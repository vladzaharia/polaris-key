/**
 * The product issuer's key ring (I-21.3; V5 §12.13.5, plans/I-20.md §3.4 and D2; threat IS-7).
 *
 * Each product has its own RSA-2048 ring, apart from its Ed25519 product keys: an RS256 key signs
 * only this product's `id_token` and `at+jwt`, and no `pkey-*+jws` is ever signed with one. A key
 * is one row of `identity_issuer_keys`, named by its RFC 7638 thumbprint.
 *
 * ── LIFECYCLE ───────────────────────────────────────────────────────────────────────────────
 *
 *   (none) --ensureIssuerKeys--> active          the first key signs at once
 *   active --rotateIssuerKeys--> a `next` is published ISSUER_KEY_ROTATION - ISSUER_KEY_NEXT_LEAD
 *                                (83 days) after the active key began to sign
 *   next   --rotateIssuerKeys--> active          at least 7 days after it was published AND
 *                                                90 days after the outgoing key activated; the
 *                                                outgoing key becomes `retired` in the same batch
 *   retired --rotateIssuerKeys--> deleted        30 days after it retired
 *   any    --emergencyRotateIssuerKey--> deleted every other key at once, a new key active
 *
 * ── THE RULES THIS FILE HOLDS ──────────────────────────────────────────────────────────────
 *
 * - The private half exists in exactly two places: sealed in `identity_issuer_keys.sealed` (the
 *   key vault's `issuer-signing-key` kind, AAD `pkey:v2:<product>:issuer-signing-key:<kid>`, so
 *   a blob copied to another product or another kid does not open), and, for the length of one
 *   call, as a non-extractable CryptoKey inside `signIssuerJwt`. No function here returns, logs
 *   or audits private material; the JWKS reader never selects `sealed`.
 * - A key is never persisted unsealed: `seal` throws without a KEK and nothing is written.
 * - Nothing caches an unsealed key across calls and the signer reads the active row on every
 *   call, so an emergency rotation takes effect on the next sign in every isolate.
 * - Every transition is one conditional batch, so a lost race changes 0 rows and a ring never
 *   holds two active keys, or none after its first.
 * - An emergency rotation does NOT revoke refresh families: a refresh token is an opaque peppered
 *   value kept server side, never signed by this key, so a key compromise is not an account
 *   compromise. Access and id tokens the dropped keys signed stop verifying at once.
 * - The route that serves `issuerJwks` must send a short `Cache-Control` (I-21.5).
 * - The signer pins `alg` to RS256 and sets `kid` and `typ` itself.
 */

import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  type JWTPayload,
} from "jose";
import type { IssuerJwk, IssuerJwks } from "@polaris-key/protocol/identity";
import {
  ACCESS_TOKEN_TYP,
  ID_TOKEN_TYP,
  ISSUER_TOKEN_ALG,
} from "@polaris-key/protocol/identity";
import type { Db, DbStatement } from "../../../db/types.js";
import { batchCounts } from "../../../db/batch.js";
import type { Env } from "../../../platform/env.js";
import { open, seal } from "../../../platform/keyvault.js";
import { issuerServed } from "./served.js";
import {
  SYSTEM_ACTORS,
  actorColumns,
  appendAudit,
  auditStatement,
  type AuditActor,
} from "../../../core/audit.js";

/** An active key rotates this long after it began to sign (90 days). */
export const ISSUER_KEY_ROTATION_SECONDS = 90 * 86_400;
/** A `next` key is in the set this long before it may sign (7 days). */
export const ISSUER_KEY_NEXT_LEAD_SECONDS = 7 * 86_400;
/** A retired key stays in the set this long (30 days), then is deleted. */
export const ISSUER_KEY_RETIRED_SECONDS = 30 * 86_400;

export type IssuerKeyState = "next" | "active" | "retired";

interface KeyRow {
  kid: string;
  state: IssuerKeyState;
  published_at: number;
  activated_at: number | null;
  retired_at: number | null;
}

const STATE_RANK = `CASE state WHEN 'active' THEN 0 WHEN 'next' THEN 1 ELSE 2 END`;

/** A new key: the public JWK members, the thumbprint, and the PKCS#8 PEM to seal at once. */
async function generateIssuerKey(): Promise<{
  kid: string;
  n: string;
  e: string;
  pkcs8: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair(ISSUER_TOKEN_ALG, {
    modulusLength: 2048,
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e)
    throw new Error("issuer key generation did not produce an RSA key");
  return {
    kid: await calculateJwkThumbprint(jwk, "sha256"),
    n: jwk.n,
    e: jwk.e,
    pkcs8: await exportPKCS8(privateKey),
  };
}

const sealCtx = (product: string, kid: string) => ({
  product,
  kind: "issuer-signing-key" as const,
  id: kid,
});

/** Generate a key and seal it, as the columns of an `identity_issuer_keys` row. */
async function newSealedKey(env: Env, product: string) {
  const k = await generateIssuerKey();
  return { ...k, sealed: await seal(env, k.pkcs8, sealCtx(product, k.kid)) };
}

type NewKey = Awaited<ReturnType<typeof newSealedKey>>;

const keyAudit = (
  product: string,
  at: number,
  actor: AuditActor,
  action: string,
  kid: string,
  summary: string,
) => ({
  product,
  at,
  ...actorColumns(actor),
  action,
  target_kind: "issuer_key",
  target_id: kid,
  summary,
});

/**
 * The product's active key id, creating its first key when the ring is empty. One conditional
 * insert: a concurrent first call inserts nothing and reads the winner's key. Throws (writing
 * nothing) when the key vault is unusable.
 */
export async function ensureIssuerKeys(
  env: Env,
  db: Db,
  product: string,
  now: number,
  actor: AuditActor = SYSTEM_ACTORS.platform,
): Promise<string> {
  const have = await activeKid(db, product);
  if (have) return have;
  const k = await newSealedKey(env, product);
  const inserted = await db.runChanges(
    `INSERT INTO identity_issuer_keys
       (product, kid, state, sealed, n, e, created_at, published_at, activated_at)
     SELECT ?, ?, 'active', ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM identity_issuer_keys WHERE product = ? AND state = 'active')`,
    product,
    k.kid,
    k.sealed,
    k.n,
    k.e,
    now,
    now,
    now,
    product,
  );
  if (inserted === 1)
    await appendAudit(
      db,
      keyAudit(
        product,
        now,
        actor,
        "identity.issuer.key.created",
        k.kid,
        "First issuer key created and active",
      ),
    );
  const kid = await activeKid(db, product);
  if (!kid) throw new Error("issuer key ring has no active key");
  return kid;
}

async function activeKid(db: Db, product: string): Promise<string | null> {
  const row = await db.first<{ kid: string }>(
    `SELECT kid FROM identity_issuer_keys WHERE product = ? AND state = 'active'
     ORDER BY activated_at DESC, kid LIMIT 1`,
    product,
  );
  return row?.kid ?? null;
}

/**
 * `<issuer>/jwks`: every key in the set (`active`, `next` and `retired`), each exactly the
 * public members. Selects no private column. The route adds the caching headers.
 */
export async function issuerJwks(db: Db, product: string): Promise<IssuerJwks> {
  const rows = await db.all<{ kid: string; n: string; e: string }>(
    `SELECT kid, n, e FROM identity_issuer_keys WHERE product = ?
     ORDER BY ${STATE_RANK}, created_at, kid`,
    product,
  );
  const keys: IssuerJwk[] = rows.map((r) => ({
    kty: "RSA",
    use: "sig",
    alg: ISSUER_TOKEN_ALG,
    kid: r.kid,
    n: r.n,
    e: r.e,
  }));
  return { keys };
}

/**
 * Sign an issuer token with the product's active key: RS256, `kid` of the key, `typ` `JWT`
 * (`id_token`) or `at+jwt`. The caller supplies the claims, including `iss`, `aud`, `exp`.
 * Creates the first key when the ring is empty. The key is opened for this call only.
 */
export async function signIssuerJwt(
  env: Env,
  db: Db,
  product: string,
  typ: typeof ID_TOKEN_TYP | typeof ACCESS_TOKEN_TYP,
  claims: JWTPayload,
  now: number,
): Promise<string> {
  // A key ring is made only for a live product whose issuer is on: a token request for any other
  // product never creates one.
  if (!(await issuerServed(db, product)))
    throw new Error("the issuer is not served for this product");
  const kid = await ensureIssuerKeys(env, db, product, now);
  const row = await db.first<{ sealed: string }>(
    `SELECT sealed FROM identity_issuer_keys WHERE product = ? AND kid = ? AND state = 'active'`,
    product,
    kid,
  );
  if (!row) throw new Error("issuer signing key is no longer active");
  const pem = await open(env, row.sealed, sealCtx(product, kid));
  const key = await importPKCS8(pem, ISSUER_TOKEN_ALG, { extractable: false });
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ISSUER_TOKEN_ALG, kid, typ })
    .sign(key);
}

/**
 * One product's rotation step, for the nightly job. Idempotent; returns the number of changes.
 * Does nothing for a product with no active key (the first key is made on demand, so a product
 * that never served the issuer holds none). It runs whatever the product's toggles say: a ring
 * keeps its timetable while the issuer is off.
 */
export async function rotateIssuerKeys(
  env: Env,
  db: Db,
  product: string,
  now: number,
): Promise<number> {
  let changes = 0;
  const actor = SYSTEM_ACTORS.platform;

  // 1. A retired key leaves the set 30 days after it retired, sealed private half included.
  const gone = await db.all<{ kid: string }>(
    `SELECT kid FROM identity_issuer_keys
     WHERE product = ? AND state = 'retired' AND retired_at <= ?`,
    product,
    now - ISSUER_KEY_RETIRED_SECONDS,
  );
  for (const g of gone) {
    const n = await db.runChanges(
      `DELETE FROM identity_issuer_keys
       WHERE product = ? AND kid = ? AND state = 'retired' AND retired_at <= ?`,
      product,
      g.kid,
      now - ISSUER_KEY_RETIRED_SECONDS,
    );
    if (n === 1) {
      changes++;
      await appendAudit(
        db,
        keyAudit(
          product,
          now,
          actor,
          "identity.issuer.key.dropped",
          g.kid,
          "Retired issuer key left the set",
        ),
      );
    }
  }

  const rows = await db.all<KeyRow>(
    `SELECT kid, state, published_at, activated_at, retired_at
     FROM identity_issuer_keys WHERE product = ?`,
    product,
  );
  const active = rows.find((r) => r.state === "active");
  if (!active || active.activated_at === null) return changes;
  const next = rows.find((r) => r.state === "next");
  const dueAt = active.activated_at + ISSUER_KEY_ROTATION_SECONDS;

  // 2. Publish the next key 7 days before the active key is due to retire.
  if (!next) {
    if (now >= dueAt - ISSUER_KEY_NEXT_LEAD_SECONDS) {
      const k = await newSealedKey(env, product);
      const n = await db.runChanges(
        `INSERT INTO identity_issuer_keys
                  (product, kid, state, sealed, n, e, created_at, published_at)
                SELECT ?, ?, 'next', ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM identity_issuer_keys
                              WHERE product = ? AND kid = ? AND state = 'active')
                  AND NOT EXISTS (SELECT 1 FROM identity_issuer_keys
                                  WHERE product = ? AND state = 'next')`,
        product,
        k.kid,
        k.sealed,
        k.n,
        k.e,
        now,
        now,
        product,
        active.kid,
        product,
      );
      if (n === 1) {
        changes++;
        await appendAudit(
          db,
          keyAudit(
            product,
            now,
            actor,
            "identity.issuer.key.published",
            k.kid,
            "Next issuer key published",
          ),
        );
      }
    }
    return changes;
  }

  // 3. Promote it: at least 7 days in the set, and the active key is 90 days old.
  const ready = now - next.published_at >= ISSUER_KEY_NEXT_LEAD_SECONDS;
  if (ready && now >= dueAt) {
    const guard = `EXISTS (SELECT 1 FROM identity_issuer_keys
                           WHERE product = ? AND kid = ? AND state = 'next' AND published_at <= ?)`;
    const guardParams = [product, next.kid, now - ISSUER_KEY_NEXT_LEAD_SECONDS];
    const counts = await batchCounts(db, [
      {
        sql: `UPDATE identity_issuer_keys SET state = 'retired', retired_at = ?
              WHERE product = ? AND kid = ? AND state = 'active' AND ${guard}`,
        params: [now, product, active.kid, ...guardParams],
      },
      {
        sql: `UPDATE identity_issuer_keys SET state = 'active', activated_at = ?
              WHERE product = ? AND kid = ? AND state = 'next' AND published_at <= ?
                AND NOT EXISTS (SELECT 1 FROM identity_issuer_keys
                                WHERE product = ? AND state = 'active')`,
        params: [
          now,
          product,
          next.kid,
          now - ISSUER_KEY_NEXT_LEAD_SECONDS,
          product,
        ],
      },
    ]);
    if (counts[0] === 1 && counts[1] === 1) {
      changes += 2;
      await appendAudit(
        db,
        keyAudit(
          product,
          now,
          actor,
          "identity.issuer.key.rotated",
          next.kid,
          `Issuer key activated; ${active.kid} retired`,
        ),
      );
    }
  }
  return changes;
}

/**
 * Emergency rotation (Superadmin, step-up: the caller's gate): a new key becomes active and every
 * other key of the product is deleted, sealed half included, in one batch. Every token the old
 * keys signed stops verifying at once. Audited with the actor and reason. Returns the new kid and
 * how many keys were dropped.
 */
export async function emergencyRotateIssuerKey(
  env: Env,
  db: Db,
  product: string,
  actor: AuditActor,
  now: number,
  reason: string | null = null,
): Promise<{ kid: string; dropped: number }> {
  const k = await newSealedKey(env, product);
  const before = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_issuer_keys WHERE product = ?",
    product,
  );
  await db.batch([
    {
      sql: "DELETE FROM identity_issuer_keys WHERE product = ?",
      params: [product],
    },
    insertKey(product, k, now),
    auditStatement({
      ...keyAudit(
        product,
        now,
        actor,
        "identity.issuer.key.emergency_rotated",
        k.kid,
        "Emergency issuer key rotation: every earlier key dropped",
      ),
      reason,
    }),
  ]);
  return { kid: k.kid, dropped: before?.n ?? 0 };
}

function insertKey(product: string, k: NewKey, now: number): DbStatement {
  return {
    sql: `INSERT INTO identity_issuer_keys
            (product, kid, state, sealed, n, e, created_at, published_at, activated_at)
          VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    params: [product, k.kid, k.sealed, k.n, k.e, now, now, now],
  };
}

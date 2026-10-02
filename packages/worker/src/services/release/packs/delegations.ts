/// <reference types="@cloudflare/workers-types" />

/**
 * Content-key delegation (P4-19, plans/P4-19.md §6; decisions 3–8).
 *
 * A delegation is a CI-signed `pkey-release+jws` with `kind: "delegation"`, signed by a declared
 * RELEASE key: it lets one content key (`delegate.publicKey`) sign tree-layout pack records of the
 * data-only types under a pack-id scope (`deliverable`, whole segments), with the record's
 * `issuedAt` inside the delegation's window. A pack record a content key signs carries the header
 * kid `pkd1-<the delegation's record hash>`. Clients stay authoritative (they verify the chain
 * against their pinned release keys); every check here is defence in depth, and the Worker holds
 * no key that signs a delegation, so it can withhold one but never forge or widen one.
 *
 * ── A `kind: delegation` SUBMIT (no ticket, no descriptor), in order ─────────────────────────
 *
 *   1. the shared record checks against the release keys (`verifyRecordJws`);
 *   2. `delegation-body`    client-core's `delegationOf` finds the body unusable, or a listed type
 *                           is not in `DELEGABLE_PACK_TYPES` (a client ignores one; ingest refuses);
 *      a byte-identical resubmit of a stored `submit` delegation changes nothing;
 *   3. `delegation-key`     the delegated key is a declared release key, a product signing key
 *                           (current or retired), or the key of ANY stored delegation, whatever
 *                           its origin or revocation: one key, one delegation;
 *   4. `seq`                not above the product's last `origin = 'submit'` delegation of the scope;
 *   5. `delegation-window`  `issuedAt > now + 300` or `expiresAt ≤ now`.
 *
 * ── A DELEGATED PACK RECORD (`verifyDelegatedRecord`, then the pack checks) ──────────────────
 *
 *   a. `delegation-unknown` / `delegation-revoked`  the delegation is not stored / is revoked;
 *   b. `product-key` / `delegation-key`             the delegated key is a product signing key /
 *                                                   a declared release key;
 *   c. `signature`, `claims`;
 *   d. `delegation-scope`   `kind: pack`, the scope root or under it, a delegated type, every
 *                           variant `tree`, `issuedAt` inside the window;
 *   e. `delegation-window`  `now ≥ expiresAt`, or `issuedAt` more than a day old or 300 s ahead.
 *
 * then every P4-02 and P4-12 pack check, then `delegation-binding` (compatible or standalone) and
 * `delegation-data-only` (the extension rule over every parsed index path, client-core's
 * `dataOnlyPathRefusal`), and the `release_delegated_records` row in the release's batch.
 *
 * ── REVOKING A DELEGATION (P4-13's revocation record unchanged) ─────────────────────────────
 *
 * The target is a stored delegation, or one supplied alongside (`{record, delegation}`) that must
 * hash to `revokes`, verify against the release keys and be usable; it is then stored already
 * revoked with `origin = 'revocation'` (exempt from the partial unique indexes, its key joining the
 * no-reuse set). `deliverable`, `version` and `seq` must be the delegation's
 * (`revocation-target`); a `replacement` is refused (`revocation-replacement`). One batch writes
 * the revocation onto the row (superseding by `newerRevocation`, never cleared), a `release_yanks`
 * row (reason `delegation-revoked`) for every release signed under it, and the clear of the sets.
 */

import { releaseKeyBytes, sameKeyBytes } from "@polaris-key/manifest";
import { base64UrlDecode, verifyJws } from "@polaris-key/jws";
import {
  coversPack,
  delegatedKid,
  delegationOf,
  isPackId,
  newerRevocation,
  releaseRecordClaims,
  type RevocationBody,
} from "@polaris-key/client-core/record";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import { DELEGABLE_PACK_TYPES } from "@polaris-key/protocol/packs";
import { DELEGATED_KID_PATTERN } from "@polaris-key/protocol/release";
import type { ServiceContext } from "../../../core/registry.js";
import type { CatalogRevocation } from "../../../core/hooks.js";
import { errorResponse, ErrorCode, json } from "../../../core/errors.js";
import { ciActor } from "../../../core/ciScope.js";
import type { CiTokenRecord } from "../../../core/publisher.js";
import { appendAudit } from "../../../core/data.js";
import type { Db, DbStatement } from "../../../core/platform.js";
import { randomId } from "../../../core/platform.js";
import { bumpReleaseGeneration } from "../ghCache.js";
import { getReleaseConfig, type ReleaseConfigRow } from "../config.js";
import {
  productSigningKeyBytes,
  refuse,
  releaseKeyTrustSet,
  sha256HexOfAscii,
  verifyRecordJws,
  type RecordRefusalReason,
  type VerifiedRecordJws,
} from "../records.js";
import { invalidateSetsStatements, resolveAndStore } from "./sets.js";

/** One stored row of `release_delegations`. */
export interface DelegationRow {
  product: string;
  record_sha256: string;
  deliverable_id: string;
  seq: number;
  version: string;
  kid: string;
  jws: string;
  public_key: string;
  types_json: string;
  issued_at: number;
  expires_at: number;
  ingested_at: number;
  origin: "submit" | "revocation";
  revocation_sha256: string | null;
  revocation_jws: string | null;
  revocation_kid: string | null;
  revocation_reason: string | null;
  revocation_issued_at: number | null;
}

/** A delegation's listed types, and the effective ones (`∩ DELEGABLE_PACK_TYPES`). */
export function delegationTypes(row: Pick<DelegationRow, "types_json">): {
  listed: string[];
  effective: string[];
} {
  let listed: string[] = [];
  try {
    const v: unknown = JSON.parse(row.types_json);
    if (Array.isArray(v)) listed = v.filter((t) => typeof t === "string");
  } catch {
    listed = [];
  }
  return {
    listed,
    effective: listed.filter((t) =>
      (DELEGABLE_PACK_TYPES as readonly string[]).includes(t),
    ),
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The lowercase hex SHA-256 of a raw key's 32 bytes (as `releaseKeyFingerprints`). */
export async function keyFingerprint(publicKey: string): Promise<string> {
  try {
    return await sha256HexOfBytes(base64UrlDecode(publicKey));
  } catch {
    return "";
  }
}

/** Every stored delegation of the product, by scope then `seq` then hash. */
export async function readDelegationRows(
  db: Db,
  product: string,
): Promise<DelegationRow[]> {
  const rows = await db.all<DelegationRow>(
    "SELECT * FROM release_delegations WHERE product = ?",
    product,
  );
  return rows.sort(
    (a, b) =>
      cmp(a.deliverable_id, b.deliverable_id) ||
      a.seq - b.seq ||
      cmp(a.record_sha256, b.record_sha256),
  );
}

export async function readDelegation(
  db: Db,
  product: string,
  sha256: string,
): Promise<DelegationRow | null> {
  return db.first<DelegationRow>(
    "SELECT * FROM release_delegations WHERE product = ? AND record_sha256 = ?",
    product,
    sha256,
  );
}

/** The delegations' revocations in force, as the hook's `revocations()` lists them
 *  (`kind: "delegation"`, no target release). */
export async function readDelegationRevocations(
  db: Db,
  product: string,
): Promise<CatalogRevocation[]> {
  const rows = await db.all<DelegationRow>(
    "SELECT * FROM release_delegations WHERE product = ? AND revocation_sha256 IS NOT NULL",
    product,
  );
  const under = new Map<string, string[]>();
  if (rows.length > 0)
    for (const x of await db.all<{
      delegation_sha256: string;
      release_id: string;
    }>(
      `SELECT d.delegation_sha256, r.release_id
         FROM release_delegated_records d
         JOIN release_records r ON r.product = d.product AND r.record_sha256 = d.record_sha256
         JOIN release_delegations g
           ON g.product = d.product AND g.record_sha256 = d.delegation_sha256
        WHERE d.product = ? AND g.revocation_sha256 IS NOT NULL
        ORDER BY r.release_id`,
      product,
    )) {
      const list = under.get(x.delegation_sha256) ?? [];
      list.push(x.release_id);
      under.set(x.delegation_sha256, list);
    }
  return rows.map((r) => ({
    kind: "delegation" as const,
    deliverableId: r.deliverable_id,
    targetReleaseId: "",
    targetSha256: r.record_sha256,
    recordSha256: r.revocation_sha256 as string,
    version: r.version,
    seq: r.seq,
    kid: r.revocation_kid ?? "",
    replacement: null,
    reason: r.revocation_reason ?? "",
    issuedAt: r.revocation_issued_at ?? 0,
    ingestedAt: r.ingested_at,
    delegatedReleaseIds: under.get(r.record_sha256) ?? [],
  }));
}

function recordRefusal(
  reason: RecordRefusalReason,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(
    reason === "seq" || reason === "revocation-stale" ? 409 : 400,
    "release_record_rejected",
    message,
    { reason, ...extra },
  );
}

/** Whether the raw key `publicKey` is a declared release key, or a product signing key. */
async function keyClashes(
  db: Db,
  product: string,
  cfg: Pick<ReleaseConfigRow, "release_keys_json"> | null,
  publicKey: string,
): Promise<"release" | "product" | null> {
  const bytes = releaseKeyBytes(publicKey);
  if (!bytes) return "release";
  for (const k of Object.values(releaseKeyTrustSet(cfg))) {
    const other = releaseKeyBytes(k);
    if (other && sameKeyBytes(other, bytes)) return "release";
  }
  const signing = await productSigningKeyBytes(db, product);
  if (signing.some((s) => sameKeyBytes(s, bytes))) return "product";
  return null;
}

// ── A `kind: delegation` submit ─────────────────────────────────────────────────────────────

export async function handleDelegationSubmit(
  ctx: ServiceContext,
  holder: CiTokenRecord,
  shared: Extract<VerifiedRecordJws, { ok: true }>,
  dryRun: boolean,
): Promise<Response> {
  const { db, product, now } = ctx;
  const slug = product.slug;

  // 2. The body, every listed type delegable.
  const body = delegationOf(shared.payload, shared.nonWireIntegers);
  if (
    body === null ||
    !body.listedTypes.every((t) =>
      (DELEGABLE_PACK_TYPES as readonly string[]).includes(t),
    )
  )
    return recordRefusal(
      "delegation-body",
      `the delegation's body is unusable: deliverable must be a pack id, delegate.publicKey 32 raw Ed25519 bytes in base64url, types 1–8 unique types all in ${DELEGABLE_PACK_TYPES.join(", ")}, and issuedAt < expiresAt ≤ issuedAt + 366 days (plans/P4-19.md §2.2).`,
    );
  const sha256 = await sha256HexOfAscii(shared.jws);
  const existing = await readDelegation(db, slug, sha256);
  const view = {
    sha256,
    kid: delegatedKid(sha256),
    deliverable: body.deliverable,
    seq: body.seq,
    types: body.types,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  };
  if (existing && existing.origin === "submit" && existing.jws === shared.jws)
    return json({
      ok: true,
      dryRun,
      outcome: "unchanged",
      delegation: { ...view, stored: false },
    });

  // 3. One key, one delegation; never a release or product key.
  const clash = await keyClashes(
    db,
    slug,
    await getReleaseConfig(db, slug),
    body.publicKey,
  );
  if (clash)
    return recordRefusal(
      "delegation-key",
      clash === "release"
        ? "the delegated key is one of the product's declared release keys; a content key is a separate key."
        : "the delegated key is one of the product's signing keys; a content key is never a key the Worker holds.",
    );
  const reused = await db.first<{ record_sha256: string }>(
    "SELECT record_sha256 FROM release_delegations WHERE product = ? AND public_key = ? LIMIT 1",
    slug,
    body.publicKey,
  );
  if (reused)
    return recordRefusal(
      "delegation-key",
      `the delegated key is already named by delegation ${reused.record_sha256}; one content key maps to one delegation (rotate: a new key and a new delegation).`,
      { delegation: reused.record_sha256 },
    );

  // 4. seq.
  const max = await db.first<{ m: number | null }>(
    "SELECT MAX(seq) AS m FROM release_delegations WHERE product = ? AND deliverable_id = ? AND origin = 'submit'",
    slug,
    body.deliverable,
  );
  if (body.seq <= (max?.m ?? 0))
    return recordRefusal(
      "seq",
      `the delegation says seq ${body.seq}, not above ${body.deliverable}'s last delegation (${max?.m ?? 0}). Ask …/release/publish/delegations for nextSeq and sign again.`,
    );

  // 5. The window, against the Worker's clock.
  if (body.issuedAt > now + 300 || body.expiresAt <= now)
    return recordRefusal(
      "delegation-window",
      body.expiresAt <= now
        ? `the delegation's window closed at ${body.expiresAt}.`
        : `the delegation's issuedAt ${body.issuedAt} is more than 300 seconds ahead of the Worker's clock.`,
    );

  if (dryRun)
    return json({
      ok: true,
      dryRun: true,
      outcome: "created",
      delegation: view,
    });

  await db.run(
    `INSERT INTO release_delegations
       (product, record_sha256, deliverable_id, seq, version, kid, jws, public_key, types_json,
        issued_at, expires_at, ingested_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submit')
     ON CONFLICT DO NOTHING`,
    slug,
    sha256,
    body.deliverable,
    body.seq,
    shared.payload.version as string,
    shared.kid,
    shared.jws,
    body.publicKey,
    JSON.stringify(body.listedTypes),
    body.issuedAt,
    body.expiresAt,
    now,
  );
  const stored = await readDelegation(db, slug, sha256);
  if (!stored || stored.jws !== shared.jws || stored.origin !== "submit")
    return errorResponse(
      409,
      "release_record_rejected",
      `another delegation of ${body.deliverable} (seq ${body.seq}) or of the same key was stored while this one was being checked.`,
      { reason: "seq", retryable: true },
    );
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(holder),
    actor_name: "CI",
    actor_email: null,
    action: "release.delegate",
    target_kind: "delegation",
    target_id: sha256,
    parent_id: null,
    summary: `Delegated a content key for ${body.types.join(", ")} under ${body.deliverable} (seq ${body.seq}) until ${body.expiresAt}, delegation ${sha256.slice(0, 12)}`,
  });
  return json({
    ok: true,
    dryRun: false,
    outcome: "created",
    delegation: { ...view, stored: true },
  });
}

// ── A delegated pack record ─────────────────────────────────────────────────────────────────

/** The protected header's `typ` and `kid`, and the payload's `kind`, read leniently. */
function peek(jws: string): { typ?: unknown; kid?: unknown; kind?: unknown } {
  const [h, p] = jws.split(".");
  const read = (seg: string | undefined): Record<string, unknown> | null => {
    if (!seg) return null;
    try {
      const v: unknown = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(seg)),
      );
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const header = read(h);
  const payload = read(p);
  return { typ: header?.typ, kid: header?.kid, kind: payload?.kind };
}

/** The `pkd1-` kid's delegation hash, when the record names one. */
export function delegatedKidOf(jws: unknown): string | null {
  if (typeof jws !== "string" || jws.split(".").length !== 3) return null;
  const { kid } = peek(jws);
  return typeof kid === "string" && DELEGATED_KID_PATTERN.test(kid)
    ? kid.slice(5)
    : null;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false;
  return true;
}

export type VerifiedDelegatedRecord =
  | (Extract<VerifiedRecordJws, { ok: true }> & { delegation: DelegationRow })
  | Extract<VerifiedRecordJws, { ok: false }>;

/**
 * Checks a–e of plans/P4-19.md §6.2 over a record whose kid is `pkd1-<hash>`. A record of any kind
 * but `pack` under such a kid is refused at `kid` before anything else: only a declared release
 * key signs app records, revocations and delegations.
 */
export async function verifyDelegatedRecord(
  db: Db,
  input: {
    product: string;
    jws: string;
    cfg: Pick<ReleaseConfigRow, "release_keys_json"> | null;
    now: number;
  },
): Promise<VerifiedDelegatedRecord> {
  const { product, jws, now } = input;
  const hp = peek(jws);
  if (hp.typ !== "pkey-release+jws")
    return refuse("typ", "the record's typ must be pkey-release+jws.");
  const hash = delegatedKidOf(jws)!;
  const kid = delegatedKid(hash);
  if (hp.kind !== "pack")
    return refuse(
      "kid",
      "a record signed by a delegated content key (pkd1- kid) can only be a kind: pack record; app records, revocations and delegations are signed by a declared release key.",
    );

  // a. The delegation is stored and not revoked.
  const row = await readDelegation(db, product, hash);
  if (!row)
    return refuse(
      "delegation-unknown",
      `the record names delegation ${hash}, which ${product} has not ingested (submit it with pkey release delegate first).`,
    );
  if (row.revocation_sha256 !== null)
    return refuse(
      "delegation-revoked",
      `delegation ${hash} is revoked (revocation ${row.revocation_sha256}); no release may be published under it.`,
    );

  // b. The delegated key is no product key now, and no declared release key.
  const clash = await keyClashes(db, product, input.cfg, row.public_key);
  if (clash === "product")
    return refuse(
      "product-key",
      "the delegated key is one of the product's signing keys; a record signed with it proves nothing.",
    );
  if (clash === "release")
    return refuse(
      "delegation-key",
      "the delegated key is one of the product's declared release keys.",
    );

  // c. The signature and the claims.
  if (jws.length > MAX_RECORD_JWS_BYTES || !isAscii(jws))
    return refuse(
      "signature",
      `a record is ASCII and at most ${MAX_RECORD_JWS_BYTES} bytes.`,
    );
  const verified = await verifyJws<unknown>(
    jws,
    { [kid]: row.public_key },
    { typ: "pkey-release+jws" },
  );
  if (!verified)
    return refuse(
      "signature",
      `the record does not verify against delegation ${hash}'s content key.`,
    );
  if (
    !releaseRecordClaims(verified.payload, {
      expectedAud: product,
      nonWire: verified.nonWireIntegers,
    })
  )
    return refuse(
      "claims",
      "the record's claims do not hold (WIRE-CONTRACT-V4 §2.4).",
    );
  const payload = verified.payload as Record<string, unknown>;

  // d. The scope.
  const { effective } = delegationTypes(row);
  const variants = (payload.variants ?? []) as {
    files?: { layout?: unknown };
  }[];
  const issuedAt = payload.issuedAt as number;
  if (
    payload.kind !== "pack" ||
    typeof payload.deliverable !== "string" ||
    !coversPack(row.deliverable_id, payload.deliverable) ||
    typeof payload.type !== "string" ||
    !effective.includes(payload.type) ||
    !variants.every((v) => v.files?.layout === "tree") ||
    issuedAt < row.issued_at ||
    issuedAt > row.expires_at
  )
    return refuse(
      "delegation-scope",
      `the record is outside delegation ${hash}: a tree-layout ${effective.join(" or ")} pack under ${row.deliverable_id}, issued between ${row.issued_at} and ${row.expires_at} (plans/P4-19.md §2.3 step 16).`,
    );

  // e. The window, against the Worker's clock (a backdated record is refused).
  if (now >= row.expires_at || issuedAt < now - 86_400 || issuedAt > now + 300)
    return refuse(
      "delegation-window",
      now >= row.expires_at
        ? `delegation ${hash}'s window closed at ${row.expires_at}; mint a new delegation.`
        : `the record's issuedAt ${issuedAt} is not within a day before and 300 seconds after the Worker's clock.`,
    );

  return {
    ok: true,
    payload,
    kid,
    jws,
    nonWireIntegers: verified.nonWireIntegers,
    delegation: row,
  };
}

/** The `release_delegated_records` row, guarded like every other row of the release. */
export function delegatedRecordStatement(r: {
  product: string;
  recordSha256: string;
  delegationSha256: string;
  guard: { sql: string; params: readonly (string | number | null)[] };
}): DbStatement {
  return {
    sql: `INSERT INTO release_delegated_records (product, record_sha256, delegation_sha256)
          SELECT ?, ?, ? WHERE ${r.guard.sql}
          ON CONFLICT DO NOTHING`,
    params: [r.product, r.recordSha256, r.delegationSha256, ...r.guard.params],
  };
}

/** A `release_yanks` row (reason `delegation-revoked`) for every release signed under a
 *  delegation, never over an existing yank. */
export function yankDelegatedStatement(
  product: string,
  delegationSha256: string,
  by: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO release_yanks (product, release_id, reason, at, by)
          SELECT r.product, r.release_id, 'delegation-revoked', ?, ?
            FROM release_delegated_records d
            JOIN release_records r
              ON r.product = d.product AND r.record_sha256 = d.record_sha256
           WHERE d.product = ? AND d.delegation_sha256 = ?
          ON CONFLICT(product, release_id) DO NOTHING`,
    params: [now, by, product, delegationSha256],
  };
}

// ── Revoking a delegation ───────────────────────────────────────────────────────────────────

/**
 * A `kind: revocation` whose target is a delegation: a stored one, or one supplied alongside
 * (`supplied`). Null when the target is neither (the caller refuses `revocation-target`).
 */
export async function handleDelegationRevocation(
  ctx: ServiceContext,
  holder: CiTokenRecord,
  shared: Extract<VerifiedRecordJws, { ok: true }>,
  body: RevocationBody,
  dryRun: boolean,
  supplied: unknown,
): Promise<Response | null> {
  const { db, env, product, now } = ctx;
  const slug = product.slug;
  const recordSha256 = await sha256HexOfAscii(shared.jws);
  const version = shared.payload.version as string;
  const seq = shared.payload.seq as number;

  let row = await readDelegation(db, slug, body.target);
  let pending: DelegationRow | null = null;
  if (!row) {
    if (supplied === undefined) return null;
    const bad = (why: string): Response =>
      recordRefusal(
        "revocation-target",
        `the delegation supplied with the revocation ${why}.`,
      );
    if (typeof supplied !== "string") return bad("is not a compact JWS");
    if ((await sha256HexOfAscii(supplied)) !== body.target)
      return bad(`does not hash to revokes (${body.target})`);
    const v = await verifyRecordJws(db, {
      product: slug,
      jws: supplied,
      cfg: await getReleaseConfig(db, slug),
    });
    if (!v.ok) return bad(`was refused (${v.reason})`);
    const d = delegationOf(v.payload, v.nonWireIntegers);
    if (d === null) return bad("is not a usable kind: delegation record");
    pending = {
      product: slug,
      record_sha256: body.target,
      deliverable_id: d.deliverable,
      seq: d.seq,
      version: v.payload.version as string,
      kid: v.kid,
      jws: supplied,
      public_key: d.publicKey,
      types_json: JSON.stringify(d.listedTypes),
      issued_at: d.issuedAt,
      expires_at: d.expiresAt,
      ingested_at: now,
      origin: "revocation",
      revocation_sha256: null,
      revocation_jws: null,
      revocation_kid: null,
      revocation_reason: null,
      revocation_issued_at: null,
    };
    row = pending;
  }

  // 3. The target is the delegation the record names.
  if (
    row.deliverable_id !== body.pack ||
    row.version !== version ||
    row.seq !== seq
  )
    return recordRefusal(
      "revocation-target",
      `the revocation names ${body.pack} ${version} (seq ${seq}), but delegation ${body.target} is ${row.deliverable_id} ${row.version} (seq ${row.seq}).`,
    );
  if (body.replacement)
    return recordRefusal(
      "revocation-replacement",
      "a revocation of a delegation carries no replacement: no release replaces a delegation (re-publish under a new delegation first).",
    );

  // 4. Superseding.
  if (row.revocation_jws === shared.jws)
    return json({
      ok: true,
      dryRun,
      outcome: "unchanged",
      revocation: {
        sha256: recordSha256,
        target: body.target,
        kind: "delegation",
        stored: false,
      },
    });
  if (row.revocation_sha256 !== null) {
    const mine = { issuedAt: body.issuedAt, record: recordSha256 };
    const theirs = {
      issuedAt: row.revocation_issued_at ?? 0,
      record: row.revocation_sha256,
    };
    if (newerRevocation(mine, theirs) !== mine)
      return recordRefusal(
        "revocation-stale",
        `delegation ${body.target} already has a newer revocation (record ${row.revocation_sha256}); a revocation supersedes another only with a newer issuedAt.`,
        { current: row.revocation_sha256 },
      );
  }
  const outcome = row.revocation_sha256 !== null ? "superseded" : "created";
  if (dryRun)
    return json({
      ok: true,
      dryRun: true,
      outcome,
      revocation: {
        sha256: recordSha256,
        kid: shared.kid,
        target: body.target,
        kind: "delegation",
        replacement: null,
      },
    });

  const revCols = [
    recordSha256,
    shared.jws,
    shared.kid,
    body.reason,
    body.issuedAt,
  ] as const;
  const write: DbStatement = pending
    ? {
        sql: `INSERT INTO release_delegations
                (product, record_sha256, deliverable_id, seq, version, kid, jws, public_key,
                 types_json, issued_at, expires_at, ingested_at, origin, revocation_sha256,
                 revocation_jws, revocation_kid, revocation_reason, revocation_issued_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revocation', ?, ?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        params: [
          slug,
          pending.record_sha256,
          pending.deliverable_id,
          pending.seq,
          pending.version,
          pending.kid,
          pending.jws,
          pending.public_key,
          pending.types_json,
          pending.issued_at,
          pending.expires_at,
          now,
          ...revCols,
        ],
      }
    : {
        sql: `UPDATE release_delegations
                 SET revocation_sha256 = ?, revocation_jws = ?, revocation_kid = ?,
                     revocation_reason = ?, revocation_issued_at = ?
               WHERE product = ? AND record_sha256 = ?
                 AND revocation_sha256 IS ?`,
        params: [...revCols, slug, body.target, row.revocation_sha256],
      };
  await db.batch([
    write,
    yankDelegatedStatement(slug, body.target, `ci:${shared.kid}`, now),
    ...invalidateSetsStatements(slug, now),
  ]);
  const stored = await readDelegation(db, slug, body.target);
  if (stored?.revocation_sha256 !== recordSha256) {
    await resolveAndStore(db, slug, now);
    return errorResponse(
      409,
      "release_record_rejected",
      `delegation ${body.target}'s revocation changed while this one was being checked; submit it again.`,
      { reason: "revocation-stale", retryable: true },
    );
  }
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(holder),
    actor_name: "CI",
    actor_email: null,
    action:
      outcome === "superseded"
        ? "release.revocation.supersede"
        : "release.delegation.revoke",
    target_kind: "delegation",
    target_id: body.target,
    parent_id: null,
    summary: `${outcome === "superseded" ? "Superseded the revocation of" : "Revoked"} delegation ${body.target.slice(0, 12)} (${row.deliverable_id}, seq ${row.seq}${pending ? ", supplied with the revocation" : ""}) with revocation record ${recordSha256.slice(0, 12)}; its releases are yanked`,
  });
  await bumpReleaseGeneration(env, slug, now);
  const sets = await resolveAndStore(db, slug, now);
  return json({
    ok: true,
    dryRun: false,
    outcome,
    revocation: {
      sha256: recordSha256,
      target: body.target,
      kind: "delegation",
      replacement: null,
      stored: true,
    },
    ...(sets.ok ? {} : { packSets: { ok: false, reason: sets.reason } }),
  });
}

// ── POST /<p>/release/publish/delegations ───────────────────────────────────────────────────

/** The CI read route (plans/P4-19.md §6.3): every stored delegation (its JWS included), and
 *  `nextSeq` for a scope.
 *  No blob store involved: a delegation is a signature, never bytes. */
export async function handleDelegationsRead(
  ctx: ServiceContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { db, product } = ctx;
  const deliverable = body.deliverable;
  if (deliverable !== undefined && !isPackId(deliverable))
    return errorResponse(
      400,
      ErrorCode.BadRequest,
      "deliverable must be a pack id (the delegation's scope root)",
      { reason: "bad_body" },
    );
  const rows = await readDelegationRows(db, product.slug);
  const delegations = [];
  for (const r of rows)
    delegations.push({
      sha256: r.record_sha256,
      deliverable: r.deliverable_id,
      seq: r.seq,
      version: r.version,
      keyFingerprint: await keyFingerprint(r.public_key),
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      origin: r.origin,
      revoked: r.revocation_sha256 !== null,
      // The delegation's compact JWS, verbatim: the CLI reads it here (behind the publisher
      // token) to revoke or publish under it, whatever the product's metadata access.
      jws: r.jws,
    });
  let nextSeq: number | undefined;
  if (typeof deliverable === "string") {
    const max = rows
      .filter((r) => r.origin === "submit" && r.deliverable_id === deliverable)
      .reduce((m, r) => Math.max(m, r.seq), 0);
    nextSeq = max + 1;
  }
  return json({
    delegations,
    ...(nextSeq !== undefined ? { nextSeq } : {}),
  });
}

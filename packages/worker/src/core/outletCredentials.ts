/// <reference types="@cloudflare/workers-types" />

/**
 * Outlet-credential custody (P5-01, README §3.8 "Connectors and credential custody").
 *
 * A store connector authenticates to its outlet with key material that is worth far more than
 * a product secret: an App Store Connect `.p8` can upload builds and change prices, a Google
 * service account can roll out a release, a Partner Center client secret can submit to the
 * Microsoft Store. So these do NOT live in `product_secrets`, which edge-mint can open for any
 * device of the product. They live in `outlet_credentials`, and this module is the only code
 * that reads that table.
 *
 * The rules, each enforced rather than documented:
 *
 *   - **Own AAD kind.** Every value is sealed under `pkey:v2:<product>:outlet-credential:<id>`.
 *     A blob copied into `product_secrets` fails to open there — the separation is
 *     cryptographic, not only a table boundary (`test/attack/R12-outlet-credentials.test.ts`).
 *   - **Platform-admin writes only.** `putOutletCredential` and `deleteOutletCredential` are
 *     called from the Core admin handler and nowhere else — `test/outletCredentialReach.test.ts`
 *     refuses any other file that names either function or the table, so no manifest ingest,
 *     resync, service hook or Distribution connector can write it.
 *   - **One reader, audited.** `openOutletCredential` is reachable only from the Distribution
 *     service and `core/outletTokens.ts` (the reach test again), and every call — success or
 *     not — appends an `outlet_credential.use` audit row with actor `system:distribution`.
 *   - **Caches checkable without an open.** `outletCredentialVersion` answers a non-secret
 *     version marker (a hash of the sealed blob) without opening anything, so the token caches
 *     in `core/outletTokens.ts` are keyed by it and a cache hit costs no open and no audit row.
 *   - **Never a value out.** Listing reads metadata columns only (the sealed column is never
 *     selected); open failures collapse to `null` ("unusable credential"), never an error
 *     message that could carry bytes; the admin write echoes the id only.
 *
 * Later kinds are added by the packages that need them (P6-01, P6-02, P6-03): one entry in
 * `KINDS` with a validator and its metadata projection.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { open, seal, type SealContext } from "../keyvault.js";
import { appendAudit } from "../repo.js";
import { randomId, sha256Hex } from "../crypto.js";
import { importEs256PrivateKey, importRs256PrivateKey } from "./jwt.js";

// ── kinds ────────────────────────────────────────────────────────────────────────────────────

/** An App Store Connect API key (team key; least privilege is the App Manager role). */
export interface AscApiKey {
  keyId: string;
  issuerId: string;
  /** The `.p8` file's contents: a P-256 PKCS#8 PEM. */
  p8: string;
}

/** The shared secret App Store Server Notifications v2 webhooks are verified against. */
export interface AscWebhookSecret {
  secret: string;
}

/** The fields of a Google service-account JSON key the Play connector needs; the rest of the
 *  key file is dropped at write. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** A Microsoft Entra app registered in Partner Center (least privilege: the Manager role). */
export interface MsPartnerCenter {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sellerId: string;
}

export interface OutletCredentialValues {
  "asc-api-key": AscApiKey;
  "asc-webhook-secret": AscWebhookSecret;
  "google-service-account": GoogleServiceAccount;
  "ms-partner-center": MsPartnerCenter;
}

export type OutletCredentialKind = keyof OutletCredentialValues;

export const OUTLET_CREDENTIAL_KINDS: readonly OutletCredentialKind[] = [
  "asc-api-key",
  "asc-webhook-secret",
  "google-service-account",
  "ms-partner-center",
];

export function isOutletCredentialKind(v: unknown): v is OutletCredentialKind {
  return (
    typeof v === "string" &&
    (OUTLET_CREDENTIAL_KINDS as readonly string[]).includes(v)
  );
}

/** The only token endpoint a Google service-account assertion is ever sent to. Every Google
 *  key file names exactly this; a key naming another is refused at write, so a credential can
 *  never make the Worker post a signed assertion to a host of the writer's choosing. */
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** Non-secret display fields, stored in `meta_json` so the console never has to open a value. */
export type OutletCredentialMeta = Record<string, string>;

type Validation<K extends OutletCredentialKind> =
  | { ok: true; value: OutletCredentialValues[K]; meta: OutletCredentialMeta }
  | { ok: false; message: string; field: string };

/** Upper bound on any one string field; a service-account key's PEM is ~1.7 KB. */
const MAX_FIELD = 8 * 1024;

function str(
  o: Record<string, unknown>,
  field: string,
  max = 256,
): string | null {
  const v = o[field];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

const fail = (field: string, message: string) =>
  ({ ok: false, field, message }) as const;

async function validateAscApiKey(
  o: Record<string, unknown>,
): Promise<Validation<"asc-api-key">> {
  const keyId = str(o, "keyId", 64);
  if (!keyId || !/^[A-Za-z0-9]+$/.test(keyId))
    return fail("keyId", "keyId must be the API key's alphanumeric id");
  const issuerId = str(o, "issuerId", 128);
  if (!issuerId || !/^[A-Za-z0-9-]+$/.test(issuerId))
    return fail("issuerId", "issuerId must be the team's issuer id");
  const p8 = str(o, "p8", MAX_FIELD);
  if (!p8 || !/-----BEGIN PRIVATE KEY-----/.test(p8))
    return fail("p8", "p8 must be the .p8 file's PKCS#8 PEM");
  try {
    await importEs256PrivateKey(p8);
  } catch {
    return fail("p8", "p8 is not a P-256 (ES256) PKCS#8 private key");
  }
  return {
    ok: true,
    value: { keyId, issuerId, p8 },
    meta: { keyId, issuerId },
  };
}

async function validateAscWebhookSecret(
  o: Record<string, unknown>,
): Promise<Validation<"asc-webhook-secret">> {
  const secret = str(o, "secret", 1024);
  if (!secret) return fail("secret", "secret is required");
  return { ok: true, value: { secret }, meta: {} };
}

async function validateGoogleServiceAccount(
  o: Record<string, unknown>,
): Promise<Validation<"google-service-account">> {
  if (o.type !== undefined && o.type !== "service_account")
    return fail("type", 'a Google key file must have type "service_account"');
  const clientEmail = str(o, "client_email", 320);
  if (!clientEmail || !/^[^\s@]+@[^\s@]+$/.test(clientEmail))
    return fail("client_email", "client_email must be the service account");
  const tokenUri = o.token_uri === undefined ? GOOGLE_TOKEN_URI : o.token_uri;
  if (tokenUri !== GOOGLE_TOKEN_URI)
    return fail("token_uri", `token_uri must be ${GOOGLE_TOKEN_URI}`);
  const privateKey = str(o, "private_key", MAX_FIELD);
  if (!privateKey || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey))
    return fail("private_key", "private_key must be the key file's RSA PEM");
  try {
    await importRs256PrivateKey(privateKey);
  } catch {
    return fail("private_key", "private_key is not an RSA private key");
  }
  return {
    ok: true,
    value: {
      client_email: clientEmail,
      private_key: privateKey,
      token_uri: GOOGLE_TOKEN_URI,
    },
    meta: { clientEmail },
  };
}

async function validateMsPartnerCenter(
  o: Record<string, unknown>,
): Promise<Validation<"ms-partner-center">> {
  const tenantId = str(o, "tenantId");
  if (!tenantId) return fail("tenantId", "tenantId is required");
  const clientId = str(o, "clientId");
  if (!clientId) return fail("clientId", "clientId is required");
  const clientSecret = str(o, "clientSecret", 1024);
  if (!clientSecret) return fail("clientSecret", "clientSecret is required");
  const sellerId = str(o, "sellerId");
  if (!sellerId) return fail("sellerId", "sellerId is required");
  return {
    ok: true,
    value: { tenantId, clientId, clientSecret, sellerId },
    meta: { tenantId, clientId, sellerId },
  };
}

const VALIDATORS: {
  [K in OutletCredentialKind]: (
    o: Record<string, unknown>,
  ) => Promise<Validation<K>>;
} = {
  "asc-api-key": validateAscApiKey,
  "asc-webhook-secret": validateAscWebhookSecret,
  "google-service-account": validateGoogleServiceAccount,
  "ms-partner-center": validateMsPartnerCenter,
};

/** Validate a raw value for `kind`: the normalised value to seal and its display metadata, or
 *  the first failing field. Never echoes the value in a message. */
export async function validateOutletCredential<K extends OutletCredentialKind>(
  kind: K,
  raw: unknown,
): Promise<Validation<K>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return fail("value", "value must be an object");
  return VALIDATORS[kind](raw as Record<string, unknown>) as Promise<
    Validation<K>
  >;
}

// ── ids ──────────────────────────────────────────────────────────────────────────────────────

/** A credential id: lowercase, no `:` (the AAD and the token-cache id are `:`-separated, so a
 *  colon could make one slot's id spell another's). */
const CREDENTIAL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isOutletCredentialId(v: unknown): v is string {
  return typeof v === "string" && CREDENTIAL_ID_RE.test(v);
}

/** An outlet id as P2b-02 will name outlets (`app-store`, `play`, `msstore`, …). */
export const isOutletId = isOutletCredentialId;

/** The `use` an open is audited under, e.g. `asc:poll`, `play:token`. */
const USE_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** The AAD slot a credential's value is sealed under. */
export function outletCredentialContext(
  product: string,
  credentialId: string,
): SealContext {
  return { product, kind: "outlet-credential", id: credentialId };
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

/** Every column except the sealed value — the shape listing returns. */
export interface OutletCredentialInfo {
  id: string;
  kind: string;
  outletId: string | null;
  meta: OutletCredentialMeta;
  status: string;
  createdAt: number;
  createdBy: string;
  rotatedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
}

interface InfoRow {
  credential_id: string;
  kind: string;
  outlet_id: string | null;
  meta_json: string;
  status: string;
  created_at: number;
  created_by: string;
  rotated_at: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
}

/** The metadata columns, spelled once. `enc_value_json` is deliberately absent. */
const INFO_COLUMNS =
  "credential_id, kind, outlet_id, meta_json, status, created_at, created_by, rotated_at, expires_at, last_used_at, last_ok_at, last_error";

function parseMeta(json: string): OutletCredentialMeta {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: OutletCredentialMeta = {};
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function toInfo(row: InfoRow): OutletCredentialInfo {
  return {
    id: row.credential_id,
    kind: row.kind,
    outletId: row.outlet_id,
    meta: parseMeta(row.meta_json),
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    rotatedAt: row.rotated_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
  };
}

/** A product's outlet credentials, metadata and health only, in id order. */
export async function listOutletCredentials(
  db: Db,
  product: string,
): Promise<OutletCredentialInfo[]> {
  const rows = await db.all<InfoRow>(
    `SELECT ${INFO_COLUMNS} FROM outlet_credentials WHERE product = ? ORDER BY credential_id`,
    product,
  );
  return rows.map(toInfo);
}

// ── write ────────────────────────────────────────────────────────────────────────────────────

export interface PutOutletCredentialInput {
  product: string;
  credentialId: string;
  kind: OutletCredentialKind;
  outletId: string | null;
  value: unknown;
  expiresAt: number | null;
  /** The verified admin session subject. */
  actor: string;
  now: number;
}

export type PutOutletCredentialResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; status: 409 | 422; message: string; field: string };

/**
 * Validate, seal and store one credential. A new id is inserted; an existing id of the SAME
 * kind is rotated in place (`rotated_at` set, the health columns cleared — they described the
 * old value); an existing id of another kind is refused (409), so a value can never silently
 * change what a connector reads it as.
 *
 * Called ONLY from the Core admin handler, which has already established a platform-admin
 * session. Auditing is the handler's, with the session's actor.
 */
export async function putOutletCredential(
  env: Env,
  db: Db,
  input: PutOutletCredentialInput,
): Promise<PutOutletCredentialResult> {
  if (!isOutletCredentialId(input.credentialId))
    return {
      ok: false,
      status: 422,
      field: "id",
      message: "id must be 1-64 of a-z, 0-9, '.', '_' or '-'",
    };
  const checked = await validateOutletCredential(input.kind, input.value);
  if (!checked.ok)
    return {
      ok: false,
      status: 422,
      field: checked.field,
      message: checked.message,
    };
  const existing = await db.first<{ kind: string }>(
    "SELECT kind FROM outlet_credentials WHERE product = ? AND credential_id = ?",
    input.product,
    input.credentialId,
  );
  if (existing && existing.kind !== input.kind)
    return {
      ok: false,
      status: 409,
      field: "kind",
      message: `credential ${input.credentialId} is a ${existing.kind}; delete it before reusing the id`,
    };
  const enc = await seal(
    env,
    JSON.stringify(checked.value),
    outletCredentialContext(input.product, input.credentialId),
  );
  const meta = JSON.stringify(checked.meta);
  if (existing) {
    await db.run(
      `UPDATE outlet_credentials
          SET enc_value_json = ?, meta_json = ?, outlet_id = ?, expires_at = ?, status = 'active',
              rotated_at = ?, last_used_at = NULL, last_ok_at = NULL, last_error = NULL
        WHERE product = ? AND credential_id = ?`,
      enc,
      meta,
      input.outletId,
      input.expiresAt,
      input.now,
      input.product,
      input.credentialId,
    );
  } else {
    await db.run(
      `INSERT INTO outlet_credentials
         (product, credential_id, kind, outlet_id, enc_value_json, meta_json, status,
          created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      input.product,
      input.credentialId,
      input.kind,
      input.outletId,
      enc,
      meta,
      input.now,
      input.actor,
    );
  }
  return { ok: true, id: input.credentialId, created: !existing };
}

/** Delete one credential. `true` when a row was removed. */
export async function deleteOutletCredential(
  db: Db,
  product: string,
  credentialId: string,
): Promise<boolean> {
  const n = await db.runChanges(
    "DELETE FROM outlet_credentials WHERE product = ? AND credential_id = ?",
    product,
    credentialId,
  );
  return n > 0;
}

// ── open ─────────────────────────────────────────────────────────────────────────────────────

/** An opened credential: the parsed, kind-typed value plus where it came from. */
export interface OpenedOutletCredential<
  K extends OutletCredentialKind = OutletCredentialKind,
> {
  product: string;
  credentialId: string;
  kind: K;
  outletId: string | null;
  value: OutletCredentialValues[K];
  /** The non-secret version marker of the blob this value was opened from — the same string
   *  `outletCredentialVersion` answers for it. Caches key by it. */
  version: string;
}

/** A non-secret version marker for a sealed value: the first 128 bits of the SHA-256 of the
 *  ciphertext. It changes whenever the stored value does (a rotation, a delete and re-create,
 *  and also a KEK re-seal, which only costs a cache miss) and says nothing about the plaintext. */
async function versionOf(encValueJson: string): Promise<string> {
  return (await sha256Hex(encValueJson)).slice(0, 32);
}

/**
 * The version marker of one usable credential, WITHOUT opening it: `null` for an unknown id, a
 * disabled row or (with `kind`) a row of another kind — the cases where `openOutletCredential`
 * would also answer null before decrypting. Not audited: nothing secret leaves the table, and
 * nothing is decrypted. A token cache keyed by this marker can be checked before any open, so
 * a connector opens (and audits) its credential only on a cache miss.
 */
export async function outletCredentialVersion(
  db: Db,
  product: string,
  credentialId: string,
  kind?: OutletCredentialKind,
): Promise<string | null> {
  const row = await db.first<{
    kind: string;
    enc_value_json: string;
    status: string;
  }>(
    "SELECT kind, enc_value_json, status FROM outlet_credentials WHERE product = ? AND credential_id = ?",
    product,
    credentialId,
  );
  if (
    !row ||
    row.status !== "active" ||
    !isOutletCredentialKind(row.kind) ||
    (kind !== undefined && row.kind !== kind)
  )
    return null;
  return versionOf(row.enc_value_json);
}

/** Every open is attributed to the Distribution service: it is the only caller. */
export const OUTLET_CREDENTIAL_ACTOR = "system:distribution";

/**
 * Open one credential for one `use` (e.g. `asc:poll`), optionally requiring a kind.
 *
 * Returns `null` — "unusable credential" — for an unknown id, a disabled row, a kind other than
 * `opts.kind`, a value that will not open (wrong AAD, retired KEK, tampered blob) or will not
 * re-validate, and an invalid `use`. Never throws on any of those, and never says which: the
 * caller's fail-closed branch is the same for all of them, and the value is never returned in
 * part.
 *
 * Every call, usable or not, appends one `outlet_credential.use` audit row (actor
 * `system:distribution`, the `use`, and the outcome) and stamps `last_used_at` on an existing
 * row. Callers that only need a token go through `core/outletTokens.ts`, which checks its
 * cache by `outletCredentialVersion` first and calls this only on a miss — that is what keeps
 * the audit trail to tens of rows a day per credential. A caller that needs the raw value on
 * every request (verifying an inbound webhook against `asc-webhook-secret`, say) opens it every
 * time; such a path must authenticate or rate-limit the request BEFORE the open, or every
 * unauthenticated request becomes two D1 writes.
 */
export async function openOutletCredential<
  K extends OutletCredentialKind = OutletCredentialKind,
>(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  use: string,
  opts: { kind?: K; now?: number } = {},
): Promise<OpenedOutletCredential<K> | null> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const validUse = USE_RE.test(use);
  const row = validUse
    ? await db.first<{
        kind: string;
        outlet_id: string | null;
        enc_value_json: string;
        status: string;
      }>(
        "SELECT kind, outlet_id, enc_value_json, status FROM outlet_credentials WHERE product = ? AND credential_id = ?",
        product,
        credentialId,
      )
    : null;

  let opened: OpenedOutletCredential<K> | null = null;
  if (
    row &&
    row.status === "active" &&
    isOutletCredentialKind(row.kind) &&
    (opts.kind === undefined || row.kind === opts.kind)
  ) {
    try {
      const plaintext = await open(
        env,
        row.enc_value_json,
        outletCredentialContext(product, credentialId),
      );
      // Re-validate on the way out: a stored value is trusted no more than an incoming one.
      const checked = await validateOutletCredential(
        row.kind,
        JSON.parse(plaintext) as unknown,
      );
      if (checked.ok) {
        opened = {
          product,
          credentialId,
          kind: row.kind as K,
          outletId: row.outlet_id,
          value: checked.value as OutletCredentialValues[K],
          version: await versionOf(row.enc_value_json),
        };
      }
    } catch {
      opened = null;
    }
  }

  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: OUTLET_CREDENTIAL_ACTOR,
    actor_name: "Distribution service",
    actor_email: null,
    action: "outlet_credential.use",
    target_kind: "outlet_credential",
    target_id: credentialId,
    parent_id: null,
    summary: `${validUse ? use : "(invalid use)"}: ${opened ? "opened" : "unusable credential"}`,
  });
  if (row) {
    await db.run(
      "UPDATE outlet_credentials SET last_used_at = ? WHERE product = ? AND credential_id = ?",
      now,
      product,
      credentialId,
    );
  }
  return opened;
}

/** The longest `last_error` kept; a connector's error is a status line, not a body. */
const MAX_ERROR = 200;

/**
 * Record what the outlet said when a connector used a credential: `ok` stamps `last_ok_at` and
 * clears `last_error`; an error stores its (truncated) message. The caller must pass a status
 * line it composed — never a response body or anything derived from the credential.
 */
export async function recordOutletCredentialResult(
  db: Db,
  product: string,
  credentialId: string,
  result: { ok: true } | { ok: false; error: string },
  now: number,
): Promise<void> {
  if (result.ok) {
    await db.run(
      "UPDATE outlet_credentials SET last_ok_at = ?, last_error = NULL WHERE product = ? AND credential_id = ?",
      now,
      product,
      credentialId,
    );
    return;
  }
  await db.run(
    "UPDATE outlet_credentials SET last_error = ? WHERE product = ? AND credential_id = ?",
    result.error.slice(0, MAX_ERROR),
    product,
    credentialId,
  );
}

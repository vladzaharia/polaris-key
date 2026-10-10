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
 *   - **The operator names the app.** A kind whose key can reach more than one store app (a
 *     team-wide App Store Connect key) carries an operator-owned **pin**: the one app id its
 *     connector may read and act on (`OUTLET_CREDENTIAL_PINS`). The pin is set only by the Core
 *     admin handler (`putOutletCredential`, `pinOutletCredential`), kept in `meta_json`, and
 *     compared with the manifest's outlet identity by `checkOutletCredentialPin`; a missing or
 *     different pin leaves the connector inert. See "Pins" below.
 *
 * Later kinds are added by the packages that need them (P6-01, P6-02, P6-03): one entry in
 * `KINDS` with a validator and its metadata projection.
 */

import type { Env } from "../platform/env.js";
import type { Db, DbStatement } from "../db/types.js";
import { open, seal, type SealContext } from "../platform/keyvault.js";
import { appendAudit } from "./repo.js";
import { randomId } from "../platform/crypto.js";
import { sha256Hex } from "../platform/hash.js";
import { importEs256PrivateKey, importRs256PrivateKey } from "./jwt.js";

// ── kinds ────────────────────────────────────────────────────────────────────────────────────

/** An App Store Connect API key (team key; least privilege is the App Manager role). */
export interface AscApiKey {
  keyId: string;
  issuerId: string;
  /** The `.p8` file's contents: a P-256 PKCS#8 PEM. */
  p8: string;
}

/** The shared secret App Store Connect webhook notifications are signed with (HMAC-SHA256,
 *  `x-apple-signature: hmacsha256=…`; P5-02). Not App Store Server Notifications v2, which are
 *  JWS-signed by Apple and need no shared secret. */
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

/** A Sentry internal integration's client secret (P6-03): Sentry signs every webhook it sends
 *  with it (`Sentry-Hook-Signature`: hex HMAC-SHA256 of the body). It reaches nothing at Sentry
 *  on its own — the Worker never calls Sentry — so it authenticates Sentry to us, not us to it. */
export interface SentryIntegration {
  clientSecret: string;
}

/** An App Store Server API key — App Store Connect → Users and Access → Integrations → In-App
 *  Purchase (P6-01). Not the App Store Connect API key (`asc-api-key`): Apple issues these
 *  separately, and this one reaches only the App Store Server API (transaction history, refund
 *  lookup) of every app of the team — so it carries a pin, the bundle id it may be used for. */
export interface AppStoreServerKey {
  keyId: string;
  issuerId: string;
  /** The `.p8` file's contents: a P-256 PKCS#8 PEM. */
  p8: string;
}

/** A Steamworks Web API publisher key (P6-01): the `partner.steam-api.com` key that can call
 *  `ISteamUserAuth/AuthenticateUserTicket` and `ISteamUser/CheckAppOwnership` for every app of
 *  the publisher — so it carries a pin, the app id it may be used for. */
export interface SteamPublisherKey {
  key: string;
}

export interface OutletCredentialValues {
  "asc-api-key": AscApiKey;
  "app-store-server-key": AppStoreServerKey;
  "steam-publisher-key": SteamPublisherKey;
  "asc-webhook-secret": AscWebhookSecret;
  "google-service-account": GoogleServiceAccount;
  "ms-partner-center": MsPartnerCenter;
  "sentry-integration": SentryIntegration;
}

export type OutletCredentialKind = keyof OutletCredentialValues;

export const OUTLET_CREDENTIAL_KINDS: readonly OutletCredentialKind[] = [
  "asc-api-key",
  "app-store-server-key",
  "steam-publisher-key",
  "asc-webhook-secret",
  "google-service-account",
  "ms-partner-center",
  "sentry-integration",
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

async function validateAppStoreServerKey(
  o: Record<string, unknown>,
): Promise<Validation<"app-store-server-key">> {
  // The same shape as an App Store Connect API key, and the same checks.
  const r = await validateAscApiKey(o);
  return r.ok ? { ok: true, value: r.value, meta: r.meta } : r;
}

async function validateSteamPublisherKey(
  o: Record<string, unknown>,
): Promise<Validation<"steam-publisher-key">> {
  const key = str(o, "key", 64);
  if (!key || !/^[0-9A-Fa-f]{32}$/.test(key))
    return fail(
      "key",
      "key must be the 32-hex-digit Steamworks Web API publisher key",
    );
  return { ok: true, value: { key: key.toUpperCase() }, meta: {} };
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

async function validateSentryIntegration(
  o: Record<string, unknown>,
): Promise<Validation<"sentry-integration">> {
  const clientSecret = str(o, "clientSecret", 1024);
  if (!clientSecret)
    return fail(
      "clientSecret",
      "clientSecret must be the internal integration's client secret",
    );
  return { ok: true, value: { clientSecret }, meta: {} };
}

const VALIDATORS: {
  [K in OutletCredentialKind]: (
    o: Record<string, unknown>,
  ) => Promise<Validation<K>>;
} = {
  "asc-api-key": validateAscApiKey,
  "app-store-server-key": validateAppStoreServerKey,
  "steam-publisher-key": validateSteamPublisherKey,
  "asc-webhook-secret": validateAscWebhookSecret,
  "google-service-account": validateGoogleServiceAccount,
  "ms-partner-center": validateMsPartnerCenter,
  "sentry-integration": validateSentryIntegration,
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

// ── the transient path (UX-69, SETUP.md D42) ─────────────────────────────────────────────────

/**
 * A credential value held for ONE request and never stored: the live check a connect form runs
 * on paste, before anything is saved (`POST …/store-connections/<store>/check`).
 *
 * It is validated by the kind's own validator, exactly as a stored value is, and then wrapped so
 * that the value cannot leave by accident:
 *
 *   - the value is a private field, read only through `reveal()` by the check that sends it to
 *     its store (`outletCredentialReach.test.ts` keeps `transientOutletCredential` to the
 *     store-connections handler and `reveal()` to the Distribution service and the token helpers);
 *   - `JSON.stringify`, string conversion and Node's `inspect` all render the kind and display
 *     metadata only, so a response, an audit row or a log line built from it carries no key;
 *   - nothing here seals, writes, caches or audits: the value lives exactly as long as the
 *     request that carried it. A token minted from it (`core/outletTokens.ts`, the `transient…`
 *     functions) is never cached either.
 */
export class TransientOutletCredential<
  K extends OutletCredentialKind = OutletCredentialKind,
> {
  readonly #value: OutletCredentialValues[K];

  constructor(
    readonly kind: K,
    value: OutletCredentialValues[K],
    /** Non-secret display fields (key id, issuer id, client email, …). */
    readonly meta: OutletCredentialMeta,
  ) {
    this.#value = value;
  }

  /** The value itself, for the one call that sends it to its store. Never log or echo it. */
  reveal(): OutletCredentialValues[K] {
    return this.#value;
  }

  toJSON(): { kind: K; meta: OutletCredentialMeta; transient: true } {
    return { kind: this.kind, meta: this.meta, transient: true };
  }

  toString(): string {
    return `[transient ${this.kind}]`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export type TransientValidation<K extends OutletCredentialKind> =
  | { ok: true; credential: TransientOutletCredential<K> }
  | { ok: false; message: string; field: string };

/** Validate an unsaved value for `kind` into a transient credential, or the first failing field
 *  (the same validator, and the same messages, as a stored value). Never echoes the value. */
export async function transientOutletCredential<K extends OutletCredentialKind>(
  kind: K,
  raw: unknown,
): Promise<TransientValidation<K>> {
  const r = await validateOutletCredential(kind, raw);
  if (!r.ok) return { ok: false, message: r.message, field: r.field };
  return {
    ok: true,
    credential: new TransientOutletCredential(kind, r.value, r.meta),
  };
}

// ── pins ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Pins: which store app a credential may be used for, decided by the operator (P5-02f).
 *
 * The app a connector reads and acts on is named by the product's `.pkey/distribution` outlet
 * identity (`appleId`, `packageName`, …), which the repo rewrites on every resync. The credential
 * is the operator's, and for some stores one key reaches every app of a team. Without a pin, a
 * repo writer could aim the operator's key — and the console's irreversible controls — at any
 * app that key can see (a confused deputy; THREAT-MODEL.md, "Who picks the outlet's app"). So a
 * kind listed here carries one operator-owned value, the **pin**, and a connector runs only when
 * the manifest's identity field equals it (`checkOutletCredentialPin`):
 *
 *   - **Where it lives.** In `meta_json` under `field` (`appleId` for `asc-api-key`, `packageName`
 *     for `google-service-account`), beside the kind's display metadata. It is not secret and not
 *     sealed; it is written only by the Core admin handler, through `putOutletCredential` (`pin`
 *     in the PUT body, alongside a value) or `pinOutletCredential` (a PUT with `pin` and no
 *     value: re-pinning never needs the key material again). The reach test keeps both writers to that handler.
 *   - **Required where used, not at write.** A credential may be stored before it is pinned (and
 *     rows from before P5-02f have none); a rotation that omits `pin` keeps the stored one. A
 *     connector treats a missing pin exactly as a wrong one: inert, with the reason shown.
 *   - **Audited.** Every change of a pin is its own `outlet_credential.pin` audit row (old and
 *     new value) written by the admin handler, apart from the `outlet_credential.set` row.
 *
 * Reuse by other connectors: add one entry here — as P5-03 did for the Play app's package name
 * (`google-service-account`, field `packageName`) and P5-04 for the Microsoft Store app's Store
 * ID (`ms-partner-center`, field `productId`) — and call
 * `checkOutletCredentialPin(info, identity.<field>)` in that connector's setup before it opens
 * anything, refusing every control and webhook when it is not `ok`. Nothing else in this module or
 * the admin handler changes: the PUT body's `pin`, the list's `pins` map, the audit row and the
 * console's re-pin action are all keyed by this table. The console's create form gives the kind
 * its `pin` entry (`OutletCredentials.tsx`, `KINDS`) so the pin is required with the key.
 */
export interface OutletCredentialPinSpec {
  /** The `meta_json` field the pin is stored under, named after the outlet identity field it is
   *  compared with. */
  field: string;
  /** What a valid pin looks like. */
  pattern: RegExp;
  /** A human label for the pinned value (the console's field label). */
  label: string;
  /** The 422 message for a malformed pin. Never echoes the input. */
  message: string;
}

export const OUTLET_CREDENTIAL_PINS: Readonly<
  Partial<Record<OutletCredentialKind, OutletCredentialPinSpec>>
> = {
  "asc-api-key": {
    field: "appleId",
    pattern: /^[0-9]{1,20}$/,
    label: "App Store Connect app id (Apple ID)",
    message:
      "pin must be the App Store Connect app id (the app's numeric Apple ID)",
  },
  // P6-01: an In-App Purchase key reaches the App Store Server API of every app of the team; the
  // commerce bridge uses it only for the bundle id the operator pinned, compared with the
  // commerce settings' `bundleId`.
  "app-store-server-key": {
    field: "bundleId",
    pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/,
    label: "App Store bundle id",
    message: "pin must be the app's bundle id (such as gg.vlad.diceroll)",
  },
  // P6-01: a Steamworks publisher key reaches every app of the publisher; the commerce bridge uses
  // it only for the app id the operator pinned, compared with the commerce settings' `appId`.
  "steam-publisher-key": {
    field: "appId",
    pattern: /^[1-9][0-9]{0,9}$/,
    label: "Steam app id",
    message: "pin must be the game's Steam app id (digits, such as 480)",
  },
  // A Google Play service account can be invited to every app of a developer account (P5-03).
  // The Android package-name rule, with the 255-character cap the manifest and the Play setup
  // apply: the pin is compared byte-for-byte with the outlet identity's `packageName`.
  "google-service-account": {
    field: "packageName",
    pattern: /^(?=.{1,255}$)[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/,
    label: "Google Play package name",
    message:
      "pin must be the Google Play app's package name (an Android application id such as com.example.game)",
  },
  // A Partner Center Entra app with the Manager role reaches every app of the seller account
  // (P5-04). The manifest's `ms-store` `productId` rule: the 12-character Store ID.
  "ms-partner-center": {
    field: "productId",
    pattern: /^[A-Za-z0-9]{12}$/,
    label: "Microsoft Store product id (Store ID)",
    message:
      "pin must be the Microsoft Store product id (the app's 12-character Store ID, such as 9NBLGGH4R315)",
  },
};

/** The pin spec of a kind, or `null` for a kind without one. */
export function outletCredentialPinSpec(
  kind: string,
): OutletCredentialPinSpec | null {
  return isOutletCredentialKind(kind)
    ? (OUTLET_CREDENTIAL_PINS[kind] ?? null)
    : null;
}

/** Validate a raw pin for `kind`: the trimmed value, or why it is refused. */
export function validateOutletCredentialPin(
  kind: OutletCredentialKind,
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  const spec = OUTLET_CREDENTIAL_PINS[kind];
  if (!spec) return { ok: false, message: `a ${kind} takes no pin` };
  const v = typeof raw === "string" ? raw.trim() : null;
  if (!v || !spec.pattern.test(v)) return { ok: false, message: spec.message };
  return { ok: true, value: v };
}

/** The stored pin of a listed credential, or `null` when its kind has none or none is set. */
export function outletCredentialPin(info: {
  kind: string;
  meta: OutletCredentialMeta;
}): string | null {
  const spec = outletCredentialPinSpec(info.kind);
  if (!spec) return null;
  const v = info.meta[spec.field];
  return typeof v === "string" && spec.pattern.test(v) ? v : null;
}

/** Whether a credential may be used for the app the manifest names. */
export type OutletCredentialPinCheck =
  | { ok: true; pinned: string }
  | { ok: false; reason: "pin_missing"; pinned: null }
  | { ok: false; reason: "pin_mismatch"; pinned: string };

/**
 * Compare a credential's pin with the app id the manifest's outlet identity names. `ok` only on an
 * exact match; a kind that should be pinned but is not, and a pin naming another app, both refuse.
 * A connector must call this before it opens the credential, and treat every refusal as "not set
 * up": no store call, no write, every control refused.
 */
export function checkOutletCredentialPin(
  info: { kind: string; meta: OutletCredentialMeta },
  expected: string,
): OutletCredentialPinCheck {
  const pinned = outletCredentialPin(info);
  if (pinned === null) return { ok: false, reason: "pin_missing", pinned };
  if (pinned !== expected) return { ok: false, reason: "pin_mismatch", pinned };
  return { ok: true, pinned };
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

/** Every ACTIVE credential of `kind` across all products that carries a pin — metadata only.
 *  The platform store connection (A-16) reads it to refuse assigning an app another product's
 *  own credential is already pinned to, and to show who holds each app. */
export async function listOutletCredentialPins(
  db: Db,
  kind: OutletCredentialKind,
): Promise<Array<{ product: string; credentialId: string; pin: string }>> {
  const rows = await db.all<{
    product: string;
    credential_id: string;
    meta_json: string;
  }>(
    "SELECT product, credential_id, meta_json FROM outlet_credentials WHERE kind = ? AND status = 'active' ORDER BY product, credential_id",
    kind,
  );
  const out: Array<{ product: string; credentialId: string; pin: string }> = [];
  for (const r of rows) {
    const pin = outletCredentialPin({ kind, meta: parseMeta(r.meta_json) });
    if (pin !== null)
      out.push({ product: r.product, credentialId: r.credential_id, pin });
  }
  return out;
}

// ── write ────────────────────────────────────────────────────────────────────────────────────

export interface PutOutletCredentialInput {
  product: string;
  credentialId: string;
  kind: OutletCredentialKind;
  outletId: string | null;
  value: unknown;
  expiresAt: number | null;
  /** The operator's pin for a kind in `OUTLET_CREDENTIAL_PINS`; omitted keeps the stored one. */
  pin?: unknown;
  /** The verified admin session subject. */
  actor: string;
  now: number;
}

/** A pin that a write changed: the stored value before (`null`: none) and after. */
export interface OutletCredentialPinChange {
  field: string;
  before: string | null;
  after: string;
}

export type PutOutletCredentialResult =
  | {
      ok: true;
      id: string;
      created: boolean;
      /** Set when the write changed the pin; the caller audits it. */
      pinChange: OutletCredentialPinChange | null;
    }
  | { ok: false; status: 404 | 409 | 422; message: string; field: string };

/**
 * Validate, seal and store one credential. A new id is inserted; an existing id of the SAME
 * kind is rotated in place (`rotated_at` set, the health columns cleared — they described the
 * old value); an existing id of another kind is refused (409), so a value can never silently
 * change what a connector reads it as.
 *
 * `pin` (kinds in `OUTLET_CREDENTIAL_PINS` only) sets the operator's pin; omitted, a rotation
 * keeps the stored pin, so rotating the key material never silently un-pins it.
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
  const spec = OUTLET_CREDENTIAL_PINS[input.kind];
  let pin: string | null = null;
  if (input.pin !== undefined) {
    const p = validateOutletCredentialPin(input.kind, input.pin);
    if (!p.ok)
      return { ok: false, status: 422, field: "pin", message: p.message };
    pin = p.value;
  }
  const existing = await db.first<{ kind: string; meta_json: string }>(
    "SELECT kind, meta_json FROM outlet_credentials WHERE product = ? AND credential_id = ?",
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
  const before = existing
    ? outletCredentialPin({
        kind: existing.kind,
        meta: parseMeta(existing.meta_json),
      })
    : null;
  const after = pin ?? before;
  const enc = await seal(
    env,
    JSON.stringify(checked.value),
    outletCredentialContext(input.product, input.credentialId),
  );
  // The pin is the operator's, never the value's: it is written after the kind's projection so
  // no field of a value can stand in for it.
  const meta = JSON.stringify(
    spec && after !== null
      ? { ...checked.meta, [spec.field]: after }
      : checked.meta,
  );
  const pinChange: OutletCredentialPinChange | null =
    spec && pin !== null && pin !== before
      ? { field: spec.field, before, after: pin }
      : null;
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
  return { ok: true, id: input.credentialId, created: !existing, pinChange };
}

export interface PinOutletCredentialInput {
  product: string;
  credentialId: string;
  kind: OutletCredentialKind;
  pin: unknown;
}

/**
 * Set the operator's pin on a stored credential without touching its value: `meta_json` only, so
 * the sealed blob, its version marker (and with it every cached token), `rotated_at` and the
 * health columns are unchanged. 404 for an unknown id, 409 for a row of another kind, 422 for a
 * kind without a pin or a malformed pin.
 *
 * Called ONLY from the Core admin handler (the reach test), which audits a change as
 * `outlet_credential.pin`.
 */
export async function pinOutletCredential(
  db: Db,
  input: PinOutletCredentialInput,
): Promise<PutOutletCredentialResult> {
  if (!isOutletCredentialId(input.credentialId))
    return {
      ok: false,
      status: 404,
      field: "id",
      message: "no such credential",
    };
  const p = validateOutletCredentialPin(input.kind, input.pin);
  if (!p.ok)
    return { ok: false, status: 422, field: "pin", message: p.message };
  const spec = OUTLET_CREDENTIAL_PINS[input.kind]!;
  const row = await db.first<{ kind: string; meta_json: string }>(
    "SELECT kind, meta_json FROM outlet_credentials WHERE product = ? AND credential_id = ?",
    input.product,
    input.credentialId,
  );
  if (!row)
    return {
      ok: false,
      status: 404,
      field: "id",
      message: "no such credential",
    };
  if (row.kind !== input.kind)
    return {
      ok: false,
      status: 409,
      field: "kind",
      message: `credential ${input.credentialId} is a ${row.kind}`,
    };
  const meta = parseMeta(row.meta_json);
  const before = outletCredentialPin({ kind: row.kind, meta });
  if (before !== p.value) {
    await db.run(
      "UPDATE outlet_credentials SET meta_json = ? WHERE product = ? AND credential_id = ?",
      JSON.stringify({ ...meta, [spec.field]: p.value }),
      input.product,
      input.credentialId,
    );
  }
  return {
    ok: true,
    id: input.credentialId,
    created: false,
    pinChange:
      before === p.value ? null : { field: spec.field, before, after: p.value },
  };
}

/**
 * Plan a re-pin of every ACTIVE credential of `kind` the product holds to `pin`, as statements for
 * one atomic batch (A-16's app assignment), without writing anything. `account` decides, per
 * credential, whether its key belongs to the same store account as the platform's team key:
 * `same` is re-pinned, `different` is returned in `refused` (the caller refuses the whole
 * assignment), `unknown` is left alone and returned in `skipped`. Named only by this module and
 * the Core admin handler (the reach test's writer allowlist).
 */
export async function planOutletCredentialRepin(
  db: Db,
  product: string,
  kind: OutletCredentialKind,
  pin: string,
  account: (meta: OutletCredentialMeta) => "same" | "different" | "unknown",
): Promise<{
  writes: DbStatement[];
  changes: Array<{ id: string; field: string; before: string | null }>;
  skipped: Array<{ id: string; reason: string }>;
  refused: Array<{ id: string; reason: string }>;
}> {
  const spec = OUTLET_CREDENTIAL_PINS[kind];
  const out = {
    writes: [] as DbStatement[],
    changes: [] as Array<{ id: string; field: string; before: string | null }>,
    skipped: [] as Array<{ id: string; reason: string }>,
    refused: [] as Array<{ id: string; reason: string }>,
  };
  if (!spec) return out;
  const rows = await db.all<{ credential_id: string; meta_json: string }>(
    "SELECT credential_id, meta_json FROM outlet_credentials WHERE product = ? AND kind = ? AND status = 'active' ORDER BY credential_id",
    product,
    kind,
  );
  for (const r of rows) {
    const meta = parseMeta(r.meta_json);
    const before = outletCredentialPin({ kind, meta });
    if (before === pin) continue;
    const a = account(meta);
    if (a === "different") {
      out.refused.push({ id: r.credential_id, reason: "other_account" });
      continue;
    }
    if (a === "unknown") {
      out.skipped.push({ id: r.credential_id, reason: "account_unverified" });
      continue;
    }
    out.writes.push({
      sql: "UPDATE outlet_credentials SET meta_json = ? WHERE product = ? AND credential_id = ? AND meta_json = ?",
      params: [
        JSON.stringify({ ...meta, [spec.field]: pin }),
        product,
        r.credential_id,
        r.meta_json,
      ],
    });
    out.changes.push({ id: r.credential_id, field: spec.field, before });
  }
  return out;
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

// @polaris-key/protocol — the Polaris Key wire contract types ONLY (no runtime, no
// crypto). These shapes are the source of truth every SDK + the Worker mirror. The
// managed-config document is the JWS payload (see @polaris-key/jws for the encoding);
// any field drift here silently breaks cross-platform verification, so treat changes as
// wire-breaking and bump PROTOCOL_VERSION + regenerate the conformance corpus.
//
// Times are epoch SECONDS (matching the JOSE world the Worker signs in), never millis.

/** Bumped on any wire-breaking change to the document shape or HTTP contract. */
export const PROTOCOL_VERSION = 2;

/** The `iss` every Polaris Key document carries — the control-plane origin host. */
export const ISSUER = "key.plrs.im";

/** A JSON-serialisable value — the type every managed entry carries. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Per-key MDM-style management state.
 *  - `enforced` ⇒ the server value wins; the client CANNOT override it (shown read-only).
 *  - `hidden`   ⇒ `enforced` AND withheld from user-facing enumeration (still applied).
 *  - `default`  ⇒ the server's `value` is a default; the client may override it via a
 *    local/user override or an environment variable (precedence: enforced|hidden > local >
 *    env > remote-default > schema-default). */
export type ManagementState = "default" | "enforced" | "hidden";

/** A managed value, its management state, and when an admin last changed it. */
export interface ManagedEntry {
  state: ManagementState;
  value: JSONValue;
  /** Epoch seconds of the last admin change to this key (for client change-detection). */
  updatedAt: number;
}

/** The three payload kinds, each routed to a different store on arrival: `config` →
 *  plaintext, `secrets` → OS keyring, `entitlements` → the capability map. Keys are the
 *  product catalog's dotted entry keys (e.g. `run.concurrency`, `polarisVpn`). */
export interface ManagedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
  entitlements: Record<string, ManagedEntry>;
}

/** The profile block for the client's offline, tamper-proof greeting (signed, so it
 *  can't be spoofed locally). */
export interface DocProfile {
  name: string;
  firstName: string;
  email: string;
  /** Epoch seconds the key was first enrolled. */
  enrolledAt: number;
}

/**
 * The JWS payload — the whole object the Worker signs (EdDSA/Ed25519) and every client
 * verifies. `aud` (product slug) + `iss` scope the document to one product/tenant as
 * defense-in-depth on top of the per-product signing key; clients MUST assert
 * `aud === their configured product`. It binds `licenseId`+`deviceId`+`issuedAt`+
 * `expiresAt`+`graceUntil`+`schemaVersion` so a doc can't be replayed across devices or
 * spliced to extend grace. `expiresAt` is short (~1h); `graceUntil` carries the long,
 * server-signed offline window.
 */
export interface ManagedConfigDoc {
  schemaVersion: number;
  /** Product slug — the audience this document is scoped to. */
  aud: string;
  /** Issuer — always `ISSUER`. */
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  /** Short — `issuedAt + DOC_EXPIRY_SECONDS`. */
  expiresAt: number;
  /** Offline-grace anchor — `issuedAt + maxOfflineDays * 86400`. */
  graceUntil: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

/** The terminal gate state a client renders from. */
export type LicenseStatus =
  | "ok"
  | "grace"
  | "expired"
  | "revoked"
  | "needs-enroll"
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled";

/** A 403 block reason returned by `GET /<product>/config`. */
export type BlockReason = "version-too-old" | "version-too-new" | "channel-not-entitled";

/** The version window a blocked client may run within. */
export interface AllowedRange {
  min?: string;
  max?: string;
}

/** Short signed-token lifetime (seconds) — a replayed doc needs constant re-signing. */
export const DOC_EXPIRY_SECONDS = 3600;

/** Seconds per day, for the offline-grace computation. */
export const SECONDS_PER_DAY = 86_400;

/** Client→Worker request headers (replaces djdl's `X-DJDL-*`). */
export const HEADER_DEVICE = "X-PKey-Device";
export const HEADER_VERSION = "X-PKey-Version";
export const HEADER_CHANNEL = "X-PKey-Channel";

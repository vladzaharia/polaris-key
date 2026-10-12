// @polaris-key/protocol/license — License service wire types (wire contract v3 §2.1, §5).

import type { DocClaims, ManagedEntry } from "./core.js";

/**
 * WIRE-CONTRACT-V4 §2.1 (SP-54): the person signed in on the device a licence document was
 * issued to. `subject` is the account's pairwise subject for this product
 * (`PAIRWISE_SUBJECT_PATTERN`); there is no name, email or account id. Read it only through
 * client-core's `licenseUserOf`, which is total (§3.2).
 */
export interface SignedInUser {
  subject: string;
}

/** The profile block for the client's offline, tamper-proof greeting (signed, so it
 *  can't be spoofed locally). `name`, `firstName` and `email` are the licence holder's. */
export interface DocProfile {
  name: string;
  firstName: string;
  email: string;
  /** Epoch seconds the key was first activated. */
  activatedAt: number;
  /** SP-54: present only when an account is signed in on the requesting device (V4 §2.1).
   *  Absent for key-entry and open-enrolment devices and in every offline bundle. A verifier
   *  never checks it (§3.2); read it with `licenseUserOf`. */
  user?: SignedInUser;
}

/**
 * The license document (`typ: "pkey-license+jws"`) — the ONLY carrier of grant data
 * (D-20). Admin/tier policy arrives as enforced entitlements (`license.tier`,
 * `license.tierLabel`, `channels`, `app.minVersion`, `app.maxVersion`, `deviceLimit`)
 * alongside catalog-declared flags. License STATE (`ok`/`grace`/…) is never carried in
 * the document; the client gate derives it.
 */
export interface LicenseDoc extends DocClaims {
  licenseId: string;
  profile?: DocProfile;
  entitlements: Record<string, ManagedEntry>;
}

/** The terminal gate state a client renders from. `not-applicable` is returned when the
 *  product does not enable the license service (isUsable ⇒ true) — the suite's
 *  config-only/release-only products boot usable, not "needs-activation". */
export type LicenseStatus =
  | "ok"
  | "grace"
  | "expired"
  | "revoked"
  | "needs-activation"
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled"
  | "not-applicable";

/**
 * The 403 block reasons `GET /<product>/license/document` may return — as a RUNTIME value, not
 * only a type.
 *
 * `BlockReason` used to be a bare `type`, which TypeScript erases at compile time. The gate
 * returns the reason string verbatim AS the `LicenseStatus`, and `isUsable` answers true for
 * `ok`, `grace` and `not-applicable`. So the erased type was the only thing standing between an
 * unsigned, attacker-writable hint and the gate: `{"v":3,"blocked":{"reason":"ok"}}` written into
 * the cache file licensed the client with no signature anywhere. WIRE-CONTRACT-V4 §4.1 keeps the
 * hint unsigned on the argument that it can only ever make the gate STRICTER, and that argument
 * is about the VOCABULARY, so membership is checked at runtime: at the network ingress, at the
 * cache-reload edge, at the browser session and inside the gate itself.
 */
export const BLOCK_REASONS = [
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
] as const;

/** A 403 block reason returned by `GET /<product>/license/document`. */
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * The reason to fall back to when a value is not a `BlockReason`. `version-too-old` is the
 * STRICTEST of the three: every one of them is a non-usable status, and this one names the
 * remedy (upgrade) that is always available to the user. Never default to a permissive status:
 * an unrecognised hint must not be able to loosen anything.
 */
export const STRICTEST_BLOCK_REASON: BlockReason = "version-too-old";

/** Runtime membership test for `BlockReason`. */
export function isBlockReason(value: unknown): value is BlockReason {
  return (
    typeof value === "string" &&
    (BLOCK_REASONS as readonly string[]).includes(value)
  );
}

/** A `BlockReason`, or the strictest one when `value` is out of vocabulary. */
export function coerceBlockReason(value: unknown): BlockReason {
  return isBlockReason(value) ? value : STRICTEST_BLOCK_REASON;
}

/** The version window a blocked client may run within. */
export interface AllowedRange {
  min?: string;
  max?: string;
}

/** How the client became activated: an online-minted `pkeyt_` device token, or a verified
 *  offline bundle import (WIRE-CONTRACT-V3 §7). A later token supersedes a bundle. */
export type ActivationSource = "token" | "bundle";

// ── Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3) ────────────────────────────────────────────

/** The longest `manageUrl` a client keeps (characters). A longer one is ignored. */
export const MANAGE_URL_MAX_LENGTH = 2048;

/** The longest `for` label the Worker puts in a `manageUrl` (characters). */
export const MANAGE_FOR_MAX_LENGTH = 64;

/**
 * The flat 403 body of `device_limit` on `POST /<p>/license/activate`, `POST /<p>/license/enroll`
 * and `POST /<p>/identity/session/license`. `manageUrl` is present only while the product's
 * customer portal is on; it opens the portal's free-device flow (an attached licence) or the
 * activate page (a floating licence). It is never an auth failure: a client shows it behind a
 * user action and never wipes state or retries because of it.
 */
export interface DeviceLimitBody {
  error: "device_limit";
  message?: string;
  limit: number;
  deviceCount: number;
  manageUrl?: string;
}

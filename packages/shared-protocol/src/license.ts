// @polaris-key/protocol/license — License service wire types (wire contract v3 §2.1, §5).

import type { DocClaims, ManagedEntry } from "./core.js";

/** The profile block for the client's offline, tamper-proof greeting (signed, so it
 *  can't be spoofed locally). */
export interface DocProfile {
  name: string;
  firstName: string;
  email: string;
  /** Epoch seconds the key was first activated. */
  activatedAt: number;
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

/** A 403 block reason returned by `GET /<product>/license/document`. */
export type BlockReason =
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled";

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

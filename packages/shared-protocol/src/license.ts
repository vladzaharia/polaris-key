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

/**
 * The 403 block reasons `GET /<product>/license/document` may return — as a RUNTIME value,
 * not only a type.
 *
 * `BlockReason` used to be a bare `type`, which TypeScript erases at compile time. The
 * reason string is then returned verbatim BY the gate AS the `LicenseStatus`, and
 * `isUsable` answers true for `ok` / `grace` / `not-applicable`. So the erased type was the
 * only thing standing between an unsigned, attacker-writable hint and the gate: writing
 * `{"v":3,"blocked":{"reason":"ok"}}` into the cache file made the client licensed with no
 * signature anywhere (A1-01). The invariant the code asserts in four places — that the
 * unsigned hints can only ever make the gate STRICTER — is only true if membership is
 * checked at runtime, so it is checked here, at the ingress, at the reload edge, and inside
 * the gate itself.
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
 * remedy (upgrade) that is always available to the user. Never default to a permissive
 * status — the whole point is that an unrecognised hint cannot loosen anything.
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

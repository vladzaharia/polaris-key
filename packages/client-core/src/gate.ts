// The client license gate — wire contract v3 §5. Computes the renderable status from the
// cached signed license document + the monotonic clock floor + the last sync outcome. The
// server enforces version/channel on `GET /<p>/license/document` (a 403 → `blocked`); the
// client reflects that plus offline grace.
//
// Two things are new in v3, both consequences of the suite service model:
//
//   * `licenseServiceEnabled: false` ⇒ `not-applicable` (isUsable true). A config-only or
//     release-only product has no license to be missing, so it must boot USABLE rather than
//     sitting on `needs-activation` forever (D-08).
//   * `activation` replaces v2's `hasToken` boolean: a device is activated either by an
//     online-minted `plrst_` token or by a verified offline bundle import (§7). Both are
//     activated; only `null` is not.
//
// Everything below those two guards is the v2 state machine, unchanged.

import type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  LicenseDoc,
  LicenseStatus,
} from "@plrs/protocol/license";

/** The unsigned 403 hint recorded from the last `/license/document` fetch. Unsigned is safe
 *  because it can only ever make the gate STRICTER (§4.1). */
export interface BlockedState {
  reason: BlockReason;
  allowedRange?: AllowedRange;
}

export interface LicenseState {
  status: LicenseStatus;
  graceUntil?: number;
  lastVerifiedAt?: number;
  allowedRange?: AllowedRange;
}

export interface GateInput {
  /** Whether this product enables the license service at all. `false` short-circuits the
   *  whole machine to `not-applicable` — the product simply is not licensed. */
  licenseServiceEnabled: boolean;
  /** How this install became activated, or `null` when it has not. Replaces v2's `hasToken`. */
  activation: ActivationSource | null;
  /** The cached, re-verified license document (or null if none yet). */
  doc: LicenseDoc | null;
  /** Epoch seconds. */
  now: number;
  /**
   * Monotonic time floor (epoch seconds): `max(issuedAt)` over EVERY artifact this client has
   * re-VERIFIED — license doc, config doc, and the trust manifest — recomputed at load from
   * the cached JWSs, never read from an unsigned field. The gate evaluates at
   * `max(now, highWaterMark)`, which makes clock rollback inert without requiring a trusted
   * local clock (§4.2, finding R4-04).
   *
   * The trust manifest is REQUIRED as a source. Derived from the license document alone the
   * floor is inert, because `doc.issuedAt < doc.graceUntil` always holds, so it can never
   * reach the end of grace. See `clock.highWaterMark`.
   */
  highWaterMark?: number;
  /** Set when the last document fetch returned a hard 401 (after a single re-acquire). */
  lastSyncUnauthorized?: boolean;
  /** Set when the last document fetch returned a 403 version/channel block. */
  blocked?: BlockedState | null;
  /** Epoch seconds of the last successful online verify, surfaced for "last checked" UI. */
  lastVerifiedAt?: number | null;
}

export function licenseState(input: GateInput): LicenseState {
  const { doc } = input;
  // §4.2 — winding the system clock back below the newest signed `issuedAt` we have already
  // verified buys nothing: the gate never sees a time earlier than that floor.
  const now = Math.max(input.now, input.highWaterMark ?? 0);
  const lastVerifiedAt = input.lastVerifiedAt ?? undefined;
  // §5 — a product without the license service has no license state to report, and must not
  // be held hostage by one. This precedes every other rule, including `blocked`.
  if (!input.licenseServiceEnabled) return { status: "not-applicable" };
  // §5 — neither a token nor an imported bundle: nothing has been granted yet.
  if (input.activation === null) return { status: "needs-activation" };
  if (input.blocked) {
    return {
      status: input.blocked.reason,
      allowedRange: input.blocked.allowedRange,
    };
  }
  if (input.lastSyncUnauthorized) return { status: "revoked" };
  if (!doc) return { status: "needs-activation" };
  if (now > doc.graceUntil)
    return { status: "expired", graceUntil: doc.graceUntil };
  if (now > doc.expiresAt) {
    return {
      status: "grace",
      graceUntil: doc.graceUntil,
      lastVerifiedAt,
    };
  }
  return {
    status: "ok",
    graceUntil: doc.graceUntil,
    lastVerifiedAt,
  };
}

/**
 * True when the gate permits running: `ok`, `grace`, or `not-applicable`. Accepts either the
 * whole `LicenseState` or a bare `LicenseStatus`, so both `isUsable(state)` and the v2
 * `isUsable(state.status)` call shape keep working across the SDK migration.
 */
export function isUsable(state: LicenseState | LicenseStatus): boolean {
  const status = typeof state === "string" ? state : state.status;
  return status === "ok" || status === "grace" || status === "not-applicable";
}

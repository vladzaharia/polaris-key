// A port of @polaris-key/node's gate.ts `licenseState` — the React SDK computes the
// renderable gate state itself so it has no runtime dependency on the Node SDK (which
// is Node-only) and so both adapters share one identical derivation. Browser and desktop
// transports both feed a `GateInput` here, guaranteeing mode-parity on `status`.
//
// Times are epoch SECONDS (matching the signed doc + the JOSE world the Worker signs in).

import type { AllowedRange, BlockReason, LicenseStatus, ManagedConfigDoc } from "@polaris-key/protocol";

/** The renderable gate state derived from the cached doc + the last sync outcome. */
export interface LicenseState {
  status: LicenseStatus;
  graceUntil?: number;
  lastVerifiedAt?: number;
  allowedRange?: AllowedRange;
}

/** The inputs every transport reduces to before computing the gate. */
export interface GateInput {
  /** Whether a credential (per-machine token desktop / cookie session browser) exists. */
  hasToken: boolean;
  /** The cached, verified doc (or null if none yet). */
  doc: ManagedConfigDoc | null;
  /** Epoch seconds. */
  now: number;
  /** Set when the last config read returned a hard 401 (after a token/session retry). */
  lastSyncUnauthorized?: boolean;
  /** Set when the last config read returned a 403 version/channel block. */
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
  /** Epoch ms of the last successful online verify. */
  lastVerifiedAt?: number;
}

/**
 * Compute the gate. Identical algorithm to the Node SDK: a 403 block wins, then
 * missing-credential, then a hard 401 → revoked, then doc presence, then the
 * expiry/grace window. Offline grace lets a previously-valid doc keep running until
 * `graceUntil`.
 */
export function licenseState(input: GateInput): LicenseState {
  const { doc, now } = input;
  if (input.blocked) {
    return { status: input.blocked.reason, allowedRange: input.blocked.allowedRange };
  }
  if (!input.hasToken) return { status: "needs-enroll" };
  if (input.lastSyncUnauthorized) return { status: "revoked" };
  if (!doc) return { status: "needs-enroll" };
  if (now > doc.graceUntil) return { status: "expired", graceUntil: doc.graceUntil };
  if (now > doc.expiresAt) {
    return { status: "grace", graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt };
  }
  return { status: "ok", graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt };
}

/** True when the gate permits running (ok or grace) — children render through. */
export function isUsable(status: LicenseStatus): boolean {
  return status === "ok" || status === "grace";
}

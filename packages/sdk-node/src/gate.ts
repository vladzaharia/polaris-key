// The client license gate. Computes the renderable status from the cached signed doc +
// current time + the last sync outcome. The server enforces version/channel (a 403 →
// `blocked`); the client reflects that plus offline grace. Mirrors djdl's license.ts.

import type {
  AllowedRange,
  BlockReason,
  LicenseStatus,
  ManagedConfigDoc,
} from "@polaris-key/protocol";

export interface LicenseState {
  status: LicenseStatus;
  graceUntil?: number;
  lastVerifiedAt?: number;
  allowedRange?: AllowedRange;
}

export interface GateInput {
  /** Whether a per-device token is stored. */
  hasToken: boolean;
  /** The cached, verified doc (or null if none yet). */
  doc: ManagedConfigDoc | null;
  /** Epoch seconds. */
  now: number;
  /** Set when the last /config returned a hard 401 (after a /token retry). */
  lastSyncUnauthorized?: boolean;
  /** Set when the last /config returned a 403 version/channel block. */
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
  /** Epoch ms of the last successful online verify. */
  lastVerifiedAt?: number;
  /**
   * Monotonic time floor (epoch seconds): `max(configDoc.issuedAt, trustManifest.issuedAt)`
   * over the artifacts this client has re-VERIFIED, recomputed at load from the cached JWS
   * — never read from an unsigned field. The gate evaluates at `max(now, highWaterMark)`,
   * which makes clock rollback inert without requiring a trusted local clock (wire contract
   * v2 §4.3, finding R4-04).
   *
   * Both sources are required. Derived from the document alone the floor is inert, because
   * `doc.issuedAt < doc.graceUntil` always holds, so it can never reach the end of grace.
   */
  highWaterMark?: number;
}

export function licenseState(input: GateInput): LicenseState {
  const { doc } = input;
  // §4.3 — winding the system clock back below the newest signed `issuedAt` we have already
  // verified buys nothing: the gate never sees a time earlier than that floor.
  const now = Math.max(input.now, input.highWaterMark ?? 0);
  if (input.blocked) {
    return {
      status: input.blocked.reason,
      allowedRange: input.blocked.allowedRange,
    };
  }
  if (!input.hasToken) return { status: "needs-activation" };
  if (input.lastSyncUnauthorized) return { status: "revoked" };
  if (!doc) return { status: "needs-activation" };
  if (now > doc.graceUntil)
    return { status: "expired", graceUntil: doc.graceUntil };
  if (now > doc.expiresAt) {
    return {
      status: "grace",
      graceUntil: doc.graceUntil,
      lastVerifiedAt: input.lastVerifiedAt,
    };
  }
  return {
    status: "ok",
    graceUntil: doc.graceUntil,
    lastVerifiedAt: input.lastVerifiedAt,
  };
}

/** True when the gate permits running (ok or grace). */
export function isUsable(status: LicenseStatus): boolean {
  return status === "ok" || status === "grace";
}

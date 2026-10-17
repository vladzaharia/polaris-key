// `verifyLicenseDocument`, moved here from `@polaris-key/node/server` (SDK parity pass §2.1,
// framework drop-ins plan §12.1). It checks one presented document with no device state and no
// network: the signature against the product's pinned keys, the audience, the device binding and
// the grace ceiling, then the shared gate. Prefer `createPolarisKey().authenticate()`, which adds
// the trust manifest, the freshness window, the cache and the problem body.

import {
  isUsable,
  licenseState,
  type LicenseState,
} from "@polaris-key/client-core/gate";
import { verifyLicenseDoc } from "@polaris-key/client-core/verify";
import { CLOCK_SKEW_SECONDS } from "@polaris-key/client-core/claims";
import type { TrustSet } from "@polaris-key/jws";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";

export interface VerifyLicenseDocumentOptions {
  /** The product's pinned keys (kid → raw Ed25519 public key, base64url). */
  trust: TrustSet;
  /** The product slug: the document's `aud`. */
  product: string;
  /** The device id the client says it is (its `X-PKey-Device`): the document's binding. */
  deviceId: string;
  /** Epoch seconds; default the system clock. */
  now?: number;
}

export type VerifiedLicense =
  | {
      ok: true;
      doc: LicenseDoc;
      /** The gate's answer at `now`: `ok`, `grace` (past `expiresAt`, within `graceUntil`) or
       *  `expired`. Revocation is not visible offline: a revoked device stops getting fresh
       *  documents, so a backend that needs it bounds the document's age. */
      state: LicenseState;
      usable: boolean;
      /** Seconds since the document was signed. */
      ageSeconds: number;
      /** Whether boolean entitlement `name` is granted, and the gate usable (G11). */
      isEntitled(name: string): boolean;
      /** The raw entitlement value, or null (also when the gate is not usable). */
      entitlementValue(name: string): JSONValue | null;
    }
  | { ok: false; reason: "invalid" };

/** Verify a license document a client presented. */
export async function verifyLicenseDocument(
  jws: string,
  opts: VerifyLicenseDocumentOptions,
): Promise<VerifiedLicense> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const doc = await verifyLicenseDoc(jws, {
    trust: opts.trust,
    expectedAud: opts.product,
    deviceId: opts.deviceId,
    now,
    // A backend verifying a presented document keeps no per-device history: no floor.
    lastAcceptedIssuedAt: null,
    // The document is expected to be past its short `expiresAt` while the device is offline;
    // the gate bounds it by `graceUntil`.
    checkFreshness: false,
  });
  if (!doc || doc.issuedAt > now + CLOCK_SKEW_SECONDS)
    return { ok: false, reason: "invalid" };
  const state = licenseState({
    licenseServiceEnabled: true,
    activation: "token",
    doc,
    now,
  });
  const usable = isUsable(state);
  // Own entries only: "constructor" is not an entitlement.
  const entry = (name: string) =>
    Object.prototype.hasOwnProperty.call(doc.entitlements, name)
      ? doc.entitlements[name]
      : undefined;
  return {
    ok: true,
    doc,
    state,
    usable,
    ageSeconds: Math.max(0, now - doc.issuedAt),
    isEntitled: (name) => usable && entry(name)?.value === true,
    entitlementValue: (name) => (usable ? (entry(name)?.value ?? null) : null),
  };
}

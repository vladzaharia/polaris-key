// Server-side recipes (SDK parity pass §2.1 "Servers", §3.14): verify a licence a client presents,
// with no device state, and the crash-tag convention the Worker's Sentry hook reads.
//
// `verifyLicenseDocument` is for a product's own backend: the desktop app sends its cached
// `pkey-license+jws` (and its device id) with a request, and the backend checks the signature
// against the product's pinned keys, the audience, the device binding and the grace ceiling, then
// runs the same gate every SDK runs. No token, no network, no store. A backend that wants a fresh
// answer asks the app to sync first; the signed `issuedAt` says how old the document is.

import {
  isUsable,
  licenseState,
  verifyLicenseDoc,
  type LicenseState,
} from "@polaris-key/client-core";
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

/** Verify a licence document a client presented. See the file header. */
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
    // A backend verifying a presented document keeps no per-device history: no floor
    // (explicit).
    lastAcceptedIssuedAt: null,
    // The document is expected to be past its short `expiresAt` while the device is offline;
    // the gate bounds it by `graceUntil`.
    checkFreshness: false,
  });
  if (!doc || doc.issuedAt > now + 300) return { ok: false, reason: "invalid" };
  const state = licenseState({
    licenseServiceEnabled: true,
    activation: "token",
    doc,
    now,
  });
  const usable = isUsable(state);
  return {
    ok: true,
    doc,
    state,
    usable,
    ageSeconds: Math.max(0, now - doc.issuedAt),
    isEntitled: (name) => usable && doc.entitlements[name]?.value === true,
    entitlementValue: (name) =>
      usable ? (doc.entitlements[name]?.value ?? null) : null,
  };
}

/** The tags a crash reporter attaches (SDK parity pass §3.14, the Worker's Sentry convention). */
export interface CrashTags {
  /** `<deliverable>@<version>[+<build>]`. */
  release: string;
  /** The release channel. */
  environment: string;
  /** The outlet id the install came from. */
  "pkey.outlet": string;
}

/** Build the crash tags from explicit values (the facade's `client.crashTags()` fills them). */
export function crashTagsFor(o: {
  version: string;
  channel: string;
  outlet?: string | null;
  deliverable?: string;
  build?: string | null;
}): CrashTags {
  const build = o.build ? `+${o.build}` : "";
  return {
    release: `${o.deliverable ?? "app"}@${o.version}${build}`,
    environment: o.channel,
    "pkey.outlet": o.outlet || "unknown",
  };
}

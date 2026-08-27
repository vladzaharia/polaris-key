// Build and ETag the FUSED v2 managed-config document. `aud`/`iss` bind it to the product as
// defense-in-depth; the per-product `kid` + key that scope each doc to one tenant are applied
// by `core/signing.ts`, which owns the signing step for every Polaris document.
//
// Wire v3 split this document in two (`services/license/document.ts` +
// `services/config/document.ts`), and `GET /<p>/config` is gone. What still assembles a v2
// document is identity's browser session, which mints one for a page rather than for an SDK
// and moves in P3 — so this module survives for exactly that caller and takes no new ones.
//
// `validatePayload` is NOT defined here any more: the catalog prune is the last gate before
// signing on all THREE document paths, so it lives in `core/payload.ts` and is re-exported
// below for the browser-session call site.

import { sha256Base64Url } from "@plrs/jws";
import {
  DOC_EXPIRY_SECONDS,
  ISSUER,
  SECONDS_PER_DAY,
  type DocProfile,
  type ManagedConfigDoc,
  type ManagedPayload,
} from "@plrs/protocol";

export { validatePayload } from "./core/payload.js";

export interface BuildDocInput {
  schemaVersion: number;
  aud: string;
  licenseId: string;
  deviceId: string;
  now: number;
  maxOfflineDays: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

/** Stamp the time-bound fields into a doc (field order matches the conformance corpus). */
export function buildDoc(input: BuildDocInput): ManagedConfigDoc {
  return {
    schemaVersion: input.schemaVersion,
    aud: input.aud,
    iss: ISSUER,
    licenseId: input.licenseId,
    deviceId: input.deviceId,
    issuedAt: input.now,
    expiresAt: input.now + DOC_EXPIRY_SECONDS,
    graceUntil: input.now + input.maxOfflineDays * SECONDS_PER_DAY,
    profile: input.profile,
    payload: input.payload,
  };
}

/** A strong ETag over the doc content, excluding the per-request timestamps so an
 *  unchanged config collapses to the same ETag → If-None-Match 304. */
export async function computeETag(doc: ManagedConfigDoc): Promise<string> {
  const material = JSON.stringify({
    schemaVersion: doc.schemaVersion,
    aud: doc.aud,
    iss: doc.iss,
    licenseId: doc.licenseId,
    deviceId: doc.deviceId,
    profile: doc.profile,
    payload: doc.payload,
  });
  const tag = await sha256Base64Url(new TextEncoder().encode(material));
  return `"${tag}"`;
}

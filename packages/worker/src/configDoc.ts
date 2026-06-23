// Build, sign, and ETag the managed-config document. The signing uses the FROZEN
// @polaris-key/jws encoding (the conformance corpus pins it); the per-product `kid` + key
// scope each doc to one tenant, and `aud`/`iss` bind it to the product as defense-in-depth.

import { signJws, sha256Base64Url } from "@polaris-key/jws";
import {
  DOC_EXPIRY_SECONDS,
  ISSUER,
  SECONDS_PER_DAY,
  type DocProfile,
  type ManagedConfigDoc,
  type ManagedPayload,
} from "@polaris-key/protocol";

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

export async function signDoc(doc: ManagedConfigDoc, signingKeyPem: string, kid: string): Promise<string> {
  return signJws(doc, signingKeyPem, kid);
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

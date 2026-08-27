// Build and ETag the FUSED session document — Identity's own, and nobody else's.
//
// `aud`/`iss` bind it to the product as defense-in-depth; the per-product `kid` + key that scope
// each doc to one tenant are applied by `core/signing.ts`, which owns the signing step for every
// Polaris Key document.
//
// Wire v3 split this document in two (`services/license/document.ts` +
// `services/config/document.ts`), and `GET /<p>/config` is gone. The ONE caller that still
// assembles the fused shape is this service's browser session, which mints a document for a
// PAGE rather than for an SDK — so the builder moved in here with it (it was `src/configDoc.ts`)
// and takes no new callers. When the React SDK migrates to the split documents, this file is
// deleted rather than generalised.
//
// `validatePayload` is not defined here: the catalog prune is the last gate before signing on
// all THREE document paths, so it lives in `core/payload.ts` and the browser session imports it
// from there directly.

import { sha256Base64Url } from "@polaris-key/jws";
import {
  DOC_EXPIRY_SECONDS,
  ISSUER,
  SECONDS_PER_DAY,
  type DocProfile,
} from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";

/**
 * The FUSED document shape: licence claims, config, secrets and entitlements in one artifact.
 *
 * Declared HERE rather than in `@polaris-key/protocol` because it is no longer a wire type
 * anyone else speaks — v3 split it into `pkey-license+jws` + `pkey-config+jws`, and the browser
 * session is the last minter. The React SDK keeps its own local copy at its own edge for the
 * same reason. When the session moves to the split pair, both copies go with it.
 */
export interface FusedSessionDoc {
  schemaVersion: number;
  aud: string;
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

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
export function buildDoc(input: BuildDocInput): FusedSessionDoc {
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
export async function computeETag(doc: FusedSessionDoc): Promise<string> {
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

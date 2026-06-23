// JWS verification + anti-replay. Cryptographic verification is the frozen
// @polaris-key/jws path; on top of it we assert the product audience, the device binding,
// and monotonic issuedAt so a doc can't be spliced across products/devices or replayed.

import { verifyJws, type TrustSet } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";

export interface VerifyOptions {
  trust: TrustSet;
  expectedAud: string;
  deviceId: string;
  lastAcceptedIssuedAt?: number;
}

export async function verifyDoc(jws: string, opts: VerifyOptions): Promise<ManagedConfigDoc | null> {
  const v = await verifyJws<ManagedConfigDoc>(jws, opts.trust);
  if (!v) return null;
  const doc = v.payload;
  if (doc.aud !== opts.expectedAud) return null;
  if (doc.deviceId !== opts.deviceId) return null;
  if (opts.lastAcceptedIssuedAt !== undefined && doc.issuedAt <= opts.lastAcceptedIssuedAt) {
    return null;
  }
  return doc;
}

/**
 * The corpus's CI-held RELEASE test keys (`tools/sign-corpus.ts` `KEYS`, WIRE-CONTRACT-V4 §2.4):
 * never a product key. The 2027 key is the rotation. Tests sign `pkey-release+jws` records with
 * them exactly as `pkey release publish` does in CI.
 */

import { signJws } from "@polaris-key/jws";
import {
  descriptorToRecord,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";

export const RELEASE_KID = "djdl-release-test-2026";
export const RELEASE_PUB = "U9d9Ix2jwC1-l_GJgrInN5zMPJgjPkgZC8Ekg7nKlEE";
export const RELEASE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMPC/pYWRN17C6MFlFHhktg/TQgXNUydx+PQtkD9KTBs\n-----END PRIVATE KEY-----";

export const RELEASE_KID_2027 = "djdl-release-test-2027";
export const RELEASE_PUB_2027 = "TOde4jqFFVbzka-bES32oJRK6Whg1kqa16Jk7y3d2Lo";
export const RELEASE_PEM_2027 =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIwJqSkvipky0ygUQh67CbUmFH5641YiVLQRAdtWfA3g\n-----END PRIVATE KEY-----";

/** `release_config.release_keys_json` declaring the 2026 key (and the 2027 one, rotating). */
export function releaseKeysJson(rotating = false): string {
  return JSON.stringify([
    { kid: RELEASE_KID, publicKey: RELEASE_PUB },
    ...(rotating
      ? [{ kid: RELEASE_KID_2027, publicKey: RELEASE_PUB_2027 }]
      : []),
  ]);
}

/** Sign a record payload as CI does. */
export function signRecord(
  payload: unknown,
  opts: { pem?: string; kid?: string; typ?: string } = {},
): Promise<string> {
  return signJws(
    payload,
    opts.pem ?? RELEASE_PEM,
    opts.kid ?? RELEASE_KID,
    (opts.typ ?? "pkey-release+jws") as "pkey-release+jws",
  );
}

/** The record `pkey release publish` signs for a descriptor (plans/P3-01.md §2.4's mapping). */
export function recordFor(
  descriptor: unknown,
  fields: { seq: number; issuedAt: number; minSupportedSeq?: number },
): Record<string, unknown> {
  return descriptorToRecord(
    descriptor as ReleaseDescriptor,
    fields,
  ) as unknown as Record<string, unknown>;
}

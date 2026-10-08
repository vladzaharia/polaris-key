// Reference: the `revocationCases` verdict (plans/P4-13.md §4.2).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { base64UrlDecode } from "@polaris-key/jws";
import { sha256Hex, utf8Bytes } from "../common.js";
import { ctxOf, hasOwn } from "./claims.js";
import { refRevocationOf } from "./content.js";
import { refVerifyJws } from "./jws.js";
import { refRecordClaims } from "./record.js";

export interface RevocationCase {
  id: string;
  description: string;
  mode: "revocation" | "replacement";
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  /** `revocation` mode: the feed entry the record is verified against. */
  entry?: {
    record: string;
    pack: string;
    target: string;
    version: string;
    seq: number;
  };
  /** `replacement` mode: the replacement's hash and pin (kind `pack`). */
  expectedHash?: string;
  pin?: { kind: "pack"; deliverable: string; version: string; seq: number };
  nonWireIntegers?: string[];
  expect:
    | {
        verify: "ok";
        revocation?: Record<string, unknown>;
        kind?: string;
        supersedes?: string;
        winner?: string;
      }
    | {
        verify: "fail";
        step: "hash" | "jws" | "claims" | "cross-check" | "revocation";
      };
}

/** §2.3's steps 12–16, from first principles. */
export function refVerifyRevocationCase(
  c: RevocationCase,
): RevocationCase["expect"] {
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check" | "revocation",
  ): RevocationCase["expect"] => ({ verify: "fail", step });
  const body = c.jws;
  const hash = c.mode === "revocation" ? c.entry!.record : c.expectedHash!;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return fail("hash");
  if (sha256Hex(body) !== hash) return fail("hash");
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(body.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return fail("jws");
  }
  if (typeof kid !== "string" || !hasOwn(c.releaseKeys, kid))
    return fail("jws");
  const key = c.releaseKeys[kid]!;
  if (Object.values(c.productTrust).includes(key)) return fail("jws");
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return fail("jws");
  const ctx = ctxOf(v.text);
  if (!refRecordClaims(v.payload, ctx, c.expectedAud)) return fail("claims");
  const d = v.payload as Record<string, any>;
  if (c.mode === "replacement") {
    const p = c.pin!;
    if (d.kind !== p.kind || d.deliverable !== p.deliverable)
      return fail("cross-check");
    if (d.version !== p.version || d.seq !== p.seq) return fail("cross-check");
    return { verify: "ok", kind: d.kind };
  }
  const e = c.entry!;
  if (d.kind !== "revocation" || d.deliverable !== e.pack)
    return fail("cross-check");
  if (d.version !== e.version || d.seq !== e.seq) return fail("cross-check");
  const r = refRevocationOf(d, ctx);
  if (r === null || r.target !== e.target) return fail("revocation");
  return { verify: "ok", revocation: r };
}

// Reference: a JWS verifier (V4 §1.1–§1.2) that recomputes every new verdict.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { base64UrlDecode } from "@polaris-key/jws";
import { type TypV3, utf8Bytes } from "../common.js";
import { refCanonicalB64url } from "./b64url.js";
import { hasOwn, isObj } from "./claims.js";
import { refParseStrict } from "./config.js";
import {
  bytesHex,
  ED_L,
  ED_P,
  leToBig,
  NEGATIVE_ZERO_ENC,
  SMALL_ORDER_REF,
} from "./ed25519.js";

// ── A reference JWS verifier (V4 §1.1–§1.2), to recompute every new verdict ─────────────────

function refPointOk(enc: Uint8Array): boolean {
  if (enc.length !== 32) return false;
  if ((leToBig(enc) & (2n ** 255n - 1n)) >= ED_P) return false;
  const hex = bytesHex(enc);
  if (hex === bytesHex(NEGATIVE_ZERO_ENC)) return false;
  if (
    hex === "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  )
    return false;
  return !SMALL_ORDER_REF.includes(hex);
}

/** Decode one segment's bytes as strict JSON text (rules 1–2), or null. */
function refSegmentText(seg: string): string | null {
  if (!refCanonicalB64url(seg)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(seg);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) return null;
  const parsed = refParseStrict(text);
  if (!parsed.ok || !isObj(parsed.value)) return null;
  return text;
}

/** The whole of `verifyJws` under V4, from first principles: caps, strict JSON, `alg`, `typ`,
 *  `kid`, the byte pre-checks and a cofactorless verify (node:crypto). */
export function refVerifyJws(
  jws: string,
  trust: Record<string, string>,
  typ: TypV3 | undefined,
  maxPayloadBytes = 65536,
): { kid: string; text: string; payload: Record<string, unknown> } | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const cap = Math.max(65536, maxPayloadBytes);
  if (h.length > Math.ceil((1024 * 4) / 3) + 4) return null;
  if (p.length > Math.ceil((cap * 4) / 3) + 4) return null;
  const ht = refSegmentText(h);
  if (ht === null || utf8Bytes(ht).length > 1024) return null;
  const header = JSON.parse(ht) as Record<string, unknown>;
  if (header.alg !== "EdDSA") return null;
  if (typ !== undefined && header.typ !== typ) return null;
  if (typeof header.kid !== "string" || !hasOwn(trust, header.kid)) return null;
  if (!refCanonicalB64url(trust[header.kid]!)) return null;
  const key = base64UrlDecode(trust[header.kid]!);
  if (!refCanonicalB64url(s)) return null;
  const sig = base64UrlDecode(s);
  if (key.length !== 32 || sig.length !== 64) return null;
  if (leToBig(sig.subarray(32)) >= ED_L) return null;
  if (!refPointOk(key) || !refPointOk(sig.subarray(0, 32))) return null;
  let ok = false;
  try {
    const pk = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: trust[header.kid]! },
      format: "jwk",
    });
    ok = nodeVerify(null, utf8Bytes(`${h}.${p}`), pk, sig);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  const pt = refSegmentText(p);
  if (pt === null || utf8Bytes(pt).length > cap) return null;
  return {
    kid: header.kid,
    text: pt,
    payload: JSON.parse(pt) as Record<string, unknown>,
  };
}

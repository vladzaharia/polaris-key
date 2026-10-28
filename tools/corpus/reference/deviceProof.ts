// Reference: the device proof `pkey-proof/1` (V5 §12.11.1, §15.8).
//
// The generator's independent reference implementation, restated from the spec over `node:crypto`
// alone: nothing from client-core, the Worker or an SDK. `deviceProof.ts` recomputes every row's
// verdict through it and throws when an authored expectation disagrees.

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { refCanonicalB64url } from "./b64url.js";
import { ED_L, bytesHex, leToBig } from "./ed25519.js";
import { refPointOk } from "./jws.js";
import { refX25519LowOrder } from "./peer.js";

export const REF_PROOF_LINE_1 = "pkey-proof/1";
export const REF_PROOF_PURPOSES = [
  "keys",
  "nonce",
  "exchange",
  "link",
  "nearby-start",
  "nearby-poll",
  "nearby-approve",
  "vouch",
  "restore",
] as const;
export const REF_KEYS_SKEW = 300;
const P25519 = 2n ** 255n - 19n;

export interface RefProofRow {
  purpose: string;
  product: string;
  deviceId: string;
  value: string;
  tokenHash: string;
  signKey: string;
  sig: string;
  now: number;
}

const b64 = (s: string): Uint8Array => Buffer.from(s, "base64url");

/** The signed bytes: the six lines joined by LF, or null when a field holds a byte outside
 *  0x21..0x7e (so no space, no newline, no control byte, no non-ASCII) or is empty. */
export function refProofMessage(
  r: Pick<
    RefProofRow,
    "purpose" | "product" | "deviceId" | "value" | "tokenHash"
  >,
): Buffer | null {
  const lines = [
    REF_PROOF_LINE_1,
    r.purpose,
    r.product,
    r.deviceId,
    r.value,
    r.tokenHash,
  ];
  for (const l of lines) {
    if (l.length === 0) return null;
    for (const ch of l) {
      const c = ch.codePointAt(0)!;
      if (c < 0x21 || c > 0x7e) return null;
    }
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

/** A canonical 32-byte base64url key, decoded, or null. */
function refRaw32(s: string): Uint8Array | null {
  if (s.length !== 43 || !refCanonicalB64url(s)) return null;
  const b = b64(s);
  return b.length === 32 ? b : null;
}

/** X25519 spelling an issuer accepts: bit 255 clear and u < p. */
function refAgreeCanonical(k: Uint8Array): boolean {
  if ((k[31]! & 0x80) !== 0) return false;
  return leToBig(k) < P25519;
}

export type RefProofReason =
  | "ok"
  | "line-format"
  | "unknown-purpose"
  | "sign-key"
  | "keys-value"
  | "agree-key"
  | "skew"
  | "sig-encoding"
  | "sig-scalar"
  | "sig-point"
  | "sig";

export function refVerifyProof(r: RefProofRow): RefProofReason {
  const pub = refRaw32(r.signKey);
  if (!pub || !refPointOk(pub)) return "sign-key";
  const msg = refProofMessage(r);
  if (!msg) return "line-format";
  if (!(REF_PROOF_PURPOSES as readonly string[]).includes(r.purpose))
    return "unknown-purpose";
  if (r.purpose === "keys") {
    if (r.tokenHash !== "-") return "keys-value";
    const m =
      /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]*)$/.exec(
        r.value,
      );
    if (!m || m[1] !== r.signKey) return "keys-value";
    const agree = refRaw32(m[2]!);
    if (
      !agree ||
      !refAgreeCanonical(agree) ||
      refX25519LowOrder(agree) ||
      bytesHex(agree) === "0".repeat(64)
    )
      return "agree-key";
    const at = Number(m[3]);
    if (!Number.isSafeInteger(at)) return "keys-value";
    if (Math.abs(at - r.now) > REF_KEYS_SKEW) return "skew";
  }
  if (r.sig.length !== 86 || !refCanonicalB64url(r.sig)) return "sig-encoding";
  const sig = b64(r.sig);
  if (sig.length !== 64) return "sig-encoding";
  if (leToBig(sig.subarray(32)) >= ED_L) return "sig-scalar";
  if (!refPointOk(sig.subarray(0, 32))) return "sig-point";
  let ok = false;
  try {
    ok = nodeVerify(
      null,
      msg,
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: r.signKey },
        format: "jwk",
      }),
      sig,
    );
  } catch {
    ok = false;
  }
  return ok ? "ok" : "sig";
}

// Reference: the JSON token scan and non-wire integers (V4 §1.2, §3).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { base64UrlDecode } from "@polaris-key/jws";
import { MAX_WIRE_INTEGER_REF, pointerToken } from "../common.js";

// ── The generator's own JSON token scan (V4 §1.2, §3) ─────────────────────────────────────────

/** The RFC 6901 pointer → token of every number in `text` (assumed to be well-formed JSON). */
export function refNumberTokens(text: string): Map<string, string> {
  const tokens = new Map<string, string>();
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const str = (): string => {
    // Delegate unescaping to JSON.parse on the exact literal (it is valid JSON by assumption).
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (pointer: string): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const name = str();
        ws();
        i++; // ':'
        value(`${pointer}/${pointerToken(name)}`);
        ws();
        if (text[i++] === "}") return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (let k = 0; ; k++) {
        value(`${pointer}/${k}`);
        ws();
        if (text[i++] === "]") return;
      }
    }
    if (c === '"') {
      str();
      return;
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(i),
    );
    if (m) {
      tokens.set(pointer, m[0]);
      i += m[0].length;
      return;
    }
    for (const lit of ["true", "false", "null"])
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    throw new Error(`refNumberTokens: not JSON at ${i}`);
  };
  value("");
  return tokens;
}

export const PLAIN_INTEGER_REF = /^-?(0|[1-9][0-9]*)$/;
/** V4 §3: a token that cannot be a wire integer (a fraction, an exponent, or > 2^53 − 1). */
function refIsNonWire(token: string): boolean {
  if (!PLAIN_INTEGER_REF.test(token)) return true;
  const v = BigInt(token);
  return v > BigInt(MAX_WIRE_INTEGER_REF) || v < -BigInt(MAX_WIRE_INTEGER_REF);
}
/** The payload's non-wire-integer pointers, sorted in JavaScript's default string order. */
export const refNonWire = (text: string): string[] =>
  [...refNumberTokens(text)]
    .filter(([, t]) => refIsNonWire(t))
    .map(([p]) => p)
    .sort();

/** The decoded payload text of a compact JWS (or null when it is not one). */
export function payloadTextOf(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(parts[1]!),
    );
  } catch {
    return null;
  }
}

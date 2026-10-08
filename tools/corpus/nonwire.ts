// `nonWireIntegers` (V4 §1.2): attach a case's non-wire integer pointers and place them right
// before `expect`.

import { payloadTextOf, refNonWire } from "./reference/tokens.js";

// ── §4.3 the 28 v3 claim cases ───────────────────────────────────────────────────────────────
// Each is its family's control case with the one change named, re-signed by the control's key,
// and appended after the family's last case so every existing case stays byte-identical.

export type WithNonWire<T> = T & { nonWireIntegers?: string[] };

/** Attach the payload's non-wire pointers when the case is built to pass `verifyJws`. */
export function withNonWire<T extends object>(
  c: T,
  jws: string,
): WithNonWire<T> {
  const text = payloadTextOf(jws);
  const nonWire = text === null ? [] : refNonWire(text);
  return nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c;
}

/** Insert `nonWireIntegers` right before `expect`, so the member sits beside it. */
export function placeNonWire<T extends object>(c: T): T {
  if (!("nonWireIntegers" in c)) return c;
  const src = c as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "nonWireIntegers") continue;
    if (k === "expect") out.nonWireIntegers = src.nonWireIntegers;
    out[k] = v;
  }
  return out as T;
}

export const BIG_OVER = "9007199254740993";

/**
 * Support codes (I-41), the console's side of `core/accounts/supportCodes.ts` in the Worker: nine
 * characters from a 30-symbol alphabet without lookalikes, shown `XXX-XXX-XXX`, the ninth a check
 * symbol (Luhn mod 30) of the first eight. The two files agree by a test on each side
 * (`test/supportCode.test.ts` here pins the alphabet, the shape and the check).
 */

export const SUPPORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 9;

/** The check symbol of eight alphabet symbols: public math, so a typo is told from "no such code". */
export function supportCodeCheck(payload: string): string {
  const n = SUPPORT_CODE_ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    const addend = factor * SUPPORT_CODE_ALPHABET.indexOf(payload[i]!);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / n) + (addend % n);
  }
  return SUPPORT_CODE_ALPHABET[(n - (sum % n)) % n]!;
}

/**
 * What an operator typed, read. Case-insensitive; spaces, dashes and dots are ignored.
 * `lookalike`: nine characters with a 0, 1, I, L, O or U in them. `bad_check`: nine alphabet
 * symbols whose last is not the first eight's check (one character is wrong).
 */
export type ParsedSupportCode =
  | { kind: "not_code" }
  | { kind: "lookalike" }
  | { kind: "bad_check" }
  | { kind: "code"; code: string };

/** Three groups of three, however separated: the shape a code is read out in. */
const GROUPED = /^\s*[a-z0-9]{3}[\s.-]+[a-z0-9]{3}[\s.-]+[a-z0-9]{3}\s*$/i;

/**
 * Is this text shaped like a support code someone typed (a digit in it, or three groups of three)?
 * A nine-letter word ("teammates", "john.smith") is not: only a valid check symbol makes one a code.
 */
export function looksLikeSupportCode(input: string): boolean {
  return GROUPED.test(input) || /\d/.test(input);
}

export function parseSupportCode(input: string): ParsedSupportCode {
  if (input.length > 40) return { kind: "not_code" };
  const s = input.toUpperCase().replace(/[\s.-]/g, "");
  if (s.length !== LENGTH || !/^[A-Z0-9]+$/.test(s))
    return { kind: "not_code" };
  const inAlphabet = [...s].every((ch) => SUPPORT_CODE_ALPHABET.includes(ch));
  if (inAlphabet && supportCodeCheck(s.slice(0, -1)) === s.slice(-1))
    return { kind: "code", code: s };
  // Only text shaped like a code is told it is a mistyped one.
  if (!looksLikeSupportCode(input)) return { kind: "not_code" };
  return inAlphabet ? { kind: "bad_check" } : { kind: "lookalike" };
}

/** The nine characters of a valid code, or `null`. */
export function normalizeSupportCode(input: string): string | null {
  const p = parseSupportCode(input);
  return p.kind === "code" ? p.code : null;
}

/** `K7M4QX9TZ` → `K7M-4QX-9TZ`. */
export function formatSupportCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

/** The one line for a code that fails its check. */
export const SUPPORT_CODE_BAD_CHECK =
  "One character is wrong. Ask them to read it again.";
/** The one line for a code with a lookalike character. */
export const SUPPORT_CODE_LOOKALIKE =
  "Support codes never contain 0, 1, I, L, O or U.";

/** One spoken word per alphabet symbol: NATO letters, digits by name. No lookalikes, so no clashes. */
export const SUPPORT_CODE_WORDS: Readonly<Record<string, string>> = {
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "6": "Six",
  "7": "Seven",
  "8": "Eight",
  "9": "Nine",
  A: "Alpha",
  B: "Bravo",
  C: "Charlie",
  D: "Delta",
  E: "Echo",
  F: "Foxtrot",
  G: "Golf",
  H: "Hotel",
  J: "Juliet",
  K: "Kilo",
  M: "Mike",
  N: "November",
  P: "Papa",
  Q: "Quebec",
  R: "Romeo",
  S: "Sierra",
  T: "Tango",
  V: "Victor",
  W: "Whiskey",
  X: "X-ray",
  Y: "Yankee",
  Z: "Zulu",
};

export interface SpelledSymbol {
  symbol: string;
  word: string;
}

/**
 * A valid code, spelled out for reading over the phone: three groups of three `{ symbol, word }`.
 * Anything that is not a valid code (a typo, a lookalike, not a code) spells nothing: `[]`.
 */
export function spellOut(input: string): SpelledSymbol[][] {
  const code = normalizeSupportCode(input);
  if (!code) return [];
  return [0, 3, 6].map((i) =>
    [...code.slice(i, i + 3)].map((symbol) => ({
      symbol,
      word: SUPPORT_CODE_WORDS[symbol]!,
    })),
  );
}

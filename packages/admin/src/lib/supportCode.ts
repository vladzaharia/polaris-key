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

export function parseSupportCode(input: string): ParsedSupportCode {
  if (input.length > 40) return { kind: "not_code" };
  const s = input.toUpperCase().replace(/[\s.-]/g, "");
  if (s.length !== LENGTH) return { kind: "not_code" };
  if (/[01ILOU]/.test(s) && /^[A-Z0-9]+$/.test(s)) {
    // Only a lookalike when everything else is in the alphabet: a word with an L is just a word.
    const rest = s.replace(/[01ILOU]/g, "");
    if ([...rest].every((ch) => SUPPORT_CODE_ALPHABET.includes(ch)))
      return { kind: "lookalike" };
  }
  for (const ch of s)
    if (!SUPPORT_CODE_ALPHABET.includes(ch)) return { kind: "not_code" };
  return supportCodeCheck(s.slice(0, -1)) === s.slice(-1)
    ? { kind: "code", code: s }
    : { kind: "bad_check" };
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

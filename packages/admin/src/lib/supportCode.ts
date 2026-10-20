/**
 * Support codes (I-41), the console's side of `core/accounts/supportCodes.ts` in the Worker: nine
 * characters from a 30-symbol alphabet without lookalikes, shown `XXX-XXX-XXX`. The two files
 * agree by a test on each side (`test/supportCode.test.ts` here pins the alphabet and the shape).
 */

export const SUPPORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 9;

/**
 * What an operator typed → the nine characters, or `null` when it is no code. Case-insensitive;
 * spaces, dashes and dots are ignored; a lookalike (0 O 1 I L U) is not a code.
 */
export function normalizeSupportCode(input: string): string | null {
  if (input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s.-]/g, "");
  if (s.length !== LENGTH) return null;
  for (const ch of s) if (!SUPPORT_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** `K7M4QX9TB` → `K7M-4QX-9TB`. */
export function formatSupportCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

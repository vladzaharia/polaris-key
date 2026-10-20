/**
 * Readable support codes (I-41): the nine characters a person reads out to a product's support,
 * shown as `XXX-XXX-XXX`.
 *
 * A code names ONE person to ONE product. It stands for that product's pairwise subject, the id
 * the developer's Users page and the signed licence carry, so a support agent can find the person
 * without ever seeing the subject or the account's email. It is an identifier for that product's
 * support, never a credential: it opens nothing on its own, and the console resolves it only for
 * an operator who may read that product's users.
 *
 * Shape. Nine characters from {@link SUPPORT_CODE_ALPHABET} (30 symbols, no 0/O, 1/I/L or U, so a
 * voice or a bad font cannot confuse two of them), drawn with crypto randomness and rejection
 * sampling so every symbol is equally likely. 30^9 is about 2e13. The three-part shape keeps it
 * apart from a device code (`XXXX-XXXX`, `deviceCodeIndex.ts`).
 *
 * Storage. `support_codes` (Identity's table; this file is the one seam). One stable code per
 * (product, subject), created on the first ask and never backfilled; the code is globally unique,
 * with a retry on a collision.
 */

import type { Db } from "../../db/types.js";
import { randomUint32 } from "../../platform/random.js";

/** 30 symbols: digits 2-9 and letters without I, L, O and U. */
export const SUPPORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SUPPORT_CODE_LENGTH = 9;
export const SUPPORT_CODE_GROUP = 3;

/** The dashed shape a code is shown in, matched whole (the portal contract publishes its source). */
export const SUPPORT_CODE_PATTERN =
  /^[2-9A-HJKMNP-TV-Z]{3}-[2-9A-HJKMNP-TV-Z]{3}-[2-9A-HJKMNP-TV-Z]{3}$/;

/** The largest multiple of the alphabet size below 2^32: draws at or above it are rejected. */
const REJECT_AT =
  Math.floor(0x1_0000_0000 / SUPPORT_CODE_ALPHABET.length) *
  SUPPORT_CODE_ALPHABET.length;

/** One fresh, uniformly random code, undashed. */
export function mintSupportCode(draw: () => number = randomUint32): string {
  let out = "";
  while (out.length < SUPPORT_CODE_LENGTH) {
    const n = draw();
    if (n >= REJECT_AT) continue;
    out += SUPPORT_CODE_ALPHABET[n % SUPPORT_CODE_ALPHABET.length];
  }
  return out;
}

/** `ABC234XYZ` → `ABC-234-XYZ`. */
export function formatSupportCode(code: string): string {
  return code.match(new RegExp(`.{1,${SUPPORT_CODE_GROUP}}`, "g"))!.join("-");
}

/**
 * What a person or an operator typed → the stored code, or `null` when it is not a support code.
 * Case-insensitive; spaces, dashes and dots are ignored; anything outside the alphabet (a lookalike
 * included) is not a code.
 */
export function normalizeSupportCode(input: string): string | null {
  if (input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s.\-]/g, "");
  if (s.length !== SUPPORT_CODE_LENGTH) return null;
  for (const ch of s) if (!SUPPORT_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** The person's code for the product (dashed), or `null` when none was asked for yet. */
export async function existingSupportCode(
  db: Db,
  product: string,
  subject: string,
): Promise<string | null> {
  const row = await db.first<{ code: string }>(
    "SELECT code FROM support_codes WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  return row ? formatSupportCode(row.code) : null;
}

/** {@link existingSupportCode} for many subjects of one product: subject → dashed code. */
export async function existingSupportCodes(
  db: Db,
  product: string,
  subjects: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(subjects)];
  // D1 binds at most 100 parameters; one is the product.
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    for (const r of await db.all<{ subject: string; code: string }>(
      `SELECT subject, code FROM support_codes
        WHERE product = ? AND subject IN (${batch.map(() => "?").join(", ")})`,
      product,
      ...batch,
    ))
      out.set(r.subject, formatSupportCode(r.code));
  }
  return out;
}

/**
 * The person's code for the product, minted on the first ask and the same one after. Race-safe:
 * `INSERT OR IGNORE` then a read, so two asks at once agree on one code. A code that collides with
 * another person's (the PRIMARY KEY) is redrawn; `draw` is the test seam for forcing that.
 */
export async function supportCodeFor(
  db: Db,
  product: string,
  subject: string,
  now: number,
  draw?: () => number,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const have = await existingSupportCode(db, product, subject);
    if (have) return have;
    await db.run(
      `INSERT OR IGNORE INTO support_codes (code, product, subject, created_at)
       VALUES (?, ?, ?, ?)`,
      mintSupportCode(draw),
      product,
      subject,
      now,
    );
  }
  const have = await existingSupportCode(db, product, subject);
  if (have) return have;
  throw new Error("could not mint a support code");
}

/**
 * A typed code → the (product, subject) it names, or `null`. INTERNAL: the caller checks the
 * operator may read that product before it says anything about the answer.
 */
export async function resolveSupportCode(
  db: Db,
  input: string,
): Promise<{ product: string; subject: string } | null> {
  const code = normalizeSupportCode(input);
  if (!code) return null;
  return await db.first<{ product: string; subject: string }>(
    "SELECT product, subject FROM support_codes WHERE code = ?",
    code,
  );
}

/** The subject a code names within ONE product, or `null` (a code of another product is `null`). */
export async function subjectForSupportCode(
  db: Db,
  product: string,
  input: string,
): Promise<string | null> {
  const hit = await resolveSupportCode(db, input);
  return hit && hit.product === product ? hit.subject : null;
}

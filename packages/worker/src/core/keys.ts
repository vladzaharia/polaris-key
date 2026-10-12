/**
 * Signing-key identifiers: how a new rotation `kid` is minted.
 *
 * The rule for what a `kid` may be is the manifest's `KID_RE` (the console's write checks and the
 * manifest validator already apply it), so a minted kid is held to the same one rather than to a
 * second copy of it.
 */

import { KID_RE } from "@polaris-key/manifest";

/** Base32 without the ambiguous letters (no `i`, `l`, `o`, `u`): a suffix an operator can read
 *  aloud. 32 symbols, so a random byte maps onto it without bias. */
const SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A random, collision-resistant suffix for a minted `kid`: 8 symbols, 40 bits.
 *
 * The rotation kid used to end in `(now % 100000).toString(36)`, a value that repeats every
 * 100000 seconds, a little over a day. Two rotations of the same product a day apart therefore
 * produced the SAME kid, hit `PRIMARY KEY (product, kid)`, and surfaced as an opaque 500: the
 * operator learns only that rotation failed, with nothing naming the reason and no reason to
 * suspect the clock. 40 bits of randomness makes the collision negligible, and the paired
 * `insertProductKeyIfAbsent` reports the residual case as a fact instead of an exception.
 */
export function kidSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % 32]).join("");
}

/**
 * Mint a `kid` for a newly generated key: `<slug>-<year>-<suffix>`.
 *
 * The year is kept because it is what makes a key inventory readable at a glance; the suffix is
 * what makes it unique. Returns null when the result is not a valid `kid`: the slug rule caps a
 * slug at 64 characters, so only a product created before that rule can reach it, and a caller
 * that ignored it would be minting a kid the signer would accept and the manifest would refuse.
 */
export function mintKid(slug: string, now: number): string | null {
  const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}-${kidSuffix()}`;
  return KID_RE.test(kid) ? kid : null;
}

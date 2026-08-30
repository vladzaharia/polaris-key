/**
 * Signing-key identifiers: what a `kid` may be, and how a new one is minted.
 *
 * Core, not admin, because both product-creation paths mint keys — the console
 * (`admin/handlers/products.ts`) and the repo-link flow (`services/release/linkRepo.ts`) — and a
 * service may only reach admin code through core. One module means one answer to "is this a
 * usable kid?", which is the entire point: the two paths disagreeing is how an unverifiable
 * document gets signed.
 *
 * B3-07. `kid` arrived from `POST /api/products` as `String(body.signingKid ?? …)` with NO
 * validation, and became the JWS header `kid` on every document that product would ever sign.
 * The VERIFIER caps the protected header at `MAX_HEADER_BYTES` (1024 decoded, `@polaris-key/jws`)
 * and the SIGNER caps nothing, so a sufficiently long `signingKid` produced a product whose every
 * document exceeded the cap — signed correctly, verifiable by nothing, in any language. The
 * failure surfaces at the client, weeks later, as "verification returns null", with no signal
 * anywhere near the console field that caused it.
 */

/**
 * The longest `kid` a mint will accept.
 *
 * The hard bound is the verifier's 1024-byte header cap. The protected header is
 * `{"alg":"EdDSA","typ":"pkey-license+jws","kid":"…"}` — 49 bytes around the kid at the longest
 * `typ` — so the true ceiling is ~975 ASCII characters. 128 is chosen instead, and the distance
 * is deliberate: a `kid` is an identifier, and a limit that sits at the edge of a cryptographic
 * cap is one JSON-escape away from being wrong. Every kid this platform has ever minted
 * (`<slug>-<year>`, `<slug>-<year>-<suffix>`) is comfortably inside it.
 */
export const MAX_KID_LENGTH = 128;

/**
 * The characters a `kid` may contain.
 *
 * The verifier itself demands only `typeof kid === "string"`, so this is not a compatibility
 * constraint — it is the set that survives every hop a kid actually takes: a JSON string with no
 * escaping (so the encoded header length is the decoded length), a URL path or query segment, a
 * D1 primary-key component, a filename in an operator's key inventory, and a map key in four
 * languages. Anything outside it is a kid that works in one place and surprises in another.
 */
const KID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Why this `kid` is unusable, or null if it is fine. The message is operator-facing. */
export function invalidSigningKid(kid: string): string | null {
  if (kid.length === 0) return "signingKid must not be empty";
  if (kid.length > MAX_KID_LENGTH)
    return `signingKid must be at most ${MAX_KID_LENGTH} characters (a longer kid makes every document this product signs exceed the verifier's header limit, so nothing can verify them)`;
  if (!KID_PATTERN.test(kid))
    return "signingKid may contain only letters, digits, '.', '_', ':' and '-'";
  return null;
}

/** Crockford-ish base32 without the ambiguous letters — a suffix an operator can read aloud. */
const SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A random, collision-resistant suffix for a minted `kid` (B3-08).
 *
 * The rotation kid used to end in `(now % 100000).toString(36)`, a value that repeats every
 * 100000 seconds — a little over a day. Two rotations of the same product a day apart therefore
 * produced the SAME kid, hit `PRIMARY KEY (product, kid)`, and surfaced as an opaque 500: the
 * operator learns only that rotation failed, with nothing naming the reason and no reason to
 * suspect the clock. 40 bits of randomness makes the collision negligible, and the paired
 * `insertProductKeyIfAbsent` reports the residual case as a fact instead of an exception.
 */
export function kidSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % 32]).join("");
}

/**
 * Mint a `kid` for a newly generated key: `<slug>-<year>-<suffix>` for a document key,
 * `<slug>-anchor-<year>-<suffix>` for a trust anchor (§1.1).
 *
 * The year is kept because it is what makes a key inventory readable at a glance; the suffix is
 * what makes it unique. Returns null when the result would not survive `invalidSigningKid` —
 * only reachable via an extravagantly long product slug, and a caller that ignored it would be
 * minting exactly the unverifiable key B3-07 is about.
 */
export function mintKid(
  slug: string,
  role: "anchor" | "document",
  now: number,
): string | null {
  const year = new Date(now * 1000).getUTCFullYear();
  const kid =
    role === "anchor"
      ? `${slug}-anchor-${year}-${kidSuffix()}`
      : `${slug}-${year}-${kidSuffix()}`;
  return invalidSigningKid(kid) === null ? kid : null;
}

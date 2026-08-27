// Generate the cross-language conformance corpus. ONE signer produces the canonical signed
// vectors; every SDK's runner (Node, Python, Swift, React) verifies the SAME files, proving
// byte-identical JWS verification + identical gate transitions. Ed25519 is deterministic, so
// re-signing is reproducible — `--check` re-emits in memory and fails if a committed file
// drifted.
//
// TWO corpora are emitted from the same two committed test keys and the same fixed clocks:
//
//   conformance/corpus/v1/  wire contract v2. FROZEN — Python and Swift still consume it
//                           (they move to v2 in P5; v1 is deleted in P8). Mirrored into the
//                           Swift test bundle, which cannot reach up the monorepo at test
//                           time. Any byte of drift here is a cross-language break.
//   conformance/corpus/v2/  wire contract v3 (docs/security/WIRE-CONTRACT-V3.md). Consumed
//                           by conformance/runners/node/corpusV2.test.ts via @plrs/client-core.
//                           NOT mirrored to Swift yet — that lands with the Swift target
//                           rename in P5.
//
//   pnpm gen:corpus            # write both corpora
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if any file is stale)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signJws, base64UrlEncodeBytes, importSigningKey } from "@plrs/jws";
import { format } from "prettier";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "..", "conformance", "corpus", "v1");
const OUT = join(CORPUS_DIR, "cases.json");
const FINGERPRINT_OUT = join(CORPUS_DIR, "fingerprint.json");

/** The Swift test target bundles its fixtures as copied resources (it can't reach up the
 *  monorepo at test time). To keep those copies from drifting from the canonical corpus, the
 *  generator mirrors them here and `--check` guards the mirror exactly like the source. */
const SWIFT_RESOURCES = join(
  HERE,
  "..",
  "sdks",
  "swift",
  "Tests",
  "PolarisKeyTests",
  "Resources",
);
const GATE_MATRIX = join(CORPUS_DIR, "gate-matrix.json");

/** Committed TEST keypairs. These are NOT production keys — they exist only to sign the
 *  corpus. `djdl-test-2026` signs the DJDL baseline; `pkey-test-prod-2026` is a Polaris
 *  Key test key. */
interface CorpusKey {
  kid: string;
  publicKeyRaw: string;
  privateKeyPkcs8Pem: string;
}

const KEYS: CorpusKey[] = [
  {
    kid: "djdl-test-2026",
    publicKeyRaw: "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----",
  },
  {
    kid: "pkey-test-prod-2026",
    publicKeyRaw: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----",
  },
];

function keyOf(kid: string): CorpusKey {
  const k = KEYS.find((x) => x.kid === kid);
  if (!k) throw new Error(`unknown corpus kid: ${kid}`);
  return k;
}
const pem = (kid: string): string => keyOf(kid).privateKeyPkcs8Pem;
const pub = (kid: string): string => keyOf(kid).publicKeyRaw;
const encSeg = (o: unknown): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));

/** The DJDL baseline doc under the product-scoped v2 wire contract. */
const BASELINE_DOC = {
  schemaVersion: 1,
  aud: "djdl",
  iss: "key.plrs.im",
  licenseId: "abc123def456",
  deviceId: "device-fixture-01",
  issuedAt: 1700000000,
  expiresAt: 1700003600,
  graceUntil: 1702592000,
  profile: {
    name: "Ada Lovelace",
    firstName: "Ada",
    email: "ada@example.com",
    activatedAt: 1690000000,
  },
  payload: {
    config: {
      "run.concurrency": { state: "enforced", value: 4, updatedAt: 1699990000 },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/abc",
        updatedAt: 1699990000,
      },
    },
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
    },
  },
} as const;

/** A Polaris Key v1 doc — adds `aud` (product) + `iss`, the canonical field order. */
function polarisDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_3f8a9b",
    deviceId: "dev_7c1e2d",
    issuedAt: 1700000000,
    expiresAt: 1700003600,
    graceUntil: 1702592000,
    profile: {
      name: "Grace Hopper",
      firstName: "Grace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
    payload: {
      config: {
        "run.concurrency": {
          state: "enforced",
          value: 4,
          updatedAt: 1699990000,
        },
      },
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
        channels: {
          state: "enforced",
          value: ["stable", "staging"],
          updatedAt: 1699990000,
        },
        "app.minVersion": {
          state: "enforced",
          value: "1.0.0",
          updatedAt: 1699990000,
        },
      },
    },
    ...overrides,
  };
}

interface VerifyExpect {
  verify: "ok" | "fail";
  kid?: string;
  doc?: unknown;
}

/** Document-type domain separator, wire contract v2 §2.4. */
type Typ = "pkey-config+jws" | "pkey-trust+jws";

interface CorpusCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  /**
   * The `typ` the CALL SITE expects, i.e. what the runner must pass to its verifier. Absent
   * means "no type requirement" — the v1 shape, and how every pre-existing case is driven.
   */
  typ?: Typ;
  expect: VerifyExpect;
}

/**
 * Sign EXACT JSON text rather than an object, so a case can carry bytes `JSON.stringify`
 * cannot produce — duplicate object keys, above all. The duplicate-key cases must be
 * correctly signed or they would fail at the signature check and prove nothing about the
 * duplicate-key rule, which runs only on authenticated bytes (§2.1 step 13).
 */
async function signRawSegments(
  headerText: string,
  payloadText: string,
  kid: string,
): Promise<string> {
  const utf8 = new TextEncoder();
  const signingInput = `${base64UrlEncodeBytes(utf8.encode(headerText))}.${base64UrlEncodeBytes(utf8.encode(payloadText))}`;
  const key = await importSigningKey(pem(kid));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

/** Grow `base` with a filler field until its JSON is EXACTLY `target` UTF-8 bytes. */
function docOfExactBytes(
  target: number,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const size = (o: unknown): number =>
    new TextEncoder().encode(JSON.stringify(o)).length;
  const empty = size({ ...base, pad: "" });
  if (empty > target)
    throw new Error(`cannot pad to ${target}: base is already ${empty}`);
  // `pad` holds ASCII, so one added character is exactly one added JSON byte.
  const doc = { ...base, pad: "A".repeat(target - empty) };
  if (size(doc) !== target)
    throw new Error(`padding did not converge: ${size(doc)} != ${target}`);
  return doc;
}

async function build(): Promise<unknown> {
  const cases: CorpusCase[] = [];

  // 1. DJDL baseline under the first product-specific test key.
  const baselineJws = await signJws(
    BASELINE_DOC,
    pem("djdl-test-2026"),
    "djdl-test-2026",
  );
  cases.push({
    id: "djdl-baseline",
    description:
      "DJDL cross-platform vector under the scoped v2 wire contract.",
    jws: baselineJws,
    trust: { "djdl-test-2026": pub("djdl-test-2026") },
    expect: { verify: "ok", kid: "djdl-test-2026", doc: BASELINE_DOC },
  });

  // 2. Valid Polaris v1 doc under the prod-like test key.
  const validDoc = polarisDoc();
  const validJws = await signJws(
    validDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-stable",
    description: "A valid Polaris v1 managed-config document (with aud/iss).",
    jws: validJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: validDoc },
  });

  // 3. Tampered payload — flip a value, keep the original signature.
  const [h, , s] = validJws.split(".") as [string, string, string];
  const tampered = polarisDoc({
    payload: {
      config: {
        "run.concurrency": {
          state: "enforced",
          value: 999,
          updatedAt: 1699990000,
        },
      },
      secrets: {},
      entitlements: {},
    },
  });
  cases.push({
    id: "tampered-payload",
    description: "Payload mutated after signing — signature must fail.",
    jws: `${h}.${encSeg(tampered)}.${s}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 4. Unknown kid — signed by a key not present in the trust set.
  const unknownJws = await signJws(
    validDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "wrong-kid",
    description: "Valid signature, but the kid is absent from the trust set.",
    jws: unknownJws,
    trust: { "some-other-kid": pub("djdl-test-2026") },
    expect: { verify: "fail" },
  });

  // 5. alg downgrade — a `none` header must be rejected before signature math.
  cases.push({
    id: "wrong-alg-none",
    description: "Header alg=none — rejected as an algorithm downgrade.",
    jws: `${encSeg({ alg: "none", kid: "pkey-test-prod-2026" })}.${encSeg(validDoc)}.`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 6. Malformed inputs — must return a clean failure, never throw.
  cases.push({
    id: "malformed-two-parts",
    description: "Structurally invalid JWS (two segments).",
    jws: "a.b",
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 7. Second key (djdl-test-2026) verified under a trust set containing BOTH keys —
  //    the verifier must pick the right pubkey by `kid`, not by position/first-entry.
  const multiTrust = {
    "djdl-test-2026": pub("djdl-test-2026"),
    "pkey-test-prod-2026": pub("pkey-test-prod-2026"),
  };
  const secondKeyDoc = polarisDoc({ licenseId: "lic_second_key" });
  const secondKeyJws = await signJws(
    secondKeyDoc,
    pem("djdl-test-2026"),
    "djdl-test-2026",
  );
  cases.push({
    id: "valid-second-key-multi-trust",
    description:
      "A doc signed by djdl-test-2026, verified against a trust set holding BOTH test keys — selection is by kid.",
    jws: secondKeyJws,
    trust: multiTrust,
    expect: { verify: "ok", kid: "djdl-test-2026", doc: secondKeyDoc },
  });

  // 8. Extensibility: extra/unknown top-level fields must NOT break verification. The
  //    signature covers the exact bytes, so the payload round-trips verbatim.
  const extensionDoc = polarisDoc({
    futureFeature: { tier: "gold", seats: 5 },
    unknownTopLevel: "preserved-extension-field",
  });
  const extensionJws = await signJws(
    extensionDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-extension-extra-fields",
    description:
      "A doc carrying unknown top-level fields still verifies and round-trips byte-for-byte.",
    jws: extensionJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: extensionDoc },
  });

  // 9. Right kid, WRONG key bytes — a signature from key A presented under a trust set
  //    that maps the SAME kid to key B's pubkey. Presence of the kid is not enough; the
  //    bytes must match, so the signature math must fail.
  cases.push({
    id: "right-kid-wrong-key",
    description:
      "Signature from pkey-test-prod-2026 verified against a trust mapping that kid to djdl-test-2026's pubkey — must fail.",
    jws: validJws,
    trust: { "pkey-test-prod-2026": pub("djdl-test-2026") },
    expect: { verify: "fail" },
  });

  // 10. Empty string — degenerate structural failure (zero segments).
  cases.push({
    id: "malformed-empty-string",
    description:
      "An empty-string JWS — structurally invalid, must fail cleanly.",
    jws: "",
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 11. Four segments — too many parts; must fail before any signature math.
  const [fh, fp, fs] = validJws.split(".") as [string, string, string];
  cases.push({
    id: "malformed-four-parts",
    description:
      "A 4-segment JWS (extra trailing part) — structurally invalid, must fail.",
    jws: `${fh}.${fp}.${fs}.extra`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 12. Unicode in profile.name — non-ASCII UTF-8 must encode + round-trip exactly, so
  //     cross-language verifiers agree on the byte-level UTF-8 of the signed payload.
  const unicodeDoc = polarisDoc({
    licenseId: "lic_unicode",
    profile: {
      name: "Ada Lovelace 💻 — 北京 — Ångström",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1690000000,
    },
  });
  const unicodeJws = await signJws(
    unicodeDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-unicode-profile-name",
    description:
      "A doc whose profile.name contains emoji + CJK + diacritics — verifies and round-trips the exact UTF-8.",
    jws: unicodeJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: unicodeDoc },
  });

  // 13. Wire contract v2 management states — a doc carrying an `enforced`, a `hidden`, and a
  //     `default` entry, each with an `updatedAt` (epoch seconds). Verifies + round-trips
  //     the exact entry shapes so every SDK agrees on the v2 ManagedEntry encoding.
  const v2StatesDoc = polarisDoc({
    licenseId: "lic_v2_states",
    payload: {
      config: {
        "run.concurrency": {
          state: "enforced",
          value: 4,
          updatedAt: 1699991111,
        },
        "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
      },
      secrets: {
        "proxy.subscriptionUrl": {
          state: "hidden",
          value: "https://vpn.example.com/sub/xyz",
          updatedAt: 1699993333,
        },
      },
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1699994444 },
      },
    },
  });
  const v2StatesJws = await signJws(
    v2StatesDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-v2-management-states",
    description:
      "A v2 doc with enforced + hidden + default ManagedEntry shapes (each carrying updatedAt) — verifies and round-trips the exact entry shapes.",
    jws: v2StatesJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: v2StatesDoc },
  });

  // 14. `updatedAt` round-trip — a distinct epoch-seconds stamp per entry must survive
  //     signing + verification byte-for-byte (clients change-detect on this field).
  const updatedAtDoc = polarisDoc({
    licenseId: "lic_updated_at",
    payload: {
      config: {
        "run.concurrency": {
          state: "enforced",
          value: 8,
          updatedAt: 1700123456,
        },
      },
      secrets: {},
      entitlements: {
        polarisVpn: { state: "default", value: false, updatedAt: 1700654321 },
      },
    },
  });
  const updatedAtJws = await signJws(
    updatedAtDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-updated-at-roundtrip",
    description:
      "Per-entry updatedAt (epoch seconds) round-trips exactly through sign + verify — clients change-detect on it.",
    jws: updatedAtJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: updatedAtDoc },
  });

  // ── Attack surface (P-hardening) ───────────────────────────────────────────────
  // The header byte segment of `validJws`, reused below to swap only the protected header.
  const validHeaderless = validJws.split(".").slice(1).join("."); // encPayload.encSig

  // 15. alg confusion — ES256. The doc was Ed25519-signed; presenting it with an `ES256`
  //     header against an Ed25519 trust set must be rejected at the `alg` assertion, before
  //     any signature math (no asymmetric-vs-symmetric / curve confusion).
  cases.push({
    id: "wrong-alg-es256",
    description:
      "Header alg=ES256 against an Ed25519 trust set — rejected as algorithm confusion.",
    jws: `${encSeg({ alg: "ES256", kid: "pkey-test-prod-2026" })}.${validHeaderless}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 16. alg confusion — HS256. A symmetric MAC alg presented against an Ed25519 (asymmetric)
  //     trust set: the classic "verify the HMAC using the public key as the secret" downgrade.
  //     Must be rejected because alg !== EdDSA.
  cases.push({
    id: "wrong-alg-hs256",
    description:
      "Header alg=HS256 (symmetric) against an Ed25519 trust set — rejected, no key-confusion.",
    jws: `${encSeg({ alg: "HS256", kid: "pkey-test-prod-2026" })}.${validHeaderless}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 17. Empty trust set — a perfectly valid token, but NO trusted keys. `{}` can never
  //     verify anything → null.
  cases.push({
    id: "empty-trust-set",
    description:
      "A valid token verified with an empty trust set ({}) — no key can match, must be null.",
    jws: validJws,
    trust: {},
    expect: { verify: "fail" },
  });

  // 18. Foreign-kid-only — the trust set holds exactly one (real) key, but under a DIFFERENT
  //     kid than the token's. The token's own kid is absent → null. (Distinct from wrong-kid:
  //     here the trusted key bytes are genuine, just keyed under an unrelated kid.)
  cases.push({
    id: "foreign-kid-only",
    description:
      "Valid token whose kid is absent from a non-empty (foreign-keyed) trust set — null.",
    jws: validJws,
    trust: { "fleet-key-eu-2027": pub("djdl-test-2026") },
    expect: { verify: "fail" },
  });

  // 19. Large integer timestamps near 2^53 — issuedAt/expiresAt/graceUntil + an entry
  //     updatedAt at Number.MAX_SAFE_INTEGER (9_007_199_254_740_991). These must round-trip
  //     losslessly through every SDK's JSON number handling (JS double, Python int, Swift
  //     Int64) — no precision corruption.
  const MAX_SAFE = 9007199254740991; // 2^53 - 1
  const bigIntDoc = polarisDoc({
    licenseId: "lic_big_int_ts",
    issuedAt: MAX_SAFE - 2,
    expiresAt: MAX_SAFE - 1,
    graceUntil: MAX_SAFE,
    profile: {
      name: "Grace Hopper",
      firstName: "Grace",
      email: "grace@example.com",
      activatedAt: MAX_SAFE - 3,
    },
    payload: {
      config: {
        "run.concurrency": { state: "enforced", value: 4, updatedAt: MAX_SAFE },
      },
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: MAX_SAFE - 1 },
      },
    },
  });
  const bigIntJws = await signJws(
    bigIntDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-large-integer-timestamps",
    description:
      "Timestamps at/near 2^53-1 (Number.MAX_SAFE_INTEGER) round-trip losslessly across JS/Python/Swift — no precision loss.",
    jws: bigIntJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: bigIntDoc },
  });

  // 20. base64url padding variant on the payload segment — the wire uses UNPADDED base64url,
  //     so the signature is computed over `encHeader "." encPayload` exactly as transmitted.
  //     Appending a `=` padding char changes those signing-input bytes, so the (unchanged)
  //     signature no longer matches → null. Verifiers must use the segment verbatim, never
  //     "helpfully" canonicalise padding away before checking the signature.
  const [vh, vp, vs] = validJws.split(".") as [string, string, string];
  cases.push({
    id: "base64url-payload-padding",
    description:
      "Payload segment carries a `=` base64url padding char — alters the signing input, must be rejected.",
    jws: `${vh}.${vp}=.${vs}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 21. Trailing data on the payload segment — extra base64url bytes appended after the signed
  //     payload change the signing input, so the (unchanged) signature no longer matches → null.
  cases.push({
    id: "base64url-payload-trailing-data",
    description:
      "Trailing data appended to the payload segment — signing input differs, signature must fail.",
    jws: `${vh}.${vp}AAAA.${vs}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 22. NUL byte inside a JSON string value — a U+0000 embedded in profile.name. JSON encodes
  //     it as the `\u0000` escape; it must survive sign + verify and round-trip as the exact
  //     same UTF-8 code point on every platform (UTF-8 stability past control chars).
  const nulByteDoc = polarisDoc({
    licenseId: "lic_nul_byte",
    profile: {
      name: "before\u0000after",
      firstName: "Gr\u0000ace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
  });
  const nulByteJws = await signJws(
    nulByteDoc,
    pem("pkey-test-prod-2026"),
    "pkey-test-prod-2026",
  );
  cases.push({
    id: "valid-nul-byte-in-string",
    description:
      "A NUL (U+0000) byte embedded in a JSON string value round-trips byte-for-byte — UTF-8 stays stable through control chars.",
    jws: nulByteJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: nulByteDoc },
  });

  // ══ Wire contract v2 §6 — the divergences the v1 corpus covered NONE of (R2-16) ═══════
  const TRUST = { "pkey-test-prod-2026": pub("pkey-test-prod-2026") };

  // 23. NON-ASCII PAYLOAD — the signer vector. R2-07: Python's `json.dumps` omitted
  //     `ensure_ascii=False`, so it escaped every non-ASCII code point to `\uXXXX` and
  //     produced DIFFERENT signed bytes than Node for the same payload. The v1 corpus was
  //     ASCII-only, so CI could not see it. `jws` below pins the correct construction —
  //     raw UTF-8, never `\uXXXX` — so any signer that re-serialises this `doc` must
  //     reproduce this exact string byte-for-byte.
  const nonAsciiDoc = polarisDoc({
    licenseId: "lic_ünïcödé",
    profile: {
      // Latin-1 supplement, combining diacritic, CJK, RTL, and an astral-plane emoji
      // (a surrogate pair in UTF-16, four bytes in UTF-8).
      name: "Ångström 💻 — 北京 — العربية — é",
      firstName: "Åsa",
      email: "ada@exämple.com",
      activatedAt: 1690000000,
    },
    payload: {
      config: {
        "ui.gruß": { state: "enforced", value: "größe", updatedAt: 1699990000 },
      },
      secrets: {},
      entitlements: {
        日本語: { state: "enforced", value: true, updatedAt: 1699990000 },
      },
    },
  });
  cases.push({
    id: "valid-non-ascii-payload",
    description:
      "Non-ASCII throughout keys AND values. Signers MUST emit raw UTF-8, never \\uXXXX escapes (§2.5) — this vector pins the canonical signed bytes so a re-serialising signer that escapes is caught (R2-07).",
    jws: await signJws(
      nonAsciiDoc,
      pem("pkey-test-prod-2026"),
      "pkey-test-prod-2026",
    ),
    trust: TRUST,
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: nonAsciiDoc },
  });

  // 24. Oversized protected header — R2-04. The header was base64-decoded and JSON-parsed
  //     with no bound at all, before any signature or trust check, so moving the blob into
  //     the header bypassed the payload cap entirely. The PoC used 8 MiB; the boundary is
  //     the same code path at a size that can live in a committed fixture.
  cases.push({
    id: "header-oversized",
    description:
      "Protected header past MAX_HEADER_BYTES (1024). Must be rejected on the ENCODED length, before any decode/parse (§2.1 step 2).",
    jws: `${encSeg({ alg: "EdDSA", kid: "pkey-test-prod-2026", junk: "J".repeat(2048) })}.${validHeaderless}`,
    trust: TRUST,
    expect: { verify: "fail" },
  });

  // 25/26. The payload cap boundary, from both sides. MAX_DOC_BYTES = 65536 decoded;
  //        MAX_PAYLOAD_B64 = ceil(65536 × 4/3) + 4 = 87386 encoded.
  const atCapDoc = docOfExactBytes(65536, polarisDoc({ licenseId: "lic_cap" }));
  cases.push({
    id: "payload-at-cap",
    description:
      "A payload of EXACTLY MAX_DOC_BYTES (65536) decoded bytes — at the cap is still valid and must verify.",
    jws: await signJws(
      atCapDoc,
      pem("pkey-test-prod-2026"),
      "pkey-test-prod-2026",
    ),
    trust: TRUST,
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: atCapDoc },
  });
  cases.push({
    id: "payload-over-cap",
    description:
      "An encoded payload one character past MAX_PAYLOAD_B64 (87386) — rejected on length before it is ever decoded, so the allocation never happens (§2.1 step 3).",
    jws: `${encSeg({ alg: "EdDSA", kid: "pkey-test-prod-2026" })}.${"A".repeat(87387)}.${vs}`,
    trust: TRUST,
    expect: { verify: "fail" },
  });

  // 27/28. Duplicate JSON members — R2-06. TS and Python resolved last-wins, Swift's
  //        JSONSerialization first-wins, so `{"alg":"none",…,"alg":"EdDSA"}` gave OPPOSITE
  //        answers per language at the algorithm-downgrade guard. Any silent resolution is a
  //        differential; the only safe answer is rejection (§2.2). Both are correctly SIGNED
  //        so the failure can only be the duplicate-key rule.
  cases.push({
    id: "duplicate-key-header-alg",
    description:
      "Protected header declaring `alg` twice (none, then EdDSA). Last-wins reads EdDSA, first-wins reads none — every implementation MUST instead reject (§2.2).",
    jws: await signRawSegments(
      '{"alg":"none","kid":"pkey-test-prod-2026","alg":"EdDSA"}',
      JSON.stringify(validDoc),
      "pkey-test-prod-2026",
    ),
    trust: TRUST,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "duplicate-key-payload",
    description:
      "Payload declaring `licenseId` twice. Checked only after the signature verifies, so this pins the post-verification parse (§2.1 step 13) — reject, never last/first-wins.",
    jws: await signRawSegments(
      '{"alg":"EdDSA","kid":"pkey-test-prod-2026"}',
      '{"schemaVersion":1,"aud":"djdl","iss":"key.plrs.im","licenseId":"lic_a","deviceId":"dev_7c1e2d","licenseId":"lic_b"}',
      "pkey-test-prod-2026",
    ),
    trust: TRUST,
    expect: { verify: "fail" },
  });

  // 29–31. Out-of-alphabet bytes in the SIGNATURE segment — R2-05. Python's
  //        `urlsafe_b64decode(validate=False)` silently DISCARDS them, so these three verify
  //        in Python and are rejected by Node and Swift. Lengths are chosen so Python's
  //        len()-based re-padding stays consistent, which is what made them accepted.
  for (const [suffix, id, label] of [
    ["***", "sig-out-of-alphabet-stars", "`***`"],
    ["\n \t", "sig-out-of-alphabet-whitespace", "whitespace (`\\n \\t`)"],
    ["====", "sig-out-of-alphabet-padding", "explicit base64 padding (`====`)"],
  ] as const) {
    cases.push({
      id,
      description: `Signature segment carrying ${label}. Strict base64url means the \`-_\` alphabet only — no whitespace, no \`=\`, no out-of-alphabet bytes; reject rather than discard (§2.3).`,
      jws: `${vh}.${vp}.${vs}${suffix}`,
      trust: TRUST,
      expect: { verify: "fail" },
    });
  }

  // 32–34. Domain separation — R2-10 / §2.4. One product key signs BOTH config documents and
  //        trust manifests, so without a `typ` a manifest can be replayed where a config doc
  //        is expected (v1 rejected it only by accident, via a swallowed TypeError).
  cases.push({
    id: "typ-missing",
    description:
      "No `typ` in the header, verified at a call site expecting `pkey-config+jws`. ACCEPTED during the rollout window: §7.2 requires verifiers to tolerate an absent `typ` for one release so the Worker can ship first. §6's `reject` row lands at rollout step 4, when `typ` becomes mandatory.",
    jws: validJws,
    trust: TRUST,
    typ: "pkey-config+jws",
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: validDoc },
  });
  cases.push({
    id: "typ-wrong",
    description:
      "Header asserts `typ: pkey-trust+jws` at a call site expecting `pkey-config+jws` — a header claiming the WRONG type is rejected immediately, rollout window or not (§2.4).",
    jws: await signJws(
      validDoc,
      pem("pkey-test-prod-2026"),
      "pkey-test-prod-2026",
      "pkey-trust+jws",
    ),
    trust: TRUST,
    typ: "pkey-config+jws",
    expect: { verify: "fail" },
  });
  const trustManifestDoc = {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    issuedAt: 1700000000,
    expiresAt: 1700000300,
    jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
    cacheSeconds: 300,
    keys: [
      {
        kid: "pkey-test-prod-2026",
        alg: "EdDSA",
        kty: "OKP",
        crv: "Ed25519",
        publicKey: pub("pkey-test-prod-2026"),
        status: "active",
      },
    ],
  };
  cases.push({
    id: "trust-manifest-as-config",
    description:
      "A genuine, correctly-signed TRUST MANIFEST presented where a config document is expected — cross-protocol replay, rejected by the `typ` domain separator rather than incidentally (§2.4).",
    jws: await signJws(
      trustManifestDoc,
      pem("pkey-test-prod-2026"),
      "pkey-test-prod-2026",
      "pkey-trust+jws",
    ),
    trust: TRUST,
    typ: "pkey-config+jws",
    expect: { verify: "fail" },
  });

  return {
    corpusVersion: 1,
    keys: KEYS,
    cases,
    docCases: await buildDocCases(),
    trustCases: await buildTrustCases(),
    clockFloorCases: await buildClockFloorCases(),
  };
}

// ── verifyDoc-level vectors (wire contract v2 §3) ────────────────────────────
// The `cases` array above stops at raw JWS verification. These drive the CLAIM checks — the
// layer R2-08 found was checking `aud`, `deviceId` and monotonic `issuedAt` and nothing else.
// Every runner feeds these through its own `verifyDoc` equivalent.

const CLOCK_SKEW = 300;
const DOC_NOW = 1700001000; // inside the baseline doc's window (1700000000 → 1700003600)

interface DocCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  expectedIss: string;
  deviceId: string;
  /** Epoch seconds the verifier must evaluate the clock claims at. */
  now: number;
  lastAcceptedIssuedAt?: number;
  /** False = the cache-reload path, where the outer bound is `graceUntil`, not `expiresAt`. */
  checkFreshness?: boolean;
  expect: { accept: boolean };
}

async function buildDocCases(): Promise<DocCase[]> {
  const kid = "pkey-test-prod-2026";
  const trust = { [kid]: pub(kid) };
  const sign = (over: Record<string, unknown>): Promise<string> =>
    signJws(polarisDoc(over), pem(kid), kid, "pkey-config+jws");
  const common = {
    trust,
    expectedAud: "djdl",
    expectedIss: "key.plrs.im",
    deviceId: "dev_7c1e2d",
    now: DOC_NOW,
  };

  return [
    {
      ...common,
      id: "doc-valid-control",
      description:
        "The control: a well-formed, correctly-bound, in-window document is accepted.",
      jws: await sign({}),
      expect: { accept: true },
    },
    {
      ...common,
      id: "doc-expired",
      description:
        "Evaluated past `expiresAt + CLOCK_SKEW`. An expired document must be refused AT VERIFY — not merely reported `grace`/`expired` by the gate afterwards, which is what v1 did while still handing out its entitlements and secrets (§3, R2-08).",
      jws: await sign({}),
      now: 1700003600 + CLOCK_SKEW + 1,
      expect: { accept: false },
    },
    {
      ...common,
      id: "doc-expired-within-skew",
      description:
        "The same document one second INSIDE the skew window is still accepted — CLOCK_SKEW is 300s in every implementation.",
      jws: await sign({}),
      now: 1700003600 + CLOCK_SKEW - 1,
      expect: { accept: true },
    },
    {
      ...common,
      id: "doc-expired-reload-path",
      description:
        "The expired document again, on the CACHE-RELOAD path. A cached doc is expected to be past its short `expiresAt` — that is what offline operation is — so the freshness bound is not applied there; its signed outer bound is `graceUntil`, enforced by the gate (§4.2/§4.3).",
      jws: await sign({}),
      now: 1700003600 + CLOCK_SKEW + 1,
      checkFreshness: false,
      expect: { accept: true },
    },
    {
      ...common,
      id: "iss-mismatch",
      description:
        "A foreign `iss`. Documented as 'always ISSUER' since v1 and enforced for trust manifests, but never checked for config documents (§3, R2-08).",
      jws: await sign({ iss: "https://evil.example" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: "issued-far-future",
      description:
        "`issuedAt` ten years ahead. v1 had no `nbf`/`iat` sanity check at all, so a far-future document was accepted and gated `ok` — and it also pinned the anti-replay floor out of reach (§3, R4-03).",
      jws: await sign({
        issuedAt: 2000000000,
        expiresAt: 2000003600,
        graceUntil: 2002592000,
      }),
      expect: { accept: false },
    },
    {
      ...common,
      id: "issued-future-within-skew",
      description:
        "`issuedAt` CLOCK_SKEW seconds ahead of the verifier's clock is tolerated: a client whose clock is slightly behind must not reject a freshly-signed document.",
      jws: await sign({}),
      now: 1700000000 - CLOCK_SKEW,
      expect: { accept: true },
    },
    {
      ...common,
      id: "grace-before-expiry",
      description:
        "`graceUntil` earlier than `expiresAt` is incoherent — the offline window cannot close before the document does (§3).",
      jws: await sign({ graceUntil: 1700003599 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: "grace-unbounded",
      description:
        "`graceUntil` a century past `issuedAt`. Bounds a hostile control plane and a tampered cache alike; v1 accepted it without complaint (§3).",
      jws: await sign({ graceUntil: 1700000000 + 100 * 365 * 86400 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: "doc-replayed-below-floor",
      description:
        "`issuedAt` at the anti-replay floor. Equal is not strictly newer, so a re-presented document is refused.",
      jws: await sign({}),
      lastAcceptedIssuedAt: 1700000000,
      expect: { accept: false },
    },
    {
      ...common,
      id: "doc-aud-mismatch",
      description:
        "A document scoped to another product. Enforced on the network path in v1 — and, critically, now on the cache-reload path too (R4-01).",
      jws: await sign({ aud: "other-product" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: "doc-device-mismatch",
      description:
        "A document bound to another device — a doc lifted from a colleague's machine (R4-01).",
      jws: await sign({ deviceId: "dev_someone_else" }),
      expect: { accept: false },
    },
  ];
}

// ── Trust-set vectors (wire contract v2 §1) ──────────────────────────────────
// Pure data for the merge/prune/revocation rules. `before` is the set already learned from an
// earlier manifest; a runner that MERGES instead of REPLACING fails `trust-prune-on-absence`,
// and one that spreads the cache after the pins fails `trust-pinned-substitution`.

interface TrustCase {
  id: string;
  description: string;
  /** Compiled into the host application. Terminal — never overridden. */
  pinned: Record<string, string>;
  /** Keys already discovered from an earlier manifest, which this one REPLACES. */
  before: Record<string, string>;
  manifestJws: string;
  now: number;
  /**
   * Absent ⇒ the NETWORK path (freshness enforced). `false` ⇒ the CACHE-RELOAD path, where a
   * manifest is EXPECTED to be past its minutes-long `expiresAt` — re-checking it there would
   * drop every rotated key on restart (§4.2).
   */
  checkFreshness?: boolean;
  expect: {
    /** Whether the manifest is accepted at all. */
    accepted: boolean;
    /** The effective trust set afterwards: `pinned ∪ non-revoked manifest keys`, or the
     *  unchanged `pinned ∪ before` when the manifest is rejected. */
    trust: Record<string, string>;
    /** The accepted manifest's `issuedAt`. This is the value §4.3 folds into the monotonic
     *  clock floor, so a runner that silently drops the manifest doc still fails here. */
    issuedAt?: number;
  };
}

/** A syntactically valid Ed25519 public key that belongs to nobody — the "attacker" bytes in
 *  the substitution case. Deterministic so `--check` is stable. */
const FOREIGN_PUB = base64UrlEncodeBytes(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff)),
);

/** Every manifest below is stamped with this `issuedAt`; §4.3 folds it into the clock floor. */
const MANIFEST_ISSUED_AT = 1700000000;

async function buildTrustCases(): Promise<TrustCase[]> {
  const PIN = "pkey-test-prod-2026";
  const ROTATED = "djdl-test-2026";
  const pinned = { [PIN]: pub(PIN) };
  const now = 1700000100;
  const key = (
    kid: string,
    publicKey: string,
    status: string,
  ): Record<string, unknown> => ({
    kid,
    alg: "EdDSA",
    kty: "OKP",
    crv: "Ed25519",
    publicKey,
    status,
  });
  const manifest = (keys: Record<string, unknown>[]): Promise<string> =>
    signJws(
      {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        issuedAt: 1700000000,
        expiresAt: 1700000300,
        jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys,
      },
      pem(PIN),
      PIN,
      "pkey-trust+jws",
    );

  return [
    {
      id: "trust-learn-rotated-key",
      description:
        "The control: a manifest signed by the pinned key publishes a second key, which joins the trust set alongside the pin.",
      pinned,
      before: {},
      manifestJws: await manifest([
        key(PIN, pub(PIN), "active"),
        key(ROTATED, pub(ROTATED), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "key-status-revoked",
      description:
        'A key published with `status:"revoked"` — the positive revocation signal the server emits for 2× cacheSeconds — MUST NOT enter the trust set. v1 never read `status` at all (§1.2, R2-02).',
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await manifest([
        key(PIN, pub(PIN), "active"),
        key(ROTATED, pub(ROTATED), "revoked"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "key-status-retired-and-staged-are-trusted",
      description:
        "`retired` and `staged` DO verify, deliberately: in-flight documents signed before a rotation must still validate, and a key must be trusted before it signs or rotation can never land (§1.2).",
      pinned,
      before: {},
      manifestJws: await manifest([
        key(PIN, pub(PIN), "retired"),
        key(ROTATED, pub(ROTATED), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "trust-prune-on-absence",
      description:
        "A key present in `before` but ABSENT from the new manifest is DROPPED: the trust set becomes exactly `pinned ∪ manifest keys`, never the union with what was already held. Merging instead of replacing is R2-02 — revocation by omission had no effect on a provisioned client (§1.2 rule 4).",
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await manifest([key(PIN, pub(PIN), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "trust-pinned-substitution",
      description:
        "A correctly-signed manifest presenting a PINNED kid with DIFFERENT key bytes. This is a substitution attempt, not an update: the WHOLE manifest is rejected and the previous trust set is kept — not merged with the substitution quietly dropped (§1.1 rule 1, R2-01).",
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await manifest([key(PIN, FOREIGN_PUB, "active")]),
      now,
      expect: {
        accepted: false,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
      },
    },
    {
      id: "trust-pinned-kid-same-bytes",
      description:
        "Re-publishing a pinned kid with the SAME bytes is an ordinary manifest, not a substitution — it must be accepted.",
      pinned,
      before: {},
      manifestJws: await manifest([key(PIN, pub(PIN), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "trust-prune-to-pins-only",
      description:
        "A manifest that revokes everything leaves exactly the pins. Pinned keys are NEVER pruned — pinning is the host application's deliberate escape hatch for a total control-plane compromise (§1.2 rule 5).",
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await manifest([key(ROTATED, pub(ROTATED), "revoked")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "trust-expired-manifest",
      description:
        "A manifest evaluated past `expiresAt + CLOCK_SKEW` is refused on the network path, and the previous trust set is kept.",
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await manifest([key(PIN, pub(PIN), "active")]),
      now: 1700000300 + CLOCK_SKEW + 1,
      expect: {
        accepted: false,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
      },
    },
    {
      id: "trust-expired-manifest-reload-path",
      description:
        "The SAME long-expired manifest on the CACHE-RELOAD path. A manifest's `expiresAt` is `issuedAt + cacheSeconds` — minutes — so a client that re-checked it on load would drop every rotated key on every restart and lose the ability to verify offline. Freshness is a network-path rule only (§4.2), the mirror of `doc-expired-reload-path`. Its `issuedAt` is still a signed lower bound on real time and still raises the §4.3 clock floor.",
      pinned,
      before: {},
      manifestJws: await manifest([
        key(PIN, pub(PIN), "active"),
        key(ROTATED, pub(ROTATED), "staged"),
      ]),
      now: 1700000300 + CLOCK_SKEW + 1,
      checkFreshness: false,
      expect: {
        accepted: true,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
        issuedAt: MANIFEST_ISSUED_AT,
      },
    },
    {
      id: "trust-aud-mismatch",
      description:
        "A manifest scoped to another product is refused — the same cross-tenant binding config documents get.",
      pinned,
      before: {},
      manifestJws: await signJws(
        {
          schemaVersion: 1,
          aud: "other-product",
          iss: "key.plrs.im",
          issuedAt: 1700000000,
          expiresAt: 1700000300,
          jwksUrl: "https://key.plrs.im/other-product/.well-known/jwks.json",
          cacheSeconds: 300,
          keys: [key(ROTATED, pub(ROTATED), "active")],
        },
        pem(PIN),
        PIN,
        "pkey-trust+jws",
      ),
      now,
      expect: { accepted: false, trust: { [PIN]: pub(PIN) } },
    },
    {
      id: "trust-signed-by-non-pinned-key",
      description:
        "A manifest signed by a DISCOVERED key rather than a pinned one. Manifests verify against the PINNED set only, so a rotated — or planted — key can never sign the manifest that mints the next key. That is what stops R2-01's poisoning from self-perpetuating (§4.2).",
      pinned,
      before: { [ROTATED]: pub(ROTATED) },
      manifestJws: await signJws(
        {
          schemaVersion: 1,
          aud: "djdl",
          iss: "key.plrs.im",
          issuedAt: 1700000000,
          expiresAt: 1700000300,
          jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
          cacheSeconds: 300,
          keys: [key("minted-by-rotated-key", FOREIGN_PUB, "active")],
        },
        pem(ROTATED),
        ROTATED,
        "pkey-trust+jws",
      ),
      now,
      expect: {
        accepted: false,
        trust: { [PIN]: pub(PIN), [ROTATED]: pub(ROTATED) },
      },
    },
  ];
}

// ── Monotonic clock-floor vectors (wire contract v2 §4.3) ────────────────────
// The rule these pin:
//
//     highWaterMark = max(verifiedConfigDoc.issuedAt, verifiedTrustManifest.issuedAt)
//     effectiveNow  = max(systemClock, highWaterMark)
//
// Deriving the mark from the config document ALONE is inert (R4-04): with one cached
// document `highWaterMark === doc.issuedAt` by construction, and `graceUntil` is by
// construction greater, so the floor can never push `effectiveNow` past `graceUntil` and
// rolling the clock back still extends offline grace indefinitely. The trust manifest is the
// second, independently-advancing signed clock — `trustRefresh` is on by default, so it moves
// even while a config document sits unchanged behind a stable ETag.
//
// Each case is the cache-RELOAD path replayed as pure data. Every runner performs exactly:
//
//   1. trust := pinned
//   2. if trustJws: verifyTrustManifest(trustJws, pinned, aud, now=systemClock,
//                                       checkFreshness=FALSE)
//        accepted ⇒ trust := mergeTrust(pinned, discovered);
//                   floor := max(floor, manifest.issuedAt)
//   3. if configJws: verifyDoc(configJws, trust, aud, deviceId, now=systemClock,
//                              checkFreshness=FALSE)
//        accepted ⇒ doc := it; floor := max(floor, doc.issuedAt)
//   4. effectiveNow := max(systemClock, floor)
//   5. status := licenseState({ hasToken: TRUE, doc, now: effectiveNow })
//
// and asserts all three of `highWaterMark`, `effectiveNow` and `status`.

interface ClockFloorCase {
  id: string;
  description: string;
  /** Compiled into the host application. The manifest verifies against these only. */
  pinned: Record<string, string>;
  /** The cached `trustJws`, when the case has one. Loaded with freshness OFF. */
  trustJws?: string;
  /** The cached `configJws`, when the case has one. Loaded with freshness OFF. */
  configJws?: string;
  expectedAud: string;
  deviceId: string;
  /** What the device's own clock claims — the value an attacker controls. */
  systemClock: number;
  expect: {
    /** `max` over the `issuedAt` of every artifact that actually re-verified. */
    highWaterMark: number;
    /** `max(systemClock, highWaterMark)`. */
    effectiveNow: number;
    /** The gate status at `effectiveNow`, with a token and no block/401 hints. */
    status: string;
  };
}

async function buildClockFloorCases(): Promise<ClockFloorCase[]> {
  const PIN = "pkey-test-prod-2026";
  const ROTATED = "djdl-test-2026";
  const pinned = { [PIN]: pub(PIN) };
  const DAY = 86400;
  /** The cached document's `issuedAt`. Its signed window is `expiresAt = +1h`,
   *  `graceUntil = +30d` (1700003600 / 1702592000 — see `polarisDoc`). */
  const DOC_ISSUED = 1700000000;
  /** A manifest refreshed 399 days later — "I verified a manifest yesterday". */
  const MANIFEST_LATER = DOC_ISSUED + 399 * DAY;
  /** A manifest older than the document, so it cannot be what raises the floor. */
  const MANIFEST_EARLIER = DOC_ISSUED - 3600;
  /** `sudo date`: wound back inside the document's one-hour window. */
  const ROLLED_BACK = DOC_ISSUED + 60;
  /** An honest clock, long past the whole signed grace window. */
  const HONEST_LATE = DOC_ISSUED + 400 * DAY;

  const key = (
    kid: string,
    publicKey: string,
    status: string,
  ): Record<string, unknown> => ({
    kid,
    alg: "EdDSA",
    kty: "OKP",
    crv: "Ed25519",
    publicKey,
    status,
  });
  const manifest = (
    issuedAt: number,
    keys: Record<string, unknown>[],
    signWith = PIN,
  ): Promise<string> =>
    signJws(
      {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        issuedAt,
        expiresAt: issuedAt + 300,
        jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys,
      },
      pem(signWith),
      signWith,
      "pkey-trust+jws",
    );
  const doc = (signWith = PIN): Promise<string> =>
    signJws(polarisDoc(), pem(signWith), signWith, "pkey-config+jws");
  const common = { pinned, expectedAud: "djdl", deviceId: "dev_7c1e2d" };

  return [
    {
      ...common,
      id: "floor-config-doc-alone-does-not-stop-rollback",
      description:
        "The residual R4-04 defect, pinned so it cannot come back by accident: with the config document as the ONLY floor source, `highWaterMark === doc.issuedAt`, which is below `graceUntil` by construction. A clock wound back inside the document's window still reads `ok`. This case is why the mark must have a second source.",
      configJws: await doc(),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: DOC_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-trust-manifest-defeats-rollback",
      description:
        "The fix. The same wound-back clock and the same document, plus a trust manifest the client verified 399 days later. `highWaterMark = max(doc.issuedAt, manifest.issuedAt)` is now past `graceUntil`, so the gate reads `expired` — a client that verified a manifest yesterday cannot claim it is last year (§4.3).",
      configJws: await doc(),
      trustJws: await manifest(MANIFEST_LATER, [key(PIN, pub(PIN), "active")]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-stale-cached-manifest-still-yields-its-keys",
      description:
        "Raising the floor from a cached manifest must NOT re-introduce freshness checking on that path. This manifest expired long ago and publishes the rotated key the cached document is signed with: it must still load (§4.2), or the document cannot verify at all and every restart after a key rotation strands the client. Its `issuedAt` predates the document's, so the document is what sets the mark.",
      configJws: await doc(ROTATED),
      trustJws: await manifest(MANIFEST_EARLIER, [
        key(PIN, pub(PIN), "active"),
        key(ROTATED, pub(ROTATED), "staged"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: DOC_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-honest-clock-is-never-lowered",
      description:
        "The floor is a MINIMUM, never a substitute. With an honest clock long past the whole signed grace window, `effectiveNow` is the system clock and the gate reads `expired` — the floor costs nothing when the clock is truthful.",
      configJws: await doc(),
      trustJws: await manifest(MANIFEST_EARLIER, [
        key(PIN, pub(PIN), "active"),
      ]),
      systemClock: HONEST_LATE,
      expect: {
        highWaterMark: DOC_ISSUED,
        effectiveNow: HONEST_LATE,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-rejected-manifest-does-not-raise-it",
      description:
        "Only RE-VERIFIED content moves the mark. This manifest carries a far later `issuedAt` but is signed by a discovered key rather than a pinned one, so it is refused outright — and a refused artifact must contribute nothing, or planting a file would become a way to force every client to `expired`.",
      configJws: await doc(),
      trustJws: await manifest(
        MANIFEST_LATER,
        [key(ROTATED, pub(ROTATED), "active")],
        ROTATED,
      ),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: DOC_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-manifest-without-a-document",
      description:
        "A manifest alone still anchors time. There is no config document, so the gate is `needs-activation` either way — but the mark it establishes survives, which is what stops a wound-back clock from later re-admitting a document that has already aged out.",
      trustJws: await manifest(MANIFEST_LATER, [key(PIN, pub(PIN), "active")]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "needs-activation",
      },
    },
  ];
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// CORPUS v2 — wire contract v3 (docs/security/WIRE-CONTRACT-V3.md)
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above this line emits `conformance/corpus/v1/` and is FROZEN: the Python and
// Swift runners still consume it (they move to v2 in P5, and v1 is deleted in P8), so a byte
// of drift up there is a cross-language break. v2 is emitted alongside it, from the same two
// committed test keys and the same fixed timestamps, so both directories stay reproducible
// under `--check`.
//
// What v3 changes, and therefore what the v2 vectors have to say that v1's cannot:
//
//   §1  the `plrs-bundle+jws` payload cap is 262 144, not 65 536 — passed per call
//   §2  a MISSING `typ` is rejected; the v2 tolerance window is closed
//   §2  one document becomes two — `plrs-license+jws` (grants) and `plrs-config+jws`
//       (config + secrets), each with its own claim family and anti-replay floor
//   §8  ISSUER is `plrs.im`, host-neutral — `key.plrs.im` is now a REJECTED issuer
//   §4.2 the clock floor folds THREE artifact kinds, not one
//   §7  offline bundles: an all-or-nothing import with a numbered validation order
//   §5  the gate gains `not-applicable` and `activation: "token" | "bundle" | null`

const V2_DIR = join(HERE, "..", "conformance", "corpus", "v2");
const V2_OUT = join(V2_DIR, "cases.json");
const V2_GATE_MATRIX_OUT = join(V2_DIR, "gate-matrix.json");
const V2_FINGERPRINT_OUT = join(V2_DIR, "fingerprint.json");

/** Document-type domain separators, wire contract v3 §2. */
type TypV3 =
  | "plrs-license+jws"
  | "plrs-config+jws"
  | "plrs-trust+jws"
  | "plrs-bundle+jws";

/** §8 — the ISSUER is host-neutral. `key.plrs.im` remains the serving HOST and is no longer
 *  a valid `iss`; `license-iss-v2-host-rejected` pins exactly that. */
const ISSUER_V3 = "plrs.im";
const AUD_V3 = "djdl";
const DEVICE_V3 = "dev_7c1e2d";
/** The kid the host application PINS. Manifests and bundles verify against this alone. */
const PIN_KID = "pkey-test-prod-2026";
/** A second real key, published by manifests as the rotated/staged one. */
const ALT_KID = "djdl-test-2026";
const PINNED_V3 = { [PIN_KID]: pub(PIN_KID) };

/** The v3 document timeline. `expiresAt = issuedAt + DOC_EXPIRY_SECONDS`,
 *  `graceUntil = issuedAt + 30 × SECONDS_PER_DAY` (a 30-day `maxOfflineDays`). */
const V3_ISSUED = 1700000000;
const V3_EXPIRES = V3_ISSUED + 3600;
const V3_GRACE = V3_ISSUED + 30 * 86400;
/** Inside the document window — the clock every claim case is evaluated at unless it says
 *  otherwise. */
const V3_NOW = 1700001000;
/** §2 `MAX_GRACE_SECONDS` — the 365-day ceiling, enforced at VERIFY time (§3.3). */
const MAX_GRACE_SECONDS = 31536000;
/** §1 — the bundle payload cap, the one artifact that is not 65 536. */
const MAX_BUNDLE_BYTES = 262144;

/** A `plrs-license+jws` payload (§2.1): the shared envelope + grants. `entitlements` is the
 *  sole carrier of grant data (D-20) — tier, channels and the version window ride here. */
function licenseDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: ISSUER_V3,
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_EXPIRES,
    graceUntil: V3_GRACE,
    licenseId: "lic_3f8a9b",
    profile: {
      name: "Grace Hopper",
      firstName: "Grace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
    entitlements: {
      "license.tier": {
        state: "enforced",
        value: "pro",
        updatedAt: 1699990000,
      },
      channels: {
        state: "enforced",
        value: ["stable", "staging"],
        updatedAt: 1699990000,
      },
      "app.minVersion": {
        state: "enforced",
        value: "1.0.0",
        updatedAt: 1699990000,
      },
      polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
    },
    ...overrides,
  };
}

/** A `plrs-config+jws` payload (§2.2): the same envelope, config + secrets, and NO license
 *  fields whatsoever — the wire-level guarantee of service independence (D-08). */
function configDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: ISSUER_V3,
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_EXPIRES,
    graceUntil: V3_GRACE,
    // The PRODUCT's catalog version, not the wire version (§2.2).
    schemaVersion: 4,
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1699990000,
      },
      "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/abc",
        updatedAt: 1699993333,
      },
    },
    ...overrides,
  };
}

function keyEntry(
  kid: string,
  publicKey: string,
  status: string,
): Record<string, unknown> {
  return { kid, alg: "EdDSA", kty: "OKP", crv: "Ed25519", publicKey, status };
}

/** A `plrs-trust+jws` payload (§2.3). Shape unchanged from v2; only `iss` and `typ` moved. */
function trustManifestV3(fields: {
  issuedAt?: number;
  aud?: string;
  keys: Record<string, unknown>[];
}): Record<string, unknown> {
  const issuedAt = fields.issuedAt ?? V3_ISSUED;
  const aud = fields.aud ?? AUD_V3;
  return {
    schemaVersion: 1,
    aud,
    iss: ISSUER_V3,
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `https://key.plrs.im/${aud}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys: fields.keys,
  };
}

const signAs = (payload: unknown, kid: string, typ: TypV3): Promise<string> =>
  signJws(payload, pem(kid), kid, typ);

// ── §1–§2 raw-JWS vectors ────────────────────────────────────────────────────
// v1's `cases` carried forward with v3 typs, plus the three the v3 envelope adds. Every
// runner drives these through the bare JWS verifier with `requireTyp: true` — v3 verifiers
// always demand a type — and with `maxPayloadBytes` only where the case declares one.

interface JwsCaseV2 {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  /** The `typ` the CALL SITE expects. v3 has no untyped call sites, so this is always set
   *  where a document-shaped expectation is meaningful. */
  typ?: TypV3;
  /** §1 — present ONLY on the `plrs-bundle+jws` vectors, which is the one artifact allowed
   *  past 65 536 bytes. Runners must not pass it anywhere else. */
  maxPayloadBytes?: number;
  /** `doc` is omitted where the payload is a quarter-megabyte of padding: the vector pins
   *  the size boundary, and the id already says which side of it. */
  expect: VerifyExpect;
}

async function buildJwsCases(): Promise<JwsCaseV2[]> {
  const cases: JwsCaseV2[] = [];
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const LIC: TypV3 = "plrs-license+jws";

  // 1. The DJDL baseline, restated as a v3 license document under the djdl test key.
  const baseline = licenseDoc({
    licenseId: "abc123def456",
    deviceId: "device-fixture-01",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "djdl-baseline",
    description:
      "The DJDL cross-platform vector, restated as a v3 license document.",
    jws: await signAs(baseline, ALT_KID, LIC),
    trust: { [ALT_KID]: pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "ok", kid: ALT_KID, doc: baseline },
  });

  // 2. The control: a valid license document under the prod-like test key.
  const validDoc = licenseDoc();
  const validJws = await signAs(validDoc, PIN_KID, LIC);
  cases.push({
    id: "valid-stable",
    description: "A valid v3 license document (typ + envelope + grants).",
    jws: validJws,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: validDoc },
  });

  const [vh, vp, vs] = validJws.split(".") as [string, string, string];
  /** `encPayload.encSig` of the valid document — reused to swap ONLY the protected header. */
  const validHeaderless = `${vp}.${vs}`;

  // 3. Tampered payload — flip a value, keep the original signature.
  cases.push({
    id: "tampered-payload",
    description: "Payload mutated after signing — signature must fail.",
    jws: `${vh}.${encSeg(licenseDoc({ licenseId: "lic_elevated" }))}.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 4. Unknown kid — signed by a key absent from the trust set.
  cases.push({
    id: "wrong-kid",
    description: "Valid signature, but the kid is absent from the trust set.",
    jws: validJws,
    trust: { "some-other-kid": pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 5. alg downgrade — `none` is rejected before any signature math.
  cases.push({
    id: "wrong-alg-none",
    description: "Header alg=none — rejected as an algorithm downgrade.",
    jws: `${encSeg({ alg: "none", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 6. Structurally invalid input must fail cleanly, never throw.
  cases.push({
    id: "malformed-two-parts",
    description: "Structurally invalid JWS (two segments).",
    jws: "a.b",
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 7. Key selection is by `kid`, not by position, in a multi-key trust set.
  const multiTrust = {
    [ALT_KID]: pub(ALT_KID),
    [PIN_KID]: pub(PIN_KID),
  };
  const secondKeyDoc = licenseDoc({ licenseId: "lic_second_key" });
  cases.push({
    id: "valid-second-key-multi-trust",
    description:
      "A document signed by djdl-test-2026, verified against a trust set holding BOTH test keys — selection is by kid.",
    jws: await signAs(secondKeyDoc, ALT_KID, LIC),
    trust: multiTrust,
    typ: LIC,
    expect: { verify: "ok", kid: ALT_KID, doc: secondKeyDoc },
  });

  // 8. Extensibility: unknown top-level fields round-trip verbatim.
  const extensionDoc = licenseDoc({
    futureFeature: { tier: "gold", seats: 5 },
    unknownTopLevel: "preserved-extension-field",
  });
  cases.push({
    id: "valid-extension-extra-fields",
    description:
      "A document carrying unknown top-level fields still verifies and round-trips byte-for-byte.",
    jws: await signAs(extensionDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: extensionDoc },
  });

  // 9. Right kid, WRONG key bytes — presence of the kid is not enough.
  cases.push({
    id: "right-kid-wrong-key",
    description:
      "Signature from pkey-test-prod-2026 verified against a trust mapping that kid to djdl-test-2026's pubkey — must fail.",
    jws: validJws,
    trust: { [PIN_KID]: pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 10/11. Degenerate segment counts.
  cases.push({
    id: "malformed-empty-string",
    description:
      "An empty-string JWS — structurally invalid, must fail cleanly.",
    jws: "",
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "malformed-four-parts",
    description:
      "A 4-segment JWS (extra trailing part) — structurally invalid, must fail.",
    jws: `${validJws}.extra`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 12. Unicode in the signed profile — byte-exact UTF-8 across languages.
  const unicodeDoc = licenseDoc({
    licenseId: "lic_unicode",
    profile: {
      name: "Ada Lovelace 💻 — 北京 — Ångström",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "valid-unicode-profile-name",
    description:
      "A document whose profile.name contains emoji + CJK + diacritics — verifies and round-trips the exact UTF-8.",
    jws: await signAs(unicodeDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: unicodeDoc },
  });

  // 13. The ManagedEntry states, now on the CONFIG document where v3 puts them. Carried from
  //     v1's `valid-v2-management-states`; the entry encoding itself is unchanged.
  const statesDoc = configDoc({
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1699991111,
      },
      "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/xyz",
        updatedAt: 1699993333,
      },
    },
  });
  cases.push({
    id: "valid-management-states",
    description:
      "A config document with enforced + hidden + default ManagedEntry shapes (each carrying updatedAt) — the entry encoding is unchanged from v2, only the document it rides on moved.",
    jws: await signAs(statesDoc, PIN_KID, "plrs-config+jws"),
    trust: TRUST,
    typ: "plrs-config+jws",
    expect: { verify: "ok", kid: PIN_KID, doc: statesDoc },
  });

  // 14. `updatedAt` round-trip — clients change-detect on it.
  const updatedAtDoc = licenseDoc({
    licenseId: "lic_updated_at",
    entitlements: {
      polarisVpn: { state: "default", value: false, updatedAt: 1700654321 },
      "license.tier": {
        state: "enforced",
        value: "free",
        updatedAt: 1700123456,
      },
    },
  });
  cases.push({
    id: "valid-updated-at-roundtrip",
    description:
      "Per-entry updatedAt (epoch seconds) round-trips exactly through sign + verify — clients change-detect on it.",
    jws: await signAs(updatedAtDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: updatedAtDoc },
  });

  // 15/16. alg confusion — an asymmetric curve swap and the symmetric-MAC downgrade.
  cases.push({
    id: "wrong-alg-es256",
    description:
      "Header alg=ES256 against an Ed25519 trust set — rejected as algorithm confusion.",
    jws: `${encSeg({ alg: "ES256", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "wrong-alg-hs256",
    description:
      "Header alg=HS256 (symmetric) against an Ed25519 trust set — rejected, no key-confusion.",
    jws: `${encSeg({ alg: "HS256", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 17/18. No usable key: an empty trust set, and a non-empty one keyed under a foreign kid.
  cases.push({
    id: "empty-trust-set",
    description:
      "A valid token verified with an empty trust set ({}) — no key can match, must be null.",
    jws: validJws,
    trust: {},
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "foreign-kid-only",
    description:
      "Valid token whose kid is absent from a non-empty (foreign-keyed) trust set — null.",
    jws: validJws,
    trust: { "fleet-key-eu-2027": pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 19. Timestamps at 2^53-1 — no precision loss in JS doubles / Python ints / Swift Int64.
  const MAX_SAFE = 9007199254740991;
  const bigIntDoc = licenseDoc({
    licenseId: "lic_big_int_ts",
    issuedAt: MAX_SAFE - 2,
    expiresAt: MAX_SAFE - 1,
    graceUntil: MAX_SAFE,
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: MAX_SAFE - 1 },
    },
  });
  cases.push({
    id: "valid-large-integer-timestamps",
    description:
      "Timestamps at/near 2^53-1 (Number.MAX_SAFE_INTEGER) round-trip losslessly across JS/Python/Swift — no precision loss.",
    jws: await signAs(bigIntDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: bigIntDoc },
  });

  // 20/21. The signing input is the segments EXACTLY as transmitted — no canonicalisation.
  cases.push({
    id: "base64url-payload-padding",
    description:
      "Payload segment carries a `=` base64url padding char — alters the signing input, must be rejected.",
    jws: `${vh}.${vp}=.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "base64url-payload-trailing-data",
    description:
      "Trailing data appended to the payload segment — signing input differs, signature must fail.",
    jws: `${vh}.${vp}AAAA.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 22/23. UTF-8 stability: a NUL inside a string, and non-ASCII throughout keys AND values.
  const nulByteDoc = licenseDoc({
    licenseId: "lic_nul_byte",
    profile: {
      name: "before\u0000after",
      firstName: "Gr\u0000ace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "valid-nul-byte-in-string",
    description:
      "A NUL (U+0000) byte embedded in a JSON string value round-trips byte-for-byte — UTF-8 stays stable through control chars.",
    jws: await signAs(nulByteDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: nulByteDoc },
  });
  const nonAsciiDoc = licenseDoc({
    licenseId: "lic_ünïcödé",
    profile: {
      name: "Ångström 💻 — 北京 — العربية — é",
      firstName: "Åsa",
      email: "ada@exämple.com",
      activatedAt: 1690000000,
    },
    entitlements: {
      日本語: { state: "enforced", value: true, updatedAt: 1699990000 },
      "ui.gruß": { state: "enforced", value: "größe", updatedAt: 1699990000 },
    },
  });
  cases.push({
    id: "valid-non-ascii-payload",
    description:
      "Non-ASCII throughout keys AND values. Signers MUST emit raw UTF-8, never \\uXXXX escapes — this vector pins the canonical signed bytes so a re-serialising signer that escapes is caught (R2-07).",
    jws: await signAs(nonAsciiDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: nonAsciiDoc },
  });

  // 24. Oversized protected header — the payload cap is trivially bypassed without it (R2-04).
  //     §1 keeps the header cap at 1024 even for bundles: no `typ` ever widens it.
  cases.push({
    id: "header-oversized",
    description:
      "Protected header past MAX_HEADER_BYTES (1024). Must be rejected on the ENCODED length, before any decode/parse.",
    jws: `${encSeg({ alg: "EdDSA", typ: LIC, kid: PIN_KID, junk: "J".repeat(2048) })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 25/26. The ORDINARY payload cap from both sides: 65 536 decoded / 87 386 encoded.
  const atCapDoc = docOfExactBytes(65536, licenseDoc({ licenseId: "lic_cap" }));
  cases.push({
    id: "payload-at-cap",
    description:
      "A payload of EXACTLY MAX_DOC_BYTES (65536) decoded bytes — at the cap is still valid and must verify.",
    jws: await signAs(atCapDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: atCapDoc },
  });
  cases.push({
    id: "payload-over-cap",
    description:
      "An encoded payload one character past MAX_PAYLOAD_B64 (87386) — rejected on length before it is ever decoded, so the allocation never happens.",
    jws: `${encSeg({ alg: "EdDSA", typ: LIC, kid: PIN_KID })}.${"A".repeat(87387)}.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 27/28. Duplicate JSON members — TS/Python resolve last-wins, Swift first-wins, so any
  //        silent resolution is a differential. Both are correctly SIGNED so the only
  //        possible cause of failure is the duplicate-key rule.
  cases.push({
    id: "duplicate-key-header-alg",
    description:
      "Protected header declaring `alg` twice (none, then EdDSA). Last-wins reads EdDSA, first-wins reads none — every implementation MUST instead reject.",
    jws: await signRawSegments(
      `{"alg":"none","typ":"${LIC}","kid":"${PIN_KID}","alg":"EdDSA"}`,
      JSON.stringify(validDoc),
      PIN_KID,
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "duplicate-key-payload",
    description:
      "Payload declaring `licenseId` twice. Checked only after the signature verifies, so this pins the post-verification parse — reject, never last/first-wins.",
    jws: await signRawSegments(
      `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}"}`,
      `{"iss":"${ISSUER_V3}","aud":"${AUD_V3}","deviceId":"${DEVICE_V3}","licenseId":"lic_a","issuedAt":${V3_ISSUED},"licenseId":"lic_b"}`,
      PIN_KID,
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 29–31. Out-of-alphabet bytes in the SIGNATURE segment. Python's lenient base64 silently
  //        DISCARDED these, so they verified there and were rejected by Node and Swift.
  for (const [suffix, id, label] of [
    ["***", "sig-out-of-alphabet-stars", "`***`"],
    ["\n \t", "sig-out-of-alphabet-whitespace", "whitespace (`\\n \\t`)"],
    ["====", "sig-out-of-alphabet-padding", "explicit base64 padding (`====`)"],
  ] as const) {
    cases.push({
      id,
      description: `Signature segment carrying ${label}. Strict base64url means the \`-_\` alphabet only — no whitespace, no \`=\`, no out-of-alphabet bytes; reject rather than discard.`,
      jws: `${vh}.${vp}.${vs}${suffix}`,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }

  // 32. THE v3 CHANGE. v1's `typ-missing` accepted a typ-less header during the rollout
  //     window; §2 closes that window ("unknown or missing `typ` is rejected"). The claims
  //     are otherwise valid and the signature is genuine, so the ONLY reason this fails is
  //     the absent type — which is what makes it a regression pin rather than a truism.
  cases.push({
    id: "typ-missing-rejected",
    description:
      "A correctly-signed document with valid claims and NO `typ` in the header. Accepted by v2's tolerance window (corpus v1's `typ-missing`); REJECTED by v3 (§2), where every verifier requires a type. This is the tolerance window's closure, pinned.",
    jws: await signJws(validDoc, pem(PIN_KID), PIN_KID),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 33/34. Domain separation: the WRONG type, and a genuine artifact of another type.
  cases.push({
    id: "typ-wrong",
    description:
      "Header asserts `typ: plrs-config+jws` at a call site expecting `plrs-license+jws` — the two v3 documents share a signing key, so only the type separates them (§2).",
    jws: await signAs(validDoc, PIN_KID, "plrs-config+jws"),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "trust-manifest-as-license",
    description:
      "A genuine, correctly-signed TRUST MANIFEST presented where a license document is expected — cross-protocol replay, rejected by the `typ` domain separator rather than incidentally (§2).",
    jws: await signAs(
      trustManifestV3({ keys: [keyEntry(PIN_KID, pub(PIN_KID), "active")] }),
      PIN_KID,
      "plrs-trust+jws",
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 35/36. §1's ONE exception: `plrs-bundle+jws` is capped at 262 144, not 65 536, and the
  //        caller passes that cap explicitly for that typ alone. Both sides of the boundary,
  //        both CORRECTLY SIGNED — the over-cap vector's encoded length (349 527) is inside
  //        the derived encoded pre-check (349 530), so it can only be refused by the DECODED
  //        cap, which runs after the signature. A verifier that forgot the decoded check
  //        would pass the pre-check and accept it.
  const bundleCapBase = {
    bundleId: "01JBUNDLECAP00000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_GRACE,
    docs: {},
    trust: "",
  };
  cases.push({
    id: "bundle-payload-at-cap",
    description:
      "A `plrs-bundle+jws` payload of EXACTLY 262 144 decoded bytes, verified with maxPayloadBytes = 262 144 — at the cap is valid (§1). `doc` is omitted: the payload is a quarter-megabyte of padding and the boundary is the whole point.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES, bundleCapBase),
      PIN_KID,
      "plrs-bundle+jws",
    ),
    trust: TRUST,
    typ: "plrs-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "ok", kid: PIN_KID },
  });
  cases.push({
    id: "bundle-payload-over-cap",
    description:
      "The same bundle one decoded byte past the cap (262 145) with the same raised cap — rejected. The raised cap is a CAP, not a licence to be unbounded.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES + 1, bundleCapBase),
      PIN_KID,
      "plrs-bundle+jws",
    ),
    trust: TRUST,
    typ: "plrs-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "fail" },
  });

  return cases;
}

// ── §3 per-document claim vectors ────────────────────────────────────────────
// v1 had ONE `docCases` array because v2 had one document. v3 has two, and they carry
// independent anti-replay floors, so the same claim families are pinned twice — once per
// document type — and a verifier that implements the envelope only once still passes both.

interface DocCaseV2 {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  /** The `typ` the runner must demand: which of the two verifiers this case drives. */
  typ: TypV3;
  expectedAud: string;
  expectedIss: string;
  deviceId: string;
  now: number;
  /** Per-TYPE anti-replay floor (§3): license and config never share one. */
  lastAcceptedIssuedAt?: number;
  /** False = the cache-reload path (and bundle import), where the outer bound is
   *  `graceUntil`, not `expiresAt`. */
  checkFreshness?: boolean;
  expect: { accept: boolean };
}

const SKEW = 300;

/** The claim families every per-service document shares (§3). Instantiated once for the
 *  license document and once for the config document, so the two can never drift apart. */
async function envelopeCases(
  prefix: string,
  typ: TypV3,
  doc: (over?: Record<string, unknown>) => Record<string, unknown>,
): Promise<DocCaseV2[]> {
  const sign = (over: Record<string, unknown> = {}): Promise<string> =>
    signAs(doc(over), PIN_KID, typ);
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  return [
    {
      ...common,
      id: `${prefix}-valid-control`,
      description:
        "The control: a well-formed, correctly-bound, in-window document is accepted.",
      jws: await sign(),
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-expired`,
      description:
        "Evaluated past `expiresAt + CLOCK_SKEW`. An expired document is refused AT VERIFY on the network path — never accepted and then merely reported `grace` by the gate while its contents are handed out (§3).",
      jws: await sign(),
      now: V3_EXPIRES + SKEW + 1,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-expired-within-skew`,
      description:
        "The same document one second INSIDE the skew window is still accepted — CLOCK_SKEW_SECONDS is 300 in every implementation.",
      jws: await sign(),
      now: V3_EXPIRES + SKEW - 1,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-expired-reload-path`,
      description:
        "The expired document again on the CACHE-RELOAD path (`checkFreshness: false`, also the bundle-import profile, §7.4). A cached document is EXPECTED to be past its one-hour `expiresAt` — that is what offline operation is — so its signed outer bound there is `graceUntil`, enforced by the gate against the clock floor (§3, §4.2).",
      jws: await sign(),
      now: V3_EXPIRES + SKEW + 1,
      checkFreshness: false,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-iss-mismatch`,
      description:
        "A foreign `iss`. Documented as 'always ISSUER' since v1 but never enforced on documents until v3 (§3).",
      jws: await sign({ iss: "https://evil.example" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-iss-v2-host-rejected`,
      description:
        '`iss: "key.plrs.im"` — the v2 issuer, and still the serving HOST. v3 is host-neutral (`plrs.im`, D-09/§8), so a v2-era document is refused outright: hosts are not wire identity, and pre-launch there is no dual-accept window (§9).',
      jws: await sign({ iss: "key.plrs.im" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issued-far-future`,
      description:
        "`issuedAt` ten years ahead. Without an `iat` sanity check a far-future document gates `ok` AND pins the anti-replay floor out of reach for every later document (§3).",
      jws: await sign({
        issuedAt: 2000000000,
        expiresAt: 2000003600,
        graceUntil: 2002592000,
      }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issued-future-within-skew`,
      description:
        "`issuedAt` exactly CLOCK_SKEW seconds ahead of the verifier's clock is tolerated: a client running slightly behind must not reject a freshly-signed document.",
      jws: await sign(),
      now: V3_ISSUED - SKEW,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-grace-before-expiry`,
      description:
        "`graceUntil` earlier than `expiresAt` is incoherent — the offline window cannot close before the document does (§3).",
      jws: await sign({ graceUntil: V3_EXPIRES - 1 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-grace-at-365d-cap`,
      description:
        "`graceUntil` at EXACTLY `issuedAt + MAX_GRACE_SECONDS` (365 d). The ceiling is inclusive, and it is applied at verify time rather than only in the gate (§3.3) — an operator-minted bundle may legitimately sit right on it (D-22).",
      jws: await sign({ graceUntil: V3_ISSUED + MAX_GRACE_SECONDS }),
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-grace-over-365d-cap`,
      description:
        "One second past the same ceiling. Bounds a hostile control plane and a tampered cache alike, at the byte the boundary actually falls on.",
      jws: await sign({ graceUntil: V3_ISSUED + MAX_GRACE_SECONDS + 1 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-grace-unbounded`,
      description:
        "`graceUntil` a century past `issuedAt` — the shape v1 accepted without complaint.",
      jws: await sign({ graceUntil: V3_ISSUED + 100 * 365 * 86400 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-replayed-below-floor`,
      description:
        "`issuedAt` EQUAL to this type's anti-replay floor. Equal is not strictly newer, so a re-presented document is refused (§3).",
      jws: await sign(),
      lastAcceptedIssuedAt: V3_ISSUED,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-replay-strictly-newer-accepted`,
      description:
        "The same floor one second lower: strictly newer IS accepted. Without this pair a verifier that rejects everything would pass the anti-replay case.",
      jws: await sign(),
      lastAcceptedIssuedAt: V3_ISSUED - 1,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-aud-mismatch`,
      description:
        "A document scoped to another product — enforced on the network path AND the reload path (§3).",
      jws: await sign({ aud: "other-product" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-device-mismatch`,
      description:
        "A document bound to another device — a document lifted from a colleague's machine (§3).",
      jws: await sign({ deviceId: "dev_someone_else" }),
      expect: { accept: false },
    },
  ];
}

async function buildLicenseDocCases(): Promise<DocCaseV2[]> {
  return envelopeCases("license", "plrs-license+jws", licenseDoc);
}

async function buildConfigDocCases(): Promise<DocCaseV2[]> {
  const shared = await envelopeCases("config", "plrs-config+jws", configDoc);
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ: "plrs-config+jws" as TypV3,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  return [
    ...shared,
    {
      ...common,
      id: "config-doc-no-license-fields",
      description:
        "D-08, on the wire: a config document carrying NO licenseId, NO entitlements and NO profile is ACCEPTED. A product with `config` enabled and `license` disabled issues exactly this to any registered device, and a verifier that reaches for a license field while validating it makes service independence unimplementable (§2.2).",
      jws: await signAs(
        {
          iss: ISSUER_V3,
          aud: AUD_V3,
          deviceId: DEVICE_V3,
          issuedAt: V3_ISSUED,
          expiresAt: V3_EXPIRES,
          graceUntil: V3_GRACE,
          schemaVersion: 4,
          config: {
            "run.concurrency": {
              state: "enforced",
              value: 4,
              updatedAt: 1699990000,
            },
          },
          secrets: {},
        },
        PIN_KID,
        "plrs-config+jws",
      ),
      expect: { accept: true },
    },
    {
      ...common,
      id: "config-schema-version-invalid",
      description:
        '`schemaVersion` as a STRING. The field carries the product\'s catalog version, so its value cannot be allow-listed — but its shape can, and `schemaVersion: "4"` is the shape R2-08 slipped through (§2.2).',
      jws: await signAs(
        configDoc({ schemaVersion: "4" }),
        PIN_KID,
        "plrs-config+jws",
      ),
      expect: { accept: false },
    },
  ];
}

// ── §1 trust-set vectors ─────────────────────────────────────────────────────
// v1's eleven, carried verbatim in meaning: only `iss` (§8) and `typ` (§2) moved. The merge,
// prune, revocation, substitution and freshness-profile rules are unchanged in v3.

interface TrustCaseV2 {
  id: string;
  description: string;
  pinned: Record<string, string>;
  before: Record<string, string>;
  manifestJws: string;
  now: number;
  checkFreshness?: boolean;
  expect: {
    accepted: boolean;
    trust: Record<string, string>;
    issuedAt?: number;
  };
}

async function buildTrustCasesV2(): Promise<TrustCaseV2[]> {
  const pinned = PINNED_V3;
  const now = V3_ISSUED + 100;
  const manifest = (
    keys: Record<string, unknown>[],
    signWith = PIN_KID,
  ): Promise<string> =>
    signAs(trustManifestV3({ keys }), signWith, "plrs-trust+jws");

  return [
    {
      id: "trust-learn-rotated-key",
      description:
        "The control: a manifest signed by the pinned key publishes a second key, which joins the trust set alongside the pin.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "key-status-revoked",
      description:
        'A key published with `status:"revoked"` — the positive revocation signal the server emits for 2× cacheSeconds — MUST NOT enter the trust set (§1).',
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "revoked"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "key-status-retired-and-staged-are-trusted",
      description:
        "`retired` and `staged` DO verify, deliberately: in-flight documents signed before a rotation must still validate, and a key must be trusted before it signs or rotation can never land (§1).",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "retired"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-prune-on-absence",
      description:
        "A key present in `before` but ABSENT from the new manifest is DROPPED: the discovered set is REPLACED wholesale, never merged, so revocation by omission works on a provisioned client (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-pinned-substitution",
      description:
        "A correctly-signed manifest presenting a PINNED kid with DIFFERENT key bytes. A substitution attempt, not an update: the WHOLE manifest is rejected and the previous trust set kept — not merged with the substitution quietly dropped (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, FOREIGN_PUB, "active")]),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-pinned-kid-same-bytes",
      description:
        "Re-publishing a pinned kid with the SAME bytes is an ordinary manifest, not a substitution — it must be accepted.",
      pinned,
      before: {},
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-prune-to-pins-only",
      description:
        "A manifest that revokes everything leaves exactly the pins. Pinned keys are NEVER pruned — pinning is the host application's escape hatch for a total control-plane compromise (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(ALT_KID, pub(ALT_KID), "revoked")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-expired-manifest",
      description:
        "A manifest evaluated past `expiresAt + CLOCK_SKEW` is refused on the network path, and the previous trust set is kept.",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now: V3_ISSUED + 300 + SKEW + 1,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-expired-manifest-reload-path",
      description:
        "The SAME long-expired manifest on the CACHE-RELOAD path (and the bundle-import path, §7.3). A manifest's `expiresAt` is `issuedAt + cacheSeconds` — minutes — so re-checking freshness on load would drop every rotated key on every restart and strand the client offline. Its `issuedAt` still raises the §4.2 clock floor.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now: V3_ISSUED + 300 + SKEW + 1,
      checkFreshness: false,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-aud-mismatch",
      description:
        "A manifest scoped to another product is refused — the same cross-tenant binding documents get.",
      pinned,
      before: {},
      manifestJws: await signAs(
        trustManifestV3({
          aud: "other-product",
          keys: [keyEntry(ALT_KID, pub(ALT_KID), "active")],
        }),
        PIN_KID,
        "plrs-trust+jws",
      ),
      now,
      expect: { accepted: false, trust: { [PIN_KID]: pub(PIN_KID) } },
    },
    {
      id: "trust-signed-by-non-pinned-key",
      description:
        "A manifest signed by a DISCOVERED key rather than a pinned one. Manifests verify against the PINNED set only — on the network path AND the reload path — so a rotated (or planted) key can never sign the manifest that mints the next key (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest(
        [keyEntry("minted-by-rotated-key", FOREIGN_PUB, "active")],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
  ];
}

// ── §4.2 monotonic clock floor, over THREE artifact kinds ────────────────────
//
//     highWaterMark = max(licenseDoc.issuedAt, configDoc.issuedAt, trustManifest.issuedAt)
//     effectiveNow  = max(systemClock, highWaterMark)
//
// v2's floor rode the config fetch and was derived from the document alone, which is
// provably inert: `doc.issuedAt < doc.graceUntil` by construction, so it can never reach the
// end of grace. v3 folds all three artifacts and makes trust refresh Core-owned, on its own
// schedule, so the floor advances even while both documents sit behind stable ETags.
//
// Each case is the cache-RELOAD path replayed as pure data. Runners perform exactly:
//
//   1. trust := pinned
//   2. verify trustJws against PINS with checkFreshness=false
//        accepted ⇒ trust := mergeTrust(pinned, discovered); floor := max(floor, issuedAt)
//   3. verify licenseJws / configJws against `trust` with checkFreshness=false
//        accepted ⇒ floor := max(floor, issuedAt)
//   4. effectiveNow := max(systemClock, floor)
//   5. status := licenseState({licenseServiceEnabled: true, activation: "token",
//                              doc: licenseDoc, now: systemClock, highWaterMark: floor})

interface ClockFloorCaseV2 {
  id: string;
  description: string;
  pinned: Record<string, string>;
  trustJws?: string;
  licenseJws?: string;
  configJws?: string;
  expectedAud: string;
  deviceId: string;
  /** What the device's own clock claims — the value an attacker controls. */
  systemClock: number;
  expect: { highWaterMark: number; effectiveNow: number; status: string };
}

async function buildClockFloorCasesV2(): Promise<ClockFloorCaseV2[]> {
  const DAY = 86400;
  /** A manifest refreshed 399 days later — "I verified a manifest yesterday". */
  const MANIFEST_LATER = V3_ISSUED + 399 * DAY;
  /** A manifest older than the documents, so it cannot be what raises the floor. */
  const MANIFEST_EARLIER = V3_ISSUED - 3600;
  /** A manifest refreshed a week in — between the two documents, so it is the MIDDLE value
   *  of the three and cannot be mistaken for the max. */
  const MANIFEST_MIDDLE = V3_ISSUED + 7 * DAY;
  /** A config document that kept refreshing for 399 days while the license document did
   *  not. The two services fetch independently in v3 (separate ETags, separate cadence),
   *  so this is the ordinary shape of a config-enabled product, not a contrivance. */
  const CONFIG_LATEST = V3_ISSUED + 399 * DAY;
  /** `sudo date`: wound back inside the license document's one-hour window. */
  const ROLLED_BACK = V3_ISSUED + 60;
  /** An honest clock, long past the whole signed grace window. */
  const HONEST_LATE = V3_ISSUED + 400 * DAY;

  const manifest = (
    issuedAt: number,
    keys: Record<string, unknown>[],
    signWith = PIN_KID,
  ): Promise<string> =>
    signAs(trustManifestV3({ issuedAt, keys }), signWith, "plrs-trust+jws");
  const license = (signWith = PIN_KID): Promise<string> =>
    signAs(licenseDoc(), signWith, "plrs-license+jws");
  const config = (issuedAt = V3_ISSUED): Promise<string> =>
    signAs(
      configDoc({
        issuedAt,
        expiresAt: issuedAt + 3600,
        graceUntil: issuedAt + 30 * DAY,
      }),
      PIN_KID,
      "plrs-config+jws",
    );
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
  };

  return [
    {
      ...common,
      id: "floor-config-doc-alone-does-not-stop-rollback",
      description:
        "The residual R4-04 defect, carried from corpus v1 and pinned so it cannot return: with DOCUMENTS as the only floor source the mark equals their `issuedAt`, which is below `graceUntil` by construction, and a clock wound back inside the license window still reads `ok`. v3 gives the client a second document and it changes nothing — both are stamped by the same fetch. Only the independently-refreshed trust manifest makes the floor bite (§4.2).",
      licenseJws: await license(),
      configJws: await config(),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-trust-manifest-defeats-rollback",
      description:
        "The fix. The same wound-back clock and the same document, plus a trust manifest the client verified 399 days later: `highWaterMark` is now past `graceUntil`, so the gate reads `expired` — a client that verified a manifest yesterday cannot claim it is last year (§4.2).",
      licenseJws: await license(),
      trustJws: await manifest(MANIFEST_LATER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-stale-cached-manifest-still-yields-its-keys",
      description:
        "Raising the floor from a cached manifest must NOT re-introduce freshness checking on that path. This manifest expired long ago and publishes the rotated key the cached license document is signed with: it must still load, or every restart after a key rotation strands the client. Its `issuedAt` predates the document's, so the document sets the mark.",
      licenseJws: await license(ALT_KID),
      trustJws: await manifest(MANIFEST_EARLIER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-honest-clock-is-never-lowered",
      description:
        "The floor is a MINIMUM, never a substitute. With an honest clock long past the whole signed grace window `effectiveNow` is the system clock and the gate reads `expired` — the floor costs nothing when the clock is truthful.",
      licenseJws: await license(),
      trustJws: await manifest(MANIFEST_EARLIER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: HONEST_LATE,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: HONEST_LATE,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-rejected-manifest-does-not-raise-it",
      description:
        "Only RE-VERIFIED content moves the mark. This manifest carries a far later `issuedAt` but is signed by a discovered key rather than a pinned one, so it is refused outright — and a refused artifact must contribute nothing, or planting a file would become a way to force every client to `expired`.",
      licenseJws: await license(),
      trustJws: await manifest(
        MANIFEST_LATER,
        [keyEntry(ALT_KID, pub(ALT_KID), "active")],
        ALT_KID,
      ),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-manifest-without-a-document",
      description:
        "A manifest alone still anchors time. There is no license document, so the gate is `needs-activation` either way — but the mark it establishes survives, which is what stops a wound-back clock from later re-admitting a document that has already aged out.",
      trustJws: await manifest(MANIFEST_LATER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "needs-activation",
      },
    },
    {
      ...common,
      id: "floor-max-over-three-artifacts",
      description:
        "NEW in v3: three artifacts with three DIFFERENT `issuedAt` values — license (day 0), trust manifest (day 7), CONFIG document (day 399) — and the mark is the MAX over all of them. Here the max is the config document, which no other case makes load-bearing: an implementation that folds documents-plus-manifest but forgets that v3 has TWO documents reads day 7, lands inside the license document's 30-day grace, and reports `grace` instead of `expired`. The config service is the one still refreshing while the license document sits behind a 403 or a stable ETag, so it is exactly the source most likely to be dropped (§4.2).",
      licenseJws: await license(),
      configJws: await config(CONFIG_LATEST),
      trustJws: await manifest(MANIFEST_MIDDLE, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: CONFIG_LATEST,
        effectiveNow: CONFIG_LATEST,
        status: "expired",
      },
    },
  ];
}

// ── §7 offline activation bundles ────────────────────────────────────────────
// Every case is a complete, signed `plrs-bundle+jws` plus the outcome of running §7's
// NUMBERED validation order against it. The order is the contract, so the expected `reason`
// names the step that must reject — a verifier that checks inner documents before the bundle's
// own device binding fails `bundle-deviceId-mismatches-local` on the reason even though it
// also refuses the bundle.
//
// Import is ALL-OR-NOTHING: `bundle-tampered-inner-license-signature` carries a perfectly
// good config document, and it must not land either.

/** The step that refused, mapping 1:1 onto §7's numbered list. */
type BundleReason =
  | "bundle-jws-rejected" // 1 — signature, pins-only trust, `typ`, or the 262 144 cap
  | "bundle-claims-rejected" // 2 — aud, deviceId, or the import window
  | "bundle-trust-rejected" // 3 — the inner trust manifest
  | "inner-doc-rejected"; // 4 — any inner document

interface BundleCase {
  id: string;
  description: string;
  bundleJws: string;
  /** Bundles verify against PINNED keys only (§7.1) — never the effective set. */
  pinned: Record<string, string>;
  expectedAud: string;
  /** The importing device's LOCAL id. */
  deviceId: string;
  now: number;
  /** §1 — the raised cap the bundle verifier must pass at step 1. */
  maxPayloadBytes: number;
  expect:
    | { imports: false; reason: BundleReason }
    | { imports: true; docs: string[] };
}

async function buildBundleCases(): Promise<BundleCase[]> {
  const DAY = 86400;
  /** The bundle's own import window: minted at day 0, importable for 30 days (§7). */
  const BUNDLE_EXPIRES = V3_ISSUED + 30 * DAY;
  const NOW = V3_NOW;

  const innerTrust = await signAs(
    trustManifestV3({
      keys: [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ],
    }),
    PIN_KID,
    "plrs-trust+jws",
  );
  const innerLicense = await signAs(licenseDoc(), PIN_KID, "plrs-license+jws");
  // Signed by the ROTATED key, which only the inner manifest publishes: step 4 must verify
  // inner documents against the effective set built in step 3, not against the pins.
  const innerConfig = await signAs(configDoc(), ALT_KID, "plrs-config+jws");

  const bundle = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    bundleId: "01JBUNDLE0000000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: BUNDLE_EXPIRES,
    docs: { license: innerLicense, config: innerConfig },
    trust: innerTrust,
    ...over,
  });
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
    now: NOW,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  };
  const sign = (payload: unknown): Promise<string> =>
    signAs(payload, PIN_KID, "plrs-bundle+jws");

  // A tampered inner document: the original header and signature over a mutated payload.
  const [ih, , is] = innerLicense.split(".") as [string, string, string];
  const tamperedInnerLicense = `${ih}.${encSeg(licenseDoc({ entitlements: { "license.tier": { state: "enforced", value: "enterprise", updatedAt: 1699990000 } } }))}.${is}`;

  return [
    {
      ...common,
      id: "bundle-valid-full",
      description:
        "The control: a bundle carrying a license document, a config document and the trust manifest. All three verify and BOTH documents import. The config document is signed by the rotated key that only the inner manifest publishes, so this also proves step 4 runs against the set built in step 3.",
      bundleJws: await sign(bundle()),
      expect: { imports: true, docs: ["license", "config"] },
    },
    {
      ...common,
      id: "bundle-valid-license-only",
      description:
        "`docs.config` is optional (§7): a license-only bundle imports exactly one document. A verifier that requires both fails here.",
      bundleJws: await sign(bundle({ docs: { license: innerLicense } })),
      expect: { imports: true, docs: ["license"] },
    },
    {
      ...common,
      id: "bundle-tampered-inner-license-signature",
      description:
        "The inner license document's payload was mutated after signing (an upgraded tier), keeping the original signature. Step 4 refuses it — and because import is ALL-OR-NOTHING, the untouched config document in the same bundle must not land either.",
      bundleJws: await sign(
        bundle({
          docs: { license: tamperedInnerLicense, config: innerConfig },
        }),
      ),
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-inner-deviceId-mismatches-bundle",
      description:
        "The bundle is addressed to this device, but the license document inside it is bound to another. Inner documents are verified against the LOCAL device id, not against the bundle's own claim, so a mint-side mix-up cannot smuggle a foreign license onto this machine (§3, §7.4).",
      bundleJws: await sign(
        bundle({
          docs: {
            license: await signAs(
              licenseDoc({ deviceId: "dev_someone_else" }),
              PIN_KID,
              "plrs-license+jws",
            ),
          },
        }),
      ),
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-deviceId-mismatches-local",
      description:
        "A bundle minted for a DIFFERENT device, presented here — the request-code flow's whole point is that a bundle is device-bound. Rejected at step 2, before the trust manifest or any inner document is even looked at.",
      bundleJws: await sign(bundle({ deviceId: "dev_not_this_machine" })),
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-expired",
      description:
        "The import window closed: `now > expiresAt + CLOCK_SKEW`. The BUNDLE itself is checked with NETWORK-path freshness (§7.2) even though its inner documents use the reload profile — a stale bundle is refused, while the long-lived documents it carries are not.",
      bundleJws: await sign(bundle()),
      now: BUNDLE_EXPIRES + SKEW + 1,
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-inner-trust-pinned-substitution",
      description:
        "The inner trust manifest presents the PINNED kid with foreign key bytes. §7.3 verifies it against the pins with the same substitution rule as the network path, so the bundle imports nothing — an air-gapped device must not be the one place where a planted key set is accepted.",
      bundleJws: await sign(
        bundle({
          trust: await signAs(
            trustManifestV3({
              keys: [keyEntry(PIN_KID, FOREIGN_PUB, "active")],
            }),
            PIN_KID,
            "plrs-trust+jws",
          ),
        }),
      ),
      expect: { imports: false, reason: "bundle-trust-rejected" },
    },
    {
      ...common,
      id: "bundle-typ-missing",
      description:
        "A correctly-signed bundle with no `typ` in its header. §7.1 demands `plrs-bundle+jws`; without the type check the same bytes could be replayed at a document call site with the raised 262 144 cap in force.",
      bundleJws: await signJws(bundle(), pem(PIN_KID), PIN_KID),
      expect: { imports: false, reason: "bundle-jws-rejected" },
    },
    {
      ...common,
      id: "bundle-over-cap",
      description:
        "A correctly-signed bundle padded one decoded byte past the 262 144 cap (§1). Refused at step 1 on size, after the signature and before anything is imported — the bundle cap is generous, not absent.",
      bundleJws: await sign(docOfExactBytes(MAX_BUNDLE_BYTES + 1, bundle())),
      expect: { imports: false, reason: "bundle-jws-rejected" },
    },
  ];
}

async function buildV2(): Promise<unknown> {
  return {
    corpusVersion: 2,
    keys: KEYS,
    jwsCases: await buildJwsCases(),
    licenseDocCases: await buildLicenseDocCases(),
    configDocCases: await buildConfigDocCases(),
    trustCases: await buildTrustCasesV2(),
    clockFloorCases: await buildClockFloorCasesV2(),
    bundleCases: await buildBundleCases(),
  };
}

// ── gate-matrix v2 (§5) ──────────────────────────────────────────────────────
// v1's matrix is hand-authored and frozen; v2 is GENERATED from it so "every v1 row is
// carried" is mechanically true rather than a claim in a commit message. The shim is the
// smallest possible one: every v1 product licensed (`licenseServiceEnabled: true`) and
// `hasToken` → `activation`. Then the rows v1 could not express are appended.

interface MatrixRowV1 {
  name: string;
  gate: Record<string, unknown>;
  license: Record<string, unknown> & { hasToken?: boolean };
  expect: Record<string, unknown>;
}

/** The standard in-window build gate, for rows whose subject is the license half. */
const PASSING_GATE = {
  version: "2.0.0",
  compatMin: "1.0.0",
  compatMax: "3.0.0",
  entitlements: {},
};
/** A build gate that BLOCKS: 4.0.0 is above the compat max. */
const BLOCKING_GATE = {
  version: "4.0.0",
  compatMin: "1.0.0",
  compatMax: "3.0.0",
  entitlements: {},
};
/** The v1 matrix's document window, reused so the new rows sit on the same timeline. */
const MATRIX_DOC = { issuedAt: 1000, expiresAt: 4600, graceUntil: 2593000 };

function buildGateMatrixV2(): unknown {
  let v1: { rows: MatrixRowV1[] };
  try {
    v1 = JSON.parse(readFileSync(GATE_MATRIX, "utf8")) as {
      rows: MatrixRowV1[];
    };
  } catch {
    // Deliberately fatal rather than silently emitting a shorter matrix. When corpus v1 is
    // deleted (P8), inline the sixteen carried rows here instead of dropping them.
    throw new Error(
      `gate-matrix v2 is derived from ${GATE_MATRIX}, which could not be read. ` +
        `If corpus v1 has been deleted, inline its rows into buildGateMatrixV2().`,
    );
  }

  const carried = v1.rows.map((row) => {
    const { hasToken, ...rest } = row.license;
    return {
      name: row.name,
      gate: row.gate,
      license: {
        licenseServiceEnabled: true,
        // v2's boolean becomes v3's tri-state; `token` is what every v1 row meant.
        activation: hasToken ? "token" : null,
        ...rest,
      },
      expect: row.expect,
    };
  });

  return {
    gateMatrixVersion: 2,
    description:
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. Rows 1-16 are corpus v1\'s matrix carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — so a v3 gate that changes any v2 decision goes red here. The remaining rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on that last row is deliberately NOT the status. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape.',
    rows: [
      ...carried,
      {
        name: "not-applicable — license service disabled, nothing cached",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: false,
          activation: null,
          now: 1500,
        },
        expect: { status: "not-applicable", ok: true },
      },
      {
        name: "not-applicable — license service disabled even with a valid document cached",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: false,
          activation: "token",
          ...MATRIX_DOC,
          now: 1500,
          lastVerifiedAt: 1490,
        },
        expect: { status: "not-applicable", ok: true },
      },
      {
        name: "ok — bundle activation inside the document window",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 1500,
        },
        expect: { status: "ok", ok: true },
      },
      {
        name: "grace — bundle activation past expiresAt, inside graceUntil",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 5000,
        },
        expect: { status: "grace", ok: true },
      },
      {
        name: "expired — bundle activation past graceUntil (the air-gapped install runs out)",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "bundle",
          ...MATRIX_DOC,
          now: 2593001,
        },
        expect: { status: "expired", ok: false },
      },
      {
        name: "needs-activation — unactivated device with a build block (activation precedes blocked)",
        gate: BLOCKING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: null,
          now: 1500,
        },
        // The build gate DOES derive `version-too-new` here; the decision is still
        // `needs-activation`, and no allowedRange is surfaced. Corpus v1 has no row where
        // the hint and the status disagree, which is why v3's ordering needed a new one.
        expect: {
          status: "needs-activation",
          ok: false,
          reason: "version-too-new",
        },
      },
    ],
  };
}

// ── Fingerprint + device-id vectors ──────────────────────────────────────────
// Until now the device-id derivation was the ONE cross-language behaviour with no golden
// vector: three hand-written implementations (Node, Python, Swift) agreed only by code
// review. Hardware fingerprinting multiplies that surface, so both formulas are pinned here.
//
// The digests below are computed from first principles with node:crypto rather than by
// importing the Worker's helper. A golden corpus that shares code with the implementation it
// checks cannot catch a bug in that shared code.

const FINGERPRINT_COMPONENT_ORDER = [
  "machineUuid",
  "boardSerial",
  "cpuModel",
  "primaryMac",
  "bootVolumeUuid",
  "ramBucket",
  "machineModel",
] as const;

type FingerprintComponentName = (typeof FINGERPRINT_COMPONENT_ORDER)[number];

function sha256B64url(input: string, length: number): string {
  return createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, length);
}

function componentHash(
  product: string,
  component: FingerprintComponentName,
  raw: string,
): string {
  return sha256B64url(`pkey-hw:${product}:${component}:${raw}`, 22);
}

function hwidOf(
  components: Partial<Record<FingerprintComponentName, string>>,
): string {
  const parts: string[] = [];
  for (const component of FINGERPRINT_COMPONENT_ORDER) {
    const value = components[component];
    if (value !== undefined) parts.push(`${component}=${value}`);
  }
  return sha256B64url(parts.join("\n"), 32);
}

interface FingerprintVector {
  id: string;
  description: string;
  product: string;
  raw: Partial<Record<FingerprintComponentName, string>>;
  components: Partial<Record<FingerprintComponentName, string>>;
  hwid: string;
}

function fingerprintVector(
  id: string,
  description: string,
  product: string,
  raw: Partial<Record<FingerprintComponentName, string>>,
): FingerprintVector {
  const components: Partial<Record<FingerprintComponentName, string>> = {};
  // Iterate the CANONICAL order, not the raw map's insertion order — that is exactly the
  // property the `reversed-input-order` vector below exists to pin.
  for (const component of FINGERPRINT_COMPONENT_ORDER) {
    const value = raw[component];
    if (value !== undefined)
      components[component] = componentHash(product, component, value);
  }
  return {
    id,
    description,
    product,
    raw,
    components,
    hwid: hwidOf(components),
  };
}

const MAC_RAW: Record<FingerprintComponentName, string> = {
  machineUuid: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
  boardSerial: "C02XK1ABCDEF",
  cpuModel: "Apple M3 Pro:12",
  primaryMac: "a4:83:e7:1b:2c:3d",
  bootVolumeUuid: "8F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
  ramBucket: "32",
  machineModel: "MacBookPro18,3",
};

function buildFingerprintCorpus(): unknown {
  const vectors: FingerprintVector[] = [
    fingerprintVector(
      "macos-full",
      "All seven components present on macOS.",
      "djdl",
      MAC_RAW,
    ),
    fingerprintVector(
      "windows-full",
      "All seven components present on Windows; same shape, different values.",
      "djdl",
      {
        machineUuid: "9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0",
        boardSerial: "/8YHTG2/CN1234567890/",
        cpuModel: "AMD Ryzen 9 7950X:16",
        primaryMac: "00:1a:2b:3c:4d:5e",
        bootVolumeUuid: "3C4D5E6F",
        ramBucket: "64",
        machineModel: "XPS 15 9530",
      },
    ),
    fingerprintVector(
      "linux-partial",
      "Fail-soft: a host that could only read three components still produces a fingerprint.",
      "djdl",
      {
        machineUuid: "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
        cpuModel: "Intel(R) Core(TM) i7-12700H:20",
        ramBucket: "16",
      },
    ),
    fingerprintVector(
      "reversed-input-order",
      "Identical components declared in reverse order must yield the macos-full hwid.",
      "djdl",
      Object.fromEntries(
        [...FINGERPRINT_COMPONENT_ORDER].reverse().map((c) => [c, MAC_RAW[c]]),
      ) as Record<FingerprintComponentName, string>,
    ),
    fingerprintVector(
      "unicode-model",
      "Non-ASCII raw values must hash over UTF-8 bytes identically in every language.",
      "djdl",
      {
        machineUuid: "ünïcödé-uuid-λ",
        machineModel: "Ordinateur — Modèle 日本",
      },
    ),
    fingerprintVector(
      "other-product",
      "Domain separation: the same hardware under a different product slug must differ.",
      "other",
      MAC_RAW,
    ),
  ];

  // The pre-existing `pkey-device:` formula, pinned for the first time.
  const deviceIds = [
    {
      id: "macos-platform-uuid",
      product: "djdl",
      raw: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
      expected: sha256B64url(
        "pkey-device:djdl:564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
        32,
      ),
    },
    {
      id: "linux-machine-id",
      product: "djdl",
      raw: "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
      expected: sha256B64url(
        "pkey-device:djdl:b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
        32,
      ),
    },
    {
      id: "other-product-same-hardware",
      product: "other",
      raw: "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
      expected: sha256B64url(
        "pkey-device:other:564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
        32,
      ),
    },
    {
      id: "unicode-raw",
      product: "djdl",
      raw: "ünïcödé-uuid-λ",
      expected: sha256B64url("pkey-device:djdl:ünïcödé-uuid-λ", 32),
    },
  ];

  return {
    fingerprintVersion: 1,
    componentOrder: FINGERPRINT_COMPONENT_ORDER,
    componentHashLength: 22,
    hwidLength: 32,
    deviceIds,
    vectors,
  };
}

/** Reconcile one generated/source file against its on-disk copy. In `--check` mode a drift
 *  is fatal (returns true so the caller can exit 1); otherwise it's written. */
function reconcile(path: string, content: string, check: boolean): boolean {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === content) {
    console.log(`up to date: ${path}`);
    return false;
  }
  if (check) {
    console.error(`stale: ${path} — run \`pnpm gen:corpus\``);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
  return false;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const corpus = await build();
  const content = await format(JSON.stringify(corpus), { parser: "json" });

  // The canonical corpus.
  let stale = reconcile(OUT, content, check);

  // The fingerprint + device-id vectors. Unsigned (they pin hash formulas, not signatures),
  // but guarded by the same drift gate and mirrored into the Swift bundle alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });
  stale = reconcile(FINGERPRINT_OUT, fingerprint, check) || stale;
  stale =
    reconcile(join(SWIFT_RESOURCES, "fingerprint.json"), fingerprint, check) ||
    stale;

  // The Swift test bundle mirrors the corpus + the gate-matrix fixture byte-for-byte. The
  // gate-matrix is a hand-authored fixture (not signed), so it's read from its canonical
  // location and copied verbatim — `--check` then guards both the source and the mirror.
  let gateMatrix: string | undefined;
  try {
    gateMatrix = readFileSync(GATE_MATRIX, "utf8");
  } catch {
    gateMatrix = undefined;
  }
  stale =
    reconcile(join(SWIFT_RESOURCES, "cases.json"), content, check) || stale;
  if (gateMatrix !== undefined) {
    stale =
      reconcile(join(SWIFT_RESOURCES, "gate-matrix.json"), gateMatrix, check) ||
      stale;
  }

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Three files in one directory so a runner can point at `corpus/v2/` and find everything
  // it needs, and so `--check` guards the whole set. `fingerprint.json` is a byte-identical
  // copy of v1's: the hash formulas are unchanged (`fingerprintVersion` stays 1) and
  // deliberately NOT rebranded — the `pkey-hw:`/`pkey-device:` prefixes are hash domains
  // baked into every enrolled digest, not user-visible identifiers.
  const v2Content = await format(JSON.stringify(await buildV2()), {
    parser: "json",
  });
  stale = reconcile(V2_OUT, v2Content, check) || stale;
  const v2GateMatrix = await format(JSON.stringify(buildGateMatrixV2()), {
    parser: "json",
  });
  stale = reconcile(V2_GATE_MATRIX_OUT, v2GateMatrix, check) || stale;
  stale = reconcile(V2_FINGERPRINT_OUT, fingerprint, check) || stale;

  if (check && stale) process.exit(1);
}

await main();

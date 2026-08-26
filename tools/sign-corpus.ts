// Generate the cross-language conformance corpus (conformance/corpus/v1/cases.json).
// ONE signer produces the canonical signed vectors; every SDK's runner (Node, Python,
// Swift, React) verifies the SAME file, proving byte-identical JWS verification + (later)
// identical gate transitions. Ed25519 is deterministic, so re-signing is reproducible —
// `--check` re-emits in memory and fails if the committed file drifted.
//
//   pnpm gen:corpus            # write conformance/corpus/v1/cases.json
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if stale)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  signJws,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@plrs/jws";
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

  if (check && stale) process.exit(1);
}

await main();

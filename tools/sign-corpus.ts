// Generate the cross-language conformance corpus (conformance/corpus/v1/cases.json).
// ONE signer produces the canonical signed vectors; every SDK's runner (Node, Python,
// Swift, React) verifies the SAME file, proving byte-identical JWS verification + (later)
// identical gate transitions. Ed25519 is deterministic, so re-signing is reproducible —
// `--check` re-emits in memory and fails if the committed file drifted.
//
//   pnpm gen:corpus            # write conformance/corpus/v1/cases.json
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if stale)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signJws, base64UrlEncodeBytes } from "@polaris-key/jws";
import { format } from "prettier";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "..", "conformance", "corpus", "v1");
const OUT = join(CORPUS_DIR, "cases.json");

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

interface CorpusCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expect: VerifyExpect;
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

  return { corpusVersion: 1, keys: KEYS, cases };
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

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

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "conformance", "corpus", "v1", "cases.json");

/** Committed TEST keypairs. These are NOT production keys — they exist only to sign the
 *  corpus. `djdl-test-2026` is the original djdl cross-platform vector key (so the legacy
 *  baseline reproduces byte-for-byte); `pkey-test-prod-2026` is a Polaris Key test key. */
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
const encSeg = (o: unknown): string => base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));

/** The original djdl doc (NO aud/iss) — its bytes must reproduce the committed fixture. */
const LEGACY_DOC = {
  schemaVersion: 1,
  licenseId: "abc123def456",
  deviceId: "device-fixture-01",
  issuedAt: 1700000000,
  expiresAt: 1700003600,
  graceUntil: 1702592000,
  profile: { name: "Ada Lovelace", firstName: "Ada", email: "ada@example.com", enrolledAt: 1690000000 },
  payload: {
    config: { "run.concurrency": { state: "enforced", value: 4, updatedAt: 1699990000 } },
    secrets: { "proxy.subscriptionUrl": { state: "hidden", value: "https://vpn.example.com/sub/abc", updatedAt: 1699990000 } },
    entitlements: { polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 } },
  },
} as const;

/** A Polaris Key v1 doc — adds `aud` (product) + `iss`, the canonical field order. */
function polarisDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_3f8a9b",
    deviceId: "dev_7c1e2d",
    issuedAt: 1700000000,
    expiresAt: 1700003600,
    graceUntil: 1702592000,
    profile: { name: "Grace Hopper", firstName: "Grace", email: "grace@example.com", enrolledAt: 1690000000 },
    payload: {
      config: { "run.concurrency": { state: "enforced", value: 4, updatedAt: 1699990000 } },
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
        channels: { state: "enforced", value: ["stable", "staging"], updatedAt: 1699990000 },
        "app.minVersion": { state: "enforced", value: "1.0.0", updatedAt: 1699990000 },
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

  // 1. Legacy djdl baseline — reproduces the original fixture bytes exactly.
  const legacyJws = await signJws(LEGACY_DOC, pem("djdl-test-2026"), "djdl-test-2026");
  cases.push({
    id: "legacy-djdl-baseline",
    description: "Original djdl cross-platform vector (no aud/iss) — proves the encoding is unchanged.",
    jws: legacyJws,
    trust: { "djdl-test-2026": pub("djdl-test-2026") },
    expect: { verify: "ok", kid: "djdl-test-2026", doc: LEGACY_DOC },
  });

  // 2. Valid Polaris v1 doc under the prod-like test key.
  const validDoc = polarisDoc();
  const validJws = await signJws(validDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
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
    payload: { config: { "run.concurrency": { state: "enforced", value: 999, updatedAt: 1699990000 } }, secrets: {}, entitlements: {} },
  });
  cases.push({
    id: "tampered-payload",
    description: "Payload mutated after signing — signature must fail.",
    jws: `${h}.${encSeg(tampered)}.${s}`,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 4. Unknown kid — signed by a key not present in the trust set.
  const unknownJws = await signJws(validDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
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
  const secondKeyJws = await signJws(secondKeyDoc, pem("djdl-test-2026"), "djdl-test-2026");
  cases.push({
    id: "valid-second-key-multi-trust",
    description:
      "A doc signed by djdl-test-2026, verified against a trust set holding BOTH test keys — selection is by kid.",
    jws: secondKeyJws,
    trust: multiTrust,
    expect: { verify: "ok", kid: "djdl-test-2026", doc: secondKeyDoc },
  });

  // 8. Forward-compat: extra/unknown top-level fields must NOT break verification. The
  //    signature covers the exact bytes (including the unknown keys), so it still verifies
  //    and the payload round-trips verbatim.
  const forwardDoc = polarisDoc({
    futureFeature: { tier: "gold", seats: 5 },
    unknownTopLevel: "ignored-by-old-clients",
  });
  const forwardJws = await signJws(forwardDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
  cases.push({
    id: "valid-forward-compat-extra-fields",
    description:
      "A doc carrying unknown top-level fields still verifies and round-trips byte-for-byte (forward-compat).",
    jws: forwardJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: forwardDoc },
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
    description: "An empty-string JWS — structurally invalid, must fail cleanly.",
    jws: "",
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "fail" },
  });

  // 11. Four segments — too many parts; must fail before any signature math.
  const [fh, fp, fs] = validJws.split(".") as [string, string, string];
  cases.push({
    id: "malformed-four-parts",
    description: "A 4-segment JWS (extra trailing part) — structurally invalid, must fail.",
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
      enrolledAt: 1690000000,
    },
  });
  const unicodeJws = await signJws(unicodeDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
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
        "run.concurrency": { state: "enforced", value: 4, updatedAt: 1699991111 },
        "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
      },
      secrets: {
        "proxy.subscriptionUrl": { state: "hidden", value: "https://vpn.example.com/sub/xyz", updatedAt: 1699993333 },
      },
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1699994444 },
      },
    },
  });
  const v2StatesJws = await signJws(v2StatesDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
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
      config: { "run.concurrency": { state: "enforced", value: 8, updatedAt: 1700123456 } },
      secrets: {},
      entitlements: { polarisVpn: { state: "default", value: false, updatedAt: 1700654321 } },
    },
  });
  const updatedAtJws = await signJws(updatedAtDoc, pem("pkey-test-prod-2026"), "pkey-test-prod-2026");
  cases.push({
    id: "valid-updated-at-roundtrip",
    description:
      "Per-entry updatedAt (epoch seconds) round-trips exactly through sign + verify — clients change-detect on it.",
    jws: updatedAtJws,
    trust: { "pkey-test-prod-2026": pub("pkey-test-prod-2026") },
    expect: { verify: "ok", kid: "pkey-test-prod-2026", doc: updatedAtDoc },
  });

  return { corpusVersion: 1, keys: KEYS, cases };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const corpus = await build();
  const content = JSON.stringify(corpus, null, 2) + "\n";

  let current: string | undefined;
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = undefined;
  }

  if (current === content) {
    console.log(`up to date: ${OUT}`);
    return;
  }
  if (check) {
    console.error(`stale: ${OUT} — run \`pnpm gen:corpus\``);
    process.exit(1);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content);
  console.log(`wrote ${OUT}`);
}

await main();

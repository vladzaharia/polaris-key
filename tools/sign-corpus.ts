// Generate the cross-language conformance corpus. ONE signer produces the canonical signed
// vectors; every SDK's runner (Node, Python, Swift, React) verifies the SAME files, proving
// byte-identical JWS verification + identical gate transitions. Ed25519 is deterministic, so
// re-signing is reproducible — `--check` re-emits in memory and fails if a committed file
// drifted.
//
// ONE corpus, from two committed test keys and fixed clocks:
//
//   conformance/corpus/v2/  wire contract v3 (docs/security/WIRE-CONTRACT-V3.md). Consumed by
//                           conformance/runners/node/corpusV2.test.ts via
//                           @polaris-key/client-core, by the Python runner, and — mirrored
//                           into the Swift test bundle's `Resources/v2/`, which keeps the
//                           mirror path identical to the source path — by the Swift suite.
//
// `corpus/v1` (wire contract v2) is GONE: its fifteen gate-matrix rows were inlined into
// `CARRIED_MATRIX_ROWS` below before deletion, so nothing it pinned was dropped.
//
//   pnpm gen:corpus            # write the corpus
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if any file is stale)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  signJws,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@polaris-key/jws";
import { format } from "prettier";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The Swift test target bundles its fixtures as copied resources (it can't reach up the
 *  monorepo at test time). To keep those copies from drifting from the canonical corpus, the
 *  generator mirrors them here and `--check` guards the mirror exactly like the source. The
 *  `v2/` segment is kept so the mirror path matches `conformance/corpus/v2/` one-for-one. */
const SWIFT_V2_RESOURCES = join(
  HERE,
  "..",
  "sdks",
  "swift",
  "Tests",
  "PolarisKeyTests",
  "Resources",
  "v2",
);

/** Committed TEST keypairs. These are NOT production keys — they exist only to sign the
 *  corpus. `djdl-test-2026` signs the DJDL baseline; `pkey-test-prod-2026` is a Polaris Key
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
interface VerifyExpect {
  verify: "ok" | "fail";
  kid?: string;
  doc?: unknown;
}

/** A syntactically valid Ed25519 public key that belongs to nobody — the "attacker" bytes in
 *  the substitution cases. Deterministic so `--check` is stable. */
const FOREIGN_PUB = base64UrlEncodeBytes(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff)),
);

/** Document-type domain separator, wire contract v2 §2.4. */
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

const CLOCK_SKEW = 300;
const V2_DIR = join(HERE, "..", "conformance", "corpus", "v2");
const V2_OUT = join(V2_DIR, "cases.json");
const V2_GATE_MATRIX_OUT = join(V2_DIR, "gate-matrix.json");
const V2_FINGERPRINT_OUT = join(V2_DIR, "fingerprint.json");

/** Document-type domain separators, wire contract v3 §2. */
type TypV3 =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws";

/** §8 — the ISSUER is host-neutral. `key.plrs.im` remains the serving HOST and is no longer
 *  a valid `iss`; `license-iss-v2-host-rejected` pins exactly that. */
const ISSUER_V3 = "key.plrs.im";
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

/** §3's shared timestamp ceiling: 23:59:59 on 9999-12-31 UTC. Restated here rather than
 *  imported — a golden corpus that shares a constant with the implementation it checks cannot
 *  catch a change to that constant. */
const MAX_TIMESTAMP_SECONDS = 253402300799;

/** A `pkey-license+jws` payload (§2.1): the shared envelope + grants. `entitlements` is the
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

/** A `pkey-config+jws` payload (§2.2): the same envelope, config + secrets, and NO license
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
  /**
   * §2.3's ADVISORY `role`. Omitted unless a vector is specifically about it, so every case
   * that predates the anchor split keeps its exact bytes — and so the corpus covers both
   * shapes, a manifest that carries the field and one that does not (a server older than the
   * split emits the latter, and that is not an error).
   */
  role?: string,
): Record<string, unknown> {
  return {
    kid,
    alg: "EdDSA",
    kty: "OKP",
    crv: "Ed25519",
    publicKey,
    status,
    ...(role === undefined ? {} : { role }),
  };
}

/** A `pkey-trust+jws` payload (§2.3). Shape unchanged from v2; only `iss` and `typ` moved. */
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
  /** §1 — present ONLY on the `pkey-bundle+jws` vectors, which is the one artifact allowed
   *  past 65 536 bytes. Runners must not pass it anywhere else. */
  maxPayloadBytes?: number;
  /**
   * Drive this vector through a call site that names NO `typ` — the one thing every shipping
   * verifier does the opposite of. `typ` above still records what the ARTIFACT is; this says
   * what the CALLER asked for. It exists for A1-05: §1's raised payload cap is granted to a
   * type, so a runner has to be able to ask for the cap without the type to prove that the
   * combination is refused.
   */
  callSiteOmitsTyp?: boolean;
  /** `doc` is omitted where the payload is a quarter-megabyte of padding: the vector pins
   *  the size boundary, and the id already says which side of it. */
  expect: VerifyExpect;
}

async function buildJwsCases(): Promise<JwsCaseV2[]> {
  const cases: JwsCaseV2[] = [];
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const LIC: TypV3 = "pkey-license+jws";

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
    jws: await signAs(statesDoc, PIN_KID, "pkey-config+jws"),
    trust: TRUST,
    typ: "pkey-config+jws",
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
      "Header asserts `typ: pkey-config+jws` at a call site expecting `pkey-license+jws` — the two v3 documents share a signing key, so only the type separates them (§2).",
    jws: await signAs(validDoc, PIN_KID, "pkey-config+jws"),
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
      "pkey-trust+jws",
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 35/36. §1's ONE exception: `pkey-bundle+jws` is capped at 262 144, not 65 536, and the
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
      "A `pkey-bundle+jws` payload of EXACTLY 262 144 decoded bytes, verified with maxPayloadBytes = 262 144 — at the cap is valid (§1). `doc` is omitted: the payload is a quarter-megabyte of padding and the boundary is the whole point.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES, bundleCapBase),
      PIN_KID,
      "pkey-bundle+jws",
    ),
    trust: TRUST,
    typ: "pkey-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "ok", kid: PIN_KID },
  });
  cases.push({
    id: "bundle-payload-raised-cap-without-typ",
    description:
      "The at-cap bundle payload again, with the SAME raised cap but NO `typ` demanded. §1 grants the 262 144-byte exception to `pkey-bundle+jws` alone, and the cap and the type are one grant: a quarter-megabyte payload accepted with no type demanded could be re-presented at an ordinary document call site with the raised cap already in force. Swift always refused this combination; TS and Python left the two decoupled and accepted it (A1-05). Refused outright rather than silently downgraded to 64 KiB — a caller asking for the bundle cap without naming the bundle type has made a mistake worth surfacing.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES, bundleCapBase),
      PIN_KID,
      "pkey-bundle+jws",
    ),
    trust: TRUST,
    typ: "pkey-bundle+jws",
    callSiteOmitsTyp: true,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "bundle-payload-over-cap",
    description:
      "The same bundle one decoded byte past the cap (262 145) with the same raised cap — rejected. The raised cap is a CAP, not a licence to be unbounded.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES + 1, bundleCapBase),
      PIN_KID,
      "pkey-bundle+jws",
    ),
    trust: TRUST,
    typ: "pkey-bundle+jws",
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
      id: `${prefix}-iss-near-miss-rejected`,
      description:
        '`iss: "plrs.im"` — the bare apex, one label away from the real `key.plrs.im` (§8). The issuer is a fixed string, never a suffix match and never derived from the serving host, so a near-miss issuer is refused outright rather than shading into acceptance.',
      jws: await sign({ iss: "plrs.im" }),
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
      id: `${prefix}-issuedAt-non-integer`,
      description:
        "`issuedAt` with a fractional part. §3's timestamp rule is ONE rule in every implementation — an integer in [0, MAX_TIMESTAMP_SECONDS] — because `typeof x === \"number\"` is not the same test in three languages: TS accepted this, Swift's `Codable` `Int` refused it, and Python's `int` check refused it too (A1-04). Neither truncated nor tolerated: refused.",
      jws: await sign({ issuedAt: V3_ISSUED + 0.5 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issuedAt-past-timestamp-ceiling`,
      description:
        "`issuedAt` one second past `MAX_TIMESTAMP_SECONDS` (23:59:59 on 9999-12-31 UTC). Evaluated on the RELOAD profile so freshness is off and the RANGE rule is the only thing that can refuse it — which is exactly the half TS and Python had no bound for at all (A1-04).",
      jws: await sign({
        issuedAt: MAX_TIMESTAMP_SECONDS + 1,
        expiresAt: MAX_TIMESTAMP_SECONDS + 1,
        graceUntil: MAX_TIMESTAMP_SECONDS + 1,
      }),
      checkFreshness: false,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issuedAt-negative`,
      description:
        "A negative `issuedAt`. Reload profile again, so only the range rule applies. There is no epoch-seconds claim before 1970 in this protocol, and a signed negative timestamp is a floor that would read as `0` in one implementation and as itself in another.",
      jws: await sign({ issuedAt: -1, expiresAt: 0, graceUntil: 0 }),
      checkFreshness: false,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-timestamps-at-ceiling-accepted`,
      description:
        "The ceiling is INCLUSIVE: `graceUntil` exactly at `MAX_TIMESTAMP_SECONDS`, with `issuedAt` a year below it so the 365-day grace bound is satisfied too. Without this pair an implementation that rejected every large timestamp would pass the two above.",
      jws: await sign({
        issuedAt: MAX_TIMESTAMP_SECONDS - MAX_GRACE_SECONDS,
        expiresAt: MAX_TIMESTAMP_SECONDS - MAX_GRACE_SECONDS + 3600,
        graceUntil: MAX_TIMESTAMP_SECONDS,
      }),
      checkFreshness: false,
      expect: { accept: true },
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
  return envelopeCases("license", "pkey-license+jws", licenseDoc);
}

async function buildConfigDocCases(): Promise<DocCaseV2[]> {
  const shared = await envelopeCases("config", "pkey-config+jws", configDoc);
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ: "pkey-config+jws" as TypV3,
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
        "pkey-config+jws",
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
        "pkey-config+jws",
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
    signAs(trustManifestV3({ keys }), signWith, "pkey-trust+jws");

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
      id: "trust-key-missing-alg-is-skipped-not-fatal",
      description:
        "One entry OMITS `alg` entirely. §1 says an entry that is not the Ed25519 triple is SKIPPED, not fatal — a future-alg key must never brick a current verifier — and an entry that omits the field is no more comprehensible than one naming an algorithm we lack, so it takes the same path. Swift used to reject the WHOLE manifest here, because `Codable` threw on the missing field, while TS and Python skipped just that entry: the same signed bytes, two trust sets (A1-06).",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        {
          kid: ALT_KID,
          kty: "OKP",
          crv: "Ed25519",
          publicKey: pub(ALT_KID),
          status: "active",
        },
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-key-wrong-typed-alg-is-skipped-not-fatal",
      description:
        'The same rule for a MISTYPED `alg` (a number, not a string). Optionality alone would not cover this — a strict decoder still throws on `alg: 7` — so the entry is read leniently and skipped, exactly as `alg: "RS256"` is.',
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        {
          kid: ALT_KID,
          alg: 7,
          kty: "OKP",
          crv: "Ed25519",
          publicKey: pub(ALT_KID),
          status: "active",
        },
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-key-missing-kid-is-fatal",
      description:
        "The OTHER half of A1-06, and the reason the two cases have to be pinned together: an entry with no `kid` is not a forward-compatible key, it is a malformed manifest — the entry has no identity, so the pinned-substitution rule cannot even be evaluated against it. The WHOLE manifest is rejected and the previous trust set is kept. `publicKey` is the same case.",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        {
          alg: "EdDSA",
          kty: "OKP",
          crv: "Ed25519",
          publicKey: pub(ALT_KID),
          status: "active",
        },
      ]),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-kid-proto-is-stored-not-dropped",
      description:
        "A published kid of `__proto__`. Python's dict and Swift's Dictionary store it; TS's object literal wrote the prototype instead and the entry silently vanished, so one implementation held a smaller trust set than the other two for identical signed bytes (A1-08). The discovered set is built on a null-prototype map, so the key is a key. Nothing is granted by this — the kid still has to be named in a header before it verifies anything, and the pins still spread last.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry("__proto__", pub(ALT_KID), "active"),
      ]),
      now,
      expect: {
        accepted: true,
        // A COMPUTED key, not the literal `__proto__:` form. The literal sets the object's
        // prototype and creates no own property at all — which is the very bug this vector
        // exists to pin, and it would have silently emitted a fixture missing the key.
        trust: {
          [PIN_KID]: pub(PIN_KID),
          ["__proto__"]: pub(ALT_KID),
        },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-issuedAt-past-timestamp-ceiling",
      description:
        "The manifest's own `issuedAt` one second past `MAX_TIMESTAMP_SECONDS`. The manifest's `issuedAt` is what makes the §4.2 floor bite, so an out-of-range value here is a floor three languages would compute differently — the same one timestamp rule the document envelope uses (A1-04).",
      pinned,
      before: {},
      manifestJws: await signAs(
        trustManifestV3({
          issuedAt: MAX_TIMESTAMP_SECONDS + 1,
          keys: [keyEntry(PIN_KID, pub(PIN_KID), "active")],
        }),
        PIN_KID,
        "pkey-trust+jws",
      ),
      now,
      checkFreshness: false,
      expect: { accepted: false, trust: { [PIN_KID]: pub(PIN_KID) } },
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
        "pkey-trust+jws",
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

    // ── §1.1 — the trust anchor / document-key split (B3-01) ─────────────────
    //
    // `PIN_KID` is the ANCHOR here (it is what `pinned` holds, which is the definition), and
    // `ALT_KID` is the rotating DOCUMENT key. The four vectors below pin, in order: the control,
    // the R2-01 guard restated for the split, the same guard against a manifest that LIES about
    // its signer's role, and the rule that `role` is advisory in the benign direction too.
    {
      id: "trust-anchor-signed-manifest-verifies-against-pinned-anchor",
      description:
        "The §1.1 control. The manifest is signed by the ANCHOR — the key the host application pins — and publishes both key classes with their advisory `role`. It verifies, and the document key it publishes joins the trust set. This is the shape every server emits after the anchor split, and the fact that it verifies identically to a pre-split manifest is why the split needs no PROTOCOL_VERSION bump.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active", "anchor"),
        keyEntry(ALT_KID, pub(ALT_KID), "active", "document"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-manifest-signed-by-document-key-rejected",
      description:
        "A manifest signed by the product's DOCUMENT key rather than its anchor. Refused, and the previous trust set is kept. This is the R2-01 guard in the vocabulary of §1.1: the anchor is a SEPARATE, longer-lived pinned key, never a relaxation of 'manifests verify against pins only'. A verifier that accepted this would be trusting a manifest signed by a key that rotates — which is both halves of the bug B3-01 describes, since it is precisely the rotating key that a compromise obtains and that a revocation is supposed to remove.",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active", "anchor"),
          keyEntry(ALT_KID, pub(ALT_KID), "active", "document"),
        ],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-role-claim-does-not-grant-manifest-signing",
      description:
        'The same forgery, dressed up: the manifest is signed by the document key AND declares that key `role: "anchor"`. Still refused. `role` is ADVISORY (§1.1) — a verifier that read it as authority would be letting a manifest name the key that verifies it, which is R2-01 through a new door, and the door would be one an attacker holding any document key could walk through. What constrains manifest signing is the pin, and only the pin.',
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest(
        [
          keyEntry(ALT_KID, pub(ALT_KID), "active", "anchor"),
          keyEntry(PIN_KID, pub(PIN_KID), "retired", "document"),
        ],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-role-is-advisory-not-a-filter",
      description:
        '`role` changes NOTHING about a manifest that is otherwise valid — the other direction of the same rule. This one is anchor-signed and correct, but its entries carry roles that are wrong (the anchor calls itself a document key), unknown (`role: "future"`) and absent. Every non-revoked entry still lands in the discovered set. An implementation that filtered on `role` would build a smaller trust set than its siblings from identical signed bytes — a cross-language divergence of exactly the kind A1-06 and A1-08 were.',
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active", "document"),
        keyEntry(ALT_KID, pub(ALT_KID), "active", "future"),
        keyEntry("no-role-declared", FOREIGN_PUB, "active"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: {
          [PIN_KID]: pub(PIN_KID),
          [ALT_KID]: pub(ALT_KID),
          "no-role-declared": FOREIGN_PUB,
        },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-document-key-rotation-keeps-client-working",
      description:
        "A document-key rotation seen from an ALREADY-PROVISIONED client: it pins the anchor and currently trusts the outgoing document key. The new manifest is signed by the SAME anchor (rotation does not move it), publishes the incoming document key, and omits the outgoing one — so it verifies, the new key is learned and the old one is pruned. This is the whole point of §1.1. Before the split the manifest was signed by the key that just rotated, so this exact refresh failed on every installed client, and with it every revocation the manifest would have carried.",
      pinned,
      before: { "djdl-2026-outgoing": FOREIGN_PUB },
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active", "anchor"),
        keyEntry(ALT_KID, pub(ALT_KID), "active", "document"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
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
  /** A trust refresh ten minutes after the documents were issued — the ordinary cadence, and
   *  early enough that the licence document is still inside its own one-hour window, so the
   *  rotation case below can assert the strongest outcome (`ok`) rather than `grace`. */
  const MANIFEST_AFTER_ROTATION = V3_ISSUED + 600;
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
    signAs(trustManifestV3({ issuedAt, keys }), signWith, "pkey-trust+jws");
  const license = (signWith = PIN_KID): Promise<string> =>
    signAs(licenseDoc(), signWith, "pkey-license+jws");
  const config = (issuedAt = V3_ISSUED): Promise<string> =>
    signAs(
      configDoc({
        issuedAt,
        expiresAt: issuedAt + 3600,
        graceUntil: issuedAt + 30 * DAY,
      }),
      PIN_KID,
      "pkey-config+jws",
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
    {
      ...common,
      id: "floor-document-key-rotation-keeps-client-working",
      description:
        "§1.1 end to end, on the path that matters: a client that pins ONLY the anchor, reloading after a document-key rotation. The manifest is anchor-signed (rotation did not move the signer) and publishes the incoming document key; the cached licence document is signed by that incoming key and therefore verifies against the set the manifest just built — so the gate reads `ok` and the install keeps running. Before the anchor split this is the exact point at which an installed client went dark: the manifest was signed by the key that had just rotated away from the pin, so step 2 refused it, no rotated key was ever learned, the licence document failed at step 3, and the client fell to `needs-activation` with no user action able to recover it.",
      licenseJws: await license(ALT_KID),
      trustJws: await manifest(
        MANIFEST_AFTER_ROTATION,
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active", "anchor"),
          keyEntry(ALT_KID, pub(ALT_KID), "active", "document"),
        ],
        PIN_KID,
      ),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_AFTER_ROTATION,
        effectiveNow: MANIFEST_AFTER_ROTATION,
        status: "ok",
      },
    },
  ];
}

// ── §7 offline activation bundles ────────────────────────────────────────────
// Every case is a complete, signed `pkey-bundle+jws` plus the outcome of running §7's
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
    "pkey-trust+jws",
  );
  const innerLicense = await signAs(licenseDoc(), PIN_KID, "pkey-license+jws");
  // Signed by the ROTATED key, which only the inner manifest publishes: step 4 must verify
  // inner documents against the effective set built in step 3, not against the pins.
  const innerConfig = await signAs(configDoc(), ALT_KID, "pkey-config+jws");

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
    signAs(payload, PIN_KID, "pkey-bundle+jws");

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
              "pkey-license+jws",
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
            "pkey-trust+jws",
          ),
        }),
      ),
      expect: { imports: false, reason: "bundle-trust-rejected" },
    },
    {
      ...common,
      id: "bundle-missing-trust-claim",
      description:
        "A bundle with NO `trust` field at all. §7 numbers step 1 as the signature, the `typ` and the 262 144-byte cap, and step 2 as the CLAIMS — so a missing claim is step 2, and the corpus pins the step because the step is the operator's remedy. Swift decoded straight into a strongly-typed `BundleDoc`, so `Codable` threw and reported step 1 for identical bytes TS and Python reported as step 2 (A1-07).",
      bundleJws: await sign(bundle({ trust: undefined })),
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-issuedAt-wrong-type",
      description:
        "`issuedAt` as a STRING. The same step-attribution rule as above — a claim of the wrong shape is a claims failure, not a JWS failure — and the same one timestamp rule §3 applies to documents (A1-04, A1-07).",
      bundleJws: await sign(bundle({ issuedAt: String(V3_ISSUED) })),
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-docs-license-explicit-null",
      description:
        "`docs.license: null` alongside a perfectly good config document. Present-and-null is NOT absent: no mint emits the key at all when there is no licence, so the only producer of an explicit null is something that got the shape wrong or is probing for a lenient reader. Python and Swift used to read it as absent and import config-only while TS refused — the same bytes, two outcomes (A2-04). Refusing adds no accepted artifacts.",
      bundleJws: await sign(
        bundle({ docs: { license: null, config: innerConfig } }),
      ),
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-typ-missing",
      description:
        "A correctly-signed bundle with no `typ` in its header. §7.1 demands `pkey-bundle+jws`; without the type check the same bytes could be replayed at a document call site with the raised 262 144 cap in force.",
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
// The matrix is hand-authored and frozen. Its first fifteen rows are corpus v1's, inlined
// verbatim below when v1 was deleted; the rows v1 could not express are appended in
// `buildGateMatrixV2`.

/**
 * The fifteen rows corpus v1's hand-authored matrix carried, INLINED here when corpus v1 was
 * deleted (Task 8.14). They arrive already shimmed into the v3 shape — every v1 product was
 * licensed (`licenseServiceEnabled: true`) and v1's `hasToken` boolean became v3's tri-state
 * `activation` — so a v3 gate that changes any decision v2 made goes red below.
 *
 * Frozen: nothing may be edited here to make a gate change pass. A genuinely new decision is a
 * NEW row appended in `buildGateMatrixV2`, so the diff shows what changed.
 */
const CARRIED_MATRIX_ROWS = [
  {
    name: "ok — stable build inside window, valid doc",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastVerifiedAt: 1490,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "ok — staging build permitted by channels entitlement",
    gate: {
      version: "2.0.0",
      channel: "staging",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {
        channels: {
          state: "enforced",
          value: ["stable", "staging"],
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel",
    gate: {
      version: "0.0.0-dev+abc123",
      channel: "staging",
      compatMin: "5.0.0",
      compatMax: "6.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "ok",
      ok: true,
    },
  },
  {
    name: "grace — doc past expiresAt but within graceUntil (offline grace)",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 5000,
      lastVerifiedAt: 4600,
    },
    expect: {
      status: "grace",
      ok: true,
    },
  },
  {
    name: "expired — doc past graceUntil",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 2593001,
    },
    expect: {
      status: "expired",
      ok: false,
    },
  },
  {
    name: "revoked — hard 401 on the last sync even with a valid doc",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastSyncUnauthorized: true,
    },
    expect: {
      status: "revoked",
      ok: false,
    },
  },
  {
    name: "needs-activation — no token (no credential stored)",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: null,
      now: 1500,
    },
    expect: {
      status: "needs-activation",
      ok: false,
    },
  },
  {
    name: "needs-activation — token present but no cached doc yet",
    gate: {
      version: "2.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      now: 1500,
    },
    expect: {
      status: "needs-activation",
      ok: false,
    },
  },
  {
    name: "version-too-old — build below the product compat min",
    gate: {
      version: "0.9.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-old",
      ok: false,
      reason: "version-too-old",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-old — per-key app.minVersion tighter than product min wins",
    gate: {
      version: "1.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {
        "app.minVersion": {
          state: "enforced",
          value: "2.0.0",
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-old",
      ok: false,
      reason: "version-too-old",
      allowedRange: {
        min: "2.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-new — build above the product compat max",
    gate: {
      version: "4.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
  {
    name: "version-too-new — per-key app.maxVersion tighter than product max wins",
    gate: {
      version: "2.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {
        "app.maxVersion": {
          state: "enforced",
          value: "2.0.0",
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "2.0.0",
      },
    },
  },
  {
    name: "channel-not-entitled — staging build without the channels entitlement",
    gate: {
      version: "2.0.0",
      channel: "staging",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "channel-not-entitled",
      ok: false,
      reason: "channel-not-entitled",
    },
  },
  {
    name: "channel-not-entitled — pr build, channels grants only staging",
    gate: {
      version: "1.0.0",
      channel: "pr-42",
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      entitlements: {
        channels: {
          state: "enforced",
          value: ["staging"],
          updatedAt: 1699990000,
        },
      },
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
    },
    expect: {
      status: "channel-not-entitled",
      ok: false,
      reason: "channel-not-entitled",
    },
  },
  {
    name: "precedence — a build block wins even over a doc that would otherwise be ok",
    gate: {
      version: "4.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: {},
    },
    license: {
      licenseServiceEnabled: true,
      activation: "token",
      issuedAt: 1000,
      expiresAt: 4600,
      graceUntil: 2593000,
      now: 1500,
      lastVerifiedAt: 1490,
    },
    expect: {
      status: "version-too-new",
      ok: false,
      reason: "version-too-new",
      allowedRange: {
        min: "1.0.0",
        max: "3.0.0",
      },
    },
  },
] as const;

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
  return {
    gateMatrixVersion: 2,
    description:
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. Rows 1-15 are corpus v1\'s matrix, carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — and inlined here when corpus v1 was deleted, so a v3 gate that changes any decision v2 made goes red here. The remaining rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on that row is deliberately NOT the status. The final five rows supply `license.blocked` DIRECTLY instead of deriving it from the build gate — a poisoned cache record is exactly a hint no build gate produced — and pin the unsigned hint\'s VOCABULARY: an out-of-vocabulary `blocked.reason` coerces to the stricter `version-too-old` and never to a usable status (A1-01), an in-vocabulary one is still honoured verbatim, and neither outranks the `licenseServiceEnabled` and `activation` guards that precede it. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape.',
    rows: [
      ...CARRIED_MATRIX_ROWS,
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
      // ── The unsigned hint's VOCABULARY (A1-01) ─────────────────────────────────────────
      // §4.1 keeps `blocked` unsigned on the argument that it can only ever make the gate
      // STRICTER. That is a claim about the vocabulary, and it was not checked anywhere: the
      // gate returned `blocked.reason` verbatim AS the `LicenseStatus`, and `isUsable` says
      // yes to `ok`/`grace`/`not-applicable`. So writing `{"v":3,"blocked":{"reason":"ok"}}`
      // into the cache file licensed the client with no document and no signature anywhere.
      //
      // These rows supply the hint DIRECTLY rather than deriving it from the build gate,
      // because a poisoned cache record is exactly a hint no build gate produced.
      {
        name: "version-too-old — an out-of-vocabulary blocked.reason coerces to the STRICTER reason",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "token",
          ...MATRIX_DOC,
          now: 1500,
          blocked: { reason: "ok" },
        },
        expect: { status: "version-too-old", ok: false },
      },
      {
        name: "version-too-old — `not-applicable` as a blocked.reason is coerced too, allowedRange kept",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "token",
          ...MATRIX_DOC,
          now: 1500,
          blocked: {
            reason: "not-applicable",
            allowedRange: { min: "1.0.0", max: "3.0.0" },
          },
        },
        // The RANGE is display furniture and survives; only the reason is coerced. A gate
        // that dropped the range would still be safe, and one that honoured the reason
        // would not, which is why the assertion is on both.
        expect: {
          status: "version-too-old",
          ok: false,
          allowedRange: { min: "1.0.0", max: "3.0.0" },
        },
      },
      {
        name: "channel-not-entitled — an IN-vocabulary blocked.reason is still honoured verbatim",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: "token",
          ...MATRIX_DOC,
          now: 1500,
          blocked: { reason: "channel-not-entitled" },
        },
        // Without this row an implementation that coerced EVERY reason to `version-too-old`
        // would pass the two above while destroying the hint's only useful property.
        expect: { status: "channel-not-entitled", ok: false },
      },
      {
        name: "needs-activation — a poisoned blocked.reason does not outrank the activation guard",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: true,
          activation: null,
          now: 1500,
          blocked: { reason: "ok" },
        },
        // The documented ordering (row 21) holds for a poisoned hint too: coercion happens
        // where the hint is READ, not by reordering the machine around it.
        expect: { status: "needs-activation", ok: false },
      },
      {
        name: "not-applicable — a poisoned blocked.reason cannot be used to gate an unlicensed product either",
        gate: PASSING_GATE,
        license: {
          licenseServiceEnabled: false,
          activation: null,
          now: 1500,
          blocked: { reason: "version-too-new" },
        },
        // The mirror of the row above, with a LEGITIMATE reason: `licenseServiceEnabled:
        // false` precedes `blocked`, so a product that runs no licence service stays usable
        // rather than being blocked by a hint that cannot apply to it (D-08).
        expect: { status: "not-applicable", ok: true },
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

  // The fingerprint + device-id vectors. Unsigned (they pin hash formulas, not signatures),
  // but guarded by the same drift gate and mirrored into the Swift bundle alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Three files in one directory so a runner can point at `corpus/v2/` and find everything
  // it needs, and so `--check` guards the whole set. The `fingerprint.json` formulas are
  // unchanged across the wire revisions (`fingerprintVersion` stays 1) and deliberately NOT
  // rebranded — the `pkey-hw:`/`pkey-device:` prefixes are hash domains baked into every
  // enrolled digest, not user-visible identifiers.
  const v2Content = await format(JSON.stringify(await buildV2()), {
    parser: "json",
  });
  let stale = false;
  stale = reconcile(V2_OUT, v2Content, check) || stale;
  const v2GateMatrix = await format(JSON.stringify(buildGateMatrixV2()), {
    parser: "json",
  });
  stale = reconcile(V2_GATE_MATRIX_OUT, v2GateMatrix, check) || stale;
  stale = reconcile(V2_FINGERPRINT_OUT, fingerprint, check) || stale;

  // …and the same three into the Swift test bundle's `Resources/v2/`, which is what the Swift
  // conformance/gate-matrix/fingerprint runners read.
  stale =
    reconcile(join(SWIFT_V2_RESOURCES, "cases.json"), v2Content, check) ||
    stale;
  stale =
    reconcile(
      join(SWIFT_V2_RESOURCES, "gate-matrix.json"),
      v2GateMatrix,
      check,
    ) || stale;
  stale =
    reconcile(
      join(SWIFT_V2_RESOURCES, "fingerprint.json"),
      fingerprint,
      check,
    ) || stale;

  if (check && stale) process.exit(1);
}

await main();

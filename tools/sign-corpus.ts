// Generate the cross-language conformance corpus. ONE signer produces the canonical signed
// vectors; every SDK's runner (Node, Python, Swift, React, Godot) verifies the SAME files,
// proving byte-identical JWS verification + identical gate transitions. Ed25519 is
// deterministic, so re-signing is reproducible — `--check` re-emits in memory and fails if a
// committed file drifted.
//
// ONE corpus, from two committed test keys and fixed clocks:
//
//   conformance/corpus/v2/  wire contract v3 (docs/security/WIRE-CONTRACT-V3.md). Consumed by
//                           conformance/runners/node/corpusV2.test.ts via
//                           @polaris-key/client-core and by the Python runner. Two
//                           generator-owned mirrors keep the path `…/v2/` one-for-one:
//                           the Swift test bundle's `Resources/v2/` (the Swift suite) and
//                           `sdks/godot/tests/corpus/v2/` (the Godot runner, which reads it
//                           from `res://` in the editor and in an exported pack). Every file
//                           is written into every target in `CORPUS_TARGETS`.
//
// Six files: `cases.json` (signed vectors), `gate-matrix.json` (§5), `fingerprint.json` (the
// hardware-hash formulas), `stage-matrix.json` (the boot stage machine of
// `@polaris-key/client-core/stages`, client boot behaviour outside the wire contract, read by
// conformance/runners/node/stageMatrix.test.ts and the Python and Swift runners),
// `headers.json` (the client metadata header values, §5.2) and `config-matrix.json` (config
// resolution and environment values, §2.2.1).
//
// `corpus/v1` (wire contract v2) is GONE: its fifteen gate-matrix rows were inlined into
// `CARRIED_MATRIX_ROWS` below before deletion. Fourteen are still emitted; one, the pre-R3-01
// dev-build bypass, was retired by P0-04 through `RETIRED_CARRIED_ROWS`, with a named successor.
//
//   pnpm gen:corpus            # write the corpus
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if any file is stale)

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** The Godot project's generator-owned mirror. An exported Godot pack can read only `res://`
 *  (the project directory), never `../../conformance/`, so the editor and release-template
 *  runs both load the corpus from here. Guarded by `--check` exactly like the Swift mirror. */
const GODOT_V2_RESOURCES = join(
  HERE,
  "..",
  "sdks",
  "godot",
  "tests",
  "corpus",
  "v2",
);

/** Committed TEST keypairs. These are NOT production keys — they exist only to sign the
 *  corpus. `djdl-test-2026` signs the DJDL baseline; `pkey-test-prod-2026` is a Polaris Key
 *  test key. */
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
  /** WIRE-CONTRACT-V3 §10: RFC 6901 pointer -> the string at that pointer under `doc` with
   *  every U+0000 replaced by U+FFFD. Written by `annotateNul`, never by hand. Only a runner
   *  whose platform string type cannot hold U+0000 (Godot) reads it; every other runner
   *  ignores it. */
  docNulReplaced?: Record<string, string>;
}

/** RFC 6901 reference token: `~` -> `~0`, then `/` -> `~1`. */
const pointerToken = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/** WIRE-CONTRACT-V3 §10 (the U+0000 representation limit). Walks `expect.doc` depth-first in
 *  insertion order and, for each string that contains U+0000, records its pointer and its
 *  U+FFFD form under `docNulReplaced`, written right after `doc` and only when the map is not
 *  empty — so every case without a NUL stays byte-identical. A NUL in an object KEY is outside
 *  the §10 entry (P3-01 decides it), so the generator refuses to emit one. Reuse this for any
 *  later section that pins a decoded document; never apply it to `bundleCases`, whose whole
 *  `expect` object the Node and Python runners compare. */
function annotateNul(expect: VerifyExpect): VerifyExpect {
  if (!("doc" in expect)) {
    if ("docNulReplaced" in expect)
      throw new Error("annotateNul: docNulReplaced without doc");
    return expect;
  }
  const replaced: Record<string, string> = {};
  const walk = (value: unknown, pointer: string): void => {
    if (typeof value === "string") {
      if (!value.includes("\u0000")) return;
      const out = value.replaceAll("\u0000", "\ufffd");
      if (out.includes("\u0000") || out === value)
        throw new Error(`annotateNul: bad replacement at ${pointer}`);
      replaced[pointer] = out;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${pointer}/${i}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes("\u0000"))
          throw new Error(
            `annotateNul: U+0000 in an object key under ${pointer || "/"}`,
          );
        walk(item, `${pointer}/${pointerToken(key)}`);
      }
    }
  };
  walk(expect.doc, "");
  if (Object.keys(replaced).length === 0) return expect;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expect)) {
    if (key === "docNulReplaced") continue;
    out[key] = value;
    if (key === "doc") out.docNulReplaced = replaced;
  }
  return out as unknown as VerifyExpect;
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
const V2_STAGE_MATRIX_OUT = join(V2_DIR, "stage-matrix.json");
const V2_HEADERS_OUT = join(V2_DIR, "headers.json");
const V2_CONFIG_MATRIX_OUT = join(V2_DIR, "config-matrix.json");
/** Every directory that receives the corpus: the source, then each generator-owned mirror. */
const CORPUS_TARGETS = [V2_DIR, SWIFT_V2_RESOURCES, GODOT_V2_RESOURCES];

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
): Record<string, unknown> {
  return { kid, alg: "EdDSA", kty: "OKP", crv: "Ed25519", publicKey, status };
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

  // §10: annotate every U+0000 string in each pinned document (one case today).
  return cases.map((c) => ({ ...c, expect: annotateNul(c.expect) }));
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
// The matrix is hand-authored and frozen. Its first rows are corpus v1's fifteen, inlined
// verbatim below when v1 was deleted, less the one P0-04 retired (`RETIRED_CARRIED_ROWS`); the
// rows v1 could not express are appended in `buildGateMatrixV2`.

/**
 * The fifteen rows corpus v1's hand-authored matrix carried, INLINED here when corpus v1 was
 * deleted (Task 8.14). They arrive already shimmed into the v3 shape — every v1 product was
 * licensed (`licenseServiceEnabled: true`) and v1's `hasToken` boolean became v3's tri-state
 * `activation` — so a v3 gate that changes any decision v2 made goes red below.
 *
 * Frozen: nothing may be edited here to make a gate change pass. A genuinely new decision is a
 * NEW row appended in `buildGateMatrixV2`, so the diff shows what changed. A carried row can be
 * retired only by an approved plan, through `RETIRED_CARRIED_ROWS`, with a named successor row.
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

/**
 * Carried rows an approved plan retired, keyed by exact row name. The frozen array above stays
 * byte-for-byte as it was; `buildGateMatrixV2` filters these out, and refuses to generate if a
 * key names no carried row or its successor is missing from the output.
 */
const RETIRED_CARRIED_ROWS: Record<
  string,
  { retiredBy: string; why: string; successor: string }
> = {
  "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel":
    {
      retiredBy: "P0-04",
      why: "It pins the unconditional dev-build bypass that R3-01 removed: today's server answers `version-too-old` for its inputs, and R3 calls the row defensible only for a client-side build gate, which no SDK has.",
      successor:
        "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
    },
};

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

// ── The channel rows (P0-04, WIRE-CONTRACT-V3 §5.1) ──────────────────────────

/** A `channels` entitlement granting `names`; no names means no entitlement at all. */
function grant(...names: string[]): Record<string, unknown> {
  if (names.length === 0) return {};
  return {
    channels: { state: "enforced", value: names, updatedAt: 1699990000 },
  };
}
/** The header rows' window: wide, with a floor that refuses every `0.0.0-*` build. */
const HEADER_WINDOW = { compatMin: "0.0.0", compatMax: "99.0.0" };
/** `0.0.0-0` sorts below every `0.0.0-<word>` build, so those builds reach the channel check. */
const PRERELEASE_WINDOW = { compatMin: "0.0.0-0", compatMax: "99.0.0" };
/** The licence half of every channel row: an activated, in-window document. */
const CHANNEL_LICENSE = {
  licenseServiceEnabled: true,
  activation: "token",
  ...MATRIX_DOC,
  now: 1500,
};
const CHANNEL_OK = { status: "ok", ok: true };
const CHANNEL_NOT_ENTITLED = {
  status: "channel-not-entitled",
  ok: false,
  reason: "channel-not-entitled",
};

function channelRow(
  name: string,
  version: string,
  channel: string | null,
  window: { compatMin: string; compatMax: string },
  entitlements: Record<string, unknown>,
  expect: Record<string, unknown>,
): unknown {
  return {
    name,
    gate: {
      version,
      ...(channel === null ? {} : { channel }),
      ...window,
      entitlements,
    },
    license: CHANNEL_LICENSE,
    expect,
  };
}

/** The channel vocabulary, pinned (P0-04 plan §4). Rows 1–8 are the brief's minimum set. */
function channelRows(): unknown[] {
  const H = HEADER_WINDOW;
  const P = PRERELEASE_WINDOW;
  const DEV_WINDOW = { compatMin: "5.0.0", compatMax: "6.0.0" };
  return [
    channelRow(
      "ok — beta header, channels [stable, beta]",
      "2.0.0",
      "beta",
      H,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — beta header, channels [stable, staging] (alias)",
      "2.0.0",
      "beta",
      H,
      grant("stable", "staging"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — staging header, channels [stable, beta] (alias)",
      "2.0.0",
      "staging",
      H,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — beta header, channels [stable]",
      "2.0.0",
      "beta",
      H,
      grant("stable"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — manual channel header, entitled by name",
      "2.0.0",
      "nightly",
      H,
      grant("stable", "nightly"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — manual channel header, not entitled",
      "2.0.0",
      "nightly",
      H,
      grant("stable", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — malformed channel header",
      "2.0.0",
      "STAGING",
      H,
      grant("stable", "staging", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — 0.0.0-beta build with beta entitlement",
      "0.0.0-beta.3",
      null,
      P,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — 0.0.0-beta build without a beta entitlement",
      "0.0.0-beta.3",
      null,
      P,
      grant("stable"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
      "0.0.0-staging.1",
      null,
      P,
      grant("stable", "beta"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — latest header is the stable channel",
      "2.0.0",
      "latest",
      H,
      grant(),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — pr-42 header, channels grant the pr family",
      "2.0.0",
      "pr-42",
      H,
      grant("stable", "pr"),
      CHANNEL_OK,
    ),
    channelRow(
      "ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
      "0.0.0-pr-42+sha",
      "pr",
      P,
      grant("stable", "pr-42"),
      CHANNEL_OK,
    ),
    channelRow(
      "channel-not-entitled — pr-7 header, channels grant only pr-42",
      "2.0.0",
      "pr-7",
      H,
      grant("stable", "pr-42"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
      "0.0.0-pr-42+sha",
      "stable",
      P,
      grant(),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "channel-not-entitled — dev header without the dev entitlement",
      "2.0.0",
      "dev",
      H,
      grant("stable", "beta"),
      CHANNEL_NOT_ENTITLED,
    ),
    channelRow(
      "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
      "0.0.0-dev+abc123",
      "staging",
      DEV_WINDOW,
      grant(),
      {
        status: "version-too-old",
        ok: false,
        reason: "version-too-old",
        allowedRange: { min: "5.0.0", max: "6.0.0" },
      },
    ),
    channelRow(
      "ok — dev build with the dev entitlement bypasses the window (R3-01)",
      "0.0.0-dev+abc123",
      "staging",
      DEV_WINDOW,
      grant("stable", "dev"),
      CHANNEL_OK,
    ),
  ];
}

/** The carried rows still emitted, after `RETIRED_CARRIED_ROWS`. */
function carriedRows(): readonly unknown[] {
  const names = new Set<string>(CARRIED_MATRIX_ROWS.map((r) => r.name));
  for (const retired of Object.keys(RETIRED_CARRIED_ROWS))
    if (!names.has(retired))
      throw new Error(`RETIRED_CARRIED_ROWS names no carried row: ${retired}`);
  return CARRIED_MATRIX_ROWS.filter((r) => !(r.name in RETIRED_CARRIED_ROWS));
}

function buildGateMatrixV2(): unknown {
  const matrix = gateMatrixV2();
  const emitted = new Set(matrix.rows.map((r) => (r as { name: string }).name));
  if (emitted.size !== matrix.rows.length)
    throw new Error("gate-matrix v2 has two rows with one name");
  for (const [name, { successor }] of Object.entries(RETIRED_CARRIED_ROWS))
    if (!emitted.has(successor))
      throw new Error(
        `retired carried row "${name}" names a successor that is not emitted: ${successor}`,
      );
  return matrix;
}

function gateMatrixV2(): {
  gateMatrixVersion: number;
  description: string;
  rows: unknown[];
} {
  return {
    gateMatrixVersion: 2,
    description:
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. The first fourteen rows are corpus v1\'s matrix, carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — and inlined here when corpus v1 was deleted, so a v3 gate that changes any decision v2 made goes red here; a fifteenth carried row, the pre-R3-01 dev-build bypass, was retired by P0-04 and its successor row appended. The next rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on the activation-precedes-blocked row is deliberately NOT the status. The channel rows that follow pin the channel vocabulary of §5.1 (P0-04): header normalisation, the `staging`/`beta` alias, the `pr` family, manual names, `dev`, and the build-implied channel. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape.',
    rows: [
      ...carriedRows(),
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
      ...channelRows(),
    ],
  };
}

// ── stage-matrix v1 (client boot behaviour, outside the wire contract) ───────
// The boot stage machine (`@polaris-key/client-core/stages` and its Python and Swift ports),
// pinned as data. Unsigned, like the gate matrix: it pins a reducer, not a signature. The rows,
// `accepts` and `probes` are literal data built with small step helpers. Nothing here imports
// `client-core`: a golden file that shares code with the implementation it checks cannot catch
// a bug in that shared code. `buildStageMatrixV1` self-checks the rows before writing, so a row
// that contradicts the vocabulary, the `accepts` table or its own stage list fails
// `gen:corpus`.
//
// Append-only, like `CARRIED_MATRIX_ROWS`. Rows that use only v1 semantics keep
// `stageMatrixVersion: 1`; a change to the vocabulary, to `accepts`, to an existing row's
// expectation, or a `canPlayOffline: true` path bumps the version, and the package that does it
// updates every port.

/** `MAX_FAILED_BOOTS`, restated rather than imported (as `MAX_BUNDLE_BYTES` is). */
const STAGE_MAX_FAILED_BOOTS = 2;

/** The nine `LicenseStatus` values, restated from `@polaris-key/protocol/license`. */
const LICENSE_STATUSES = [
  "ok",
  "grace",
  "expired",
  "revoked",
  "needs-activation",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
  "not-applicable",
] as const;

const STAGE_VOCABULARY = {
  stages: [
    "idle",
    "shell",
    "guard",
    "sync",
    "gate",
    "decide",
    "fetch",
    "mount",
    "ready",
    "background",
    "offline",
    "blocked",
    "error",
  ],
  outcomes: ["running", "waiting", "ready", "blocked", "offline", "error"],
  events: [
    "start",
    "shell.done",
    "guard.done",
    "sync.done",
    "sync.timeout",
    "gate.status",
    "decide.done",
    "fetch.done",
    "mount.done",
    "background.start",
    "background.done",
    "retry",
    "play-offline",
    "fail",
  ],
  emits: [
    "stage_changed",
    "waiting",
    "update_available",
    "blocked",
    "offline",
    "error",
    "boot_rolled_back",
    "boot_ready",
  ],
  guardActions: ["none", "apply-staged", "roll-back"],
};

/** The plan's "Accepted in" table. A key is a stage, or `gate:waiting` for the gate while it
 *  waits for the player. */
const STAGE_ACCEPTS: Record<string, string[]> = {
  idle: ["start"],
  shell: ["shell.done", "fail"],
  guard: ["guard.done", "fail"],
  sync: ["sync.done", "sync.timeout", "fail"],
  gate: ["gate.status", "fail"],
  "gate:waiting": ["gate.status", "retry"],
  decide: ["decide.done", "fail"],
  fetch: ["fetch.done", "fail"],
  mount: ["mount.done", "fail"],
  ready: ["background.start"],
  background: ["background.done"],
  offline: ["retry"],
  blocked: ["retry"],
  error: ["retry"],
};

type StageEvent = { type: string } & Record<string, unknown>;
type StageEmit = { type: string } & Record<string, unknown>;
interface StageStep {
  event: StageEvent;
  emits: StageEmit[];
}
interface StageInit {
  allowOffline?: boolean;
  allowGrace?: boolean;
  requiredPacks?: string[];
}
interface StageRow {
  name: string;
  init: StageInit;
  steps: StageStep[];
  expect: { stages: string[]; outcome: string };
}

// Events.
const evStart: StageEvent = { type: "start" };
const evShellDone: StageEvent = { type: "shell.done" };
const evGuard = (result: string): StageEvent => ({
  type: "guard.done",
  result,
});
const evSync = (result: string): StageEvent => ({ type: "sync.done", result });
const evTimeout: StageEvent = { type: "sync.timeout" };
const evGate = (status: string): StageEvent => ({
  type: "gate.status",
  status,
});
const evDecide = (decision: string): StageEvent => ({
  type: "decide.done",
  decision,
});
const evFetch = (result: string, installed: string[]): StageEvent => ({
  type: "fetch.done",
  result,
  installed,
});
const evMountDone: StageEvent = { type: "mount.done" };
const evBackgroundStart: StageEvent = { type: "background.start" };
const evBackgroundDone: StageEvent = { type: "background.done" };
const evRetry: StageEvent = { type: "retry" };
const evPlayOffline: StageEvent = { type: "play-offline" };
const evFail = (code: string): StageEvent => ({ type: "fail", code });

// Emits.
const changed = (stage: string, previous: string): StageEmit => ({
  type: "stage_changed",
  stage,
  previous,
});
const emWaiting = (status: string): StageEmit => ({ type: "waiting", status });
const emBlocked = (reason: string): StageEmit => ({ type: "blocked", reason });
const emOffline: StageEmit = { type: "offline", canPlayOffline: false };
const emError = (code: string): StageEmit => ({ type: "error", code });
const emUpdateAvailable: StageEmit = { type: "update_available" };
const emRolledBack: StageEmit = { type: "boot_rolled_back" };
const emBootReady: StageEmit = { type: "boot_ready" };

const step = (event: StageEvent, ...emits: StageEmit[]): StageStep => ({
  event,
  emits,
});
/** An event the current stage does not accept: it emits nothing. */
const ignored = (event: StageEvent): StageStep => ({ event, emits: [] });

// Shared step runs.
/** `P`: start, shell.done, guard.done with `result` (ok unless a row says otherwise). */
const prefix = (result = "ok"): StageStep[] => [
  step(evStart, changed("shell", "idle")),
  step(evShellDone, changed("guard", "shell")),
  result === "rolled-back"
    ? step(evGuard(result), changed("sync", "guard"), emRolledBack)
    : step(evGuard(result), changed("sync", "guard")),
];
/** A sync result that continues to the gate. */
const toGate = (result: string): StageStep =>
  step(evSync(result), changed("gate", "sync"));
/** A gate status that passes to decide. */
const pass = (status = "ok"): StageStep =>
  step(evGate(status), changed("decide", "gate"));
/** `T`: decide.done none, fetch.done ok [], mount.done. */
const tail = (): StageStep[] => [
  step(evDecide("none"), changed("fetch", "decide")),
  step(evFetch("ok", []), changed("mount", "fetch")),
  step(evMountDone, changed("ready", "mount"), emBootReady),
];

const INIT_D: StageInit = {
  allowOffline: true,
  allowGrace: true,
  requiredPacks: [],
};
const INIT_D_O: StageInit = { ...INIT_D, allowOffline: false };
const INIT_D_G: StageInit = { ...INIT_D, allowGrace: false };
const INIT_D_K: StageInit = { ...INIT_D, requiredPacks: ["core"] };

/** The stages every row except 34 and 35 enters first. */
const S_BASE = ["shell", "guard", "sync"];
/** Row 1's stages: the whole normal path. */
const S_READY = [...S_BASE, "gate", "decide", "fetch", "mount", "ready"];
/** After a retry that resumes at the sync: the normal path from there. */
const S_RESYNC = ["sync", "gate", "decide", "fetch", "mount", "ready"];

function stageRows(): StageRow[] {
  return [
    {
      name: "ready — every stage is entered in order",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — not-applicable passes the gate",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass("not-applicable"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — needs-activation waits for the player, then continues",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        pass(),
        ...tail(),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "waiting — revoked waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "offline — expired without a network cannot continue",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "ready — expired while online waits, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("expired"), emWaiting("expired")),
        step(evRetry, changed("sync", "gate")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "gate", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "blocked — version-too-old requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — channel-not-entitled blocks, and retry continues once entitled",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
        step(evRetry, changed("sync", "blocked")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "blocked", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — by default a sync timeout continues offline and grace passes",
      init: {},
      steps: [
        ...prefix(),
        step(evTimeout, changed("gate", "sync")),
        pass("grace"),
        ...tail(),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — allowGrace false refuses grace offline",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("grace"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "waiting — offline and not yet activated still reaches activation",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "ready — an offline first launch of a config-only product continues on its defaults",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        pass("not-applicable"),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("offline", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a sync error continues from local state",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — allowOffline false stops when the network is unreachable",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evSync("offline"), changed("offline", "sync"), emOffline),
      ],
      expect: { stages: [...S_BASE, "offline"], outcome: "offline" },
    },
    {
      name: "error — allowOffline false stops with sync-failed on a server error",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evSync("error"), changed("error", "sync"), emError("sync-failed")),
      ],
      expect: { stages: [...S_BASE, "error"], outcome: "error" },
    },
    {
      name: "ready — allowOffline false: a timeout stops, play-offline is ignored, retry syncs",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        step(evTimeout, changed("offline", "sync"), emOffline),
        ignored(evPlayOffline),
        step(evRetry, changed("sync", "offline")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "offline", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "ready — an optional update continues and emits update_available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evDecide("optional"),
          changed("fetch", "decide"),
          emUpdateAvailable,
        ),
        step(evFetch("ok", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "blocked — a required update blocks",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evDecide("required"),
          changed("blocked", "decide"),
          emBlocked("update-required"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "blocked"],
        outcome: "blocked",
      },
    },
    {
      name: "ready — a missing required pack is fetched",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("ok", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "offline — a required pack is missing and there is no network",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("offline"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("offline", []), changed("offline", "fetch"), emOffline),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "offline"],
        outcome: "offline",
      },
    },
    {
      name: "error — a required pack is still missing after a failed fetch",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFetch("failed", []),
          changed("error", "fetch"),
          emError("fetch-failed"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error"],
        outcome: "error",
      },
    },
    {
      name: "ready — a failed download never blocks when the required set is present",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("failed", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a rolled-back boot continues and emits boot_rolled_back",
      init: INIT_D,
      steps: [...prefix("rolled-back"), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — an applied staged update continues",
      init: INIT_D,
      steps: [...prefix("applied"), toGate("ok"), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a late sync.timeout after sync.done is ignored",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), ignored(evTimeout), pass(), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — a host failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(evFetch("ok", []), changed("mount", "fetch")),
        step(
          evFail("mount-failed"),
          changed("error", "mount"),
          emError("mount-failed"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          ...S_BASE,
          "gate",
          "decide",
          "fetch",
          "mount",
          "error",
          ...S_RESYNC,
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — background work after ready returns to ready",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        ...tail(),
        step(evBackgroundStart, changed("background", "ready")),
        step(evBackgroundDone, changed("ready", "background")),
      ],
      expect: { stages: [...S_READY, "background", "ready"], outcome: "ready" },
    },
    {
      name: "error — expired after a server error stops with sync-failed",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("expired"),
          changed("error", "gate"),
          emError("sync-failed"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "error"], outcome: "error" },
    },
    {
      name: "running — events outside their stage are ignored mid-boot",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        ignored(evStart),
        ignored(evMountDone),
        step(evShellDone, changed("guard", "shell")),
        ignored(evRetry),
        step(evGuard("ok"), changed("sync", "guard")),
        ignored(evBackgroundDone),
        step(evTimeout, changed("gate", "sync")),
        ignored(evSync("ok")),
        ignored(evRetry),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "running" },
    },
    {
      name: "ready — fail while the gate waits, and fail and retry after ready, are ignored",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        ignored(evFail("activation-failed")),
        pass(),
        ...tail(),
        ignored(evFail("late-failure")),
        ignored(evRetry),
      ],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "error — fetch reports ok but a required pack is still missing",
      init: INIT_D_K,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFetch("ok", []),
          changed("error", "fetch"),
          emError("fetch-failed"),
        ),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error"],
        outcome: "error",
      },
    },
    {
      name: "waiting — allowGrace false holds grace for the player after a sync",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("grace"), emWaiting("grace")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "ready — a shell failure ends in error, and retry runs the shell again",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        step(
          evFail("shell-failed"),
          changed("error", "shell"),
          emError("shell-failed"),
        ),
        step(evRetry, changed("shell", "error")),
        step(evShellDone, changed("guard", "shell")),
        step(evGuard("ok"), changed("sync", "guard")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          "shell",
          "error",
          "shell",
          "guard",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — a guard failure ends in error, and retry runs the guard again",
      init: INIT_D,
      steps: [
        step(evStart, changed("shell", "idle")),
        step(evShellDone, changed("guard", "shell")),
        step(
          evFail("guard-failed"),
          changed("error", "guard"),
          emError("guard-failed"),
        ),
        step(evRetry, changed("guard", "error")),
        step(evGuard("ok"), changed("sync", "guard")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [
          "shell",
          "guard",
          "error",
          "guard",
          "sync",
          "gate",
          "decide",
          "fetch",
          "mount",
          "ready",
        ],
        outcome: "ready",
      },
    },
    {
      name: "ready — a sync failure ends in error even with allowOffline, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        step(
          evFail("sync-exception"),
          changed("error", "sync"),
          emError("sync-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: { stages: [...S_BASE, "error", ...S_RESYNC], outcome: "ready" },
    },
    {
      name: "ready — a gate failure before any status ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(
          evFail("gate-exception"),
          changed("error", "gate"),
          emError("gate-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — a decide failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(
          evFail("decide-exception"),
          changed("error", "decide"),
          emError("decide-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "ready — a fetch failure ends in error, and retry syncs again",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        step(
          evFail("fetch-exception"),
          changed("error", "fetch"),
          emError("fetch-exception"),
        ),
        step(evRetry, changed("sync", "error")),
        toGate("ok"),
        pass(),
        ...tail(),
      ],
      expect: {
        stages: [...S_BASE, "gate", "decide", "fetch", "error", ...S_RESYNC],
        outcome: "ready",
      },
    },
    {
      name: "waiting — revoked without a network waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "blocked — version-too-old without a network still requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new without a network is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — channel-not-entitled without a network is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — not-applicable passes the gate after a server error",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass("not-applicable"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "ready — grace passes the gate after a server error",
      init: INIT_D,
      steps: [...prefix(), toGate("error"), pass("grace"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "error — allowGrace false refuses grace after a server error",
      init: INIT_D_G,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("grace"), changed("error", "gate"), emError("sync-failed")),
      ],
      expect: { stages: [...S_BASE, "gate", "error"], outcome: "error" },
    },
    {
      name: "waiting — needs-activation after a server error still reaches activation",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "waiting — revoked after a server error waits for the player",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(evGate("revoked"), emWaiting("revoked")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
    {
      name: "blocked — version-too-old after a server error requires an update",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("version-too-old"),
          changed("blocked", "gate"),
          emBlocked("update-required"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — version-too-new after a server error is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("version-too-new"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "blocked — channel-not-entitled after a server error is not available",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("error"),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — grace passes the gate after a sync",
      init: INIT_D,
      steps: [...prefix(), toGate("ok"), pass("grace"), ...tail()],
      expect: { stages: S_READY, outcome: "ready" },
    },
    {
      name: "blocked — a gate that waits for the player still blocks on channel-not-entitled",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(
          evGate("channel-not-entitled"),
          changed("blocked", "gate"),
          emBlocked("not-available"),
        ),
      ],
      expect: { stages: [...S_BASE, "gate", "blocked"], outcome: "blocked" },
    },
    {
      name: "offline — a gate that waits without a network still stops on expired",
      init: INIT_D,
      steps: [
        ...prefix(),
        toGate("offline"),
        step(evGate("needs-activation"), emWaiting("needs-activation")),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "offline — expired after a sync timeout stops as offline, not as sync-failed",
      init: INIT_D,
      steps: [
        ...prefix(),
        step(evTimeout, changed("gate", "sync")),
        step(evGate("expired"), changed("offline", "gate"), emOffline),
      ],
      expect: { stages: [...S_BASE, "gate", "offline"], outcome: "offline" },
    },
    {
      name: "waiting — allowOffline false does not change the gate: expired after a sync waits",
      init: INIT_D_O,
      steps: [
        ...prefix(),
        toGate("ok"),
        step(evGate("expired"), emWaiting("expired")),
      ],
      expect: { stages: [...S_BASE, "gate"], outcome: "waiting" },
    },
  ];
}

/** The boot guard's launch decision, G1–G7. */
const STAGE_GUARD_CASES = [
  {
    name: "none — nothing staged and no failed boots",
    input: { staged: false, failedBoots: 0 },
    expect: { action: "none" },
  },
  {
    name: "apply-staged — a staged update is applied",
    input: { staged: true, failedBoots: 0 },
    expect: { action: "apply-staged" },
  },
  {
    name: "none — one failed boot does not roll back",
    input: { staged: false, failedBoots: 1 },
    expect: { action: "none" },
  },
  {
    name: "apply-staged — a staged update replaces a slot with one failure",
    input: { staged: true, failedBoots: 1 },
    expect: { action: "apply-staged" },
  },
  {
    name: "roll-back — two failed boots roll back",
    input: { staged: false, failedBoots: 2 },
    expect: { action: "roll-back" },
  },
  {
    name: "roll-back — a rollback takes precedence over a staged update",
    input: { staged: true, failedBoots: 2 },
    expect: { action: "roll-back" },
  },
  {
    name: "roll-back — more than two failed boots still roll back",
    input: { staged: false, failedBoots: 3 },
    expect: { action: "roll-back" },
  },
];

/** One well-formed event per vocabulary event type, in vocabulary order. */
const STAGE_PROBES: StageEvent[] = [
  evStart,
  evShellDone,
  evGuard("ok"),
  evSync("ok"),
  evTimeout,
  evGate("ok"),
  evDecide("none"),
  evFetch("ok", []),
  evMountDone,
  evBackgroundStart,
  evBackgroundDone,
  evRetry,
  evPlayOffline,
  evFail("probe"),
];

/** Throws unless the rows agree with the vocabulary, `accepts`, their own stage lists, and
 *  cover every cell of the plan's sync and gate tables. Nothing here computes an expectation:
 *  it only checks the hand-authored ones against each other. */
function checkStageMatrix(
  rows: StageRow[],
  guardCases: typeof STAGE_GUARD_CASES,
): void {
  const fail = (msg: string): never => {
    throw new Error(`stage-matrix: ${msg}`);
  };
  const v = STAGE_VOCABULARY;
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  // accepts: exactly the 13 stages plus gate:waiting, listing vocabulary events only.
  const keys = [...v.stages, "gate:waiting"];
  if (!same(Object.keys(STAGE_ACCEPTS).sort(), [...keys].sort()))
    fail("accepts must have the 13 stages and gate:waiting as its keys");
  for (const [key, events] of Object.entries(STAGE_ACCEPTS))
    for (const e of events)
      if (!v.events.includes(e)) fail(`accepts.${key} lists unknown ${e}`);
  // probes: one per vocabulary event type, in order.
  if (
    !same(
      STAGE_PROBES.map((p) => p.type),
      v.events,
    )
  )
    fail("probes must hold one event per vocabulary event type, in order");

  const used = {
    stages: new Set<string>(),
    outcomes: new Set<string>(),
    events: new Set<string>(),
    emits: new Set<string>(),
    statuses: new Set<string>(),
  };
  const acceptCells = new Set<string>();
  const syncCells = new Set<string>();
  const gateCells = new Set<string>();
  const names = new Set<string>();
  const finalOutcomes: Record<string, string[]> = {
    idle: ["running"],
    shell: ["running"],
    guard: ["running"],
    sync: ["running"],
    gate: ["running", "waiting"],
    decide: ["running"],
    fetch: ["running"],
    mount: ["running"],
    ready: ["ready"],
    background: ["ready"],
    offline: ["offline"],
    blocked: ["blocked"],
    error: ["error"],
  };

  for (const row of rows) {
    if (names.has(row.name)) fail(`duplicate row name: ${row.name}`);
    names.add(row.name);
    const allowOffline = row.init.allowOffline ?? true;
    const allowGrace = row.init.allowGrace ?? true;
    let key = "idle";
    let sync = "pending";
    const stages: string[] = [];
    for (const [i, s] of row.steps.entries()) {
      const where = `${row.name}, step ${i + 1}`;
      const type = s.event.type;
      if (!v.events.includes(type)) fail(`${where}: unknown event ${type}`);
      used.events.add(type);
      const accepted = STAGE_ACCEPTS[key]!.includes(type);
      if (accepted !== s.emits.length > 0)
        fail(
          `${where}: ${type} in ${key} must ${accepted ? "emit something" : "emit nothing"}`,
        );
      if (!accepted) continue;
      acceptCells.add(`${key}|${type}`);
      if (type === "sync.done" || type === "sync.timeout") {
        const result = type === "sync.timeout" ? "timeout" : s.event.result;
        syncCells.add(`${result}|${allowOffline}`);
        sync = result === "timeout" ? "offline" : String(s.event.result);
      }
      if (type === "gate.status") {
        const status = String(s.event.status);
        used.statuses.add(status);
        const cls = status === "grace" ? `grace:${allowGrace}` : status;
        gateCells.add(`${cls}|${sync}`);
      }
      for (const [j, em] of s.emits.entries()) {
        if (!v.emits.includes(em.type))
          fail(`${where}: unknown emit ${em.type}`);
        used.emits.add(em.type);
        if (em.type === "stage_changed") {
          if (j !== 0) fail(`${where}: stage_changed must come first`);
          const stage = String(em.stage);
          if (!v.stages.includes(stage)) fail(`${where}: unknown ${stage}`);
          if (em.previous !== (key === "gate:waiting" ? "gate" : key))
            fail(`${where}: stage_changed.previous must be ${key}`);
          used.stages.add(stage);
          used.stages.add(String(em.previous));
          stages.push(stage);
          key = stage;
        } else if (j > 1 || (j === 1 && s.emits[0]!.type !== "stage_changed")) {
          fail(`${where}: at most one emit besides stage_changed`);
        }
        if (em.type === "waiting") {
          if (key !== "gate" && key !== "gate:waiting")
            fail(`${where}: waiting outside the gate`);
          key = "gate:waiting";
        }
      }
    }
    if (!same(stages, row.expect.stages))
      fail(`${row.name}: expect.stages differs from the stage_changed emits`);
    const final = stages[stages.length - 1] ?? "idle";
    if (!finalOutcomes[final]!.includes(row.expect.outcome))
      fail(`${row.name}: ${final} cannot end ${row.expect.outcome}`);
    if (
      final === "gate" &&
      (row.expect.outcome === "waiting") !== (key === "gate:waiting")
    )
      fail(`${row.name}: the gate's outcome disagrees with its waiting emit`);
    used.outcomes.add(row.expect.outcome);
  }

  const guardActions = new Set(guardCases.map((c) => c.expect.action));
  for (const [list, set] of [
    [v.stages, used.stages],
    [v.outcomes, used.outcomes],
    [v.events, used.events],
    [v.emits, used.emits],
    [v.guardActions, guardActions],
    [LICENSE_STATUSES, used.statuses],
  ] as const)
    for (const entry of list)
      if (!set.has(entry)) fail(`${entry} is used by no row or case`);
  for (const action of guardActions)
    if (!v.guardActions.includes(action))
      fail(`unknown guard action ${action}`);

  for (const [key, events] of Object.entries(STAGE_ACCEPTS))
    for (const e of events)
      if (!acceptCells.has(`${key}|${e}`))
        fail(`no row step takes the accepts cell ${key} × ${e}`);
  for (const result of ["ok", "offline", "error", "timeout"])
    for (const allow of [true, false])
      if (!syncCells.has(`${result}|${allow}`))
        fail(`no row takes the sync cell ${result}, allowOffline ${allow}`);
  const gateClasses = [
    ...LICENSE_STATUSES.filter((s) => s !== "grace"),
    "grace:true",
    "grace:false",
  ];
  for (const cls of gateClasses)
    for (const sync of ["ok", "offline", "error"])
      if (!gateCells.has(`${cls}|${sync}`))
        fail(`no row takes the gate cell ${cls} after sync ${sync}`);
}

function buildStageMatrixV1(): unknown {
  const rows = stageRows();
  checkStageMatrix(rows, STAGE_GUARD_CASES);
  return {
    stageMatrixVersion: 1,
    description:
      "The boot stage machine (client boot behaviour, outside the wire contract), owned by `@polaris-key/client-core/stages` and ported to every SDK. Each row starts from `initialBootState(init)` (an omitted option takes its default: allowOffline true, allowGrace true, requiredPacks []) and feeds `bootTransition` its steps in order; each step lists the exact emits that event produces, `stage_changed` first. `expect.stages` is every stage entered, in order, and its last entry is the final stage; `expect.outcome` is the final outcome. Events are dotted, emits snake_case, payload keys camelCase and payload values kebab-case. An event the current stage does not accept, or a malformed one, is ignored: the state comes back unchanged with no emits. `accepts` lists what each stage accepts (`gate:waiting` is the gate while it waits for the player), and a runner sends every probe at the initial state and after every step of every row, asserting an unchanged state and no emits exactly when the probe's type is not accepted there. `guardCases` pin `bootGuardAction`, which rolls back at `maxFailedBoots`. Append-only: a change to the vocabulary, to `accepts` or to an existing row's expectation bumps `stageMatrixVersion`.",
    maxFailedBoots: STAGE_MAX_FAILED_BOOTS,
    vocabulary: STAGE_VOCABULARY,
    accepts: STAGE_ACCEPTS,
    probes: STAGE_PROBES,
    rows,
    guardCases: STAGE_GUARD_CASES,
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

// ── Fingerprint component derivations (WIRE-CONTRACT-V3 §6.1, P1b-09) ───────────────────────
// The three source rules every native SDK must follow when it READS a component, pinned as
// pure input → output cases: the Windows CIM parser (rule 1), the Linux anchor selection
// (rule 2) and the RAM bucket (rule 3). Each case states its expected output literally; the
// generator-local reference functions below re-derive every one and generation fails on any
// disagreement, so a typo in a hand-written expectation cannot ship.

/** One line with no double quotes (Windows argument quoting cannot mangle it), emitting pure
 *  ASCII (a console code page or a missing console cannot corrupt a value). `[-1]` takes the
 *  last instance, which is the row the old `wmic … /format:csv` parser took; each query has
 *  its own `try`, so a failing class costs only its own component. */
const WINDOWS_CIM_SCRIPT =
  "$ErrorActionPreference='Stop';$b=$null;$m=$null;" +
  "try{$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};" +
  "try{$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};" +
  "$j=ConvertTo-Json -Compress -InputObject @{boardSerial=$b;machineModel=$m};" +
  "$o='';foreach($c in $j.ToCharArray()){$n=[int]$c;if($n -gt 126){$o+='\\u'+$n.ToString('x4')}else{$o+=$c}};$o";

const WINDOWS_CIM_COMMAND = {
  program: "powershell.exe",
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_CIM_SCRIPT,
  ],
  stdin: "null",
  timeoutMs: 10000,
};

/** Rules 1 and 2 trim exactly these: U+0009–U+000D and U+0020. Nothing else. */
const ASCII_WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function refTrimAscii(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WS.has(value.charCodeAt(start))) start++;
  while (end > start && ASCII_WS.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

type WindowsCimExpected = { boardSerial?: string; machineModel?: string };

function refParseWindowsCim(stdout: string): WindowsCimExpected {
  const text = stdout.startsWith("\uFEFF") ? stdout.slice(1) : stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  const out: WindowsCimExpected = {};
  for (const key of ["boardSerial", "machineModel"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const trimmed = refTrimAscii(value);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

const LINUX_ANCHOR_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

type LinuxAnchorExpected = { source: string; value: string } | null;

function refLinuxAnchor(files: Record<string, string>): LinuxAnchorExpected {
  for (const source of LINUX_ANCHOR_PATHS) {
    const content = files[source];
    if (content === undefined) continue;
    const value = refTrimAscii(content);
    if (value && value !== "uninitialized") return { source, value };
  }
  return null;
}

/** Integer-exact over BigInt: `g = floor(bytes / 2^30)`, then the largest power of two not
 *  above `g`; omitted when `g = 0`. Dividing BEFORE any logarithm is the whole point. */
function refRamBucket(bytes: number): string | null {
  let g = BigInt(bytes) >> 30n;
  if (g === 0n) return null;
  let p = 1n;
  while (g > 1n) {
    g >>= 1n;
    p <<= 1n;
  }
  return p.toString();
}

const BOTH_CIM =
  '{"boardSerial":"/8YHTG2/CN1234567890/","machineModel":"XPS 15 9530"}';
const BOTH_EXPECTED: WindowsCimExpected = {
  boardSerial: "/8YHTG2/CN1234567890/",
  machineModel: "XPS 15 9530",
};

const WINDOWS_CIM_CASES: {
  id: string;
  description: string;
  stdout: string;
  expected: WindowsCimExpected;
}[] = [
  {
    id: "both",
    description:
      "The script's normal output, CRLF-terminated: both components.",
    stdout: `${BOTH_CIM}\r\n`,
    expected: BOTH_EXPECTED,
  },
  {
    id: "padded",
    description:
      "Leading and trailing spaces are trimmed; inner spaces are kept.",
    stdout:
      '{"boardSerial":"  PF2ABCDE  ","machineModel":"ThinkPad X1 Carbon Gen 11 "}',
    expected: {
      boardSerial: "PF2ABCDE",
      machineModel: "ThinkPad X1 Carbon Gen 11",
    },
  },
  {
    id: "placeholder-kept",
    description:
      "Vendor placeholders are kept verbatim, as wmic returned them; they are not this rule's to judge.",
    stdout:
      '{"boardSerial":"To be filled by O.E.M.","machineModel":"System Product Name"}',
    expected: {
      boardSerial: "To be filled by O.E.M.",
      machineModel: "System Product Name",
    },
  },
  {
    id: "serial-null",
    description: "A null value yields no component; the other is kept.",
    stdout: '{"boardSerial":null,"machineModel":"Surface Laptop 5"}',
    expected: { machineModel: "Surface Laptop 5" },
  },
  {
    id: "empty-and-blank",
    description:
      "An empty string, and one that is blank after trimming, yield nothing.",
    stdout: '{"boardSerial":"","machineModel":" \\t "}',
    expected: {},
  },
  {
    id: "non-ascii-space-kept",
    description:
      "Only U+0009–U+000D and U+0020 are trimmed: U+000B and U+000C go, U+00A0 and U+001F stay. A language's default trim fails this case.",
    stdout:
      '{"boardSerial":"\\u000b\\u00a0PF2ABCDE\\u001f\\u000c","machineModel":"\\u001fThinkPad X1\\u00a0"}',
    expected: {
      boardSerial: "\u00a0PF2ABCDE\u001f",
      machineModel: "\u001fThinkPad X1\u00a0",
    },
  },
  {
    id: "key-order",
    description: "Key order does not matter.",
    stdout: '{"machineModel":"OptiPlex 7090","boardSerial":"7XYZ123"}',
    expected: { boardSerial: "7XYZ123", machineModel: "OptiPlex 7090" },
  },
  {
    id: "pretty",
    description: "Indented JSON over four lines parses the same.",
    stdout:
      '{\r\n    "boardSerial":  "/8YHTG2/CN1234567890/",\r\n    "machineModel":  "XPS 15 9530"\r\n}\r\n',
    expected: BOTH_EXPECTED,
  },
  {
    id: "bom",
    description: "One leading U+FEFF is stripped before parsing.",
    stdout: `\uFEFF${BOTH_CIM}`,
    expected: BOTH_EXPECTED,
  },
  {
    id: "json-escapes",
    description:
      "JSON escapes decode (PowerShell 5.1 escapes &, < and >); a missing key yields no component.",
    stdout: '{"machineModel":"Dell \\u0026 Co \\u003cX\\u003e"}',
    expected: { machineModel: "Dell & Co <X>" },
  },
  {
    id: "escaped-non-ascii",
    description:
      "Non-ASCII as the script emits it, escaped, decodes to the value.",
    stdout: '{"machineModel":"Mod\\u00e8le \\u2014 \\u65e5\\u672c"}',
    expected: { machineModel: "Modèle — 日本" },
  },
  {
    id: "raw-non-ascii",
    description: "Unescaped non-ASCII, decoded as UTF-8, gives the same value.",
    stdout: '{"machineModel":"Modèle — 日本"}',
    expected: { machineModel: "Modèle — 日本" },
  },
  {
    id: "unknown-keys",
    description: "Keys other than the two components are ignored.",
    stdout: '{"boardSerial":"A1","machineModel":"B2","extra":"C3"}',
    expected: { boardSerial: "A1", machineModel: "B2" },
  },
  {
    id: "non-string",
    description: "A value that is not a string yields no component.",
    stdout: '{"boardSerial":12345,"machineModel":true}',
    expected: {},
  },
  {
    id: "not-an-object",
    description: "Valid JSON that is not an object yields nothing.",
    stdout: '["A1","B2"]',
    expected: {},
  },
  {
    id: "error-text",
    description: "Output that is not JSON yields nothing.",
    stdout: "Get-CimInstance : Access denied\r\n",
    expected: {},
  },
  {
    id: "empty",
    description: "No output yields nothing.",
    stdout: "",
    expected: {},
  },
];

const MACHINE_ID = "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c";
const DBUS_MACHINE_ID = "e3b0c44298fc1c149afbf4c8996fb924";
const DMI_FILES = {
  "/sys/class/dmi/id/product_uuid": "4C4C4544-0042-3510-8048-B4C04F4E3732\n",
  "/sys/class/dmi/id/board_serial": ".CN1234567890.\n",
};

const LINUX_ANCHOR_CASES: {
  id: string;
  description: string;
  files: Record<string, string>;
  expected: LinuxAnchorExpected;
}[] = [
  {
    id: "root",
    description:
      "Root can read the DMI files too; they are never read, so the anchor is /etc/machine-id.",
    files: {
      ...DMI_FILES,
      "/etc/machine-id": `${MACHINE_ID}\n`,
      "/var/lib/dbus/machine-id": `${MACHINE_ID}\n`,
    },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "unprivileged",
    description:
      "The same host without root yields the same source and value as `root`.",
    files: {
      "/etc/machine-id": `${MACHINE_ID}\n`,
      "/var/lib/dbus/machine-id": `${MACHINE_ID}\n`,
    },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "product-uuid-only",
    description:
      "Root on a host with no machine-id, such as a container: no anchor (P1b-09 plan D3).",
    files: { ...DMI_FILES },
    expected: null,
  },
  {
    id: "etc-missing",
    description: "No /etc/machine-id: the dbus file is the anchor.",
    files: { "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n` },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "etc-empty",
    description:
      "A blank /etc/machine-id is skipped. Trim first: a reader that tests for emptiness before trimming picks it and fails.",
    files: {
      "/etc/machine-id": " \n",
      "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n`,
    },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "etc-uninitialized",
    description: "`uninitialized` (systemd's first-boot marker) is skipped.",
    files: {
      "/etc/machine-id": "uninitialized\n",
      "/var/lib/dbus/machine-id": `${DBUS_MACHINE_ID}\n`,
    },
    expected: { source: "/var/lib/dbus/machine-id", value: DBUS_MACHINE_ID },
  },
  {
    id: "all-uninitialized",
    description:
      "Both files `uninitialized`: no anchor, never a literal shared by every such host.",
    files: {
      "/etc/machine-id": "uninitialized\n",
      "/var/lib/dbus/machine-id": "uninitialized\n",
    },
    expected: null,
  },
  {
    id: "whitespace",
    description: "Surrounding ASCII whitespace, CRLF included, is trimmed.",
    files: { "/etc/machine-id": `  ${MACHINE_ID}  \r\n` },
    expected: { source: "/etc/machine-id", value: MACHINE_ID },
  },
  {
    id: "nbsp-kept",
    description:
      "Only U+0009–U+000D and U+0020 are trimmed: U+000C, U+000B and the newline go, U+001F and U+00A0 stay.",
    files: {
      "/etc/machine-id":
        "\u000c\u001f4e1d2c3b4a5968778695a4b3c2d1e0a9\u00a0\u000b\n",
    },
    expected: {
      source: "/etc/machine-id",
      value: "\u001f4e1d2c3b4a5968778695a4b3c2d1e0a9\u00a0",
    },
  },
  {
    id: "nothing",
    description: "No readable file: no anchor.",
    files: {},
    expected: null,
  },
];

const RAM_BUCKET_CASES: {
  id: string;
  description: string;
  bytes: number;
  bucket: string | null;
}[] = [
  { id: "zero", description: "Zero bytes: omitted.", bytes: 0, bucket: null },
  {
    id: "half-gib",
    description: "Below 1 GiB: omitted, never `0.5`.",
    bytes: 536870912,
    bucket: null,
  },
  {
    id: "just-under-1gib",
    description: "One byte under 1 GiB: omitted.",
    bytes: 1073741823,
    bucket: null,
  },
  { id: "1gib", description: "Exactly 1 GiB.", bytes: 1073741824, bucket: "1" },
  {
    id: "just-under-2gib",
    description: "One byte under 2 GiB stays in the 1 bucket.",
    bytes: 2147483647,
    bucket: "1",
  },
  { id: "2gib", description: "Exactly 2 GiB.", bytes: 2147483648, bucket: "2" },
  {
    id: "linux-16gb-memtotal",
    description:
      "A 16 GB Linux MemTotal (about 15.4 GiB) buckets to 8, not 16.",
    bytes: 16496934912,
    bucket: "8",
  },
  {
    id: "16gib",
    description: "Exactly 16 GiB.",
    bytes: 17179869184,
    bucket: "16",
  },
  {
    id: "windows-32gb-total",
    description: "A 32 GB Windows total (about 31.9 GiB) buckets to 16.",
    bytes: 34200436736,
    bucket: "16",
  },
  {
    id: "64gib",
    description: "Exactly 64 GiB.",
    bytes: 68719476736,
    bucket: "64",
  },
  {
    id: "1tib",
    description: "Exactly 1 TiB.",
    bytes: 1099511627776,
    bucket: "1024",
  },
  {
    id: "6tib",
    description: "6 TiB is not a power of two: 4096.",
    bytes: 6597069766656,
    bucket: "4096",
  },
  {
    id: "just-under-1pib",
    description:
      "One byte under 1 PiB. A float log2(bytes / 2^30) rounds this up to 1048576; dividing first gives 524288.",
    bytes: 1125899906842623,
    bucket: "524288",
  },
];

function selfCheckDerivations(): void {
  const fail = (section: string, id: string): never => {
    throw new Error(`corpus self-check failed: ${section}/${id}`);
  };
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const c of WINDOWS_CIM_CASES) {
    const got = refParseWindowsCim(c.stdout);
    // Compare per key so key order in the literal cannot matter.
    if (
      got.boardSerial !== c.expected.boardSerial ||
      got.machineModel !== c.expected.machineModel ||
      Object.keys(got).length !== Object.keys(c.expected).length
    )
      fail("windowsCim", c.id);
  }
  for (const c of LINUX_ANCHOR_CASES)
    if (!same(refLinuxAnchor(c.files), c.expected)) fail("linuxAnchor", c.id);
  for (const c of RAM_BUCKET_CASES) {
    if (!Number.isSafeInteger(c.bytes)) fail("ramBuckets", c.id);
    if (refRamBucket(c.bytes) !== c.bucket) fail("ramBuckets", c.id);
  }
}

function buildFingerprintCorpus(): unknown {
  selfCheckDerivations();

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
    windowsCimCommand: WINDOWS_CIM_COMMAND,
    windowsCim: WINDOWS_CIM_CASES,
    linuxAnchor: LINUX_ANCHOR_CASES,
    ramBuckets: RAM_BUCKET_CASES,
  };
}

// ── Client metadata header values (headers.json) ─────────────────────────────
// WIRE-CONTRACT-V3 §5.2. One row per SPELLING a runtime reports, not per SDK: every SDK and the
// Worker run every row through the same lookup (fold ASCII A–Z, no trimming, own entries only),
// so rows that describe one machine agree by construction and a later SDK reuses them without a
// corpus change. `expect: null` means the spelling has no value: an SDK omits the header, and the
// Worker stores `raw` as sent (nothing, for an empty `raw`).
//
// THE ROWS ARE THE TABLES. `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` (`@polaris-key/protocol/core`,
// generated into every SDK) hold exactly the folded `raw` of the non-null rows, and every runner
// asserts its own table equals the map derived from them — so a spelling cannot enter or leave a
// table without a case here. The self-check below ties each canonical value to
// conformance/parity/enums.json, so adding a vocabulary value needs a corpus case (and a plan).

interface HeaderCase {
  id: string;
  description: string;
  raw: string;
  expect: string | null;
}

const PLATFORM_CASES: HeaderCase[] = [
  {
    id: "rust-macos",
    description:
      "Rust std::env::consts::OS on macOS; the canonical value maps to itself.",
    raw: "macos",
    expect: "macos",
  },
  {
    id: "godot-swift-macos",
    description: "Godot OS.get_name() and Swift's os(macOS) token.",
    raw: "macOS",
    expect: "macos",
  },
  {
    id: "node-darwin",
    description:
      "Node os.platform() on macOS; the old Node, Python and Swift header.",
    raw: "darwin",
    expect: "macos",
  },
  {
    id: "python-darwin",
    description: "Python platform.system() on macOS.",
    raw: "Darwin",
    expect: "macos",
  },
  {
    id: "swift-mac-catalyst",
    description:
      "Swift's targetEnvironment(macCatalyst): a Catalyst build sends macos.",
    raw: "macCatalyst",
    expect: "macos",
  },
  {
    id: "swift-legacy-ios",
    description: "The old Swift header; the canonical value maps to itself.",
    raw: "ios",
    expect: "ios",
  },
  {
    id: "godot-swift-python-ios",
    description:
      "Godot OS.get_name(), Swift's os(iOS) and Python 3.13+ on iOS.",
    raw: "iOS",
    expect: "ios",
  },
  {
    id: "python-ipados",
    description: "Python 3.13+ platform.system() on an iPad: iPadOS is ios.",
    raw: "iPadOS",
    expect: "ios",
  },
  {
    id: "node-android",
    description:
      "Node os.platform() on Android; the canonical value maps to itself.",
    raw: "android",
    expect: "android",
  },
  {
    id: "godot-python-android",
    description: "Godot OS.get_name() and Python 3.13+ on Android.",
    raw: "Android",
    expect: "android",
  },
  {
    id: "python-legacy-windows",
    description:
      "The old Python header (platform.system().lower()); the canonical value maps to itself.",
    raw: "windows",
    expect: "windows",
  },
  {
    id: "python-godot-swift-windows",
    description:
      "Python platform.system(), Godot OS.get_name() and Swift's os(Windows).",
    raw: "Windows",
    expect: "windows",
  },
  {
    id: "node-win32",
    description:
      "Node os.platform() on Windows; the old Node and Swift header.",
    raw: "win32",
    expect: "windows",
  },
  {
    id: "node-linux",
    description:
      "Node os.platform() on Linux; the canonical value maps to itself.",
    raw: "linux",
    expect: "linux",
  },
  {
    id: "python-godot-linux",
    description:
      "Python platform.system(), Godot OS.get_name() and Swift's os(Linux).",
    raw: "Linux",
    expect: "linux",
  },
  {
    id: "ascii-fold-upper-case-linux",
    description:
      "Folding is ASCII A-Z only: a Turkish-locale lowercase would give a dotless i and miss.",
    raw: "LINUX",
    expect: "linux",
  },
  {
    id: "react-web",
    description:
      "The React browser adapter; the canonical value maps to itself.",
    raw: "web",
    expect: "web",
  },
  {
    id: "godot-web-export",
    description: "Godot OS.get_name() in a web export.",
    raw: "Web",
    expect: "web",
  },
  {
    id: "react-legacy-browser",
    description: "The old React header.",
    raw: "browser",
    expect: "web",
  },
  {
    id: "python-freebsd",
    description:
      "Python platform.system() on FreeBSD: no value, so the header is omitted.",
    raw: "FreeBSD",
    expect: null,
  },
  {
    id: "node-freebsd",
    description: "Node os.platform() on FreeBSD: no value.",
    raw: "freebsd",
    expect: null,
  },
  {
    id: "node-sunos",
    description: "Node os.platform() on illumos and Solaris: no value.",
    raw: "sunos",
    expect: null,
  },
  {
    id: "node-cygwin",
    description: "Node os.platform() under Cygwin: no value.",
    raw: "cygwin",
    expect: null,
  },
  {
    id: "pyodide-emscripten",
    description: "Python platform.system() under Pyodide: no value.",
    raw: "Emscripten",
    expect: null,
  },
  {
    id: "swift-visionos",
    description:
      "Swift's os(visionOS): no value until a spelling and a case add one.",
    raw: "visionOS",
    expect: null,
  },
  {
    id: "swift-tvos",
    description: "Swift's os(tvOS): no value.",
    raw: "tvOS",
    expect: null,
  },
  {
    id: "swift-legacy-unknown",
    description: "The old Swift fallback: never sent, and no value.",
    raw: "unknown",
    expect: null,
  },
  {
    id: "python-undeterminable-empty",
    description:
      "Python platform.system() when the OS cannot be determined: no value, and the Worker treats an empty header as absent.",
    raw: "",
    expect: null,
  },
  {
    id: "no-trimming-leading-space",
    description: "The lookup does not trim.",
    raw: " linux",
    expect: null,
  },
  {
    id: "prototype-constructor",
    description: "The lookup reads the table's own entries only.",
    raw: "constructor",
    expect: null,
  },
  {
    id: "prototype-proto",
    description: "The lookup reads the table's own entries only.",
    raw: "__proto__",
    expect: null,
  },
];

const ARCH_CASES: HeaderCase[] = [
  {
    id: "python-swift-godot-x86-64",
    description:
      "Python platform.machine() on Linux and macOS, Swift's arch(x86_64), Godot and Rust; the canonical value maps to itself.",
    raw: "x86_64",
    expect: "x86_64",
  },
  {
    id: "ascii-fold-upper-case-x86-64",
    description: "Folding is ASCII A-Z only.",
    raw: "X86_64",
    expect: "x86_64",
  },
  {
    id: "node-x64",
    description: "Node os.arch() and .NET; the old Node header.",
    raw: "x64",
    expect: "x86_64",
  },
  {
    id: "jvm-amd64",
    description: "The JVM's os.arch.",
    raw: "amd64",
    expect: "x86_64",
  },
  {
    id: "python-windows-amd64",
    description: "Python platform.machine() on Windows; the old Python header.",
    raw: "AMD64",
    expect: "x86_64",
  },
  {
    id: "node-swift-godot-arm64",
    description:
      "Node os.arch(), Python on macOS, Swift's arch(arm64) and Godot; the canonical value maps to itself.",
    raw: "arm64",
    expect: "arm64",
  },
  {
    id: "python-windows-arm64",
    description: "Python platform.machine() on Windows on Arm.",
    raw: "ARM64",
    expect: "arm64",
  },
  {
    id: "python-linux-aarch64",
    description:
      "Python platform.machine() on Linux, Rust and the JVM; the old Python header.",
    raw: "aarch64",
    expect: "arm64",
  },
  {
    id: "android-abi-arm64-v8a",
    description: "An Android ABI name.",
    raw: "arm64-v8a",
    expect: "arm64",
  },
  {
    id: "canonical-armv7",
    description: "The canonical value maps to itself.",
    raw: "armv7",
    expect: "armv7",
  },
  {
    id: "python-armv7l",
    description: "Python platform.machine() on a 32-bit Arm Linux board.",
    raw: "armv7l",
    expect: "armv7",
  },
  {
    id: "linux-armv8l",
    description: "A 32-bit userland on a 64-bit Arm kernel.",
    raw: "armv8l",
    expect: "armv7",
  },
  {
    id: "node-arm",
    description:
      "Node os.arch(), Rust and .NET on 32-bit Arm, whose official builds are ARMv7.",
    raw: "arm",
    expect: "armv7",
  },
  {
    id: "godot-arm32",
    description: "Godot Engine.get_architecture_name() on 32-bit Arm.",
    raw: "arm32",
    expect: "armv7",
  },
  {
    id: "android-abi-armeabi-v7a",
    description: "An Android ABI name.",
    raw: "armeabi-v7a",
    expect: "armv7",
  },
  {
    id: "godot-rust-wasm32",
    description:
      "Godot's web export and Rust; the canonical value maps to itself. A browser's JavaScript has no arch and sends none.",
    raw: "wasm32",
    expect: "wasm32",
  },
  {
    id: "node-ia32",
    description:
      "Node os.arch() on 32-bit x86: no value, so the header is omitted.",
    raw: "ia32",
    expect: null,
  },
  {
    id: "dotnet-rust-x86",
    description: ".NET, Rust and Android on 32-bit x86: no value.",
    raw: "x86",
    expect: null,
  },
  {
    id: "python-i686",
    description: "Python platform.machine() on 32-bit x86: no value.",
    raw: "i686",
    expect: null,
  },
  {
    id: "godot-x86-32",
    description:
      "Godot Engine.get_architecture_name() on 32-bit x86: no value.",
    raw: "x86_32",
    expect: null,
  },
  {
    id: "python-armv6l",
    description:
      "Python platform.machine() on ARMv6, where armv7 builds do not run: no value.",
    raw: "armv6l",
    expect: null,
  },
  {
    id: "riscv64",
    description: "RISC-V: no value until a spelling and a case add one.",
    raw: "riscv64",
    expect: null,
  },
  {
    id: "wasm64",
    description: "64-bit WebAssembly: no value.",
    raw: "wasm64",
    expect: null,
  },
  {
    id: "watchos-arm64-32",
    description: "watchOS's arm64_32: no value.",
    raw: "arm64_32",
    expect: null,
  },
  {
    id: "artifact-universal",
    description: "An artifact value, never a header value.",
    raw: "universal",
    expect: null,
  },
  {
    id: "artifact-any",
    description: "An artifact value, never a header value.",
    raw: "any",
    expect: null,
  },
  {
    id: "unknown",
    description: "No value.",
    raw: "unknown",
    expect: null,
  },
  {
    id: "empty",
    description: "No value, and the Worker treats an empty header as absent.",
    raw: "",
    expect: null,
  },
  {
    id: "no-trimming-trailing-space",
    description: "The lookup does not trim.",
    raw: "x86_64 ",
    expect: null,
  },
  {
    id: "prototype-constructor",
    description: "The lookup reads the table's own entries only.",
    raw: "constructor",
    expect: null,
  },
  {
    id: "prototype-proto",
    description: "The lookup reads the table's own entries only.",
    raw: "__proto__",
    expect: null,
  },
];

/** ASCII case folding: A–Z become a–z, every other code unit is unchanged (§5.2 rule 1). */
function refFoldAscii(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : raw[i];
  }
  return out;
}

/** The canonical vocabulary, read from the registry the generated constants come from. */
function readParityEnum(name: string): string[] {
  const enums = JSON.parse(
    readFileSync(
      join(HERE, "..", "conformance", "parity", "enums.json"),
      "utf8",
    ),
  ) as { enums: { name: string; values: string[] }[] };
  const found = enums.enums.find((e) => e.name === name);
  if (!found) throw new Error(`conformance/parity/enums.json has no ${name}`);
  return found.values;
}

function checkHeaderSection(
  section: string,
  rows: HeaderCase[],
  vocabulary: string[],
): void {
  const fail = (id: string, why: string): never => {
    throw new Error(
      `corpus self-check failed: headers/${section}/${id}: ${why}`,
    );
  };
  const ids = new Set<string>();
  const byFolded = new Map<string, string | null>();
  for (const row of rows) {
    if (ids.has(row.id)) fail(row.id, "duplicate id");
    ids.add(row.id);
    const folded = refFoldAscii(row.raw);
    if (byFolded.has(folded) && byFolded.get(folded) !== row.expect)
      fail(
        row.id,
        `folds to "${folded}" like another row, with another expect`,
      );
    byFolded.set(folded, row.expect);
    if (row.expect === null) continue;
    if (!vocabulary.includes(row.expect))
      fail(row.id, `"${row.expect}" is not a value of the enum`);
    // The key alphabet keeps Swift's Dictionary lookup (canonical equivalence) exact: no other
    // scalar sequence is canonically equivalent to such a key.
    if (!/^[a-z0-9_-]+$/.test(folded))
      fail(row.id, `table key "${folded}" is outside [a-z0-9_-]`);
  }
  for (const value of vocabulary)
    if (!rows.some((r) => r.raw === value && r.expect === value))
      fail(value, "no identity row (raw equal to the value)");
}

function buildHeadersCorpus(): unknown {
  checkHeaderSection(
    "platformCases",
    PLATFORM_CASES,
    readParityEnum("platform"),
  );
  checkHeaderSection("archCases", ARCH_CASES, readParityEnum("arch"));
  return {
    headersVersion: 1,
    description:
      "Client metadata header values (WIRE-CONTRACT-V3 §5.2). Each row is one spelling an OS or runtime reports (`raw`) and its canonical `X-PKey-Platform` (`platformCases`) or `X-PKey-Arch` (`archCases`) value. A runner looks `raw` up after ASCII case folding (A-Z only, never a locale-dependent lowercase), with no trimming, reading the table's own entries only. `expect: null` means the spelling has no value: an SDK omits the header rather than inventing one, and the Worker stores `raw` as sent (nothing, for an empty `raw`). The rows are the tables: `PLATFORM_SPELLINGS` and `ARCH_SPELLINGS` (`@polaris-key/protocol/core`, generated into every SDK) hold exactly the folded `raw` of the non-null rows, and every runner asserts that its table equals the map derived from them. Append-only: a new spelling (a row plus a table entry) keeps `headersVersion`; a changed row, or a change to folding or lookup, bumps it.",
    platformCases: PLATFORM_CASES,
    archCases: ARCH_CASES,
  };
}

// ── Config resolution (config-matrix.json) ───────────────────────────────────
// WIRE-CONTRACT-V3 §2.2.1: the precedence, the variable name (rule 1), the strict environment
// value (rule 2), the host without an environment (rule 3, `expectNoEnv`) and the user-visible
// list (rule 4). Every expectation is checked against the generator-local reference below, which
// imports nothing from client-core or shared-jws for the reason the fingerprint section gives: a
// golden corpus that shares code with the implementation it checks cannot catch a bug in it.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RemoteEntry {
  state: "default" | "enforced" | "hidden";
  value: Json;
  updatedAt: number;
}

interface ResolveCase {
  id: string;
  description: string;
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
  key: string;
  fallback: Json;
  expect: { value: Json; source: string };
  expectNoEnv?: { value: Json; source: string };
}

interface EnvValueCase {
  id: string;
  description: string;
  raw: string;
  value?: Json;
  anyNumber?: true;
}

interface ListEntry {
  key: string;
  value: Json;
  enforced: boolean;
}

interface ListCase {
  id: string;
  description: string;
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
  expect: ListEntry[];
  expectNoEnv?: ListEntry[];
}

/** Rule 2's limits, restated as literals (they are not generated constants). */
const REF_MAX_DEPTH = 64;
const REF_MAX_DECIMAL_EXPONENT = 307;
const REF_MAX_EXPONENT_DIGITS = 6;
const CM_PREFIX = "PKEY_CONFIG_";

const refOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Rule 2's number range, judged from the token's digits (the reference's own copy). */
function refNumberInRange(token: string): boolean {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  if (!m) throw new Error(`refNumberInRange: not a number token: ${token}`);
  const int = m[1]!;
  const frac = m[2] ?? "";
  const expDigits = (m[4] ?? "0").replace(/^0+/, "");
  if (expDigits.length > REF_MAX_EXPONENT_DIGITS) return false;
  const exp = (m[3] === "-" ? -1 : 1) * Number(expDigits || "0");
  const digits = int + frac;
  const first = digits.search(/[1-9]/);
  if (first === -1) return true;
  const power = int.length - 1 - first + exp;
  return (
    power >= -REF_MAX_DECIMAL_EXPONENT && power <= REF_MAX_DECIMAL_EXPONENT
  );
}

/** Unicode noncharacters: U+FDD0..U+FDEF and U+xxFFFE/U+xxFFFF in every plane. */
function isNoncharacter(cp: number): boolean {
  return (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
}

class RefRefused extends Error {}

/**
 * A small recursive-descent parser of rule 2's strict JSON. It refuses a 65th level before
 * descending into it, compares member names as JS strings (scalar comparison once lone
 * surrogates are refused) and never normalizes them, refuses a member name holding U+0000,
 * accepts noncharacters, and judges each number token from its digits before reading it with
 * `Number`.
 */
function refParseStrict(
  text: string,
): { ok: true; value: Json } | { ok: false } {
  let i = 0;
  const refuse = (): never => {
    throw new RefRefused();
  };
  const ws = (): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
  const str = (): string => {
    if (text[i] !== '"') refuse();
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) refuse();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) refuse();
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e !== undefined && refOwn(simple, e)) out += simple[e];
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) refuse();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else refuse();
        continue;
      }
      out += text[i];
      i++;
    }
    // No lone surrogate, escaped or raw.
    for (let k = 0; k < out.length; k++) {
      const u = out.charCodeAt(k);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = out.charCodeAt(k + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          k++;
          continue;
        }
        refuse();
      } else if (u >= 0xdc00 && u <= 0xdfff) refuse();
    }
    return out;
  };
  const num = (): number => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(i),
    );
    if (!m) refuse();
    const token = m![0];
    i += token.length;
    if (!refNumberInRange(token)) refuse();
    return Number(token);
  };
  const value = (depth: number): Json => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth + 1 > REF_MAX_DEPTH) refuse();
      i++;
      if (c === "[") {
        const arr: Json[] = [];
        ws();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        for (;;) {
          arr.push(value(depth + 1));
          ws();
          if (text[i] === ",") {
            i++;
            continue;
          }
          if (text[i] === "]") {
            i++;
            return arr;
          }
          refuse();
        }
      }
      const obj: { [k: string]: Json } = {};
      const names = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const name = str();
        if (name.indexOf("\u0000") !== -1) refuse();
        if (names.has(name)) refuse();
        names.add(name);
        ws();
        if (text[i] !== ":") refuse();
        i++;
        Object.defineProperty(obj, name, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        refuse();
      }
    }
    if (c === '"') return str();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    for (const [lit, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    return refuse();
  };
  try {
    const v = value(0);
    ws();
    if (i !== text.length) return { ok: false };
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof RefRefused) return { ok: false };
    throw e;
  }
}

/** Rule 2: the parsed value, or the raw string unchanged. */
function refEnvValue(raw: string): Json {
  const parsed = refParseStrict(raw);
  return parsed.ok ? parsed.value : raw;
}

interface RefContext {
  remote: Record<string, RemoteEntry> | null;
  localOverrides: Record<string, Json>;
  env: Record<string, string>;
  envPrefix: string;
}

function refResolve(
  ctx: RefContext,
  key: string,
  fallback: Json,
  withEnv: boolean,
): { value: Json; source: string } {
  const entry =
    ctx.remote !== null && refOwn(ctx.remote, key) ? ctx.remote[key]! : null;
  if (entry && entry.state === "enforced")
    return { value: entry.value, source: "enforced" };
  if (entry && entry.state === "hidden")
    return { value: entry.value, source: "hidden" };
  if (refOwn(ctx.localOverrides, key))
    return { value: ctx.localOverrides[key]!, source: "local" };
  const name = ctx.envPrefix + key.split(".").join("__");
  if (withEnv && refOwn(ctx.env, name))
    return { value: refEnvValue(ctx.env[name]!), source: "env" };
  if (entry) return { value: entry.value, source: "remote-default" };
  return { value: fallback, source: "fallback" };
}

function refList(ctx: RefContext, withEnv: boolean): ListEntry[] {
  const out: ListEntry[] = [];
  for (const key of Object.keys(ctx.remote ?? {})) {
    const entry = ctx.remote![key]!;
    if (entry.state === "hidden") continue;
    out.push({
      key,
      value: refResolve(ctx, key, null, withEnv).value,
      enforced: entry.state === "enforced",
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Canonical JSON equality (notes/A7 §5): keys unordered, arrays ordered, numbers by value (an
 *  integral float equals its integer, and -0 equals 0). */
function canonicalEqual(a: Json, b: Json): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as Json[];
    return (
      a.length === bb.length && a.every((x, k) => canonicalEqual(x, bb[k]!))
    );
  }
  const ao = a as { [k: string]: Json };
  const bo = b as { [k: string]: Json };
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return (
    ak.length === bk.length &&
    ak.every((k) => refOwn(bo, k) && canonicalEqual(ao[k]!, bo[k]!))
  );
}

const entry = (state: RemoteEntry["state"], value: Json): RemoteEntry => ({
  state,
  value,
  updatedAt: 1,
});
const DARK = { "ui.theme": entry("default", "dark") };
const BLUE = { [`${CM_PREFIX}ui__theme`]: '"blue"' };

/** A resolve row: `ui.theme` with a `default` entry `"dark"`, unless the row says otherwise. The
 *  expectations are computed by the reference and then compared against the literal ones. */
function resolveRow(
  id: string,
  description: string,
  setup: Partial<
    Omit<ResolveCase, "id" | "description" | "expect" | "expectNoEnv">
  >,
  expect: [Json, string],
  expectNoEnv?: [Json, string],
): ResolveCase {
  const row: ResolveCase = {
    id,
    description,
    remote: setup.remote === undefined ? DARK : setup.remote,
    localOverrides: setup.localOverrides ?? {},
    env: setup.env ?? {},
    envPrefix: setup.envPrefix ?? CM_PREFIX,
    key: setup.key ?? "ui.theme",
    fallback: setup.fallback === undefined ? "system" : setup.fallback,
    expect: { value: expect[0], source: expect[1] },
  };
  if (expectNoEnv)
    row.expectNoEnv = { value: expectNoEnv[0], source: expectNoEnv[1] };
  return row;
}

function resolveCases(): ResolveCase[] {
  const overrides = { localOverrides: { "ui.theme": "light" }, env: BLUE };
  return [
    resolveRow(
      "enforced-beats-local-and-env",
      "An enforced entry is locked: the local override and the environment are ignored.",
      { remote: { "ui.theme": entry("enforced", "dark") }, ...overrides },
      ["dark", "enforced"],
    ),
    resolveRow(
      "hidden-beats-local-and-env",
      "A hidden entry is locked too, and reports hidden.",
      { remote: { "ui.theme": entry("hidden", "s3cr3t") }, ...overrides },
      ["s3cr3t", "hidden"],
    ),
    resolveRow(
      "local-beats-env",
      "Over a default entry, a local override beats the environment.",
      overrides,
      ["light", "local"],
    ),
    resolveRow(
      "env-beats-remote-default",
      "The environment beats the remote default; a host without an environment sees the default.",
      { env: BLUE },
      ["blue", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "remote-default-beats-fallback",
      "With no override, the remote default answers.",
      {},
      ["dark", "remote-default"],
    ),
    resolveRow(
      "fallback-empty-document",
      "A document without the key: the caller's fallback.",
      { remote: {} },
      ["system", "fallback"],
    ),
    resolveRow(
      "fallback-no-document",
      "No document yet (remote null): the caller's fallback.",
      { remote: null },
      ["system", "fallback"],
    ),
    resolveRow(
      "env-key-absent-from-document",
      "The environment answers for a key the document lacks.",
      { remote: { "other.key": entry("default", 1) }, env: BLUE },
      ["blue", "env"],
      ["system", "fallback"],
    ),
    resolveRow(
      "env-no-document",
      "The environment answers before the first document.",
      { remote: null, env: BLUE },
      ["blue", "env"],
      ["system", "fallback"],
    ),
    resolveRow(
      "local-no-document",
      "A local override answers before the first document.",
      { remote: null, localOverrides: { "ui.theme": "light" } },
      ["light", "local"],
    ),
    resolveRow(
      "local-null-is-a-value",
      "A local override holding JSON null answers null; only fallback means no layer answered.",
      { localOverrides: { "ui.theme": null } },
      [null, "local"],
    ),
    resolveRow(
      "env-null-is-a-value",
      "An environment value of null parses to JSON null, which answers.",
      { env: { [`${CM_PREFIX}ui__theme`]: "null" } },
      [null, "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "remote-default-null-is-a-value",
      "A default entry holding null answers null.",
      { remote: { "ui.theme": entry("default", null) } },
      [null, "remote-default"],
    ),
    resolveRow(
      "enforced-null-is-locked",
      "An enforced entry holding null is still locked.",
      {
        remote: { "ui.theme": entry("enforced", null) },
        localOverrides: { "ui.theme": "light" },
      },
      [null, "enforced"],
    ),
    resolveRow(
      "env-empty-string-is-a-value",
      "A variable that is set counts even when it is empty; its value is the raw empty string.",
      { env: { [`${CM_PREFIX}ui__theme`]: "" } },
      ["", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-dots-to-double-underscores",
      "Rule 1: every dot in the key becomes a double underscore.",
      {
        key: "run.concurrency",
        remote: { "run.concurrency": entry("default", 4) },
        env: { [`${CM_PREFIX}run__concurrency`]: "8" },
      },
      [8, "env"],
      [4, "remote-default"],
    ),
    resolveRow(
      "env-name-dotted-form-not-read",
      "The SDK looks up exactly the built name, never the dotted form.",
      {
        key: "run.concurrency",
        remote: { "run.concurrency": entry("default", 4) },
        env: { [`${CM_PREFIX}run.concurrency`]: "8" },
      },
      [4, "remote-default"],
    ),
    resolveRow(
      "env-name-case-sensitive",
      "Nothing but the dots changes, case included.",
      { env: { [`${CM_PREFIX}UI__THEME`]: '"blue"' } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-keeps-other-characters",
      "Underscores and hyphens in the key are kept as they are.",
      {
        key: "net_proxy.max-retries",
        remote: { "net_proxy.max-retries": entry("default", 5) },
        env: { [`${CM_PREFIX}net_proxy__max-retries`]: "3" },
      },
      [3, "env"],
      [5, "remote-default"],
    ),
    resolveRow(
      "env-name-custom-prefix",
      "The host's prefix replaces PKEY_CONFIG_, which is then not read.",
      {
        envPrefix: "MYAPP_",
        env: {
          MYAPP_ui__theme: '"blue"',
          [`${CM_PREFIX}ui__theme`]: '"red"',
        },
      },
      ["blue", "env"],
      ["dark", "remote-default"],
    ),
    resolveRow(
      "env-name-withdrawn-prefix-not-read",
      "The withdrawn PLRS_CONFIG_ prefix (Amendment A1) is not read.",
      { env: { PLRS_CONFIG_ui__theme: '"blue"' } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "prototype-key-absent",
      "A key named like a language built-in is an ordinary key: absent from the document, it falls back.",
      { key: "constructor", remote: {} },
      ["system", "fallback"],
    ),
    resolveRow(
      "prototype-key-in-document",
      "A key named like a language built-in resolves from the document like any other.",
      { key: "toString", remote: { toString: entry("default", "dark") } },
      ["dark", "remote-default"],
    ),
    resolveRow(
      "prototype-key-empty-prefix",
      "With an empty prefix the variable name is the key itself; an empty environment does not hold it.",
      { key: "valueOf", envPrefix: "", remote: null, env: {} },
      ["system", "fallback"],
    ),
  ];
}

const RAW = Symbol("raw");
const ANY = Symbol("anyNumber");

/** `[id, description, raw, value]`: `RAW` expects the raw string back, `ANY` pins only the
 *  verdict (a finite number in the SDK's own type). */
const ENV_VALUE_ROWS: [
  string,
  string,
  string,
  Json | typeof RAW | typeof ANY,
][] = [
  // Parse.
  ["env-value-true", "A JSON literal.", "true", true],
  ["env-value-false", "A JSON literal.", "false", false],
  ["env-value-null", "A JSON literal.", "null", null],
  ["env-value-integer", "An integer.", "42", 42],
  ["env-value-negative-integer", "A negative integer.", "-7", -7],
  ["env-value-zero", "Zero.", "0", 0],
  ["env-value-decimal", "A decimal.", "1.5", 1.5],
  [
    "env-value-decimal-trailing-zero",
    "A decimal with a trailing zero.",
    "2.50",
    2.5,
  ],
  ["env-value-exponent", "An exponent.", "1e3", 1000],
  [
    "env-value-exponent-upper-negative",
    "An upper-case negative exponent.",
    "1E-2",
    0.01,
  ],
  [
    "env-value-fraction-and-exponent",
    "A fraction with an exponent.",
    "0.1e1",
    1,
  ],
  [
    "env-value-negative-zero",
    "Negative zero, which compares equal to 0.",
    "-0",
    0,
  ],
  ["env-value-negative-zero-decimal", "Negative zero as a decimal.", "-0.0", 0],
  [
    "env-value-max-safe-integer",
    "2^53 - 1.",
    "9007199254740991",
    9007199254740991,
  ],
  ["env-value-string", "A quoted string.", '"hello"', "hello"],
  ["env-value-quoted-empty-string", "The quoted empty string.", '""', ""],
  [
    "env-value-string-escapes",
    "A string written with escapes.",
    '"caf\\u00e9 \\u65e5\\n"',
    "caf\u00e9 \u65e5\n",
  ],
  ["env-value-empty-array", "An empty array.", "[]", []],
  ["env-value-empty-object", "An empty object.", "{}", {}],
  [
    "env-value-mixed-array",
    "An array of every JSON type.",
    '["a",1,true,null,{"b":[2.5]}]',
    ["a", 1, true, null, { b: [2.5] }],
  ],
  [
    "env-value-nested-object",
    "Nested objects and arrays.",
    '{"a":{"b":[1,{"c":null}]}}',
    { a: { b: [1, { c: null }] } },
  ],
  [
    "env-value-surrounding-spaces",
    "JSON whitespace around the value.",
    " 42 ",
    42,
  ],
  [
    "env-value-surrounding-json-whitespace",
    "Tab, CR and LF around the value.",
    '\t{"a":1}\r\n',
    { a: 1 },
  ],
  [
    "env-value-noncharacters",
    "Noncharacters are ordinary characters (rule 2), escaped or raw: U+FFFF, U+FDD0, U+1FFFE, then a raw U+FFFF.",
    '["\\uffff","\\ufdd0","\\ud83f\\udffe","\uffff"]',
    ["\uffff", "\ufdd0", "\u{1fffe}", "\uffff"],
  ],
  // Raw: not JSON.
  ["env-value-bare-word", "A bare word.", "dark", RAW],
  ["env-value-python-true", "Python's True is not JSON.", "True", RAW],
  ["env-value-leading-zero", "A leading zero.", "01", RAW],
  ["env-value-trailing-dot", "A trailing decimal point.", "1.", RAW],
  ["env-value-leading-dot", "A leading decimal point.", ".5", RAW],
  ["env-value-plus-sign", "A leading plus sign.", "+1", RAW],
  ["env-value-hex", "A hexadecimal literal.", "0x10", RAW],
  ["env-value-digit-separator", "A digit separator.", "1_000", RAW],
  ["env-value-unclosed-object", "An unclosed object.", "{", RAW],
  ["env-value-unclosed-array", "An unclosed array.", "[1,2", RAW],
  [
    "env-value-unterminated-string",
    "An unterminated string.",
    '"unterminated',
    RAW,
  ],
  ["env-value-trailing-garbage", "Text after the value.", '{"a":1}x', RAW],
  ["env-value-two-texts", "Two JSON texts.", "[1] [2]", RAW],
  ["env-value-empty", "The empty string is not a JSON text.", "", RAW],
  ["env-value-whitespace-only", "Whitespace only.", "   ", RAW],
  [
    "env-value-nbsp-before-number",
    "U+00A0 is not JSON whitespace.",
    "\u00a042",
    RAW,
  ],
  [
    "env-value-bom-before-object",
    "A leading byte order mark is not skipped.",
    "\ufeff{}",
    RAW,
  ],
  [
    "env-value-bom-before-number",
    "A leading byte order mark is not skipped.",
    "\ufeff42",
    RAW,
  ],
  [
    "env-value-form-feed-before-array",
    "U+000C is not JSON whitespace.",
    "\u000c[1]",
    RAW,
  ],
  ["env-value-single-quotes", "Single quotes.", "'single'", RAW],
  ["env-value-unquoted-name", "An unquoted member name.", "{a:1}", RAW],
  // Raw, where the SDKs disagreed before §2.2.1.
  [
    "env-value-trailing-comma-array",
    "A trailing comma in an array.",
    "[1,2,]",
    RAW,
  ],
  [
    "env-value-trailing-comma-object",
    "A trailing comma in an object.",
    '{"a":1,}',
    RAW,
  ],
  [
    "env-value-duplicate-name",
    "Two members of the same name.",
    '{"a":1,"a":2}',
    RAW,
  ],
  [
    "env-value-duplicate-name-escaped",
    'Names compare after unescaping: "a" and "\\u0061" are one name.',
    '{"a":1,"\\u0061":2}',
    RAW,
  ],
  [
    "env-value-duplicate-name-nested",
    "A duplicate at any depth.",
    '{"a":{"b":1,"b":2}}',
    RAW,
  ],
  ["env-value-nan", "NaN is not JSON.", "NaN", RAW],
  ["env-value-infinity", "Infinity is not JSON.", "Infinity", RAW],
  ["env-value-negative-infinity", "-Infinity is not JSON.", "-Infinity", RAW],
  ["env-value-nan-in-array", "NaN inside an array.", "[NaN]", RAW],
  ["env-value-number-overflow", "A number beyond binary64.", "1e400", RAW],
  [
    "env-value-number-negative-overflow",
    "A negative number beyond binary64.",
    "-1e400",
    RAW,
  ],
  [
    "env-value-number-overflow-in-array",
    "An overflowing number inside an array.",
    "[1e400]",
    RAW,
  ],
  [
    "env-value-integer-310-digits",
    "1 followed by 309 zeros: E = 309.",
    "1" + "0".repeat(309),
    RAW,
  ],
  [
    "env-value-lone-high-surrogate",
    "An escaped lone high surrogate.",
    '"\\ud800"',
    RAW,
  ],
  [
    "env-value-lone-low-surrogate-in-array",
    "An escaped lone low surrogate inside an array.",
    '["\\udc00x"]',
    RAW,
  ],
  [
    "env-value-lone-surrogate-name",
    "An escaped lone surrogate in a member name.",
    '{"\\ud800":1}',
    RAW,
  ],
  // Rule 2's number range. E is the power of ten of the first non-zero digit.
  ["env-value-number-e308", "E = 308.", "1e308", RAW],
  [
    "env-value-number-largest-double",
    "The largest double, E = 308: raw however a parser would round it.",
    "1.7976931348623158e308",
    RAW,
  ],
  [
    "env-value-number-309-digits",
    "A 309-digit integer, E = 308.",
    "17976931348623157" + "0".repeat(292),
    RAW,
  ],
  ["env-value-number-e-308", "E = -308.", "1e-308", RAW],
  ["env-value-number-subnormal", "A subnormal, E = -324.", "5e-324", RAW],
  ["env-value-number-underflow", "E = -400.", "1e-400", RAW],
  [
    "env-value-number-zero-seven-digit-exponent",
    "Zero with seven significant exponent digits.",
    "0e1000000",
    RAW,
  ],
  [
    "env-value-number-exponent-past-32-bits",
    "Ten exponent digits, past 2^32.",
    "1e4294967297",
    RAW,
  ],
  [
    "env-value-number-edge-high",
    "E = 307: in range. Only the verdict is pinned (WIRE-CONTRACT-V3 §10).",
    "9.99e307",
    ANY,
  ],
  [
    "env-value-number-edge-low",
    "E = -307: in range. Only the verdict is pinned (WIRE-CONTRACT-V3 §10).",
    "1e-307",
    ANY,
  ],
  [
    "env-value-number-exponent-leading-zeros",
    "An exponent with leading zeros has one significant digit.",
    "1e0000001",
    10,
  ],
  [
    "env-value-number-zero-with-exponent",
    "Zero with an exponent is in range.",
    "0e5",
    0,
  ],
  // Member names.
  [
    "env-value-canonically-equivalent-names",
    "Names compare by scalar value and are never normalized: U+00E9 and U+0065 U+0301 are two names. Their values are equal, so Swift's merge (WIRE-CONTRACT-V3 §10) cannot change the comparison.",
    '{"\\u00e9":1,"e\\u0301":1}',
    { "\u00e9": 1, "e\u0301": 1 },
  ],
  [
    "env-value-name-holds-nul",
    "A member name holding U+0000 keeps the raw string.",
    '{"a\\u0000":1}',
    RAW,
  ],
  [
    "env-value-name-escaped-backslash-u0000",
    "An escaped backslash before u0000: the name holds no U+0000.",
    '{"a\\\\u0000":1}',
    { "a\\u0000": 1 },
  ],
  // Depth.
  [
    "env-value-depth-64-arrays",
    "64 nested arrays parse.",
    "[".repeat(64) + "]".repeat(64),
    nestedArrays(64),
  ],
  [
    "env-value-depth-65-arrays",
    "65 nested arrays stay raw.",
    "[".repeat(65) + "]".repeat(65),
    RAW,
  ],
  [
    "env-value-depth-65-objects",
    "64 nested objects around [1], 65 levels, stay raw.",
    '{"a":'.repeat(64) + "[1]" + "}".repeat(64),
    RAW,
  ],
  [
    "env-value-depth-brackets-in-string",
    "Brackets inside a string do not count, even after an escaped quote.",
    '["\\"' + "[".repeat(65) + '"]',
    ['"' + "[".repeat(65)],
  ],
  [
    "env-value-depth-after-escaped-backslash",
    "The string ends after an escaped backslash, so 64 nested arrays follow it: 65 levels stay raw.",
    '["\\\\",' + "[".repeat(64) + "]".repeat(64) + "]",
    RAW,
  ],
  [
    "env-value-depth-10000",
    "10,000 nested arrays stay raw, and no runner may throw on them.",
    "[".repeat(10000) + "]".repeat(10000),
    RAW,
  ],
];

function nestedArrays(depth: number): Json {
  let v: Json = [];
  for (let k = 1; k < depth; k++) v = [v];
  return v;
}

function envValueCases(): EnvValueCase[] {
  return ENV_VALUE_ROWS.map(([id, description, raw, value]) => {
    if (value === ANY) return { id, description, raw, anyNumber: true };
    return { id, description, raw, value: value === RAW ? raw : value };
  });
}

/** An `envValueCase` as the resolve case it expands to (the file's description says the same). */
function expandEnvValueCase(c: EnvValueCase): RefContext & {
  key: string;
  fallback: Json;
} {
  return {
    remote: null,
    localOverrides: {},
    env: { [`${CM_PREFIX}value`]: c.raw },
    envPrefix: CM_PREFIX,
    key: "value",
    fallback: "(fallback)",
  };
}

function listRow(
  id: string,
  description: string,
  setup: Partial<RefContext>,
  expect: ListEntry[],
  expectNoEnv?: ListEntry[],
): ListCase {
  const row: ListCase = {
    id,
    description,
    remote: setup.remote === undefined ? {} : setup.remote,
    localOverrides: setup.localOverrides ?? {},
    env: setup.env ?? {},
    envPrefix: setup.envPrefix ?? CM_PREFIX,
    expect,
  };
  if (expectNoEnv) row.expectNoEnv = expectNoEnv;
  return row;
}

const le = (key: string, value: Json, enforced = false): ListEntry => ({
  key,
  value,
  enforced,
});

function listCases(): ListCase[] {
  return [
    listRow(
      "list-states-and-layers",
      "Hidden entries are not listed, enforced ones are flagged, and each entry carries its resolved value.",
      {
        remote: {
          a: entry("default", 1),
          b: entry("enforced", 2),
          c: entry("hidden", 3),
          d: entry("default", "x"),
        },
        localOverrides: { b: 99, d: "y" },
        env: { [`${CM_PREFIX}a`]: "5" },
      },
      [le("a", 5), le("b", 2, true), le("d", "y")],
      [le("a", 1), le("b", 2, true), le("d", "y")],
    ),
    listRow(
      "list-omits-local-only-keys",
      "A key only a local override supplies is not listed.",
      { remote: { a: entry("default", 1) }, localOverrides: { z: "local" } },
      [le("a", 1)],
    ),
    listRow(
      "list-omits-env-only-keys",
      "A key only the environment supplies is not listed.",
      { remote: { a: entry("default", 1) }, env: { [`${CM_PREFIX}z`]: "1" } },
      [le("a", 1)],
    ),
    listRow(
      "list-no-document",
      "No document yet: nothing is listed, whatever the overrides.",
      { remote: null, localOverrides: { a: 1 } },
      [],
    ),
    listRow(
      "list-empty-document",
      "An empty document lists nothing.",
      { remote: {} },
      [],
    ),
    listRow(
      "list-only-hidden",
      "A document of hidden entries lists nothing.",
      { remote: { h: entry("hidden", "x") } },
      [],
    ),
    listRow(
      "list-null-value",
      "An entry holding null is listed with null.",
      { remote: { n: entry("default", null) } },
      [le("n", null)],
    ),
    listRow(
      "list-prototype-named-entries",
      "Entries named like language built-ins are ordinary entries.",
      {
        remote: {
          constructor: entry("default", 1),
          toString: entry("enforced", 2),
          valueOf: entry("hidden", 3),
        },
      },
      [le("constructor", 1), le("toString", 2, true)],
    ),
  ];
}

/** E for a single number token: the power of ten of its first non-zero digit (null for zero). */
function decimalPower(token: string): number | null {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!m) return null;
  const digits = m[1]! + (m[2] ?? "");
  const first = digits.search(/[1-9]/);
  if (first === -1) return null;
  return m[1]!.length - 1 - first + Number(m[3] ?? "0");
}

/** The parts of a number token that decide whether every SDK reads it as the same double. */
function numberForm(token: string): {
  digits: string;
  fracDigits: number;
  exp: number;
  expDigits: string;
} {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  if (!m) throw new Error(`not a number token: ${token}`);
  const expDigits = (m[4] ?? "0").replace(/^0+/, "") || "0";
  return {
    digits: m[1]! + (m[2] ?? ""),
    fracDigits: (m[2] ?? "").length,
    exp: (m[3] === "-" ? -1 : 1) * Number(expDigits.slice(0, 15)),
    expDigits,
  };
}

/** True when every SDK, Godot included, reads the token as the nearest double: at most 18 digits
 *  before the exponent part (leading zeros included), those digits an integer of at most 2^53,
 *  and the exponent minus the fraction digits within ±22 (WIRE-CONTRACT-V3 §10). */
function exactlyReadEverywhere(token: string): boolean {
  const f = numberForm(token);
  if (f.digits.length > 18) return false;
  if (BigInt(f.digits) > 2n ** 53n) return false;
  const scale = f.exp - f.fracDigits;
  return scale >= -22 && scale <= 22;
}

/** Number tokens outside strings, in a text JSON accepts. */
function numberTokens(text: string): string[] {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length - 1;
      }
    }
  }
  return out;
}

function checkConfigMatrix(
  resolve: ResolveCase[],
  envValues: EnvValueCase[],
  list: ListCase[],
  file: unknown,
): void {
  const fail = (section: string, id: string, why: string): never => {
    throw new Error(
      `corpus self-check failed: config-matrix/${section}/${id}: ${why}`,
    );
  };
  const ids = new Set<string>();
  const usedSources = new Set<string>();
  const usedTypes = new Set<string>();
  const usedEnforced = new Set<boolean>();
  const typeOf = (v: Json): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const envNamesAscii = (
    section: string,
    id: string,
    env: Record<string, string>,
  ) => {
    for (const name of Object.keys(env))
      if (!/^[\x20-\x7e]*$/.test(name))
        fail(section, id, `variable name ${JSON.stringify(name)} is not ASCII`);
  };

  for (const c of resolve) {
    if (ids.has(c.id)) fail("resolveCases", c.id, "duplicate id");
    ids.add(c.id);
    envNamesAscii("resolveCases", c.id, c.env);
    const withEnv = refResolve(c, c.key, c.fallback, true);
    const noEnv = refResolve(c, c.key, c.fallback, false);
    if (
      withEnv.source !== c.expect.source ||
      !canonicalEqual(withEnv.value, c.expect.value)
    )
      fail(
        "resolveCases",
        c.id,
        `the reference answers ${JSON.stringify(withEnv)}`,
      );
    const differs =
      noEnv.source !== withEnv.source ||
      !canonicalEqual(noEnv.value, withEnv.value);
    if (differs !== (c.expectNoEnv !== undefined))
      fail(
        "resolveCases",
        c.id,
        differs ? "expectNoEnv is missing" : "expectNoEnv equals expect",
      );
    if (
      c.expectNoEnv &&
      (noEnv.source !== c.expectNoEnv.source ||
        !canonicalEqual(noEnv.value, c.expectNoEnv.value))
    )
      fail(
        "resolveCases",
        c.id,
        `the reference answers ${JSON.stringify(noEnv)} without an environment`,
      );
    for (const e of [c.expect, c.expectNoEnv]) {
      if (!e) continue;
      usedSources.add(e.source);
      usedTypes.add(typeOf(e.value));
    }
  }

  let equivalentPair = false;
  for (const c of envValues) {
    if (ids.has(c.id)) fail("envValueCases", c.id, "duplicate id");
    ids.add(c.id);
    const ctx = expandEnvValueCase(c);
    const got = refResolve(ctx, ctx.key, ctx.fallback, true);
    if (got.source !== "env")
      fail("envValueCases", c.id, `source ${got.source}`);
    const noEnv = refResolve(ctx, ctx.key, ctx.fallback, false);
    if (noEnv.source !== "fallback" || noEnv.value !== "(fallback)")
      fail(
        "envValueCases",
        c.id,
        "the no-environment expansion does not fall back",
      );
    usedSources.add("env");
    if (c.anyNumber) {
      if (
        typeof got.value !== "number" ||
        !Number.isFinite(got.value) ||
        got.value === 0
      )
        fail(
          "envValueCases",
          c.id,
          "anyNumber, but the reference does not read a non-zero finite number",
        );
      const tokens = numberTokens(c.raw);
      if (tokens.length !== 1 || tokens[0] !== c.raw.trim())
        fail("envValueCases", c.id, "an anyNumber row must be a single number");
      const f = numberForm(tokens[0]!);
      const scale = f.exp - f.fracDigits;
      if (f.digits.length > 18 || scale < -308 || scale > 308)
        fail(
          "envValueCases",
          c.id,
          "an anyNumber row must have at most 18 digits and a scale within ±308",
        );
      usedTypes.add("number");
      continue;
    }
    if (!canonicalEqual(got.value, c.value!))
      fail(
        "envValueCases",
        c.id,
        `the reference answers ${JSON.stringify(got.value)}`,
      );
    usedTypes.add(typeOf(c.value!));
    const keepsRaw =
      typeof c.value === "string" &&
      c.value === c.raw &&
      !refParseStrict(c.raw).ok;
    if (!keepsRaw)
      for (const token of numberTokens(c.raw))
        if (!exactlyReadEverywhere(token))
          fail(
            "envValueCases",
            c.id,
            `the compared number ${token} is outside the forms every SDK reads alike`,
          );
    if (hasEquivalentPair(c.value!)) equivalentPair = true;
  }
  if (!equivalentPair)
    fail(
      "envValueCases",
      "*",
      "no row holds two canonically equivalent member names",
    );

  for (const c of list) {
    if (ids.has(c.id)) fail("listCases", c.id, "duplicate id");
    ids.add(c.id);
    envNamesAscii("listCases", c.id, c.env);
    const sorted = [...c.expect].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    if (sorted.some((e, k) => e !== c.expect[k]))
      fail("listCases", c.id, "expect is not sorted by key");
    const withEnv = refList(c, true);
    const noEnv = refList(c, false);
    const same = (a: ListEntry[], b: ListEntry[]): boolean =>
      a.length === b.length &&
      a.every(
        (e, k) =>
          e.key === b[k]!.key &&
          e.enforced === b[k]!.enforced &&
          canonicalEqual(e.value, b[k]!.value),
      );
    if (!same(withEnv, c.expect))
      fail("listCases", c.id, `the reference lists ${JSON.stringify(withEnv)}`);
    const differs = !same(withEnv, noEnv);
    if (differs !== (c.expectNoEnv !== undefined))
      fail(
        "listCases",
        c.id,
        differs ? "expectNoEnv is missing" : "expectNoEnv equals expect",
      );
    if (c.expectNoEnv && !same(noEnv, c.expectNoEnv))
      fail(
        "listCases",
        c.id,
        `the reference lists ${JSON.stringify(noEnv)} without an environment`,
      );
    for (const e of [...c.expect, ...(c.expectNoEnv ?? [])]) {
      usedEnforced.add(e.enforced);
      usedTypes.add(typeOf(e.value));
    }
  }

  for (const s of [
    "enforced",
    "hidden",
    "local",
    "env",
    "remote-default",
    "fallback",
  ])
    if (!usedSources.has(s)) fail("*", s, "no row expects this source");
  for (const t of ["null", "boolean", "number", "string", "array", "object"])
    if (!usedTypes.has(t))
      fail("*", t, "no row expects a value of this JSON type");
  for (const b of [true, false])
    if (!usedEnforced.has(b))
      fail("*", String(b), "no list row expects this enforced value");

  // Rule 2's character rules are each pinned.
  const keepsRawRow = (c: EnvValueCase): boolean =>
    c.value === c.raw && !refParseStrict(c.raw).ok;
  const parseRow = (c: EnvValueCase): boolean =>
    !c.anyNumber && !keepsRawRow(c);
  const namesOf = (v: Json): string[] => {
    if (v === null || typeof v !== "object") return [];
    if (Array.isArray(v)) return v.flatMap(namesOf);
    return Object.keys(v).flatMap((k) => [k, ...namesOf(v[k]!)]);
  };
  // JS's own parser is lenient about U+0000 in names, which is what this lookup needs.
  const lenient = (raw: string): Json | undefined => {
    try {
      return JSON.parse(raw) as Json;
    } catch {
      return undefined;
    }
  };
  if (
    !envValues.some(
      (c) =>
        keepsRawRow(c) &&
        namesOf(lenient(c.raw) ?? null).some((n) => n.includes("\u0000")),
    )
  )
    fail("envValueCases", "*", "no raw row's member name spells \\u0000");
  if (
    !envValues.some(
      (c) =>
        parseRow(c) && namesOf(c.value!).some((n) => n.includes("\\u0000")),
    )
  )
    fail(
      "envValueCases",
      "*",
      "no parse row's member name spells an escaped backslash before u0000",
    );
  const escapedNonchar = (raw: string): boolean => {
    for (const m of raw.matchAll(/\\u([0-9a-fA-F]{4})/g))
      if (isNoncharacter(parseInt(m[1]!, 16))) return true;
    return false;
  };
  const rawNonchar = (raw: string): boolean => {
    for (const ch of raw) if (isNoncharacter(ch.codePointAt(0)!)) return true;
    return false;
  };
  if (
    !envValues.some(
      (c) => parseRow(c) && escapedNonchar(c.raw) && rawNonchar(c.raw),
    )
  )
    fail(
      "envValueCases",
      "*",
      "no parse row holds a noncharacter both escaped and raw",
    );

  // Rule 2's range on both sides of each edge.
  const singlePower = (c: EnvValueCase): number | null | undefined => {
    const tokens = numberTokens(c.raw);
    return tokens.length === 1 && tokens[0] === c.raw
      ? decimalPower(c.raw)
      : undefined;
  };
  const inRangeAt = (e: number) =>
    envValues.some((c) => !keepsRawRow(c) && singlePower(c) === e);
  const rawAt = (e: number) =>
    envValues.some((c) => keepsRawRow(c) && singlePower(c) === e);
  for (const e of [307, -307])
    if (!inRangeAt(e)) fail("envValueCases", "*", `no parsed row at E = ${e}`);
  for (const e of [308, -308])
    if (!rawAt(e)) fail("envValueCases", "*", `no raw row at E = ${e}`);
  if (
    !envValues.some(
      (c) =>
        keepsRawRow(c) &&
        singlePower(c) !== undefined &&
        numberForm(c.raw).expDigits.length === 7,
    )
  )
    fail(
      "envValueCases",
      "*",
      "no raw row whose exponent has seven significant digits",
    );

  // The whole file, as each runner loads it.
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v.includes("\u0000")) fail("*", path, "a loaded string holds U+0000");
      if (hasLoneSurrogateRef(v))
        fail("*", path, "a loaded string holds a lone surrogate");
      return;
    }
    if (typeof v === "number") {
      if (!exactlyReadEverywhere(JSON.stringify(v)))
        fail(
          "*",
          path,
          `the number ${v} is outside the forms every SDK reads alike`,
        );
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x, k) => walk(x, `${path}[${k}]`));
      return;
    }
    const obj = v as Record<string, unknown>;
    const names = Object.keys(obj);
    for (const name of names) {
      if (name.includes("\u0000"))
        fail("*", path, "a loaded member name holds U+0000");
      if (hasLoneSurrogateRef(name))
        fail("*", path, "a loaded member name holds a lone surrogate");
      walk(obj[name], `${path}.${name}`);
    }
    for (let a = 0; a < names.length; a++)
      for (let b = a + 1; b < names.length; b++)
        if (
          names[a] !== names[b] &&
          names[a]!.normalize("NFC") === names[b]!.normalize("NFC") &&
          !canonicalEqual(obj[names[a]!] as Json, obj[names[b]!] as Json)
        )
          fail(
            "*",
            path,
            "two canonically equivalent member names hold different values",
          );
  };
  walk(file, "$");
}

function hasLoneSurrogateRef(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const u = s.charCodeAt(k);
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = s.charCodeAt(k + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        k++;
        continue;
      }
      return true;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

function hasEquivalentPair(v: Json): boolean {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(hasEquivalentPair);
  const names = Object.keys(v);
  for (let a = 0; a < names.length; a++)
    for (let b = a + 1; b < names.length; b++)
      if (names[a]!.normalize("NFC") === names[b]!.normalize("NFC"))
        return true;
  return names.some((n) => hasEquivalentPair(v[n]!));
}

function buildConfigMatrix(): unknown {
  const resolve = resolveCases();
  const envValues = envValueCases();
  const list = listCases();
  const file = {
    configMatrixVersion: 1,
    description:
      'Config resolution (WIRE-CONTRACT-V3 §2.2.1). Precedence: enforced | hidden (remote) > local override > environment > remote default > fallback, reported as source enforced, hidden, local, env, remote-default or fallback; a layer holding JSON null answers null, and only fallback means no layer answered. A layer answers only for a key it holds itself (own properties), so `constructor` and `toString` are ordinary keys. `remote: null` means no document yet (a host without that state passes an empty map). Rule 1: the variable name is `envPrefix` plus the key with every `.` replaced by `__`, nothing else changed; a set variable counts even when empty. Rule 2: the value is the parsed value when the raw string is one RFC 8259 JSON text with no duplicate member names (compared by Unicode scalar value after unescaping, never normalized), no member name holding U+0000, no lone surrogate, every number zero or of magnitude at least 10^-307 and below 10^308 (judged from its digits, its exponent part at most six significant digits), and at most 64 arrays and objects open at once; otherwise it is the raw string, and reading never fails. Noncharacters are ordinary characters. Rule 3: a host without an environment layer resolves as though no variable were set, and checks `expectNoEnv` where present, else `expect`. Rule 4 (`listCases`): every document entry except hidden ones, each with its resolved value; `enforced` is true exactly when the state is enforced; keys only a local override or the environment supplies are not listed; each `expect` is sorted by key and runners sort their output the same way. An `envValueCase` expands to the resolve case { remote: null, localOverrides: {}, env: { "PKEY_CONFIG_value": raw }, envPrefix: "PKEY_CONFIG_", key: "value", fallback: "(fallback)" }, expecting { value, source: "env" }, and { "(fallback)", "fallback" } without an environment. `anyNumber: true` in place of `value` pins only the verdict: source env and a finite number in the SDK\'s own type. A resolveValue answer of undefined (nothing matched) reads as the row\'s fallback. Compare with canonical JSON: keys unordered, arrays ordered, numbers by value, an integral float equal to its integer, -0 equal to 0. Append-only: a new row keeps `configMatrixVersion`; a changed row or rule bumps it.',
    resolveCases: resolve,
    envValueCases: envValues,
    listCases: list,
  };
  checkConfigMatrix(resolve, envValues, list, JSON.parse(JSON.stringify(file)));
  return file;
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
  // but guarded by the same drift gate and mirrored alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Six files in one directory so a runner can point at `corpus/v2/` and find everything
  // it needs, and so `--check` guards the whole set. The `fingerprint.json` formulas are
  // unchanged across the wire revisions (`fingerprintVersion` stays 1) and deliberately NOT
  // rebranded — the `pkey-hw:`/`pkey-device:` prefixes are hash domains baked into every
  // enrolled digest, not user-visible identifiers. `stage-matrix.json` pins client boot
  // behaviour, which is outside the wire contract but shares the directory and the gate.
  const v2Content = await format(JSON.stringify(await buildV2()), {
    parser: "json",
  });
  const v2GateMatrix = await format(JSON.stringify(buildGateMatrixV2()), {
    parser: "json",
  });
  const v2StageMatrix = await format(JSON.stringify(buildStageMatrixV1()), {
    parser: "json",
  });
  // Client metadata header values (§5.2) and config resolution (§2.2.1): unsigned behaviour
  // tables, guarded by the same gate and mirrored alongside the rest.
  const v2Headers = await format(JSON.stringify(buildHeadersCorpus()), {
    parser: "json",
  });
  const v2ConfigMatrix = await format(JSON.stringify(buildConfigMatrix()), {
    parser: "json",
  });

  // One map from file name to content, reconciled into the source directory and into every
  // generator-owned mirror, so a file added here reaches each mirror by construction.
  const files = new Map<string, string>([
    [basename(V2_OUT), v2Content],
    [basename(V2_GATE_MATRIX_OUT), v2GateMatrix],
    [basename(V2_FINGERPRINT_OUT), fingerprint],
    [basename(V2_STAGE_MATRIX_OUT), v2StageMatrix],
    [basename(V2_HEADERS_OUT), v2Headers],
    [basename(V2_CONFIG_MATRIX_OUT), v2ConfigMatrix],
  ]);
  let stale = false;
  for (const dir of CORPUS_TARGETS) {
    for (const [name, content] of files)
      stale = reconcile(join(dir, name), content, check) || stale;
    // Stray-file guard: a top-level JSON file the generator does not write fails both modes
    // and is never deleted automatically, so a dropped or renamed file cannot linger in a
    // mirror. Subdirectories belong to their owners.
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      if (!entry.endsWith(".json") || files.has(entry)) continue;
      const path = join(dir, entry);
      if (!statSync(path).isFile()) continue;
      console.error(`stray: ${path} is not written by the generator`);
      stale = true;
    }
  }

  if (stale) process.exit(1);
}

await main();

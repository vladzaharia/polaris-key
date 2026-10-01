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
// Four files: `cases.json` (signed vectors), `gate-matrix.json` (§5), `fingerprint.json` (the
// hardware-hash formulas) and `stage-matrix.json` (the boot stage machine of
// `@polaris-key/client-core/stages`, client boot behaviour outside the wire contract, read by
// conformance/runners/node/stageMatrix.test.ts and the Python and Swift runners).
//
// `corpus/v1` (wire contract v2) is GONE: its fifteen gate-matrix rows were inlined into
// `CARRIED_MATRIX_ROWS` below before deletion, so nothing it pinned was dropped.
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
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. Rows 1-15 are corpus v1\'s matrix, carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — and inlined here when corpus v1 was deleted, so a v3 gate that changes any decision v2 made goes red here. The remaining rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on that last row is deliberately NOT the status. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape.',
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
  // but guarded by the same drift gate and mirrored alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Four files in one directory so a runner can point at `corpus/v2/` and find everything
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

  // One map from file name to content, reconciled into the source directory and into every
  // generator-owned mirror, so a file added here reaches each mirror by construction.
  const files = new Map<string, string>([
    [basename(V2_OUT), v2Content],
    [basename(V2_GATE_MATRIX_OUT), v2GateMatrix],
    [basename(V2_FINGERPRINT_OUT), fingerprint],
    [basename(V2_STAGE_MATRIX_OUT), v2StageMatrix],
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

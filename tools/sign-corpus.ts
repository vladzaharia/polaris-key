// Generate the cross-language conformance corpus. ONE signer produces the canonical signed
// vectors; every SDK's runner (Node, Python, Swift, React, Godot) verifies the SAME files,
// proving byte-identical JWS verification + identical gate transitions. Ed25519 is
// deterministic, so re-signing is reproducible — `--check` re-emits in memory and fails if a
// committed file drifted.
//
// ONE corpus, from four committed test keys (two product keys, two release keys) and fixed clocks:
//
//   conformance/corpus/v2/  wire contract v4 (docs/security/WIRE-CONTRACT-V4.md; v3's documents
//                           are unchanged, so the directory and `corpusVersion: 2` stay). Consumed
//                           by conformance/runners/node/corpusV2.test.ts via
//                           @polaris-key/client-core and by the Python runner. Two
//                           generator-owned mirrors keep the path `…/v2/` one-for-one:
//                           the Swift test bundle's `Resources/v2/` (the Swift suite) and
//                           `sdks/godot/tests/corpus/v2/` (the Godot runner, which reads it
//                           from `res://` in the editor and in an exported pack). Every file
//                           is written into every target in `CORPUS_TARGETS`.
//
// Eleven files and one directory: `cases.json` (signed vectors, the v4 feed, release-record and
// pack families included), `gate-matrix.json` (§5, with SP-00's `entitlementRows` family),
// `fingerprint.json` (the hardware-hash
// formulas), `stage-matrix.json` (the boot stage machine of `@polaris-key/client-core/stages`,
// client boot behaviour outside the wire contract, read by
// conformance/runners/node/stageMatrix.test.ts and the Python, Swift and Godot runners; version
// 2 adds boot confirmation, version 3 adds packs, plans/P4-01.md §2.10), `headers.json` (the
// client metadata header values, §5.2), `config-matrix.json` (config resolution and environment
// values, §2.2.1), `update-matrix.json` (the update decision, plans/P3-01.md §2.8),
// `outlet-matrix.json` (outlet kinds, capabilities and detection, plans/P3-01.md §2.9),
// `plan-matrix.json` (the pack plan, plans/P4-01.md), `feed-url-matrix.json` (the app-updater
// feed URLs out of discovery's `update.endpoints`, plans/SP-00.md D5), `sync-scenarios.json` (the
// Cloud Sync client scenario corpus, literal data from tools/sync-scenarios.ts, plans/U-01.md
// §4.1, U-18) and `content/` (the content corpus: `cases.json` plus `blobs/`, plans/P4-01.md
// §4.4, P4-04).
//
// `corpus/v1` (wire contract v2) is GONE: its fifteen gate-matrix rows were inlined into
// `CARRIED_MATRIX_ROWS` below before deletion. Fourteen are still emitted; one, the pre-R3-01
// dev-build bypass, was retired by P0-04 through `RETIRED_CARRIED_ROWS`, with a named successor.
//
//   pnpm gen:corpus            # write the corpus
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if any file is stale)

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify as nodeVerify,
} from "node:crypto";
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
  base64UrlDecode,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@polaris-key/jws";
import { ED25519_TORSION_SUBGROUP, ed25519 } from "@noble/curves/ed25519.js";
import { isUsable, licenseState } from "@polaris-key/client-core/gate";
import { CHANNEL_ALIASES } from "@polaris-key/protocol/core";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { format } from "prettier";
import {
  CONTENT_CASES_NAME,
  CONTENT_DIR,
  CORPUS_CHUNK_PARAMS,
  buildContentCorpus,
  contentHashBytes,
  contentRef,
  contentStrays,
  loadContentSet,
  rebuildContentBlobs,
  type ContentSet,
  type RefJson,
} from "./gen-content-corpus.js";
import { buildSyncScenarios } from "./sync-scenarios.js";

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
  // Wire contract v4 §2.4: the CI-held RELEASE keys that sign `pkey-release+jws` records,
  // generated once with `crypto.generateKeyPairSync("ed25519")`. Never a product key, never in
  // a feed case's trust; the 2027 key is the rotation.
  {
    kid: "djdl-release-test-2026",
    publicKeyRaw: "U9d9Ix2jwC1-l_GJgrInN5zMPJgjPkgZC8Ekg7nKlEE",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMPC/pYWRN17C6MFlFHhktg/TQgXNUydx+PQtkD9KTBs\n-----END PRIVATE KEY-----",
  },
  {
    kid: "djdl-release-test-2027",
    publicKeyRaw: "TOde4jqFFVbzka-bES32oJRK6Whg1kqa16Jk7y3d2Lo",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIwJqSkvipky0ygUQh67CbUmFH5641YiVLQRAdtWfA3g\n-----END PRIVATE KEY-----",
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
const V2_UPDATE_MATRIX_OUT = join(V2_DIR, "update-matrix.json");
const V2_OUTLET_MATRIX_OUT = join(V2_DIR, "outlet-matrix.json");
const V2_PLAN_MATRIX_OUT = join(V2_DIR, "plan-matrix.json");
const V2_FEED_URL_MATRIX_OUT = join(V2_DIR, "feed-url-matrix.json");
const V2_SYNC_SCENARIOS_OUT = join(V2_DIR, "sync-scenarios.json");
/** Every directory that receives the corpus: the source, then each generator-owned mirror. */
const CORPUS_TARGETS = [V2_DIR, SWIFT_V2_RESOURCES, GODOT_V2_RESOURCES];

/** Document-type domain separators, wire contract v3 §2. */
type TypV3 =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws"
  | "pkey-feed+jws"
  | "pkey-release+jws";

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

  // §10: annotate every U+0000 string in each pinned document (one case today). Wire contract
  // v4's 44 vectors follow the existing 36, which stay byte-identical (plans/P3-01.md §4.3).
  const v4 = await buildJwsCasesV4();
  return [...cases, ...v4].map((c) =>
    placeNonWire({ ...c, expect: annotateNul(c.expect) }),
  );
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
  return [
    ...(await envelopeCases("license", "pkey-license+jws", licenseDoc)),
    // Wire contract v4 §3: the licence claim cases, after the family's last case.
    ...(await buildLicenseDocCasesV4()).map(placeNonWire),
  ];
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
    // Wire contract v4 §3: the config claim cases, after the family's last case.
    ...(await buildConfigDocCasesV4()).map(placeNonWire),
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
    // Wire contract v4 §3: the trust-manifest claim cases, after the family's last case.
    ...(await buildTrustCasesV4()).map(placeNonWire),
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
    // Wire contract v4 §3: the bundle claim cases, after the family's last case.
    ...(await buildBundleCasesV4()).map(placeNonWire),
  ];
}

async function buildV2(): Promise<unknown> {
  // Wire contract v4: the record vectors first, because every feed pins one by its hash.
  RECORDS = await buildRecordVectors();
  const corpus = {
    corpusVersion: 2,
    keys: KEYS,
    jwsCases: await buildJwsCases(),
    licenseDocCases: await buildLicenseDocCases(),
    configDocCases: await buildConfigDocCases(),
    trustCases: await buildTrustCasesV2(),
    clockFloorCases: await buildClockFloorCasesV2(),
    bundleCases: await buildBundleCases(),
    feedCases: await buildFeedCases(),
    // plans/P4-13.md §4.1: the feed's content members, parsed beside the claims.
    feedContentCases: await buildFeedContentCases(),
    releaseRecordCases: await buildReleaseRecordCases(RECORDS),
    // plans/P4-13.md §4.1: `kind: revocation` records against a feed entry.
    revocationCases: await buildRevocationCases(),
    // plans/P4-01.md §4.6 (P4-21): two new JWS families after the record cases.
    packRecordCases: await buildPackRecordCases(),
    markerCases: await buildMarkerCases(),
    // plans/P4-19.md §4.1: content-key delegation, appended as the last section.
    delegationCases: await buildDelegationCases(),
  };
  checkCorpusV4(corpus as unknown as Record<string, AnyCase[]>);
  checkPackClaimCases(corpus as unknown as Record<string, AnyCase[]>);
  return corpus;
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
  entitlementRows: EntitlementRow[];
} {
  return {
    gateMatrixVersion: 2,
    description:
      'Cross-SDK gate decision matrix for wire contract v3 §5. Each row carries the build-gate inputs (version/channel/compat window/entitlements) AND the license-state inputs, paired with the single expected decision. The first fourteen rows are corpus v1\'s matrix, carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` (every v1 product was licensed) and `hasToken` → `activation: "token" | null` — and inlined here when corpus v1 was deleted, so a v3 gate that changes any decision v2 made goes red here; a fifteenth carried row, the pre-R3-01 dev-build bypass, was retired by P0-04 and its successor row appended. The next rows pin what v1 could not express: `not-applicable` for a product that does not enable the license service (D-08), `activation: "bundle"` for an air-gapped install (§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint. `expect.reason` names the build-gate hint that was derived, which on the activation-precedes-blocked row is deliberately NOT the status. The channel rows that follow pin the channel vocabulary of §5.1 (P0-04): header normalisation, the `staging`/`beta` alias, the `pr` family, manual names, `dev`, and the build-implied channel. Times are epoch SECONDS. ManagedEntry values use the {state, value, updatedAt} shape. `entitlementRows` (SP-00, plans/SP-00.md D4) is a separate family over the same `gate` and `license` inputs, so a runner evaluates the status exactly as for `rows`: `entitlement.entry` is what the cached licence document carries at `entitlements[entitlement.key]` (null when it carries nothing, and always null without a document), and `expect.isEntitled` is `isUsable(status) && entry.value === true` — the entitlement answer follows the gate, so a revoked, expired or unactivated licence entitles nothing even while its cached document still says `true` (S-19 G11). The documents are today\'s licence shape (S-19 `legacy` mode): no new member and no per-entry expiry.',
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
    entitlementRows: entitlementRows(),
  };
}

// ── gate-matrix v2 `entitlementRows` (SP-00, plans/SP-00.md §4 and D4) ───────
// `isEntitled(key)` answers from the gate, not from the cached document alone: an SDK that reads
// `doc.entitlements[key].value` without asking the gate keeps entitling a revoked or expired
// licence (S-19 G11). Each row is evaluated here through client-core's own `licenseState` and
// `isUsable`, so a hand-authored `expect` that disagrees with the reference gate fails the run.

interface EntitlementRow {
  name: string;
  gate: typeof PASSING_GATE;
  license: {
    licenseServiceEnabled: boolean;
    activation: "token" | "bundle" | null;
    now: number;
    issuedAt?: number;
    expiresAt?: number;
    graceUntil?: number;
    lastSyncUnauthorized?: boolean;
    lastVerifiedAt?: number;
  };
  entitlement: { key: string; entry: ManagedEntry | null };
  expect: { status: string; isEntitled: boolean };
}

/** The entitlement every G11 row asks about: a DLC flag the admin enforces `true`. */
const DLC_ENFORCED_TRUE: ManagedEntry = {
  state: "enforced",
  value: true,
  updatedAt: 1699990000,
};

function entitlementRows(): EntitlementRow[] {
  const dlc = { key: "dlc", entry: DLC_ENFORCED_TRUE };
  const rows: EntitlementRow[] = [
    {
      name: "ok — dlc enforced true is entitled",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 1500,
        lastVerifiedAt: 1490,
      },
      entitlement: dlc,
      expect: { status: "ok", isEntitled: true },
    },
    {
      name: "grace — dlc enforced true is still entitled past expiresAt, inside graceUntil",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 5000,
      },
      entitlement: dlc,
      expect: { status: "grace", isEntitled: true },
    },
    {
      name: "expired — dlc enforced true in a document past graceUntil is not entitled",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 2593001,
      },
      entitlement: dlc,
      expect: { status: "expired", isEntitled: false },
    },
    {
      name: "revoked — hard 401 on the last sync: dlc enforced true in the cached document is not entitled (G11)",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: "token",
        ...MATRIX_DOC,
        now: 1500,
        lastSyncUnauthorized: true,
      },
      entitlement: dlc,
      expect: { status: "revoked", isEntitled: false },
    },
    {
      name: "needs-activation — an unactivated device is not entitled even with a cached dlc document",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: true,
        activation: null,
        ...MATRIX_DOC,
        now: 1500,
      },
      entitlement: dlc,
      expect: { status: "needs-activation", isEntitled: false },
    },
    {
      name: "not-applicable — usable, but no document means no entitlement",
      gate: PASSING_GATE,
      license: {
        licenseServiceEnabled: false,
        activation: null,
        now: 1500,
      },
      entitlement: { key: "dlc", entry: null },
      expect: { status: "not-applicable", isEntitled: false },
    },
  ];
  for (const row of rows) assertEntitlementRow(row);
  if (new Set(rows.map((r) => r.name)).size !== rows.length)
    throw new Error("gate-matrix entitlementRows has two rows with one name");
  return rows;
}

/** The row's status through client-core's gate, and `isEntitled` through `isUsable`. */
function assertEntitlementRow(row: EntitlementRow): void {
  const l = row.license;
  const hasDoc =
    l.issuedAt !== undefined &&
    l.expiresAt !== undefined &&
    l.graceUntil !== undefined;
  if (!hasDoc && row.entitlement.entry !== null)
    throw new Error(`${row.name}: an entry without a cached document`);
  const doc: LicenseDoc | null = hasDoc
    ? {
        aud: AUD_V3,
        iss: ISSUER_V3,
        licenseId: "lic_matrix",
        deviceId: "dev_matrix",
        issuedAt: l.issuedAt as number,
        expiresAt: l.expiresAt as number,
        graceUntil: l.graceUntil as number,
        entitlements:
          row.entitlement.entry === null
            ? {}
            : { [row.entitlement.key]: row.entitlement.entry },
      }
    : null;
  // PASSING_GATE derives no build-gate hint, so nothing is `blocked`.
  const state = licenseState({
    licenseServiceEnabled: l.licenseServiceEnabled,
    activation: l.activation,
    doc,
    now: l.now,
    lastSyncUnauthorized: l.lastSyncUnauthorized,
    lastVerifiedAt: l.lastVerifiedAt,
  });
  if (state.status !== row.expect.status)
    throw new Error(
      `${row.name}: client-core's gate says ${state.status}, the row says ${row.expect.status}`,
    );
  const entitled =
    isUsable(state.status) &&
    doc?.entitlements[row.entitlement.key]?.value === true;
  if (entitled !== row.expect.isEntitled)
    throw new Error(
      `${row.name}: isUsable(status) && value === true is ${entitled}, the row says ${row.expect.isEntitled}`,
    );
}

// ── stage-matrix v1 (client boot behaviour, outside the wire contract) ───────
// The boot stage machine (`@polaris-key/client-core/stages` and its Python and Swift ports),
// pinned as data. Unsigned, like the gate matrix: it pins a reducer, not a signature. The rows,
// `accepts` and `probes` are literal data built with small step helpers. Nothing here imports
// `client-core`: a golden file that shares code with the implementation it checks cannot catch
// a bug in that shared code. `buildStageMatrix` self-checks the rows before writing, so a row
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
    // Version 3 (plans/P4-01.md §2.10): fetch consent and progress.
    "fetch.consent",
    "fetch.progress",
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
    "consent_needed",
    "fetch_progress",
  ],
  guardActions: ["none", "apply-staged", "roll-back"],
};

/** The plan's "Accepted in" table. A key is a stage, `gate:waiting` for the gate while it waits
 *  for the player, `fetch:waiting` for the fetch while it waits for download consent, or
 *  `offline:playable` for an offline stop that can play what is present (version 3). */
const STAGE_ACCEPTS: Record<string, string[]> = {
  idle: ["start"],
  shell: ["shell.done", "fail"],
  guard: ["guard.done", "fail"],
  sync: ["sync.done", "sync.timeout", "fail"],
  gate: ["gate.status", "fail"],
  "gate:waiting": ["gate.status", "retry"],
  decide: ["decide.done", "fail"],
  fetch: ["fetch.done", "fetch.consent", "fetch.progress", "fail"],
  "fetch:waiting": ["fetch.done", "fetch.progress"],
  mount: ["mount.done", "fail"],
  ready: ["background.start"],
  background: ["background.done"],
  offline: ["retry"],
  "offline:playable": ["retry", "play-offline"],
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
  essentialPacks?: string[];
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
const evConsent = (bytes: number, metered: boolean): StageEvent => ({
  type: "fetch.consent",
  bytes,
  metered,
});
const evProgress = (done: number, total: number): StageEvent => ({
  type: "fetch.progress",
  done,
  total,
});

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
const emOfflinePlayable: StageEmit = { type: "offline", canPlayOffline: true };
const emConsent = (bytes: number, metered: boolean): StageEmit => ({
  type: "consent_needed",
  bytes,
  metered,
});
const emProgress = (done: number, total: number): StageEmit => ({
  type: "fetch_progress",
  done,
  total,
});

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
/** Version 3's `essentialPacks` (plans/P4-01.md §4.7): `D+KE` and `D+E`. */
const INIT_D_KE: StageInit = {
  ...INIT_D,
  requiredPacks: ["core"],
  essentialPacks: ["core", "hd"],
};
const INIT_D_E: StageInit = { ...INIT_D, essentialPacks: ["hd"] };

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
    // ── Version 3 (plans/P4-01.md §2.10, §4.7): packs — consent, progress, a playable
    // offline. Every row runs `P`, then `sync ok`, `gate ok`, `decide.done none`.
    ...packStageRows(),
  ];
}

/** `P`, `sync ok`, `gate ok`, `decide.done none`: every version 3 row's lead-in. */
const toFetch = (): StageStep[] => [
  ...prefix(),
  toGate("ok"),
  pass(),
  step(evDecide("none"), changed("fetch", "decide")),
];
/** The stages `toFetch` enters. */
const S_FETCH = [...S_BASE, "gate", "decide", "fetch"];
const MB50 = 52428800;

/** plans/P4-01.md §4.7's thirteen rows (57–69). */
function packStageRows(): StageRow[] {
  const resync = (): StageStep[] => [
    step(evRetry, changed("sync", "blocked")),
    toGate("ok"),
    pass(),
    step(evDecide("none"), changed("fetch", "decide")),
  ];
  const declined = (): StageStep[] => [
    ...toFetch(),
    step(evConsent(MB50, true), emConsent(MB50, true)),
    step(
      evFetch("declined", []),
      changed("blocked", "fetch"),
      emBlocked("content-declined"),
    ),
  ];
  const offlinePlayable = (): StageStep[] => [
    ...toFetch(),
    step(
      evFetch("offline", ["core"]),
      changed("offline", "fetch"),
      emOfflinePlayable,
    ),
  ];
  const mountReady = (installed: string[], from = "fetch"): StageStep[] => [
    step(evFetch("ok", installed), changed("mount", from)),
    step(evMountDone, changed("ready", "mount"), emBootReady),
  ];
  return [
    {
      name: "ready — a required download asks first, then fetches with progress",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evConsent(MB50, false), emConsent(MB50, false)),
        step(evProgress(0, MB50), emProgress(0, MB50)),
        step(evProgress(MB50, MB50), emProgress(MB50, MB50)),
        ...mountReady(["core"]),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "waiting — consent waits for the player on a metered network",
      init: INIT_D_K,
      steps: [...toFetch(), step(evConsent(MB50, true), emConsent(MB50, true))],
      expect: { stages: S_FETCH, outcome: "waiting" },
    },
    {
      name: "blocked — the player declines a required download",
      init: INIT_D_K,
      steps: declined(),
      expect: { stages: [...S_FETCH, "blocked"], outcome: "blocked" },
    },
    {
      name: "ready — retry after a declined download asks again",
      init: INIT_D_K,
      steps: [
        ...declined(),
        ...resync(),
        step(evConsent(MB50, false), emConsent(MB50, false)),
        step(evProgress(0, MB50), emProgress(0, MB50)),
        ...mountReady(["core"]),
      ],
      expect: {
        stages: [
          ...S_FETCH,
          "blocked",
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
      name: "ready — declining essential content that is not required plays without it",
      init: INIT_D_E,
      steps: [
        ...toFetch(),
        step(evConsent(1048576, true), emConsent(1048576, true)),
        step(evFetch("declined", []), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "offline — essential content cannot download, and the required set is present",
      init: INIT_D_KE,
      steps: offlinePlayable(),
      expect: { stages: [...S_FETCH, "offline"], outcome: "offline" },
    },
    {
      name: "ready — play-offline from that card plays what is present",
      init: INIT_D_KE,
      steps: [
        ...offlinePlayable(),
        step(evPlayOffline, changed("mount", "offline")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: {
        stages: [...S_FETCH, "offline", "mount", "ready"],
        outcome: "ready",
      },
    },
    {
      name: "ready — retry from that card syncs again",
      init: INIT_D_KE,
      steps: [
        ...offlinePlayable(),
        step(evRetry, changed("sync", "offline")),
        toGate("ok"),
        pass(),
        step(evDecide("none"), changed("fetch", "decide")),
        ...mountReady(["core", "hd"]),
      ],
      expect: {
        stages: [
          ...S_FETCH,
          "offline",
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
      name: "offline — a missing required pack stays unplayable, and play-offline is ignored",
      init: INIT_D_KE,
      steps: [
        ...toFetch(),
        step(evFetch("offline", []), changed("offline", "fetch"), emOffline),
        ignored(evPlayOffline),
      ],
      expect: { stages: [...S_FETCH, "offline"], outcome: "offline" },
    },
    {
      name: "ready — a failed essential download never blocks when the required set is present",
      init: INIT_D_KE,
      steps: [
        ...toFetch(),
        step(evFetch("failed", ["core"]), changed("mount", "fetch")),
        step(evMountDone, changed("ready", "mount"), emBootReady),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "ready — progress without a consent step",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evProgress(0, 1000), emProgress(0, 1000)),
        step(evProgress(1000, 1000), emProgress(1000, 1000)),
        ...mountReady(["core"]),
      ],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
    },
    {
      name: "waiting — fail, a second consent and play-offline are ignored while consent waits",
      init: INIT_D_K,
      steps: [
        ...toFetch(),
        step(evConsent(1000, false), emConsent(1000, false)),
        ignored(evFail("consent-failed")),
        ignored(evConsent(2000, false)),
        ignored(evPlayOffline),
      ],
      expect: { stages: S_FETCH, outcome: "waiting" },
    },
    {
      name: "ready — every essential pack is present: nothing is asked",
      init: INIT_D_KE,
      steps: [...toFetch(), ...mountReady(["core", "hd"])],
      expect: { stages: [...S_FETCH, "mount", "ready"], outcome: "ready" },
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
  evConsent(0, false),
  evProgress(0, 0),
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

  // accepts: exactly the 13 stages plus gate:waiting, fetch:waiting and offline:playable,
  // listing vocabulary events only.
  const keys = [
    ...v.stages,
    "gate:waiting",
    "fetch:waiting",
    "offline:playable",
  ];
  if (!same(Object.keys(STAGE_ACCEPTS).sort(), [...keys].sort()))
    fail(
      "accepts must have the 13 stages, gate:waiting, fetch:waiting and offline:playable as its keys",
    );
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
    fetch: ["running", "waiting"],
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
          if (em.previous !== key.split(":")[0])
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
        // Version 3: consent waits in the fetch, progress resumes it, and a playable offline
        // stop takes play-offline.
        if (em.type === "consent_needed") {
          if (key !== "fetch")
            fail(`${where}: consent_needed outside the fetch`);
          key = "fetch:waiting";
        }
        if (em.type === "fetch_progress") {
          if (key !== "fetch" && key !== "fetch:waiting")
            fail(`${where}: fetch_progress outside the fetch`);
          key = "fetch";
        }
        if (em.type === "offline" && em.canPlayOffline === true) {
          if (key !== "offline")
            fail(`${where}: a playable offline outside offline`);
          key = "offline:playable";
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
    if (
      final === "fetch" &&
      (row.expect.outcome === "waiting") !== (key === "fetch:waiting")
    )
      fail(`${row.name}: the fetch's outcome disagrees with its consent emit`);
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

function buildStageMatrix(): unknown {
  const rows = stageRows();
  checkStageMatrix(rows, STAGE_GUARD_CASES);
  checkConfirmCases();
  return {
    stageMatrixVersion: 3,
    description:
      "The boot stage machine (client boot behaviour, outside the wire contract), owned by `@polaris-key/client-core/stages` and ported to every SDK. Each row starts from `initialBootState(init)` (an omitted option takes its default: allowOffline true, allowGrace true, requiredPacks []) and feeds `bootTransition` its steps in order; each step lists the exact emits that event produces, `stage_changed` first. `expect.stages` is every stage entered, in order, and its last entry is the final stage; `expect.outcome` is the final outcome. Events are dotted, emits snake_case, payload keys camelCase and payload values kebab-case. An event the current stage does not accept, or a malformed one, is ignored: the state comes back unchanged with no emits. `accepts` lists what each stage accepts (`gate:waiting` is the gate while it waits for the player), and a runner sends every probe at the initial state and after every step of every row, asserting an unchanged state and no emits exactly when the probe's type is not accepted there. `guardCases` pin `bootGuardAction`, which rolls back at `maxFailedBoots`. Version 2 (plans/P3-01.md §2.10) adds boot confirmation: `confirmCases` pin `bootConfirmation(outcome)`, one per outcome (`now` for waiting, blocked and offline; `after-ok-seconds` for ready, confirmed once the outcome has been `ready` for `bootOkSeconds` with the process alive, or by the game's `confirmBoot()`; `never` for running and error), and a confirmed launch resets `failedBoots` to 0. Version 3 (plans/P4-01.md §2.10) adds packs: the option `essentialPacks` (default []: packs the boot wants before ready but can play without), `fetch.consent {bytes, metered}` (accepted in `fetch`: the outcome waits, key `fetch:waiting`, and `consent_needed` is emitted), `fetch.progress {done, total}` (integers, 0 <= done <= total; accepted in `fetch` and `fetch:waiting`: the outcome runs, `fetch_progress` is emitted), `fetch.done` accepted in `fetch:waiting` and its result `declined`. The fetch rule: with a required pack missing, `offline` stops at `offline {canPlayOffline: false}`, `declined` at `blocked {reason: content-declined}` and anything else at `error {fetch-failed}`; with every required pack present and an essential one missing, `offline` stops at `offline {canPlayOffline: true}` (key `offline:playable`, where `play-offline` goes to `mount`); otherwise `mount`. `BootState.canPlayOffline` is true only at that playable offline stop. Append-only: a change to the vocabulary, to `accepts` or to an existing row's expectation bumps `stageMatrixVersion`.",
    maxFailedBoots: STAGE_MAX_FAILED_BOOTS,
    bootOkSeconds: STAGE_BOOT_OK_SECONDS,
    vocabulary: { ...STAGE_VOCABULARY, confirmations: STAGE_CONFIRMATIONS },
    accepts: STAGE_ACCEPTS,
    probes: STAGE_PROBES,
    rows,
    guardCases: STAGE_GUARD_CASES,
    confirmCases: STAGE_CONFIRM_CASES,
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

// ══════════════════════════════════════════════════════════════════════════════════════════
// Wire contract v4 (docs/security/WIRE-CONTRACT-V4.md, plans/P3-01.md §2–§4)
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Everything below restates the v4 rules as literals and reference implementations, written
// from the plan and importing nothing it checks: the strict verifier's vectors, the feed and
// record families, the per-claim integer cases, `update-matrix.json`, `outlet-matrix.json`
// and the stage matrix's confirmation cases. Each builder recomputes its own expectations and
// throws when a hand-written expectation disagrees, so a row that contradicts the plan fails
// `gen:corpus` instead of shipping.

/** V4 §3: the largest integer claim, 2^53 − 1. */
const MAX_WIRE_INTEGER_REF = 9007199254740991;
/** The v4 feed clocks, beside `V3_ISSUED`. */
const FEED_ISSUED = V3_ISSUED;
const FEED_EXPIRES = FEED_ISSUED + 900;
const FEED_NOW = FEED_ISSUED + 100;
const FEED_TTL_REF = 900;
const MAX_FEED_TTL_REF = 3600;
const ROLLOUT_BUCKETS_REF = 10000;
/** The release keys (V4 §2.4). Records are signed by these two, never by a product key. */
const REL_KID = "djdl-release-test-2026";
const REL2_KID = "djdl-release-test-2027";

// ── Raw tokens and raw bytes ─────────────────────────────────────────────────────────────────
// `JSON.stringify` cannot write `7.0`, `17e8` or `9007199254740993`, so a vector that needs one
// carries the string `raw(token)` and `rawJson` splices the token in after serialising.

const RAW_RE = /"@@raw:([^"@]*)@@"/g;
const raw = (token: string): string => `@@raw:${token}@@`;
const rawJson = (value: unknown): string =>
  JSON.stringify(value).replace(RAW_RE, "$1");
const headerText = (typ: TypV3, kid: string): string =>
  JSON.stringify({ alg: "EdDSA", typ, kid });
const utf8Bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s);

/** Sign raw header and payload BYTES — the UTF-8 and BOM vectors, which text cannot hold. */
async function signRawBytes(
  header: Uint8Array,
  payload: Uint8Array,
  kid: string,
): Promise<string> {
  const signingInput = `${base64UrlEncodeBytes(header)}.${base64UrlEncodeBytes(payload)}`;
  const key = await importSigningKey(pem(kid));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8Bytes(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

/** Sign a payload given as JSON TEXT (with any raw tokens already spliced in). */
const signText = (text: string, kid: string, typ: TypV3): Promise<string> =>
  signRawSegments(headerText(typ, kid), text, kid);

// ── Ed25519 constructions (V4 §1.1), on @noble/curves — vectors only, never a verifier ────────

const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const ED_P = 2n ** 255n - 19n;
const EdPoint = ed25519.Point;

function leToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(bytes[k]!);
  return n;
}
function bigToLe(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let k = 0; k < length; k++, n >>= 8n) out[k] = Number(n & 0xffn);
  return out;
}
const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const bytesHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}
const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

/** The secret scalar of a committed PKCS#8 key: SHA-512 of the seed, clamped (RFC 8032). */
function secretScalar(kid: string): bigint {
  const der = Buffer.from(
    pem(kid)
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  const h = sha512(new Uint8Array(der.subarray(der.length - 32)));
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return leToBig(h.subarray(0, 32));
}

/** A deterministic nonce for the hand-built signatures: SHA-512 of a label, mod L. */
const nonce = (label: string, counter: number): bigint =>
  leToBig(sha512(utf8Bytes(`pkey-corpus-v4-r:${label}:${counter}`))) % ED_L;

/** `k = H(R ‖ A ‖ M) mod L` over the ASCII signing input. */
const challenge = (rEnc: Uint8Array, aEnc: Uint8Array, input: string): bigint =>
  leToBig(sha512(rEnc, aEnc, utf8Bytes(input))) % ED_L;

/** Assemble a compact JWS from text segments and a hand-built `R ‖ S`. */
function assembleJws(
  header: string,
  payload: string,
  rEnc: Uint8Array,
  s: bigint,
): string {
  const input = `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(payload))}`;
  const sig = new Uint8Array(64);
  sig.set(rEnc, 0);
  sig.set(bigToLe(s, 32), 32);
  return `${input}.${base64UrlEncodeBytes(sig)}`;
}

/** Sign `payload` as `kid` (header) with the hand-held scalar `a` of key `aEnc`, using `rEnc`
 *  (and its scalar `r`, or 0 for a non-point / identity `R`). Optionally grind the nonce until
 *  `k mod 8` satisfies `want` — the order-8 and mixed-order constructions. */
function handSign(opts: {
  kid: string;
  payload: string;
  aEnc: Uint8Array;
  a: bigint;
  label: string;
  rEnc?: Uint8Array;
  kMod8?: "zero" | "nonzero";
}): { jws: string; k: bigint; s: bigint } {
  const header = headerText("pkey-license+jws", opts.kid);
  const input = (): string =>
    `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(opts.payload))}`;
  for (let counter = 0; counter < 512; counter++) {
    let r = 0n;
    let rEnc = opts.rEnc;
    if (!rEnc) {
      r = nonce(opts.label, counter);
      rEnc = EdPoint.BASE.multiply(r).toBytes();
    }
    const k = challenge(rEnc, opts.aEnc, input());
    if (opts.kMod8 === "zero" && k % 8n !== 0n) continue;
    if (opts.kMod8 === "nonzero" && k % 8n === 0n) continue;
    const s = (r + k * opts.a) % ED_L;
    return { jws: assembleJws(header, opts.payload, rEnc, s), k, s };
  }
  throw new Error(`handSign: could not grind ${opts.label}`);
}

/** The small-order encodings, restated (V4 §1.1 check 3). */
const SMALL_ORDER_REF = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];
const IDENTITY_ENC = hexBytes(SMALL_ORDER_REF[0]!);
/** The identity with y = p + 1, a non-canonical encoding (check 2). */
const IDENTITY_Y_P_PLUS_1 = bigToLe(ED_P + 1n, 32);
/** x = 0 with the sign bit set: `01 00…00 80` (check 2). */
const NEGATIVE_ZERO_ENC = hexBytes(
  "0100000000000000000000000000000000000000000000000000000000000080",
);
const ORDER8_ENC = hexBytes(SMALL_ORDER_REF[6]!);

/** Self-checks of the constructions (plans/P3-01.md §4.9). */
function checkEd25519Tables(): void {
  const fail = (m: string): never => {
    throw new Error(`ed25519: ${m}`);
  };
  const torsion = new Set(ED25519_TORSION_SUBGROUP);
  if (torsion.size !== 8 || !SMALL_ORDER_REF.every((h) => torsion.has(h)))
    fail("the small-order table differs from noble's torsion subgroup");
  for (const h of SMALL_ORDER_REF)
    if (!EdPoint.fromHex(h).isSmallOrder()) fail(`${h} is not small order`);
  const t8 = EdPoint.fromHex(SMALL_ORDER_REF[6]!);
  if (t8.multiplyUnsafe(4n).equals(EdPoint.ZERO))
    fail("the order-8 point has order 4");
  if (!t8.multiplyUnsafe(8n).equals(EdPoint.ZERO))
    fail("the order-8 point is not order 8");
  if (leToBig(IDENTITY_Y_P_PLUS_1) !== ED_P + 1n) fail("y = p + 1 encoding");
  const pinA = base64UrlDecode(pub(PIN_KID));
  if (
    bytesHex(EdPoint.BASE.multiply(secretScalar(PIN_KID) % ED_L).toBytes()) !==
    bytesHex(pinA)
  )
    fail("the PIN key's scalar does not reproduce its public key");
}

// ── The generator's own JSON token scan (V4 §1.2, §3) ─────────────────────────────────────────

/** The RFC 6901 pointer → token of every number in `text` (assumed to be well-formed JSON). */
function refNumberTokens(text: string): Map<string, string> {
  const tokens = new Map<string, string>();
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const str = (): string => {
    // Delegate unescaping to JSON.parse on the exact literal (it is valid JSON by assumption).
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (pointer: string): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const name = str();
        ws();
        i++; // ':'
        value(`${pointer}/${pointerToken(name)}`);
        ws();
        if (text[i++] === "}") return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (let k = 0; ; k++) {
        value(`${pointer}/${k}`);
        ws();
        if (text[i++] === "]") return;
      }
    }
    if (c === '"') {
      str();
      return;
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(i),
    );
    if (m) {
      tokens.set(pointer, m[0]);
      i += m[0].length;
      return;
    }
    for (const lit of ["true", "false", "null"])
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    throw new Error(`refNumberTokens: not JSON at ${i}`);
  };
  value("");
  return tokens;
}

const PLAIN_INTEGER_REF = /^-?(0|[1-9][0-9]*)$/;
/** V4 §3: a token that cannot be a wire integer (a fraction, an exponent, or > 2^53 − 1). */
function refIsNonWire(token: string): boolean {
  if (!PLAIN_INTEGER_REF.test(token)) return true;
  const v = BigInt(token);
  return v > BigInt(MAX_WIRE_INTEGER_REF) || v < -BigInt(MAX_WIRE_INTEGER_REF);
}
/** The payload's non-wire-integer pointers, sorted in JavaScript's default string order. */
const refNonWire = (text: string): string[] =>
  [...refNumberTokens(text)]
    .filter(([, t]) => refIsNonWire(t))
    .map(([p]) => p)
    .sort();

/** The decoded payload text of a compact JWS (or null when it is not one). */
function payloadTextOf(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(parts[1]!),
    );
  } catch {
    return null;
  }
}

// ── The generator's own claim checks, for all six typs ────────────────────────────────────────
// One integer check, three switchable halves: the token rule, the 2^53 − 1 bound, and the
// claim's minimum (§2.2 "Minimums", one literal table below). `off` switches one half off at
// one pointer, which is how §4.9's per-claim self-check proves a case breaks that claim alone.

interface ClaimCtx {
  tokens: Map<string, string>;
  off: ReadonlySet<string>;
}
const ctxOf = (text: string, off: Iterable<string> = []): ClaimCtx => ({
  tokens: refNumberTokens(text),
  off: new Set(off),
});

/** §2.2 "Minimums": the 21 integer-claim paths (`*` is any index or member), plans/P4-01.md
 *  §2.5's 16 pack and `content` paths and plans/P4-10.md §2.2's two `chunks` paths (39 in all). */
const INTEGER_CLAIM_MINIMUMS: Readonly<Record<string, Record<string, number>>> =
  {
    envelope: { "/issuedAt": 0, "/expiresAt": 0, "/graceUntil": 0 },
    config: { "/schemaVersion": 1 },
    trust: { "/schemaVersion": 1, "/issuedAt": 0, "/expiresAt": 0 },
    bundle: { "/issuedAt": 0, "/expiresAt": 0 },
    feed: {
      "/schemaVersion": 1,
      "/seq": 1,
      "/issuedAt": 0,
      "/expiresAt": 1,
      "/app/targets/*/release/seq": 1,
      "/app/targets/*/outlets/*/live/seq": 1,
      "/app/targets/*/outlets/*/rollout/bp": 0,
    },
    record: {
      "/schemaVersion": 1,
      "/seq": 1,
      "/issuedAt": 0,
      "/minSupportedSeq": 1,
      "/builds/*/artifacts/*/size": 0,
    },
    // plans/P4-01.md §2.5: the pack record's 14 paths and the app record's two `content` paths.
    pack: {
      "/formatVersion": 1,
      "/handler/mountOrder": 0,
      "/variants/*/payload/size": 0,
      "/variants/*/full/bytes": 0,
      "/variants/*/full/size": 0,
      "/variants/*/files/bytes": 1,
      "/variants/*/files/size": 1,
      "/variants/*/files/gaps/bytes": 0,
      "/variants/*/files/gaps/size": 0,
      "/variants/*/deltas/*/memBytes": 1,
      "/variants/*/deltas/*/artifact/bytes": 1,
      "/variants/*/deltas/*/patch/bytes": 1,
      "/variants/*/deltas/*/patch/size": 1,
      "/variants/*/deltas/*/data/bytes": 1,
      // plans/P4-10.md §2.2: the chunk index's object ref (`bytes` and `size` from 1).
      "/variants/*/chunks/bytes": 1,
      "/variants/*/chunks/size": 1,
    },
    content: { "/content/contentApi": 1, "/content/pins/*/release/seq": 1 },
  };
/** A concrete pointer's path (`/app/targets/0/release/seq` → `/app/targets/*\/release/seq`). */
function claimPathOf(family: string, pointer: string): string | null {
  const parts = pointer.split("/");
  for (const path of Object.keys(INTEGER_CLAIM_MINIMUMS[family]!)) {
    const want = path.split("/");
    if (want.length !== parts.length) continue;
    if (want.every((w, k) => w === "*" || w === parts[k])) return path;
  }
  return null;
}
function minimumOf(family: string, pointer: string): number {
  const path = claimPathOf(family, pointer);
  if (path === null) throw new Error(`no minimum for ${family} ${pointer}`);
  return INTEGER_CLAIM_MINIMUMS[family]![path]!;
}

function refInt(
  ctx: ClaimCtx,
  family: string,
  value: unknown,
  pointer: string,
): boolean {
  const token = ctx.tokens.get(pointer);
  if (typeof value !== "number" || token === undefined) return false;
  const min = minimumOf(family, pointer);
  const plain = PLAIN_INTEGER_REF.test(token);
  if (!plain && !ctx.off.has(`token:${pointer}`)) return false;
  const big = plain ? BigInt(token) : null;
  const over =
    big !== null
      ? big > BigInt(MAX_WIRE_INTEGER_REF)
      : value > MAX_WIRE_INTEGER_REF;
  if (over && !ctx.off.has(`bound:${pointer}`)) return false;
  const under = big !== null ? big < BigInt(min) : value < min;
  if (under && !ctx.off.has(`min:${pointer}`)) return false;
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

interface EnvelopeOpts {
  expectedAud: string;
  deviceId: string;
  now: number;
  checkFreshness?: boolean;
  lastAcceptedIssuedAt?: number;
}

/** V3 §3's envelope and the licence or config claims, with V4 §3's integer rule. */
function refDocClaims(
  typ: TypV3,
  doc: unknown,
  ctx: ClaimCtx,
  o: EnvelopeOpts,
): boolean {
  if (!isObj(doc)) return false;
  if (doc.aud !== o.expectedAud || doc.iss !== ISSUER_V3) return false;
  if (doc.deviceId !== o.deviceId) return false;
  const e = "envelope";
  if (!refInt(ctx, e, doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, e, doc.expiresAt, "/expiresAt")) return false;
  if (!refInt(ctx, e, doc.graceUntil, "/graceUntil")) return false;
  const [iat, exp, grace] = [
    doc.issuedAt,
    doc.expiresAt,
    doc.graceUntil,
  ] as number[];
  if (o.lastAcceptedIssuedAt !== undefined && iat! <= o.lastAcceptedIssuedAt)
    return false;
  if (grace! < exp! || grace! > iat! + MAX_GRACE_SECONDS) return false;
  if (o.checkFreshness !== false) {
    if (iat! > o.now + CLOCK_SKEW || exp! <= o.now - CLOCK_SKEW) return false;
  }
  if (typ === "pkey-license+jws") {
    if (typeof doc.licenseId !== "string" || doc.licenseId === "") return false;
    if (!isObj(doc.entitlements)) return false;
    if (hasOwn(doc, "profile") && !isObj(doc.profile)) return false;
    return true;
  }
  if (!refInt(ctx, "config", doc.schemaVersion, "/schemaVersion")) return false;
  return isObj(doc.config) && isObj(doc.secrets);
}

/** V3 §1 / §2.3's trust-manifest claims; the keys and the substitution rule. */
function refTrustClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: { pinned: Record<string, string>; now: number; checkFreshness?: boolean },
): Record<string, string> | null {
  if (!isObj(doc)) return null;
  const t = "trust";
  if (
    !refInt(ctx, t, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return null;
  if (doc.aud !== AUD_V3 || doc.iss !== ISSUER_V3) return null;
  if (!refInt(ctx, t, doc.issuedAt, "/issuedAt")) return null;
  if (!refInt(ctx, t, doc.expiresAt, "/expiresAt")) return null;
  if (o.checkFreshness !== false) {
    if ((doc.issuedAt as number) > o.now + CLOCK_SKEW) return null;
    if ((doc.expiresAt as number) <= o.now - CLOCK_SKEW) return null;
  }
  if (!Array.isArray(doc.keys)) return null;
  const out: Record<string, string> = {};
  for (const key of doc.keys) {
    if (
      !isObj(key) ||
      typeof key.kid !== "string" ||
      typeof key.publicKey !== "string"
    )
      return null;
    if (hasOwn(o.pinned, key.kid) && o.pinned[key.kid] !== key.publicKey)
      return null;
    if (key.status === "revoked") continue;
    if (key.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519")
      continue;
    out[key.kid] = key.publicKey;
  }
  return out;
}

/** V3 §7 step 2: the bundle's own claims, and the `docs` shapes (V4 §3 presence). */
function refBundleClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: { now: number; deviceId: string },
): boolean {
  if (!isObj(doc)) return false;
  if (typeof doc.bundleId !== "string" || doc.bundleId === "") return false;
  if (typeof doc.trust !== "string") return false;
  if (doc.aud !== AUD_V3 || doc.deviceId !== o.deviceId) return false;
  if (!refInt(ctx, "bundle", doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, "bundle", doc.expiresAt, "/expiresAt")) return false;
  if ((doc.issuedAt as number) > o.now + CLOCK_SKEW) return false;
  if (o.now > (doc.expiresAt as number) + CLOCK_SKEW) return false;
  if (!isObj(doc.docs)) return false;
  const docs = doc.docs;
  for (const k of ["license", "config"])
    if (hasOwn(docs, k) && typeof docs[k] !== "string") return false;
  return hasOwn(docs, "license") || hasOwn(docs, "config");
}

// ── Versions (plans/P3-01.md §2.8), the generator's own comparator ───────────────────────────

const REF_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const REF_FOUR_PART_RE = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){3}$/;
const REF_SCHEMES = ["semver", "semver+build", "4part"] as const;

function refParseVersion(
  scheme: string,
  v: unknown,
): { core: string[]; pre: string[] | null; build: string | null } | null {
  if (typeof v !== "string") return null;
  if (scheme === "4part") {
    if (!REF_FOUR_PART_RE.test(v)) return null;
    return { core: v.split("."), pre: null, build: null };
  }
  if (scheme !== "semver" && scheme !== "semver+build") return null;
  const m = REF_SEMVER_RE.exec(v);
  if (!m) return null;
  return {
    core: [m[1]!, m[2]!, m[3]!],
    pre: m[4] === undefined ? null : m[4].split("."),
    build: m[5] ?? null,
  };
}

/** Unbounded integers as digit strings: strip leading zeros, then length, then ASCII. */
function refCmpDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=.)/, "");
  const y = b.replace(/^0+(?=.)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

function refCompareVersions(
  scheme: string,
  a: unknown,
  b: unknown,
): number | null {
  const pa = refParseVersion(scheme, a);
  const pb = refParseVersion(scheme, b);
  if (!pa || !pb) return null;
  for (let k = 0; k < pa.core.length; k++) {
    const c = refCmpDigits(pa.core[k]!, pb.core[k]!);
    if (c !== 0) return c;
  }
  if (scheme === "4part") return 0;
  let c = 0;
  if (pa.pre === null && pb.pre !== null) c = 1;
  else if (pa.pre !== null && pb.pre === null) c = -1;
  else if (pa.pre !== null && pb.pre !== null) {
    const n = Math.min(pa.pre.length, pb.pre.length);
    for (let k = 0; k < n && c === 0; k++) {
      const x = pa.pre[k]!;
      const y = pb.pre[k]!;
      const xn = /^[0-9]+$/.test(x);
      const yn = /^[0-9]+$/.test(y);
      if (xn && yn) c = refCmpDigits(x, y);
      else if (xn !== yn) c = xn ? -1 : 1;
      else c = x === y ? 0 : x < y ? -1 : 1;
    }
    if (c === 0 && pa.pre.length !== pb.pre.length)
      c = pa.pre.length < pb.pre.length ? -1 : 1;
  }
  if (c !== 0 || scheme !== "semver+build") return c;
  const na = pa.build !== null && /^[0-9]+$/.test(pa.build) ? pa.build : null;
  const nb = pb.build !== null && /^[0-9]+$/.test(pb.build) ? pb.build : null;
  if (na === null && nb === null) return 0;
  if (na === null) return -1;
  if (nb === null) return 1;
  return refCmpDigits(na, nb);
}

// ── Outlet kinds and capabilities (plans/P3-01.md §2.9), restated as literals ────────────────

const REF_OUTLET_KINDS = [
  "direct",
  "app-store",
  "testflight",
  "altstore",
  "altstore-pal",
  "play",
  "play-testing",
  "obtainium",
  "fdroid-repo",
  "ms-store",
  "app-installer",
  "steam",
  "itch",
  "flathub",
  "snap",
  "winget",
  "web",
] as const;
const REF_RELEASE_PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
];
const REF_OUTLET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REF_BINARY_ORDER = ["none", "store", "self"];

interface RefCaps {
  binaryUpdates: string;
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: string;
  downloadedScripts: boolean;
}
const refCaps = (
  binaryUpdates: string,
  codeUpdates: boolean,
  dataUpdates: boolean,
  channelSwitch: boolean,
  commerce: string,
  downloadedScripts: boolean,
): RefCaps => ({
  binaryUpdates,
  codeUpdates,
  dataUpdates,
  channelSwitch,
  commerce,
  downloadedScripts,
});
/** §2.9's table, row for row; `platforms` is each kind's list (`unknown`: every platform). */
const REF_KIND_TABLE: Record<string, RefCaps & { platforms: string[] }> = {
  direct: {
    ...refCaps("self", true, true, true, "own", true),
    platforms: ["macos", "windows", "linux", "android", "ios"],
  },
  "app-store": {
    ...refCaps("store", false, true, false, "store-iap", false),
    platforms: ["ios", "macos"],
  },
  testflight: {
    ...refCaps("store", false, true, false, "store-iap", false),
    platforms: ["ios", "macos"],
  },
  altstore: {
    ...refCaps("store", false, true, false, "own", false),
    platforms: ["ios"],
  },
  "altstore-pal": {
    ...refCaps("store", false, true, false, "own", false),
    platforms: ["ios"],
  },
  play: {
    ...refCaps("store", false, true, false, "store-iap", false),
    platforms: ["android"],
  },
  "play-testing": {
    ...refCaps("store", false, true, false, "store-iap", false),
    platforms: ["android"],
  },
  obtainium: {
    ...refCaps("store", false, true, false, "own", false),
    platforms: ["android"],
  },
  "fdroid-repo": {
    ...refCaps("store", false, true, false, "own", false),
    platforms: ["android"],
  },
  "ms-store": {
    ...refCaps("store", false, true, false, "store-iap", false),
    platforms: ["windows"],
  },
  "app-installer": {
    ...refCaps("none", false, true, false, "own", false),
    platforms: ["windows"],
  },
  steam: {
    ...refCaps("none", false, true, false, "steam", false),
    platforms: ["windows", "macos", "linux"],
  },
  itch: {
    ...refCaps("none", false, true, false, "own", false),
    platforms: ["windows", "macos", "linux"],
  },
  flathub: {
    ...refCaps("none", false, true, false, "own", false),
    platforms: ["linux"],
  },
  snap: {
    ...refCaps("none", false, true, false, "own", false),
    platforms: ["linux"],
  },
  winget: {
    ...refCaps("none", false, true, false, "own", false),
    platforms: ["windows"],
  },
  web: {
    ...refCaps("none", false, true, false, "own", true),
    platforms: ["web"],
  },
  unknown: {
    ...refCaps("none", false, false, false, "none", false),
    platforms: [...REF_RELEASE_PLATFORMS],
  },
};
const REF_PLATFORM_NARROWING: Record<
  string,
  Record<string, Partial<RefCaps>>
> = {
  ios: {
    direct: {
      binaryUpdates: "store",
      codeUpdates: false,
      downloadedScripts: false,
    },
  },
};
const REF_SUBKINDS = [
  "homebrew",
  "npm",
  "pnpm",
  "npx",
  "scoop",
  "chocolatey",
  "flatpak",
  "appimage",
];
const REF_PACKAGE_MANAGED: Partial<RefCaps> = {
  binaryUpdates: "none",
  codeUpdates: false,
};
const REF_SUBKIND_NARROWING: Record<string, Partial<RefCaps>> = {
  homebrew: REF_PACKAGE_MANAGED,
  npm: REF_PACKAGE_MANAGED,
  pnpm: REF_PACKAGE_MANAGED,
  npx: REF_PACKAGE_MANAGED,
  scoop: REF_PACKAGE_MANAGED,
  chocolatey: REF_PACKAGE_MANAGED,
  flatpak: REF_PACKAGE_MANAGED,
  appimage: {},
};
const REF_LISTING_PREFIXES: Record<string, string[]> = {
  "app-store": ["https://apps.apple.com/", "itms-apps://apps.apple.com/"],
  testflight: ["https://testflight.apple.com/join/"],
  play: [
    "https://play.google.com/store/apps/details?id=",
    "market://details?id=",
  ],
  "play-testing": [
    "https://play.google.com/apps/testing/",
    "https://play.google.com/store/apps/details?id=",
    "market://details?id=",
  ],
  "ms-store": [
    "https://apps.microsoft.com/detail/",
    "ms-windows-store://pdp/?productid=",
  ],
};
const REF_CONFIDENCES = ["attested", "declared", "heuristic", "stamp"];
const CAP_BOOLS = [
  "codeUpdates",
  "dataUpdates",
  "channelSwitch",
  "downloadedScripts",
] as const;

/** Narrow `caps` by one narrowing: booleans AND, `binaryUpdates` the narrower, `commerce`
 *  becomes `none` only when told `none`; nothing widens. */
function refNarrow(
  caps: RefCaps,
  n: Record<string, unknown> | undefined,
): RefCaps {
  if (!n) return caps;
  const out = { ...caps };
  for (const k of CAP_BOOLS)
    if (typeof n[k] === "boolean") out[k] = out[k] && (n[k] as boolean);
  if (
    typeof n.binaryUpdates === "string" &&
    REF_BINARY_ORDER.includes(n.binaryUpdates)
  ) {
    if (
      REF_BINARY_ORDER.indexOf(n.binaryUpdates) <
      REF_BINARY_ORDER.indexOf(out.binaryUpdates)
    )
      out.binaryUpdates = n.binaryUpdates;
  }
  if (n.commerce === "none") out.commerce = "none";
  return out;
}

function refEffectiveCapabilities(
  kind: string,
  o: {
    platform: string;
    subkind?: string | null;
    server?: Record<string, unknown>;
  },
): RefCaps {
  const base = REF_KIND_TABLE[kind] ?? REF_KIND_TABLE.unknown!;
  const { platforms: _p, ...caps0 } = base;
  let caps: RefCaps = caps0;
  caps = refNarrow(caps, REF_PLATFORM_NARROWING[o.platform]?.[kind]);
  caps = refNarrow(
    caps,
    o.subkind ? REF_SUBKIND_NARROWING[o.subkind] : undefined,
  );
  caps = refNarrow(caps, o.server);
  return caps;
}

// ── The feed's and the record's claims (V4 §2.3, §2.4), the generator's own ──────────────────

const REF_CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF_CHANNEL_ALIASES: Record<string, string> = {
  staging: "beta",
  latest: "stable",
};
const REF_FEED_PLATFORM_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REF_BUILD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_DELIVERABLE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const REF_RECORD_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const REF_SHA256_RE = /^[0-9a-f]{64}$/;
const REF_SALT_RE = /^[0-9a-f]{32}$/;

function refFeedClaimsOk(
  doc: Record<string, unknown>,
  ctx: ClaimCtx,
  aud: string,
): boolean {
  const f = "feed";
  if (
    !refInt(ctx, f, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return false;
  if (doc.iss !== ISSUER_V3 || doc.aud !== aud) return false;
  if (typeof doc.channel !== "string" || !REF_CHANNEL_RE.test(doc.channel))
    return false;
  if (!isObj(doc.selector)) return false;
  const sel = doc.selector;
  if (hasOwn(sel, "platform") && typeof sel.platform !== "string") return false;
  if (!refInt(ctx, f, doc.seq, "/seq")) return false;
  if (!refInt(ctx, f, doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, f, doc.expiresAt, "/expiresAt")) return false;
  const [iat, exp] = [doc.issuedAt as number, doc.expiresAt as number];
  if (!(iat < exp) || exp > iat + MAX_FEED_TTL_REF) return false;
  if (!isObj(doc.app)) return false;
  const app = doc.app;
  if (app.deliverable !== "app") return false;
  const scheme = app.versionScheme;
  if (
    typeof scheme !== "string" ||
    !(REF_SCHEMES as readonly string[]).includes(scheme)
  )
    return false;
  const ver = (v: unknown): boolean => refParseVersion(scheme, v) !== null;
  if (!Array.isArray(app.targets)) return false;
  const seen = new Set<string>();
  for (const [i, t] of app.targets.entries()) {
    const at = `/app/targets/${i}`;
    if (!isObj(t)) return false;
    if (
      typeof t.platform !== "string" ||
      !REF_FEED_PLATFORM_RE.test(t.platform)
    )
      return false;
    if (seen.has(t.platform)) return false;
    seen.add(t.platform);
    if (hasOwn(sel, "platform") && t.platform !== sel.platform) return false;
    const r = t.release;
    if (
      !isObj(r) ||
      typeof r.sha256 !== "string" ||
      !REF_SHA256_RE.test(r.sha256)
    )
      return false;
    if (!refInt(ctx, f, r.seq, `${at}/release/seq`) || !ver(r.version))
      return false;
    if (!hasOwn(t, "floor")) return false;
    if (t.floor !== null) {
      if (!isObj(t.floor) || !ver(t.floor.minVersion)) return false;
      const c = refCompareVersions(scheme, t.floor.minVersion, r.version);
      if (c === null || c > 0) return false;
    }
    if (typeof t.critical !== "boolean") return false;
    if (!isObj(t.outlets)) return false;
    for (const [id, e] of Object.entries(t.outlets)) {
      const ep = `${at}/outlets/${pointerToken(id)}`;
      if (!REF_OUTLET_ID_RE.test(id) || !isObj(e)) return false;
      if (
        typeof e.kind !== "string" ||
        !REF_OUTLET_ID_RE.test(e.kind) ||
        e.kind === "unknown"
      )
        return false;
      if (!hasOwn(e, "live")) return false;
      if (e.live !== null) {
        if (!isObj(e.live) || !ver(e.live.version)) return false;
        if (!refInt(ctx, f, e.live.seq, `${ep}/live/seq`)) return false;
      }
      if (typeof e.halted !== "boolean") return false;
      if (hasOwn(e, "rollout")) {
        const ro = e.rollout;
        if (!isObj(ro) || !refInt(ctx, f, ro.bp, `${ep}/rollout/bp`))
          return false;
        if ((ro.bp as number) > ROLLOUT_BUCKETS_REF) return false;
        if (typeof ro.salt !== "string" || !REF_SALT_RE.test(ro.salt))
          return false;
      }
      if (hasOwn(e, "listingUrl")) {
        const url = e.listingUrl;
        if (typeof url !== "string") return false;
        if ((REF_OUTLET_KINDS as readonly string[]).includes(e.kind)) {
          const bytes = utf8Bytes(url);
          if (bytes.length < 1 || bytes.length > 2048) return false;
          if (bytes.some((b) => b < 0x21 || b > 0x7e)) return false;
          if (
            !(REF_LISTING_PREFIXES[e.kind] ?? []).some((p) => url.startsWith(p))
          )
            return false;
        }
      }
      if (hasOwn(e, "capabilities")) {
        const c = e.capabilities;
        if (!isObj(c)) return false;
        if (
          hasOwn(c, "binaryUpdates") &&
          !REF_BINARY_ORDER.includes(c.binaryUpdates as string)
        )
          return false;
        for (const k of CAP_BOOLS)
          if (hasOwn(c, k) && typeof c[k] !== "boolean") return false;
        if (
          hasOwn(c, "commerce") &&
          !["own", "store-iap", "steam", "none"].includes(c.commerce as string)
        )
          return false;
      }
    }
  }
  return true;
}

/** Client steps 4–6 (plans/P3-01.md §2.5): claims, channel binding, selector. */
function refFeedClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: { aud: string; channel: string; platform?: string },
): "claims" | "channel" | "selector" | null {
  if (!isObj(doc) || !refFeedClaimsOk(doc, ctx, o.aud)) return "claims";
  const claim = doc.channel as string;
  if (claim === "latest") return "channel";
  if (claim !== o.channel && claim !== REF_CHANNEL_ALIASES[o.channel])
    return "channel";
  const sel = doc.selector as Record<string, unknown>;
  if (Object.keys(sel).some((k) => k !== "platform")) return "selector";
  if (
    hasOwn(sel, "platform") &&
    o.platform !== undefined &&
    sel.platform !== o.platform
  )
    return "selector";
  return null;
}

/** Client step 14 (plans/P3-01.md §2.4). */
function refRecordClaims(doc: unknown, ctx: ClaimCtx, aud: string): boolean {
  if (!isObj(doc)) return false;
  const r = "record";
  if (
    !refInt(ctx, r, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return false;
  if (doc.aud !== aud) return false;
  if (
    typeof doc.deliverable !== "string" ||
    utf8Bytes(doc.deliverable).length > 64 ||
    !REF_DELIVERABLE_RE.test(doc.deliverable)
  )
    return false;
  if (typeof doc.kind !== "string" || doc.kind === "") return false;
  if (
    typeof doc.version !== "string" ||
    !REF_RECORD_VERSION_RE.test(doc.version)
  )
    return false;
  if (!refInt(ctx, r, doc.seq, "/seq")) return false;
  if (!refInt(ctx, r, doc.issuedAt, "/issuedAt")) return false;
  if (
    hasOwn(doc, "minSupportedSeq") &&
    !refInt(ctx, r, doc.minSupportedSeq, "/minSupportedSeq")
  )
    return false;
  for (const k of ["tag", "channel", "title", "notes"])
    if (hasOwn(doc, k) && typeof doc[k] !== "string") return false;
  if (hasOwn(doc, "provenance")) {
    const p = doc.provenance;
    if (!isObj(p)) return false;
    for (const k of ["commit", "workflowRun"])
      if (hasOwn(p, k) && typeof p[k] !== "string") return false;
  }
  // plans/P4-01.md §2.2: §2.3 for `kind: pack`, §2.4 for `kind: app`, the common claims only
  // for any other kind (whose `content` and `embeds` are ignored).
  if (doc.kind === "pack") return refPackClaims(doc, ctx);
  const app = doc.kind === "app";
  if (app && hasOwn(doc, "content") && on(ctx, "content")) {
    if (!refContentClaims(doc.content, ctx, "/content")) return false;
  }
  if (!hasOwn(doc, "builds")) return doc.kind !== "app";
  if (
    !Array.isArray(doc.builds) ||
    doc.builds.length < 1 ||
    doc.builds.length > 64
  )
    return false;
  const ids = new Set<string>();
  for (const [i, b] of doc.builds.entries()) {
    if (!isObj(b) || typeof b.id !== "string" || !REF_BUILD_ID_RE.test(b.id))
      return false;
    if (ids.has(b.id)) return false;
    ids.add(b.id);
    for (const k of ["platform", "arch", "format"])
      if (typeof b[k] !== "string" || b[k] === "") return false;
    for (const k of ["buildNumber", "minOS"])
      if (hasOwn(b, k) && typeof b[k] !== "string") return false;
    if (hasOwn(b, "requires") && !isObj(b.requires)) return false;
    if (!Array.isArray(b.artifacts) || b.artifacts.length > 32) return false;
    let payloads = 0;
    for (const [j, a] of b.artifacts.entries()) {
      if (!isObj(a)) return false;
      if (typeof a.name !== "string" || a.name === "") return false;
      if (typeof a.role !== "string" || a.role === "") return false;
      if (a.role === "payload") payloads++;
      if (typeof a.sha256 !== "string" || !REF_SHA256_RE.test(a.sha256))
        return false;
      if (!refInt(ctx, r, a.size, `/builds/${i}/artifacts/${j}/size`))
        return false;
      if (hasOwn(a, "contentType") && typeof a.contentType !== "string")
        return false;
    }
    if (payloads > 1) return false;
    if (app && hasOwn(b, "embeds") && on(ctx, "embeds")) {
      if (!refEmbedsClaims(b.embeds, ctx)) return false;
    }
  }
  return true;
}

// ── A reference JWS verifier (V4 §1.1–§1.2), to recompute every new verdict ─────────────────

function refPointOk(enc: Uint8Array): boolean {
  if (enc.length !== 32) return false;
  if ((leToBig(enc) & (2n ** 255n - 1n)) >= ED_P) return false;
  const hex = bytesHex(enc);
  if (hex === bytesHex(NEGATIVE_ZERO_ENC)) return false;
  if (
    hex === "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  )
    return false;
  return !SMALL_ORDER_REF.includes(hex);
}

/** Decode one segment's bytes as strict JSON text (rules 1–2), or null. */
function refSegmentText(seg: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(seg)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(seg);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) return null;
  const parsed = refParseStrict(text);
  if (!parsed.ok || !isObj(parsed.value)) return null;
  return text;
}

/** The whole of `verifyJws` under V4, from first principles: caps, strict JSON, `alg`, `typ`,
 *  `kid`, the byte pre-checks and a cofactorless verify (node:crypto). */
function refVerifyJws(
  jws: string,
  trust: Record<string, string>,
  typ: TypV3 | undefined,
  maxPayloadBytes = 65536,
): { kid: string; text: string; payload: Record<string, unknown> } | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const cap = Math.max(65536, maxPayloadBytes);
  if (h.length > Math.ceil((1024 * 4) / 3) + 4) return null;
  if (p.length > Math.ceil((cap * 4) / 3) + 4) return null;
  const ht = refSegmentText(h);
  if (ht === null || utf8Bytes(ht).length > 1024) return null;
  const header = JSON.parse(ht) as Record<string, unknown>;
  if (header.alg !== "EdDSA") return null;
  if (typ !== undefined && header.typ !== typ) return null;
  if (typeof header.kid !== "string" || !hasOwn(trust, header.kid)) return null;
  const key = base64UrlDecode(trust[header.kid]!);
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const sig = base64UrlDecode(s);
  if (key.length !== 32 || sig.length !== 64) return null;
  if (leToBig(sig.subarray(32)) >= ED_L) return null;
  if (!refPointOk(key) || !refPointOk(sig.subarray(0, 32))) return null;
  let ok = false;
  try {
    const pk = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: trust[header.kid]! },
      format: "jwk",
    });
    ok = nodeVerify(null, utf8Bytes(`${h}.${p}`), pk, sig);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  const pt = refSegmentText(p);
  if (pt === null || utf8Bytes(pt).length > cap) return null;
  return {
    kid: header.kid,
    text: pt,
    payload: JSON.parse(pt) as Record<string, unknown>,
  };
}

// ── §4.3 the new `jwsCases` ──────────────────────────────────────────────────────────────────

interface JwsCaseV4Extra {
  /** V4 §4.1: the payload's non-wire-integer pointers, beside `expect`. */
  nonWireIntegers?: string[];
}

/** The 44 vectors appended after `bundle-payload-over-cap`, in §4.3's order. */
async function buildJwsCasesV4(): Promise<(JwsCaseV2 & JwsCaseV4Extra)[]> {
  checkEd25519Tables();
  const LIC: TypV3 = "pkey-license+jws";
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const out: (JwsCaseV2 & JwsCaseV4Extra)[] = [];
  const add = (c: JwsCaseV2 & JwsCaseV4Extra): void => {
    out.push(c);
  };
  const lic = (
    id: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> =>
    licenseDoc({ licenseId: `lic_${id.replaceAll("-", "_")}`, ...extra });
  const pinA = base64UrlDecode(pub(PIN_KID));
  const pinScalar = secretScalar(PIN_KID) % ED_L;

  // §1.1 check 1: S + L.
  {
    const jws = await signAs(lic("sig-s-plus-l"), PIN_KID, LIC);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const sig = base64UrlDecode(s);
    const sBig = leToBig(sig.subarray(32));
    const sPrime = sBig + ED_L;
    if (sPrime < ED_L || sPrime % ED_L !== sBig % ED_L || sPrime >= 2n ** 256n)
      throw new Error("sig-s-plus-l: S' must be ≥ L and ≡ S (mod L)");
    const out64 = new Uint8Array(sig);
    out64.set(bigToLe(sPrime, 32), 32);
    add({
      id: "sig-s-plus-l",
      description:
        "V4 §1.1 check 1: a genuine signature with S replaced by S + L. The equation still holds mod L, so only `S < L` refuses it (every backend measured already does).",
      jws: `${h}.${p}.${base64UrlEncodeBytes(out64)}`,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  // R vectors under the pinned key, with S = k·a so the equation holds over each R encoding.
  for (const [id, rEnc, what] of [
    [
      "sig-r-identity",
      IDENTITY_ENC,
      "R is the canonical identity and S = k·a: RFC 8032-valid, accepted by all four backends, refused by check 3 (a small-order R)",
    ],
    [
      "sig-r-non-canonical",
      IDENTITY_Y_P_PLUS_1,
      "R is the identity encoded with y = p + 1, a non-canonical encoding (check 2)",
    ],
    [
      "sig-r-negative-zero",
      NEGATIVE_ZERO_ENC,
      "R is `01 00…00 80`, x = 0 with the sign bit set (check 2)",
    ],
  ] as const) {
    const { jws } = handSign({
      kid: PIN_KID,
      payload: JSON.stringify(lic(id)),
      aEnc: pinA,
      a: pinScalar,
      label: id,
      rEnc,
    });
    add({
      id,
      description: `V4 §1.1: ${what}.`,
      jws,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  // A vectors: each brings its own one-key trust.
  const keyVector = async (
    id: string,
    kid: string,
    aEnc: Uint8Array,
    a: bigint,
    kMod8: "zero" | "nonzero" | undefined,
    verdict: "ok" | "fail",
    what: string,
  ): Promise<void> => {
    const doc = lic(id);
    const { jws, k } = handSign({
      kid,
      payload: JSON.stringify(doc),
      aEnc,
      a,
      label: id,
      kMod8,
    });
    if (kMod8 === "zero" && k % 8n !== 0n) throw new Error(`${id}: k mod 8`);
    if (kMod8 === "nonzero" && k % 8n === 0n) throw new Error(`${id}: k mod 8`);
    add({
      id,
      description: `V4 §1.1: ${what}.`,
      jws,
      trust: { [kid]: base64UrlEncodeBytes(aEnc) },
      typ: LIC,
      expect:
        verdict === "ok" ? { verify: "ok", kid, doc } : { verify: "fail" },
    });
  };
  await keyVector(
    "pubkey-small-order-identity",
    "corpus-small-order-identity",
    IDENTITY_ENC,
    0n,
    undefined,
    "fail",
    "A is the identity, R = [r]B and S = r, so [S]B = R + [k]A for every k: refused by check 3",
  );
  await keyVector(
    "pubkey-small-order-order8",
    "corpus-small-order-order8",
    ORDER8_ENC,
    0n,
    "zero",
    "fail",
    "A is an order-8 point and the nonce is ground until k ≡ 0 (mod 8), so [k]A is the identity and S = r verifies cofactorlessly: refused by check 3",
  );
  await keyVector(
    "pubkey-non-canonical",
    "corpus-non-canonical",
    IDENTITY_Y_P_PLUS_1,
    0n,
    undefined,
    "fail",
    "A is the identity encoded with y = p + 1 (check 2). OpenSSL decodes it and accepts; CryptoKit and Godot refuse",
  );
  await keyVector(
    "pubkey-negative-zero",
    "corpus-negative-zero",
    NEGATIVE_ZERO_ENC,
    0n,
    undefined,
    "fail",
    "A is `01 00…00 80` (check 2)",
  );
  {
    const a0 = nonce("mixed-order-key", 0);
    const mixed = EdPoint.BASE.multiply(a0).add(
      EdPoint.fromHex(SMALL_ORDER_REF[6]!),
    );
    if (mixed.isSmallOrder() || mixed.isTorsionFree())
      throw new Error("mixed-order key");
    const aEnc = mixed.toBytes();
    await keyVector(
      "pubkey-mixed-order-cofactored-only",
      "corpus-mixed-order",
      aEnc,
      a0,
      "nonzero",
      "fail",
      "A = A₀ + T₈ with k ≢ 0 (mod 8): only a cofactored equation accepts, and the equation is cofactorless (check 4)",
    );
    await keyVector(
      "valid-pubkey-mixed-order",
      "corpus-mixed-order",
      aEnc,
      a0,
      "zero",
      "ok",
      "A = A₀ + T₈ with k ≡ 0 (mod 8): the cofactorless equation holds, and no prime-subgroup check is made, so it verifies (check 4)",
    );
  }

  // §1.2 vectors on text.
  const header = headerText(LIC, PIN_KID);
  const baseText = JSON.stringify(lic("json"));
  /** The licence payload with `"x":<raw>` spliced in before the closing brace. */
  const withX = (rawValue: string): string =>
    `${baseText.slice(0, -1)},"x":${rawValue}}`;
  const textCase = async (
    id: string,
    payload: string,
    verdict: "ok" | "fail",
    what: string,
    o: { hdr?: string; doc?: unknown } = {},
  ): Promise<void> => {
    const jws = await signRawSegments(o.hdr ?? header, payload, PIN_KID);
    const nonWire = verdict === "ok" ? refNonWire(payload) : [];
    add({
      id,
      description: what,
      jws,
      trust: TRUST,
      typ: LIC,
      ...(nonWire.length > 0 ? { nonWireIntegers: nonWire } : {}),
      expect:
        verdict === "ok"
          ? o.doc !== undefined
            ? { verify: "ok", kid: PIN_KID, doc: o.doc }
            : { verify: "ok", kid: PIN_KID }
          : { verify: "fail" },
    });
  };
  await textCase(
    "json-lone-high-surrogate",
    withX('"\\ud800"'),
    "fail",
    "V4 §1.2 rule 5: a lone high-surrogate escape in a value. JavaScript and Python decode it to an unpaired code unit; Godot refuses it.",
  );
  await textCase(
    "json-lone-low-surrogate",
    withX('"\\udc00"'),
    "fail",
    "Rule 5: a lone low-surrogate escape in a value.",
  );
  await textCase(
    "json-reversed-surrogate-pair",
    withX('"\\udc00\\ud800"'),
    "fail",
    "Rule 5: a low surrogate followed by a high one is two lone surrogates, not a pair.",
  );
  await textCase(
    "json-lone-surrogate-in-key",
    `${baseText.slice(0, -1)},"\\ud800":1}`,
    "fail",
    "Rule 5: a lone surrogate in a member name.",
  );
  {
    const doc = { ...lic("json"), x: "\u{1F4BB}" };
    await textCase(
      "valid-surrogate-pair-escape",
      withX('"\\ud83d\\udcbb"'),
      "ok",
      "Rule 5 must not over-reject: the escaped pair `\\ud83d\\udcbb` decodes to U+1F4BB.",
      { doc },
    );
  }
  await textCase(
    "json-raw-control-char-payload",
    withX('"a\u0001b"'),
    "fail",
    "Rule 4: a raw U+0001 inside a payload string (RFC 8259 already forbids it; Swift's JSONDecoder accepted it).",
  );
  await textCase(
    "json-raw-control-char-header",
    baseText,
    "fail",
    "Rule 4 in the HEADER: a raw U+001F in an extra header member, parsed before the signature (Swift's lazy decoding never looked at it).",
    {
      hdr: `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}","x":"a\u001fb"}`,
    },
  );
  await textCase(
    "json-raw-nul-byte",
    withX('"a\u0000b"'),
    "fail",
    "Rule 4: a raw 0x00 byte inside a payload string.",
  );
  await textCase(
    "json-nul-escape-in-key",
    `${baseText.slice(0, -1)},"a\\u0000b":1}`,
    "fail",
    "Rule 7: U+0000 in a member name, closing V3 §10's open entry. Godot cannot represent it.",
  );
  // Byte vectors.
  const bytesCase = async (
    id: string,
    hdr: Uint8Array,
    payload: Uint8Array,
    what: string,
  ): Promise<void> => {
    add({
      id,
      description: what,
      jws: await signRawBytes(hdr, payload, PIN_KID),
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  };
  const H = utf8Bytes(header);
  const P = utf8Bytes(baseText);
  const withBytes = (b: number[]): Uint8Array =>
    Uint8Array.from([
      ...utf8Bytes(baseText.slice(0, -1) + ',"x":"'),
      ...b,
      ...utf8Bytes('"}'),
    ]);
  const BOM = [0xef, 0xbb, 0xbf];
  await bytesCase(
    "json-invalid-utf8",
    H,
    withBytes([0xff]),
    "Rule 1: byte 0xFF inside a string, never valid UTF-8.",
  );
  await bytesCase(
    "json-utf8-encoded-surrogate",
    H,
    withBytes([0xed, 0xa0, 0x80]),
    "Rule 1: ED A0 80, a UTF-8-encoded surrogate (CESU-8).",
  );
  await bytesCase(
    "json-overlong-utf8",
    H,
    withBytes([0xc0, 0xaf]),
    "Rule 1: C0 AF, an overlong encoding of `/`.",
  );
  await bytesCase(
    "json-leading-bom-payload",
    H,
    Uint8Array.from([...BOM, ...P]),
    "Rule 2: a byte order mark before the payload.",
  );
  await bytesCase(
    "json-leading-bom-header",
    Uint8Array.from([...BOM, ...H]),
    P,
    "Rule 2: a byte order mark before the header.",
  );
  await bytesCase(
    "json-two-leading-boms-payload",
    H,
    Uint8Array.from([...BOM, ...BOM, ...P]),
    "Rule 2: two byte order marks before the payload; Godot stripped both.",
  );
  await bytesCase(
    "json-two-leading-boms-header",
    Uint8Array.from([...BOM, ...BOM, ...H]),
    P,
    "Rule 2: two byte order marks before the header.",
  );
  await textCase(
    "json-nan-literal",
    withX("NaN"),
    "fail",
    "Rule 3: a bare `NaN`, which Python's json.loads accepts without parse_constant.",
  );
  await textCase(
    "json-infinity-literal",
    withX("Infinity"),
    "fail",
    "Rule 3: a bare `Infinity`.",
  );
  await textCase(
    "json-negative-infinity-literal",
    withX("-Infinity"),
    "fail",
    "Rule 3: a bare `-Infinity`.",
  );
  await textCase(
    "json-trailing-comma-payload",
    `${baseText.slice(0, -1)},}`,
    "fail",
    "Rule 3: a comma before the payload's closing brace.",
  );
  await textCase(
    "json-trailing-comma-header",
    baseText,
    "fail",
    "Rule 3 in the header, parsed before the signature.",
    {
      hdr: `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}",}`,
    },
  );
  await textCase(
    "json-number-overflow",
    withX("1e400"),
    "fail",
    "Rule 8: `1e400` in an unused member — out of range (Node and Python read infinity, Swift throws).",
  );
  await textCase(
    "json-number-underflow",
    withX("1e-400"),
    "fail",
    "Rule 8: `1e-400`, which rounds to zero.",
  );
  await textCase(
    "json-number-subnormal",
    withX("5e-324"),
    "fail",
    "Rule 8: `5e-324`, a subnormal that Godot reads as 0.",
  );
  await textCase(
    "json-number-exponent-wrap",
    withX("1e4294967297"),
    "fail",
    "Rule 8: an exponent of ten significant digits, more than six, is out of range outright; Godot read it as 10.",
  );
  await textCase(
    "valid-number-integral-spellings",
    withX("[7.0,7e0,0.0,-0.0,7.0000000000000001,1700000000.00000001]"),
    "ok",
    "Rule 8 keeps these: they are values in an unused member. Only an integer claim refuses such spellings (V4 §3). No `doc`: Python reads them as floats.",
  );
  await textCase(
    "valid-number-forms",
    withX("[7,-0,7.5,1e-7,1e+21,1e-307,9.99e307,0e5]"),
    "ok",
    "Every number form rule 8 keeps. No `doc`: Godot's last bits differ.",
  );
  const nest = (levels: number): string =>
    `${"[".repeat(levels)}${"]".repeat(levels)}`;
  await textCase(
    "valid-depth-64",
    withX(nest(63)),
    "ok",
    "Rule 9: 64 levels, counting the top-level object as level 1. No `doc`.",
  );
  await textCase(
    "json-depth-65",
    withX(nest(64)),
    "fail",
    "Rule 9: 65 levels.",
  );
  await textCase(
    "valid-canonically-equivalent-member-names",
    withX('{"\\u00e9":1,"e\\u0301":2}'),
    "ok",
    "Rule 6: sibling names U+00E9 and U+0065 U+0301 are two names, compared by scalar value. Swift's String equality refused them. No `doc`: Swift's JSONValue keeps the first (a V4 §10 representation limit).",
  );
  {
    const doc = { ...lic("json"), x: { "a\\u0000": 1 } };
    await textCase(
      "valid-escaped-backslash-before-u0000-in-key",
      withX('{"a\\\\u0000":1}'),
      "ok",
      "Rule 7 must not fire: the member name is `a`, a backslash and `u0000`, not U+0000.",
      { doc },
    );
  }
  {
    const doc = { ...lic("json"), x: { "\uffff": "\uffff" } };
    await textCase(
      "valid-noncharacter-escape",
      withX('{"\\uffff":"\\uffff"}'),
      "ok",
      "`\\uffff` as a value and as a member name: noncharacters are ordinary characters, and no verifier applies RFC 7493 §2.1's ban.",
      { doc },
    );
  }
  // §2: the two new typs at the wrong call site.
  add({
    id: "typ-feed-as-license",
    description:
      "A genuine channel feed (`pkey-feed+jws`) presented at a licence call site: the shared product key signs both, so only the `typ` separates them (V4 §2).",
    jws: await signAs(feedPayload(), PIN_KID, "pkey-feed+jws"),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  add({
    id: "typ-license-as-feed",
    description:
      "A genuine licence document presented at a feed call site (`typ: pkey-feed+jws`).",
    jws: await signAs(lic("typ-license-as-feed"), PIN_KID, LIC),
    trust: TRUST,
    typ: "pkey-feed+jws",
    expect: { verify: "fail" },
  });

  if (out.length !== 44) throw new Error(`jwsCases v4: ${out.length} != 44`);
  // Recompute every verdict with the reference verifier.
  for (const c of out) {
    const v = refVerifyJws(c.jws, c.trust, c.typ, c.maxPayloadBytes);
    if ((v !== null) !== (c.expect.verify === "ok"))
      throw new Error(`jwsCases v4: the reference disagrees on ${c.id}`);
    if (
      v !== null &&
      c.expect.doc !== undefined &&
      !canonicalEqual(JSON.parse(v.text) as Json, c.expect.doc as Json)
    )
      throw new Error(`jwsCases v4: ${c.id}'s doc is not its payload`);
  }
  return out;
}

// ── §4.3 the 28 v3 claim cases ───────────────────────────────────────────────────────────────
// Each is its family's control case with the one change named, re-signed by the control's key,
// and appended after the family's last case so every existing case stays byte-identical.

type WithNonWire<T> = T & { nonWireIntegers?: string[] };

/** Attach the payload's non-wire pointers when the case is built to pass `verifyJws`. */
function withNonWire<T extends object>(c: T, jws: string): WithNonWire<T> {
  const text = payloadTextOf(jws);
  const nonWire = text === null ? [] : refNonWire(text);
  return nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c;
}

/** Insert `nonWireIntegers` right before `expect`, so the member sits beside it. */
function placeNonWire<T extends object>(c: T): T {
  if (!("nonWireIntegers" in c)) return c;
  const src = c as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "nonWireIntegers") continue;
    if (k === "expect") out.nonWireIntegers = src.nonWireIntegers;
    out[k] = v;
  }
  return out as T;
}

const BIG_OVER = "9007199254740993";

async function buildLicenseDocCasesV4(): Promise<WithNonWire<DocCaseV2>[]> {
  const typ: TypV3 = "pkey-license+jws";
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  const sign = (over: Record<string, unknown>): Promise<string> =>
    signText(rawJson(licenseDoc(over)), PIN_KID, typ);
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    accept: boolean,
    extra: Partial<DocCaseV2> = {},
  ): Promise<WithNonWire<DocCaseV2>> => {
    const jws = await sign(over);
    return withNonWire(
      { ...common, ...extra, id, description, jws, expect: { accept } },
      jws,
    );
  };
  const base = licenseDoc();
  return [
    await mk(
      "license-issued-at-near-integer",
      "V4 §3: the `issuedAt` token `1700000000.00000001` denotes no integer, but binary64 rounding makes it one in Node, Swift and Godot. Only the token rule refuses it.",
      { issuedAt: raw("1700000000.00000001") },
      false,
    ),
    await mk(
      "license-expires-at-near-integer",
      "V4 §3: the `expiresAt` token `1700003600.00000001`.",
      { expiresAt: raw("1700003600.00000001") },
      false,
    ),
    await mk(
      "license-grace-until-near-integer",
      "V4 §3: the `graceUntil` token `1702592000.00000001`.",
      { graceUntil: raw("1702592000.00000001") },
      false,
    ),
    await mk(
      "license-issued-at-over-max",
      "V4 §3: only `issuedAt` (9007199254740993) is above 2^53 − 1; every other claim is in range at this `now`. JavaScript reads it as 2^53.",
      {
        issuedAt: raw(BIG_OVER),
        expiresAt: 9007199254740950,
        graceUntil: 9007199254740960,
      },
      false,
      { now: 9007199254740900 },
    ),
    await mk(
      "license-grace-until-over-max",
      "V4 §3: only `graceUntil` (9007199254826400) is above 2^53 − 1.",
      {
        issuedAt: 9007199254740000,
        expiresAt: 9007199254740900,
        graceUntil: 9007199254826400,
      },
      false,
      { now: 9007199254740000 },
    ),
    await mk(
      "license-member-shapes-ignored",
      "V4 §3 'Members outside the claims': an entry with `state: \"future\"` and a fractional `updatedAt`, an entry with no `value`, an entry that is `5`, and a profile with no `firstName` and a fractional `activatedAt` decide nothing. Swift's synthesized decoders refused these.",
      {
        entitlements: {
          "license.tier": {
            state: "future",
            value: "pro",
            updatedAt: 1699990000.5,
          },
          channels: { state: "enforced", updatedAt: 1699990000 },
          "app.minVersion": (base.entitlements as Record<string, unknown>)[
            "app.minVersion"
          ],
          polarisVpn: 5,
        },
        profile: {
          name: "Grace Hopper",
          email: "grace@example.com",
          activatedAt: 1690000000.5,
        },
      },
      true,
    ),
    await mk(
      "license-profile-null",
      "V4 §3 presence: a present `profile: null` is refused (Python and Swift read it as absent).",
      { profile: null },
      false,
    ),
    await mk(
      "license-issued-at-negative-reload-path",
      "V4 §3 minimums: `issuedAt` −1 is a plain integer token below its minimum, 0. On the reload path nothing else refuses it.",
      { issuedAt: -1, expiresAt: 3599, graceUntil: 2591999 },
      false,
      { checkFreshness: false },
    ),
    await mk(
      "license-expires-at-negative-reload-path",
      "V4 §3 minimums: `expiresAt` −1, with the control's `issuedAt` and `graceUntil`, on the reload path.",
      { expiresAt: -1 },
      false,
      { checkFreshness: false },
    ),
  ];
}

async function buildConfigDocCasesV4(): Promise<WithNonWire<DocCaseV2>[]> {
  const typ: TypV3 = "pkey-config+jws";
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  const mk = async (
    id: string,
    description: string,
    schemaVersion: unknown,
  ): Promise<WithNonWire<DocCaseV2>> => {
    const jws = await signText(
      rawJson(configDoc({ schemaVersion })),
      PIN_KID,
      typ,
    );
    return withNonWire(
      { ...common, id, description, jws, expect: { accept: false } },
      jws,
    );
  };
  return [
    await mk(
      "config-schema-version-near-integer",
      "V4 §3: the `schemaVersion` token `4.0000000000000001`.",
      raw("4.0000000000000001"),
    ),
    await mk(
      "config-schema-version-over-max",
      "V4 §3: `schemaVersion` 9007199254740993, above 2^53 − 1.",
      raw(BIG_OVER),
    ),
    await mk(
      "config-schema-version-zero",
      "V4 §3 minimums: `schemaVersion` 0, below its minimum, 1.",
      0,
    ),
  ];
}

async function buildTrustCasesV4(): Promise<WithNonWire<TrustCaseV2>[]> {
  const pinned = PINNED_V3;
  const now = V3_ISSUED + 100;
  const keys = [
    keyEntry(PIN_KID, pub(PIN_KID), "active"),
    keyEntry(ALT_KID, pub(ALT_KID), "staged"),
  ];
  const refused = { accepted: false, trust: { [PIN_KID]: pub(PIN_KID) } };
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    o: {
      now?: number;
      checkFreshness?: boolean;
      expect?: TrustCaseV2["expect"];
      drop?: string[];
    } = {},
  ): Promise<WithNonWire<TrustCaseV2>> => {
    const doc: Record<string, unknown> = {
      ...trustManifestV3({ keys }),
      ...over,
    };
    for (const k of o.drop ?? []) delete doc[k];
    const jws = await signText(rawJson(doc), PIN_KID, "pkey-trust+jws");
    const c: TrustCaseV2 = {
      id,
      description,
      pinned,
      before: {},
      manifestJws: jws,
      now: o.now ?? now,
      ...(o.checkFreshness === undefined
        ? {}
        : { checkFreshness: o.checkFreshness }),
      expect: o.expect ?? refused,
    };
    return withNonWire(c, jws);
  };
  return [
    await mk(
      "trust-schema-version-near-integer",
      "V4 §3: the `schemaVersion` token `1.0000000000000001`, which every v3 SDK read as 1.",
      { schemaVersion: raw("1.0000000000000001") },
    ),
    await mk(
      "trust-schema-version-boolean",
      "V4 §3: `schemaVersion: true` — Python's `True in frozenset({1})` held.",
      { schemaVersion: true },
    ),
    await mk(
      "trust-issued-at-near-integer",
      "V4 §3: the `issuedAt` token `1700000000.00000001`.",
      { issuedAt: raw("1700000000.00000001") },
    ),
    await mk(
      "trust-expires-at-near-integer",
      "V4 §3: the `expiresAt` token `1700000300.00000001`.",
      { expiresAt: raw("1700000300.00000001") },
    ),
    await mk(
      "trust-issued-at-over-max",
      "V4 §3: only `issuedAt` (9007199254740993) is above 2^53 − 1 at this `now`.",
      { issuedAt: raw(BIG_OVER), expiresAt: 9007199254740950 },
      { now: 9007199254740900 },
    ),
    await mk(
      "trust-expires-at-over-max",
      "V4 §3: `expiresAt` 9007199254740993.",
      { expiresAt: raw(BIG_OVER) },
    ),
    await mk(
      "trust-member-shapes-ignored",
      "V4 §3 'Members outside the claims': no `jwksUrl` and no `cacheSeconds`, a key with no `status`, and a key whose `alg` is `1` (skipped). Swift's synthesized decoders refused the manifest.",
      {
        keys: [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          {
            kid: ALT_KID,
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: pub(ALT_KID),
          },
          {
            kid: "future-2026",
            alg: 1,
            kty: "OKP",
            crv: "Ed25519",
            publicKey: FOREIGN_PUB,
            status: "active",
          },
        ],
      },
      {
        drop: ["jwksUrl", "cacheSeconds"],
        expect: {
          accepted: true,
          trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
          issuedAt: V3_ISSUED,
        },
      },
    ),
    await mk(
      "trust-issued-at-negative",
      "V4 §3 minimums: `issuedAt` −1 with the control's `expiresAt`.",
      { issuedAt: -1, expiresAt: V3_ISSUED + 300 },
    ),
    await mk(
      "trust-expires-at-negative-reload-path",
      "V4 §3 minimums: `expiresAt` −1, on the reload path, where freshness does not refuse it first.",
      { expiresAt: -1 },
      { checkFreshness: false },
    ),
  ];
}

async function buildBundleCasesV4(): Promise<WithNonWire<BundleCase>[]> {
  const DAY = 86400;
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
  const innerConfig = await signAs(configDoc(), ALT_KID, "pkey-config+jws");
  const bundle = (over: Record<string, unknown>): Record<string, unknown> => ({
    bundleId: "01JBUNDLE0000000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_ISSUED + 30 * DAY,
    docs: { license: innerLicense, config: innerConfig },
    trust: innerTrust,
    ...over,
  });
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  };
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    now = V3_NOW,
  ): Promise<WithNonWire<BundleCase>> => {
    const jws = await signText(
      rawJson(bundle(over)),
      PIN_KID,
      "pkey-bundle+jws",
    );
    return withNonWire(
      {
        ...common,
        now,
        id,
        description,
        bundleJws: jws,
        expect: { imports: false, reason: "bundle-claims-rejected" },
      } as BundleCase,
      jws,
    );
  };
  return [
    await mk(
      "bundle-issued-at-near-integer",
      "V4 §3: the bundle's `issuedAt` token `1700000000.00000001`.",
      { issuedAt: raw("1700000000.00000001") },
    ),
    await mk(
      "bundle-expires-at-near-integer",
      "V4 §3: the bundle's `expiresAt` token `1702592000.00000001`.",
      { expiresAt: raw("1702592000.00000001") },
    ),
    await mk(
      "bundle-issued-at-over-max",
      "V4 §3: only the bundle's `issuedAt` (9007199254740993) is above 2^53 − 1 at this `now`.",
      { issuedAt: raw(BIG_OVER), expiresAt: 9007199254740950 },
      9007199254740900,
    ),
    await mk(
      "bundle-expires-at-over-max",
      "V4 §3: the bundle's `expiresAt` 9007199254740993.",
      { expiresAt: raw(BIG_OVER) },
    ),
    await mk(
      "bundle-docs-license-null",
      "V4 §3 presence: `docs: {license: null, config: …}`. Python and Swift read the null as absent and imported the config; every bundle member failure is `bundle-claims-rejected`.",
      { docs: { license: null, config: innerConfig } },
    ),
    await mk(
      "bundle-trust-not-string",
      "`trust: 5`. Swift decoded the bundle inside its signature step and answered `bundle-jws-rejected`; the member check is step 2 everywhere.",
      { trust: 5 },
    ),
    await mk(
      "bundle-issued-at-negative",
      "V4 §3 minimums: the bundle's `issuedAt` −1.",
      { issuedAt: -1 },
    ),
  ];
}

// ── Release records (V4 §2.4) — the fixtures every feed pin and update-matrix row names ───────

/** One artifact, with a deterministic digest and size. */
function artifact(
  id: string,
  version: string,
  ext: string,
  role = "payload",
  index = 0,
): Record<string, unknown> {
  return {
    name: `diceroll-${version}-${id}.${ext}`,
    role,
    sha256: sha256Hex(`pkey-corpus-artifact:${version}:${id}:${role}`),
    size: 10_000_000 + index * 1_000_003,
  };
}

/** `R15`'s builds (plans/P3-01.md §4.6), each with one `payload` artifact unless stated. */
function r15Builds(
  version: string,
  only?: string[],
): Record<string, unknown>[] {
  const b = (
    i: number,
    id: string,
    platform: string,
    arch: string,
    format: string,
    o: {
      buildNumber?: boolean;
      role?: string;
      none?: boolean;
      requires?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> => ({
    id,
    platform,
    arch,
    format,
    ...(o.buildNumber === false ? {} : { buildNumber: String(150 + i) }),
    ...(o.requires ? { requires: o.requires } : {}),
    artifacts: o.none
      ? []
      : [artifact(id, version, format, o.role ?? "payload", i)],
  });
  const all = [
    b(0, "macos-dmg", "macos", "universal", "dmg"),
    b(1, "win-chunks", "windows", "x86_64", "zip", { role: "chunk-bundle" }),
    b(2, "win-exe", "windows", "x86_64", "exe"),
    b(3, "win-pck", "windows", "any", "pck", {
      requires: { engine: "godot-4.7", minBinary: "1.4.0" },
    }),
    b(4, "win-zip", "windows", "x86_64", "zip"),
    b(5, "linux-arm64", "linux", "arm64", "tar.gz", { buildNumber: false }),
    b(6, "linux-x64", "linux", "x86_64", "tar.gz"),
    b(7, "aab", "android", "any", "aab", { none: true }),
    b(8, "apk", "android", "any", "apk"),
    b(9, "ipa", "ios", "arm64", "ipa"),
    b(10, "web", "web", "wasm32", "zip"),
  ];
  return only ? all.filter((x) => only.includes(x.id as string)) : all;
}

const RECORD_ISSUED = V3_ISSUED - 10_000;

function recordDoc(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const version = (over.version as string | undefined) ?? "1.5.0";
  return {
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: "app",
    kind: "app",
    version,
    seq: 15,
    issuedAt: RECORD_ISSUED,
    tag: `v${version}`,
    channel: "stable",
    title: `Diceroll ${version}`,
    builds: r15Builds(typeof version === "string" ? version : "1.5.0"),
    ...over,
  };
}

interface RecordVector {
  name: string;
  doc: Record<string, unknown>;
  jws: string;
  sha256: string;
}

/** The record vectors the feeds and update-matrix rows pin, by name. */
async function buildRecordVectors(): Promise<Map<string, RecordVector>> {
  const out = new Map<string, RecordVector>();
  const add = async (
    name: string,
    doc: Record<string, unknown>,
  ): Promise<void> => {
    const jws = await signAs(doc, REL_KID, "pkey-release+jws");
    out.set(name, { name, doc, jws, sha256: sha256Hex(jws) });
  };
  await add("R15", recordDoc());
  await add(
    "RB",
    recordDoc({ version: "1.5.0+46", seq: 16, builds: r15Builds("1.5.0+46") }),
  );
  await add(
    "R4",
    recordDoc({ version: "1.5.0.0", builds: r15Builds("1.5.0.0") }),
  );
  await add(
    "R16b",
    recordDoc({
      version: "1.6.0-beta.2",
      seq: 16,
      channel: "beta",
      builds: r15Builds("1.6.0-beta.2", ["macos-dmg"]),
    }),
  );
  await add("R15max", recordDoc({ seq: MAX_WIRE_INTEGER_REF }));
  // plans/P4-13.md §4.3: the level-4 app release `contentRows` offers (prestage), its apk build
  // embedding the texture pack.
  {
    const builds = r15Builds("1.6.0");
    for (const b of builds)
      if (b.id === "apk") b.embeds = ["diceroll.textures"];
    await add(
      "RC16",
      recordDoc({
        version: "1.6.0",
        seq: 16,
        builds,
        content: {
          contentApi: 4,
          pins: [],
          expects: [
            { pack: "diceroll.foes", required: true, delivery: "essential" },
            { pack: "diceroll.l10n", required: false, delivery: "prefetch" },
            { pack: "diceroll.skins", required: false, delivery: "on-demand" },
            {
              pack: "diceroll.textures",
              required: true,
              delivery: "essential",
            },
          ],
        },
      }),
    );
  }
  return out;
}

// ── §4.5 `releaseRecordCases` ────────────────────────────────────────────────────────────────

interface RecordCase {
  id: string;
  description: string;
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin?: { deliverable: string; version: string; seq: number };
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: "hash" | "jws" | "claims" | "cross-check" };
}

/** V4 §2.5 steps 12–15, from first principles. */
function refVerifyRecordCase(c: RecordCase): RecordCase["expect"] {
  const body = c.jws;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { verify: "fail", step: "hash" };
  if (sha256Hex(body) !== c.expectedHash)
    return { verify: "fail", step: "hash" };
  const parts = body.split(".");
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(parts[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return { verify: "fail", step: "jws" };
  }
  if (typeof kid !== "string" || !hasOwn(c.releaseKeys, kid))
    return { verify: "fail", step: "jws" };
  const key = c.releaseKeys[kid]!;
  if (Object.values(c.productTrust).includes(key))
    return { verify: "fail", step: "jws" };
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { verify: "fail", step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), c.expectedAud))
    return { verify: "fail", step: "claims" };
  if (c.pin) {
    const d = v.payload;
    if (d.kind !== "app" || d.deliverable !== c.pin.deliverable)
      return { verify: "fail", step: "cross-check" };
    if (d.version !== c.pin.version || d.seq !== c.pin.seq)
      return { verify: "fail", step: "cross-check" };
  }
  return { verify: "ok", kind: v.payload.kind as string };
}

async function buildReleaseRecordCases(
  records: Map<string, RecordVector>,
): Promise<RecordCase[]> {
  const RK = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const PIN = { deliverable: "app", version: "1.5.0", seq: 15 };
  const cases: RecordCase[] = [];
  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      jws?: string;
      kid?: string;
      typ?: TypV3;
      releaseKeys?: Record<string, string>;
      expectedHash?: string;
      pin?: RecordCase["pin"] | null;
      expect: RecordCase["expect"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, o.typ ?? "pkey-release+jws")
        : await signAs(o.doc ?? recordDoc(), kid, o.typ ?? "pkey-release+jws"));
    const c: RecordCase = {
      id,
      description,
      jws,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: o.expectedHash ?? sha256Hex(jws),
      ...(o.pin === null ? {} : { pin: o.pin ?? PIN }),
      expect: o.expect,
    };
    // A case built to pass `verifyJws` (its own keys, typ and cap) carries its non-wire pointers.
    const kidOk =
      hasOwn(c.releaseKeys, kid) &&
      !Object.values(PT).includes(c.releaseKeys[kid]!);
    const v = kidOk
      ? refVerifyJws(jws, { [kid]: c.releaseKeys[kid]! }, "pkey-release+jws")
      : null;
    const nonWire = v ? refNonWire(v.text) : [];
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ok = (kind = "app"): RecordCase["expect"] => ({ verify: "ok", kind });
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check",
  ): RecordCase["expect"] => ({ verify: "fail", step });
  const r15 = records.get("R15")!;
  const rd = (over: Record<string, unknown>): Record<string, unknown> =>
    recordDoc(over);
  const builds = r15Builds("1.5.0");
  const withBuild0 = (
    patch: (b: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, unknown>[] =>
    builds.map((b, i) => (i === 0 ? patch(structuredClone(b)) : b));
  const artifact0 = (
    patch: Record<string, unknown>,
  ): Record<string, unknown>[] =>
    withBuild0((b) => ({
      ...b,
      artifacts: [
        { ...(b.artifacts as Record<string, unknown>[])[0], ...patch },
      ],
    }));

  await mk(
    "record-valid-app",
    "The control: R15, signed by the pinned release key, its hash the pin, cross-checked against `{app, 1.5.0, 15}`.",
    {
      jws: r15.jws,
      expect: { verify: "ok", kind: "app", doc: r15.doc },
    },
  );
  await mk(
    "record-valid-rotation-second-key",
    "A record signed by the 2027 release key while both are pinned: two keys are valid at once during a rotation.",
    {
      kid: REL2_KID,
      releaseKeys: { ...RK, [REL2_KID]: pub(REL2_KID) },
      expect: ok(),
    },
  );
  await mk(
    "record-valid-unknown-arch-build",
    "A `riscv64` build: an unknown arch is allowed and never eligible.",
    {
      doc: rd({
        builds: [
          ...builds,
          {
            id: "linux-riscv64",
            platform: "linux",
            arch: "riscv64",
            format: "tar.gz",
            artifacts: [
              artifact("linux-riscv64", "1.5.0", "tar.gz", "payload", 11),
            ],
          },
        ],
      }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-store-only-build",
    "A store-only build (`aab`, `artifacts: []`) verifies; it is never installed.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["aab", "apk"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-build-number-absent",
    "`buildNumber` is optional and absent here.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["linux-arm64"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-non-payload-build",
    "A build whose one file is a `chunk-bundle` verifies (P2-04 accepts it) and is never eligible.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["win-chunks", "win-zip"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-4part-version",
    "`1.5.0.0`: the record's claims name no scheme; the pin's version parses under the feed's.",
    {
      jws: records.get("R4")!.jws,
      pin: { deliverable: "app", version: "1.5.0.0", seq: 15 },
      expect: ok(),
    },
  );
  await mk(
    "record-valid-content-reserved",
    "A reserved `content` member (P4-01) is ignored.",
    {
      doc: rd({
        content: {
          contentApi: 1,
          pins: [],
          holds: [],
          expects: [],
          packChannels: {},
        },
      }),
      expect: ok(),
    },
  );
  // plans/P4-01.md §4.6: rewritten in place to sign `djdl.levels@1.1.0`, a pack record a P4
  // verifier accepts at `claims`; same ids, same `expect`.
  const packLevels = (await packRecords()).get("djdl.levels@1.1.0")!;
  await mk(
    "record-valid-kind-pack-verify-only",
    "`kind: pack` (`djdl.levels@1.1.0`) verifies when no pin asks for an app (verify only).",
    {
      jws: packLevels.jws,
      pin: null,
      expect: ok("pack"),
    },
  );
  await mk(
    "record-valid-kind-revocation-verify-only",
    "`kind: revocation`, reserved (P4-13), verifies and is never acted on.",
    {
      doc: rd({ kind: "revocation", builds: undefined }),
      pin: null,
      expect: ok("revocation"),
    },
  );
  await mk(
    "record-valid-kind-unknown-verify-only",
    "An unknown kind verifies; the cross-check refuses it where an app record is expected.",
    {
      doc: rd({ kind: "future", builds: undefined }),
      pin: null,
      expect: ok("future"),
    },
  );
  await mk(
    "record-hash-mismatch",
    "Step 12: the body's SHA-256 is not the pin (another valid record).",
    {
      jws: r15.jws,
      expectedHash: records.get("RB")!.sha256,
      expect: fail("hash"),
    },
  );
  {
    const [h, , s] = r15.jws.split(".") as [string, string, string];
    const tampered = `${h}.${encSeg({ ...r15.doc, seq: 99 })}.${s}`;
    await mk(
      "record-hash-checked-before-signature",
      "Step 12 runs before any Ed25519 work: a tampered body whose signature is also bad fails at `hash`.",
      {
        jws: tampered,
        expectedHash: r15.sha256,
        expect: fail("hash"),
      },
    );
  }
  await mk(
    "record-hash-pin-uppercase",
    "The pin is lowercase hex; an uppercase pin is no match.",
    {
      jws: r15.jws,
      expectedHash: r15.sha256.toUpperCase(),
      expect: fail("hash"),
    },
  );
  await mk(
    "record-rotation-old-key-dropped",
    "Signed by the 2026 key after it left the pinned set.",
    {
      releaseKeys: { [REL2_KID]: pub(REL2_KID) },
      expect: fail("jws"),
    },
  );
  await mk(
    "record-release-key-is-product-key",
    "A product key pinned as a release key: refused at `jws` because its bytes are in the product trust set (V4 §2.4).",
    {
      kid: PIN_KID,
      releaseKeys: { [PIN_KID]: pub(PIN_KID) },
      expect: fail("jws"),
    },
  );
  await mk(
    "record-duplicate-key",
    "A payload that declares `version` twice: strict JSON refuses it at `jws`.",
    {
      text: JSON.stringify(recordDoc()).replace(
        '"version":"1.5.0"',
        '"version":"1.5.0","version":"1.6.0"',
      ),
      expect: fail("jws"),
    },
  );
  await mk(
    "record-build-requires-null",
    "V4 §3 presence: `requires: null` on one build.",
    {
      doc: rd({ builds: withBuild0((b) => ({ ...b, requires: null })) }),
      expect: fail("claims"),
    },
  );
  const tokenCase = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    pin: RecordCase["pin"] | null = PIN,
  ): Promise<void> =>
    mk(id, description, {
      text: rawJson(recordDoc(over)),
      pin,
      expect: fail("claims"),
    });
  await tokenCase(
    "record-schema-version-near-integer",
    'V4 §3: `"schemaVersion":1.0000000000000001`.',
    { schemaVersion: raw("1.0000000000000001") },
  );
  await tokenCase(
    "record-issued-at-near-integer",
    "V4 §3: the `issuedAt` token `1700000000.00000001`.",
    { issuedAt: raw("1700000000.00000001") },
  );
  await tokenCase(
    "record-seq-over-max",
    "V4 §3: `seq` 9007199254740993, no pin.",
    { seq: raw(BIG_OVER) },
    null,
  );
  await tokenCase(
    "record-min-supported-seq-over-max",
    "V4 §3: `minSupportedSeq` 9007199254740993.",
    { minSupportedSeq: raw(BIG_OVER) },
  );
  await mk(
    "record-deliverable-trailing-newline",
    'Whole-string patterns: `deliverable` `"app\\n"`, no pin.',
    { doc: rd({ deliverable: "app\n" }), pin: null, expect: fail("claims") },
  );
  await mk("record-issued-at-negative", "V4 §3 minimums: `issuedAt` −1.", {
    doc: rd({ issuedAt: -1 }),
    expect: fail("claims"),
  });
  await mk(
    "record-build-id-non-ascii",
    "`BUILD_ID_PATTERN` is ASCII: a build id `macos-arm64-é` is refused, so uniqueness and the tie-break compare bytes in every SDK.",
    {
      doc: rd({
        builds: withBuild0((b) => ({ ...b, id: "macos-arm64-\u00e9" })),
      }),
      expect: fail("claims"),
    },
  );
  await mk("record-wrong-aud", "A record scoped to another product.", {
    doc: rd({ aud: "other-product" }),
    expect: fail("claims"),
  });
  await mk("record-schema-version-2", "`schemaVersion: 2`.", {
    doc: rd({ schemaVersion: 2 }),
    expect: fail("claims"),
  });
  await mk(
    "record-version-bad-chars",
    "A version outside P2-04's `VERSION_RE` (a space).",
    { doc: rd({ version: "1.5.0 beta" }), expect: fail("claims") },
  );
  await tokenCase("record-seq-not-integer", 'V4 §3: `"seq":15.5`.', {
    seq: raw("15.5"),
  });
  await mk("record-builds-missing", "`kind: app` with no `builds`.", {
    doc: rd({ builds: undefined }),
    expect: fail("claims"),
  });
  await mk("record-duplicate-build-id", "Two builds with one id.", {
    doc: rd({ builds: [...builds, builds[0]] }),
    expect: fail("claims"),
  });
  await mk("record-build-platform-null", "`platform: null` on a build.", {
    doc: rd({ builds: withBuild0((b) => ({ ...b, platform: null })) }),
    expect: fail("claims"),
  });
  await mk("record-build-two-payloads", "A build with two `payload` files.", {
    doc: rd({
      builds: withBuild0((b) => ({
        ...b,
        artifacts: [
          ...(b.artifacts as unknown[]),
          artifact("macos-dmg-2", "1.5.0", "dmg", "payload", 12),
        ],
      })),
    }),
    expect: fail("claims"),
  });
  await mk(
    "record-artifact-sha256-uppercase",
    "An artifact digest in uppercase hex.",
    {
      doc: rd({
        builds: artifact0({
          sha256: (
            builds[0]!.artifacts as Record<string, string>[]
          )[0]!.sha256!.toUpperCase(),
        }),
      }),
      expect: fail("claims"),
    },
  );
  await mk("record-build-number-not-string", "`buildNumber: 46`, a number.", {
    doc: rd({ builds: withBuild0((b) => ({ ...b, buildNumber: 46 })) }),
    expect: fail("claims"),
  });
  await mk(
    "record-min-supported-seq-zero",
    "V4 §3 minimums: `minSupportedSeq` 0.",
    { doc: rd({ minSupportedSeq: 0 }), expect: fail("claims") },
  );
  await mk(
    "record-version-mismatches-pin",
    "Step 15: the record's version is not the pin's.",
    {
      doc: rd({ version: "1.5.1", builds: r15Builds("1.5.1") }),
      expect: fail("cross-check"),
    },
  );
  await mk(
    "record-seq-mismatches-pin",
    "Step 15: the record's `seq` is not the pin's.",
    { doc: rd({ seq: 16 }), expect: fail("cross-check") },
  );
  await mk(
    "record-kind-pack-refused-as-app",
    "Step 15: a pack record (`djdl.levels@1.1.0`) is verified, then refused where an app record is expected.",
    {
      jws: packLevels.jws,
      expect: fail("cross-check"),
    },
  );
  await mk(
    "record-signed-by-product-key",
    "A record signed by the PRODUCT key: its kid is not among the pinned release keys.",
    { kid: PIN_KID, expect: fail("jws") },
  );
  await mk("record-wrong-typ", "A genuine record signed as `pkey-feed+jws`.", {
    typ: "pkey-feed+jws",
    expect: fail("jws"),
  });
  await mk("record-artifact-size-over-max", "V4 §3: `size` 9007199254740992.", {
    doc: rd({ builds: artifact0({ size: 9007199254740992 }) }),
    expect: fail("claims"),
  });
  await tokenCase(
    "record-artifact-size-integral-fraction",
    'V4 §3: `"size":1024.0` at `/builds/0/artifacts/0/size`.',
    { builds: artifact0({ size: raw("1024.0") }) },
  );
  await tokenCase(
    "record-seq-integral-fraction",
    'V4 §3: `"seq":15.0`, with the pin\'s `seq` 15.',
    { seq: raw("15.0") },
  );
  await tokenCase(
    "record-min-supported-seq-near-integer",
    'V4 §3: `"minSupportedSeq":3.0000000000000001`.',
    { minSupportedSeq: raw("3.0000000000000001") },
  );
  await tokenCase(
    "record-issued-at-over-max",
    "V4 §3: `issuedAt` 9007199254740993.",
    { issuedAt: raw(BIG_OVER) },
  );
  await mk(
    "record-version-trailing-newline",
    'Whole-string patterns: `version` `"1.5.0\\n"`, no pin.',
    {
      doc: rd({ version: "1.5.0\n", builds: builds }),
      pin: null,
      expect: fail("claims"),
    },
  );
  await mk("record-seq-zero", "V4 §3 minimums: `seq` 0, no pin.", {
    doc: rd({ seq: 0 }),
    pin: null,
    expect: fail("claims"),
  });
  await mk(
    "record-artifact-size-negative",
    'V4 §3 minimums: `"size":-1` at `/builds/0/artifacts/0/size`.',
    { doc: rd({ builds: artifact0({ size: -1 }) }), expect: fail("claims") },
  );

  if (cases.length !== 49)
    throw new Error(`releaseRecordCases: ${cases.length} != 49`);
  for (const c of cases) {
    const want = refVerifyRecordCase(c);
    const got = c.expect;
    if (
      want.verify !== got.verify ||
      (want.verify === "fail" &&
        got.verify === "fail" &&
        want.step !== got.step)
    )
      throw new Error(
        `releaseRecordCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
    if (want.verify === "ok" && got.verify === "ok" && want.kind !== got.kind)
      throw new Error(`releaseRecordCases: kind of ${c.id}`);
  }
  return cases;
}

// ── The channel feed (V4 §2.3) ───────────────────────────────────────────────────────────────

/** The record vectors, built once per run before any feed (feeds pin their hashes). */
let RECORDS: Map<string, RecordVector> | null = null;
const record = (name: string): RecordVector => {
  const r = RECORDS?.get(name);
  if (!r) throw new Error(`record vector ${name} not built`);
  return r;
};

const LIVE = (version: string, seq: number): Record<string, unknown> => ({
  version,
  seq,
});
const APP_STORE_URL = "https://apps.apple.com/app/id1234567890";
const ROLLOUT_SALT = "00112233445566778899aabbccddeeff";

function pinOf(name: string): Record<string, unknown> {
  const r = record(name);
  return { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version };
}

/** `FC`, the feed the `feedCases` start from: a macOS and a Windows target pinning R15. */
function feedPayload(): Record<string, unknown> {
  const target = (
    platform: string,
    outlets: Record<string, unknown>,
  ): Record<string, unknown> => ({
    platform,
    release: pinOf("R15"),
    floor: null,
    critical: false,
    outlets,
  });
  return {
    schemaVersion: 1,
    iss: ISSUER_V3,
    aud: AUD_V3,
    channel: "stable",
    selector: {},
    seq: 7,
    issuedAt: FEED_ISSUED,
    expiresAt: FEED_EXPIRES,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        target("macos", {
          direct: { kind: "direct", live: LIVE("1.5.0", 15), halted: false },
          "app-store": {
            kind: "app-store",
            live: LIVE("1.4.0", 14),
            halted: false,
            listingUrl: APP_STORE_URL,
          },
        }),
        target("windows", {
          direct: { kind: "direct", live: LIVE("1.5.0", 15), halted: false },
          steam: { kind: "steam", live: LIVE("1.5.0", 15), halted: false },
        }),
      ],
    },
  };
}

interface FeedCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  floors?: Record<string, { seq: number; issuedAt: number }>;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; seq: number; issuedAt: number; doc?: unknown }
    | {
        verify: "fail";
        reason:
          | "jws"
          | "claims"
          | "channel"
          | "selector"
          | "freshness"
          | "not-newer"
          | "rollback";
      };
}

/** V4 §2.5 steps 3–8, from first principles. */
function refVerifyFeedCase(c: FeedCase): FeedCase["expect"] {
  const v = refVerifyJws(c.jws, c.trust, "pkey-feed+jws");
  if (!v) return { verify: "fail", reason: "jws" };
  const r = refFeedClaims(v.payload, ctxOf(v.text), {
    aud: c.expectedAud,
    channel: c.channel,
    platform: c.platform,
  });
  if (r) return { verify: "fail", reason: r };
  const d = v.payload as {
    channel: string;
    seq: number;
    issuedAt: number;
    expiresAt: number;
  };
  if (c.checkFreshness) {
    if (d.issuedAt > c.now + CLOCK_SKEW || d.expiresAt <= c.now - CLOCK_SKEW)
      return { verify: "fail", reason: "freshness" };
  }
  const floor = c.floors?.[d.channel];
  if (floor) {
    if (d.seq < floor.seq) return { verify: "fail", reason: "rollback" };
    if (d.seq === floor.seq && d.issuedAt <= floor.issuedAt)
      return { verify: "fail", reason: "not-newer" };
  }
  return { verify: "ok", seq: d.seq, issuedAt: d.issuedAt };
}

/** Leaf pointers where two JSON values differ (for the one-property twin check). */
function leafDiff(a: unknown, b: unknown, at = ""): string[] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      leafDiff(a[k], b[k], `${at}/${pointerToken(k)}`),
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, k) =>
      leafDiff(a[k], b[k], `${at}/${k}`),
    ).flat();
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

async function buildFeedCases(): Promise<FeedCase[]> {
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const cases: FeedCase[] = [];
  const base = feedPayload();
  type Patch = (d: Record<string, any>) => void;
  const mk = async (
    id: string,
    description: string,
    o: {
      patch?: Patch;
      doc?: Record<string, unknown>;
      text?: (d: Record<string, unknown>) => string;
      kid?: string;
      /** A header kid other than the signing key's (an unknown kid). */
      headerKid?: string;
      typ?: TypV3;
      trust?: Record<string, string>;
      channel?: string;
      now?: number;
      checkFreshness?: boolean;
      floors?: FeedCase["floors"];
      /** The one property under test (a pointer prefix); the twin is `FC` with it reverted. */
      prop?: string;
      withDoc?: boolean;
      expect: "ok" | Exclude<FeedCase["expect"], { verify: "ok" }>["reason"];
    },
  ): Promise<void> => {
    const doc = o.doc ?? structuredClone(base);
    o.patch?.(doc);
    const kid = o.kid ?? PIN_KID;
    const typ = o.typ ?? "pkey-feed+jws";
    const text = o.text ? o.text(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText(typ, o.headerKid ?? kid),
      text,
      kid,
    );
    const trust = o.trust ?? TRUST;
    const parsed = JSON.parse(text) as Record<string, number>;
    const c: FeedCase = {
      id,
      description,
      jws,
      trust,
      expectedAud: AUD_V3,
      channel: o.channel ?? "stable",
      platform: "macos",
      now: o.now ?? FEED_NOW,
      checkFreshness: o.checkFreshness ?? true,
      ...(o.floors ? { floors: o.floors } : {}),
      expect:
        o.expect === "ok"
          ? {
              verify: "ok",
              seq: parsed.seq!,
              issuedAt: parsed.issuedAt!,
              ...(o.withDoc ? { doc: JSON.parse(text) } : {}),
            }
          : { verify: "fail", reason: o.expect },
    };
    const v = refVerifyJws(jws, trust, "pkey-feed+jws");
    const nonWire = v ? refNonWire(v.text) : [];
    if (o.prop !== undefined) {
      const diff = leafDiff(base, doc);
      if (
        diff.length === 0 ||
        !diff.every((p) => p === o.prop || p.startsWith(`${o.prop}/`))
      )
        throw new Error(
          `feedCases ${id}: differs from FC outside ${o.prop}: ${diff.join(", ")}`,
        );
    }
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const t0 = (d: Record<string, any>): Record<string, any> => d.app.targets[0];
  const direct0 = (d: Record<string, any>): Record<string, any> =>
    t0(d).outlets.direct;
  const raws = (d: Record<string, unknown>): string => rawJson(d);

  // Left column of §4.4.
  await mk(
    "feed-valid",
    "The control: FC, signed by the product key, fresh, on its own channel.",
    { expect: "ok", withDoc: true },
  );
  await mk(
    "feed-valid-platform-selector",
    "A per-platform document (`selector: {platform: macos}`), which the Worker serves when the channel-wide one exceeds 65 536 bytes.",
    {
      patch: (d) => {
        d.selector = { platform: "macos" };
        d.app.targets = [d.app.targets[0]];
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-alias-channel",
    "A request for `latest` answered with the canonical `stable`: the claim is the canonical channel.",
    { channel: "latest", expect: "ok" },
  );
  await mk(
    "feed-valid-rotated-key",
    "Signed by `djdl-test-2026`, which the effective trust set holds (pins ∪ manifest keys).",
    {
      kid: ALT_KID,
      trust: { ...TRUST, [ALT_KID]: pub(ALT_KID) },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-reload-path-expired",
    "An expired feed on the reload path (`checkFreshness: false`): it still verifies, and keeps its floor.",
    {
      now: FEED_EXPIRES + CLOCK_SKEW + 1000,
      checkFreshness: false,
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-unknown-fields-ignored",
    "Reserved `packSets` and unknown members at every level are ignored.",
    {
      patch: (d) => {
        d.packSets = [];
        d.extra = { any: true };
        d.app.extra = 1;
        t0(d).extra = "x";
        direct0(d).extra = null;
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-at-cap",
    "A feed payload of exactly 65 536 bytes (no `doc`).",
    { doc: docOfExactBytes(65536, base), expect: "ok" },
  );
  await mk(
    "feed-valid-semver-build",
    "`semver+build`, the pin `1.5.0+46` (RB).",
    {
      patch: (d) => {
        d.app.versionScheme = "semver+build";
        for (const t of d.app.targets) {
          t.release = pinOf("RB");
          for (const e of Object.values<Record<string, any>>(t.outlets))
            if (e.live?.version === "1.5.0") e.live = LIVE("1.5.0+46", 16);
        }
      },
      expect: "ok",
    },
  );
  const to4part = (d: Record<string, any>): void => {
    d.app.versionScheme = "4part";
    for (const t of d.app.targets) {
      t.release = pinOf("R4");
      for (const e of Object.values<Record<string, any>>(t.outlets))
        if (e.live) e.live = LIVE(`${e.live.version}.0`, e.live.seq);
    }
  };
  await mk("feed-valid-4part", "`4part`, the pin `1.5.0.0` (R4).", {
    patch: to4part,
    expect: "ok",
  });
  await mk(
    "feed-valid-unknown-kind-ignored",
    "An entry of kind `epic`, outside the 17: allowed, never matched, and its `listingUrl` is only type-checked.",
    {
      patch: (d) => {
        t0(d).outlets["epic-store"] = {
          kind: "epic",
          live: null,
          halted: false,
          listingUrl: "https://store.epicgames.com/p/diceroll",
        };
      },
      prop: "/app/targets/0/outlets/epic-store",
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-floors-per-target",
    "Each target carries its own platform's floor: macOS `1.5.0`, Windows null.",
    {
      patch: (d) => {
        t0(d).floor = { minVersion: "1.5.0" };
      },
      prop: "/app/targets/0/floor",
      expect: "ok",
    },
  );
  const atMax = (d: Record<string, any>): void => {
    d.seq = MAX_WIRE_INTEGER_REF;
    t0(d).release = pinOf("R15max");
    direct0(d).live = LIVE("1.5.0", MAX_WIRE_INTEGER_REF);
  };
  await mk(
    "feed-valid-seq-at-max",
    "`seq`, the macOS pin's `seq` and its `direct` live `seq` all at 2^53 − 1.",
    { patch: atMax, expect: "ok" },
  );
  await mk(
    "feed-valid-seq-ceiling-recovery",
    "The `seq` ceiling recovery (V4 §4): a feed at 2^53 − 1 with a newer `issuedAt` than the committed one at the ceiling is accepted.",
    {
      patch: atMax,
      floors: {
        stable: { seq: MAX_WIRE_INTEGER_REF, issuedAt: FEED_ISSUED - 1000 },
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-seq-equal-newer-issued",
    "Equal `seq`, newer `issuedAt`: a re-signing of the same content, accepted.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED - 1000 } },
      expect: "ok",
    },
  );
  await mk(
    "feed-seq-higher-older-issued",
    "A higher `seq` with an older `issuedAt`: `seq` is primary.",
    {
      floors: { stable: { seq: 6, issuedAt: FEED_ISSUED + 500 } },
      expect: "ok",
    },
  );
  await mk(
    "feed-expires-within-skew",
    "`now = expiresAt + 299`: inside the skew, still fresh.",
    { now: FEED_EXPIRES + CLOCK_SKEW - 1, expect: "ok" },
  );
  await mk("feed-wrong-typ", "FC signed as `pkey-license+jws`.", {
    typ: "pkey-license+jws",
    expect: "jws",
  });
  await mk(
    "feed-signed-by-release-key",
    "FC signed by a RELEASE key: release keys are a separate input and never in a feed's trust set.",
    { kid: REL_KID, expect: "jws" },
  );
  await mk("feed-unknown-kid", "FC under a kid the trust set does not hold.", {
    headerKid: "pkey-test-unknown-2026",
    expect: "jws",
  });
  await mk(
    "feed-expired-network",
    "On the network path at `now = expiresAt + 300`: stale.",
    { now: FEED_EXPIRES + CLOCK_SKEW, expect: "freshness" },
  );
  await mk("feed-future-dated", "`issuedAt` 301 s ahead of `now`.", {
    patch: (d) => {
      d.issuedAt = FEED_NOW + CLOCK_SKEW + 1;
      d.expiresAt = d.issuedAt + FEED_TTL_REF;
    },
    expect: "freshness",
  });
  await mk(
    "feed-seq-equal-same-issued",
    "The committed feed again (equal `seq` and `issuedAt`): `not-newer`, kept silently.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED } },
      expect: "not-newer",
    },
  );
  await mk(
    "feed-seq-equal-older-issued",
    "Equal `seq`, older `issuedAt`: an older signing from a cache, `not-newer`.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED + 500 } },
      expect: "not-newer",
    },
  );
  await mk("feed-seq-rollback", "A lower `seq` than the floor: `rollback`.", {
    floors: { stable: { seq: 8, issuedAt: FEED_ISSUED - 1000 } },
    expect: "rollback",
  });
  await mk(
    "feed-wrong-channel",
    "A request for `stable` answered with `beta`.",
    {
      patch: (d) => void (d.channel = "beta"),
      prop: "/channel",
      expect: "channel",
    },
  );
  await mk(
    "feed-selector-other-platform",
    "A Windows document served to a macOS client.",
    {
      patch: (d) => {
        d.selector = { platform: "windows" };
        d.app.targets = [d.app.targets[1]];
      },
      expect: "selector",
    },
  );
  await mk(
    "feed-selector-unknown-key",
    "A selector key a v4 client does not know (P4 may add keys).",
    {
      patch: (d) => void (d.selector = { contentApi: "2" }),
      prop: "/selector",
      expect: "selector",
    },
  );
  await mk(
    "feed-schema-version-near-integer",
    'V4 §3: `"schemaVersion":1.0000000000000001`.',
    {
      patch: (d) => void (d.schemaVersion = raw("1.0000000000000001")),
      text: raws,
      prop: "/schemaVersion",
      expect: "claims",
    },
  );
  await mk(
    "feed-expires-at-near-integer",
    "V4 §3: the `expiresAt` token `1700000900.00000001`.",
    {
      patch: (d) => void (d.expiresAt = raw("1700000900.00000001")),
      text: raws,
      prop: "/expiresAt",
      expect: "claims",
    },
  );
  await mk(
    "feed-expires-at-over-max",
    "V4 §3: only `expiresAt` (9007199254740993) is above 2^53 − 1.",
    {
      patch: (d) => {
        d.issuedAt = 9007199254740000;
        d.expiresAt = raw(BIG_OVER);
      },
      text: raws,
      now: 9007199254740100,
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-live-missing",
    "V4 §3 presence: an entry with no `live` member (null is allowed, missing is not).",
    {
      patch: (d) => void delete direct0(d).live,
      prop: "/app/targets/0/outlets/direct/live",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-non-ascii",
    "An `app-store` `listingUrl` of 1 038 characters and 2 049 bytes: lengths count bytes, and the URL must be printable ASCII.",
    {
      patch: (d) =>
        void (t0(d).outlets["app-store"].listingUrl =
          `https://apps.apple.com/app/${"\u00e9".repeat(1011)}`),
      prop: "/app/targets/0/outlets/app-store/listingUrl",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-version-trailing-newline",
    'Whole-string patterns: the pin\'s `version` `"1.5.0\\n"`.',
    {
      patch: (d) => void (t0(d).release.version = "1.5.0\n"),
      prop: "/app/targets/0/release/version",
      expect: "claims",
    },
  );
  await mk(
    "feed-channel-trailing-newline",
    'Whole-string patterns: `"channel":"stable\\n"` (a lenient match would fail at `channel` instead).',
    {
      patch: (d) => void (d.channel = "stable\n"),
      prop: "/channel",
      expect: "claims",
    },
  );
  await mk(
    "feed-rollout-salt-trailing-newline",
    "Whole-string patterns: the `direct` entry's rollout `salt` followed by `\\n`.",
    {
      patch: (d) =>
        void (direct0(d).rollout = { bp: 5000, salt: `${ROLLOUT_SALT}\n` }),
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk(
    "feed-alias-staging-beta-floor-applies",
    "A request for `staging` answered with the canonical `beta` meets `floors.beta`: the floor is keyed by the claim, never by the requested name.",
    {
      patch: (d) => void (d.channel = "beta"),
      channel: "staging",
      floors: { beta: { seq: 9, issuedAt: FEED_ISSUED } },
      expect: "rollback",
    },
  );
  await mk("feed-target-seq-zero", "V4 §3 minimums: the pin's `seq` 0.", {
    patch: (d) => void (t0(d).release.seq = 0),
    prop: "/app/targets/0/release/seq",
    expect: "claims",
  });
  await mk("feed-rollout-bp-negative", 'V4 §3 minimums: `"bp":-1`.', {
    patch: (d) => void (direct0(d).rollout = { bp: -1, salt: ROLLOUT_SALT }),
    prop: "/app/targets/0/outlets/direct/rollout",
    expect: "claims",
  });
  await mk(
    "feed-target-platform-non-ascii",
    "`FEED_PLATFORM_PATTERN` is ASCII: a second target whose platform is `macoś` (its twin `freebsd`, an unknown ASCII platform, verifies).",
    {
      patch: (d) =>
        void d.app.targets.push({
          ...structuredClone(t0(d)),
          platform: "maco\u015b",
        }),
      prop: "/app/targets/2",
      expect: "claims",
    },
  );
  // Right column of §4.4.
  await mk("feed-wrong-aud", "A feed scoped to another product.", {
    patch: (d) => void (d.aud = "other-product"),
    prop: "/aud",
    expect: "claims",
  });
  await mk("feed-wrong-iss", "A foreign `iss`.", {
    patch: (d) => void (d.iss = "https://evil.example"),
    prop: "/iss",
    expect: "claims",
  });
  await mk("feed-schema-version-2", "`schemaVersion: 2`.", {
    patch: (d) => void (d.schemaVersion = 2),
    prop: "/schemaVersion",
    expect: "claims",
  });
  await mk(
    "feed-ttl-over-max",
    "`expiresAt = issuedAt + 3601`, past `MAX_FEED_TTL_SECONDS`.",
    {
      patch: (d) => void (d.expiresAt = d.issuedAt + MAX_FEED_TTL_REF + 1),
      prop: "/expiresAt",
      expect: "claims",
    },
  );
  await mk("feed-expires-not-after-issued", "`expiresAt = issuedAt`.", {
    patch: (d) => void (d.expiresAt = d.issuedAt),
    prop: "/expiresAt",
    expect: "claims",
  });
  await mk("feed-target-bad-sha256", "A pin that is not 64 lowercase hex.", {
    patch: (d) => void (t0(d).release.sha256 = t0(d).release.sha256.slice(1)),
    prop: "/app/targets/0/release/sha256",
    expect: "claims",
  });
  await mk("feed-duplicate-platform-target", "Two targets for one platform.", {
    patch: (d) => void (d.app.targets[1].platform = "macos"),
    prop: "/app/targets/1/platform",
    expect: "claims",
  });
  await mk(
    "feed-target-outside-selector",
    "`selector.platform` is macOS but a target is Windows.",
    {
      patch: (d) => void (d.selector = { platform: "macos" }),
      prop: "/selector",
      expect: "claims",
    },
  );
  await mk("feed-rollout-bp-over-max", "`bp` 10 001, past 10 000.", {
    patch: (d) =>
      void (direct0(d).rollout = {
        bp: ROLLOUT_BUCKETS_REF + 1,
        salt: ROLLOUT_SALT,
      }),
    prop: "/app/targets/0/outlets/direct/rollout",
    expect: "claims",
  });
  await mk(
    "feed-floor-not-in-scheme",
    "A target floor `1.5` that does not parse under `semver`.",
    {
      patch: (d) => void (t0(d).floor = { minVersion: "1.5" }),
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk(
    "feed-floor-above-target",
    "A floor `1.6.0` above the pin `1.5.0`.",
    {
      patch: (d) => void (t0(d).floor = { minVersion: "1.6.0" }),
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk("feed-seq-zero", "V4 §3 minimums: `seq` 0.", {
    patch: (d) => void (d.seq = 0),
    prop: "/seq",
    expect: "claims",
  });
  await mk("feed-seq-fraction", 'V4 §3: `"seq":7.5`.', {
    patch: (d) => void (d.seq = 7.5),
    prop: "/seq",
    expect: "claims",
  });
  await mk(
    "feed-seq-integral-fraction",
    'V4 §3: `"seq":7.0`, an integer claim\'s token.',
    {
      patch: (d) => void (d.seq = raw("7.0")),
      text: raws,
      prop: "/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-seq-near-integer",
    'V4 §3: `"seq":7.0000000000000001`, which Node, Swift and Godot read as 7.',
    {
      patch: (d) => void (d.seq = raw("7.0000000000000001")),
      text: raws,
      prop: "/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-seq-near-integer",
    "V4 §3: the pin's `seq` token `15.0000000000000001`, at `/app/targets/0/release/seq`.",
    {
      patch: (d) => void (t0(d).release.seq = raw("15.0000000000000001")),
      text: raws,
      prop: "/app/targets/0/release/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-rollout-bp-exponent",
    'V4 §3: `"bp":25e2`, at `/app/targets/0/outlets/direct/rollout/bp`.',
    {
      patch: (d) =>
        void (direct0(d).rollout = { bp: raw("25e2"), salt: ROLLOUT_SALT }),
      text: raws,
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk("feed-seq-over-max", "V4 §3: `seq` 9007199254740992.", {
    patch: (d) => void (d.seq = 9007199254740992),
    prop: "/seq",
    expect: "claims",
  });
  await mk(
    "feed-target-seq-over-max",
    "V4 §3: the pin's `seq` 9007199254740993, which JavaScript reads as 2^53.",
    {
      patch: (d) => void (t0(d).release.seq = raw(BIG_OVER)),
      text: raws,
      prop: "/app/targets/0/release/seq",
      expect: "claims",
    },
  );
  await mk("feed-live-seq-over-max", "V4 §3: a live `seq` 18014398509481984.", {
    patch: (d) => void (direct0(d).live.seq = 18014398509481984),
    prop: "/app/targets/0/outlets/direct/live/seq",
    expect: "claims",
  });
  await mk("feed-version-scheme-unknown", "`versionScheme: calver`.", {
    patch: (d) => void (d.app.versionScheme = "calver"),
    prop: "/app/versionScheme",
    expect: "claims",
  });
  await mk(
    "feed-target-version-not-in-scheme",
    "`4part` with a pin `1.5.0` (every live version is four-part).",
    {
      patch: (d) => {
        to4part(d);
        t0(d).release.version = "1.5.0";
      },
      expect: "claims",
    },
  );
  await mk("feed-outlet-kind-missing", "An entry with no `kind`.", {
    patch: (d) => void delete direct0(d).kind,
    prop: "/app/targets/0/outlets/direct/kind",
    expect: "claims",
  });
  await mk(
    "feed-outlet-kind-literal-unknown",
    "An entry of kind `unknown`, a detection result that nothing can declare.",
    {
      patch: (d) => void (direct0(d).kind = "unknown"),
      prop: "/app/targets/0/outlets/direct/kind",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-foreign-host",
    "`https://apps.apple.com.example/…`: the prefix is compared byte for byte, `/` included.",
    {
      patch: (d) =>
        void (t0(d).outlets["app-store"].listingUrl =
          "https://apps.apple.com.example/app/id1234567890"),
      prop: "/app/targets/0/outlets/app-store/listingUrl",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-on-kind-without-prefixes",
    "An `altstore` entry carrying a `listingUrl`: AltStore sources are code-delivery paths, so the kind has no prefixes.",
    {
      patch: (d) =>
        void (t0(d).outlets.altstore = {
          kind: "altstore",
          live: null,
          halted: false,
          listingUrl: "https://apps.apple.com/app/id1234567890",
        }),
      prop: "/app/targets/0/outlets/altstore",
      expect: "claims",
    },
  );
  {
    const prefix = `${APP_STORE_URL}?x=`;
    await mk(
      "feed-valid-listing-url-at-max",
      "An `app-store` `listingUrl` of exactly 2 048 ASCII bytes.",
      {
        patch: (d) =>
          void (t0(d).outlets["app-store"].listingUrl =
            prefix + "a".repeat(2048 - prefix.length)),
        prop: "/app/targets/0/outlets/app-store/listingUrl",
        expect: "ok",
      },
    );
    await mk(
      "feed-listing-url-over-max",
      "2 049 ASCII bytes under the `app-store` prefix.",
      {
        patch: (d) =>
          void (t0(d).outlets["app-store"].listingUrl =
            prefix + "a".repeat(2049 - prefix.length)),
        prop: "/app/targets/0/outlets/app-store/listingUrl",
        expect: "claims",
      },
    );
  }
  await mk(
    "feed-issued-at-near-integer",
    "V4 §3: the `issuedAt` token `1700000000.00000001`.",
    {
      patch: (d) => void (d.issuedAt = raw("1700000000.00000001")),
      text: raws,
      prop: "/issuedAt",
      expect: "claims",
    },
  );
  await mk(
    "feed-live-seq-near-integer",
    "V4 §3: the first target's `direct` live `seq` token `15.0000000000000001`.",
    {
      patch: (d) => void (direct0(d).live.seq = raw("15.0000000000000001")),
      text: raws,
      prop: "/app/targets/0/outlets/direct/live/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-floor-missing",
    "V4 §3 presence: a target with no `floor` member.",
    {
      patch: (d) => void delete t0(d).floor,
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-rollout-null",
    "V4 §3 presence: `rollout: null` (an optional member is absent or typed).",
    {
      patch: (d) => void (direct0(d).rollout = null),
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-id-trailing-newline",
    'Whole-string patterns: an outlet key `"direct\\n"` of kind `direct`.',
    {
      patch: (d) => {
        const outlets = t0(d).outlets;
        t0(d).outlets = {
          "direct\n": outlets.direct,
          "app-store": outlets["app-store"],
        };
      },
      expect: "claims",
    },
  );
  await mk(
    "feed-target-sha256-trailing-newline",
    "Whole-string patterns: the pin's `sha256` followed by `\\n`.",
    {
      patch: (d) => void (t0(d).release.sha256 += "\n"),
      prop: "/app/targets/0/release/sha256",
      expect: "claims",
    },
  );
  await mk(
    "feed-valid-manual-staging-beta-floor-ignored",
    "A product with a manual `staging` channel: the claim is `staging`, so `floors.beta` does not apply (a runner that resolved `staging` itself would fail here).",
    {
      patch: (d) => void (d.channel = "staging"),
      channel: "staging",
      floors: { beta: { seq: 9, issuedAt: FEED_ISSUED } },
      expect: "ok",
    },
  );
  await mk(
    "feed-channel-latest-claim",
    "A request for `latest` answered with the claim `latest`, which is never canonical (it always resolves to `stable`).",
    {
      patch: (d) => void (d.channel = "latest"),
      channel: "latest",
      expect: "channel",
    },
  );
  await mk(
    "feed-live-seq-zero",
    "V4 §3 minimums: the first target's `direct` live `seq` 0.",
    {
      patch: (d) => void (direct0(d).live.seq = 0),
      prop: "/app/targets/0/outlets/direct/live/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-issued-at-negative",
    "V4 §3 minimums: `issuedAt` −1 (`expiresAt` 899) on the reload path; on the network path the freshness window refuses it first.",
    {
      patch: (d) => {
        d.issuedAt = -1;
        d.expiresAt = 899;
      },
      checkFreshness: false,
      expect: "claims",
    },
  );

  // plans/P4-13.md §4.2: three appended cases carrying the content members.
  await appendContentFeedCases(mk, base);

  if (cases.length !== 80) throw new Error(`feedCases: ${cases.length} != 80`);
  for (const c of cases) {
    const want = refVerifyFeedCase(c);
    const got = c.expect;
    if (
      want.verify !== got.verify ||
      (want.verify === "fail" &&
        got.verify === "fail" &&
        want.reason !== got.reason) ||
      (want.verify === "ok" &&
        got.verify === "ok" &&
        (want.seq !== got.seq || want.issuedAt !== got.issuedAt))
    )
      throw new Error(
        `feedCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
    for (const k of Object.keys(c.floors ?? {}))
      if (!REF_CHANNEL_RE.test(k) || k === "latest")
        throw new Error(`feedCases ${c.id}: floor key ${k}`);
  }
  return cases;
}

// ── The update decision (plans/P3-01.md §2.8), the generator's reference ─────────────────────

interface RefInput {
  now: number;
  feed: Record<string, any>;
  record: Record<string, any> | null;
  installed: {
    version: string;
    binaryVersion: string;
    buildNumber: string | null;
    platform: string;
    arch: string;
    format: string | null;
    engine: string | null;
  };
  outlet: { id: string | null; kind: string };
  subkind: string | null;
  staged: { version: string; channel: string } | null;
  skipVersion: string | null;
  bucket: number | null;
  methods: string[];
}

/** One build's eligibility for self-installation (§2.8 "Eligible builds"). A build whose
 *  `requires.engine` is not a string, or whose `requires.minBinary` does not parse, is never
 *  eligible. */
function refEligible(
  b: Record<string, any>,
  inp: RefInput,
  scheme: string,
): boolean {
  const payloads = (b.artifacts as Record<string, unknown>[]).filter(
    (a) => a.role === "payload",
  );
  if (payloads.length !== 1) return false;
  if (b.platform !== inp.installed.platform) return false;
  if (
    b.arch !== inp.installed.arch &&
    b.arch !== "universal" &&
    b.arch !== "any"
  )
    return false;
  const req = b.requires;
  if (isObj(req)) {
    if (hasOwn(req, "engine") && typeof req.engine !== "string") return false;
    if (
      hasOwn(req, "minBinary") &&
      refParseVersion(scheme, req.minBinary) === null
    )
      return false;
  }
  return true;
}

const ARCH_RANK = (b: Record<string, any>, arch: string): number =>
  b.arch === arch ? 0 : b.arch === "universal" ? 1 : 2;

function refPickBuild(
  builds: Record<string, any>[],
  arch: string,
): Record<string, any> | null {
  const sorted = [...builds].sort((x, y) => {
    const r = ARCH_RANK(x, arch) - ARCH_RANK(y, arch);
    if (r !== 0) return r;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

function refDecideUpdate(inp: RefInput): Record<string, unknown> {
  const feed = inp.feed;
  const scheme = feed.app.versionScheme as string;
  const cmp = (a: string, b: string): number | null =>
    refCompareVersions(scheme, a, b);
  const discard = (action: string): boolean =>
    inp.staged !== null && action !== "code-ready";
  const none = (reason: string): Record<string, unknown> => ({
    action: "none",
    reason,
    behind: reason === "behind",
    discardStaged: discard("none"),
  });
  const blocked = (): Record<string, unknown> => ({
    action: "blocked",
    reason: "app-floor",
    discardStaged: discard("blocked"),
  });

  // 1. Stale.
  if (inp.now >= (feed.expiresAt as number) + CLOCK_SKEW)
    return {
      action: "none",
      reason: "stale",
      behind: false,
      discardStaged: false,
    };
  // 2. Unknown version.
  const run = inp.installed.version;
  const bin = inp.installed.binaryVersion ?? run;
  if (
    refParseVersion(scheme, run) === null ||
    refParseVersion(scheme, bin) === null
  )
    return none("unknown-version");
  // 3. Setup.
  const target = (feed.app.targets as Record<string, any>[]).find(
    (t) => t.platform === inp.installed.platform,
  );
  let entry: Record<string, any> | null = null;
  if (target && inp.outlet.kind !== "unknown") {
    const outlets = target.outlets as Record<string, Record<string, any>>;
    const byId = inp.outlet.id !== null ? outlets[inp.outlet.id] : undefined;
    if (byId && byId.kind === inp.outlet.kind) entry = byId;
    else {
      const ofKind = Object.values(outlets).filter(
        (e) => e.kind === inp.outlet.kind,
      );
      if (ofKind.length === 1) entry = ofKind[0]!;
    }
  }
  const caps = refEffectiveCapabilities(inp.outlet.kind, {
    platform: inp.installed.platform,
    subkind: inp.subkind,
    server: entry?.capabilities,
  });
  const belowFloor =
    !!target && target.floor !== null && cmp(bin, target.floor.minVersion)! < 0;
  // 4. The offer.
  let offer: Record<string, any> | null = null;
  if (entry) {
    if (caps.binaryUpdates === "self") {
      offer =
        entry.live !== null &&
        entry.live.seq === target!.release.seq &&
        inp.record !== null
          ? target!.release
          : null;
    } else offer = entry.live;
  }
  if (!offer) return belowFloor ? blocked() : none("not-available");
  // 5. Behind.
  if (cmp(offer.version, run)! < 0) return none("behind");
  // 6. Up to date.
  const newerRun = cmp(offer.version, run)! > 0;
  const newerBin = cmp(offer.version, bin)! > 0;
  if (!newerRun && !(belowFloor && newerBin))
    return belowFloor ? blocked() : none("up-to-date");
  // 7. Halted.
  if (entry!.halted) return belowFloor ? blocked() : none("halted");
  // 8. Rollout.
  if (hasOwn(entry!, "rollout") && !belowFloor && !target!.critical) {
    const bp = entry!.rollout.bp as number;
    if (!(inp.bucket !== null && inp.bucket < bp)) return none("out-of-bucket");
  }
  const short = { version: offer.version, seq: offer.seq };
  const critical = target!.critical as boolean;
  // 9. Platform.
  if (caps.binaryUpdates === "none")
    return {
      action: "platform",
      release: short,
      mandatory: belowFloor,
      critical,
      discardStaged: discard("platform"),
    };
  // 10. Store.
  if (caps.binaryUpdates === "store")
    return {
      action: "store",
      release: short,
      listingUrl: entry!.listingUrl ?? null,
      mandatory: belowFloor,
      critical,
      discardStaged: discard("store"),
    };
  // 11. Self-updating outlets.
  const full = { version: offer.version, seq: offer.seq, sha256: offer.sha256 };
  const notSkipped = offer.version !== inp.skipVersion;
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    inp.staged !== null &&
    inp.staged.channel === feed.channel &&
    inp.staged.version === offer.version &&
    notSkipped
  )
    return {
      action: "code-ready",
      release: full,
      critical,
      discardStaged: false,
    };
  const builds = ((inp.record?.builds ?? []) as Record<string, any>[]).filter(
    (b) => refEligible(b, inp, scheme),
  );
  const codePacks = builds.filter((b) => {
    if (b.format !== "pck") return false;
    const req = isObj(b.requires) ? b.requires : {};
    if (
      typeof req.engine !== "string" ||
      inp.installed.engine === null ||
      req.engine !== inp.installed.engine
    )
      return false;
    if (!hasOwn(req, "minBinary")) return true;
    const c = cmp(bin, req.minBinary as string);
    return c !== null && c >= 0;
  });
  const binaries = builds.filter(
    (b) =>
      b.format !== "pck" &&
      (inp.installed.format === null || b.format === inp.installed.format),
  );
  const binary = (
    method: string,
    build: Record<string, any>,
  ): Record<string, unknown> => ({
    action: "binary",
    method,
    release: full,
    build: build.id,
    mandatory: belowFloor,
    critical,
    prestage: [],
    discardStaged: discard("binary"),
  });
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    inp.methods.includes("sidecar-pck") &&
    notSkipped &&
    codePacks.length > 0
  )
    return binary("sidecar-pck", refPickBuild(codePacks, inp.installed.arch)!);
  const pick = refPickBuild(binaries, inp.installed.arch);
  for (const method of ["native", "download"])
    if (newerBin && inp.methods.includes(method) && pick)
      return binary(method, pick);
  if (belowFloor) return blocked();
  if (!notSkipped) return none("skipped");
  if (!pick) return none("no-build");
  return none("no-method");
}

/** §2.8 (P3-01): no v4 answer stops play. `refBootDecisionV2` adds plans/P4-13.md §2.6. */
function refBootDecision(d: Record<string, unknown>): string {
  if (d.action === "none") return "none";
  if (d.action === "platform" && d.mandatory === false) return "none";
  return "optional";
}

function refResolveUpdateOutlet(o: {
  host: unknown;
  stamp: Record<string, unknown> | null;
  detected: Record<string, unknown> | null;
}): { id: string | null; kind: string; subkind: string | null } {
  const kinds: readonly string[] = REF_OUTLET_KINDS;
  if (o.host !== null && o.host !== undefined) {
    if (typeof o.host === "string") {
      if (!kinds.includes(o.host)) throw new Error("invalid-options");
      return { id: o.host, kind: o.host, subkind: null };
    }
    const h = o.host as Record<string, unknown>;
    if (typeof h.kind !== "string" || !kinds.includes(h.kind))
      throw new Error("invalid-options");
    if (typeof h.id !== "string" || !REF_OUTLET_ID_RE.test(h.id))
      throw new Error("invalid-options");
    if (
      h.subkind !== undefined &&
      h.subkind !== null &&
      !REF_SUBKINDS.includes(h.subkind as string)
    )
      throw new Error("invalid-options");
    return {
      id: h.id,
      kind: h.kind,
      subkind: (h.subkind as string | undefined) ?? null,
    };
  }
  const s = o.stamp ?? {};
  const rawKind = hasOwn(s, "outletKind") ? s.outletKind : s.outlet;
  const kind =
    typeof rawKind === "string" && kinds.includes(rawKind) ? rawKind : null;
  const id =
    typeof s.outlet === "string" && REF_OUTLET_ID_RE.test(s.outlet)
      ? s.outlet
      : null;
  const sub =
    typeof s.outletSubkind === "string" &&
    REF_SUBKINDS.includes(s.outletSubkind)
      ? s.outletSubkind
      : null;
  if (o.detected) {
    const dk = o.detected.kind as string;
    const ds = (o.detected.subkind as string | null) ?? null;
    return dk === kind
      ? { id, kind: dk, subkind: ds }
      : { id: null, kind: dk, subkind: ds };
  }
  if (kind !== null) return { id, kind, subkind: sub };
  return { id: null, kind: "unknown", subkind: null };
}

function refBucket(
  salt: string,
  installId: string,
): { sha256: string; first4: string; u32: number; bucket: number } {
  const digest = createHash("sha256")
    .update(Buffer.from(salt, "utf8"))
    .update(Buffer.from(installId, "utf8"))
    .digest();
  const u32 = digest.readUInt32BE(0);
  return {
    sha256: digest.toString("hex"),
    first4: digest.subarray(0, 4).toString("hex"),
    u32,
    bucket: u32 % 10000,
  };
}

// ── §4.6 `update-matrix.json` ────────────────────────────────────────────────────────────────

/** `F`: six targets in `RELEASE_PLATFORMS` order, each pinning R15 (plans/P3-01.md §4.6). */
function matrixFeed(): Record<string, any> {
  const e = (
    kind: string,
    live: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    kind,
    live,
    halted: false,
    ...extra,
  });
  const L15 = LIVE("1.5.0", 15);
  const L14 = LIVE("1.4.0", 14);
  const appStore = e("app-store", L14, { listingUrl: APP_STORE_URL });
  const t = (
    platform: string,
    outlets: Record<string, unknown>,
  ): Record<string, unknown> => ({
    platform,
    release: pinOf("R15"),
    floor: null,
    critical: false,
    outlets,
  });
  return {
    schemaVersion: 1,
    iss: ISSUER_V3,
    aud: AUD_V3,
    channel: "stable",
    selector: {},
    seq: 7,
    issuedAt: FEED_ISSUED,
    expiresAt: FEED_EXPIRES,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        t("macos", {
          direct: e("direct", L15),
          "app-store": structuredClone(appStore),
          steam: e("steam", L15),
        }),
        t("ios", {
          direct: e("direct", L15),
          "app-store": structuredClone(appStore),
          testflight: e("testflight", L15),
          altstore: e("altstore", L15),
          "altstore-beta": e("altstore", L14),
        }),
        t("android", {
          direct: e("direct", L15),
          play: e("play", L14),
          obtainium: e("obtainium", L15),
        }),
        t("windows", {
          direct: e("direct", L15),
          steam: e("steam", L15),
          "ms-store": e("ms-store", L14),
        }),
        t("linux", {
          direct: e("direct", L15),
          steam: e("steam", L15),
          flathub: e("flathub", L14),
        }),
        t("web", { web: e("web", L15) }),
      ],
    },
  };
}

function rescheme(
  feed: Record<string, any>,
  scheme: string,
  pin: string,
  map: (v: string, seq: number) => [string, number],
): void {
  feed.app.versionScheme = scheme;
  for (const t of feed.app.targets) {
    t.release = pinOf(pin);
    for (const en of Object.values<Record<string, any>>(t.outlets))
      if (en.live) {
        const [v, s] = map(en.live.version, en.live.seq);
        en.live = LIVE(v, s);
      }
  }
}

function matrixFeedB(): Record<string, any> {
  const f = matrixFeed();
  rescheme(f, "semver+build", "RB", (v, s) =>
    v === "1.5.0" ? ["1.5.0+46", 16] : [v, s],
  );
  return f;
}
function matrixFeed4(): Record<string, any> {
  const f = matrixFeed();
  rescheme(f, "4part", "R4", (v, s) => [`${v}.0`, s]);
  return f;
}
function matrixFeedBeta(): Record<string, any> {
  return {
    ...matrixFeed(),
    channel: "beta",
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        {
          platform: "macos",
          release: pinOf("R16b"),
          floor: null,
          critical: false,
          outlets: {
            direct: {
              kind: "direct",
              live: LIVE("1.6.0-beta.2", 16),
              halted: false,
            },
          },
        },
      ],
    },
  };
}

function baseInput(): RefInput {
  return {
    now: FEED_NOW,
    feed: matrixFeed(),
    record: structuredClone(record("R15").doc),
    installed: {
      version: "1.4.0",
      binaryVersion: "1.4.0",
      buildNumber: "140",
      platform: "macos",
      arch: "arm64",
      format: null,
      engine: "godot-4.7",
    },
    outlet: { id: "direct", kind: "direct" },
    subkind: null,
    staged: null,
    skipVersion: null,
    bucket: null,
    methods: ["download"],
  };
}

/** The delta rule (§4.6), as functions. */
const D = {
  W: (i: RefInput): void => {
    i.installed.platform = "windows";
    i.installed.arch = "x86_64";
    i.installed.format = "zip";
    i.methods = ["sidecar-pck", "download"];
  },
  installed:
    (v: string) =>
    (i: RefInput): void => {
      i.installed.version = v;
      i.installed.binaryVersion = v;
    },
  version:
    (v: string) =>
    (i: RefInput): void =>
      void (i.installed.version = v),
  binary:
    (v: string) =>
    (i: RefInput): void =>
      void (i.installed.binaryVersion = v),
  platform:
    (p: string, arch?: string) =>
    (i: RefInput): void => {
      i.installed.platform = p;
      if (arch) i.installed.arch = arch;
    },
  format:
    (f: string) =>
    (i: RefInput): void =>
      void (i.installed.format = f),
  outlet:
    (id: string | null, kind?: string) =>
    (i: RefInput): void =>
      void (i.outlet = { id, kind: kind ?? (id as string) }),
  subkind:
    (s: string) =>
    (i: RefInput): void =>
      void (i.subkind = s),
  methods:
    (...m: string[]) =>
    (i: RefInput): void =>
      void (i.methods = m),
  staged:
    (version: string, channel: string) =>
    (i: RefInput): void =>
      void (i.staged = { version, channel }),
  skip:
    (v: string) =>
    (i: RefInput): void =>
      void (i.skipVersion = v),
  bucket:
    (n: number | null) =>
    (i: RefInput): void =>
      void (i.bucket = n),
  now:
    (t: number) =>
    (i: RefInput): void =>
      void (i.now = t),
  engine:
    (e: string) =>
    (i: RefInput): void =>
      void (i.installed.engine = e),
  recordNull: (i: RefInput): void => void (i.record = null),
  floor:
    (platform: string, v: string) =>
    (i: RefInput): void => {
      i.feed.app.targets.find(
        (t: Record<string, any>) => t.platform === platform,
      ).floor = { minVersion: v };
    },
  /** An entry change on the decided platform (`installed.platform`). */
  entry:
    (id: string, patch: Record<string, unknown>) =>
    (i: RefInput): void => {
      const t = i.feed.app.targets.find(
        (x: Record<string, any>) => x.platform === i.installed.platform,
      );
      Object.assign(t.outlets[id], patch);
    },
  rollout:
    (bp: number) =>
    (i: RefInput): void => {
      const t = i.feed.app.targets.find(
        (x: Record<string, any>) => x.platform === i.installed.platform,
      );
      t.outlets.direct.rollout = { bp, salt: ROLLOUT_SALT };
    },
  critical: (i: RefInput): void => {
    i.feed.app.targets.find(
      (x: Record<string, any>) => x.platform === i.installed.platform,
    ).critical = true;
  },
  feedRecord:
    (feed: () => Record<string, any>, rec: string) =>
    (i: RefInput): void => {
      i.feed = feed();
      i.record = structuredClone(record(rec).doc);
    },
};

type Delta = (i: RefInput) => void;
/** The plan's expected decision, in its own terms; every given member must match. */
interface Want {
  action: string;
  reason?: string;
  method?: string;
  build?: string;
  release?: string;
  mandatory?: boolean;
  critical?: boolean;
  discardStaged?: boolean;
  listingUrl?: string | null;
  boot: "none" | "optional";
}

function updateRowsSpec(): { name: string; deltas: Delta[]; want: Want }[] {
  const { W } = D;
  const row = (
    name: string,
    deltas: Delta[],
    want: Want,
  ): { name: string; deltas: Delta[]; want: Want } => ({ name, deltas, want });
  const o = "optional" as const;
  const n = "none" as const;
  const r6 = [D.floor("macos", "1.5.0")];
  const r26 = [D.platform("ios"), D.outlet("app-store"), D.installed("1.3.0")];
  const r45 = [D.outlet(null, "unknown")];
  return [
    row("none — up to date", [D.installed("1.5.0")], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "none — behind: the channel head is older, nothing is downgraded",
      [D.installed("1.6.0-beta.1")],
      { action: "none", reason: "behind", boot: n },
    ),
    row(
      "none — behind suppresses the floor",
      [D.installed("1.6.0"), D.binary("1.3.0"), D.floor("macos", "1.4.0")],
      { action: "none", reason: "behind", boot: n },
    ),
    row("binary — download a newer release on `direct` (universal build)", [], {
      action: "binary",
      method: "download",
      build: "macos-dmg",
      boot: o,
    }),
    row(
      "binary — native when the host has a native updater",
      [D.methods("native", "download")],
      { action: "binary", method: "native", build: "macos-dmg", boot: o },
    ),
    row("binary — mandatory below this platform's floor", r6, {
      action: "binary",
      method: "download",
      build: "macos-dmg",
      mandatory: true,
      boot: o,
    }),
    row(
      "binary — the floor is judged against the binary, not the running code",
      [W, D.version("1.5.0"), D.binary("1.3.0"), D.floor("windows", "1.4.0")],
      {
        action: "binary",
        method: "download",
        build: "win-zip",
        mandatory: true,
        boot: o,
      },
    ),
    row("binary — sidecar-pck: same engine, the binary meets minBinary", [W], {
      action: "binary",
      method: "sidecar-pck",
      build: "win-pck",
      boot: o,
    }),
    row(
      "binary — an engine change: the binary supersedes code",
      [W, D.engine("godot-4.6")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "binary — minBinary not met: the binary supersedes code",
      [W, D.version("1.3.5"), D.binary("1.3.0")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "binary — a mandatory update never takes the code path",
      [W, D.floor("windows", "1.5.0")],
      {
        action: "binary",
        method: "download",
        build: "win-zip",
        mandatory: true,
        boot: o,
      },
    ),
    row(
      "code-ready — the staged release is the target on the same channel",
      [W, D.staged("1.5.0", "stable")],
      { action: "code-ready", discardStaged: false, boot: o },
    ),
    row(
      "binary — staged code from another channel is discarded",
      [W, D.staged("1.5.0", "beta")],
      { action: "binary", method: "sidecar-pck", discardStaged: true, boot: o },
    ),
    row(
      "binary — a stale staged release is discarded",
      [W, D.staged("1.4.5", "stable")],
      { action: "binary", method: "sidecar-pck", discardStaged: true, boot: o },
    ),
    row(
      "binary — the skipped version is still offered as a download",
      [W, D.skip("1.5.0")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "none — the skipped version with no other method",
      [W, D.methods("sidecar-pck"), D.skip("1.5.0")],
      { action: "none", reason: "skipped", boot: n },
    ),
    row("none — no method this host can perform", [D.methods()], {
      action: "none",
      reason: "no-method",
      boot: n,
    }),
    row(
      "blocked — below the floor with no method: a prompt, and play goes on",
      [D.methods(), D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "none — halted, and the staged update is discarded",
      [W, D.entry("direct", { halted: true }), D.staged("1.5.0", "stable")],
      { action: "none", reason: "halted", discardStaged: true, boot: n },
    ),
    row(
      "blocked — halted below the floor",
      [D.entry("direct", { halted: true }), D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row("none — out of the rollout bucket", [D.rollout(2500), D.bucket(6871)], {
      action: "none",
      reason: "out-of-bucket",
      boot: n,
    }),
    row(
      "binary — inside the rollout bucket",
      [D.rollout(7000), D.bucket(6871)],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — a bucket equal to bp is out",
      [D.rollout(6871), D.bucket(6871)],
      { action: "none", reason: "out-of-bucket", boot: n },
    ),
    row(
      "binary — a critical release bypasses the rollout",
      [D.rollout(2500), D.bucket(6871), D.critical],
      { action: "binary", method: "download", critical: true, boot: o },
    ),
    row(
      "binary — below the floor bypasses the rollout",
      [D.rollout(2500), D.bucket(6871), D.floor("macos", "1.5.0")],
      { action: "binary", method: "download", mandatory: true, boot: o },
    ),
    row("store — a newer release is live on the App Store", r26, {
      action: "store",
      release: "1.4.0",
      listingUrl: APP_STORE_URL,
      boot: o,
    }),
    row(
      "none — the App Store has nothing newer",
      [D.platform("ios"), D.outlet("app-store"), D.installed("1.4.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "store — mandatory, and the store's release clears the floor",
      [...r26, D.floor("ios", "1.4.0")],
      { action: "store", release: "1.4.0", mandatory: true, boot: o },
    ),
    row(
      "store — mandatory although the store's release is still below the floor",
      [...r26, D.floor("ios", "1.5.0")],
      { action: "store", release: "1.4.0", mandatory: true, boot: o },
    ),
    row(
      "blocked — below the floor, and the store has nothing newer",
      [
        D.platform("ios"),
        D.outlet("app-store"),
        D.installed("1.4.0"),
        D.floor("ios", "1.5.0"),
      ],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "store — store builds never self-update code",
      [
        D.platform("macos"),
        D.outlet("app-store"),
        D.installed("1.3.0"),
        D.methods("sidecar-pck", "download"),
        D.staged("1.4.0", "stable"),
      ],
      { action: "store", release: "1.4.0", discardStaged: true, boot: o },
    ),
    row(
      "platform — Steam has a newer release",
      [D.platform("linux", "x86_64"), D.outlet("steam")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row(
      "platform — mandatory through Steam",
      [
        D.platform("linux", "x86_64"),
        D.outlet("steam"),
        D.floor("linux", "1.5.0"),
      ],
      { action: "platform", release: "1.5.0", mandatory: true, boot: o },
    ),
    row(
      "platform — web reloads",
      [D.platform("web", "wasm32"), D.outlet("web")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row(
      "none — the outlet has no entry for this platform",
      [D.platform("linux", "x86_64"), D.outlet("itch")],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "none — no target for the platform",
      [
        (i) =>
          void (i.feed.app.targets = i.feed.app.targets.filter(
            (t: Record<string, any>) => t.platform !== "android",
          )),
        D.platform("android", "arm64"),
        D.outlet("obtainium"),
      ],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "binary — another platform's floor does not apply",
      [W, D.floor("macos", "1.5.0")],
      { action: "binary", method: "sidecar-pck", build: "win-pck", boot: o },
    ),
    row("none — no record for a self-updating outlet", [D.recordNull], {
      action: "none",
      reason: "not-available",
      boot: n,
    }),
    row(
      "none — a stale feed freezes, and the staged update is kept",
      [D.now(1700001200), W, D.staged("1.5.0", "stable")],
      { action: "none", reason: "stale", discardStaged: false, boot: n },
    ),
    row(
      "none — a stale feed never blocks below the floor",
      [D.now(1700001200), D.floor("macos", "1.5.0")],
      { action: "none", reason: "stale", boot: n },
    ),
    row("binary — one second before stale", [D.now(1700001199)], {
      action: "binary",
      method: "download",
      boot: o,
    }),
    row(
      "binary — server narrowing turns code updates off",
      [W, D.entry("direct", { capabilities: { codeUpdates: false } })],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "store — the server cannot widen an App Store build to self",
      [
        ...r26,
        D.entry("app-store", { capabilities: { binaryUpdates: "self" } }),
      ],
      { action: "store", release: "1.4.0", boot: o },
    ),
    row(
      "platform — a Homebrew install is updated by brew",
      [D.subkind("homebrew")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row("none — an unknown outlet is never offered an update", r45, {
      action: "none",
      reason: "not-available",
      boot: n,
    }),
    row(
      "blocked — an unknown outlet below the floor",
      [...r45, D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "binary — format gating picks the installed format",
      [D.platform("windows", "x86_64"), D.format("exe")],
      { action: "binary", method: "download", build: "win-exe", boot: o },
    ),
    row(
      "binary — the arm64 build on an arm64 Linux device",
      [D.platform("linux", "arm64")],
      { action: "binary", method: "download", build: "linux-arm64", boot: o },
    ),
    row(
      "none — no build for the device's arch",
      [D.platform("linux", "armv7")],
      { action: "none", reason: "no-build", boot: n },
    ),
    row(
      "binary — a prerelease target on beta",
      [D.feedRecord(matrixFeedBeta, "R16b"), D.installed("1.5.0")],
      {
        action: "binary",
        method: "download",
        build: "macos-dmg",
        release: "1.6.0-beta.2",
        boot: o,
      },
    ),
    row(
      "none — an installed version that does not parse",
      [D.installed("1.5")],
      { action: "none", reason: "unknown-version", boot: n },
    ),
    row(
      "store — iOS web distribution opens its page, never installs itself or loads code",
      [D.platform("ios", "arm64"), D.outlet("direct")],
      { action: "store", release: "1.5.0", listingUrl: null, boot: o },
    ),
    row(
      "none — a rollout with no bucket is out",
      [D.rollout(7000), D.bucket(null)],
      { action: "none", reason: "out-of-bucket", boot: n },
    ),
    row(
      "binary — a store-only build is never installed",
      [D.platform("android", "arm64"), D.outlet("direct")],
      { action: "binary", method: "download", build: "apk", boot: o },
    ),
    row(
      "binary — a build with no payload file is never installed",
      [W, D.methods("download")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "store — an AltStore beta source reads its own entry",
      [
        D.platform("ios"),
        D.outlet("altstore-beta", "altstore"),
        D.installed("1.3.0"),
      ],
      { action: "store", release: "1.4.0", listingUrl: null, boot: o },
    ),
    row(
      "none — two entries of the detected kind, and no id to choose",
      [D.platform("ios"), D.outlet(null, "altstore"), D.installed("1.3.0")],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "store — the one entry of the detected kind",
      [D.platform("ios"), D.outlet(null, "app-store"), D.installed("1.3.0")],
      { action: "store", release: "1.4.0", boot: o },
    ),
    row(
      "binary — `semver+build`: a higher build number is newer",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0+45")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — `semver+build`: the same build is up to date",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0+46")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "binary — `semver+build`: no build metadata is older",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "binary — `4part`: parts compare numerically",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.4.9.9")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — `4part`: 1.10 is newer than 1.5, so the device is behind",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.10.0.0")],
      { action: "none", reason: "behind", boot: n },
    ),
    row(
      "none — `4part`: a three-part version does not parse",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.5.0")],
      { action: "none", reason: "unknown-version", boot: n },
    ),
    row(
      "none — `seq` values compare exactly at 2^53 − 1",
      [
        (i) => {
          const t = i.feed.app.targets[0];
          t.release = pinOf("R15max");
          t.outlets.direct.live = LIVE("1.5.0", MAX_WIRE_INTEGER_REF - 1);
          i.record = structuredClone(record("R15max").doc);
        },
      ],
      { action: "none", reason: "not-available", boot: n },
    ),
  ];
}

function buildUpdateMatrixV1(): unknown {
  const fail = (m: string): never => {
    throw new Error(`update-matrix: ${m}`);
  };
  const vocabulary = {
    // plans/P4-13.md §2.6: P3-01's reserved values, added together with the constants.
    actions: [
      "none",
      "code-ready",
      "binary",
      "store",
      "platform",
      "blocked",
      "packs",
    ],
    noneReasons: [
      "up-to-date",
      "behind",
      "not-available",
      "halted",
      "out-of-bucket",
      "stale",
      "skipped",
      "no-method",
      "no-build",
      "unknown-version",
    ],
    blockedReasons: ["app-floor", "content-floor", "revoked-content"],
    methods: ["native", "download", "sidecar-pck"],
    boot: ["none", "optional", "required"],
    schemes: [...REF_SCHEMES],
  };
  const versionSpec: [string, string, string, number | null, string][] = [
    ["semver", "1.2.3", "1.2.4", -1, "patch"],
    ["semver", "1.10.0", "1.9.0", 1, "numeric, not text"],
    ["semver", "1.0.0-alpha", "1.0.0", -1, "a prerelease is lower"],
    [
      "semver",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      -1,
      "numeric below non-numeric",
    ],
    [
      "semver",
      "1.0.0-9",
      "1.0.0-10a",
      -1,
      "the same, where text order would say otherwise",
    ],
    [
      "semver",
      "1.0.0-alpha.10",
      "1.0.0-alpha.9",
      1,
      "numeric prerelease identifiers",
    ],
    ["semver", "1.2.3+45", "1.2.3+9", 0, "build metadata ignored"],
    [
      "semver",
      "99999999999999999999.0.0",
      "99999999999999999998.0.0",
      1,
      "exact beyond 2^53",
    ],
    ["semver", "01.2.3", "1.2.3", null, "a leading zero does not parse"],
    ["semver", "1.2", "1.2.0", null, "two parts do not parse"],
    [
      "semver+build",
      "1.2.3+45",
      "1.2.3+9",
      1,
      "numeric build metadata breaks the tie",
    ],
    ["semver+build", "1.2.3", "1.2.3+0", -1, "no metadata is lower"],
    [
      "semver+build",
      "1.2.3+build.5",
      "1.2.3",
      0,
      "non-numeric metadata counts as none",
    ],
    ["semver+build", "1.2.4", "1.2.3+99", 1, "SemVer first"],
    [
      "semver+build",
      "1.2.3-rc.1+50",
      "1.2.3+1",
      -1,
      "a prerelease stays lower",
    ],
    ["4part", "1.10.0.0", "1.9.0.0", 1, "numeric parts"],
    ["4part", "1.2.3.4", "1.2.3.4", 0, "equal"],
    ["4part", "1.2.3", "1.2.3.0", null, "three parts do not parse"],
    ["4part", "1.02.3.4", "1.2.3.4", null, "a leading zero does not parse"],
    ["4part", "1.2.3.4-beta", "1.2.3.4", null, "no prerelease in 4part"],
    [
      "semver",
      "1.0.0-a..b",
      "1.0.0-a.0.b",
      null,
      "an empty prerelease identifier does not parse",
    ],
    [
      "semver",
      "1.0.0-01",
      "1.0.0-1",
      null,
      "a numeric prerelease identifier with a leading zero does not parse",
    ],
    [
      "semver+build",
      "1.2.3+",
      "1.2.3",
      null,
      "empty build metadata does not parse",
    ],
    [
      "semver",
      "1.2.3\n",
      "1.2.3",
      null,
      "a trailing U+000A does not parse (whole-string match)",
    ],
    ["4part", "1.2.3.4\n", "1.2.3.4", null, "the same under 4part"],
  ];
  const versionCases = versionSpec.map(([scheme, a, b, expect, name], k) => {
    const got = refCompareVersions(scheme, a, b);
    if (got !== expect)
      fail(`version case ${k + 1} computes ${got}, the plan says ${expect}`);
    return { name: `${k + 1}. ${name}`, scheme, a, b, expect };
  });
  for (const k of [23, 24]) {
    const c = versionCases[k]!;
    if (refParseVersion(c.scheme, c.a.replace(/\n$/, "")) === null)
      fail(`version case ${k + 1} without the terminator must parse`);
  }

  const everything = {
    binaryUpdates: "self",
    codeUpdates: true,
    dataUpdates: true,
    channelSwitch: true,
    commerce: "own",
    downloadedScripts: true,
  };
  const capSpec: [
    string,
    string,
    string,
    string | null,
    Record<string, unknown>,
    Partial<RefCaps>,
  ][] = [
    ["direct defaults", "direct", "macos", null, {}, {}],
    [
      "the server narrows codeUpdates",
      "direct",
      "macos",
      null,
      { codeUpdates: false },
      { codeUpdates: false },
    ],
    [
      "the server cannot widen app-store to self",
      "app-store",
      "macos",
      null,
      { binaryUpdates: "self" },
      {},
    ],
    [
      "the server narrows self to none",
      "direct",
      "macos",
      null,
      { binaryUpdates: "none" },
      { binaryUpdates: "none" },
    ],
    [
      "the server sets commerce: none, which applies",
      "direct",
      "macos",
      null,
      { commerce: "none" },
      { commerce: "none" },
    ],
    [
      "the server sets commerce: store-iap on direct, which is ignored",
      "direct",
      "macos",
      null,
      { commerce: "store-iap" },
      {},
    ],
    [
      "subkind homebrew on direct",
      "direct",
      "macos",
      "homebrew",
      {},
      { binaryUpdates: "none", codeUpdates: false },
    ],
    [
      "unknown stays restrictive under a server that allows everything",
      "unknown",
      "macos",
      null,
      everything,
      {},
    ],
    [
      "a server true over a false default (web codeUpdates) is ignored",
      "web",
      "web",
      null,
      { codeUpdates: true },
      {},
    ],
    [
      "direct on ios: store, no code, no downloaded scripts",
      "direct",
      "ios",
      null,
      everything,
      { binaryUpdates: "store", codeUpdates: false, downloadedScripts: false },
    ],
  ];
  const capabilityCases = capSpec.map(
    ([name, kind, platform, subkind, server, delta], k) => {
      const { platforms: _p, ...defaults } = REF_KIND_TABLE[kind]!;
      const expect = { ...defaults, ...delta };
      const got = refEffectiveCapabilities(kind, { platform, subkind, server });
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`capability case ${k + 1}: ${JSON.stringify(got)}`);
      return {
        name: `${k + 1}. ${name}`,
        kind,
        platform,
        subkind,
        server,
        expect,
      };
    },
  );

  const outletSpec: [
    string,
    unknown,
    Record<string, unknown> | null,
    Record<string, unknown> | null,
    [string | null, string, string | null],
  ][] = [
    [
      "the host wins",
      { id: "altstore-beta", kind: "altstore" },
      { outlet: "direct", outletKind: "direct" },
      null,
      ["altstore-beta", "altstore", null],
    ],
    [
      "a bare kind is its own id",
      "steam",
      null,
      null,
      ["steam", "steam", null],
    ],
    [
      "the stamp's id and kind",
      null,
      { outlet: "direct", outletKind: "direct" },
      null,
      ["direct", "direct", null],
    ],
    [
      "a product outlet id of a kind",
      null,
      { outlet: "itch-beta", outletKind: "itch" },
      null,
      ["itch-beta", "itch", null],
    ],
    [
      "no outletKind, so the id is the kind",
      null,
      { outlet: "steam" },
      null,
      ["steam", "steam", null],
    ],
    [
      "a kind outside the 17",
      null,
      { outlet: "epic-store", outletKind: "epic" },
      null,
      [null, "unknown", null],
    ],
    ["nothing configured", null, null, null, [null, "unknown", null]],
    [
      "the stamp's subkind",
      null,
      { outlet: "direct", outletKind: "direct", outletSubkind: "flatpak" },
      null,
      ["direct", "direct", "flatpak"],
    ],
    [
      "detection moved the kind",
      null,
      { outlet: "direct", outletKind: "direct" },
      {
        kind: "steam",
        confidence: "declared",
        source: "steam.libraryManifest",
        subkind: null,
      },
      [null, "steam", null],
    ],
    [
      "detection confirmed the kind and added a subkind",
      null,
      { outlet: "direct", outletKind: "direct" },
      {
        kind: "direct",
        confidence: "heuristic",
        source: "macos.homebrewCask",
        subkind: "homebrew",
      },
      ["direct", "direct", "homebrew"],
    ],
    [
      "detection with no stamp",
      null,
      null,
      {
        kind: "app-store",
        confidence: "attested",
        source: "ios.appDistributor",
        subkind: null,
      },
      [null, "app-store", null],
    ],
    [
      "an id outside OUTLET_ID_PATTERN",
      null,
      { outlet: "Direct Build", outletKind: "direct" },
      null,
      [null, "direct", null],
    ],
  ];
  const outletCases = outletSpec.map(
    ([name, host, stamp, detected, [id, kind, subkind]], k) => {
      const expect = { id, kind, subkind };
      const got = refResolveUpdateOutlet({ host, stamp, detected });
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`outlet case ${k + 1}: ${JSON.stringify(got)}`);
      return { name: `${k + 1}. ${name}`, host, stamp, detected, expect };
    },
  );

  const bucketSpec: [string, string, string, string, number, number][] = [
    ["corpus device", ROLLOUT_SALT, "dev_7c1e2d", "36cae637", 919266871, 6871],
    [
      "top bit set",
      ROLLOUT_SALT,
      "device-fixture-01",
      "c654abc5",
      3327437765,
      7765,
    ],
    [
      "another salt",
      "0123456789abcdef0123456789abcdef",
      "dev_7c1e2d",
      "1cfbabd6",
      486255574,
      5574,
    ],
    [
      "top bit, small bucket",
      ROLLOUT_SALT,
      "dev_probe_1",
      "fd307c32",
      4247813170,
      3170,
    ],
    ["bucket 0", ROLLOUT_SALT, "dev_probe_9167", "8ee96360", 2397660000, 0],
    [
      "bucket 9999",
      ROLLOUT_SALT,
      "dev_probe_3276",
      "d456100f",
      3562409999,
      9999,
    ],
  ];
  const bucketVectors = bucketSpec.map(
    ([name, salt, installId, first4, u32, bucket]) => {
      const got = refBucket(salt, installId);
      if (got.first4 !== first4 || got.u32 !== u32 || got.bucket !== bucket)
        fail(`bucket vector ${name}: ${JSON.stringify(got)}`);
      return { name, salt, installId, sha256: got.sha256, first4, u32, bucket };
    },
  );

  const used = {
    actions: new Set<string>(),
    none: new Set<string>(),
    blocked: new Set<string>(),
    methods: new Set<string>(),
    schemes: new Set<string>(),
    classes: new Set<string>(),
  };
  const rows = updateRowsSpec().map((spec, k) => {
    const input = baseInput();
    for (const d of spec.deltas) d(input);
    const decision = refDecideUpdate(input);
    const boot = refBootDecision(decision);
    const where = `row ${k + 1} (${spec.name})`;
    const w = spec.want;
    if (decision.action !== w.action)
      fail(`${where}: ${decision.action} != ${w.action}`);
    for (const key of [
      "reason",
      "method",
      "build",
      "mandatory",
      "critical",
      "discardStaged",
      "listingUrl",
    ] as const)
      if (w[key] !== undefined && decision[key] !== w[key])
        fail(`${where}: ${key} ${String(decision[key])} != ${String(w[key])}`);
    if (
      w.release !== undefined &&
      (decision.release as Record<string, unknown>).version !== w.release
    )
      fail(`${where}: release`);
    if (boot !== w.boot) fail(`${where}: boot ${boot} != ${w.boot}`);
    if (boot === "required") fail(`${where}: no v4 row answers required`);
    // Every row's feed passes the feed claims, and its record the record claims and the pin.
    const feedText = JSON.stringify(input.feed);
    if (
      refFeedClaims(input.feed, ctxOf(feedText), {
        aud: AUD_V3,
        channel: input.feed.channel,
      }) !== null
    )
      fail(`${where}: its feed fails the claims`);
    if (input.record) {
      if (
        !refRecordClaims(
          input.record,
          ctxOf(JSON.stringify(input.record)),
          AUD_V3,
        )
      )
        fail(`${where}: its record fails the claims`);
      const target = input.feed.app.targets.find(
        (t: Record<string, any>) => t.platform === input.installed.platform,
      );
      if (target) {
        const named = [...RECORDS!.values()].find(
          (r) => r.sha256 === target.release.sha256,
        );
        if (
          !named ||
          JSON.stringify(named.doc) !== JSON.stringify(input.record)
        )
          fail(`${where}: the record is not the pin's`);
      }
    }
    used.actions.add(decision.action as string);
    if (decision.action === "none") used.none.add(decision.reason as string);
    if (decision.action === "blocked")
      used.blocked.add(decision.reason as string);
    if (decision.action === "binary")
      used.methods.add(decision.method as string);
    used.schemes.add(input.feed.app.versionScheme);
    used.classes.add(
      refEffectiveCapabilities(input.outlet.kind, {
        platform: input.installed.platform,
        subkind: input.subkind,
      }).binaryUpdates,
    );
    return {
      name: `${k + 1}. ${spec.name}`,
      input,
      expect: { decision, boot },
    };
  });
  if (rows.length !== 65) fail(`${rows.length} rows, not 65`);
  // plans/P4-13.md §4.3: the content rows, after `rows`.
  const content = buildContentRows(fail);
  const usedBoot = new Set<string>(content.used.boot);
  for (const r of rows) usedBoot.add((r.expect as { boot: string }).boot);
  for (const v of content.used.actions) used.actions.add(v);
  for (const v of content.used.blocked) used.blocked.add(v);
  // Every vocabulary value, `required` included (no longer exempt), is produced by a row.
  for (const [list, set] of [
    [vocabulary.actions, used.actions],
    [vocabulary.noneReasons, used.none],
    [vocabulary.blockedReasons, used.blocked],
    [vocabulary.methods, used.methods],
    [vocabulary.schemes, used.schemes],
    [vocabulary.boot, usedBoot],
    [REF_BINARY_ORDER, used.classes],
  ] as const)
    for (const v of list) if (!set.has(v)) fail(`${v} is produced by no row`);

  return {
    updateMatrixVersion: 1,
    description:
      "The update decision (plans/P3-01.md §2.8; WIRE-CONTRACT-V4 §11, client behaviour outside the wire contract). `versionCases` pin `compareVersions(scheme, a, b)` (null when either side does not parse); `capabilityCases` pin `effectiveCapabilities(kind, {platform, subkind, server})`; `outletCases` pin `resolveUpdateOutlet({host, stamp, detected})` (a host value that is invalid raises `invalid-options`, so none is listed); `bucketVectors` pin `rolloutBucket(salt, installId)`, the first four bytes of SHA-256(UTF-8(salt) ‖ UTF-8(installId)) read big-endian, mod 10000; each row's `input` is a complete `UpdateDecisionInput` with the decoded feed and record, and `expect` is the `decideUpdate` decision, compared by value, and its `bootDecision`. The generator recomputes every case and row with its own reference implementation. A runner also asserts its compiled tables against `outlet-matrix.json`.",
    vocabulary,
    versionCases,
    capabilityCases,
    outletCases,
    bucketVectors,
    rows,
    contentRows: content.rows,
  };
}

// ── §4.7 `outlet-matrix.json` ────────────────────────────────────────────────────────────────

/** The 25 signals in vocabulary order, with S-06's confidence and evidence (§4.7). */
const REF_SIGNALS: {
  signal: string;
  confidence: string | null;
  verified: string;
  note?: string;
}[] = [
  {
    signal: "ios.appDistributor",
    confidence: "attested",
    verified: "source",
    note: "the device run is unmeasured",
  },
  { signal: "ios.bundleIdRewrite", confidence: "declared", verified: "source" },
  {
    signal: "ios.provisioningProfile",
    confidence: "heuristic",
    verified: "unmeasured",
  },
  { signal: "macos.masReceipt", confidence: "attested", verified: "measured" },
  {
    signal: "macos.receiptSandbox",
    confidence: "attested",
    verified: "measured",
    note: "one app",
  },
  { signal: "macos.signingLeaf", confidence: "attested", verified: "measured" },
  {
    signal: "macos.homebrewCask",
    confidence: "heuristic",
    verified: "measured",
  },
  {
    signal: "macos.homebrewFormula",
    confidence: "heuristic",
    verified: "measured",
    note: "the realpath reading",
  },
  {
    signal: "windows.packageIdentity",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.signatureKind",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.appInstallerUri",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.externalLocation",
    confidence: "attested",
    verified: "source",
    note: "needs a device",
  },
  {
    signal: "windows.pathConvention",
    confidence: "heuristic",
    verified: "unmeasured",
  },
  {
    signal: "linux.flatpakInfo",
    confidence: "attested",
    verified: "measured",
    note: "a foreign Flatpak too",
  },
  {
    signal: "linux.snapEnv",
    confidence: "declared",
    verified: "emulated",
    note: "and source",
  },
  { signal: "linux.appImageEnv", confidence: "declared", verified: "emulated" },
  {
    signal: "steam.libraryManifest",
    confidence: "declared",
    verified: "measured",
    note: "macOS only",
  },
  {
    signal: "steam.appIdEnv",
    confidence: "heuristic",
    verified: "measured",
    note: "macOS only",
  },
  {
    signal: "steam.appIdFile",
    confidence: null,
    verified: "measured",
    note: "refuted as a dev-mode signal",
  },
  {
    signal: "itch.receipt",
    confidence: "declared",
    verified: "emulated",
    note: "and source",
  },
  { signal: "itch.appEnv", confidence: null, verified: "source" },
  {
    signal: "android.installSource",
    confidence: "declared",
    verified: "measured",
    note: "every installer but Play; the digest read on one variant",
  },
  {
    signal: "android.installerMismatch",
    confidence: "declared",
    verified: "measured",
  },
  { signal: "web.displayMode", confidence: "heuristic", verified: "measured" },
  {
    signal: "node.packageManager",
    confidence: "heuristic",
    verified: "measured",
  },
];
const REF_VERIFIED = ["measured", "emulated", "source", "unmeasured"];
const MAC_STORE_LEAVES: Record<string, string> = {
  "Apple Mac OS Application Signing": "app-store",
  "TestFlight Beta Distribution": "testflight",
};
const REF_PLATFORM_DATA = {
  listingUrlPrefixes: REF_LISTING_PREFIXES,
  playStoreCertSha256s: [] as string[],
  altStorePalMarketplaceIds: [] as string[],
  playPackages: ["com.android.vending"],
  obtainiumPackages: ["dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"],
  fdroidClientPackages: [
    "org.fdroid.fdroid",
    "com.looker.droidify",
    "com.machiav3lli.fdroid",
  ],
  systemInstallerPackages: [
    "com.google.android.packageinstaller",
    "com.android.packageinstaller",
  ],
  macosStoreLeaves: MAC_STORE_LEAVES,
  deadlineMs: 2000,
};

interface Evidence {
  signal: string;
  confidence: string | null;
  names?: { kind: string; subkind: string | null };
  vetoes?: string[];
}

/** `detectOutlet({stamp, signals})` (plans/P3-01.md §2.9), the generator's reference. */
function refDetectOutlet(
  stamp: {
    outletKind: string;
    subkind: string | null;
    outletIds: Record<string, string>;
  } | null,
  signals: Record<string, any>,
): {
  kind: string;
  confidence: string | null;
  source: string | null;
  subkind: string | null;
} {
  const UNKNOWN = {
    kind: "unknown",
    confidence: null,
    source: null,
    subkind: null,
  };
  const ids = stamp?.outletIds ?? {};
  const has = (s: string): boolean => hasOwn(signals, s);
  const v = (s: string): any => signals[s];
  const identityHolds = (s: string): boolean => {
    switch (s) {
      case "ios.bundleIdRewrite":
        return v(s)?.altBundleIdentifier === ids.bundleId;
      case "macos.receiptSandbox":
        return v("macos.masReceipt") === true;
      case "macos.homebrewCask":
        return v(s) === ids.caskToken;
      case "macos.homebrewFormula":
        return v(s) === ids.homebrewFormula;
      case "windows.packageIdentity":
        return v(s) === ids.msixFamilyName;
      case "windows.signatureKind":
      case "windows.appInstallerUri":
      case "windows.externalLocation":
        return (
          has("windows.packageIdentity") &&
          v("windows.packageIdentity") === ids.msixFamilyName
        );
      case "linux.flatpakInfo":
        return v(s) === ids.flatpakId;
      case "linux.snapEnv":
        return v(s)?.name === ids.snapName;
      case "linux.appImageEnv":
        return (
          typeof v(s)?.exePath === "string" &&
          typeof v(s)?.appDir === "string" &&
          v(s).exePath.startsWith(v(s).appDir)
        );
      case "steam.libraryManifest":
        return v(s) === ids.steamAppId;
      case "steam.appIdEnv":
        return v(s)?.appId === ids.steamAppId;
      case "itch.receipt":
        return v(s) === ids.itchGameId;
      case "android.installSource":
        return v(s)?.installer === v(s)?.initiator;
      case "node.packageManager":
        return v(s)?.packageMatch === true;
      default:
        return true;
    }
  };
  // 1. Filter.
  const evidence: Evidence[] = [];
  for (const { signal, confidence } of REF_SIGNALS) {
    if (!has(signal) || confidence === null || !identityHolds(signal)) continue;
    const value = v(signal);
    const e: Evidence = { signal, confidence };
    const name = (kind: string, subkind: string | null = null): void =>
      void (e.names = { kind, subkind });
    switch (signal) {
      case "ios.appDistributor":
        if (value === "appStore") name("app-store");
        else if (value === "testFlight") name("testflight");
        else if (value === "web") name("direct");
        else if (
          typeof value === "string" &&
          value.startsWith("marketplace:")
        ) {
          if (
            REF_PLATFORM_DATA.altStorePalMarketplaceIds.includes(
              value.slice(12),
            )
          )
            name("altstore-pal");
          else e.vetoes = ["app-store", "testflight"];
        }
        break;
      case "ios.bundleIdRewrite":
        name("altstore");
        break;
      case "ios.provisioningProfile":
        if (value === true) e.vetoes = ["app-store"];
        break;
      case "macos.masReceipt":
        if (value === true)
          name(v("macos.receiptSandbox") === true ? "testflight" : "app-store");
        break;
      case "macos.signingLeaf":
        if (hasOwn(MAC_STORE_LEAVES, value)) name(MAC_STORE_LEAVES[value]!);
        else e.vetoes = ["app-store", "testflight"];
        break;
      case "macos.homebrewCask":
      case "macos.homebrewFormula":
        name("direct", "homebrew");
        break;
      case "windows.signatureKind":
        if (value === "Store") name("ms-store");
        else if (value === "Developer" || value === "Enterprise")
          e.vetoes = ["ms-store"];
        break;
      case "windows.appInstallerUri":
        if (value !== null) name("app-installer");
        break;
      case "windows.pathConvention":
        if (value === "winget") name("winget");
        else if (value === "scoop" || value === "chocolatey")
          name("direct", value);
        break;
      case "linux.flatpakInfo":
        if (stamp?.outletKind === "direct" && stamp.subkind === "flatpak")
          name("direct", "flatpak");
        else name("flathub");
        break;
      case "linux.snapEnv":
        if (
          typeof value.revision === "string" &&
          value.revision.startsWith("x")
        )
          e.vetoes = ["snap"];
        else name("snap");
        break;
      case "linux.appImageEnv":
        name("direct", "appimage");
        break;
      case "steam.libraryManifest":
      case "steam.appIdEnv":
        name("steam");
        break;
      case "itch.receipt":
        name("itch");
        break;
      case "android.installSource": {
        const installer = value.installer as string | null;
        if (
          installer !== null &&
          REF_PLATFORM_DATA.playPackages.includes(installer)
        ) {
          name("play");
          if (
            REF_PLATFORM_DATA.playStoreCertSha256s.includes(
              value.initiatorCertSha256,
            )
          )
            e.confidence = "attested";
        } else if (
          installer !== null &&
          REF_PLATFORM_DATA.obtainiumPackages.includes(installer)
        )
          name("obtainium");
        else if (
          installer !== null &&
          REF_PLATFORM_DATA.fdroidClientPackages.includes(installer)
        )
          name("fdroid-repo");
        else if (
          installer === null ||
          installer === "com.android.shell" ||
          REF_PLATFORM_DATA.systemInstallerPackages.includes(installer)
        )
          name("direct");
        break;
      }
      case "android.installerMismatch":
        if (value === true) e.vetoes = ["play", "play-testing"];
        break;
      case "web.displayMode":
        name("web");
        break;
      case "node.packageManager":
        name("direct", value.manager);
        break;
      default:
        break;
    }
    evidence.push(e);
  }
  const vetoed = (kind: string): boolean =>
    evidence.some((e) => e.vetoes?.includes(kind));
  // 2. Attested naming.
  const attested = evidence.filter(
    (e) => e.confidence === "attested" && e.names,
  );
  if (attested.length > 0) {
    const kinds = new Set(attested.map((e) => e.names!.kind));
    if (kinds.size > 1) return UNKNOWN;
    const first = attested[0]!;
    if (vetoed(first.names!.kind)) return UNKNOWN;
    return {
      kind: first.names!.kind,
      confidence: "attested",
      source: first.signal,
      subkind: first.names!.subkind,
    };
  }
  // 3. The stamp.
  if (!stamp) return UNKNOWN;
  const cur = {
    kind: stamp.outletKind,
    confidence: "stamp",
    source: "stamp",
    subkind: stamp.subkind,
  };
  // 4. Vetoes.
  if (vetoed(cur.kind)) return UNKNOWN;
  // 5. Restricting signals.
  const width = (kind: string, subkind: string | null): number =>
    REF_BINARY_ORDER.indexOf(
      refNarrow(
        refEffectiveCapabilities(kind, { platform: "" }),
        subkind ? REF_SUBKIND_NARROWING[subkind] : undefined,
      ).binaryUpdates,
    );
  for (const conf of ["declared", "heuristic"])
    for (const e of evidence) {
      if (e.confidence !== conf || !e.names) continue;
      if (width(e.names.kind, e.names.subkind) > width(cur.kind, cur.subkind))
        continue;
      const subkind =
        e.names.subkind ?? (e.names.kind === cur.kind ? cur.subkind : null);
      return {
        kind: e.names.kind,
        confidence: conf,
        source: e.signal,
        subkind,
      };
    }
  return cur;
}

function buildOutletMatrixV1(): unknown {
  const fail = (m: string): never => {
    throw new Error(`outlet-matrix: ${m}`);
  };
  const IDS = {
    steamAppId: "3166810",
    itchGameId: "1001",
    flatpakId: "gg.vlad.Diceroll",
    snapName: "diceroll",
    caskToken: "diceroll",
    homebrewFormula: "diceroll",
    msixFamilyName: "Diceroll_abc123",
    bundleId: "gg.vlad.diceroll",
  };
  const st = (outletKind: string, subkind: string | null = null) => ({
    outletKind,
    subkind,
    outletIds: IDS,
  });
  const and = (
    installer: string | null,
    initiator: string | null,
  ): Record<string, unknown> => ({
    "android.installSource": {
      installer,
      initiator,
      initiatorCertSha256: "0".repeat(64),
    },
    "android.installerMismatch": installer !== initiator,
  });
  const appImage = {
    "linux.appImageEnv": {
      appImage: "/home/a/Diceroll.AppImage",
      appDir: "/tmp/.mount_DicerX1",
      exePath: "/tmp/.mount_DicerX1/usr/bin/diceroll",
    },
  };
  const ID = "Diceroll_abc123";
  type Exp = [string, string | null, string | null, string | null];
  const U: Exp = ["unknown", null, null, null];
  const spec: [
    string,
    ReturnType<typeof st> | null,
    Record<string, unknown>,
    Exp,
  ][] = [
    [
      "stamp only — direct",
      st("direct"),
      {},
      ["direct", "stamp", "stamp", null],
    ],
    ["stamp only — steam", st("steam"), {}, ["steam", "stamp", "stamp", null]],
    ["no stamp and no evidence", null, {}, U],
    [
      "no stamp: a heuristic never selects",
      null,
      { "steam.appIdEnv": { appId: "3166810", clientLaunch: true } },
      U,
    ],
    [
      "the macOS receipt overrides a direct stamp",
      st("direct"),
      {
        "macos.masReceipt": true,
        "macos.signingLeaf": "Apple Mac OS Application Signing",
      },
      ["app-store", "attested", "macos.masReceipt", null],
    ],
    [
      "the macOS TestFlight receipt",
      null,
      {
        "macos.masReceipt": true,
        "macos.receiptSandbox": true,
        "macos.signingLeaf": "TestFlight Beta Distribution",
      },
      ["testflight", "attested", "macos.masReceipt", null],
    ],
    [
      "a store leaf that disagrees with the receipt",
      st("direct"),
      {
        "macos.masReceipt": true,
        "macos.signingLeaf": "TestFlight Beta Distribution",
      },
      U,
    ],
    [
      "a Developer ID leaf vetoes an app-store stamp",
      st("app-store"),
      { "macos.signingLeaf": "Developer ID Application" },
      U,
    ],
    [
      "a Developer ID leaf leaves a steam stamp",
      st("steam"),
      { "macos.signingLeaf": "Developer ID Application" },
      ["steam", "stamp", "stamp", null],
    ],
    [
      "no leaf vetoes a testflight stamp",
      st("testflight"),
      { "macos.signingLeaf": "none" },
      U,
    ],
    [
      "a Homebrew cask restricts a direct stamp",
      st("direct"),
      { "macos.homebrewCask": "diceroll" },
      ["direct", "heuristic", "macos.homebrewCask", "homebrew"],
    ],
    [
      "a cask with another token does not count",
      st("direct"),
      { "macos.homebrewCask": "other" },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "the Steam library moves a direct stamp to steam",
      st("direct"),
      { "steam.libraryManifest": "3166810" },
      ["steam", "declared", "steam.libraryManifest", null],
    ],
    [
      "the Steam environment with this app id",
      st("direct"),
      { "steam.appIdEnv": { appId: "3166810", clientLaunch: true } },
      ["steam", "heuristic", "steam.appIdEnv", null],
    ],
    [
      "the Steam environment with another app id",
      st("direct"),
      { "steam.appIdEnv": { appId: "480", clientLaunch: true } },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "`steam_appid.txt` is diagnostic only",
      st("direct"),
      { "steam.appIdFile": "3166810" },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "a heuristic never widens: AppImage on a steam stamp",
      st("steam"),
      appImage,
      ["steam", "stamp", "stamp", null],
    ],
    [
      "the itch receipt moves a direct stamp to itch",
      st("direct"),
      { "itch.receipt": "1001" },
      ["itch", "declared", "itch.receipt", null],
    ],
    [
      "`ITCHIO_APP` is diagnostic only",
      st("direct"),
      { "itch.appEnv": true },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "Flatpak info with this id overrides a direct stamp",
      st("direct"),
      { "linux.flatpakInfo": "gg.vlad.Diceroll" },
      ["flathub", "attested", "linux.flatpakInfo", null],
    ],
    [
      "Flatpak info keeps a direct + flatpak stamp",
      st("direct", "flatpak"),
      { "linux.flatpakInfo": "gg.vlad.Diceroll" },
      ["direct", "attested", "linux.flatpakInfo", "flatpak"],
    ],
    [
      "a foreign Flatpak is no Flathub evidence",
      st("steam"),
      {
        "linux.flatpakInfo": "com.valvesoftware.Steam",
        "steam.libraryManifest": "3166810",
      },
      ["steam", "declared", "steam.libraryManifest", null],
    ],
    [
      "the snap name restricts a direct stamp",
      st("direct"),
      { "linux.snapEnv": { name: "diceroll", revision: "42" } },
      ["snap", "declared", "linux.snapEnv", null],
    ],
    [
      "a local snap revision vetoes a snap stamp",
      st("snap"),
      { "linux.snapEnv": { name: "diceroll", revision: "x1" } },
      U,
    ],
    [
      "AppImage with APPDIR around the executable",
      st("direct"),
      appImage,
      ["direct", "declared", "linux.appImageEnv", "appimage"],
    ],
    [
      "Android Play, no recorded digest: declared",
      st("direct"),
      and("com.android.vending", "com.android.vending"),
      ["play", "declared", "android.installSource", null],
    ],
    [
      "Android: the shell claiming Play vetoes a play stamp",
      st("play"),
      and("com.android.vending", "com.android.shell"),
      U,
    ],
    [
      "Android: Obtainium",
      st("direct"),
      and("dev.imranr.obtainium", "dev.imranr.obtainium"),
      ["obtainium", "declared", "android.installSource", null],
    ],
    [
      "Android: the F-Droid client",
      st("direct"),
      and("org.fdroid.fdroid", "org.fdroid.fdroid"),
      ["fdroid-repo", "declared", "android.installSource", null],
    ],
    [
      "Android: a browser download confirms direct",
      st("direct"),
      and(
        "com.google.android.packageinstaller",
        "com.google.android.packageinstaller",
      ),
      ["direct", "declared", "android.installSource", null],
    ],
    [
      "iOS: App Store overrides a direct stamp",
      st("direct"),
      { "ios.appDistributor": "appStore" },
      ["app-store", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: TestFlight with no stamp",
      null,
      { "ios.appDistributor": "testFlight" },
      ["testflight", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: a timeout is no evidence",
      st("app-store"),
      { "ios.appDistributor": "timeout" },
      ["app-store", "stamp", "stamp", null],
    ],
    [
      "iOS: web distribution is direct",
      null,
      { "ios.appDistributor": "web" },
      ["direct", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: an AltStore rewrite moves an app-store stamp",
      st("app-store"),
      {
        "ios.bundleIdRewrite": {
          runtimeBundleId: "gg.vlad.diceroll.ABCDE12345",
          altBundleIdentifier: "gg.vlad.diceroll",
        },
      },
      ["altstore", "declared", "ios.bundleIdRewrite", null],
    ],
    [
      "iOS: a provisioning profile vetoes an app-store stamp",
      st("app-store"),
      { "ios.provisioningProfile": true },
      U,
    ],
    [
      "iOS: a marketplace other than AltStore PAL",
      st("app-store"),
      { "ios.appDistributor": "marketplace:com.example" },
      U,
    ],
    [
      "Windows: Store signature with this family name",
      st("direct"),
      { "windows.packageIdentity": ID, "windows.signatureKind": "Store" },
      ["ms-store", "attested", "windows.signatureKind", null],
    ],
    [
      "Windows: an inherited identity is ignored",
      st("steam"),
      {
        "windows.packageIdentity": "Other_xyz",
        "windows.signatureKind": "Store",
      },
      ["steam", "stamp", "stamp", null],
    ],
    [
      "Windows: an App Installer URI",
      st("direct"),
      {
        "windows.packageIdentity": ID,
        "windows.signatureKind": "Developer",
        "windows.appInstallerUri": "https://dl.example/diceroll.appinstaller",
      },
      ["app-installer", "attested", "windows.appInstallerUri", null],
    ],
    [
      "Windows: a Developer signature vetoes an ms-store stamp",
      st("ms-store"),
      { "windows.packageIdentity": ID, "windows.signatureKind": "Developer" },
      U,
    ],
    [
      "Windows: a sparse package keeps the stamp",
      st("direct"),
      {
        "windows.packageIdentity": ID,
        "windows.signatureKind": "Developer",
        "windows.externalLocation": "C:\\Games\\Diceroll",
      },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "Windows: a WinGet path restricts direct to winget",
      st("direct"),
      { "windows.pathConvention": "winget" },
      ["winget", "heuristic", "windows.pathConvention", null],
    ],
    [
      "Windows: a Scoop path",
      st("direct"),
      { "windows.pathConvention": "scoop" },
      ["direct", "heuristic", "windows.pathConvention", "scoop"],
    ],
    [
      "Node: npx",
      st("direct"),
      { "node.packageManager": { manager: "npx", packageMatch: true } },
      ["direct", "heuristic", "node.packageManager", "npx"],
    ],
    [
      "web: display mode confirms the web stamp",
      st("web"),
      { "web.displayMode": "standalone" },
      ["web", "heuristic", "web.displayMode", null],
    ],
    [
      "a Homebrew formula restricts a direct stamp",
      st("direct"),
      { "macos.homebrewFormula": "diceroll" },
      ["direct", "heuristic", "macos.homebrewFormula", "homebrew"],
    ],
    [
      "Android: an installer mismatch leaves a direct stamp",
      st("direct"),
      and("com.android.vending", "com.android.shell"),
      ["direct", "stamp", "stamp", null],
    ],
  ];
  const seen = new Set<string>();
  const rows = spec.map(
    ([name, stamp, signals, [kind, confidence, source, subkind]], k) => {
      const expect = { kind, confidence, source, subkind };
      const got = refDetectOutlet(stamp, signals);
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`row ${k + 1} (${name}) computes ${JSON.stringify(got)}`);
      for (const s of Object.keys(signals)) seen.add(s);
      return { name: `${k + 1}. ${name}`, stamp, signals, expect };
    },
  );
  if (rows.length !== 48) fail(`${rows.length} rows, not 48`);
  for (const { signal } of REF_SIGNALS)
    if (!seen.has(signal)) fail(`${signal} is in no row`);
  const kinds: Record<string, unknown> = {};
  for (const k of [...REF_OUTLET_KINDS, "unknown"]) {
    const row = REF_KIND_TABLE[k];
    if (!row) fail(`no kind row for ${k}`);
    for (const p of row!.platforms)
      if (!REF_RELEASE_PLATFORMS.includes(p)) fail(`${k}: platform ${p}`);
    kinds[k] = row;
  }
  for (const [k, prefixes] of Object.entries(REF_LISTING_PREFIXES)) {
    if (REF_KIND_TABLE[k]?.binaryUpdates !== "store")
      fail(`listing prefixes on a non-store kind ${k}`);
    for (const p of prefixes)
      if (p.startsWith("https://") && !/^https:\/\/[^/]+\//.test(p))
        fail(`${p} has no / after its host`);
  }
  for (const s of REF_SIGNALS)
    if (!REF_VERIFIED.includes(s.verified)) fail(`${s.signal}: verified`);
  const counts = REF_VERIFIED.map(
    (x) => REF_SIGNALS.filter((s) => s.verified === x).length,
  ).join(",");
  if (counts !== "13,3,7,2") fail(`evidence counts ${counts}`);
  return {
    outletMatrixVersion: 1,
    description:
      "Outlet kinds, capabilities and detection (plans/P3-01.md §2.9; WIRE-CONTRACT-V4 §11, client behaviour outside the wire contract). `kinds` is the capability default and platform list per kind (and `unknown`); `platformNarrowing` and `subkinds` narrow it, booleans by AND, `binaryUpdates` to the narrower of none < store < self, and `commerce` only to `none`. `signals` lists the 25 detection signals in vocabulary order with their confidence (null for a diagnostic signal) and evidence (`verified`; no SDK branches on it). Each row runs `detectOutlet({stamp, signals})` and expects `{kind, confidence, source, subkind}`; the generator recomputes every row with its own reference. A runner asserts its compiled tables against `kinds`, `platformNarrowing`, `subkinds` and `platformData.listingUrlPrefixes`.",
    kinds,
    platformNarrowing: REF_PLATFORM_NARROWING,
    subkinds: REF_SUBKIND_NARROWING,
    vocabulary: {
      kinds: [...REF_OUTLET_KINDS],
      confidence: REF_CONFIDENCES,
      signals: REF_SIGNALS.map((s) => s.signal),
      subkinds: REF_SUBKINDS,
      verified: REF_VERIFIED,
    },
    signals: REF_SIGNALS,
    platformData: REF_PLATFORM_DATA,
    rows,
  };
}

// ── §4.8 the stage matrix, version 2: boot confirmation ─────────────────────────────────────

const STAGE_BOOT_OK_SECONDS = 10;
const STAGE_CONFIRMATIONS = ["now", "after-ok-seconds", "never"];
const STAGE_CONFIRM_CASES = [
  { outcome: "running", expect: "never" },
  { outcome: "waiting", expect: "now" },
  { outcome: "ready", expect: "after-ok-seconds" },
  { outcome: "blocked", expect: "now" },
  { outcome: "offline", expect: "now" },
  { outcome: "error", expect: "never" },
];

// ── plans/P4-01.md §4.6: packs on the wire — `packRecordCases` and `markerCases` (P4-21) ─────
//
// Two new JWS families after `releaseRecordCases`, which the v4 record runners of P3-04 to P3-08
// never read. P4-21 signs them over the FIXED object-ref table below (§4.2): every `sha256` is
// the SHA-256 of the blob's name and every size is §4.3's figure, because the content set does
// not exist yet and no claim fetches an object, so every verdict holds. P4-04 then re-signs the
// valid records, their twins, the markers and the two rewritten P3-02 cases over the content
// set's real refs: their bytes change, never their ids or `expect`.

/** The generator's registry of the 83 claim checks (§4.6's table, and plans/P4-10.md §2.2's
 *  81–83). A check id outside it throws; the per-check self-check proves each has a case its
 *  check alone refuses. */
const PACK_CLAIM_CHECKS = [
  // kind: pack (1–55)
  "deliverable.not-app",
  "builds.absent",
  "type",
  "formatVersion",
  "handler",
  "handler.mountOrder",
  "handler.prefixes",
  "handler.prefixes.count",
  "handler.prefixes.item",
  "handler.prefixes.length",
  "handler.prefixes.unique",
  "handler.activation",
  "entitlement",
  "variants",
  "variants.count",
  "variants.item",
  "variants.key-unique",
  "variants.axes-same",
  "variant",
  "variant.count",
  "variant.axis",
  "variant.value",
  "payload",
  "payload.size",
  "payload.sha256",
  "full",
  "ref.sha256",
  "ref.bytes",
  "ref.size",
  "ref.codec",
  "ref.none-bytes",
  "files",
  "files.format",
  "files.layout",
  "files.gaps",
  "files.gaps-container",
  "files.gaps-tree",
  "deltas",
  "deltas.count",
  "deltas.item",
  "deltas.id-unique",
  "delta.method",
  "delta.scope",
  "delta.scope-tree",
  "delta.from",
  "delta.memBytes",
  "delta.artifact",
  "delta.artifact.sha256",
  "delta.artifact.bytes",
  "delta.patch",
  "delta.data",
  "delta.data.sha256",
  "delta.data.bytes",
  "requires",
  "requires.engine",
  // kind: app (56–80)
  "content",
  "content.contentApi",
  "content.pins",
  "content.pins.count",
  "content.pins.item",
  "content.pins.unique",
  "pin.pack",
  "pin.pack.not-app",
  "pin.release",
  "pin.release.sha256",
  "pin.release.seq",
  "pin.release.version",
  "content.expects",
  "content.expects.count",
  "content.expects.item",
  "content.expects.unique",
  "expect.pack",
  "expect.pack.not-app",
  "expect.required",
  "expect.delivery",
  "embeds",
  "embeds.count",
  "embeds.item",
  "embeds.not-app",
  "embeds.unique",
  // kind: pack, plans/P4-10.md §2.2 (81–83): `chunks` absent or an object, its `format`, its
  // `params` absent or an object (the object ref stands on checks 27–31).
  "chunks",
  "chunks.format",
  "chunks.params",
] as const;
type PackCheck = (typeof PACK_CLAIM_CHECKS)[number];
const PACK_CHECK_SET: ReadonlySet<string> = new Set(PACK_CLAIM_CHECKS);

/** A registered check is on unless `check:<id>` is switched off. Switching a check off skips
 *  that member and everything under it. */
function on(ctx: ClaimCtx, id: PackCheck): boolean {
  if (!PACK_CHECK_SET.has(id)) throw new Error(`unregistered pack check ${id}`);
  return !ctx.off.has(`check:${id}`);
}

// §2.3's patterns, restated as literals (the generator imports nothing it checks).
const REF_PACK_TYPE_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;
const REF_VOCAB_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REF_OBJECT_FORMAT_RE = /^[a-z][a-z0-9-]{0,31}\/[1-9][0-9]{0,8}$/;
const REF_HANDLER_PREFIX_RE = /^res:\/\/([A-Za-z0-9_][A-Za-z0-9 ._@+-]*\/)+$/;
const REF_ENTITLEMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REF_AXIS_RE = /^[a-z][a-z0-9-]{0,15}$/;
const REF_AXIS_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;
const REF_ENGINE_RE = /^godot-[0-9]+\.[0-9]+$/;

/** A pack id: `DELIVERABLE_ID_PATTERN`, at most 64 bytes (`not-app` is its own check). */
const refPackIdShape = (v: unknown): v is string =>
  typeof v === "string" &&
  utf8Bytes(v).length <= 64 &&
  REF_DELIVERABLE_RE.test(v);
const refHex64 = (v: unknown): boolean =>
  typeof v === "string" && REF_SHA256_RE.test(v);
/** "absent or …": a present `null` is refused (V4 §3.3 rule 3). */
const refVocab = (v: unknown): boolean =>
  typeof v === "string" && REF_VOCAB_RE.test(v);

/** The one object-ref check (checks 27–31), at every site. */
function refObjectRef(
  ctx: ClaimCtx,
  v: Record<string, unknown>,
  at: string,
): boolean {
  if (on(ctx, "ref.sha256") && !refHex64(v.sha256)) return false;
  if (on(ctx, "ref.bytes")) {
    if (typeof v.bytes !== "number") return false;
    if (!refInt(ctx, "pack", v.bytes, `${at}/bytes`)) return false;
  }
  if (on(ctx, "ref.size")) {
    if (typeof v.size !== "number") return false;
    if (!refInt(ctx, "pack", v.size, `${at}/size`)) return false;
  }
  if (on(ctx, "ref.codec") && !refVocab(v.codec)) return false;
  if (on(ctx, "ref.none-bytes") && v.codec === "none" && v.bytes !== v.size)
    return false;
  return true;
}

/** A `{sha256, bytes}` member (a delta's `artifact` or `data`). */
function refHashBytes(
  ctx: ClaimCtx,
  v: Record<string, unknown>,
  at: string,
  sha: PackCheck,
  bytes: PackCheck,
): boolean {
  if (on(ctx, sha) && !refHex64(v.sha256)) return false;
  if (on(ctx, bytes)) {
    if (typeof v.bytes !== "number") return false;
    if (!refInt(ctx, "pack", v.bytes, `${at}/bytes`)) return false;
  }
  return true;
}

/** §2.3: the pack record's claims, after the common ones. */
function refPackClaims(doc: Record<string, unknown>, ctx: ClaimCtx): boolean {
  if (on(ctx, "deliverable.not-app") && doc.deliverable === "app") return false;
  if (on(ctx, "builds.absent") && hasOwn(doc, "builds")) return false;
  if (
    on(ctx, "type") &&
    !(typeof doc.type === "string" && REF_PACK_TYPE_RE.test(doc.type))
  )
    return false;
  if (on(ctx, "formatVersion")) {
    if (typeof doc.formatVersion !== "number") return false;
    if (!refInt(ctx, "pack", doc.formatVersion, "/formatVersion")) return false;
  }
  if (hasOwn(doc, "handler") && on(ctx, "handler")) {
    const h = doc.handler;
    if (!isObj(h)) return false;
    if (hasOwn(h, "mountOrder") && on(ctx, "handler.mountOrder")) {
      if (typeof h.mountOrder !== "number") return false;
      if (!refInt(ctx, "pack", h.mountOrder, "/handler/mountOrder"))
        return false;
    }
    if (hasOwn(h, "prefixes") && on(ctx, "handler.prefixes")) {
      const p = h.prefixes;
      if (!Array.isArray(p)) return false;
      if (on(ctx, "handler.prefixes.count") && (p.length < 1 || p.length > 32))
        return false;
      for (const x of p) {
        if (
          on(ctx, "handler.prefixes.item") &&
          !(typeof x === "string" && REF_HANDLER_PREFIX_RE.test(x))
        )
          return false;
        if (
          on(ctx, "handler.prefixes.length") &&
          typeof x === "string" &&
          utf8Bytes(x).length > 256
        )
          return false;
      }
      if (
        on(ctx, "handler.prefixes.unique") &&
        new Set(p.map((x) => JSON.stringify(x))).size !== p.length
      )
        return false;
    }
    if (
      hasOwn(h, "activation") &&
      on(ctx, "handler.activation") &&
      !refVocab(h.activation)
    )
      return false;
  }
  if (
    hasOwn(doc, "entitlement") &&
    on(ctx, "entitlement") &&
    !(
      typeof doc.entitlement === "string" &&
      REF_ENTITLEMENT_RE.test(doc.entitlement)
    )
  )
    return false;
  if (on(ctx, "variants")) {
    const vs = doc.variants;
    if (!Array.isArray(vs)) return false;
    if (on(ctx, "variants.count") && (vs.length < 1 || vs.length > 32))
      return false;
    const keys: string[] = [];
    const axisSets: string[] = [];
    for (const [i, v] of vs.entries()) {
      if (!on(ctx, "variants.item")) continue;
      if (!isObj(v)) return false;
      const sel = refVariantClaims(v, i, ctx);
      if (sel === false) return false;
      const names = Object.keys(sel).sort();
      keys.push(names.map((n) => `${n}=${String(sel[n])}`).join(";"));
      axisSets.push(JSON.stringify(names));
    }
    if (on(ctx, "variants.key-unique") && new Set(keys).size !== keys.length)
      return false;
    if (on(ctx, "variants.axes-same") && new Set(axisSets).size > 1)
      return false;
  }
  return true;
}

/** One variant's claims; its axis selection when they hold. */
function refVariantClaims(
  v: Record<string, unknown>,
  i: number,
  ctx: ClaimCtx,
): Record<string, unknown> | false {
  const at = `/variants/${i}`;
  let sel: Record<string, unknown> = {};
  if (on(ctx, "variant")) {
    if (!isObj(v.variant)) return false;
    sel = v.variant;
    const names = Object.keys(sel);
    if (on(ctx, "variant.count") && names.length > 4) return false;
    for (const n of names) {
      if (on(ctx, "variant.axis") && !REF_AXIS_RE.test(n)) return false;
      if (
        on(ctx, "variant.value") &&
        !(typeof sel[n] === "string" && REF_AXIS_VALUE_RE.test(sel[n]))
      )
        return false;
    }
  }
  if (on(ctx, "payload")) {
    const p = v.payload;
    if (!isObj(p)) return false;
    if (on(ctx, "payload.size")) {
      if (typeof p.size !== "number") return false;
      if (!refInt(ctx, "pack", p.size, `${at}/payload/size`)) return false;
    }
    if (on(ctx, "payload.sha256") && !refHex64(p.sha256)) return false;
  }
  if (on(ctx, "full")) {
    if (!isObj(v.full)) return false;
    if (!refObjectRef(ctx, v.full, `${at}/full`)) return false;
  }
  let layout: unknown = undefined;
  if (on(ctx, "files")) {
    const f = v.files;
    if (!isObj(f)) return false;
    layout = f.layout;
    if (
      on(ctx, "files.format") &&
      !(typeof f.format === "string" && REF_OBJECT_FORMAT_RE.test(f.format))
    )
      return false;
    if (on(ctx, "files.layout") && !refVocab(f.layout)) return false;
    if (!refObjectRef(ctx, f, `${at}/files`)) return false;
    if (hasOwn(f, "gaps") && on(ctx, "files.gaps")) {
      if (!isObj(f.gaps)) return false;
      if (!refObjectRef(ctx, f.gaps, `${at}/files/gaps`)) return false;
    }
    if (
      on(ctx, "files.gaps-container") &&
      f.layout === "container" &&
      !hasOwn(f, "gaps")
    )
      return false;
    if (on(ctx, "files.gaps-tree") && f.layout === "tree" && hasOwn(f, "gaps"))
      return false;
  }
  if (hasOwn(v, "deltas") && on(ctx, "deltas")) {
    const ds = v.deltas;
    if (!Array.isArray(ds)) return false;
    if (on(ctx, "deltas.count") && ds.length > 16) return false;
    const ids: string[] = [];
    for (const [j, d] of ds.entries()) {
      if (!on(ctx, "deltas.item")) continue;
      if (!isObj(d)) return false;
      const dt = `${at}/deltas/${j}`;
      if (on(ctx, "delta.method") && !refVocab(d.method)) return false;
      if (on(ctx, "delta.scope") && !refVocab(d.scope)) return false;
      if (
        on(ctx, "delta.scope-tree") &&
        d.scope === "payload" &&
        layout === "tree"
      )
        return false;
      if (on(ctx, "delta.from") && !refHex64(d.from)) return false;
      if (on(ctx, "delta.memBytes")) {
        if (typeof d.memBytes !== "number") return false;
        if (!refInt(ctx, "pack", d.memBytes, `${dt}/memBytes`)) return false;
      }
      if (d.scope === "payload" && on(ctx, "delta.artifact")) {
        if (!isObj(d.artifact)) return false;
        if (
          !refHashBytes(
            ctx,
            d.artifact,
            `${dt}/artifact`,
            "delta.artifact.sha256",
            "delta.artifact.bytes",
          )
        )
          return false;
        ids.push(String(d.artifact.sha256));
      }
      if (d.scope === "files") {
        if (on(ctx, "delta.patch")) {
          if (!isObj(d.patch)) return false;
          if (!refObjectRef(ctx, d.patch, `${dt}/patch`)) return false;
          ids.push(String(d.patch.sha256));
        }
        if (on(ctx, "delta.data")) {
          if (!isObj(d.data)) return false;
          if (
            !refHashBytes(
              ctx,
              d.data,
              `${dt}/data`,
              "delta.data.sha256",
              "delta.data.bytes",
            )
          )
            return false;
        }
      }
    }
    if (on(ctx, "deltas.id-unique") && new Set(ids).size !== ids.length)
      return false;
  }
  if (hasOwn(v, "requires") && on(ctx, "requires")) {
    const r = v.requires;
    if (!isObj(r)) return false;
    if (
      hasOwn(r, "engine") &&
      on(ctx, "requires.engine") &&
      !(typeof r.engine === "string" && REF_ENGINE_RE.test(r.engine))
    )
      return false;
  }
  // plans/P4-10.md §2.2: checks 81–83 and the object ref at `chunks`; other members ignored.
  if (hasOwn(v, "chunks") && on(ctx, "chunks")) {
    const c = v.chunks;
    if (!isObj(c)) return false;
    if (
      on(ctx, "chunks.format") &&
      !(typeof c.format === "string" && REF_OBJECT_FORMAT_RE.test(c.format))
    )
      return false;
    if (!refObjectRef(ctx, c, `${at}/chunks`)) return false;
    if (hasOwn(c, "params") && on(ctx, "chunks.params") && !isObj(c.params))
      return false;
  }
  return sel;
}

/** §2.4's `content` (checks 57–75), at `at` (`/content` in a record). */
function refContentClaims(c: unknown, ctx: ClaimCtx, at: string): boolean {
  if (!isObj(c)) return false;
  if (on(ctx, "content.contentApi")) {
    if (typeof c.contentApi !== "number") return false;
    if (!refInt(ctx, "content", c.contentApi, `${at}/contentApi`)) return false;
  }
  if (on(ctx, "content.pins")) {
    const pins = c.pins;
    if (!Array.isArray(pins)) return false;
    if (on(ctx, "content.pins.count") && pins.length > 256) return false;
    const packs: unknown[] = [];
    for (const [i, p] of pins.entries()) {
      if (!on(ctx, "content.pins.item")) continue;
      if (!isObj(p)) return false;
      packs.push(p.pack);
      if (on(ctx, "pin.pack") && !refPackIdShape(p.pack)) return false;
      if (on(ctx, "pin.pack.not-app") && p.pack === "app") return false;
      if (on(ctx, "pin.release")) {
        const r = p.release;
        if (!isObj(r)) return false;
        if (on(ctx, "pin.release.sha256") && !refHex64(r.sha256)) return false;
        if (on(ctx, "pin.release.seq")) {
          if (typeof r.seq !== "number") return false;
          if (!refInt(ctx, "content", r.seq, `${at}/pins/${i}/release/seq`))
            return false;
        }
        if (
          on(ctx, "pin.release.version") &&
          !(
            typeof r.version === "string" &&
            REF_RECORD_VERSION_RE.test(r.version)
          )
        )
          return false;
      }
    }
    if (
      on(ctx, "content.pins.unique") &&
      new Set(packs.map((x) => JSON.stringify(x))).size !== packs.length
    )
      return false;
  }
  if (on(ctx, "content.expects")) {
    const es = c.expects;
    if (!Array.isArray(es)) return false;
    if (on(ctx, "content.expects.count") && es.length > 256) return false;
    const packs: unknown[] = [];
    for (const e of es) {
      if (!on(ctx, "content.expects.item")) continue;
      if (!isObj(e)) return false;
      packs.push(e.pack);
      if (on(ctx, "expect.pack") && !refPackIdShape(e.pack)) return false;
      if (on(ctx, "expect.pack.not-app") && e.pack === "app") return false;
      if (on(ctx, "expect.required") && typeof e.required !== "boolean")
        return false;
      if (on(ctx, "expect.delivery") && !refVocab(e.delivery)) return false;
    }
    if (
      on(ctx, "content.expects.unique") &&
      new Set(packs.map((x) => JSON.stringify(x))).size !== packs.length
    )
      return false;
  }
  return true;
}

/** §2.4's `builds[].embeds` (checks 77–80). */
function refEmbedsClaims(e: unknown, ctx: ClaimCtx): boolean {
  if (!Array.isArray(e)) return false;
  if (on(ctx, "embeds.count") && e.length > 64) return false;
  for (const x of e) {
    if (on(ctx, "embeds.item") && !refPackIdShape(x)) return false;
    if (on(ctx, "embeds.not-app") && x === "app") return false;
  }
  if (
    on(ctx, "embeds.unique") &&
    new Set(e.map((x) => JSON.stringify(x))).size !== e.length
  )
    return false;
  return true;
}

/** The reference helpers the content generator borrows (it imports nothing it checks). */
const REF_JSON: RefJson = {
  parseStrict: (text) => refParseStrict(text),
  nonWire: (text) => refNonWire(text),
  // A stamp's members sit at its top level; re-rooted under `/content` so §2.5's minimum table
  // and `refContentClaims` apply unchanged.
  stampContentClaims: (text) => {
    const wrapped = `{"content":${text}}`;
    const parsed = refParseStrict(wrapped);
    if (!parsed.ok || !isObj(parsed.value)) return false;
    return refContentClaims(parsed.value.content, ctxOf(wrapped), "/content");
  },
  // plans/P4-13.md §2.4: the stamp's holds, re-rooted under `/content` like the claims.
  stampHolds: (text) => {
    const wrapped = `{"content":${text}}`;
    const parsed = refParseStrict(wrapped);
    if (!parsed.ok || !isObj(parsed.value)) return null;
    const c = parsed.value.content;
    if (!isObj(c)) return null;
    return refHoldsOf(c, ctxOf(wrapped), "/content");
  },
};

// ── §4.3's records over the content set's object refs (P4-04) ─────────────────────────────────

/** The content set, decoded from the committed inputs in `conformance/corpus/v2/content/blobs/`
 *  (`tools/gen-content-corpus.ts`). P4-21 pinned a fixed table here; P4-04 re-signs every valid
 *  record, twin and marker over the real refs, so the two corpora join by hash. */
let CONTENT_SET: ContentSet | null = null;
function contentSet(): ContentSet {
  CONTENT_SET ??= loadContentSet(REF_JSON);
  return CONTENT_SET;
}
/** The object refs every §4.6 record may pin: shipped blobs and `refs.json`'s four entries. */
function packObjectHashes(): Set<string> {
  return new Set([...contentSet().objects.values()].map((r) => r.sha256));
}

/** An object ref `{sha256, bytes, size, codec}` of a content-set object. */
function objRef(name: string): Record<string, unknown> {
  const r = contentRef(contentSet(), name);
  return { sha256: r.sha256, bytes: r.bytes, size: r.size, codec: r.codec };
}
/** A `{sha256, bytes}` member (a delta's `artifact` or `data`). */
function hashBytes(name: string): Record<string, unknown> {
  return contentHashBytes(contentSet(), name);
}

/** The payloads: a container's `sha256` is its payload file's; a tree's is its `treeDigest`. */
const PACK_PAYLOADS = {
  get v1() {
    return { ...contentSet().c1.payload };
  },
  get v2() {
    return { ...contentSet().c2.payload };
  },
  get treeV1() {
    return { ...contentSet().tree1.payload };
  },
  get treeV2() {
    return { ...contentSet().tree2.payload };
  },
  get t1() {
    return { ...contentSet().t1.payload };
  },
};

const LEVELS_HANDLER = {
  mountOrder: 2,
  prefixes: ["res://levels/"],
  activation: "restart",
};

function packDoc(
  deliverable: string,
  version: string,
  seq: number,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable,
    kind: "pack",
    version,
    seq,
    issuedAt: RECORD_ISSUED,
    tag: `${deliverable}-v${version}`,
    channel: "stable",
    ...body,
  };
}

/** `djdl.levels@1.1.0`'s `{texture: s3tc}` variant: one delta of each scope from v1. */
function levelsV2Variant(): Record<string, unknown> {
  return {
    variant: { texture: "s3tc" },
    payload: { ...PACK_PAYLOADS.v2 },
    full: objRef("payload/v2.full.zst"),
    files: {
      format: "pkey-files/1",
      layout: "container",
      ...objRef("files/v2.files.zst"),
      gaps: objRef("files/v2.gaps.zst"),
    },
    deltas: [
      {
        method: "zstd-patch-from",
        scope: "payload",
        from: PACK_PAYLOADS.v1.sha256,
        memBytes: PACK_PAYLOADS.v1.size + PACK_PAYLOADS.v2.size,
        artifact: hashBytes("deltas/v1-v2.pf.zst"),
      },
      {
        method: "zstd-patch-from",
        scope: "files",
        from: PACK_PAYLOADS.v1.sha256,
        memBytes: contentSet().memBytes.setC,
        patch: objRef("patch/v1-v2.files.zst"),
        data: hashBytes("patch/v1-v2.files.data"),
      },
    ],
    requires: { engine: "godot-4.7" },
  };
}

/** plans/P4-10.md §2.2, §4.5: a variant's `chunks`, pinning `chunks/v2.pkc.zst` with the corpus
 *  parameters (§2.4's, with a 256 KiB bundle target). */
function levelsChunks(): Record<string, unknown> {
  return {
    format: "pkey-chunks/1",
    ...objRef("chunks/v2.pkc.zst"),
    params: { ...CORPUS_CHUNK_PARAMS },
  };
}

/** §4.3's six records, and plans/P4-10.md §4.5's `djdl.levels@1.2.0`. */
function packRecordDocs(): Record<string, Record<string, unknown>> {
  const godot = {
    type: "godot.pck",
    formatVersion: 4,
    handler: LEVELS_HANDLER,
  };
  const tree = { type: "files.tree", formatVersion: 1 };
  const etc2 = levelsV2Variant();
  delete etc2.deltas;
  etc2.variant = { texture: "etc2" };
  return {
    "djdl.levels@1.0.0": packDoc("djdl.levels", "1.0.0", 1, {
      ...godot,
      variants: [
        {
          variant: { texture: "s3tc" },
          payload: { ...PACK_PAYLOADS.v1 },
          full: objRef("payload/v1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "container",
            ...objRef("files/v1.files.zst"),
            gaps: objRef("files/v1.gaps.zst"),
          },
          requires: { engine: "godot-4.7" },
        },
      ],
    }),
    "djdl.levels@1.1.0": packDoc("djdl.levels", "1.1.0", 2, {
      ...godot,
      variants: [levelsV2Variant(), etc2],
    }),
    "djdl.assets@1.0.0": packDoc("djdl.assets", "1.0.0", 1, {
      ...tree,
      handler: { activation: "hot" },
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.treeV1 },
          full: objRef("tree/v1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/v1.files.zst"),
          },
        },
      ],
    }),
    "djdl.assets@1.1.0": packDoc("djdl.assets", "1.1.0", 2, {
      ...tree,
      handler: { activation: "hot" },
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.treeV2 },
          full: objRef("tree/v2.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/v2.files.zst"),
          },
          deltas: [
            {
              method: "zstd-patch-from",
              scope: "files",
              from: PACK_PAYLOADS.treeV1.sha256,
              memBytes: contentSet().memBytes.setT,
              patch: objRef("patch/v1-v2.tree.zst"),
              data: hashBytes("patch/v1-v2.tree.data"),
            },
          ],
        },
      ],
    }),
    // plans/P4-10.md §4.5: v2's payload republished by a chunk-aware CI; both variants pin
    // `chunks/v2.pkc.zst`, which joins the two corpora by SHA-256.
    "djdl.levels@1.2.0": packDoc("djdl.levels", "1.2.0", 3, {
      ...godot,
      variants: [
        { ...levelsV2Variant(), chunks: levelsChunks() },
        { ...etc2, chunks: levelsChunks() },
      ],
    }),
    // The minimal record: no handler, no entitlement, no deltas, no requires.
    "djdl.docs@1.0.0": packDoc("djdl.docs", "1.0.0", 1, {
      ...tree,
      variants: [
        {
          variant: {},
          payload: { ...PACK_PAYLOADS.t1 },
          full: objRef("tree/t1.full.zst"),
          files: {
            format: "pkey-files/1",
            layout: "tree",
            ...objRef("tree/t1.files.zst"),
          },
        },
      ],
    }),
  };
}

/** The signed pack records (built once per run; the rewritten P3-02 cases sign the same). */
let PACK_RECORDS: Map<string, RecordVector> | null = null;
async function packRecords(): Promise<Map<string, RecordVector>> {
  if (PACK_RECORDS) return PACK_RECORDS;
  const out = new Map<string, RecordVector>();
  for (const [name, doc] of Object.entries(packRecordDocs())) {
    const jws = await signAs(doc, REL_KID, "pkey-release+jws");
    out.set(name, { name, doc, jws, sha256: sha256Hex(jws) });
  }
  PACK_RECORDS = out;
  return out;
}

/** The app twin of §4.6's app checks: R15's envelope with two builds, `content` pinning the
 *  two v1.1.0 pack records and the minimal one, and `embeds` on the desktop build. */
function appTwin(packs: Map<string, RecordVector>): Record<string, unknown> {
  const pin = (name: string): Record<string, unknown> => {
    const r = packs.get(name)!;
    return {
      pack: r.doc.deliverable,
      release: { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version },
    };
  };
  const builds = r15Builds("1.5.0", ["macos-dmg", "web"]);
  builds[0]!.embeds = ["djdl.levels"];
  builds[1]!.embeds = [];
  return recordDoc({
    content: {
      contentApi: 4,
      pins: [pin("djdl.levels@1.1.0"), pin("djdl.assets@1.1.0")],
      expects: [
        { pack: "djdl.levels", required: true, delivery: "essential" },
        { pack: "djdl.assets", required: false, delivery: "prefetch" },
      ],
    },
    builds,
  });
}

// ── `packRecordCases` (159) ──────────────────────────────────────────────────────────────────

interface PackPin {
  kind?: string;
  deliverable: string;
  version: string;
  seq: number;
}

interface PackRecordCase {
  id: string;
  description: string;
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin?: PackPin;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: "hash" | "jws" | "claims" | "cross-check" };
}

/** Steps 12–14 over a record body (shared by pack cases and markers). */
function refRecordSteps(
  body: string,
  expectedHash: string,
  releaseKeys: Record<string, string>,
  productTrust: Record<string, string>,
  aud: string,
):
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; step: "hash" | "jws" | "claims" } {
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { ok: false, step: "hash" };
  if (sha256Hex(body) !== expectedHash) return { ok: false, step: "hash" };
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(body.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return { ok: false, step: "jws" };
  }
  if (typeof kid !== "string" || !hasOwn(releaseKeys, kid))
    return { ok: false, step: "jws" };
  const key = releaseKeys[kid]!;
  if (Object.values(productTrust).includes(key))
    return { ok: false, step: "jws" };
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { ok: false, step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), aud))
    return { ok: false, step: "claims" };
  return { ok: true, doc: v.payload };
}

/** V4 §3.5 steps 12–15 with plans/P4-01.md §2.6's step 15: `kind` equals the pin's, `app`
 *  when the pin names none. */
function refVerifyPackCase(c: PackRecordCase): PackRecordCase["expect"] {
  const r = refRecordSteps(
    c.jws,
    c.expectedHash,
    c.releaseKeys,
    c.productTrust,
    c.expectedAud,
  );
  if (!r.ok) return { verify: "fail", step: r.step };
  const d = r.doc;
  if (c.pin) {
    if (d.kind !== (c.pin.kind ?? "app") || d.deliverable !== c.pin.deliverable)
      return { verify: "fail", step: "cross-check" };
    if (d.version !== c.pin.version || d.seq !== c.pin.seq)
      return { verify: "fail", step: "cross-check" };
  }
  return { verify: "ok", kind: d.kind as string };
}

/** A structure case's generator-only facts: its check, its twin and the property it breaks. */
interface StructureCase {
  check: PackCheck;
  twin: Record<string, unknown>;
  prop: string;
}
/** Filled by `buildPackRecordCases`, read by the per-check self-check; never in the corpus. */
const PACK_STRUCTURE = new Map<string, StructureCase>();
/** The per-integer-path rows for §2.5's 16 paths (token, bound, minimum case ids). */
const PACK_PER_CLAIM: [string, string, string, string][] = [];

const clone = <T>(v: T): T => structuredClone(v);

async function buildPackRecordCases(): Promise<PackRecordCase[]> {
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const packs = await packRecords();
  const rec = (name: string): RecordVector => packs.get(name)!;
  const LV1 = rec("djdl.levels@1.0.0");
  const LV2 = rec("djdl.levels@1.1.0");
  const AS2 = rec("djdl.assets@1.1.0");
  const MIN = rec("djdl.docs@1.0.0").doc;
  /** The one-variant container twin: v2's s3tc variant, one delta of each scope. */
  const ONE: Record<string, unknown> = {
    ...clone(LV2.doc),
    variants: [levelsV2Variant()],
  };
  const APP = appTwin(packs);
  const cases: PackRecordCase[] = [];
  PACK_STRUCTURE.clear();
  PACK_PER_CLAIM.length = 0;

  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      jws?: string;
      kid?: string;
      expectedHash?: string;
      pin?: PackPin;
      expect: PackRecordCase["expect"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, "pkey-release+jws")
        : await signAs(o.doc!, kid, "pkey-release+jws"));
    const c: PackRecordCase = {
      id,
      description,
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: o.expectedHash ?? sha256Hex(jws),
      ...(o.pin ? { pin: o.pin } : {}),
      expect: o.expect,
    };
    const v = hasOwn(RK, kid)
      ? refVerifyJws(jws, { [kid]: RK[kid]! }, "pkey-release+jws")
      : null;
    const nonWire = v ? refNonWire(v.text) : [];
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ok = (kind: string, doc?: unknown): PackRecordCase["expect"] =>
    doc === undefined ? { verify: "ok", kind } : { verify: "ok", kind, doc };
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check",
  ): PackRecordCase["expect"] => ({ verify: "fail", step });

  // ── Valid (13) ──
  await mk(
    "pack-valid-container",
    "`djdl.levels@1.1.0`: a `godot.pck` container with two texture variants, the first with one delta of each scope.",
    { jws: LV2.jws, expect: ok("pack", LV2.doc) },
  );
  await mk(
    "pack-valid-tree",
    "`djdl.assets@1.1.0`: an unvaried `files.tree` pack with a `files` delta and no gaps.",
    { jws: AS2.jws, expect: ok("pack") },
  );
  await mk(
    "pack-valid-pinned",
    "`djdl.levels@1.1.0` cross-checked against a pack pin `{kind: pack, djdl.levels, 1.1.0, 2}` (plans/P4-01.md §2.6).",
    {
      jws: LV2.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: ok("pack"),
    },
  );
  await mk(
    "pack-valid-minimal",
    "`djdl.docs@1.0.0`: only the required members (no handler, entitlement, deltas or requires).",
    { jws: rec("djdl.docs@1.0.0").jws, expect: ok("pack") },
  );
  {
    const d = clone(MIN);
    d.type = "l10n.table";
    await mk(
      "pack-valid-unknown-type",
      "An unknown pack type (`l10n.table`) verifies; the pack is unusable on a v1 SDK (`pack-type-unsupported`).",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.deltas[0].method = "godot-delta-pck";
    v.deltas.push({
      method: "zstd-patch-from",
      scope: "chunks",
      from: PACK_PAYLOADS.v1.sha256,
      memBytes: 1048576,
    });
    v.files.format = "pkey-files/2";
    v.full.codec = "lz4";
    (d.handler as Record<string, unknown>).activation = "lazy";
    await mk(
      "pack-valid-unknown-vocabulary",
      "Values outside v1's vocabularies (a `godot-delta-pck` method, a `chunks` scope, a `pkey-files/2` index, an `lz4` object, activation `lazy`) verify; each only makes its thing unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    (d.variants as Record<string, any>[])[0]!.files.layout = "strata";
    await mk(
      "pack-valid-unknown-layout",
      "An unknown layout (`strata`) carrying `gaps` and a `payload` delta verifies: it neither needs nor refuses them, and the variant is unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.full.size = v.payload.size + 1;
    await mk(
      "pack-valid-full-size-differs",
      "`full.size` differs from `payload.size`: not a claim (no claim relates two integer members); `full` is unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.deltas[0].patch = null;
    v.deltas[0].data = 5;
    v.deltas[1].artifact = "x";
    await mk(
      "pack-valid-foreign-delta-members",
      'A `payload` delta with `patch: null` and `data: 5`, and a `files` delta with `artifact: "x"`: a member of the other scope is ignored, not refused.',
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.chunks = {
      format: "pkey-chunks/1",
      ...objRef("files/v2.files.zst"),
      params: { avg: 65536 },
    };
    v.conflicts = ["djdl.other"];
    v.requires = {
      engine: "godot-4.7",
      contentApi: 1,
      packs: ["djdl.assets"],
      features: ["x"],
    };
    d.provides = ["djdl.levels-hd"];
    d.removes = [];
    d.content = 5;
    await mk(
      "pack-valid-reserved-members",
      "Every reserved member (`conflicts`, `requires.{contentApi, packs, features}`, `provides`, `removes`) and `content: 5`, which a pack record ignores; its `chunks` is well formed (plans/P4-10.md §2.2).",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const jws = await signAs(APP, REL_KID, "pkey-release+jws");
    await mk(
      "app-valid-content",
      "An app record with `content` (two pins, two expects) and `builds[].embeds`.",
      { jws, expect: ok("app", APP) },
    );
  }
  {
    const d = clone(APP);
    const c = d.content as Record<string, any>;
    c.expects.push({
      pack: "djdl.music",
      required: false,
      delivery: "background",
    });
    c.holds = [];
    c.packChannels = { "djdl.levels": "beta" };
    await mk(
      "app-valid-content-forward",
      "Forward members: an unpinned expect, `holds`, `packChannels` and delivery `background` verify (cross-record rules are publish rules, never claims).",
      { doc: d, expect: ok("app") },
    );
  }
  {
    const builds = r15Builds("1.5.0", ["web"]);
    builds[0]!.embeds = 7;
    await mk(
      "content-valid-ignored-on-unknown-kind",
      "A record of an unknown kind with `content: 5` and a build with `embeds: 7`: only the common claims apply.",
      {
        doc: recordDoc({ kind: "future", content: 5, builds }),
        expect: ok("future"),
      },
    );
  }

  // ── Structure (92): one property of a twin, refused by its check alone ──
  const brk = async (
    id: string,
    check: PackCheck,
    twin: Record<string, unknown>,
    prop: string,
    description: string,
    mutate: (d: Record<string, any>) => void,
  ): Promise<void> => {
    const d = clone(twin) as Record<string, any>;
    mutate(d);
    PACK_STRUCTURE.set(id, { check, twin, prop });
    await mk(id, description, { doc: d, expect: fail("claims") });
  };
  const V0 = "/variants/0";
  const v0 = (d: Record<string, any>): Record<string, any> => d.variants[0];
  const pd = (d: Record<string, any>): Record<string, any> => v0(d).deltas[0];
  const fd = (d: Record<string, any>): Record<string, any> => v0(d).deltas[1];

  await brk(
    "pack-deliverable-app",
    "deliverable.not-app",
    ONE,
    "/deliverable",
    "A pack record whose `deliverable` is `app`.",
    (d) => {
      d.deliverable = "app";
    },
  );
  await brk(
    "pack-builds-present",
    "builds.absent",
    ONE,
    "/builds",
    "A pack record with `builds: []`.",
    (d) => {
      d.builds = [];
    },
  );
  await brk("pack-type-missing", "type", ONE, "/type", "No `type`.", (d) => {
    delete d.type;
  });
  await brk(
    "pack-type-bad-pattern",
    "type",
    ONE,
    "/type",
    '`type: "godot"`, outside `PACK_TYPE_PATTERN`.',
    (d) => {
      d.type = "godot";
    },
  );
  await brk(
    "pack-type-trailing-newline",
    "type",
    ONE,
    "/type",
    'Whole-string patterns: `type` `"godot.pck\\n"`.',
    (d) => {
      d.type = "godot.pck\n";
    },
  );
  await brk(
    "pack-format-version-missing",
    "formatVersion",
    ONE,
    "/formatVersion",
    "No `formatVersion`.",
    (d) => {
      delete d.formatVersion;
    },
  );
  await brk(
    "pack-handler-null",
    "handler",
    ONE,
    "/handler",
    "`handler: null`.",
    (d) => {
      d.handler = null;
    },
  );
  await brk(
    "pack-mount-order-null",
    "handler.mountOrder",
    ONE,
    "/handler/mountOrder",
    "`handler.mountOrder: null`.",
    (d) => {
      d.handler.mountOrder = null;
    },
  );
  await brk(
    "pack-handler-prefixes-null",
    "handler.prefixes",
    ONE,
    "/handler/prefixes",
    "`handler.prefixes: null`.",
    (d) => {
      d.handler.prefixes = null;
    },
  );
  await brk(
    "pack-handler-prefixes-empty",
    "handler.prefixes.count",
    ONE,
    "/handler/prefixes",
    "`handler.prefixes: []` (1–32 items).",
    (d) => {
      d.handler.prefixes = [];
    },
  );
  await brk(
    "pack-handler-prefixes-over-max",
    "handler.prefixes.count",
    ONE,
    "/handler/prefixes",
    "33 distinct prefixes (1–32 items).",
    (d) => {
      d.handler.prefixes = Array.from({ length: 33 }, (_, k) => `res://p${k}/`);
    },
  );
  await brk(
    "pack-handler-prefix-bad",
    "handler.prefixes.item",
    ONE,
    "/handler/prefixes",
    "A prefix without its trailing slash (`res://levels`).",
    (d) => {
      d.handler.prefixes = ["res://levels"];
    },
  );
  await brk(
    "pack-handler-prefix-not-string",
    "handler.prefixes.item",
    ONE,
    "/handler/prefixes",
    "A prefix that is a number.",
    (d) => {
      d.handler.prefixes = [7];
    },
  );
  await brk(
    "pack-handler-prefix-over-256-bytes",
    "handler.prefixes.length",
    ONE,
    "/handler/prefixes",
    "A 257-byte prefix that matches `HANDLER_PREFIX_PATTERN`.",
    (d) => {
      d.handler.prefixes = [`res://${"a".repeat(250)}/`];
    },
  );
  await brk(
    "pack-handler-prefixes-duplicate",
    "handler.prefixes.unique",
    ONE,
    "/handler/prefixes",
    "The same prefix twice.",
    (d) => {
      d.handler.prefixes = ["res://levels/", "res://levels/"];
    },
  );
  await brk(
    "pack-handler-activation-empty",
    "handler.activation",
    ONE,
    "/handler/activation",
    '`handler.activation: ""`.',
    (d) => {
      d.handler.activation = "";
    },
  );
  await brk(
    "pack-handler-activation-null",
    "handler.activation",
    ONE,
    "/handler/activation",
    "`handler.activation: null`.",
    (d) => {
      d.handler.activation = null;
    },
  );
  await brk(
    "pack-entitlement-bad",
    "entitlement",
    ONE,
    "/entitlement",
    '`entitlement: "-hd"`, outside `ENTITLEMENT_PATTERN`.',
    (d) => {
      d.entitlement = "-hd";
    },
  );
  await brk(
    "pack-variants-missing",
    "variants",
    ONE,
    "/variants",
    "No `variants`.",
    (d) => {
      delete d.variants;
    },
  );
  await brk(
    "pack-variants-empty",
    "variants.count",
    ONE,
    "/variants",
    "`variants: []` (1–32 items).",
    (d) => {
      d.variants = [];
    },
  );
  await brk(
    "pack-variants-over-max",
    "variants.count",
    ONE,
    "/variants",
    "33 variants with distinct keys (1–32 items).",
    (d) => {
      const base = v0(d);
      delete base.deltas;
      d.variants = Array.from({ length: 33 }, (_, k) => ({
        ...clone(base),
        variant: { texture: `t${k}` },
      }));
    },
  );
  await brk(
    "pack-variant-not-object",
    "variants.item",
    ONE,
    "/variants/0",
    "A variant that is a number.",
    (d) => {
      d.variants[0] = 7;
    },
  );
  await brk(
    "pack-variant-key-duplicate",
    "variants.key-unique",
    ONE,
    "/variants",
    "Two variants with the key `texture=s3tc`.",
    (d) => {
      d.variants.push(clone(v0(d)));
    },
  );
  await brk(
    "pack-variant-axes-differ",
    "variants.axes-same",
    ONE,
    "/variants",
    "A second variant declaring `locale` where the first declares `texture`.",
    (d) => {
      d.variants.push({ ...clone(v0(d)), variant: { locale: "fr" } });
    },
  );
  await brk(
    "pack-variant-member-missing",
    "variant",
    ONE,
    `${V0}/variant`,
    "A variant without its `variant` member.",
    (d) => {
      delete v0(d).variant;
    },
  );
  await brk(
    "pack-variant-five-axes",
    "variant.count",
    ONE,
    `${V0}/variant`,
    "A variant with five axes (0–4 members).",
    (d) => {
      v0(d).variant = {
        texture: "s3tc",
        locale: "fr",
        quality: "hd",
        tier: "a",
        size: "b",
      };
    },
  );
  await brk(
    "pack-variant-axis-bad",
    "variant.axis",
    ONE,
    `${V0}/variant`,
    "An axis name `Texture`, outside `VARIANT_AXIS_PATTERN`.",
    (d) => {
      v0(d).variant = { Texture: "s3tc" };
    },
  );
  await brk(
    "pack-variant-value-non-ascii",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    "An axis value `s3tç`: `VARIANT_VALUE_PATTERN` is ASCII.",
    (d) => {
      v0(d).variant.texture = "s3tç";
    },
  );
  await brk(
    "pack-variant-value-trailing-newline",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    'Whole-string patterns: an axis value `"s3tc\\n"`.',
    (d) => {
      v0(d).variant.texture = "s3tc\n";
    },
  );
  await brk(
    "pack-variant-value-not-string",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    "An axis value that is a number.",
    (d) => {
      v0(d).variant.texture = 7;
    },
  );
  await brk(
    "pack-payload-missing",
    "payload",
    ONE,
    `${V0}/payload`,
    "A variant without `payload`.",
    (d) => {
      delete v0(d).payload;
    },
  );
  await brk(
    "pack-payload-size-missing",
    "payload.size",
    ONE,
    `${V0}/payload/size`,
    "`payload` without `size`.",
    (d) => {
      delete v0(d).payload.size;
    },
  );
  await brk(
    "pack-payload-sha256-uppercase",
    "payload.sha256",
    ONE,
    `${V0}/payload/sha256`,
    "`payload.sha256` in uppercase hex.",
    (d) => {
      v0(d).payload.sha256 = String(v0(d).payload.sha256).toUpperCase();
    },
  );
  await brk(
    "pack-full-missing",
    "full",
    ONE,
    `${V0}/full`,
    "A variant without `full`.",
    (d) => {
      delete v0(d).full;
    },
  );
  await brk(
    "pack-ref-sha256-short",
    "ref.sha256",
    ONE,
    `${V0}/full/sha256`,
    "`full.sha256` with 63 hex digits (standing for every object ref).",
    (d) => {
      v0(d).full.sha256 = String(v0(d).full.sha256).slice(1);
    },
  );
  await brk(
    "pack-ref-bytes-missing",
    "ref.bytes",
    ONE,
    `${V0}/full/bytes`,
    "`full` without `bytes`.",
    (d) => {
      delete v0(d).full.bytes;
    },
  );
  await brk(
    "pack-ref-size-missing",
    "ref.size",
    ONE,
    `${V0}/full/size`,
    "`full` without `size`.",
    (d) => {
      delete v0(d).full.size;
    },
  );
  await brk(
    "pack-ref-codec-missing",
    "ref.codec",
    ONE,
    `${V0}/full/codec`,
    "`full` without `codec` (required even for `none`).",
    (d) => {
      delete v0(d).full.codec;
    },
  );
  await brk(
    "pack-ref-codec-bad-pattern",
    "ref.codec",
    ONE,
    `${V0}/full/codec`,
    '`full.codec: "ZSTD"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => {
      v0(d).full.codec = "ZSTD";
    },
  );
  await brk(
    "pack-ref-none-bytes-mismatch",
    "ref.none-bytes",
    ONE,
    `${V0}/full/codec`,
    "`full.codec: none` while `bytes` ≠ `size`.",
    (d) => {
      v0(d).full.codec = "none";
    },
  );
  await brk(
    "pack-files-missing",
    "files",
    ONE,
    `${V0}/files`,
    "A variant without `files`.",
    (d) => {
      delete v0(d).files;
    },
  );
  await brk(
    "pack-files-format-empty",
    "files.format",
    ONE,
    `${V0}/files/format`,
    '`files.format: ""`.',
    (d) => {
      v0(d).files.format = "";
    },
  );
  await brk(
    "pack-files-layout-empty",
    "files.layout",
    ONE,
    `${V0}/files/layout`,
    '`files.layout: ""`.',
    (d) => {
      v0(d).files.layout = "";
    },
  );
  await brk(
    "pack-files-gaps-null",
    "files.gaps",
    ONE,
    `${V0}/files/gaps`,
    "`files.gaps: null` on a container.",
    (d) => {
      v0(d).files.gaps = null;
    },
  );
  await brk(
    "pack-files-gaps-missing",
    "files.gaps-container",
    ONE,
    `${V0}/files/gaps`,
    "A container without `files.gaps`.",
    (d) => {
      delete v0(d).files.gaps;
    },
  );
  await brk(
    "pack-files-gaps-on-tree",
    "files.gaps-tree",
    MIN,
    `${V0}/files/gaps`,
    "A tree carrying `files.gaps`.",
    (d) => {
      v0(d).files.gaps = objRef("files/v2.gaps.zst");
    },
  );
  await brk(
    "pack-deltas-null",
    "deltas",
    ONE,
    `${V0}/deltas`,
    "`deltas: null`.",
    (d) => {
      v0(d).deltas = null;
    },
  );
  await brk(
    "pack-deltas-over-max",
    "deltas.count",
    ONE,
    `${V0}/deltas`,
    "17 `payload` deltas with distinct ids (at most 16).",
    (d) => {
      const base = pd(d);
      v0(d).deltas = Array.from({ length: 17 }, (_, k) => ({
        ...clone(base),
        artifact: {
          sha256: sha256Hex(`pkey-corpus-delta:${k}`),
          bytes: 312704,
        },
      }));
    },
  );
  await brk(
    "pack-delta-not-object",
    "deltas.item",
    ONE,
    `${V0}/deltas/0`,
    "A delta that is a number.",
    (d) => {
      v0(d).deltas[0] = 7;
    },
  );
  await brk(
    "pack-delta-id-duplicate",
    "deltas.id-unique",
    ONE,
    `${V0}/deltas`,
    "Two `payload` deltas with one id (`artifact.sha256`).",
    (d) => {
      v0(d).deltas = [clone(pd(d)), clone(pd(d))];
    },
  );
  await brk(
    "pack-delta-method-bad",
    "delta.method",
    ONE,
    `${V0}/deltas/0/method`,
    '`method: "Zstd"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => {
      pd(d).method = "Zstd";
    },
  );
  await brk(
    "pack-delta-scope-empty",
    "delta.scope",
    ONE,
    `${V0}/deltas/0/scope`,
    '`scope: ""`.',
    (d) => {
      pd(d).scope = "";
    },
  );
  await brk(
    "pack-delta-payload-on-tree",
    "delta.scope-tree",
    MIN,
    `${V0}/deltas`,
    "A `payload` delta on a tree variant.",
    (d) => {
      v0(d).deltas = [
        {
          method: "zstd-patch-from",
          scope: "payload",
          from: PACK_PAYLOADS.treeV1.sha256,
          memBytes: 19000,
          artifact: hashBytes("deltas/v1-v2.pf.zst"),
        },
      ];
    },
  );
  await brk(
    "pack-delta-from-bad",
    "delta.from",
    ONE,
    `${V0}/deltas/0/from`,
    "`from` that is not 64 lowercase hex.",
    (d) => {
      pd(d).from = "088b";
    },
  );
  await brk(
    "pack-delta-mem-bytes-missing",
    "delta.memBytes",
    ONE,
    `${V0}/deltas/0/memBytes`,
    "A delta without `memBytes`.",
    (d) => {
      delete pd(d).memBytes;
    },
  );
  await brk(
    "pack-delta-artifact-missing",
    "delta.artifact",
    ONE,
    `${V0}/deltas/0/artifact`,
    "A `payload` delta without `artifact`.",
    (d) => {
      delete pd(d).artifact;
    },
  );
  await brk(
    "pack-delta-artifact-sha256-bad",
    "delta.artifact.sha256",
    ONE,
    `${V0}/deltas/0/artifact/sha256`,
    "`artifact.sha256` in uppercase hex.",
    (d) => {
      pd(d).artifact.sha256 = String(pd(d).artifact.sha256).toUpperCase();
    },
  );
  await brk(
    "pack-delta-artifact-bytes-missing",
    "delta.artifact.bytes",
    ONE,
    `${V0}/deltas/0/artifact/bytes`,
    "`artifact` without `bytes`.",
    (d) => {
      delete pd(d).artifact.bytes;
    },
  );
  await brk(
    "pack-delta-patch-missing",
    "delta.patch",
    ONE,
    `${V0}/deltas/1/patch`,
    "A `files` delta without `patch`.",
    (d) => {
      delete fd(d).patch;
    },
  );
  await brk(
    "pack-delta-data-missing",
    "delta.data",
    ONE,
    `${V0}/deltas/1/data`,
    "A `files` delta without `data`.",
    (d) => {
      delete fd(d).data;
    },
  );
  await brk(
    "pack-delta-data-sha256-bad",
    "delta.data.sha256",
    ONE,
    `${V0}/deltas/1/data/sha256`,
    "`data.sha256` with 63 hex digits.",
    (d) => {
      fd(d).data.sha256 = String(fd(d).data.sha256).slice(1);
    },
  );
  await brk(
    "pack-delta-data-bytes-missing",
    "delta.data.bytes",
    ONE,
    `${V0}/deltas/1/data/bytes`,
    "`data` without `bytes`.",
    (d) => {
      delete fd(d).data.bytes;
    },
  );
  await brk(
    "pack-requires-null",
    "requires",
    ONE,
    `${V0}/requires`,
    "`requires: null`.",
    (d) => {
      v0(d).requires = null;
    },
  );
  await brk(
    "pack-requires-engine-bad",
    "requires.engine",
    ONE,
    `${V0}/requires/engine`,
    '`requires.engine: "godot-4"`, outside `ENGINE_PATTERN`.',
    (d) => {
      v0(d).requires.engine = "godot-4";
    },
  );

  // kind: app, on the app twin.
  const C = "/content";
  const ct = (d: Record<string, any>): Record<string, any> => d.content;
  const pin0 = (d: Record<string, any>): Record<string, any> => ct(d).pins[0];
  const exp0 = (d: Record<string, any>): Record<string, any> =>
    ct(d).expects[0];
  const B0 = "/builds/0/embeds";
  await brk("app-content-null", "content", APP, C, "`content: null`.", (d) => {
    d.content = null;
  });
  await brk(
    "app-content-api-missing",
    "content.contentApi",
    APP,
    `${C}/contentApi`,
    "`content` without `contentApi`.",
    (d) => {
      delete ct(d).contentApi;
    },
  );
  await brk(
    "app-pins-missing",
    "content.pins",
    APP,
    `${C}/pins`,
    "`content` without `pins`.",
    (d) => {
      delete ct(d).pins;
    },
  );
  await brk(
    "app-pins-over-max",
    "content.pins.count",
    APP,
    `${C}/pins`,
    "257 pins with distinct packs (at most 256).",
    (d) => {
      const base = pin0(d);
      ct(d).pins = Array.from({ length: 257 }, (_, k) => ({
        ...clone(base),
        pack: `p${k}`,
      }));
    },
  );
  await brk(
    "app-pin-not-object",
    "content.pins.item",
    APP,
    `${C}/pins/0`,
    "A pin that is a number.",
    (d) => {
      ct(d).pins[0] = 7;
    },
  );
  await brk(
    "app-pins-duplicate-pack",
    "content.pins.unique",
    APP,
    `${C}/pins/1/pack`,
    "Two pins of `djdl.levels`.",
    (d) => {
      ct(d).pins[1].pack = "djdl.levels";
    },
  );
  await brk(
    "app-pin-pack-bad",
    "pin.pack",
    APP,
    `${C}/pins/0/pack`,
    '`pins[].pack: "Djdl.levels"`, outside the pack-id pattern.',
    (d) => {
      pin0(d).pack = "Djdl.levels";
    },
  );
  await brk(
    "app-pin-pack-over-64-bytes",
    "pin.pack",
    APP,
    `${C}/pins/0/pack`,
    "A 65-byte pack id.",
    (d) => {
      pin0(d).pack = "a".repeat(65);
    },
  );
  await brk(
    "app-pin-pack-app",
    "pin.pack.not-app",
    APP,
    `${C}/pins/0/pack`,
    '`pins[].pack: "app"`.',
    (d) => {
      pin0(d).pack = "app";
    },
  );
  await brk(
    "app-pin-release-missing",
    "pin.release",
    APP,
    `${C}/pins/0/release`,
    "A pin without `release`.",
    (d) => {
      delete pin0(d).release;
    },
  );
  await brk(
    "app-pin-sha256-bad",
    "pin.release.sha256",
    APP,
    `${C}/pins/0/release/sha256`,
    "`release.sha256` in uppercase hex.",
    (d) => {
      pin0(d).release.sha256 = String(pin0(d).release.sha256).toUpperCase();
    },
  );
  await brk(
    "app-pin-seq-missing",
    "pin.release.seq",
    APP,
    `${C}/pins/0/release/seq`,
    "`release` without `seq`.",
    (d) => {
      delete pin0(d).release.seq;
    },
  );
  await brk(
    "app-pin-version-trailing-newline",
    "pin.release.version",
    APP,
    `${C}/pins/0/release/version`,
    'Whole-string patterns: `release.version` `"1.1.0\\n"`.',
    (d) => {
      pin0(d).release.version = "1.1.0\n";
    },
  );
  await brk(
    "app-expects-missing",
    "content.expects",
    APP,
    `${C}/expects`,
    "`content` without `expects`.",
    (d) => {
      delete ct(d).expects;
    },
  );
  await brk(
    "app-expects-over-max",
    "content.expects.count",
    APP,
    `${C}/expects`,
    "257 expects with distinct packs (at most 256).",
    (d) => {
      const base = exp0(d);
      ct(d).expects = Array.from({ length: 257 }, (_, k) => ({
        ...clone(base),
        pack: `p${k}`,
      }));
    },
  );
  await brk(
    "app-expect-not-object",
    "content.expects.item",
    APP,
    `${C}/expects/0`,
    "An expect that is a number.",
    (d) => {
      ct(d).expects[0] = 7;
    },
  );
  await brk(
    "app-expects-duplicate-pack",
    "content.expects.unique",
    APP,
    `${C}/expects/1/pack`,
    "Two expects of `djdl.levels`.",
    (d) => {
      ct(d).expects[1].pack = "djdl.levels";
    },
  );
  await brk(
    "app-expect-pack-bad",
    "expect.pack",
    APP,
    `${C}/expects/0/pack`,
    '`expects[].pack: "djdl..levels"`, outside the pack-id pattern.',
    (d) => {
      exp0(d).pack = "djdl..levels";
    },
  );
  await brk(
    "app-expect-pack-over-64-bytes",
    "expect.pack",
    APP,
    `${C}/expects/0/pack`,
    "A 65-byte pack id.",
    (d) => {
      exp0(d).pack = "b".repeat(65);
    },
  );
  await brk(
    "app-expect-pack-app",
    "expect.pack.not-app",
    APP,
    `${C}/expects/0/pack`,
    '`expects[].pack: "app"`.',
    (d) => {
      exp0(d).pack = "app";
    },
  );
  await brk(
    "app-expect-required-not-boolean",
    "expect.required",
    APP,
    `${C}/expects/0/required`,
    '`required: "yes"`.',
    (d) => {
      exp0(d).required = "yes";
    },
  );
  await brk(
    "app-expect-delivery-empty",
    "expect.delivery",
    APP,
    `${C}/expects/0/delivery`,
    '`delivery: ""`.',
    (d) => {
      exp0(d).delivery = "";
    },
  );
  await brk(
    "app-embeds-null",
    "embeds",
    APP,
    B0,
    "`builds[].embeds: null`.",
    (d) => {
      d.builds[0].embeds = null;
    },
  );
  await brk(
    "app-embeds-over-max",
    "embeds.count",
    APP,
    B0,
    "65 distinct embedded packs (at most 64).",
    (d) => {
      d.builds[0].embeds = Array.from({ length: 65 }, (_, k) => `p${k}`);
    },
  );
  await brk(
    "app-embeds-item-bad",
    "embeds.item",
    APP,
    B0,
    "An embedded pack id `Djdl`.",
    (d) => {
      d.builds[0].embeds = ["Djdl"];
    },
  );
  await brk(
    "app-embeds-item-over-64-bytes",
    "embeds.item",
    APP,
    B0,
    "A 65-byte embedded pack id.",
    (d) => {
      d.builds[0].embeds = ["c".repeat(65)];
    },
  );
  await brk(
    "app-embeds-app",
    "embeds.not-app",
    APP,
    B0,
    "`app` among the embedded packs.",
    (d) => {
      d.builds[0].embeds = ["app"];
    },
  );
  await brk(
    "app-embeds-duplicate",
    "embeds.unique",
    APP,
    B0,
    "One pack embedded twice.",
    (d) => {
      d.builds[0].embeds = ["djdl.levels", "djdl.levels"];
    },
  );

  // ── Cross-check, hash and key (6) ──
  const PACK_PIN: PackPin = {
    kind: "pack",
    deliverable: "djdl.levels",
    version: "1.1.0",
    seq: 2,
  };
  await mk(
    "pack-pin-version-mismatch",
    "Step 15: the pack record's version is not the pin's.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, version: "1.0.0" },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-seq-mismatch",
    "Step 15: the pack record's `seq` is not the pin's.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, seq: 1 },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-deliverable-mismatch",
    "Step 15: the pack record's `deliverable` is not the pin's pack id.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, deliverable: "djdl.assets" },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-kind-app",
    "Step 15: an app record where a pack is pinned (`kind` differs; deliverable, version and `seq` match).",
    {
      doc: APP,
      pin: { kind: "pack", deliverable: "app", version: "1.5.0", seq: 15 },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-hash-mismatch",
    "Step 12: the body's SHA-256 is not the pin (another valid pack record).",
    {
      jws: LV2.jws,
      expectedHash: LV1.sha256,
      expect: fail("hash"),
    },
  );
  await mk(
    "pack-signed-by-product-key",
    "A pack record signed by the PRODUCT key: its kid is not among the pinned release keys.",
    {
      doc: LV2.doc,
      kid: PIN_KID,
      expect: fail("jws"),
    },
  );

  // ── Integers (48): token, bound and minimum per §2.5 path, each breaking its path alone ──
  const intRow = async (
    pointer: string,
    twin: Record<string, unknown>,
    ids: [string, string, string],
    tokens: [string, string],
    member: string,
  ): Promise<void> => {
    const at = (d: Record<string, any>, token: unknown): void => {
      const parts = pointer.split("/").slice(1);
      let o: any = d;
      for (const p of parts.slice(0, -1)) o = o[p];
      o[parts[parts.length - 1]!] = token;
    };
    const [tokenId, boundId, minId] = ids;
    const t = clone(twin) as Record<string, any>;
    at(t, raw(tokens[0]));
    await mk(
      tokenId,
      `V4 §3: the ${member} token \`${tokens[0]}\` at \`${pointer}\`.`,
      {
        text: rawJson(t),
        expect: fail("claims"),
      },
    );
    const b = clone(twin) as Record<string, any>;
    at(b, raw(BIG_OVER));
    await mk(boundId, `V4 §3: ${member} ${BIG_OVER} at \`${pointer}\`.`, {
      text: rawJson(b),
      expect: fail("claims"),
    });
    const m = clone(twin) as Record<string, any>;
    at(m, tokens[1] === "0" ? 0 : -1);
    await mk(
      minId,
      `V4 §3 minimums: ${member} ${tokens[1] === "0" ? 0 : -1} at \`${pointer}\` (minimum ${tokens[1] === "0" ? 1 : 0}).`,
      {
        doc: m,
        expect: fail("claims"),
      },
    );
    PACK_PER_CLAIM.push([pointer, tokenId, boundId, minId]);
  };
  const tok = (pointer: string, twin: Record<string, unknown>): number => {
    let o: any = twin;
    for (const p of pointer.split("/").slice(1)) o = o[p];
    return o as number;
  };
  const IF = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}.0`;
  const NI = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}.0000000000000001`;
  const EX = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}e0`;
  const rows: [
    string,
    Record<string, unknown>,
    string,
    (p: string, t: Record<string, unknown>) => string,
    "0" | "-1",
    string,
  ][] = [
    ["/formatVersion", ONE, "pack-format-version", IF, "0", "`formatVersion`"],
    ["/handler/mountOrder", ONE, "pack-mount-order", NI, "-1", "`mountOrder`"],
    [
      `${V0}/payload/size`,
      ONE,
      "pack-payload-size",
      IF,
      "-1",
      "`payload.size`",
    ],
    [`${V0}/full/bytes`, ONE, "pack-full-bytes", NI, "-1", "`full.bytes`"],
    [`${V0}/full/size`, ONE, "pack-full-size", EX, "-1", "`full.size`"],
    [`${V0}/files/bytes`, ONE, "pack-files-bytes", IF, "0", "`files.bytes`"],
    [`${V0}/files/size`, ONE, "pack-files-size", NI, "0", "`files.size`"],
    [
      `${V0}/files/gaps/bytes`,
      ONE,
      "pack-gaps-bytes",
      IF,
      "-1",
      "`gaps.bytes`",
    ],
    [`${V0}/files/gaps/size`, ONE, "pack-gaps-size", NI, "-1", "`gaps.size`"],
    [`${V0}/deltas/0/memBytes`, ONE, "pack-mem-bytes", EX, "0", "`memBytes`"],
    [
      `${V0}/deltas/0/artifact/bytes`,
      ONE,
      "pack-artifact-bytes",
      NI,
      "0",
      "`artifact.bytes`",
    ],
    [
      `${V0}/deltas/1/patch/bytes`,
      ONE,
      "pack-patch-bytes",
      IF,
      "0",
      "`patch.bytes`",
    ],
    [
      `${V0}/deltas/1/patch/size`,
      ONE,
      "pack-patch-size",
      NI,
      "0",
      "`patch.size`",
    ],
    [
      `${V0}/deltas/1/data/bytes`,
      ONE,
      "pack-data-bytes",
      IF,
      "0",
      "`data.bytes`",
    ],
    ["/content/contentApi", APP, "app-content-api", NI, "0", "`contentApi`"],
    [
      "/content/pins/0/release/seq",
      APP,
      "app-pin-seq",
      IF,
      "0",
      "`pins[].release.seq`",
    ],
  ];
  for (const [pointer, twin, stem, token, min, member] of rows) {
    const kind =
      token === IF
        ? "integral-fraction"
        : token === NI
          ? "near-integer"
          : "exponent";
    await intRow(
      pointer,
      twin,
      [
        `${stem}-${kind}`,
        `${stem}-over-max`,
        `${stem}-${min === "0" ? "zero" : "negative"}`,
      ],
      [token(pointer, twin), min],
      member,
    );
  }

  // ── plans/P4-10.md §4.5: `chunks` (+11), appended after P4-01's 159 ──
  const CH: Record<string, unknown> = clone(ONE);
  (CH.variants as Record<string, any>[])[0]!.chunks = levelsChunks();
  {
    const L3 = rec("djdl.levels@1.2.0");
    await mk(
      "pack-valid-chunks",
      "`djdl.levels@1.2.0`: v2's payload republished by a chunk-aware CI; both variants carry `chunks` pinning `chunks/v2.pkc.zst`, which joins the content corpus by SHA-256 (plans/P4-10.md §4.5).",
      { jws: L3.jws, expect: ok("pack", L3.doc) },
    );
  }
  {
    const d = clone(CH);
    const c = (d.variants as Record<string, any>[])[0]!.chunks;
    c.format = "pkey-chunks/2";
    c.codec = "lz4";
    c.deltas = [];
    c.params = { ...c.params, later: { anything: true }, avgSize: "big" };
    await mk(
      "pack-valid-chunks-forward",
      "`chunks` with format `pkey-chunks/2`, codec `lz4`, an extra `deltas: []` member and unknown `params` members: it verifies, and its chunks are only unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  await brk(
    "pack-chunks-null",
    "chunks",
    CH,
    `${V0}/chunks`,
    "`chunks: null` (absent or an object).",
    (d) => {
      v0(d).chunks = null;
    },
  );
  await brk(
    "pack-chunks-format-empty",
    "chunks.format",
    CH,
    `${V0}/chunks/format`,
    '`chunks.format: ""`, outside `OBJECT_FORMAT_PATTERN`.',
    (d) => {
      v0(d).chunks.format = "";
    },
  );
  await brk(
    "pack-chunks-params-not-object",
    "chunks.params",
    CH,
    `${V0}/chunks/params`,
    "`chunks.params: 7` (absent or an object).",
    (d) => {
      v0(d).chunks.params = 7;
    },
  );
  for (const [pointer, stem, token, min, member] of [
    [`${V0}/chunks/bytes`, "pack-chunks-bytes", IF, "0", "`chunks.bytes`"],
    [`${V0}/chunks/size`, "pack-chunks-size", NI, "0", "`chunks.size`"],
  ] as const) {
    const kind = token === IF ? "integral-fraction" : "near-integer";
    await intRow(
      pointer,
      CH,
      [`${stem}-${kind}`, `${stem}-over-max`, `${stem}-zero`],
      [token(pointer, CH), min],
      member,
    );
  }

  if (cases.length !== 170)
    throw new Error(`packRecordCases: ${cases.length} != 170`);
  for (const c of cases) {
    const want = refVerifyPackCase(c);
    if (
      JSON.stringify({ ...want, doc: undefined }) !==
      JSON.stringify({ ...c.expect, doc: undefined })
    )
      throw new Error(
        `packRecordCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
  }
  return cases;
}

// ── `markerCases` (17), V4 §3.7 ──────────────────────────────────────────────────────────────

interface MarkerCase {
  id: string;
  description: string;
  marker: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; packId: string; version: string; recordSha256: string }
    | {
        verify: "fail";
        step: "format" | "hash" | "jws" | "claims" | "cross-check";
      };
}

/** The marker's `release` when the marker text is a JSON object holding a string there. */
function markerRelease(text: string): string | null {
  try {
    const m = JSON.parse(text) as unknown;
    return isObj(m) && typeof m.release === "string" ? m.release : null;
  } catch {
    return null;
  }
}

/** V4 §3.7 (plans/P4-01.md §2.6), from first principles. */
function refVerifyMarkerCase(c: MarkerCase): MarkerCase["expect"] {
  const text = c.marker;
  if (text.charCodeAt(0) === 0xfeff) return { verify: "fail", step: "format" };
  const parsed = refParseStrict(text);
  if (!parsed.ok || !isObj(parsed.value))
    return { verify: "fail", step: "format" };
  const m = parsed.value as Record<string, unknown>;
  if (m.format !== "pkey-marker/1") return { verify: "fail", step: "format" };
  if (!refPackIdShape(m.packId) || m.packId === "app")
    return { verify: "fail", step: "format" };
  if (typeof m.version !== "string" || !REF_RECORD_VERSION_RE.test(m.version))
    return { verify: "fail", step: "format" };
  if (typeof m.release !== "string") return { verify: "fail", step: "format" };
  const body = m.release;
  const r = refRecordSteps(
    body,
    utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body)
      ? ""
      : sha256Hex(body),
    c.releaseKeys,
    c.productTrust,
    c.expectedAud,
  );
  if (!r.ok) return { verify: "fail", step: r.step };
  if (
    r.doc.kind !== "pack" ||
    r.doc.deliverable !== m.packId ||
    r.doc.version !== m.version
  )
    return { verify: "fail", step: "cross-check" };
  return {
    verify: "ok",
    packId: m.packId,
    version: m.version,
    recordSha256: sha256Hex(body),
  };
}

async function buildMarkerCases(): Promise<MarkerCase[]> {
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const packs = await packRecords();
  const LV2 = packs.get("djdl.levels@1.1.0")!;
  const AS2 = packs.get("djdl.assets@1.1.0")!;
  const DOC1 = packs.get("djdl.docs@1.0.0")!;
  const cases: MarkerCase[] = [];
  const marker = (o: Record<string, unknown>): string => JSON.stringify(o);
  const of = (r: RecordVector, over: Record<string, unknown> = {}): string =>
    marker({
      format: "pkey-marker/1",
      packId: r.doc.deliverable,
      version: r.doc.version,
      release: r.jws,
      ...over,
    });
  const mk = (
    id: string,
    description: string,
    text: string,
    expect: MarkerCase["expect"],
    releaseKeys: Record<string, string> = RK,
  ): void => {
    const c: MarkerCase = {
      id,
      description,
      marker: text,
      releaseKeys,
      productTrust: PT,
      expectedAud: AUD_V3,
      expect,
    };
    const release = markerRelease(text);
    let nonWire: string[] = [];
    if (release !== null) {
      const parts = release.split(".");
      let kid: unknown;
      try {
        kid = (
          JSON.parse(
            new TextDecoder().decode(base64UrlDecode(parts[0] ?? "")),
          ) as Record<string, unknown>
        ).kid;
      } catch {
        kid = undefined;
      }
      const v =
        typeof kid === "string" && hasOwn(releaseKeys, kid)
          ? refVerifyJws(
              release,
              { [kid]: releaseKeys[kid]! },
              "pkey-release+jws",
            )
          : null;
      if (v) nonWire = refNonWire(v.text);
    }
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const okOf = (r: RecordVector): MarkerCase["expect"] => ({
    verify: "ok",
    packId: r.doc.deliverable as string,
    version: r.doc.version as string,
    recordSha256: r.sha256,
  });
  const fail = (
    step: "format" | "hash" | "jws" | "claims" | "cross-check",
  ): MarkerCase["expect"] => ({ verify: "fail", step });

  mk(
    "marker-valid",
    "`djdl.levels.pck.pkey.json`: the marker beside a single-file payload, carrying `djdl.levels@1.1.0`.",
    of(LV2),
    okOf(LV2),
  );
  mk(
    "marker-valid-tree",
    "`.pkey/pack.json` inside a tree, carrying `djdl.assets@1.1.0`.",
    of(AS2),
    okOf(AS2),
  );
  {
    const jws = await signAs(DOC1.doc, REL2_KID, "pkey-release+jws");
    const r = { ...DOC1, jws, sha256: sha256Hex(jws) };
    mk(
      "marker-valid-rotation-second-key",
      "A marker whose record is signed by the 2027 release key while both are pinned.",
      of(r),
      okOf(r),
      { ...RK, [REL2_KID]: pub(REL2_KID) },
    );
  }
  mk(
    "marker-not-object",
    "Step 1: the marker is a JSON array.",
    "[]",
    fail("format"),
  );
  mk(
    "marker-duplicate-member",
    "Step 1: strict JSON refuses a marker that declares `version` twice.",
    of(LV2).replace('"version":"1.1.0"', '"version":"1.1.0","version":"1.0.0"'),
    fail("format"),
  );
  mk(
    "marker-leading-bom",
    "Step 1: a leading byte-order mark.",
    `\ufeff${of(LV2)}`,
    fail("format"),
  );
  mk(
    "marker-format-unknown",
    "Step 2: `format: pkey-marker/2`.",
    of(LV2, { format: "pkey-marker/2" }),
    fail("format"),
  );
  mk(
    "marker-pack-id-bad",
    "Step 2: `packId` outside the pack-id pattern.",
    of(LV2, { packId: "djdl.Levels" }),
    fail("format"),
  );
  mk(
    "marker-release-not-string",
    "Step 2: `release` is an object.",
    of(LV2, { release: { jws: LV2.jws } }),
    fail("format"),
  );
  {
    const [h, p, s] = LV2.jws.split(".") as [string, string, string];
    const padded = `${h}.${p}${"A".repeat(88845 - LV2.jws.length)}.${s}`;
    if (padded.length !== 88845)
      throw new Error("marker-release-over-bound length");
    mk(
      "marker-release-over-bound",
      "Step 3: a `release` of 88,845 ASCII bytes, one over the bound, refused before hashing.",
      of(LV2, { release: padded }),
      fail("hash"),
    );
  }
  mk(
    "marker-release-non-ascii",
    "Step 3: a `release` with a byte outside ASCII, refused before hashing.",
    of(LV2, { release: `${LV2.jws}é` }),
    fail("hash"),
  );
  {
    const jws = await signAs(LV2.doc, PIN_KID, "pkey-release+jws");
    mk(
      "marker-signed-by-product-key",
      "Step 3: the record is signed by the PRODUCT key, whose kid is not a pinned release key.",
      of(LV2, { release: jws }),
      fail("jws"),
    );
  }
  mk(
    "marker-key-dropped",
    "Step 3: the record is signed by the 2026 key after it left the pinned set.",
    of(LV2),
    fail("jws"),
    { [REL2_KID]: pub(REL2_KID) },
  );
  {
    const jws = await signAs(
      { ...LV2.doc, type: "godot" },
      REL_KID,
      "pkey-release+jws",
    );
    mk(
      "marker-record-claims",
      'Step 3: the record fails the pack claims (`type: "godot"`).',
      of(LV2, { release: jws }),
      fail("claims"),
    );
  }
  mk(
    "marker-pack-id-mismatch",
    "Step 4: the marker names `djdl.assets`, the record `djdl.levels`.",
    of(LV2, { packId: "djdl.assets" }),
    fail("cross-check"),
  );
  mk(
    "marker-version-mismatch",
    "Step 4: the marker names 1.0.0, the record 1.1.0.",
    of(LV2, { version: "1.0.0" }),
    fail("cross-check"),
  );
  {
    const jws = await signAs(appTwin(packs), REL_KID, "pkey-release+jws");
    mk(
      "marker-record-is-app",
      "Step 4: the record is a valid app record, not a pack record.",
      of(LV2, { release: jws, packId: "djdl.levels", version: "1.5.0" }),
      fail("cross-check"),
    );
  }

  if (cases.length !== 17)
    throw new Error(`markerCases: ${cases.length} != 17`);
  for (const c of cases) {
    const want = refVerifyMarkerCase(c);
    if (JSON.stringify(want) !== JSON.stringify(c.expect))
      throw new Error(
        `markerCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
  }
  return cases;
}

/** §4.2's per-check self-check: the registry is §4.6's table, every registered id has a case,
 *  and every structure case breaks its one property and is refused by its check alone. */
function checkPackClaimCases(corpus: Record<string, AnyCase[]>): void {
  const fail = (m: string): never => {
    throw new Error(`packRecordCases self-check: ${m}`);
  };
  if (PACK_CLAIM_CHECKS.length !== 83 || PACK_CHECK_SET.size !== 83)
    fail("the registry must hold 83 distinct checks");
  const byId = new Map(corpus.packRecordCases!.map((c) => [c.id as string, c]));
  const covered = new Set<string>();
  for (const [id, s] of PACK_STRUCTURE) {
    const c = byId.get(id) ?? fail(`${id} is not a packRecordCases case`);
    covered.add(s.check);
    const text = payloadTextOf(c.jws)!;
    const doc = JSON.parse(text) as unknown;
    const diff = leafDiff(s.twin, doc);
    if (diff.length === 0) fail(`${id} equals its twin`);
    for (const p of diff)
      if (p !== s.prop && !p.startsWith(`${s.prop}/`))
        fail(`${id} differs from its twin at ${p}, outside ${s.prop}`);
    if (!refRecordClaims(s.twin, ctxOf(JSON.stringify(s.twin)), AUD_V3))
      fail(`${id}'s twin fails the claims`);
    if (refRecordClaims(doc, ctxOf(text), AUD_V3))
      fail(`${id}: the claims accept it`);
    if (!refRecordClaims(doc, ctxOf(text, [`check:${s.check}`]), AUD_V3))
      fail(`${id}: it fails beyond check ${s.check}`);
  }
  for (const id of PACK_CLAIM_CHECKS)
    if (!covered.has(id)) fail(`check ${id} has no case`);
  if (PACK_STRUCTURE.size !== 95)
    fail(`${PACK_STRUCTURE.size} structure cases, not 95`);
  if (PACK_PER_CLAIM.length !== 18)
    fail(`${PACK_PER_CLAIM.length} integer paths, not 18`);
  // plans/P4-10.md §4.2: pack-valid-chunks' `chunks` ref is `chunks/v2.pkc.zst`'s (the join).
  {
    const want = objRef("chunks/v2.pkc.zst");
    const l3 = PACK_RECORDS!.get("djdl.levels@1.2.0")!.doc;
    for (const v of l3.variants as Record<string, any>[]) {
      const c = v.chunks as Record<string, unknown>;
      for (const k of ["sha256", "bytes", "size", "codec"])
        if (c[k] !== want[k])
          fail(`djdl.levels@1.2.0's chunks.${k} is not chunks/v2.pkc.zst's`);
    }
  }
  // The valid pack records pin only §4.2's table.
  for (const r of PACK_RECORDS!.values()) {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) {
        if (typeof v.sha256 === "string" && typeof v.bytes === "number")
          refs.push(v.sha256);
        Object.values(v).forEach(walk);
      }
    };
    walk(r.doc.variants);
    for (const h of refs)
      if (!packObjectHashes().has(h))
        fail(`${r.name} pins ${h}, outside the object table`);
  }
}

// ── plans/P4-13.md: content members, revocations, holds and the content decision ────────────
// The generator's own references (it imports nothing it checks): `refFeedContent` (§2.2),
// `refRevocationOf` and the revocation verifier (§2.3), `refHoldsOf` (§2.4) and the content
// decision (§2.6), plus the fixtures of `feedContentCases`, `revocationCases`, the three appended
// `feedCases` and `update-matrix.json#/contentRows`.

const refCmpBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const refPackId = (v: unknown): v is string => refPackIdShape(v) && v !== "app";
const P13_SCHEMES: readonly string[] = REF_SCHEMES;
const P13_REASON_MAX = 512;

/** A content integer member (V4 §3.1's token rule, read from the payload's own tokens). */
function p13Int(
  ctx: ClaimCtx | null,
  v: unknown,
  pointer: string,
  min: number,
  max = MAX_WIRE_INTEGER_REF,
): v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return false;
  if (ctx !== null) {
    const t = ctx.tokens.get(pointer);
    if (t === undefined || !PLAIN_INTEGER_REF.test(t)) return false;
  }
  return v >= min && v <= max;
}

/** `packSetId` (plans/P4-01.md §2.9), from first principles. */
function refPackSetId(entries: [pack: string, sha256: string][]): string {
  const text = [...entries]
    .sort((a, b) => refCmpBytes(a[0], b[0]))
    .map(([p, h]) => `${p} ${h}\n`)
    .join("");
  return sha256Hex(text);
}

const refVariantKey = (v: Record<string, string>): string =>
  Object.keys(v)
    .sort(refCmpBytes)
    .map((k) => `${k}=${v[k]}`)
    .join(";");

/** §2.2's table, member by member; each returns the parsed member or null. */
function refFeedContent(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): { packSets: unknown; packFloors: unknown; revocations: unknown } {
  const packSets = ((): unknown => {
    if (!hasOwn(doc, "packSets")) return null;
    const ps = doc.packSets;
    if (!isObj(ps)) return null;
    for (const k of ["releases", "sets", "rows"])
      if (!hasOwn(ps, k)) return null;
    if (!isObj(ps.releases) || !isObj(ps.sets) || !Array.isArray(ps.rows))
      return null;
    const releases: Record<string, unknown> = {};
    for (const h of Object.keys(ps.releases)) {
      const r = ps.releases[h];
      if (!REF_SHA256_RE.test(h) || !isObj(r)) return null;
      if (!refPackId(r.pack)) return null;
      if (
        typeof r.version !== "string" ||
        !REF_RECORD_VERSION_RE.test(r.version)
      )
        return null;
      if (!p13Int(ctx, r.seq, `/packSets/releases/${h}/seq`, 1)) return null;
      releases[h] = { pack: r.pack, version: r.version, seq: r.seq };
    }
    const sets: Record<string, string[]> = {};
    for (const id of Object.keys(ps.sets)) {
      const m = ps.sets[id];
      if (!REF_SHA256_RE.test(id) || !Array.isArray(m)) return null;
      const seen: string[] = [];
      for (const h of m) {
        if (typeof h !== "string" || !hasOwn(releases, h)) return null;
        const pack = (releases[h] as { pack: string }).pack;
        if (seen.includes(pack)) return null;
        seen.push(pack);
      }
      sets[id] = [...m];
    }
    const sel = isObj(doc.selector) ? doc.selector : {};
    const rows: unknown[] = [];
    const keys = new Set<string>();
    for (const [i, r] of ps.rows.entries()) {
      if (!isObj(r)) return null;
      if (!p13Int(ctx, r.contentApi, `/packSets/rows/${i}/contentApi`, 1))
        return null;
      if (
        typeof r.platform !== "string" ||
        !REF_FEED_PLATFORM_RE.test(r.platform)
      )
        return null;
      if (hasOwn(sel, "platform") && r.platform !== sel.platform) return null;
      if (
        typeof r.engine !== "string" ||
        (r.engine !== "" && !REF_ENGINE_RE.test(r.engine))
      )
        return null;
      if (!isObj(r.variant) || Object.keys(r.variant).length > 4) return null;
      const variant: Record<string, string> = {};
      for (const [a, x] of Object.entries(r.variant)) {
        if (!REF_AXIS_RE.test(a)) return null;
        if (typeof x !== "string" || !REF_AXIS_VALUE_RE.test(x)) return null;
        variant[a] = x;
      }
      if (typeof r.set !== "string" || !hasOwn(sets, r.set)) return null;
      const key = `${r.contentApi}|${r.platform}|${r.engine}|${refVariantKey(variant)}`;
      if (keys.has(key)) return null;
      keys.add(key);
      rows.push({
        contentApi: r.contentApi,
        platform: r.platform,
        engine: r.engine,
        variant,
        set: r.set,
      });
    }
    const out: Record<string, unknown> = { releases, sets, rows };
    if (hasOwn(ps, "outlets")) {
      if (!isObj(ps.outlets)) return null;
      const outlets: Record<string, unknown> = {};
      for (const id of Object.keys(ps.outlets)) {
        const e = ps.outlets[id];
        if (!REF_OUTLET_ID_RE.test(id) || !isObj(e)) return null;
        const o: Record<string, unknown> = {};
        if (hasOwn(e, "pinned")) {
          if (!Array.isArray(e.pinned)) return null;
          if (!e.pinned.every(refPackId)) return null;
          if (new Set(e.pinned).size !== e.pinned.length) return null;
          o.pinned = [...e.pinned];
        }
        if (hasOwn(e, "gates")) {
          if (!isObj(e.gates)) return null;
          const gates: Record<string, unknown> = {};
          for (const h of Object.keys(e.gates)) {
            const g = e.gates[h];
            if (!hasOwn(releases, h) || !isObj(g)) return null;
            if (typeof g.halted !== "boolean") return null;
            const gate: Record<string, unknown> = { halted: g.halted };
            if (hasOwn(g, "rollout")) {
              const ro = g.rollout;
              if (!isObj(ro)) return null;
              const at = `/packSets/outlets/${pointerToken(id)}/gates/${h}/rollout/bp`;
              if (!p13Int(ctx, ro.bp, at, 0, 10000)) return null;
              if (typeof ro.salt !== "string" || !REF_SALT_RE.test(ro.salt))
                return null;
              gate.rollout = { bp: ro.bp, salt: ro.salt };
            }
            if (!hasOwn(g, "fallback")) return null;
            if (
              g.fallback !== null &&
              !(typeof g.fallback === "string" && hasOwn(releases, g.fallback))
            )
              return null;
            gate.fallback = g.fallback;
            gates[h] = gate;
          }
          o.gates = gates;
        }
        outlets[id] = o;
      }
      out.outlets = outlets;
    }
    return out;
  })();

  const packFloors = ((): unknown => {
    if (!hasOwn(doc, "packFloors")) return null;
    const fs = doc.packFloors;
    if (!Array.isArray(fs)) return null;
    const out: unknown[] = [];
    const keys = new Set<string>();
    for (const [i, f] of fs.entries()) {
      if (!isObj(f) || !refPackId(f.pack)) return null;
      if (!p13Int(ctx, f.contentApi, `/packFloors/${i}/contentApi`, 1))
        return null;
      if (
        typeof f.minVersion !== "string" ||
        !REF_RECORD_VERSION_RE.test(f.minVersion)
      )
        return null;
      if (typeof f.versionScheme !== "string") return null;
      const key = `${f.pack}|${f.contentApi}`;
      if (keys.has(key)) return null;
      keys.add(key);
      if (P13_SCHEMES.includes(f.versionScheme))
        out.push({
          pack: f.pack,
          contentApi: f.contentApi,
          minVersion: f.minVersion,
          versionScheme: f.versionScheme,
        });
    }
    return out;
  })();

  const revocations = ((): unknown => {
    if (!hasOwn(doc, "revocations")) return null;
    const rs = doc.revocations;
    if (!Array.isArray(rs)) return null;
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const [i, r] of rs.entries()) {
      if (!isObj(r)) return null;
      if (!refHex64(r.record) || !refPackId(r.pack) || !refHex64(r.target))
        return null;
      if (
        typeof r.version !== "string" ||
        !REF_RECORD_VERSION_RE.test(r.version)
      )
        return null;
      if (!p13Int(ctx, r.seq, `/revocations/${i}/seq`, 1)) return null;
      if (seen.has(r.record as string)) return null;
      seen.add(r.record as string);
      // plans/P4-19.md §2.7: `kind` absent or `delegation`; another vocabulary token drops the
      // entry alone; anything else makes the member unusable.
      if (hasOwn(r, "kind")) {
        if (typeof r.kind !== "string" || !REF_VOCAB_RE.test(r.kind))
          return null;
        if (r.kind !== "delegation") continue;
      }
      out.push({
        record: r.record,
        pack: r.pack,
        target: r.target,
        version: r.version,
        seq: r.seq,
        ...(hasOwn(r, "kind") ? { kind: r.kind } : {}),
      });
    }
    return out;
  })();

  return { packSets, packFloors, revocations };
}

/** §2.3: the revocation body, or null. */
function refRevocationOf(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown> | null {
  if (doc.kind !== "revocation" || !refPackId(doc.deliverable)) return null;
  if (!refHex64(doc.revokes)) return null;
  let replacement: Record<string, unknown> | null = null;
  if (hasOwn(doc, "replacement")) {
    const r = doc.replacement;
    if (!isObj(r) || !refHex64(r.sha256) || r.sha256 === doc.revokes)
      return null;
    if (!p13Int(ctx, r.seq, "/replacement/seq", 1)) return null;
    if (typeof r.version !== "string" || !REF_RECORD_VERSION_RE.test(r.version))
      return null;
    replacement = { sha256: r.sha256, seq: r.seq, version: r.version };
  }
  if (typeof doc.reason !== "string") return null;
  const n = utf8Bytes(doc.reason).length;
  if (n < 1 || n > P13_REASON_MAX) return null;
  return {
    pack: doc.deliverable,
    target: doc.revokes,
    replacement,
    reason: doc.reason,
    issuedAt: doc.issuedAt,
  };
}

/** §2.4: the holds of a `content` object at `at`, or null when unusable. */
function refHoldsOf(
  c: Record<string, any>,
  ctx: ClaimCtx | null,
  at: string,
): unknown[] | null {
  if (!hasOwn(c, "holds")) return [];
  const hs = c.holds;
  if (!Array.isArray(hs) || hs.length > 256) return null;
  const pinned = new Set(
    (Array.isArray(c.pins) ? c.pins : []).map((p: any) => p?.pack),
  );
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const [i, h] of hs.entries()) {
    if (!isObj(h) || !refPackId(h.pack)) return null;
    if (seen.has(h.pack) || pinned.has(h.pack)) return null;
    seen.add(h.pack);
    const r = h.release;
    if (!isObj(r) || !refHex64(r.sha256)) return null;
    if (!p13Int(ctx, r.seq, `${at}/holds/${i}/release/seq`, 1)) return null;
    if (typeof r.version !== "string" || !REF_RECORD_VERSION_RE.test(r.version))
      return null;
    if (hasOwn(h, "reason") && typeof h.reason !== "string") return null;
    out.push({
      pack: h.pack,
      release: { sha256: r.sha256, seq: r.seq, version: r.version },
      ...(hasOwn(h, "reason") ? { reason: h.reason } : {}),
    });
  }
  return out;
}

// ── The content fixture (CONTENT §6.8, Diceroll) ─────────────────────────────────────────────

/** The pack releases every P4-13 vector names, by short name: [pack, version, seq]. */
const P13_RELEASES: Record<string, [string, string, number]> = {
  "foes@1.3.3": ["diceroll.foes", "1.3.3", 10],
  "foes@1.3.4": ["diceroll.foes", "1.3.4", 11],
  "foes@2.0.0": ["diceroll.foes", "2.0.0", 20],
  "foes@2.0.1": ["diceroll.foes", "2.0.1", 21],
  "foes@2.0.2": ["diceroll.foes", "2.0.2", 22],
  "l10n@1.0.0": ["diceroll.l10n", "1.0.0", 1],
  "l10n@1.1.0": ["diceroll.l10n", "1.1.0", 2],
  "tex@1.0.0": ["diceroll.textures", "1.0.0", 1],
  "tex@1.1.0": ["diceroll.textures", "1.1.0", 2],
  "skins@1.0.0": ["diceroll.skins", "1.0.0", 1],
};
const p13Rel = (name: string): [string, string, number] => {
  const r = P13_RELEASES[name];
  if (!r) throw new Error(`P4-13 fixture: no release ${name}`);
  return r;
};
const p13Hash = (name: string): string => {
  const [pack, version] = p13Rel(name);
  return sha256Hex(`pkey-corpus-pack:${pack}@${version}`);
};
const p13Pin = (name: string): Record<string, unknown> => {
  const [, version, seq] = p13Rel(name);
  return { sha256: p13Hash(name), seq, version };
};
const p13PackOf = (name: string): string => p13Rel(name)[0];
/** A revocation record's hash in the decision fixtures (a record the rows never sign). */
const p13RevRecord = (name: string, n = 1): string =>
  sha256Hex(`pkey-corpus-revocation:${name}:${n}`);

type P13Row = [
  contentApi: number,
  platform: string,
  engine: string,
  variant: Record<string, string>,
  members: string[],
];

/** `packSets` from rows of release names: the release table, the sets keyed by `packSetId`. */
function p13PackSets(
  rows: P13Row[],
  outlets?: Record<string, unknown>,
): Record<string, any> {
  const names = [...new Set(rows.flatMap((r) => r[4]))];
  const releases: Record<string, unknown> = {};
  for (const n of [...names].sort((a, b) =>
    refCmpBytes(p13Hash(a), p13Hash(b)),
  )) {
    const [pack, version, seq] = p13Rel(n);
    releases[p13Hash(n)] = { pack, version, seq };
  }
  const sets: Record<string, string[]> = {};
  const outRows = rows.map(
    ([contentApi, platform, engine, variant, members]) => {
      const sorted = [...members].sort((a, b) =>
        refCmpBytes(p13PackOf(a), p13PackOf(b)),
      );
      const id = refPackSetId(sorted.map((m) => [p13PackOf(m), p13Hash(m)]));
      sets[id] = sorted.map(p13Hash);
      return { contentApi, platform, engine, variant, set: id };
    },
  );
  return {
    releases,
    sets,
    rows: outRows,
    ...(outlets ? { outlets } : {}),
  };
}

/**
 * plans/P4-29.md §2.2: the delta menu, from first principles. Null when absent or unusable;
 * otherwise target → the kept `payload` entries (known members only). Both caps and both
 * uniqueness rules count dropped entries too.
 */
const P29_MAX_FEED_DELTAS = 64;
const P29_MAX_PER_TARGET = 4;
function refFeedDeltas(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown[]> | null {
  if (!hasOwn(doc, "deltas")) return null;
  const m = doc.deltas;
  if (!isObj(m)) return null;
  const out: Record<string, unknown[]> = {};
  const artifacts: string[] = [];
  let total = 0;
  for (const to of Object.keys(m)) {
    if (!REF_SHA256_RE.test(to)) return null;
    const list = m[to];
    if (!Array.isArray(list)) return null;
    if (list.length < 1 || list.length > P29_MAX_PER_TARGET) return null;
    total += list.length;
    if (total > P29_MAX_FEED_DELTAS) return null;
    const pairs: string[] = [];
    const kept: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isObj(e)) return null;
      if (typeof e.from !== "string" || !REF_SHA256_RE.test(e.from))
        return null;
      if (e.from === to) return null;
      if (typeof e.method !== "string" || !REF_VOCAB_RE.test(e.method))
        return null;
      if (typeof e.scope !== "string" || !REF_VOCAB_RE.test(e.scope))
        return null;
      if (!p13Int(ctx, e.memBytes, `/deltas/${to}/${i}/memBytes`, 1))
        return null;
      const a = e.artifact;
      if (!isObj(a)) return null;
      if (typeof a.sha256 !== "string" || !REF_SHA256_RE.test(a.sha256))
        return null;
      if (!p13Int(ctx, a.bytes, `/deltas/${to}/${i}/artifact/bytes`, 1))
        return null;
      if (artifacts.includes(a.sha256)) return null;
      artifacts.push(a.sha256);
      const pair = `${e.from} ${e.method}`;
      if (pairs.includes(pair)) return null;
      pairs.push(pair);
      if (e.scope !== "payload") continue;
      kept.push({
        from: e.from,
        method: e.method,
        scope: "payload",
        memBytes: e.memBytes,
        artifact: { sha256: a.sha256, bytes: a.bytes },
      });
    }
    if (kept.length > 0) out[to] = kept;
  }
  return out;
}

const P13_SALT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** The `feedContentCases` base: FC's two platforms. */
function p13FeedMembers(): Record<string, unknown> {
  return {
    packSets: p13PackSets(
      [
        [3, "macos", "godot-4.4", {}, ["foes@1.3.4", "l10n@1.1.0"]],
        [4, "macos", "godot-4.4", {}, ["foes@2.0.1", "l10n@1.1.0"]],
        [4, "macos", "godot-4.4", { texture: "astc" }, ["tex@1.1.0"]],
        [4, "macos", "godot-4.4", { texture: "etc2" }, ["tex@1.0.0"]],
        [4, "windows", "", {}, ["foes@2.0.1", "l10n@1.1.0"]],
      ],
      {
        steam: { pinned: ["diceroll.foes"] },
        direct: {
          gates: {
            [p13Hash("foes@2.0.1")]: {
              halted: false,
              rollout: { bp: 2500, salt: P13_SALT },
              fallback: null,
            },
            [p13Hash("tex@1.1.0")]: {
              halted: true,
              fallback: p13Hash("tex@1.0.0"),
            },
          },
        },
      },
    ),
    packFloors: [
      {
        pack: "diceroll.foes",
        contentApi: 3,
        minVersion: "1.3.4",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.foes",
        contentApi: 4,
        minVersion: "2.0.0",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.l10n",
        contentApi: 4,
        minVersion: "1.0.0",
        versionScheme: "semver",
      },
    ],
    revocations: [
      {
        record: p13RevRecord("foes@1.3.3"),
        pack: "diceroll.foes",
        target: p13Hash("foes@1.3.3"),
        version: "1.3.3",
        seq: 10,
      },
    ],
  };
}

// ── `feedContentCases` (plans/P4-13.md §4.2) ─────────────────────────────────────────────────

interface FeedContentCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  nonWireIntegers?: string[];
  expect: {
    verify: "ok";
    content: { packSets: unknown; packFloors: unknown; revocations: unknown };
    /** plans/P4-29.md §4.1: the delta menu, on the appended cases only (absent means null). */
    deltas?: unknown;
  };
}

async function buildFeedContentCases(): Promise<FeedContentCase[]> {
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const base = { ...feedPayload(), ...p13FeedMembers() };
  const cases: FeedContentCase[] = [];
  const baseContent = refFeedContent(base, null);
  type Patch = (d: Record<string, any>) => void;
  const mk = async (
    id: string,
    description: string,
    o: {
      patch?: Patch;
      raw?: boolean;
      /** The members (pointer prefixes) the mutation may touch. */
      props: string[];
      /** Which parsed members must differ from the base's (the rest must equal it). */
      changes: ("packSets" | "packFloors" | "revocations")[];
      /** plans/P4-29.md §4.2: an appended case, and whether its menu is usable. */
      deltas?: "usable" | "unusable";
    },
  ): Promise<void> => {
    const doc = structuredClone(base) as Record<string, any>;
    o.patch?.(doc);
    const text = o.raw ? rawJson(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText("pkey-feed+jws", PIN_KID),
      text,
      PIN_KID,
    );
    // Every case is a valid feed: the claims never see the content members.
    const v = refVerifyJws(jws, TRUST, "pkey-feed+jws");
    if (!v) throw new Error(`feedContentCases ${id}: does not verify`);
    if (
      refFeedClaims(v.payload, ctxOf(v.text), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      throw new Error(`feedContentCases ${id}: fails the feed claims`);
    const content = refFeedContent(v.payload, ctxOf(v.text));
    // The mutation changes only its members.
    const parsedBack = JSON.parse(text) as unknown;
    const diff = leafDiff(base, parsedBack);
    if (
      o.patch &&
      (diff.length === 0 && !o.raw
        ? true
        : !diff.every((p) =>
            o.props.some((q) => p === q || p.startsWith(`${q}/`)),
          ))
    )
      throw new Error(
        `feedContentCases ${id}: differs outside ${o.props.join(", ")}: ${diff.join(", ")}`,
      );
    for (const m of ["packSets", "packFloors", "revocations"] as const) {
      const same =
        JSON.stringify(content[m]) === JSON.stringify(baseContent[m]);
      if (o.changes.includes(m) === same)
        throw new Error(
          `feedContentCases ${id}: ${m} ${same ? "unchanged" : "changed"}`,
        );
    }
    // plans/P4-29.md §4.1: an older case carries no menu; an appended one pins its own.
    const deltas = refFeedDeltas(v.payload, ctxOf(v.text));
    if (
      o.deltas === undefined
        ? deltas !== null
        : (deltas === null) !== (o.deltas === "unusable")
    )
      throw new Error(
        `feedContentCases ${id}: deltas ${deltas === null ? "null" : "usable"}`,
      );
    const nonWire = refNonWire(v.text);
    const c: FeedContentCase = {
      id,
      description,
      jws,
      trust: TRUST,
      expectedAud: AUD_V3,
      channel: "stable",
      platform: "macos",
      now: FEED_NOW,
      checkFreshness: true,
      expect: {
        verify: "ok",
        content,
        ...(o.deltas !== undefined ? { deltas } : {}),
      },
    };
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ps = (d: Record<string, any>): Record<string, any> => d.packSets;
  const h = p13Hash;
  const gateBp = `/packSets/outlets/direct/gates/${h("foes@2.0.1")}/rollout/bp`;

  // Valid.
  await mk(
    "feed-content-valid",
    'The base: FC with all three content members (two platforms, an axis-less group and a texture group, an `engine: ""` row, a narrowed outlet, two gates, three floors and one revocation).',
    { props: [], changes: [] },
  );
  await mk("feed-content-valid-pack-sets-alone", "Only `packSets`.", {
    patch: (d) => {
      delete d.packFloors;
      delete d.revocations;
    },
    props: ["/packFloors", "/revocations"],
    changes: ["packFloors", "revocations"],
  });
  await mk("feed-content-valid-pack-floors-alone", "Only `packFloors`.", {
    patch: (d) => {
      delete d.packSets;
      delete d.revocations;
    },
    props: ["/packSets", "/revocations"],
    changes: ["packSets", "revocations"],
  });
  await mk("feed-content-valid-revocations-alone", "Only `revocations`.", {
    patch: (d) => {
      delete d.packSets;
      delete d.packFloors;
    },
    props: ["/packSets", "/packFloors"],
    changes: ["packSets", "packFloors"],
  });
  await mk(
    "feed-content-valid-absent",
    "No content member: all three parse as null (a feed from a Worker before P4-13).",
    {
      patch: (d) => {
        delete d.packSets;
        delete d.packFloors;
        delete d.revocations;
      },
      props: ["/packSets", "/packFloors", "/revocations"],
      changes: ["packSets", "packFloors", "revocations"],
    },
  );
  await mk(
    "feed-content-valid-unknown-members-ignored",
    "An unknown member at every level of every content member is ignored, and the parsed members carry the known ones only.",
    {
      patch: (d) => {
        ps(d).later = 1;
        ps(d).releases[h("foes@2.0.1")].later = 1;
        ps(d).rows[0].later = "x";
        ps(d).outlets.steam.later = true;
        ps(d).outlets.direct.gates[h("tex@1.1.0")].later = {};
        d.packFloors[0].later = 1;
        d.revocations[0].later = 1;
      },
      props: ["/packSets", "/packFloors", "/revocations"],
      changes: [],
    },
  );
  await mk(
    "feed-content-valid-floor-unknown-scheme",
    "A floor with a forward `versionScheme` (`calver`) is dropped alone; the others stay in force.",
    {
      patch: (d) => void (d.packFloors[2].versionScheme = "calver"),
      props: ["/packFloors/2/versionScheme"],
      changes: ["packFloors"],
    },
  );
  await mk(
    "feed-content-valid-empty-set",
    "A row whose set is empty (every pack of that group unsatisfied).",
    {
      patch: (d) => {
        const empty = refPackSetId([]);
        ps(d).sets[empty] = [];
        ps(d).rows[2].set = empty;
      },
      props: ["/packSets/sets", "/packSets/rows/2/set"],
      changes: ["packSets"],
    },
  );
  await mk(
    "feed-content-valid-engine-empty-rows",
    'Every row with `engine: ""` (builds that declared no engine).',
    {
      patch: (d) => {
        for (const r of ps(d).rows) r.engine = "";
      },
      props: ["/packSets/rows"],
      changes: ["packSets"],
    },
  );

  // Unusable `packSets`.
  const bad = async (
    id: string,
    description: string,
    patch: Patch,
    props: string[],
    member: "packSets" | "packFloors" | "revocations" = "packSets",
    raw = false,
  ): Promise<void> =>
    mk(id, description, { patch, props, changes: [member], raw });
  await bad(
    "feed-content-pack-sets-not-object",
    "`packSets` is a string.",
    (d) => void (d.packSets = "sets"),
    ["/packSets"],
  );
  await bad(
    "feed-content-pack-sets-array",
    "`packSets: []`, the shape `feed-valid-unknown-fields-ignored` carries: unusable, never a refusal.",
    (d) => void (d.packSets = []),
    ["/packSets"],
  );
  for (const k of ["releases", "sets", "rows"])
    await bad(
      `feed-content-pack-sets-${k}-missing`,
      `\`packSets\` without \`${k}\`.`,
      (d) => void delete ps(d)[k],
      [`/packSets/${k}`],
    );
  await bad(
    "feed-content-release-key-uppercase",
    "A `releases` key in uppercase hex.",
    (d) => {
      const r = ps(d).releases;
      const k = h("skins@1.0.0").toUpperCase();
      r[k] = { pack: "diceroll.skins", version: "1.0.0", seq: 1 };
    },
    ["/packSets/releases"],
  );
  await bad(
    "feed-content-release-pack-app",
    "A release whose `pack` is `app` (not a pack id).",
    (d) => void (ps(d).releases[h("l10n@1.1.0")].pack = "app"),
    [`/packSets/releases/${h("l10n@1.1.0")}/pack`],
  );
  await bad(
    "feed-content-release-version-bad",
    "A release `version` with a space.",
    (d) => void (ps(d).releases[h("l10n@1.1.0")].version = "1.1 .0"),
    [`/packSets/releases/${h("l10n@1.1.0")}/version`],
  );
  await bad(
    "feed-content-release-seq-string",
    'A release `seq` of `"2"`.',
    (d) => void (ps(d).releases[h("l10n@1.1.0")].seq = "2"),
    [`/packSets/releases/${h("l10n@1.1.0")}/seq`],
  );
  await bad(
    "feed-content-set-unknown-release",
    "A set names a hash that is not in `releases`.",
    (d) => {
      const id = ps(d).rows[2].set;
      ps(d).sets[id] = [...ps(d).sets[id], h("skins@1.0.0")];
    },
    ["/packSets/sets"],
  );
  await bad(
    "feed-content-set-pack-twice",
    "A set names two releases of one pack.",
    (d) => {
      const id = ps(d).rows[2].set;
      ps(d).sets[id] = [h("tex@1.1.0"), h("tex@1.0.0")];
    },
    ["/packSets/sets"],
  );
  await bad(
    "feed-content-row-content-api-string",
    'A row `contentApi` of `"4"`.',
    (d) => void (ps(d).rows[1].contentApi = "4"),
    ["/packSets/rows/1/contentApi"],
  );
  await bad(
    "feed-content-row-platform-bad",
    "A row platform with an uppercase letter.",
    (d) => void (ps(d).rows[1].platform = "macOS"),
    ["/packSets/rows/1/platform"],
  );
  await bad(
    "feed-content-row-engine-bad",
    "A row engine that is neither empty nor `godot-<major>.<minor>`.",
    (d) => void (ps(d).rows[1].engine = "godot-4"),
    ["/packSets/rows/1/engine"],
  );
  await bad(
    "feed-content-row-variant-five-axes",
    "A row variant with five members.",
    (d) =>
      void (ps(d).rows[2].variant = {
        texture: "astc",
        locale: "fr",
        quality: "hd",
        size: "l",
        tier: "a",
      }),
    ["/packSets/rows/2/variant"],
  );
  await bad(
    "feed-content-row-set-unknown",
    "A row names a set that is not in `sets`.",
    (d) => void (ps(d).rows[1].set = h("skins@1.0.0")),
    ["/packSets/rows/1/set"],
  );
  await bad(
    "feed-content-row-duplicate-key",
    "Two rows with the same (contentApi, platform, engine, variant).",
    (d) => void (ps(d).rows[3].variant = { texture: "astc" }),
    ["/packSets/rows/3/variant"],
  );
  await bad(
    "feed-content-row-platform-not-selector",
    "A per-platform feed (`selector {platform: macos}`) whose `packSets` keeps a windows row.",
    (d) => {
      d.selector = { platform: "macos" };
      d.app.targets = [d.app.targets[0]];
    },
    ["/selector", "/app/targets"],
  );
  await bad(
    "feed-content-outlet-key-bad",
    "An `outlets` key with an underscore.",
    (d) => {
      ps(d).outlets.play_store = { pinned: [] };
    },
    ["/packSets/outlets"],
  );
  await bad(
    "feed-content-outlet-pinned-duplicate",
    "`pinned` names one pack twice.",
    (d) =>
      void (ps(d).outlets.steam.pinned = ["diceroll.foes", "diceroll.foes"]),
    ["/packSets/outlets/steam/pinned"],
  );
  await bad(
    "feed-content-gate-key-not-release",
    "A gate keyed by a hash that is not in `releases`.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("skins@1.0.0")] = {
        halted: true,
        fallback: null,
      }),
    ["/packSets/outlets/direct/gates"],
  );
  await bad(
    "feed-content-gate-halted-string",
    'A gate `halted` of `"false"`.',
    (d) => void (ps(d).outlets.direct.gates[h("tex@1.1.0")].halted = "false"),
    [`/packSets/outlets/direct/gates/${h("tex@1.1.0")}/halted`],
  );
  await bad(
    "feed-content-gate-bp-over",
    "A gate rollout `bp` of 10 001.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.bp = 10001),
    [gateBp],
  );
  await bad(
    "feed-content-gate-salt-bad",
    "A gate rollout salt of 31 hex digits.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.salt =
        P13_SALT.slice(1)),
    [`/packSets/outlets/direct/gates/${h("foes@2.0.1")}/rollout/salt`],
  );
  await bad(
    "feed-content-gate-fallback-dangling",
    "A gate `fallback` that is not in `releases`.",
    (d) =>
      void (ps(d).outlets.direct.gates[h("tex@1.1.0")].fallback =
        h("skins@1.0.0")),
    [`/packSets/outlets/direct/gates/${h("tex@1.1.0")}/fallback`],
  );

  // Unusable `packFloors` and `revocations`.
  await bad(
    "feed-content-pack-floors-not-array",
    "`packFloors` is an object.",
    (d) => void (d.packFloors = {}),
    ["/packFloors"],
    "packFloors",
  );
  await bad(
    "feed-content-pack-floors-duplicate",
    "Two floors for one (pack, contentApi).",
    (d) => void (d.packFloors[1].contentApi = 3),
    ["/packFloors/1/contentApi"],
    "packFloors",
  );
  await bad(
    "feed-content-revocations-not-array",
    "`revocations` is an object.",
    (d) => void (d.revocations = {}),
    ["/revocations"],
    "revocations",
  );
  await bad(
    "feed-content-revocations-duplicate-record",
    "Two entries with one `record`.",
    (d) =>
      void d.revocations.push({
        ...d.revocations[0],
        target: h("foes@1.3.4"),
        version: "1.3.4",
        seq: 11,
      }),
    ["/revocations/1"],
    "revocations",
  );

  // The token rule and the minimum at each of the five integer pointers.
  const intCase = async (
    slug: string,
    pointer: string,
    member: "packSets" | "packFloors" | "revocations",
    set: (d: Record<string, any>, v: unknown) => void,
    token: string,
    min: number,
  ): Promise<void> => {
    await bad(
      `feed-content-${slug}-token`,
      `V4 §3.1: \`${pointer}\` written as the token \`${token}\`.`,
      (d) => set(d, raw(token)),
      [pointer],
      member,
      true,
    );
    await bad(
      `feed-content-${slug}-minimum`,
      `\`${pointer}\` ${min}, below its minimum.`,
      (d) => set(d, min),
      [pointer],
      member,
    );
  };
  await intCase(
    "release-seq",
    `/packSets/releases/${h("l10n@1.1.0")}/seq`,
    "packSets",
    (d, v) => void (ps(d).releases[h("l10n@1.1.0")].seq = v),
    "2.0",
    0,
  );
  await intCase(
    "row-content-api",
    "/packSets/rows/0/contentApi",
    "packSets",
    (d, v) => void (ps(d).rows[0].contentApi = v),
    "3.0",
    0,
  );
  await intCase(
    "gate-bp",
    gateBp,
    "packSets",
    (d, v) => void (ps(d).outlets.direct.gates[h("foes@2.0.1")].rollout.bp = v),
    "2500.0",
    -1,
  );
  await intCase(
    "floor-content-api",
    "/packFloors/0/contentApi",
    "packFloors",
    (d, v) => void (d.packFloors[0].contentApi = v),
    "3.0",
    0,
  );
  await intCase(
    "revocation-seq",
    "/revocations/0/seq",
    "revocations",
    (d, v) => void (d.revocations[0].seq = v),
    "10.0",
    0,
  );

  // ── plans/P4-29.md §4.2: 28 appended cases, each the base plus one `deltas` mutation ──────
  const T = (n: string): string => sha256Hex(`p4-29 payload ${n}`);
  const A = (n: string): string => sha256Hex(`p4-29 artifact ${n}`);
  const entry = (
    from: string,
    art: string,
    bytes: number,
    memBytes = 10515192,
  ): Record<string, unknown> => ({
    from: T(from),
    method: "zstd-patch-from",
    scope: "payload",
    memBytes,
    artifact: { sha256: A(art), bytes },
  });
  const menu = (): Record<string, any> => ({
    [T("foes@2.0.1")]: [
      entry("foes@1.3.4", "foes 1.3.4-2.0.1", 325258),
      entry("foes@2.0.0", "foes 2.0.0-2.0.1", 120000),
    ],
    [T("tex@1.1.0")]: [entry("tex@1.0.0", "tex 1.0.0-1.1.0", 4096, 2097152)],
  });
  const k0 = T("foes@2.0.1");
  const k1 = T("tex@1.1.0");
  /** 16 targets × 4 entries: `MAX_FEED_DELTAS` with 4 on every key. */
  const atCaps = (): Record<string, any> => {
    const m: Record<string, any> = {};
    for (let t = 0; t < 16; t++) {
      const list: unknown[] = [];
      for (let e = 0; e < 4; e++)
        list.push(
          entry(`cap ${t} base ${e}`, `cap ${t}-${e}`, 1000 + t * 4 + e),
        );
      m[T(`cap ${t}`)] = list;
    }
    return m;
  };
  const dm = async (
    id: string,
    description: string,
    patch: Patch,
    deltas: "usable" | "unusable",
    raw = false,
  ): Promise<void> =>
    mk(id, description, {
      patch: (d) => {
        d.deltas = menu();
        patch(d);
      },
      props: ["/deltas"],
      changes: [],
      deltas,
      raw,
    });

  // Valid (8).
  await dm(
    "feed-deltas-valid",
    "The delta menu (plans/P4-29.md §2.2): two target payloads, one with two `payload` entries; the three content members stay parsed.",
    () => {},
    "usable",
  );
  await mk(
    "feed-deltas-alone",
    "Only `deltas`: the three content members parse as null and the menu stands on its own.",
    {
      patch: (d) => {
        delete d.packSets;
        delete d.packFloors;
        delete d.revocations;
        d.deltas = menu();
      },
      props: ["/packSets", "/packFloors", "/revocations", "/deltas"],
      changes: ["packSets", "packFloors", "revocations"],
      deltas: "usable",
    },
  );
  await dm(
    "feed-deltas-empty-object",
    "`deltas: {}` is usable and offers nothing.",
    (d) => void (d.deltas = {}),
    "usable",
  );
  await dm(
    "feed-deltas-unknown-members-ignored",
    "Unknown members on an entry and on its `artifact` are ignored; the parsed entries carry the known members only.",
    (d) => {
      d.deltas[k0][0].size = 5256232;
      d.deltas[k0][0].windowLog = 23;
      d.deltas[k1][0].artifact.later = "x";
    },
    "usable",
  );
  await dm(
    "feed-deltas-unknown-method-kept",
    "An entry whose `method` is an unknown vocabulary token (`hdiffpatch`) is kept: the planner's `caps.patchMethods` decides.",
    (d) => void (d.deltas[k1][0].method = "hdiffpatch"),
    "usable",
  );
  await dm(
    "feed-deltas-files-scope-dropped",
    "An entry of a forward scope (`files`) is dropped alone; its sibling on the same key is kept.",
    (d) => void (d.deltas[k0][1].scope = "files"),
    "usable",
  );
  await dm(
    "feed-deltas-all-dropped-key-omitted",
    "A key whose only entry is of a forward scope is left out of the parsed menu; the other key stays.",
    (d) => void (d.deltas[k1][0].scope = "files"),
    "usable",
  );
  await dm(
    "feed-deltas-at-caps",
    "`MAX_FEED_DELTAS` (64) entries, `MAX_FEED_DELTAS_PER_TARGET` (4) on every key: usable.",
    (d) => void (d.deltas = atCaps()),
    "usable",
  );

  // Unusable (16): the three content members stay parsed in each.
  const ud = (id: string, description: string, patch: Patch, raw = false) =>
    dm(id, description, patch, "unusable", raw);
  await ud("feed-deltas-null", "A present `deltas: null` is unusable.", (d) => {
    d.deltas = null;
  });
  await ud("feed-deltas-array", "`deltas` is an array.", (d) => {
    d.deltas = [d.deltas[k0][0]];
  });
  await ud(
    "feed-deltas-bad-key",
    "A key that is not 64 lowercase hex (upper case).",
    (d) => {
      d.deltas[k1.toUpperCase()] = d.deltas[k1];
      delete d.deltas[k1];
    },
  );
  await ud("feed-deltas-empty-value", "A key whose list is empty.", (d) => {
    d.deltas[k1] = [];
  });
  await ud(
    "feed-deltas-over-per-target",
    "Five entries on one key, over `MAX_FEED_DELTAS_PER_TARGET`.",
    (d) => {
      for (let e = 2; e < 5; e++)
        d.deltas[k0].push(entry(`foes base ${e}`, `foes extra ${e}`, 2000 + e));
    },
  );
  await ud(
    "feed-deltas-over-total",
    "65 entries in all, over `MAX_FEED_DELTAS` (each key within its own cap).",
    (d) => {
      d.deltas = atCaps();
      d.deltas[k1] = [entry("tex@1.0.0", "tex 1.0.0-1.1.0", 4096, 2097152)];
    },
  );
  await ud(
    "feed-deltas-entry-not-object",
    "An entry that is a string.",
    (d) => {
      d.deltas[k1][0] = "delta";
    },
  );
  await ud("feed-deltas-from-missing", "An entry without `from`.", (d) => {
    delete d.deltas[k1][0].from;
  });
  await ud(
    "feed-deltas-from-malformed",
    "An entry whose `from` is 63 hex digits.",
    (d) => void (d.deltas[k1][0].from = T("tex@1.0.0").slice(1)),
  );
  await ud(
    "feed-deltas-from-is-target",
    "An entry whose `from` equals its own key.",
    (d) => void (d.deltas[k1][0].from = k1),
  );
  await ud(
    "feed-deltas-bad-method",
    '`method: "Zstd-patch-from"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => void (d.deltas[k1][0].method = "Zstd-patch-from"),
  );
  await ud(
    "feed-deltas-bad-scope",
    '`scope: "Payload"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => void (d.deltas[k1][0].scope = "Payload"),
  );
  await ud(
    "feed-deltas-bad-artifact",
    "An entry whose `artifact.sha256` is not 64 lowercase hex (upper case).",
    (d) =>
      void (d.deltas[k1][0].artifact.sha256 =
        A("tex 1.0.0-1.1.0").toUpperCase()),
  );
  await ud(
    "feed-deltas-duplicate-artifact",
    "One `artifact.sha256` listed under two keys.",
    (d) =>
      void (d.deltas[k1][0].artifact.sha256 = d.deltas[k0][0].artifact.sha256),
  );
  await ud(
    "feed-deltas-duplicate-pair",
    "Two entries with one (`from`, `method`) on a key.",
    (d) => void (d.deltas[k0][1].from = d.deltas[k0][0].from),
  );
  await ud(
    "feed-deltas-duplicate-with-dropped",
    "A (`from`, `method`) duplicate whose first entry is of a forward scope: dropped entries count toward uniqueness.",
    (d) => {
      d.deltas[k0][0].scope = "files";
      d.deltas[k0][1].from = d.deltas[k0][0].from;
    },
  );

  // The token rule and the minimum at the two integer pointers (4).
  const memAt = `/deltas/${k1}/0/memBytes`;
  const bytesAt = `/deltas/${k1}/0/artifact/bytes`;
  await ud(
    "feed-deltas-mem-bytes-token",
    `V4 §3.1: \`${memAt}\` written as the token \`3.0\`.`,
    (d) => void (d.deltas[k1][0].memBytes = raw("3.0")),
    true,
  );
  await ud(
    "feed-deltas-mem-bytes-minimum",
    `\`${memAt}\` 0, below its minimum.`,
    (d) => void (d.deltas[k1][0].memBytes = 0),
  );
  await ud(
    "feed-deltas-artifact-bytes-token",
    `V4 §3.1: \`${bytesAt}\` written as the token \`1.0\`.`,
    (d) => void (d.deltas[k1][0].artifact.bytes = raw("1.0")),
    true,
  );
  await ud(
    "feed-deltas-artifact-bytes-minimum",
    `\`${bytesAt}\` 0, below its minimum.`,
    (d) => void (d.deltas[k1][0].artifact.bytes = 0),
  );

  // Every set key is the `packSetId` of its members, in every case whose `packSets` parses.
  for (const c of cases) {
    const p = c.expect.content.packSets as Record<string, any> | null;
    if (p === null) continue;
    for (const [id, members] of Object.entries<string[]>(p.sets))
      if (
        id !==
        refPackSetId(members.map((m) => [p.releases[m].pack as string, m]))
      )
        throw new Error(
          `feedContentCases ${c.id}: set ${id} is not its packSetId`,
        );
  }
  if (cases.length !== P13_COUNTS.feedContentCases)
    throw new Error(
      `feedContentCases: ${cases.length} != ${P13_COUNTS.feedContentCases}`,
    );
  // plans/P4-29.md §4.2: the menu's cases are appended; the at-caps payload stays in the cap.
  const appended = cases.filter((c) => c.expect.deltas !== undefined);
  if (appended.length !== 28 || cases.indexOf(appended[0]!) !== 48)
    throw new Error("feedContentCases: the 28 P4-29 cases must follow the 48");
  const capCase = cases.find((c) => c.id === "feed-deltas-at-caps")!;
  if (Buffer.from(capCase.jws.split(".")[1]!, "base64url").byteLength > 65536)
    throw new Error(
      "feedContentCases: feed-deltas-at-caps is over 65,536 bytes",
    );
  return cases;
}

/** The exact counts of plans/P4-13.md's new sections (the self-check's "counts are exact"),
 *  with plans/P4-29.md §4.2's 28 appended `feedContentCases`. */
const P13_COUNTS = {
  feedContentCases: 76,
  revocationCases: 27,
  contentRows: 44,
};

/** The three appended `feedCases` (plans/P4-13.md §4.2): every runner verifies them. */
async function appendContentFeedCases(
  mk: (
    id: string,
    description: string,
    o: { doc?: Record<string, unknown>; expect: "ok" },
  ) => Promise<void>,
  base: Record<string, unknown>,
): Promise<void> {
  await mk(
    "feed-valid-content-members-populated",
    "P4-13: a channel-wide feed carrying all three content members (`packSets` with every row kind, `packFloors`, `revocations`). A v4 verifier ignores them: the verdict is FC's.",
    { doc: { ...structuredClone(base), ...p13FeedMembers() }, expect: "ok" },
  );
  const perPlatform = {
    ...structuredClone(base),
    ...p13FeedMembers(),
  } as Record<string, any>;
  perPlatform.selector = { platform: "macos" };
  perPlatform.app.targets = [perPlatform.app.targets[0]];
  perPlatform.packSets = p13PackSets(
    [
      [3, "macos", "godot-4.4", {}, ["foes@1.3.4", "l10n@1.1.0"]],
      [4, "macos", "godot-4.4", {}, ["foes@2.0.1", "l10n@1.1.0"]],
    ],
    { "app-store": { pinned: ["diceroll.foes"] } },
  );
  await mk(
    "feed-valid-content-members-per-platform",
    "P4-13: a per-platform feed (`selector: {platform: macos}`) with its own rows only, every floor and revocation.",
    { doc: perPlatform, expect: "ok" },
  );
  // At the cap: `packSets` rows padded until the payload is exactly 65 536 bytes.
  const atCap = {
    ...structuredClone(base),
    ...p13FeedMembers(),
  } as Record<string, any>;
  const size = (o: unknown): number => utf8Bytes(JSON.stringify(o)).length;
  const rows = atCap.packSets.rows as Record<string, unknown>[];
  const set0 = rows[0]!.set as string;
  for (let api = 100; ; api++) {
    const row = {
      contentApi: api,
      platform: "linux",
      engine: "godot-4.4",
      variant: {},
      set: set0,
    };
    rows.push(row);
    if (size(atCap) > 65536 - 200) break;
  }
  const last = rows[rows.length - 1]!;
  last.pad = "";
  const room = 65536 - size(atCap);
  if (room < 0) throw new Error("feed-valid-content-at-cap: overshoot");
  last.pad = "A".repeat(room);
  if (size(atCap) !== 65536)
    throw new Error(`feed-valid-content-at-cap: ${size(atCap)} bytes`);
  if (refFeedContent(atCap, null).packSets === null)
    throw new Error("feed-valid-content-at-cap: packSets must stay usable");
  await mk(
    "feed-valid-content-at-cap",
    "P4-13: the generator's at-cap test, a content-carrying payload of exactly 65 536 bytes (its `packSets` rows padded). An over-cap payload is `jwsCases`' oversize case.",
    { doc: atCap, expect: "ok" },
  );
}

// ── `revocationCases` (plans/P4-13.md §4.2) ──────────────────────────────────────────────────

interface RevocationCase {
  id: string;
  description: string;
  mode: "revocation" | "replacement";
  jws: string;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  /** `revocation` mode: the feed entry the record is verified against. */
  entry?: {
    record: string;
    pack: string;
    target: string;
    version: string;
    seq: number;
  };
  /** `replacement` mode: the replacement's hash and pin (kind `pack`). */
  expectedHash?: string;
  pin?: { kind: "pack"; deliverable: string; version: string; seq: number };
  nonWireIntegers?: string[];
  expect:
    | {
        verify: "ok";
        revocation?: Record<string, unknown>;
        kind?: string;
        supersedes?: string;
        winner?: string;
      }
    | {
        verify: "fail";
        step: "hash" | "jws" | "claims" | "cross-check" | "revocation";
      };
}

/** §2.3's steps 12–16, from first principles. */
function refVerifyRevocationCase(c: RevocationCase): RevocationCase["expect"] {
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check" | "revocation",
  ): RevocationCase["expect"] => ({ verify: "fail", step });
  const body = c.jws;
  const hash = c.mode === "revocation" ? c.entry!.record : c.expectedHash!;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return fail("hash");
  if (sha256Hex(body) !== hash) return fail("hash");
  let kid: unknown;
  try {
    kid = (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(body.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return fail("jws");
  }
  if (typeof kid !== "string" || !hasOwn(c.releaseKeys, kid))
    return fail("jws");
  const key = c.releaseKeys[kid]!;
  if (Object.values(c.productTrust).includes(key)) return fail("jws");
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return fail("jws");
  const ctx = ctxOf(v.text);
  if (!refRecordClaims(v.payload, ctx, c.expectedAud)) return fail("claims");
  const d = v.payload as Record<string, any>;
  if (c.mode === "replacement") {
    const p = c.pin!;
    if (d.kind !== p.kind || d.deliverable !== p.deliverable)
      return fail("cross-check");
    if (d.version !== p.version || d.seq !== p.seq) return fail("cross-check");
    return { verify: "ok", kind: d.kind };
  }
  const e = c.entry!;
  if (d.kind !== "revocation" || d.deliverable !== e.pack)
    return fail("cross-check");
  if (d.version !== e.version || d.seq !== e.seq) return fail("cross-check");
  const r = refRevocationOf(d, ctx);
  if (r === null || r.target !== e.target) return fail("revocation");
  return { verify: "ok", revocation: r };
}

async function buildRevocationCases(): Promise<RevocationCase[]> {
  const packs = await packRecords();
  const target = packs.get("djdl.levels@1.0.0")!;
  const repl = packs.get("djdl.levels@1.1.0")!;
  const other = packs.get("djdl.assets@1.1.0")!;
  const RK = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const ISSUED = RECORD_ISSUED + 5_000;
  const revDoc = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: "djdl.levels",
    kind: "revocation",
    version: "1.0.0",
    seq: 1,
    issuedAt: ISSUED,
    revokes: target.sha256,
    replacement: { sha256: repl.sha256, seq: 2, version: "1.1.0" },
    reason: "Exploit in the level 3 spawn tables.",
    ...over,
  });
  const cases: RevocationCase[] = [];
  const hashes = new Map<string, string>();
  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      kid?: string;
      releaseKeys?: Record<string, string>;
      entry?: Partial<NonNullable<RevocationCase["entry"]>>;
      /** Sign this exact JWS (`replacement` mode, or a pre-signed record). */
      jws?: string;
      mode?: "revocation" | "replacement";
      pin?: RevocationCase["pin"];
      hashOverride?: string;
      supersedes?: string;
      winner?: string;
      expect:
        | "ok"
        | Exclude<RevocationCase["expect"], { verify: "ok" }>["step"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const mode = o.mode ?? "revocation";
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, "pkey-release+jws")
        : await signAs(o.doc ?? revDoc(), kid, "pkey-release+jws"));
    const base: RevocationCase = {
      id,
      description,
      mode,
      jws,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expect: { verify: "ok" },
    };
    const c: RevocationCase =
      mode === "revocation"
        ? {
            ...base,
            entry: {
              record: o.hashOverride ?? sha256Hex(jws),
              pack: "djdl.levels",
              target: target.sha256,
              version: "1.0.0",
              seq: 1,
              ...o.entry,
            },
          }
        : {
            ...base,
            expectedHash: o.hashOverride ?? sha256Hex(jws),
            pin: o.pin!,
          };
    const want = refVerifyRevocationCase(c);
    if (o.expect === "ok") {
      if (want.verify !== "ok")
        throw new Error(`revocationCases ${id}: the reference refuses it`);
      c.expect = {
        ...want,
        ...(o.supersedes ? { supersedes: o.supersedes } : {}),
        ...(o.winner ? { winner: o.winner } : {}),
      };
    } else {
      if (want.verify !== "fail" || want.step !== o.expect)
        throw new Error(
          `revocationCases ${id}: the reference answers ${JSON.stringify(want)}`,
        );
      c.expect = want;
    }
    hashes.set(id, sha256Hex(jws));
    const kidOk =
      hasOwn(c.releaseKeys, kid) &&
      !Object.values(PT).includes(c.releaseKeys[kid]!);
    const v = kidOk
      ? refVerifyJws(jws, { [kid]: c.releaseKeys[kid]! }, "pkey-release+jws")
      : null;
    const nonWire = v ? refNonWire(v.text) : [];
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const withoutKey = (
    k: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const d = revDoc(over);
    delete d[k];
    return d;
  };

  // Valid.
  await mk(
    "revocation-valid-with-replacement",
    "The control: djdl.levels@1.0.0 revoked, replaced by 1.1.0 (same deliverable), signed by the pinned release key.",
    { expect: "ok" },
  );
  await mk(
    "revocation-valid-no-replacement",
    "A revocation without a replacement.",
    {
      doc: withoutKey("replacement"),
      expect: "ok",
    },
  );
  await mk(
    "revocation-valid-reason-at-max",
    "`reason` of exactly 512 UTF-8 bytes (multi-byte characters counted as bytes).",
    {
      doc: revDoc({ reason: `${"é".repeat(200)}${"x".repeat(112)}` }),
      expect: "ok",
    },
  );
  await mk(
    "revocation-valid-second-release-key",
    "Signed by the second pinned release key (2027), during a rotation.",
    {
      kid: REL2_KID,
      releaseKeys: { ...RK, [REL2_KID]: pub(REL2_KID) },
      expect: "ok",
    },
  );
  // jws.
  await mk(
    "revocation-signed-by-product-key",
    "Signed by the product key, which is in the product trust set: refused at step `jws` (decision 3: the Worker can never sign one).",
    {
      kid: PIN_KID,
      releaseKeys: { ...RK, [PIN_KID]: pub(PIN_KID) },
      expect: "jws",
    },
  );
  await mk(
    "revocation-kid-not-pinned",
    "Signed by the 2027 release key, which this app does not pin.",
    { kid: REL2_KID, expect: "jws" },
  );
  // hash.
  await mk(
    "revocation-hash-mismatch",
    "The body does not hash to `entry.record`.",
    { hashOverride: sha256Hex("pkey-corpus-revocation:other"), expect: "hash" },
  );
  // claims.
  await mk("revocation-wrong-aud", "`aud` names another product.", {
    doc: revDoc({ aud: "other" }),
    expect: "claims",
  });
  // cross-check.
  await mk(
    "revocation-entry-pack-mismatch",
    "The feed entry names another pack.",
    { entry: { pack: "djdl.assets" }, expect: "cross-check" },
  );
  await mk(
    "revocation-entry-version-mismatch",
    "The feed entry names another version.",
    { entry: { version: "1.0.1" }, expect: "cross-check" },
  );
  await mk(
    "revocation-entry-seq-mismatch",
    "The feed entry names another `seq`.",
    { entry: { seq: 2 }, expect: "cross-check" },
  );
  await mk(
    "revocation-kind-app",
    "A record of `kind: app` where a revocation is pinned.",
    {
      doc: revDoc({ kind: "app", builds: r15Builds("1.0.0", ["macos-dmg"]) }),
      expect: "cross-check",
    },
  );
  // revocation (step 16).
  await mk(
    "revocation-deliverable-app",
    "`deliverable: app`: an app build is revoked by License's compatibility window, never by a revocation record.",
    {
      doc: revDoc({ deliverable: "app" }),
      entry: { pack: "app" },
      expect: "revocation",
    },
  );
  await mk("revocation-revokes-missing", "No `revokes`.", {
    doc: withoutKey("revokes"),
    expect: "revocation",
  });
  await mk("revocation-revokes-uppercase", "`revokes` in uppercase hex.", {
    doc: revDoc({ revokes: target.sha256.toUpperCase() }),
    expect: "revocation",
  });
  await mk(
    "revocation-revokes-not-entry-target",
    "`revokes` is not the feed entry's `target`.",
    { doc: revDoc({ revokes: other.sha256 }), expect: "revocation" },
  );
  await mk(
    "revocation-replacement-equals-revokes",
    "The replacement is the revoked record itself.",
    {
      doc: revDoc({
        replacement: { sha256: target.sha256, seq: 1, version: "1.0.0" },
      }),
      expect: "revocation",
    },
  );
  await mk(
    "revocation-replacement-seq-token",
    "V4 §3.1: `replacement.seq` written as the token `2.0`.",
    {
      text: rawJson(
        revDoc({
          replacement: {
            sha256: repl.sha256,
            seq: raw("2.0"),
            version: "1.1.0",
          },
        }),
      ),
      expect: "revocation",
    },
  );
  await mk("revocation-replacement-seq-zero", "`replacement.seq` 0.", {
    doc: revDoc({
      replacement: { sha256: repl.sha256, seq: 0, version: "1.1.0" },
    }),
    expect: "revocation",
  });
  await mk("revocation-reason-missing", "No `reason`.", {
    doc: withoutKey("reason"),
    expect: "revocation",
  });
  await mk("revocation-reason-over-max", "`reason` of 513 bytes.", {
    doc: revDoc({ reason: "x".repeat(513) }),
    expect: "revocation",
  });
  // replacement mode.
  await mk(
    "revocation-replacement-record-valid",
    "`replacement` mode: the replacement record (djdl.levels@1.1.0) verifies as a pack record against the revocation's replacement pin.",
    {
      mode: "replacement",
      jws: repl.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: "ok",
    },
  );
  await mk(
    "revocation-replacement-other-deliverable",
    "`replacement` mode: the replacement hash names a record of another deliverable (djdl.assets@1.1.0): refused at `cross-check`.",
    {
      mode: "replacement",
      jws: other.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: "cross-check",
    },
  );
  // Superseding (decision 18).
  const replB = { sha256: other.sha256, seq: 2, version: "1.1.0" };
  await mk(
    "revocation-supersedes-replacement",
    "A later revocation of the same target with a newer `issuedAt` and a different replacement; with `revocation-valid-with-replacement` it is the winner (`newerRevocation`).",
    {
      doc: revDoc({ issuedAt: ISSUED + 600, replacement: replB }),
      supersedes: "revocation-valid-with-replacement",
      winner: "revocation-supersedes-replacement",
      expect: "ok",
    },
  );
  await mk(
    "revocation-supersede-omits-revokes",
    "A superseding record cannot omit `revokes`: still step `revocation`.",
    {
      doc: withoutKey("revokes", { issuedAt: ISSUED + 900 }),
      expect: "revocation",
    },
  );
  {
    const tie = revDoc({ replacement: replB, reason: "Tie." });
    const tieJws = await signAs(tie, REL_KID, "pkey-release+jws");
    const control = hashes.get("revocation-valid-with-replacement")!;
    const winner =
      sha256Hex(tieJws) > control
        ? "revocation-supersede-tie"
        : "revocation-valid-with-replacement";
    await mk(
      "revocation-supersede-tie",
      "Equal `issuedAt` with `revocation-valid-with-replacement`: the higher record hash (by bytes) wins.",
      {
        jws: tieJws,
        supersedes: "revocation-valid-with-replacement",
        winner,
        expect: "ok",
      },
    );
  }
  await mk(
    "revocation-supersede-older-loses",
    "An older `issuedAt` with a different replacement loses to `revocation-valid-with-replacement`, which stays the winner.",
    {
      doc: revDoc({ issuedAt: ISSUED - 600, replacement: replB }),
      supersedes: "revocation-valid-with-replacement",
      winner: "revocation-valid-with-replacement",
      expect: "ok",
    },
  );

  // The superseding winners, recomputed with the reference rule.
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const c of cases) {
    if (c.expect.verify !== "ok" || !c.expect.supersedes) continue;
    const o = byId.get(c.expect.supersedes)!;
    const a = c.expect.revocation as { issuedAt: number };
    const b = (o.expect as unknown as { revocation: { issuedAt: number } })
      .revocation;
    const ha = c.entry!.record;
    const hb = o.entry!.record;
    const win =
      a.issuedAt !== b.issuedAt
        ? a.issuedAt > b.issuedAt
          ? c.id
          : o.id
        : ha >= hb
          ? c.id
          : o.id;
    if (win !== c.expect.winner)
      throw new Error(`revocationCases ${c.id}: the winner is ${win}`);
    if (c.entry!.target !== o.entry!.target)
      throw new Error(`revocationCases ${c.id}: supersedes another target`);
  }
  if (cases.length !== P13_COUNTS.revocationCases)
    throw new Error(
      `revocationCases: ${cases.length} != ${P13_COUNTS.revocationCases}`,
    );
  return cases;
}

// ── The content decision (plans/P4-13.md §2.6), the generator's reference ────────────────────

interface RefContentInput {
  stamp: {
    contentApi: number;
    pins: { pack: string; release: Record<string, any> }[];
    expects: { pack: string; required: boolean; delivery: string }[];
    holds: { pack: string; release: Record<string, any> }[] | null;
  };
  active: Record<string, Record<string, any>>;
  axes: Record<string, string[]>;
  revocations: {
    target: string;
    pack: string;
    replacement: Record<string, any> | null;
    replacementUsable: boolean;
  }[];
  buckets: Record<string, number | null>;
}
type RefContentRowInput = RefInput & { content: RefContentInput };

/** The key of the install's outlet entry in `target`, by §2.8 step 3's rule. */
function refEntryId(
  target: Record<string, any> | undefined,
  outlet: { id: string | null; kind: string },
): string | null {
  if (!target || outlet.kind === "unknown") return null;
  const outlets = target.outlets as Record<string, Record<string, any>>;
  if (outlet.id !== null && hasOwn(outlets, outlet.id)) {
    if (outlets[outlet.id]!.kind === outlet.kind) return outlet.id;
  }
  const ids = Object.keys(outlets).filter(
    (k) => outlets[k]!.kind === outlet.kind,
  );
  return ids.length === 1 ? ids[0]! : null;
}

/** §2.6 steps 1–5: the feed target per pack at one level and engine (pins and gates applied). */
function refFeedTargets(
  ps: Record<string, any> | null,
  level: number,
  platform: string,
  engine: string,
  axes: Record<string, string[]>,
  outlet: Record<string, any> | null,
  buckets: Record<string, number | null>,
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  if (ps === null) return out;
  const best = new Map<string, { idx: number[]; set: string }>();
  for (const row of ps.rows as Record<string, any>[]) {
    if (row.contentApi !== level || row.platform !== platform) continue;
    if (row.engine !== engine) continue;
    const names = Object.keys(row.variant).sort(refCmpBytes);
    const idx = names.map((a) =>
      hasOwn(axes, a) ? axes[a]!.indexOf(row.variant[a]) : -1,
    );
    if (idx.some((k) => k < 0)) continue;
    const g = names.join("\u0000");
    const cur = best.get(g);
    let lower = cur === undefined;
    if (cur !== undefined)
      for (let k = 0; k < idx.length; k++)
        if (idx[k] !== cur.idx[k]) {
          lower = idx[k]! < cur.idx[k]!;
          break;
        }
    if (lower) best.set(g, { idx, set: row.set });
  }
  const count = new Map<string, number>();
  const named = new Map<string, string>();
  for (const { set } of best.values())
    for (const h of ps.sets[set] as string[]) {
      const pack = ps.releases[h].pack as string;
      count.set(pack, (count.get(pack) ?? 0) + 1);
      named.set(pack, h);
    }
  const pinned: string[] = outlet?.pinned ?? [];
  const gates: Record<string, any> = outlet?.gates ?? {};
  for (const [pack, h0] of named) {
    if (count.get(pack)! > 1 || pinned.includes(pack)) continue;
    let h: string | null = h0;
    if (hasOwn(gates, h0)) {
      const g = gates[h0];
      const inBucket =
        !g.halted &&
        (!hasOwn(g, "rollout") ||
          (typeof buckets[g.rollout.salt] === "number" &&
            (buckets[g.rollout.salt] as number) < g.rollout.bp));
      if (!inBucket) h = g.fallback;
    }
    if (h !== null) {
      const r = ps.releases[h];
      out.set(pack, { sha256: h, seq: r.seq, version: r.version });
    }
  }
  return out;
}

interface RefComposed {
  install: { pack: string; release: Record<string, any> }[];
  revoke: string[];
  set: { pack: string; sha256: string }[];
  R: boolean;
  F: boolean;
}

function refCompose(
  c: RefContentInput,
  ps: Record<string, any> | null,
  floors: Record<string, any>[],
  outlet: Record<string, any> | null,
  dataUpdates: boolean,
  platform: string,
  engine: string,
): RefComposed {
  const L = c.stamp.contentApi;
  const revs = new Map(c.revocations.map((r) => [r.target, r]));
  const revoked = (x: Record<string, any> | null | undefined): boolean =>
    !!x && revs.has(x.sha256);
  const pin = new Map(c.stamp.pins.map((p) => [p.pack, p.release]));
  const hold = new Map((c.stamp.holds ?? []).map((h) => [h.pack, h.release]));
  const exp = new Map(c.stamp.expects.map((e) => [e.pack, e]));
  const pinnedOut: string[] = ps !== null ? (outlet?.pinned ?? []) : [];
  const targets = refFeedTargets(
    ps,
    L,
    platform,
    engine,
    c.axes,
    ps !== null ? outlet : null,
    c.buckets,
  );
  const packs = [
    ...new Set([
      ...pin.keys(),
      ...hold.keys(),
      ...exp.keys(),
      ...Object.keys(c.active),
      ...targets.keys(),
    ]),
  ].sort(refCmpBytes);
  const out: RefComposed = {
    install: [],
    revoke: [],
    set: [],
    R: false,
    F: false,
  };
  for (const p of packs) {
    const narrowed = pinnedOut.includes(p);
    const replace = (
      x: Record<string, any> | null,
    ): Record<string, any> | null => {
      if (x === null) return null;
      if (!revoked(x)) return x;
      const r = revs.get(x.sha256)!;
      return r.replacementUsable &&
        r.replacement !== null &&
        !revoked(r.replacement) &&
        dataUpdates &&
        !narrowed
        ? r.replacement
        : null;
    };
    const required = exp.get(p)?.required === true;
    const essential = exp.get(p)?.delivery === "essential";
    const act = hasOwn(c.active, p) ? c.active[p]! : null;
    let base: Record<string, any> | null = null;
    if (pin.has(p)) base = pin.get(p)!;
    else if (hold.has(p)) base = hold.get(p)!;
    else if (!narrowed && c.stamp.holds !== null && dataUpdates && ps !== null)
      base = targets.get(p) ?? null;
    let cand = replace(base);
    if (cand === null && revoked(act)) cand = replace(act);
    const install =
      cand !== null &&
      cand.sha256 !== act?.sha256 &&
      (act !== null || required || essential) &&
      (pin.has(p) ||
        hold.has(p) ||
        act === null ||
        revoked(act) ||
        cand.seq > act.seq);
    if (install) out.install.push({ pack: p, release: cand! });
    const eff = install ? cand : act !== null && !revoked(act) ? act : cand;
    if (eff !== null) out.set.push({ pack: p, sha256: eff.sha256 });
    const noFix =
      cand === null && (revoked(act) || (revoked(base) && act === null));
    if (noFix && required) out.R = true;
    if (noFix && !required && act !== null) out.revoke.push(p);
    if (!noFix && (act !== null || required)) {
      const f = floors.find((x) => x.pack === p && x.contentApi === L);
      if (f) {
        const k =
          eff === null
            ? null
            : refCompareVersions(f.versionScheme, eff.version, f.minVersion);
        if (k === null || k < 0) out.F = true;
      }
    }
  }
  return out;
}

/** §2.6 "Order", over P3-01's answer from `refDecideUpdate`. */
function refDecideWithContent(
  inp: RefContentRowInput,
): Record<string, unknown> {
  const app = refDecideUpdate(inp);
  const c = inp.content;
  const feed = inp.feed;
  const target = (feed.app.targets as Record<string, any>[]).find(
    (t) => t.platform === inp.installed.platform,
  );
  const id = refEntryId(target, inp.outlet);
  const entry = id !== null ? target!.outlets[id] : null;
  const caps = refEffectiveCapabilities(inp.outlet.kind, {
    platform: inp.installed.platform,
    subkind: inp.subkind,
    server: entry?.capabilities,
  });
  const fc = refFeedContent(feed, null) as {
    packSets: Record<string, any> | null;
    packFloors: Record<string, any>[] | null;
  };
  const outlet =
    fc.packSets !== null && id !== null && hasOwn(fc.packSets.outlets ?? {}, id)
      ? fc.packSets.outlets[id]
      : null;
  const engine = inp.installed.engine ?? "";
  const floors = fc.packFloors ?? [];
  const staged = inp.staged !== null;

  if (
    app.action === "none" &&
    (app.reason === "stale" || app.reason === "unknown-version")
  ) {
    const k = refCompose(
      c,
      null,
      floors,
      null,
      caps.dataUpdates,
      inp.installed.platform,
      engine,
    );
    return k.R
      ? { action: "blocked", reason: "revoked-content", discardStaged: staged }
      : app;
  }
  const k = refCompose(
    c,
    fc.packSets,
    floors,
    outlet,
    caps.dataUpdates,
    inp.installed.platform,
    engine,
  );
  const block = k.R ? "revoked-content" : k.F ? "content-floor" : null;
  if (app.action === "blocked")
    return block === null ? app : { ...app, contentBlock: block };
  if (["binary", "store", "platform"].includes(app.action as string)) {
    let a = app;
    if (app.action === "binary") {
      // Prestage: the offered record's new level, required and essential, minus the embeds.
      const rec = inp.record;
      const rc = rec?.content;
      let prestage: unknown[] = [];
      if (rc && rc.contentApi !== c.stamp.contentApi) {
        const build = (rec!.builds as Record<string, any>[]).find(
          (b) => b.id === app.build,
        );
        const embeds: string[] = build?.embeds ?? [];
        const bEngine =
          isObj(build?.requires) && typeof build!.requires.engine === "string"
            ? build!.requires.engine
            : engine;
        const holds = refHoldsOf(rc, null, "/content");
        const tgts =
          holds === null || !caps.dataUpdates
            ? new Map<string, Record<string, any>>()
            : refFeedTargets(
                fc.packSets,
                rc.contentApi,
                inp.installed.platform,
                bEngine,
                c.axes,
                outlet,
                c.buckets,
              );
        const revs = new Map(c.revocations.map((r) => [r.target, r]));
        for (const e of rc.expects as Record<string, any>[]) {
          if (
            !(e.required || e.delivery === "essential") ||
            embeds.includes(e.pack)
          )
            continue;
          const narrowed = (outlet?.pinned ?? []).includes(e.pack);
          let rel: Record<string, any> | null =
            (rc.pins as Record<string, any>[]).find((x) => x.pack === e.pack)
              ?.release ??
            (holds as Record<string, any>[] | null)?.find(
              (x) => x.pack === e.pack,
            )?.release ??
            tgts.get(e.pack) ??
            null;
          if (rel && revs.has(rel.sha256)) {
            const r = revs.get(rel.sha256)!;
            rel =
              r.replacementUsable &&
              r.replacement &&
              !revs.has(r.replacement.sha256) &&
              caps.dataUpdates &&
              !narrowed
                ? r.replacement
                : null;
          }
          if (!rel || c.active[e.pack]?.sha256 === rel.sha256) continue;
          prestage.push({ pack: e.pack, release: rel });
        }
        prestage = (prestage as { pack: string }[]).sort((x, y) =>
          refCmpBytes(x.pack, y.pack),
        );
      }
      a = { ...app, prestage };
    }
    if (block !== null) return { ...a, mandatory: true, contentBlock: block };
    if (app.mandatory === true || app.action === "binary") return a;
  }
  if (block !== null)
    return { action: "blocked", reason: block, discardStaged: staged };
  if (app.action === "code-ready") return app;
  if (caps.dataUpdates && (k.install.length > 0 || k.revoke.length > 0))
    return {
      action: "packs",
      install: k.install,
      revoke: k.revoke,
      set: k.set,
      discardStaged: staged,
    };
  return app;
}

/** §2.6's boot table over P3-01's. */
function refBootDecisionV2(d: Record<string, unknown>): string {
  if (d.reason === "revoked-content" || d.contentBlock === "revoked-content")
    return "required";
  if (d.action === "packs") return "none";
  return refBootDecision(d);
}

// ── `update-matrix.json#/contentRows` (plans/P4-13.md §4.3) ──────────────────────────────────

const P13_EXPECTS = [
  { pack: "diceroll.foes", required: true, delivery: "essential" },
  { pack: "diceroll.l10n", required: false, delivery: "prefetch" },
  { pack: "diceroll.skins", required: false, delivery: "on-demand" },
  { pack: "diceroll.textures", required: true, delivery: "essential" },
];

/** The rows of the base feed: android, `godot-4.4`, levels 3 and 4. */
function p13MatrixRows(): P13Row[] {
  const rows: P13Row[] = [];
  for (const [level, foes] of [
    [3, "foes@1.3.3"],
    [4, "foes@2.0.1"],
  ] as const) {
    rows.push([
      level,
      "android",
      "godot-4.4",
      {},
      [foes, "l10n@1.1.0", "skins@1.0.0"],
    ]);
    rows.push([
      level,
      "android",
      "godot-4.4",
      { texture: "astc" },
      ["tex@1.1.0"],
    ]);
    rows.push([
      level,
      "android",
      "godot-4.4",
      { texture: "etc2" },
      ["tex@1.0.0"],
    ]);
  }
  return rows;
}

/** The base `contentRows` input: CONTENT §6.8's Diceroll on android, level 4, up to date. */
function contentBaseInput(): RefContentRowInput {
  const i = baseInput() as RefContentRowInput;
  i.installed = {
    version: "1.5.0",
    binaryVersion: "1.5.0",
    buildNumber: "150",
    platform: "android",
    arch: "arm64",
    format: null,
    engine: "godot-4.4",
  };
  Object.assign(i.feed, {
    packSets: p13PackSets(p13MatrixRows(), {
      play: { pinned: ["diceroll.foes"] },
    }),
    packFloors: [
      {
        pack: "diceroll.foes",
        contentApi: 3,
        minVersion: "1.3.3",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.foes",
        contentApi: 4,
        minVersion: "2.0.0",
        versionScheme: "semver",
      },
    ],
    revocations: [],
  });
  i.content = {
    stamp: {
      contentApi: 4,
      pins: [],
      expects: structuredClone(P13_EXPECTS),
      holds: [],
    },
    active: {
      "diceroll.foes": p13Pin("foes@2.0.1"),
      "diceroll.l10n": p13Pin("l10n@1.1.0"),
      "diceroll.skins": p13Pin("skins@1.0.0"),
      "diceroll.textures": p13Pin("tex@1.1.0"),
    },
    axes: { texture: ["astc", "etc2"] },
    revocations: [],
    buckets: {},
  };
  return i;
}

type CDelta = (i: RefContentRowInput) => void;
/** The deltas of `contentRows`, as functions. */
const C = {
  active:
    (pack: string, name: string | null) =>
    (i: RefContentRowInput): void => {
      if (name === null) delete i.content.active[`diceroll.${pack}`];
      else i.content.active[`diceroll.${pack}`] = p13Pin(name);
    },
  level:
    (n: number) =>
    (i: RefContentRowInput): void =>
      void (i.content.stamp.contentApi = n),
  /** A level-3 device: its stamp and the level-3 releases active. */
  level3: (i: RefContentRowInput): void => {
    i.content.stamp.contentApi = 3;
    i.content.active["diceroll.foes"] = p13Pin("foes@1.3.3");
  },
  pin:
    (name: string) =>
    (i: RefContentRowInput): void =>
      void i.content.stamp.pins.push({
        pack: p13PackOf(name),
        release: p13Pin(name),
      }),
  hold:
    (name: string) =>
    (i: RefContentRowInput): void =>
      void i.content.stamp.holds!.push({
        pack: p13PackOf(name),
        release: p13Pin(name),
      }),
  holdsUnusable: (i: RefContentRowInput): void =>
    void (i.content.stamp.holds = null),
  rows:
    (rows: P13Row[], outlets?: Record<string, unknown>) =>
    (i: RefContentRowInput): void =>
      void (i.feed.packSets = p13PackSets(
        rows,
        outlets ?? i.feed.packSets.outlets,
      )),
  floor:
    (level: number, min: string) =>
    (i: RefContentRowInput): void => {
      const f = (i.feed.packFloors as Record<string, any>[]).find(
        (x) => x.contentApi === level,
      )!;
      f.minVersion = min;
    },
  gate:
    (name: string, gate: Record<string, unknown>, fallback: string | null) =>
    (i: RefContentRowInput): void => {
      const ps = i.feed.packSets;
      if (fallback !== null) {
        const [pack, version, seq] = p13Rel(fallback);
        ps.releases[p13Hash(fallback)] = { pack, version, seq };
      }
      const o = (ps.outlets ??= {});
      o.direct = {
        gates: {
          [p13Hash(name)]: {
            ...gate,
            fallback: fallback === null ? null : p13Hash(fallback),
          },
        },
      };
    },
  bucket:
    (n: number | null) =>
    (i: RefContentRowInput): void =>
      void (i.content.buckets = { [P13_SALT]: n }),
  /** A revocation of `name`, in the feed and stored (`replacement` usable unless stated). */
  revoke:
    (name: string, replacement: string | null, usable = true, n = 1) =>
    (i: RefContentRowInput): void => {
      const [pack, version, seq] = p13Rel(name);
      (i.feed.revocations as unknown[]).push({
        record: p13RevRecord(name, n),
        pack,
        target: p13Hash(name),
        version,
        seq,
      });
      i.content.revocations.push({
        target: p13Hash(name),
        pack,
        replacement: replacement === null ? null : p13Pin(replacement),
        replacementUsable: replacement !== null && usable,
      });
    },
  outletPlay: (i: RefContentRowInput): void => {
    i.outlet = { id: "play", kind: "play" };
  },
  playLive:
    (version: string, seq: number) =>
    (i: RefContentRowInput): void => {
      const t = i.feed.app.targets.find((x: any) => x.platform === "android");
      t.outlets.play.live = LIVE(version, seq);
    },
  /** The android target pins RC16 (1.6.0, level 4 content), offered on `direct`. */
  offerRC16: (i: RefContentRowInput): void => {
    const t = i.feed.app.targets.find((x: any) => x.platform === "android");
    t.release = pinOf("RC16");
    t.outlets.direct.live = LIVE("1.6.0", 16);
    i.record = structuredClone(record("RC16").doc);
  },
  appFloor:
    (v: string) =>
    (i: RefContentRowInput): void => {
      i.feed.app.targets.find((x: any) => x.platform === "android").floor = {
        minVersion: v,
      };
    },
  installed:
    (v: string) =>
    (i: RefContentRowInput): void => {
      i.installed.version = v;
      i.installed.binaryVersion = v;
    },
  engine:
    (e: string | null) =>
    (i: RefContentRowInput): void =>
      void (i.installed.engine = e),
  methods:
    (...m: string[]) =>
    (i: RefContentRowInput): void =>
      void (i.methods = m),
  stale: (i: RefContentRowInput): void =>
    void (i.now = (i.feed.expiresAt as number) + CLOCK_SKEW),
  staged:
    (version: string) =>
    (i: RefContentRowInput): void =>
      void (i.staged = { version, channel: "stable" }),
  entryCaps:
    (caps: Record<string, unknown>) =>
    (i: RefContentRowInput): void => {
      const t = i.feed.app.targets.find((x: any) => x.platform === "android");
      t.outlets.direct.capabilities = caps;
    },
  noPackSets: (i: RefContentRowInput): void => void delete i.feed.packSets,
};

interface CWant {
  action: string;
  reason?: string;
  install?: string[];
  revoke?: string[];
  prestage?: string[];
  mandatory?: boolean;
  contentBlock?: string;
  boot: "none" | "optional" | "required";
}

function contentRowsSpec(): { name: string; deltas: CDelta[]; want: CWant }[] {
  const row = (name: string, deltas: CDelta[], want: CWant) => ({
    name,
    deltas,
    want,
  });
  const n = "none" as const;
  const o = "optional" as const;
  const r = "required" as const;
  const base = p13MatrixRows();
  const withSet = (level: number, members: string[]): P13Row[] =>
    base.map((x) =>
      x[0] === level && Object.keys(x[3]).length === 0
        ? [x[0], x[1], x[2], x[3], members]
        : x,
    );
  return [
    row("packs-new-compatible-release", [C.active("foes", "foes@2.0.0")], {
      action: "packs",
      install: ["foes@2.0.1"],
      boot: n,
    }),
    row("packs-active-equals-target", [], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "packs-standalone-any-level",
      [C.level3, C.active("l10n", "l10n@1.0.0")],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-hold-overrides-feed",
      [
        C.active("foes", "foes@2.0.0"),
        C.active("l10n", "l10n@1.0.0"),
        C.hold("foes@2.0.0"),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-pinned-never-from-feed",
      [C.active("foes", "foes@2.0.0"), C.pin("foes@2.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-narrowed-to-pinned-on-play",
      [C.outletPlay, C.playLive("1.5.0", 15), C.active("foes", "foes@2.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-variant-row-by-preference",
      [C.active("textures", "tex@1.0.0")],
      { action: "packs", install: ["tex@1.1.0"], boot: n },
    ),
    row(
      "packs-engine-exact-row-only",
      [
        C.active("l10n", "l10n@1.0.0"),
        C.rows([
          ...base,
          [4, "android", "", {}, ["foes@2.0.1", "l10n@1.0.0", "skins@1.0.0"]],
        ]),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-engine-no-exact-row-no-target",
      [
        C.engine("godot-4.5"),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(base.map((x) => [x[0], x[1], "", x[3], x[4]] as P13Row)),
      ],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-engine-null-takes-empty-row",
      [
        C.engine(null),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(base.map((x) => [x[0], x[1], "", x[3], x[4]] as P13Row)),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-yanked-head-no-downgrade",
      [C.rows(withSet(4, ["foes@2.0.0", "l10n@1.1.0", "skins@1.0.0"]))],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-gate-in-bucket",
      [
        C.active("foes", "foes@2.0.0"),
        C.gate(
          "foes@2.0.1",
          { halted: false, rollout: { bp: 5000, salt: P13_SALT } },
          "foes@2.0.0",
        ),
        C.bucket(100),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "packs-gate-out-of-bucket-fallback",
      [
        C.active("foes", "foes@2.0.0"),
        C.gate(
          "foes@2.0.1",
          { halted: false, rollout: { bp: 5000, salt: P13_SALT } },
          "foes@2.0.0",
        ),
        C.bucket(9000),
      ],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-gate-halted-fallback",
      [
        C.active("foes", null),
        C.gate("foes@2.0.1", { halted: true }, "foes@2.0.0"),
      ],
      { action: "packs", install: ["foes@2.0.0"], boot: n },
    ),
    row(
      "packs-no-data-updates",
      [C.active("foes", "foes@2.0.0"), C.entryCaps({ dataUpdates: false })],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row("packs-member-absent", [C.active("foes", "foes@2.0.0"), C.noPackSets], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "packs-non-mandatory-store-with-pack-update",
      [C.outletPlay, C.playLive("1.6.0", 16), C.active("l10n", "l10n@1.0.0")],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row("binary-prestage-on-contentapi-change", [C.level3, C.offerRC16], {
      action: "binary",
      prestage: ["foes@2.0.1"],
      mandatory: false,
      boot: o,
    }),
    row("binary-same-contentapi-no-prestage", [C.offerRC16], {
      action: "binary",
      prestage: [],
      mandatory: false,
      boot: o,
    }),
    row(
      "non-mandatory-binary-with-pack-update",
      [C.offerRC16, C.active("l10n", "l10n@1.0.0")],
      { action: "binary", prestage: [], mandatory: false, boot: o },
    ),
    row("store-new-level-fetch-at-boot", [C.active("foes", "foes@1.3.3")], {
      action: "packs",
      install: ["foes@2.0.1"],
      boot: n,
    }),
    row("blocked-content-floor-no-backport", [C.level3, C.floor(3, "1.3.4")], {
      action: "blocked",
      reason: "content-floor",
      boot: o,
    }),
    row(
      "content-floor-met-by-backport",
      [
        C.level3,
        C.floor(3, "1.3.4"),
        C.rows(withSet(3, ["foes@1.3.4", "l10n@1.1.0", "skins@1.0.0"])),
      ],
      { action: "packs", install: ["foes@1.3.4"], boot: n },
    ),
    row(
      "blocked-content-floor-pinned-below-floor",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.floor(4, "2.0.1"),
      ],
      { action: "blocked", reason: "content-floor", boot: o },
    ),
    row(
      "content-floor-with-store-offer",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.floor(4, "2.0.1"),
        C.outletPlay,
        C.playLive("1.6.0", 16),
      ],
      {
        action: "store",
        mandatory: true,
        contentBlock: "content-floor",
        boot: o,
      },
    ),
    row(
      "revoked-with-compatible-replacement",
      [C.revoke("foes@2.0.1", "foes@2.0.2")],
      { action: "packs", install: ["foes@2.0.2"], boot: n },
    ),
    row(
      "revoked-pinned-with-record-replacement",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.1"),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "blocked-revoked-no-compatible-replacement",
      [C.revoke("foes@2.0.1", null)],
      { action: "blocked", reason: "revoked-content", boot: r },
    ),
    row(
      "revoked-replacement-unusable",
      [C.revoke("foes@2.0.1", "foes@2.0.2", false)],
      { action: "blocked", reason: "revoked-content", boot: r },
    ),
    row(
      "revoked-embedded-baseline",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.1"),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row("revoked-optional-pack-unmounted", [C.revoke("skins@1.0.0", null)], {
      action: "packs",
      install: [],
      revoke: ["diceroll.skins"],
      boot: n,
    }),
    row(
      "revoked-feed-target-not-installed",
      [C.active("foes", "foes@2.0.0"), C.revoke("foes@2.0.1", null)],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "revoked-with-binary-offer",
      [C.offerRC16, C.revoke("foes@2.0.1", null)],
      {
        action: "binary",
        mandatory: true,
        contentBlock: "revoked-content",
        prestage: [],
        boot: r,
      },
    ),
    row(
      "app-floor-precedes-content-floor",
      [
        C.level3,
        C.floor(3, "1.3.4"),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.methods(),
      ],
      {
        action: "blocked",
        reason: "app-floor",
        contentBlock: "content-floor",
        boot: o,
      },
    ),
    row(
      "app-floor-with-revoked-required",
      [
        C.revoke("foes@2.0.1", null),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.methods(),
      ],
      {
        action: "blocked",
        reason: "app-floor",
        contentBlock: "revoked-content",
        boot: r,
      },
    ),
    row(
      "mandatory-binary-supersedes-optional-packs",
      [
        C.level3,
        C.active("l10n", "l10n@1.0.0"),
        C.offerRC16,
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
      ],
      { action: "binary", mandatory: true, prestage: ["foes@2.0.1"], boot: o },
    ),
    row(
      "mandatory-store-supersedes-packs",
      [
        C.outletPlay,
        C.playLive("1.6.0", 16),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.active("l10n", "l10n@1.0.0"),
      ],
      { action: "store", mandatory: true, boot: o },
    ),
    row(
      "stale-feed-revoked-required-blocks",
      [C.stale, C.revoke("foes@2.0.1", null)],
      {
        action: "blocked",
        reason: "revoked-content",
        boot: r,
      },
    ),
    row(
      "stale-feed-content-floor-frozen",
      [C.stale, C.level3, C.floor(3, "1.3.4")],
      {
        action: "none",
        reason: "stale",
        boot: n,
      },
    ),
    row(
      "code-ready-with-pack-update",
      [C.installed("1.4.0"), C.staged("1.5.0"), C.active("l10n", "l10n@1.0.0")],
      { action: "code-ready", boot: o },
    ),
    row(
      "holds-unusable-no-feed-targets",
      [C.holdsUnusable, C.active("l10n", "l10n@1.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "pack-in-two-selected-rows-ignored",
      [
        C.active("foes", "foes@2.0.0"),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(
          base.map((x) =>
            x[0] === 4 && x[3].texture === "astc"
              ? ([
                  x[0],
                  x[1],
                  x[2],
                  x[3],
                  ["tex@1.1.0", "l10n@1.1.0"],
                ] as P13Row)
              : x,
          ),
        ),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "revoked-superseded-replacement",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.2", true, 2),
      ],
      { action: "packs", install: ["foes@2.0.2"], boot: n },
    ),
    row(
      "stale-feed-revoked-pin-replacement-active",
      [C.stale, C.pin("foes@2.0.0"), C.revoke("foes@2.0.0", "foes@2.0.1")],
      { action: "none", reason: "stale", boot: n },
    ),
  ];
}

/** `contentRows`: computed by the reference, checked against the plan's table. */
function buildContentRows(fail: (m: string) => never): {
  rows: unknown[];
  used: { actions: Set<string>; blocked: Set<string>; boot: Set<string> };
} {
  const used = {
    actions: new Set<string>(),
    blocked: new Set<string>(),
    boot: new Set<string>(),
  };
  const nameOf = (pin: Record<string, any>): string => {
    const hit = Object.keys(P13_RELEASES).find(
      (k) => p13Hash(k) === pin.sha256,
    );
    if (!hit) fail(`contentRows: an unknown release ${pin.sha256}`);
    return hit!;
  };
  const rows = contentRowsSpec().map((spec, k) => {
    const input = contentBaseInput();
    for (const d of spec.deltas) d(input);
    const decision = refDecideWithContent(input);
    const boot = refBootDecisionV2(decision);
    const label = k < 9 ? `C${k + 1}` : k === 9 ? "C9b" : `C${k}`;
    const where = `contentRow ${label} (${spec.name})`;
    const w = spec.want;
    if (decision.action !== w.action)
      fail(`${where}: ${decision.action} != ${w.action}`);
    for (const key of ["reason", "mandatory", "contentBlock"] as const)
      if (w[key] !== undefined && decision[key] !== w[key])
        fail(`${where}: ${key} ${String(decision[key])} != ${String(w[key])}`);
    if (w.contentBlock === undefined && decision.contentBlock !== undefined)
      fail(`${where}: an unexpected contentBlock`);
    if (w.install !== undefined) {
      const got = (decision.install as { release: Record<string, any> }[]).map(
        (x) => nameOf(x.release),
      );
      if (JSON.stringify(got) !== JSON.stringify(w.install))
        fail(`${where}: install ${JSON.stringify(got)}`);
    }
    if (
      w.revoke !== undefined &&
      JSON.stringify(decision.revoke) !== JSON.stringify(w.revoke)
    )
      fail(`${where}: revoke ${JSON.stringify(decision.revoke)}`);
    if (w.prestage !== undefined) {
      const got = (decision.prestage as { release: Record<string, any> }[]).map(
        (x) => nameOf(x.release),
      );
      if (JSON.stringify(got) !== JSON.stringify(w.prestage))
        fail(`${where}: prestage ${JSON.stringify(got)}`);
    }
    if (boot !== w.boot) fail(`${where}: boot ${boot} != ${w.boot}`);
    // `required` exactly on the revoked-content rows.
    const revokedRow =
      decision.reason === "revoked-content" ||
      decision.contentBlock === "revoked-content";
    if ((boot === "required") !== revokedRow)
      fail(`${where}: required off the revoked-content rows`);
    // The feed passes the claims; its content members are usable unless the row removes one.
    const feedText = JSON.stringify(input.feed);
    if (
      refFeedClaims(input.feed, ctxOf(feedText), {
        aud: AUD_V3,
        channel: input.feed.channel,
      }) !== null
    )
      fail(`${where}: its feed fails the claims`);
    const fc = refFeedContent(input.feed, ctxOf(feedText));
    if (spec.name !== "packs-member-absent" && fc.packSets === null)
      fail(`${where}: packSets unusable`);
    if (fc.packFloors === null || fc.revocations === null)
      fail(`${where}: floors or revocations unusable`);
    const ps = fc.packSets as Record<string, any> | null;
    if (ps)
      for (const [id, members] of Object.entries<string[]>(ps.sets))
        if (id !== refPackSetId(members.map((m) => [ps.releases[m].pack, m])))
          fail(`${where}: set ${id} is not its packSetId`);
    if (input.record) {
      if (
        !refRecordClaims(
          input.record,
          ctxOf(JSON.stringify(input.record)),
          AUD_V3,
        )
      )
        fail(`${where}: its record fails the claims`);
      const t = input.feed.app.targets.find(
        (x: any) => x.platform === input.installed.platform,
      );
      const named = [...RECORDS!.values()].find(
        (x) => x.sha256 === t.release.sha256,
      );
      if (!named || JSON.stringify(named.doc) !== JSON.stringify(input.record))
        fail(`${where}: the record is not the pin's`);
    }
    // The stamp's content passes the content claims; holds, when usable, pass `holdsOf`.
    const stamp = input.content.stamp;
    if (stamp.holds !== null && refHoldsOf(stamp, null, "/content") === null)
      fail(`${where}: the stamp's holds are unusable`);
    used.actions.add(decision.action as string);
    if (decision.action === "blocked")
      used.blocked.add(decision.reason as string);
    used.boot.add(boot);
    const expect: Record<string, unknown> = { decision, boot };
    if (decision.action === "packs")
      expect.packSetId = refPackSetId(
        (decision.set as { pack: string; sha256: string }[]).map((x) => [
          x.pack,
          x.sha256,
        ]),
      );
    return { name: `${label}. ${spec.name}`, input, expect };
  });
  if (rows.length !== P13_COUNTS.contentRows)
    fail(`${rows.length} contentRows, not ${P13_COUNTS.contentRows}`);
  return { rows, used };
}

// ── §4.9 self-checks over the assembled corpus ───────────────────────────────────────────────

type AnyCase = Record<string, any>;

/** The seven JWS families of §4.1 and plans/P4-01.md §4.6's two: where each keeps its JWS, its
 *  keys, its `typ` and its cap. */
const JWS_FAMILIES: Record<
  string,
  (c: AnyCase) => {
    jws: string;
    keys: Record<string, string>;
    typ: TypV3 | undefined;
    cap: number;
  }
> = {
  jwsCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: c.maxPayloadBytes ?? 65536,
  }),
  licenseDocCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: 65536,
  }),
  configDocCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: 65536,
  }),
  trustCases: (c) => ({
    jws: c.manifestJws,
    keys: c.pinned,
    typ: "pkey-trust+jws",
    cap: 65536,
  }),
  bundleCases: (c) => ({
    jws: c.bundleJws,
    keys: c.pinned,
    typ: "pkey-bundle+jws",
    cap: MAX_BUNDLE_BYTES,
  }),
  feedCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: "pkey-feed+jws",
    cap: 65536,
  }),
  releaseRecordCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  // plans/P4-13.md §4.2.
  feedContentCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: "pkey-feed+jws",
    cap: 65536,
  }),
  revocationCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  packRecordCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  // A marker's JWS is its `release` (plans/P4-01.md §4.6).
  markerCases: (c) => ({
    jws: markerRelease(c.marker) ?? "",
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
};

/** Each family's claim step, from the generator's own claim checks, with `off` switched off. */
function claimStep(family: string, c: AnyCase, off: string[]): boolean {
  const { jws } = JWS_FAMILIES[family]!(c);
  const text = payloadTextOf(jws)!;
  const doc = JSON.parse(text) as unknown;
  const ctx = ctxOf(text, off);
  switch (family) {
    case "licenseDocCases":
    case "configDocCases":
      return refDocClaims(c.typ, doc, ctx, c as EnvelopeOpts);
    case "trustCases":
      return (
        refTrustClaims(doc, ctx, {
          pinned: c.pinned,
          now: c.now,
          checkFreshness: c.checkFreshness,
        }) !== null
      );
    case "bundleCases":
      return refBundleClaims(doc, ctx, { now: c.now, deviceId: c.deviceId });
    case "feedCases":
      return (
        refFeedClaims(doc, ctx, {
          aud: c.expectedAud,
          channel: c.channel,
          platform: c.platform,
        }) === null
      );
    case "releaseRecordCases":
    case "packRecordCases":
      return refRecordClaims(doc, ctx, c.expectedAud);
    default:
      throw new Error(family);
  }
}

/** §4.9 "per claim": the 21 paths, each with its token case, its bound case (null where §4.3
 *  lists the bound as implied) and its minimum case (null where §2.2 names the check that
 *  implies it). The licence cases stand for the envelope licence and config share. */
const PER_CLAIM: [string, string, string, string | null, string | null][] = [
  [
    "licenseDocCases",
    "/issuedAt",
    "license-issued-at-near-integer",
    "license-issued-at-over-max",
    "license-issued-at-negative-reload-path",
  ],
  [
    "licenseDocCases",
    "/expiresAt",
    "license-expires-at-near-integer",
    null,
    "license-expires-at-negative-reload-path",
  ],
  [
    "licenseDocCases",
    "/graceUntil",
    "license-grace-until-near-integer",
    "license-grace-until-over-max",
    null,
  ],
  [
    "configDocCases",
    "/schemaVersion",
    "config-schema-version-near-integer",
    "config-schema-version-over-max",
    "config-schema-version-zero",
  ],
  [
    "trustCases",
    "/schemaVersion",
    "trust-schema-version-near-integer",
    null,
    null,
  ],
  [
    "trustCases",
    "/issuedAt",
    "trust-issued-at-near-integer",
    "trust-issued-at-over-max",
    "trust-issued-at-negative",
  ],
  [
    "trustCases",
    "/expiresAt",
    "trust-expires-at-near-integer",
    "trust-expires-at-over-max",
    "trust-expires-at-negative-reload-path",
  ],
  [
    "bundleCases",
    "/issuedAt",
    "bundle-issued-at-near-integer",
    "bundle-issued-at-over-max",
    "bundle-issued-at-negative",
  ],
  [
    "bundleCases",
    "/expiresAt",
    "bundle-expires-at-near-integer",
    "bundle-expires-at-over-max",
    null,
  ],
  [
    "feedCases",
    "/schemaVersion",
    "feed-schema-version-near-integer",
    null,
    null,
  ],
  [
    "feedCases",
    "/seq",
    "feed-seq-near-integer",
    "feed-seq-over-max",
    "feed-seq-zero",
  ],
  [
    "feedCases",
    "/issuedAt",
    "feed-issued-at-near-integer",
    null,
    "feed-issued-at-negative",
  ],
  [
    "feedCases",
    "/expiresAt",
    "feed-expires-at-near-integer",
    "feed-expires-at-over-max",
    null,
  ],
  [
    "feedCases",
    "/app/targets/0/release/seq",
    "feed-target-seq-near-integer",
    "feed-target-seq-over-max",
    "feed-target-seq-zero",
  ],
  [
    "feedCases",
    "/app/targets/0/outlets/direct/live/seq",
    "feed-live-seq-near-integer",
    "feed-live-seq-over-max",
    "feed-live-seq-zero",
  ],
  [
    "feedCases",
    "/app/targets/0/outlets/direct/rollout/bp",
    "feed-rollout-bp-exponent",
    null,
    "feed-rollout-bp-negative",
  ],
  [
    "releaseRecordCases",
    "/schemaVersion",
    "record-schema-version-near-integer",
    null,
    null,
  ],
  [
    "releaseRecordCases",
    "/seq",
    "record-seq-integral-fraction",
    "record-seq-over-max",
    "record-seq-zero",
  ],
  [
    "releaseRecordCases",
    "/issuedAt",
    "record-issued-at-near-integer",
    "record-issued-at-over-max",
    "record-issued-at-negative",
  ],
  [
    "releaseRecordCases",
    "/minSupportedSeq",
    "record-min-supported-seq-near-integer",
    "record-min-supported-seq-over-max",
    "record-min-supported-seq-zero",
  ],
  [
    "releaseRecordCases",
    "/builds/0/artifacts/0/size",
    "record-artifact-size-integral-fraction",
    "record-artifact-size-over-max",
    "record-artifact-size-negative",
  ],
];
/** Cases built to break an integer claim's token or bound beyond the per-claim table. */
const EXTRA_BREAKERS = [
  "feed-seq-fraction",
  "feed-seq-integral-fraction",
  "record-seq-not-integer",
];

const FAMILY_CLAIM_KEYS: Record<string, string[]> = {
  licenseDocCases: ["envelope"],
  configDocCases: ["envelope", "config"],
  trustCases: ["trust"],
  bundleCases: ["bundle"],
  feedCases: ["feed"],
  feedContentCases: ["feed"],
  releaseRecordCases: ["record"],
  revocationCases: ["record"],
  packRecordCases: ["record", "pack", "content"],
  markerCases: ["record", "pack", "content"],
};

function checkCorpusV4(corpus: Record<string, AnyCase[]>): void {
  const fail = (m: string): never => {
    throw new Error(`corpus v4 self-check: ${m}`);
  };
  const byId = new Map<string, [string, AnyCase]>();
  // Ids are unique in every family.
  for (const family of Object.keys(JWS_FAMILIES).concat("clockFloorCases")) {
    const ids = new Set<string>();
    for (const c of corpus[family]!) {
      if (ids.has(c.id)) fail(`duplicate id ${c.id} in ${family}`);
      ids.add(c.id);
      byId.set(c.id, [family, c]);
    }
  }
  const counts: Record<string, number> = {
    jwsCases: 80,
    licenseDocCases: 25,
    configDocCases: 21,
    trustCases: 20,
    bundleCases: 16,
    feedCases: 80,
    feedContentCases: P13_COUNTS.feedContentCases,
    releaseRecordCases: 49,
    revocationCases: P13_COUNTS.revocationCases,
    packRecordCases: 170,
    markerCases: 17,
  };
  for (const [family, n] of Object.entries(counts))
    if (corpus[family]!.length !== n)
      fail(`${family} has ${corpus[family]!.length} cases, not ${n}`);

  // §4.1: `nonWireIntegers` is the generator's scan exactly where the JWS is built to pass.
  for (const [family, view] of Object.entries(JWS_FAMILIES))
    for (const c of corpus[family]!) {
      const { jws, keys, typ, cap } = view(c);
      const v = refVerifyJws(jws, keys, typ, cap);
      const want = v ? refNonWire(v.text) : [];
      const got = c.nonWireIntegers;
      if (want.length === 0 && got !== undefined)
        fail(`${c.id} carries nonWireIntegers it must not`);
      if (want.length > 0 && JSON.stringify(got) !== JSON.stringify(want))
        fail(
          `${c.id}: nonWireIntegers ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
      if (got !== undefined) {
        const keysOrder = Object.keys(c);
        if (
          keysOrder.indexOf("nonWireIntegers") !==
          keysOrder.indexOf("expect") - 1
        )
          fail(`${c.id}: nonWireIntegers must sit right before expect`);
      }
    }

  // Per claim: token, bound and minimum cases break their path alone.
  const breakers = new Set(EXTRA_BREAKERS);
  // plans/P4-01.md §4.2: P3-02's loop extended with §2.5's 16 pack and `content` paths.
  const perClaim: [string, string, string, string | null, string | null][] = [
    ...PER_CLAIM,
    ...PACK_PER_CLAIM.map(
      ([pointer, token, bound, min]) =>
        ["packRecordCases", pointer, token, bound, min] as [
          string,
          string,
          string,
          string,
          string,
        ],
    ),
  ];
  for (const [family, pointer, token, bound, min] of perClaim) {
    for (const [kind, id] of [
      ["token", token],
      ["bound", bound],
      ["min", min],
    ] as const) {
      if (id === null) continue;
      const hit = byId.get(id);
      if (!hit || hit[0] !== family) fail(`${id} is not a ${family} case`);
      const c = hit![1];
      const text = payloadTextOf(JWS_FAMILIES[family]!(c).jws)!;
      const scan = refNonWire(text);
      if (kind === "min") {
        if (scan.length !== 0)
          fail(`${id}: a minimum case's scan must be empty`);
        const t = refNumberTokens(text).get(pointer);
        if (t === undefined || !PLAIN_INTEGER_REF.test(t))
          fail(`${id}: no plain integer at ${pointer}`);
      } else {
        breakers.add(id);
        if (JSON.stringify(scan) !== JSON.stringify([pointer]))
          fail(`${id}: its scan is ${JSON.stringify(scan)}, not [${pointer}]`);
      }
      if (claimStep(family, c, [])) fail(`${id}: the claim checks accept it`);
      if (!claimStep(family, c, [`${kind}:${pointer}`]))
        fail(`${id}: it fails beyond ${kind} at ${pointer}`);
    }
  }
  // No other case of the six families has a non-wire number at an integer claim.
  for (const family of Object.keys(FAMILY_CLAIM_KEYS))
    for (const c of corpus[family]!) {
      if (breakers.has(c.id)) continue;
      const text = payloadTextOf(JWS_FAMILIES[family]!(c).jws);
      if (text === null) continue;
      let pointers: string[];
      try {
        pointers = refNonWire(text);
      } catch {
        continue; // not JSON at all
      }
      for (const p of pointers)
        if (FAMILY_CLAIM_KEYS[family]!.some((k) => claimPathOf(k, p) !== null))
          fail(`${c.id} has a non-wire integer claim at ${p}`);
    }

  // Every feed pin names a record vector, except the cases built to mismatch.
  const hashes = new Set([...RECORDS!.values()].map((r) => r.sha256));
  for (const c of corpus.feedCases!) {
    const doc = JSON.parse(payloadTextOf(c.jws)!) as Record<string, any>;
    for (const t of doc.app?.targets ?? [])
      if (
        !hashes.has(t.release?.sha256) &&
        ![
          "feed-target-bad-sha256",
          "feed-target-sha256-trailing-newline",
        ].includes(c.id)
      )
        fail(`${c.id}: a pin names no record vector`);
  }

  // The non-ASCII cases and their ASCII twins.
  {
    const c = byId.get("record-build-id-non-ascii")![1];
    const text = payloadTextOf(c.jws)!;
    const doc = JSON.parse(text);
    const id = doc.builds[0].id as string;
    if (REF_BUILD_ID_RE.test(id))
      fail("record-build-id-non-ascii passes BUILD_ID_PATTERN");
    doc.builds[0].id = id.replace(/[^\x00-\x7f]/g, "e");
    if (!refRecordClaims(doc, ctxOf(JSON.stringify(doc)), AUD_V3))
      fail("record-build-id-non-ascii's twin fails");
  }
  {
    const c = byId.get("feed-target-platform-non-ascii")![1];
    const doc = JSON.parse(payloadTextOf(c.jws)!);
    const p = doc.app.targets[2].platform as string;
    if (REF_FEED_PLATFORM_RE.test(p))
      fail("feed-target-platform-non-ascii passes FEED_PLATFORM_PATTERN");
    doc.app.targets[2].platform = "freebsd";
    if (
      refFeedClaims(doc, ctxOf(JSON.stringify(doc)), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      fail("feed-target-platform-non-ascii's twin (freebsd) fails");
  }
  // Each trailing-newline value fails its whole-string pattern and passes without the terminator.
  for (const [value, ok] of [
    ["1.5.0\n", (v: string) => refParseVersion("semver", v) !== null],
    ["direct\n", (v: string) => REF_OUTLET_ID_RE.test(v)],
    ["stable\n", (v: string) => REF_CHANNEL_RE.test(v)],
    [`${record("R15").sha256}\n`, (v: string) => REF_SHA256_RE.test(v)],
    [`${ROLLOUT_SALT}\n`, (v: string) => REF_SALT_RE.test(v)],
    ["1.5.0\n", (v: string) => REF_RECORD_VERSION_RE.test(v)],
    ["app\n", (v: string) => REF_DELIVERABLE_RE.test(v)],
  ] as const)
    if (ok(value) || !ok(value.slice(0, -1)))
      fail(`trailing newline ${JSON.stringify(value)}`);
  // The listing-URL lengths.
  const url = (id: string): string =>
    (JSON.parse(payloadTextOf(byId.get(id)![1].jws)!) as Record<string, any>)
      .app.targets[0].outlets["app-store"].listingUrl;
  const nonAscii = url("feed-listing-url-non-ascii");
  if (!([...nonAscii].length <= 2048 && utf8Bytes(nonAscii).length > 2048))
    fail("feed-listing-url-non-ascii lengths");
  if (utf8Bytes(url("feed-listing-url-over-max")).length !== 2049)
    fail("feed-listing-url-over-max length");
  if (utf8Bytes(url("feed-valid-listing-url-at-max")).length !== 2048)
    fail("feed-valid-listing-url-at-max length");
  // The number and depth vectors break exactly the rule they name.
  for (const id of [
    "json-number-overflow",
    "json-number-underflow",
    "json-number-subnormal",
    "json-number-exponent-wrap",
  ]) {
    const x = /"x":([^}]*)\}$/.exec(payloadTextOf(byId.get(id)![1].jws)!)![1]!;
    if (refNumberInRange(x)) fail(`${id}: ${x} is in range`);
  }
  for (const id of ["valid-number-forms", "valid-number-integral-spellings"]) {
    const text = payloadTextOf(byId.get(id)![1].jws)!;
    for (const t of refNumberTokens(text).values())
      if (!refNumberInRange(t)) fail(`${id}: ${t} out of range`);
  }
}

/** The stage matrix's self-check gains "every outcome has one confirm case" (§4.8). */
function checkConfirmCases(): void {
  const outcomes = STAGE_VOCABULARY.outcomes;
  const listed = STAGE_CONFIRM_CASES.map((c) => c.outcome);
  if (
    JSON.stringify([...listed].sort()) !==
      JSON.stringify([...outcomes].sort()) ||
    new Set(listed).size !== listed.length
  )
    throw new Error(
      "stage-matrix: every outcome needs exactly one confirm case",
    );
  for (const c of STAGE_CONFIRM_CASES)
    if (!STAGE_CONFIRMATIONS.includes(c.expect))
      throw new Error(`stage-matrix: confirm ${c.outcome}`);
}

// ── `delegationCases` (plans/P4-19.md §4.2) ──────────────────────────────────────────────────
// Content-key delegation: a CI-signed `kind: delegation` record lets one content key sign
// tree-layout pack records of the data-only types under a pack-id scope, inside a signing window.
// The reference below restates §2.2's `delegationOf`, §2.3's delegated path of steps 12–16 and
// `recordRevoked` from first principles; every case is checked against it at its exact step.

/** The content keys: deterministic TEST keys from fixed seeds (never a real key). Their public
 *  halves appear only inside the cases' delegations, so the top-level `keys` array is unchanged. */
interface ContentKey {
  pem: string;
  pub: string;
}
function contentKey(label: string): ContentKey {
  const seed = createHash("sha256")
    .update(`pkey-corpus-content-key:${label}`)
    .digest();
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return {
    pem: key.export({ format: "pem", type: "pkcs8" }).toString().trim(),
    pub: jwk.x,
  };
}

const P19_DELEGABLE = ["files.tree", "data.json", "l10n.table"];
const P19_MAX_TTL = 31622400;
const P19_MAX_TYPES = 8;
const P19_KEY_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const P19_KID_RE = /^pkd1-[0-9a-f]{64}$/;
const P19_COUNTS = { delegationCases: 46 };

/** §2.2's `delegationOf`, from first principles. */
function refDelegationOf(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown> | null {
  if (doc.kind !== "delegation" || !refPackId(doc.deliverable)) return null;
  const d = doc.delegate;
  if (!isObj(d) || typeof d.publicKey !== "string") return null;
  if (!P19_KEY_RE.test(d.publicKey)) return null;
  const types = doc.types;
  if (!Array.isArray(types) || types.length < 1 || types.length > P19_MAX_TYPES)
    return null;
  if (new Set(types).size !== types.length) return null;
  if (!types.every((t) => typeof t === "string" && REF_PACK_TYPE_RE.test(t)))
    return null;
  const effective = types.filter((t) => P19_DELEGABLE.includes(t));
  if (effective.length === 0) return null;
  if (!p13Int(ctx, doc.expiresAt, "/expiresAt", 1)) return null;
  if (!p13Int(ctx, doc.issuedAt, "/issuedAt", 0)) return null;
  if (!(doc.issuedAt < doc.expiresAt)) return null;
  if (doc.expiresAt > doc.issuedAt + P19_MAX_TTL) return null;
  return {
    deliverable: doc.deliverable,
    publicKey: d.publicKey,
    types: effective,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
  };
}

interface DelegationPin {
  kind?: string;
  deliverable: string;
  version: string;
  seq: number;
}

interface DelegationCase {
  id: string;
  description: string;
  mode: "record" | "release-only" | "revocation" | "feed";
  jws: string;
  /** `record` mode: the delegation's compact JWS the caller supplies; null otherwise. */
  delegation?: string | null;
  releaseKeys?: Record<string, string>;
  productTrust?: Record<string, string>;
  expectedAud: string;
  expectedHash?: string;
  pin?: DelegationPin | null;
  /** `record` mode: the revoked target hashes `recordRevoked` reads. */
  revoked?: string[];
  /** `revocation` mode: the feed entry. */
  entry?: Record<string, unknown>;
  /** `feed` mode. */
  trust?: Record<string, string>;
  channel?: string;
  platform?: string;
  now?: number;
  checkFreshness?: boolean;
  expect: Record<string, unknown>;
}

type P19Step =
  | "hash"
  | "jws"
  | "claims"
  | "cross-check"
  | "delegation"
  | "scope"
  | "revocation";

const p19Kid = (jws: string): unknown => {
  try {
    return (
      JSON.parse(
        new TextDecoder().decode(base64UrlDecode(jws.split(".")[0] ?? "")),
      ) as Record<string, unknown>
    ).kid;
  } catch {
    return undefined;
  }
};

/** §2.3 step 13.1: a delegation against the pinned release keys, by hash. */
function refVerifyDelegation(
  jws: string,
  hash: string,
  releaseKeys: Record<string, string>,
  productTrust: Record<string, string>,
  aud: string,
): (Record<string, any> & { sha256: string }) | null {
  const r = refRecordSteps(jws, hash, releaseKeys, productTrust, aud);
  if (!r.ok || r.doc.kind !== "delegation") return null;
  const text = payloadTextOf(jws)!;
  const body = refDelegationOf(r.doc, ctxOf(text));
  return body === null ? null : { ...body, sha256: hash };
}

/** §2.3's steps 12–16 with an optional delegation, from first principles. */
function refVerifyDelegatedRecord(c: {
  jws: string;
  delegation: string | null;
  releaseKeys: Record<string, string>;
  productTrust: Record<string, string>;
  expectedAud: string;
  expectedHash: string;
  pin: DelegationPin | null;
}):
  | {
      ok: true;
      doc: Record<string, any>;
      delegation: Record<string, any> | null;
    }
  | { ok: false; step: P19Step } {
  const body = c.jws;
  if (utf8Bytes(body).length > 88844 || /[^\x00-\x7f]/.test(body))
    return { ok: false, step: "hash" };
  if (sha256Hex(body) !== c.expectedHash) return { ok: false, step: "hash" };
  const kid = p19Kid(body);
  if (typeof kid !== "string") return { ok: false, step: "jws" };
  let key: string;
  let delegation: Record<string, any> | null = null;
  if (hasOwn(c.releaseKeys, kid)) {
    key = c.releaseKeys[kid]!;
    if (Object.values(c.productTrust).includes(key))
      return { ok: false, step: "jws" };
  } else {
    if (c.delegation === null || !P19_KID_RE.test(kid))
      return { ok: false, step: "jws" };
    const d = refVerifyDelegation(
      c.delegation,
      kid.slice(5),
      c.releaseKeys,
      c.productTrust,
      c.expectedAud,
    );
    if (d === null) return { ok: false, step: "delegation" };
    if (
      Object.values(c.releaseKeys).includes(d.publicKey) ||
      Object.values(c.productTrust).includes(d.publicKey)
    )
      return { ok: false, step: "delegation" };
    delegation = d;
    key = d.publicKey;
  }
  const v = refVerifyJws(body, { [kid]: key }, "pkey-release+jws");
  if (!v) return { ok: false, step: "jws" };
  if (!refRecordClaims(v.payload, ctxOf(v.text), c.expectedAud))
    return { ok: false, step: "claims" };
  const doc = v.payload as Record<string, any>;
  if (c.pin) {
    if (
      doc.kind !== (c.pin.kind ?? "app") ||
      doc.deliverable !== c.pin.deliverable
    )
      return { ok: false, step: "cross-check" };
    if (doc.version !== c.pin.version || doc.seq !== c.pin.seq)
      return { ok: false, step: "cross-check" };
  }
  if (delegation !== null) {
    const root = delegation.deliverable as string;
    const inScope =
      doc.kind === "pack" &&
      (doc.deliverable === root || doc.deliverable.startsWith(`${root}.`)) &&
      (delegation.types as string[]).includes(doc.type) &&
      (doc.variants as Record<string, any>[]).every(
        (x) => x.files.layout === "tree",
      ) &&
      delegation.issuedAt <= doc.issuedAt &&
      doc.issuedAt <= delegation.expiresAt;
    if (!inScope) return { ok: false, step: "scope" };
  }
  return { ok: true, doc, delegation };
}

/** §2.3's `recordRevoked`, from first principles. */
function refRecordRevoked(
  record: string,
  delegation: string | null,
  revoked: readonly string[],
): "record" | "delegation" | null {
  if (revoked.includes(record)) return "record";
  if (delegation !== null && revoked.includes(delegation)) return "delegation";
  return null;
}

async function buildDelegationCases(): Promise<DelegationCase[]> {
  const CK = contentKey("djdl-events-2026");
  const CK2 = contentKey("djdl-events-other");
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const RK2: Record<string, string> = { ...RK, [REL2_KID]: pub(REL2_KID) };
  const PT: Record<string, string> = {
    [PIN_KID]: pub(PIN_KID),
    [ALT_KID]: pub(ALT_KID),
  };
  const DI = RECORD_ISSUED + 2_000;
  const DE = DI + 180 * 86400;
  const PI = DI + 3_000;
  const ROOT = "djdl.events";
  const TYP: TypV3 = "pkey-release+jws";

  const delDoc = (over: Record<string, unknown> = {}): Record<string, any> => ({
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: ROOT,
    kind: "delegation",
    version: "1",
    seq: 1,
    issuedAt: DI,
    expiresAt: DE,
    delegate: { publicKey: CK.pub },
    types: ["files.tree", "data.json"],
    notes: "Events team, corpus",
    ...over,
  });
  const signWith = async (
    payloadText: string,
    pemText: string,
    kid: string,
  ): Promise<string> => {
    const header = headerText(TYP, kid);
    const input = `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(payloadText))}`;
    const key = await importSigningKey(pemText);
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      utf8Bytes(input),
    );
    return `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
  };
  const signDel = (
    doc: Record<string, unknown>,
    kid = REL_KID,
  ): Promise<string> => signAs(doc, kid, TYP);
  const treeVariant = (
    sel: Record<string, string> = {},
  ): Record<string, unknown> => ({
    variant: sel,
    payload: { ...PACK_PAYLOADS.t1 },
    full: objRef("tree/t1.full.zst"),
    files: {
      format: "pkey-files/1",
      layout: "tree",
      ...objRef("tree/t1.files.zst"),
    },
  });
  const packRec = (
    over: Record<string, unknown> = {},
    deliverable = `${ROOT}.halloween`,
  ): Record<string, any> => ({
    ...packDoc(deliverable, "1.0.0", 1, {
      type: "files.tree",
      formatVersion: 1,
      variants: [treeVariant()],
    }),
    issuedAt: PI,
    ...over,
  });
  /** A record signed by a content key under the delegation `delJws`. */
  const signUnder = (
    doc: Record<string, unknown>,
    delJws: string,
    key: ContentKey = CK,
  ): Promise<string> =>
    signWith(JSON.stringify(doc), key.pem, `pkd1-${sha256Hex(delJws)}`);
  const pinOfDoc = (d: Record<string, any>): DelegationPin => ({
    kind: d.kind,
    deliverable: d.deliverable,
    version: d.version,
    seq: d.seq,
  });

  const D = await signDel(delDoc());
  const cases: DelegationCase[] = [];
  const ids = new Set<string>();
  const push = (c: DelegationCase): void => {
    if (ids.has(c.id)) throw new Error(`delegationCases: duplicate ${c.id}`);
    ids.add(c.id);
    cases.push(c);
  };

  /** A `record` or `release-only` case, checked against the reference at its step. */
  const rec = async (
    id: string,
    description: string,
    o: {
      jws: string;
      delegation?: string | null;
      releaseOnly?: boolean;
      releaseKeys?: Record<string, string>;
      pin?: DelegationPin | null;
      revoked?: string[];
      expect: "ok" | P19Step;
      revokedExpect?: "record" | "delegation" | null;
    },
  ): Promise<void> => {
    const delegation = o.releaseOnly ? null : (o.delegation ?? D);
    const pin =
      o.pin === undefined ? pinOfDoc(JSON.parse(payloadTextOf(o.jws)!)) : o.pin;
    const c: DelegationCase = {
      id,
      description,
      mode: o.releaseOnly ? "release-only" : "record",
      jws: o.jws,
      delegation,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: sha256Hex(o.jws),
      pin,
      ...(o.revoked ? { revoked: o.revoked } : {}),
      expect: {},
    };
    const r = refVerifyDelegatedRecord({
      jws: c.jws,
      delegation,
      releaseKeys: c.releaseKeys!,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: c.expectedHash!,
      pin,
    });
    if (o.expect === "ok") {
      if (!r.ok)
        throw new Error(
          `delegationCases ${id}: the reference refuses it at ${r.step}`,
        );
      const del =
        r.delegation === null
          ? null
          : {
              sha256: r.delegation.sha256,
              deliverable: r.delegation.deliverable,
              types: r.delegation.types,
              issuedAt: r.delegation.issuedAt,
              expiresAt: r.delegation.expiresAt,
            };
      c.expect = { verify: "ok", kind: r.doc.kind, delegation: del };
      if (o.revoked) {
        const got = refRecordRevoked(
          c.expectedHash!,
          del === null ? null : del.sha256,
          o.revoked,
        );
        if (got !== (o.revokedExpect ?? null))
          throw new Error(`delegationCases ${id}: recordRevoked is ${got}`);
        c.expect.revoked = got;
      }
    } else {
      if (r.ok || r.step !== o.expect)
        throw new Error(
          `delegationCases ${id}: the reference answers ${r.ok ? "ok" : r.step}, not ${o.expect}`,
        );
      c.expect = { verify: "fail", step: o.expect };
    }
    // Every delegated kid is `pkd1-` and its supplied delegation's hash, except the cases
    // built to break that.
    const kid = p19Kid(c.jws) as string;
    if (
      P19_KID_RE.test(kid) &&
      delegation !== null &&
      kid.slice(5) !== sha256Hex(delegation) &&
      !["delegation-hash-mismatch"].includes(id)
    )
      throw new Error(`delegationCases ${id}: kid names another delegation`);
    push(c);
  };

  // ── ok ──
  const base = packRec();
  await rec(
    "delegated-valid-files-tree",
    "The control: djdl.events.halloween (files.tree, tree layout) signed by the content key under a delegation of djdl.events for [files.tree, data.json], issued inside the window; the delegation is signed by the pinned 2026 release key.",
    { jws: await signUnder(base, D), expect: "ok" },
  );
  await rec(
    "delegated-valid-data-json",
    "A `data.json` pack (djdl.events.lore) under the same delegation.",
    {
      jws: await signUnder(packRec({ type: "data.json" }, `${ROOT}.lore`), D),
      expect: "ok",
    },
  );
  await rec(
    "delegated-valid-prefix-is-pack-id",
    "The record's pack id IS the scope root (djdl.events): whole-segment matching covers the root itself.",
    { jws: await signUnder(packRec({}, ROOT), D), expect: "ok" },
  );
  {
    const D27 = await signDel(delDoc(), REL2_KID);
    await rec(
      "delegated-valid-delegation-by-2027-key",
      "The delegation is signed by the second pinned release key (2027), during a rotation.",
      {
        jws: await signUnder(base, D27),
        delegation: D27,
        releaseKeys: RK2,
        expect: "ok",
      },
    );
  }
  await rec(
    "delegated-valid-window-start",
    "The record's `issuedAt` equals the delegation's `issuedAt` (the window is closed at both ends).",
    { jws: await signUnder(packRec({ issuedAt: DI }), D), expect: "ok" },
  );
  await rec(
    "delegated-valid-window-end",
    "The record's `issuedAt` equals the delegation's `expiresAt`.",
    { jws: await signUnder(packRec({ issuedAt: DE }), D), expect: "ok" },
  );
  const DU = await signDel(
    delDoc({ types: ["files.tree", "godot.pck", "future.type"] }),
  );
  await rec(
    "delegated-valid-unknown-types-ignored",
    "The delegation lists [files.tree, godot.pck, future.type]: godot.pck is never delegable and future.type is unknown, so both are ignored and the effective types are [files.tree].",
    { jws: await signUnder(base, DU), delegation: DU, expect: "ok" },
  );
  {
    const relSigned = await signAs(base, REL_KID, TYP);
    await rec(
      "release-kid-ignores-delegation",
      "A pack record signed by the pinned release key itself, with a delegation supplied: today's path, the delegation is ignored and the result's `delegation` is null.",
      { jws: relSigned, expect: "ok" },
    );
  }
  await rec(
    "delegation-record-verify-only",
    "The delegation record verified as a record with no pin and no delegation: `kind: delegation` verifies (steps 12–14) and is never acted on as a record.",
    { jws: D, releaseOnly: true, pin: null, expect: "ok" },
  );

  // ── delegation ──
  const viaDel = async (
    id: string,
    description: string,
    del: string,
    o: {
      releaseKeys?: Record<string, string>;
      key?: ContentKey;
      doc?: Record<string, unknown>;
    } = {},
  ): Promise<void> =>
    rec(id, description, {
      jws: await signUnder(o.doc ?? base, del, o.key),
      delegation: del,
      releaseKeys: o.releaseKeys,
      expect: "delegation",
    });
  await viaDel(
    "delegation-unpinned-signer",
    "The delegation is signed by the 2027 release key, which this app does not pin.",
    await signDel(delDoc(), REL2_KID),
  );
  await viaDel(
    "delegation-signed-by-product-key",
    "The delegation is signed by the product key; even listed among the release keys, a key in the product trust set is refused (step 13's product-key rule).",
    await signDel(delDoc(), PIN_KID),
    { releaseKeys: { ...RK, [PIN_KID]: pub(PIN_KID) } },
  );
  {
    const D2 = await signDel(delDoc({ notes: "Another delegation" }));
    await rec(
      "delegation-hash-mismatch",
      "The record's kid names the base delegation, but the caller supplies a different (valid) delegation: its hash is not the kid's.",
      { jws: await signUnder(base, D), delegation: D2, expect: "delegation" },
    );
  }
  {
    const app = await signAs(recordDoc(), REL_KID, TYP);
    await viaDel(
      "delegation-not-a-delegation",
      "The kid names an app record signed by the release key: it verifies as a record but is not `kind: delegation`.",
      app,
    );
  }
  {
    const inner = await signWith(
      JSON.stringify(delDoc({ notes: "Re-delegated" })),
      CK.pem,
      `pkd1-${sha256Hex(D)}`,
    );
    await viaDel(
      "delegation-signed-by-content-key",
      "The delegation is itself signed by a content key (under the base delegation): a delegation verifies against pinned release keys only, so a content key can never re-delegate (one level only).",
      inner,
    );
  }
  {
    const d = delDoc();
    delete d.types;
    await viaDel(
      "delegation-types-missing",
      "The delegation has no `types`.",
      await signDel(d),
    );
  }
  await viaDel(
    "delegation-types-none-effective",
    "`types` is [godot.pck]: no listed type is delegable, so there are no effective types.",
    await signDel(delDoc({ types: ["godot.pck"] })),
  );
  await viaDel(
    "delegation-types-too-many",
    "`types` has 9 entries (the bound is 8).",
    await signDel(
      delDoc({
        types: [
          "files.tree",
          "data.json",
          "l10n.table",
          "a.one",
          "a.two",
          "a.three",
          "a.four",
          "a.five",
          "a.six",
        ],
      }),
    ),
  );
  await viaDel(
    "delegation-types-duplicate",
    "`types` lists files.tree twice.",
    await signDel(delDoc({ types: ["files.tree", "files.tree"] })),
  );
  await viaDel(
    "delegation-ttl-over-max",
    "`expiresAt − issuedAt` is 31,622,401 seconds, one over the 366-day bound.",
    await signDel(delDoc({ expiresAt: DI + P19_MAX_TTL + 1 })),
  );
  await viaDel(
    "delegation-expires-before-issued",
    "`expiresAt` is one second before `issuedAt`.",
    await signDel(delDoc({ expiresAt: DI - 1 })),
  );
  {
    const text = rawJson(delDoc({ expiresAt: raw("1.8e9") }));
    await viaDel(
      "delegation-expiresat-token",
      "`expiresAt` is the token 1.8e9: an exponent is never an integer claim (V4 §3.1), so the delegation is unusable.",
      await signText(text, REL_KID, TYP),
    );
  }
  await viaDel(
    "delegation-public-key-malformed",
    "`delegate.publicKey` is base64url of 31 bytes, not 32.",
    await signDel(
      delDoc({
        delegate: {
          publicKey: base64UrlEncodeBytes(
            base64UrlDecode(CK.pub).subarray(0, 31),
          ),
        },
      }),
    ),
  );
  {
    const relPem = pem(REL_KID);
    const dRel = await signDel(
      delDoc({ delegate: { publicKey: pub(REL_KID) } }),
    );
    await rec(
      "delegation-key-is-release-key",
      "The delegated key is the pinned release key itself (the record is signed by it under a pkd1- kid): refused, a delegated key is never a release key.",
      {
        jws: await signWith(
          JSON.stringify(base),
          relPem,
          `pkd1-${sha256Hex(dRel)}`,
        ),
        delegation: dRel,
        expect: "delegation",
      },
    );
    const dPk = await signDel(
      delDoc({ delegate: { publicKey: pub(PIN_KID) } }),
    );
    await rec(
      "delegation-key-is-product-key",
      "The delegated key is a product signing key (the record is signed by it under a pkd1- kid): refused, a delegated key is never a product key.",
      {
        jws: await signWith(
          JSON.stringify(base),
          pem(PIN_KID),
          `pkd1-${sha256Hex(dPk)}`,
        ),
        delegation: dPk,
        expect: "delegation",
      },
    );
  }
  await viaDel(
    "delegation-deliverable-app",
    "The delegation's `deliverable` is `app`, not a pack id.",
    await signDel(delDoc({ deliverable: "app" })),
  );

  // ── jws ──
  await rec(
    "delegated-no-delegation-supplied",
    "A delegated record verified without its delegation (a pre-P4-19 caller, or an app path): the kid is not a pinned release key, so step 13 refuses it at `jws`.",
    { jws: await signUnder(base, D), releaseOnly: true, expect: "jws" },
  );
  await rec(
    "delegated-wrong-signer",
    "The record names the base delegation but is signed by another content key.",
    { jws: await signUnder(base, D, CK2), expect: "jws" },
  );
  await rec(
    "delegated-kid-malformed",
    "The kid is `pkd1-` and 63 hex digits: not the delegated pattern, so no delegation is consulted.",
    {
      jws: await signWith(
        JSON.stringify(base),
        CK.pem,
        `pkd1-${sha256Hex(D).slice(0, 63)}`,
      ),
      expect: "jws",
    },
  );
  {
    const baseHash = sha256Hex(await signUnder(base, D));
    const revDocC = {
      schemaVersion: 1,
      aud: AUD_V3,
      deliverable: `${ROOT}.halloween`,
      kind: "revocation",
      version: "1.0.0",
      seq: 1,
      issuedAt: PI + 100,
      revokes: baseHash,
      reason: "Signed by a content key.",
    };
    const jws = await signUnder(revDocC, D);
    const entry = {
      record: sha256Hex(jws),
      pack: `${ROOT}.halloween`,
      target: baseHash,
      version: "1.0.0",
      seq: 1,
    };
    const r = refVerifyRevocationCase({
      id: "",
      description: "",
      mode: "revocation",
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "ok" },
    });
    if (r.verify !== "fail" || r.step !== "jws")
      throw new Error("delegationCases revocation-signed-by-content-key");
    push({
      id: "revocation-signed-by-content-key",
      description:
        "A revocation signed by the content key under a pkd1- kid: `verifyRevocation` never passes a delegation, so it is refused at `jws` (only release keys revoke).",
      mode: "revocation",
      jws,
      delegation: null,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "fail", step: "jws" },
    });
  }
  const appDoc = recordDoc({ issuedAt: PI });
  await rec(
    "app-record-by-content-key-release-only",
    "An app record signed by the content key, verified on an app path (no delegation passed): `jws`.",
    {
      jws: await signUnder(appDoc, D),
      releaseOnly: true,
      expect: "jws",
    },
  );

  // ── scope ──
  {
    const levels = packRecordDocs()["djdl.levels@1.0.0"]!;
    await rec(
      "delegated-godot-pck",
      "A `godot.pck` (container) pack under a delegation that even lists godot.pck: never an effective type, so `scope`.",
      {
        jws: await signUnder(
          {
            ...levels,
            deliverable: `${ROOT}.halloween`,
            tag: "djdl.events.halloween-v1.0.0",
            issuedAt: PI,
          },
          DU,
        ),
        delegation: DU,
        expect: "scope",
      },
    );
  }
  await rec(
    "delegated-type-not-delegated",
    "An `l10n.table` pack: a delegable type, but not one this delegation lists.",
    {
      jws: await signUnder(packRec({ type: "l10n.table" }), D),
      expect: "scope",
    },
  );
  {
    const c = packRecordDocs()["djdl.levels@1.0.0"]!;
    const container = structuredClone(
      (c.variants as Record<string, unknown>[])[0]!,
    );
    delete container.requires;
    container.variant = { texture: "etc2" };
    await rec(
      "delegated-container-layout",
      "A `files.tree`-typed record with a second, `container`-layout variant: a container is never delegable, whatever the type.",
      {
        jws: await signUnder(
          packRec({ variants: [treeVariant({ texture: "s3tc" }), container] }),
          D,
        ),
        expect: "scope",
      },
    );
  }
  await rec(
    "delegated-outside-prefix",
    "A pack outside the scope (djdl.levels).",
    { jws: await signUnder(packRec({}, "djdl.levels"), D), expect: "scope" },
  );
  await rec(
    "delegated-prefix-not-segment",
    "djdl.eventsx shares the scope root's characters but not its segment: whole-segment matching refuses it.",
    { jws: await signUnder(packRec({}, "djdl.eventsx"), D), expect: "scope" },
  );
  await rec(
    "delegated-after-window",
    "The record's `issuedAt` is one second after the delegation's `expiresAt` (the brief's expired delegation): devices check the record against the signing window, never their clock.",
    {
      jws: await signUnder(packRec({ issuedAt: DE + 1 }), D),
      expect: "scope",
    },
  );
  await rec(
    "delegated-before-window",
    "The record's `issuedAt` is one second before the delegation's `issuedAt`.",
    {
      jws: await signUnder(packRec({ issuedAt: DI - 1 }), D),
      expect: "scope",
    },
  );
  await rec(
    "app-record-by-content-key",
    "An app record signed by the content key with its delegation supplied (a runner passing one on an app path): steps 13–15 pass, step 16 refuses `kind: app`.",
    { jws: await signUnder(appDoc, D), expect: "scope" },
  );
  await rec(
    "delegation-by-content-key-as-record",
    "A delegation signed by the content key, verified as a record with the base delegation supplied: step 16 refuses `kind: delegation`.",
    {
      jws: await signUnder(delDoc({ issuedAt: PI, expiresAt: PI + 86400 }), D),
      pin: null,
      expect: "scope",
    },
  );

  // ── revocation and recordRevoked ──
  const rev = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
  ): Promise<void> => {
    const doc = {
      schemaVersion: 1,
      aud: AUD_V3,
      deliverable: ROOT,
      kind: "revocation",
      version: "1",
      seq: 1,
      issuedAt: PI + 500,
      revokes: sha256Hex(D),
      reason: "Content key retired.",
      ...over,
    };
    const jws = await signAs(doc, REL_KID, TYP);
    const entry = {
      record: sha256Hex(jws),
      pack: ROOT,
      target: sha256Hex(D),
      version: "1",
      seq: 1,
      kind: "delegation",
    };
    const c: RevocationCase = {
      id,
      description,
      mode: "revocation",
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "ok" },
    };
    const r = refVerifyRevocationCase(c);
    if (r.verify !== "ok")
      throw new Error(`delegationCases ${id}: the reference refuses it`);
    push({
      id,
      description,
      mode: "revocation",
      jws,
      delegation: null,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: r as Record<string, unknown>,
    });
  };
  await rev(
    "revocation-of-delegation-valid",
    "P4-13's revocation record unchanged, naming the delegation: `deliverable`, `version` and `seq` are the delegation's and `revokes` its hash; the feed entry carries `kind: delegation`.",
    {},
  );
  const baseJws = await signUnder(base, D);
  await rec(
    "delegated-revoked-delegation",
    "The control record with the delegation's hash revoked: it verifies, and `recordRevoked` answers `delegation` (pack-revoked, detail delegation).",
    {
      jws: baseJws,
      revoked: [sha256Hex(D)],
      revokedExpect: "delegation",
      expect: "ok",
    },
  );
  await rec(
    "delegated-revoked-record",
    "The control record with its own hash revoked: `recordRevoked` answers `record` first.",
    {
      jws: baseJws,
      revoked: [sha256Hex(baseJws), sha256Hex(D)],
      revokedExpect: "record",
      expect: "ok",
    },
  );
  await rev(
    "revocation-of-delegation-replacement-ignored",
    "A delegation revocation carrying a `replacement`: `verifyRevocation` is unchanged and parses it, but ingest refuses it and a device ignores it for a delegation target (no release replaces a delegation).",
    {
      replacement: {
        sha256: sha256Hex(baseJws),
        seq: 1,
        version: "1.0.0",
      },
    },
  );

  // ── feed ──
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const feedCase = async (
    id: string,
    description: string,
    entries: Record<string, unknown>[],
    rawText = false,
  ): Promise<void> => {
    const doc = { ...feedPayload(), revocations: entries };
    const text = rawText ? rawJson(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText("pkey-feed+jws", PIN_KID),
      text,
      PIN_KID,
    );
    const v = refVerifyJws(jws, TRUST, "pkey-feed+jws");
    if (!v) throw new Error(`delegationCases ${id}: does not verify`);
    if (
      refFeedClaims(v.payload, ctxOf(v.text), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      throw new Error(`delegationCases ${id}: fails the feed claims`);
    const content = refFeedContent(v.payload, ctxOf(v.text));
    if (refNonWire(v.text).length > 0)
      throw new Error(`delegationCases ${id}: non-wire integers`);
    push({
      id,
      description,
      mode: "feed",
      jws,
      trust: TRUST,
      expectedAud: AUD_V3,
      channel: "stable",
      platform: "macos",
      now: FEED_NOW,
      checkFreshness: true,
      expect: { verify: "ok", content },
    });
  };
  const packEntry = {
    record: p13RevRecord("foes@1.3.3"),
    pack: "diceroll.foes",
    target: p13Hash("foes@1.3.3"),
    version: "1.3.3",
    seq: 10,
  };
  const delEntry = (kind: unknown): Record<string, unknown> => ({
    record: sha256Hex("pkey-corpus-revocation:delegation:1"),
    pack: "diceroll.events",
    target: sha256Hex("pkey-corpus-delegation:diceroll.events:1"),
    version: "1",
    seq: 1,
    kind,
  });
  await feedCase(
    "feed-revocation-kind-delegation",
    "A feed whose `revocations` hold a pack-record entry (no `kind`) and a delegation entry (`kind: delegation`, `pack` the scope root): both are kept, `kind` carried as present.",
    [packEntry, delEntry("delegation")],
  );
  await feedCase(
    "feed-revocation-kind-unknown-dropped",
    "An entry whose `kind` is a forward vocabulary token (`future`): that entry alone is dropped.",
    [packEntry, delEntry("future")],
  );
  await feedCase(
    "feed-revocation-kind-not-string",
    "An entry whose `kind` is null: the `revocations` member is unusable (null), never the feed.",
    [packEntry, delEntry(null)],
  );

  // Self-checks: the counts; every step and mode the plan lists is present.
  if (cases.length !== P19_COUNTS.delegationCases)
    throw new Error(
      `delegationCases: ${cases.length} != ${P19_COUNTS.delegationCases}`,
    );
  const steps = new Set(
    cases.map((c) =>
      c.expect.verify === "ok" ? "ok" : (c.expect.step as string),
    ),
  );
  for (const s of ["ok", "delegation", "jws", "scope"])
    if (!steps.has(s)) throw new Error(`delegationCases: no ${s} case`);
  return cases;
}

/** The content corpus over the signed pack records (`tools/gen-content-corpus.ts`), with the join
 *  self-check: every `refs.json` entry is pinned by a valid record or a `plan-real-*` row. */
async function buildContent(): Promise<{
  cases: Record<string, unknown>;
  planMatrix: Record<string, unknown>;
}> {
  const packs = await packRecords();
  const built = buildContentCorpus(REF_JSON, contentSet(), {
    get: (name) => {
      const r = packs.get(name);
      if (!r) throw new Error(`content corpus: no pack record ${name}`);
      return { doc: r.doc, sha256: r.sha256 };
    },
    appContent: appTwin(packs).content as Record<string, unknown>,
    docsPin: (() => {
      const r = packs.get("djdl.docs@1.0.0")!;
      return { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version };
    })(),
  });
  const pinned = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (typeof v.sha256 === "string") pinned.add(v.sha256);
      Object.values(v).forEach(walk);
    }
  };
  for (const r of packs.values()) walk(r.doc.variants);
  for (const [name, r] of Object.entries(contentSet().refsJson))
    if (!pinned.has(r.sha256) && !built.planRealPins.has(name))
      throw new Error(
        `content corpus: refs.json ${name} is pinned by no record or plan row`,
      );
  return { cases: built.cases, planMatrix: built.planMatrix };
}

// ── `feed-url-matrix.json` v1 (SP-00, plans/SP-00.md §4 and D5) ─────────────────────────────
// The app-updater feed URL a native updater is handed, built from discovery's `update.endpoints`
// rather than string-built by the caller. The templates are the Worker's own: the `everything`
// product of `packages/worker/test/fixtures/discovery-golden.json`, which discoveryGolden.test.ts
// holds byte-equal to what `updateService.discoveryFragment` serves
// (packages/worker/src/services/update/index.ts). (The transcripts' discovery fixture runs with
// Update off, so it carries no `update.endpoints`.) Reading the golden makes a Worker change to a
// template go stale here under `--check`.
//
// The expansion is the one the SDKs already ship (sdk-node `appcastUrlFrom`; Godot
// `PKeyDiscovery.appcast_url_from`, `PKeyUpdate._expand` and `PKeyUpdater.feed_url`, P3-10):
//
//   * channel: absent means `stable`; an alias is rewritten through CHANNEL_ALIASES first
//     (`staging` → `beta`, `latest` → `stable`). Validating a channel NAME is the caller's job
//     (gate-matrix's channel rows); this pins the expansion only.
//   * every `{channel}`, `{velopackChannel}` and `{buildId}` is replaced by the value encoded
//     as encodeURIComponent (UTF-8, unreserved `A-Za-z0-9-_.!~*'()` kept), in that order —
//     an encoded value cannot contain `{`, so no substitution sees another's output.
//   * `appcast` takes `endpoints.appcast` (the stable feed) and, for any other channel, makes
//     the channel a PATH segment before `/appcast.xml` — the stable feed's sibling.
//   * `velopack` with a `velopackChannel` is the releases file; without one it is the feed
//     DIRECTORY Velopack's UpdateManager is opened on (the template up to `releases.`, which
//     UpdateManager appends itself).
//   * `zsync` needs a `buildId` (the AppImage build's artifact-map id).
//   * a kind whose template the endpoints do not carry is `{unsupported: "product"}`.

const DISCOVERY_GOLDEN = join(
  HERE,
  "..",
  "packages",
  "worker",
  "test",
  "fixtures",
  "discovery-golden.json",
);

/** Feed kind → the `update.endpoints` key it reads. */
const FEED_URL_KINDS = {
  appcast: "appcast",
  winsparkle: "winsparkle",
  velopack: "velopack",
  appInstaller: "appInstaller",
  zsync: "zsync",
} as const;
type FeedUrlKind = keyof typeof FEED_URL_KINDS;

/** The keys P3-09 added after `feed` (discoveryGolden.test.ts's header names them). */
const APP_UPDATER_ENDPOINTS = [
  "winsparkle",
  "velopack",
  "appInstaller",
  "zsync",
] as const;

interface FeedUrlInput {
  kind: FeedUrlKind;
  channel?: string;
  velopackChannel?: string;
  buildId?: string;
}
type FeedUrlExpect = { url: string } | { unsupported: "product" };

/** The reference expansion (see the section comment). */
function refFeedUrl(
  endpoints: Record<string, string>,
  input: FeedUrlInput,
): FeedUrlExpect {
  const template = endpoints[FEED_URL_KINDS[input.kind]];
  if (typeof template !== "string" || template === "")
    return { unsupported: "product" };
  const requested = input.channel ?? "stable";
  const channel =
    (CHANNEL_ALIASES as Record<string, string>)[requested] ?? requested;
  if (input.kind === "appcast") {
    if (channel === "stable") return { url: template };
    const at = template.search(/[?#]/);
    const path = at < 0 ? template : template.slice(0, at);
    const tail = at < 0 ? "" : template.slice(at);
    if (!path.endsWith("/appcast.xml")) return { url: template };
    return {
      url: `${path.slice(0, -"/appcast.xml".length)}/${encodeURIComponent(channel)}/appcast.xml${tail}`,
    };
  }
  let t = template;
  if (input.kind === "velopack" && input.velopackChannel === undefined) {
    const at = t.indexOf("releases.");
    if (at < 0)
      throw new Error("feed-url-matrix: a velopack template without releases.");
    t = t.slice(0, at);
  }
  if (input.kind === "zsync" && input.buildId === undefined)
    throw new Error("feed-url-matrix: a zsync row needs a buildId");
  t = t.split("{channel}").join(encodeURIComponent(channel));
  if (input.velopackChannel !== undefined)
    t = t
      .split("{velopackChannel}")
      .join(encodeURIComponent(input.velopackChannel));
  if (input.buildId !== undefined)
    t = t.split("{buildId}").join(encodeURIComponent(input.buildId));
  if (/[{}]/.test(t))
    throw new Error(`feed-url-matrix: an unexpanded placeholder in ${t}`);
  return { url: t };
}

function buildFeedUrlMatrixV1(): unknown {
  const golden = JSON.parse(readFileSync(DISCOVERY_GOLDEN, "utf8")) as {
    everything: { services: { update: { endpoints: Record<string, string> } } };
  };
  const everything = golden.everything.services.update.endpoints;
  for (const key of [...Object.values(FEED_URL_KINDS), "channelAppcast"])
    if (typeof everything[key] !== "string")
      throw new Error(
        `feed-url-matrix: the golden has no update.endpoints.${key}`,
      );
  // The same Worker before P3-09: the four app-updater templates are absent.
  const withoutAppUpdaterFeeds = Object.fromEntries(
    Object.entries(everything).filter(
      ([k]) => !(APP_UPDATER_ENDPOINTS as readonly string[]).includes(k),
    ),
  );
  const endpointSets: Record<string, Record<string, string>> = {
    everything,
    withoutAppUpdaterFeeds,
    // A product with Update off advertises no endpoints (`{"enabled": false}`).
    updateOff: {},
  };
  const B = "https://key.plrs.im/full/update";
  const ENC = "qa%20build%2F%C3%BC~*";
  const row = (
    name: string,
    endpoints: string,
    input: FeedUrlInput,
    expect: FeedUrlExpect,
  ) => ({ name, endpoints, input, expect });
  const no = { unsupported: "product" } as const;
  const rows = [
    row(
      "appcast — no channel is the stable feed",
      "everything",
      { kind: "appcast" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — stable",
      "everything",
      { kind: "appcast", channel: "stable" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — beta is a path segment",
      "everything",
      { kind: "appcast", channel: "beta" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "appcast — staging is the beta alias",
      "everything",
      { kind: "appcast", channel: "staging" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "appcast — latest is the stable alias",
      "everything",
      { kind: "appcast", channel: "latest" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — a manual channel",
      "everything",
      { kind: "appcast", channel: "nightly" },
      { url: `${B}/nightly/appcast.xml` },
    ),
    row(
      "appcast — a channel is percent-encoded",
      "everything",
      { kind: "appcast", channel: "qa build/ü~*" },
      { url: `${B}/${ENC}/appcast.xml` },
    ),
    row(
      "winsparkle — no channel is stable",
      "everything",
      { kind: "winsparkle" },
      { url: `${B}/stable/winsparkle.xml` },
    ),
    row(
      "winsparkle — beta",
      "everything",
      { kind: "winsparkle", channel: "beta" },
      { url: `${B}/beta/winsparkle.xml` },
    ),
    row(
      "winsparkle — staging is the beta alias",
      "everything",
      { kind: "winsparkle", channel: "staging" },
      { url: `${B}/beta/winsparkle.xml` },
    ),
    row(
      "winsparkle — a channel is percent-encoded",
      "everything",
      { kind: "winsparkle", channel: "qa build/ü~*" },
      { url: `${B}/${ENC}/winsparkle.xml` },
    ),
    row(
      "velopack — beta, win-x64 releases file",
      "everything",
      { kind: "velopack", channel: "beta", velopackChannel: "win-x64" },
      { url: `${B}/beta/velopack/releases.win-x64.json` },
    ),
    row(
      "velopack — staging is the beta alias",
      "everything",
      { kind: "velopack", channel: "staging", velopackChannel: "linux" },
      { url: `${B}/beta/velopack/releases.linux.json` },
    ),
    row(
      "velopack — no velopackChannel is the UpdateManager feed directory",
      "everything",
      { kind: "velopack", channel: "stable" },
      { url: `${B}/stable/velopack/` },
    ),
    row(
      "velopack — a velopackChannel is percent-encoded",
      "everything",
      { kind: "velopack", channel: "stable", velopackChannel: "win x64" },
      { url: `${B}/stable/velopack/releases.win%20x64.json` },
    ),
    row(
      "appInstaller — stable",
      "everything",
      { kind: "appInstaller", channel: "stable" },
      { url: `${B}/stable/app.appinstaller` },
    ),
    row(
      "appInstaller — latest is the stable alias",
      "everything",
      { kind: "appInstaller", channel: "latest" },
      { url: `${B}/stable/app.appinstaller` },
    ),
    row(
      "appInstaller — a pr channel",
      "everything",
      { kind: "appInstaller", channel: "pr-42" },
      { url: `${B}/pr-42/app.appinstaller` },
    ),
    row(
      "zsync — beta build",
      "everything",
      { kind: "zsync", channel: "beta", buildId: "linux-x64.appimage" },
      { url: `${B}/beta/linux-x64.appimage.AppImage.zsync` },
    ),
    row(
      "zsync — no channel is stable",
      "everything",
      { kind: "zsync", buildId: "linux-arm64" },
      { url: `${B}/stable/linux-arm64.AppImage.zsync` },
    ),
    row(
      "zsync — a channel is percent-encoded",
      "everything",
      { kind: "zsync", channel: "qa build/ü~*", buildId: "linux-arm64" },
      { url: `${B}/${ENC}/linux-arm64.AppImage.zsync` },
    ),
    row(
      "appcast — a Worker before P3-09 still serves it",
      "withoutAppUpdaterFeeds",
      { kind: "appcast", channel: "beta" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "winsparkle — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "winsparkle", channel: "beta" },
      no,
    ),
    row(
      "velopack — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "velopack", channel: "beta", velopackChannel: "win" },
      no,
    ),
    row(
      "appInstaller — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "appInstaller" },
      no,
    ),
    row(
      "zsync — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "zsync", buildId: "linux-arm64" },
      no,
    ),
    row(
      "appcast — unsupported with Update off",
      "updateOff",
      { kind: "appcast" },
      no,
    ),
    row(
      "winsparkle — unsupported with Update off",
      "updateOff",
      { kind: "winsparkle", channel: "beta" },
      no,
    ),
  ];
  const names = new Set<string>();
  const kinds = new Set<string>();
  for (const r of rows) {
    if (names.has(r.name))
      throw new Error(`feed-url-matrix: two rows named ${r.name}`);
    names.add(r.name);
    kinds.add(r.input.kind);
    const set = endpointSets[r.endpoints];
    if (!set)
      throw new Error(`feed-url-matrix: ${r.name} names no endpoint set`);
    const got = refFeedUrl(set, r.input);
    if (JSON.stringify(got) !== JSON.stringify(r.expect))
      throw new Error(
        `feed-url-matrix: ${r.name} expands to ${JSON.stringify(got)}, the row says ${JSON.stringify(r.expect)}`,
      );
  }
  for (const k of Object.keys(FEED_URL_KINDS))
    if (!kinds.has(k)) throw new Error(`feed-url-matrix: no row for ${k}`);
  return {
    feedUrlMatrixVersion: 1,
    description:
      "App-updater feed URLs from discovery's `update.endpoints` (plans/SP-00.md D5; proof of `update.feeds`). `endpointSets` holds the Worker's templates — `everything` is the `everything` product of the Worker's byte-checked discovery golden, `withoutAppUpdaterFeeds` the same Worker before P3-09 added `winsparkle`, `velopack`, `appInstaller` and `zsync`, and `updateOff` a product with Update off — and `kinds` maps each feed kind to the endpoints key it reads. Each row names an endpoint set and an input `{kind, channel?, velopackChannel?, buildId?}`; `expect` is `{url}`, or `{unsupported: \"product\"}` when the set carries no template for the kind. The expansion: an absent channel is `stable`, and an alias is rewritten through CHANNEL_ALIASES (`staging` → `beta`, `latest` → `stable`) first; `{channel}`, `{velopackChannel}` and `{buildId}` are each replaced by the value encoded as encodeURIComponent. `appcast` reads `endpoints.appcast` (the stable feed) and, for any other channel, inserts the channel as a path segment before `/appcast.xml`. `velopack` without a `velopackChannel` is the feed directory Velopack's UpdateManager opens (the template up to `releases.`). A `zsync` input always carries a `buildId`. Channel-name validity is not pinned here (gate-matrix's channel rows pin it): the percent-encoded rows use a value outside the channel alphabet only to pin the encoding.",
    kinds: FEED_URL_KINDS,
    endpointSets,
    rows,
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
  // plans/P4-01.md §4.2: the explicit blob rebuild, never in the gate. It writes only
  // `content/blobs/` (refs.json included); run `pnpm gen:corpus` afterwards. `--blobs <dir>`
  // points it at another blob directory (gen-content-corpus.test.ts passes a temporary copy).
  if (process.argv.includes("--rebuild-content-blobs")) {
    const flag = (name: string): string | undefined => {
      const at = process.argv.indexOf(name);
      if (at < 0) return undefined;
      const value = process.argv[at + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${name} needs a directory`);
      return value;
    };
    rebuildContentBlobs(REF_JSON, {
      payloadsDir: flag("--payloads"),
      blobsDir: flag("--blobs"),
    });
    return;
  }

  // The fingerprint + device-id vectors. Unsigned (they pin hash formulas, not signatures),
  // but guarded by the same drift gate and mirrored alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Ten files and the `content/` directory in one place so a runner can point at `corpus/v2/`
  // and find everything it needs, and so `--check` guards the whole set. The `fingerprint.json` formulas are
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
  const v2StageMatrix = await format(JSON.stringify(buildStageMatrix()), {
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
  // Wire contract v4's two decision tables (plans/P3-01.md §4.6, §4.7): unsigned client
  // behaviour, recomputed by the generator's reference implementations, mirrored like the rest.
  // `buildV2` above has built the record vectors their rows pin.
  const v2UpdateMatrix = await format(JSON.stringify(buildUpdateMatrixV1()), {
    parser: "json",
  });
  const v2OutletMatrix = await format(JSON.stringify(buildOutletMatrixV1()), {
    parser: "json",
  });
  // SP-00 (plans/SP-00.md D5): the app-updater feed URLs out of discovery's `update.endpoints`.
  const v2FeedUrlMatrix = await format(JSON.stringify(buildFeedUrlMatrixV1()), {
    parser: "json",
  });
  // plans/P4-01.md §4.1–§4.5 (P4-04): the content corpus and `plan-matrix.json`, rebuilt from
  // the committed inputs after `buildV2` has signed the pack records they join by hash.
  const content = await buildContent();
  const contentCases = await format(JSON.stringify(content.cases), {
    parser: "json",
  });
  const planMatrix = await format(JSON.stringify(content.planMatrix), {
    parser: "json",
  });
  // plans/U-01.md §4.1 (U-18): the Cloud Sync client scenario corpus. Literal data with its own
  // self-check (tools/sync-scenarios.ts); unsigned, mirrored like the rest.
  const syncScenarios = await format(JSON.stringify(buildSyncScenarios()), {
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
    [basename(V2_UPDATE_MATRIX_OUT), v2UpdateMatrix],
    [basename(V2_OUTLET_MATRIX_OUT), v2OutletMatrix],
    [basename(V2_PLAN_MATRIX_OUT), planMatrix],
    [basename(V2_FEED_URL_MATRIX_OUT), v2FeedUrlMatrix],
    [basename(V2_SYNC_SCENARIOS_OUT), syncScenarios],
  ]);
  let stale = false;
  // `content/` is source-only (§4.1): its cases are reconciled in the source tree alone, its
  // blobs are inputs nothing here writes, and a `content/` directory in a mirror is stray.
  stale =
    reconcile(join(CONTENT_DIR, CONTENT_CASES_NAME), contentCases, check) ||
    stale;
  for (const path of contentStrays([SWIFT_V2_RESOURCES, GODOT_V2_RESOURCES])) {
    console.error(`stray: ${path} is not written by the generator`);
    stale = true;
  }
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

// The case-driving half of the corpus v2 conformance runner, shared by two runners that load the
// same files differently: `corpusV2.test.ts` (Node, reads them with node:fs) and
// `conformance/runners/browser` (Chromium, Firefox and WebKit through Vitest browser mode, which
// imports them through Vite). Neither runner owns a case: both call `defineCorpusSuites` with the
// parsed files named in `CORPUS_FILES`, so a vector added to the corpus runs in every JS runtime
// at once. Nothing here may import a Node builtin — this module runs in a browser.
//
// Corpus v2 / wire contract v4. This module drives EVERY vector in its four files through
// `@polaris-key/client-core` — the single isomorphic implementation every JS SDK will consume —
// and asserts the expected outcome. The Python, Swift and Godot runners mirror THIS file against
// the SAME corpus (Swift and Godot read generator-owned
// mirrors); that is how every SDK proves byte-identical verification. Godot runs `jwsCases`
// so far, and reads `expect.docNulReplaced` (WIRE-CONTRACT-V3 §10), which the JS runners ignore.
//
// Seven v3 sections, seven layers of the contract:
//
//   jwsCases         §1–§2 raw compact-JWS verification    → @polaris-key/jws verifyJws
//   licenseDocCases  §3 claim validation, license          → verifyLicenseDoc
//   configDocCases   §3 claim validation, config           → verifyConfigDoc
//   trustCases       §1 trust merge / prune / revocation   → verifyTrustManifest + mergeTrust
//   clockFloorCases  §4.2 monotonic floor over 3 artifacts → the reload path + licenseState
//   gate-matrix      §5 the gate decision table            → licenseState
//   bundleCases      §7 offline bundle import              → inspectBundle
//
// and, for wire contract v4 (docs/security/WIRE-CONTRACT-V4.md, plans/P3-01.md §5 order 0):
//
//   the pointer sets  §4.1 nonWireIntegers over the nine JWS families  → verifyJws
//   versionCases      update-matrix.json, the version comparator      → compareVersions
//   feedCases         steps 4–6 over every case that reaches them     → feedClaims
//   releaseRecordCases step 14 over every case that reaches it        → releaseRecordClaims
//
// and, for packs on the wire (plans/P4-01.md §5 order 0, P4-21):
//
//   the pointer sets  §4.1 over packRecordCases and markerCases       → verifyJws
//   packRecordCases   step 14 over every case that reaches it         → releaseRecordClaims
//   markerCases       step 14 over every marker release that reaches it → releaseRecordClaims
//
// with `outlet-matrix.json`'s capability tables asserted against `@polaris-key/protocol/
// distribution`; and, from P3-05 (plans/P3-01.md §5 order 1), the full verifiers and the rest
// of the update matrix:
//
//   feedCases         steps 3–8, every case                            → verifyFeed
//   releaseRecordCases steps 12–15, every case                         → verifyReleaseRecord
//   capabilityCases   update-matrix.json, §2.9's narrowing             → effectiveCapabilities
//   outletCases       update-matrix.json, the decision's outlet        → resolveUpdateOutlet
//   bucketVectors     update-matrix.json, the rollout bucket           → rolloutBucket
//   rows              update-matrix.json, every decision and boot      → decideUpdate, bootDecision
//
// and, from P3-11 (§5 order 3), detection:
//
//   rows              outlet-matrix.json, every row                    → detectOutlet
//
// with the signal table and platform data asserted against client-core's compiled
// `OUTLET_SIGNALS` and `OUTLET_PLATFORM_DATA`.
//
// And `content/cases.json`, the content corpus (plans/P4-01.md §4.4, §5 order 0, P4-04), through
// `defineContentSuites`, which takes the blobs and a zstd decoder from its runner:
//
//   blobs             every file under content/blobs/ against the `blobs` table (harness check)
//   pathCases         §2.7's path rules                               → checkPaths
//   filesIndexCases   §2.7's parseFilesIndex, steps 1–5                → parseFilesIndex
//   packSetIdCases    §2.9's packSetId                                 → packSetId
//   stampCases        §2.8's content stamp                             → parseContentStamp
//   frameWindowCases  §2.7 rule 3's header window                      → frameWindow
//
// `applyCases` and `plan-matrix.json` need the appliers and the planner, which are P4-06's.
//
// `stage-matrix.json` (the boot stage machine, client boot behaviour outside the wire contract)
// has its own Node runner: `stageMatrix.test.ts`, through
// `@polaris-key/client-core/stages`. `fingerprint.json` likewise runs in `fingerprint.test.ts`.
//
// The bundle section used to carry an inline reference implementation of §7's numbered order,
// because no shipped verifier existed. P4 shipped one — `@polaris-key/client-core`'s `inspectBundle`
// — and this module now drives THAT, vector for vector, including which numbered step refuses.
// The step attribution is the whole point of the section, so the shipped API reports it
// (`BundleRefusalReason`) rather than collapsing every failure into a bare null.

import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlDecode, verifyJws, type TrustSet } from "@polaris-key/jws";
import {
  LISTING_URL_PREFIXES,
  OUTLET_CAPABILITY_DEFAULTS,
  OUTLET_CONFIDENCES,
  OUTLET_KINDS,
  OUTLET_PLATFORMS,
  OUTLET_SUBKINDS,
  PLATFORM_NARROWING,
  SUBKIND_NARROWING,
} from "@polaris-key/protocol/distribution";
import {
  BINARY_METHODS,
  BLOCKED_REASONS,
  FEED_VERSION_SCHEMES,
  NONE_REASONS,
  UPDATE_ACTIONS,
  type UpdateDecision,
  type UpdateDecisionInput,
} from "@polaris-key/protocol/update";
import {
  CHANNEL_ALIASES,
  CHANNEL_BETA,
  CHANNEL_DEV,
  CHANNEL_NAME_PATTERN,
  CHANNEL_PR,
  CHANNEL_STABLE,
  PR_CHANNEL_PATTERN,
  PR_NUMBER_MAX_DIGITS,
  type ManagedEntry,
} from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  BOOT_DECISIONS,
  MAX_BUNDLE_BYTES,
  channelForVersion,
  compareVersions,
  bootDecision,
  decideUpdate,
  detectOutlet,
  effectiveCapabilities,
  feedClaims,
  OUTLET_PLATFORM_DATA,
  OUTLET_SIGNALS,
  type DetectionStamp,
  releaseRecordClaims,
  resolveUpdateOutlet,
  rolloutBucket,
  verifyFeed,
  verifyReleaseRecord,
  compareSemver,
  effectiveNow,
  highWaterMark,
  inspectBundle,
  isDevBuild,
  isUsable,
  licenseState,
  mergeTrust,
  verifyBundle,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  checkPaths,
  frameWindow,
  packSetId,
  parseContentStamp,
  parseFilesIndex,
  type BlockedState,
  type BundleRefusalReason,
  type FilesIndexRef,
  type PackSetEntry,
  type VerifyOptions,
  type ZstdDecode,
} from "@polaris-key/client-core";

type TypV3 =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws"
  | "pkey-feed+jws"
  | "pkey-release+jws";

/** WIRE-CONTRACT-V4 §4.1: the payload's non-wire-integer pointers, beside `expect`. */
interface NonWire {
  nonWireIntegers?: string[];
}

interface JwsCase extends NonWire {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  typ?: TypV3;
  maxPayloadBytes?: number;
  expect: { verify: "ok" | "fail"; kid?: string; doc?: unknown };
}

interface DocCase extends NonWire {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  typ: TypV3;
  expectedAud: string;
  expectedIss: string;
  deviceId: string;
  now: number;
  lastAcceptedIssuedAt?: number;
  checkFreshness?: boolean;
  expect: { accept: boolean };
}

interface TrustCase extends NonWire {
  id: string;
  description: string;
  pinned: TrustSet;
  before: TrustSet;
  manifestJws: string;
  now: number;
  checkFreshness?: boolean;
  expect: { accepted: boolean; trust: TrustSet; issuedAt?: number };
}

interface ClockFloorCase {
  id: string;
  description: string;
  pinned: TrustSet;
  trustJws?: string;
  licenseJws?: string;
  configJws?: string;
  expectedAud: string;
  deviceId: string;
  systemClock: number;
  expect: { highWaterMark: number; effectiveNow: number; status: string };
}

// The fixture's vocabulary IS the shipped `BundleRefusalReason` union — declared as an alias
// so a rename on either side stops compiling instead of silently un-pinning the attribution.
type BundleReason = BundleRefusalReason;

type ImportOutcome =
  | { imports: false; reason: BundleReason }
  | { imports: true; docs: string[] };

interface BundleCase extends NonWire {
  id: string;
  description: string;
  bundleJws: string;
  pinned: TrustSet;
  expectedAud: string;
  deviceId: string;
  now: number;
  maxPayloadBytes: number;
  expect: ImportOutcome;
}

/** WIRE-CONTRACT-V4 §2.3: one `feedCases` vector (plans/P3-01.md §4.4). */
interface FeedCase extends NonWire {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  floors?: Record<string, { seq: number; issuedAt: number }>;
  expect:
    | { verify: "ok"; seq: number; issuedAt: number; doc?: unknown }
    | { verify: "fail"; reason: string };
}

/** WIRE-CONTRACT-V4 §2.4: one `releaseRecordCases` vector (plans/P3-01.md §4.5). */
interface RecordCase extends NonWire {
  id: string;
  description: string;
  jws: string;
  releaseKeys: TrustSet;
  productTrust: TrustSet;
  expectedAud: string;
  expectedHash: string;
  pin?: { deliverable: string; version: string; seq: number };
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: string };
}

/** plans/P4-01.md §4.6: one `packRecordCases` vector. `pin.kind` defaults to `app`. */
export interface PackRecordCase extends NonWire {
  id: string;
  description: string;
  jws: string;
  releaseKeys: TrustSet;
  productTrust: TrustSet;
  expectedAud: string;
  expectedHash: string;
  pin?: { kind?: string; deliverable: string; version: string; seq: number };
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: string };
}

/** plans/P4-01.md §4.6: one `markerCases` vector; the marker file's exact text, whose JWS is
 *  its `release` member. */
export interface MarkerCase extends NonWire {
  id: string;
  description: string;
  marker: string;
  releaseKeys: TrustSet;
  productTrust: TrustSet;
  expectedAud: string;
  expect:
    | { verify: "ok"; packId: string; version: string; recordSha256: string }
    | { verify: "fail"; step: string };
}

/** A marker's `release`, when its text is a JSON object holding a string there. */
function markerRelease(text: string): string | null {
  try {
    const m = JSON.parse(text) as unknown;
    return typeof m === "object" &&
      m !== null &&
      typeof (m as { release?: unknown }).release === "string"
      ? (m as { release: string }).release
      : null;
  } catch {
    return null;
  }
}

export interface Corpus {
  corpusVersion: number;
  keys: { kid: string; publicKeyRaw: string }[];
  jwsCases: JwsCase[];
  licenseDocCases: DocCase[];
  configDocCases: DocCase[];
  trustCases: TrustCase[];
  clockFloorCases: ClockFloorCase[];
  bundleCases: BundleCase[];
  feedCases: FeedCase[];
  releaseRecordCases: RecordCase[];
  packRecordCases: PackRecordCase[];
  markerCases: MarkerCase[];
}

export interface MatrixRow {
  name: string;
  gate: {
    version: string;
    channel?: string;
    compatMin: string;
    compatMax: string;
    entitlements: Record<string, ManagedEntry>;
  };
  license: {
    licenseServiceEnabled: boolean;
    activation: ActivationSource | null;
    now: number;
    issuedAt?: number;
    expiresAt?: number;
    graceUntil?: number;
    lastSyncUnauthorized?: boolean;
    lastVerifiedAt?: number;
  };
  expect: {
    status: string;
    ok: boolean;
    reason?: BlockReason;
    allowedRange?: AllowedRange;
  };
}

export interface GateMatrix {
  gateMatrixVersion: number;
  rows: MatrixRow[];
}

export interface UpdateMatrix {
  updateMatrixVersion: number;
  vocabulary: Record<string, string[]>;
  versionCases: {
    name: string;
    scheme: string;
    a: string;
    b: string;
    expect: -1 | 0 | 1 | null;
  }[];
  capabilityCases: {
    name: string;
    kind: string;
    platform: string;
    subkind: string | null;
    server: Record<string, unknown>;
    expect: Record<string, unknown>;
  }[];
  outletCases: {
    name: string;
    host: unknown;
    stamp: Record<string, string> | null;
    detected: Record<string, string | null> | null;
    expect: { id: string | null; kind: string; subkind: string | null };
  }[];
  bucketVectors: {
    name: string;
    salt: string;
    installId: string;
    sha256: string;
    first4: string;
    u32: number;
    bucket: number;
  }[];
  rows: {
    name: string;
    input: UpdateDecisionInput;
    expect: { decision: UpdateDecision; boot: string };
  }[];
}
export interface OutletMatrix {
  outletMatrixVersion: number;
  kinds: Record<string, Record<string, unknown>>;
  platformNarrowing: Record<string, Record<string, unknown>>;
  subkinds: Record<string, unknown>;
  vocabulary: Record<string, string[]>;
  signals: { signal: string; confidence: string | null; verified: string }[];
  platformData: {
    listingUrlPrefixes: Record<string, string[]>;
  } & Record<string, unknown>;
  rows: {
    name: string;
    stamp: DetectionStamp | null;
    signals: Record<string, unknown>;
    expect: {
      kind: string;
      confidence: string | null;
      source: string | null;
      subkind: string | null;
    };
  }[];
}

/**
 * The corpus files this module drives, by name, under `conformance/corpus/v2/`. The Node runner
 * reads each one from disk; the browser runner imports the same four through Vite. `stage-matrix
 * .json` and `fingerprint.json` have their own Node-only runners (`stageMatrix.test.ts`,
 * `fingerprint.test.ts`).
 */
export const CORPUS_FILES = {
  corpus: "cases.json",
  matrix: "gate-matrix.json",
  updateMatrix: "update-matrix.json",
  outletMatrix: "outlet-matrix.json",
} as const;

/** The parsed files, keyed as in `CORPUS_FILES`. */
export interface CorpusFiles {
  corpus: Corpus;
  matrix: GateMatrix;
  updateMatrix: UpdateMatrix;
  outletMatrix: OutletMatrix;
}

/** The rows P0-04 appended to gate-matrix v2 (WIRE-CONTRACT-V3 §5.1). */
const P0_04_CHANNEL_ROWS = [
  "ok — beta header, channels [stable, beta]",
  "ok — beta header, channels [stable, staging] (alias)",
  "ok — staging header, channels [stable, beta] (alias)",
  "channel-not-entitled — beta header, channels [stable]",
  "ok — manual channel header, entitled by name",
  "channel-not-entitled — manual channel header, not entitled",
  "channel-not-entitled — malformed channel header",
  "ok — 0.0.0-beta build with beta entitlement",
  "channel-not-entitled — 0.0.0-beta build without a beta entitlement",
  "ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
  "ok — latest header is the stable channel",
  "ok — pr-42 header, channels grant the pr family",
  "ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
  "channel-not-entitled — pr-7 header, channels grant only pr-42",
  "channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
  "channel-not-entitled — dev header without the dev entitlement",
  "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
  "ok — dev build with the dev entitlement bypasses the window (R3-01)",
] as const;

// §3 — the claim layer, once per document type. The two share an envelope and nothing else,
// so both families run against the same expectations through different verifiers.
const docOpts = (c: DocCase): VerifyOptions => ({
  trust: c.trust,
  expectedAud: c.expectedAud,
  expectedIss: c.expectedIss,
  deviceId: c.deviceId,
  now: c.now,
  lastAcceptedIssuedAt: c.lastAcceptedIssuedAt,
  checkFreshness: c.checkFreshness,
});

// ── The build-gate port (mirrors packages/worker/src/core/gate.ts `checkBuildGate`) ─────
// Rebuilt here from client-core's exported semver/channel primitives and the protocol's
// channel constants rather than imported: that surface is exactly what every SDK must keep in
// lockstep, and the fixture is the oracle (the Worker replays the same rows through the real
// gate in packages/worker/test/gateMatrixCorpus.test.ts). Python and Swift port these same
// lines against the same rows. It follows WIRE-CONTRACT-V3 §5.1 rules 2–5.
function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}
function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value)
    ? (e.value.filter((v) => typeof v === "string") as string[])
    : undefined;
}
function tighterMin(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}
function tighterMax(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) <= 0 ? a : b;
}
const CHANNEL_NAME_RE = new RegExp(CHANNEL_NAME_PATTERN);
const PR_CHANNEL_RE = new RegExp(PR_CHANNEL_PATTERN);
const PR_N_RE = /^pr-[0-9]+$/;
function prChannel(digits: string): string {
  return digits.length > PR_NUMBER_MAX_DIGITS ? CHANNEL_PR : `pr-${digits}`;
}
/** §5.1 rule 2: the family, with a PR build narrowed to its own `pr-<n>`. */
function impliedChannel(version: string): string {
  const family = channelForVersion(version);
  if (family !== CHANNEL_PR) return family;
  const digits = version.match(/^0\.0\.0-pr-?([0-9]+)/)?.[1];
  return digits ? prChannel(digits) : CHANNEL_PR;
}
/** §5.1 rule 3: `null` is a malformed header, which the gate refuses. */
function normalizeChannelHeader(
  header: string,
  version: string,
): string | null {
  if (Object.hasOwn(CHANNEL_ALIASES, header))
    return CHANNEL_ALIASES[header as keyof typeof CHANNEL_ALIASES];
  if (header === CHANNEL_PR) {
    const implied = impliedChannel(version);
    return PR_N_RE.test(implied) ? implied : CHANNEL_PR;
  }
  const pr = header.match(PR_CHANNEL_RE);
  if (pr?.[1] !== undefined) return prChannel(pr[1]);
  return CHANNEL_NAME_RE.test(header) ? header : null;
}
/** §5.1 rule 4: `stable` always; exact name; `staging` covers `beta`; `pr` covers `pr-<n>`. */
function channelEntitled(granted: readonly string[], channel: string): boolean {
  if (channel === CHANNEL_STABLE) return true;
  if (granted.includes(channel)) return true;
  if (channel === CHANNEL_BETA && granted.includes("staging")) return true;
  return PR_N_RE.test(channel) && granted.includes(CHANNEL_PR);
}
/** §5.1 rule 5, in order: dev bypass by grant, version window, malformed header, channels. */
function checkBuildGate(g: MatrixRow["gate"]): BlockedState | undefined {
  const granted = arrEnt(g.entitlements["channels"]) ?? [CHANNEL_STABLE];
  if (isDevBuild(g.version) && granted.includes(CHANNEL_DEV)) return undefined;
  const min = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]));
  const max = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]));
  const allowedRange: AllowedRange = {};
  if (min) allowedRange.min = min;
  if (max) allowedRange.max = max;
  if (min && compareSemver(g.version, min) < 0)
    return { reason: "version-too-old", allowedRange };
  if (max && compareSemver(g.version, max) > 0)
    return { reason: "version-too-new", allowedRange };
  const declared =
    g.channel === undefined
      ? null
      : normalizeChannelHeader(g.channel, g.version);
  if (g.channel !== undefined && declared === null)
    return { reason: "channel-not-entitled" };
  for (const channel of new Set([impliedChannel(g.version), declared])) {
    if (channel !== null && !channelEntitled(granted, channel))
      return { reason: "channel-not-entitled" };
  }
  return undefined;
}

/** The gate reads only the three timestamps; the rest is fixture furniture. */
function matrixDoc(l: MatrixRow["license"]): LicenseDoc | null {
  if (
    l.issuedAt === undefined ||
    l.expiresAt === undefined ||
    l.graceUntil === undefined
  )
    return null;
  return {
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_matrix",
    deviceId: "dev_matrix",
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceUntil: l.graceUntil,
    entitlements: {},
  };
}

// ── §7 — offline bundle import, all-or-nothing, in the contract's numbered order ────────
// `inspectBundle` walks steps 1–4 and reports the step that refused; step 5 (the atomic cache
// write) belongs to the host, so what the corpus can pin is exactly what this returns.
//
// Note what the runner no longer does: it does not hand the verifier a payload cap. §1's
// raised bundle cap is a property of the `typ`, not of the caller, so `inspectBundle` takes
// it from `MAX_BUNDLE_BYTES` and the fixture's value is asserted to agree — which is a
// STRONGER pin than passing it in, because a runner that supplies the cap cannot catch an
// implementation that forgot to apply one.
/** Step 13's key selection from the pinned release keys, then `verifyJws`. */
async function reachClaims(jws: string, releaseKeys: TrustSet) {
  const kid = (
    JSON.parse(
      new TextDecoder().decode(base64UrlDecode(jws.split(".")[0]!)),
    ) as {
      kid: string;
    }
  ).kid;
  return verifyJws(
    jws,
    { [kid]: releaseKeys[kid]! },
    { typ: "pkey-release+jws" },
  );
}

async function importBundle(c: BundleCase): Promise<ImportOutcome> {
  const opts = {
    pinned: c.pinned,
    product: c.expectedAud,
    deviceId: c.deviceId,
    now: c.now,
  };
  const result = await inspectBundle(c.bundleJws, opts);
  if (!result.ok) return { imports: false, reason: result.reason };
  // The two entry points must never disagree: `verifyBundle` is the same walk with the step
  // discarded, and a host that uses it has to see exactly what the corpus saw.
  expect(await verifyBundle(c.bundleJws, opts)).toEqual(result.bundle);
  // `docs` is reported in §7's order (license, then config) so the fixture's array is a
  // sequence rather than a set.
  const docs: string[] = [];
  if (result.bundle.docs.license) docs.push("license");
  if (result.bundle.docs.config) docs.push("config");
  return { imports: true, docs };
}

const CLAIM_REASONS = new Set(["claims", "channel", "selector"]);
const AFTER_CLAIMS = new Set(["freshness", "not-newer", "rollback"]);

/**
 * Registers every suite over the four files. Call it once per runner, at module top level, after
 * loading `CORPUS_FILES` — the suites are built from the data, one `it` per vector.
 */
export function defineCorpusSuites({
  corpus,
  matrix,
  updateMatrix,
  outletMatrix,
}: CorpusFiles): void {
  // @pkey-feature core.verify
  describe(`conformance corpus v${corpus.corpusVersion} — JWS (§1–§2)`, () => {
    it("has vectors in every section", () => {
      expect(corpus.corpusVersion).toBe(2);
      expect(corpus.jwsCases.length).toBeGreaterThan(0);
      expect(corpus.licenseDocCases.length).toBeGreaterThan(0);
      expect(corpus.configDocCases.length).toBeGreaterThan(0);
      expect(corpus.trustCases.length).toBeGreaterThan(0);
      expect(corpus.clockFloorCases.length).toBeGreaterThan(0);
      expect(corpus.bundleCases.length).toBeGreaterThan(0);
    });

    for (const c of corpus.jwsCases) {
      it(`${c.id} → verify:${c.expect.verify}`, async () => {
        const result = await verifyJws(c.jws, c.trust, {
          // §2 — every vector names its `typ`; a verifier that did not would be asking for
          // no domain separation at all, which no shipping call site does.
          typ: c.typ,
          // §1 — the raised cap travels with the vector, so a runner cannot accidentally
          // grant bundle sizes to ordinary documents.
          maxPayloadBytes: c.maxPayloadBytes,
        });
        if (c.expect.verify === "ok") {
          expect(result, `${c.id} should verify`).not.toBeNull();
          expect(result!.kid).toBe(c.expect.kid);
          // Omitted where the payload is a quarter-megabyte of padding (the cap vectors).
          if (c.expect.doc !== undefined) {
            expect(result!.payload).toEqual(c.expect.doc);
          }
        } else {
          expect(result, `${c.id} must fail verification`).toBeNull();
        }
      });
    }
  });

  // @pkey-feature core.verify
  describe(`conformance corpus v${corpus.corpusVersion} — license documents (§3)`, () => {
    for (const c of corpus.licenseDocCases) {
      it(`${c.id} → accept:${c.expect.accept}`, async () => {
        const doc = await verifyLicenseDoc(c.jws, docOpts(c));
        expect(doc !== null, `${c.id} — ${c.description}`).toBe(
          c.expect.accept,
        );
      });
    }
  });

  // @pkey-feature core.verify
  describe(`conformance corpus v${corpus.corpusVersion} — config documents (§3)`, () => {
    for (const c of corpus.configDocCases) {
      it(`${c.id} → accept:${c.expect.accept}`, async () => {
        const doc = await verifyConfigDoc(c.jws, docOpts(c));
        expect(doc !== null, `${c.id} — ${c.description}`).toBe(
          c.expect.accept,
        );
      });
    }
  });

  // @pkey-feature core.verify
  describe(`conformance corpus v${corpus.corpusVersion} — trust set (§1)`, () => {
    for (const c of corpus.trustCases) {
      it(`${c.id} → accepted:${c.expect.accepted}`, async () => {
        const result = await verifyTrustManifest(c.manifestJws, {
          pinned: c.pinned,
          expectedAud: "djdl",
          now: c.now,
          checkFreshness: c.checkFreshness,
        });
        expect(result.doc !== null, `${c.id} acceptance`).toBe(
          c.expect.accepted,
        );
        // Accepted ⇒ the discovered set REPLACES what was held; rejected ⇒ it is untouched.
        const discovered = result.doc ? result.discovered : c.before;
        expect(mergeTrust(c.pinned, discovered)).toEqual(c.expect.trust);
        // The accepted manifest's `issuedAt` is what §4.2 folds into the clock floor.
        if (c.expect.issuedAt !== undefined) {
          expect(result.doc?.issuedAt, `${c.id} issuedAt`).toBe(
            c.expect.issuedAt,
          );
        }
      });
    }
  });

  // @pkey-feature core.verify
  // §4.2 — the monotonic clock floor. Each case replays the cache-RELOAD path as pure data:
  // re-verify the cached manifest against the PINS (freshness off), re-verify each cached
  // document against the resulting effective set (freshness off), fold the `issuedAt` of
  // whatever actually verified, and gate at `max(systemClock, floor)`.
  describe(`conformance corpus v${corpus.corpusVersion} — clock floor (§4.2)`, () => {
    for (const c of corpus.clockFloorCases) {
      it(`${c.id} → ${c.expect.status}`, async () => {
        let trust: TrustSet = c.pinned;
        const verified: { issuedAt: number }[] = [];

        if (c.trustJws !== undefined) {
          const manifest = await verifyTrustManifest(c.trustJws, {
            pinned: c.pinned,
            expectedAud: c.expectedAud,
            now: c.systemClock,
            checkFreshness: false,
          });
          if (manifest.doc) {
            trust = mergeTrust(c.pinned, manifest.discovered);
            verified.push(manifest.doc);
          }
        }

        const reload = {
          trust,
          expectedAud: c.expectedAud,
          deviceId: c.deviceId,
          now: c.systemClock,
          checkFreshness: false,
        };
        let license: LicenseDoc | null = null;
        if (c.licenseJws !== undefined) {
          license = await verifyLicenseDoc(c.licenseJws, reload);
          if (license) verified.push(license);
        }
        if (c.configJws !== undefined) {
          const config = await verifyConfigDoc(c.configJws, reload);
          if (config) verified.push(config);
        }

        const floor = highWaterMark(verified);
        expect(floor, `${c.id} highWaterMark`).toBe(c.expect.highWaterMark);
        expect(effectiveNow(c.systemClock, floor), `${c.id} effectiveNow`).toBe(
          c.expect.effectiveNow,
        );
        const state = licenseState({
          licenseServiceEnabled: true,
          activation: "token",
          doc: license,
          now: c.systemClock,
          highWaterMark: floor,
        });
        expect(state.status, `${c.id} — ${c.description}`).toBe(
          c.expect.status,
        );
      });
    }
  });

  // @pkey-feature license.gate
  describe(`gate-matrix v${matrix.gateMatrixVersion} (§5)`, () => {
    for (const row of matrix.rows) {
      it(row.name, () => {
        const blocked = checkBuildGate(row.gate);
        const state = licenseState({
          licenseServiceEnabled: row.license.licenseServiceEnabled,
          activation: row.license.activation,
          doc: matrixDoc(row.license),
          now: row.license.now,
          lastSyncUnauthorized: row.license.lastSyncUnauthorized,
          lastVerifiedAt: row.license.lastVerifiedAt,
          blocked,
        });
        expect(state.status, row.name).toBe(row.expect.status);
        expect(isUsable(state), `${row.name} usable`).toBe(row.expect.ok);
        // `reason` describes the DERIVED build-gate hint, which on the unactivated+blocked row
        // is deliberately not the status — that row is the whole point of v3's ordering.
        if (row.expect.reason !== undefined) {
          expect(blocked?.reason, `${row.name} reason`).toBe(row.expect.reason);
        }
        expect(state.allowedRange, `${row.name} allowedRange`).toEqual(
          row.expect.allowedRange,
        );
      });
    }
  });

  // @pkey-feature license.gate
  describe("gate-matrix v2 covers the P0-04 channel rows", () => {
    it("has the 18 channel rows and no longer has the retired dev-bypass row", () => {
      const names = new Set(matrix.rows.map((r) => r.name));
      expect(matrix.rows).toHaveLength(38);
      for (const name of P0_04_CHANNEL_ROWS)
        expect(names, name).toContain(name);
      expect(names).not.toContain(
        "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel",
      );
    });
  });

  // @pkey-feature core.bundle
  describe(`conformance corpus v${corpus.corpusVersion} — offline bundles (§7)`, () => {
    it("pins the bundle payload cap against the implementation's own constant", () => {
      for (const c of corpus.bundleCases) {
        expect(c.maxPayloadBytes, `${c.id} cap`).toBe(MAX_BUNDLE_BYTES);
      }
    });

    for (const c of corpus.bundleCases) {
      const label = c.expect.imports
        ? `imports ${c.expect.docs.join("+")}`
        : c.expect.reason;
      it(`${c.id} → ${label}`, async () => {
        const outcome = await importBundle(c);
        expect(outcome, `${c.id} — ${c.description}`).toEqual(c.expect);
      });
    }

    // A verified bundle hands back everything §7 step 5 needs, and the caller must not have to
    // re-parse anything to write the cache: the trust manifest's bytes, the effective set the
    // inner documents were checked against, and each document as BOTH its signed artifact and
    // its decoded payload.
    it("bundle-valid-full yields the artifacts the cache write needs", async () => {
      const c = corpus.bundleCases.find((x) => x.id === "bundle-valid-full")!;
      const bundle = await verifyBundle(c.bundleJws, {
        pinned: c.pinned,
        product: c.expectedAud,
        deviceId: c.deviceId,
        now: c.now,
      });
      expect(bundle).not.toBeNull();
      expect(bundle!.bundleId).toEqual(expect.any(String));
      expect(bundle!.trustJws.split(".")).toHaveLength(3);
      // Step 3's set, not the bare pins: the config document in this vector is signed by a
      // rotated key only the inner manifest publishes, so the merge has to have happened.
      expect(Object.keys(bundle!.effectiveTrust).length).toBeGreaterThan(
        Object.keys(c.pinned).length,
      );
      expect(bundle!.docs.license!.doc.deviceId).toBe(c.deviceId);
      expect(bundle!.docs.license!.doc.aud).toBe(c.expectedAud);
      expect(bundle!.docs.config!.doc.deviceId).toBe(c.deviceId);
      // The artifacts are the exact inner bytes — the host persists these, never the payloads.
      expect(bundle!.docs.license!.jws.split(".")).toHaveLength(3);
      expect(bundle!.docs.config!.jws.split(".")).toHaveLength(3);
    });
  });

  // ── WIRE-CONTRACT-V4 §4.1 — the non-wire-integer pointer sets, over the nine JWS families ────
  // Every family's JWS goes through this verifier's own `verifyJws` with the family's keys, `typ`
  // and cap. Whenever it accepts, its `nonWireIntegers` must equal the case's member as a set (an
  // absent member is the empty set), and a case that carries the member must be accepted. So
  // the four SDKs' pointer sets cannot drift: one that misses or invents a pointer fails here.
  const POINTER_FAMILIES: [
    string,
    { id: string; nonWireIntegers?: string[] }[],
    (c: never) => {
      jws: string;
      keys: TrustSet;
      typ: TypV3 | undefined;
      cap: number | undefined;
    },
  ][] = [
    [
      "jwsCases",
      corpus.jwsCases,
      (c: JwsCase) => ({
        jws: c.jws,
        keys: c.trust,
        typ: c.typ,
        cap: c.maxPayloadBytes,
      }),
    ],
    [
      "licenseDocCases",
      corpus.licenseDocCases,
      (c: DocCase) => ({
        jws: c.jws,
        keys: c.trust,
        typ: c.typ,
        cap: undefined,
      }),
    ],
    [
      "configDocCases",
      corpus.configDocCases,
      (c: DocCase) => ({
        jws: c.jws,
        keys: c.trust,
        typ: c.typ,
        cap: undefined,
      }),
    ],
    [
      "trustCases",
      corpus.trustCases,
      (c: TrustCase) => ({
        jws: c.manifestJws,
        keys: c.pinned,
        typ: "pkey-trust+jws",
        cap: undefined,
      }),
    ],
    [
      "bundleCases",
      corpus.bundleCases,
      (c: BundleCase) => ({
        jws: c.bundleJws,
        keys: c.pinned,
        typ: "pkey-bundle+jws",
        cap: MAX_BUNDLE_BYTES,
      }),
    ],
    [
      "feedCases",
      corpus.feedCases,
      (c: FeedCase) => ({
        jws: c.jws,
        keys: c.trust,
        typ: "pkey-feed+jws",
        cap: undefined,
      }),
    ],
    [
      "releaseRecordCases",
      corpus.releaseRecordCases,
      (c: RecordCase) => ({
        jws: c.jws,
        keys: c.releaseKeys,
        typ: "pkey-release+jws",
        cap: undefined,
      }),
    ],
    // plans/P4-01.md §4.6 (P4-21): the two pack families; a marker's JWS is its `release`.
    [
      "packRecordCases",
      corpus.packRecordCases,
      (c: PackRecordCase) => ({
        jws: c.jws,
        keys: c.releaseKeys,
        typ: "pkey-release+jws",
        cap: undefined,
      }),
    ],
    [
      "markerCases",
      corpus.markerCases,
      (c: MarkerCase) => ({
        jws: markerRelease(c.marker) ?? "",
        keys: c.releaseKeys,
        typ: "pkey-release+jws",
        cap: undefined,
      }),
    ],
  ];

  // @pkey-feature core.verify
  describe(`conformance corpus v${corpus.corpusVersion} — non-wire-integer pointer sets (V4 §4.1)`, () => {
    for (const [family, cases, view] of POINTER_FAMILIES) {
      for (const c of cases) {
        it(`${family}/${c.id}`, async () => {
          const { jws, keys, typ, cap } = view(c as never);
          const v = await verifyJws(jws, keys, { typ, maxPayloadBytes: cap });
          if (c.nonWireIntegers !== undefined)
            expect(
              v,
              `${c.id} carries nonWireIntegers, so it must verify`,
            ).not.toBeNull();
          if (v === null) return;
          expect([...v.nonWireIntegers].sort()).toEqual(
            [...(c.nonWireIntegers ?? [])].sort(),
          );
        });
      }
    }
  });

  // ── plans/P3-01.md §5 order 0 — the four functions P3-03 imports ─────────────────────────────
  // `versionCases` through `compareVersions`, and the two claim functions over every feed and
  // record case that reaches the claims step (V4 §2.5 steps 4–6 and 14). The full feed and record
  // verifiers and the rest of `update-matrix.json` are P3-05's sections.

  // @pkey-feature update.decide
  describe(`update-matrix v${updateMatrix.updateMatrixVersion} — vocabulary and versions`, () => {
    it("has its version and §2.8's vocabularies, which the protocol constants hold", () => {
      expect(updateMatrix.updateMatrixVersion).toBe(1);
      expect(updateMatrix.vocabulary).toEqual({
        actions: [...UPDATE_ACTIONS],
        noneReasons: [...NONE_REASONS],
        blockedReasons: [...BLOCKED_REASONS],
        methods: [...BINARY_METHODS],
        boot: [...BOOT_DECISIONS],
        schemes: [...FEED_VERSION_SCHEMES],
      });
    });
    for (const c of updateMatrix.versionCases) {
      it(`version ${c.name}`, () => {
        expect(compareVersions(c.scheme, c.a, c.b)).toBe(c.expect);
      });
    }
  });

  // @pkey-feature outlet.detect
  describe(`outlet-matrix v${outletMatrix.outletMatrixVersion} — the compiled tables`, () => {
    it("OUTLET_CAPABILITY_DEFAULTS, PLATFORM_NARROWING, SUBKIND_NARROWING and LISTING_URL_PREFIXES equal the matrix", () => {
      expect(outletMatrix.outletMatrixVersion).toBe(1);
      const kinds: Record<string, unknown> = {};
      for (const [kind, caps] of Object.entries(OUTLET_CAPABILITY_DEFAULTS))
        kinds[kind] = {
          ...caps,
          platforms: [
            ...OUTLET_PLATFORMS[kind as keyof typeof OUTLET_PLATFORMS],
          ],
        };
      expect(outletMatrix.kinds).toEqual(kinds);
      expect(outletMatrix.platformNarrowing).toEqual(PLATFORM_NARROWING);
      expect(outletMatrix.subkinds).toEqual(SUBKIND_NARROWING);
      expect(outletMatrix.platformData.listingUrlPrefixes).toEqual(
        LISTING_URL_PREFIXES,
      );
      expect(outletMatrix.vocabulary.kinds).toEqual([...OUTLET_KINDS]);
      expect(outletMatrix.vocabulary.subkinds).toEqual([...OUTLET_SUBKINDS]);
      expect(outletMatrix.vocabulary.confidence).toEqual([
        ...OUTLET_CONFIDENCES,
      ]);
    });
  });

  // @pkey-feature outlet.detect
  describe(`outlet-matrix v${outletMatrix.outletMatrixVersion} — detection (plans/P3-01.md §2.9)`, () => {
    it("OUTLET_SIGNALS is the signal table, in vocabulary order, with each confidence", () => {
      expect(OUTLET_SIGNALS.map((s) => s.signal)).toEqual(
        outletMatrix.vocabulary.signals,
      );
      expect(
        outletMatrix.signals.map(({ signal, confidence }) => ({
          signal,
          confidence,
        })),
      ).toEqual(OUTLET_SIGNALS);
    });
    it("OUTLET_PLATFORM_DATA is the matrix's platform data", () => {
      const { listingUrlPrefixes: _prefixes, ...rest } =
        outletMatrix.platformData;
      expect(rest).toEqual(OUTLET_PLATFORM_DATA);
    });
    it("has 48 rows", () => {
      expect(outletMatrix.rows.length).toBe(48);
    });
    for (const row of outletMatrix.rows) {
      it(`row ${row.name}`, () => {
        expect(
          detectOutlet({ stamp: row.stamp, signals: row.signals }),
        ).toEqual(row.expect);
      });
    }
  });

  // @pkey-feature update.feed
  describe(`conformance corpus v${corpus.corpusVersion} — feed claims (V4 §2.5 steps 4–6)`, () => {
    for (const c of corpus.feedCases) {
      const reason = c.expect.verify === "ok" ? null : c.expect.reason;
      if (
        reason !== null &&
        !CLAIM_REASONS.has(reason) &&
        !AFTER_CLAIMS.has(reason)
      )
        continue;
      it(`${c.id} → ${reason !== null && CLAIM_REASONS.has(reason) ? reason : "no refusal"}`, async () => {
        const v = await verifyJws(c.jws, c.trust, { typ: "pkey-feed+jws" });
        expect(v, `${c.id} reaches the claims step`).not.toBeNull();
        const got = feedClaims(v!.payload, {
          expectedAud: c.expectedAud,
          channel: c.channel,
          platform: c.platform,
          nonWire: v!.nonWireIntegers,
        });
        expect(got, c.description).toBe(
          reason !== null && CLAIM_REASONS.has(reason) ? reason : null,
        );
      });
    }
  });

  // @pkey-feature release.record
  describe(`conformance corpus v${corpus.corpusVersion} — record claims (V4 §2.5 step 14)`, () => {
    for (const c of corpus.releaseRecordCases) {
      const step = c.expect.verify === "ok" ? null : c.expect.step;
      if (step !== null && step !== "claims" && step !== "cross-check")
        continue;
      it(`${c.id} → claims ${step === "claims" ? "refused" : "accepted"}`, async () => {
        // Step 13's key selection, from the pinned release keys only.
        const kid = (
          JSON.parse(
            new TextDecoder().decode(base64UrlDecode(c.jws.split(".")[0]!)),
          ) as { kid: string }
        ).kid;
        const v = await verifyJws(
          c.jws,
          { [kid]: c.releaseKeys[kid]! },
          { typ: "pkey-release+jws" },
        );
        expect(v, `${c.id} reaches the claims step`).not.toBeNull();
        const ok = releaseRecordClaims(v!.payload, {
          expectedAud: c.expectedAud,
          nonWire: v!.nonWireIntegers,
        });
        expect(ok, c.description).toBe(step !== "claims");
      });
    }
  });

  // ── plans/P4-01.md §5 order 0 (P4-21) — the pack claims P4-02's ingest and P4-03's CLI import ──
  // Step 14 through `releaseRecordClaims` over every pack-record case that reaches it, and over
  // every marker whose `release` reaches it. The full sections (step 15 with `pin.kind`, the
  // marker verifier) are P4-06's.

  // @pkey-feature packs.record
  describe(`conformance corpus v${corpus.corpusVersion} — pack record claims (V4 §2.5 step 14, plans/P4-01.md §2.3–§2.4)`, () => {
    it("has every pack-record and marker case of plans/P4-01.md §4.6", () => {
      expect(corpus.packRecordCases.length).toBe(159);
      expect(corpus.markerCases.length).toBe(17);
    });
    for (const c of corpus.packRecordCases) {
      const step = c.expect.verify === "ok" ? null : c.expect.step;
      if (step !== null && step !== "claims" && step !== "cross-check")
        continue;
      it(`${c.id} → claims ${step === "claims" ? "refused" : "accepted"}`, async () => {
        const v = await reachClaims(c.jws, c.releaseKeys);
        expect(v, `${c.id} reaches the claims step`).not.toBeNull();
        const ok = releaseRecordClaims(v!.payload, {
          expectedAud: c.expectedAud,
          nonWire: v!.nonWireIntegers,
        });
        expect(ok, c.description).toBe(step !== "claims");
      });
    }
    for (const c of corpus.markerCases) {
      const step = c.expect.verify === "ok" ? null : c.expect.step;
      if (step !== null && step !== "claims" && step !== "cross-check")
        continue;
      it(`marker ${c.id} → claims ${step === "claims" ? "refused" : "accepted"}`, async () => {
        const release = markerRelease(c.marker);
        expect(release, `${c.id} carries a release`).not.toBeNull();
        const v = await reachClaims(release!, c.releaseKeys);
        expect(v, `${c.id} reaches the claims step`).not.toBeNull();
        const ok = releaseRecordClaims(v!.payload, {
          expectedAud: c.expectedAud,
          nonWire: v!.nonWireIntegers,
        });
        expect(ok, c.description).toBe(step !== "claims");
      });
    }
  });

  // ── plans/P3-01.md §5 order 1 (P3-05) — the full verifiers and the rest of the update matrix ──

  // @pkey-feature update.feed
  describe(`conformance corpus v${corpus.corpusVersion} — channel feeds (V4 §2.5 steps 3–8)`, () => {
    it("has every feed case of plans/P3-01.md §4.4", () => {
      expect(corpus.feedCases.length).toBe(77);
    });
    for (const c of corpus.feedCases) {
      const want = c.expect.verify === "ok" ? "ok" : c.expect.reason;
      it(`${c.id} → ${want}`, async () => {
        const r = await verifyFeed(c.jws, {
          trust: c.trust,
          expectedAud: c.expectedAud,
          channel: c.channel,
          platform: c.platform,
          now: c.now,
          checkFreshness: c.checkFreshness,
          floors: c.floors,
        });
        if (c.expect.verify === "ok") {
          expect(r, c.description).toMatchObject({ ok: true });
          if (!r.ok) return;
          expect(r.feed.seq).toBe(c.expect.seq);
          expect(r.feed.issuedAt).toBe(c.expect.issuedAt);
          if (c.expect.doc !== undefined) expect(r.feed).toEqual(c.expect.doc);
        } else {
          expect(r.ok, c.description).toBe(false);
          if (r.ok) return;
          expect(r.reason, c.description).toBe(c.expect.reason);
        }
      });
    }
  });

  // @pkey-feature release.record
  describe(`conformance corpus v${corpus.corpusVersion} — release records (V4 §2.5 steps 12–15)`, () => {
    it("has every record case of plans/P3-01.md §4.5", () => {
      expect(corpus.releaseRecordCases.length).toBe(49);
    });
    for (const c of corpus.releaseRecordCases) {
      const want = c.expect.verify === "ok" ? "ok" : c.expect.step;
      it(`${c.id} → ${want}`, async () => {
        const r = await verifyReleaseRecord(c.jws, {
          releaseKeys: c.releaseKeys,
          productTrust: c.productTrust,
          expectedAud: c.expectedAud,
          expectedHash: c.expectedHash,
          ...(c.pin ? { pin: c.pin } : {}),
        });
        if (c.expect.verify === "ok") {
          expect(r, c.description).toMatchObject({ ok: true });
          if (!r.ok) return;
          expect(r.record.kind).toBe(c.expect.kind);
          if (c.expect.doc !== undefined)
            expect(r.record).toEqual(c.expect.doc);
        } else {
          expect(r.ok, c.description).toBe(false);
          if (r.ok) return;
          expect(r.step, c.description).toBe(c.expect.step);
        }
      });
    }
  });

  // @pkey-feature update.decide
  describe(`update-matrix v${updateMatrix.updateMatrixVersion} — capabilities, outlets, buckets and rows`, () => {
    it("has every case of plans/P3-01.md §4.6", () => {
      expect(updateMatrix.capabilityCases.length).toBe(10);
      expect(updateMatrix.outletCases.length).toBe(12);
      expect(updateMatrix.bucketVectors.length).toBe(6);
      expect(updateMatrix.rows.length).toBe(65);
    });
    for (const c of updateMatrix.capabilityCases) {
      it(`capability ${c.name}`, () => {
        expect(
          effectiveCapabilities(c.kind, {
            platform: c.platform,
            subkind: c.subkind,
            server: c.server,
          }),
        ).toEqual(c.expect);
      });
    }
    for (const c of updateMatrix.outletCases) {
      it(`outlet ${c.name}`, () => {
        expect(
          resolveUpdateOutlet({
            host: c.host,
            stamp: c.stamp,
            detected: c.detected as never,
          }),
        ).toEqual(c.expect);
      });
    }
    it("refuses a host outlet outside the vocabularies (invalid-options)", () => {
      for (const host of [
        "epic",
        { id: "Direct Build", kind: "direct" },
        { id: "direct", kind: "epic" },
        { id: "direct", kind: "direct", subkind: "brew" },
      ])
        expect(resolveUpdateOutlet({ host })).toBeNull();
    });
    for (const v of updateMatrix.bucketVectors) {
      it(`bucket ${v.name}`, async () => {
        expect(await rolloutBucket(v.salt, v.installId)).toBe(v.bucket);
        expect(v.u32 % 10000).toBe(v.bucket);
      });
    }
    for (const row of updateMatrix.rows) {
      it(`row ${row.name}`, () => {
        const decision = decideUpdate(row.input);
        expect(decision).toEqual(row.expect.decision);
        expect(bootDecision(decision)).toBe(row.expect.boot);
      });
    }
    it("every v4 boot value is none or optional: no floor stops play", () => {
      for (const row of updateMatrix.rows)
        expect(["none", "optional"]).toContain(row.expect.boot);
    });
  });
}

// ── plans/P4-01.md §5 order 0 (P4-04) — the content corpus's pure sections ───────────────────

/** A `<ref>` (content/cases.json's description): a named blob, decoded when `codec` is `zstd`,
 *  then mutated; or `{text}`, its UTF-8 bytes. */
export interface ContentRef {
  blob?: string;
  text?: string;
  codec?: string;
  size?: number;
  mutate?: (
    | { op: "truncate"; length: number }
    | { op: "xor"; offset: number; value: number }
  )[];
}

interface ContentCase {
  id: string;
  description: string;
}

/** `content/cases.json` (contentCorpusVersion 1): the sections this module drives. */
export interface ContentCorpus {
  contentCorpusVersion: number;
  blobs: Record<string, { size: number; sha256: string }>;
  pathCases: (ContentCase & {
    paths: string[];
    expect: { ok: boolean; error?: string; path?: string };
  })[];
  filesIndexCases: (ContentCase & {
    stored: ContentRef;
    files: FilesIndexRef;
    payload: { size: number; sha256: string };
    expect:
      | { ok: true; files: number }
      | { ok: false; error: string; path?: string };
  })[];
  packSetIdCases: (ContentCase & {
    entries: PackSetEntry[];
    expect: { packSetId: string | null };
  })[];
  stampCases: (ContentCase & { stamp: string; expect: unknown })[];
  frameWindowCases: (ContentCase & {
    header: string;
    expect: { window: number | null };
  })[];
}

/** What a runner hands `defineContentSuites`: the corpus, every file under `content/blobs/` by
 *  its path there (read raw), and a zstd decoder for one frame with its content size. */
export interface ContentFiles {
  content: ContentCorpus;
  loadBlobs: () => Promise<Map<string, Uint8Array>>;
  decode: ZstdDecode;
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
  );
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Materialise a `<ref>`: the blob (decoded when `codec` is `zstd`) or the text, then mutated. */
async function materialise(
  ref: ContentRef,
  blobs: Map<string, Uint8Array>,
  decode: ZstdDecode,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (ref.text !== undefined) bytes = new TextEncoder().encode(ref.text);
  else {
    const raw = blobs.get(ref.blob ?? "");
    if (raw === undefined) throw new Error(`no blob ${String(ref.blob)}`);
    bytes = ref.codec === "zstd" ? await decode(raw, ref.size!) : raw.slice();
  }
  for (const m of ref.mutate ?? []) {
    if (m.op === "truncate") bytes = bytes.slice(0, m.length);
    else if (m.op === "xor") {
      bytes = bytes.slice();
      bytes[m.offset] = bytes[m.offset]! ^ m.value;
    } else throw new Error(`unknown mutation ${JSON.stringify(m)}`);
  }
  return bytes;
}

/**
 * Registers the content corpus's pure sections. Call it once per runner, at module top level.
 * The blobs load once, in `beforeAll`; a blob that differs from the `blobs` table, a missing one
 * or a stray file fails the first test, which every other test in the block then follows.
 */
export function defineContentSuites({
  content,
  loadBlobs,
  decode,
}: ContentFiles): void {
  let blobs = new Map<string, Uint8Array>();

  // @pkey-feature packs.index.files
  describe(`content corpus v${content.contentCorpusVersion} — blobs and the files index (plans/P4-01.md §2.7)`, () => {
    beforeAll(async () => {
      blobs = await loadBlobs();
    });
    it("has its version and every section of plans/P4-01.md §4.4", () => {
      expect(content.contentCorpusVersion).toBe(1);
      expect(content.pathCases.length).toBe(18);
      expect(content.filesIndexCases.length).toBe(15);
      expect(content.packSetIdCases.length).toBe(7);
      expect(content.stampCases.length).toBe(6);
      expect(content.frameWindowCases.length).toBe(13);
    });
    it("every file under content/blobs/ matches the blobs table, and nothing else is there", async () => {
      expect([...blobs.keys()].sort()).toEqual(
        Object.keys(content.blobs).sort(),
      );
      for (const [name, want] of Object.entries(content.blobs)) {
        const got = blobs.get(name)!;
        expect(got.byteLength, name).toBe(want.size);
        expect(await sha256Of(got), name).toBe(want.sha256);
      }
    });
    for (const c of content.pathCases) {
      it(`paths ${c.id}`, () => {
        expect(checkPaths(c.paths), c.description).toEqual(c.expect);
      });
    }
    for (const c of content.filesIndexCases) {
      it(`files index ${c.id}`, async () => {
        const stored = await materialise(c.stored, blobs, decode);
        const r = await parseFilesIndex(
          stored,
          c.files,
          { payload: c.payload },
          { decode },
        );
        const verdict = r.ok ? { ok: true, files: r.index.files.length } : r;
        expect(verdict, c.description).toEqual(c.expect);
      });
    }
  });

  // @pkey-feature packs.state
  describe(`content corpus v${content.contentCorpusVersion} — packSetId (plans/P4-01.md §2.9)`, () => {
    for (const c of content.packSetIdCases) {
      it(`pack set ${c.id}`, async () => {
        expect(
          { packSetId: await packSetId(c.entries) },
          c.description,
        ).toEqual(c.expect);
      });
    }
  });

  // @pkey-feature packs.record
  describe(`content corpus v${content.contentCorpusVersion} — content stamps (plans/P4-01.md §2.8)`, () => {
    for (const c of content.stampCases) {
      it(`stamp ${c.id}`, () => {
        expect(parseContentStamp(c.stamp), c.description).toEqual(c.expect);
      });
    }
  });

  // @pkey-feature packs.apply.delta
  describe(`content corpus v${content.contentCorpusVersion} — frameWindow (plans/P4-01.md §2.7 rule 3)`, () => {
    for (const c of content.frameWindowCases) {
      it(`frame window ${c.id}`, () => {
        expect(
          { window: frameWindow(hexBytes(c.header)) },
          c.description,
        ).toEqual(c.expect);
      });
    }
  });
}

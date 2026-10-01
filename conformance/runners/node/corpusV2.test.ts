// The Node conformance runner for corpus v2 / wire contract v3. It drives EVERY vector in
// `conformance/corpus/v2/` through `@polaris-key/client-core` — the single isomorphic implementation
// every JS SDK will consume — and asserts the expected outcome. The Python, Swift and Godot
// runners mirror THIS file against the SAME corpus (Swift and Godot read generator-owned
// mirrors); that is how every SDK proves byte-identical verification. Godot runs `jwsCases`
// so far, and reads `expect.docNulReplaced` (WIRE-CONTRACT-V3 §10), which this runner ignores.
//
// Seven sections, seven layers of the contract:
//
//   jwsCases         §1–§2 raw compact-JWS verification    → @polaris-key/jws verifyJws
//   licenseDocCases  §3 claim validation, license          → verifyLicenseDoc
//   configDocCases   §3 claim validation, config           → verifyConfigDoc
//   trustCases       §1 trust merge / prune / revocation   → verifyTrustManifest + mergeTrust
//   clockFloorCases  §4.2 monotonic floor over 3 artifacts → the reload path + licenseState
//   gate-matrix      §5 the gate decision table            → licenseState
//   bundleCases      §7 offline bundle import              → inspectBundle
//
// The fourth file in `corpus/v2/`, `stage-matrix.json` (the boot stage machine, client boot
// behaviour outside the wire contract), has its own runner: `stageMatrix.test.ts`, through
// `@polaris-key/client-core/stages`. `fingerprint.json` likewise runs in `fingerprint.test.ts`.
//
// The bundle section used to carry an inline reference implementation of §7's numbered order,
// because no shipped verifier existed. P4 shipped one — `@polaris-key/client-core`'s `inspectBundle`
// — and this file now drives THAT, vector for vector, including which numbered step refuses.
// The step attribution is the whole point of the section, so the shipped API reports it
// (`BundleRefusalReason`) rather than collapsing every failure into a bare null.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyJws, type TrustSet } from "@polaris-key/jws";
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
  MAX_BUNDLE_BYTES,
  channelForVersion,
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
  type BlockedState,
  type BundleRefusalReason,
  type VerifyOptions,
} from "@polaris-key/client-core";

type TypV3 =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws";

interface JwsCase {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  typ?: TypV3;
  maxPayloadBytes?: number;
  expect: { verify: "ok" | "fail"; kid?: string; doc?: unknown };
}

interface DocCase {
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

interface TrustCase {
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

interface BundleCase {
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

interface Corpus {
  corpusVersion: number;
  keys: { kid: string; publicKeyRaw: string }[];
  jwsCases: JwsCase[];
  licenseDocCases: DocCase[];
  configDocCases: DocCase[];
  trustCases: TrustCase[];
  clockFloorCases: ClockFloorCase[];
  bundleCases: BundleCase[];
}

interface MatrixRow {
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

const here = dirname(fileURLToPath(import.meta.url));
const v2 = (name: string): string =>
  join(here, "..", "..", "corpus", "v2", name);
const corpus = JSON.parse(readFileSync(v2("cases.json"), "utf8")) as Corpus;
const matrix = JSON.parse(readFileSync(v2("gate-matrix.json"), "utf8")) as {
  gateMatrixVersion: number;
  rows: MatrixRow[];
};

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

// @pkey-feature core.verify
describe(`conformance corpus v${corpus.corpusVersion} — license documents (§3)`, () => {
  for (const c of corpus.licenseDocCases) {
    it(`${c.id} → accept:${c.expect.accept}`, async () => {
      const doc = await verifyLicenseDoc(c.jws, docOpts(c));
      expect(doc !== null, `${c.id} — ${c.description}`).toBe(c.expect.accept);
    });
  }
});

// @pkey-feature core.verify
describe(`conformance corpus v${corpus.corpusVersion} — config documents (§3)`, () => {
  for (const c of corpus.configDocCases) {
    it(`${c.id} → accept:${c.expect.accept}`, async () => {
      const doc = await verifyConfigDoc(c.jws, docOpts(c));
      expect(doc !== null, `${c.id} — ${c.description}`).toBe(c.expect.accept);
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
      expect(result.doc !== null, `${c.id} acceptance`).toBe(c.expect.accepted);
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
      expect(state.status, `${c.id} — ${c.description}`).toBe(c.expect.status);
    });
  }
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
    for (const name of P0_04_CHANNEL_ROWS) expect(names, name).toContain(name);
    expect(names).not.toContain(
      "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel",
    );
  });
});

// ── §7 — offline bundle import, all-or-nothing, in the contract's numbered order ────────
// `inspectBundle` walks steps 1–4 and reports the step that refused; step 5 (the atomic cache
// write) belongs to the host, so what the corpus can pin is exactly what this returns.
//
// Note what the runner no longer does: it does not hand the verifier a payload cap. §1's
// raised bundle cap is a property of the `typ`, not of the caller, so `inspectBundle` takes
// it from `MAX_BUNDLE_BYTES` and the fixture's value is asserted to agree — which is a
// STRONGER pin than passing it in, because a runner that supplies the cap cannot catch an
// implementation that forgot to apply one.
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

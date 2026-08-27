// The Node conformance runner for corpus v1 / wire contract v2.
//
// v1 is not the live contract any more — `corpusV2.test.ts` is — but it is still the fixture
// the PYTHON and SWIFT runners consume, and it stays in this repo until P5 moves them and P8
// deletes it. Keeping a Node runner on it is what makes that safe: v1 is the only shared
// oracle those two SDKs currently have, and a fixture nothing exercises is a fixture that can
// rot while three implementations quietly disagree with it.
//
// ── WHAT CHANGED IN P4 ──────────────────────────────────────────────────────────────────────
//
// These cases used to be driven through `@plrs/node`'s own `verifyDoc` / `verifyTrustManifest`
// / `licenseState`. Those copies are gone: the Node SDK now CONSUMES `@plrs/client-core`, the
// single isomorphic implementation React and every future JS host share. So v1 runs through
// client-core too, with the two smallest possible v2 shims:
//
//   * a `DocTypeSpec` naming v2's `pkey-config+jws` and validating the fused document's
//     `schemaVersion` — `verifyDoc` was always generic over the document type, so this is the
//     seam being used as designed rather than a new one being cut;
//   * `verifyTrustManifest`'s `typ` option, for v2's `pkey-trust+jws`.
//
// Everything else — the envelope rules, the substitution guard, the prune, the freshness split,
// the clock floor, the gate — is the SAME CODE corpus v2 runs. That is the point: if v3's
// implementation ever decides a v2 case differently, it shows up here as a red test rather than
// as a divergence discovered by a Python SDK a phase later.
//
//   cases            raw compact-JWS verification            → @plrs/jws  verifyJws
//   docCases         §3 claim validation                     → client-core verifyDoc
//   trustCases       §1 trust-set merge / prune / revocation  → client-core verifyTrustManifest
//   clockFloorCases  §4.3 monotonic clock floor               → the cache-reload path + gate
//
// The fingerprint/device-id half of v1 lives in `fingerprint.test.ts` and stays with
// `@plrs/node/devices`, because those two formulas ARE Node-only host code.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { verifyJws, type TrustSet } from "@plrs/jws";
import type { ManagedConfigDoc } from "@plrs/protocol";
import type { LicenseDoc } from "@plrs/protocol/license";
import {
  effectiveNow,
  highWaterMark,
  licenseState,
  mergeTrust,
  verifyDoc,
  verifyTrustManifest,
  type DocTypeSpec,
} from "@plrs/client-core";

type Typ = "pkey-config+jws" | "pkey-trust+jws";

/**
 * v2's single fused document, expressed as a v3 `DocTypeSpec`.
 *
 * The envelope checks (`iss`/`aud`/`deviceId`/the grace ceiling/the anti-replay floor/the
 * freshness split) are shared and live in `verifyDoc` itself; all that differs is the domain
 * separator and the one per-document claim v2 had. `schemaVersion` is validated by SHAPE, not
 * against an allow-list — on a managed-config document that field carries the product CATALOG
 * version, which is unbounded per product (see client-core's `verify.ts` for the full note).
 */
const V2_MANAGED_DOC: DocTypeSpec<ManagedConfigDoc> = {
  typ: "pkey-config+jws",
  validate: (doc) =>
    typeof doc.schemaVersion === "number" &&
    Number.isInteger(doc.schemaVersion) &&
    doc.schemaVersion >= 1,
};

interface CorpusCase {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  typ?: Typ;
  expect: { verify: "ok" | "fail"; kid?: string; doc?: unknown };
}

interface DocCase {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
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
  configJws?: string;
  expectedAud: string;
  deviceId: string;
  systemClock: number;
  expect: { highWaterMark: number; effectiveNow: number; status: string };
}

interface Corpus {
  corpusVersion: number;
  keys: { kid: string; publicKeyRaw: string }[];
  cases: CorpusCase[];
  docCases: DocCase[];
  trustCases: TrustCase[];
  clockFloorCases: ClockFloorCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "..", "..", "corpus", "v1", "cases.json"), "utf8"),
) as Corpus;

/** v2's `iss` and v2's trust `typ`, both supplied explicitly so the v3 defaults (`plrs.im`,
 *  `plrs-trust+jws`) stay untouched. `JwsTyp` still carries the legacy values until P8, so
 *  neither of these needs a cast — the frozen crypto layer knows about both contracts. */
const V2_ISS = "key.plrs.im";
const V2_TRUST_TYP = "pkey-trust+jws" as const;

describe(`conformance corpus v${corpus.corpusVersion}`, () => {
  it("has cases", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(corpus.docCases.length).toBeGreaterThan(0);
    expect(corpus.trustCases.length).toBeGreaterThan(0);
    expect(corpus.clockFloorCases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    it(`${c.id} → verify:${c.expect.verify}`, async () => {
      // No `requireTyp` here: v2's tolerance window — a header carrying NO `typ` is accepted,
      // a header carrying a DIFFERENT one is not — is exactly what these vectors pin, and v3
      // closing that window is corpus v2's business, not this file's.
      const result = await verifyJws(c.jws, c.trust, { typ: c.typ });
      if (c.expect.verify === "ok") {
        expect(result, `${c.id} should verify`).not.toBeNull();
        expect(result!.kid).toBe(c.expect.kid);
        expect(result!.payload).toEqual(c.expect.doc);
      } else {
        expect(result, `${c.id} must fail verification`).toBeNull();
      }
    });
  }
});

describe(`conformance corpus v${corpus.corpusVersion} — claim validation (§3)`, () => {
  for (const c of corpus.docCases) {
    it(`${c.id} → accept:${c.expect.accept}`, async () => {
      const doc = await verifyDoc(c.jws, V2_MANAGED_DOC, {
        trust: c.trust,
        expectedAud: c.expectedAud,
        expectedIss: c.expectedIss,
        deviceId: c.deviceId,
        now: c.now,
        lastAcceptedIssuedAt: c.lastAcceptedIssuedAt,
        checkFreshness: c.checkFreshness,
      });
      expect(doc !== null, `${c.id} — ${c.description}`).toBe(c.expect.accept);
    });
  }
});

describe(`conformance corpus v${corpus.corpusVersion} — trust set (§1)`, () => {
  for (const c of corpus.trustCases) {
    it(`${c.id} → accepted:${c.expect.accepted}`, async () => {
      const result = await verifyTrustManifest(c.manifestJws, {
        pinned: c.pinned,
        expectedAud: "djdl",
        expectedIss: V2_ISS,
        typ: V2_TRUST_TYP,
        now: c.now,
        checkFreshness: c.checkFreshness,
      });
      expect(result.doc !== null, `${c.id} acceptance`).toBe(c.expect.accepted);
      // Accepted ⇒ the discovered set REPLACES what was held; rejected ⇒ it is untouched.
      const discovered = result.doc ? result.discovered : c.before;
      expect(mergeTrust(c.pinned, discovered)).toEqual(c.expect.trust);
      // The accepted manifest's `issuedAt` is what §4.3 folds into the clock floor.
      if (c.expect.issuedAt !== undefined) {
        expect(result.doc?.issuedAt, `${c.id} issuedAt`).toBe(
          c.expect.issuedAt,
        );
      }
    });
  }
});

// §4.3 — the monotonic clock floor. Each case replays the cache-RELOAD path as pure data:
// re-verify the cached manifest (freshness OFF), re-verify the cached document against the
// resulting trust set (freshness OFF), take the floor as the max of the `issuedAt` of
// whatever actually verified, and gate at `max(systemClock, floor)`.
describe(`conformance corpus v${corpus.corpusVersion} — clock floor (§4.3)`, () => {
  for (const c of corpus.clockFloorCases) {
    it(`${c.id} → ${c.expect.status}`, async () => {
      let trust: TrustSet = c.pinned;
      const verified: { issuedAt: number }[] = [];

      if (c.trustJws !== undefined) {
        const manifest = await verifyTrustManifest(c.trustJws, {
          pinned: c.pinned,
          expectedAud: c.expectedAud,
          expectedIss: V2_ISS,
          typ: V2_TRUST_TYP,
          now: c.systemClock,
          checkFreshness: false,
        });
        if (manifest.doc) {
          trust = mergeTrust(c.pinned, manifest.discovered);
          verified.push(manifest.doc);
        }
      }

      let doc: ManagedConfigDoc | null = null;
      if (c.configJws !== undefined) {
        doc = await verifyDoc(c.configJws, V2_MANAGED_DOC, {
          trust,
          expectedAud: c.expectedAud,
          expectedIss: V2_ISS,
          deviceId: c.deviceId,
          now: c.systemClock,
          checkFreshness: false,
        });
        if (doc) verified.push(doc);
      }

      const floor = highWaterMark(verified);
      expect(floor, `${c.id} highWaterMark`).toBe(c.expect.highWaterMark);
      expect(effectiveNow(c.systemClock, floor), `${c.id} effectiveNow`).toBe(
        c.expect.effectiveNow,
      );
      // The v2→v3 gate shim, as small as it can be: every v1 product licensed
      // (`licenseServiceEnabled: true`) and `hasToken: true` ⇒ `activation: "token"`. The gate
      // reads only the three timestamps off the document, so the fused v2 shape is compatible.
      const state = licenseState({
        licenseServiceEnabled: true,
        activation: "token",
        // The v2 document is not a `LicenseDoc` (its entitlements are nested under `payload`),
        // but the gate reads only `issuedAt`/`expiresAt`/`graceUntil`, which the two shapes
        // share — so the cast is narrow and the assertion below is what proves it holds.
        doc: doc as unknown as LicenseDoc | null,
        now: c.systemClock,
        highWaterMark: floor,
      });
      expect(state.status, `${c.id} — ${c.description}`).toBe(c.expect.status);
    });
  }
});

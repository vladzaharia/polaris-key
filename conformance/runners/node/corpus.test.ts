// The Node conformance runner. It drives EVERY case in the shared corpus through the
// production verifiers and asserts the expected outcome. The Python (pytest), Swift (XCTest),
// and React (vitest/WebCrypto) runners mirror this file against the SAME corpus/v1/cases.json
// — that's how four SDKs prove byte-identical verification.
//
// Four sections, four layers of the wire contract:
//
//   cases            raw compact-JWS verification            → @plrs/jws  verifyJws
//   docCases         §3 claim validation                     → @plrs/node verifyDoc
//   trustCases       §1 trust-set merge / prune / revocation  → verifyTrustManifest
//   clockFloorCases  §4.3 monotonic clock floor               → the cache-reload path + gate

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { verifyJws, type TrustSet } from "@plrs/jws";
import {
  licenseState,
  mergeTrust,
  verifyDoc,
  verifyTrustManifest,
} from "@plrs/node";

type Typ = "pkey-config+jws" | "pkey-trust+jws";

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

describe(`conformance corpus v${corpus.corpusVersion}`, () => {
  it("has cases", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(corpus.docCases.length).toBeGreaterThan(0);
    expect(corpus.trustCases.length).toBeGreaterThan(0);
    expect(corpus.clockFloorCases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    it(`${c.id} → verify:${c.expect.verify}`, async () => {
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
      const doc = await verifyDoc(c.jws, {
        trust: c.trust,
        expectedAud: c.expectedAud,
        expectedIss: c.expectedIss,
        deviceId: c.deviceId,
        now: c.now,
        lastAcceptedIssuedAt: c.lastAcceptedIssuedAt,
        checkFreshness: c.checkFreshness,
      });
      if (c.expect.accept) {
        expect(doc, `${c.id} should be accepted`).not.toBeNull();
      } else {
        expect(doc, `${c.id} must be rejected`).toBeNull();
      }
    });
  }
});

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
      let highWaterMark = 0;

      if (c.trustJws !== undefined) {
        const manifest = await verifyTrustManifest(c.trustJws, {
          pinned: c.pinned,
          expectedAud: c.expectedAud,
          now: c.systemClock,
          checkFreshness: false,
        });
        if (manifest.doc) {
          trust = mergeTrust(c.pinned, manifest.discovered);
          highWaterMark = Math.max(highWaterMark, manifest.doc.issuedAt);
        }
      }

      let doc = null;
      if (c.configJws !== undefined) {
        doc = await verifyDoc(c.configJws, {
          trust,
          expectedAud: c.expectedAud,
          deviceId: c.deviceId,
          now: c.systemClock,
          checkFreshness: false,
        });
        if (doc) highWaterMark = Math.max(highWaterMark, doc.issuedAt);
      }

      expect(highWaterMark, `${c.id} highWaterMark`).toBe(
        c.expect.highWaterMark,
      );
      const effectiveNow = Math.max(c.systemClock, highWaterMark);
      expect(effectiveNow, `${c.id} effectiveNow`).toBe(c.expect.effectiveNow);
      const state = licenseState({
        hasToken: true,
        doc,
        now: c.systemClock,
        highWaterMark,
      });
      expect(state.status, `${c.id} — ${c.description}`).toBe(c.expect.status);
    });
  }
});

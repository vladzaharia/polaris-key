// The Node conformance runner. It drives EVERY case in the shared corpus through the
// production verifiers and asserts the expected outcome. The Python (pytest), Swift (XCTest),
// and React (vitest/WebCrypto) runners mirror this file against the SAME corpus/v1/cases.json
// — that's how four SDKs prove byte-identical verification.
//
// Three sections, three layers of the wire contract:
//
//   cases       raw compact-JWS verification            → @polaris-key/jws  verifyJws
//   docCases    §3 claim validation                     → @polaris-key/node verifyDoc
//   trustCases  §1 trust-set merge / prune / revocation → @polaris-key/node verifyTrustManifest

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { verifyJws, type TrustSet } from "@polaris-key/jws";
import { mergeTrust, verifyDoc, verifyTrustManifest } from "@polaris-key/node";

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
  expect: { accepted: boolean; trust: TrustSet };
}

interface Corpus {
  corpusVersion: number;
  keys: { kid: string; publicKeyRaw: string }[];
  cases: CorpusCase[];
  docCases: DocCase[];
  trustCases: TrustCase[];
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
      });
      expect(result.doc !== null, `${c.id} acceptance`).toBe(c.expect.accepted);
      // Accepted ⇒ the discovered set REPLACES what was held; rejected ⇒ it is untouched.
      const discovered = result.doc ? result.discovered : c.before;
      expect(mergeTrust(c.pinned, discovered)).toEqual(c.expect.trust);
    });
  }
});

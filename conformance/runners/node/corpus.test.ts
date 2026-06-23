// The Node conformance runner. It drives EVERY case in the shared corpus through the
// production verifier (@polaris-key/jws) and asserts the expected verify outcome. The
// Python (pytest), Swift (XCTest), and React (vitest/WebCrypto) runners mirror this file
// against the SAME corpus/v1/cases.json — that's how four SDKs prove byte-identical
// verification.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { verifyJws, type TrustSet } from "@polaris-key/jws";

interface CorpusCase {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  expect: { verify: "ok" | "fail"; kid?: string; doc?: unknown };
}
interface Corpus {
  corpusVersion: number;
  keys: { kid: string; publicKeyRaw: string }[];
  cases: CorpusCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "..", "..", "corpus", "v1", "cases.json"), "utf8"),
) as Corpus;

describe(`conformance corpus v${corpus.corpusVersion}`, () => {
  it("has cases", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    it(`${c.id} → verify:${c.expect.verify}`, async () => {
      const result = await verifyJws(c.jws, c.trust);
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

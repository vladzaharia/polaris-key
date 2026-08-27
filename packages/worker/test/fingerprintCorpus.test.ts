// The Worker half of the fingerprint conformance check.
//
// This matters more than it looks: the Worker RECOMPUTES the hwid from the components a
// client sends (it never trusts the client's own value), so if the Worker's formula and an
// SDK's formula ever diverge, free-tier dedupe silently stops matching and every machine
// looks new. The SDK halves live in conformance/runners/node, sdks/python/tests, and
// sdks/swift/Tests — all against this same file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FingerprintComponent } from "@polaris-key/protocol";
import { computeComponentHash, computeHwid } from "../src/fingerprint.js";

interface Vector {
  id: string;
  description: string;
  product: string;
  raw: Partial<Record<FingerprintComponent, string>>;
  components: Partial<Record<FingerprintComponent, string>>;
  hwid: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "fingerprint.json",
    ),
    "utf8",
  ),
) as { fingerprintVersion: number; vectors: Vector[] };

describe(`fingerprint corpus v${corpus.fingerprintVersion} (worker)`, () => {
  it("has vectors", () => {
    expect(corpus.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of corpus.vectors) {
    it(`${vector.id}: ${vector.description}`, async () => {
      for (const [component, raw] of Object.entries(vector.raw)) {
        expect(
          await computeComponentHash(
            vector.product,
            component as FingerprintComponent,
            raw,
          ),
          `component ${component}`,
        ).toBe(vector.components[component as FingerprintComponent]);
      }
      expect(await computeHwid(vector.components)).toBe(vector.hwid);
    });
  }
});

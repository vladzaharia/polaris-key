// The Node conformance runner for the fingerprint + device-id formulas.
//
// Until this landed, device-id derivation was the ONE cross-language behaviour with no golden
// vector — Node, Python, and Swift agreed only by code review. Both formulas are now pinned,
// and the Python (pytest) and Swift (XCTest) runners mirror this file against the SAME
// corpus/v1/fingerprint.json.
//
// P4 re-attribution: these two stay with `@plrs/node`, unlike the verification cases that
// moved to `@plrs/client-core`. They are the one part of the wire contract that CANNOT be
// isomorphic — reading a machine UUID means `ioreg`/the registry/`/sys/class/dmi`, and the
// hashing that follows is only meaningful over what those reads produced. They now live at the
// `@plrs/node/devices` subpath, together, because they are the same kind of thing (hashed
// hardware identity, computed on-device so raw serials never cross the wire) and because THIS
// FILE pins both. `fingerprintVersion` is 1 and unchanged by v3.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { FingerprintComponent } from "@plrs/protocol/core";
import { deviceIdFromRaw, hashComponents } from "@plrs/node/devices";

interface Vector {
  id: string;
  description: string;
  product: string;
  raw: Partial<Record<FingerprintComponent, string>>;
  components: Partial<Record<FingerprintComponent, string>>;
  hwid: string;
}
interface DeviceIdVector {
  id: string;
  product: string;
  raw: string;
  expected: string;
}
interface FingerprintCorpus {
  fingerprintVersion: number;
  componentOrder: FingerprintComponent[];
  vectors: Vector[];
  deviceIds: DeviceIdVector[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v1", "fingerprint.json"),
    "utf8",
  ),
) as FingerprintCorpus;

describe(`fingerprint corpus v${corpus.fingerprintVersion} (node sdk)`, () => {
  it("has vectors", () => {
    expect(corpus.vectors.length).toBeGreaterThan(0);
    expect(corpus.deviceIds.length).toBeGreaterThan(0);
  });

  for (const vector of corpus.vectors) {
    it(`${vector.id}: ${vector.description}`, () => {
      const actual = hashComponents(vector.product, vector.raw);
      expect(actual.components).toEqual(vector.components);
      expect(actual.hwid).toBe(vector.hwid);
    });
  }

  for (const vector of corpus.deviceIds) {
    it(`device-id ${vector.id}`, () => {
      expect(deviceIdFromRaw(vector.product, vector.raw)).toBe(vector.expected);
    });
  }
});

// @pkey-feature devices.fingerprint
// The Node conformance runner for the fingerprint + device-id formulas.
//
// Until this landed, device-id derivation was the ONE cross-language behaviour with no golden
// vector — Node, Python, and Swift agreed only by code review. Both formulas are now pinned,
// and the Python (pytest) and Swift (XCTest) runners mirror this file against the SAME
// corpus/v2/fingerprint.json; the Godot runner (sdks/godot/tests/suite_conformance.gd) mirrors
// its `deviceIds` vectors, on an editor and an exported release template.
//
// P4 re-attribution: these two stay with `@polaris-key/node`, unlike the verification cases that
// moved to `@polaris-key/client-core`. They are the one part of the wire contract that CANNOT be
// isomorphic — reading a machine UUID means `ioreg`/the registry/`/sys/class/dmi`, and the
// hashing that follows is only meaningful over what those reads produced. They now live at the
// `@polaris-key/node/devices` subpath, together, because they are the same kind of thing (hashed
// hardware identity, computed on-device so raw serials never cross the wire) and because THIS
// FILE pins both. `fingerprintVersion` is 1 and unchanged by v3.
//
// P1b-09 added the three SOURCE rules (WIRE-CONTRACT-V3 §6.1): which raw values a native SDK
// reads before hashing. Node reads Windows and Linux hardware, so it runs all three sections —
// `windowsCim`, `linuxAnchor`, `ramBuckets` — plus the pinned `windowsCimCommand`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { FingerprintComponent } from "@polaris-key/protocol/core";
import {
  deviceIdFromRaw,
  hashComponents,
  linuxAnchorSource,
  parseWindowsCim,
  ramBucket,
  WINDOWS_CIM_COMMAND,
} from "@polaris-key/node/devices";

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
interface WindowsCimCase {
  id: string;
  description: string;
  stdout: string;
  expected: { boardSerial?: string; machineModel?: string };
}
interface LinuxAnchorCase {
  id: string;
  description: string;
  files: Record<string, string>;
  expected: { source: string; value: string } | null;
}
interface RamBucketCase {
  id: string;
  description: string;
  bytes: number;
  bucket: string | null;
}
interface FingerprintCorpus {
  fingerprintVersion: number;
  componentOrder: FingerprintComponent[];
  vectors: Vector[];
  deviceIds: DeviceIdVector[];
  windowsCimCommand: {
    program: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
  };
  windowsCim: WindowsCimCase[];
  linuxAnchor: LinuxAnchorCase[];
  ramBuckets: RamBucketCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "fingerprint.json"),
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

describe("fingerprint source rules (WIRE-CONTRACT-V3 §6.1, node sdk)", () => {
  it("windowsCimCommand: the SDK runs exactly the pinned command", () => {
    expect({
      program: WINDOWS_CIM_COMMAND.program,
      args: [...WINDOWS_CIM_COMMAND.args],
      stdin: WINDOWS_CIM_COMMAND.stdin,
      timeoutMs: WINDOWS_CIM_COMMAND.timeoutMs,
    }).toEqual(corpus.windowsCimCommand);
  });

  it("has every section", () => {
    expect(corpus.windowsCim.length).toBeGreaterThan(0);
    expect(corpus.linuxAnchor.length).toBeGreaterThan(0);
    expect(corpus.ramBuckets.length).toBeGreaterThan(0);
  });

  for (const c of corpus.windowsCim) {
    it(`windowsCim ${c.id}: ${c.description}`, () => {
      expect(parseWindowsCim(c.stdout)).toEqual(c.expected);
    });
  }

  for (const c of corpus.linuxAnchor) {
    it(`linuxAnchor ${c.id}: ${c.description}`, () => {
      expect(linuxAnchorSource(c.files)).toEqual(c.expected);
    });
  }

  for (const c of corpus.ramBuckets) {
    it(`ramBuckets ${c.id}: ${c.description}`, () => {
      expect(ramBucket(c.bytes)).toBe(c.bucket);
    });
  }
});

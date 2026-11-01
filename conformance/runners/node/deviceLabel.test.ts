// @pkey-feature identity.devicelabel
// The Node conformance runner for `conformance/corpus/v2/device-label.json` (WIRE-CONTRACT-V5
// §12.7.1 and §15.6, plans/PX-W13.md §4, DEVICE-LABEL-STRIP). It covers React too: both JS SDKs
// normalise through the same `client-core` functions. The Python (`tests/test_device_label.py`), Swift
// (`DeviceLabelTests.swift`), Godot (`tests/suite_conformance.gd`) and Kotlin
// (`DeviceLabelTest.kt`) runners and the Worker (`test/services/identity/deviceLabelCorpus.test.ts`) run the same
// rows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cleanDisplayLabel,
  normalizeDeviceLabel,
} from "@polaris-key/client-core";
import {
  DEVICE_LABEL_MAX_CODEPOINTS,
  DEVICE_LABEL_SPACE,
  DEVICE_LABEL_STRIP,
} from "@polaris-key/protocol/identity";
import { DEVICE_LABEL_MAX_CODEPOINTS as NODE_MAX } from "@polaris-key/node";

interface DeviceLabelCase {
  id: string;
  description: string;
  raw: string;
  expect: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "corpus", "v2", "device-label.json"),
    "utf8",
  ),
) as {
  deviceLabelVersion: number;
  ranges: { space: [number, number][]; strip: [number, number][] };
  cases: DeviceLabelCase[];
  helloCases: DeviceLabelCase[];
};

describe("device-label.json", () => {
  it("is version 2 with rows in both sections", () => {
    expect(corpus.deviceLabelVersion).toBe(2);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(47);
    expect(corpus.helloCases.length).toBeGreaterThanOrEqual(11);
  });

  it("the generated constant matches the protocol", () => {
    expect(NODE_MAX).toBe(DEVICE_LABEL_MAX_CODEPOINTS);
  });

  it("the protocol tables equal ranges", () => {
    expect(DEVICE_LABEL_SPACE).toEqual(corpus.ranges.space);
    expect(DEVICE_LABEL_STRIP).toEqual(corpus.ranges.strip);
  });

  for (const row of corpus.cases)
    it(row.id, () => {
      expect(normalizeDeviceLabel(row.raw)).toBe(row.expect);
      // Cleaning a cleaned label changes nothing.
      if (row.expect !== null)
        expect(normalizeDeviceLabel(row.expect)).toBe(row.expect);
    });

  for (const row of corpus.helloCases)
    it(row.id, () => {
      expect(cleanDisplayLabel(row.raw)).toBe(row.expect);
      if (row.expect !== null)
        expect(cleanDisplayLabel(row.expect)).toBe(row.expect);
    });
});

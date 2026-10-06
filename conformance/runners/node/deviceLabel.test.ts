// @pkey-feature identity.devicelabel
// The Node conformance runner for `conformance/corpus/v2/device-label.json` (WIRE-CONTRACT-V4
// §12.7.1, plans/PX-W13.md §4). It covers React too: both JS SDKs normalise through the same
// `client-core` function. The Python (`tests/test_device_label.py`), Swift
// (`DeviceLabelTests.swift`), Godot (`tests/suite_conformance.gd`) and Kotlin
// (`DeviceLabelTest.kt`) runners and the Worker (`test/deviceLabelCorpus.test.ts`) run the same
// rows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { DEVICE_LABEL_MAX_CODEPOINTS } from "@polaris-key/protocol/identity";
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
) as { deviceLabelVersion: number; cases: DeviceLabelCase[] };

describe("device-label.json", () => {
  it("is version 1 with rows", () => {
    expect(corpus.deviceLabelVersion).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
  });

  it("the generated constant matches the protocol", () => {
    expect(NODE_MAX).toBe(DEVICE_LABEL_MAX_CODEPOINTS);
  });

  for (const row of corpus.cases)
    it(row.id, () => {
      expect(normalizeDeviceLabel(row.raw)).toBe(row.expect);
    });
});

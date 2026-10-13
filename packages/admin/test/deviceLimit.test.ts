/**
 * The console's device-limit rule agrees with the Worker's ceiling (`MAX_DEVICE_LIMIT`), in the
 * shared helper and in the product settings form's own check.
 */

import { describe, expect, it } from "vitest";
import { MAX_DEVICE_LIMIT as MANIFEST_MAX } from "@polaris-key/manifest";
import {
  deviceLimitIssue,
  isDeviceLimit,
  MAX_DEVICE_LIMIT,
} from "../src/lib/deviceLimit.js";
import { validateSettings } from "../src/console/sections/core/pages/Settings.js";

describe("isDeviceLimit", () => {
  it("is the manifest's ceiling, not a second copy", () => {
    expect(MAX_DEVICE_LIMIT).toBe(MANIFEST_MAX);
  });

  it("accepts a whole number from 1 to the ceiling and nothing else", () => {
    for (const ok of [1, 5, MAX_DEVICE_LIMIT])
      expect(isDeviceLimit(ok)).toBe(true);
    for (const bad of [
      0,
      -1,
      1.5,
      MAX_DEVICE_LIMIT + 1,
      100_000_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(isDeviceLimit(bad), String(bad)).toBe(false);
  });
});

describe("deviceLimitIssue", () => {
  it("is null for a fine value, and for blank only where the form allows it", () => {
    expect(deviceLimitIssue(MAX_DEVICE_LIMIT)).toBeNull();
    expect(deviceLimitIssue(null, "leave it blank")).toBeNull();
    expect(deviceLimitIssue(null)).toEqual(expect.any(String));
  });

  it("names the ceiling when a value is past it", () => {
    expect(deviceLimitIssue(MAX_DEVICE_LIMIT + 1)).toContain(
      String(MAX_DEVICE_LIMIT),
    );
    expect(deviceLimitIssue(0, "leave it blank")).toContain("leave it blank");
  });
});

describe("the product settings form", () => {
  const draft = (defaultDeviceLimit: number | null) => ({
    name: "Acme",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit,
    webOrigins: [],
  });

  it("refuses a default device limit past the ceiling, and accepts the ceiling", () => {
    expect(validateSettings(draft(MAX_DEVICE_LIMIT + 1))).toHaveProperty(
      "defaultDeviceLimit",
    );
    expect(validateSettings(draft(0))).toHaveProperty("defaultDeviceLimit");
    expect(validateSettings(draft(null))).toHaveProperty("defaultDeviceLimit");
    expect(validateSettings(draft(MAX_DEVICE_LIMIT))).not.toHaveProperty(
      "defaultDeviceLimit",
    );
  });
});

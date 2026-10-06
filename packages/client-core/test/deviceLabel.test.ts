// Unit tests for the §12.7.1 device label. The corpus rows (`device-label.json`) run in
// conformance/runners/node/deviceLabel.test.ts; these pin the edges the corpus cannot carry.
import { describe, expect, it } from "vitest";
import { normalizeDeviceLabel } from "../src/deviceLabel.js";

describe("normalizeDeviceLabel", () => {
  it("is not a string: no label", () => {
    expect(normalizeDeviceLabel(undefined)).toBeNull();
    expect(normalizeDeviceLabel(null)).toBeNull();
    expect(normalizeDeviceLabel(42)).toBeNull();
  });

  it("is idempotent", () => {
    const once = normalizeDeviceLabel("  Den\u202e PC\t\t");
    expect(once).toBe("Den PC");
    expect(normalizeDeviceLabel(once)).toBe(once);
  });

  it("counts code points, never UTF-16 units", () => {
    const emoji = "\u{1f3ae}".repeat(70);
    expect(Array.from(normalizeDeviceLabel(emoji)!)).toHaveLength(64);
  });
});

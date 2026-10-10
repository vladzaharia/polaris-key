import { describe, expect, it } from "vitest";
import {
  confirmLevel,
  draftError,
  formatSettingValue,
  fromField,
  intentOf,
  saveCopy,
  toField,
  type SettingSpec,
} from "../../src/ui/settings/model.js";

const enumSpec: SettingSpec = { kind: "enum", values: ["a", "b", "c"] };
const days: SettingSpec = { kind: "integer", unit: "days", min: 1, max: 365 };
const bytes: SettingSpec = {
  kind: "integer",
  unit: "bytes",
  min: 1_048_576,
  max: 33_554_432,
};

describe("confirmLevel", () => {
  it("is L0 for an unchanged value whatever the registry says", () => {
    expect(confirmLevel(enumSpec, { change: "L3" }, "a", "a")).toBe("L0");
  });
  it("reads each direction of the registry's confirm", () => {
    expect(confirmLevel(enumSpec, { up: "L2", down: "L1" }, "a", "c")).toBe(
      "L2",
    );
    expect(confirmLevel(enumSpec, { up: "L2", down: "L1" }, "c", "a")).toBe(
      "L1",
    );
    expect(confirmLevel(days, { up: "L1", down: "L0" }, 5, 9)).toBe("L1");
    expect(confirmLevel(days, { up: "L1", down: "L0" }, 9, 5)).toBe("L0");
    expect(
      confirmLevel({ kind: "switch" }, { on: "L1", off: "L0" }, "off", "on"),
    ).toBe("L1");
    expect(
      confirmLevel({ kind: "boolean" }, { on: "L0", off: "L2" }, true, false),
    ).toBe("L2");
  });
  it("asks at the level of the value changed TO, and L1 for one the registry omits", () => {
    const c = { byValue: { error: "L2" as const, warn: "L0" as const } };
    expect(confirmLevel(enumSpec, c, "warn", "error")).toBe("L2");
    expect(confirmLevel(enumSpec, c, "error", "warn")).toBe("L0");
    expect(confirmLevel(enumSpec, c, "warn", "unlisted")).toBe("L1");
  });
  // Negative control: a direction swapped would let a raise through as a lowering.
  it("does not treat a raise as a lowering", () => {
    expect(confirmLevel(days, { up: "L2", down: "L0" }, 5, 9)).not.toBe("L0");
  });
});

describe("formatSettingValue", () => {
  it("words each kind", () => {
    expect(formatSettingValue({ kind: "boolean" }, true)).toBe("On");
    expect(formatSettingValue({ kind: "switch" }, "off")).toBe("Off");
    expect(formatSettingValue(days, 1)).toBe("1 day");
    expect(formatSettingValue(days, 30)).toBe("30 days");
    expect(formatSettingValue(bytes, 33_554_432)).toBe("32 MiB");
    expect(formatSettingValue(enumSpec, "b", { b: "Bee" })).toBe("Bee");
    expect(formatSettingValue(enumSpec, "b", { values: { b: "Bee" } })).toBe(
      "Bee",
    );
    expect(formatSettingValue(enumSpec, "b")).toBe("b");
  });
});

describe("fields and drafts", () => {
  it("round-trips a byte size through MiB", () => {
    expect(toField(bytes, 16_777_216)).toBe(16);
    expect(fromField(bytes, 16)).toBe(16_777_216);
    expect(fromField(days, 7)).toBe(7);
  });
  it("names the bound a draft breaks, and passes one inside", () => {
    expect(draftError(bytes, 40 * 1_048_576)).toBe("Use 32 or less.");
    expect(draftError(days, 0)).toBe("Use 1 or more.");
    expect(draftError(days, null)).toBe("Enter a value.");
    expect(draftError(days, 30)).toBeNull();
    expect(draftError(enumSpec, "a")).toBeNull();
  });
});

describe("dialog words", () => {
  it("follows the kind of value", () => {
    expect(saveCopy("Lazy deltas", { kind: "switch" }, "on")).toEqual({
      title: "Turn on lazy deltas?",
      confirmLabel: "Turn on lazy deltas",
    });
    expect(saveCopy("Names", enumSpec, "b", { b: "Refuse" }).confirmLabel).toBe(
      "Set to refuse",
    );
    expect(saveCopy("Grace", days, 14).confirmLabel).toBe("Save 14 days");
  });
  it("makes L2 and L3 a danger and L1 a caution", () => {
    expect(intentOf("L0")).toBe("neutral");
    expect(intentOf("L1")).toBe("caution");
    expect(intentOf("L2")).toBe("danger");
    expect(intentOf("L3")).toBe("danger");
  });
});

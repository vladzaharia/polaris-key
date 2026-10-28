import { describe, expect, it } from "vitest";
import {
  decodeReplacePick,
  encodeReplacePick,
} from "../../../src/services/identity/licenseChoice.js";

describe("the replace-pick value", () => {
  it("round-trips ids that hold the separator", () => {
    const raw = encodeReplacePick("lic|a", "dev|b|c");
    expect(raw.split("|")).toHaveLength(2);
    expect(decodeReplacePick(raw)).toEqual({
      licenseId: "lic|a",
      deviceId: "dev|b|c",
    });
  });

  it("leaves plain ids as they were", () => {
    expect(encodeReplacePick("lic_start", "work-laptop")).toBe(
      "lic_start|work-laptop",
    );
  });

  it("refuses what it could not have made", () => {
    expect(decodeReplacePick("a|b|c")).toBeNull();
    expect(decodeReplacePick("only")).toBeNull();
    expect(decodeReplacePick("%E0|b")).toBeNull();
  });
});

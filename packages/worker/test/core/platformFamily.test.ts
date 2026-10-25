import { describe, expect, it } from "vitest";
import { PLATFORM_SPELLINGS } from "@polaris-key/protocol/core";
import {
  knownPlatform,
  platformFamily,
} from "../../src/core/devices/platformFamily.js";

describe("knownPlatform (the closed set the Cloud Sync directory records)", () => {
  it("is every canonical platform id, as itself", () => {
    for (const id of new Set(Object.values(PLATFORM_SPELLINGS)))
      expect(knownPlatform(id)).toBe(id);
  });
  it("is null for a family, a free-form string or a non-string", () => {
    for (const odd of [
      "mobile",
      "desktop",
      "Windows 11",
      "",
      "__proto__",
      "toString",
      null,
      undefined,
      3,
    ])
      expect(knownPlatform(odd), String(odd)).toBeNull();
  });
  it("covers exactly the platforms that have a family", () => {
    for (const id of new Set(Object.values(PLATFORM_SPELLINGS)))
      expect(platformFamily(id)).toBeTruthy();
  });
});

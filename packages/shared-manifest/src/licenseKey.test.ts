import { describe, expect, it } from "vitest";
import {
  checkLicenseKey,
  licenseKeyParts,
  licenseKeySlug,
  maskLicenseKey,
  normaliseLicenseKey,
} from "./licenseKey.js";

const SECRET = "A".repeat(22);

describe("licence-key format", () => {
  it("accepts the minted shape and trims whitespace", () => {
    expect(checkLicenseKey(`  pkey_tidewater_${SECRET}\n`)).toEqual({
      kind: "valid",
      slug: "tidewater",
      secret: SECRET,
    });
    expect(normaliseLicenseKey(" x \n")).toBe("x");
  });

  it("classifies what is not yet a key", () => {
    expect(checkLicenseKey("")).toEqual({ kind: "empty" });
    expect(checkLicenseKey("pke")).toEqual({ kind: "partial" });
    expect(checkLicenseKey("ABCDE-ABCDE-ABCDE")).toEqual({
      kind: "notKey",
      steam: true,
    });
    expect(checkLicenseKey("hello")).toEqual({ kind: "notKey", steam: false });
  });

  it("names why a pkey_ key is incomplete", () => {
    const reason = (s: string) => {
      const c = checkLicenseKey(s);
      return c.kind === "incomplete" ? c.reason : c.kind;
    };
    expect(reason("pkey_tide")).toBe("short");
    expect(reason(`pkey_tide_${"A".repeat(5)}`)).toBe("short");
    expect(reason(`pkey_tide_${"A".repeat(23)}`)).toBe("long");
    expect(reason(`pkey_tide_${"A".repeat(10)} ${"A".repeat(11)}`)).toBe(
      "space",
    );
    expect(reason(`pkey_tide_${"A".repeat(21)}!`)).toBe("chars");
    expect(reason(`pkey_Tide_${SECRET}`)).toBe("chars");
  });

  it("masks, slugs and splits", () => {
    expect(maskLicenseKey("tidewater", "KQ2w")).toBe("pkey_tidewater_…KQ2w");
    expect(maskLicenseKey("tidewater")).toBe("pkey_tidewater_…");
    expect(licenseKeySlug(`pkey_lumen-raw_${SECRET}`)).toBe("lumen-raw");
    expect(licenseKeyParts("pkey_a_bc")).toEqual({
      prefix: "pkey_",
      slug: "a",
      sep: "_",
      rest: "bc",
    });
  });
});

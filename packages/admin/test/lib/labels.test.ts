import { describe, expect, it } from "vitest";
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  PROVIDER_LABELS,
  REGISTRATION_LABELS,
  SIGN_IN_LABELS,
  label,
} from "../../src/lib/labels.js";

describe("labels (ADMIN.md §5.8)", () => {
  it("words the documented examples", () => {
    expect(label(REGISTRATION_LABELS, "requires-license")).toBe(
      "License required",
    );
    expect(label(SIGN_IN_LABELS, "manual")).toBe("Manual");
    expect(label(SIGN_IN_LABELS, "oidc")).toBe("Single sign-on");
    expect(label(PROVIDER_LABELS, "github")).toBe("GitHub");
    expect(label(PROVIDER_LABELS, null)).toBe("None");
    expect(label(PROVIDER_LABELS, undefined)).toBe("None");
  });

  it("humanises an unknown value rather than showing the slug", () => {
    expect(label(ACCESS_LABELS, "staff-only")).toBe("Staff only");
  });

  it("describes every access mode", () => {
    expect(Object.keys(ACCESS_DESCRIPTIONS).sort()).toEqual(
      Object.keys(ACCESS_LABELS).sort(),
    );
  });
});

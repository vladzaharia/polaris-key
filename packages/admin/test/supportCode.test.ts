import { describe, expect, it } from "vitest";
import {
  SUPPORT_CODE_ALPHABET,
  formatSupportCode,
  normalizeSupportCode,
  parseSupportCode,
  supportCodeCheck,
} from "../src/lib/supportCode.js";

/** The console's copy of the Worker's `core/accounts/supportCodes.ts` (I-41): same alphabet, same rules. */
describe("support codes in the console", () => {
  it("shares the Worker's alphabet: 30 symbols, no lookalikes", () => {
    expect(SUPPORT_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTVWXYZ");
    for (const bad of "01ILOU")
      expect(SUPPORT_CODE_ALPHABET).not.toContain(bad);
  });

  it("normalises case, spaces, dashes and dots, and refuses everything else", () => {
    for (const typed of [
      "k7m-4qx-9tz",
      "K7M 4QX 9TZ",
      " k7m.4qx.9tz ",
      "K7M4QX9TZ",
    ])
      expect(normalizeSupportCode(typed), typed).toBe("K7M4QX9TZ");
    for (const typed of [
      "",
      "K7M-4QX",
      "K7M-4QX-9T0",
      "K7M-4QX-9TI",
      "ps_".padEnd(25, "A"),
    ])
      expect(normalizeSupportCode(typed), typed).toBeNull();
    expect(formatSupportCode("K7M4QX9TZ")).toBe("K7M-4QX-9TZ");
  });

  it("tells a wrong check symbol and a lookalike from a plain non-code", () => {
    expect(parseSupportCode("K7M-4QX-9TB")).toEqual({ kind: "bad_check" });
    expect(parseSupportCode("K7M-4QX-9T0")).toEqual({ kind: "lookalike" });
    expect(parseSupportCode("K7M-4QX-9TZ")).toEqual({
      kind: "code",
      code: "K7M4QX9TZ",
    });
    expect(parseSupportCode("sarah.bergx")).toEqual({ kind: "not_code" });
    // The check is the Worker's: these pairs are pinned on both sides.
    expect(supportCodeCheck("23456789")).toBe("J");
    expect(supportCodeCheck("K7M4QX9T")).toBe("Z");
  });
});

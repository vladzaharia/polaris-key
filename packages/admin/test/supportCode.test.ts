import { describe, expect, it } from "vitest";
import {
  SUPPORT_CODE_ALPHABET,
  formatSupportCode,
  normalizeSupportCode,
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
      "k7m-4qx-9tb",
      "K7M 4QX 9TB",
      " k7m.4qx.9tb ",
      "K7M4QX9TB",
    ])
      expect(normalizeSupportCode(typed), typed).toBe("K7M4QX9TB");
    for (const typed of [
      "",
      "K7M-4QX",
      "K7M-4QX-9T0",
      "K7M-4QX-9TI",
      "ps_".padEnd(25, "A"),
    ])
      expect(normalizeSupportCode(typed), typed).toBeNull();
    expect(formatSupportCode("K7M4QX9TB")).toBe("K7M-4QX-9TB");
  });
});

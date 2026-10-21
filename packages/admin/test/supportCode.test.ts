import { describe, expect, it } from "vitest";
import {
  SUPPORT_CODE_ALPHABET,
  formatSupportCode,
  normalizeSupportCode,
  SUPPORT_CODE_WORDS,
  parseSupportCode,
  spellOut,
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
    // Nine-letter words are words, not mistyped codes; only a valid check makes one a code.
    for (const word of [
      "teammates",
      "john.smith",
      "Cloud Sync",
      "API tokens",
      "Trust pins",
    ])
      expect(parseSupportCode(word), word).toEqual({ kind: "not_code" });
    expect(parseSupportCode("KMNPQRSTM")).toEqual({
      kind: "code",
      code: "KMNPQRSTM",
    });
    // Code-shaped text with a digit, or in three groups of three, is told it is a typo.
    expect(parseSupportCode("KMN-PQR-STX")).toEqual({ kind: "bad_check" });
    expect(parseSupportCode("KMNPQRST2")).toEqual({ kind: "bad_check" });
    // The check is the Worker's: these pairs are pinned on both sides.
    expect(supportCodeCheck("23456789")).toBe("J");
    expect(supportCodeCheck("K7M4QX9T")).toBe("Z");
  });
});

describe("spelling a support code out (I-41s)", () => {
  it("gives every alphabet symbol exactly one word, and no two symbols share one", () => {
    const words = [...SUPPORT_CODE_ALPHABET].map((c) => SUPPORT_CODE_WORDS[c]);
    expect(words.every((w) => typeof w === "string" && w.length > 0)).toBe(
      true,
    );
    expect(new Set(words).size).toBe(SUPPORT_CODE_ALPHABET.length);
    expect(Object.keys(SUPPORT_CODE_WORDS).sort()).toEqual(
      [...SUPPORT_CODE_ALPHABET].sort(),
    );
  });

  it("spells each symbol of the alphabet as its own word", () => {
    for (const symbol of SUPPORT_CODE_ALPHABET) {
      const payload = (symbol + "2345678").slice(0, 8);
      const code = payload + supportCodeCheck(payload);
      const flat = spellOut(code).flat();
      expect(flat[0], symbol).toEqual({
        symbol,
        word: SUPPORT_CODE_WORDS[symbol],
      });
    }
    expect(SUPPORT_CODE_WORDS.K).toBe("Kilo");
    expect(SUPPORT_CODE_WORDS["7"]).toBe("Seven");
  });

  it("returns three groups of three, however the code was typed", () => {
    const groups = spellOut("k7m 4qx 9tz");
    expect(groups.map((g) => g.map((s) => s.symbol).join(""))).toEqual([
      "K7M",
      "4QX",
      "9TZ",
    ]);
    expect(groups[0]![0]).toEqual({ symbol: "K", word: "Kilo" });
  });

  it("returns nothing for anything that is not a valid code", () => {
    for (const bad of [
      "",
      "K7M-4QX",
      "K7M-4QX-9TB",
      "K7M-4QX-9T0",
      "teammates",
    ])
      expect(spellOut(bad), bad).toEqual([]);
  });
});

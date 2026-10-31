import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_KEPT,
  DISPLAY_NAME_REFUSED,
  checkDisplayName,
  displayNameSkeleton,
  reservedDisplayTerm,
  validateIngestDocuments,
} from "./index.js";

/** A minimal ingest manifest whose product is called `name`. */
function manifest(name: string, slug = "acme"): Record<string, unknown> {
  return {
    product: { product: { slug, name } },
    schema: { schemaVersion: 1, entries: [] },
  };
}

function codes(
  name: string,
  mode?: "warn" | "error",
  slug?: string,
): { errors: string[]; warnings: string[] } {
  const r = validateIngestDocuments(
    manifest(name, slug) as never,
    mode ? { reservedDisplayNames: mode } : {},
  );
  return {
    errors: r.errors.map((e) => e.code),
    warnings: r.warnings.map((e) => e.code),
  };
}

describe("reserved display names (PX-W13 §3)", () => {
  it.each([
    ["Steam", "steam"],
    ["Steam Deck Companion", "steam"],
    ["Google Play Services", "google play"],
    ["Polaris Key", "polaris key"],
    ["PolarisKey Helper", "polaris key"],
    ["polaris-key", "polaris key"],
    ["P0LARIS", "polaris"],
    ["Stearn", "steam"],
    ["\u0405team Store", "steam"], // Cyrillic DZE for S
    ["\u0391pple Arcade", "apple"], // Greek capital alpha
    ["\uff33\uff54\uff45\uff41\uff4d", "steam"], // fullwidth, folded by NFKC
    ["itch.io bundle", "itch io"],
    ["XBOX 360 Pad", "xbox"],
    ["Nintendo™ Helper", "nintendo"],
  ])("%s is reserved (%s)", (name, term) => {
    expect(reservedDisplayTerm(name)).toBe(term);
    expect(checkDisplayName(name)).toBe("reserved");
  });

  it.each(["Applesauce Games", "Pineapple", "Steamroller Racing", "Acme"])(
    "%s is not reserved (whole words only)",
    (name) => {
      expect(checkDisplayName(name)).toBeNull();
    },
  );

  it("refuses a spoofed app name when the platform enforces it", () => {
    expect(codes("Steam Link", "error")).toEqual({
      errors: ["reserved_display_name"],
      warnings: [],
    });
  });

  it("only warns in the default mode", () => {
    expect(codes("Steam Link")).toEqual({
      errors: [],
      warnings: ["reserved_display_name"],
    });
  });

  it("exempts the system product, never from the text rule", () => {
    expect(codes("Polaris Key", "error", "polaris-key")).toEqual({
      errors: [],
      warnings: [],
    });
    expect(checkDisplayName("Polaris Key\u202e", { slug: "polaris-key" })).toBe(
      "invalid",
    );
  });

  it("extra platform terms extend the floor", () => {
    expect(reservedDisplayTerm("Acme Launcher", ["acme"])).toBe("acme");
    expect(reservedDisplayTerm("Steam", ["acme"])).toBe("steam");
  });

  it("the skeleton folds case, width, confusables and separators", () => {
    expect(displayNameSkeleton("  G\u043e\u043egle_PLAY! ")).toEqual([
      "google",
      "play",
    ]);
  });
});

describe("invalid display text (PX-W13 §3)", () => {
  it.each([
    "Living room\u202eexe",
    "Zero\u200bwidth",
    "Isolate\u2066x\u2069",
    " leading",
    "trailing ",
    "trailing\u00a0",
    "BOM\ufeff",
    "C1\u0085",
  ])("%j is invalid", (name) => {
    expect(checkDisplayName(name)).toBe("invalid");
  });

  it("is an error in every mode", () => {
    expect(codes("Acme\u200f", "warn").errors).toEqual([
      "invalid_display_text",
    ]);
  });

  it("allows ordinary non-Latin names", () => {
    expect(checkDisplayName("Gästezimmer · 客厅")).toBeNull();
  });
});

describe("invisible characters (DISPLAY-NAME-INVISIBLE)", () => {
  it.each([
    ["a Hangul filler", "Steam\u3164"],
    ["a name of only a Hangul filler", "\u3164"],
    ["a name of only Braille blank", "\u2800"],
    ["a soft hyphen", "Ac\u00adme"],
    ["a line separator", "Ac\u2028me"],
    ["a paragraph separator", "Ac\u2029me"],
    ["a supplementary-plane format character", "Acme\u{1D173}"],
    ["a language tag", "Acme\u{E0001}"],
    ["a lone surrogate", "Acme\ud800"],
    ["a ZWJ emoji sequence (D-4)", "\u{1F469}\u200D\u{1F4BB} Dev"],
    ["a ZWNJ", "Ac\u200cme"],
    ["a selector first", "\uFE0FAcme"],
    ["a tag first", "\u{E0067}Acme"],
    ["a name of only kept code points", "\uFE0F\uFE0F"],
    ["a Mongolian selector first", "\u180BAcme"],
  ])("%s is invalid", (_what, name) => {
    expect(checkDisplayName(name)).toBe("invalid");
    expect(codes(name, "error").errors).toContain("invalid_display_text");
  });

  it.each([
    "\u{1F3AE}\uFE0F Arcade",
    "1\uFE0F\u20E3 Games",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Games",
    "\u{1F44D}\u{1F3FD} Thumbs",
    "Acme \u{1F3AE}\uFE0F",
  ])("%j is valid", (name) => {
    expect(checkDisplayName(name)).toBeNull();
    expect(codes(name, "error")).toEqual({ errors: [], warnings: [] });
  });

  it("the system product is held to the text rule", () => {
    expect(checkDisplayName("Polaris Key\u3164", { slug: "polaris-key" })).toBe(
      "invalid",
    );
  });

  it("deletes refused and kept code points before comparing (D-5)", () => {
    expect(reservedDisplayTerm("Ste\u{E0061}am")).toBe("steam");
    expect(reservedDisplayTerm("Ste\u00adam")).toBe("steam");
    expect(reservedDisplayTerm("Steam\uFE0F")).toBe("steam");
    expect(reservedDisplayTerm("Ste\u3164am")).toBe("steam");
    expect(reservedDisplayTerm("Polaris\u200bKey")).toBe("polaris key");
    expect(displayNameSkeleton("Ste\u{E0061}am")).toEqual(["steam"]);
    expect(displayNameSkeleton("Google\u3164 Play")).toEqual([
      "google",
      "play",
    ]);
    // An extra platform term is folded the same way.
    expect(reservedDisplayTerm("Ac\u00adme Launcher", ["acme"])).toBe("acme");
    expect(reservedDisplayTerm("Acme Launcher", ["ac\u00adme"])).toBe(
      "ac\u00adme",
    );
  });

  it("reports Ste<tag>am as reserved in error mode", () => {
    // A tag after another character is a legal modifier, so the name is valid text and only reserved.
    expect(codes("Ste\u{E0061}am", "error").errors).toEqual([
      "reserved_display_name",
    ]);
    expect(codes("Steam\uFE0F Link", "error").errors).toEqual([
      "reserved_display_name",
    ]);
  });
});

describe("DISPLAY_NAME_REFUSED / DISPLAY_NAME_KEPT (D-2, D-6)", () => {
  const asSet = (ranges: readonly (readonly [number, number])[]) => {
    const out = new Set<number>();
    for (const [lo, hi] of ranges)
      for (let cp = lo; cp <= hi; cp++) out.add(cp);
    return out;
  };

  it("the ranges are sorted, disjoint and inclusive", () => {
    for (const ranges of [DISPLAY_NAME_REFUSED, DISPLAY_NAME_KEPT]) {
      let prev = -1;
      for (const [lo, hi] of ranges) {
        expect(lo).toBeLessThanOrEqual(hi);
        expect(lo).toBeGreaterThan(prev);
        prev = hi;
      }
    }
    const refused = asSet(DISPLAY_NAME_REFUSED);
    for (const cp of asSet(DISPLAY_NAME_KEPT))
      expect(refused.has(cp)).toBe(false);
  });

  it("keeps the joiners refused (D-4) and the emoji selectors kept", () => {
    const refused = asSet(DISPLAY_NAME_REFUSED);
    const kept = asSet(DISPLAY_NAME_KEPT);
    expect(refused.has(0x200c) && refused.has(0x200d)).toBe(true);
    expect(kept.has(0xfe0f) && kept.has(0xe007f)).toBe(true);
  });

  // The ranges are frozen at Unicode 16.0; Node 22 ships ICU 16.0 or later. On an older ICU the
  // property classes differ, so the comparison is skipped (the frozen ranges are the contract).
  const unicode = Number.parseFloat(process.versions.unicode ?? "0");
  it.skipIf(unicode < 16)(
    "R and K together are exactly Cc, Cf, Cs, Zl, Zp, Default_Ignorable_Code_Point and U+2800",
    () => {
      const refused = asSet(DISPLAY_NAME_REFUSED);
      const kept = asSet(DISPLAY_NAME_KEPT);
      const cls =
        /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
      const diff: string[] = [];
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const inClass =
          (cp >= 0xd800 && cp <= 0xdfff) || cls.test(String.fromCodePoint(cp));
        if (inClass !== (refused.has(cp) || kept.has(cp)))
          diff.push(cp.toString(16));
      }
      expect(diff).toEqual([]);
    },
  );
});

describe("display-name policy options (PX-W13b)", () => {
  const run = (name: string, opts: Record<string, unknown>) => {
    const r = validateIngestDocuments(manifest(name) as never, {
      reservedDisplayNames: "error",
      ...opts,
    });
    return r.errors.map((e) => e.code);
  };

  it("an extra term adds to the floor", () => {
    expect(run("Acme Launcher", {})).toEqual([]);
    expect(run("Acme Launcher", { reservedDisplayTerms: ["acme"] })).toEqual([
      "reserved_display_name",
    ]);
    // The floor stays when extra terms are given.
    expect(run("Steam Link", { reservedDisplayTerms: ["acme"] })).toEqual([
      "reserved_display_name",
    ]);
    expect(checkDisplayName("Acme Launcher", { extraTerms: ["acme"] })).toBe(
      "reserved",
    );
  });

  it("an approval clears reserved for this product, never invalid", () => {
    expect(run("Steam Deck Companion", { displayNameApproved: true })).toEqual(
      [],
    );
    expect(
      run("Acme Launcher", {
        reservedDisplayTerms: ["acme"],
        displayNameApproved: true,
      }),
    ).toEqual([]);
    expect(run("Steam‮", { displayNameApproved: true })).toEqual([
      "invalid_display_text",
    ]);
    expect(checkDisplayName("Steam‮", { approved: true })).toBe("invalid");
  });
});

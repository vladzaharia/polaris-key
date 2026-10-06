import { describe, expect, it } from "vitest";
import {
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

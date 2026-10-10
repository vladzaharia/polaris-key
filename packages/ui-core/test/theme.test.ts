// @pkey-feature ui.theme
//
// Theme and ProductIdentity resolution (UI-KITS.md §1.2, §3.1, §3.3, DL13; plans/HA-11.md):
//   - a fake PresentationSource gives the product's accent (and accentDark in dark) with no
//     integrator input; with no source the bundle names it and its icon gives the accent;
//   - every product accent runs through brand's resolveAccent, so the primary, its label, the
//     accent text and the focus ring keep their contrast in both schemes, on the brand's
//     surfaces and on a host's own (the UK-47 review's pink, navy and yellow included);
//   - the focus ring follows the product accent, never a fixed violet.

import type {
  PresentationSource,
  ProductPresentation,
} from "@polaris-key/client-core/presentation";
import { contrastRatio } from "@polaris-key/brand/color";
import { THEME_TOKENS } from "@polaris-key/brand";
import { describe, expect, it } from "vitest";

import {
  accentFor,
  brandGrounds,
  contrastReport,
  coreAccent,
  resolveKitColors,
  resolveProductIdentity,
  resolveTheme,
  watchProductIdentity,
  type Scheme,
} from "../src/theme/index.js";

/** A fake source built from HA-12's type, as the brief asks. */
function fakeSource(
  initial: ProductPresentation | null,
  iconBytes: Uint8Array | null = null,
): PresentationSource & { push(p: ProductPresentation | null): void } {
  let current = initial;
  const listeners = new Set<(p: ProductPresentation | null) => void>();
  return {
    current: () => current,
    icon: async () => iconBytes,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    push(p) {
      current = p;
      for (const l of listeners) l(p);
    },
  };
}

const DRIFT: ProductPresentation = {
  name: "Drift Kart",
  developerName: "Lanternworks",
  accent: "#ff6a3d",
  accentDark: "#ff8a66",
};

/** RGBA pixels of one colour. */
const pixels = (hex: string, n = 16): number[] => {
  const v = parseInt(hex.slice(1), 16);
  return Array.from({ length: n }, () => [
    (v >> 16) & 255,
    (v >> 8) & 255,
    v & 255,
    255,
  ]).flat();
};

describe("ProductIdentity: integrator, presentation source, bundle, the icon, ink", () => {
  it("takes the product's accent from a fake PresentationSource with no integrator input", () => {
    const id = resolveProductIdentity({ source: fakeSource(DRIFT) });
    expect(id.name).toBe("Drift Kart");
    expect(id.developer).toBe("Lanternworks");
    expect(id.accentSource).toBe("product");
    expect(accentFor(id, "light")).toBe("#ff6a3d");
    // accentDark in the dark scheme.
    expect(accentFor(id, "dark")).toBe("#ff8a66");
    const noDark = resolveProductIdentity({
      source: fakeSource({ name: "Drift Kart", accent: "#ff6a3d" }),
    });
    expect(accentFor(noDark, "dark")).toBe("#ff6a3d");
  });

  it("with no source, falls through to the bundle and then the icon's derived accent", () => {
    const bundle = {
      slug: "tidewater",
      name: "Tidewater Studio",
      iconRgba: pixels("#369186"),
    };
    const id = resolveProductIdentity({ source: null, bundle });
    expect(id.name).toBe("Tidewater Studio");
    expect(id.accentSource).toBe("icon");
    expect(accentFor(id, "dark")).toMatch(/^#[0-9a-f]{6}$/);
    // No icon at all: ink, never violet.
    const ink = resolveProductIdentity({ bundle: { slug: "tidewater" } });
    expect(ink.name).toBe("tidewater");
    expect(ink.accentSource).toBe("ink");
    expect(accentFor(ink, "dark")).toBeNull();
    // A greyscale icon derives nothing: ink.
    expect(
      resolveProductIdentity({
        bundle: { slug: "t", iconRgba: pixels("#777777") },
      }).accentSource,
    ).toBe("ink");
  });

  it("lets the integrator win, and gives violet only when asked", () => {
    const source = fakeSource(DRIFT);
    const mine = resolveProductIdentity({
      source,
      integrator: { name: "Drift", accent: "#2f6fde" },
    });
    expect(mine.name).toBe("Drift");
    expect(mine.accentSource).toBe("integrator");
    expect(accentFor(mine, "dark")).toBe("#2f6fde");
    const core = resolveProductIdentity({ source, accent: "core" });
    expect(core.accentSource).toBe("core");
    expect(accentFor(core, "dark")).toBe(coreAccent("dark"));
    // Under native the host's accent stands, unless the integrator set one.
    expect(
      resolveProductIdentity({ source, preset: "native" }).accentSource,
    ).toBe("host");
  });

  it("reads a broken source as no presentation", () => {
    const broken: PresentationSource = {
      current: () => {
        throw new Error("discovery failed");
      },
      icon: async () => null,
      subscribe: () => () => {},
    };
    expect(
      resolveProductIdentity({
        source: broken,
        bundle: { slug: "tidewater", name: "Tidewater" },
      }).name,
    ).toBe("Tidewater");
  });

  it("resolves again when the source changes and when its icon decodes", async () => {
    const source = fakeSource(
      {
        name: "Tidewater Studio",
        icon: {
          sha256: "a".repeat(64),
          contentType: "image/png",
          original: "https://img.plrs.im/x",
          sizes: [],
        } as never,
      },
      new Uint8Array([1, 2, 3]),
    );
    const seen: string[] = [];
    const stop = watchProductIdentity(
      { source, decodeIcon: async () => pixels("#369186") },
      (id) =>
        seen.push(`${id.name}:${id.accentSource}:${id.accent.dark ?? "-"}`),
    );
    // First synchronously: the icon is known, its accent not decoded yet.
    expect(seen[0]).toBe("Tidewater Studio:icon:-");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toMatch(/^Tidewater Studio:icon:#[0-9a-f]{6}$/);
    source.push(DRIFT);
    expect(seen.at(-1)).toBe("Drift Kart:product:#ff8a66");
    stop();
    source.push({ name: "Gone" });
    expect(seen.at(-1)).not.toContain("Gone");
  });
});

describe("theme resolution (UI-KITS.md §3.1)", () => {
  it("defaults Godot and TV to dark and spacious, and follows the host's scheme otherwise", () => {
    expect(resolveTheme({}, { kit: "godot" })).toMatchObject({
      colorScheme: "dark",
      scheme: "dark",
      density: "spacious",
    });
    expect(
      resolveTheme(
        {},
        { kit: "compose", platform: { os: "android", formFactor: "tv" } },
      ).density,
    ).toBe("spacious");
    expect(resolveTheme({}, { kit: "react", prefersDark: false }).scheme).toBe(
      "light",
    );
    expect(resolveTheme({}, { kit: "react" }).scheme).toBe("dark");
  });

  it("reduced motion turns all motion off, and native drops the ambient", () => {
    expect(resolveTheme({}, { kit: "react", reducedMotion: true }).motion).toBe(
      "reduced",
    );
    expect(resolveTheme({ motion: "none" }, { kit: "react" }).motion).toBe(
      "reduced",
    );
    expect(resolveTheme({}, { kit: "react" }).motion).toBe("full");
    expect(resolveTheme({ preset: "native" }, { kit: "react" }).ambient).toBe(
      false,
    );
  });
});

/** The accents the UK-47 review measured unreadable, and the fixture products. */
const ACCENTS = {
  pink: "#ff4fa3",
  navy: "#1b2a6b",
  yellow: "#ffd400",
  driftKart: "#ff6a3d",
  tidewater: "#369186",
  white: "#ffffff",
  black: "#000000",
};
const SCHEMES: Scheme[] = ["dark", "light"];

describe("Themes: every product accent stays readable (resolveAccent, DL13)", () => {
  for (const [name, hex] of Object.entries(ACCENTS))
    for (const scheme of SCHEMES)
      it(`${name} (${hex}) in ${scheme}, on the brand's surfaces`, () => {
        const colors = resolveKitColors(hex, scheme);
        for (const c of contrastReport(colors))
          expect(c.ratio, c.pair).toBeGreaterThanOrEqual(c.min);
      });

  const HOSTS: Record<Scheme, string[][]> = {
    dark: [
      ["#1e1f22", "#2b2d31", "#313338"],
      ["#3a3d45", "#2f3238"],
    ],
    light: [
      ["#ffffff", "#f3f3f3"],
      ["#fdf6e3", "#eee8d5"],
    ],
  };
  for (const [name, hex] of Object.entries(ACCENTS))
    for (const scheme of SCHEMES)
      for (const grounds of HOSTS[scheme])
        it(`${name} in ${scheme}, native, on a host's ${grounds.join(" ")}`, () => {
          const colors = resolveKitColors(hex, scheme, grounds);
          for (const c of contrastReport(colors))
            expect(c.ratio, c.pair).toBeGreaterThanOrEqual(c.min);
        });

  it("an ink primary (no accent) is readable too, in both schemes", () => {
    for (const scheme of SCHEMES)
      for (const c of contrastReport(resolveKitColors(null, scheme)))
        expect(c.ratio, `${scheme} ${c.pair}`).toBeGreaterThanOrEqual(c.min);
  });

  it("the focus ring follows the product accent, never the brand's violet", () => {
    for (const scheme of SCHEMES) {
      const violet = THEME_TOKENS[scheme].focus;
      for (const hex of Object.values(ACCENTS))
        expect(resolveKitColors(hex, scheme).focus).not.toBe(violet);
      expect(resolveKitColors(null, scheme).focus).not.toBe(violet);
    }
  });

  it("measures the UK-47 review's three failures fixed", () => {
    const pinkDark = resolveKitColors(ACCENTS.pink, "dark");
    expect(
      contrastRatio(pinkDark.onPrimary, pinkDark.primary),
    ).toBeGreaterThanOrEqual(4.5);
    const navyDark = resolveKitColors(ACCENTS.navy, "dark");
    expect(
      contrastRatio(navyDark.onPrimary, navyDark.primary),
    ).toBeGreaterThanOrEqual(4.5);
    for (const g of brandGrounds("dark"))
      expect(contrastRatio(navyDark.primary, g)).toBeGreaterThanOrEqual(3);
    const yellowLight = resolveKitColors(ACCENTS.yellow, "light");
    expect(
      contrastRatio(yellowLight.onPrimary, yellowLight.primary),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

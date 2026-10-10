// The accent resolver (docs/design/UI-KITS.md §3.3): the implementation reproduces the shared
// vectors every port is held to, the spec's table rows are pinned, and the contrast promises hold
// for the vectors and for a sweep around the hue wheel.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACCENT_INK,
  ACCENT_RULES,
  ACCENT_WHITE,
  accentLabel,
  accentSolid,
  accentSurfaces,
  deriveAccent,
  resolveAccent,
} from "../src/accent.js";
import { contrastRatio, hexToOklch, oklchToHex } from "../src/color.js";
import { THEMES } from "../src/tokens/source.js";

const PKG = join(import.meta.dirname, "..");

interface Vectors {
  surfaces: Record<"dark" | "light", string[]>;
  derive: {
    name: string;
    pixels: [number, number, number, number, number][];
    expect: string | null;
  }[];
  resolve: {
    name: string;
    input: string;
    scheme: "dark" | "light";
    expect: ReturnType<typeof resolveAccent>;
  }[];
  danger: { scheme: "dark" | "light"; input: string; expect: string }[];
}

const vectors = JSON.parse(
  readFileSync(join(PKG, "fixtures", "accent-vectors.json"), "utf8"),
) as Vectors;

const expand = (pixels: Vectors["derive"][number]["pixels"]) =>
  pixels.flatMap(([r, g, b, a, n]) =>
    Array.from({ length: n }, () => [r, g, b, a]).flat(),
  );

describe("the shared vectors (fixtures/accent-vectors.json)", () => {
  it("surfaces are the scheme's page, raised, overlay and sunken", () => {
    for (const t of THEMES)
      expect(vectors.surfaces[t]).toEqual([...accentSurfaces(t)]);
  });

  it.each(vectors.derive.map((v) => [v.name, v] as const))(
    "deriveAccent: %s",
    (_, v) => {
      expect(deriveAccent(expand(v.pixels))).toBe(v.expect);
    },
  );

  it.each(vectors.resolve.map((v) => [`${v.name} → ${v.scheme}`, v] as const))(
    "resolveAccent: %s",
    (_, v) => {
      expect(resolveAccent(v.input, v.scheme)).toEqual(v.expect);
    },
  );

  it.each(vectors.danger.map((v) => [v.scheme, v] as const))(
    "the danger solid (%s) keeps a white label",
    (_, v) => {
      expect(accentSolid(v.input, v.scheme, "white")).toBe(v.expect);
      expect(contrastRatio(ACCENT_WHITE, v.expect)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("UI-KITS §3.3's table, pinned", () => {
  const derived = deriveAccent(
    expand(vectors.derive.find((v) => v.name === "tidewater")!.pixels),
  )!;

  it("Tidewater's icon derives a teal with a white label in both schemes", () => {
    expect(derived).toBe("#369186");
    expect(resolveAccent(derived, "dark")).toMatchObject({
      solid: "#26847a",
      on: ACCENT_WHITE,
      fg: "#72cabe",
      subtle: "#0a181e",
    });
    expect(resolveAccent(derived, "light")).toMatchObject({
      solid: "#26847a",
      on: ACCENT_WHITE,
      fg: "#14796f",
      subtle: "#e1ecf2",
    });
  });

  it("the core violet keeps white, and the kit violet is its own light solid", () => {
    expect(resolveAccent("#9a5cff", "dark")).toMatchObject({
      solid: "#9051f3",
      on: ACCENT_WHITE,
      fg: "#c0a6ff",
    });
    expect(resolveAccent("#7a2fff", "light")).toMatchObject({
      solid: "#7a2fff",
      on: ACCENT_WHITE,
      fg: "#7321f6",
      subtle: "#eae4ff",
    });
  });

  it("Drift Kart's light orange keeps its hue and takes an ink label in both schemes", () => {
    expect(resolveAccent("#ff6a3d", "dark")).toMatchObject({
      solid: "#ff6a3d",
      on: ACCENT_INK,
      fg: "#ff987a",
    });
    expect(resolveAccent("#ff6a3d", "light")).toMatchObject({
      solid: "#ec592a",
      on: ACCENT_INK,
      fg: "#b73500",
    });
  });

  it("danger is #db3a2b in dark and #be2323 in light, both with white", () => {
    expect(vectors.danger.map((d) => d.expect)).toEqual(["#db3a2b", "#be2323"]);
  });

  it("`on` is the same colour in both schemes for every vector", () => {
    const byName = new Map<string, Set<string>>();
    for (const v of vectors.resolve) {
      const set = byName.get(v.name) ?? new Set<string>();
      set.add(v.expect.on);
      byName.set(v.name, set);
    }
    for (const [name, ons] of byName)
      expect([name, ons.size]).toEqual([name, 1]);
  });
});

// A sweep: 24 hues × 4 lightnesses × 3 chromas, plus the vectors' inputs.
const sweep = [
  ...vectors.resolve.map((v) => v.input),
  ...Array.from({ length: 24 }, (_, i) => i * 15).flatMap((h) =>
    [0.35, 0.5, 0.65, 0.8].flatMap((l) =>
      [0.05, 0.12, 0.2].map((c) => oklchToHex({ l, c, h })),
    ),
  ),
];

describe("the contrast promises hold across the hue wheel", () => {
  it.each(THEMES)(
    "%s: solid ≥ 3:1, fg ≥ 4.5:1 on every surface; on ≥ 4.5:1 on solid",
    (scheme) => {
      const surfaces = accentSurfaces(scheme);
      const failures: string[] = [];
      for (const hex of sweep) {
        const r = resolveAccent(hex, scheme);
        for (const s of surfaces) {
          if (contrastRatio(r.solid, s) < ACCENT_RULES.ui)
            failures.push(`${hex} solid ${r.solid} on ${s}`);
          if (contrastRatio(r.fg, s) < ACCENT_RULES.text)
            failures.push(`${hex} fg ${r.fg} on ${s}`);
        }
        if (contrastRatio(r.on, r.solid) < ACCENT_RULES.text)
          failures.push(`${hex} on ${r.on} on ${r.solid}`);
        if (r.focus !== (scheme === "dark" ? r.fg : r.solid))
          failures.push(`${hex} focus`);
      }
      expect(failures).toEqual([]);
    },
  );

  it("the label never depends on the scheme, and white wins whenever a small move allows it", () => {
    for (const hex of sweep) {
      const label = accentLabel(hex);
      for (const scheme of THEMES)
        expect(resolveAccent(hex, scheme).on).toBe(
          label === "white" ? ACCENT_WHITE : ACCENT_INK,
        );
    }
    expect(accentLabel("#7a2fff")).toBe("white");
    expect(accentLabel("#ffd400")).toBe("ink");
    expect(accentLabel("#5fe3cf")).toBe("ink");
  });
});

describe("deriveAccent", () => {
  it("ignores translucent pixels and needs 8 % of the opaque area", () => {
    const px = (hex: string, a: number, n: number) => {
      const v = parseInt(hex.slice(1), 16);
      return Array.from({ length: n }, () => [
        (v >> 16) & 255,
        (v >> 8) & 255,
        v & 255,
        a,
      ]).flat();
    };
    expect(deriveAccent([])).toBeNull();
    expect(deriveAccent(px("#ff0000", 127, 10))).toBeNull();
    expect(deriveAccent(px("#ff0000", 128, 10))).not.toBeNull();
    expect(
      deriveAccent([...px("#333333", 255, 93), ...px("#ff0000", 255, 7)]),
    ).toBeNull();
    expect(
      deriveAccent([...px("#333333", 255, 92), ...px("#ff0000", 255, 8)]),
    ).not.toBeNull();
  });

  it("clamps the derived lightness into the accent band", () => {
    const [lo, hi] = ACCENT_RULES.derivedL;
    const light = hexToOklch(deriveAccent([255, 240, 120, 255])!).l;
    const dark = hexToOklch(deriveAccent([40, 10, 120, 255])!).l;
    expect(light).toBeCloseTo(hi, 2);
    expect(dark).toBeCloseTo(lo, 2);
  });
});

describe("resolveAccent on a host's grounds (DL13, the native preset)", () => {
  it("defaults to the brand's surfaces, so the shared vectors hold", () => {
    for (const scheme of THEMES)
      expect(resolveAccent("#369186", scheme, accentSurfaces(scheme))).toEqual(
        resolveAccent("#369186", scheme),
      );
  });

  it.each([
    ["the Compose round's #3a3d45 host", ["#3a3d45", "#2f3238", "#44474f"]],
    ["a chat app's greys", ["#1e1f22", "#2b2d31", "#313338"]],
  ])("keeps a navy accent readable on %s (native dark)", (_name, grounds) => {
    const r = resolveAccent("#1b2a6b", "dark", grounds);
    for (const g of grounds) {
      expect(contrastRatio(r.solid, g)).toBeGreaterThanOrEqual(ACCENT_RULES.ui);
      expect(contrastRatio(r.fg, g)).toBeGreaterThanOrEqual(ACCENT_RULES.text);
      expect(contrastRatio(r.focus, g)).toBeGreaterThanOrEqual(ACCENT_RULES.ui);
    }
    expect(contrastRatio(r.on, r.solid)).toBeGreaterThanOrEqual(
      ACCENT_RULES.text,
    );
  });

  it("keeps a yellow accent readable on a warm light host", () => {
    const grounds = ["#fdf6e3", "#ffffff"];
    const r = resolveAccent("#ffd400", "light", grounds);
    for (const g of grounds) {
      expect(contrastRatio(r.solid, g)).toBeGreaterThanOrEqual(ACCENT_RULES.ui);
      expect(contrastRatio(r.fg, g)).toBeGreaterThanOrEqual(ACCENT_RULES.text);
    }
    expect(contrastRatio(r.on, r.solid)).toBeGreaterThanOrEqual(
      ACCENT_RULES.text,
    );
  });

  it("refuses an empty list of grounds", () => {
    expect(() => resolveAccent("#369186", "dark", [])).toThrow(RangeError);
  });
});

// Generator drift and the generated formats: every output equals what `gen` would write now, the
// CSS carries both themes with the system/attribute mechanics, and the Tailwind v4 theme compiles
// into utilities that read the live tokens.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import { run } from "../scripts/gen.js";
import { SERVICE_ACCENTS, THEME_TOKENS } from "../src/generated/tokens.js";
import { SERVICE_IDS, STATUS_IDS } from "../src/tokens/source.js";

const PKG = join(import.meta.dirname, "..");
const css = readFileSync(join(PKG, "css", "tokens.css"), "utf8");
const themeCss = readFileSync(join(PKG, "css", "theme.css"), "utf8");

describe("generator drift", () => {
  it("every generated output is up to date (pnpm gen:brand -- --check)", async () => {
    expect(await run({ check: true })).toEqual([]);
  }, 60_000);

  it("tokens.json mirrors the TS constants", () => {
    const json = JSON.parse(readFileSync(join(PKG, "tokens.json"), "utf8"));
    expect(json.themes).toEqual(THEME_TOKENS);
    expect(json.services).toEqual(SERVICE_ACCENTS);
  });

  it("the Godot and Swift outputs carry every section's accent", () => {
    const gd = readFileSync(
      join(
        PKG,
        "../../sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd",
      ),
      "utf8",
    );
    const swift = readFileSync(
      join(
        PKG,
        "../../sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift",
      ),
      "utf8",
    );
    for (const id of SERVICE_IDS) {
      expect(gd).toContain(`"${id}": Color(`);
      expect(swift).toContain(`"${id}": BrandAccent(`);
      expect(swift).toContain(
        `solid: BrandColor(hex: 0x${SERVICE_ACCENTS.dark[id].solid.slice(1)})`,
      );
    }
    // Core draws no bit: no core entry in the Godot bit tables, and a nil bit in Swift.
    expect(gd).toContain(
      "static func has_section_bit(service: String) -> bool:",
    );
    expect(gd).not.toContain("SERVICE_CORE_BIT");
    expect(gd).not.toMatch(/_BIT_(DARK|LIGHT) := \{[^}]*"core"/);
    expect(swift).toMatch(/"core": BrandAccent\([^\n]*, bit: nil\)/);
    expect(swift).toContain("public let bit: BrandColor?");
    expect(gd).toContain("class_name PKeyBrand");
    expect(gd.startsWith("# GENERATED FILE")).toBe(true);
    expect(swift.startsWith("// GENERATED FILE")).toBe(true);
  });

  it("the Godot addon's brand folder is the kit's files, bit-less and never imported", () => {
    const dir = join(PKG, "../../sdks/godot/addons/polaris_key/brand");
    expect(readFileSync(join(dir, ".gdignore"), "utf8")).toContain("GENERATED");
    const copies: [string, string][] = [
      ["polaris_key-dark.svg", "06-games/key/dark/key-16.svg"],
      ["powered-by-credit-light.svg", "06-games/powered-by-credit-light.svg"],
    ];
    for (const [name, kit] of copies) {
      const svg = readFileSync(join(dir, name), "utf8");
      expect(svg.startsWith("<!--\n  GENERATED FILE")).toBe(true);
      const original = readFileSync(join(PKG, "kit", kit), "utf8").trimEnd();
      expect(svg.trimEnd().endsWith(original)).toBe(true);
    }
    // The default Pinned K has no terminal bit (BRAND.md owner decisions, 2026-10-03).
    for (const name of ["polaris_key-dark.svg", "polaris_key-light.svg"]) {
      const svg = readFileSync(join(dir, name), "utf8").toLowerCase();
      expect(svg).not.toContain("#ffc24d");
      expect(svg).not.toContain("#d07a00");
    }
  });
});

describe("tokens.css", () => {
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    expect(i, selector).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };

  it("is dark first: :root and [data-theme=dark] carry the dark palette", () => {
    const dark = block(':root,\n[data-theme="dark"]');
    expect(dark).toContain("color-scheme: dark;");
    expect(dark).toContain(
      `--pk-surface-page: ${THEME_TOKENS.dark.surface.page};`,
    );
  });

  it("follows the system to light unless data-theme=dark pins dark", () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{\s*color-scheme: light;/,
    );
  });

  it("data-theme=light forces light parity", () => {
    const light = block('[data-theme="light"]');
    for (const [k, v] of Object.entries(THEME_TOKENS.light.surface))
      expect(light).toContain(`--pk-surface-${k}: ${v};`);
    for (const s of STATUS_IDS)
      expect(light).toContain(`--pk-${s}: ${THEME_TOKENS.light.status[s].fg};`);
  });

  it("re-points the accent and section bit per data-service", () => {
    for (const id of SERVICE_IDS.filter((s) => s !== "core")) {
      const b = block(`[data-service="${id}"]`);
      expect(b).toContain(`--pk-accent: var(--pk-service-${id});`);
      expect(b).toContain(`--pk-section-bit: var(--pk-service-${id}-bit);`);
      expect(b).toContain(`--pk-section-bit-display: inline;`);
    }
  });

  it("core defines no section bit: no gold, and the live bit is not displayed", () => {
    expect(css).not.toContain("--pk-service-core-bit");
    const core = block(`:root,\n[data-theme],\n[data-service="core"]`);
    expect(core).toContain("--pk-section-bit: none;");
    expect(core).toContain("--pk-section-bit-display: none;");
    expect(css).toMatch(
      /\.polaris-live-bit \{\s*fill: var\(--pk-section-bit\);\s*display: var\(--pk-section-bit-display\);/,
    );
    for (const theme of ["dark", "light"] as const)
      expect(SERVICE_ACCENTS[theme].core.bit).toBeNull();
  });

  it("collapses motion under prefers-reduced-motion and never animates more than the bit", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--pk-duration-instant: 0ms;\s*--pk-duration-fast: 0ms;\s*--pk-duration-base: 0ms;\s*--pk-duration-slow: 0ms;/,
    );
    expect(css).toMatch(/\.polaris-section-bit \{\s*transition: fill/);
    expect(css).not.toMatch(/animation|@keyframes|rotate/);
  });

  it("forbids synthetic weights", () => {
    expect(css).toContain("font-synthesis: none;");
  });
});

describe("theme.css (Tailwind v4)", () => {
  const require = createRequire(import.meta.url);
  const twDir = join(require.resolve("tailwindcss/package.json"), "..");

  async function build(candidates: string[]): Promise<string> {
    const compiler = await compile(
      `@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n${themeCss}`,
      {
        base: PKG,
        loadStylesheet: async (id: string, base: string) => {
          const path = id.startsWith("tailwindcss/")
            ? join(twDir, id.slice("tailwindcss/".length))
            : join(base, id);
          return {
            path,
            base: join(path, ".."),
            content: readFileSync(path, "utf8"),
          };
        },
      },
    );
    return compiler.build(candidates);
  }

  it("compiles and its utilities read the live --pk-* variables", async () => {
    const out = await build([
      "bg-surface-raised",
      "text-fg-muted",
      "border-border-strong",
      "bg-accent",
      "text-service-config-fg",
      "bg-signed",
      "text-signed-on",
      "ring-focus",
      "font-sans",
      "rounded-xl",
      "shadow-elevation-2",
      "text-sm",
    ]);
    expect(out).toContain("background-color: var(--pk-surface-raised)");
    expect(out).toContain("color: var(--pk-text-muted)");
    expect(out).toContain("background-color: var(--pk-accent)");
    expect(out).toContain("color: var(--pk-service-config-fg)");
    expect(out).toContain("background-color: var(--pk-signed)");
    expect(out).toContain("var(--pk-focus)");
    expect(out).toContain("var(--pk-font-sans)");
    expect(out).toContain("var(--pk-radius-xl)");
    expect(out).toContain("var(--pk-font-size-sm)");
  });

  it("dark: and light: variants follow data-theme and the system", async () => {
    const out = await build(["dark:bg-surface-page", "light:text-fg"]);
    expect(out).toContain('[data-theme="dark"]');
    expect(out).toContain("prefers-color-scheme: light");
  });

  it("maps only variables tokens.css defines", () => {
    const defined = new Set(
      [...css.matchAll(/--pk-([a-z0-9_-]+):/g)].map((m) => m[1]),
    );
    for (const [, name] of themeCss.matchAll(/var\(--pk-([a-z0-9_-]+)\)/g))
      expect(defined.has(name), name).toBe(true);
  });
});

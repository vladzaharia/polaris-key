// Generator drift and the generated formats: every output equals what `gen` would write now, the
// CSS carries both themes with the system/attribute mechanics, and the Tailwind v4 theme compiles
// into utilities that read the live tokens.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import { run, svgTree } from "../scripts/gen.js";
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

  it("the Kotlin (Compose) output carries every accent, the bit-less marks and the kit fonts", () => {
    const kt = readFileSync(
      join(
        PKG,
        "../../sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/brand/PolarisBrandTokens.generated.kt",
      ),
      "utf8",
    );
    expect(kt.startsWith("// GENERATED FILE")).toBe(true);
    for (const id of SERVICE_IDS) {
      expect(kt).toContain(
        `"${id}" to BrandAccent(solid = Color(0xFF${SERVICE_ACCENTS.dark[id].solid.slice(1).toUpperCase()})`,
      );
    }
    expect(kt).toMatch(/"core" to BrandAccent\([^\n]*, bit = null\)/);
    expect(kt).toContain("public val pinnedKDark: BrandVector");
    expect(kt).toContain("public val poweredByCompactLight: BrandVector");
    // The display-cut Pinned K without the terminal bit: no gold in the mark.
    const pinned = kt.slice(
      kt.indexOf("public val pinnedKDark"),
      kt.indexOf("public val pinnedKLight"),
    );
    expect(pinned).not.toContain("FFC24D");
    const ui = join(PKG, "../../sdks/kotlin/ui/src/main");
    for (const [copy, kit] of [
      ["res/font/polaris_rubik_regular.ttf", "Rubik-Regular.ttf"],
      ["res/font/polaris_rubik_bold.ttf", "Rubik-Bold.ttf"],
    ] as const) {
      expect(
        readFileSync(join(ui, copy)).equals(
          readFileSync(join(PKG, "kit/source/fonts", kit)),
        ),
      ).toBe(true);
    }
    expect(
      readFileSync(join(ui, "assets/polaris-key/fonts/OFL.txt"), "utf8"),
    ).toContain("SIL OPEN FONT LICENSE");
  });

  it("svgTree reduces a kit SVG to groups and filled paths, and refuses anything else", () => {
    const tree = svgTree(
      '<svg width="10" height="10" viewBox="0 0 10 10"><title>t</title><g fill="#fff" transform="translate(1 2) scale(0.5 -0.5)"><path d="M0 0Z"/><path transform="translate(3 0)" d="M1 1Z"/></g></svg>',
    );
    expect(tree).toEqual({
      width: 10,
      height: 10,
      nodes: [
        {
          kind: "group",
          tx: 1,
          ty: 2,
          sx: 0.5,
          sy: -0.5,
          fill: "#fff",
          children: [
            { kind: "path", fill: null, d: "M0 0Z" },
            {
              kind: "group",
              tx: 3,
              ty: 0,
              sx: 1,
              sy: 1,
              fill: null,
              children: [{ kind: "path", fill: null, d: "M1 1Z" }],
            },
          ],
        },
      ],
    });
    expect(() =>
      svgTree(
        '<svg width="1" height="1" viewBox="0 0 1 1"><circle r="1"/></svg>',
      ),
    ).toThrow(/unsupported SVG element/);
    expect(() =>
      svgTree(
        '<svg width="1" height="1" viewBox="0 0 1 1"><g transform="rotate(45)"></g></svg>',
      ),
    ).toThrow(/unsupported SVG transform/);
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

  it("the Godot UI kit's Rubik is the kit's TTFs, unchanged, with the OFL beside them", () => {
    const dir = join(PKG, "../../sdks/godot/addons/polaris_key/ui/theme/fonts");
    const kit = join(PKG, "kit", "source", "fonts");
    const fonts: [string, string][] = [
      ["rubik_regular.tres", "Rubik-Regular.ttf"],
      ["rubik_bold.tres", "Rubik-Bold.ttf"],
    ];
    for (const [name, ttf] of fonts) {
      const tres = readFileSync(join(dir, name), "utf8");
      expect(tres.startsWith('[gd_resource type="FontFile" format=4]\n')).toBe(
        true,
      );
      expect(tres).toContain("; GENERATED FILE");
      const b64 = /data = PackedByteArray\("([A-Za-z0-9+/=]+)"\)/.exec(tres);
      expect(b64, name).not.toBeNull();
      expect(
        Buffer.from(b64![1]!, "base64").equals(readFileSync(join(kit, ttf))),
      ).toBe(true);
    }
    for (const f of ["OFL.txt", "FONT-NOTICE.txt"])
      expect(readFileSync(join(dir, f), "utf8")).toBe(
        readFileSync(join(kit, f), "utf8"),
      );
  });

  it("the Godot UI kit's marks are the kit SVGs, verbatim, and the Pinned K has no bit", () => {
    const gd = readFileSync(
      join(
        PKG,
        "../../sdks/godot/addons/polaris_key/ui/theme/brand_marks_generated.gd",
      ),
      "utf8",
    );
    expect(gd.startsWith("# GENERATED FILE")).toBe(true);
    expect(gd).toContain("class_name PKeyBrandMarks");
    const marks: [string, string][] = [
      ["PINNED_K_DARK", "01-marks/key/svg/key-display-dark.svg"],
      ["PINNED_K_LIGHT", "01-marks/key/svg/key-display-light.svg"],
      [
        "POWERED_BY_COMPACT_DARK",
        "03-powered-by/transparent/powered-by-compact-dark.svg",
      ],
    ];
    for (const [name, kitPath] of marks) {
      const m = new RegExp(`const ${name} := (".*")$`, "m").exec(gd);
      expect(m, name).not.toBeNull();
      expect(JSON.parse(m![1]!)).toBe(
        readFileSync(join(PKG, "kit", kitPath), "utf8").trim(),
      );
    }
    for (const line of gd.match(/const PINNED_K_(DARK|LIGHT) := .*/g) ?? []) {
      expect(line.toLowerCase()).not.toContain("#ffc24d");
      expect(line.toLowerCase()).not.toContain("#d07a00");
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

// The UI-kit tokens (docs/design/UI-KITS.md §2.1): the spec's component table and type scale,
// the weight rule, the concentric rule, the generated kit.css and kit.ts, and the drift gate
// catching a hand edit to any generated output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { outputPaths, run } from "../scripts/gen.js";
import { ACCENT_WHITE } from "../src/accent.js";
import { contrastRatio } from "../src/color.js";
import { KIT_TOKENS } from "../src/generated/kit.js";
import {
  CAPSULE,
  KIT_COMPONENTS,
  KIT_PLATFORMS,
  KIT_TYPE_ROLES,
  KIT_TYPE_SCALE,
  concentricRadius,
} from "../src/tokens/kit.js";
import { FONT, FONT_WEIGHT } from "../src/tokens/scales.js";

const PKG = join(import.meta.dirname, "..");
const ROOT = join(PKG, "..", "..");
const kitCss = readFileSync(join(PKG, "css", "kit.css"), "utf8");

describe("component tokens equal UI-KITS §2.1", () => {
  it("control heights", () => {
    expect(KIT_COMPONENTS.web.controlHeight).toEqual({
      default: 44,
      coarse: 48,
      compact: 36,
    });
    expect(KIT_COMPONENTS.ios.controlHeight.default).toBe(52);
    expect(KIT_COMPONENTS.macos.controlHeight).toEqual({
      default: 28,
      hero: 36,
    });
    expect(KIT_COMPONENTS.android.controlHeight.default).toBe(56);
    expect(KIT_COMPONENTS.windows.controlHeight.default).toBe(32);
    expect(KIT_COMPONENTS.gnome.controlHeight.default).toBe(34);
    expect(KIT_COMPONENTS.godot.controlHeight.default).toBe(60);
  });

  it("radii", () => {
    expect(KIT_COMPONENTS.web.radiusControl).toEqual({
      default: 12,
      compact: 10,
    });
    for (const p of ["ios", "macos", "android"] as const)
      expect(KIT_COMPONENTS[p].radiusControl.default).toBe(CAPSULE);
    expect(KIT_COMPONENTS.windows.radiusControl.default).toBe(4);
    expect(KIT_COMPONENTS.gnome.radiusControl.default).toBe(8);
    expect(KIT_COMPONENTS.godot.radiusControl.default).toBe(16);
    expect(KIT_COMPONENTS.web.radiusSurface).toEqual({ card: 22, group: 16 });
    expect(KIT_COMPONENTS.ios.radiusSurface).toEqual({
      sheet: 40,
      floating: 40,
      floatingLarge: 48,
    });
    expect(KIT_COMPONENTS.android.radiusSurface).toEqual({
      sheet: 28,
      listOuter: 24,
      listInner: 6,
    });
    expect(KIT_COMPONENTS.godot.radiusSurface).toEqual({ panel: 28 });
  });

  it("card padding, focus and scrims", () => {
    expect(KIT_COMPONENTS.web.cardPad).toEqual({ default: 32, fullBleed: 20 });
    expect(KIT_COMPONENTS.godot.cardPad.default).toBe(44);
    expect(KIT_COMPONENTS.web.focus).toEqual({ width: 2, offset: 2 });
    expect(KIT_COMPONENTS.ios.focus).toBe("system");
    expect(KIT_COMPONENTS.gnome.focus).toEqual({ width: 2, offset: -2 });
    expect(KIT_COMPONENTS.godot.focus).toMatchObject({ width: 3, offset: 2 });
    expect(KIT_COMPONENTS.macos.scrim).toBeNull();
    expect(KIT_COMPONENTS.web.scrim).toEqual({
      light: { opacity: 0.14, blur: 12 },
      dark: { opacity: 0.5, blur: 16 },
    });
    expect(KIT_COMPONENTS.android.scrim?.dark.opacity).toBe(0.6);
  });

  it("every platform has every component token", () => {
    for (const p of KIT_PLATFORMS) {
      const c = KIT_COMPONENTS[p];
      expect(c.controlHeight.default, p).toBeGreaterThan(0);
      expect(Object.keys(c.radiusSurface).length, p).toBeGreaterThan(0);
    }
  });
});

describe("type scale", () => {
  it("uses 400, 500 and 600 only (UI-KITS §1.5 rule 6)", () => {
    for (const scale of Object.values(KIT_TYPE_SCALE))
      for (const r of KIT_TYPE_ROLES)
        expect([400, 500, 600]).toContain(scale[r].weight);
  });

  it("matches the spec's rows", () => {
    expect(KIT_TYPE_SCALE.ios.display).toMatchObject({
      size: 34,
      lineHeight: 40,
      weight: 600,
    });
    expect(KIT_TYPE_SCALE.macos.body).toMatchObject({
      size: 13,
      lineHeight: 16,
      weight: 400,
    });
    expect(KIT_TYPE_SCALE.android.code).toMatchObject({
      size: 32,
      lineHeight: 40,
      weight: 500,
      tracking: 0.06,
      family: "mono",
    });
    expect(KIT_TYPE_SCALE.godot.code).toMatchObject({
      size: 52,
      weight: 600,
      family: "mono",
    });
    expect(KIT_TYPE_SCALE.web.display.size).toBe(
      "clamp(1.75rem, 1.1rem + 2.6cqi, 2.25rem)",
    );
  });

  it("the brand weights carry medium and semibold, and the mono is JetBrains Mono", () => {
    expect(FONT_WEIGHT).toEqual({
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    });
    expect(FONT.sans.startsWith('"Rubik", "Rubik Fallback"')).toBe(true);
    expect(
      FONT.mono.startsWith('"JetBrains Mono", "JetBrains Mono Fallback"'),
    ).toBe(true);
  });
});

describe("rules", () => {
  it("concentric: inner = outer − inset, never below 8", () => {
    expect(concentricRadius(22, 6)).toBe(16);
    expect(concentricRadius(12, 6)).toBe(8);
    expect(concentricRadius(10, 6)).toBe(8);
  });

  it("the danger solid keeps a white label at 4.5:1 in both schemes", () => {
    for (const t of ["dark", "light"] as const) {
      expect(KIT_TOKENS.danger[t].on).toBe(ACCENT_WHITE);
      expect(
        contrastRatio(KIT_TOKENS.danger[t].solid, ACCENT_WHITE),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("css/kit.css", () => {
  it("declares the web defaults and every platform variant", () => {
    expect(kitCss).toContain("--pk-kit-control-height: 44px;");
    expect(kitCss).toContain("--pk-kit-radius-card: 22px;");
    expect(kitCss).toContain(
      `--pk-kit-danger-solid: ${KIT_TOKENS.danger.dark.solid};`,
    );
    expect(kitCss).toContain(
      `--pk-kit-danger-solid: ${KIT_TOKENS.danger.light.solid};`,
    );
    for (const p of KIT_PLATFORMS.filter((x) => x !== "web"))
      expect(kitCss).toContain(`[data-pk-platform="${p}"] {`);
    expect(kitCss).toMatch(
      /\[data-pk-platform="ios"\] \{[^}]*--pk-kit-radius-control: 9999px;/,
    );
  });

  it("is zero-specificity and never forces :root", () => {
    expect(kitCss).toContain(":where(:root, :host, [data-pk-kit]) {");
    expect(kitCss).not.toMatch(/^:root \{/m);
  });
});

describe("the drift gate covers every kit output", () => {
  const kitOutputs = [
    "packages/brand/css/kit.css",
    "packages/brand/src/generated/kit.ts",
    "packages/brand/fixtures/accent-vectors.json",
    "sdks/swift/Sources/PolarisKeyUI/KitTokens.generated.swift",
    "sdks/swift/Tests/PolarisKeyTests/AccentVectors.generated.swift",
    "sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/brand/PolarisKitTokens.generated.kt",
    "sdks/kotlin/ui/src/test/kotlin/im/plrs/key/ui/brand/AccentVectors.generated.kt",
    "sdks/kotlin/ui/src/main/res/font/polaris_rubik_variable.ttf",
    "sdks/kotlin/ui/src/main/res/font/polaris_jetbrains_mono_variable.ttf",
    "sdks/godot/addons/polaris_key/ui/theme/kit_tokens_generated.gd",
    "sdks/godot/addons/polaris_key/ui/theme/kit_icons_generated.gd",
    "sdks/godot/addons/polaris_key/ui/theme/fonts/rubik_variable.tres",
    "sdks/godot/addons/polaris_key/ui/theme/fonts/jetbrains_mono_variable.tres",
    "sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs",
    "sdks/godot/tests/brand/accent-vectors.json",
    "sdks/python/src/polaris_key/ui/_tokens.py",
    "sdks/python/src/polaris_key/ui/ansi.py",
    "sdks/python/src/polaris_key/ui/qt/Theme.qml",
    "sdks/python/src/polaris_key/ui/qt/polaris_key_dark.qss",
    "sdks/python/src/polaris_key/ui/qt/polaris_key_light.qss",
    "sdks/python/src/polaris_key/ui/fonts/Rubik-Variable.ttf",
    "sdks/python/src/polaris_key/ui/fonts/JetBrainsMono-Variable.ttf",
    "sdks/python/tests/fixtures/accent-vectors.json",
    "packages/sdk-node/src/cli/tokens.generated.ts",
  ];

  it("lists them all", () => {
    const owned = new Set(outputPaths());
    expect(kitOutputs.filter((p) => !owned.has(p))).toEqual([]);
  });

  it.each(kitOutputs)(
    "a hand edit to %s fails --check",
    async (path) => {
      const target = join(ROOT, path);
      const stale = await run({
        check: true,
        read: (abs) => {
          const bytes = readFileSync(abs);
          return abs === target
            ? Buffer.concat([bytes, Buffer.from(" ")])
            : bytes;
        },
      });
      expect(stale).toEqual([path]);
    },
    60_000,
  );

  it("every text output carries the GENERATED banner", () => {
    for (const path of kitOutputs) {
      if (/\.(ttf|json)$/.test(path)) continue;
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text.slice(0, 400), path).toMatch(/GENERATED/);
    }
  });
});

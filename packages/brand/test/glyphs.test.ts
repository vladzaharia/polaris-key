// The new-window glyph (UI-KITS.md §1.5 rule 11, DL6): one source, written into every kit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  KIT_GLYPH_GRID,
  KIT_GLYPH_STROKE,
  KIT_GLYPHS,
} from "../src/tokens/glyphs.js";
import { TERMINAL_SYMBOLS } from "../src/tokens/terminal.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the new-window glyph", () => {
  const g = KIT_GLYPHS.newWindow;

  it("sits on the 24 grid with the 2 px stroke the icon set uses", () => {
    expect(KIT_GLYPH_GRID).toBe(24);
    expect(KIT_GLYPH_STROKE).toBe(2);
    for (const d of g.paths) {
      // Path data on the grid: it starts with a move and holds only path commands and numbers.
      expect(d).toMatch(/^M[\d.\s,MmHhVvAaLlCcSsZz-]+$/);
    }
  });

  it("is described by the catalog's a11y line, which exists in the kit copy", () => {
    expect(g.copyKey).toBe("a11y.externalLink");
    expect(read("sdks/godot/addons/polaris_key/ui/locale/en.po")).toContain(
      `msgid "${g.copyKey}"`,
    );
  });

  it("is written into the Godot icon set, the Swift, Compose and Python tokens and the Qt theme", () => {
    expect(
      read("sdks/godot/addons/polaris_key/ui/theme/kit_icons_generated.gd"),
    ).toContain('"new_window"');
    expect(
      read("sdks/swift/Sources/PolarisKeyUI/KitTokens.generated.swift"),
    ).toContain(`newWindow = "${g.sfSymbol}"`);
    const kt = read(
      "sdks/kotlin/ui/src/commonMain/kotlin/im/plrs/key/ui/brand/PolarisKitGlyphs.generated.kt",
    );
    const py = read("sdks/python/src/polaris_key/ui/_tokens.py");
    const qml = read("sdks/python/src/polaris_key/ui/qt/Theme.qml");
    for (const d of g.paths) {
      expect(kt).toContain(d);
      expect(py).toContain(d);
      expect(qml).toContain(d);
      expect(
        read("sdks/godot/addons/polaris_key/ui/theme/kit_icons_generated.gd"),
      ).toContain(d);
    }
  });

  it("keeps the terminal's text glyph with an ASCII fallback", () => {
    expect(TERMINAL_SYMBOLS.unicode.newWindow).toBe("↗");
    expect(TERMINAL_SYMBOLS.ascii.newWindow).toMatch(/^[\x20-\x7e]+$/);
  });
});

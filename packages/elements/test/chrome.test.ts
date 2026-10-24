// @pkey-feature ui.kit
//
// The desktop chrome tokens (UK-06.6): the stylesheet's `[data-pk-platform=…]` blocks are written
// from brand's KIT_TOKENS and must say what brand's css/kit.css says for the same variant (the
// lengths there are px, here rem). The variant id is ui-core's `platformVariant`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformVariant } from "@polaris-key/ui-core/theme";
import { DESKTOP_VARIANTS, platformVars } from "../src/desktopTokens.js";
import { tokenCss } from "../src/tokens.js";

const brandCss = readFileSync(
  join(import.meta.dirname, "..", "..", "brand", "css", "kit.css"),
  "utf8",
);

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!]),
  );
}

/** rem → px, so both sheets compare in brand's unit. */
const px = (v: string) =>
  /^-?[\d.]+rem$/.test(v) ? `${+(Number.parseFloat(v) * 16).toFixed(3)}px` : v;
const norm = (v: string) => (v === "0px" ? "0" : px(v));

describe("the desktop chrome token blocks", () => {
  it.each(DESKTOP_VARIANTS)("%s equals brand's kit.css block", (p) => {
    const brand = block(brandCss, `[data-pk-platform="${p}"]`);
    const mine = platformVars(p);
    for (const [k, v] of Object.entries(brand)) {
      if (k === "--pk-kit-scrim" || k === "--pk-kit-scrim-blur") continue;
      expect(norm(mine[k] ?? "(missing)"), `${p} ${k}`).toBe(norm(v));
    }
  });

  it("is emitted once per variant, with a scrim per scheme", () => {
    const css = tokenCss();
    for (const p of DESKTOP_VARIANTS) {
      expect(css).toContain(`[data-pk-platform="${p}"] {`);
      expect(css).toContain(`[data-theme="light"][data-pk-platform="${p}"] {`);
      expect(css).toContain(`[data-theme="dark"][data-pk-platform="${p}"] {`);
    }
  });

  it("takes 44 px targets under a coarse pointer and keeps fine-pointer controls at 24 px or more", () => {
    for (const p of DESKTOP_VARIANTS) {
      const v = platformVars(p);
      expect(px(v["--pk-kit-control-height-coarse"]!)).toBe("44px");
      expect(
        Number.parseFloat(px(v["--pk-kit-control-height"]!)),
      ).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("platformVariant", () => {
  it("names linux gnome, keeps the others, and falls back to web", () => {
    expect(platformVariant({ platform: "linux" })).toBe("gnome");
    expect(platformVariant({ platform: "gnome" })).toBe("gnome");
    expect(platformVariant({ platform: "windows" })).toBe("windows");
    expect(platformVariant({ platform: "macos" })).toBe("macos");
    expect(platformVariant({ platform: "ios" })).toBe("ios");
    expect(platformVariant({ platform: null })).toBe("web");
    expect(platformVariant({ platform: "web" })).toBe("web");
    expect(platformVariant({ platform: "haiku" })).toBe("web");
    expect(platformVariant(undefined)).toBe("web");
  });
});

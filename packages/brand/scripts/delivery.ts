// The "Polaris Key Delivery" lockups (owner decision, 2026-10-03; docs/design/BRAND.md §1.1).
//
// The kit ships the Star Cut as "Polaris Key Update". Our surfaces name it "Polaris Key
// Delivery", the service mark for the whole delivery family (the bytes host, Distribution,
// Update), so this module builds Delivery lockups the way the kit built its own:
//
//   - the Star Cut glyph group is copied from the kit's Update template, byte for byte;
//   - the wordmark is Rubik Bold (kit/source/fonts/Rubik-Bold.ttf) outlined by ./wordmark.ts,
//     at the kit's scale, baseline and pen (no tracking), the same distance from the glyph;
//   - the canvas follows the kit's rules for each layout (derived below), so clear space and
//     the glyph's place are the kit's.
//
// `relayout` is proven before it is trusted: re-setting the kit's own text ("Polaris Key",
// "Polaris Key Update") in the kit's own templates must reproduce those templates exactly, for
// every layout, or the generator stops. Only then is "Polaris Key Delivery" set.

import { join } from "node:path";

import type { Template } from "./kit.js";
import { glyphPaths, loadFont, setLine, type Font } from "./wordmark.js";

export const DELIVERY_TITLE = "Polaris Key Delivery";

type Layout = "horizontal" | "stacked" | "compact";

/** Python's str() for a float (the kit's generator wrote `222.0`, `1.0`). */
const pyFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

/**
 * Each layout's canvas rule, measured from the kit's files (text advance `a` in px at the
 * layout's type scale):
 *
 *   horizontal  glyph 96 px at (16, 32); text at x 140, baseline 96, scale 0.052;
 *               width = round(140 + a + 40)
 *   compact     glyph 32 px at (12, 16); text at x 58, baseline 42, scale 0.026;
 *               width = round(58 + a + 18)
 *   stacked     glyph 136 px centred at y 30; text centred, baseline 238, scale 0.044;
 *               width = max(440, ceil((a + 160) / 20) * 20)
 */
function canvasWidth(layout: Layout, textX: number, advancePx: number) {
  if (layout === "horizontal") return Math.round(textX + advancePx + 40);
  if (layout === "compact") return Math.round(textX + advancePx + 18);
  return Math.max(440, Math.ceil((advancePx + 160) / 20) * 20);
}

const TEXT_GROUP =
  /<g fill="\{text\}" transform="translate\(([\d.]+) (\d+)\) scale\(([\d.]+) -[\d.]+\)">((?:<path transform="translate\(\d+ 0\)" d="[^"]*"\/>)+)<\/g>/;
const GLYPH_GROUP =
  /^<g transform="translate\(([\d.]+) (\d+)\) scale\(([\d.]+)\)">/;

/** Re-set a kit lockup template's wordmark to `text`, by the kit's own rules. */
export function relayout(
  font: Font,
  template: Template,
  layout: Layout,
  text: string,
): Template {
  const tm = TEXT_GROUP.exec(template.body);
  const gm = GLYPH_GROUP.exec(template.body);
  if (!tm || !gm) throw new Error(`delivery: unexpected ${layout} template`);
  const [, kitX, baseline, scaleText] = tm;
  const scale = Number(scaleText);
  const { glyphs, advance } = setLine(font, text);
  const advancePx = advance * scale;
  let textX = Number(kitX);
  const width = canvasWidth(layout, textX, advancePx);
  let body = template.body;
  if (layout === "stacked") {
    textX = (width - advancePx) / 2;
    const glyphPx = 96 * Number(gm[3]);
    body = body.replace(
      GLYPH_GROUP,
      `<g transform="translate(${pyFloat((width - glyphPx) / 2)} ${gm[2]}) scale(${gm[3]})">`,
    );
  }
  body = body.replace(
    TEXT_GROUP,
    `<g fill="{text}" transform="translate(${textX.toFixed(4)} ${baseline}) scale(${scaleText} -${scaleText})">${glyphPaths(glyphs)}</g>`,
  );
  return { width, height: template.height, title: text, desc: "", body };
}

/**
 * Build the Delivery lockups from the kit's Update templates, after proving `relayout` on every
 * kit lockup. Throws (the generator exits non-zero) if the proof fails.
 */
export function deliveryLockups(
  kitDir: string,
  lockups: Record<"key" | "update", Record<string, Template>>,
): Record<Layout, Template> {
  const font = loadFont(join(kitDir, "source/fonts/Rubik-Bold.ttf"));
  const out = {} as Record<Layout, Template>;
  for (const layout of ["horizontal", "stacked", "compact"] as const) {
    for (const kind of ["key", "update"] as const) {
      const kit = lockups[kind][layout]!;
      const again = relayout(font, kit, layout, kit.title);
      if (JSON.stringify(again) !== JSON.stringify(kit))
        throw new Error(
          `delivery: re-setting "${kit.title}" does not reproduce the kit's ${kind} ${layout} lockup`,
        );
    }
    out[layout] = relayout(
      font,
      lockups.update[layout]!,
      layout,
      DELIVERY_TITLE,
    );
  }
  return out;
}

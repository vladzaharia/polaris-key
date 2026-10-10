// The "Polaris Key Delivery" marks, web files and social set, and the 1080 x 1350 portrait cards.
//
// The kit ships the Star Cut as "Polaris Key Update" (its marks, web manifest and social cards
// carry that name, and the cards' wordmark is outlined into the artwork). Our public surfaces
// name it "Polaris Key Delivery" (docs/design/BRAND.md §1.1), so this module derives the Delivery
// files from the kit's Update files the way scripts/delivery.ts derived the lockups:
//
//   - marks/delivery/   the kit's Update mark files, glyph paths byte for byte, with the title and
//                       aria-label renamed (the desc and every fill are untouched);
//   - web/delivery/     the kit's Update site.webmanifest and head-snippet.html renamed; the icon
//                       bytes are the kit's (copied by scripts/gen.ts);
//   - social/delivery/  the kit's Update social compositions with the wordmark re-set to
//                       "Polaris Key Delivery" in Rubik Bold, centred on the canvas as the kit
//                       centres its own;
//   - social/{key,delivery}/portrait-*.svg   the kit's square composition on a 1080 x 1350 canvas.
//
// `setCard` is proven before it is trusted: re-setting every kit card's own text ("Polaris Key",
// "Polaris Key Update") must reproduce that card exactly, or the generator stops. Nothing here
// draws new art, and no output carries a `style` attribute.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DELIVERY_TITLE } from "./delivery.js";
import { glyphPaths, loadFont, setLine, type Font } from "./wordmark.js";

export const KIT_UPDATE_NAME = "Polaris Key Update";
export const CARD_KINDS = [
  "social-card",
  "square",
  "banner",
  "splash",
] as const;
export const THEMES = ["dark", "light"] as const;
export const MARK_CUTS = ["display", "service", "favicon"] as const;
export const MARK_VARIANTS = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
  "currentColor",
] as const;

/** The portrait canvas (BRAND.md §7.2): 1080 x 1350, essential content 8 % inside every edge. */
export const PORTRAIT = { width: 1080, height: 1350, safe: 0.08 } as const;

const rename = (s: string) => s.replaceAll(KIT_UPDATE_NAME, DELIVERY_TITLE);

// ── Marks ───────────────────────────────────────────────────────────────────────────────────

/** marks/delivery/delivery-<cut>-<variant>.svg from kit/01-marks/update/svg/update-… */
export function deliveryMark(
  kitDir: string,
  cut: (typeof MARK_CUTS)[number],
  variant: (typeof MARK_VARIANTS)[number],
): string {
  const src = readFileSync(
    join(kitDir, "01-marks/update/svg", `update-${cut}-${variant}.svg`),
    "utf8",
  );
  if (!src.includes(KIT_UPDATE_NAME))
    throw new Error(
      `assets: update-${cut}-${variant}.svg no longer says Update`,
    );
  return rename(src);
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────

export function deliveryManifest(kitDir: string): string {
  const m = JSON.parse(
    readFileSync(join(kitDir, "04-web/update/site.webmanifest"), "utf8"),
  ) as { name: string; short_name: string };
  if (m.name !== KIT_UPDATE_NAME || m.short_name !== "Key Update")
    throw new Error("assets: the kit's Update manifest changed shape");
  return JSON.stringify(
    { ...m, name: DELIVERY_TITLE, short_name: "Key Delivery" },
    null,
    2,
  );
}

export function deliveryHeadSnippet(kitDir: string): string {
  const src = readFileSync(
    join(kitDir, "04-web/update/head-snippet.html"),
    "utf8",
  );
  if (!src.includes("/branding/update/"))
    throw new Error("assets: the kit's Update head snippet changed shape");
  return src.replaceAll("/branding/update/", "/branding/delivery/");
}

// ── Social cards ────────────────────────────────────────────────────────────────────────────

const CARD_TEXT =
  /(<g fill="#[0-9a-f]{6}" transform="translate\()([\d.]+)( [\d.]+\) scale\(([\d.]+) -[\d.]+\)">)((?:<path transform="translate\(\d+ 0\)" d="[^"]*"\/>)+)(<\/g>)/;
const CANVAS = /<svg [^>]*width="(\d+)" height="(\d+)"/;

/**
 * Re-set a kit social card's wordmark to `text`: Rubik Bold at the kit's scale and baseline, centred
 * on the canvas. Also renames the card (title and aria-label) to `name`.
 */
export function setCard(font: Font, svg: string, text: string, name: string) {
  const m = CARD_TEXT.exec(svg);
  const c = CANVAS.exec(svg);
  if (!m || !c) throw new Error("assets: unexpected social card");
  const scale = Number(m[4]);
  const { glyphs, advance } = setLine(font, text);
  const x = (Number(c[1]) - advance * scale) / 2;
  const named = svg.replace(
    /(aria-label=")[^"]*(")(><title>)[^<]*(<\/title>)/,
    `$1${name}$2$3${name}$4`,
  );
  return named.replace(CARD_TEXT, `$1${x.toFixed(4)}$3${glyphPaths(glyphs)}$6`);
}

const kitCard = (kitDir: string, kind: "key" | "update", file: string) =>
  readFileSync(join(kitDir, "07-social", kind, file), "utf8");

/** Prove `setCard` on every kit card before using it; throws if it cannot reproduce one. */
export function proveCards(kitDir: string, font: Font): void {
  for (const kind of ["key", "update"] as const)
    for (const card of CARD_KINDS)
      for (const theme of THEMES) {
        const file = `${card}-${theme}.svg`;
        const kit = kitCard(kitDir, kind, file);
        const name = /<title>([^<]*)<\/title>/.exec(kit)![1]!;
        if (setCard(font, kit, name, name) !== kit)
          throw new Error(
            `assets: re-setting "${name}" does not reproduce the kit's ${kind}/${file}`,
          );
      }
}

export function loadWordmarkFont(kitDir: string): Font {
  return loadFont(join(kitDir, "source/fonts/Rubik-Bold.ttf"));
}

/** social/delivery/<card>-<theme>.svg */
export function deliveryCard(
  kitDir: string,
  font: Font,
  card: (typeof CARD_KINDS)[number],
  theme: (typeof THEMES)[number],
): string {
  return setCard(
    font,
    kitCard(kitDir, "update", `${card}-${theme}.svg`),
    DELIVERY_TITLE,
    DELIVERY_TITLE,
  );
}

/**
 * The 1080 x 1350 portrait of a square card: the same mark and wordmark, the same sizes, the same
 * centring, on the taller canvas (everything moves down by half the extra height).
 */
export function portraitOf(square: string): string {
  const c = CANVAS.exec(square);
  if (!c || c[1] !== "1080" || c[2] !== "1080")
    throw new Error("assets: the portrait is built from a 1080 x 1080 square");
  const dy = (PORTRAIT.height - 1080) / 2;
  const down = (y: string) => String(Number(y) + dy);
  let out = square
    .replace(
      'width="1080" height="1080" viewBox="0 0 1080 1080"',
      `width="${PORTRAIT.width}" height="${PORTRAIT.height}" viewBox="0 0 ${PORTRAIT.width} ${PORTRAIT.height}"`,
    )
    .replace(
      '<rect width="1080" height="1080"',
      `<rect width="${PORTRAIT.width}" height="${PORTRAIT.height}"`,
    );
  let moved = 0;
  out = out.replace(
    /(<g (?:fill="#[0-9a-f]{6}" )?transform="translate\([\d.]+ )([\d.]+)(\) scale)/g,
    (_, a: string, y: string, b: string) => {
      moved++;
      return `${a}${down(y)}${b}`;
    },
  );
  if (moved !== 2)
    throw new Error(`assets: expected 2 groups in the square, found ${moved}`);
  return out;
}

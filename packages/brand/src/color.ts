// Colour science for the design system: sRGB <-> OKLab/OKLCH, WCAG 2 contrast, OKLab ΔE and
// HSL hue. Dependency-free on purpose: the token generator, the tests and any consumer that
// wants to check a pairing use the same arithmetic.
//
// OKLab is Björn Ottosson's perceptual space (https://bottosson.github.io/posts/oklab/), the
// one CSS Color 4 uses for `oklch()`. The matrices below are the published ones (the 2021-01-25
// revision that CSS adopted). Out-of-gamut OKLCH colours are mapped into sRGB by reducing chroma
// at constant lightness and hue, which is the CSS Color 4 gamut-mapping intent without the
// "just noticeable difference" shortcut: our palette is designed in-gamut, so mapping only ever
// trims a few thousandths of chroma.

/** An sRGB colour with channels in 0..1 (gamma-encoded). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** An OKLab colour (L in 0..1). */
export interface Oklab {
  l: number;
  a: number;
  b: number;
}

/** An OKLCH colour: lightness 0..1, chroma >= 0, hue in degrees 0..360. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parse `#rgb` or `#rrggbb`. Throws on anything else. */
export function parseHex(hex: string): Rgb {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Format as lower-case `#rrggbb`, clamping each channel into 0..1. */
export function toHex(rgb: Rgb): string {
  const ch = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`;
}

/** Normalise any accepted hex spelling to lower-case `#rrggbb`. */
export function normalizeHex(hex: string): string {
  return toHex(parseHex(hex));
}

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Gamma-encoded sRGB to OKLab. */
export function rgbToOklab({ r, g, b }: Rgb): Oklab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab to gamma-encoded sRGB. Channels may fall outside 0..1 for out-of-gamut input. */
export function oklabToRgb({ l, a, b }: Oklab): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

export function oklabToOklch({ l, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l, c, h };
}

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

export function hexToOklab(hex: string): Oklab {
  return rgbToOklab(parseHex(hex));
}

export function hexToOklch(hex: string): Oklch {
  return oklabToOklch(hexToOklab(hex));
}

function inGamut({ r, g, b }: Rgb, eps = 1e-6): boolean {
  return [r, g, b].every((v) => v >= -eps && v <= 1 + eps);
}

/**
 * OKLCH to `#rrggbb`. An out-of-gamut colour keeps its lightness and hue and loses chroma (a
 * binary search to 1e-5) until it fits sRGB.
 */
export function oklchToHex(color: Oklch): string {
  let rgb = oklabToRgb(oklchToOklab(color));
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.c;
    while (hi - lo > 1e-5) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToRgb(oklchToOklab({ ...color, c: mid })))) lo = mid;
      else hi = mid;
    }
    rgb = oklabToRgb(oklchToOklab({ ...color, c: lo }));
  }
  return toHex(rgb);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean distance in OKLab (ΔEOK). 0.02 is about a just-noticeable difference. */
export function deltaEOK(a: string, b: string): number {
  const x = hexToOklab(a);
  const y = hexToOklab(b);
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
}

/** HSL hue in degrees (0..360); NaN for an achromatic colour. */
export function hslHue(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return Number.NaN;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** HSL saturation (0..1). */
export function hslSaturation(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return 0;
  return d / (1 - Math.abs(2 * l - 1));
}

/** True when `h` lies on the arc from `from` to `to` (degrees, clockwise, wrapping at 360). */
export function hueInArc(h: number, from: number, to: number): boolean {
  if (Number.isNaN(h)) return false;
  const n = (x: number) => ((x % 360) + 360) % 360;
  const hh = n(h);
  const f = n(from);
  const t = n(to);
  return f <= t ? hh >= f && hh < t : hh >= f || hh < t;
}

/** Composite `fg` at `alpha` over an opaque `bg` (both hex) in gamma-encoded sRGB, as CSS does. */
export function mixOver(fg: string, alpha: number, bg: string): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  return toHex({
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  });
}

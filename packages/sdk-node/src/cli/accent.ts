// The accent resolver (docs/design/UI-KITS.md §3.3), ported from packages/brand/src/accent.ts so
// `@polaris-key/node` takes no brand dependency, like the Swift, Kotlin, GDScript and Python
// ports. It reproduces every vector in packages/brand/fixtures/accent-vectors.json exactly
// (test/cli/accent.test.ts). The terminal draws only the product chip in the accent, so it reads
// `solid` (the chip) and `on` (its label); the other roles are kept for parity with the ports.
//
// Every step is a lightness move in OKLCH, a 32-step bisection compared on the rounded hex.
// Change it only together with packages/brand and every port.

export type AccentScheme = "dark" | "light";

export interface ResolvedProductAccent {
  solid: string;
  on: string;
  fg: string;
  subtle: string;
  focus: string;
}

export const ACCENT_WHITE = "#ffffff";
export const ACCENT_INK = "#060912";

const RULES = {
  text: 4.5,
  ui: 3,
  whiteShift: 0.08,
  fgDarkL: 0.78,
  fgLightL: 0.52,
  steps: 32,
  opaqueAlpha: 128,
  greyChroma: 0.04,
  hueBin: 30,
  minShare: 0.08,
  derivedL: [0.45, 0.6] as const,
};

/** The four surfaces of each scheme (page, raised, overlay, sunken), from the brand tokens. */
const SURFACES: Record<AccentScheme, readonly string[]> = {
  dark: ["#060912", "#0d111b", "#121722", "#020408"],
  light: ["#f6f8ff", "#ffffff", "#ffffff", "#ebeef8"],
};

const SUBTLE_ALPHA: Record<AccentScheme, number> = { dark: 0.12, light: 0.1 };

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface Oklab {
  l: number;
  a: number;
  b: number;
}
interface Oklch {
  l: number;
  c: number;
  h: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(hex: string): Rgb {
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

function toHex(rgb: Rgb): string {
  const ch = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`;
}

/** Lower-case `#rrggbb`; throws on anything that is not a hex colour. */
export function normalizeHex(hex: string): string {
  return toHex(parseHex(hex));
}

const toLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function rgbToOklab({ r, g, b }: Rgb): Oklab {
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

function oklabToRgb({ l, a, b }: Oklab): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

function oklabToOklch({ l, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l, c, h };
}

function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

const hexToOklch = (hex: string): Oklch =>
  oklabToOklch(rgbToOklab(parseHex(hex)));

function inGamut({ r, g, b }: Rgb, eps = 1e-6): boolean {
  return [r, g, b].every((v) => v >= -eps && v <= 1 + eps);
}

function oklchToHex(color: Oklch): string {
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

function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mixOver(fg: string, alpha: number, bg: string): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  return toHex({
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  });
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const at = (base: Oklch, l: number) =>
  oklchToHex({ l: clamp01(l), c: base.c, h: base.h });

function moveUntil(
  base: Oklch,
  dir: -1 | 1,
  ok: (hex: string) => boolean,
): string {
  const start = at(base, base.l);
  if (ok(start)) return start;
  let lo = 0;
  let hi = dir < 0 ? base.l : 1 - base.l;
  if (!ok(at(base, base.l + dir * hi))) return at(base, base.l + dir * hi);
  for (let i = 0; i < RULES.steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(at(base, base.l + dir * mid))) hi = mid;
    else lo = mid;
  }
  return at(base, base.l + dir * hi);
}

const clears = (hex: string, grounds: readonly string[], min: number) =>
  grounds.every((g) => contrastRatio(hex, g) >= min);

/** White unless darkening by at most `whiteShift` cannot reach 4.5:1 against white. */
export function accentLabel(hex: string): "white" | "ink" {
  const base = hexToOklch(normalizeHex(hex));
  const shifted = at(base, base.l - RULES.whiteShift);
  return contrastRatio(ACCENT_WHITE, shifted) >= RULES.text ? "white" : "ink";
}

function accentSolid(
  hex: string,
  scheme: AccentScheme,
  label: "white" | "ink",
): string {
  const base = hexToOklch(normalizeHex(hex));
  const surfaces = SURFACES[scheme];
  const onUi = (h: string) => clears(h, surfaces, RULES.ui);
  if (label === "white") {
    const solid = moveUntil(
      base,
      -1,
      (h) => contrastRatio(ACCENT_WHITE, h) >= RULES.text,
    );
    return scheme === "dark" && !onUi(solid)
      ? moveUntil(hexToOklch(solid), 1, onUi)
      : solid;
  }
  const solid = moveUntil(
    base,
    1,
    (h) => contrastRatio(ACCENT_INK, h) >= RULES.text,
  );
  return scheme === "light" && !onUi(solid)
    ? moveUntil(hexToOklch(solid), -1, onUi)
    : solid;
}

function accentFg(hex: string, scheme: AccentScheme): string {
  const base = hexToOklch(normalizeHex(hex));
  const readable = (h: string) => clears(h, SURFACES[scheme], RULES.text);
  return scheme === "dark"
    ? moveUntil({ ...base, l: Math.max(base.l, RULES.fgDarkL) }, 1, readable)
    : moveUntil({ ...base, l: Math.min(base.l, RULES.fgLightL) }, -1, readable);
}

/** The five accent roles for one scheme. */
export function resolveAccent(
  hex: string,
  scheme: AccentScheme,
): ResolvedProductAccent {
  const label = accentLabel(hex);
  const solid = accentSolid(hex, scheme, label);
  const fg = accentFg(hex, scheme);
  return {
    solid,
    on: label === "white" ? ACCENT_WHITE : ACCENT_INK,
    fg,
    subtle: mixOver(solid, SUBTLE_ALPHA[scheme], SURFACES[scheme][0]!),
    focus: scheme === "dark" ? fg : solid,
  };
}

/** The input colour derived from an icon's RGBA pixels, or null for a near-greyscale icon. */
export function deriveAccent(rgba: ArrayLike<number>): string | null {
  const bins = RULES.hueBin;
  const count = Math.floor(360 / bins);
  const n: number[] = new Array(count).fill(0);
  const sumL: number[] = new Array(count).fill(0);
  const sumA: number[] = new Array(count).fill(0);
  const sumB: number[] = new Array(count).fill(0);
  const sumC: number[] = new Array(count).fill(0);
  let opaque = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < RULES.opaqueAlpha) continue;
    opaque++;
    const lab = rgbToOklab({
      r: rgba[i]! / 255,
      g: rgba[i + 1]! / 255,
      b: rgba[i + 2]! / 255,
    });
    const lch = oklabToOklch(lab);
    if (lch.c < RULES.greyChroma) continue;
    const k = Math.min(count - 1, Math.floor(lch.h / bins));
    n[k]!++;
    sumL[k]! += lab.l;
    sumA[k]! += lab.a;
    sumB[k]! += lab.b;
    sumC[k]! += lch.c;
  }
  if (opaque === 0) return null;
  let best = -1;
  for (let k = 0; k < count; k++) {
    if (n[k]! < RULES.minShare * opaque) continue;
    if (best < 0) {
      best = k;
      continue;
    }
    const chroma = sumC[k]! / n[k]!;
    const bestChroma = sumC[best]! / n[best]!;
    if (chroma > bestChroma || (chroma === bestChroma && n[k]! > n[best]!))
      best = k;
  }
  if (best < 0) return null;
  const mean = oklabToOklch({
    l: sumL[best]! / n[best]!,
    a: sumA[best]! / n[best]!,
    b: sumB[best]! / n[best]!,
  });
  const [lo, hi] = RULES.derivedL;
  return oklchToHex({ ...mean, l: Math.min(hi, Math.max(lo, mean.l)) });
}

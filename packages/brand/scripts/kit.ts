// Read the launch kit copy in kit/ and turn its layout SVGs into colour templates.
//
// Each lockup and badge ships in four or five colour variants that differ ONLY in their fill and
// stroke values. A template is the dark variant with every colour replaced by the ROLE it plays
// (body, star, gold, text, muted, bg, stroke); a role is recognised by its (dark, light) colour
// pair and the attribute it sits in. The template is accepted only if substituting each variant's
// palette reproduces that variant's file byte for byte, so the React and string renderers emit
// the kit's exact artwork and the generator fails instead of guessing when the kit changes shape.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROLES = [
  "body",
  "star",
  "gold",
  "text",
  "muted",
  "bg",
  "stroke",
] as const;
export type Role = (typeof ROLES)[number];

export type KitVariant =
  | "dark"
  | "light"
  | "mono-black"
  | "mono-white"
  | "currentColor";

export type Palette = Record<Role, string>;

/** Each variant's colour for each role, as the kit's files use them. */
export const KIT_PALETTES: Record<KitVariant, Palette> = {
  dark: {
    body: "#9a5cff",
    star: "#ffffff",
    gold: "#ffc24d",
    text: "#ffffff",
    muted: "#dbe4ff",
    bg: "#060912",
    stroke: "#9a5cff",
  },
  light: {
    body: "#7a2fff",
    star: "#7a2fff",
    gold: "#d07a00",
    text: "#060912",
    muted: "#48536b",
    bg: "#f6f8ff",
    stroke: "#7a2fff",
  },
  "mono-black": {
    body: "#060912",
    star: "#060912",
    gold: "#060912",
    text: "#060912",
    muted: "#060912",
    bg: "#f6f8ff",
    stroke: "#060912",
  },
  "mono-white": {
    body: "#ffffff",
    star: "#ffffff",
    gold: "#ffffff",
    text: "#ffffff",
    muted: "#ffffff",
    bg: "#060912",
    stroke: "#ffffff",
  },
  currentColor: {
    body: "currentColor",
    star: "currentColor",
    gold: "currentColor",
    text: "currentColor",
    muted: "currentColor",
    bg: "currentColor",
    stroke: "currentColor",
  },
};

const COLOR_ATTR = /(fill|stroke)="(#[0-9a-f]{6}|currentColor)"/g;

/** The (attribute, dark colour, light colour) signature of each role. */
function roleOf(attr: string, dark: string, light: string): Role {
  for (const role of ROLES) {
    const isStroke = role === "stroke";
    if ((attr === "stroke") !== isStroke) continue;
    if (KIT_PALETTES.dark[role] === dark && KIT_PALETTES.light[role] === light)
      return role;
  }
  throw new Error(`no role for ${attr} ${dark}/${light}`);
}

export interface Template {
  width: number;
  height: number;
  title: string;
  desc: string;
  /** Inner markup (after <title>/<desc>, before </svg>) with `{role}` placeholders. */
  body: string;
}

const HEAD =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)" role="img" aria-label="([^"]*)"><title>([^<]*)<\/title><desc>([^<]*)<\/desc>([\s\S]*)<\/svg>\n?$/;

function split(svg: string, path: string) {
  const m = HEAD.exec(svg);
  if (!m) throw new Error(`${path}: unexpected SVG head`);
  const [, w, h, vw, vh, label, title, desc, body] = m;
  if (w !== vw || h !== vh || label !== title)
    throw new Error(`${path}: viewBox/label mismatch`);
  return {
    width: Number(w),
    height: Number(h),
    title: title!,
    desc: desc!,
    body: body!,
  };
}

/** Render a template with a palette, reproducing the kit file's exact bytes. */
export function renderTemplate(t: Template, palette: Palette): string {
  const body = t.body.replace(/\{(\w+)\}/g, (_, r: Role) => palette[r]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${t.title}"><title>${t.title}</title><desc>${t.desc}</desc>${body}</svg>`;
}

/** Build one template from a set of variant files and prove it reproduces every one. */
export function buildTemplate(
  kitDir: string,
  files: Partial<Record<KitVariant, string>>,
): Template {
  const read = (v: KitVariant) => readFileSync(join(kitDir, files[v]!), "utf8");
  const dark = split(read("dark"), files.dark!);
  const light = split(read("light"), files.light!);
  const darkColors = [...dark.body.matchAll(COLOR_ATTR)];
  const lightColors = [...light.body.matchAll(COLOR_ATTR)];
  if (darkColors.length !== lightColors.length)
    throw new Error(`${files.dark}: colour count differs from light`);
  let i = 0;
  const body = dark.body.replace(
    COLOR_ATTR,
    (_, attr: string, color: string) => {
      const l = lightColors[i++]!;
      return `${attr}="{${roleOf(attr, color, l[2]!)}}"`;
    },
  );
  const template: Template = { ...dark, body };
  for (const [variant, file] of Object.entries(files) as [
    KitVariant,
    string,
  ][]) {
    const want = readFileSync(join(kitDir, file), "utf8");
    const got = renderTemplate(template, KIT_PALETTES[variant]);
    if (got !== want)
      throw new Error(
        `${file}: the ${variant} palette does not reproduce the kit file`,
      );
  }
  return template;
}

export const LOCKUP_LAYOUTS = ["horizontal", "stacked", "compact"] as const;
export const BADGE_LAYOUTS = ["horizontal", "compact", "stacked"] as const;
export const BADGE_STYLES = ["transparent", "sticker", "outline"] as const;
const LOCKUP_VARIANTS: KitVariant[] = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
  "currentColor",
];
const BADGE_VARIANTS: KitVariant[] = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
];

export type Geometry = Record<
  "key" | "update",
  Record<"display" | "service" | "favicon", [number, [string, string][]]>
>;

/** The glyph a layout carries: which optical cut and its rendered size at the natural size. */
export interface GlyphInfo {
  cut: "display" | "service" | "favicon";
  /** Glyph edge in user units of the layout's viewBox. */
  size: number;
}

function glyphOf(t: Template, geometry: Geometry): GlyphInfo {
  const m = /<g transform="translate\([\d. ]+\) scale\(([\d.]+)\)">/.exec(
    t.body,
  );
  if (!m) throw new Error("layout without a mark group");
  const scale = Number(m[1]);
  const firstPath = /<path fill="\{body\}" d="([^"]+)"\/>/.exec(t.body)?.[1];
  for (const kind of ["key", "update"] as const)
    for (const cut of ["display", "service", "favicon"] as const) {
      const [grid, parts] = geometry[kind][cut];
      if (parts[0]![1] === firstPath) return { cut, size: grid * scale };
    }
  throw new Error("layout mark matches no kit geometry");
}

export function loadKit(kitDir: string) {
  const geometry = JSON.parse(
    readFileSync(join(kitDir, "source/geometry.json"), "utf8"),
  ) as Geometry;
  const lockups = {} as Record<"key" | "update", Record<string, Template>>;
  const lockupGlyphs = {} as Record<
    "key" | "update",
    Record<string, GlyphInfo>
  >;
  for (const kind of ["key", "update"] as const) {
    lockups[kind] = {};
    lockupGlyphs[kind] = {};
    for (const layout of LOCKUP_LAYOUTS) {
      const files = Object.fromEntries(
        LOCKUP_VARIANTS.map((v) => [
          v,
          `02-lockups/${kind}/${kind}-${layout}-${v}.svg`,
        ]),
      );
      const t = buildTemplate(kitDir, files);
      lockups[kind][layout] = t;
      lockupGlyphs[kind][layout] = glyphOf(t, geometry);
    }
  }
  const badges = {} as Record<string, Record<string, Template>>;
  for (const style of BADGE_STYLES) {
    badges[style] = {};
    for (const layout of BADGE_LAYOUTS) {
      const files = Object.fromEntries(
        BADGE_VARIANTS.map((v) => [
          v,
          `03-powered-by/${style}/powered-by-${layout}-${v}.svg`,
        ]),
      );
      badges[style][layout] = buildTemplate(kitDir, files);
    }
  }
  const sprite = readFileSync(
    join(kitDir, "08-developer/polaris-sprite.svg"),
    "utf8",
  );
  const kitTokens = JSON.parse(
    readFileSync(join(kitDir, "08-developer/tokens.json"), "utf8"),
  ) as unknown;
  return { geometry, lockups, lockupGlyphs, badges, sprite, kitTokens };
}

// Read the Polaris Locker launch kit copy (locker-kit/) and turn its marks, lockups and badges into
// geometry and colour templates (docs/design/BRAND.md §15).
//
// The kit ships every lockup and badge in several colour variants that differ ONLY in their fill
// and stroke values. A template is the dark variant with each colour replaced by the ROLE it plays
// (body, star, text, bg, stroke); a role is recognised by the element and attribute it sits in,
// not by its value, because the kit reuses one value for several roles (white-on-white). The
// template is accepted only if substituting each variant's palette reproduces that variant's
// file byte for byte, so the renderers emit the kit's exact artwork and the generator stops
// instead of guessing when the kit changes shape. The kit's own build.py is never run.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LockerTemplate } from "../src/marks/types.js";

export const LOCKER_ROLES = ["body", "star", "text", "bg", "stroke"] as const;
export type LockerRole = (typeof LOCKER_ROLES)[number];
export type LockerPalette = Partial<Record<LockerRole, string>>;

export const LOCKER_MARK_VARIANTS = [
  "dark",
  "light",
  "white",
  "black",
  "coral",
] as const;
export const LOCKER_LAYOUTS = ["horizontal", "compact", "stacked"] as const;
export const LOCKER_BADGE_THEMES = ["dark", "light", "white"] as const;
export const LOCKER_BADGE_TREATMENTS = [
  "transparent",
  "sticker",
  "outline",
] as const;

export type { LockerTemplate };

const HEAD =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)" viewBox="0 0 \1 \2" role="img" aria-label="([^"]+)">(.*)<\/svg>$/s;
const TAG = /<(rect|path|g)\b([^>]*)>/g;
const COLOR_ATTR = /\b(fill|stroke)="(#[0-9a-f]{6})"/;

function split(svg: string) {
  const m = HEAD.exec(svg.trimEnd());
  if (!m) throw new Error("locker: unexpected SVG head");
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    title: m[3]!,
    body: m[4]!,
  };
}

/** Replace each role-bearing colour with `{role}`; return the template and the palette it had. */
function abstract(svg: string): { t: LockerTemplate; palette: LockerPalette } {
  const head = split(svg);
  const palette: LockerPalette = {};
  let paths = 0;
  const set = (role: LockerRole, value: string) => {
    if (palette[role] !== undefined && palette[role] !== value)
      throw new Error(`locker: role ${role} takes two colours in one file`);
    palette[role] = value;
    return `{${role}}`;
  };
  const body = head.body.replace(TAG, (tag, name: string, attrs: string) => {
    const hasFill = /\bfill="/.test(attrs);
    let role: LockerRole | undefined;
    if (name === "path" && hasFill) role = paths++ === 0 ? "body" : "star";
    let out = tag;
    for (const attr of ["fill", "stroke"] as const) {
      const m = new RegExp(`\\b${attr}="(#[0-9a-f]{6})"`).exec(attrs);
      if (!m) continue;
      let r: LockerRole;
      if (name === "rect") r = attr === "fill" ? "bg" : "stroke";
      else if (name === "g") r = "text";
      else r = role!;
      out = out.replace(m[0], `${attr}="${set(r, m[1]!)}"`);
    }
    return out;
  });
  if (COLOR_ATTR.test(body.replace(/\{[a-z]+\}/g, "")))
    throw new Error("locker: a colour is left outside the role template");
  return { t: { ...head, body }, palette };
}

const fillRoles = (body: string, p: LockerPalette) =>
  body.replace(/\{(\w+)\}/g, (_, r: LockerRole) => {
    const v = p[r];
    if (v === undefined) throw new Error(`locker: palette lacks ${r}`);
    return v;
  });

/** The kit's own file for a template and palette, byte for byte. */
export function lockerFile(t: LockerTemplate, p: LockerPalette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}" role="img" aria-label="${t.title}">${fillRoles(t.body, p)}</svg>`;
}

const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

function template(
  dir: string,
  files: [variant: string, path: string][],
): { t: LockerTemplate; palettes: Record<string, LockerPalette> } {
  const palettes: Record<string, LockerPalette> = {};
  let t: LockerTemplate | undefined;
  for (const [variant, path] of files) {
    const svg = read(dir, path);
    const a = abstract(svg);
    if (!t) t = a.t;
    else if (JSON.stringify(a.t) !== JSON.stringify(t))
      throw new Error(
        `locker: ${path} differs from its siblings beyond colour`,
      );
    palettes[variant] = a.palette;
    if (lockerFile(a.t, a.palette) !== svg.trimEnd())
      throw new Error(`locker: ${path} does not reproduce from its template`);
  }
  return { t: t!, palettes };
}

const MICRO_BODY =
  /<g transform="scale\(8\)"><path fill="(#[0-9a-f]{6})" d="([^"]+)"\/><path fill="(#[0-9a-f]{6})" d="([^"]+)"\/><\/g>/;
const MASTER_BODY =
  /<path fill="(#[0-9a-f]{6}|currentColor)" d="([^"]+)"\/><path fill="(#[0-9a-f]{6}|currentColor)" d="([^"]+)"\/>/;

export type LockerMarkParts = readonly [
  readonly ["body", string],
  readonly ["star", string],
];

/** Everything src/generated/locker.ts carries. */
export function loadLocker(dir: string) {
  const geometry = {} as Record<
    "micro" | "master",
    readonly [number, LockerMarkParts]
  >;
  const markPalettes = {} as Record<
    "micro" | "master",
    Record<string, { body: string; star: string }>
  >;
  for (const cut of ["micro", "master"] as const) {
    markPalettes[cut] = {};
    for (const variant of LOCKER_MARK_VARIANTS) {
      const svg = read(dir, `logos/svg/locker-mark-${variant}-${cut}.svg`);
      const head = split(svg);
      if (head.title !== "Polaris Locker" || head.width !== 128)
        throw new Error(`locker: mark ${variant} ${cut} changed shape`);
      const m = (cut === "micro" ? MICRO_BODY : MASTER_BODY).exec(head.body);
      if (!m || `${head.body}` !== m[0])
        throw new Error(`locker: mark ${variant} ${cut} changed shape`);
      const parts: LockerMarkParts = [
        ["body", m[2]!],
        ["star", m[4]!],
      ];
      if (variant === "dark")
        geometry[cut] = [cut === "micro" ? 16 : 128, parts];
      else if (JSON.stringify(parts) !== JSON.stringify(geometry[cut]![1]))
        throw new Error(`locker: ${variant} ${cut} geometry differs from dark`);
      markPalettes[cut][variant] = { body: m[1]!, star: m[3]! };
    }
  }
  // currentColor master: both parts take the ink (the micro cut has no currentColor file).
  const cc = split(read(dir, "logos/svg/locker-mark-currentColor.svg"));
  const ccm = MASTER_BODY.exec(cc.body)!;
  if (
    ccm[1] !== "currentColor" ||
    ccm[3] !== "currentColor" ||
    ccm[2] !== geometry.master[1][0][1] ||
    ccm[4] !== geometry.master[1][1][1]
  )
    throw new Error("locker: the currentColor mark changed shape");

  const lockups = {} as Record<(typeof LOCKER_LAYOUTS)[number], LockerTemplate>;
  const lockupPalettes = {} as Record<
    (typeof LOCKER_LAYOUTS)[number],
    Record<string, LockerPalette>
  >;
  for (const layout of LOCKER_LAYOUTS) {
    const r = template(
      dir,
      LOCKER_MARK_VARIANTS.map((v) => [
        v,
        `logos/svg/locker-${layout}-${v}.svg`,
      ]),
    );
    lockups[layout] = r.t;
    lockupPalettes[layout] = r.palettes;
  }
  // The glyph of every lockup is the master cut: the template's first two paths.
  for (const layout of LOCKER_LAYOUTS)
    if (!lockups[layout].body.includes(geometry.master[1][0][1]))
      throw new Error(
        `locker: the ${layout} lockup does not carry the master cut`,
      );

  // Badges (v1.3): 16 labels share one structure per treatment; only the prefix text group
  // ("Open in", "Sync with", ...) differs, so each treatment is a template with a {prefix} slot
  // and each label contributes its outlined prefix. Every file must reproduce from them.
  const index = JSON.parse(read(dir, "badges/index.json")) as {
    canvas: [number, number];
    minimumDisplayWidthCssPx: number;
    themes: string[];
    styles: string[];
    labels: { label: string; slug: string }[];
  };
  if (
    index.canvas.join("x") !== "320x104" ||
    index.minimumDisplayWidthCssPx !== 320 ||
    index.themes.join() !== LOCKER_BADGE_THEMES.join() ||
    index.styles.join() !== LOCKER_BADGE_TREATMENTS.join()
  )
    throw new Error("locker: badges/index.json changed shape");
  const PREFIX =
    /<g fill="\{text\}" transform="translate\(96,42\) scale\(0\.014, -0\.014\)">(?:<path transform="translate\(\d+,0\)" d="[^"]*"\/>)+<\/g>/;
  const badgeLabels: Record<string, string> = {};
  const badgePrefixes: Record<string, string> = {};
  const badges = {} as Record<
    (typeof LOCKER_BADGE_TREATMENTS)[number],
    LockerTemplate
  >;
  const badgePalettes = {} as Record<
    (typeof LOCKER_BADGE_TREATMENTS)[number],
    Record<string, LockerPalette>
  >;
  for (const { label, slug } of index.labels) {
    badgeLabels[slug] = label;
    for (const treatment of LOCKER_BADGE_TREATMENTS) {
      for (const theme of LOCKER_BADGE_THEMES) {
        const path = `badges/locker-${slug}-${theme}-${treatment}.svg`;
        const svg = read(dir, path);
        const { t, palette } = abstract(svg);
        if (t.title !== `${label} Polaris Locker`)
          throw new Error(
            `locker: ${path} is not named "${label} Polaris Locker"`,
          );
        const m = PREFIX.exec(t.body);
        if (!m) throw new Error(`locker: ${path} has no prefix group`);
        if (badgePrefixes[slug] !== undefined && badgePrefixes[slug] !== m[0])
          throw new Error(`locker: ${path} prefix differs from its siblings`);
        badgePrefixes[slug] = m[0];
        const rest: LockerTemplate = {
          width: t.width,
          height: t.height,
          title: "",
          body: t.body.replace(PREFIX, "{prefix}"),
        };
        const known = badges[treatment];
        if (known && JSON.stringify(known) !== JSON.stringify(rest))
          throw new Error(`locker: ${path} differs from its treatment`);
        badges[treatment] = rest;
        const pal = (badgePalettes[treatment] ??= {});
        if (
          pal[theme] &&
          JSON.stringify(pal[theme]) !== JSON.stringify(palette)
        )
          throw new Error(`locker: ${path} palette differs`);
        pal[theme] = palette;
        const again = lockerFile(
          {
            ...rest,
            title: t.title,
            body: rest.body.replace("{prefix}", badgePrefixes[slug]!),
          },
          palette,
        );
        if (again !== svg.trimEnd())
          throw new Error(
            `locker: ${path} does not reproduce from its template`,
          );
      }
    }
  }
  return {
    geometry,
    markPalettes,
    lockups,
    lockupPalettes,
    badges,
    badgePalettes,
    badgeLabels,
    badgePrefixes,
  };
}

/** The Locker web manifest: the kit's, with the scope its site gives it (BRAND.md §15). */
export function lockerManifest(dir: string): string {
  const m = JSON.parse(read(dir, "web/site.webmanifest")) as {
    name: string;
    short_name: string;
    start_url: string;
  } & Record<string, unknown>;
  if (m.name !== "Polaris Locker" || m.short_name !== "Locker")
    throw new Error("locker: the kit's manifest changed shape");
  const { name, short_name, start_url: _start, ...rest } = m;
  return JSON.stringify(
    { name, short_name, id: "/", start_url: "/", scope: "/", ...rest },
    null,
    2,
  );
}

export function lockerHeadSnippet(): string {
  return `<!-- Copy this directory to /branding/locker/; adjust paths and manifest scope for your site. -->
<link rel="icon" type="image/svg+xml" href="/branding/locker/favicon.svg">
<link rel="icon" type="image/x-icon" sizes="16x16 24x24 32x32 48x48 64x64 128x128 256x256" href="/branding/locker/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/branding/locker/apple-touch-icon.png">
<link rel="manifest" href="/branding/locker/site.webmanifest">
<meta name="theme-color" content="#060912">
`;
}

// The design tokens every shadow root adopts, written from `@polaris-key/brand`'s typed tokens
// (never a hand-copied value): the brand's surfaces, text, borders, status and elevation per
// scheme, the space, radius, motion and type scales, and the web kit's component measures
// (UI-KITS.md §2.1). The names are tokens.css's and kit.css's (`--pk-surface-page`,
// `--pk-kit-control-height`), so a host's own `--pk-*` override reads the same in React and here.
//
// Scoping (UI-KITS.md §3.2): the scales sit on `:host`, the colours on the kit root's
// `[data-theme]`, which the element always sets to the resolved scheme. Nothing is set on `:root`.

import { KIT_TOKENS, THEME_TOKENS } from "@polaris-key/brand";
import { ELEVATION, FONT, MOTION, RADIUS, SPACE } from "@polaris-key/brand";

type Scheme = "dark" | "light";

/** px → rem at the 16 px root, so type follows the person's text size (DL11). */
export function rem(px: number | string): string {
  const n = typeof px === "number" ? px : Number.parseFloat(px);
  if (typeof px === "string" && !px.endsWith("px")) return px;
  return `${+(n / 16).toFixed(4)}rem`;
}

const decl = (vars: Record<string, string | number>) =>
  Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

function scales(): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(SPACE))
    out[`--pk-space-${k.replace(".", "_")}`] = v;
  for (const [k, v] of Object.entries(RADIUS)) out[`--pk-radius-${k}`] = v;
  out["--pk-font-sans"] = FONT.sans;
  out["--pk-font-mono"] = FONT.mono;
  for (const [k, v] of Object.entries(MOTION.duration))
    out[`--pk-duration-${k}`] = v;
  for (const [k, v] of Object.entries(MOTION.easing)) out[`--pk-ease-${k}`] = v;
  for (const [k, v] of Object.entries(MOTION.distance))
    out[`--pk-motion-distance-${k}`] = v;
  out["--pk-motion-scale-press"] = MOTION.scale.press;
  out["--pk-motion-scale-enter"] = MOTION.scale.enter;
  out["--pk-motion-scale-pop"] = MOTION.scale.pop;
  out["--pk-stagger-step"] = MOTION.stagger.step;

  const web = KIT_TOKENS.components.web;
  out["--pk-kit-control-height"] = rem(web.controlHeight.default);
  out["--pk-kit-control-height-coarse"] = rem(web.controlHeight.coarse);
  out["--pk-kit-control-height-compact"] = rem(web.controlHeight.compact);
  out["--pk-kit-radius-control"] = rem(web.radiusControl.default);
  out["--pk-kit-radius-control-compact"] = rem(web.radiusControl.compact);
  out["--pk-kit-radius-card"] = rem(web.radiusSurface.card);
  out["--pk-kit-radius-group"] = rem(web.radiusSurface.group);
  out["--pk-kit-card-pad"] = rem(web.cardPad.default);
  out["--pk-kit-card-pad-full-bleed"] = rem(web.cardPad.fullBleed);
  out["--pk-kit-focus-width"] = `${web.focus.width}px`;
  out["--pk-kit-focus-offset"] = `${web.focus.offset}px`;
  for (const [role, t] of Object.entries(KIT_TOKENS.typeScale.web)) {
    out[`--pk-kit-type-${role}-size`] = rem(t.size);
    out[`--pk-kit-type-${role}-line-height`] =
      typeof t.lineHeight === "number" ? t.lineHeight : rem(t.lineHeight);
    out[`--pk-kit-type-${role}-weight`] = t.weight;
    out[`--pk-kit-type-${role}-tracking`] = `${t.tracking}em`;
    out[`--pk-kit-type-${role}-family`] =
      t.family === "mono" ? "var(--pk-font-mono)" : "var(--pk-font-sans)";
  }
  return out;
}

function colours(scheme: Scheme): Record<string, string> {
  const t = THEME_TOKENS[scheme];
  const out: Record<string, string> = {
    "--pk-surface-page": t.surface.page,
    "--pk-surface-raised": t.surface.raised,
    "--pk-surface-overlay": t.surface.overlay,
    "--pk-surface-sunken": t.surface.sunken,
    "--pk-text-strong": t.text.strong,
    "--pk-text-default": t.text.default,
    "--pk-text-muted": t.text.muted,
    "--pk-text-subtle": t.text.subtle,
    "--pk-border-subtle": t.border.subtle,
    "--pk-border-strong": t.border.strong,
  };
  // The brand's light sunken ground is a lavender that fights an accent and a host's greys: the
  // kit's fields, rows and callouts take a neutral lift of the text colour instead.
  if (scheme === "light")
    out["--pk-surface-sunken"] =
      "color-mix(in srgb, var(--pk-text-strong) 5%, var(--pk-surface-raised))";
  for (const [k, s] of Object.entries(t.status)) {
    out[`--pk-${k}`] = s.fg;
    out[`--pk-${k}-on`] = s.on;
    out[`--pk-${k}-border`] = s.border;
    out[`--pk-${k}-subtle`] = s.subtle;
  }
  for (const [k, v] of Object.entries(ELEVATION[scheme]))
    out[`--pk-elevation-${k}`] = v;
  const hl = KIT_TOKENS.highlight[scheme];
  out["--pk-kit-highlight"] = rgba(hl.color, hl.opacity);
  out["--pk-kit-danger-solid"] = KIT_TOKENS.danger[scheme].solid;
  out["--pk-kit-danger-on"] = KIT_TOKENS.danger[scheme].on;
  const scrim = KIT_TOKENS.components.web.scrim[scheme];
  out["--pk-kit-scrim"] = rgba(KIT_TOKENS.scrimColor[scheme], scrim.opacity);
  out["--pk-kit-scrim-blur"] = `${scrim.blur}px`;
  return out;
}

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

/** The desktop chrome variants (UK-06): brand's `windows`, `gnome` and `macos` blocks. */
export const DESKTOP_VARIANTS = ["windows", "gnome", "macos"] as const;
export type DesktopVariant = (typeof DESKTOP_VARIANTS)[number];

type Num = number | string;
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const px = (n: number) => (n === 0 ? "0" : `${n}px`);
/** A radius: brand's `"capsule"` is the pill; a number is rem so it follows the text size. */
const radius = (r: Num) => (r === "capsule" ? "9999px" : rem(r));

/**
 * One desktop variant's custom properties, written from `KIT_TOKENS` (never hand-copied): the same
 * names and values as brand's css/kit.css `[data-pk-platform=…]` block (test/chrome.test.ts holds
 * them equal), with lengths in rem. `compact` and `coarse` fall back to the variant's own default
 * so the web's density rules never bring the web radius or height back, except the coarse target
 * size: 44 px under a coarse pointer (UK-06 U6; the variant's default is already 24 px or more
 * under a fine one).
 */
export function platformVars(p: DesktopVariant): Record<string, string> {
  const c = KIT_TOKENS.components[p] as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  const obj = (k: string) => (c[k] ?? {}) as Record<string, Num>;
  for (const [k, v] of Object.entries(obj("controlHeight")))
    out[`--pk-kit-control-height${k === "default" ? "" : `-${kebab(k)}`}`] =
      rem(v);
  const h = out["--pk-kit-control-height"]!;
  out["--pk-kit-control-height-compact"] ??= h;
  out["--pk-kit-control-height-coarse"] = rem(
    Math.max(44, Number.parseFloat(String(obj("controlHeight").default))),
  );
  for (const [k, v] of Object.entries(obj("radiusControl")))
    out[`--pk-kit-radius-control${k === "default" ? "" : `-${kebab(k)}`}`] =
      radius(v);
  out["--pk-kit-radius-control-compact"] ??= out["--pk-kit-radius-control"]!;
  for (const [k, v] of Object.entries(obj("radiusSurface")))
    out[`--pk-kit-radius-${kebab(k)}`] = radius(v);
  for (const [k, v] of Object.entries(obj("cardPad")))
    out[`--pk-kit-card-pad${k === "default" ? "" : `-${kebab(k)}`}`] = rem(v);
  // `focus: "system"` (macOS) draws the system ring: no width, offset, inner line or glow.
  const f = (typeof c.focus === "object" ? c.focus : {}) as Record<
    string,
    number
  >;
  out["--pk-kit-focus-width"] = px(f.width ?? 0);
  out["--pk-kit-focus-offset"] = px(f.offset ?? 0);
  out["--pk-kit-focus-inner"] = px(f.inner ?? 0);
  out["--pk-kit-focus-glow"] = px(f.glow ?? 0);
  const scale = (KIT_TOKENS.typeScale as unknown as Record<string, unknown>)[
    p
  ] as Record<
    string,
    {
      size: Num;
      lineHeight: Num;
      weight: number;
      tracking: number;
      family: string;
    }
  >;
  for (const [role, t] of Object.entries(scale)) {
    out[`--pk-kit-type-${role}-size`] = rem(t.size);
    out[`--pk-kit-type-${role}-line-height`] =
      typeof t.lineHeight === "number" && t.lineHeight < 4
        ? String(t.lineHeight)
        : rem(t.lineHeight);
    out[`--pk-kit-type-${role}-weight`] = String(t.weight);
    out[`--pk-kit-type-${role}-tracking`] =
      t.tracking === 0 ? "0" : `${t.tracking}em`;
    out[`--pk-kit-type-${role}-family`] =
      t.family === "mono" ? "var(--pk-font-mono)" : "var(--pk-font-sans)";
  }
  return out;
}

function platformScrim(p: DesktopVariant, scheme: Scheme) {
  const s = (
    KIT_TOKENS.components[p] as unknown as {
      scrim: Record<Scheme, { opacity: number; blur: number }> | null;
    }
  ).scrim;
  return {
    "--pk-kit-scrim": s
      ? rgba(KIT_TOKENS.scrimColor[scheme], s[scheme].opacity)
      : "transparent",
    "--pk-kit-scrim-blur": px(s?.[scheme].blur ?? 0),
  };
}

function platformCss(): string {
  return DESKTOP_VARIANTS.flatMap((p) => [
    `[data-pk-platform="${p}"] {\n${decl(platformVars(p))}\n}`,
    ...(["dark", "light"] as const).map(
      (scheme) =>
        `[data-theme="${scheme}"][data-pk-platform="${p}"] {\n${decl(platformScrim(p, scheme))}\n}`,
    ),
  ]).join("\n\n");
}

/** The token sheet's text: scales on `:host`, colours per `[data-theme]`, then the desktop
 *  variants' blocks on the kit root's `[data-pk-platform]`. */
export function tokenCss(): string {
  return [
    `:host {\n${decl(scales())}\n}`,
    `[data-theme="dark"] {\n  color-scheme: dark;\n${decl(colours("dark"))}\n}`,
    `[data-theme="light"] {\n  color-scheme: light;\n${decl(colours("light"))}\n}`,
    platformCss(),
    // Reduced motion (DL16): every duration 0, no fade; the delay of DL7 is a model timer.
    `[data-motion="reduced"] {\n${decl(
      Object.fromEntries(
        Object.keys(MOTION.duration).map((k) => [`--pk-duration-${k}`, "0ms"]),
      ),
    )}\n}`,
  ].join("\n\n");
}

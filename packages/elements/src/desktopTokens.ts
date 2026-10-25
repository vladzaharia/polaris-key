// The desktop chrome variants' tokens (UK-06), written from brand's `windows`, `gnome` and `macos`
// blocks. Their own module so the React kit's web entry can leave them out (the build gives it an
// empty stand-in, packages/sdk-react/scripts/bundle-contract.mjs); `tokenCss()` includes them.

import { KIT_TOKENS } from "@polaris-key/brand";

import { decl, rem, rgba } from "./tokens.js";

type Scheme = "dark" | "light";

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

/** The desktop variants' token blocks (UK-06). */
export function platformTokenCss(): string {
  return DESKTOP_VARIANTS.flatMap((p) => [
    `[data-pk-platform="${p}"] {\n${decl(platformVars(p))}\n}`,
    ...(["dark", "light"] as const).map(
      (scheme) =>
        `[data-theme="${scheme}"][data-pk-platform="${p}"] {\n${decl(platformScrim(p, scheme))}\n}`,
    ),
    // A coarse pointer takes the variant's touch height. It is written here, after the variant's
    // own block and with its specificity, so the light-DOM sheet's single layer cannot let the
    // variant's fine-pointer height outrank the general coarse rule (UK-06 U6).
    `@media (pointer: coarse) {\n[data-pk-platform="${p}"] {\n  --pk-kit-control-height: var(--pk-kit-control-height-coarse);\n}\n}`,
  ]).join("\n\n");
}

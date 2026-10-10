// The theme API of the elements (UI-KITS.md §3.1, §3.2): one value, set globally with
// `PolarisKey.theme({…})`, per subtree with `<pk-provider theme='…'>`, or per element with its
// `theme` property, each layer over the last. Identity resolves through ui-core's one path
// (integrator → the SDK's PresentationSource → bundle → the icon's accent → ink, §1.2): the kit
// has no discovery fetch and no icon cache of its own (owner decision, HA-13/HA-14).

import type { PresentationSource } from "@polaris-key/client-core/presentation";
import type { UiInput } from "@polaris-key/ui-core";
import {
  accentFor,
  resolveKitColors,
  resolveTheme,
  watchProductIdentity,
  type BundleProduct,
  type KitColors,
  type ResolvedIdentity,
  type ResolvedTheme,
  type Scheme,
  type ThemeOptions,
} from "@polaris-key/ui-core/theme";

/** UI-KITS.md §3.1, as the elements take it. Everything is optional. */
export interface ElementsTheme extends ThemeOptions {
  /** `theme.copy`'s locale: a BCP 47 tag; absent: the document's `lang`, then the browser's. */
  locale?: string;
  /** `theme.copy`'s overrides, per locale (`{ en: { "welcome.title": "…" } }`). */
  copy?: Partial<Record<string, Readonly<Record<string, string>>>>;
  /** `sm` = 6/10, `md` = 12/22, `lg` = 16/28 (control/card), or the control radius in px. */
  radius?: "sm" | "md" | "lg" | number;
  /** The integrator's icon, as a URL the page may load. */
  iconSrc?: string;
  /** The SDK's presentation seam (HA-12's `PresentationSource`). */
  presentation?: PresentationSource | null;
  /** What the app bundle knows about the product. */
  bundle?: BundleProduct;
}

type Listener = () => void;

let globalTheme: ElementsTheme = {};
const globalListeners = new Set<Listener>();

/** Set the theme every element starts from (`PolarisKey.theme({…})`). */
export function setTheme(theme: ElementsTheme): void {
  globalTheme = { ...theme };
  for (const l of [...globalListeners]) l();
}

export function getTheme(): ElementsTheme {
  return globalTheme;
}

export function onThemeChange(l: Listener): () => void {
  globalListeners.add(l);
  return () => globalListeners.delete(l);
}

/** Something that holds a theme for its subtree (`<pk-provider>`). */
export interface ThemeHost extends HTMLElement {
  readonly providedTheme: ElementsTheme;
  subscribeTheme(l: Listener): () => void;
}

/** The nearest `<pk-provider>` above `el`, across shadow roots. */
export function findProvider(el: Element): ThemeHost | null {
  let node: Node | null = el.parentNode;
  while (node) {
    if (
      node instanceof HTMLElement &&
      node.localName === "pk-provider" &&
      "providedTheme" in node
    )
      return node as unknown as ThemeHost;
    node =
      node instanceof ShadowRoot
        ? node.host
        : (node.parentNode ?? (node as { host?: Node }).host ?? null);
  }
  return null;
}

/** Merge theme layers: later wins, `product` and `copy` member by member. */
export function mergeThemes(
  ...layers: (ElementsTheme | undefined | null)[]
): ElementsTheme {
  const out: ElementsTheme = {};
  for (const l of layers) {
    if (!l) continue;
    const { product, copy, ...rest } = l;
    Object.assign(out, rest);
    if (product) out.product = { ...(out.product ?? {}), ...product };
    if (copy) {
      const merged: NonNullable<ElementsTheme["copy"]> = {
        ...(out.copy ?? {}),
      };
      for (const [loc, table] of Object.entries(copy))
        merged[loc] = { ...(merged[loc] ?? {}), ...(table ?? {}) };
      out.copy = merged;
    }
  }
  return out;
}

const media = (q: string): MediaQueryList | null =>
  typeof matchMedia === "function" ? matchMedia(q) : null;

/** The OS preference: dark unless it asks for light (UI-KITS.md §3.1 "dark when the OS has no
 *  preference"). */
export function osPrefersDark(): boolean {
  return media("(prefers-color-scheme: light)")?.matches !== true;
}

export function osReducedMotion(): boolean {
  return media("(prefers-reduced-motion: reduce)")?.matches === true;
}

/**
 * DL13: under `native`, `system` resolves against the ground the kit sits on. Walk up from the
 * host, across shadow roots, to the first opaque background, and read its lightness; with none,
 * the OS preference.
 */
export function groundPrefersDark(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const rgb = parseRgb(bg);
    if (rgb && rgb[3] >= 0.99) {
      const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
      const lin = (c: number) =>
        c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      return y < 0.18;
    }
    node =
      node.parentElement ??
      ((node.getRootNode() as ShadowRoot).host as Element | undefined) ??
      null;
  }
  return osPrefersDark();
}

function parseRgb(v: string): [number, number, number, number] | null {
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const parts = m[1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/** Everything an element paints with, resolved from its theme layers and the host. */
export interface Resolved {
  options: ElementsTheme;
  theme: ResolvedTheme;
  identity: ResolvedIdentity;
  /** The accent's roles for the scheme in effect; `null` under `native` with no accent (the
   *  host's `AccentColor`). */
  colors: KitColors | null;
  /** The icon to draw: the integrator's URL or the verified presentation icon's bytes. */
  iconUrl: string | null;
  locale: string;
}

/** The input a view model reads, with the identity the theme resolved (§1.2's order). */
export function inputWithIdentity(input: UiInput, r: Resolved): UiInput {
  const id = r.identity;
  return {
    ...input,
    integrator: {
      ...(input.integrator ?? {}),
      ...(id.name ? { name: id.name } : {}),
      ...(id.shortName ? { shortName: id.shortName } : {}),
      ...(id.developer ? { developer: id.developer } : {}),
      ...(r.iconUrl ? { icon: true } : {}),
    },
  };
}

const RADII = { sm: [6, 10], md: [12, 22], lg: [16, 28] } as const;

/** The custom properties the kit root carries for a resolved theme (CSP-safe: set through the
 *  CSSOM, never a style attribute string). */
export function themeVars(r: Resolved): Record<string, string> {
  const vars: Record<string, string> = {};
  const c = r.colors;
  if (c) {
    vars["--pk-accent"] = c.primary;
    vars["--pk-accent-on"] = c.onPrimary;
    vars["--pk-accent-fg"] = c.accentText;
    vars["--pk-accent-subtle"] = c.subtle;
    vars["--pk-accent-focus"] = c.focus;
  }
  const radius = r.options.radius;
  if (radius !== undefined) {
    const [control, card] =
      typeof radius === "number"
        ? [radius, Math.round(radius * 1.83)]
        : RADII[radius];
    vars["--pk-kit-radius-control"] = `${control / 16}rem`;
    vars["--pk-kit-radius-card"] = `${card / 16}rem`;
  }
  return vars;
}

/** Resolve once; `watch` re-resolves when the presentation changes or its icon decodes. */
export function resolveFor(
  host: Element,
  options: ElementsTheme,
  identity: ResolvedIdentity,
  iconUrl: string | null,
): Resolved {
  const native = options.preset === "native";
  const scheme = resolveTheme(options, {
    kit: "elements",
    prefersDark: native ? groundPrefersDark(host) : osPrefersDark(),
    reducedMotion: osReducedMotion(),
  });
  const accent = accentFor(identity, scheme.scheme as Scheme);
  const colors =
    native && accent === null
      ? null
      : resolveKitColors(accent, scheme.scheme as Scheme);
  const docLang =
    typeof document !== "undefined" ? document.documentElement.lang : "";
  const nav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return {
    options,
    theme: {
      ...scheme,
      name: identity.name || scheme.name,
      accentSource: identity.accentSource,
      icon: iconUrl || identity.icon ? "image" : "monogram",
    },
    identity,
    colors,
    iconUrl,
    locale: options.locale ?? (docLang || nav || "en"),
  };
}

/** Decode icon bytes to RGBA through a canvas, for the derived accent (§3.3). */
export async function decodeIcon(
  bytes: Uint8Array,
): Promise<ArrayLike<number> | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const size = 64;
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement("canvas"), {
            width: size,
            height: size,
          });
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
}

export { watchProductIdentity };

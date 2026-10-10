// `@polaris-key/ui-core/theme`: the one theme value of UI-KITS.md §3.1, resolved for a kit, and the
// `ProductIdentity` resolver of §1.2 over the SDK's presentation seam (plans/HA-11.md). It needs
// `@polaris-key/brand` (an optional peer: the web kits ship it already, the Node terminal does
// not import this subpath):
//
//   resolveTheme            preset, scheme, accent source, icon, density, motion, platform
//   resolveKitColors        the accent's roles through brand's `resolveAccent` for one scheme, on
//                           the brand's surfaces or (native) the host's own grounds, so a
//                           product accent can never give an unreadable primary or ring (DL13)
//   resolveProductIdentity  integrator → PresentationSource → bundle → the icon's accent → ink
//   watchProductIdentity    the same, again whenever the source changes or the icon arrives
//
// No kit fetches discovery or an icon itself: the SDK implements `PresentationSource` (HA-13) and
// the kit passes it in; with none, identity falls through to the bundle (HA-11's seam).

import type { PresentationSource } from "@polaris-key/client-core/presentation";
import {
  ACCENT_RULES,
  deriveAccent,
  resolveAccent,
  type ResolvedProductAccent,
} from "@polaris-key/brand/accent";
import { contrastRatio } from "@polaris-key/brand/color";
import { SERVICE_ACCENTS, THEME_TOKENS } from "@polaris-key/brand";

import type {
  BundleIdentity,
  IntegratorIdentity,
  Platform,
  PresentationMember,
} from "../input.js";
import type { AccentSource, ColorScheme, Kit, Preset } from "../vocabulary.js";

export type Scheme = "dark" | "light";
export type Density = "compact" | "comfortable" | "spacious";
export type Motion = "system" | "reduced" | "none";

/** UI-KITS.md §3.1: the theme a kit takes. Everything is optional. */
export interface ThemeOptions {
  preset?: Preset;
  colorScheme?: ColorScheme;
  /** `"product"` (default), `"core"` (Polaris violet), `"service"` or a colour. */
  accent?: string;
  density?: Density;
  motion?: Motion;
  ambient?: boolean;
  /** The integrator's ProductIdentity: it wins over the presentation and the bundle. */
  product?: IntegratorIdentity;
  poweredBy?: false | "line" | "badge";
  /** Web and Qt Quick kits: the platform variant to render (`auto`: the one the kit runs on). */
  platform?: "auto" | "ios" | "android" | "macos" | "windows" | "linux" | "web";
}

/** What a kit resolves a theme against. */
export interface ThemeContext {
  kit: Kit;
  /** Discovery's presentation member, as the source answered it (`null`: none). */
  presentation?: PresentationMember | null;
  bundle?: BundleIdentity;
  platform?: Platform;
  /** The host's preference when `colorScheme` is `system` (the OS, or the ground the kit sits on
   *  under `native`). Absent: dark, as when the OS has no preference. */
  prefersDark?: boolean;
  /** The OS reduced-motion setting, for `motion: "system"`. */
  reducedMotion?: boolean;
}

/** The theme's identity and look, before colours (ui-matrix.json `theme` pins these five). */
export interface ThemeSummary {
  name: string;
  accentSource: AccentSource;
  colorScheme: ColorScheme;
  icon: "image" | "monogram" | "none";
  preset: Preset;
}

export interface ResolvedTheme extends ThemeSummary {
  /** The scheme in effect: `system` resolved against the host. */
  scheme: Scheme;
  density: Density;
  /** `full`, or `reduced` (every duration 0, the shimmer still; DL16). */
  motion: "full" | "reduced";
  ambient: boolean;
  /** The platform variant the kit renders (§3.1 `platform`), `null` when nothing says. */
  platform: string | null;
}

/**
 * UI-KITS.md §1.2 and §3.4. The name: the integrator's, the presentation's, the bundle's, the
 * slug. The accent: an integrator's colour (or `core`) wins; under `native` the host's; then the
 * presentation's; then the icon's; then ink, never violet. Godot and TV default to dark and to
 * `spacious`; the terminal draws no icon.
 */
export function resolveTheme(
  options: ThemeOptions,
  ctx: ThemeContext,
): ResolvedTheme {
  const integrator: IntegratorIdentity = {
    ...(options.product ?? {}),
    ...(options.accent !== undefined &&
    options.accent !== "product" &&
    options.accent !== "service"
      ? { accent: options.accent }
      : {}),
  };
  const presentation = ctx.presentation === undefined ? null : ctx.presentation;
  const preset = options.preset ?? "polaris-key";
  const name =
    integrator.name ??
    presentation?.name ??
    ctx.bundle?.name ??
    ctx.bundle?.slug ??
    "";
  const hasIcon = integrator.icon === true || presentation?.icon === true;
  const icon = ctx.kit === "terminal" ? "none" : hasIcon ? "image" : "monogram";
  const accentSource: AccentSource =
    integrator.accent === "core"
      ? "core"
      : typeof integrator.accent === "string"
        ? "integrator"
        : preset === "native"
          ? "host"
          : typeof presentation?.accent === "string"
            ? "product"
            : hasIcon
              ? "icon"
              : "ink";
  const tvOrGame = ctx.kit === "godot" || ctx.platform?.formFactor === "tv";
  const colorScheme = options.colorScheme ?? (tvOrGame ? "dark" : "system");
  const scheme: Scheme =
    colorScheme === "system"
      ? ctx.prefersDark === false
        ? "light"
        : "dark"
      : colorScheme;
  const motion = options.motion ?? "system";
  return {
    name,
    accentSource,
    colorScheme,
    icon,
    preset,
    scheme,
    density: options.density ?? (tvOrGame ? "spacious" : "comfortable"),
    motion:
      motion === "none" || (motion === "system" && ctx.reducedMotion)
        ? "reduced"
        : motion === "reduced"
          ? "reduced"
          : "full",
    ambient: options.ambient ?? preset !== "native",
    platform:
      options.platform && options.platform !== "auto"
        ? options.platform
        : (ctx.platform?.os ?? null),
  };
}

/** The five fields ui-matrix.json's `theme` rows pin. */
export function themeSummary(t: ThemeSummary): ThemeSummary {
  return {
    name: t.name,
    accentSource: t.accentSource,
    colorScheme: t.colorScheme,
    icon: t.icon,
    preset: t.preset,
  };
}

// ── Colours ──────────────────────────────────────────────────────────────────────────────────

/** The colours a kit paints with the product's accent in one scheme (UI-KITS.md §3.3, DL13). */
export interface KitColors {
  scheme: Scheme;
  /** The one filled control (`solid`), or ink when the product has no accent. */
  primary: string;
  /** Its label: >= 4.5:1 on `primary`. */
  onPrimary: string;
  /** Accent text and glyphs (`fg`): >= 4.5:1 on every ground. */
  accentText: string;
  /** The tinted fill of a selected row. */
  subtle: string;
  /** The focus ring: the resolved accent's `focus` (>= 3:1 on every ground), never a fixed
   *  violet once a product accent is set. */
  focus: string;
  /** The grounds these were resolved against, page first. */
  grounds: readonly string[];
}

/** The brand's four surfaces of a scheme, page first. */
export function brandGrounds(scheme: Scheme): string[] {
  const s = THEME_TOKENS[scheme].surface;
  return [s.page, s.raised, s.overlay, s.sunken];
}

/**
 * The kit's colours for `accent` (a `#rrggbb`, or `null` for ink) in `scheme`, through brand's
 * `resolveAccent`. `grounds` are the surfaces the kit draws on, page first: the brand's under
 * `polaris-key`, the host's own under `native` (so a host's accent keeps its contrast there too).
 */
export function resolveKitColors(
  accent: string | null,
  scheme: Scheme,
  grounds: readonly string[] = brandGrounds(scheme),
): KitColors {
  if (accent === null) {
    // Ink: `text-strong` fill, the page as its label (UI-KITS.md §1.2 "with no icon").
    const t = THEME_TOKENS[scheme];
    return {
      scheme,
      primary: t.text.strong,
      onPrimary: t.surface.page,
      accentText: t.text.strong,
      subtle: t.surface.sunken,
      focus: t.text.strong,
      grounds,
    };
  }
  const r: ResolvedProductAccent = resolveAccent(accent, scheme, grounds);
  return {
    scheme,
    primary: r.solid,
    onPrimary: r.on,
    accentText: r.fg,
    subtle: r.subtle,
    focus: r.focus,
    grounds,
  };
}

/** Every contrast promise of `colors`: [what, ratio, the minimum]. A test and a kit's dev check
 *  read it; a value under its minimum is a bug. */
export function contrastReport(
  colors: KitColors,
): { pair: string; ratio: number; min: number }[] {
  const out: { pair: string; ratio: number; min: number }[] = [
    {
      pair: "onPrimary on primary",
      ratio: contrastRatio(colors.onPrimary, colors.primary),
      min: ACCENT_RULES.text,
    },
  ];
  for (const g of colors.grounds) {
    out.push({
      pair: `primary on ${g}`,
      ratio: contrastRatio(colors.primary, g),
      min: ACCENT_RULES.ui,
    });
    out.push({
      pair: `accentText on ${g}`,
      ratio: contrastRatio(colors.accentText, g),
      min: ACCENT_RULES.text,
    });
    out.push({
      pair: `focus on ${g}`,
      ratio: contrastRatio(colors.focus, g),
      min: ACCENT_RULES.ui,
    });
  }
  return out;
}

/** Polaris violet, only when the integrator asks for it (`accent: "core"`). */
export function coreAccent(scheme: Scheme): string {
  return SERVICE_ACCENTS[scheme].core.solid;
}

// ── ProductIdentity ──────────────────────────────────────────────────────────────────────────

/** What the bundle knows about the product (Info.plist, the manifest, package.json, Godot). */
export interface BundleProduct extends BundleIdentity {
  developer?: string;
  /** The bundle icon's pixels (RGBA bytes), for the derived accent. */
  iconRgba?: ArrayLike<number>;
}

export interface ProductIdentityOptions {
  /** The integrator's theme identity (or `theme.product`). */
  integrator?: IntegratorIdentity;
  /** `theme.accent`: `"product"`, `"core"`, `"service"` or a colour. */
  accent?: string;
  preset?: Preset;
  /** The SDK's presentation seam (HA-12's `PresentationSource`); absent until HA-13 lands. */
  source?: PresentationSource | null;
  bundle?: BundleProduct;
  /** The presentation icon's pixels (RGBA), once the kit decoded `source.icon()`'s bytes. */
  presentationIconRgba?: ArrayLike<number> | null;
}

/** Who the screens are about, and their accent per scheme. */
export interface ResolvedIdentity {
  name: string;
  /** Inline sentences use it only when the integrator set it. */
  shortName: string | null;
  developer: string | null;
  accentSource: AccentSource;
  /** The accent per scheme, before contrast resolution; `null` is ink (or the host's, native). */
  accent: { light: string | null; dark: string | null };
  /** True when an icon is drawn (else the monogram tile). */
  icon: boolean;
  deviceCodeUrl: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v: unknown): string | null =>
  typeof v === "string" && HEX.test(v) ? v.toLowerCase() : null;

/**
 * UI-KITS.md §1.2's resolution, synchronously over what is known now: the integrator, then the
 * presentation (`source.current()`), then the bundle; the accent from an explicit colour, `core`,
 * the presentation's `accent` / `accentDark`, the colour derived from the icon's pixels, then ink.
 * A broken source never breaks the kit: it reads as no presentation.
 */
export function resolveProductIdentity(
  o: ProductIdentityOptions,
): ResolvedIdentity {
  const i = o.integrator ?? {};
  let p: ReturnType<PresentationSource["current"]> = null;
  try {
    p = o.source?.current() ?? null;
  } catch {
    p = null;
  }
  const b = o.bundle;
  const name = i.name ?? p?.name ?? b?.name ?? b?.slug ?? "";
  const developer = i.developer ?? p?.developerName ?? b?.developer ?? null;
  const presentationIcon = p?.icon !== undefined;
  const icon = i.icon === true || presentationIcon || b?.iconRgba !== undefined;
  const base = {
    name,
    shortName: i.shortName ?? null,
    developer,
    icon,
    deviceCodeUrl: i.deviceCodeUrl ?? null,
  };
  const explicit =
    o.accent !== undefined && o.accent !== "product" && o.accent !== "service"
      ? o.accent
      : undefined;
  const wanted = explicit ?? i.accent;
  if (wanted === "core")
    return {
      ...base,
      accentSource: "core",
      accent: { light: coreAccent("light"), dark: coreAccent("dark") },
    };
  const light = hex(wanted) ?? (explicit ? null : hex(i.accent));
  const dark = (explicit ? hex(explicit) : hex(i.accentDark)) ?? light;
  if (light || dark)
    return {
      ...base,
      accentSource: "integrator",
      accent: { light: light ?? dark, dark: dark ?? light },
    };
  if (o.preset === "native")
    return {
      ...base,
      accentSource: "host",
      accent: { light: null, dark: null },
    };
  const pl = hex(p?.accent);
  const pd = hex(p?.accentDark);
  if (pl || pd)
    // `accentDark` in the dark scheme when set (HA-11).
    return {
      ...base,
      accentSource: "product",
      accent: { light: pl ?? pd, dark: pd ?? pl },
    };
  const pixels = o.presentationIconRgba ?? b?.iconRgba ?? null;
  if (pixels) {
    const derived = deriveAccent(pixels);
    if (derived)
      return {
        ...base,
        accentSource: "icon",
        accent: { light: derived, dark: derived },
      };
  } else if (presentationIcon)
    // The icon is known but not decoded yet: its accent arrives with its pixels.
    return {
      ...base,
      accentSource: "icon",
      accent: { light: null, dark: null },
    };
  return { ...base, accentSource: "ink", accent: { light: null, dark: null } };
}

/** The accent to resolve for `scheme`, or `null` for ink (or the host's own, native). */
export function accentFor(id: ResolvedIdentity, scheme: Scheme): string | null {
  return scheme === "dark" ? id.accent.dark : id.accent.light;
}

export interface WatchOptions extends ProductIdentityOptions {
  /** Decode the icon's bytes to RGBA (a canvas on the web). Absent: no derived accent. */
  decodeIcon?: (bytes: Uint8Array) => Promise<ArrayLike<number> | null>;
  /** The hero's size and the screen's scale, for `source.icon(px, scale)`. */
  iconPx?: number;
  iconScale?: number;
}

/**
 * Resolve now and again whenever the presentation changes or its icon decodes. Returns the
 * unsubscribe. `onChange` runs synchronously with the first resolution.
 */
export function watchProductIdentity(
  o: WatchOptions,
  onChange: (id: ResolvedIdentity) => void,
): () => void {
  let pixels: ArrayLike<number> | null = o.presentationIconRgba ?? null;
  let stopped = false;
  let generation = 0;
  const emit = () => {
    if (!stopped)
      onChange(resolveProductIdentity({ ...o, presentationIconRgba: pixels }));
  };
  const loadIcon = () => {
    const src = o.source;
    if (!src || !o.decodeIcon) return;
    const mine = ++generation;
    void src
      .icon(o.iconPx ?? 96, o.iconScale ?? 2)
      .then((bytes) => (bytes ? o.decodeIcon!(bytes) : null))
      .then((rgba) => {
        if (stopped || mine !== generation) return;
        pixels = rgba ?? null;
        emit();
      })
      .catch(() => {
        // A failed icon leaves the monogram and the accent it had: never an error state.
      });
  };
  emit();
  loadIcon();
  const unsubscribe = o.source?.subscribe(() => {
    pixels = null;
    emit();
    loadIcon();
  });
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

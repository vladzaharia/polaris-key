// The terminal kit's theme and product identity (docs/design/UI-KITS.md §1.2, §3.1–§3.4).
//
// One theme value with the §3.1 field names. What each field does in a terminal:
//
//   preset       "polaris-key" (default) draws the product chip in the product's accent;
//                "native" hands the look to the terminal: ANSI roles only (the user's palette),
//                an inverse chip, no `colors`; NO_COLOR still drops every escape.
//   colorScheme  "system" (default) follows PKEY_THEME, COLORFGBG and OSC 11; "dark" / "light"
//                pin it. It changes only the truecolor chip and the QR's polarity.
//   accent       "product" (default) resolves integrator → presentation → derived from the icon →
//                ink; "core" is Polaris violet; a hex colour is the integrator's own; "service"
//                has no section in a terminal and behaves as "product".
//   colors       per-role overrides, per scheme, as hex: `{ dark: { success: "#3fb27f" } }`. The
//                roles are the terminal's (accent, success, warning, danger, info, muted, strong,
//                link); a value is drawn only where the terminal draws truecolor, so on ANSI-16 the
//                roles keep following the user's palette, and NO_COLOR drops them with every other
//                escape. The native preset ignores them. The Python kit takes the same value.
//   density      "compact" drops the blank rail rows between steps; "spacious" keeps them.
//   motion       "reduced" / "none" stop the spinner and redraws (lines print once).
//   product      the integrator's ProductIdentity, which wins over every other source.
//   copy         `{ locale, overrides }` (§4.7).
//   poweredBy    "line" or "badge" add the Powered by line under `status` and `doctor`.
//   symbols      the terminal's restyle hook (§3.2): "unicode" (default) or "ascii".
//   serviceCues, radius, typography, ambient, platform: accepted for one theme value across kits,
//                and without effect here (a terminal has no tiles, radii, faces or ambient art).
//
// Product identity resolves in the §1.2 order: the integrator's `product`, then the SDK's
// presentation source (the client's `presentationSource()`, client-core's `PresentationSource`),
// then the bundle (`productName` and `author` in the entry's package.json), then the product slug.
// The kit never fetches discovery or an icon itself.
//
// The kit's own `{ presentation() }` seam predates HA-13 and stays as a thin adapter
// (plans/HA-13.md D1) until UK-03's terminal views import client-core's seam: `readPresentation`
// takes either shape.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  deriveAccent,
  normalizeHex,
  resolveAccent,
  type AccentScheme,
} from "./accent.js";
import type {
  PresentationSource as CorePresentationSource,
  ProductPresentation as CoreProductPresentation,
} from "@polaris-key/client-core/presentation";
import type { CopyOptions } from "./copy.js";
import type { ChipColors, RoleColors } from "./term/paint.js";

/** The product as a kit screen shows it (UI-KITS §1.2). */
export interface ProductIdentity {
  name: string;
  shortName?: string;
  developer?: string;
  /** Hex; the dark scheme uses `accentDark` when set. */
  accent?: string;
  accentDark?: string;
  /** The icon's decoded RGBA pixels, for the derived accent when no accent is set. */
  iconPixels?: ArrayLike<number>;
  /** The device-code page to show instead of the server's (UI-KITS owner decision Q8). */
  deviceCodeUrl?: string;
}

/** What the kit reads of discovery's `core.presentation` (client-core's member, HA-13). */
export interface ProductPresentation extends Partial<
  Pick<
    CoreProductPresentation,
    "name" | "developerName" | "accent" | "accentDark"
  >
> {
  /** The verified icon, decoded, when the host has it. */
  iconPixels?: ArrayLike<number>;
}

/** The kit's original seam: an object with `presentation()` (the thin adapter, D1). */
export interface LegacyPresentationSource {
  presentation():
    | ProductPresentation
    | null
    | undefined
    | Promise<ProductPresentation | null | undefined>;
}

/** What the kit reads the presentation through: client-core's seam, or the original one. */
export type PresentationSource =
  | Pick<CorePresentationSource, "current">
  | LegacyPresentationSource;

export interface PolarisKeyTerminalTheme {
  preset?: "polaris-key" | "native";
  colorScheme?: "system" | "dark" | "light";
  accent?: "product" | "core" | "service" | (string & {});
  serviceCues?: boolean;
  colors?: { dark?: RoleColors; light?: RoleColors };
  radius?: "sm" | "md" | "lg" | number;
  typography?: Record<string, unknown>;
  density?: "compact" | "comfortable" | "spacious";
  motion?: "system" | "reduced" | "none";
  ambient?: boolean;
  product?: Partial<ProductIdentity>;
  copy?: CopyOptions;
  poweredBy?: false | "line" | "badge";
  platform?: string;
  symbols?: "unicode" | "ascii";
}

/** Where the accent came from (the `theme` fixture rows' `accentSource`). */
export type AccentSource = "integrator" | "product" | "icon" | "ink" | "core";

export interface ResolvedProduct {
  name: string;
  shortName?: string;
  developer?: string;
  deviceCodeUrl?: string;
  accentSource: AccentSource;
  /** The input colour before the resolver, or null for ink. */
  accentHex: string | null;
  /** The chip in truecolor, or null (ink, or the native preset). */
  chip: ChipColors | null;
}

/** Core violet per scheme (BRAND.md; accent-vectors.json). */
const CORE_VIOLET: Record<AccentScheme, string> = {
  dark: "#9a5cff",
  light: "#7a2fff",
};

const isHex = (v: unknown): v is string =>
  typeof v === "string" && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
const hex = (v: string) => normalizeHex(v.startsWith("#") ? v : `#${v}`);

/** `djdl-studio` → `Djdl Studio`: the last resort for a name. */
export function titleizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) // ui-lint: allow terminal-uppercase initial capitals for a slug-derived name
    .trim();
}

/**
 * The bundle's identity: `productName` and `author` from the nearest package.json above the
 * entry script (Electron's convention). Empty when there is none.
 */
export function bundleIdentity(
  entry: string | undefined = process.argv[1],
): Partial<ProductIdentity> {
  if (!entry) return {};
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as {
        productName?: unknown;
        author?: unknown;
      };
      const out: Partial<ProductIdentity> = {};
      if (typeof pkg.productName === "string" && pkg.productName.trim())
        out.name = pkg.productName.trim();
      const author =
        typeof pkg.author === "string"
          ? pkg.author.replace(/\s*[<(].*$/, "").trim()
          : typeof (pkg.author as { name?: unknown })?.name === "string"
            ? (pkg.author as { name: string }).name
            : undefined;
      if (author) out.developer = author;
      return out;
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return {};
}

export interface ResolveIdentityOptions {
  theme?: PolarisKeyTerminalTheme;
  /** The SDK's presentation, already read (see `readPresentation`). */
  presentation?: ProductPresentation | null;
  bundle?: Partial<ProductIdentity>;
  /** The product slug, the name of last resort. */
  slug: string;
  scheme: AccentScheme;
}

/** Read the presentation through the seam; a failing source is treated as absent. */
export async function readPresentation(
  source: PresentationSource | null | undefined,
): Promise<ProductPresentation | null> {
  if (!source) return null;
  try {
    if ("current" in source && typeof source.current === "function")
      return source.current() ?? null;
    return (await (source as LegacyPresentationSource).presentation()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The client's presentation seam, duck-typed: `presentationSource()` (the SDK's accessor, HA-13),
 * else an object with the original `presentation()` method.
 */
export function presentationSourceOf(
  client: unknown,
): PresentationSource | null {
  const c = client as {
    presentationSource?: unknown;
    presentation?: unknown;
  } | null;
  if (c && typeof c.presentationSource === "function") {
    try {
      const s = (c.presentationSource as () => unknown).call(c) as
        | Partial<CorePresentationSource>
        | null
        | undefined;
      if (s && typeof s.current === "function")
        return s as CorePresentationSource;
    } catch {
      // A broken accessor reads as no presentation.
    }
  }
  return c && typeof c.presentation === "function"
    ? (c as unknown as LegacyPresentationSource)
    : null;
}

/** Resolve the product the kit shows, and its chip colours (UI-KITS §1.2, §3.3). */
export function resolveProduct(o: ResolveIdentityOptions): ResolvedProduct {
  const integrator = o.theme?.product ?? {};
  const p = o.presentation ?? {};
  const bundle = o.bundle ?? {};
  const name = integrator.name ?? p.name ?? bundle.name ?? titleizeSlug(o.slug);
  const developer = integrator.developer ?? p.developerName ?? bundle.developer;
  const base = {
    name,
    ...(integrator.shortName ? { shortName: integrator.shortName } : {}),
    ...(developer ? { developer } : {}),
    ...(integrator.deviceCodeUrl
      ? { deviceCodeUrl: integrator.deviceCodeUrl }
      : {}),
  };
  const choice = o.theme?.accent ?? "product";
  let source: AccentSource = "ink";
  let input: string | null = null;
  const pick = (light?: string, dark?: string) => {
    const v = o.scheme === "dark" && isHex(dark) ? dark : light;
    return isHex(v) ? hex(v) : null;
  };
  if (choice === "core") {
    source = "core";
    input = CORE_VIOLET[o.scheme];
  } else if (isHex(choice)) {
    source = "integrator";
    input = hex(choice);
  } else {
    const fromIntegrator = pick(integrator.accent, integrator.accentDark);
    const fromProduct = pick(p.accent, p.accentDark);
    const pixels = integrator.iconPixels ?? p.iconPixels;
    const derived = pixels ? deriveAccent(pixels) : null;
    if (fromIntegrator) [source, input] = ["integrator", fromIntegrator];
    else if (fromProduct) [source, input] = ["product", fromProduct];
    else if (derived) [source, input] = ["icon", derived];
  }
  const native = o.theme?.preset === "native";
  const chip =
    input && !native
      ? (({ solid, on, fg }) => ({ solid, on, fg }))(
          resolveAccent(input, o.scheme),
        )
      : null;
  return { ...base, accentSource: source, accentHex: input, chip };
}

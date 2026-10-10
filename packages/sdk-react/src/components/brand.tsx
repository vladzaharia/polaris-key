// The product identity atop the SDK's screens, and the "Powered by Polaris Key" badge.
//
//   * The identity (UI-KITS §1.2, §1.6) is the PRODUCT's, never Polaris Key's: the integrator's
//     `theme.logo`; otherwise, once `copy.productName` is set, a monogram tile (the name's
//     initial on the sunken surface); otherwise nothing. No screen shows a Polaris Key mark
//     under any branding: the gate belongs to the product behind it.
//   * The badge (BRAND.md §1.5, §7.2) is opt-in (`poweredBy` or <PoweredByPolarisKey>), the exact
//     phrase, never below its minimum, never cropped, and only on an integrator's licence,
//     account or credits surfaces. It is rendered through `@polaris-key/brand/react`, so the
//     artwork is the launch kit's own; dark means FOR dark grounds (§1.2), so its variant
//     follows the luminance of the background token actually in use.

import type { ReactNode } from "react";
import { PoweredByBadge } from "@polaris-key/brand/react";
import { relativeLuminance } from "@polaris-key/brand/color";
import { usePolarisTheme } from "../react/hooks.js";
import {
  knownProductName,
  type PolarisResolvedScheme,
  type PolarisTheme,
  type PoweredByLayout,
} from "./theme.js";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Which ground the theme's background is: "dark" or "light". A non-hex background (a
 *  `var()`, a named colour) falls back to the theme's scheme, then to dark. */
export function groundOf(theme: PolarisTheme): PolarisResolvedScheme {
  const bg = theme.tokens.background.trim();
  if (HEX.test(bg)) {
    const hex =
      bg.length === 4
        ? `#${bg[1]}${bg[1]}${bg[2]}${bg[2]}${bg[3]}${bg[3]}`
        : bg;
    // The midpoint between the kit's two grounds in contrast terms: a ground is "light" when
    // dark ink would read better on it than white ink.
    return relativeLuminance(hex) > 0.179 ? "light" : "dark";
  }
  return theme.scheme ?? "dark";
}

/** The product's monogram: its name's first letter, weight 600, on the sunken surface. It is
 *  decorative: the title beside it names the product. */
function MonogramTile(props: {
  name: string;
  size: string;
}): React.JSX.Element {
  const initial = Array.from(props.name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      data-polaris-identity="monogram"
      style={{
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        width: props.size,
        height: props.size,
        borderRadius: "var(--pk-radius)",
        border: "1px solid var(--pk-border)",
        background: "var(--pk-surface-sunken, var(--pk-surface))",
        color: "var(--pk-text-strong, var(--pk-text))",
        fontFamily: "var(--pk-font-family)",
        fontWeight: 600,
        fontSize: `calc(${props.size} * 0.45)`,
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );
}

/**
 * The product identity a gate or update screen shows above its title, at `size`: the
 * integrator's `theme.logo` (`null` for none), else a monogram tile once the product's name is
 * known, else nothing. Never a Polaris Key mark (UI-KITS §1.6).
 */
export function screenLogo(theme: PolarisTheme, size = "4rem"): ReactNode {
  if (theme.logo !== undefined) return theme.logo;
  const name = knownProductName(theme);
  return name ? <MonogramTile name={name} size={size} /> : null;
}

export interface PoweredByPolarisKeyProps {
  /** compact (app UI, the default), horizontal (footers, credits), stacked (square spots). */
  layout?: PoweredByLayout;
  /** transparent / outline on a clean ground of matching contrast; sticker on busy imagery. */
  treatment?: "transparent" | "outline" | "sticker";
  /** Which ground it sits on. Defaults to the ground of the current theme's background. */
  ground?: PolarisResolvedScheme;
  /** Rendered width in CSS px. Raised to the layout's minimum, never below it. */
  width?: number;
  className?: string;
}

/**
 * "Powered by Polaris Key", for an integrator's about/credits screen, licence screen or
 * account screen (BRAND.md §7.2). Polaris Key's own surfaces never show it. Must be rendered
 * inside a `<PolarisKeyProvider>` unless `ground` is given.
 */
export function PoweredByPolarisKey(
  props: PoweredByPolarisKeyProps,
): React.JSX.Element {
  const theme = usePolarisTheme();
  return <PoweredBy theme={theme} {...props} />;
}

/** The badge without the context lookup (the components already hold the theme). */
export function PoweredBy(
  props: PoweredByPolarisKeyProps & { theme: PolarisTheme },
): React.JSX.Element {
  const {
    theme,
    layout = "compact",
    treatment,
    ground,
    width,
    className,
  } = props;
  return (
    <div
      className={className}
      // The badge never shrinks below its minimum (BRAND.md §1.5); on a screen narrower than
      // that it scrolls rather than crop or push the page sideways.
      style={{
        display: "flex",
        justifyContent: "center",
        maxWidth: "100%",
        overflowX: "auto",
      }}
      data-polaris-powered-by={layout}
    >
      <PoweredByBadge
        layout={layout}
        treatment={treatment ?? "transparent"}
        theme={ground ?? groundOf(theme)}
        width={width}
      />
    </div>
  );
}

/** The badge a licence/account screen renders when the theme opts in, else nothing. */
export function themePoweredBy(theme: PolarisTheme): ReactNode {
  if (!theme.poweredBy) return null;
  const layout = theme.poweredBy === true ? "compact" : theme.poweredBy;
  return <PoweredBy theme={theme} layout={layout} />;
}

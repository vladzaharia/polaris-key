// The Polaris Key marks and the "Powered by Polaris Key" badge inside the SDK's UI. Both are
// opt-in (owner decision 2026-10-04): the marks appear only under `branding: "polaris-key"`,
// the badge only when the integrator sets `poweredBy` or places <PoweredByPolarisKey>. Rendered
// through `@polaris-key/brand/react` so the artwork is the launch kit's own (never redrawn) and
// the rules travel with it (docs/design/BRAND.md):
//
//   * which mark (§7.1): the Pinned K on the gate, activation and sign-in screens; the Star Cut
//     ("Polaris Key Delivery") on update screens, as identity only, never as a progress or
//     "update available" indicator;
//   * the default Pinned K has no terminal bit (§6, rule 0), so nothing here passes `bit` or
//     `signed`;
//   * dark means FOR dark grounds (§1.2): the variant follows the luminance of the background
//     token actually in use, so an integrator who re-tints the surfaces still gets legible art;
//   * the badge (§1.5, §7.2) is the exact phrase, never below its minimum, never cropped, and
//     appears only on an integrator's licence/account/credits surfaces, when they opt in.
//
// Nothing here emits an inline `style` attribute or a `<style>`/`<script>` element: the brand
// components draw with SVG presentation attributes, so the markup is CSP-safe.

import type { ReactNode } from "react";
import { PolarisMark, PoweredByBadge } from "@polaris-key/brand/react";
import { relativeLuminance } from "@polaris-key/brand/color";
import { usePolarisTheme } from "../react/hooks.js";
import type {
  PolarisResolvedScheme,
  PolarisTheme,
  PoweredByLayout,
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

/** The mark kind a screen uses: the platform ("key") or the delivery family ("delivery"). */
export type ScreenIdentity = "key" | "delivery";

/** The logo a gate/update screen renders: the integrator's `theme.logo` when set, nothing when
 *  it is `null` or the branding is neutral, and otherwise (branding "polaris-key") the design
 *  system's mark for that screen at 48 px. */
export function screenLogo(
  theme: PolarisTheme,
  identity: ScreenIdentity = "key",
): ReactNode {
  if (theme.logo !== undefined) return theme.logo;
  // Polaris Key branding is opt-in: the neutral theme shows no mark.
  if (theme.branding !== "polaris-key") return null;
  const delivery = identity === "delivery";
  return (
    <PolarisMark
      kind={delivery ? "update" : "key"}
      size={48}
      theme={groundOf(theme)}
      title={delivery ? "Polaris Key Delivery" : "Polaris Key"}
      data-polaris-mark={delivery ? "delivery" : "key"}
    />
  );
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
): JSX.Element {
  const theme = usePolarisTheme();
  return <PoweredBy theme={theme} {...props} />;
}

/** The badge without the context lookup (the components already hold the theme). */
export function PoweredBy(
  props: PoweredByPolarisKeyProps & { theme: PolarisTheme },
): JSX.Element {
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
      style={{ display: "flex", justifyContent: "center" }}
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

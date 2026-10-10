import * as React from "react";
import { resolveAccent } from "@polaris-key/brand/accent";
import type { ProductPresentation } from "../api.js";
import { useTheme } from "../components/theme.js";
import { cn } from "../lib/cn.js";
import { iconShape, letterOf, type IconShape } from "../lib/productArt.js";

export type ProductLogoSize = 24 | 32 | 40;

const SIZE: Record<ProductLogoSize, string> = {
  24: "size-6",
  32: "size-8",
  40: "size-10",
};

/** The corner mask a store applies to a full-bleed square, and the monogram tile's radius. */
const RADIUS: Record<ProductLogoSize, string> = {
  24: "rounded-md",
  32: "rounded-md",
  40: "rounded-lg",
};

const LETTER: Record<ProductLogoSize, string> = {
  24: "text-xs",
  32: "text-sm",
  40: "text-lg",
};

/**
 * A product's logo in the console (Home's product card, the Products table; owner request
 * 2026-10-06, docs/design/console-product-card/).
 *
 * With a hosted icon (`presentation.icon`, image-host URLs from the registry read), the icon at
 * the tile size: the 64 and 128 px WebP variants as a `srcset`, so a 24 to 40 px tile loads 64 px
 * at 1x and 128 px at 2x, never the original. It is drawn as the developer made it, with no frame
 * of ours: a shaped icon (transparent corners) as is, and only a full-bleed square gets the corner
 * mask a store would apply (`iconShape` reads one corner pixel, which `crossOrigin="anonymous"`
 * allows: the image host answers every origin and takes no credentials).
 *
 * With no icon, or when it fails to load, a monogram tile: the name's first letter or digit on the
 * brand's neutral tile (`surface-sunken`, `border`, `text-fg-muted`). No spinner while a first pull
 * is in flight: the tile is the same.
 *
 * Decorative: the product's name always sits beside it, so the image has an empty `alt` and the
 * tile is hidden from assistive technology.
 */
export function ProductLogo({
  name,
  presentation,
  size,
  className,
}: {
  name: string;
  presentation?: ProductPresentation | null;
  size: ProductLogoSize;
  className?: string;
}): React.ReactElement {
  const icon = presentation?.icon ?? null;
  const [failed, setFailed] = React.useState<string | null>(null);
  const [shape, setShape] = React.useState<IconShape>("shaped");
  const { theme } = useTheme();

  if (icon && failed !== icon.url) {
    const srcSet = [
      icon.w64 ? `${icon.w64} 64w` : null,
      icon.w128 ? `${icon.w128} 128w` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <img
        src={icon.w128 ?? icon.w64 ?? icon.url}
        srcSet={srcSet || undefined}
        sizes={srcSet ? `${size}px` : undefined}
        width={size}
        height={size}
        alt=""
        crossOrigin="anonymous"
        decoding="async"
        loading="lazy"
        draggable={false}
        data-logo="image"
        data-shape={shape}
        onError={() => setFailed(icon.url)}
        onLoad={(e) => setShape(iconShape(e.currentTarget))}
        className={cn(
          "shrink-0 object-contain",
          SIZE[size],
          shape === "square" && RADIUS[size],
          className,
        )}
      />
    );
  }

  // HA-12 SEAM. `presentation.accent` is not stored yet, so `accent` is always null today and the
  // tile is neutral. When HA-12 serves it, the tile takes the product's accent through the brand's
  // resolver (UI-KITS.md §3.3): its `solid` (>= 3:1 on every surface) behind its `on` letter
  // (>= 4.5:1), `accentDark` in the dark theme when set. The colours are set through CSSOM, which
  // the console's `style-src 'self'` allows.
  const accent =
    theme === "dark"
      ? (presentation?.accentDark ?? presentation?.accent ?? null)
      : (presentation?.accent ?? null);
  const tint = accent ? resolveAccent(accent, theme) : null;
  return (
    <span
      aria-hidden
      data-logo="monogram"
      style={
        tint
          ? {
              backgroundColor: tint.solid,
              color: tint.on,
              borderColor: "transparent",
            }
          : undefined
      }
      className={cn(
        "inline-grid shrink-0 select-none place-items-center border font-medium leading-none",
        SIZE[size],
        RADIUS[size],
        LETTER[size],
        !tint && "border-border bg-surface-sunken text-fg-muted",
        className,
      )}
    >
      {letterOf(name)}
    </span>
  );
}

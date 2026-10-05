import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * Product art (PORTAL.md §5.2 `ProductArt`): the listing's header art through the same-origin
 * media proxy (G1, PX-W1) when there is one, else (or when it fails to load) the flat fallback: a
 * tint field with the product's letter. No gradients. The tint is the developer's `tintColor`
 * when present, else a stable pick from a muted set by slug, so a product keeps its colour
 * everywhere.
 */
const TINTS = [
  "#3b2f63",
  "#1f4d4a",
  "#5a2d33",
  "#24435c",
  "#4d3f1d",
  "#2e3f66",
  "#45294f",
  "#2b4a2f",
] as const;

export function tintFor(slug: string, tint: string | null): string {
  if (tint) return tint;
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

export function letterOf(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u);
  return (m?.[0] ?? "?").toUpperCase();
}

/** `icon` is `ProductIcon`. */
export type ArtVariant = "banner" | "tile" | "thumb";

export function ProductArt({
  slug,
  name,
  tint,
  variant,
  src,
  className,
  children,
}: {
  slug: string;
  name: string;
  tint: string | null;
  /** A same-origin `/media/…` URL, or null for the fallback. */
  src?: string | null;
  variant: ArtVariant;
  className?: string;
  /** Overlays (the status plate) positioned inside the art. */
  children?: React.ReactNode;
}): React.ReactElement {
  const letter = letterOf(name);
  const background = tintFor(slug, tint);
  const [failed, setFailed] = React.useState(false);
  if (src && !failed) {
    return (
      <div
        data-art="image"
        style={{ backgroundColor: background }}
        className={cn("relative overflow-hidden", className)}
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
        {children}
      </div>
    );
  }
  return (
    <div
      data-art="fallback"
      style={{ backgroundColor: background }}
      className={cn("relative overflow-hidden", className)}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-1/2 top-1/2 inline-flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22%] bg-black/25 font-bold text-[#f4f1ff]",
          variant === "banner" && "size-28 text-6xl",
          variant === "tile" && "size-16 text-3xl",
          variant === "thumb" && "size-9 text-lg",
        )}
      >
        {letter}
      </span>
      {children}
    </div>
  );
}

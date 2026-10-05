import * as React from "react";
import { cn } from "../../lib/cn.js";
import { letterOf, tintFor } from "./ProductArt.js";

const SIZE: Record<number, string> = {
  20: "size-5",
  24: "size-6",
  40: "size-10",
  48: "size-12",
  64: "size-16",
  112: "size-28",
};

/** The corner mask for a full-bleed square icon and the letter tile, per size. */
const RADIUS: Record<number, string> = {
  20: "rounded-[0.3rem]",
  24: "rounded-md",
  40: "rounded-lg",
  48: "rounded-xl",
  64: "rounded-2xl",
  112: "rounded-[1.75rem]",
};

type IconShape = "shaped" | "square";

/**
 * `square` when the icon's top-left corner pixel is opaque (a full-bleed square), else `shaped`.
 * The art is same-origin (the media proxy), so reading it back is allowed; where it can't be read
 * (no canvas) the icon is left exactly as the developer drew it.
 */
export function iconShape(img: HTMLImageElement): IconShape {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "shaped";
    ctx.drawImage(img, 0, 0, 32, 32);
    return ctx.getImageData(0, 0, 1, 1).data[3]! >= 250 ? "square" : "shaped";
  } catch {
    return "shaped";
  }
}

/** The letter tile's own chrome: its radius and letter size, per size. */
const TILE: Record<number, string> = {
  20: "text-[0.625rem]",
  24: "text-xs",
  40: "text-base",
  48: "text-lg",
  64: "text-2xl",
  112: "text-5xl",
};

/**
 * The product icon: the listing icon through the media proxy (G1), else tint and letter.
 *
 * An icon image is drawn edge to edge at the size, with no background, border, ring or padding
 * of ours: the developer's own shape is the frame, so a shaped icon (a macOS squircle with
 * transparent corners) is never a squircle inside a rounded box. A full-bleed square icon (opaque
 * corners, as iOS and Android icons are authored) gets the corner mask a store applies to it, and
 * nothing else; `iconShape` reads one corner pixel once the image loads. Only the letter fallback
 * is a tile, with its tint, radius and whatever `tileClassName` adds (the ring that cuts
 * it out of the art). `lift` sets it off art it overlaps: a soft drop shadow that follows the
 * image's own alpha, or the tile's elevation.
 */
export function ProductIcon({
  slug,
  name,
  tint,
  size,
  src,
  lift = false,
  className,
  tileClassName,
}: {
  slug: string;
  name: string;
  tint: string | null;
  /** A same-origin `/media/…` URL, or null for the fallback. */
  src?: string | null;
  size: 20 | 24 | 40 | 48 | 64 | 112;
  /** Over art: a drop shadow on the image, elevation on the tile. */
  lift?: boolean;
  /** Layout (position, margins, size overrides): both the image and the tile. */
  className?: string;
  /** Chrome for the letter tile only (a ring in the surface colour). */
  tileClassName?: string;
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  const [shape, setShape] = React.useState<IconShape>("shaped");
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        data-art="image"
        decoding="async"
        onError={() => setFailed(true)}
        onLoad={(e) => setShape(iconShape(e.currentTarget))}
        data-shape={shape}
        className={cn(
          "shrink-0 object-contain",
          SIZE[size],
          shape === "square" && RADIUS[size],
          lift && "drop-shadow-[0_6px_14px_rgb(0_0_0/0.35)]",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-art="fallback"
      style={{ backgroundColor: tintFor(slug, tint) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold text-[#f4f1ff]",
        SIZE[size],
        TILE[size],
        RADIUS[size],
        lift && "shadow-elevation-2",
        tileClassName,
        className,
      )}
    >
      {letterOf(name)}
    </span>
  );
}

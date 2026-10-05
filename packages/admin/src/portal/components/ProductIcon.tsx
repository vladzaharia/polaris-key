import * as React from "react";
import { cn } from "../../lib/cn.js";
import { letterOf, tintFor } from "./ProductArt.js";

/** The product icon: the listing icon through the media proxy (G1), else tint and letter. */
export function ProductIcon({
  slug,
  name,
  tint,
  size,
  src,
  className,
}: {
  slug: string;
  name: string;
  tint: string | null;
  /** A same-origin `/media/…` URL, or null for the fallback. */
  src?: string | null;
  size: 20 | 24 | 40 | 48 | 64 | 112;
  className?: string;
}): React.ReactElement {
  const sizes: Record<number, string> = {
    20: "size-5 text-[0.625rem] rounded-[0.3rem]",
    24: "size-6 text-xs rounded-md",
    40: "size-10 text-base rounded-lg",
    48: "size-12 text-lg rounded-xl",
    64: "size-16 text-2xl rounded-2xl",
    112: "size-28 text-5xl rounded-[1.75rem]",
  };
  const [failed, setFailed] = React.useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        data-art="image"
        decoding="async"
        onError={() => setFailed(true)}
        style={{ backgroundColor: tintFor(slug, tint) }}
        className={cn("shrink-0 object-cover", sizes[size], className)}
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
        sizes[size],
        className,
      )}
    >
      {letterOf(name)}
    </span>
  );
}

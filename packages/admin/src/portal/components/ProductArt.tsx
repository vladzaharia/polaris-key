import * as React from "react";
import { cn } from "../../lib/cn.js";
import { letterOf } from "../../lib/productArt.js";

/**
 * Product art (PORTAL.md §5.2 `ProductArt`): the listing's header art through the same-origin
 * media proxy (G1, PX-W1) when there is one, else (or when it fails to load) the flat fallback: a
 * tint field with the product's letter (or a bare tint field with `letter={false}`, where an icon
 * already stands in front of the art). No gradients. The tint is the developer's `tintColor`
 * when present, else a stable pick from a muted set by slug, so a product keeps its colour
 * everywhere.
 *
 * The image fades in once it is decoded (`.pk-img-in` in src/motion.css; MO-07): the tint field
 * holds the box at its aspect meanwhile, so nothing shifts, and an image that was already decoded
 * (a cached one, a return to the page) shows at once. Under reduced motion it is an instant swap.
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

export { letterOf };

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
  onError,
  letter: showLetter = true,
  liftArt = false,
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
  /** Told when the image fails to load (the fallback then renders). */
  onError?: () => void;
  /** The fallback's letter; off where the product's icon (or its letter tile) sits on the art. */
  letter?: boolean;
  /** Inside a `.pk-lift` card: the image scales a little while the card is hovered. */
  liftArt?: boolean;
}): React.ReactElement {
  const letter = letterOf(name);
  const background = tintFor(slug, tint);
  const [failed, setFailed] = React.useState(false);
  // The `src` whose image is decoded and showing; keyed by URL, so new art fades in again.
  const [loaded, setLoaded] = React.useState<string | null>(null);
  const img = React.useRef<HTMLImageElement>(null);
  // Already decoded (from the memory cache): show it before the first paint, without a fade.
  React.useLayoutEffect(() => {
    const el = img.current;
    if (src && el?.complete && el.naturalWidth > 0) setLoaded(src);
  }, [src]);
  if (src && !failed) {
    return (
      <div
        data-art="image"
        style={{ backgroundColor: background }}
        className={cn("relative overflow-hidden", className)}
      >
        <img
          ref={img}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded === src ? "" : undefined}
          onLoad={(e) => {
            // Fade in once decoded, so the fade never starts on an image not yet painted.
            const el = e.currentTarget;
            const show = (): void => setLoaded(src);
            if (typeof el.decode === "function") el.decode().then(show, show);
            else show();
          }}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
          className={cn(
            "pk-img-in absolute inset-0 size-full object-cover",
            liftArt && "pk-lift-art",
          )}
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
      {showLetter ? (
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
      ) : null}
      {children}
    </div>
  );
}

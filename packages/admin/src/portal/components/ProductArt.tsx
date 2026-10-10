import * as React from "react";
import { cn } from "../../lib/cn.js";
import { letterOf } from "../../lib/productArt.js";
import { variantUrl } from "../model/artVariant.js";

/**
 * Product art (PORTAL.md §5.2 `ProductArt`): the product's hosted header art on the image host
 * (HA-07; the same-origin media proxy in HA-10's rollback, G1, PX-W1) when there is one, else (or
 * when it fails to load) the flat fallback: a
 * tint field with the product's letter (or a bare tint field with `letter={false}`, where an icon
 * already stands in front of the art). No gradients. The tint is the developer's `tintColor`
 * when present, else a stable pick from a muted set by slug, so a product keeps its colour
 * everywhere.
 *
 * The hosted width follows the drawn size: the narrowest ladder rung at least as wide as the box
 * times devicePixelRatio (`model/artVariant.ts`), never a tile variant stretched into a banner.
 * The widest rung chosen so far is kept, so a window resized back down does not fetch again. A rung
 * the host does not have (a small original) falls back to the URL as given before the fallback.
 *
 * `fit="contain"`: the whole art is shown, uncropped, over a blurred cover copy of itself that
 * fills the rest of the box (a box that is not the art's 16:9). Nothing is drawn over the art.
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
  fit = "cover",
}: {
  slug: string;
  name: string;
  tint: string | null;
  /** An image-host URL (or a same-origin `/media/…` one), or null for the fallback. */
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
  /** `contain`: uncropped over a blurred cover copy (a box wider or taller than the art's 16:9). */
  fit?: "cover" | "contain";
}): React.ReactElement {
  const letter = letterOf(name);
  const background = tintFor(slug, tint);
  const [failed, setFailed] = React.useState(false);
  // The `src` whose image is decoded and showing; keyed by URL, so new art fades in again.
  const [loaded, setLoaded] = React.useState<string | null>(null);
  const img = React.useRef<HTMLImageElement>(null);
  const box = React.useRef<HTMLDivElement>(null);
  // The widest drawn size seen (CSS px): the rung is chosen from it, and only ever goes up.
  const [drawn, setDrawn] = React.useState(0);
  // The box is measured before the first image request, so a rung is never fetched and replaced.
  const [measured, setMeasured] = React.useState(false);
  const [asIs, setAsIs] = React.useState<string | null>(null);
  React.useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      setDrawn((d) => (w > d ? Math.ceil(w) : d));
      setMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [src]);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const shown =
    !src || !measured
      ? null
      : asIs !== src && drawn > 0
        ? variantUrl(src, drawn, dpr)
        : src;
  // Already decoded (from the memory cache): show it before the first paint, without a fade.
  React.useLayoutEffect(() => {
    const el = img.current;
    if (shown && el?.complete && el.naturalWidth > 0) setLoaded(shown);
  }, [shown]);
  if (src && !failed) {
    const img_ = (cover: boolean): React.ReactElement | null =>
      !shown ? null : (
        <img
          ref={cover ? undefined : img}
          src={shown}
          alt=""
          loading="lazy"
          decoding="async"
          aria-hidden={cover ? true : undefined}
          data-loaded={cover || loaded === shown ? "" : undefined}
          data-blur={cover && fit === "contain" ? "" : undefined}
          onLoad={
            cover
              ? undefined
              : (e) => {
                  // Fade in once decoded, so the fade never starts on an image not yet painted.
                  const el = e.currentTarget;
                  const show = (): void => setLoaded(shown);
                  if (typeof el.decode === "function")
                    el.decode().then(show, show);
                  else show();
                }
          }
          onError={
            cover
              ? undefined
              : () => {
                  // A rung the host lacks: the URL as given once, then the fallback.
                  if (shown !== src) return setAsIs(src);
                  setFailed(true);
                  onError?.();
                }
          }
          className={cn(
            cover
              ? "absolute inset-0 size-full scale-110 object-cover blur-2xl"
              : cn(
                  "pk-img-in absolute inset-0 size-full",
                  fit === "contain" ? "object-contain" : "object-cover",
                  liftArt && "pk-lift-art",
                ),
          )}
        />
      );
    return (
      <div
        ref={box}
        data-art="image"
        style={{ backgroundColor: background }}
        className={cn("relative overflow-hidden", className)}
      >
        {fit === "contain" ? img_(true) : null}
        {img_(false)}
        {children}
      </div>
    );
  }
  return (
    <div
      ref={box}
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

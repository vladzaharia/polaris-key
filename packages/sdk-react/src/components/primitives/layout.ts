// Container-keyed layout for the kit's full-window screens, without a stylesheet.
//
// The components style themselves through React's `style` prop (applied through the CSSOM, so a
// page needs no `style-src 'unsafe-inline'`), and a style prop cannot hold a media or container
// query. Most of the kit's responsiveness is intrinsic (wrapping rows, `min()` widths, padding
// in percent of the containing block, which is the container's width). The one discrete switch,
// a blocking screen going full-bleed on a narrow window, is a container query run in script: the
// full-window backdrop measures itself with a ResizeObserver and publishes its layout to the
// cards inside it. The thresholds are in rem, so a larger default font reaches the compact
// layout sooner, which is what text at that size needs.
//
// UK-05 replaces this with the shared stylesheet's `@container` rules.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type RefCallback,
} from "react";

/** Below this inline size (35rem: 560 px at a 16 px root) a full-window screen's card goes
 *  full-bleed: no inset, no border, its actions docked at the bottom. */
export const BLEED_BELOW_REM = 35;

/** Below this block size (30rem: 480 px; a phone on its side, a laptop at 200 % zoom) a
 *  full-window screen is short: its card is capped at the window's height and scrolls inside. */
export const SHORT_BELOW_REM = 30;

/** An element's border-box size in rem of the root font. `0` means not measured yet (a server
 *  render, or a DOM with no layout such as jsdom). */
export interface RemSize {
  width: number;
  height: number;
}

/** How a full-window screen lays its card out. */
export interface WindowLayout {
  /** The card fills the window: no inset, no border or radius, actions docked. */
  bleed: boolean;
  /** The window is short: the card never grows past it. */
  short: boolean;
}

export const REGULAR_LAYOUT: WindowLayout = { bleed: false, short: false };

/** A layout effect in the browser (it runs before paint); a plain effect on a server render,
 *  where React warns about layout effects and neither runs. */
export const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function rootFontPx(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function")
    return 16;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 16;
}

/**
 * The element's size in rem, kept current by a ResizeObserver (a window `resize` listener where
 * there is none). Measured in a layout effect, so a client render never paints the wrong layout
 * first.
 */
export function useRemSize<T extends HTMLElement>(): [RefCallback<T>, RemSize] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState<RemSize>({ width: 0, height: 0 });
  useIsomorphicLayoutEffect(() => {
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      const rem = rootFontPx();
      const width = rect.width / rem;
      const height = rect.height / rem;
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    if (typeof window === "undefined") return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [el]);
  return [setEl, size];
}

/** The layout a full-window screen of this size takes. Unmeasured is the regular layout. */
export function windowLayoutOf(size: RemSize): WindowLayout {
  if (size.width <= 0) return REGULAR_LAYOUT;
  return {
    bleed: size.width < BLEED_BELOW_REM,
    short: size.height > 0 && size.height < SHORT_BELOW_REM,
  };
}

/** Published by a full-window screen to the card inside it; `null` outside one. */
export const WindowLayoutContext = createContext<WindowLayout | null>(null);

/** The layout of the full-window screen this component sits in, or `null` when it is embedded
 *  in the host's own page. */
export function useWindowLayout(): WindowLayout | null {
  return useContext(WindowLayoutContext);
}

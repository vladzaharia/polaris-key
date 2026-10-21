import * as React from "react";

/**
 * An element's rendered width in px, kept current with a ResizeObserver; 0 until measured (and
 * where there is no ResizeObserver, as in jsdom).
 */
export function useElementWidth(
  ref: React.RefObject<HTMLElement | null>,
): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(() =>
      setWidth(el.getBoundingClientRect().width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

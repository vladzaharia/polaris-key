import * as React from "react";

/**
 * Does the tab bar have tabs scrolled out of view to its right? The bar fades at that edge to
 * say so. Returns the ref to put on the bar and the flag.
 */
export function useMoreTabs(
  count: number,
): [React.RefObject<HTMLElement | null>, boolean] {
  const ref = React.useRef<HTMLElement>(null);
  const [more, setMore] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void =>
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    // The current tab is never off-screen or under the fade.
    el.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [count]);
  return [ref, more];
}

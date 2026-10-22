import * as React from "react";

/**
 * How many open popups made each element inert. An element goes back only when the last popup
 * that inerted it closes, in any order; one that was inert before any popup opened is never
 * touched (it has no entry here).
 */
const inerted = new Map<HTMLElement, number>();

/**
 * While a menu or a select is open, everything outside its portal is `inert` (P1). Radix hides
 * the rest of the page from assistive tech with `aria-hidden` but leaves it focusable, which axe
 * rightly calls `aria-hidden-focus`; `inert` takes it out of the tab order and the pointer too,
 * so the hidden page and the focus agree. Returns a ref callback for the popup's content (React
 * 19: it returns its own cleanup); the cleanup undoes exactly what it set when the popup closes.
 */
export function useInertOutside<T extends HTMLElement>(
  forwarded?: React.Ref<T>,
): React.RefCallback<T> {
  const forwardedRef = React.useRef(forwarded);
  forwardedRef.current = forwarded;
  return React.useCallback((node: T | null) => {
    const f = forwardedRef.current;
    const give = (v: T | null): void => {
      if (typeof f === "function") f(v);
      else if (f) (f as React.RefObject<T | null>).current = v;
    };
    give(node);
    if (!node) return;
    const set: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement) || el.contains(node)) continue;
      if (["SCRIPT", "STYLE", "LINK"].includes(el.tagName)) continue;
      const n = inerted.get(el);
      if (n === undefined) {
        if (el.hasAttribute("inert")) continue;
        el.setAttribute("inert", "");
      }
      inerted.set(el, (n ?? 0) + 1);
      set.push(el);
    }
    return () => {
      for (const el of set) {
        const n = (inerted.get(el) ?? 1) - 1;
        if (n > 0) inerted.set(el, n);
        else {
          inerted.delete(el);
          el.removeAttribute("inert");
        }
      }
      give(null);
    };
  }, []);
}

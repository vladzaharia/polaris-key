import * as React from "react";

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
      if (el.hasAttribute("inert")) continue;
      if (["SCRIPT", "STYLE", "LINK"].includes(el.tagName)) continue;
      el.setAttribute("inert", "");
      set.push(el);
    }
    return () => {
      for (const el of set) el.removeAttribute("inert");
      give(null);
    };
  }, []);
}

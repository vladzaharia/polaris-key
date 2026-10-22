import * as React from "react";

/**
 * Marks the document with `attr` while the root font is at least 1.5 times the default (24 px):
 * the styles' variants keyed on it answer to it. A rem media query answers to the browser's own
 * text setting but not to a page that sets the root size itself; this follows both. Re-read on
 * resize and when the root's style changes.
 */
export function useLargeTextFlag(attr = "data-large-text"): void {
  React.useEffect(() => {
    const root = document.documentElement;
    const apply = (): void => {
      const px = parseFloat(getComputedStyle(root).fontSize);
      if (px >= 24) root.setAttribute(attr, "");
      else root.removeAttribute(attr);
    };
    apply();
    window.addEventListener("resize", apply);
    const mo = new MutationObserver(apply);
    mo.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      window.removeEventListener("resize", apply);
      mo.disconnect();
      root.removeAttribute(attr);
    };
  }, [attr]);
}

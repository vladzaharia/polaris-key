// The keyboard focus ring (BRAND.md §7.4): 2 px solid `--pk-ring` (violet in the brand) with a
// 2 px offset, on `:focus-visible` only, so a pointer click does not paint a ring but keyboard
// focus always does (WCAG 2.4.7, 2.4.11).
//
// The components style themselves through React's `style` prop (applied through the CSSOM, so
// it needs no `style-src 'unsafe-inline'`), and a style prop cannot express `:focus-visible`.
// So the primitive asks the element on focus whether it matches `:focus-visible` and paints the
// ring itself. A browser that cannot answer gets the ring on every focus: visible beats tidy.

import { useState, type CSSProperties, type FocusEvent } from "react";

export const focusRing: CSSProperties = {
  outline: "2px solid var(--pk-ring)",
  outlineOffset: "2px",
};

const noRing: CSSProperties = { outline: "none" };

function matchesFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface FocusRing {
  style: CSSProperties;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export function useFocusRing(): FocusRing {
  const [visible, setVisible] = useState(false);
  return {
    style: visible ? focusRing : noRing,
    onFocus: (e) => setVisible(matchesFocusVisible(e.currentTarget)),
    onBlur: () => setVisible(false),
  };
}

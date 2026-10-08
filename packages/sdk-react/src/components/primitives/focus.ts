// The keyboard focus ring (BRAND.md §7.4): 2 px solid `--pk-ring` (violet in the brand) with a
// 2 px offset, on keyboard focus only, so a pointer click, and the focus a screen moves to its
// primary action on a cold start, paint no ring, while keyboard focus always does (WCAG 2.4.7,
// 2.4.11).
//
// The components style themselves through React's `style` prop (applied through the CSSOM, so
// it needs no `style-src 'unsafe-inline'`), and a style prop cannot express `:focus-visible`.
// So the primitive tracks the input modality itself: a key press since the page loaded (or since
// the last pointer press) makes focus "keyboard" focus; a pointer press resets it. The element's
// own `:focus-visible` must agree, where the browser can answer.

import { useState, type CSSProperties, type FocusEvent } from "react";

export const focusRing: CSSProperties = {
  outline: "2px solid var(--pk-ring)",
  outlineOffset: "2px",
};

const noRing: CSSProperties = { outline: "none" };

let keyboard = false;
let tracking = false;

function track(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboard = true;
    },
    true,
  );
  const pointer = (): void => {
    keyboard = false;
  };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("mousedown", pointer, true);
}

/** Whether the last input was the keyboard. */
export function keyboardModality(): boolean {
  track();
  return keyboard;
}

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
  track();
  const [visible, setVisible] = useState(false);
  return {
    style: visible ? focusRing : noRing,
    onFocus: (e) =>
      setVisible(keyboard && matchesFocusVisible(e.currentTarget)),
    onBlur: () => setVisible(false),
  };
}

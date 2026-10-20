/** Small DOM helpers of the New product wizard (focus and settling). */

import * as React from "react";

export const focusField = (name: string): void => {
  window.setTimeout(
    () =>
      document
        .querySelector<HTMLElement>(`[data-field-name="${name}"]`)
        ?.focus(),
    0,
  );
};

/** A value that follows `value` after `ms` (the slug check and the repository search). */
export function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Move focus to an element that is not tabbable on its own, once it is on screen. */
export const focusSoon = (el: () => HTMLElement | null): void => {
  window.setTimeout(() => el()?.focus({ preventScroll: false }), 0);
};

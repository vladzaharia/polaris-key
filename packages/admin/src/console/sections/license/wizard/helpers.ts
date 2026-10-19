/** New license (LX-29): focus and error helpers of the wizard. */

import { ApiError } from "../../../../api.js";
import type { StepId } from "./draft.js";

export const STEP_TITLES: Record<StepId, string> = {
  tier: "Choose a tier",
  holder: "Who it's for",
  limits: "Limits",
  delivery: "Delivery",
  review: "Review",
};

/** With the opener gone (palette, deep link, reload) focus goes to the page's h1. */
export function focusPageTitle(): void {
  window.setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest("[data-wizard]")) return;
    const h1 = document.querySelector<HTMLElement>(
      "[data-page-title], main h1",
    );
    if (!h1) return;
    if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
  }, 80);
}

/** The step heading of the open wizard: where focus goes when the button that had it is gone. */
export function focusHeading(): void {
  window.setTimeout(
    () =>
      document
        .querySelector<HTMLElement>('[data-wizard="drawer"] h2[tabindex="-1"]')
        ?.focus({ preventScroll: true }),
    0,
  );
}

/** Whether another try could help: a server or network failure, not a refusal. */
export const retryable = (e: unknown): boolean =>
  !(e instanceof ApiError) || e.status >= 500;

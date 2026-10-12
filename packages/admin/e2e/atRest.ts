import type { Page } from "playwright";

/**
 * Wait until a page is at rest: nothing is animating and no View Transition is in flight.
 * `html[data-vt]` is set before a transition starts and cleared when it finishes; a View
 * Transition's pseudo-element animations only exist from its ready phase, so "no animations" alone
 * also holds in the gap between the DOM swap and the first frame of the transition, which widens on
 * a loaded runner. The wait throws when the page is not at rest within `timeout`, so a stuck
 * animation fails here by name rather than as a mismatch in the assertion after it.
 */
export async function atRest(page: Page, timeout = 8000): Promise<void> {
  await page.waitForFunction(
    () =>
      !document.documentElement.hasAttribute("data-vt") &&
      document.getAnimations().length === 0,
    null,
    { timeout },
  );
}

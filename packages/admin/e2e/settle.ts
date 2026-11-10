import type { Page } from "playwright";

/**
 * Waits for the page to be at rest, in the page's own terms (frames, fonts, scroll), not wall
 * clock: a slow machine takes more frames, never fewer checks. Each helper returns once the
 * condition holds and has no time cap of its own; the test's timeout is the only bound.
 */

/** Two animation frames: layout and paint of everything queued before the call have run. */
export const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++)
      await new Promise((r) => requestAnimationFrame(r));
  }, n);

/**
 * The focused element has stopped moving: its top is the same across 2 consecutive frames. A Tab
 * scrolls the focus into view, and a measurement taken before that scroll (and the sticky chrome's
 * own layout) has settled reads a position the user never sees. Resolves at once when nothing is
 * focused.
 */
export const focusStable = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const top = () => document.activeElement?.getBoundingClientRect().top;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let prev = top();
    let still = 0;
    while (still < 2) {
      await frame();
      const now = top();
      still = now === prev ? still + 1 : 0;
      prev = now;
    }
  });

/** Web fonts are loaded and two frames have run on them. */
export const fontsAndFrames = (page: Page): Promise<void> =>
  page
    .evaluate(() => document.fonts.ready.then(() => undefined))
    .then(() => frames(page));

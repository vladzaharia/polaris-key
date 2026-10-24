import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { atRest } from "./atRest.js";

/**
 * Frame strips for review (MO-13.2). With `PK_SHOTS_DIR` set, `frameStrip` slows every animation to
 * ×0.1 over the DevTools protocol, runs `act`, and saves one screenshot per offset to
 * `$PK_SHOTS_DIR/<name>-<theme>-<n>.png` (n from 1). Without it the call does nothing, so a suite
 * can call it unconditionally. One helper for every motion suite: the playback-rate loop used to be
 * copied three times.
 */

/** Where strips are written; unset means "no strips". */
export const SHOTS = process.env.PK_SHOTS_DIR;

/** Ms after `act` for each of the six frames (dataMotion's original offsets, at ×0.1 playback). */
export const STRIP_OFFSETS = [30, 600, 1200, 1800, 2600, 3600];

/** `frames` offsets `every` ms apart, the first at 0: the shape the older per-suite strips took. */
export const evenOffsets = (frames: number, every: number): number[] =>
  Array.from({ length: frames }, (_, i) => i * every);

export interface StripOptions {
  /** The label in the file name: "dark", "light" or "reduced". Default: the page's colour scheme. */
  theme?: string;
  /** Ms after `act` for each frame, ascending. Default: STRIP_OFFSETS. */
  offsets?: number[];
  /** Wait for the page to be at rest before and after (default true). */
  rest?: boolean;
}

export async function frameStrip(
  page: Page,
  name: string,
  act: () => Promise<void>,
  options: StripOptions = {},
): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const offsets = options.offsets ?? STRIP_OFFSETS;
  const theme =
    options.theme ??
    (await page.evaluate(() =>
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    ));
  const rest = options.rest ?? true;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Animation.enable");
    if (rest) await atRest(page);
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
    await act();
    let last = 0;
    for (const [i, ms] of offsets.entries()) {
      if (ms > last) await page.waitForTimeout(ms - last);
      last = ms;
      await page.screenshot({
        path: `${SHOTS}/${name}-${theme}-${i + 1}.png`,
      });
    }
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    if (rest) await atRest(page, 6000);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

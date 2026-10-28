// @pkey-feature ui.kit identity.link
//
// The link offer's three steps in real Chromium (I-46.13): link-offer, link-done and link-conflict,
// inline and as the sheet over the app, at 390 and 1440 in dark and light. Every render: axe
// (WCAG 2.x A and AA) finds nothing and nothing scrolls sideways.
//
// PKEY_KIT_SHOTS=<dir> writes each render to <dir>/elements.link.<name>/<size>-<scheme>.png.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import type { PkSignIn } from "../../src/index.js";
import { axeViolations, fixtureTheme, inputRow } from "./support.js";

declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

const shoot = (file: string): Promise<void> =>
  (commands as unknown as Record<string, (f: string) => Promise<void>>)
    .kitShot!(file);

const VIEWPORTS: [string, number, number][] = [
  ["390", 390, 844],
  ["1440", 1440, 900],
];

beforeAll(() => fixtureTheme(__PKEY_FONTS__));
afterEach(() => document.body.replaceChildren());

/** [id, ui-matrix row, the control the step must show] */
const STEPS: [string, string, string][] = [
  [
    "offer",
    "SignIn/link-offer: Google shared across apps",
    "signin.linkOffer.primary",
  ],
  [
    "offer-developer",
    "SignIn/link-offer: Google per developer",
    "signin.linkOffer.primary",
  ],
  ["done", "SignIn/link-done", "common.continue"],
  ["conflict", "SignIn/link-conflict", "signin.linkOffer.join"],
];

async function draw(
  row: string,
  dark: boolean,
  sheet: boolean,
): Promise<PkSignIn> {
  const el = document.createElement("pk-sign-in") as PkSignIn;
  el.colorScheme = dark ? "dark" : "light";
  el.input = inputRow(sheet ? `${row} (sheet)` : row);
  if (sheet) Object.assign(el, { presentation: "sheet", open: true });
  else el.fill = true;
  document.body.style.background = dark ? "#060912" : "#f6f8ff";
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  // Settled: no step entrance still running, so axe reads the final colours.
  const running = () =>
    el.shadowRoot!.getAnimations().some((a) => a.playState === "running");
  for (let frames = 0; frames < 90 && (frames < 3 || running()); frames += 1)
    await new Promise((next) => requestAnimationFrame(next));
  return el;
}

describe("the link offer in the elements", () => {
  for (const [label, width, height] of VIEWPORTS)
    for (const dark of [true, false])
      for (const sheet of [false, true])
        it.each(STEPS)(
          `%s${sheet ? " (sheet)" : ""} at ${label} ${dark ? "dark" : "light"}`,
          async (id, row, has) => {
            await page.viewport(width, height);
            const el = await draw(row, dark, sheet);
            expect(
              el.shadowRoot!.querySelector(`[data-key="${has}"]`),
            ).not.toBeNull();
            expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
              width,
            );
            expect(await axeViolations(el)).toEqual([]);
            if (__PKEY_KIT_SHOTS__)
              await shoot(
                `${__PKEY_KIT_SHOTS__}/elements.link.${id}${sheet ? "-sheet" : ""}/${label}-${dark ? "dark" : "light"}.png`,
              );
          },
        );
});

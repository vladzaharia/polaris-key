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

declare module "vitest/browser" {
  interface BrowserCommands {
    kitShot: (file: string) => Promise<void>;
  }
}
declare const __PKEY_KIT_SHOTS__: string;
declare const __PKEY_FONTS__: string;

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["dark", "light"] as const;

beforeAll(() => {
  fixtureTheme(__PKEY_FONTS__);
});
afterEach(() => {
  document.body.replaceChildren();
});

const SCENES = [
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
] as const;

async function draw(
  row: string,
  scheme: "dark" | "light",
  sheet: boolean,
): Promise<PkSignIn> {
  const el = document.createElement("pk-sign-in") as PkSignIn;
  el.colorScheme = scheme;
  el.input = inputRow(sheet ? `${row} (sheet)` : row);
  if (sheet) {
    el.presentation = "sheet";
    el.open = true;
  } else el.fill = true;
  document.body.style.background = scheme === "dark" ? "#060912" : "#f6f8ff";
  document.body.replaceChildren(el);
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;
  }
  await document.fonts.ready;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  // The step's entrance runs to its end before axe measures colours.
  await Promise.all(
    el
      .shadowRoot!.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  );
  return el;
}

describe("the link offer in the elements", () => {
  for (const size of SIZES)
    for (const scheme of SCHEMES)
      for (const sheet of [false, true])
        it.each(SCENES.map((s) => [...s] as const))(
          `%s${sheet ? " (sheet)" : ""} at ${size.label} ${scheme}`,
          async (id, row, has) => {
            await page.viewport(size.width, size.height);
            const el = await draw(row, scheme, sheet);
            expect(
              el.shadowRoot!.querySelector(`[data-key="${has}"]`),
              has,
            ).not.toBeNull();
            expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
              size.width,
            );
            expect(await axeViolations(el)).toEqual([]);
            if (__PKEY_KIT_SHOTS__)
              await commands.kitShot(
                `${__PKEY_KIT_SHOTS__}/elements.link.${id}${sheet ? "-sheet" : ""}/${size.label}-${scheme}.png`,
              );
          },
        );
});

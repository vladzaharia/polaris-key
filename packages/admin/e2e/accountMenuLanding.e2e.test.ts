import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { h1, startPortal, type PortalHarness } from "./portalHarness.js";

/**
 * The header account menu's links to a section ("Sign-in methods", "Appearance") land on that
 * section (P0-34.5): the page swaps at once, so the menu must not hand focus back to its trigger
 * afterwards (its focus() would scroll the page back to the top). By pointer and by keyboard, at
 * a desktop and a phone width.
 */

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

const SECTIONS = [
  { item: "Appearance", id: "section-appearance" },
  { item: "Sign-in methods", id: "section-methods" },
] as const;

async function onScreen(page: Page, id: string): Promise<boolean> {
  return page.evaluate((sectionId) => {
    const el = document.getElementById(sectionId);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  }, id);
}

for (const width of [1440, 390]) {
  for (const how of ["pointer", "keyboard"] as const) {
    describe(`account menu → a section, by ${how} at ${width}`, () => {
      for (const { item, id } of SECTIONS) {
        it(`${item} lands on its section`, async () => {
          const o = await portal.open("three", "/#/", {
            width,
            height: width === 390 ? 844 : 900,
          });
          try {
            await h1(o.page, "Your library");
            const trigger = o.page
              .getByRole("banner")
              .getByRole("button", { name: /^Account:/ });
            await trigger.click();
            const entry = o.page.getByRole("menuitem", { name: item });
            if (how === "pointer") await entry.click();
            else {
              await entry.focus();
              await o.page.keyboard.press("Enter");
            }
            await h1(o.page, "Account");
            await o.page.waitForTimeout(400);
            await expect.poll(() => onScreen(o.page, id)).toBe(true);
            expect(await o.violations()).toEqual([]);
          } finally {
            await o.close();
          }
        });
      }
    });
  }
}

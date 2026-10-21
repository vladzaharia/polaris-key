import { afterAll, beforeAll, describe, it } from "vitest";
import type { Page } from "playwright";
import {
  axe,
  h1,
  h1Count,
  horizontalOverflow,
  shoot,
  smallTargets,
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { toConfirm } from "./portalStates.js";

/**
 * The focused task frame (PX-29; PORTAL.md §4.25): free a device, the focused download (on a
 * computer and on a phone) and the Activate dialog, at the five sizes the package names (1440,
 * 1024, 844 × 390, 390 and 360 px) in both themes. Each page, on a cold load as an app's or an
 * email's link opens it:
 *
 * - puts focus on its one `h1`, once the real one is there;
 * - has zero Content-Security-Policy violations, zero axe violations, exactly one visible `h1`, no
 *   sideways page scroll and no target under 24 px;
 * - is one centred column, never pinned to the left edge;
 * - puts the identity beside the task from 800 px wide on a short screen (1440 × 900, 1024 × 768,
 *   844 × 390), where the task's action is on the first screen, and above it everywhere else;
 * - on a phone, offers Email me the download and never a desktop Download.
 *
 * The Activate dialog's Enter step shows the account the key joins, and after a claim focus is on
 * Open. Visual baselines for the pages are `portalQuality.e2e.test.ts`'s.
 */

const SIZES = [
  { label: "1440", width: 1440, height: 900, beside: true },
  { label: "1024", width: 1024, height: 768, beside: true },
  { label: "844x390", width: 844, height: 390, beside: true },
  { label: "390", width: 390, height: 844, beside: false },
  { label: "360", width: 360, height: 780, beside: false },
] as const;
const THEMES: Theme[] = ["dark", "light"];
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

interface Flow {
  id: string;
  scenario: "twelve" | "three";
  path: string;
  heading: string;
  action: RegExp;
  userAgent?: string;
}

const FLOWS: Flow[] = [
  {
    id: "free-device",
    scenario: "twelve",
    path: "/#/p/orbit-survey/free-device?for=Mara%E2%80%99s%20Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
    heading: "Free a device",
    action: /^Remove Work laptop$/,
  },
  {
    id: "download",
    scenario: "three",
    path: "/#/p/nightfall/download?platform=macos",
    heading: "Download Nightfall 1.4.2",
    action: /^Download for macOS/,
  },
  {
    id: "download-phone",
    scenario: "three",
    path: "/#/p/nightfall/download?platform=macos",
    heading: "Download Nightfall 1.4.2",
    action: /^Email me the download/,
    userAgent: IPHONE,
  },
];

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

const activeTag = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.activeElement?.tagName);

describe.concurrent(
  "the focused task frame, at its five sizes in both themes",
  () => {
    for (const flow of FLOWS) {
      describe(flow.id, () => {
        for (const size of SIZES) {
          for (const theme of THEMES) {
            it(`${size.label}, ${theme}`, async ({ expect }) => {
              const o = await portal.open(flow.scenario, flow.path, {
                theme,
                width: size.width,
                height: size.height,
                userAgent: flow.userAgent,
              });
              try {
                await h1(o.page, flow.heading);
                await expect
                  .poll(() => activeTag(o.page), { message: "focus on the h1" })
                  .toBe("H1");
                await shoot(o.page, `frame-${flow.id}-${size.label}-${theme}`);
                expect.soft(await o.violations(), "CSP violations").toEqual([]);
                expect.soft(await axe(o.page), "axe violations").toEqual([]);
                expect.soft(await h1Count(o.page), "visible h1 count").toBe(1);
                expect
                  .soft(await horizontalOverflow(o.page), "horizontal scroll")
                  .toBeLessThanOrEqual(0);
                expect
                  .soft(await smallTargets(o.page), "targets under 24 px")
                  .toEqual([]);

                // One centred column, never pinned to the left edge.
                const frame = await o.page.evaluate(() => {
                  const column = document.querySelector("main > div")!;
                  const r = column.getBoundingClientRect();
                  const id = document
                    .querySelector("[data-identity]")!
                    .getBoundingClientRect();
                  return {
                    left: r.left,
                    right: innerWidth - r.right,
                    idRight: id.right,
                    idBottom: id.bottom,
                  };
                });
                expect
                  .soft(
                    Math.abs(frame.left - frame.right),
                    `centred (left ${frame.left}, right ${frame.right})`,
                  )
                  .toBeLessThanOrEqual(2);

                // The identity beside the task from 800 px wide on a short screen, above it else.
                const action = (await o.page
                  .getByRole("button", { name: flow.action })
                  .first()
                  .boundingBox())!;
                if (size.beside)
                  expect
                    .soft(frame.idRight, "identity beside the task")
                    .toBeLessThanOrEqual(action.x + 1);
                else
                  expect
                    .soft(frame.idBottom, "identity above the task")
                    .toBeLessThanOrEqual(action.y + 1);
                // The action is on the first screen where the columns put it there.
                if (size.beside && size.height >= 768)
                  expect
                    .soft(
                      action.y + action.height,
                      "the action is on the first screen",
                    )
                    .toBeLessThanOrEqual(size.height);

                if (flow.id === "free-device" && !size.beside) {
                  // The action row never leaves the first screen on a phone held upright.
                  const bar = await o.page
                    .locator("[data-sticky-actions]")
                    .boundingBox();
                  expect
                    .soft(bar!.y + bar!.height, "the action row on a phone")
                    .toBeLessThanOrEqual(size.height + 1);
                }
                if (flow.userAgent) {
                  await o.page
                    .getByText("You’re viewing desktop builds.", {
                      exact: false,
                    })
                    .or(o.page.getByText("You're viewing desktop builds."))
                    .first()
                    .waitFor();
                  // Never a desktop Download on a phone.
                  expect
                    .soft(
                      await o.page
                        .getByRole("button", { name: /^Download/ })
                        .count(),
                      "desktop Download buttons on a phone",
                    )
                    .toBe(0);
                }
                expect
                  .soft(await o.violations(), "CSP violations after checks")
                  .toEqual([]);
              } finally {
                await o.close();
              }
            });
          }
        }
      });
    }
  },
);

describe.concurrent(
  "the Activate dialog (PX-29), at its five sizes in both themes",
  () => {
    for (const size of SIZES) {
      for (const theme of THEMES) {
        it(`${size.label}, ${theme}: the account row on Enter; focus on Open after a claim`, async ({
          expect,
        }) => {
          const o = await portal.open("three", "/", {
            theme,
            width: size.width,
            height: size.height,
          });
          try {
            await toConfirm(o.page);
            // Back to Enter: the account the key joins, before Continue.
            await o.page
              .getByRole("dialog")
              .getByRole("button", { name: "Back" })
              .click();
            const dialog = o.page.getByRole("dialog", {
              name: "Activate a license",
            });
            const row = dialog.getByRole("group", {
              name: "Account the license joins",
            });
            await row.waitFor();
            expect.soft(await row.innerText()).toContain("@");
            await shoot(o.page, `frame-activate-enter-${size.label}-${theme}`);
            expect.soft(await axe(o.page), "axe, Enter").toEqual([]);
            await dialog.getByRole("button", { name: "Continue" }).click();
            await o.page
              .getByRole("button", { name: "Add to my library", exact: true })
              .click();
            const open = o.page.getByRole("button", {
              name: "Open Mossgarden",
            });
            await open.waitFor();
            await expect
              .poll(
                () =>
                  o.page.evaluate(
                    () =>
                      `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`,
                  ),
                { message: "focus after a claim" },
              )
              .toBe("BUTTON:Open Mossgarden");
            expect.soft(await axe(o.page), "axe, Done").toEqual([]);
            expect
              .soft(await horizontalOverflow(o.page), "horizontal scroll")
              .toBeLessThanOrEqual(0);
            expect.soft(await o.violations(), "CSP violations").toEqual([]);
          } finally {
            await o.close();
          }
        });
      }
    }
  },
);

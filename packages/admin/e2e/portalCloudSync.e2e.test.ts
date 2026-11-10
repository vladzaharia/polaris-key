import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  axe,
  h1,
  h1Count,
  horizontalOverflow,
  smallTargets,
  startPortal,
  type PortalHarness,
} from "./portalHarness.js";
import { syncOn } from "./portalFixtures.js";

/**
 * The product page's Sync Across Devices card (PX-18) in real Chromium under the Worker's CSP:
 * Download synced data saves the zip (a blob URL and `<a download>`, which the CSP must allow),
 * Remove my data from the card answers a removal that finishes in the background, and the card
 * reflows at 320 and 360 px, with 200 % text too. Each step has zero CSP violations. The card's
 * states and their baselines are in `portalStates.ts` (`product-sync*`).
 */

const PATH = "/#/p/tidewater";
const card = (page: Page) => page.locator("#section-sync");

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
});

describe("Sync Across Devices card (PX-18)", () => {
  it("Download synced data saves Polaris Locker's zip of the product", async () => {
    const o = await portal.open("three", PATH, {
      routes: {
        ...syncOn("three", "tidewater"),
        "GET /api/products/tidewater/export": (req) =>
          new URL(req.url()).searchParams.get("format") === "zip"
            ? { body: "PK" }
            : { status: 400, body: { error: "bad_request" } },
      },
    });
    try {
      await h1(o.page, "Tidewater Studio");
      const button = card(o.page).getByRole("button", {
        name: "Download synced data",
      });
      await button.waitFor();
      const [download] = await Promise.all([
        o.page.waitForEvent("download"),
        button.click(),
      ]);
      expect(download.suggestedFilename()).toBe(
        "polaris-locker-tidewater-data.zip",
      );
      expect(o.requests).toContain(
        "GET /api/products/tidewater/export?format=zip",
      );
      await o.page.getByText("Your download has started").waitFor();
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });

  it("Remove my data from the card: a removal that finishes in the background says so, focus on the card", async () => {
    const o = await portal.open("three", PATH, {
      routes: {
        ...syncOn("three", "tidewater"),
        "DELETE /api/products/tidewater/data": {
          body: {
            ok: true,
            product: "tidewater",
            removed: true,
            pending: true,
            detachedLicenses: [],
          },
        },
      },
    });
    try {
      await h1(o.page, "Tidewater Studio");
      await card(o.page)
        .getByRole("button", { name: "Remove my data from Tidewater Studio" })
        .click();
      const dialog = o.page.getByRole("alertdialog", {
        name: "Remove your data from Tidewater Studio?",
      });
      await dialog.waitFor();
      expect(await axe(o.page)).toEqual([]);
      await dialog
        .getByRole("textbox", { name: /Type the app's name to confirm/ })
        .fill("tidewater studio");
      await dialog.getByRole("button", { name: "Remove my data" }).click();
      await o.page
        .getByText("Removing your data from Tidewater Studio")
        .waitFor();
      await o.page
        .getByText("It finishes shortly. There's nothing else to do.")
        .waitFor();
      await o.page.waitForFunction(
        () => document.activeElement?.id === "section-sync-h",
      );
      expect(o.requests).toContain("DELETE /api/products/tidewater/data");
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });

  for (const { width, height, text } of [
    { width: 320, height: 640, text: 100 },
    { width: 360, height: 780, text: 100 },
    { width: 320, height: 640, text: 200 },
  ])
    it(`reflows at ${width} px${text === 100 ? "" : `, ${text} % text`}: no sideways scroll, targets kept`, async () => {
      const o = await portal.open("three", PATH, {
        width,
        height,
        routes: syncOn("three", "tidewater"),
      });
      try {
        await h1(o.page, "Tidewater Studio");
        await card(o.page).getByRole("meter", { name: "Storage" }).waitFor();
        if (text !== 100)
          await o.page.evaluate((p) => {
            document.documentElement.style.setProperty(
              "font-size",
              `${p}%`,
              "important",
            );
          }, text);
        await card(o.page).scrollIntoViewIfNeeded();
        expect(await horizontalOverflow(o.page)).toBeLessThanOrEqual(0);
        // The card's own width holds inside the window: a long device label wraps.
        const box = await card(o.page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        // On a phone the actions are full-width 44 px targets (the customer-surface floor).
        const heights = await card(o.page)
          .getByRole("button")
          .evaluateAll((els) =>
            els.map((el) => el.getBoundingClientRect().height),
          );
        expect(heights.length).toBe(2);
        for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
        expect(await smallTargets(o.page)).toEqual([]);
        expect(await h1Count(o.page)).toBe(1);
        expect(await o.violations()).toEqual([]);
      } finally {
        await o.close();
      }
    });
});

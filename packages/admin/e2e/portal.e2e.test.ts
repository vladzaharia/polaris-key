import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  h1,
  shoot,
  startPortal,
  type OpenOptions,
  type PortalHarness,
} from "./portalHarness.js";
import type { PortalScenario } from "./portalFixtures.js";

/**
 * The customer site's main flows (PORTAL.md) in real Chromium under the Worker's exact CSP, driven
 * end to end: activate, deep links, inline errors, device removal, ⌘K, search, focused flows,
 * package access, sign-in and theme. Every screen and state is also checked on its own (both
 * themes, both widths, axe, one h1, 360 px, visual baseline) by portalQuality.e2e.test.ts.
 *
 * Set `PK_SHOTS_DIR` to also save screenshots there.
 */

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
});

const open = (scenario: PortalScenario, path: string, opts?: OpenOptions) =>
  portal.open(scenario, path, opts);

describe("Library on GET /api/library (PX-08)", () => {
  it("shows proxied art with zero violations, every image decoded", async () => {
    const o = await open("three", "/");
    await h1(o.page, "Your library");
    await expect
      .poll(() =>
        o.page.evaluate(
          () =>
            [...document.images].filter((i) => i.complete && i.naturalWidth > 0)
              .length,
        ),
      )
      .toBeGreaterThanOrEqual(4);
    const srcs = await o.page.evaluate(() =>
      [...document.images].map((i) => new URL(i.src).pathname),
    );
    expect(srcs.every((s) => s.startsWith("/media/"))).toBe(true);
    expect(o.requests).toContain("GET /media/nightfall/header");
    await o.page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /Discover/ })
      .waitFor();
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

describe("focused flows (PX-10)", () => {
  it("frees a device and returns only to the declared app link", async () => {
    const o = await open(
      "twelve",
      "/#/p/orbit-survey/free-device?for=Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
      { width: 390, height: 844 },
    );
    await h1(o.page, "Your license is on 2 of 2 devices");
    expect(
      await o.page
        .getByRole("radio", { name: /Work laptop/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await o.page
      .getByRole("button", { name: "Remove Work laptop and continue" })
      .click();
    await h1(o.page, "Work laptop was removed");
    await shoot(o.page, "device-limit-done-mobile-dark");
    expect(
      await o.page
        .getByRole("link", { name: "Return to Orbit Survey" })
        .getAttribute("href"),
    ).toBe("orbitsurvey://retry");
    expect(o.requests).toContain(
      "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work",
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("drops an undeclared return URL", async () => {
    const o = await open(
      "twelve",
      "/#/p/orbit-survey/free-device?return=https%3A%2F%2Fevil.example%2F",
    );
    await h1(o.page, "Your license is on 2 of 2 devices");
    expect(
      await o.page
        .getByRole("link", { name: "Back to Orbit Survey" })
        .getAttribute("href"),
    ).toBe("#/p/orbit-survey");
    expect(await o.page.content()).not.toContain("evil.example");
    await o.close();
  });
});

describe("package access (PX-11)", () => {
  it("creates a token and shows it once in a dialog that Escape doesn't close", async () => {
    const o = await open("three", "/#/p/tidewater/package");
    await h1(o.page, "Tidewater Studio");
    await o.page.getByRole("button", { name: "Create token" }).click();
    const form = o.page.getByRole("dialog", { name: "Create a token" });
    await form.getByLabel("Name").fill("Laptop 2");
    await form.getByRole("button", { name: "Create token" }).click();
    const shown = o.page.getByRole("dialog", { name: "Copy your token now" });
    await shown.waitFor();
    await shoot(o.page, "product-token-desktop-dark");
    await o.page.keyboard.press("Escape");
    await shown.getByText(/Close without copying\?/).waitFor();
    expect(await shown.isVisible()).toBe(true);
    expect(o.requests).toContain(
      "POST /api/licenses/tidewater/lic_tidewater/registry-tokens",
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

describe("main flows", () => {
  it("activates a license from the header and lands on the product page", async () => {
    const o = await open("three", "/");
    await h1(o.page, "Your library");
    await o.page.getByRole("button", { name: "Activate license" }).click();
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.waitFor();
    await dialog
      .getByRole("textbox", { name: "License key" })
      .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByText("Key format is valid").waitFor();
    await shoot(o.page, "activate-key-desktop-dark");
    await dialog.getByRole("button", { name: "Continue" }).click();
    const confirm = o.page.getByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await confirm.waitFor();
    await confirm.getByText("Lifetime · up to 5 devices").waitFor();
    await shoot(o.page, "activate-confirm-desktop-dark");
    expect(o.requests).toContain("POST /api/activate/preview");
    expect(o.requests).not.toContain("POST /api/claim/license-key");
    await confirm.getByRole("button", { name: "Add Mossgarden" }).click();
    const done = o.page.getByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    await done.waitFor();
    await shoot(o.page, "activate-done-desktop-dark");
    await done.getByRole("button", { name: "Open Mossgarden" }).click();
    await h1(o.page, "Mossgarden");
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.tagName))
      .toBe("H1");
    expect(o.requests).toContain("POST /api/claim/license-key");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("opens /activate?key=… as the Library with the modal prefilled", async () => {
    const o = await open(
      "three",
      "/activate?key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w",
      { width: 390, height: 844 },
    );
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.waitFor();
    expect(
      await dialog.getByRole("textbox", { name: "License key" }).inputValue(),
    ).toBe("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByText("Filled in from your link").waitFor();
    expect(await o.page.evaluate(() => location.pathname)).toBe("/");
    await shoot(o.page, "activate-link-mobile-dark");
    await o.page.keyboard.press("Escape");
    await h1(o.page, "Your library");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("shows the inline errors of a refused key", async () => {
    const o = await open("three", "/#/?activate=5XKQ7-B2M9P-HT4LZ");
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.getByText(/looks like a Steam key/).waitFor();
    await dialog
      .getByRole("textbox", { name: "License key" })
      .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4z");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByText(/We couldn't find that key/).waitFor();
    await shoot(o.page, "activate-errors-desktop-dark");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("removes a device with the inline confirmation", async () => {
    const o = await open("three", "/#/p/nightfall/devices");
    await h1(o.page, "Nightfall");
    await o.page
      .getByRole("button", { name: "Remove Studio PC" })
      .first()
      .click();
    const heading = o.page.getByRole("heading", { name: "Remove Studio PC?" });
    await heading.waitFor();
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.textContent))
      .toBe("Remove Studio PC?");
    await shoot(o.page, "product-remove-device-desktop-dark");
    await o.page
      .getByRole("button", { name: "Remove Studio PC", exact: true })
      .last()
      .click();
    await o.page.getByText("Studio PC was removed").first().waitFor();
    expect(o.requests.some((r) => r.startsWith("DELETE /api/licenses/"))).toBe(
      true,
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("jumps to a product with ⌘K from 8 products", async () => {
    const o = await open("twelve", "/");
    await h1(o.page, "Your library");
    // ⌘K listens only once the library has loaded (8+ products), after the h1 shows.
    await o.page.getByText("Glyphsmith").first().waitFor();
    await o.page.keyboard.press("Control+k");
    const palette = o.page.getByRole("dialog", { name: "Jump to a product" });
    await palette.waitFor();
    await o.page.keyboard.type("glyph");
    await shoot(o.page, "switcher-desktop-dark");
    await o.page.keyboard.press("Enter");
    await h1(o.page, "Glyphsmith");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("filters and searches the library, kept in the URL", async () => {
    const o = await open("twelve", "/");
    await h1(o.page, "Your library");
    await o.page
      .getByRole("searchbox", { name: /Search 12 products/ })
      .fill("orbit");
    await o.page.getByText("Showing 1 of 12 ·").waitFor();
    expect(await o.page.evaluate(() => location.hash)).toContain("q=orbit");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("signs in with an email link: the honest sent screen", async () => {
    const o = await open("signedOut", "/", { width: 390, height: 844 });
    await h1(o.page, "Sign in to Polaris Key");
    await o.page
      .getByRole("textbox", { name: "Email" })
      .fill("mara@fennick.studio");
    await o.page.getByRole("button", { name: "Continue" }).click();
    await h1(o.page, "Check your email");
    await shoot(o.page, "signin-sent-mobile-dark");
    expect(o.requests).toContain("POST /api/magic/start");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("switches the theme from Account → Appearance", async () => {
    const o = await open("three", "/#/account/appearance");
    await h1(o.page, "Account");
    await o.page.getByRole("radio", { name: /Light/ }).click();
    expect(
      await o.page.evaluate(() => document.documentElement.dataset.theme),
    ).toBe("light");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

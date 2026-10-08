import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  h1,
  shoot,
  startPortal,
  type OpenOptions,
  type PortalHarness,
} from "./portalHarness.js";
import {
  MARA_METHODS,
  PROFILE_STEAM,
  profileRoutes,
  UPLOAD_ASSET,
  type PortalScenario,
} from "./portalFixtures.js";
import { FLOATING_ON_TWO, licenseSourceIs } from "./portalStates.js";

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

/** What paints at the middle of the icon's top quarter, the part that overlaps the cover. */
async function iconOnTop(
  page: Page,
): Promise<{ overlaps: boolean; onTop: boolean }> {
  return page.evaluate(() => {
    const header = document.querySelector("[data-cover]")!;
    const icon = header.querySelector<HTMLElement>("[data-art]")!;
    const banner = header.previousElementSibling as HTMLElement | null;
    const r = icon.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 4;
    const b = banner?.getBoundingClientRect();
    return {
      overlaps: !!b && r.top < b.bottom && r.bottom > b.bottom,
      onTop: document.elementFromPoint(x, y) === icon,
    };
  });
}

describe("product header: the icon in front of the cover (§4.20)", () => {
  for (const [slug, scenario, name] of [
    ["nightfall", "three", "Nightfall"],
    ["glyphsmith", "twelve", "Glyphsmith"],
  ] as const) {
    it(`${name}: the icon overlaps the cover's lower edge and paints over it, both themes, 1440, 1280 and 390`, async () => {
      for (const theme of ["dark", "light"] as const) {
        for (const width of [1440, 1280, 390]) {
          const o = await open(scenario, `/#/p/${slug}`, {
            theme,
            width,
            height: width === 390 ? 844 : 900,
          });
          await h1(o.page, name);
          expect(await o.page.getAttribute("[data-cover]", "data-cover")).toBe(
            "image",
          );
          expect(await iconOnTop(o.page), `${theme} ${width}`).toEqual({
            overlaps: true,
            onTop: true,
          });
          const art = await o.page.evaluate(() => {
            const header = document.querySelector("[data-cover]")!;
            const icon = header.querySelector<HTMLElement>("[data-art]")!;
            const s = getComputedStyle(icon);
            const banner =
              header.previousElementSibling!.getBoundingClientRect();
            return {
              image: icon.tagName === "IMG",
              frame:
                icon.tagName === "IMG"
                  ? [
                      s.backgroundColor,
                      s.borderTopWidth,
                      s.borderTopLeftRadius,
                      s.padding,
                    ]
                  : null,
              ratio: banner.width / banner.height,
              height: banner.height,
            };
          });
          // An icon image is its own frame: no tile background, border, radius or padding.
          if (art.image)
            expect(art.frame).toEqual([
              "rgba(0, 0, 0, 0)",
              "0px",
              "0px",
              "0px",
            ]);
          // 16:9 on phones; a 3:1 band, at most 416 px tall, on desktop.
          if (width === 390) expect(art.ratio).toBeCloseTo(16 / 9, 1);
          else {
            expect(art.height).toBeLessThanOrEqual(416.5);
            expect(art.ratio).toBeGreaterThanOrEqual(2.9);
          }
          await shoot(o.page, `header-${slug}-${width}-${theme}`);
          await o.close();
        }
      }
    });
  }

  it("without a cover the icon stands alone beside the name, with no letter banner", async () => {
    for (const width of [1440, 390]) {
      const o = await open("twelve", "/#/p/hollow-pines", { width });
      await h1(o.page, "Hollow Pines");
      expect(await o.page.getAttribute("[data-cover]", "data-cover")).toBe(
        "none",
      );
      const box = await o.page.evaluate(() => {
        const header = document.querySelector("[data-cover]")!;
        const icon = header
          .querySelector("[data-art]")!
          .getBoundingClientRect();
        const h = header.querySelector("h1")!.getBoundingClientRect();
        return {
          banners: document.querySelectorAll(
            "main [data-art='fallback'].aspect-video",
          ).length,
          beside: h.left >= icon.right,
          letter: header.querySelector("[data-art]")!.textContent,
        };
      });
      expect(box).toEqual({ banners: 0, beside: true, letter: "H" });
      await o.close();
    }
  });
});

describe("library cards: 16:9 art, the status inset on its plate, no byline", () => {
  for (const [scenario, path] of [
    ["three", "/"],
    ["twelve", "/#/?view=grid"],
  ] as const) {
    it(`${scenario}: both themes at 1440, 1280 and 390`, async () => {
      for (const theme of ["dark", "light"] as const) {
        for (const width of [1440, 1280, 390]) {
          const o = await open(scenario, path, {
            theme,
            width,
            height: width === 390 ? 844 : 900,
          });
          await h1(o.page, "Your library");
          await o.page.getByRole("article", { name: "Nightfall" }).waitFor();
          // Both icons decoded, so their shape is read.
          await expect
            .poll(() =>
              o.page.evaluate(() =>
                ["nightfall", "tidewater"].every((p) => {
                  const i = document.querySelector<HTMLImageElement>(
                    `article[aria-labelledby='tile-${p}'] img[data-art]`,
                  );
                  return !!i && i.complete && i.naturalWidth > 0;
                }),
              ),
            )
            .toBe(true);
          const card = await o.page.evaluate(() => {
            const article = [...document.querySelectorAll("article")].find(
              (a) => a.getAttribute("aria-labelledby") === "tile-nightfall",
            )!;
            const art = article.querySelector<HTMLElement>("[data-art]")!;
            // Healthy is silence on art (UX-03): Nightfall has no plate; the issue plate
            // (owner's padding) is measured on Ember Tactics, which has expired.
            const emberArt = document.querySelector<HTMLElement>(
              "article[aria-labelledby='tile-ember-tactics'] [data-art]",
            )!;
            const plate = emberArt.querySelector<HTMLElement>("span.absolute")!;
            const a = art.getBoundingClientRect();
            const e = emberArt.getBoundingClientRect();
            const p = plate.getBoundingClientRect();
            const pill = plate.firstElementChild!.getBoundingClientRect();
            const icon = article.querySelector<HTMLElement>("img[data-art]")!;
            const s = getComputedStyle(icon);
            // A full-bleed square icon (Tidewater's) gets the store's corner mask, nothing more.
            const square = document.querySelector<HTMLElement>(
              "article[aria-labelledby='tile-tidewater'] img[data-art]",
            )!;
            const q = getComputedStyle(square);
            return {
              ratio: a.width / a.height,
              healthyPlate:
                (art.querySelector("span.absolute")?.childElementCount ?? 0) >
                0,
              insetRight: e.right - p.right,
              insetBottom: e.bottom - p.bottom,
              plateHeight: pill.height,
              byline: article.textContent!.includes("Lanternworks"),
              iconFrame: [
                s.backgroundColor,
                s.borderTopWidth,
                s.borderTopLeftRadius,
              ],
              shapes: [icon.dataset.shape, square.dataset.shape],
              squareFrame: [q.backgroundColor, q.borderTopWidth],
              squareRadius: parseFloat(q.borderTopLeftRadius),
            };
          });
          expect(card.ratio, `${scenario} ${theme} ${width}`).toBeCloseTo(
            16 / 9,
            1,
          );
          expect(card.insetRight).toBeGreaterThanOrEqual(16);
          expect(card.healthyPlate).toBe(false);
          expect(card.insetBottom).toBeGreaterThanOrEqual(16);
          expect(card.insetRight).toBe(card.insetBottom);
          expect(card.plateHeight).toBeGreaterThanOrEqual(32);
          expect(card.byline).toBe(false);
          expect(card.iconFrame).toEqual(["rgba(0, 0, 0, 0)", "0px", "0px"]);
          expect(card.shapes).toEqual(["shaped", "square"]);
          expect(card.squareFrame).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
          expect(card.squareRadius).toBeGreaterThan(0);
          await shoot(o.page, `cards-${scenario}-${width}-${theme}`);
          await o.close();
        }
      }
    });
  }
});

describe("Discover count (P6, FLOWS P-13): counts only what the page lists", () => {
  // PX-16 made the Discover page list `GET /api/discover` (`DISCOVER_LISTS_OFFERS` is true), so
  // the Worker's count shows in both navs and the page lists exactly the offers it counted.
  it("the Worker counts 4 offers and the page lists them: Discover in either nav, with the count", async () => {
    for (const width of [1440, 390]) {
      // The fixture's library carries `discoverCount: 4`, one per offer `GET /api/discover` sends.
      const o = await open("three", "/", { width });
      await h1(o.page, "Your library");
      const nav = o.page.getByRole("navigation", {
        name: width === 390 ? "Phone" : "Main",
      });
      await nav.getByRole("link", { name: /Library/ }).waitFor();
      const discover = nav.getByRole("link", { name: /Discover/ });
      await discover.waitFor();
      expect(await discover.count()).toBe(1);
      // The desktop count is visible; the phone bar's dot carries ", 4 offers" for readers.
      expect(await discover.textContent()).toContain("4");
      expect(await o.violations()).toEqual([]);
      await o.close();
    }
  });

  it("a typed #/discover lists the four offers it counted", async () => {
    const o = await open("three", "/#/discover");
    await h1(o.page, "Discover");
    for (const name of ["Quill", "Mossgarden", "Lumen RAW", "Pixel Forge SDK"])
      await o.page.getByRole("article", { name }).waitFor();
    expect(await o.page.getByRole("article").count()).toBe(4);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

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
    expect(o.requests).toContain("GET /media/nightfall/header?v=1");
    await o.page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: /Library/ })
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
    await o.page.getByRole("button", { name: "Remove Work laptop" }).click();
    await h1(o.page, "Work laptop was removed");
    await shoot(o.page, "device-limit-done-mobile-dark");
    expect(
      await o.page
        .getByRole("link", { name: "Back to Orbit Survey" })
        .last()
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
        .getByRole("link", { name: "See Orbit Survey in your library" })
        .getAttribute("href"),
    ).toBe("#/p/orbit-survey");
    expect(await o.page.content()).not.toContain("evil.example");
    await o.close();
  });
});

describe("the Activate link from an app (PX-17)", () => {
  const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";

  it("next=free-device: names why, adds the key, then the free-device flow with the app's way back", async () => {
    const o = await open(
      "three",
      `/activate?product=mossgarden&next=free-device&for=macOS+arm64&return=mossgarden%3A%2F%2Fretry#key=${KEY}`,
      { width: 390, height: 844 },
    );
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.getByText(/then free one up for macOS arm64/).waitFor();
    await dialog.getByRole("button", { name: "Continue" }).click();
    const confirm = o.page.getByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await confirm.getByRole("button", { name: "Add Mossgarden" }).click();
    await h1(o.page, "Your license has a free device");
    expect(await o.page.evaluate(() => location.hash)).toBe(
      "#/p/mossgarden/free-device?license=lic_mossgarden&for=macOS+arm64&return=mossgarden%3A%2F%2Fretry",
    );
    // Focus lands on the flow's heading (§9.4).
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.tagName))
      .toBe("H1");
    expect(
      await o.page
        .getByRole("link", { name: "Back to Mossgarden" })
        .last()
        .getAttribute("href"),
    ).toBe("mossgarden://retry");
    expect(o.requests).toContain("POST /api/claim/license-key");
    // The key went in the claim's body only: no request line or Referer carries it.
    expect(o.all.filter((r) => r.includes("pkey_"))).toEqual([]);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("return= to the login card: back to /signin?request=… after the add, the key in no URL", async () => {
    const o = await open(
      "three",
      `/activate?product=mossgarden&return=%2Fsignin%3Frequest%3Drq_0123456789abcdef#key=${KEY}`,
    );
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.getByText(/Signing in to Mossgarden/).waitFor();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await o.page
      .getByRole("dialog", { name: "Add Mossgarden to your account?" })
      .getByRole("button", { name: "Add Mossgarden" })
      .click();
    await o.page.waitForURL(/\/signin\?request=rq_0123456789abcdef$/);
    expect(o.requests).toContain("POST /api/claim/license-key");
    expect(o.all.filter((r) => r.includes("pkey_"))).toEqual([]);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });
});

describe("portal flow conformance (UX-79)", () => {
  it("on a phone, the removal toast sits at the bottom above the phone bar, full width", async () => {
    for (const theme of ["dark", "light"] as const) {
      const o = await open("three", "/#/p/nightfall/devices", {
        width: 390,
        height: 844,
        theme,
      });
      await h1(o.page, "Nightfall");
      await o.page
        .getByRole("button", { name: "Remove Studio PC" })
        .first()
        .click();
      await o.page
        .getByRole("button", { name: "Remove Studio PC", exact: true })
        .last()
        .click();
      const toast = o.page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Studio PC was removed" });
      await toast.waitFor();
      await expect
        .poll(() => o.page.evaluate(() => document.activeElement?.tagName))
        .toBe("H1");
      // Let the toast's enter settle before measuring.
      await o.page.waitForTimeout(500);
      const box = await toast.boundingBox();
      const bar = await o.page
        .getByRole("navigation", { name: "Phone" })
        .boundingBox();
      expect(box && bar).toBeTruthy();
      expect(box!.y).toBeGreaterThan(844 / 2);
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y);
      expect(box!.width).toBeGreaterThan(390 - 48);
      await shoot(o.page, `device-removed-toast-390-${theme}`);
      expect(await o.violations()).toEqual([]);
      await o.close();
    }
  });

  it("Free a device: least recent as text, an action-named primary, a back label that fits at 390", async () => {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [1440, 390]) {
        const o = await open(
          "twelve",
          "/#/p/orbit-survey/free-device?for=Steam%20Deck",
          { width, height: width === 390 ? 844 : 900, theme },
        );
        await h1(o.page, "Your license is on 2 of 2 devices");
        const work = o.page.getByRole("radio", { name: /Work laptop/ });
        expect(await work.innerText()).toMatch(/· least\srecent/);
        await o.page
          .getByRole("button", { name: "Remove Work laptop", exact: true })
          .waitFor();
        const back = o.page
          .getByRole("banner")
          .getByRole("link", { name: /See Orbit Survey/ });
        const label = back.locator("span.truncate");
        const clipped = await label.evaluate(
          (el) => el.scrollWidth > el.clientWidth,
        );
        expect(clipped, `${theme} ${width}`).toBe(false);
        expect((await back.innerText()).trim()).toBe(
          width === 390
            ? "See Orbit Survey"
            : "See Orbit Survey in your library",
        );
        await shoot(o.page, `free-device-${width}-${theme}`);
        expect(await o.violations()).toEqual([]);
        await o.close();
      }
    }
  });

  it("screens: activate confirm and the library without Discover, both widths and themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      for (const width of [1440, 390]) {
        const o = await open("three", "/", {
          width,
          height: width === 390 ? 844 : 900,
          theme,
        });
        await h1(o.page, "Your library");
        await shoot(o.page, `library-no-discover-${width}-${theme}`);
        await o.page
          .getByRole(width === 390 ? "navigation" : "banner", {
            name: width === 390 ? "Phone" : undefined,
          })
          .getByRole("button", { name: /^Activate/ })
          .click();
        const dialog = o.page.getByRole("dialog", {
          name: "Activate a license",
        });
        await dialog
          .getByRole("textbox", { name: "License key" })
          .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
        await dialog.getByRole("button", { name: "Continue" }).click();
        await expect
          .poll(() =>
            o.page.evaluate(() => document.activeElement?.textContent),
          )
          .toBe("Add Mossgarden to your account?");
        await shoot(o.page, `activate-confirm-${width}-${theme}`);
        expect(await o.violations()).toEqual([]);
        await o.close();
      }
    }
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

describe("Account → Profile (PX-22, §4.30)", () => {
  /** Every picture on the page: its source, whether it decoded, and its natural width. */
  const pictures = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .filter((i) => i.getAttribute("src")?.startsWith("/media/avatar/"))
        .map((i) => ({
          src: i.getAttribute("src"),
          decoded: i.complete && i.naturalWidth > 0,
        })),
    );

  it("explicit choices: a typed name and a picked picture are sent alone, stick, and reach the header chip", async () => {
    const patches: unknown[] = [];
    const o = await open("three", "/#/account/profile", {
      routes: profileRoutes(PROFILE_STEAM, patches),
    });
    try {
      await h1(o.page, "Account");
      const card = o.page.getByRole("region", { name: "Profile" });
      await card
        .getByText("Name typed by you · picture from Steam (marafox)")
        .waitFor();
      await card.getByRole("button", { name: "Edit profile" }).click();
      const field = card.getByRole("textbox", { name: "Display name" });
      await field.fill("Mara F.");
      await card.getByText("Your choice", { exact: true }).waitFor();
      await card
        // The tile (its label) takes the click; the native radio inside is visually hidden.
        .locator('[data-tile="link:lnk_google"]')
        .click();
      await card.getByRole("button", { name: "Save profile" }).click();
      await card.getByText("Name typed by you · picture from Google").waitFor();
      expect(patches).toEqual([
        { name: "Mara F.", picture: { from: "lnk_google" } },
      ]);
      const chip = o.page.getByRole("button", { name: "Account: Mara F." });
      await chip.waitFor();
      await o.page.waitForFunction(() =>
        [...document.images].every((i) => i.complete),
      );
      const shown = await pictures(o.page);
      // The chip's 96 px picture and the card's 256 px one, both same-origin and decoded.
      const google = `/media/avatar/${"6a".repeat(32)}`;
      expect(shown.map((p) => p.src)).toEqual(
        expect.arrayContaining([`${google}-96`, google]),
      );
      expect(shown.every((p) => p.decoded)).toBe(true);
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });

  it("upload: the bytes go up, Your upload is selected, and Save picks it", async () => {
    const patches: unknown[] = [];
    const o = await open("three", "/#/account/profile", {
      routes: profileRoutes(PROFILE_STEAM, patches),
      width: 390,
      height: 844,
    });
    try {
      await h1(o.page, "Account");
      const card = o.page.getByRole("region", { name: "Profile" });
      await card.getByRole("button", { name: "Edit profile" }).click();
      const chooser = o.page.waitForEvent("filechooser");
      await card.getByRole("button", { name: "Upload" }).click();
      await (
        await chooser
      ).setFiles({
        name: "me.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
      const mine = card.getByRole("radio", { name: /Your upload/ });
      await mine.waitFor({ state: "attached" });
      expect(await mine.isChecked()).toBe(true);
      expect(o.requests).toContain("POST /api/me/profile/picture");
      await card.getByRole("button", { name: "Save profile" }).click();
      await card
        .getByText("Name typed by you · picture uploaded by you")
        .waitFor();
      expect(patches).toEqual([{ picture: { upload: UPLOAD_ASSET } }]);
      expect(
        await o.page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });

  it("no picture before authentication: the login card asks for no profile and loads no picture", async () => {
    // The profile route would answer with a picture; signed out, nothing may ask for it.
    const o = await open("signedOut", "/", {
      routes: {
        "GET /api/me/profile":
          profileRoutes(PROFILE_STEAM)["GET /api/me/profile"]!,
      },
    });
    try {
      await h1(o.page, /Sign in/);
      expect(await pictures(o.page)).toEqual([]);
      expect(
        o.all.filter((r) => /\/media\/avatar\/|\/api\/me\/profile/.test(r)),
      ).toEqual([]);
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
  });
});

describe("Account → Sign-in methods (PX-13, §4.26)", () => {
  it("Disconnect asks to confirm it's you, takes an email code, then removes the method", async () => {
    let fresh = false;
    let removed = false;
    const calls: string[] = [];
    const view = () => ({
      ...MARA_METHODS,
      methods: MARA_METHODS.methods.filter(
        (m) => !(removed && m.id === "lnk_steam"),
      ),
      providers: MARA_METHODS.providers.map((p) =>
        p.kind === "steam" ? { ...p, connected: !removed } : p,
      ),
      stepUp: fresh
        ? {
            authenticatedAt: Date.UTC(2026, 9, 1, 12) / 1000,
            freshUntil: Date.UTC(2026, 9, 1, 12, 5) / 1000,
            fresh: true,
            maxAgeSeconds: 300,
          }
        : MARA_METHODS.stepUp,
    });
    const o = await open("three", "/#/account/methods", {
      routes: {
        "GET /api/me/methods": () => ({ body: view() }),
        "POST /api/signin/email/start": () => {
          calls.push("start");
          return { body: { ok: true, expiresIn: 600, resendIn: 60 } };
        },
        "POST /api/signin/email/verify": () => {
          calls.push("verify");
          fresh = true;
          return { body: { status: "signed_in", next: "/" } };
        },
        "DELETE /api/me/methods/lnk_steam": () => {
          calls.push("delete");
          if (!fresh)
            return { status: 401, body: { error: "step_up_required" } };
          removed = true;
          return {
            body: { ok: true, removed: { id: "lnk_steam", kind: "steam" } },
          };
        },
      },
    });
    try {
      await h1(o.page, "Account");
      const region = o.page.getByRole("region", { name: "Sign-in methods" });
      await region.getByRole("button", { name: "Disconnect Steam" }).click();
      await region
        .getByRole("heading", { name: "Disconnect Steam?" })
        .waitFor();
      const prompt = region.getByRole("group", {
        name: "Confirm it's you first",
      });
      // The account has passkeys, so the passkey comes first; this run confirms with an email code.
      const useEmail = prompt.getByRole("button", {
        name: "Use an email code instead",
      });
      if (await useEmail.isVisible()) await useEmail.click();
      await prompt
        .getByRole("button", { name: "Email a code to mara@fennick.studio" })
        .click();
      await prompt
        .getByRole("textbox", { name: "6-digit code" })
        .fill("481920");
      await o.page.getByText("Steam was disconnected").first().waitFor();
      expect(calls).toEqual(["start", "verify", "delete"]);
      await region
        .getByRole("button", { name: "Disconnect Steam" })
        .waitFor({ state: "detached" });
      expect(
        await o.page.evaluate(() => document.activeElement?.textContent),
      ).toBe("Accounts");
      expect(await o.violations()).toEqual([]);
    } finally {
      await o.close();
    }
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
    // Focus follows the step to its heading (FLOWS.md §2 C18, P-5).
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.textContent))
      .toBe("Add Mossgarden to your account?");
    await shoot(o.page, "activate-confirm-desktop-dark");
    expect(o.requests).toContain("POST /api/activate/preview");
    expect(o.requests).not.toContain("POST /api/claim/license-key");
    await confirm.getByRole("button", { name: "Add Mossgarden" }).click();
    const done = o.page.getByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    await done.waitFor();
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.textContent))
      .toBe("Mossgarden is in your library");
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

  it("opens /activate#key=… as the Library with the modal prefilled", async () => {
    const o = await open(
      "three",
      "/activate#key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w",
      { width: 390, height: 844 },
    );
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog.waitFor();
    expect(
      await dialog.getByRole("textbox", { name: "License key" }).inputValue(),
    ).toBe("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByText("Filled in from your link").waitFor();
    expect(await o.page.evaluate(() => location.pathname)).toBe("/");
    // The fragment is gone from the address bar.
    await expect
      .poll(() => o.page.evaluate(() => location.href))
      .not.toContain("pkey_");
    await shoot(o.page, "activate-link-mobile-dark");
    await o.page.keyboard.press("Escape");
    await h1(o.page, "Your library");
    // Every request the page made, the document navigation included (a fragment is never sent),
    // has the key in neither its URL nor its Referer.
    expect(o.all.length).toBeGreaterThan(1);
    expect(o.all.filter((r) => r.includes("pkey_"))).toEqual([]);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("opens a legacy /activate?key=… the same way, and no later request carries the key", async () => {
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
    // The query is gone from the address bar.
    await expect
      .poll(() => o.page.evaluate(() => location.href))
      .not.toContain("pkey_");
    await o.page.keyboard.press("Escape");
    await h1(o.page, "Your library");
    // The document navigation is the legacy link itself, so it carries `?key=` by definition:
    // it is the one request excluded, and only it. Every later request (the shell's own
    // `/assets/*`, fonts and icons, which start before the rewrite, then the app's API calls)
    // has the key in neither its URL nor its Referer, because the shell is served with
    // `Referrer-Policy: no-referrer`.
    const [navigation, ...later] = o.all;
    expect(navigation).toMatch(/^GET \S+\/activate\?key=pkey_\S+ referer=$/);
    expect(later.length).toBeGreaterThan(0);
    expect(later.filter((r) => r.includes("pkey_"))).toEqual([]);
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
    // Continue is disabled until the key changes; focus goes to the field, not body (P-5).
    await expect
      .poll(() =>
        o.page.evaluate(() =>
          document.activeElement?.getAttribute("aria-invalid"),
        ),
      )
      .toBe("true");
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
    // The row has gone; focus is on the product's h1, never body (FLOWS.md P-7).
    await expect
      .poll(() => o.page.evaluate(() => document.activeElement?.tagName))
      .toBe("H1");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("a sign-in licence lists its devices and removes one remotely", async () => {
    const o = await open("signIn", "/#/p/quill/devices");
    await h1(o.page, "Quill");
    await licenseSourceIs(o.page, "Automatic Grant");
    expect(await o.page.getByText(/Account-wide/).count()).toBe(0);
    await o.page
      .getByRole("button", { name: "Remove Living room PC" })
      .first()
      .click();
    await o.page
      .getByRole("heading", { name: "Remove Living room PC?" })
      .waitFor();
    await o.page
      .getByRole("button", { name: "Remove Living room PC", exact: true })
      .last()
      .click();
    await o.page.getByText("Living room PC was removed").first().waitFor();
    expect(
      o.requests.some(
        (r) => r === "DELETE /api/licenses/quill/lic_quill/devices/quill-tv",
      ),
    ).toBe(true);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("with a Steam key and a sign-in licence, the key licence hides its counter", async () => {
    const o = await open("signIn", "/#/p/drift-kart");
    await h1(o.page, "Drift Kart");
    const card = o.page.getByRole("region", { name: "Drift Kart license" });
    await card.getByText("Activated").waitFor();
    const picker = card.getByRole("combobox");
    expect((await picker.locator("option").allTextContents()).sort()).toEqual([
      "Standard · Sign-in",
      "Standard · Steam key",
    ]);
    await licenseSourceIs(o.page, "Steam key");
    expect(await card.getByText(/\d+ (of \d+ )?devices?$/).count()).toBe(0);
    const devices = o.page.getByRole("region", { name: "Devices" });
    await devices.getByText("Mara's MacBook Pro").waitFor();
    expect(await devices.getByText(/in use/).count()).toBe(0);
    await picker.selectOption({ label: "Standard · Sign-in" });
    await licenseSourceIs(o.page, "Automatic Grant");
    // The count is the Devices card's alone (owner polish 2026-10-07).
    await devices
      .getByRole("img", { name: /^1 of \d+ devices? in use$/ })
      .waitFor();
    expect(await card.getByText(/\d+ (of \d+ )?devices?$/).count()).toBe(0);
    await devices.getByText("Mara's Steam Deck").waitFor();
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("adds a floating key with its devices: the count on Confirm and on Done (PX-23)", async () => {
    const o = await open("three", "/", { routes: FLOATING_ON_TWO });
    await h1(o.page, "Your library");
    await o.page.getByRole("button", { name: "Activate license" }).click();
    const dialog = o.page.getByRole("dialog", { name: "Activate a license" });
    await dialog
      .getByRole("textbox", { name: "License key" })
      .fill("pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w");
    await dialog.getByRole("button", { name: "Continue" }).click();
    const confirm = o.page.getByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await confirm
      .getByText(
        "It's on 2 devices already. They keep working and come with it.",
      )
      .waitFor();
    await shoot(o.page, "activate-confirm-devices-desktop-dark");
    await confirm.getByRole("button", { name: "Add Mossgarden" }).click();
    const done = o.page.getByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    await done
      .getByText(
        "Its 2 devices came with it. Sign in on them to turn on Cloud Sync.",
      )
      .waitFor();
    await shoot(o.page, "activate-done-devices-desktop-dark");
    expect(o.requests).toContain("POST /api/claim/license-key");
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("each licence names how it reached the person (PX-23)", async () => {
    const o = await open("origins", "/#/p/tidewater");
    await h1(o.page, "Tidewater Studio");
    await licenseSourceIs(o.page, "Added with a key");
    const card = o.page.getByRole("region", {
      name: "Tidewater Studio license",
    });
    const picker = card.getByRole("combobox");
    expect((await picker.locator("option").allTextContents()).sort()).toEqual([
      "Free · From Harbor Audio",
      "Pro · Key",
    ]);
    await picker.selectOption({ label: "Free · From Harbor Audio" });
    await licenseSourceIs(o.page, "From Harbor Audio");
    // The term is said once, as Updates included, never as a meta line under the tier.
    expect(await card.getByText(/ · (Lifetime|Expires|Ended)/).count()).toBe(0);
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("no Remove for a licence its key can't bring back: a sign-in licence (PX-23 review)", async () => {
    const o = await open("signIn", "/#/p/quill");
    await h1(o.page, "Quill");
    await licenseSourceIs(o.page, "Automatic Grant");
    await o.page.getByRole("button", { name: "More for Quill" }).click();
    const items = o.page.getByRole("menuitem");
    await items.first().waitFor();
    expect(await items.allTextContents()).toEqual([
      "Manage devices",
      "Copy link",
    ]);
    expect(o.requests.some((r) => r.startsWith("DELETE /api/licenses/"))).toBe(
      false,
    );
    expect(await o.violations()).toEqual([]);
    await o.close();
  });

  it("Remove from my library: the licence leaves and stays out across reloads (PX-23, with LX-26)", async () => {
    const o = await open(
      "origins",
      "/#/p/tidewater?license=lic_tidewater-free",
    );
    await h1(o.page, "Tidewater Studio");
    await licenseSourceIs(o.page, "From Harbor Audio");
    const removeFromMenu = async (dialogName: string) => {
      await o.page
        .getByRole("button", { name: "More for Tidewater Studio" })
        .click();
      await o.page
        .getByRole("menuitem", { name: "Remove from my library" })
        .click();
      const dialog = o.page.getByRole("alertdialog", { name: dialogName });
      await dialog.waitFor();
      return dialog;
    };
    // A licence the developer assigned keeps its email: not in an account, never "floating".
    const first = await removeFromMenu(
      "Remove this Tidewater Studio license from your library?",
    );
    await first
      .getByText(
        "It won't be in an account, and it won't come back to this account by itself. To add it again, use its key.",
      )
      .waitFor();
    expect(await first.getByText(/floating/i).count()).toBe(0);
    await shoot(o.page, "product-remove-license-desktop-dark");
    await first.getByRole("button", { name: "Remove from my library" }).click();
    await o.page
      .getByText("The Free license was removed from your library")
      .first()
      .waitFor();
    expect(o.requests).toContain(
      "DELETE /api/licenses/tidewater/lic_tidewater-free",
    );
    // The page now shows the licence that is left, and only it, after every reload.
    for (let i = 0; i < 2; i++) {
      await licenseSourceIs(o.page, "Added with a key");
      const card = o.page.getByRole("region", {
        name: "Tidewater Studio license",
      });
      expect(await card.getByRole("combobox").count()).toBe(0);
      await o.page.reload();
      await h1(o.page, "Tidewater Studio");
    }
    // The key Mara added floats again once removed: anyone with the key can add it.
    const last = await removeFromMenu(
      "Remove Tidewater Studio from your library?",
    );
    await last
      .getByText(
        "It won't be in an account: anyone with the key can add it, and it won't come back to this account by itself.",
      )
      .waitFor();
    await last.getByRole("button", { name: "Remove from my library" }).click();
    await o.page
      .getByText("Tidewater Studio was removed from your library")
      .first()
      .waitFor();
    await h1(o.page, "Your library");
    for (let i = 0; i < 2; i++) {
      await o.page.reload();
      await h1(o.page, "Your library");
      expect(
        await o.page.getByRole("link", { name: /Tidewater Studio/ }).count(),
      ).toBe(0);
    }
    await o.page.goto(`${portal.base()}/#/p/tidewater`);
    await h1(o.page, "That product isn't in your library");
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
    // Focus lands on the product's h1, not body (FLOWS.md P-14).
    await expect
      .poll(() =>
        o.page.evaluate(() =>
          document.activeElement?.tagName === "H1"
            ? document.activeElement.textContent
            : null,
        ),
      )
      .toBe("Glyphsmith");
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

  it("signs in with an email code: the six-cell code step", async () => {
    const o = await open("signedOut", "/", { width: 390, height: 844 });
    await h1(o.page, "Sign in to Polaris Key");
    await o.page
      .getByRole("textbox", { name: "Email" })
      .fill("mara@fennick.studio");
    await o.page.getByRole("button", { name: "Continue" }).click();
    await h1(o.page, "Check your email");
    await o.page.getByRole("textbox", { name: "6-digit code" }).waitFor();
    await shoot(o.page, "signin-sent-mobile-dark");
    expect(o.requests).toContain("POST /api/signin/email/start");
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

describe("product page, owner polish 2026-10-07", () => {
  /** The nav entry the page marks as being read. */
  const marked = (page: Page, nav: string): Promise<string | null> =>
    page.evaluate(
      (label) =>
        document.querySelector(
          `nav[aria-label="${label}"] a[aria-current="location"]`,
        )?.textContent ?? null,
      nav,
    );

  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    it(`What's new: Markdown formatted, a summary, the full notes in place, focus kept (${reducedMotion})`, async () => {
      const o = await open("three", "/#/p/nightfall", { reducedMotion });
      await h1(o.page, "Nightfall");
      const news = o.page.getByRole("region", { name: "What's new in 1.4.2" });
      await news
        .getByRole("heading", { level: 3, name: "Highlights" })
        .waitFor();
      expect(await news.locator("strong").first().textContent()).toBe(
        "Photo Mode",
      );
      // The summary's three items; the fourth waits behind Show full notes.
      expect(await news.locator("[data-notes] > div > ul > li").count()).toBe(
        3,
      );
      expect(await news.getByText("Subtitles keep their size").count()).toBe(0);
      const more = news.getByRole("button", { name: "Show full notes" });
      await more.focus();
      await o.page.keyboard.press("Enter");
      const rest = news.getByText(/Subtitles keep their size/);
      await rest.waitFor();
      // The same end state with or without motion: open, laid out, visible.
      await expect
        .poll(() =>
          news.locator("[data-notes-rest]").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 40 && getComputedStyle(el).opacity === "1";
          }),
        )
        .toBe(true);
      const blog = news.getByRole("link", { name: "the Nightfall blog" });
      expect(await blog.getAttribute("href")).toBe(
        "https://nightfall.example.com/blog/1-4-2",
      );
      expect(await blog.getAttribute("target")).toBe("_blank");
      expect(await blog.getAttribute("rel")).toBe("noreferrer");
      // Focus never left the button, which now closes the notes.
      expect(
        await o.page.evaluate(() => document.activeElement?.textContent),
      ).toBe("Show less");
      await o.page.keyboard.press("Enter");
      await expect.poll(() => rest.count()).toBe(0);
      expect(
        await o.page.evaluate(() => document.activeElement?.textContent),
      ).toBe("Show full notes");
      expect(await o.violations()).toEqual([]);
      await o.close();
    });
  }

  for (const [width, nav] of [
    [1440, "On this page"],
    [390, "Sections"],
  ] as const) {
    it(`the section nav (${nav}, ${width} px) follows the page down in its own order, and a picked section holds`, async () => {
      const o = await open("three", "/#/p/nightfall", {
        width,
        height: width === 390 ? 844 : 800,
      });
      await h1(o.page, "Nightfall");
      const links = o.page.getByRole("navigation", { name: nav });
      const order = ["Get it", "License", "Devices 2", "What's new", "Help"];
      expect(await links.getByRole("link").allTextContents()).toEqual(order);
      // The device count is a pill.
      expect(
        await links
          .getByRole("link", { name: "Devices 2" })
          .locator("[data-status=pill]")
          .textContent(),
      ).toBe("2");
      const seen: string[] = [];
      await o.page.mouse.move(width / 2, 400);
      for (let i = 0; i < 80; i++) {
        const m = await marked(o.page, nav);
        if (m && seen.at(-1) !== m) seen.push(m);
        const atEnd = await o.page.evaluate(
          () =>
            window.innerHeight + window.scrollY >=
            document.documentElement.scrollHeight - 2,
        );
        if (atEnd) break;
        await o.page.mouse.wheel(0, 120);
        await o.page.waitForTimeout(60);
      }
      // Every section, once each, in the nav's order: the mark never skips or jumps back.
      expect(seen, JSON.stringify(seen)).toEqual(order);

      // A picked section holds once the scroll lands, though a card may share its top.
      for (const pick of ["License", "Get it"]) {
        await links.getByRole("link", { name: pick }).click();
        await o.page.waitForTimeout(300);
        expect(await marked(o.page, nav)).toBe(pick);
      }
      expect(await o.violations()).toEqual([]);
      await o.close();
    });
  }
});

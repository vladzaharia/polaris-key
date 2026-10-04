import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browser } from "../src/portal/browser.js";
import {
  artifact,
  axeViolations,
  DAY,
  fetchedRequests,
  license,
  mockFetch,
  NOW_S,
  release,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nightfall = license({
  product: "nightfall",
  tier: "lifetime",
  deviceCount: 2,
});
const tidewater = license({
  product: "tidewater",
  productName: "Tidewater Studio",
  tier: "pro",
  activatedAt: NOW_S - 3 * DAY,
});
const ember = license({
  product: "ember-tactics",
  productName: "Ember Tactics",
  expiresAt: NOW_S - 20 * DAY,
  usable: false,
  activatedAt: NOW_S - 60 * DAY,
});
const nightfallRelease = release({
  product: "nightfall",
  version: "1.4.2",
  artifacts: [
    artifact({
      artifactId: "mac",
      name: "Nightfall.dmg",
      platform: "macos",
      arch: "universal",
    }),
  ],
});

async function library(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Your library" });
}

describe("Library on today's data (PX-02)", () => {
  it("empty: names the email and offers Activate a license", async () => {
    mockFetch(signedIn([]));
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        name: "Nothing here for mara@fennick.studio yet",
      }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Activate a license" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Activate a license" }),
    ).toBeTruthy();
    // The Discover teaser waits for G24.
    expect(screen.queryByText(/Discover/)).toBeNull();
  });

  it("one product: the hero with the solid download and the summary", async () => {
    mockFetch(
      signedIn([nightfall], {
        "/api/releases": { releases: [nightfallRelease] },
      }),
    );
    renderPortal();
    await library();
    const hero = await screen.findByRole("article", { name: "Nightfall" });
    expect(within(hero).getByText("Active")).toBeTruthy();
    expect(within(hero).getByText("Lifetime")).toBeTruthy();
    const download = within(hero).getByRole("button", {
      name: /^Download for macOS: Nightfall/,
    });
    expect(download.textContent).toContain(
      "Version 1.4.2 · Universal · 2.1 GB",
    );
    expect(within(hero).getByText("2 devices in use")).toBeTruthy();
    expect(
      screen.getByText(/That's everything linked to mara@fennick.studio/),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("starts a download with a fresh link", async () => {
    const go = vi.spyOn(browser, "go").mockImplementation(() => undefined);
    mockFetch(
      signedIn([nightfall], {
        "/api/releases": { releases: [nightfallRelease] },
        "POST /api/releases/nightfall/rel_1.4.2/artifacts/mac/token": {
          status: 201,
          body: { url: "/download/tok" },
        },
      }),
    );
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Download for macOS/ }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledWith("/download/tok"));
  });

  it("2–7 products: large tiles with outlined quick actions, reasons as text", async () => {
    mockFetch(
      signedIn([nightfall, tidewater, ember], {
        "/api/releases": { releases: [nightfallRelease] },
      }),
    );
    renderPortal();
    await library();
    expect(
      await screen.findByText("3 products ·", { exact: false }),
    ).toBeTruthy();
    const tiles = screen.getAllByRole("article");
    expect(
      tiles.map(
        (t) => within(t).getByRole("heading", { level: 3 }).textContent,
      ),
    ).toEqual(["Tidewater Studio", "Nightfall", "Ember Tactics"]);
    const emberTile = screen.getByRole("article", { name: "Ember Tactics" });
    expect(within(emberTile).getByText("Expired")).toBeTruthy();
    expect(within(emberTile).getByText(/^Ended /)).toBeTruthy();
    // No solid violet on a tile: every quick action is the quiet variant.
    expect(
      within(emberTile).getByRole("link", {
        name: "View details: Ember Tactics",
      }).className,
    ).toContain("border-border-strong");
    expect(
      screen.getByRole("button", { name: "More for Nightfall" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("8+ products: the compact grid under All products, the shelf only with actions", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      license({
        product: `p${i}`,
        productName: `Product ${i}`,
        activatedAt: NOW_S - i * DAY,
      }),
    );
    many.push(
      license({
        product: "glyphsmith",
        productName: "Glyphsmith",
        tier: "studio",
        expiresAt: NOW_S + 9 * DAY,
        activatedAt: NOW_S - 99 * DAY,
        productBranding: {
          developerName: "Northpaw Type",
          supportUrl: "https://northpaw.example/renew",
        },
      }),
    );
    mockFetch(signedIn(many));
    renderPortal();
    await library();
    expect(
      await screen.findByRole("heading", { name: /All products/ }),
    ).toBeTruthy();
    const shelf = screen.getByRole("region", { name: /Needs attention/ });
    expect(
      within(shelf)
        .getByRole("link", { name: "Renew with Northpaw Type" })
        .getAttribute("href"),
    ).toBe("https://northpaw.example/renew");
    expect(screen.getAllByRole("article")).toHaveLength(10);
  });

  it("shows the error with Retry instead of an empty library", async () => {
    mockFetch(
      signedIn([], {
        "/api/licenses": { status: 500, body: { error: "internal" } },
      }),
    );
    renderPortal();
    expect(
      await screen.findByRole("heading", { name: "Something went wrong" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Nothing here/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("asks for releases only when the module is on", async () => {
    mockFetch(signedIn([nightfall]));
    renderPortal();
    await screen.findByRole("article", { name: "Nightfall" });
    expect(fetchedRequests()).toContain("GET /api/releases");
  });
});

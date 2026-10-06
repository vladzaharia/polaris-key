import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  artifact,
  axeViolations,
  dlFile,
  downloadsView,
  storeLink,
  CAPS_ALL,
  DAY,
  detail,
  device,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  NOW_S,
  release,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * The License card's **License source** fact (owner, 2026-10-06: the origin moved from the meta
 * line into the facts grid, beside "Activated"); throws while the card has no such field.
 */
function licenseSource(card: HTMLElement): string | null {
  const term = within(card).getByText("License source");
  expect(term.tagName).toBe("DT");
  return term.nextElementSibling?.textContent ?? null;
}

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

const nightfall = license({
  product: "nightfall",
  tier: "deluxe",
  deviceCount: 2,
  maxOfflineDays: 30,
  maxVersion: "1.x",
  entitlements: [
    { key: "soundtrack", label: "Original soundtrack", value: true },
    { key: "artbook", label: "Digital art book", value: true },
  ],
});
const nightfallDetail = detail(nightfall, {
  devices: [
    device({ deviceId: "d1", label: "Mara's MacBook Pro" }),
    device({
      deviceId: "d2",
      label: "Studio PC",
      platform: "windows",
      arch: "x86_64",
    }),
    device({ deviceId: "d3", label: "Old laptop", status: "deauthorized" }),
  ],
});
const releases = [
  release({
    product: "nightfall",
    version: "1.4.2",
    notes:
      "- New Photo Mode with free camera.\n- Steadier 40 fps on Steam Deck.",
    artifacts: [
      artifact({
        artifactId: "mac",
        name: "Nightfall-1.4.2.dmg",
        platform: "macos",
        arch: "universal",
        sizeBytes: 3_100_000_000,
      }),
      artifact({
        artifactId: "win",
        name: "Nightfall-1.4.2.exe",
        platform: "windows",
        arch: "x86_64",
      }),
      artifact({
        artifactId: "ost",
        name: "Original soundtrack.zip",
        platform: null,
        access: "entitled",
        canDownload: false,
        sha256: null,
      }),
    ],
  }),
  release({
    product: "nightfall",
    version: "1.4.1",
    publishedAt: NOW_S - 30 * DAY,
  }),
];

function routes(extra = {}) {
  return signedIn(
    [nightfall, license({ product: "ember", productName: "Ember Tactics" })],
    {
      "/api/releases": { releases },
      "/api/licenses/nightfall/lic_nightfall": nightfallDetail,
      ...extra,
    },
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/#/p/nightfall");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function page(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Nightfall" });
  await screen.findByText("Activated");
}

describe("product page on today's data (PX-04)", () => {
  it("renders the header with the one lead action and only the sections that apply", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    expect(document.title).toBe("Nightfall · Polaris Key");
    expect(
      within(screen.getByRole("main"))
        .getByRole("link", { name: "Library" })
        .getAttribute("href"),
    ).toBe("#/");
    const navs = [
      screen.getByRole("navigation", { name: "Sections" }),
      screen.getByRole("navigation", { name: "On this page" }),
    ];
    for (const nav of navs) {
      const items = within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent);
      expect(items).not.toContain("Cloud Sync");
      expect(items).not.toContain("Package access");
      expect(items).not.toContain("Help");
    }
    // Desktop TOC order, then the phone's task order.
    expect(
      within(navs[1]!)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Get it", "What's new", "License", "Devices 2"]);
    expect(
      within(navs[0]!)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Get it", "License", "Devices 2", "What's new"]);
    expect(document.body.textContent).not.toMatch(/Cloud Sync/);
    expect(await axeViolations()).toEqual([]);
  });

  it("puts the icon in front of the cover, and stands it alone without one (§4.20)", async () => {
    const item = (over: Record<string, unknown>) =>
      routes({
        "/api/library": libraryFor([nightfall], undefined, over),
      });
    // No cover: no banner, the letter tile beside the name.
    mockFetch(item({}));
    renderPortal();
    await page();
    let header = document.querySelector("[data-cover]")!;
    expect(header.getAttribute("data-cover")).toBe("none");
    expect(header.previousElementSibling?.getAttribute("data-art")).toBeNull();
    expect(header.querySelector("[data-art]")!.textContent).toBe("N");
    cleanup();

    // A cover and an icon: the banner, then the icon tile stacked in front of it.
    mockFetch(
      item({
        iconUrl: "/media/nightfall/icon?v=1",
        headerUrl: "/media/nightfall/header?v=1",
      }),
    );
    renderPortal();
    await page();
    header = document.querySelector("[data-cover]")!;
    expect(header.getAttribute("data-cover")).toBe("image");
    expect(header.previousElementSibling?.getAttribute("data-art")).toBe(
      "image",
    );
    const icon = header.querySelector("img[data-art]")!;
    expect(icon.className).toMatch(/\brelative\b/);
    expect(icon.className).toMatch(/\bz-10\b/);
    expect(icon.className).toMatch(/-mt-/);
    cleanup();

    // A cover and no icon: the letter tile in front of the cover.
    mockFetch(item({ headerUrl: "/media/nightfall/header?v=1" }));
    renderPortal();
    await page();
    header = document.querySelector("[data-cover]")!;
    expect(header.getAttribute("data-cover")).toBe("image");
    const tile = header.querySelector("[data-art='fallback']")!;
    expect(tile.textContent).toBe("N");
    expect(tile.className).toMatch(/\bz-10\b/);
  });

  it("shows the license facts, the masked key and what it includes", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    const card = screen.getByRole("region", { name: "Nightfall license" });
    expect(within(card).getByText("Lifetime")).toBeTruthy();
    expect(within(card).queryByText("For life")).toBeNull();
    // The tier is a neutral pill with the device count beside it.
    const tier = within(card).getByText("Deluxe").closest("[data-status]")!;
    expect(tier.getAttribute("data-status")).toBe("pill");
    expect(tier.getAttribute("data-tone")).toBe("neutral");
    expect(within(card).getByText("2 devices")).toBeTruthy();
    expect(within(card).getByText("Up to 1.x")).toBeTruthy();
    expect(within(card).getByText("30 days")).toBeTruthy();
    expect(
      within(card).getByRole("img", { name: "License key for nightfall" })
        .textContent,
    ).toBe("pkey_nightfall_…");
    expect(within(card).getByText(/can’t be shown again/)).toBeTruthy();
    expect(within(card).getByText("Original soundtrack")).toBeTruthy();
    // No "Get a new key" until G7.
    expect(within(card).queryByText(/Get a new key/)).toBeNull();
  });

  it("says nothing when healthy and keeps the facts as text (UX-03)", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    // Healthy is silence: no "Active" pill in the header or on the License card.
    expect(within(screen.getByRole("main")).queryByText("Active")).toBeNull();
    const card = screen.getByRole("region", { name: "Nightfall license" });
    // The tier is a neutral pill on the License card (owner, 2026-10-05, overriding UX-03's
    // "tier as text" for this card only); the facts stay as text.
    expect(within(card).getByText("Deluxe")).toBeTruthy();
    expect(within(card).queryByText("Tier")).toBeNull();
    expect(within(card).getByText("Updates included").tagName).toBe("DT");
    const included = within(card).getByRole("list", { name: "Included" });
    expect(
      within(included)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Original soundtrack", "Digital art book"]);
  });

  it("shows an issue once, in the header, not again on the License card (UX-03)", async () => {
    const lapsed = license({
      product: "nightfall",
      tier: "deluxe",
      expiresAt: NOW_S - 3 * DAY,
    });
    mockFetch(
      signedIn([lapsed], {
        "/api/releases": { releases },
        "/api/licenses/nightfall/lic_nightfall": detail(lapsed, {
          devices: [],
        }),
      }),
    );
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Nightfall",
    });
    const card = await screen.findByRole("region", {
      name: "Nightfall license",
    });
    await within(card).findByText("Updates included");
    expect(within(h1.parentElement!).getByText("Expired")).toBeTruthy();
    expect(within(card).queryByText("Expired")).toBeNull();
  });

  it("masks a key with its last 4 when the Worker sends them", async () => {
    mockFetch(
      routes({
        "/api/licenses/nightfall/lic_nightfall": detail(nightfall, {
          keys: [
            {
              hash: "h",
              last4: "Tz4g",
              status: "active",
              label: null,
              createdAt: 1,
              lastUsedAt: null,
            },
          ],
        }),
      }),
    );
    renderPortal();
    await page();
    expect(
      screen.getByRole("img", { name: "License key ending Tz4g" }).textContent,
    ).toBe("pkey_nightfall_…Tz4g");
  });

  it("recommends the Universal Mac build and marks what isn't included, in words", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    const get = screen.getByRole("region", { name: "Get Nightfall" });
    expect(within(get).getByText("Recommended for your Mac")).toBeTruthy();
    expect(
      within(get).getByText(/Runs on Apple silicon and Intel/),
    ).toBeTruthy();
    expect(within(get).getByText("Not included")).toBeTruthy();
    // /api/releases says "no" without saying why (it may just not be servable yet): no claim
    // about the license's coverage.
    expect(within(get).getByText("Not available here yet")).toBeTruthy();
    expect(
      within(get).queryByText("Your license doesn't include this version"),
    ).toBeNull();
    expect(within(get).getByText("Extras")).toBeTruthy();
    expect(
      within(get).getAllByRole("button", { name: /Copy SHA-256/ }).length,
    ).toBeGreaterThan(0);
    const news = screen.getByRole("region", { name: "What's new in 1.4.2" });
    expect(
      within(news).getByText("New Photo Mode with free camera."),
    ).toBeTruthy();
    expect(within(news).getByText("1.4.1")).toBeTruthy();
  });

  it("uses the downloads view (PX-W2): the older covered release, reasons and store links", async () => {
    const f = (over: Record<string, unknown>) => ({
      releaseId: "r18",
      artifactId: "a",
      version: "1.8",
      name: "Nightfall.dmg",
      buildId: null,
      platform: "macos",
      arch: "universal",
      format: "dmg",
      role: "payload",
      sizeBytes: 1_000_000,
      sha256: null,
      minOs: null,
      canDownload: true,
      reason: null,
      ...over,
    });
    const old = f({ artifactId: "old-mac" });
    const newer = f({
      artifactId: "new-mac",
      releaseId: "r20",
      version: "2.0",
      canDownload: false,
      reason: "not_entitled",
    });
    mockFetch(
      routes({
        "/api/products/nightfall/downloads": {
          product: { slug: "nightfall", name: "Nightfall" },
          channel: "stable",
          available: true,
          access: "entitled",
          detected: { platform: "macos", arch: null, touchAmbiguous: false },
          latest: {
            releaseId: "r20",
            version: "2.0",
            title: null,
            publishedAt: NOW_S - DAY,
          },
          recommended: {
            platform: "macos",
            label: "macOS",
            releaseId: "r18",
            version: "1.8",
            universal: true,
            latest: false,
            files: [old],
          },
          platforms: [
            {
              platform: "macos",
              label: "macOS",
              recommended: null,
              files: [newer],
            },
          ],
          extras: [],
          stores: [
            {
              id: "steam:main",
              kind: "steam",
              outletId: "main",
              platforms: ["macos"],
              label: "Steam",
              url: "https://store.steampowered.com/app/1/",
              deepLink: null,
              command: null,
              activateUrl: null,
              live: true,
              version: "2.0",
            },
          ],
        },
      }),
    );
    renderPortal();
    await page();
    const get = await screen.findByRole("region", { name: "Get Nightfall" });
    await within(get).findByText(/Version 2.0 isn't included in your license/);
    expect(get.textContent).toContain("Your license covers 1.8");
    expect(
      within(get).getByText("Your license doesn't include this version"),
    ).toBeTruthy();
    expect(within(get).getByRole("link", { name: /Steam/ })).toBeTruthy();
    expect(
      within(get).getByRole("button", {
        name: "Download Nightfall 1.8 for macOS Universal",
      }),
    ).toBeTruthy();
  });

  it("shows the seat limit from the library (G5)", async () => {
    mockFetch(
      routes({
        "/api/library": {
          products: [
            {
              product: "nightfall",
              name: "Nightfall",
              developerName: "Kiln Games",
              tintColor: null,
              website: null,
              iconUrl: null,
              headerUrl: null,
              support: null,
              status: "active",
              license: {
                id: "lic_nightfall",
                tier: "deluxe",
                status: "active",
                licenseStatus: "active",
                activatedAt: NOW_S,
                expiresAt: null,
                maxOfflineDays: 30,
                deviceLimit: 3,
                activeSeatCount: 2,
                deviceCount: 2,
                dormantCount: 0,
              },
              licenseCount: 1,
              addedAt: NOW_S,
            },
          ],
        },
      }),
    );
    renderPortal();
    await page();
    expect(screen.getByText("by", { exact: false }).textContent).toContain(
      "Kiln Games",
    );
    const devices = screen.getByRole("region", { name: "Devices" });
    expect(devices.textContent).toContain("2 of 3 devices in use");
  });

  it("removes a device inline: consequences, focus on the heading, Keep it, then Remove", async () => {
    mockFetch(
      routes({
        "DELETE /api/licenses/nightfall/lic_nightfall/devices/d2": {
          ok: true,
          deviceId: "d2",
        },
      }),
    );
    renderPortal();
    await page();
    const devices = screen.getByRole("region", { name: "Devices" });
    expect(within(devices).getByText(/\+1 not using a seat/)).toBeTruthy();
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Studio PC" }),
    );
    const heading = within(devices).getByRole("heading", {
      name: "Remove Studio PC?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(devices).getByText(
        "Its seat is free straight away: 1 device in use.",
      ),
    ).toBeTruthy();
    // Mail is configured in this fixture (capabilities.auth.magic), so the notice is promised.
    expect(
      within(devices).getByText("We'll email you to confirm."),
    ).toBeTruthy();
    await userEvent.click(
      within(devices).getByRole("button", { name: "Keep it" }),
    );
    expect(
      within(devices).queryByRole("heading", { name: "Remove Studio PC?" }),
    ).toBeNull();
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Studio PC" }),
    );
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Studio PC" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain(
        "DELETE /api/licenses/nightfall/lic_nightfall/devices/d2",
      ),
    );
    expect(await screen.findByText("Studio PC was removed")).toBeTruthy();
    // The row is gone; focus goes to the product's h1, never body (FLOWS.md P-7).
    const h1 = screen.getByRole("heading", { level: 1, name: "Nightfall" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("promises no confirmation email when the Worker can't send mail", async () => {
    mockFetch(
      signedIn(
        [nightfall],
        {
          "/api/releases": { releases },
          "/api/licenses/nightfall/lic_nightfall": nightfallDetail,
        },
        { ...CAPS_ALL, auth: { oidc: true, magic: false } },
      ),
    );
    renderPortal();
    await page();
    const devices = screen.getByRole("region", { name: "Devices" });
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Studio PC" }),
    );
    await within(devices).findByRole("heading", { name: "Remove Studio PC?" });
    expect(
      within(devices).queryByText("We'll email you to confirm."),
    ).toBeNull();
  });

  it("switches between several licenses for one product", async () => {
    const edu = license({
      product: "nightfall",
      id: "lic_edu",
      tier: "edu",
      activatedAt: NOW_S - 99 * DAY,
    });
    mockFetch(
      signedIn([nightfall, edu], {
        "/api/releases": { releases },
        "/api/licenses/nightfall/lic_nightfall": nightfallDetail,
        "/api/licenses/nightfall/lic_edu": detail(edu, { devices: [] }),
      }),
    );
    renderPortal();
    await page();
    const select = screen.getByRole("combobox", {
      name: /2 licenses · Deluxe, Edu/,
    });
    await userEvent.selectOptions(select, "lic_edu");
    expect(window.location.hash).toBe("#/p/nightfall?license=lic_edu");
    expect(
      await screen.findByText(/No device is using this license/),
    ).toBeTruthy();
  });

  it("says when a product isn't in the library, never 'portal api 404'", async () => {
    window.history.replaceState(null, "", "/#/p/unknown-thing");
    mockFetch(routes());
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "That product isn't in your library",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("main")).getByText("mara@fennick.studio"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to your library" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/404|portal api/);
    await userEvent.click(
      screen.getByRole("button", { name: "Activate a license" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Activate a license" }),
    ).toBeTruthy();
  });

  it("shows a load error with Retry inside the cards", async () => {
    mockFetch(
      routes({
        "/api/licenses/nightfall/lic_nightfall": {
          status: 500,
          body: { error: "internal" },
        },
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    expect(
      (await screen.findAllByRole("button", { name: "Try again" })).length,
    ).toBeGreaterThan(0);
  });

  it("a sign-in licence: Standard pill, its device count, a quiet origin, and its devices with Remove", async () => {
    window.history.replaceState(null, "", "/#/p/quill");
    const quill = license({
      product: "quill",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
    });
    const removed: string[] = [];
    mockFetch(
      signedIn([quill], {
        "/api/licenses/quill/lic_quill": detail(quill, {
          keys: [],
          devices: [device({ deviceId: "q1", label: "Living room PC" })],
        }),
        "/api/products/quill": productView("quill", [
          { id: "lic_quill", deviceLimit: 5 },
        ]),
        "DELETE /api/licenses/quill/lic_quill/devices/q1": () => {
          removed.push("q1");
          return { ok: true, deviceId: "q1" };
        },
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Quill" });
    const card = await screen.findByRole("region", { name: "Quill license" });
    await within(card).findByText("1 of 5 devices");
    expect(within(card).getByText("Standard")).toBeTruthy();
    expect(licenseSource(card)).toBe("From signing in");
    // Owner decision (2026-10-05): no licence type label; every licence is account-bound.
    expect(screen.queryByText(/Account-wide/)).toBeNull();
    expect(screen.queryByText("Signed-in app")).toBeNull();
    expect(screen.queryByText(/any device/i)).toBeNull();
    const devices = screen.getByRole("region", { name: "Devices" });
    expect(within(devices).getByText(/of 5 devices/)).toBeTruthy();
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Living room PC" }),
    );
    expect(within(devices).getByText(/asks you to sign in again/)).toBeTruthy();
    await userEvent.click(
      within(devices).getByRole("button", { name: "Remove Living room PC" }),
    );
    await waitFor(() => expect(removed).toEqual(["q1"]));
    expect(await axeViolations()).toEqual([]);
  });

  it("a sign-in licence never claims a limit it doesn't know", async () => {
    window.history.replaceState(null, "", "/#/p/quill");
    const quill = license({
      product: "quill",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
    });
    mockFetch(
      signedIn([quill], {
        "/api/licenses/quill/lic_quill": detail(quill, { keys: [] }),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", { name: "Quill license" });
    await within(card).findByText("Activated");
    expect(licenseSource(card)).toBe("From signing in");
    expect(within(card).queryByText(/of \d+ devices?/)).toBeNull();
    expect(within(card).queryByText(/Account-wide/)).toBeNull();
  });

  describe("a key licence and a sign-in licence for one product", () => {
    const key = license({
      product: "quill",
      id: "lic_key",
      activatedAt: NOW_S - 60 * DAY,
    });
    const acct = license({
      product: "quill",
      id: "lic_acct",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
    });
    const both = (extra = {}) =>
      signedIn([key, acct], {
        "/api/licenses/quill/lic_key": detail(key, {
          devices: [device({ deviceId: "k1", label: "Studio Mac" })],
        }),
        "/api/licenses/quill/lic_acct": detail(acct, {
          keys: [],
          devices: [device({ deviceId: "a1", label: "Living room PC" })],
        }),
        "/api/products/quill": productView("quill", [
          { id: "lic_acct", deviceLimit: 5 },
          { id: "lic_key", deviceLimit: 3 },
        ]),
        ...extra,
      });

    it("names each licence by tier and its origin in the picker", async () => {
      window.history.replaceState(null, "", "/#/p/quill");
      mockFetch(both());
      renderPortal();
      const card = await screen.findByRole("region", { name: "Quill license" });
      const picker = within(card).getByRole("combobox");
      const options = within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent);
      expect(options.sort()).toEqual(["Standard · Key", "Standard · Sign-in"]);
    });

    it("the key licence hides its device counter but keeps the device list", async () => {
      window.history.replaceState(null, "", "/#/p/quill?license=lic_key");
      mockFetch(both());
      renderPortal();
      const card = await screen.findByRole("region", { name: "Quill license" });
      await within(card).findByText("Activated");
      expect(within(card).getByText("Standard")).toBeTruthy();
      expect(within(card).queryByText(/devices?$/)).toBeNull();
      const devices = screen.getByRole("region", { name: "Devices" });
      await within(devices).findByText("Studio Mac");
      expect(within(devices).queryByText(/in use/)).toBeNull();
      expect(
        within(devices).queryByRole("img", { name: /devices? in use/ }),
      ).toBeNull();
      await userEvent.click(
        within(devices).getByRole("button", { name: "Remove Studio Mac" }),
      );
      expect(
        within(devices).getByText("Its seat is free straight away."),
      ).toBeTruthy();
    });

    it("the sign-in licence keeps its counter", async () => {
      window.history.replaceState(null, "", "/#/p/quill?license=lic_acct");
      mockFetch(both());
      renderPortal();
      const card = await screen.findByRole("region", { name: "Quill license" });
      await within(card).findByText("1 of 5 devices");
      const devices = screen.getByRole("region", { name: "Devices" });
      await within(devices).findByText("Living room PC");
      expect(
        within(devices).getByRole("img", { name: "1 of 5 devices in use" }),
      ).toBeTruthy();
    });
  });
});

describe("a licence's origin names the store it came from (owner, 2026-10-05)", () => {
  it('a Steam-bound key licence reads "Steam key" on the card and in the picker', async () => {
    window.history.replaceState(null, "", "/#/p/quill");
    const steam = license({ product: "quill", id: "lic_steam" });
    const other = license({
      product: "quill",
      id: "lic_dev",
      activatedAt: NOW_S - 90 * DAY,
    });
    mockFetch(
      signedIn([steam, other], {
        "/api/licenses/quill/lic_steam": detail(steam, {
          keys: [
            {
              hash: "h1",
              last4: "3WPLDA",
              status: "active",
              label: null,
              createdAt: NOW_S - 30 * DAY,
              lastUsedAt: null,
            },
          ],
        }),
        "/api/products/quill": productView("quill", [
          {
            id: "lic_steam",
            deviceLimit: 3,
            purchase: { source: "store", store: "steam" },
          },
          {
            id: "lic_dev",
            deviceLimit: 3,
            purchase: { source: "developer", store: null },
          },
        ]),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", { name: "Quill license" });
    await waitFor(() =>
      expect(licenseSource(card)).toBe("Steam key ending 3WPLDA"),
    );
    const options = within(within(card).getByRole("combobox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toContain("Standard · Steam key …3WPLDA");
    expect(options).toContain("Standard · Key");
  });

  it('a store-bound licence with no key reads "From Steam"', async () => {
    window.history.replaceState(null, "", "/#/p/quill");
    const bound = license({
      product: "quill",
      keyCount: 0,
      activeKeyCount: 0,
    });
    mockFetch(
      signedIn([bound], {
        "/api/licenses/quill/lic_quill": detail(bound, { keys: [] }),
        "/api/products/quill": productView("quill", [
          {
            id: "lic_quill",
            deviceLimit: 2,
            purchase: { source: "store", store: "steam" },
          },
        ]),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", { name: "Quill license" });
    await waitFor(() => expect(licenseSource(card)).toBe("From Steam"));
    expect(within(card).getByText("Standard")).toBeTruthy();
  });
});

describe("licence origins and Remove from my library (PX-23)", () => {
  const LITTLE_FERN = { developerName: "Little Fern" };

  it("the License source sits beside Activated; the term is not repeated under the tier", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const added = license({
      product: "mossgarden",
      productName: "Mossgarden",
      email: "",
      origin: "key",
      originStore: null,
    });
    mockFetch(
      signedIn([added], {
        "/api/licenses/mossgarden/lic_mossgarden": detail(added),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", {
      name: "Mossgarden license",
    });
    await within(card).findByText("License source");
    expect(licenseSource(card)).toBe("Added with a key");
    // The facts read in order: … Activated, then License source (owner, 2026-10-06).
    const terms = [...card.querySelectorAll("dt")].map((d) => d.textContent);
    expect(terms.indexOf("License source")).toBe(
      terms.indexOf("Activated") + 1,
    );
    // "Lifetime" once, as Updates included; no "<origin> · <term>" meta line.
    expect(within(card).getAllByText("Lifetime")).toHaveLength(1);
    expect(within(card).queryByText(/ · (Lifetime|Expires|Ended)/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("the Worker's origin wins: a licence the developer assigned reads From <Developer>, even with a key", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const assigned = license({
      product: "mossgarden",
      productName: "Mossgarden",
      productBranding: LITTLE_FERN,
      origin: "developer",
      originStore: null,
    });
    const steam = license({
      product: "mossgarden",
      productName: "Mossgarden",
      id: "lic_steam",
      activatedAt: NOW_S - 90 * DAY,
      productBranding: LITTLE_FERN,
      origin: "store-key",
      originStore: "steam",
    });
    mockFetch(
      signedIn([assigned, steam], {
        "/api/licenses/mossgarden/lic_mossgarden": detail(assigned),
        "/api/licenses/mossgarden/lic_steam": detail(steam),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", {
      name: "Mossgarden license",
    });
    await within(card).findByText("License source");
    expect(licenseSource(card)).toBe("From Little Fern");
    const options = within(within(card).getByRole("combobox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    // The store comes from the summary itself (`originStore`), no product view needed.
    expect(options.sort()).toEqual([
      "Standard · From Little Fern",
      "Standard · Steam key",
    ]);
  });

  /**
   * A product whose licences the routes below remove (the Worker's state, mutable). Each licence
   * is `removable` unless it says otherwise; `refuse` answers the DELETE instead (another tab's
   * removal, a refusal).
   */
  function removable(
    given: ReturnType<typeof license>[],
    sync = false,
    refuse?: { status: number; body: unknown },
  ) {
    const held = given.map((l) => ({ removable: true, ...l }));
    let list = [...held];
    const removed: string[] = [];
    const extra: Record<string, unknown> = {
      "/api/licenses": () => ({ licenses: list }),
      "/api/library": () => libraryFor(list),
      "/api/products/mossgarden": {
        ...productView(
          "mossgarden",
          held.map((l) => ({ id: l.id, deviceLimit: 3 })),
        ),
        services: { license: true, sync },
      },
    };
    for (const l of held) {
      extra[`/api/licenses/mossgarden/${l.id}`] = detail(l);
      extra[`DELETE /api/licenses/mossgarden/${l.id}`] = () => {
        if (refuse) {
          if (refuse.status === 404) list = list.filter((x) => x.id !== l.id);
          return refuse;
        }
        removed.push(l.id);
        list = list.filter((x) => x.id !== l.id);
        return { ok: true, product: "mossgarden", licenseId: l.id };
      };
    }
    return { extra, removed };
  }

  async function openRemove(name: string): Promise<HTMLElement> {
    await screen.findByRole("heading", { level: 1, name: "Mossgarden" });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Mossgarden" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from my library" }),
    );
    return screen.findByRole("alertdialog", { name });
  }

  it("a licence the developer assigned: not in an account, never back by itself; then the Library", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const assigned = license({
      product: "mossgarden",
      productName: "Mossgarden",
      origin: "developer",
    });
    const { extra, removed } = removable([assigned], true);
    mockFetch(signedIn([assigned], extra as never));
    renderPortal();
    const dialog = await openRemove("Remove Mossgarden from your library?");
    expect(within(dialog).getByText("Its devices keep working.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The devices you signed in on stop syncing it with Cloud Sync.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "It won't be in an account, and it won't come back to this account by itself. To add it again, use its key.",
      ),
    ).toBeTruthy();
    // Customers never read "floating" (S-24 D5).
    expect(within(dialog).queryByText(/floating/i)).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove from my library" }),
    );
    await waitFor(() => expect(removed).toEqual(["lic_mossgarden"]));
    expect(fetchedRequests()).toContain(
      "DELETE /api/licenses/mossgarden/lic_mossgarden",
    );
    await screen.findByText("Mossgarden was removed from your library");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("a floating key Mara added: anyone with the key can add it; Keep it changes nothing; no Cloud Sync line without the service", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const added = license({
      product: "mossgarden",
      productName: "Mossgarden",
      email: "",
      origin: "key",
    });
    const { extra, removed } = removable([added]);
    mockFetch(signedIn([added], extra as never));
    renderPortal();
    const dialog = await openRemove("Remove Mossgarden from your library?");
    expect(
      within(dialog).getByText(
        "It won't be in an account: anyone with the key can add it, and it won't come back to this account by itself.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Cloud Sync/)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep it" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removed).toEqual([]);
  });

  it("offers no Remove for a licence its key can't bring back: a sign-in licence, a Discover claim", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    // A Discover claim: minted by the auto-issue path, keyless; the Worker says removable false.
    const claimed = license({
      product: "mossgarden",
      productName: "Mossgarden",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
      origin: "signin",
      removable: false,
    });
    const { extra } = removable([claimed]);
    // The helper defaults removable to true only where the licence says nothing.
    mockFetch(signedIn([claimed], extra as never));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Mossgarden" });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Mossgarden" }),
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Manage devices",
      "Copy link",
    ]);
  });

  it("an older Worker that doesn't say removable offers no Remove", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const old = license({ product: "mossgarden", productName: "Mossgarden" });
    mockFetch(
      signedIn([old], {
        "/api/licenses/mossgarden/lic_mossgarden": detail(old),
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Mossgarden" });
    await userEvent.click(
      screen.getByRole("button", { name: "More for Mossgarden" }),
    );
    await screen.findAllByRole("menuitem");
    expect(
      screen.queryByRole("menuitem", { name: "Remove from my library" }),
    ).toBeNull();
  });

  it("focus starts on Keep it, the least destructive action", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const added = license({
      product: "mossgarden",
      productName: "Mossgarden",
      email: "",
      origin: "key",
    });
    const { extra } = removable([added]);
    mockFetch(signedIn([added], extra as never));
    renderPortal();
    const dialog = await openRemove("Remove Mossgarden from your library?");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Keep it" }),
      ),
    );
  });

  it("removed in another tab (404): it counts as removed, and the page goes to the Library", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const added = license({
      product: "mossgarden",
      productName: "Mossgarden",
      email: "",
      origin: "key",
    });
    const { extra } = removable([added], false, {
      status: 404,
      body: { error: "not_found" },
    });
    mockFetch(signedIn([added], extra as never));
    renderPortal();
    const dialog = await openRemove("Remove Mossgarden from your library?");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove from my library" }),
    );
    await screen.findByText("Mossgarden was removed from your library");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refusal (409 not_removable) says why, inline, and the page stops offering Remove", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden");
    const added = license({
      product: "mossgarden",
      productName: "Mossgarden",
      email: "",
      origin: "key",
    });
    const { extra } = removable([added], false, {
      status: 409,
      body: {
        error: "not_removable",
        message: "this license could not be added back, so it stays",
        reason: "key_claim_off",
      },
    });
    mockFetch(signedIn([added], extra as never));
    renderPortal();
    const dialog = await openRemove("Remove Mossgarden from your library?");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove from my library" }),
    );
    expect(await within(dialog).findByText("Can't remove")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This license can't be added back with a key, so it stays in your library.",
      ),
    ).toBeTruthy();
    expect(fetchedRequests()).toContain(
      "DELETE /api/licenses/mossgarden/lic_mossgarden",
    );
  });

  it("with several licences it names the one the page shows, and the product stays", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden?license=lic_two");
    const one = license({
      product: "mossgarden",
      productName: "Mossgarden",
      origin: "developer",
      productBranding: LITTLE_FERN,
    });
    const two = license({
      product: "mossgarden",
      productName: "Mossgarden",
      id: "lic_two",
      tier: "pro",
      email: "",
      activatedAt: NOW_S - 90 * DAY,
      origin: "key",
    });
    const { extra, removed } = removable([one, two]);
    mockFetch(signedIn([one, two], extra as never));
    renderPortal();
    const dialog = await openRemove(
      "Remove this Mossgarden license from your library?",
    );
    expect(
      within(dialog).getByText("Pro · Key. Your other license stays."),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove from my library" }),
    );
    await waitFor(() => expect(removed).toEqual(["lic_two"]));
    await screen.findByText("The Pro license was removed from your library");
    await waitFor(() => expect(window.location.hash).toBe("#/p/mossgarden"));
    await screen.findByRole("heading", { level: 1, name: "Mossgarden" });
  });
});

describe("product page correctness (UX-04)", () => {
  it("one OS source: the header's action and Get it name the OS the Worker detected", async () => {
    // The browser says Mac; the Worker (UA-CH) says Windows. Both read the Worker's answer.
    mockFetch(
      routes({
        "/api/products/nightfall/downloads": downloadsView(
          "nightfall",
          [
            dlFile({ artifactId: "m", platform: "macos" }),
            dlFile({ artifactId: "w", platform: "windows", arch: "x86_64" }),
          ],
          { recommend: "windows" },
        ),
      }),
    );
    renderPortal();
    await page();
    const get = await screen.findByRole("region", { name: "Get Nightfall" });
    await within(get).findByText("Recommended for your Windows PC");
    expect(within(get).queryByText(/Recommended for your Mac/)).toBeNull();
    expect(within(get).getByText(/Windows · x64/)).toBeTruthy();
    expect(
      screen.getAllByRole("button", {
        name: /^Download for Windows: Nightfall/,
      }).length,
    ).toBe(1);
    expect(
      screen.queryByRole("button", { name: /^Download for macOS/ }),
    ).toBeNull();
  });

  it("a not_hosted file says where to get it, never 'Not included'", async () => {
    mockFetch(
      routes({
        "/api/products/nightfall/downloads": downloadsView(
          "nightfall",
          [
            dlFile({ artifactId: "m", platform: "macos" }),
            dlFile({
              artifactId: "pack",
              name: "Sample pack.zip",
              platform: null,
              canDownload: false,
              reason: "not_hosted",
            }),
          ],
          {
            stores: [
              storeLink({
                kind: "steam",
                label: "Steam",
                url: "https://store.steampowered.com/app/1/",
              }),
            ],
          },
        ),
      }),
    );
    renderPortal();
    await page();
    const get = await screen.findByRole("region", { name: "Get Nightfall" });
    const steam = await within(get).findByRole("link", {
      name: "Get it from Steam",
    });
    expect(steam.getAttribute("href")).toBe(
      "https://store.steampowered.com/app/1/",
    );
    expect(within(get).queryByText("Not included")).toBeNull();
    expect(get.textContent).not.toContain("here yet");
  });

  it("no downloads and no website: the header never offers a 'View details' back to itself", async () => {
    window.history.replaceState(null, "", "/#/p/ember");
    mockFetch(routes());
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Ember Tactics" });
    expect(screen.queryByRole("link", { name: /View details/ })).toBeNull();
  });

  it("no downloads with a website: 'Get it from <developer>' everywhere", async () => {
    const ember = license({
      product: "ember",
      productName: "Ember Tactics",
      productBranding: {
        developerName: "Kiln Games",
        website: "https://kiln.example",
      },
    });
    window.history.replaceState(null, "", "/#/p/ember");
    mockFetch(signedIn([ember]));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Ember Tactics" });
    const lead = screen.getByRole("link", {
      name: "Get it from Kiln Games: Ember Tactics",
    });
    expect(lead.getAttribute("href")).toBe("https://kiln.example");
    expect(screen.queryByRole("link", { name: /View details/ })).toBeNull();
  });

  it("one device source: the Devices card counts seats as the free-device flow does", async () => {
    const seatLicense = {
      id: "lic_nightfall",
      tier: "deluxe",
      status: "active" as const,
      licenseStatus: "active",
      activatedAt: NOW_S,
      expiresAt: null,
      maxOfflineDays: 30,
      deviceLimit: 3,
      activeSeatCount: 1,
      deviceCount: 2,
      dormantCount: 1,
    };
    const productDevice = (deviceId: string, dormant: boolean) => ({
      deviceId,
      label: deviceId,
      platform: "macos",
      arch: null,
      appVersion: null,
      firstSeen: NOW_S - 200 * DAY,
      lastSeen: dormant ? NOW_S - 120 * DAY : NOW_S - DAY,
      dormant,
    });
    mockFetch(
      routes({
        "/api/products/nightfall": {
          product: "nightfall",
          name: "Nightfall",
          developerName: null,
          tintColor: null,
          website: null,
          iconUrl: null,
          headerUrl: null,
          support: null,
          services: { license: true },
          status: "active",
          addedAt: NOW_S,
          licenses: [
            {
              ...seatLicense,
              entitlements: [],
              // Studio PC (d2) is past the dormancy window: it holds no seat.
              devices: [productDevice("d1", false), productDevice("d2", true)],
            },
          ],
        },
      }),
    );
    renderPortal();
    await page();
    const devices = screen.getByRole("region", { name: "Devices" });
    await waitFor(() =>
      expect(devices.textContent).toContain("1 of 3 devices in use"),
    );
    expect(
      within(devices).queryByRole("button", { name: "Remove Studio PC" }),
    ).toBeNull();
    expect(
      within(devices).getByRole("button", {
        name: "Remove Mara's MacBook Pro",
      }),
    ).toBeTruthy();
  });
});

/** A minimal `GET /api/products/<p>`: the per-licence seat limits the product page reads. */
function productView(
  product: string,
  licenses: {
    id: string;
    deviceLimit: number;
    purchase?: { source: string; store: string | null } | null;
  }[],
) {
  return {
    product,
    name: product,
    developerName: null,
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    services: { license: true },
    status: "active",
    addedAt: NOW_S - 30 * DAY,
    licenses: licenses.map((l) => ({
      id: l.id,
      tier: null,
      status: "active",
      licenseStatus: "active",
      activatedAt: NOW_S - 30 * DAY,
      expiresAt: null,
      maxOfflineDays: null,
      deviceLimit: l.deviceLimit,
      activeSeatCount: 1,
      deviceCount: 1,
      dormantCount: 0,
      entitlements: [],
      devices: [],
      ...(l.purchase !== undefined ? { purchase: l.purchase } : {}),
    })),
  };
}

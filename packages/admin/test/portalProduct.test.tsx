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
  license,
  mockFetch,
  NOW_S,
  release,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

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

  it("shows the license facts, the masked key and what it includes", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    const card = screen.getByRole("region", { name: "Nightfall license" });
    expect(within(card).getByText("For life")).toBeTruthy();
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
    const tier = within(card).getByText("Tier");
    expect(tier.tagName).toBe("DT");
    expect(tier.nextElementSibling?.textContent).toBe("Deluxe");
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
    await within(card).findByText("Tier");
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

  it("an account-bound product has no Devices section", async () => {
    window.history.replaceState(null, "", "/#/p/quill");
    const quill = license({
      product: "quill",
      identityProvider: "oidc",
      keyCount: 0,
      activeKeyCount: 0,
    });
    mockFetch(
      signedIn([quill], {
        "/api/licenses/quill/lic_quill": detail(quill, {
          keys: [],
          devices: [],
        }),
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Quill" });
    expect(screen.getAllByText("Signed-in app").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
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

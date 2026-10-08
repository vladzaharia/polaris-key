import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  artifact,
  axeViolations,
  dlFile,
  downloadsView,
  installSource,
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
    // One order for both navs, the page's own (owner polish 2026-10-07): the side column's
    // License and Devices start beside Get it, so they come before What's new.
    for (const nav of navs)
      expect(
        within(nav)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["Get it", "License", "Devices 2", "What's new"]);
    // The device count is a small neutral pill, and the link still reads as one name.
    for (const nav of navs) {
      const devicesLink = within(nav).getByRole("link", { name: "Devices 2" });
      const pill = devicesLink.querySelector("[data-status=pill]")!;
      expect(pill.textContent).toBe("2");
      expect(pill.getAttribute("data-tone")).toBe("neutral");
    }
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
    // The tier is a neutral pill at the header's top right (owner polish 2026-10-07), and the
    // device count is the Devices card's alone.
    const tier = within(card).getByText("Deluxe").closest("[data-status]")!;
    expect(tier.getAttribute("data-status")).toBe("pill");
    expect(tier.getAttribute("data-tone")).toBe("neutral");
    const header = card.querySelector("h2")!.parentElement!.parentElement!;
    expect(header.lastElementChild!.contains(tier)).toBe(true);
    expect(within(card).queryByText(/^\d+ (of \d+ )?devices?$/)).toBeNull();
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

  it("an issue of the licence the card shows sits after the tier, both at the header's top right (owner polish 2026-10-07)", async () => {
    // The page header names the best licence's status (active); the card shows the expired one.
    const lapsed = license({
      product: "nightfall",
      id: "lic_old",
      tier: "pro",
      expiresAt: NOW_S - 3 * DAY,
      activatedAt: NOW_S - 400 * DAY,
    });
    window.history.replaceState(null, "", "/#/p/nightfall?license=lic_old");
    mockFetch(
      signedIn([nightfall, lapsed], {
        "/api/releases": { releases },
        "/api/licenses/nightfall/lic_nightfall": nightfallDetail,
        "/api/licenses/nightfall/lic_old": detail(lapsed, { devices: [] }),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", {
      name: "Nightfall license",
    });
    await within(card).findByText("Updates included");
    const pills = card.querySelector("[data-license-pills]")!;
    expect(
      Array.from(pills.querySelectorAll("[data-status=pill]")).map((p) => [
        p.textContent,
        p.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["Pro", "neutral"],
      ["Expired", "danger"],
    ]);
    expect(await axeViolations()).toEqual([]);
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
    await within(card).findByText("Activated");
    expect(within(card).getByText("Standard")).toBeTruthy();
    // Granted through OIDC at sign-in: "Automatic Grant" (owner polish 2026-10-07).
    expect(licenseSource(card)).toBe("Automatic Grant");
    // The count is the Devices card's alone.
    expect(within(card).queryByText(/of 5 devices/)).toBeNull();
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
    expect(licenseSource(card)).toBe("Automatic Grant");
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
      await within(card).findByText("Activated");
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
      name: "Get it from Steam (opens in a new tab)",
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

describe("product identity card (PX-13; §4.20, §3.1)", () => {
  it("shows how the product signs you in, only with Identity on", async () => {
    mockFetch(
      routes({
        "/api/products/nightfall": {
          ...productView("nightfall", [
            { id: "lic_nightfall", deviceLimit: 3 },
          ]),
          services: { license: true, identity: true },
        },
      }),
    );
    renderPortal();
    await page();
    const card = await screen.findByRole("region", {
      name: "Sign in to Nightfall",
    });
    expect(
      within(card).getByText(
        "It gets its own id for you, so developers can't match you across products.",
      ),
    ).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: "Manage sign-in methods" })
        .getAttribute("href"),
    ).toBe("#/account/methods");
    // Not a section of its own: the TOC and the pills don't list it.
    const toc = screen.getByRole("navigation", { name: "On this page" });
    expect(within(toc).queryByRole("link", { name: /Sign in/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("says nothing about sign-in for a product without Identity", async () => {
    mockFetch(
      routes({
        "/api/products/nightfall": productView("nightfall", [
          { id: "lic_nightfall", deviceLimit: 3 },
        ]),
      }),
    );
    renderPortal();
    await page();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Devices" }).textContent,
      ).toMatch(/of 3 devices/),
    );
    expect(screen.queryByRole("region", { name: /^Sign in to/ })).toBeNull();
  });
});

describe("What's new reads its notes as Markdown (owner polish 2026-10-07)", () => {
  const NOTES = [
    "## Highlights",
    "- **Photo Mode** with a free camera",
    "- Steadier 40 fps on [Steam Deck](https://store.example.com/deck)",
    "- Rumble no longer cuts out after a reload",
    "- Fourth fix <img src=x onerror=alert(1)>",
    "",
    "[Unsafe](javascript:alert(1)) and `pkey sync`.",
  ].join("\n");
  const withNotes = (notes: string) =>
    routes({
      "/api/releases": {
        releases: [{ ...releases[0]!, notes }, ...releases.slice(1)],
      },
    });

  it("shows a formatted summary, and the full notes in place on Show full notes", async () => {
    mockFetch(withNotes(NOTES));
    renderPortal();
    await page();
    const news = screen.getByRole("region", { name: "What's new in 1.4.2" });
    // Formatted: a heading under the card's h2, bold, a safe link out.
    expect(
      within(news).getByRole("heading", { level: 3, name: "Highlights" }),
    ).toBeTruthy();
    expect(within(news).getByText("Photo Mode").tagName).toBe("STRONG");
    const deck = within(news).getByRole("link", { name: "Steam Deck" });
    expect(deck.getAttribute("href")).toBe("https://store.example.com/deck");
    expect(deck.getAttribute("target")).toBe("_blank");
    expect(deck.getAttribute("rel")).toBe("noreferrer");
    // The summary: the first list, cut to three items; the rest is not in the page yet.
    const summary = news.querySelector("[data-notes] ul")!;
    expect(
      within(summary as HTMLElement).getAllByRole("listitem"),
    ).toHaveLength(3);
    expect(within(news).queryByText(/Fourth fix/)).toBeNull();
    const more = within(news).getByRole("button", { name: "Show full notes" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(
      more.getAttribute("aria-controls")!,
    )!;
    expect(region).toBeTruthy();
    expect(news.contains(region)).toBe(true);

    await userEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe("Show less");
    expect(region.hasAttribute("data-open")).toBe(true);
    // Raw HTML is its text: no element made from it.
    expect(within(region).getByText(/Fourth fix <img src=x/)).toBeTruthy();
    expect(news.querySelector("img, script")).toBeNull();
    // An unsafe link is its words, never a link.
    expect(within(region).getByText(/Unsafe/)).toBeTruthy();
    expect(within(news).queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(within(region).getByText("pkey sync").tagName).toBe("CODE");
    // Focus never leaves the button.
    expect(document.activeElement).toBe(more);
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() =>
      expect(within(news).queryByText(/Fourth fix/)).toBeNull(),
    );
    expect(document.activeElement).toBe(more);
  });

  it("reaches the same end state under reduced motion", async () => {
    document.documentElement.dataset.motion = "reduce";
    try {
      mockFetch(withNotes(NOTES));
      renderPortal();
      await page();
      const news = screen.getByRole("region", { name: "What's new in 1.4.2" });
      await userEvent.click(
        within(news).getByRole("button", { name: "Show full notes" }),
      );
      expect(within(news).getByText(/Fourth fix/)).toBeTruthy();
      expect(
        within(news).getByRole("button", { name: "Show less" }),
      ).toBeTruthy();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("short notes show whole, with nothing to open", async () => {
    mockFetch(withNotes("Faster *preset* browser."));
    renderPortal();
    await page();
    const news = screen.getByRole("region", { name: "What's new in 1.4.2" });
    expect(within(news).getByText("preset").tagName).toBe("EM");
    expect(
      within(news).queryByRole("button", { name: "Show full notes" }),
    ).toBeNull();
  });
});

describe("the section nav follows the page as it scrolls (owner polish 2026-10-07)", () => {
  /** Section tops in the viewport, as a scroll would leave them. */
  let tops: Record<string, number> = {};
  beforeEach(() => {
    tops = {};
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const s = this.id.startsWith("section-") ? this.id.slice(8) : null;
        const top = s !== null && s in tops ? tops[s]! : 0;
        const height = s !== null && s in tops ? 200 : 0;
        return {
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  const marked = (): string | null =>
    within(screen.getByRole("navigation", { name: "On this page" }))
      .getAllByRole("link")
      .find((a) => a.getAttribute("aria-current") === "location")
      ?.textContent ?? null;

  const scrollTo = async (next: Record<string, number>): Promise<void> => {
    tops = next;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  };

  it("walks down the nav in the page's order, and a picked section holds until the person scrolls", async () => {
    mockFetch(routes());
    renderPortal();
    await page();
    // At the top: no card has reached the reading line, so the first section.
    await scrollTo({ get: 500, license: 500, devices: 800, new: 1100 });
    await waitFor(() => expect(marked()).toBe("Get it"));
    // Get it and License (side by side) pass the line together: the later one in the order.
    await scrollTo({ get: 4, license: 4, devices: 304, new: 604 });
    await waitFor(() => expect(marked()).toBe("License"));
    await scrollTo({ get: -300, license: -300, devices: 0, new: 300 });
    await waitFor(() => expect(marked()).toBe("Devices 2"));
    await scrollTo({ get: -600, license: -600, devices: -300, new: 0 });
    await waitFor(() => expect(marked()).toBe("What's new"));

    // Picking Get it holds the mark, though License shares its top once it lands.
    const toc = screen.getByRole("navigation", { name: "On this page" });
    await userEvent.click(within(toc).getByRole("link", { name: "Get it" }));
    await scrollTo({ get: 0, license: 0, devices: 300, new: 600 });
    await new Promise((r) => setTimeout(r, 50));
    expect(marked()).toBe("Get it");
    // Once the person scrolls by themselves, the reading line leads again.
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    await scrollTo({ get: -600, license: -600, devices: -300, new: 0 });
    await waitFor(() => expect(marked()).toBe("What's new"));
  });

  it("with no main-column card, the licence's cards are one column, not a column of air beside one", async () => {
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
    expect(card.closest("[data-columns]")!.getAttribute("data-columns")).toBe(
      "one",
    );
    cleanup();
    window.history.replaceState(null, "", "/#/p/nightfall");
    mockFetch(routes());
    renderPortal();
    await page();
    expect(
      screen
        .getByRole("region", { name: "Nightfall license" })
        .closest("[data-columns]")!
        .getAttribute("data-columns"),
    ).toBe("two");
  });

  it("Help closes the main column, so the nav ends with it on every width", async () => {
    mockFetch(
      routes({
        "/api/library": libraryFor([nightfall], undefined, {
          support: { url: "https://help.example.com", email: null },
        }),
      }),
    );
    renderPortal();
    await page();
    const help = await screen.findByRole("region", { name: "Need help?" });
    const news = screen.getByRole("region", { name: "What's new in 1.4.2" });
    const license = screen.getByRole("region", { name: "Nightfall license" });
    // In the main column with What's new, after it; not in the licence's side column.
    const column = (el: HTMLElement) => el.parentElement!.parentElement!;
    expect(column(help)).toBe(column(news));
    expect(column(help)).not.toBe(column(license));
    for (const nav of ["On this page", "Sections"])
      expect(
        within(screen.getByRole("navigation", { name: nav }))
          .getAllByRole("link")
          .map((a) => a.textContent)
          .at(-1),
      ).toBe("Help");
  });
});

describe("Get it: other ways to install (P0-48)", () => {
  const SOURCE =
    "https://k.example/nightfall/distribution/altstore/stable/source.json";
  const REPO = `https://k.example/nightfall/distribution/fdroid/stable/repo?fingerprint=${"ab".repeat(32)}`;
  const QR = "data:image/svg+xml;base64,PHN2Zy8+";
  const sources = [
    installSource({
      kind: "homebrew",
      label: "Homebrew",
      command: "brew install --cask nightfall",
      platforms: ["macos"],
    }),
    installSource({
      kind: "altstore",
      label: "Add to AltStore",
      url: SOURCE,
      deepLink: `altstore://source?url=${encodeURIComponent(SOURCE)}`,
      qr: QR,
      platforms: ["ios"],
    }),
    installSource({
      kind: "fdroid",
      label: "Add to F-Droid",
      url: REPO,
      deepLink: `fdroidrepos://${REPO.slice("https://".length)}`,
      fingerprint: "ab".repeat(32),
      qr: QR,
      platforms: ["android"],
    }),
  ];
  const view = (recommend: string) => ({
    ...downloadsView(
      "nightfall",
      [
        dlFile({ artifactId: "m", platform: "macos" }),
        dlFile({ artifactId: "i", platform: "ios", arch: "arm64" }),
      ],
      {
        recommend,
        stores: [
          storeLink({
            kind: "app-store",
            label: "App Store",
            platforms: ["ios"],
          }),
        ],
      },
    ),
    installSources: sources,
  });

  it("on a computer: deep links, copyable URLs and commands, QR codes, each under its platform", async () => {
    mockFetch(routes({ "/api/products/nightfall/downloads": view("macos") }));
    renderPortal();
    await page();
    const get = await screen.findByRole("region", { name: "Get Nightfall" });
    const mac = await within(get).findByRole("list", {
      name: "Other ways to install on macOS",
    });
    expect(within(mac).getByText("Homebrew")).toBeTruthy();
    expect(within(mac).getByText("brew install --cask nightfall")).toBeTruthy();
    const copy = within(mac).getByRole("button", {
      name: "Copy Homebrew command",
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("brew install --cask nightfall");
    await within(mac).findByText("Copied");

    // AltStore opens the app, never the raw source.json; the URL is copyable text.
    const ios = within(get).getByRole("list", {
      name: "Other ways to install on iPhone and iPad",
    });
    expect(
      within(ios)
        .getByRole("link", { name: "Add to AltStore" })
        .getAttribute("href"),
    ).toBe(`altstore://source?url=${encodeURIComponent(SOURCE)}`);
    expect(get.querySelector(`a[href="${SOURCE}"]`)).toBeNull();
    expect(
      within(ios).getByRole("button", { name: "Copy source URL" }),
    ).toBeTruthy();
    expect(
      within(ios)
        .getByRole("img", { name: "QR code: Add to AltStore" })
        .getAttribute("src"),
    ).toBe(QR);

    // F-Droid opens fdroidrepos://, with the repository URL and its fingerprint to copy.
    const android = within(get).getByRole("list", {
      name: "Other ways to install on Android",
    });
    expect(
      within(android)
        .getByRole("link", { name: "Add to F-Droid" })
        .getAttribute("href"),
    ).toMatch(/^fdroidrepos:\/\/k\.example\//);
    expect(
      within(android).getByText("Repository fingerprint (SHA-256)"),
    ).toBeTruthy();
    expect(
      within(android).getByRole("button", {
        name: "Copy repository fingerprint",
      }),
    ).toBeTruthy();
    expect(
      within(android).getByRole("button", { name: "Copy repository URL" }),
    ).toBeTruthy();

    // "Also yours on" is the stores alone, opening in a new tab.
    const also = within(get).getByRole("list", { name: "Also yours on" });
    expect(
      within(also)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["App Store(opens in a new tab)"]);
    expect(get.textContent).not.toContain("Open this page on your computer");
    expect(await axeViolations()).toEqual([]);
  });

  it("on an iPhone: leads with what installs on it, and shows no QR code", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
    );
    mockFetch(routes({ "/api/products/nightfall/downloads": view("ios") }));
    renderPortal();
    await page();
    const get = await screen.findByRole("region", { name: "Get Nightfall" });
    const lead = await within(get).findByRole("list", {
      name: "Install on this iPhone",
    });
    expect(
      within(lead)
        .getByRole("link", { name: "Add to AltStore" })
        .getAttribute("href"),
    ).toMatch(/^altstore:\/\/source\?url=/);
    expect(
      within(lead)
        .getByRole("link", { name: /App Store/ })
        .getAttribute("href"),
    ).toBe("https://store.example/app-store");
    expect(get.textContent).not.toContain(
      "Open this page on your computer to download",
    );
    expect(
      within(get).getByText(
        "To download the files, open this page on your computer.",
      ),
    ).toBeTruthy();
    expect(within(get).queryByRole("img", { name: /QR code/ })).toBeNull();
    // The phone's own OS comes first under All platforms.
    const headings = within(get)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(headings[0]).toBe("iPhone and iPad");
  });
});

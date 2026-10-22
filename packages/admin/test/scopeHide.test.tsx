/**
 * A-20.7: a channel outside the product's scope is hidden on today's IA. The facts are the
 * one-product read's `channels[].inScope` (never a product check): the nav items that need a
 * channel, the Storefronts tiles, the Commerce overview's store rows and the palette.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { ALL_ON, resetConsole, productRow } from "./consoleHarness.js";
import { bootWith } from "./distributionFixture.js";
import {
  channelInScope,
  navFeaturesOf,
  navItems,
  SECTIONS,
} from "../src/console/nav.js";
import {
  connectorInScope,
  kindInScope,
} from "../src/console/sections/distribution/model/channelScope.js";
import { navigationSource } from "../src/console/shell/palette/navigation.js";

beforeEach(() => {
  resetConsole();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (id: string, inScope: boolean) => ({
  id,
  label: id,
  inScope,
  delivery: "not_set_up" as const,
  notUsing: false,
});
/** A Windows-only product: winget and the built-in store are in scope, no Apple or Play channel. */
const WINDOWS = [
  row("polaris-key", true),
  row("winget", true),
  row("scoop", true),
  row("steam", true),
];
/** The platform facts that make the scope known: a product with none shows everything. */
const PLATFORMS = [
  {
    platform: "windows",
    arches: ["x64"],
    formats: ["zip"],
    sources: ["builds"],
  },
];
/** An iOS product: the App Store is in scope. */
const IOS = [row("polaris-key", true), row("app-store", true)];

const PRODUCT = (channels: unknown, platforms: unknown = PLATFORMS) => ({
  "/manage/api/products/djdl": {
    product: { ...productRow("djdl", "DJDL", ALL_ON), channels, platforms },
  },
});

const labelsOf = (key: "distribution" | "commerce", f = navFeaturesOf) =>
  navItems(
    SECTIONS.find((s) => s.key === key)!,
    f({ channels: WINDOWS, platforms: PLATFORMS } as never),
  );

describe("nav requirements (A-20.7)", () => {
  it("a Windows-only product hides Distribution → App Store and Commerce → In-app purchases", () => {
    expect(labelsOf("distribution").map((p) => p.label)).not.toContain(
      "App Store",
    );
    expect(labelsOf("commerce").map((p) => p.label)).not.toContain(
      "In-app purchases",
    );
  });

  it("an App Store product keeps both", () => {
    const f = navFeaturesOf({ channels: IOS, platforms: PLATFORMS } as never);
    expect(
      navItems(SECTIONS.find((s) => s.key === "distribution")!, f).map(
        (p) => p.label,
      ),
    ).toContain("App Store");
    expect(
      navItems(SECTIONS.find((s) => s.key === "commerce")!, f).map(
        (p) => p.label,
      ),
    ).toContain("In-app purchases");
  });

  it("shows both while the product loads, and when an older Worker sends no channels", () => {
    for (const f of [null, navFeaturesOf({})]) {
      expect(
        navItems(SECTIONS.find((s) => s.key === "distribution")!, f).map(
          (p) => p.label,
        ),
      ).toContain("App Store");
      expect(channelInScope(f, "app-store")).toBe(true);
    }
  });

  it("a declared channel that is out of scope stays listed", () => {
    const f = navFeaturesOf({
      channels: [row("app-store", false)],
      platforms: PLATFORMS,
    } as never);
    expect(channelInScope(f, "app-store")).toBe(true);
    expect(channelInScope(f, "google-play")).toBe(false);
  });

  it("no platform facts means an unknown scope: nothing is hidden", () => {
    for (const product of [
      { channels: [], platforms: [] },
      { channels: [row("polaris-key", true)], platforms: [] },
    ]) {
      const f = navFeaturesOf(product as never);
      expect(channelInScope(f, "app-store")).toBe(true);
      expect(
        navItems(SECTIONS.find((s) => s.key === "distribution")!, f).map(
          (p) => p.label,
        ),
      ).toContain("App Store");
    }
  });

  it("the palette uses the same features", () => {
    const f = navFeaturesOf({
      channels: WINDOWS,
      platforms: PLATFORMS,
    } as never);
    const hrefs = navigationSource("djdl", "DJDL", ALL_ON, f).map(
      (i) => i.href,
    );
    expect(hrefs).not.toContain("#/p/djdl/distribution/app-store");
    expect(hrefs).not.toContain("#/p/djdl/commerce/in-app-purchases");
    const on = navigationSource(
      "djdl",
      "DJDL",
      ALL_ON,
      navFeaturesOf({ channels: IOS, platforms: PLATFORMS } as never),
    ).map((i) => i.href);
    expect(on).toContain("#/p/djdl/distribution/app-store");
  });
});

const store = (id: string, label: string) => ({
  id,
  label,
  listingStore: null,
  connection: {
    state: "not-configured",
    credential: null,
    credentialLabel: null,
    source: null,
    lastError: null,
  },
  app: null,
  outlets: [],
  readOnly: null,
  capabilities: [],
  prerequisites: [],
  steps: [],
});
const STORES = {
  stores: [
    store("app-store", "App Store"),
    store("google-play", "Google Play"),
    store("steam", "Steam"),
  ],
  listing: null,
};

describe("Storefronts and the Commerce overview (A-20.7)", () => {
  it("Storefronts lists in-scope stores only", async () => {
    bootWith("#/p/djdl/distribution/storefronts", {
      ...PRODUCT(WINDOWS),
      "/manage/api/products/djdl/distribution/storefronts": STORES,
    });
    const main = await screen.findByRole("main");
    await within(main).findByRole("region", { name: "Steam" });
    expect(
      within(main).queryByRole("region", { name: "App Store" }),
    ).toBeNull();
    expect(
      within(main).queryByRole("region", { name: "Google Play" }),
    ).toBeNull();
  });

  it("Storefronts keeps the built-in store, flags a declared out-of-scope one and shows the scope line", async () => {
    bootWith("#/p/djdl/distribution/storefronts", {
      ...PRODUCT([
        row("polaris-key", true),
        row("app-store", false),
        row("steam", true),
      ]),
      "/manage/api/products/djdl/distribution/storefronts": {
        stores: [
          { ...store("polaris-key", "Polaris Locker"), builtIn: true },
          store("app-store", "App Store"),
          store("steam", "Steam"),
          store("google-play", "Google Play"),
        ],
        listing: null,
      },
    });
    const main = await screen.findByRole("main");
    await within(main).findByRole("region", { name: "Polaris Locker" });
    const appStore = within(main).getByRole("region", { name: "App Store" });
    expect(within(appStore).getByText("Out of scope")).toBeTruthy();
    expect(
      within(main).queryByRole("region", { name: "Google Play" }),
    ).toBeNull();
    expect(within(main).getByText(/Stores for Windows/)).toBeTruthy();
    expect(
      within(main).getByRole("link", { name: "Add a platform" }),
    ).toBeTruthy();
  });

  it("Storefronts lists every store while the product has no channel facts", async () => {
    bootWith("#/p/djdl/distribution/storefronts", {
      "/manage/api/products/djdl/distribution/storefronts": STORES,
    });
    const main = await screen.findByRole("main");
    await within(main).findByRole("region", { name: "App Store" });
    expect(
      within(main).getByRole("region", { name: "Google Play" }),
    ).toBeTruthy();
  });

  const unset = { configured: false, credential: null, reason: null };
  const COMMERCE = {
    "/manage/api/products/djdl/commerce": {
      licenseEnabled: true,
      setup: { "app-store": unset, play: unset, steam: unset },
      products: [],
      purchases: [],
    },
  };

  it("the Commerce overview lists in-scope stores and omits the App Store link", async () => {
    bootWith("#/p/djdl/commerce", { ...PRODUCT(WINDOWS), ...COMMERCE });
    // In-app purchases is hidden, so Commerce is the one page: its h1 says so.
    await screen.findByRole("heading", { level: 1, name: "Commerce" });
    const main = screen.getByRole("main");
    const table = await within(main).findByRole("table", {
      name: /Storefronts/,
    });
    expect(within(table).getByText("Steam")).toBeTruthy();
    expect(within(table).queryByText("App Store")).toBeNull();
    expect(within(table).queryByText("Google Play")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Map App Store products" }),
    ).toBeNull();
  });

  it("the Commerce overview keeps the App Store row for an App Store product", async () => {
    bootWith("#/p/djdl/commerce", { ...PRODUCT(IOS), ...COMMERCE });
    const table = await screen.findByRole("table", { name: /Storefronts/ });
    expect(within(table).getByText("App Store")).toBeTruthy();
    expect(within(table).queryByText("Steam")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Map App Store products" }),
    ).toBeTruthy();
  });
});

describe("Direct links, the add flow and the credentials page (A-20.7)", () => {
  it("a link to a hidden page says the store is not one of the channels", async () => {
    bootWith("#/p/djdl/distribution/app-store", PRODUCT(WINDOWS));
    await screen.findByRole("heading", {
      level: 2,
      name: "The App Store isn't one of this product's channels",
    });
    expect(screen.getByRole("link", { name: "Open Storefronts" })).toBeTruthy();
  });

  it("the Commerce overview with no store in scope drops the table and the set-up link", async () => {
    bootWith("#/p/djdl/commerce", {
      ...PRODUCT(
        [row("polaris-key", true)],
        [{ platform: "web", arches: [], formats: [], sources: ["builds"] }],
      ),
      "/manage/api/products/djdl/commerce": {
        licenseEnabled: true,
        setup: {
          "app-store": { configured: false, credential: null, reason: null },
          play: { configured: false, credential: null, reason: null },
          steam: { configured: false, credential: null, reason: null },
        },
        products: [],
        purchases: [],
      },
    });
    await screen.findByText(
      "No supported store fits this product's platforms.",
    );
    expect(screen.queryByRole("table", { name: /Storefronts/ })).toBeNull();
    expect(screen.queryByText(/Set up a storefront/)).toBeNull();
  });

  it("the add flow with no other store fitting says so and links to Planned platforms", async () => {
    bootWith("#/p/djdl/distribution/storefronts?flow=add", {
      ...PRODUCT([row("polaris-key", true)]),
      "/manage/api/products/djdl/distribution/storefronts": {
        stores: [
          { ...store("polaris-key", "Polaris Locker"), builtIn: true },
          store("app-store", "App Store"),
        ],
        listing: null,
      },
    });
    await screen.findByText("No other store fits this product's platforms.");
    expect(
      screen.getByRole("link", { name: "Planned platforms" }),
    ).toBeTruthy();
  });

  const connector = (kind: string, label: string, outletKinds: string[]) => ({
    kind,
    label,
    outletKinds,
    configured: false,
    inert: { reason: "no_outlet", message: "declare a channel" },
    setup: null,
    controls: [],
  });
  const CONNECTORS = {
    connectors: [
      connector("asc", "App Store Connect", ["app-store", "testflight"]),
      connector("play", "Google Play", ["play", "play-testing"]),
      connector("ms-store", "Microsoft Store", ["ms-store"]),
    ],
  };

  it("Channel credentials hides the cards and the kinds of an out-of-scope store", async () => {
    bootWith("#/p/djdl/distribution/credentials", {
      ...PRODUCT(
        [row("polaris-key", true), row("microsoft-store", true)],
        PLATFORMS,
      ),
      "/manage/api/products/djdl/distribution/connectors": CONNECTORS,
    });
    const main = await screen.findByRole("main");
    await within(main).findByText("Microsoft Store");
    expect(within(main).queryByText("App Store Connect")).toBeNull();
    expect(within(main).queryByText("Google Play")).toBeNull();
  });

  it("Channel credentials shows every card while the scope is unknown", async () => {
    bootWith("#/p/djdl/distribution/credentials", {
      ...PRODUCT([], []),
      "/manage/api/products/djdl/distribution/connectors": CONNECTORS,
    });
    const main = await screen.findByRole("main");
    await within(main).findByText("App Store Connect");
    expect(within(main).getByText("Google Play")).toBeTruthy();
  });
});

describe("credential kinds follow the scope (A-20.7)", () => {
  it("hides the kinds of a store outside it, but never Sentry", () => {
    const f = navFeaturesOf({
      channels: WINDOWS,
      platforms: PLATFORMS,
    } as never);
    expect(kindInScope(f, "asc-api-key")).toBe(false);
    expect(kindInScope(f, "google-service-account")).toBe(false);
    expect(kindInScope(f, "steam-publisher-key")).toBe(true);
    expect(kindInScope(f, "sentry-integration")).toBe(true);
    expect(connectorInScope(f, ["play", "play-testing"])).toBe(false);
    expect(connectorInScope(null, ["play"])).toBe(true);
  });
});

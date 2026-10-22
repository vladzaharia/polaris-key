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
  row("google-play", false),
];
/** An iOS product: the App Store is in scope. */
const IOS = [row("polaris-key", true), row("app-store", true)];

const PRODUCT = (channels: unknown) => ({
  "/manage/api/products/djdl": {
    product: { ...productRow("djdl", "DJDL", ALL_ON), channels },
  },
});

const labelsOf = (key: "distribution" | "commerce", f = navFeaturesOf) =>
  navItems(SECTIONS.find((s) => s.key === key)!, f({ channels: WINDOWS }));

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
    const f = navFeaturesOf({ channels: IOS });
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

  it("a declared channel that is out of scope stays out", () => {
    const f = navFeaturesOf({ channels: [row("app-store", false)] });
    expect(channelInScope(f, "app-store")).toBe(false);
  });

  it("the palette uses the same features", () => {
    const f = navFeaturesOf({ channels: WINDOWS });
    const hrefs = navigationSource("djdl", "DJDL", ALL_ON, f).map(
      (i) => i.href,
    );
    expect(hrefs).not.toContain("#/p/djdl/distribution/app-store");
    expect(hrefs).not.toContain("#/p/djdl/commerce/in-app-purchases");
    const on = navigationSource(
      "djdl",
      "DJDL",
      ALL_ON,
      navFeaturesOf({ channels: IOS }),
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
    await screen.findByRole("heading", { level: 1, name: /Overview/ });
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

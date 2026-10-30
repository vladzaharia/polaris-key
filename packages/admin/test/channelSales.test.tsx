/**
 * A-22.6: a channel's Sales tab (`distribution/channels/<id>/sales`): the commerce facet's states,
 * the storefront's human steps inline, and the tab's visibility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { ChannelRow, StorefrontDto } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { channelRow, channelsView } from "./channelFixture.js";
import { bootWith, P } from "./distributionFixture.js";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const H = "#/p/djdl/distribution/channels";

const row = channelRow;
const channels = (c: ChannelRow) => channelsView(c);

const STEAM: StorefrontDto = {
  id: "steam",
  label: "Steam",
  listingStore: "steam",
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
  prerequisites: [
    {
      id: "publisher-key",
      label: "Publisher key",
      state: "unmet",
      detail: "Add a publisher key.",
      page: "platform-stores",
    },
  ],
  steps: [],
  pushListing: null,
  confirmationLabel: "Steam",
};

const VIEW = {
  licenseEnabled: true,
  identity: {
    "app-store": { value: null, source: null, assigned: null, mismatch: false },
    play: { value: null, source: null, assigned: null, mismatch: false },
    steam: { value: "999", source: "typed", assigned: "480", mismatch: true },
  },
  setup: {},
  products: [
    { store: "steam", productId: "480", deliverable: "app", flag: "pro" },
  ],
  purchases: [
    {
      store: "steam",
      purchase: "p1",
      storeProductId: "480",
      state: "active",
      environment: "Production",
      lastVerified: 1,
    },
  ],
  events: [],
};

const boot = (id: string, c: ChannelRow, extra: Record<string, unknown> = {}) =>
  bootWith(`${H}/${id}/sales`, {
    [P("/distribution/channels")]: channels(c),
    ...extra,
  });

describe("Distribution → a channel: Sales", () => {
  it("is a tab only for a channel Commerce sells through", async () => {
    boot("app-store", row());
    const list = await screen.findByRole("tablist", { name: "App Store tabs" });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("tab")
          .map((t) => t.textContent),
      ).toContain("Sales"),
    );
  });

  it("is not a tab for a channel with no commerce facet", async () => {
    bootWith(`${H}/google-play/sales`, {
      [P("/distribution/channels")]: channels(
        row({ id: "google-play", label: "Google Play", commerce: null }),
      ),
    });
    const list = await screen.findByRole("tablist", {
      name: "Google Play tabs",
    });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("tab")
          .map((t) => t.textContent),
      ).not.toContain("Sales"),
    );
  });

  it("ready: the App Store products", async () => {
    boot("app-store", row());
    const t = await screen.findByRole("table", { name: "App Store products" });
    expect(await within(t).findByText("gg.acme.djdl.pro")).toBeTruthy();
  });

  it("ready, a store with no section of its own: its Commerce facts", async () => {
    boot("steam", row({ id: "steam", label: "Steam" }), {
      [P("/commerce")]: VIEW,
    });
    expect(await screen.findByText("Products on sale")).toBeTruthy();
    expect(screen.getByText("Purchases").nextSibling?.textContent).toBe("1");
    expect(screen.getByText("999")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "See purchases" }).getAttribute("href"),
    ).toBe("#/p/djdl/commerce");
  });

  it("an App Store with no connector says what is missing and links to Setup", async () => {
    boot("app-store", row(), {
      [P("/distribution/connectors")]: { connectors: [] },
    });
    expect(
      await screen.findByText(
        "App Store Connect isn't connected for this product.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Setup" }).getAttribute("href"),
    ).toBe("#/p/djdl/distribution/channels/app-store/setup");
  });

  it("attention: names the app mismatch", async () => {
    boot(
      "steam",
      row({
        id: "steam",
        label: "Steam",
        commerce: {
          state: "attention",
          reason: null,
          attention: [{ code: "identity_mismatch" }],
        },
      }),
      { [P("/commerce")]: VIEW },
    );
    expect(await screen.findByText("Steam app mismatch")).toBeTruthy();
    expect(
      await screen.findByText(/checked against 999, not DJDL's app 480/),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Fix on Commerce" }),
    ).toHaveLength(1);
  });

  it("not set up: the storefront's steps inline, and the full setup one link away", async () => {
    boot(
      "steam",
      row({
        id: "steam",
        label: "Steam",
        commerce: {
          state: "not_set_up",
          reason: "no_credential",
          attention: [],
        },
      }),
      { [P("/distribution/storefronts")]: { stores: [STEAM], listing: null } },
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Set up" }),
    ).toBeTruthy();
    expect(await screen.findByText("Publisher key")).toBeTruthy();
    // Not started is neutral, never "Not met"; the first step carries the action.
    expect(screen.getByText("0 of 1 done")).toBeTruthy();
    expect(screen.queryByText(/Not met/)).toBeNull();
    expect(screen.queryByText(/Store connections/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open Connections" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open full setup" })
        .getAttribute("href"),
    ).toContain("flow=add&stores=steam");
  });

  it("commerce off: says so and links to Features", async () => {
    boot(
      "app-store",
      row({
        commerce: {
          state: "not_set_up",
          reason: "commerce_off",
          attention: [],
        },
      }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Commerce is off for this product",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Features" }).getAttribute("href"),
    ).toBe("#/p/djdl/settings/features");
  });
});

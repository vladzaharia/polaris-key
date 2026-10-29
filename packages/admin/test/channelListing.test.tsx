/** A-22.5: a channel's Listing tab: the store's listing, read-only, with the way to edit it. */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootWith, P } from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import type { ChannelRow, ChannelsView, ListingResponse } from "../src/api.js";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const boot = (id: string, label: string, l: ListingResponse) => {
  const c = {
    id,
    label,
    inScope: true,
    declared: true,
    oneClick: false,
    notUsing: false,
    delivery: { state: "live", attention: [], platforms: [] },
    commerce: null,
    identity: null,
  } as ChannelRow;
  const view: ChannelsView = {
    product: "djdl",
    now: 1,
    platforms: [],
    kinds: [],
    channels: [c],
  };
  bootWith(`#/p/djdl/distribution/channels/${id}/listing`, {
    [P("/distribution/channels")]: view,
    [P("/distribution/listing")]: l,
  });
};

const listing = (over: Partial<ListingResponse> = {}): ListingResponse => ({
  listing: {
    app: { defaultLocale: "en-US", name: "DJDL", developerName: "Acme Ltd" },
    source: "console",
    provenance: {},
    modifiedAt: 1,
    modifiedBy: "a",
  },
  locales: [
    {
      locale: "en-US",
      shortDescription: "Mix anywhere",
      keywords: ["dj", "mix"],
      source: "console",
      provenance: {},
      modifiedAt: 1,
      modifiedBy: "a",
    },
  ],
  overrides: [
    {
      store: "play",
      locale: null,
      field: "shortDescription",
      value: "Mix on Android",
    },
    {
      store: "steam",
      locale: null,
      field: "shortDescription",
      value: "Steam only",
    },
  ],
  limits: {},
  stores: [],
  overrideStores: [],
  modelFields: [],
  ...over,
});

describe("Distribution → a channel: Listing", () => {
  it("shows the store's fields, its override applied, read-only", async () => {
    boot("google-play", "Google Play", listing());
    expect(await screen.findByText("Mix on Android")).toBeTruthy();
    expect(screen.queryByText("Steam only")).toBeNull();
    expect(screen.queryByText("Mix anywhere")).toBeNull();
    expect(screen.getByText("Override for this store.")).toBeTruthy();
    expect(screen.getByText("dj, mix")).toBeTruthy();
    expect(screen.getByText("Acme Ltd")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("links to Presentation → Listing to edit", async () => {
    boot("google-play", "Google Play", listing());
    const a = await screen.findByRole("link", { name: "Edit listing" });
    expect(a.getAttribute("href")).toContain("settings/presentation/listing");
  });

  it("says so when there is no listing yet", async () => {
    boot(
      "google-play",
      "Google Play",
      listing({ listing: null, locales: [], overrides: [] }),
    );
    expect(await screen.findByText("No listing yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit listing" })).toBeTruthy();
  });

  it("a channel without a store listing shows nothing invented", async () => {
    boot("homebrew", "Homebrew", listing());
    expect(
      await screen.findByText("Homebrew has no store listing"),
    ).toBeTruthy();
    expect(screen.queryByText("Mix anywhere")).toBeNull();
  });
});

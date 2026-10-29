/** A-22.5: a channel's Listing tab: the store's listing, read-only, with the way to edit it. */

import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootWith, P } from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import type {
  ChannelRow,
  ChannelsView,
  ListingFitResponse,
  ListingResponse,
} from "../src/api.js";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const cell = (
  field: string,
  from: string,
  plane: "api" | "copy" | "manual" = "api",
  present = true,
) => ({
  field,
  from,
  locale: null,
  plane,
  status: "green" as const,
  present,
});

const FIT: ListingFitResponse = {
  exists: true,
  release: null,
  stores: [
    {
      store: "play",
      label: "Google Play",
      status: "red",
      issues: [
        {
          store: "play",
          field: "title",
          from: "name",
          locale: null,
          issue: "too_long",
          severity: "block",
          limit: 5,
          actual: 9,
          unit: "chars",
        },
      ],
      cells: [
        cell("title", "name"),
        cell("shortDescription", "shortDescription"),
        cell("fullDescription", "description", "copy"),
        cell("category", "category", "manual"),
      ],
    },
  ],
};

const boot = (
  id: string,
  label: string,
  l: ListingResponse,
  fit: ListingFitResponse = FIT,
) => {
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
    [P("/distribution/listing/fit")]: fit,
    [P("/distribution/storefronts")]: {
      stores: [
        { id: "google-play", label, listingStore: "play" },
        { id: "homebrew", label, listingStore: null },
      ],
    },
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
  it("shows only the fields the store takes, the override applied, read-only", async () => {
    boot("google-play", "Google Play", listing());
    expect(await screen.findByText("Mix on Android")).toBeTruthy();
    // Play takes a title, a short and full description; not keywords, features or developer.
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.queryByText("Keywords")).toBeNull();
    expect(screen.queryByText("Developer name")).toBeNull();
    expect(screen.queryByText("Steam only")).toBeNull();
    expect(screen.queryByText("Mix anywhere")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("marks an override, the copy and store-set planes, and says the locale in words", async () => {
    boot("google-play", "Google Play", listing());
    await screen.findByText("Mix on Android");
    expect(screen.getByText("Google Play only")).toBeTruthy();
    expect(screen.getByText(/Copied by hand/)).toBeTruthy();
    expect(screen.getByText(/Set in the store/)).toBeTruthy();
    expect(screen.getByText(/American English/)).toBeTruthy();
  });

  it("shows each field's fit issue inline", async () => {
    boot("google-play", "Google Play", listing());
    expect(await screen.findByText("Title too long: 9 of 5")).toBeTruthy();
    expect(screen.getByText(/1 to review/)).toBeTruthy();
  });

  it("links to this store's view of Presentation → Listing", async () => {
    boot("google-play", "Google Play", listing());
    const a = await screen.findByRole("link", {
      name: "Edit Google Play listing",
    });
    expect(a.getAttribute("href")).toContain("settings/presentation/listing");
    expect(a.getAttribute("href")).toContain("store=google-play");
  });

  it("says where to write it when there is no listing yet", async () => {
    boot(
      "google-play",
      "Google Play",
      listing({ listing: null, locales: [], overrides: [] }),
      { ...FIT, exists: false },
    );
    expect(await screen.findByText("No listing yet")).toBeTruthy();
    expect(screen.getByText(/Settings → Presentation → Listing/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit listing" })).toBeTruthy();
  });

  it("a channel without a store listing has no Listing tab", async () => {
    boot("homebrew", "Homebrew", listing());
    await screen.findByRole("tab", { name: "Status" });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Listing" })).toBeNull(),
    );
  });
});

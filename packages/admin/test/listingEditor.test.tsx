/**
 * A-27.10: `ListingEditor`. Unscoped it is the Listing page (every store's fit row, the switcher,
 * every store's push); scoped to a store it shows that store's fit row, slot groups and Push only.
 * The page itself renders it unscoped, so the existing listing tests stay as they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { resetConsole } from "./consoleHarness.js";
import { P, bootWith } from "./distributionFixture.js";

const LISTING = "#/p/djdl/settings/presentation/listing";
const SF = (path = "") => P(`/distribution/storefronts${path}`);

const store = (id: string, label: string, listingStore: string) => ({
  id,
  label,
  listingStore,
  connection: {
    state: "connected",
    credential: null,
    credentialLabel: null,
    source: "console",
    lastError: null,
  },
  app: { id: `app.${id}`, name: label },
  outlets: [],
  readOnly: null,
  capabilities: [],
  prerequisites: [],
  steps: [],
  pushListing: { stageOnly: false },
});

const fitRow = (id: string, label: string) => ({
  store: id,
  label,
  status: "red",
  issues: [
    {
      store: id,
      field: "title",
      from: "name",
      locale: "en-US",
      issue: "too_long",
      severity: "block",
      limit: 30,
      actual: 34,
      unit: "chars",
    },
  ],
  cells: [],
});

const slot = (group: string) => ({
  slot: `${group}:icon`,
  locale: null,
  group,
  kind: "derived",
  state: "review",
  spec: "512x512 PNG",
  textAllowed: "free",
  asset: null,
});

const routes = () => ({
  [SF()]: {
    stores: [
      store("google-play", "Google Play", "play"),
      store("ms-store", "Microsoft Store", "ms-store"),
    ],
    listing: { name: "DJDL", defaultLocale: "en-US", locales: ["en-US"] },
  },
  [SF("/slots")]: { slots: [slot("masters"), slot("play"), slot("ms-store")] },
  [P("/distribution/listing")]: {
    listing: {
      app: { defaultLocale: "en-US", name: "DJDL" },
      source: "admin",
      provenance: {},
      modifiedAt: 1,
      modifiedBy: "u1",
    },
    locales: [],
    overrides: [
      {
        store: "play",
        locale: "en-US",
        field: "subtitle",
        value: "Two-deck DJ mixer",
      },
    ],
    limits: {},
  },
  [P("/distribution/listing/fit")]: {
    exists: true,
    release: null,
    stores: [
      fitRow("play", "Google Play"),
      fitRow("ms-store", "Microsoft Store"),
    ],
  },
});

beforeEach(() => {
  resetConsole();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ListingEditor (A-27.10)", () => {
  it("unscoped: every store's fit row, the page's store switcher, and the scope line", async () => {
    bootWith(`${LISTING}?tab=fit`, routes());
    expect(await screen.findByText("Google Play")).toBeTruthy();
    expect(screen.getByText("Microsoft Store")).toBeTruthy();
    expect(screen.getByLabelText(/store/i)).toBeTruthy();
    expect(
      screen.getByText(
        "Changes here show in Polaris Locker, on the download page and on every storefront.",
      ),
    ).toBeTruthy();
  });

  it("scoped: one store's fit row with its override", async () => {
    bootWith(`${LISTING}?tab=fit&store=google-play`, routes());
    await screen.findByRole("button", { name: "Override…" });
    expect(document.querySelectorAll("[data-fit]")).toHaveLength(1);
    expect(document.querySelector('[data-fit="play"]')).not.toBeNull();
    expect(document.querySelector('[data-scope="google-play"]')).not.toBeNull();
  });

  it("scoped: the first tab is the storefront's overrides, with Edit and Remove", async () => {
    bootWith(`${LISTING}?store=google-play`, routes());
    await screen.findByRole("button", { name: "Edit override" });
    expect(
      screen.getByRole("button", { name: "Remove override" }),
    ).toBeTruthy();
    expect(screen.getByText("Two-deck DJ mixer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Release notes" })).toBeNull();
  });

  it("scoped: the slot board shows the masters and that store's group only", async () => {
    bootWith(`${LISTING}?tab=images&store=ms-store`, routes());
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="ms-store:icon"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector('[data-slot="play:icon"]')).toBeNull();
    expect(document.querySelector('[data-slot="masters:icon"]')).not.toBeNull();
  });

  it("scoped to a storefront that takes no push, Push says so", async () => {
    const r = routes() as Record<string, any>;
    r[SF()].stores[1].pushListing = null;
    r[SF()].stores[1].builtIn = true;
    bootWith(`${LISTING}?tab=push&store=ms-store`, r);
    expect(await screen.findByText(/reads the listing directly/)).toBeTruthy();
    expect(screen.queryByText("No store takes a listing push")).toBeNull();
  });

  it("unscoped Push lists both stores; scoped Push lists the one", async () => {
    bootWith(`${LISTING}?tab=push`, routes());
    const all = await screen.findAllByRole("button", { name: "Push listing" });
    expect(all).toHaveLength(2);
    cleanup();
    bootWith(`${LISTING}?tab=push&store=ms-store`, routes());
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Push listing" }),
      ).toHaveLength(1),
    );
    expect(document.querySelector('[data-scope="ms-store"]')).not.toBeNull();
  });
});

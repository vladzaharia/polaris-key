/**
 * A-27.10: `ListingEditor`. Unscoped it is the Listing page (every store's fit row, the switcher,
 * every store's push); scoped to a store it shows that store's fit row, slot groups and Push only.
 * The page itself renders it unscoped, so the existing listing tests stay as they were.
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { resetConsole } from "./consoleHarness.js";
import { P, bootWith } from "./distributionFixture.js";
import { ListingEditor } from "../src/console/sections/core/components/listing/ListingEditor.js";

const scope = vi.hoisted(() => ({ store: undefined as string | undefined }));
vi.mock("../src/console/sections/storefronts/pages/ListingPage.js", () => ({
  ListingPage: ({ slug }: { slug: string }) =>
    React.createElement(ListingEditorProxy, { slug }),
}));
function ListingEditorProxy({ slug }: { slug: string }) {
  return scope.store === undefined ? (
    <ListingEditor slug={slug} />
  ) : (
    <ListingEditor slug={slug} store={scope.store} />
  );
}

const LISTING = "#/p/djdl/distribution/listing";
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
    overrides: [],
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
  scope.store = undefined;
});

describe("ListingEditor (A-27.10)", () => {
  it("unscoped: every store's fit row, the store switcher, every push, and the scope line", async () => {
    bootWith(`${LISTING}?tab=fit`, routes());
    expect(await screen.findByText("Google Play")).toBeTruthy();
    expect(screen.getByText("Microsoft Store")).toBeTruthy();
    expect(screen.getByLabelText(/store/i)).toBeTruthy();
    expect(
      screen.getByText(
        "Changes here show in Polaris Locker, on the download page and on every channel.",
      ),
    ).toBeTruthy();
  });

  it("scoped: one store's fit row with its override, and no switcher", async () => {
    scope.store = "google-play";
    bootWith(`${LISTING}?tab=fit`, routes());
    await screen.findByRole("button", { name: "Override…" });
    expect(document.querySelectorAll("[data-fit]")).toHaveLength(1);
    expect(document.querySelector('[data-fit="play"]')).not.toBeNull();
    expect(document.querySelector('[data-scope="google-play"]')).not.toBeNull();
    expect(screen.queryByLabelText(/^store$/i)).toBeNull();
  });

  it("scoped: the slot board shows the masters and that store's group only", async () => {
    scope.store = "ms-store";
    bootWith(`${LISTING}?tab=images`, routes());
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="ms-store:icon"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector('[data-slot="play:icon"]')).toBeNull();
    expect(document.querySelector('[data-slot="masters:icon"]')).not.toBeNull();
  });

  it("unscoped Push lists both stores; scoped Push lists the one", async () => {
    bootWith(`${LISTING}?tab=push`, routes());
    const all = await screen.findAllByRole("button", { name: "Push listing" });
    expect(all).toHaveLength(2);
    cleanup();
    scope.store = "ms-store";
    bootWith(`${LISTING}?tab=push`, routes());
    const one = await screen.findAllByRole("button", { name: "Push listing" });
    expect(one).toHaveLength(1);
    expect(
      within(one[0]!.closest("[data-row], div")!).queryByText("Google Play"),
    ).toBeNull();
  });
});

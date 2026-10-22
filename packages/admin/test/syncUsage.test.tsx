/**
 * Cloud Sync → Usage (config.cloud-sync-usage; U-05.20): every section from one fixture, the
 * warning only where a tier has people over 80 %, player or person from the catalog, MiB and GiB,
 * and the empty, error and off states.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ProductDetail, SyncUsageResponse } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const product = vi.fn();
const syncUsage = vi.fn<() => Promise<SyncUsageResponse>>();
const schema = vi.fn();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      product: (s: string) => product(s),
      schema: (s: string) => schema(s),
      syncUsage: () => syncUsage(),
    },
  };
});

const { SyncUsagePage, formatStorage, nounsFor } =
  await import("../src/console/sections/sync/pages/SyncUsage.js");

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

type On = Extract<SyncUsageResponse, { enabled: true }>;
const FIXTURE: On = {
  enabled: true,
  usage: {
    bytes: 18.4 * GiB,
    people: 4812,
    settingsBytes: 0.2 * GiB,
    recordBytes: 3 * GiB,
    fileBytes: 8.6 * GiB,
    revisionBytes: 6.6 * GiB,
    computedAt: Math.floor(Date.now() / 1000) - 240,
    breakdown: {
      byTier: [
        {
          tierId: "free",
          people: 3120,
          bytes: 9.5 * GiB,
          medianBytes: 2.6 * MiB,
          over80: 41,
        },
        {
          tierId: "standard",
          people: 1402,
          bytes: 5.5 * GiB,
          medianBytes: 3.4 * MiB,
          over80: 0,
        },
        {
          tierId: null,
          people: 290,
          bytes: 3.4 * GiB,
          medianBytes: 9.8 * MiB,
          over80: 1,
        },
      ],
      byKind: { settings: 0, records: 0, files: 0, revisions: 0 },
      byPlatform: [
        { platform: "ios", peopleThisWeek: 2214, lastSyncAt: 1_790_000_000 },
        { platform: "windows", peopleThisWeek: 931, lastSyncAt: 1_790_000_000 },
      ],
    },
  },
  today: { day: "2026-10-22", syncs: 61240, conflicts: 37 },
  tiers: [
    { id: "free", label: "Free", bytes: null },
    { id: "standard", label: "Standard", bytes: 512 * MiB },
    { id: "deluxe", label: "Deluxe", bytes: 2 * GiB },
  ],
  defaultBytes: 256 * MiB,
};
const withTiers = (over80: number[]): On => ({
  ...FIXTURE,
  usage: {
    ...FIXTURE.usage,
    breakdown: {
      ...FIXTURE.usage.breakdown,
      byTier: FIXTURE.usage.breakdown.byTier.map((t, i) => ({
        ...t,
        over80: over80[i] ?? 0,
      })),
    },
  },
});

const detail = (sync = true): ProductDetail =>
  ({
    slug: "diceroll",
    name: "Diceroll",
    services: { sync: { enabled: sync } },
  }) as ProductDetail;

const GAME = {
  schemaVersion: 1,
  entries: [],
  cloudSync: { collections: [{ name: "saves", template: "saves" }] },
};
const APP = { schemaVersion: 1, entries: [] };

function renderPage() {
  return render(
    <KitProviders>
      <div data-service="sync">
        <SyncUsagePage slug="diceroll" />
      </div>
    </KitProviders>,
  );
}

beforeEach(() => {
  for (const m of [product, syncUsage, schema]) m.mockReset();
  product.mockResolvedValue({ product: detail() });
  schema.mockResolvedValue(GAME);
  syncUsage.mockResolvedValue(FIXTURE);
});
afterEach(cleanup);

describe("formatStorage", () => {
  it("writes binary units, MiB and GiB, never MB", () => {
    expect(formatStorage(0)).toBe("0 bytes");
    expect(formatStorage(900)).toBe("900 bytes");
    expect(formatStorage(2.6 * MiB)).toBe("2.6 MiB");
    expect(formatStorage(256 * MiB)).toBe("256 MiB");
    expect(formatStorage(18.4 * GiB)).toBe("18.4 GiB");
    // 1023.96 MiB rounds to 1,024.0: it moves up to GiB.
    expect(formatStorage(1023.96 * MiB)).toBe("1 GiB");
    expect(formatStorage(3 * 1024 * GiB)).toBe("3 TiB");
  });
  it("names a game's users players and an app's people", () => {
    expect(nounsFor(true).many).toBe("players");
    expect(nounsFor(false).many).toBe("people");
  });
});

describe("Cloud Sync → Usage", () => {
  it("draws every section from the read", async () => {
    const { container } = renderPage();
    await screen.findByRole("heading", { name: "Storage by tier" });
    const tabs = screen.getByRole("navigation", { name: "Cloud Sync" });
    expect(
      within(tabs)
        .getByRole("link", { name: "Usage" })
        .getAttribute("aria-current"),
    ).toBe("page");

    // The tiles.
    expect(screen.getAllByText("Players with data").length).toBeGreaterThan(0);
    expect(screen.getByText("4,812")).toBeTruthy();
    expect(screen.getByText("18.4 GiB")).toBeTruthy();
    expect(screen.getByText("61,240")).toBeTruthy();
    expect(screen.getByText("Conflicts today")).toBeTruthy();
    expect(screen.getByText("37")).toBeTruthy();

    // Storage by tier: a tier's limit in words, the default named, the no-license row.
    const tiers = screen.getByRole("table", { name: "Storage by tier" });
    expect(
      within(tiers).getAllByText("256 MiB each, the default"),
    ).toHaveLength(1);
    expect(within(tiers).getByText("512 MiB each")).toBeTruthy();
    expect(within(tiers).getByText("Deluxe")).toBeTruthy();
    expect(within(tiers).getByText("Without a license")).toBeTruthy();
    expect(within(tiers).getByText("9.5 GiB")).toBeTruthy();
    expect(within(tiers).getByText("2.6 MiB")).toBeTruthy();

    // What's stored: the bar's text alternative lists the same sizes as the table.
    const bar = screen.getByRole("img", { name: /Settings .*GiB/ });
    expect(bar.getAttribute("aria-label")).toBe(
      "Settings 204.8 MiB, Records 3 GiB, Files 8.6 GiB, Older versions 6.6 GiB",
    );
    const stored = screen.getByRole("table", { name: "What's stored" });
    expect(within(stored).getByText("Older versions")).toBeTruthy();
    expect(within(stored).getByText("8.6 GiB")).toBeTruthy();
    expect(bar.className).toContain("max-w-[640px]");

    // Where players sync from.
    const platforms = screen.getByRole("table", {
      name: "Players per platform",
    });
    expect(within(platforms).getByText("iOS")).toBeTruthy();
    expect(within(platforms).getByText("2,214")).toBeTruthy();
    expect(within(platforms).getByText("Windows")).toBeTruthy();

    // No per-person table: three tables, none lists people.
    expect(screen.getAllByRole("table")).toHaveLength(3);
    expect((await axe(container)).violations).toEqual([]);
  });

  it("warns only for a tier with people over 80 %", async () => {
    syncUsage.mockResolvedValue(withTiers([41, 0, 1]));
    renderPage();
    await screen.findByRole("heading", { name: "Storage by tier" });
    expect(screen.getByText("41 players over 80 %")).toBeTruthy();
    expect(screen.getByText("1 player over 80 %")).toBeTruthy();
    // Standard has nobody over: "None", and no warning for it.
    expect(screen.getAllByText("None")).toHaveLength(3); // Standard and Deluxe over-80, Deluxe median
    cleanup();
    syncUsage.mockResolvedValue(withTiers([0, 0, 0]));
    renderPage();
    await screen.findByRole("heading", { name: "Storage by tier" });
    expect(screen.queryByText(/over 80 %/)).toBeNull();
  });

  it("says person and people for an app", async () => {
    schema.mockResolvedValue(APP);
    renderPage();
    expect(
      (await screen.findAllByText("People with data")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "Where people sync from" }),
    ).toBeTruthy();
    expect(screen.getByText("1 person over 80 %")).toBeTruthy();
    expect(screen.queryByText(/player/i)).toBeNull();
  });

  it("says player for a game, and person when there is no catalog yet", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Where players sync from" }),
    ).toBeTruthy();
    cleanup();
    schema.mockRejectedValue(new ApiError(404, undefined, "not_found"));
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Where people sync from" }),
    ).toBeTruthy();
  });

  it("shows the empty state when nobody has synced", async () => {
    syncUsage.mockResolvedValue({
      ...FIXTURE,
      usage: { ...FIXTURE.usage, people: 0, bytes: 0 },
    });
    renderPage();
    expect(await screen.findByText("No players have synced yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("answers a failed read with Retry", async () => {
    syncUsage.mockRejectedValueOnce(new ApiError(500, undefined, "internal"));
    renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    syncUsage.mockResolvedValue(FIXTURE);
    await userEvent.click(retry);
    expect(
      await screen.findByRole("heading", { name: "Storage by tier" }),
    ).toBeTruthy();
  });

  it("says Cloud Sync is off, for the product or the read", async () => {
    product.mockResolvedValue({ product: detail(false) });
    renderPage();
    expect(
      await screen.findByText("Cloud Sync is off for this product"),
    ).toBeTruthy();
    expect(syncUsage).not.toHaveBeenCalled();
    cleanup();
    product.mockResolvedValue({ product: detail(true) });
    syncUsage.mockResolvedValue({ enabled: false });
    renderPage();
    expect(
      await screen.findByText("Cloud Sync is off for this product"),
    ).toBeTruthy();
  });
});

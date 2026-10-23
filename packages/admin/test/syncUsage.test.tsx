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
const productSettings = vi.fn();
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
      productSettings: () => productSettings(),
    },
  };
});

const { SyncUsagePage, formatStorage, nounsFor } =
  await import("../src/console/sections/sync/pages/SyncUsage.js");
const { formatBinaryBytes } =
  await import("../src/console/sections/sync/pages/SyncData.js");

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
        { platform: null, peopleThisWeek: 12, lastSyncAt: 0 },
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

const detail = (sync = true, license = true): ProductDetail =>
  ({
    slug: "diceroll",
    name: "Diceroll",
    services: { sync: { enabled: sync }, license: { enabled: license } },
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
  for (const m of [product, syncUsage, schema, productSettings]) m.mockReset();
  productSettings.mockRejectedValue(new Error("not served"));
  product.mockResolvedValue({ product: detail() });
  schema.mockResolvedValue(GAME);
  syncUsage.mockResolvedValue(FIXTURE);
});
afterEach(cleanup);

describe("formatStorage", () => {
  it("reads 'Of Y' from the product's ceiling setting, and from the catalog default until it loads", async () => {
    productSettings.mockResolvedValue({
      settings: [{ key: "cloudSync.ceiling.bytes", value: 80 * GiB }],
    });
    renderPage();
    expect(await screen.findByText("Of 80 GiB")).toBeTruthy();
  });

  it("is Setup's formatter with the unit kept to its number: MiB and GiB, never MB", () => {
    expect(formatStorage(0)).toBe("0 bytes");
    expect(formatStorage(900)).toBe("900 bytes");
    expect(formatStorage(2.6 * MiB)).toBe("2.6 MiB");
    expect(formatStorage(256 * MiB)).toBe("256 MiB");
    expect(formatStorage(18.4 * GiB)).toBe("18.4 GiB");
    // Two decimals, as Setup and Data write them (the clamped per-person ceiling).
    expect(formatStorage(GiB + 64 * MiB + 256 * 1024)).toBe("1.06 GiB");
    expect(formatStorage(3 * 1024 * GiB)).toBe("3 TiB");
    expect(formatStorage(2 * GiB)).toBe(
      formatBinaryBytes(2 * GiB).replace(" ", " "),
    );
  });
  it("names a game's users players and an app's people", () => {
    expect(nounsFor(true).many).toBe("players");
    expect(nounsFor(false).many).toBe("people");
  });
});

const heading = (name: string) => screen.findByRole("heading", { name });

describe("Cloud Sync → Usage", () => {
  it("draws every section from the read", async () => {
    const { container } = renderPage();
    await heading("Storage by tier");
    const tabs = screen.getByRole("navigation", { name: "Cloud Sync" });
    expect(
      within(tabs)
        .getByRole("link", { name: "Usage" })
        .getAttribute("aria-current"),
    ).toBe("page");

    // The tiles: storage says its ceiling, the age of the aggregate shows once.
    expect(screen.getAllByText("Players with data").length).toBeGreaterThan(0);
    expect(screen.getByText("4,812")).toBeTruthy();
    expect(screen.getByText("18.4 GiB")).toBeTruthy();
    expect(screen.getByText("Of 50 GiB")).toBeTruthy();
    expect(screen.getByText("61,240")).toBeTruthy();
    expect(screen.getByText("Conflicts today")).toBeTruthy();
    expect(screen.getByText("37")).toBeTruthy();
    expect(screen.getAllByText(/Updated 4 min\. ago/)).toHaveLength(1);

    // Storage by tier: a tier's limit in words, the default named, the null tier is "No tier".
    const tiers = screen.getByRole("table", { name: "Storage by tier" });
    expect(
      within(tiers).getAllByText("256 MiB each, the default"),
    ).toHaveLength(1);
    expect(within(tiers).getByText("512 MiB each")).toBeTruthy();
    expect(within(tiers).getByText("Deluxe")).toBeTruthy();
    expect(within(tiers).getByText("No tier")).toBeTruthy();
    expect(within(tiers).getByText("9.5 GiB")).toBeTruthy();
    expect(within(tiers).getByText("2.6 MiB")).toBeTruthy();
    // The header says "Over 80 %"; the cell says the count once.
    expect(
      within(tiers).getByRole("columnheader", { name: "Over 80 %" }),
    ).toBeTruthy();

    // What's stored: a short summary for the bar; the table holds every size.
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toMatch(/^Files are \d+ % of /);
    expect(bar.className).toContain("max-w-[640px]");
    const stored = screen.getByRole("table", { name: "What's stored" });
    expect(within(stored).getByText("Older versions")).toBeTruthy();
    expect(within(stored).getByText("8.6 GiB")).toBeTruthy();
    expect(screen.getByText(/count toward each player's storage/)).toBeTruthy();

    // Where players sync from: platform ids are named, never shown raw.
    const platforms = screen.getByRole("table", {
      name: "Players per platform",
    });
    expect(within(platforms).getByText("iOS")).toBeTruthy();
    expect(within(platforms).getByText("2,214")).toBeTruthy();
    expect(within(platforms).getByText("Windows")).toBeTruthy();
    expect(within(platforms).getByText("Not reported")).toBeTruthy();

    // No per-person table: three tables, none lists people.
    expect(screen.getAllByRole("table")).toHaveLength(3);
    expect((await axe(container)).violations).toEqual([]);
  });

  it("warns only for a tier with people over 80 %", async () => {
    syncUsage.mockResolvedValue(withTiers([41, 0, 1]));
    renderPage();
    await heading("Storage by tier");
    expect(screen.getByText("41 players")).toBeTruthy();
    expect(screen.getByText("1 player")).toBeTruthy();
    // Standard has nobody over: "None", and no warning for it.
    expect(screen.getAllByText("None")).toHaveLength(3); // Standard and Deluxe over-80, Deluxe median
    cleanup();
    syncUsage.mockResolvedValue(withTiers([0, 0, 0]));
    renderPage();
    await heading("Storage by tier");
    expect(screen.queryByText(/^\d+ players?$/)).toBeNull();
    expect(screen.queryByText(/over 80/)).toBeNull();
  });

  it("says person and people for an app", async () => {
    schema.mockResolvedValue(APP);
    renderPage();
    expect(await heading("Where people sync from")).toBeTruthy();
    expect(screen.getAllByText("People with data").length).toBeGreaterThan(0);
    expect(screen.getByText("1 person")).toBeTruthy();
    expect(screen.queryByText(/player/i)).toBeNull();
  });

  it("says player for a game, and person when there is no catalog yet", async () => {
    renderPage();
    expect(await heading("Where players sync from")).toBeTruthy();
    cleanup();
    schema.mockRejectedValue(new ApiError(404, undefined, "not_found"));
    renderPage();
    expect(await heading("Where people sync from")).toBeTruthy();
  });

  it("never shows a noun before the catalog has answered", async () => {
    schema.mockReturnValue(new Promise(() => {}));
    renderPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/people with data/i)).toBeNull();
    expect(screen.queryByText(/players with data/i)).toBeNull();
    // The skeleton is tiles and a card, with no second header.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("loading: one polite status, tiles hidden from assistive tech, axe clean", async () => {
    syncUsage.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(await screen.findByText("Loading usage")).toBeTruthy();
    expect(screen.getByText("Loading usage").getAttribute("role")).toBe(
      "status",
    );
    expect(screen.queryAllByText("Loading")).toHaveLength(4);
    for (const t of screen.getAllByText("Loading", { selector: "p" }))
      expect(t.closest("[aria-hidden=true]")).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("lists platforms by people, most first, with Not reported last", async () => {
    renderPage();
    const platforms = await screen.findByRole("table", {
      name: "Players per platform",
    });
    const names = within(platforms)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(names).toEqual(["iOS", "Windows", "Not reported"]);
  });

  it("with Licensing off, the no-tier row carries the default's limit", async () => {
    product.mockResolvedValue({ product: detail(true, false) });
    renderPage();
    await heading("Storage by tier");
    const tiers = screen.getByRole("table", { name: "Storage by tier" });
    expect(
      within(tiers).getAllByText("256 MiB each, the default"),
    ).toHaveLength(2);
  });

  it("calls a tier the list no longer holds a removed tier, with no limit line", async () => {
    const odd = withTiers([0, 0, 0]);
    odd.usage.breakdown.byTier.push({
      tierId: "legacy_gold",
      people: 2,
      bytes: 10,
      medianBytes: 5,
      over80: 0,
    });
    syncUsage.mockResolvedValue(odd);
    renderPage();
    await heading("Storage by tier");
    expect(screen.getByText("legacy_gold")).toBeTruthy();
    expect(screen.getByText("Removed tier")).toBeTruthy();
  });

  it("with U-05's real shape (every byte a setting) lists one kind and no bar", async () => {
    schema.mockResolvedValue(APP);
    syncUsage.mockResolvedValue({
      ...FIXTURE,
      usage: {
        ...FIXTURE.usage,
        settingsBytes: FIXTURE.usage.bytes,
        recordBytes: 0,
        fileBytes: 0,
        revisionBytes: 0,
      },
    });
    renderPage();
    await heading("What's stored");
    const stored = screen.getByRole("table", { name: "What's stored" });
    expect(within(stored).getAllByRole("row")).toHaveLength(2); // head + Settings
    expect(within(stored).queryByText("Records")).toBeNull();
    expect(within(stored).queryByText("Files")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/count toward/)).toBeNull();
  });

  it("lists declared kinds even at zero", async () => {
    syncUsage.mockResolvedValue({
      ...FIXTURE,
      usage: {
        ...FIXTURE.usage,
        recordBytes: 0,
        fileBytes: 0,
        revisionBytes: 0,
      },
    });
    schema.mockResolvedValue({
      ...GAME,
      cloudSync: { collections: [{ name: "saves", template: "saves" }] },
    });
    renderPage();
    await heading("What's stored");
    const stored = screen.getByRole("table", { name: "What's stored" });
    expect(within(stored).getByText("Records")).toBeTruthy();
    expect(within(stored).getByText("Files")).toBeTruthy();
    expect(within(stored).queryByText("Older versions")).toBeNull();
  });

  it("shows the empty state, with an action, when nobody has data", async () => {
    syncUsage.mockResolvedValue({
      ...FIXTURE,
      usage: { ...FIXTURE.usage, people: 0, bytes: 0, computedAt: 0 },
      today: { day: "2026-10-22", syncs: 0, conflicts: 0 },
    });
    renderPage();
    expect(await screen.findByText("No data yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See Setup" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps today's counters when syncs happened before the first aggregate", async () => {
    syncUsage.mockResolvedValue({
      ...FIXTURE,
      usage: { ...FIXTURE.usage, people: 0, bytes: 0, computedAt: 0 },
      today: { day: "2026-10-22", syncs: 14, conflicts: 0 },
    });
    renderPage();
    expect(await screen.findByText("No data yet")).toBeTruthy();
    expect(screen.getByText("Syncs today")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
  });

  it("answers a failed read with Retry", async () => {
    syncUsage.mockRejectedValueOnce(new ApiError(500, undefined, "internal"));
    renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    syncUsage.mockResolvedValue(FIXTURE);
    await userEvent.click(retry);
    expect(await heading("Storage by tier")).toBeTruthy();
  });

  it("a refused read says so, never 'you need edit access'", async () => {
    syncUsage.mockRejectedValue(new ApiError(403, undefined, "forbidden"));
    renderPage();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/edit access/i);
    expect(document.body.textContent).toMatch(/access/i);
  });

  it("says Cloud Sync is off, for the product or the read, as the shell does", async () => {
    product.mockResolvedValue({ product: detail(false) });
    renderPage();
    expect(
      await screen.findByText("Cloud Sync is off for Diceroll."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Features" })).toBeTruthy();
    expect(syncUsage).not.toHaveBeenCalled();
    cleanup();
    product.mockResolvedValue({ product: detail(true) });
    syncUsage.mockResolvedValue({ enabled: false });
    renderPage();
    expect(
      await screen.findByText("Cloud Sync is off for Diceroll."),
    ).toBeTruthy();
  });
});

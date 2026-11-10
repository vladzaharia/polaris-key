import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalCloudSync } from "../src/portal/api.js";
import { formatDayTime } from "../src/portal/date.js";
import {
  axeViolations,
  DAY,
  detail,
  fetchedRequests,
  license,
  mockFetch,
  type MockRoute,
  NOW_S,
  productView,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * The product page's Sync Across Devices section (PX-18.1; U-12.5's `GET /api/products/<p>/sync`):
 * read-only, shown only for a product whose view says sync is on, with its nav entries and the
 * jump palette's action coming and going with it.
 */

const moss = license({ product: "mossgarden" });

/** The product view (`GET /api/products/<p>`) with sync on or off. */
function view(product: string, sync: boolean) {
  return {
    ...productView(product, [{ id: `lic_${product}`, deviceLimit: 3 }]),
    services: { license: true, sync },
  };
}

function summary(over: Partial<PortalCloudSync> = {}): PortalCloudSync {
  return {
    encryption: "e2e",
    empty: false,
    state: "active",
    pausedSince: null,
    usage: { bytes: 142 * 1024 ** 2 },
    quota: { bytes: 1024 ** 3, tierLabel: "Pro" },
    devices: [
      { label: "Studio PC", lastSyncAt: NOW_S - 3 * DAY },
      { label: "Mara's MacBook Pro", lastSyncAt: NOW_S - 180 },
    ],
    ...over,
  };
}

function routes(
  sync: boolean,
  syncRoute?: MockRoute,
): Record<string, MockRoute> {
  return signedIn([moss], {
    "/api/licenses/mossgarden/lic_mossgarden": detail(moss),
    "/api/products/mossgarden": view("mossgarden", sync),
    ...(syncRoute === undefined
      ? {}
      : { "/api/products/mossgarden/sync": syncRoute }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/#/p/mossgarden");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

/** The product page is on screen (its `h1`). */
const page = (): Promise<HTMLElement> =>
  screen.findByRole("heading", { level: 1, name: "Mossgarden" });

function navLinks(): string[][] {
  return ["Sections", "On this page"].map((name) =>
    within(screen.getByRole("navigation", { name }))
      .getAllByRole("link")
      .map((a) => a.textContent ?? ""),
  );
}

async function syncCard(): Promise<HTMLElement> {
  const h2 = await screen.findByRole("heading", {
    level: 2,
    name: "Sync Across Devices",
  });
  return h2.closest("section")!;
}

describe("Sync Across Devices on the product page (PX-18.1)", () => {
  it("shows use against the limit, the tier, each device's last sync and who can read it", async () => {
    mockFetch(routes(true, summary()));
    renderPortal();
    await page();
    const card = await syncCard();
    expect(card.id).toBe("section-sync");
    const meter = await within(card).findByRole("meter", { name: "Storage" });
    expect(meter.getAttribute("aria-valuetext")).toBe("142 MB of 1 GB");
    expect(within(card).getByText("Limit set by your Pro tier")).toBeTruthy();
    // Devices, most recent first, each with a relative time and its date and time as the title.
    const list = within(card).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("bdi")?.textContent)).toEqual([
      "Mara's MacBook Pro",
      "Studio PC",
    ]);
    const times = rows.map((r) => r.querySelector("time")!);
    expect(times[0]!.textContent).toMatch(/min/);
    expect(times[0]!.getAttribute("title")).toBe(formatDayTime(NOW_S - 180));
    expect(times[1]!.textContent).toMatch(/day/);
    expect(within(card).getByText("Last synced").tagName).toBe("H3");
    expect(
      within(card).getByText("Only your devices can read your synced data."),
    ).toBeTruthy();
    // No "Up to date": the Worker's time is a push or a pull, at most an hour stale.
    expect(card.textContent).not.toMatch(/up to date/i);
    // The nav lists it in the page's order, between Devices and Your Data.
    for (const links of navLinks())
      expect(links).toEqual([
        "License",
        "Devices 1",
        "Sync Across Devices",
        "Your Data",
      ]);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("says nothing about who can read it when the server holds the data readable", async () => {
    mockFetch(routes(true, summary({ encryption: "server" })));
    renderPortal();
    await page();
    const card = await syncCard();
    await within(card).findByRole("meter", { name: "Storage" });
    expect(card.textContent).not.toMatch(/Only your devices/);
  });

  it("loads in place: a skeleton in the card until the summary answers", async () => {
    let answer: (v: unknown) => void = () => {};
    mockFetch(routes(true, () => new Promise((resolve) => (answer = resolve))));
    renderPortal();
    await page();
    const card = await syncCard();
    expect(card.querySelector(".pk-skeleton")).not.toBeNull();
    expect(within(card).queryByRole("meter")).toBeNull();
    answer(summary());
    await within(card).findByRole("meter", { name: "Storage" });
    expect(card.querySelector(".pk-skeleton")).toBeNull();
  });

  it("empty: says nothing is synced yet and how it starts, with no meter or device list", async () => {
    mockFetch(
      routes(true, summary({ empty: true, usage: { bytes: 0 }, devices: [] })),
    );
    renderPortal();
    await page();
    const card = await syncCard();
    await within(card).findByText(
      "Nothing synced yet. Sign in to Mossgarden on a device to start.",
    );
    expect(within(card).queryByRole("meter")).toBeNull();
    expect(within(card).queryByRole("list")).toBeNull();
    // Nothing is stored, so there is nothing yet to say who can read.
    expect(card.textContent).not.toMatch(/Only your devices/);
    expect(await axeViolations()).toEqual([]);
  });

  it("paused: says so in words beside the numbers", async () => {
    mockFetch(
      routes(true, summary({ state: "paused", pausedSince: NOW_S - DAY })),
    );
    renderPortal();
    await page();
    const card = await syncCard();
    await within(card).findByText("Sync paused");
    expect(
      within(card).getByText(
        "Syncing is paused for a moment. Your changes are kept and will sync later.",
      ),
    ).toBeTruthy();
    expect(within(card).getByRole("meter", { name: "Storage" })).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("full: the meter is at the limit and the card says what happens to new changes", async () => {
    mockFetch(
      routes(true, summary({ state: "full", usage: { bytes: 1024 ** 3 } })),
    );
    renderPortal();
    await page();
    const card = await syncCard();
    await within(card).findByText("Storage full");
    expect(
      within(card).getByText(
        "New changes stay on your devices until there's room.",
      ),
    ).toBeTruthy();
    const meter = within(card).getByRole("meter", { name: "Storage" });
    expect(meter.getAttribute("aria-valuetext")).toBe("1 GB of 1 GB");
    expect(meter.querySelector(".fill-danger")).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("a failed read says what failed in the card, and Try again reads it again", async () => {
    let fail = true;
    mockFetch(
      routes(true, () =>
        fail ? { status: 500, body: { error: "internal" } } : summary(),
      ),
    );
    renderPortal();
    await page();
    const card = await syncCard();
    await within(card).findByText("Couldn't load your synced data.");
    fail = false;
    await userEvent.click(
      within(card).getByRole("button", { name: "Try again" }),
    );
    await within(card).findByRole("meter", { name: "Storage" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("with sync off: no section, no nav entry, and the summary is never asked for", async () => {
    mockFetch(routes(false, summary()));
    renderPortal();
    await page();
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/products/mossgarden"),
    );
    // The product view has answered: the License card's facts are on the page.
    await screen.findByText("Activated");
    expect(
      screen.queryByRole("heading", { name: "Sync Across Devices" }),
    ).toBeNull();
    for (const links of navLinks())
      expect(links).not.toContain("Sync Across Devices");
    expect(fetchedRequests().some((r) => r.endsWith("/mossgarden/sync"))).toBe(
      false,
    );
  });

  it("with sync off, #/p/<product>/sync becomes the product page's own address", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden/sync?license=x");
    mockFetch(routes(false));
    renderPortal();
    await page();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/mossgarden?license=x"),
    );
    expect(
      screen.queryByRole("heading", { name: "Sync Across Devices" }),
    ).toBeNull();
  });

  it("a 404 from the summary (sync went off meanwhile) takes the section away, and its deep link", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden/sync");
    mockFetch(routes(true));
    renderPortal();
    await page();
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/products/mossgarden/sync"),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/mossgarden"));
    expect(
      screen.queryByRole("heading", { name: "Sync Across Devices" }),
    ).toBeNull();
    for (const links of navLinks())
      expect(links).not.toContain("Sync Across Devices");
  });

  it("with sync on, #/p/<product>/sync stays and scrolls to the section once it arrives", async () => {
    window.history.replaceState(null, "", "/#/p/mossgarden/sync");
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this.id);
    });
    mockFetch(routes(true, summary()));
    renderPortal();
    await page();
    await syncCard();
    await waitFor(() => expect(scrolled).toContain("section-sync"));
    expect(window.location.hash).toBe("#/p/mossgarden/sync");
  });
});

describe("the jump palette's sync action (PX-18.1, D10)", () => {
  const NAMES = [
    "Mossgarden",
    "Nightfall",
    "Tidewater Studio",
    "Orbit Survey",
    "Drift Kart",
    "Hollow Pines",
    "Glyphsmith",
    "Lumen RAW",
  ];
  const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const EIGHT = NAMES.map((n, i) =>
    license({
      product: slug(n),
      productName: n,
      activatedAt: NOW_S - i * DAY,
    }),
  );

  async function palette(query: string): Promise<HTMLElement> {
    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", {
      name: "Jump to a product",
    });
    await userEvent.keyboard(query);
    return dialog;
  }

  it("offers it for a product whose page is known to have the section, and jumps there", async () => {
    mockFetch(
      signedIn(EIGHT, {
        "/api/products/mossgarden": view("mossgarden", true),
        "/api/products/mossgarden/sync": summary(),
        "/api/products/glyphsmith": view("glyphsmith", true),
      }),
    );
    renderPortal();
    await page();
    await syncCard();
    const dialog = await palette("moss");
    const action = within(dialog).getByText("See synced data for Mossgarden");
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(action);
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/mossgarden/sync"),
    );
  });

  it("never offers it for a product with sync off, or one whose page this tab hasn't read", async () => {
    window.history.replaceState(null, "", "/#/p/nightfall");
    mockFetch(
      signedIn(EIGHT, {
        "/api/products/nightfall": view("nightfall", false),
        "/api/products/glyphsmith": view("glyphsmith", true),
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/products/nightfall"),
    );
    let dialog = await palette("night");
    expect(
      within(dialog).getByText("Manage devices for Nightfall"),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/See synced data/)).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Jump to a product" }),
      ).toBeNull(),
    );
    // Glyphsmith has sync on, but this tab has not read its page: nothing to key on.
    dialog = await palette("glyph");
    expect(
      within(dialog).getByText("Manage devices for Glyphsmith"),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/See synced data/)).toBeNull();
  });
});

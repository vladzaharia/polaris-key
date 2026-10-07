import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalLibraryItem,
  PortalLicenseSummary,
  PortalRelease,
} from "../src/portal/api.js";
import { forgetLoadedPages } from "../src/portal/stagger.js";
import {
  artifact,
  axeViolations,
  DAY,
  libraryItem,
  license,
  mockFetch,
  NOW_S,
  release,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * "Added just now" in the Library (PX-24; EXPERIENCE §0.6 P1 step 7, §0.7 frame 7): for 24 hours
 * after the account's first contact with a product, its tile (grid, compact grid) and its list row
 * carry a ring and the quiet text, lead with its download and come first under the default sort.
 * The ring and the text come in once per product per document; the animations themselves run in
 * e2e/libraryMotion.e2e.test.ts.
 */

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
  // Every test stands for a fresh document.
  forgetLoadedPages();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.vt;
});

const macRelease = (product: string): PortalRelease =>
  release({
    product,
    version: "1.4.2",
    artifacts: [
      artifact({
        artifactId: `${product}-mac`,
        name: `${product}.dmg`,
        platform: "macos",
        arch: "universal",
      }),
    ],
  });

const NAMES = [
  "Nightfall",
  "Tidewater Studio",
  "Ember Tactics",
  "Orbit Survey",
  "Drift Kart",
  "Hollow Pines",
  "Glyphsmith",
  "Lumen RAW",
  "Quill",
  "Saltwind",
  "Pixel Forge SDK",
  "Mossgarden",
];
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * `n` products in the Worker's order (name order, as the Worker lists licences), each first met
 * `i + 2` days ago, except those in `fresh` (seconds ago, by product name).
 */
function products(
  n: number,
  fresh: Record<string, number> = {},
): { licenses: PortalLicenseSummary[]; items: PortalLibraryItem[] } {
  const names = NAMES.slice(0, n).sort();
  const licenses = names.map((name, i) =>
    license({
      product: slug(name),
      productName: name,
      activatedAt: name in fresh ? NOW_S - fresh[name]! : NOW_S - (i + 2) * DAY,
    }),
  );
  return {
    licenses,
    items: licenses.map((l) => libraryItem(l)),
  };
}

function serve(
  n: number,
  fresh: Record<string, number> = {},
  releases: PortalRelease[] = [],
): void {
  const { licenses, items } = products(n, fresh);
  mockFetch(
    signedIn(licenses, {
      "/api/library": { products: items },
      "/api/releases": { releases },
    }),
  );
}

/** The tiles' names in the order they show. */
function tileOrder(): string[] {
  return screen
    .getAllByRole("article")
    .map((a) => a.querySelector("h3")!.textContent!);
}

/** A tile's wrapper (the lift), which also holds the ring outside the clipping card. */
function wrapperOf(name: string): HTMLElement {
  return screen.getByRole("article", { name }).parentElement!;
}

function ringOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>("[data-ring]");
}

function textOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>("[data-cue='text']");
}

async function grid(name: string): Promise<void> {
  await screen.findByRole("article", { name });
}

describe("the rule on the tile (2–7 products)", () => {
  it("rings a product added a minute ago, says so, leads with its download and puts it first", async () => {
    serve(3, { "Tidewater Studio": 60 }, [
      macRelease("tidewater-studio"),
      macRelease("nightfall"),
    ]);
    renderPortal();
    await grid("Tidewater Studio");
    // First, ahead of the Worker's (name) order.
    expect(tileOrder()).toEqual([
      "Tidewater Studio",
      "Ember Tactics",
      "Nightfall",
    ]);

    const fresh = wrapperOf("Tidewater Studio");
    const card = screen.getByRole("article", { name: "Tidewater Studio" });
    // The words carry the meaning, at the head of the reason line.
    expect(within(card).getByText("Added just now")).toBeTruthy();
    expect(textOf(card)!.parentElement!.textContent).toMatch(
      /^Added just now · /,
    );
    // The ring is decoration, outside the card (which clips its art).
    const ring = ringOf(fresh)!;
    expect(ring.getAttribute("aria-hidden")).toBe("true");
    expect(ring.parentElement).toBe(fresh);
    expect(card.contains(ring)).toBe(false);
    // The download leads: solid, not the outlined quick action.
    const lead = within(card).getByRole("button", {
      name: /^Download for macOS: Tidewater Studio/,
    });
    expect(lead.getAttribute("data-variant")).toBe("primary");

    // The others are ordinary.
    const other = screen.getByRole("article", { name: "Nightfall" });
    expect(within(other).queryByText("Added just now")).toBeNull();
    expect(ringOf(wrapperOf("Nightfall"))).toBeNull();
    expect(
      within(other)
        .getByRole("button", { name: /^Download for macOS: Nightfall/ })
        .getAttribute("data-variant"),
    ).toBe("quiet");
    expect(document.querySelectorAll("[data-ring]")).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("is ordinary again at 24 hours", async () => {
    serve(3, { "Tidewater Studio": DAY }, [macRelease("tidewater-studio")]);
    renderPortal();
    await grid("Tidewater Studio");
    expect(screen.queryByText("Added just now")).toBeNull();
    expect(document.querySelector("[data-ring]")).toBeNull();
    expect(tileOrder()).toEqual([
      "Ember Tactics",
      "Nightfall",
      "Tidewater Studio",
    ]);
    const card = screen.getByRole("article", { name: "Tidewater Studio" });
    expect(
      within(card)
        .getByRole("button", { name: /^Download for macOS/ })
        .getAttribute("data-variant"),
    ).toBe("quiet");
  });

  it("keeps the outlined action when the quick action is not a download (See downloads)", async () => {
    // Built for Windows only: on this Mac the quick action opens the product's downloads.
    serve(3, { "Tidewater Studio": 60 }, [
      release({
        product: "tidewater-studio",
        version: "1.0",
        artifacts: [
          artifact({
            artifactId: "win",
            name: "Tidewater.exe",
            platform: "windows",
            arch: "x64",
          }),
        ],
      }),
    ]);
    renderPortal();
    await grid("Tidewater Studio");
    const card = screen.getByRole("article", { name: "Tidewater Studio" });
    expect(within(card).getByText("Added just now")).toBeTruthy();
    expect(ringOf(wrapperOf("Tidewater Studio"))).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: "See downloads: Tidewater Studio" })
        .getAttribute("data-variant"),
    ).toBe("quiet");
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps the old date of a product the account met before (no ring on a re-add)", async () => {
    const { licenses, items } = products(3);
    mockFetch(
      signedIn(licenses, {
        // The licence was attached a minute ago, but the account's first contact is 40 days old.
        "/api/library": {
          products: items.map((it) =>
            it.product === "nightfall"
              ? {
                  ...it,
                  license: { ...it.license, activatedAt: NOW_S - 60 },
                  addedAt: NOW_S - 40 * DAY,
                }
              : it,
          ),
        },
      }),
    );
    renderPortal();
    await grid("Nightfall");
    expect(screen.queryByText("Added just now")).toBeNull();
    expect(document.querySelector("[data-ring]")).toBeNull();
  });
});

describe("at scale (8+): the compact grid and the list", () => {
  it("is first under the default sort and keeps its place by name", async () => {
    serve(12, { Mossgarden: 60 }, [macRelease("mossgarden")]);
    renderPortal();
    await grid("Mossgarden");
    expect(tileOrder()[0]).toBe("Mossgarden");
    const card = screen.getByRole("article", { name: "Mossgarden" });
    expect(within(card).getByText("Added just now")).toBeTruthy();
    expect(
      within(card)
        .getByRole("button", { name: /^Download for macOS: Mossgarden/ })
        .getAttribute("data-variant"),
    ).toBe("primary");
    expect(await axeViolations()).toEqual([]);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort" }),
      "name",
    );
    await waitFor(() => expect(tileOrder()[0]).toBe("Drift Kart"));
    const byName = tileOrder();
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    // Still ringed and still saying so, in its place.
    expect(
      within(screen.getByRole("article", { name: "Mossgarden" })).getByText(
        "Added just now",
      ),
    ).toBeTruthy();
  });

  it("marks the list's row the same way: the text under the name, the ring, the lead", async () => {
    window.history.replaceState(null, "", "/#/?view=list");
    serve(12, { Mossgarden: 60 }, [macRelease("mossgarden")]);
    renderPortal();
    const table = await screen.findByRole("table", { name: "Your products" });
    const rows = within(table).getAllByRole("row").slice(1);
    const row = rows[0]!;
    expect(within(row).getByRole("link", { name: "Mossgarden" })).toBeTruthy();
    expect(within(row).getByText("Added just now")).toBeTruthy();
    expect(ringOf(row)!.getAttribute("aria-hidden")).toBe("true");
    expect(
      within(row)
        .getByRole("button", { name: /^Download for macOS: Mossgarden/ })
        .getAttribute("data-variant"),
    ).toBe("primary");
    for (const r of rows.slice(1)) {
      expect(within(r).queryByText("Added just now")).toBeNull();
      expect(ringOf(r)).toBeNull();
    }
    expect(table.querySelectorAll("[data-ring]")).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });
});

describe("the cue comes in once per product per document", () => {
  it("pops the text and fades the ring in the first time, then never again (view switch, search)", async () => {
    serve(12, { Mossgarden: 60 }, [macRelease("mossgarden")]);
    renderPortal();
    await grid("Mossgarden");
    const first = wrapperOf("Mossgarden");
    expect(textOf(first)!.className).toMatch(/\bpk-pop-in\b/);
    // The ring only fades: a scaled ring would pass inside the card's edge.
    expect(ringOf(first)!.className).toMatch(/\bpk-content-in\b/);
    expect(ringOf(first)!.className).not.toMatch(/\bpk-pop-in\b/);

    // Grid → List: the row shows the cue without motion.
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    const table = await screen.findByRole("table", { name: "Your products" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(textOf(row)!.className).not.toMatch(/\bpk-pop-in\b/);
    expect(ringOf(row)!.className).not.toMatch(/\bpk-content-in\b/);

    // And back, then a search that hides it and Show all that brings it back: still static.
    await userEvent.click(screen.getByRole("radio", { name: "Grid" }));
    await grid("Mossgarden");
    expect(textOf(wrapperOf("Mossgarden"))!.className).not.toMatch(
      /\bpk-pop-in\b/,
    );
    await userEvent.type(screen.getByRole("searchbox"), "orbit");
    expect(await screen.findByText(/Showing 1 of 12 ·/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    await grid("Mossgarden");
    const back = wrapperOf("Mossgarden");
    expect(textOf(back)!.className).not.toMatch(/\bpk-pop-in\b/);
    expect(ringOf(back)!.className).not.toMatch(/\bpk-content-in\b/);
  });

  it("is simply there on a return to the page", async () => {
    serve(3, { "Tidewater Studio": 60 });
    renderPortal();
    await grid("Tidewater Studio");
    expect(textOf(wrapperOf("Tidewater Studio"))!.className).toMatch(
      /\bpk-pop-in\b/,
    );
    act(() => {
      window.location.hash = "#/account";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("heading", { level: 1, name: "Account" });
    act(() => {
      window.location.hash = "#/";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await grid("Tidewater Studio");
    const w = wrapperOf("Tidewater Studio");
    expect(textOf(w)!.className).not.toMatch(/\bpk-pop-in\b/);
    expect(ringOf(w)!.className).not.toMatch(/\bpk-content-in\b/);
  });

  it("is simply there when the page mounts inside a View Transition (Back from a product)", async () => {
    document.documentElement.dataset.vt = "back";
    serve(3, { "Tidewater Studio": 60 });
    renderPortal();
    await grid("Tidewater Studio");
    const w = wrapperOf("Tidewater Studio");
    expect(textOf(w)!.className).not.toMatch(/\bpk-pop-in\b/);
    expect(ringOf(w)!.className).not.toMatch(/\bpk-content-in\b/);
  });

  it("drops its classes once its own animations finish, and at once when there are none", async () => {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    // The cue's two animations, still running; nothing else animates.
    const running = function (this: Element) {
      return [...this.querySelectorAll("[data-cue]")].map((target) => ({
        effect: { target },
        finished: done,
      }));
    };
    const stub = (value: unknown) =>
      Object.defineProperty(Element.prototype, "getAnimations", {
        configurable: true,
        value,
      });
    try {
      stub(running);
      serve(3, { "Tidewater Studio": 60 });
      renderPortal();
      await grid("Tidewater Studio");
      const w = wrapperOf("Tidewater Studio");
      expect(textOf(w)!.className).toMatch(/\bpk-pop-in\b/);
      expect(ringOf(w)!.className).toMatch(/\bpk-content-in\b/);
      await act(async () => {
        finish();
        await done;
      });
      await waitFor(() =>
        expect(textOf(w)!.className).not.toMatch(/\bpk-pop-in\b/),
      );
      expect(ringOf(w)!.className).not.toMatch(/\bpk-content-in\b/);

      // Reduced motion: no animations at all, so nothing is left waiting to replay.
      cleanup();
      forgetLoadedPages();
      stub(() => []);
      serve(3, { "Tidewater Studio": 60 });
      renderPortal();
      await grid("Tidewater Studio");
      await waitFor(() =>
        expect(textOf(wrapperOf("Tidewater Studio"))!.className).not.toMatch(
          /\bpk-pop-in\b/,
        ),
      );
      expect(ringOf(wrapperOf("Tidewater Studio"))!.className).not.toMatch(
        /\bpk-content-in\b/,
      );
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  axeViolations,
  DAY,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

const NAMES = [
  "Nightfall",
  "Tidewater Studio",
  "Mossgarden",
  "Orbit Survey",
  "Drift Kart",
  "Hollow Pines",
  "Glyphsmith",
  "Lumen RAW",
  "Quill",
  "Pixel Forge SDK",
  "Saltwind",
  "Ember Tactics",
];
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const TWELVE = NAMES.map((n, i) =>
  license({
    product: slug(n),
    productName: n,
    activatedAt: NOW_S - i * DAY,
    ...(n === "Ember Tactics" ? { expiresAt: NOW_S - DAY, usable: false } : {}),
    ...(n === "Glyphsmith" ? { expiresAt: NOW_S + 9 * DAY } : {}),
  }),
);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function ready(): Promise<void> {
  await screen.findByRole("searchbox", { name: "Search 12 products" });
}

describe("scale features from 8 products (PX-03)", () => {
  it("has no toolbar or palette below 8 products", async () => {
    mockFetch(signedIn(TWELVE.slice(0, 7)));
    renderPortal();
    await screen.findAllByRole("article");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Jump to a product" }),
    ).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(
      screen.queryByRole("dialog", { name: "Jump to a product" }),
    ).toBeNull();
  });

  it("searches, says how many it shows, and keeps the query in the URL", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.type(screen.getByRole("searchbox"), "orbit");
    expect(await screen.findByText(/Showing 1 of 12 ·/)).toBeTruthy();
    expect(window.location.hash).toBe("#/?q=orbit");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(window.location.hash).toBe("#/");
  });

  it("focuses search with /", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("filters to Needs attention with counts, hiding zero-count chips", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    const group = screen.getByRole("group", { name: "Filter" });
    const chip = within(group).getByRole("button", { name: /Needs attention/ });
    expect(chip.textContent).toContain("2");
    expect(within(group).queryByRole("button", { name: /Games/ })).toBeNull();
    await userEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.hash).toBe("#/?filter=attention");
    expect(
      screen
        .getAllByRole("article")
        .map((a) => within(a).getByRole("heading").textContent),
    ).toEqual(["Glyphsmith", "Ember Tactics"]);
  });

  it("sorts by name", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort" }),
      "name",
    );
    expect(window.location.hash).toBe("#/?sort=name");
    const first = screen.getAllByRole("article")[0]!;
    expect(within(first).getByRole("heading").textContent).toBe("Drift Kart");
  });

  it("switches to the list: one row per product, the whole row a link", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(window.location.hash).toBe("#/?view=list");
    const table = await screen.findByRole("table", { name: "Your products" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(12);
    expect(
      within(rows[0]!)
        .getByRole("link", { name: "Nightfall" })
        .getAttribute("href"),
    ).toBe("#/p/nightfall");
    expect(window.localStorage.getItem("pk-portal-library-view")).toBe("list");
    expect(await axeViolations()).toEqual([]);
  });

  it("jumps to a product from the keyboard with ⌘K / Ctrl K", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", {
      name: "Jump to a product",
    });
    expect(await axeViolations()).toEqual([]);
    await userEvent.keyboard("glyph");
    expect(
      within(dialog).getByText("Manage devices for Glyphsmith"),
    ).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/p/glyphsmith"));
    expect(
      screen.queryByRole("dialog", { name: "Jump to a product" }),
    ).toBeNull();
    // Focus lands on the product's h1, not body (FLOWS.md P-14).
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Glyphsmith",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("jumping to the product already showing still focuses its h1 (UX-79)", async () => {
    window.history.replaceState(null, "", "/#/p/glyphsmith");
    mockFetch(signedIn(TWELVE));
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Glyphsmith",
    });
    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Jump to a product" });
    await userEvent.keyboard("glyph{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Jump to a product" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("moves through the palette with the arrow keys and opens Activate from it", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await ready();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Jump to a product" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Jump to a product",
    });
    await userEvent.keyboard("zzz-nothing");
    expect(
      within(dialog).getByText(/Nothing in your library matches/),
    ).toBeTruthy();
    await userEvent.clear(within(dialog).getByRole("combobox"));
    await userEvent.type(within(dialog).getByRole("combobox"), "quill");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    const selected = dialog.querySelector("[data-selected=true]");
    expect(selected?.textContent).toBe("Activate a license");
    await userEvent.keyboard("{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Activate a license" }),
    ).toBeTruthy();
  });
});

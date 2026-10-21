/**
 * Stabilization package A (B-001 to B-016): the console shell, switcher, palette and landing
 * pages, one test per bug that no existing suite pinned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Me } from "../src/api.js";
import { canOpenPage, landingPage } from "../src/console/access/can.js";
import { ALL_ON, boot, resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A member narrowed to Ship builds and Commerce in two products, without the Platform area. */
const NARROWED: Partial<Me> = {
  platformAdmin: false,
  email: "lucia@example.com",
  products: [
    { slug: "djdl", name: "DJDL", schemaVersion: 1 },
    { slug: "acme", name: "Acme", schemaVersion: 1 },
  ],
  permissions: {
    roles: [
      {
        role: "product_admin",
        scope: "all-products",
        areas: ["ship", "commerce"],
        source: "grant",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {
      djdl: { view: ["ship", "commerce"], edit: ["ship", "commerce"] },
      acme: { view: ["ship", "commerce"], edit: ["ship", "commerce"] },
    },
  },
};
const NARROWED_ME = { ...(NARROWED as Me) };

async function ready(): Promise<HTMLElement> {
  const nav = await screen.findByRole("navigation", { name: "Console" });
  await waitFor(() =>
    expect(within(nav).queryAllByRole("link").length).toBeGreaterThan(0),
  );
  return nav;
}

describe("B-016: a narrowed member's product links open a page they can see", () => {
  it("landingPage is Overview when allowed, else the first page the role opens", () => {
    expect(canOpenPage(NARROWED_ME, "overview", "djdl")).toBe(false);
    const page = landingPage(NARROWED_ME, "djdl", null);
    expect(page).not.toBe("overview");
    expect(canOpenPage(NARROWED_ME, page, "djdl")).toBe(true);
  });

  it("the switcher opens the landing page, not Overview", async () => {
    boot("#/p/djdl/release/releases", { me: NARROWED, services: ALL_ON });
    await ready();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Product: DJDL (djdl). Change product",
      }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /^Acme/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/acme\//));
    expect(window.location.hash).not.toBe("#/p/acme");
    expect(window.location.hash).not.toMatch(/#\/p\/acme\/?$/);
  });

  it("Home's product card and the palette's product row do the same", async () => {
    boot("#/", { me: NARROWED, services: ALL_ON });
    await ready();
    const main = await screen.findByRole("main");
    const link = await within(main).findByRole("link", { name: "DJDL" });
    const href = link.getAttribute("href")!;
    expect(href).toMatch(/^#\/p\/djdl\/.+/);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "acme",
    );
    const rows = await within(dialog).findAllByRole("option", {
      name: /^Acme\s*acme/,
    });
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/acme\/./));
  });
});

describe("the switcher", () => {
  it("B-001: its name is the visible name (Platform, or All products without the area)", async () => {
    boot("#/", { services: ALL_ON });
    await ready();
    expect(
      screen.getByRole("button", { name: "Platform. Change product" }),
    ).toBeTruthy();
    cleanup();
    resetConsole();
    boot("#/", { me: NARROWED, services: ALL_ON });
    await ready();
    const card = screen.getByRole("button", {
      name: "All products. Change product",
    });
    expect(card.textContent).toContain("All products");
    expect(screen.queryByText("Platform", { selector: "li *" })).toBeNull();
  });

  it("B-010: the Platform row carries the core accent, not the page's", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Product: DJDL (djdl). Change product",
      }),
    );
    const platform = await screen.findByRole("option", { name: /^Platform/ });
    expect(platform.getAttribute("data-service")).toBe("core");
  });

  it("B-006: Escape after g p returns focus to where it was", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const where = await screen.findByRole("button", { name: "Account menu" });
    where.focus();
    await userEvent.keyboard("gp");
    await screen.findByRole("combobox", { name: "Find a product" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "Find a product" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(where));
  });
});

describe("the sidebar", () => {
  it("B-008/B-009: each group's list is named by its header, and the header draws no forced-colours box", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    const nav = await ready();
    const headers = nav.querySelectorAll<HTMLButtonElement>(
      "button[data-section-header]",
    );
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h.className).toContain("forced-colors:border-0");
      expect(h.id).not.toBe("");
      // A collapsed group renders no list; an open one's list is named by its header.
      const list = document
        .getElementById(h.getAttribute("aria-controls")!)
        ?.querySelector("ul");
      if (list) expect(list.getAttribute("aria-labelledby")).toBe(h.id);
    }
  });
});

describe("the command palette", () => {
  const open = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    return screen.findByRole("dialog", { name: "Command palette" });
  };

  it("B-002/B-003: after typing, the active descendant exists, and an empty result has no empty listbox", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const dialog = await open();
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    // Move the selection down the untyped list, then narrow to rows that drop it.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await userEvent.type(input, "tiers");
    await waitFor(() => {
      const id = input.getAttribute("aria-activedescendant");
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)).not.toBeNull();
    });
    await expectNoAxeViolations(dialog);

    await userEvent.clear(input);
    await userEvent.type(input, "qqqqq");
    await within(dialog).findByText("Nothing matches “qqqqq”.");
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    await expectNoAxeViolations(dialog);
  });

  it("B-011: the count skips the See all row and says 8 of N when settings are capped", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const dialog = await open();
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "e",
    );
    const seeAll = await within(dialog).findByRole("option", {
      name: /^See all \d+ settings/,
    });
    const total = /See all (\d+) settings/.exec(seeAll.textContent!)![1];
    const live = within(dialog)
      .getAllByRole("status")
      .find((el) => el.getAttribute("aria-atomic") === "true")!;
    // Debounced: nothing is announced for every letter.
    await waitFor(
      () =>
        expect(live.textContent).toMatch(new RegExp(`8 of ${total} settings$`)),
      { timeout: 3000 },
    );
    const options = within(dialog).getAllByRole("option").length;
    expect(live.textContent).toMatch(new RegExp(`^${options - 1} results`));
  });
});

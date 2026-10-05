import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  ALL_ON,
  PENDING,
  boot,
  productRow,
  resetConsole,
  type FetchLog,
} from "./consoleHarness.js";

/**
 * Products (ADMIN.md §2.3, T2; replaces `views/Products.tsx` and `products/*`). Closes PRD-1 to
 * PRD-5 and PRD-10 to PRD-12; the create flow is the wizard's (productNew.test.tsx).
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const main = (): HTMLElement => screen.getByRole("main");

function registry(): Record<string, unknown> {
  return {
    "/manage/api/products": {
      products: [
        productRow("djdl", "DJDL", ALL_ON),
        {
          ...productRow("acme", "Acme", ALL_ON),
          releaseSource: "github",
          setup: {
            healthy: false,
            nextActions: [{ id: "secret:WEBHOOK_SECRET", label: "x" }],
          },
        },
      ],
    },
  };
}

async function page(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: /Products/ });
  return main();
}

/** The table's body rows (skipping the header row). */
const rows = (): HTMLElement[] =>
  within(within(main()).getByRole("table"))
    .getAllByRole("row")
    .filter((r) => r.querySelector("td"));

async function openRowMenu(name: string): Promise<void> {
  await userEvent.click(
    within(main()).getByRole("button", { name: `Actions for ${name}` }),
  );
}

describe("Products", () => {
  it("lists every product with its slug, source, services and setup (PRD-11)", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const acme = rows().find((r) => r.textContent?.includes("acme"))!;
    expect(within(acme).getByText("GitHub")).toBeTruthy();
    expect(within(acme).getByText("1 needs attention")).toBeTruthy();
    expect(
      within(acme).getByText(
        "Runs License, Config, Release, Distribution, Update, Identity and Cloud Sync",
      ),
    ).toBeTruthy();
    const djdl = rows().find((r) => r.textContent?.includes("djdl"))!;
    expect(within(djdl).getByText("Manual")).toBeTruthy();
    // Pills mean attention (ADMIN.md §5.11): the issue pill ends the row, in the last data
    // column; a healthy product draws no pill, only words for assistive tech.
    const acmeCells = within(acme).getAllByRole("cell");
    const setupCell = acmeCells.find((c) =>
      c.textContent?.includes("1 needs attention"),
    )!;
    expect(setupCell.querySelector("[data-status=pill]")).not.toBeNull();
    expect(
      acmeCells.indexOf(setupCell) >=
        acmeCells.filter((c) => c.textContent?.trim()).length - 1,
    ).toBe(true);
    expect(djdl.querySelector("[data-status=pill]")).toBeNull();
    expect(within(djdl).getByText("Setup complete").className).toContain(
      "sr-only",
    );
  });

  it("the product name links to its Overview, never a service page (PRD-1)", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      within(main()).getByRole("link", { name: "DJDL" }).getAttribute("href"),
    ).toBe("#/p/djdl");
  });

  it("opens a product's Overview when its row is clicked (owner, 2026-10-03)", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(within(main()).getByText("djdl"));
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl"));
  });

  it("is not a role=button row wrapping its menu (PRD-2)", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(main().querySelector("tr[role=button]")).toBeNull();
  });

  it("keeps search and facets in the URL", async () => {
    boot("#/products?source=github", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.textContent).toContain("acme");
    await userEvent.type(
      within(main()).getByRole("searchbox", { name: /Search/ }),
      "zz",
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/products?source=github&q=zz"),
    );
  });

  it("says when filters match nothing, with Clear filters", async () => {
    boot("#/products?q=nothing-here", { extra: registry() });
    await page();
    expect(await within(main()).findByText(/No products match/)).toBeTruthy();
  });

  it("first run: the empty state opens the wizard", async () => {
    boot("#/products", { me: { products: [] } });
    await page();
    expect(await within(main()).findByText("No products yet")).toBeTruthy();
    expect(
      within(main())
        .getByRole("link", { name: "Link a repository" })
        .getAttribute("href"),
    ).toBe("#/products/new?via=github");
  });

  it("shows skeleton rows while loading", async () => {
    boot("#/products", { extra: { "/manage/api/products": PENDING } });
    await page();
    // Five skeleton rows, hidden from assistive tech (the live region announces the load).
    expect(main().querySelectorAll("tbody tr[aria-hidden]")).toHaveLength(5);
  });

  it("words a failed load and offers Retry (PRD-12)", async () => {
    boot("#/products", {
      extra: {
        "/manage/api/products": new Response("{}", { status: 500 }),
      },
    });
    await page();
    const alert = await within(main()).findByRole("alert");
    expect(alert.textContent).not.toMatch(/api 500/);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("New product opens the wizard page", async () => {
    boot("#/products", { extra: registry() });
    await page();
    expect(
      within(main())
        .getByRole("link", { name: /New product/ })
        .getAttribute("href"),
    ).toBe("#/products/new");
  });

  it("links to the product's own forms instead of copying them (PRD-5)", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await openRowMenu("DJDL");
    expect(
      await screen.findByRole("menuitem", { name: "Open settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Open keys & secrets" }),
    ).toBeTruthy();
    // No second Edit, Set secret or Prepare signing key form in the registry.
    expect(screen.queryByRole("menuitem", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Set secret/ })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Prepare signing key/ }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Open settings" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/settings"));
  });

  it("deletes only after the slug is typed, and sends the typed slug (PRD-3, PRD-4, L3)", async () => {
    const log: FetchLog = boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await openRowMenu("DJDL");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete DJDL?")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Delete product",
    });
    // L3: confirm stays unavailable until the slug is typed exactly.
    await userEvent.click(confirm);
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    const productsReads = log.calls.filter(
      (c) => c.path === "/manage/api/products" && c.method === "GET",
    ).length;
    // The button re-renders once it is usable (its disabled reason goes away): query it again.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete product" }),
    );
    await waitFor(() =>
      expect(
        log.calls.find(
          (c) =>
            c.method === "DELETE" && c.path === "/manage/api/products/djdl",
        )?.body,
      ).toBe(JSON.stringify({ confirmSlug: "djdl" })),
    );
    // Invalidation: the registry (and the session's product list) refetch.
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.path === "/manage/api/products" && c.method === "GET",
        ).length,
      ).toBeGreaterThan(productsReads),
    );
  });

  it("keeps the delete dialog open with the worded error when the server refuses (PRD-12)", async () => {
    boot("#/products", {
      extra: {
        ...registry(),
        "/manage/api/products/djdl": new Response(
          JSON.stringify({ error: "forbidden", message: "nope" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await openRowMenu("DJDL");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete product" }),
    );
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBe(dialog);
  });

  it("offers Resync from repo only for repository-linked products, behind a caution confirm", async () => {
    const log = boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await openRowMenu("DJDL");
    await screen.findByRole("menuitem", { name: "Open settings" });
    expect(
      screen.queryByRole("menuitem", { name: /Resync from repo/ }),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");

    await openRowMenu("Acme");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Resync from repo…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resync from repo" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === "/manage/api/products/acme/release/resync",
        ),
      ).toBe(true),
    );
  });

  it("passes axe", async () => {
    boot("#/products", { extra: registry() });
    await page();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

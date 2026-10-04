import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  ALL_ON,
  ME,
  PENDING,
  boot,
  productRow,
  resetConsole,
} from "./consoleHarness.js";

/**
 * Home (ADMIN.md §6.1; replaces `views/Dashboard.tsx`, closes DSH-1 to DSH-7). Driven through the
 * whole console so the registry query, the router's query state and the shell are the real ones.
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

async function home(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Home" });
  return main();
}

/** The registry with one product needing attention (a missing secret) and one healthy. */
function registry(): Record<string, unknown> {
  const djdl = {
    ...productRow("djdl", "DJDL", ALL_ON),
    modifiedAt: 2_000,
    releaseSource: "github",
    setup: {
      healthy: false,
      nextActions: [
        {
          id: "secret:OIDC_CLIENT_SECRET",
          label: "Set required secret OIDC_CLIENT_SECRET",
          route: "#/p/djdl/settings",
        },
        {
          id: "edge-mint:studio",
          label: "Review and approve edge-mint recipe studio",
          route: "#/p/djdl/secrets",
        },
      ],
    },
  };
  const acme = {
    ...productRow("acme", "Acme", {
      ...ALL_ON,
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    }),
    modifiedAt: 1_000,
  };
  return { "/manage/api/products": { products: [djdl, acme] } };
}

const cards = (): HTMLElement[] =>
  within(within(main()).getByRole("list", { name: "Products" })).getAllByRole(
    "article",
  );

describe("Home", () => {
  it("lists every product as a card whose name is the link, with an explicit Open (DSH-3)", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = cards().find((c) => c.getAttribute("aria-label") === "Acme")!;
    expect(
      within(acme).getByRole("link", { name: "Acme" }).getAttribute("href"),
    ).toBe("#/p/acme");
    expect(
      within(acme)
        .getByRole("link", { name: "Open Acme" })
        .getAttribute("href"),
    ).toBe("#/p/acme");
    // The card itself is not a link or a button.
    expect(acme.tagName).toBe("ARTICLE");
  });

  it("shows what each product runs, for sighted and screen-reader users alike (DSH-7)", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = cards().find((c) => c.getAttribute("aria-label") === "Acme")!;
    expect(
      within(acme).getByText("Runs License, Config and Release"),
    ).toBeTruthy();
    // No schema jargon on the card, and the email is not repeated on the page (DSH-4).
    expect(within(main()).queryByText(/schema v/i)).toBeNull();
    expect(within(main()).queryByText(ME.email)).toBeNull();
  });

  it("lists attention items from the registry's setup state, each with one action (DSH-1)", async () => {
    boot("#/", { extra: registry() });
    await home();
    const list = await within(main()).findByRole("region", {
      name: "Needs attention",
    });
    expect(
      within(list).getByText("Missing required secret OIDC_CLIENT_SECRET"),
    ).toBeTruthy();
    expect(
      within(list)
        .getByRole("link", { name: /Set secret/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/keys");
    // The edge-mint item points at Edge mint's own URL (the router takes it to its host today).
    expect(
      within(list)
        .getByRole("link", { name: /Review recipe/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config/edge-mint");
    // Live figures, no constants: 1 product needs attention, 1 of 2 complete.
    expect(within(main()).getByText("1 of 2")).toBeTruthy();
  });

  it("omits the attention list when nothing needs the operator", async () => {
    boot("#/");
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });

  it("filters and sorts the cards, both kept in the URL (DSH-7)", async () => {
    boot("#/?q=acm", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]!.getAttribute("aria-label")).toBe("Acme");
    const filter = within(main()).getByRole("textbox", {
      name: "Filter products",
    });
    expect((filter as HTMLInputElement).value).toBe("acm");
    await userEvent.clear(filter);
    await userEvent.type(filter, "dj");
    await waitFor(() => expect(window.location.hash).toBe("#/?q=dj"));
    await waitFor(() =>
      expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual([
        "DJDL",
      ]),
    );
  });

  it("sorts by name from the URL", async () => {
    boot("#/?sort=name", { extra: registry() });
    await home();
    await waitFor(() =>
      expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual([
        "Acme",
        "DJDL",
      ]),
    );
  });

  it("says when a filter matches nothing, with Clear filters", async () => {
    boot("#/?q=zzz", { extra: registry() });
    await home();
    expect(await within(main()).findByText("No products match")).toBeTruthy();
    await userEvent.click(
      within(main()).getByRole("button", { name: /Clear filters/ }),
    );
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(window.location.hash).toBe("#/");
  });

  it("first run: opens the wizard with the source chosen (DSH-6)", async () => {
    boot("#/", { me: { products: [] } });
    await home();
    expect(
      await within(main()).findByText("Register your first product"),
    ).toBeTruthy();
    expect(
      within(main())
        .getByRole("link", { name: /Link a repository/ })
        .getAttribute("href"),
    ).toBe("#/products/new?via=github");
    expect(
      within(main())
        .getByRole("link", { name: "Start manually" })
        .getAttribute("href"),
    ).toBe("#/products/new?via=manual");
    // There is one privilege level; nothing asks the operator to request a grant.
    expect(within(main()).queryByText(/grant access/i)).toBeNull();
    expect(within(main()).queryByText(/Product administrator/)).toBeNull();
  });

  it("shows loading tiles and cards while the registry loads", async () => {
    boot("#/", { extra: { "/manage/api/products": PENDING } });
    await home();
    expect(
      within(main())
        .getByRole("list", { name: "Products" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(within(main()).getByText("Loading Products")).toBeTruthy();
  });

  it("shows a retryable error when the registry cannot load", async () => {
    boot("#/", {
      extra: {
        "/manage/api/products": new Response(
          JSON.stringify({ error: "internal" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await home();
    const alert = await within(main()).findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("one name for the registry, and New product opens the wizard (DSH-5)", async () => {
    boot("#/", { extra: registry() });
    await home();
    expect(within(main()).queryByText(/registry/i)).toBeNull();
    expect(
      within(main())
        .getByRole("link", { name: /New product/ })
        .getAttribute("href"),
    ).toBe("#/products/new");
  });

  it("passes axe", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

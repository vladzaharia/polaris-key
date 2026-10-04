import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import {
  ALL_ON,
  ME,
  boot,
  mockFetch,
  productRow,
  resetConsole,
} from "./consoleHarness.js";

/**
 * Smoke tests for the console as a whole: boot, the session query, and a few pages through the
 * real router. The shell's behaviour is shell.test.tsx's; each view's is its own suite's.
 */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin SPA", () => {
  it("boots behind a live 'Loading console…' and lands on Home", async () => {
    boot("#/");
    expect(
      screen
        .getAllByRole("status")
        .some((el) => el.textContent === "Loading console…"),
    ).toBe(true);
    expect(await screen.findByText(/Welcome, Ada/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Polaris Key home" })).toBeTruthy();
  });

  it("shows a retryable error with a way to sign in when the session can't load", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? new Response("{}", { status: 500 })
          : new Response(JSON.stringify(ME), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("Can’t load the console")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/manage/login");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Welcome, Ada/)).toBeTruthy();
  });

  it("renders a product page at its new URL", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    expect(
      await screen.findByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
  });

  it("shows the Products registry", async () => {
    boot("#/products");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Products" }),
    ).toBeTruthy();
  });

  it("refreshes the session after a product is created, so the switcher sees it (SH-1, CC-1)", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    const { mutate } = await import("../src/console/data/mutations.js");
    const log = mockFetch({
      "/manage/api/me": {
        ...ME,
        products: [
          ...ME.products,
          { slug: "new", name: "New", schemaVersion: 0 },
        ],
      },
      // Serves both the create (POST) and the registry refetch (GET).
      "/manage/api/products": {
        ok: true,
        slug: "new",
        kid: "k",
        products: [
          productRow("djdl", "DJDL", ALL_ON),
          productRow("acme", "Acme", ALL_ON),
          productRow("new", "New", ALL_ON),
        ],
      },
    });
    await mutate("createManualProduct", { slug: "new" } as never);
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.path === "/manage/api/me" && c.method === "GET",
        ),
      ).toBe(true),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Product: DJDL/ }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("listbox", { name: "Products" }))
          .getAllByRole("option")
          .some((o) => o.textContent?.startsWith("New")),
      ).toBe(true),
    );
  });
});

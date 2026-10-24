import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { PageTabs } from "../src/console/components/PageTabs.js";
import { ALL_ON, boot, resetConsole } from "./consoleHarness.js";
import {
  libraryFor,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Both apps' routers, through the core, land focus on the new page's h1 and announce
 * "{title}, page loaded" once per route change (P0-34 acceptance; ADMIN.md §5.6).
 */
const announced: string[] = [];
vi.mock("../src/ui/LiveRegion.js", async (orig) => {
  const m = await orig<typeof import("../src/ui/LiveRegion.js")>();
  return {
    ...m,
    announce: (t: string) => {
      announced.push(t);
      m.announce(t);
    },
  };
});

beforeEach(() => {
  announced.length = 0;
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loaded = (): string[] =>
  announced.filter((a) => a.endsWith("page loaded"));

describe("route focus through the core", () => {
  it("console: a route change focuses the h1 and announces once; a query change is silent", async () => {
    resetConsole();
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "Licenses" });
    announced.length = 0;
    act(() => {
      window.location.hash = "#/p/djdl/license/tiers";
    });
    const h1 = await screen.findByRole("heading", { level: 1, name: "Tiers" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    await new Promise((r) => setTimeout(r, 80));
    expect(loaded()).toEqual(["Tiers, page loaded"]);
    announced.length = 0;
    act(() => {
      window.location.hash = "#/p/djdl/license/tiers?q=x";
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(loaded()).toEqual([]);
  });

  it("portal: a route change focuses the h1 and announces once", async () => {
    const licenses = [license({ product: "nightfall" })];
    mockFetch(signedIn(licenses, { "/api/library": libraryFor(licenses) }));
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    announced.length = 0;
    act(() => {
      window.location.hash = "#/account";
    });
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Account",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    await new Promise((r) => setTimeout(r, 80));
    expect(loaded()).toEqual(["Account, page loaded"]);
  });

  it("console: a missing record announces its visible heading, not the route title", async () => {
    resetConsole();
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "Licenses" });
    announced.length = 0;
    act(() => {
      window.location.hash = "#/p/djdl/license/licenses/lic_404";
    });
    await waitFor(() => expect(loaded().length).toBe(1), { timeout: 3000 });
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(document.activeElement).toBe(h1);
    expect(loaded()).toEqual([`${h1.textContent!.trim()}, page loaded`]);
    expect(loaded()[0]).not.toMatch(/^License lic_404/);
  });

  it("route tabs: a selection change moves focus from a stale tab to the selected one", () => {
    const items = [
      { value: "keys", label: "Keys", to: "#/x/keys" },
      { value: "devices", label: "Devices", to: "#/x/devices" },
    ];
    const ui = (value: string) => (
      <PageTabs items={items} value={value} label="Record" />
    );
    const { rerender } = render(ui("devices"));
    screen.getByRole("link", { name: "Devices" }).focus();
    rerender(ui("keys"));
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Keys" }),
    );
    // Focus elsewhere is left alone.
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    rerender(ui("devices"));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

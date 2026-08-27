/**
 * The console-side half of task 7.2: `capabilities.modules.releases` gates Downloads.
 *
 * The worker now folds that flag out of `products.services_json` — a product that does not run
 * the Release service cannot advertise downloads — but the SPA is where a customer either sees
 * the tab or does not, so the gating is pinned here as its own regression rather than left
 * implied by the worker suite. Both halves of the gate are asserted, because they fail
 * independently: hiding the nav item while `#/downloads` still mounts `Downloads` leaves the
 * view one hand-typed URL away, and `/api/releases` is fetched the moment it mounts.
 *
 * The absences are asserted with queries against the rendered tree, not with counts, so a
 * future layout change that renames or moves the nav cannot quietly satisfy them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalApp } from "../src/portal/App.js";

type MockRoute =
  | unknown
  | {
      status: number;
      body?: unknown;
    };

function isMockResponse(
  route: MockRoute,
): route is { status: number; body?: unknown } {
  return (
    route != null &&
    typeof route === "object" &&
    "status" in route &&
    typeof route.status === "number"
  );
}

function mockFetch(routes: Record<string, MockRoute>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = url.replace("http://localhost", "").split("?")[0]!;
      const route = routes[path];
      const status = isMockResponse(route) ? route.status : 200;
      const body = isMockResponse(route) ? route.body : route;
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** Every path the SPA has actually asked for so far. */
function fetchedPaths(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) =>
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
}

function signedIn(releases: boolean): Record<string, MockRoute> {
  return {
    "/api/me": {
      account: { id: "acct_1", name: "Ada Lovelace", email: "ada@x.io" },
      csrf: "csrf-token",
    },
    "/api/capabilities": {
      auth: { oidc: true, magic: true },
      modules: { licensing: true, claim: true, releases },
    },
    "/api/licenses": { licenses: [] },
    "/api/releases": { releases: [] },
  };
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("portal Downloads gating follows modules.releases", () => {
  it("shows the nav item and the view when releases are enabled", async () => {
    mockFetch(signedIn(true));

    render(<PortalApp />);

    const nav = await screen.findByRole("link", { name: "Downloads" });
    expect(nav.getAttribute("href")).toBe("#/downloads");
  });

  it("hides the nav item when releases are disabled", async () => {
    mockFetch(signedIn(false));

    render(<PortalApp />);

    // Waiting on a sibling nav item first: `queryBy` on a tree that has not finished its
    // capabilities fetch would pass for the wrong reason — nothing is rendered yet.
    expect(await screen.findByRole("link", { name: "Licenses" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Downloads" })).toBeNull();
  });

  it("renders the Downloads view for a #/downloads deep link when releases are enabled", async () => {
    window.location.hash = "#/downloads";
    mockFetch(signedIn(true));

    render(<PortalApp />);

    expect(
      await screen.findByRole("heading", { name: "Downloads" }),
    ).toBeTruthy();
    expect(fetchedPaths()).toContain("/api/releases");
  });

  it("refuses the same deep link when releases are disabled, and never fetches the listing", async () => {
    // The half a nav-only gate misses. `#/downloads` is reachable by typing it, by a bookmark
    // from before the product turned Release off, and by the back button.
    window.location.hash = "#/downloads";
    mockFetch(signedIn(false));

    render(<PortalApp />);

    expect(await screen.findByText("Downloads are unavailable")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Downloads" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Downloads" })).toBeNull();
    expect(fetchedPaths()).not.toContain("/api/releases");
  });

  it("shows neither view nor tab while capabilities are still loading", async () => {
    // `capabilities` is null on the first paint, and null is NOT "enabled": a deep link that
    // mounted `Downloads` optimistically would fire `/api/releases` before the answer arrived,
    // which is the same disclosure the gate exists to prevent, just earlier.
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.location.hash = "#/downloads";
    const routes = signedIn(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        const path = url.replace("http://localhost", "").split("?")[0]!;
        if (path === "/api/capabilities") await pending;
        const route = routes[path];
        const status = isMockResponse(route) ? route.status : 200;
        const body = isMockResponse(route) ? route.body : route;
        return new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    render(<PortalApp />);

    // The account resolves first, so the shell is up while capabilities are still in flight.
    expect(await screen.findByRole("link", { name: "Licenses" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Downloads" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Downloads" })).toBeNull();
    expect(fetchedPaths()).not.toContain("/api/releases");

    release?.();
    expect(await screen.findByText("Downloads are unavailable")).toBeTruthy();
  });
});

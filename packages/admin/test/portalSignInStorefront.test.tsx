import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import {
  CAPS_ALL,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * LK-12c/d: a signed-out visitor at a storefront link sees a card that names the product only
 * when `GET /api/storefront/<slug>` answers; a 404 or an error is the generic card.
 */

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Route = Parameters<typeof mockFetch>[0][string];

function open(hash: string, storefront?: Route): void {
  window.history.replaceState(null, "", `/${hash}`);
  mockFetch({
    ...signedIn(),
    "/api/me": { status: 401 },
    "/api/capabilities": CAPS_ALL,
    ...(storefront === undefined
      ? {}
      : { "/api/storefront/pixel-pals": storefront }),
  });
  renderPortal();
}

const GENERIC = { level: 1, name: "Sign in to Polaris Locker" } as const;

describe("signed-out storefront link", () => {
  it("names the product and shows its icon when the endpoint answers", async () => {
    open("#/discover/pixel-pals", {
      name: "Pixel Pals",
      iconUrl: "https://img.example.test/pixel-pals/a/x/128.webp",
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to add Pixel Pals",
      }),
    ).toBeTruthy();
    expect(document.querySelector('img[data-art="image"]')).toHaveProperty(
      "src",
      "https://img.example.test/pixel-pals/a/x/128.webp",
    );
    expect(window.location.hash).toBe("#/discover/pixel-pals");
    expect(fetchedRequests()).toContain("GET /api/storefront/pixel-pals");
  });

  it.each([
    ["a 404", { status: 404, body: { error: "not_found" } }],
    ["a network error", "network"],
  ] as [string, Route][])(
    "is the generic card on %s, never a name made from the slug",
    async (_label, route) => {
      open("#/discover/pixel-pals", route);
      expect(await screen.findByRole("heading", GENERIC)).toBeTruthy();
      await waitFor(() =>
        expect(fetchedRequests()).toContain("GET /api/storefront/pixel-pals"),
      );
      expect(screen.queryByText(/Pixel Pals/)).toBeNull();
    },
  );

  it("asks nothing for a slug that is not a slug", async () => {
    open("#/discover/%3Cb%3Ex%3C%2Fb%3E");
    expect(await screen.findByRole("heading", GENERIC)).toBeTruthy();
    expect(fetchedRequests().some((u) => /storefront/.test(u))).toBe(false);
  });

  it("keeps the generic card elsewhere", async () => {
    open("#/");
    expect(await screen.findByRole("heading", GENERIC)).toBeTruthy();
    expect(fetchedRequests().some((u) => /storefront/.test(u))).toBe(false);
  });
});

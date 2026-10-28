import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import {
  CAPS_ALL,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/** LK-12c: a signed-out visitor at a storefront link sees a card that names the product (slug only). */

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(hash: string): void {
  window.history.replaceState(null, "", `/${hash}`);
  mockFetch({
    ...signedIn(),
    "/api/me": { status: 401 },
    "/api/capabilities": CAPS_ALL,
  });
  renderPortal();
}

describe("signed-out storefront link", () => {
  it("names the product by its slug and keeps the return to the storefront", async () => {
    open("#/discover/pixel-pals");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to add pixel-pals",
      }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/discover/pixel-pals");
    // Only the URL's slug: no product read, no product-scoped capabilities.
    const urls = fetchedRequests();
    expect(urls.some((u) => /discover|product=/.test(u))).toBe(false);
  });

  it("keeps the generic card for a slug that is not a slug", async () => {
    open("#/discover/%3Cb%3Ex%3C%2Fb%3E");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Locker",
      }),
    ).toBeTruthy();
  });

  it("keeps the generic card elsewhere", async () => {
    open("#/");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in to Polaris Locker",
      }),
    ).toBeTruthy();
  });
});

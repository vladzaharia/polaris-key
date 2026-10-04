/**
 * `capabilities.modules.releases` gates every use of `/api/releases` (task 7.2): a product that
 * does not run the Release service cannot advertise downloads. The old Downloads page is gone
 * (PORTAL.md §3.3: `#/downloads` → the Library); the half that still matters is that the listing
 * is never fetched while the module is off, nor while capabilities are still loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import {
  CAPS_ALL,
  fetchedRequests,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const off = { ...CAPS_ALL, modules: { ...CAPS_ALL.modules, releases: false } };

describe("portal downloads follow modules.releases", () => {
  it("redirects the old #/downloads link to the Library", async () => {
    window.location.hash = "#/downloads";
    mockFetch(signedIn([], {}, off));
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/");
  });

  it("never fetches the release listing when releases are disabled", async () => {
    mockFetch(signedIn([license({ product: "nightfall" })], {}, off));
    renderPortal();
    expect(await screen.findAllByText("Nightfall")).not.toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchedRequests().some((r) => r.includes("/api/releases"))).toBe(
      false,
    );
  });
});

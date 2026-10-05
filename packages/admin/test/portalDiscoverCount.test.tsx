import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import {
  libraryFor,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";
import { discoverCountFrom, withoutHeld } from "../src/portal/model/owned.js";

/**
 * Discover never offers or counts what the library already holds (G24). The Worker is the
 * source (`GET /api/library`'s `discoverCount`, `GET /api/discover`); the portal guards too.
 */

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

const nightfall = license({ product: "nightfall" });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("withoutHeld", () => {
  const offer = (product: string) => ({ product, name: product });

  it("drops an offer whose product the library holds and keeps the rest, in order", () => {
    expect(
      withoutHeld(
        [offer("mossgarden"), offer("nightfall"), offer("tidewater")],
        [{ product: "nightfall" }],
      ).map((o) => o.product),
    ).toEqual(["mossgarden", "tidewater"]);
  });

  it("keeps every offer while the library is unknown or empty", () => {
    const offers = [offer("mossgarden")];
    expect(withoutHeld(offers, undefined)).toEqual(offers);
    expect(withoutHeld(offers, [])).toEqual(offers);
  });

  it("answers nothing when every offer is held", () => {
    expect(
      withoutHeld([offer("nightfall")], [{ product: "nightfall" }]),
    ).toEqual([]);
  });
});

describe("discoverCountFrom", () => {
  it("takes a whole, non-negative count, 0 included", () => {
    expect(discoverCountFrom(0)).toBe(0);
    expect(discoverCountFrom(3)).toBe(3);
  });

  it("answers null (Discover out of the nav) for anything else", () => {
    for (const v of [undefined, null, -1, 1.5, Number.NaN, "2"])
      expect(discoverCountFrom(v)).toBeNull();
  });
});

describe("the nav with nothing to discover", () => {
  it("count 0: Discover stays in the nav with no count pill and no phone-bar dot", async () => {
    mockFetch(
      signedIn([nightfall], { "/api/library": libraryFor([nightfall], 0) }),
    );
    renderPortal();
    await screen.findByRole("article", { name: "Nightfall" });
    const main = screen.getByRole("navigation", { name: "Main" });
    const link = await within(main).findByRole("link", { name: /Discover/ });
    expect(link.textContent).toBe("Discover");
    expect(link.querySelector("span")).toBeNull();
    const phone = screen.getByRole("navigation", { name: "Phone" });
    const phoneLink = within(phone).getByRole("link", { name: /Discover/ });
    expect(phoneLink.textContent).toBe("Discover");
    expect(phoneLink.querySelector(".rounded-full")).toBeNull();
    expect(screen.queryByText(/in Discover/)).toBeNull();
  });

  it("count 1: one pill and one dot", async () => {
    mockFetch(
      signedIn([nightfall], { "/api/library": libraryFor([nightfall], 1) }),
    );
    renderPortal();
    const main = await screen.findByRole("navigation", { name: "Main" });
    const link = await within(main).findByRole("link", { name: /Discover/ });
    expect(link.textContent).toBe("Discover1");
    const phone = screen.getByRole("navigation", { name: "Phone" });
    expect(
      within(phone)
        .getByRole("link", { name: /^Discover\W+1 offer$/ })
        .querySelector(".rounded-full"),
    ).not.toBeNull();
  });
});

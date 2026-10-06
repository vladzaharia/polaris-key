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
import type * as DiscoverModel from "../src/portal/model/discover.js";

/*
 * The shell's count rendering is tested as it will be once the Discover page lists offers
 * (PX-16): `navDiscoverCount` answers as if `DISCOVER_LISTS_OFFERS` were true. Its own gate, and
 * the nav on `main` today (no Discover while the page cannot show the offers), are tested below
 * through `vi.importActual` and in `e2e/portal.e2e.test.ts`.
 */
vi.mock("../src/portal/model/discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DiscoverModel>();
  return {
    ...actual,
    DISCOVER_LISTS_OFFERS: true,
    navDiscoverCount: (raw: unknown) => actual.navDiscoverCount(raw, true),
  };
});

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

describe("navDiscoverCount (P6: count only what the page can show)", () => {
  it("lists offers since PX-16, so the Worker's count passes through by default", async () => {
    const actual = await vi.importActual<typeof DiscoverModel>(
      "../src/portal/model/discover.js",
    );
    expect(actual.DISCOVER_LISTS_OFFERS).toBe(true);
    expect(actual.navDiscoverCount(4)).toBe(4);
    expect(actual.navDiscoverCount(undefined)).toBeNull();
  });

  it("answers null while a page cannot list offers, whatever the Worker counts", async () => {
    const actual = await vi.importActual<typeof DiscoverModel>(
      "../src/portal/model/discover.js",
    );
    for (const v of [0, 1, 4, undefined])
      expect(actual.navDiscoverCount(v, false)).toBeNull();
  });

  it("passes the Worker's count through once the page lists offers", async () => {
    const actual = await vi.importActual<typeof DiscoverModel>(
      "../src/portal/model/discover.js",
    );
    expect(actual.navDiscoverCount(4, true)).toBe(4);
    expect(actual.navDiscoverCount(0, true)).toBe(0);
    expect(actual.navDiscoverCount(-1, true)).toBeNull();
    expect(actual.navDiscoverCount(undefined, true)).toBeNull();
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

  it("count 4: the nav, the phone bar and the library say 4", async () => {
    mockFetch(
      signedIn([nightfall], { "/api/library": libraryFor([nightfall], 4) }),
    );
    renderPortal();
    const main = await screen.findByRole("navigation", { name: "Main" });
    const link = await within(main).findByRole("link", { name: /Discover/ });
    expect(link.getAttribute("href")).toBe("#/discover");
    expect(link.textContent).toBe("Discover4");
    const phone = screen.getByRole("navigation", { name: "Phone" });
    expect(
      within(phone).getByRole("link", { name: /^Discover\W+4 offers$/ }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("link", {
        name: "4 more you can add in Discover",
      }),
    ).toBeTruthy();
  });
});

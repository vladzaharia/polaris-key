import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalDiscoverOffer,
  PortalLicenseSummary,
} from "../src/portal/api.js";
import {
  offerPlatforms,
  reasonCopy,
  termsLine,
} from "../src/portal/model/discover.js";
import {
  axeViolations,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/#/discover");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function offer(
  over: Partial<PortalDiscoverOffer> & { product: string; name: string },
): PortalDiscoverOffer {
  return {
    developerName: null,
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    platforms: [],
    offer: {
      tier: null,
      tierLabel: null,
      deviceLimit: 0,
      expiresAt: null,
      expiryDays: null,
    },
    reason: "free_with_account",
    ...over,
  };
}

const QUILL = offer({
  product: "quill",
  name: "Quill",
  developerName: "Inkwell Labs",
  platforms: ["web", "macos", "ios"],
  offer: {
    tier: "personal",
    tierLabel: "Personal",
    deviceLimit: 0,
    expiresAt: null,
    expiryDays: null,
  },
});
const MOSSGARDEN = offer({
  product: "mossgarden",
  name: "Mossgarden",
  developerName: "Little Fern",
  platforms: ["macos", "windows"],
  offer: {
    tier: "lifetime",
    tierLabel: "Lifetime",
    deviceLimit: 5,
    expiresAt: null,
    expiryDays: null,
  },
});
const LUMEN = offer({
  product: "lumen-raw",
  name: "Lumen RAW",
  developerName: "Aperture Seven",
  offer: {
    tier: "beta",
    tierLabel: "Beta",
    deviceLimit: 2,
    expiresAt: NOW_S + 90 * 86_400,
    expiryDays: 90,
  },
  reason: "group:aperture-seven-customers",
});
const PIXEL = offer({
  product: "pixel-forge",
  name: "Pixel Forge SDK",
  developerName: "Anvil Labs",
  reason: "email_domain:fennick.studio",
});

const MOSS_LICENSE: PortalLicenseSummary = license({
  product: "mossgarden",
  productName: "Mossgarden",
  tier: "lifetime",
  identityProvider: "oidc",
  deviceCount: 0,
});

/**
 * A Worker with Discover: `GET /api/discover` lists `offers` minus what the account holds, and
 * the claim mints once (idempotent), moving the product into the library.
 */
function discoverWorker(
  offers: PortalDiscoverOffer[],
  opts: {
    held?: PortalLicenseSummary[];
    claim?: (slug: string) => { status: number; body?: unknown } | null;
  } = {},
) {
  let held = [...(opts.held ?? [])];
  const open = () =>
    offers.filter((o) => !held.some((l) => l.product === o.product));
  return signedIn(held, {
    "/api/licenses": () => ({ licenses: held }),
    "/api/library": () => libraryFor(held, open().length),
    "/api/discover": () => ({ offers: open() }),
    "POST /api/discover/mossgarden/claim": () => {
      const refused = opts.claim?.("mossgarden");
      if (refused) return refused;
      const added = !held.some((l) => l.product === "mossgarden");
      if (added) held = [MOSS_LICENSE, ...held];
      return {
        added,
        product: "mossgarden",
        license: {
          id: MOSS_LICENSE.id,
          tier: "lifetime",
          tierLabel: "Lifetime",
          status: "active",
          usable: true,
          expiresAt: null,
          deviceLimit: 5,
        },
      };
    },
    "POST /api/discover/lumen-raw/claim": () =>
      opts.claim?.("lumen-raw") ?? {
        status: 409,
        body: {
          error: "not_eligible",
          message: "this product is no longer offered to your account",
        },
      },
  });
}

async function discoverPage(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Discover" });
}

const tile = (name: string) => screen.findByRole("article", { name });

describe("Discover (PX-16)", () => {
  it("lists every offer with its terms and the always-visible reason", async () => {
    mockFetch(discoverWorker([QUILL, MOSSGARDEN, LUMEN, PIXEL]));
    renderPortal();
    await discoverPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const moss = await tile("Mossgarden");
    expect(within(moss).getByText("Little Fern")).toBeTruthy();
    expect(within(moss).getByText("Lifetime · 5 devices")).toBeTruthy();
    expect(
      within(moss).getByText("Free with a Polaris Key account"),
    ).toBeTruthy();
    expect(
      within(moss).getByRole("img", { name: "Plays on Windows, macOS" }),
    ).toBeTruthy();
    const lumen = await tile("Lumen RAW");
    expect(within(lumen).getByText("Beta · 90 days · 2 devices")).toBeTruthy();
    expect(
      within(lumen).getByText("For members of aperture-seven-customers"),
    ).toBeTruthy();
    // A reason this page doesn't know yet still says something true.
    expect(
      within(await tile("Pixel Forge SDK")).getByText(
        "Offered to your account by its developer",
      ),
    ).toBeTruthy();
    expect(
      within(await tile("Quill")).getByText("Personal · Lifetime"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only products you can add for free appear here/),
    ).toBeTruthy();
    // In name order, every tile with its own Add.
    expect(
      screen
        .getAllByRole("article")
        .map((a) => a.getAttribute("aria-labelledby")),
    ).toEqual([
      "offer-lumen-raw",
      "offer-mossgarden",
      "offer-pixel-forge",
      "offer-quill",
    ]);
    expect(
      screen.getAllByRole("button", { name: /^Add to library/ }),
    ).toHaveLength(4);
    // Discover is in the nav with its count.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav).getByRole("link", { name: /Discover/ }).textContent,
    ).toBe("Discover4");
    expect(await axeViolations()).toEqual([]);
  });

  it("Add mints once on a double click, then shows the just-added state", async () => {
    mockFetch(discoverWorker([QUILL, MOSSGARDEN]));
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    // Two clicks in the same tick, before React can re-render the button as busy.
    const button = within(moss).getByRole("button", {
      name: "Add to library: Mossgarden",
    });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    const open = await within(moss).findByRole("link", {
      name: "Open Mossgarden",
    });
    expect(open.getAttribute("href")).toBe("#/p/mossgarden");
    expect(
      fetchedRequests().filter((r) => r.startsWith("POST /api/discover/")),
    ).toEqual(["POST /api/discover/mossgarden/claim"]);
    expect(within(moss).getByText("In your library")).toBeTruthy();
    expect(moss.getAttribute("data-state")).toBe("added");
    expect(
      within(moss).queryByRole("button", { name: /Add to library/ }),
    ).toBeNull();
    // Focus moves from the vanished button to Open; the URL keeps the state for a reload.
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(window.location.hash).toBe("#/discover?added=mossgarden");
    expect(
      await screen.findByText("Mossgarden is in your library"),
    ).toBeTruthy();
    // The counts move: Library 1, Discover 1 (the tile stays, added, after the refetch).
    const nav = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: /Discover/ }).textContent,
      ).toBe("Discover1"),
    );
    expect(within(nav).getByRole("link", { name: /Library/ }).textContent).toBe(
      "Library1",
    );
    expect(await tile("Mossgarden")).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps the just-added state after a reload through ?added=", async () => {
    window.history.replaceState(null, "", "/#/discover?added=mossgarden");
    mockFetch(discoverWorker([QUILL, MOSSGARDEN], { held: [MOSS_LICENSE] }));
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    expect(moss.getAttribute("data-state")).toBe("added");
    expect(within(moss).getByText("In your library")).toBeTruthy();
    expect(within(moss).getByText("Lifetime")).toBeTruthy();
    expect(
      within(moss).getByRole("link", { name: "Open Mossgarden" }),
    ).toBeTruthy();
    expect(
      within(await tile("Quill")).getByRole("button", {
        name: "Add to library: Quill",
      }),
    ).toBeTruthy();
  });

  it("ignores ?added= for a product the library doesn't hold", async () => {
    window.history.replaceState(null, "", "/#/discover?added=mossgarden");
    mockFetch(discoverWorker([MOSSGARDEN]));
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    expect(moss.getAttribute("data-state")).toBe("offer");
  });

  it("says inline when the developer stopped the offer, and drops its Add", async () => {
    mockFetch(discoverWorker([LUMEN, MOSSGARDEN]));
    renderPortal();
    await discoverPage();
    const lumen = await tile("Lumen RAW");
    await userEvent.click(
      within(lumen).getByRole("button", { name: "Add to library: Lumen RAW" }),
    );
    expect((await within(lumen).findByRole("alert")).textContent).toBe(
      "Aperture Seven stopped this offer.",
    );
    expect(
      within(lumen).queryByRole("button", { name: /Add to library/ }),
    ).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps Add for a retry when the request didn't go through", async () => {
    mockFetch(
      discoverWorker([MOSSGARDEN], {
        claim: () => ({ status: 429, body: { error: "rate_limited" } }),
      }),
    );
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    await userEvent.click(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    );
    expect((await within(moss).findByRole("alert")).textContent).toBe(
      "Too many tries. Wait a minute, then try again.",
    );
    expect(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    ).toBeTruthy();
  });

  it("empty: the star, one h1 and Back to your library", async () => {
    mockFetch(discoverWorker([]));
    renderPortal();
    await discoverPage();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Nothing to add right now",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen
        .getByRole("link", { name: "Back to your library" })
        .getAttribute("href"),
    ).toBe("#/");
    expect(screen.queryByText(/Only products you can add/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("shows the empty state on a Worker without Discover", async () => {
    mockFetch(signedIn([]));
    renderPortal();
    await discoverPage();
    expect(
      await screen.findByRole("heading", { name: "Nothing to add right now" }),
    ).toBeTruthy();
  });
});

describe("the empty Library's Discover teaser (PX-16, §4.12)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows up to three offers with See all", async () => {
    mockFetch(discoverWorker([QUILL, MOSSGARDEN, LUMEN, PIXEL]));
    renderPortal();
    const ready = await screen.findByRole("region", { name: /Ready to add/ });
    const rows = within(ready).getAllByRole("listitem");
    // The thumbs are the fallback art (no media here): the tint and the product's letter first.
    expect(rows.map((r) => r.textContent)).toEqual([
      "QQuillFree with a Polaris Key account",
      "MMossgardenFree with a Polaris Key account",
      "LLumen RAWFor members of aperture-seven-customers",
    ]);
    for (const link of within(ready).getAllByRole("link"))
      expect(link.getAttribute("href")).toBe("#/discover");
    expect(within(ready).getByRole("link", { name: "See all" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "See 4 in Discover" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("is hidden, and Discover never asked, when there is nothing to add", async () => {
    mockFetch(discoverWorker([]));
    renderPortal();
    await screen.findByRole("heading", {
      name: "Nothing here for mara@fennick.studio yet",
    });
    expect(screen.queryByRole("region", { name: /Ready to add/ })).toBeNull();
    expect(fetchedRequests()).not.toContain("GET /api/discover");
  });
});

describe("Discover's words (model/discover.ts)", () => {
  it("words the terms from the policy, never guessing", () => {
    const base = {
      tier: null,
      tierLabel: null,
      deviceLimit: 0,
      expiresAt: null,
      expiryDays: null,
    };
    expect(termsLine(base)).toBe("Lifetime");
    expect(termsLine({ ...base, tier: "free", deviceLimit: 1 })).toBe(
      "Free · Lifetime · 1 device",
    );
    expect(termsLine({ ...base, tierLabel: "Lifetime", deviceLimit: 5 })).toBe(
      "Lifetime · 5 devices",
    );
    expect(
      termsLine({ ...base, tierLabel: "Beta", expiryDays: 90, deviceLimit: 2 }),
    ).toBe("Beta · 90 days · 2 devices");
  });

  it("words every reason, known or not", () => {
    expect(reasonCopy("free_with_account").text).toBe(
      "Free with a Polaris Key account",
    );
    expect(reasonCopy("group:beta-testers").text).toBe(
      "For members of beta-testers",
    );
    expect(reasonCopy("group:").kind).toBe("other");
    expect(reasonCopy("something_new").text).toBe(
      "Offered to your account by its developer",
    );
  });

  it("orders platforms the site's way and drops unknown ones", () => {
    expect(offerPlatforms(["macos", "windows", "switch", "ipados"])).toEqual([
      "windows",
      "macos",
      "ios",
    ]);
  });
});

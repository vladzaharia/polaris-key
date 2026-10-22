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
  ADDED_PARAM_MAX,
  addedParam,
  offerPlatforms,
  reasonCopy,
  termsLine,
  withAdded,
} from "../src/portal/model/discover.js";
import {
  axeViolations,
  dlFile,
  downloadsView,
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

/**
 * One offer as the Worker sends it since PS-04: its paths (here the one its `reason` names, with
 * the offer's terms), the first path's `reason` and `offer`, and the action.
 */
function offer(
  over: Partial<PortalDiscoverOffer> & { product: string; name: string },
): PortalDiscoverOffer {
  const base = {
    developerName: null,
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    platforms: [],
    shortDescription: null,
    cta: "add" as const,
    stores: [],
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
  const reason = base.reason ?? "";
  const group = reason.startsWith("group:") ? reason.slice(6) : null;
  return {
    ...base,
    paths: over.paths ?? [
      {
        kind:
          reason === "free_with_account"
            ? "auto_issue"
            : group !== null
              ? "group"
              : reason,
        detail: group,
        label: null,
        terms: base.offer,
        action: "add",
        reason,
      },
    ],
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
const QUILL_LICENSE: PortalLicenseSummary = license({
  product: "quill",
  productName: "Quill",
  tier: "personal",
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
    expect(within(moss).getByText("Lifetime")).toBeTruthy();
    expect(within(moss).getByText("5 devices")).toBeTruthy();
    expect(
      within(moss).getByText("Free with a Polaris Locker account"),
    ).toBeTruthy();
    expect(
      within(moss).getByRole("img", { name: "Runs on Windows, macOS" }),
    ).toBeTruthy();
    const lumen = await tile("Lumen RAW");
    expect(within(lumen).getByText("Beta")).toBeTruthy();
    expect(within(lumen).getByText("90 days")).toBeTruthy();
    expect(within(lumen).getByText("2 devices")).toBeTruthy();
    expect(
      within(lumen).getByText("For aperture-seven-customers"),
    ).toBeTruthy();
    // No cover: the letter shows once, on the icon's tile, never also on the art.
    expect(
      [
        ...(await tile("Pixel Forge SDK")).querySelectorAll("[data-art]"),
      ].filter((el) => el.textContent === "P"),
    ).toHaveLength(1);
    // A reason this page doesn't know yet still says something true.
    expect(
      within(await tile("Pixel Forge SDK")).getByText(
        "Offered to your account by its developer",
      ),
    ).toBeTruthy();
    const quill = within(await tile("Quill"));
    expect(quill.getByText("Personal")).toBeTruthy();
    expect(quill.getByText("Lifetime")).toBeTruthy();
    // The mockup has no subtitle and no closing line (portal.discover).
    expect(screen.queryByText("Products you can add for free")).toBeNull();
    expect(
      screen.queryByText("Purchases appear in your library automatically."),
    ).toBeNull();
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
    ).toBe("Discover4 to add");
    expect(await axeViolations()).toEqual([]);
  });

  it("never shows a held product an older answer still offers, and keeps a just-added tile", async () => {
    // A Worker that does not leave held products out (an answer that crossed a licence change).
    let held: PortalLicenseSummary[] = [];
    mockFetch(
      signedIn(held, {
        "/api/licenses": () => ({ licenses: held }),
        "/api/library": () => libraryFor(held, 2),
        "/api/discover": () => ({ offers: [QUILL, MOSSGARDEN] }),
        "POST /api/discover/mossgarden/claim": () => {
          held = [MOSS_LICENSE];
          return {
            added: true,
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
      }),
    );
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    await userEvent.click(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    );
    // Held now, and still in the stale offers: the tile stays, in its just-added state.
    expect(
      await within(moss).findByRole("link", { name: "Open Mossgarden" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchedRequests().filter((r) => r === "GET /api/library").length,
      ).toBeGreaterThan(1),
    );
    expect((await tile("Mossgarden")).getAttribute("data-state")).toBe("added");
  });

  it("an added tile leads with the build for this device, then Go to the product (portal.discover)", async () => {
    mockFetch({
      ...discoverWorker([QUILL, MOSSGARDEN]),
      "/api/products/mossgarden/downloads": downloadsView("mossgarden", [
        dlFile({ artifactId: "m-mac", platform: "macos" }),
      ]),
    });
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    await userEvent.click(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    );
    const go = await within(moss).findByRole("link", {
      name: "Go to Mossgarden",
    });
    expect(go.getAttribute("href")).toBe("#/p/mossgarden");
    expect(
      within(moss).getByRole("button", { name: /Download for macOS/ }),
    ).toBeTruthy();
    expect(
      within(moss).queryByRole("link", { name: "Open Mossgarden" }),
    ).toBeNull();
    // The toast confirms, and says how to sign in.
    expect(await screen.findByText("Added to your library")).toBeTruthy();
    expect(screen.getByText(/Sign in to Mossgarden with /)).toBeTruthy();
  });

  it("drops an offer for a product the library already holds", async () => {
    mockFetch(
      signedIn([MOSS_LICENSE], {
        "/api/licenses": () => ({ licenses: [MOSS_LICENSE] }),
        "/api/library": () => libraryFor([MOSS_LICENSE], 2),
        "/api/discover": () => ({ offers: [QUILL, MOSSGARDEN] }),
      }),
    );
    renderPortal();
    await discoverPage();
    await tile("Quill");
    expect(screen.queryByRole("article", { name: "Mossgarden" })).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
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
    expect(await screen.findByText("Added to your library")).toBeTruthy();
    // The counts move: Library 1, Discover 1 (the tile stays, added, after the refetch).
    const nav = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: /Discover/ }).textContent,
      ).toBe("Discover1 to add"),
    );
    expect(within(nav).getByRole("link", { name: /Library/ }).textContent).toBe(
      "Library1",
    );
    expect(await tile("Mossgarden")).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps the same tile through an Add, so its plate pops in (Discover's refetch drops the offer before the Add resolves)", async () => {
    // The library answers after the claim late: Discover's refetch lands first and the Worker no
    // longer lists the product, while the Add (which waits for the library) is still running.
    const worker = discoverWorker([QUILL, MOSSGARDEN]);
    const claim = worker[
      "POST /api/discover/mossgarden/claim"
    ] as () => unknown;
    const library = worker["/api/library"] as () => unknown;
    let claimed = false;
    mockFetch({
      ...worker,
      "POST /api/discover/mossgarden/claim": () => {
        claimed = true;
        return claim();
      },
      "/api/library": async () => {
        if (claimed) await new Promise((r) => setTimeout(r, 150));
        return library();
      },
    });
    renderPortal();
    await discoverPage();
    const moss = await tile("Mossgarden");
    await userEvent.click(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    );
    await within(moss).findByRole("link", { name: "Open Mossgarden" });
    // Never unmounted on the way: the same element, added while on screen, so the plate pops.
    expect(moss.isConnected).toBe(true);
    expect(within(moss).getByText("In your library").className).toContain(
      "pk-pop-in",
    );
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

  it("keeps an earlier just-added tile after a reload when another product is added", async () => {
    window.history.replaceState(null, "", "/#/discover?added=quill");
    mockFetch(discoverWorker([QUILL, MOSSGARDEN], { held: [QUILL_LICENSE] }));
    renderPortal();
    await discoverPage();
    expect((await tile("Quill")).getAttribute("data-state")).toBe("added");
    const moss = await tile("Mossgarden");
    fireEvent.click(
      within(moss).getByRole("button", { name: "Add to library: Mossgarden" }),
    );
    await within(moss).findByRole("link", { name: "Open Mossgarden" });
    // Both stay named for the next reload, and Quill's tile keeps its state now.
    expect(window.location.hash).toBe(
      "#/discover?added=quill&added=mossgarden",
    );
    const quill = await tile("Quill");
    expect(quill.getAttribute("data-state")).toBe("added");
    expect(within(quill).getByText("In your library")).toBeTruthy();
    expect(moss.getAttribute("data-state")).toBe("added");
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
      "Aperture Seven no longer gives Lumen RAW to your account.",
    );
    // The error takes the reason's place, so the tile keeps its height and the row does not
    // move (B-080).
    expect(
      within(lumen).queryByText("For aperture-seven-customers"),
    ).toBeNull();
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
      "Couldn't add Mossgarden. Wait a moment and try again.",
    );
    // Back on the button, still "Add to library", with the error tied to it and focus returned.
    const retry = within(moss).getByRole("button", {
      name: "Add to library: Mossgarden",
    });
    expect(retry.getAttribute("aria-describedby")).toBe(
      within(moss).getByRole("alert").id,
    );
    await waitFor(() => expect(document.activeElement).toBe(retry));
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

describe("the empty Library's way into Discover (portal-17, §4.12)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("says one thing and offers the two ways in; no offers are listed under it", async () => {
    mockFetch(discoverWorker([QUILL, MOSSGARDEN, LUMEN, PIXEL]));
    renderPortal();
    await screen.findByRole("heading", { name: "Nothing here yet" });
    expect(
      screen.getByRole("link", { name: "See 4 in Discover" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Ready to add/ })).toBeNull();
    expect(fetchedRequests()).not.toContain("GET /api/discover");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("has no Discover link when there is nothing to add", async () => {
    mockFetch(discoverWorker([]));
    renderPortal();
    await screen.findByRole("heading", { name: "Nothing here yet" });
    expect(screen.queryByRole("link", { name: /in Discover/ })).toBeNull();
  });
});

describe("?added= (model/discover.ts)", () => {
  it("names each just-added product once, the most recent last, and only the latest few", () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(addedParam(q(""))).toEqual([]);
    expect(addedParam(q("added=a&added=&added=b&added=a"))).toEqual(["b", "a"]);
    expect(
      addedParam(
        q(`added=a&added=Bad%20Slug&added=${"x".repeat(65)}&added=-x`),
      ),
    ).toEqual(["a"]);
    expect(withAdded(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(withAdded(["a", "b"], "a")).toEqual(["b", "a"]);
    const many = Array.from({ length: ADDED_PARAM_MAX + 3 }, (_, i) => `p${i}`);
    expect(addedParam(q(many.map((p) => `added=${p}`).join("&")))).toEqual(
      many.slice(-ADDED_PARAM_MAX),
    );
    expect(withAdded(many.slice(0, ADDED_PARAM_MAX), "new")).toEqual([
      ...many.slice(1, ADDED_PARAM_MAX),
      "new",
    ]);
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
      "Free with a Polaris Locker account",
    );
    expect(reasonCopy("group:beta-testers").text).toBe("For beta-testers");
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

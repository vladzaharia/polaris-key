/**
 * The Polaris Key storefront in the portal (PS-05; notes/S-21 §6.5): multi-path Discover tiles
 * and their reason copy, the storefront product page `#/discover/:product`, open products in the
 * Library (entries: "Free to use", Get it, Remove from library confirmed inline) and link-only
 * tiles. The Worker answers come from PS-04's API shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalDiscoverOffer,
  PortalDiscoverTerms,
  PortalEntryItem,
  PortalLicenseSummary,
  PortalObtainPath,
} from "../src/portal/api.js";
import {
  moreWaysText,
  pathCopy,
  pathTermsLine,
} from "../src/portal/model/discover.js";
import {
  navigationKind,
  resolveHash,
  type PortalRoute,
} from "../src/portal/router.js";
import {
  axeViolations,
  entryItem,
  fetchedRequests,
  libraryItem,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TERMS: PortalDiscoverTerms = {
  tier: "standard",
  tierLabel: "Standard",
  deviceLimit: 3,
  expiresAt: null,
  expiryDays: null,
};
const TRIAL: PortalDiscoverTerms = {
  tier: "trial",
  tierLabel: "Trial",
  deviceLimit: 1,
  expiresAt: NOW_S + 14 * 86_400,
  expiryDays: 14,
};

function path(over: Partial<PortalObtainPath> & { kind: string }) {
  return {
    detail: null,
    label: null,
    terms: TERMS,
    action: "add" as const,
    reason: over.kind,
    ...over,
  };
}

function offer(
  over: Partial<PortalDiscoverOffer> & { product: string; name: string },
): PortalDiscoverOffer {
  const paths = over.paths ?? [
    path({ kind: "auto_issue", reason: "free_with_account" }),
  ];
  return {
    developerName: null,
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    platforms: [],
    shortDescription: null,
    cta: "add",
    stores: [],
    ...over,
    paths,
    offer: paths[0]?.terms ?? null,
    reason: paths[0]?.reason ?? null,
  };
}

// Lumen RAW: an operator-labelled group, and a trial for everyone with an account.
const LUMEN = offer({
  product: "lumen-raw",
  name: "Lumen RAW",
  developerName: "Aperture Seven",
  paths: [
    path({
      kind: "group",
      detail: "aperture-customers",
      label: "Aperture Seven",
      reason: "group:aperture-customers",
    }),
    path({ kind: "auto_issue", reason: "free_with_account", terms: TRIAL }),
  ],
});
// Driftwood Notes: an open product (nothing to licence).
const DRIFTWOOD = offer({
  product: "driftwood",
  name: "Driftwood Notes",
  developerName: "Tern Studio",
  website: "https://tern.example",
  shortDescription: "A quiet notebook for field recordings",
  platforms: ["macos", "linux"],
  paths: [path({ kind: "open", reason: "open", terms: null })],
});
// Starfall Arena: shown to everyone, nothing to add; its store page instead.
const STARFALL = offer({
  product: "starfall",
  name: "Starfall Arena",
  developerName: "Comet Forge",
  cta: "link",
  paths: [],
  stores: [
    {
      id: "steam:main",
      kind: "steam",
      label: "Steam",
      url: "https://store.example/steam/starfall",
    },
  ],
});

const NIGHTFALL: PortalLicenseSummary = license({
  product: "nightfall",
  productName: "Nightfall",
});

const PAGE = {
  ...LUMEN,
  shortDescription: "RAW development for night skies",
  description: "Develop RAW files.\nStack exposures.",
  screenshots: [
    "/media/lumen-raw/screenshot-0?v=1",
    "https://evil.example/x.png",
  ],
  stores: [
    {
      id: "steam:main",
      kind: "steam",
      label: "Steam",
      url: "https://store.example/steam/lumen",
    },
  ],
  platforms: ["macos", "windows"],
};

/**
 * A Worker with the storefront: `offers` minus what the account holds; the claim creates a
 * licence (identity paths) or an entry (`open`), once; `DELETE /api/library/<p>` removes an entry.
 */
function storefrontWorker(
  offers: PortalDiscoverOffer[],
  opts: {
    held?: PortalLicenseSummary[];
    entries?: PortalEntryItem[];
    pages?: Record<string, unknown>;
    /** Milliseconds `GET /api/library` takes (a slow Worker); 0 answers at once. */
    slowLibrary?: number;
    /** Milliseconds `DELETE /api/library/<p>` takes. */
    slowDelete?: number;
  } = {},
) {
  const later = <T,>(ms: number, value: () => T): T | Promise<T> =>
    ms > 0
      ? new Promise((resolve) => setTimeout(() => resolve(value()), ms))
      : value();
  const held = [...(opts.held ?? [])];
  let entries = [...(opts.entries ?? [])];
  const holds = (slug: string) =>
    held.some((l) => l.product === slug) ||
    entries.some((e) => e.product === slug);
  const open = () => offers.filter((o) => !holds(o.product));
  const routes: Record<string, unknown> = {
    "/api/licenses": () => ({ licenses: held }),
    "/api/library": () =>
      later(opts.slowLibrary ?? 0, () => ({
        products: [...held.map((l) => libraryItem(l)), ...entries],
        discoverCount: open().filter((o) => o.cta === "add").length,
      })),
    "/api/discover": () => ({ offers: open() }),
  };
  for (const o of offers) {
    routes[`GET /api/discover/${o.product}`] = () =>
      holds(o.product)
        ? { status: 404, body: { error: "not_found" } }
        : (opts.pages?.[o.product] ?? o);
    routes[`POST /api/discover/${o.product}/claim`] = (
      init: RequestInit | undefined,
    ) => {
      const asked = init?.body
        ? (JSON.parse(String(init.body)) as { path?: string }).path
        : undefined;
      const chosen = asked ?? o.paths[0]?.kind;
      if (o.cta !== "add" || !o.paths.some((p) => p.kind === chosen))
        return { status: 409, body: { error: "not_eligible" } };
      const added = !holds(o.product);
      if (chosen === "open") {
        if (added)
          entries = [
            ...entries,
            entryItem(o.product, o.name, {
              developerName: o.developerName,
              website: o.website,
            }),
          ];
        return {
          added,
          product: o.product,
          kind: "entry",
          entry: { via: "open", addedAt: NOW_S },
        };
      }
      if (added)
        held.push(
          license({
            product: o.product,
            productName: o.name,
            identityProvider: "oidc",
            keyCount: 0,
            deviceCount: 0,
          }),
        );
      return {
        added,
        product: o.product,
        kind: "license",
        license: {
          id: `lic_${o.product}`,
          tier: "standard",
          tierLabel: "Standard",
          status: "active",
          usable: true,
          expiresAt: null,
          deviceLimit: 3,
        },
      };
    };
  }
  for (const e of opts.entries ?? [])
    routes[`DELETE /api/library/${e.product}`] = () =>
      later(opts.slowDelete ?? 0, () => {
        if (!entries.some((x) => x.product === e.product))
          return { status: 404, body: { error: "not_found" } };
        entries = entries.filter((x) => x.product !== e.product);
        return { ok: true, product: e.product };
      });
  // The entries' product view (PS-04: `kind: "entry"`, no licences).
  for (const e of [
    ...(opts.entries ?? []),
    ...offers.map((o) => entryItem(o.product, o.name)),
  ])
    routes[`GET /api/products/${e.product}`] ??= () =>
      entries.some((x) => x.product === e.product)
        ? {
            ...entries.find((x) => x.product === e.product),
            services: { license: false, distribution: true },
            returnTo: { origins: [], schemes: [] },
            licenses: [],
          }
        : { status: 404, body: { error: "not_found" } };
  return signedIn(held, routes);
}

const tile = (name: string) => screen.findByRole("article", { name });

describe("Discover tiles on the storefront (PS-05)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/#/discover");
  });

  it("words every way to add, says when there are more, and offers store links for a link-only listing", async () => {
    mockFetch(storefrontWorker([LUMEN, DRIFTWOOD, STARFALL]));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Discover" });

    const lumen = await tile("Lumen RAW");
    // The first path's reason, with the operator's group label; the other way is one link away.
    expect(
      within(lumen).getByText("Included with Aperture Seven"),
    ).toBeTruthy();
    expect(
      within(lumen).getByText("Standard · Lifetime · 3 devices"),
    ).toBeTruthy();
    const more = within(lumen).getByRole("link", {
      name: "+1 more way to add Lumen RAW",
    });
    expect(more.getAttribute("href")).toBe("#/discover/lumen-raw");
    // The name opens the storefront page.
    expect(
      within(lumen)
        .getByRole("link", { name: "Lumen RAW" })
        .getAttribute("href"),
    ).toBe("#/discover/lumen-raw");

    const drift = await tile("Driftwood Notes");
    expect(within(drift).getByText("Free to use")).toBeTruthy();
    // No licence terms: the listing's one line says what it is.
    expect(
      within(drift).getByText("A quiet notebook for field recordings"),
    ).toBeTruthy();
    expect(
      within(drift).getByRole("button", {
        name: "Add to library: Driftwood Notes",
      }),
    ).toBeTruthy();

    const star = await tile("Starfall Arena");
    expect(star.getAttribute("data-cta")).toBe("link");
    // No reason line and no Add: "Get it on Steam", in a new tab.
    expect(within(star).queryByText(/Why you can add it/)).toBeNull();
    expect(
      within(star).queryByRole("button", { name: /Add to library/ }),
    ).toBeNull();
    const steam = within(star).getByRole("link", {
      name: "Get it on Steam: Starfall Arena (opens in a new tab)",
    });
    expect(steam.getAttribute("href")).toBe(
      "https://store.example/steam/starfall",
    );
    expect(steam.getAttribute("target")).toBe("_blank");

    // The nav counts what can be added now: the open product too, never the link.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav).getByRole("link", { name: /Discover/ }).textContent,
    ).toBe("Discover2");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("adds an open product from its tile as a library entry, with the counts moving", async () => {
    mockFetch(storefrontWorker([LUMEN, DRIFTWOOD], { held: [NIGHTFALL] }));
    renderPortal();
    const drift = await tile("Driftwood Notes");
    await userEvent.click(
      within(drift).getByRole("button", {
        name: "Add to library: Driftwood Notes",
      }),
    );
    const open = await within(drift).findByRole("link", {
      name: "Open Driftwood Notes",
    });
    expect(open.getAttribute("href")).toBe("#/p/driftwood");
    await waitFor(() => expect(document.activeElement).toBe(open));
    // The claim named no path: the Worker's first is the one.
    expect(
      fetchedRequests().filter((r) => r.startsWith("POST /api/discover/")),
    ).toEqual(["POST /api/discover/driftwood/claim"]);
    const nav = screen.getByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: /Library/ }).textContent,
      ).toBe("Library2"),
    );
    expect(
      within(nav).getByRole("link", { name: /Discover/ }).textContent,
    ).toBe("Discover1");
  });
});

describe("the storefront product page, #/discover/:product (PS-05)", () => {
  it("shows the listing, every way to add it with its terms, and adds by the chosen way", async () => {
    window.history.replaceState(null, "", "/#/discover/lumen-raw");
    mockFetch(
      storefrontWorker([LUMEN, DRIFTWOOD], {
        held: [NIGHTFALL],
        pages: { "lumen-raw": PAGE },
      }),
    );
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Lumen RAW",
    });
    expect(document.title).toBe("Lumen RAW · Polaris Key");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("RAW development for night skies")).toBeTruthy();
    expect(screen.getByText(/Develop RAW files\./)).toBeTruthy();
    // Screenshots from the media host only; another host's image is never shown.
    const shots = within(
      screen.getByRole("region", { name: "Screenshots" }),
    ).getAllByRole("img");
    expect(shots.map((i) => i.getAttribute("src"))).toEqual([
      "/media/lumen-raw/screenshot-0?v=1",
    ]);
    expect(shots[0]!.getAttribute("alt")).toBe("Lumen RAW, screenshot 1 of 1");
    // Every way, with its terms; the first is preselected.
    const ways = screen.getByRole("region", { name: "Ways to add it" });
    const group = within(ways).getByRole("radio", {
      name: /Included with Aperture Seven/,
    }) as HTMLInputElement;
    const trial = within(ways).getByRole("radio", {
      name: /Free trial · 14 days/,
    }) as HTMLInputElement;
    expect(group.checked).toBe(true);
    expect(within(ways).getByText("Trial · 14 days · 1 device")).toBeTruthy();
    // Where else it is.
    expect(
      within(screen.getByRole("region", { name: "Also on" }))
        .getByRole("link", { name: /Get it on Steam/ })
        .getAttribute("href"),
    ).toBe("https://store.example/steam/lumen");
    // The Discover tab stays current.
    expect(
      within(screen.getByRole("navigation", { name: "Main" }))
        .getByRole("link", { name: /Discover/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(trial);
    await userEvent.click(
      screen.getByRole("button", { name: "Add to library" }),
    );
    // The claim names the chosen path; the page is replaced by the product's library page.
    await waitFor(() => expect(window.location.hash).toBe("#/p/lumen-raw"));
    const claims = vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).endsWith("/claim"));
    expect(JSON.parse(String(claims[0]![1]!.body))).toEqual({
      path: "auto_issue",
    });
    const product = await screen.findByRole("heading", {
      level: 1,
      name: "Lumen RAW",
    });
    expect(product).not.toBe(h1);
    await waitFor(() => expect(document.activeElement).toBe(product));
    expect(
      await screen.findByText("Lumen RAW is in your library"),
    ).toBeTruthy();
  });

  for (const [what, slug, name] of [
    ["a licence path", "lumen-raw", "Lumen RAW"],
    ["an open product", "driftwood", "Driftwood Notes"],
  ] as const)
    it(`after Add (${what}), the library page never says the product is missing, however slow the library`, async () => {
      window.history.replaceState(null, "", `/#/discover/${slug}`);
      mockFetch(
        storefrontWorker([LUMEN, DRIFTWOOD], {
          held: [NIGHTFALL],
          slowLibrary: 150,
        }),
      );
      const seen: string[] = [];
      const watch = new MutationObserver(() => {
        if (document.body.textContent?.includes("isn't in your library"))
          seen.push(window.location.hash);
      });
      watch.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      try {
        renderPortal();
        await screen.findByRole("heading", { level: 1, name });
        await userEvent.click(
          screen.getByRole("button", { name: "Add to library" }),
        );
        await waitFor(() => expect(window.location.hash).toBe(`#/p/${slug}`));
        const h1 = await screen.findByRole("heading", { level: 1, name });
        await waitFor(() => expect(document.activeElement).toBe(h1));
      } finally {
        watch.disconnect();
      }
      expect(seen).toEqual([]);
    });

  it("opened from Discover, the tile's offer is the page until it answers", async () => {
    window.history.replaceState(null, "", "/#/discover");
    let answer: (v: unknown) => void = () => undefined;
    mockFetch({
      ...storefrontWorker([LUMEN, DRIFTWOOD]),
      "GET /api/discover/lumen-raw": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    renderPortal();
    const tile = await screen.findByRole("article", { name: "Lumen RAW" });
    await userEvent.click(
      within(tile).getByRole("link", { name: "Lumen RAW", exact: true } as {
        name: string;
      }),
    );
    // The header, the reason and Add, before the page has answered.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Lumen RAW" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Included with Aperture Seven/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Screenshots" })).toBeNull();
    answer(PAGE);
    expect(
      await screen.findByRole("region", { name: "Screenshots" }),
    ).toBeTruthy();
  });

  it("answers unknown, ineligible and withdrawn products with one not-found state", async () => {
    mockFetch(storefrontWorker([LUMEN]));
    const texts: string[] = [];
    for (const slug of ["nope", "private-thing"]) {
      window.history.replaceState(null, "", `/#/discover/${slug}`);
      renderPortal();
      const h1 = await screen.findByRole("heading", {
        level: 1,
        name: "There's nothing to add here",
      });
      expect(document.title).toBe("Not available · Polaris Key");
      texts.push(h1.closest("section")!.textContent ?? "");
      expect(
        screen
          .getByRole("link", { name: "Browse Discover" })
          .getAttribute("href"),
      ).toBe("#/discover");
      expect(await axeViolations()).toEqual([]);
      cleanup();
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it("says inline when the offer ended, and drops Add", async () => {
    window.history.replaceState(null, "", "/#/discover/lumen-raw");
    mockFetch({
      ...storefrontWorker([LUMEN]),
      "POST /api/discover/lumen-raw/claim": {
        status: 409,
        body: { error: "not_eligible" },
      },
    });
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add to library" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Aperture Seven stopped this offer.",
    );
    expect(screen.queryByRole("button", { name: "Add to library" })).toBeNull();
    expect(window.location.hash).toBe("#/discover/lumen-raw");
  });

  it("sends a product the library holds to its library page", async () => {
    window.history.replaceState(null, "", "/#/discover/nightfall");
    mockFetch(storefrontWorker([LUMEN], { held: [NIGHTFALL] }));
    renderPortal();
    await waitFor(() => expect(window.location.hash).toBe("#/p/nightfall"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Nightfall" }),
    ).toBeTruthy();
  });

  it("a link-only listing with nowhere to get it says only who shows it", async () => {
    window.history.replaceState(null, "", "/#/discover/starfall");
    mockFetch(storefrontWorker([{ ...STARFALL, stores: [] }]));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Starfall Arena" });
    expect(
      screen.getByText(
        "Comet Forge shows it to everyone with a Polaris Key account.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/above\./)).toBeNull();
  });

  it("a link-only listing: its store pages are the action, no Add", async () => {
    window.history.replaceState(null, "", "/#/discover/starfall");
    mockFetch(storefrontWorker([STARFALL]));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Starfall Arena" });
    expect(screen.queryByRole("button", { name: "Add to library" })).toBeNull();
    expect(screen.queryByRole("region", { name: /Ways to add/ })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /Get it on Steam: Starfall Arena/ })
        .getAttribute("href"),
    ).toBe("https://store.example/steam/starfall");
    expect(await axeViolations()).toEqual([]);
  });
});

describe("open products in the Library (PS-05)", () => {
  const DRIFT_ENTRY = entryItem("driftwood", "Driftwood Notes", {
    developerName: "Tern Studio",
    website: "https://tern.example",
  });

  it("an entry's tile: Free to use, no seats, and Remove from library confirmed inline", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch(
      storefrontWorker([DRIFTWOOD], {
        held: [NIGHTFALL],
        entries: [DRIFT_ENTRY],
      }),
    );
    renderPortal();
    const drift = await tile("Driftwood Notes");
    expect(within(drift).getByText("Free to use")).toBeTruthy();
    expect(within(drift).queryByText(/device/)).toBeNull();
    // Get it: the developer's site while no downloads are served for the entry.
    expect(
      within(drift)
        .getByRole("link", { name: /Get it from Tern Studio/ })
        .getAttribute("href"),
    ).toBe("https://tern.example");

    const menu = within(drift).getByRole("button", {
      name: "More for Driftwood Notes",
    });
    await userEvent.click(menu);
    expect(
      screen.queryByRole("menuitem", { name: /Manage devices/ }),
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    const confirm = await within(drift).findByRole("group", {
      name: "Remove Driftwood Notes from your library?",
    });
    const keep = within(confirm).getByRole("button", { name: "Keep it" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(await axeViolations()).toEqual([]);

    // Keep it: the confirmation goes and focus is back on the menu button.
    await userEvent.click(keep);
    expect(within(drift).queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(menu);

    // Escape cancels too.
    await userEvent.click(menu);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    await within(drift).findByRole("group");
    await userEvent.keyboard("{Escape}");
    expect(within(drift).queryByRole("group")).toBeNull();

    // Remove: the entry goes, focus lands on the page heading before the tile leaves.
    await userEvent.click(menu);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    await userEvent.click(
      within(await within(drift).findByRole("group")).getByRole("button", {
        name: "Remove from library",
      }),
    );
    expect(
      await screen.findByText("Driftwood Notes was removed from your library"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Driftwood Notes" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Your library" }),
    );
    expect(fetchedRequests()).toContain("DELETE /api/library/driftwood");
  });

  it("Remove chosen again puts focus back on Keep it; while it removes, focus waits on the confirmation", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch(
      storefrontWorker([DRIFTWOOD], {
        held: [NIGHTFALL],
        entries: [DRIFT_ENTRY],
        slowDelete: 150,
      }),
    );
    renderPortal();
    const drift = await tile("Driftwood Notes");
    const menu = within(drift).getByRole("button", {
      name: "More for Driftwood Notes",
    });
    const ask = async (): Promise<void> => {
      await userEvent.click(menu);
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Remove from library" }),
      );
    };
    await ask();
    const confirm = await within(drift).findByRole("group");
    const keep = within(confirm).getByRole("button", { name: "Keep it" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    // Away from it, then Remove again: Keep it has focus once more.
    menu.focus();
    await ask();
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove from library" }),
    );
    // Both buttons are disabled while the request runs; focus is on the confirmation.
    expect(document.activeElement).toBe(confirm);
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Driftwood Notes" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Your library" }),
    );
  });

  it("an entry's product page: no licence card or devices, Get it, Help, and Remove back to the Library", async () => {
    window.history.replaceState(null, "", "/#/p/driftwood");
    mockFetch(
      storefrontWorker([DRIFTWOOD], {
        held: [NIGHTFALL],
        entries: [DRIFT_ENTRY],
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Driftwood Notes" });
    expect(screen.getAllByText("Free to use").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: /^License/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Devices/ })).toBeNull();
    const get = await screen.findByRole("region", {
      name: "Get Driftwood Notes",
    });
    expect(
      within(get).getByRole("link", { name: /Get it from Tern Studio/ }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Need help?" })).toBeTruthy();
    expect(await axeViolations()).toEqual([]);

    const menu = screen.getByRole("button", {
      name: "More for Driftwood Notes",
    });
    await userEvent.click(menu);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from library" }),
    );
    const confirm = await screen.findByRole("group", {
      name: "Remove Driftwood Notes from your library?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove from library" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
  });

  it("the free-device flow has nothing to free for an entry: it goes to the product page", async () => {
    window.history.replaceState(null, "", "/#/p/driftwood/free-device");
    mockFetch(
      storefrontWorker([DRIFTWOOD], {
        held: [NIGHTFALL],
        entries: [DRIFT_ENTRY],
      }),
    );
    renderPortal();
    await waitFor(() => expect(window.location.hash).toBe("#/p/driftwood"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Driftwood Notes" }),
    ).toBeTruthy();
  });
});

describe("the storefront's words (model/discover.ts, notes/S-21 §6.5)", () => {
  it("words each path kind", () => {
    const p = (over: Partial<PortalObtainPath> & { kind: string }) =>
      pathCopy(path(over)).text;
    expect(p({ kind: "auto_issue", reason: "free_with_account" })).toBe(
      "Free with a Polaris Key account",
    );
    expect(p({ kind: "auto_issue", terms: TRIAL })).toBe(
      "Free trial · 14 days",
    );
    expect(p({ kind: "auto_issue", terms: { ...TRIAL, expiryDays: 1 } })).toBe(
      "Free trial · 1 day",
    );
    expect(
      p({ kind: "group", detail: "members", label: "Aperture Seven" }),
    ).toBe("Included with Aperture Seven");
    expect(p({ kind: "group", detail: "members" })).toBe(
      "For members of members",
    );
    expect(p({ kind: "product_idp", detail: "Aperture ID" })).toBe(
      "Included with your Aperture ID account",
    );
    expect(p({ kind: "email_domain", detail: "fennick.studio" })).toBe(
      "For everyone with a fennick.studio email",
    );
    expect(p({ kind: "store_owned", detail: "steam" })).toBe(
      "You own it on Steam",
    );
    expect(p({ kind: "open", terms: null })).toBe("Free to use");
    expect(p({ kind: "something_new", reason: "something_new" })).toBe(
      "Offered to your account by its developer",
    );
    expect(pathTermsLine(path({ kind: "open", terms: null }))).toBe(
      "No license needed",
    );
    expect(moreWaysText(LUMEN)).toBe("+1 more way");
    expect(moreWaysText(DRIFTWOOD)).toBeNull();
  });
});

describe("the storefront route (router.ts)", () => {
  it("#/discover/:product is the storefront page; a longer path is the page itself", () => {
    expect(resolveHash("#/discover/lumen-raw")).toEqual({
      route: { kind: "storefront", product: "lumen-raw" },
    });
    expect(resolveHash("#/discover/lumen-raw/extra")).toEqual({
      route: { kind: "storefront", product: "lumen-raw" },
      redirect: "#/discover/lumen-raw",
    });
  });

  it("Discover opens a storefront page forward, and Back returns", () => {
    const discover: PortalRoute = {
      kind: "discover",
      params: new URLSearchParams(),
    };
    const page: PortalRoute = { kind: "storefront", product: "x" };
    const product: PortalRoute = {
      kind: "product",
      product: "x",
      section: null,
      params: new URLSearchParams(),
    };
    expect(navigationKind(discover, page)).toBe("forward");
    expect(navigationKind(page, discover)).toBe("back");
    expect(navigationKind(page, product)).toBe("route");
  });
});

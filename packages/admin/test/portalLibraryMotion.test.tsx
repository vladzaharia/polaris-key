import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import type { PortalDiscoverOffer } from "../src/portal/api.js";
import { DiscoverTile } from "../src/portal/components/DiscoverTile.js";
import { ProductArt } from "../src/portal/components/ProductArt.js";
import { useFirstLoadStagger } from "../src/portal/stagger.js";
import {
  DAY,
  fetchedRequests,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Library and Discover motion (notes/S-23 §6.1; MO-07), as far as jsdom can see it: which classes
 * and attributes the patterns hang on, when the first-load stagger is on and when it is not, and
 * that the Grid/List toggle goes through one `list` View Transition (and through none under
 * reduced motion). The animations themselves run in e2e/libraryMotion.e2e.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));

const NAMES = [
  "Nightfall",
  "Tidewater Studio",
  "Mossgarden",
  "Orbit Survey",
  "Drift Kart",
  "Hollow Pines",
  "Glyphsmith",
  "Lumen RAW",
  "Quill",
  "Pixel Forge SDK",
  "Saltwind",
  "Ember Tactics",
];
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const TWELVE = NAMES.map((n, i) =>
  license({ product: slug(n), productName: n, activatedAt: NOW_S - i * DAY }),
);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.vt;
});

/** The `ul` (grid) or `tbody` (list) whose children are the products. */
function items(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /All products/ });
  const section = heading.closest("section")!;
  return (section.querySelector("ul") ??
    section.querySelector("tbody")) as HTMLElement;
}

async function twelve(): Promise<void> {
  await screen.findByRole("searchbox", { name: "Search 12 products" });
}

// ── The first-load stagger ─────────────────────────────────────────────────────────────────────

function StaggerProbe({
  firstLoad,
  view,
  rows = 3,
}: {
  firstLoad: boolean;
  view?: string;
  rows?: number;
}): React.ReactElement {
  const s = useFirstLoadStagger(firstLoad, view);
  return (
    <ul data-testid="list" ref={s.ref} className={s.className}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <span>row {i}</span>
        </li>
      ))}
    </ul>
  );
}

describe("useFirstLoadStagger", () => {
  it("staggers only a first load", () => {
    render(<StaggerProbe firstLoad />);
    expect(screen.getByTestId("list").className).toBe("pk-stagger");
    cleanup();
    render(<StaggerProbe firstLoad={false} />);
    expect(screen.getByTestId("list").className).toBe("");
  });

  it("stops for good once the view changes (search, filter, sort, grid ↔ list)", () => {
    const { rerender } = render(<StaggerProbe firstLoad view="grid" />);
    expect(screen.getByTestId("list").className).toBe("pk-stagger");
    rerender(<StaggerProbe firstLoad view="list" />);
    expect(screen.getByTestId("list").className).toBe("");
    rerender(<StaggerProbe firstLoad view="grid" />);
    expect(screen.getByTestId("list").className).toBe("");
  });

  it("comes off when the items' own animations finish, whatever loops inside them", async () => {
    let finish!: () => void;
    const staggerDone = new Promise<void>((r) => (finish = r));
    const forever = new Promise<void>(() => undefined);
    const getAnimations = vi.fn(function (this: Element) {
      const item = this.firstElementChild!;
      return [
        // The item's own pk-enter: the stagger.
        { effect: { target: item }, finished: staggerDone },
        // A spinner inside an item loops for ever and must not hold the class.
        { effect: { target: item.firstElementChild }, finished: forever },
      ];
    });
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    try {
      render(<StaggerProbe firstLoad />);
      const list = screen.getByTestId("list");
      expect(list.className).toBe("pk-stagger");
      expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
      await act(async () => {
        finish();
        await staggerDone;
      });
      await waitFor(() => expect(list.className).toBe(""));
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("comes off at once when nothing animates (reduced motion)", async () => {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    try {
      render(<StaggerProbe firstLoad />);
      await waitFor(() =>
        expect(screen.getByTestId("list").className).toBe(""),
      );
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});

describe("the Library staggers on its first load only", () => {
  it("puts the stagger on the grid when the library arrives, and a filter ends it", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    expect(items().tagName).toBe("UL");
    expect(items().className).toMatch(/\bpk-stagger\b/);
    await userEvent.type(screen.getByRole("searchbox"), "orbit");
    expect(await screen.findByText(/Showing 1 of 12 ·/)).toBeTruthy();
    expect(items().className).not.toMatch(/\bpk-stagger\b/);
    // Undoing the filter brings the other tiles back without a stagger.
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(items().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("keeps every tile through a refetch (keys kept: nothing remounts, nothing restaggers)", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    const before = [...items().children];
    const fetches = () =>
      fetchedRequests().filter((r) => r === "GET /api/library").length;
    const n = fetches();
    // Stale after 30 s; a focus change refetches.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(fetches()).toBeGreaterThan(n));
    await waitFor(() =>
      expect(screen.getAllByRole("article")).toHaveLength(12),
    );
    const after = [...items().children];
    expect(after).toHaveLength(before.length);
    after.forEach((li, i) => expect(li).toBe(before[i]));
    focusManager.setFocused(undefined);
  });

  it("does not stagger a return to the page (the library is cached)", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    expect(items().className).toMatch(/\bpk-stagger\b/);
    act(() => {
      window.location.hash = "#/account";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("heading", { level: 1, name: "Account" });
    act(() => {
      window.location.hash = "#/";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await twelve();
    expect(items().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("staggers the list's rows when the list is what loads", async () => {
    window.history.replaceState(null, "", "/#/?view=list");
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    expect(items().tagName).toBe("TBODY");
    expect(items().className).toMatch(/\bpk-stagger\b/);
    expect(items().children).toHaveLength(12);
  });

  it("staggers the 2–7 grid too", async () => {
    mockFetch(signedIn(TWELVE.slice(0, 3)));
    renderPortal();
    await screen.findAllByRole("article");
    expect(items().className).toMatch(/\bpk-stagger\b/);
  });
});

// ── Grid ↔ list ─────────────────────────────────────────────────────────────────────────────────

interface Started {
  vt: string | undefined;
  scoped: boolean;
  /** The products' view was still the old one when the transition captured it. */
  oldView: string | undefined;
  newView: string | undefined;
}

/** A stand-in for `document.startViewTransition` that records what the layer set up. */
function stubViewTransitions(): Started[] {
  const started: Started[] = [];
  const start = vi.fn((update: () => void) => {
    const run: Started = {
      vt: document.documentElement.dataset.vt,
      scoped: !!document.querySelector("section.pk-vt-list"),
      oldView: items().tagName,
      newView: undefined,
    };
    update();
    run.newView = items().tagName;
    started.push(run);
    const done = Promise.resolve();
    return {
      updateCallbackDone: done,
      finished: done,
      ready: done,
      skipTransition: () => undefined,
    };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: start,
  });
  return started;
}

describe("the Grid/List toggle is one list View Transition", () => {
  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it("switches inside one `list` transition over the products section", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    const started = stubViewTransitions();
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(started).toEqual([
      { vt: "list", scoped: true, oldView: "UL", newView: "TBODY" },
    ]);
    await screen.findByRole("table", { name: "Your products" });
    expect(window.location.hash).toBe("#/?view=list");
    await waitFor(() =>
      expect(document.documentElement.dataset.vt).toBeUndefined(),
    );
    // The page's own blocks are the transition's scope (they hold still).
    expect(
      screen
        .getByRole("heading", { level: 1, name: "Your library" })
        .closest("section")!.className,
    ).toMatch(/\bpk-vt-scope\b/);
    await userEvent.click(screen.getByRole("radio", { name: "Grid" }));
    expect(started.map((s) => [s.vt, s.oldView, s.newView])).toEqual([
      ["list", "UL", "TBODY"],
      ["list", "TBODY", "UL"],
    ]);
    // A view switch never restaggers.
    expect(items().className).not.toMatch(/\bpk-stagger\b/);
  });

  it('is an instant swap under reduced motion (html[data-motion="reduce"]): no transition starts', async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    document.documentElement.dataset.motion = "reduce";
    const started = stubViewTransitions();
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(
      await screen.findByRole("table", { name: "Your products" }),
    ).toBeTruthy();
    expect(started).toEqual([]);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("is an instant swap without the View Transitions API", async () => {
    mockFetch(signedIn(TWELVE));
    renderPortal();
    await twelve();
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(
      await screen.findByRole("table", { name: "Your products" }),
    ).toBeTruthy();
    expect(window.localStorage.getItem("pk-portal-library-view")).toBe("list");
  });
});

// ── Tiles: lift, press, art ─────────────────────────────────────────────────────────────────────

describe("Library tiles lift, and press only for their own link", () => {
  it("hangs the lift and the card press on a wrapper outside the clipping card", async () => {
    mockFetch(signedIn(TWELVE.slice(0, 3)));
    renderPortal();
    const card = await screen.findByRole("article", { name: "Nightfall" });
    const wrapper = card.parentElement!;
    expect(wrapper.className).toMatch(/\bpk-lift\b/);
    expect(wrapper.className).toMatch(/\bpk-pressable-card\b/);
    expect(wrapper.className).toMatch(/\brounded-xl\b/);
    // The card itself never presses as a whole (its buttons have their own press).
    expect(card.className).not.toMatch(/\bpk-pressable\b/);
    expect(
      within(card).getByRole("link", { name: "Nightfall" }).className,
    ).toMatch(/\bpk-press-link\b/);
    for (const button of within(card).getAllByRole("button"))
      expect(button.className).not.toMatch(/\bpk-press-link\b/);
  });
});

describe("ProductArt fades its image in once decoded", () => {
  const art = (src: string | null, liftArt = false) => (
    <ProductArt
      slug="nightfall"
      name="Nightfall"
      tint={null}
      src={src}
      variant="tile"
      liftArt={liftArt}
      className="aspect-video"
    />
  );

  it("keeps the image hidden until it loads, in a box that keeps its aspect", async () => {
    const { container, rerender } = render(art("/media/nightfall/header?v=1"));
    const box = container.querySelector<HTMLElement>("[data-art='image']")!;
    const img = box.querySelector("img")!;
    expect(box.className).toMatch(/\baspect-video\b/);
    expect(img.className).toMatch(/\bpk-img-in\b/);
    expect(img.className).toMatch(/\babsolute inset-0\b/);
    expect(img.className).not.toMatch(/\bpk-lift-art\b/);
    expect(img.hasAttribute("data-loaded")).toBe(false);
    fireEvent.load(img);
    await waitFor(() => expect(img.getAttribute("data-loaded")).toBe(""));
    expect(box.className).toMatch(/\baspect-video\b/);
    // New art fades in again.
    rerender(art("/media/nightfall/header?v=2"));
    expect(img.hasAttribute("data-loaded")).toBe(false);
    fireEvent.load(img);
    await waitFor(() => expect(img.getAttribute("data-loaded")).toBe(""));
  });

  it("waits for decode() before it shows the image", async () => {
    let decoded!: () => void;
    const decode = vi.fn(() => new Promise<void>((r) => (decoded = () => r())));
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: decode,
    });
    try {
      const { container } = render(art("/media/nightfall/header?v=1"));
      const img = container.querySelector("img")!;
      fireEvent.load(img);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(img.hasAttribute("data-loaded")).toBe(false);
      await act(async () => decoded());
      expect(img.getAttribute("data-loaded")).toBe("");
    } finally {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    }
  });

  it("shows an image that is already decoded at once (a cached one)", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      1920,
    );
    const { container } = render(art("/media/nightfall/header?v=1"));
    expect(container.querySelector("img")!.getAttribute("data-loaded")).toBe(
      "",
    );
  });

  it("scales with the lift inside a tile", () => {
    const { container } = render(art("/media/nightfall/header?v=1", true));
    const img = container.querySelector("img")!;
    expect(img.className).toMatch(/\bpk-img-in\b/);
    expect(img.className).toMatch(/\bpk-lift-art\b/);
  });
});

// ── Discover: the just-added ring ─────────────────────────────────────────────────────────────

const OFFER: PortalDiscoverOffer = {
  product: "mossgarden",
  name: "Mossgarden",
  developerName: "Little Fern",
  tintColor: null,
  website: null,
  iconUrl: null,
  headerUrl: null,
  support: null,
  platforms: ["macos"],
  offer: {
    tier: "lifetime",
    tierLabel: "Lifetime",
    deviceLimit: 5,
    expiresAt: null,
  },
  reason: "free_with_account",
} as PortalDiscoverOffer;

describe("Discover tiles: lift, and the just-added ring pops in once", () => {
  const tile = (state: "offer" | "adding" | "added") => (
    <DiscoverTile offer={OFFER} state={state} onAdd={() => undefined} />
  );

  it("pops the ring and the plate in when an Add goes through on screen", () => {
    const { container, rerender } = render(tile("offer"));
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/\bpk-lift\b/);
    expect(wrapper.className).not.toMatch(/\bpk-pressable/);
    expect(container.querySelector("[data-ring]")).toBeNull();
    rerender(tile("adding"));
    rerender(tile("added"));
    const ring = container.querySelector("[data-ring]")!;
    expect(ring.getAttribute("aria-hidden")).toBe("true");
    expect(ring.className).toMatch(/\bring-1 ring-success\b/);
    expect(ring.className).toMatch(/\bpk-pop-in\b/);
    // The words carry the meaning; the plate pops with the ring.
    const plate = screen.getByText("In your library");
    expect(plate.className).toMatch(/\bpk-pop-in\b/);
    // The card keeps its green edge; the ring left it, so the card's clip can't cut it.
    const card = screen.getByRole("article", { name: "Mossgarden" });
    expect(card.className).toMatch(/\bborder-success\b/);
    expect(card.className).not.toMatch(/\bring-/);
  });

  it("just shows them on a tile that is already added when it mounts (?added= after a reload)", () => {
    const { container } = render(tile("added"));
    const ring = container.querySelector("[data-ring]")!;
    expect(ring.className).toMatch(/\bring-1 ring-success\b/);
    expect(ring.className).not.toMatch(/\bpk-pop-in\b/);
    expect(screen.getByText("In your library").className).not.toMatch(
      /\bpk-pop-in\b/,
    );
  });

  it("staggers the offers on their first load", async () => {
    mockFetch(
      signedIn([], {
        "/api/discover": { offers: [OFFER] },
      }),
    );
    window.history.replaceState(null, "", "/#/discover");
    renderPortal();
    const card = await screen.findByRole("article", { name: "Mossgarden" });
    expect(card.closest("ul")!.className).toMatch(/\bpk-stagger\b/);
  });
});

// ── The stylesheet half ─────────────────────────────────────────────────────────────────────────

describe("motion.css carries MO-07's patterns on the tokens", () => {
  const css = readFileSync(join(here, "..", "src", "motion.css"), "utf8");

  it("presses a card for its link only, and never under reduced motion", () => {
    expect(css).toMatch(
      /\.pk-pressable-card:has\(\.pk-press-link:active\) \{\s*transform: scale\(var\(--pk-motion-scale-press\)\);\s*transition-duration: var\(--pk-duration-micro\);/,
    );
    const media = css.split("@media (prefers-reduced-motion: reduce)");
    expect(
      media.some((b) =>
        /^\s*\{\s*\.pk-pressable-card:has\(\.pk-press-link:active\) \{\s*transform: none;/.test(
          b,
        ),
      ),
    ).toBe(true);
    expect(css).toMatch(
      /:root\[data-motion="reduce"\] \.pk-pressable-card:has\(\.pk-press-link:active\) \{\s*transform: none;/,
    );
  });

  it("fades art in on opacity alone, on a token, keeping the lift's transform transition", () => {
    expect(css).toMatch(
      /\.pk-img-in \{\s*opacity: 0;\s*transition: opacity var\(--pk-duration-base\) var\(--pk-ease-standard\);/,
    );
    expect(css).toMatch(/\.pk-img-in\[data-loaded\] \{\s*opacity: 1;/);
    expect(css).toMatch(
      /\.pk-img-in\.pk-lift-art \{\s*transition:\s*opacity var\(--pk-duration-base\) var\(--pk-ease-standard\),\s*transform var\(--pk-duration-slow\) var\(--pk-ease-standard\);/,
    );
  });
});

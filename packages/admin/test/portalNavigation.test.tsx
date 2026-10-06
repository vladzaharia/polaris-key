import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DAY,
  libraryFor,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";
import {
  consumeHeadingFocus,
  requestHeadingFocus,
} from "../src/portal/focus.js";
import {
  focusPageHeading,
  navigationKind,
  resolveHash,
  VT_SOURCE,
  type PortalRoute,
} from "../src/portal/router.js";

/**
 * Portal navigation motion, scroll and focus (MO-05, notes/S-23 §6.3, §6.5). jsdom has no View
 * Transitions API, so the default path is the instant swap; a fake `startViewTransition` stands in
 * for the browser where the transition's types and one-shot names are under test. The real
 * pseudo-element animations are checked in e2e/motion.e2e.test.ts.
 */

const html = document.documentElement;
type Doc = { startViewTransition?: unknown };

const art = (slug: string) => ({
  headerUrl: `/media/${slug}/header?v=1`,
  iconUrl: `/media/${slug}/icon?v=1`,
});
const LICENSES = ["nightfall", "tidewater", "ember"].map((product, i) =>
  license({ product, activatedAt: NOW_S - i * DAY }),
);

function withArt(): void {
  mockFetch(
    signedIn(LICENSES, {
      "/api/library": libraryFor(LICENSES, undefined, art("nightfall")),
    }),
  );
}

interface Fake {
  calls: number;
  /** Per call: html[data-vt] and the inline names on the page when the transition started. */
  starts: { vt: string | undefined; names: string[] }[];
  /** Per call: the inline names once the update ran (the new state's one-shot names). */
  updated: string[][];
  release: () => void;
}

/** Inline (CSSOM) view-transition-names on the page, as "tag=name". */
function inlineNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("*"))
    .map(
      (el) => [el, el.style.getPropertyValue("view-transition-name")] as const,
    )
    .filter(([, n]) => n !== "")
    .map(([el, n]) => `${el.tagName.toLowerCase()}=${n}`)
    .sort();
}

/** A fake API: the update runs in a microtask, the transition finishes when released. */
function installFake(): Fake {
  const fake: Fake = {
    calls: 0,
    starts: [],
    updated: [],
    release: () => undefined,
  };
  (document as unknown as Doc).startViewTransition = (update: () => void) => {
    fake.calls++;
    fake.starts.push({ vt: html.dataset.vt, names: inlineNames() });
    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => (resolveFinished = r));
    const updateCallbackDone = Promise.resolve().then(() => {
      update();
      fake.updated.push(inlineNames());
    });
    fake.release = () => resolveFinished();
    return {
      updateCallbackDone,
      finished: updateCallbackDone.then(() => finished),
      skipTransition: () => resolveFinished(),
    };
  };
  return fake;
}

const route = (hash: string): PortalRoute => resolveHash(hash).route;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Doc).startViewTransition;
  delete html.dataset.motion;
  delete html.dataset.vt;
});

async function library(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Your library" });
  await screen.findByRole("article", { name: "Nightfall" });
}

const tileLink = (name: string) =>
  within(screen.getByRole("article", { name })).getByRole("link", {
    name,
    exact: true,
  } as never);

describe("the kind of navigation (pure)", () => {
  it("forward into a product, back to the Library or Discover, route otherwise", () => {
    expect(navigationKind(route("#/"), route("#/p/nightfall"))).toBe("forward");
    expect(navigationKind(route("#/discover"), route("#/p/nightfall"))).toBe(
      "forward",
    );
    expect(navigationKind(route("#/p/nightfall"), route("#/"))).toBe("back");
    expect(
      navigationKind(route("#/p/nightfall/devices"), route("#/discover")),
    ).toBe("back");
    expect(navigationKind(route("#/"), route("#/discover"))).toBe("route");
    expect(navigationKind(route("#/"), route("#/account"))).toBe("route");
    expect(navigationKind(route("#/account"), route("#/p/nightfall"))).toBe(
      "route",
    );
    expect(navigationKind(route("#/p/nightfall"), route("#/p/tidewater"))).toBe(
      "route",
    );
    expect(
      navigationKind(
        route("#/p/nightfall"),
        route("#/p/nightfall/free-device"),
      ),
    ).toBe("route");
  });

  it("a section of the same page, and a query of the same page and section", () => {
    expect(
      navigationKind(route("#/p/nightfall"), route("#/p/nightfall/devices")),
    ).toBe("section");
    expect(navigationKind(route("#/account"), route("#/account/data"))).toBe(
      "section",
    );
    expect(navigationKind(route("#/"), route("#/?q=fern&view=list"))).toBe(
      "params",
    );
    expect(
      navigationKind(
        route("#/p/nightfall/devices"),
        route("#/p/nightfall/devices?license=lic_2"),
      ),
    ).toBe("params");
  });
});

describe("without the View Transitions API: instant swaps that still scroll and focus", () => {
  it("opens a product at the top with focus on its h1, and Back focuses the Library's", async () => {
    withArt();
    renderPortal();
    await library();
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(240);

    await userEvent.click(tileLink("Nightfall"));
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Nightfall",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: "instant",
    });
    // No transition ran, so nothing was named and no tile is left marked.
    expect(inlineNames()).toEqual([]);
    expect(document.querySelector(`[${VT_SOURCE}]`)).toBeNull();

    await userEvent.click(
      within(screen.getByRole("main")).getByRole("link", { name: "Library" }),
    );
    const libraryH1 = await screen.findByRole("heading", {
      level: 1,
      name: "Your library",
    });
    await waitFor(() => expect(document.activeElement).toBe(libraryH1));
    // Made focusable for the move; styles.css draws no ring on it.
    expect(libraryH1.getAttribute("tabindex")).toBe("-1");
  });

  it("focuses the new page's heading once per navigation", async () => {
    withArt();
    renderPortal();
    await library();
    const focused: string[] = [];
    document.addEventListener("focusin", (e) =>
      focused.push((e.target as Element).tagName),
    );
    act(() => {
      window.location.hash = "#/account";
    });
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Account",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    await new Promise((r) => setTimeout(r, 30));
    expect(focused.filter((t) => t === "H1")).toEqual(["H1"]);
  });

  it("a query change (search, filters) moves nothing: focus stays where the user types", async () => {
    const twelve = Array.from({ length: 9 }, (_, i) =>
      license({ product: `p${i}`, productName: `Product ${i}` }),
    );
    mockFetch(signedIn(twelve));
    renderPortal();
    const search = await screen.findByRole("searchbox");
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    await userEvent.type(search, "Product 3");
    await waitFor(() => expect(window.location.hash).toContain("q="));
    expect(document.activeElement).toBe(search);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("another section of the same product scrolls there (smooth only with motion), focus stays", async () => {
    window.history.replaceState(null, "", "/#/p/nightfall");
    withArt();
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Nightfall",
    });
    const calls: { id: string; behavior: unknown }[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      calls.push({
        id: this.id,
        behavior: typeof arg === "object" ? arg.behavior : undefined,
      });
    });
    // A section other than the first (the first is the page's top; see below).
    const first = document
      .querySelector("main [data-first-section]")
      ?.getAttribute("data-first-section");
    const [a] = Array.from(
      document.querySelectorAll<HTMLElement>("main [data-section]"),
    )
      .map((el) => el.dataset.section!)
      .filter((id) => id !== first);
    expect(a).toBeTruthy();
    const before = document.activeElement;
    act(() => {
      window.location.hash = `#/p/nightfall/${a}`;
    });
    await waitFor(() =>
      expect(calls).toContainEqual({ id: `section-${a}`, behavior: "smooth" }),
    );
    // Back to the page's top, then the same section again under reduced motion.
    act(() => {
      window.location.hash = "#/p/nightfall";
    });
    html.dataset.motion = "reduce";
    calls.length = 0;
    act(() => {
      window.location.hash = `#/p/nightfall/${a}`;
    });
    await waitFor(() =>
      expect(calls).toContainEqual({ id: `section-${a}`, behavior: "instant" }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(h1);
  });

  it("the product's section links scroll smoothly only when motion is allowed", async () => {
    window.history.replaceState(null, "", "/#/p/nightfall");
    withArt();
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    const behaviors: unknown[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      (arg?: boolean | ScrollIntoViewOptions) => {
        behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
      },
    );
    const toc = screen.getByRole("navigation", { name: "On this page" });
    const links = within(toc).getAllByRole("link");
    await userEvent.click(links[1]!);
    expect(behaviors.at(-1)).toBe("smooth");
    html.dataset.motion = "reduce";
    await userEvent.click(links[0]!);
    expect(behaviors.at(-1)).toBe("instant");
  });

  it("a link to the product's first section keeps the page at its top, as the deep link does", async () => {
    window.history.replaceState(null, "", "/#/p/nightfall/devices");
    withArt();
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    const first = document
      .querySelector("main [data-first-section]")
      ?.getAttribute("data-first-section");
    expect(first).toBeTruthy();
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(600);
    const into = vi.spyOn(Element.prototype, "scrollIntoView");
    into.mockClear();
    act(() => {
      window.location.hash = `#/p/nightfall/${first}`;
    });
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({
        top: 0,
        left: 0,
        behavior: "smooth",
      }),
    );
    expect(into).not.toHaveBeenCalled();
  });

  it("a heading-focus request for another product never holds this page's focus", async () => {
    withArt();
    renderPortal();
    await library();
    // Left by a jump that never reached its product page (a not-found product, say).
    requestHeadingFocus("tidewater");
    try {
      act(() => {
        window.location.hash = "#/account";
      });
      const h1 = await screen.findByRole("heading", {
        level: 1,
        name: "Account",
      });
      await waitFor(() => expect(document.activeElement).toBe(h1));
    } finally {
      consumeHeadingFocus("tidewater");
    }
  });
});

describe("focusPageHeading", () => {
  afterEach(() => document.body.replaceChildren());

  it("waits for the real heading while the page shows its loading placeholder", async () => {
    const main = document.createElement("main");
    main.innerHTML =
      '<div aria-busy="true"><h1 class="sr-only">Loading</h1></div>';
    document.body.append(main);
    focusPageHeading();
    await new Promise((r) => setTimeout(r, 60));
    expect(document.activeElement).toBe(document.body);
    main.innerHTML = "<h1>Nightfall</h1>";
    const h1 = main.querySelector("h1")!;
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(h1.getAttribute("tabindex")).toBe("-1");
  });

  it("gives up once another navigation has taken over", async () => {
    const main = document.createElement("main");
    main.innerHTML = "<h1>Account</h1>";
    document.body.append(main);
    focusPageHeading(undefined, () => false);
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("with the API: typed View Transitions and the one-shot shared element", () => {
  it("Library → product: forward, the clicked tile's art, icon and name named for the old state only", async () => {
    withArt();
    renderPortal();
    await library();
    const fake = installFake();
    await userEvent.click(tileLink("Nightfall"));
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    expect(fake.calls).toBe(1);
    expect(fake.starts[0]).toEqual({
      vt: "forward",
      names: ["div=pk-hero", "h3=pk-hero-title", "img=pk-hero-icon"],
    });
    // The new ends are the hero's classes (motion.css), never inline names.
    expect(fake.updated[0]).toEqual([]);
    expect(document.querySelector(".pk-vt-hero")).not.toBeNull();
    expect(document.querySelector(".pk-vt-hero-icon")).not.toBeNull();
    expect(document.querySelector("h1.pk-vt-hero-title")).not.toBeNull();
    fake.release();
    await waitFor(() => expect(html.dataset.vt).toBeUndefined());
    expect(document.querySelector(`[${VT_SOURCE}]`)).toBeNull();
    const h1 = screen.getByRole("heading", { level: 1, name: "Nightfall" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  it("product → Library: back, the tile it came from named for the new state, then cleared", async () => {
    withArt();
    renderPortal();
    await library();
    await userEvent.click(tileLink("Nightfall"));
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    const fake = installFake();
    await userEvent.click(
      within(screen.getByRole("main")).getByRole("link", { name: "Library" }),
    );
    await library();
    expect(fake.calls).toBe(1);
    expect(fake.starts[0]!.vt).toBe("back");
    expect(fake.updated[0]).toEqual([
      "div=pk-hero",
      "h3=pk-hero-title",
      "img=pk-hero-icon",
    ]);
    fake.release();
    await waitFor(() => expect(inlineNames()).toEqual([]));
    expect(html.dataset.vt).toBeUndefined();
  });

  it("a route between top-level pages is typed route and names nothing", async () => {
    withArt();
    renderPortal();
    await library();
    const fake = installFake();
    act(() => {
      window.location.hash = "#/account";
    });
    await screen.findByRole("heading", { level: 1, name: "Account" });
    expect(fake.starts).toEqual([{ vt: "route", names: [] }]);
    fake.release();
  });

  it("a click elsewhere than a tile (or a deep link into a section) flies nothing", async () => {
    withArt();
    renderPortal();
    await library();
    const fake = installFake();
    act(() => {
      window.location.hash = "#/p/nightfall";
    });
    await screen.findByRole("heading", { level: 1, name: "Nightfall" });
    expect(fake.starts).toEqual([{ vt: "forward", names: [] }]);
  });

  it("under reduced motion (the in-app preference) no transition starts; scroll and focus still land", async () => {
    withArt();
    renderPortal();
    await library();
    html.dataset.motion = "reduce";
    const fake = installFake();
    await userEvent.click(tileLink("Nightfall"));
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Nightfall",
    });
    expect(fake.calls).toBe(0);
    expect(html.dataset.vt).toBeUndefined();
    expect(inlineNames()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });

  for (const role of ["dialog", "menu"])
    it(`while a ${role} is on screen (closing), no transition starts and focus waits for it to go`, async () => {
      withArt();
      renderPortal();
      await library();
      const fake = installFake();
      // An overlay still running its exit, as Radix keeps it mounted.
      const closing = document.createElement("div");
      closing.setAttribute("role", role);
      closing.setAttribute("data-state", "closed");
      document.body.append(closing);
      act(() => {
        window.location.hash = "#/account";
      });
      const h1 = await screen.findByRole("heading", {
        level: 1,
        name: "Account",
      });
      expect(fake.calls).toBe(0);
      await new Promise((r) => setTimeout(r, 60));
      expect(document.activeElement).not.toBe(h1);
      closing.remove();
      await waitFor(() => expect(document.activeElement).toBe(h1));
    });
});

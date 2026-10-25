// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeRouter,
  blockNavigation,
  createHashRouter,
  navigate,
  overlayOnScreen,
  type HashRouter,
  type TransitionRun,
} from "../../src/lib/router-core.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

interface Rig {
  router: HashRouter;
  runs: TransitionRun[];
  updates: Array<() => void>;
  seen: string[];
  unsubscribe: () => void;
  navigated: Array<[string, string, string | null]>;
}

/** A router over a fake runner that records each run and holds its update until released. */
function rig(opts: { inline?: boolean } = {}): Rig {
  const runs: TransitionRun[] = [];
  const updates: Array<() => void> = [];
  const navigated: Array<[string, string, string | null]> = [];
  const router = createHashRouter({
    redirect: (h) => (h === "#/section" ? "#/section/home" : null),
    classify: (from, to) =>
      from.split("?")[0] === to.split("?")[0] ? null : "route",
    transition: (update, run) => {
      runs.push(run);
      if (opts.inline) update();
      else updates.push(update);
    },
    onNavigate: (f, t, k) => navigated.push([f, t, k]),
  });
  const seen: string[] = [];
  const unsubscribe = router.subscribe(() => seen.push(router.snapshot()));
  return { router, runs, updates, seen, unsubscribe, navigated };
}

let r: Rig;

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/#/a");
});
afterEach(() => {
  r?.unsubscribe();
  r?.router.resetForTests();
  r?.router.dispose();
});

describe("router core: store", () => {
  it("snapshot reads the location", () => {
    r = rig();
    expect(r.router.snapshot()).toBe("#/a");
  });

  it("applies a redirect on read with replaceState, adding no history entry", () => {
    const len = window.history.length;
    window.history.replaceState(null, "", "/#/section");
    r = rig();
    expect(r.router.snapshot()).toBe("#/section/home");
    expect(window.location.hash).toBe("#/section/home");
    expect(window.history.length).toBe(len);
  });

  it("redirects a navigation's target before it is pushed", () => {
    r = rig({ inline: true });
    r.router.navigate("#/section");
    expect(window.location.hash).toBe("#/section/home");
  });

  it("the same hash is a no-op", () => {
    r = rig();
    expect(r.router.navigate("#/a")).toBe(true);
    expect(r.seen).toEqual([]);
    expect(r.runs).toEqual([]);
  });

  it("publishes once for the hashchange and popstate of one navigation", async () => {
    r = rig({ inline: true });
    r.router.navigate("#/b");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await tick();
    expect(r.seen).toEqual(["#/b"]);
    expect(r.navigated).toEqual([["#/a", "#/b", "route"]]);
  });

  it("detaches its window listeners with the last subscriber", async () => {
    r = rig({ inline: true });
    r.unsubscribe();
    window.location.hash = "#/z";
    await tick();
    expect(r.seen).toEqual([]);
  });
});

describe("router core: params", () => {
  it("setParams replaces the history entry, merges and removes", () => {
    r = rig();
    const len = window.history.length;
    r.router.setParams({ q: "x", tags: ["a", "b"] });
    expect(window.location.hash).toBe("#/a?q=x&tags=a&tags=b");
    r.router.setParams({ q: null, tags: [] });
    expect(window.location.hash).toBe("#/a");
    expect(window.history.length).toBe(len);
  });

  it("setParams never starts a transition", () => {
    r = rig();
    r.router.setParams({ q: "x" });
    expect(r.runs).toEqual([]);
    expect(r.seen).toEqual(["#/a?q=x"]);
  });

  it("setParams can push when asked", () => {
    r = rig();
    const len = window.history.length;
    r.router.setParams({ step: "2" }, { replace: false });
    expect(window.history.length).toBe(len + 1);
  });
});

describe("router core: blockers", () => {
  it("refuses a navigate and leaves the location alone", () => {
    r = rig();
    r.router.blockNavigation(() => false);
    expect(r.router.navigate("#/b")).toBe(false);
    expect(window.location.hash).toBe("#/a");
    expect(r.seen).toEqual([]);
  });

  it("force skips the blockers", () => {
    r = rig({ inline: true });
    r.router.blockNavigation(() => false);
    expect(r.router.navigate("#/b", { force: true, replace: true })).toBe(true);
    expect(window.location.hash).toBe("#/b");
  });

  it("rolls back a hashchange it could not prevent", async () => {
    r = rig();
    r.router.blockNavigation((h) => h !== "#/b");
    window.location.hash = "#/b";
    await tick();
    expect(window.location.hash).toBe("#/a");
    expect(r.seen).toEqual([]);
  });

  it("an unregistered blocker no longer refuses", () => {
    r = rig({ inline: true });
    const off = r.router.blockNavigation(() => false);
    off();
    expect(r.router.navigate("#/b")).toBe(true);
  });

  it("a committed link click is not asked twice", async () => {
    r = rig({ inline: true });
    const guard = vi.fn(() => true);
    r.router.blockNavigation(guard);
    expect(r.router.allows("#/b")).toBe(true);
    r.router.commit({ hash: "#/b" });
    guard.mockClear();
    window.location.hash = "#/b";
    await tick();
    expect(guard).not.toHaveBeenCalled();
    expect(r.seen).toEqual(["#/b"]);
  });
});

describe("router core: transitions", () => {
  it("a change of path runs the runner and holds the old hash until the update", () => {
    r = rig();
    r.router.navigate("#/b", { replace: true });
    expect(r.runs).toEqual([{ type: "route", shared: [] }]);
    expect(r.router.snapshot()).toBe("#/a");
    expect(r.seen).toEqual([]);
    r.updates[0]?.();
    expect(r.router.snapshot()).toBe("#/b");
    expect(r.seen).toEqual(["#/b"]);
  });

  it("flushes an update the runner calls later, not one it calls at once", () => {
    const flush = vi.fn((fn: () => void) => fn());
    let later: (() => void) | null = null;
    let inline = true;
    const router = createHashRouter({
      redirect: () => null,
      classify: () => "route",
      transition: (update) => {
        if (inline) update();
        else later = update;
      },
      flush,
    });
    const un = router.subscribe(() => {});
    router.navigate("#/b", { replace: true });
    expect(flush).not.toHaveBeenCalled();
    inline = false;
    router.navigate("#/c", { replace: true });
    (later as (() => void) | null)?.();
    expect(flush).toHaveBeenCalledTimes(1);
    un();
    router.dispose();
    r = undefined as unknown as Rig;
  });

  it("the query alone starts none", () => {
    r = rig();
    r.router.navigate("#/a?q=1", { replace: true });
    expect(r.runs).toEqual([]);
    expect(r.seen).toEqual(["#/a?q=1"]);
  });

  it("starts none when classify answers null", () => {
    r = rig();
    r.router.navigate("#/a?x=2", { replace: true });
    expect(r.runs).toHaveLength(0);
  });

  it("starts none while an overlay is on screen, and still publishes", () => {
    r = rig();
    document.body.innerHTML = '<div role="dialog"></div>';
    r.router.navigate("#/b", { replace: true });
    expect(r.runs).toEqual([]);
    expect(r.seen).toEqual(["#/b"]);
  });

  it("runUnderOverlay hands the move to the runner even with an overlay on screen", () => {
    const runs: string[] = [];
    const router = createHashRouter({
      redirect: () => null,
      classify: () => "route",
      transition: (update, run) => {
        runs.push(run.type);
        update();
      },
      runUnderOverlay: true,
    });
    const seen: string[] = [];
    const off = router.subscribe(() => seen.push(router.snapshot()));
    document.body.innerHTML = '<div role="dialog"></div>';
    router.navigate("#/b", { replace: true });
    off();
    router.resetForTests();
    router.dispose();
    expect(runs).toEqual(["route"]);
    expect(seen).toEqual(["#/b"]);
  });

  it("a link's intent names the type and the shared element of a forward move", () => {
    r = rig();
    document.body.innerHTML = '<a><i data-vt-shared="pk-key"></i></a>';
    const shared = document.querySelector("i");
    r.router.commit({ hash: "#/b", type: "forward", shared });
    window.location.hash = "#/b";
    return tick().then(() => {
      expect(r.runs).toEqual([
        { type: "forward", shared: [[shared, "pk-key"]] },
      ]);
    });
  });

  it("onNavigate sees every published change, with a null kind for the query", () => {
    r = rig({ inline: true });
    r.router.navigate("#/a?q=1", { replace: true });
    r.router.navigate("#/b", { replace: true });
    expect(r.navigated).toEqual([
      ["#/a", "#/a?q=1", null],
      ["#/a?q=1", "#/b", "route"],
    ]);
  });
});

describe("router core: overlayOnScreen", () => {
  const cases: Array<[string, string]> = [
    ["an open dialog", '<div role="dialog" data-state="open"></div>'],
    ["a closing dialog", '<div role="dialog" data-state="closed"></div>'],
    ["an alertdialog", '<div role="alertdialog"></div>'],
    ["a menu", '<div role="menu"></div>'],
    [
      "the overlay animation class",
      '<div class="animate-pk-overlay-in"></div>',
    ],
    ["a scrim", '<div class="pk-overlay"></div>'],
    ["a drawer", '<div class="pk-drawer"></div>'],
    ["a visible toast", "<li data-sonner-toast></li>"],
    [
      "popper content that is not a tooltip",
      "<div data-radix-popper-content-wrapper><div>menu</div></div>",
    ],
  ];

  it("is false on an empty page", () => {
    expect(overlayOnScreen()).toBe(false);
  });

  it.each(cases)("sees %s", (_name, html) => {
    document.body.innerHTML = html;
    expect(overlayOnScreen()).toBe(true);
  });

  it("ignores a hidden toast", () => {
    document.body.innerHTML =
      '<li data-sonner-toast data-visible="false"></li>';
    expect(overlayOnScreen()).toBe(false);
  });

  it("ignores a tooltip", () => {
    document.body.innerHTML =
      '<div data-radix-popper-content-wrapper><div><span role="tooltip"></span></div></div>';
    expect(overlayOnScreen()).toBe(false);
  });
});

describe("router core: the active router", () => {
  it("module-level navigate and blockNavigation reach the last created router", () => {
    r = rig({ inline: true });
    expect(activeRouter()).toBe(r.router);
    const off = blockNavigation(() => false);
    expect(navigate("#/b")).toBe(false);
    off();
    expect(navigate("#/b", { replace: true })).toBe(true);
    expect(window.location.hash).toBe("#/b");
  });

  it("a newer router takes over; dispose of the old one leaves it active", () => {
    r = rig();
    const second = createHashRouter({
      redirect: () => null,
      classify: () => null,
      transition: () => {},
    });
    expect(activeRouter()).toBe(second);
    r.router.dispose();
    expect(activeRouter()).toBe(second);
    second.dispose();
    expect(() => activeRouter()).toThrow(/No hash router/);
  });
});

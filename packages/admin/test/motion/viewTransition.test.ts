import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIST_BUDGET,
  markViewTransitionSupport,
  viewTransition,
  viewTransitionsSupported,
} from "../../src/ui/motion/index.js";

/**
 * viewTransition() (notes/S-23 §6.3). jsdom has no View Transitions API, so the default path is
 * the instant swap; a fake `startViewTransition` stands in for the browser where the API's own
 * behaviour is under test.
 */

const html = document.documentElement;
type Doc = { startViewTransition?: unknown };

interface Fake {
  calls: number;
  skipped: number;
  release: () => void;
}

/** Install a fake API that runs the update in a microtask and finishes when released. */
function installFake(): Fake {
  const fake: Fake = { calls: 0, skipped: 0, release: () => undefined };
  (document as unknown as Doc).startViewTransition = (update: () => void) => {
    fake.calls++;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => (resolveFinished = r));
    const updateCallbackDone = Promise.resolve().then(update);
    fake.release = () => resolveFinished();
    return {
      updateCallbackDone,
      finished: updateCallbackDone.then(() => finished),
      skipTransition: () => {
        fake.skipped++;
        resolveFinished();
      },
    };
  };
  return fake;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  delete (document as unknown as Doc).startViewTransition;
  delete html.dataset.motion;
  delete html.dataset.vt;
  markViewTransitionSupport();
});

describe("without the View Transitions API (jsdom)", () => {
  it("runs the update synchronously and returns resolved promises", async () => {
    expect(viewTransitionsSupported()).toBe(false);
    const update = vi.fn();
    const handle = viewTransition(update, { type: "forward" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(html.dataset.vt).toBeUndefined();
    await expect(handle.updateCallbackDone).resolves.toBeUndefined();
    await expect(handle.finished).resolves.toBeUndefined();
  });

  it("does not mark the document as supporting transitions", () => {
    markViewTransitionSupport();
    expect(html.hasAttribute("data-vt-supported")).toBe(false);
  });

  it("lets an update's error surface to the caller", () => {
    expect(() =>
      viewTransition(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});

describe("with the API", () => {
  let fake: Fake;
  beforeEach(() => {
    fake = installFake();
    markViewTransitionSupport();
  });

  it("marks support, sets data-vt for the transition and clears it after", async () => {
    expect(html.hasAttribute("data-vt-supported")).toBe(true);
    const update = vi.fn();
    const handle = viewTransition(update, { type: "tab" });
    expect(fake.calls).toBe(1);
    expect(html.dataset.vt).toBe("tab");
    await handle.updateCallbackDone;
    expect(update).toHaveBeenCalledTimes(1);
    fake.release();
    await handle.finished;
    await flush();
    expect(html.dataset.vt).toBeUndefined();
  });

  it("defaults to a route transition", () => {
    viewTransition(() => undefined);
    expect(html.dataset.vt).toBe("route");
  });

  it("does not start a transition under reduced motion (the in-app preference)", async () => {
    html.dataset.motion = "reduce";
    const update = vi.fn();
    const handle = viewTransition(update, { type: "route" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(fake.calls).toBe(0);
    expect(html.dataset.vt).toBeUndefined();
    await expect(handle.finished).resolves.toBeUndefined();
  });

  it("does not start a transition under prefers-reduced-motion", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes("reduce"),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const update = vi.fn();
      viewTransition(update);
      expect(update).toHaveBeenCalledTimes(1);
      expect(fake.calls).toBe(0);
    } finally {
      window.matchMedia = original;
    }
  });

  it("skips a running transition when a new one starts", async () => {
    viewTransition(() => undefined, { type: "route" });
    const second = viewTransition(() => undefined, { type: "forward" });
    expect(fake.skipped).toBe(1);
    expect(html.dataset.vt).toBe("forward");
    await flush();
    // The first one's cleanup must not clear the second one's type.
    expect(html.dataset.vt).toBe("forward");
    fake.release();
    await second.finished;
    await flush();
    expect(html.dataset.vt).toBeUndefined();
  });

  it("names a shared element for the old snapshot only, through the CSSOM", async () => {
    const tile = document.createElement("div");
    document.body.append(tile);
    let nameDuringUpdate = "unset";
    const handle = viewTransition(
      () => {
        nameDuringUpdate = tile.style.getPropertyValue("view-transition-name");
      },
      { type: "forward", shared: [[tile, "pk-hero"]] },
    );
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("pk-hero");
    expect(tile.hasAttribute("style")).toBe(true); // a CSSOM write, reflected
    await handle.updateCallbackDone;
    expect(nameDuringUpdate).toBe("");
    tile.remove();
  });

  it(`takes a list of up to ${LIST_BUDGET} rows whole, and cleans up`, async () => {
    const list = document.createElement("ul");
    for (let i = 0; i < LIST_BUDGET; i++)
      list.append(document.createElement("li"));
    const handle = viewTransition(() => undefined, { type: "list", list });
    expect(list.classList.contains("pk-vt-list")).toBe(true);
    fake.release();
    await handle.finished;
    await flush();
    expect(list.classList.contains("pk-vt-list")).toBe(false);
  });

  it("names only the on-screen rows of a longer list", async () => {
    const list = document.createElement("ul");
    const rows: HTMLLIElement[] = [];
    for (let i = 0; i < LIST_BUDGET + 10; i++) {
      const li = document.createElement("li");
      // Row i sits at y = i * 40; the jsdom viewport is 768 px tall.
      li.getBoundingClientRect = () =>
        ({ top: i * 40, bottom: i * 40 + 40 }) as DOMRect;
      rows.push(li);
      list.append(li);
    }
    const handle = viewTransition(() => undefined, { type: "list", list });
    expect(list.classList.contains("pk-vt-list")).toBe(false);
    const named = rows.filter(
      (r) =>
        r.style.getPropertyValue("view-transition-name") === "match-element",
    );
    expect(named.length).toBe(Math.ceil(window.innerHeight / 40));
    expect(named.length).toBeLessThanOrEqual(LIST_BUDGET);
    expect(named[0]!.style.getPropertyValue("view-transition-class")).toBe(
      "pk-row",
    );
    fake.release();
    await handle.finished;
    await flush();
    expect(
      rows.some((r) => r.style.getPropertyValue("view-transition-name")),
    ).toBe(false);
  });

  it("reports an update's error without an unhandled rejection", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    try {
      const handle = viewTransition(() => {
        throw new Error("boom");
      });
      await expect(handle.updateCallbackDone).resolves.toBeUndefined();
      expect(reportError).toHaveBeenCalledWith(new Error("boom"));
      await expect(handle.finished).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

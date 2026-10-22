// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusRoute } from "../../src/ui/focusRoute.js";
import { lastAnnouncement } from "../../src/ui/LiveRegion.js";

const announced: string[] = [];
vi.mock("../../src/ui/LiveRegion.js", async (orig) => {
  const m = await orig<typeof import("../../src/ui/LiveRegion.js")>();
  return {
    ...m,
    announce: (t: string) => {
      announced.push(t);
      m.announce(t);
    },
  };
});

function html(s: string): void {
  document.body.innerHTML = s;
}

beforeEach(() => {
  vi.useFakeTimers();
  html("");
  announced.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("focusRoute", () => {
  it("focuses a heading that arrives late, then announces once", async () => {
    const p = focusRoute();
    await vi.advanceTimersByTimeAsync(200);
    html("<main><h1>Licenses</h1></main>");
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("focused");
    const h1 = document.querySelector("h1")!;
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(lastAnnouncement()).toBe("Licenses, page loaded");
    expect(announced).toEqual(["Licenses, page loaded"]);
  });

  it("uses title over the heading text, and [aria-level=1]", async () => {
    html("<div role='heading' aria-level='1'>x</div>");
    expect(await focusRoute({ title: "Devices" })).toBe("focused");
    expect(lastAnnouncement()).toBe("Devices, page loaded");
  });

  it("leaves focus alone while a dialog is open", async () => {
    html("<h1>Page</h1><div role='dialog'><button>ok</button></div>");
    const before = document.activeElement;
    expect(await focusRoute()).toBe("kept");
    expect(document.activeElement).toBe(before);
    expect(announced).toEqual([]);
  });

  it("waits for a closing overlay, and for a busy placeholder", async () => {
    html(
      "<h1>Page</h1><div role='dialog' data-state='closed'></div><div aria-busy='true'></div>",
    );
    const p = focusRoute();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.activeElement).toBe(document.body);
    document.querySelector("[role=dialog]")!.remove();
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).toBe(document.body);
    document.querySelector("[aria-busy]")!.remove();
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("focused");
    expect(document.activeElement?.tagName).toBe("H1");
  });

  it("does nothing once alive() turns false", async () => {
    let live = true;
    html("<div aria-busy='true'></div><h1>Page</h1>");
    const p = focusRoute({ alive: () => live });
    live = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("cancelled");
    expect(document.activeElement).toBe(document.body);
  });

  it("does not scroll", async () => {
    html("<h1>Page</h1>");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await focusRoute();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("announces once per call", async () => {
    html("<h1>Page</h1>");
    await focusRoute({ title: "A" });
    expect(lastAnnouncement()).toBe("A, page loaded");
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastAnnouncement()).toBe("A, page loaded");
    expect(announced).toEqual(["A, page loaded"]);
  });

  it("at the deadline focuses a heading despite a busy region, or gives up", async () => {
    html("<div aria-busy='true'></div><h1>Slow</h1>");
    const p = focusRoute({ deadline: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe("focused");
    html("<div aria-busy='true'></div>");
    const q = focusRoute({ deadline: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await q).toBe("timeout");
  });
});

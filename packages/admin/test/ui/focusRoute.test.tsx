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

  it("announces the heading's accessible name, not the passed title; [aria-level=1] counts", async () => {
    html("<div role='heading' aria-level='1'>Ada Lovelace</div>");
    expect(await focusRoute({ title: "License lic_1" })).toBe("focused");
    expect(lastAnnouncement()).toBe("Ada Lovelace, page loaded");
  });

  it("leaves decorative parts out of the name, and honours aria-label", async () => {
    html(
      "<h1>DJDL <span aria-hidden='true'>live</span> <span hidden>x</span><span class='sr-only'>product</span></h1>",
    );
    await focusRoute({ title: "Overview" });
    expect(lastAnnouncement()).toBe("DJDL product, page loaded");
    html("<h1 aria-label='Licence not found'>Not <b>found</b> 404</h1>");
    await focusRoute();
    expect(lastAnnouncement()).toBe("Licence not found, page loaded");
  });

  it("falls back to the title when the heading has no name", async () => {
    html("<h1><span aria-hidden='true'>x</span></h1>");
    await focusRoute({ title: "No access · Tiers" });
    expect(lastAnnouncement()).toBe("No access · Tiers, page loaded");
  });

  it("leaves focus alone while a dialog is open", async () => {
    html("<h1>Page</h1><div role='dialog'><button>ok</button></div>");
    const before = document.activeElement;
    expect(await focusRoute()).toBe("kept");
    expect(document.activeElement).toBe(before);
    expect(announced).toEqual([]);
  });

  it("waits for a closing overlay, and for a heading that is a loading placeholder", async () => {
    html(
      "<div role='dialog' data-state='closed'></div><div aria-busy='true'><h1>Loading</h1></div>",
    );
    const p = focusRoute();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.activeElement).toBe(document.body);
    document.querySelector("[role=dialog]")!.remove();
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).toBe(document.body);
    html("<h1>Real</h1>");
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("focused");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(announced).toEqual(["Real, page loaded"]);
  });

  it("does not wait for a busy panel when the heading is real", async () => {
    html("<h1>Account</h1><section aria-busy='true'>Loading</section>");
    expect(await focusRoute()).toBe("focused");
  });

  it("keeps a user's place: a control focused during the wait is not taken", async () => {
    html(
      "<button id='b'>go</button><div aria-busy='true'><h1>Loading</h1></div>",
    );
    const p = focusRoute();
    await vi.advanceTimersByTimeAsync(100);
    document.getElementById("b")!.focus();
    html("<button id='c'>other</button>");
    document.getElementById("c")!.focus();
    html("<button id='c'>other</button><h1>Real</h1>");
    document.getElementById("c")!.focus();
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("moved");
    expect(document.activeElement?.id).toBe("c");
    expect(announced).toEqual([]);
  });

  it("takes focus from the element that had it at the start, or one that was removed", async () => {
    html("<button id='b'>go</button><h1>Page</h1>");
    document.getElementById("b")!.focus();
    expect(await focusRoute()).toBe("focused");
    html("<button id='x'>x</button>");
    document.getElementById("x")!.focus();
    const p = focusRoute();
    html("<h1>Later</h1>");
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("focused");
  });

  it("does nothing once alive() turns false", async () => {
    let live = true;
    html("<div aria-busy='true'><h1>Page</h1></div>");
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
    expect(lastAnnouncement()).toBe("Page, page loaded");
    await vi.advanceTimersByTimeAsync(5000);
    expect(announced).toEqual(["Page, page loaded"]);
  });

  it("never focuses or announces a placeholder; it keeps waiting while alive, then ends silently", async () => {
    html("<div aria-busy='true'><h1>Loading</h1></div>");
    const p = focusRoute({ deadline: 300, alive: () => true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.activeElement).toBe(document.body);
    html("<h1>Slow</h1>");
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe("focused");
    expect(announced).toEqual(["Slow, page loaded"]);
    html("<div aria-busy='true'><h1>Loading</h1></div>");
    const q = focusRoute({ deadline: 300, alive: () => true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await q).toBe("timeout");
    expect(announced).toEqual(["Slow, page loaded"]);
    const r = focusRoute({ deadline: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await r).toBe("timeout");
  });

  it("the deadline releases a closing overlay's hold and reads performance.now, not Date", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    html("<h1>Slow</h1><div role='dialog' data-state='closed'></div>");
    const p = focusRoute({ deadline: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe("focused");
  });
});

// @pkey-feature ui.cli
// A window shrunk and then grown: what a live region does about the rows the terminal pulls back
// onto the screen above it. @xterm/headless keeps them in its scrollback, but VTE, WezTerm and
// others restore them, so the region's writes are checked against a terminal that does.

import { describe, expect, it } from "vitest";
import type { RailRow } from "../../src/cli/term/layout.js";
import { LiveRegion, type LiveHost } from "../../src/cli/term/live.js";

const ERASE = "\x1b[2K";
const count = (s: string, what: string) => s.split(what).length - 1;

function setup(cursor: (() => Promise<number | null>) | undefined) {
  const writes: string[] = [];
  let onResize: () => void = () => undefined;
  const out = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on: (_: string, fn: () => void) => {
      onResize = fn;
    },
    off: () => undefined,
  };
  const caps = { animate: true, rows: 24, columns: 80 };
  const row = (text: string, role?: "header"): RailRow => ({
    mark: "rail",
    spans: [{ text }],
    ...(role ? { role } : {}),
  });
  const screen: RailRow[] = [
    row("HEADER", "header"),
    ...Array.from({ length: 11 }, (_, i) => row(`body ${i}`)),
  ];
  const host: LiveHost = {
    caps,
    refreshSize: () => {
      caps.rows = out.rows;
    },
    render: (rows) => rows.map((r) => r.spans[0]!.text),
    fit: (rows) => {
      const lines = rows.map((r) => r.spans[0]!.text);
      const max = out.rows - 1;
      const cut = Math.max(0, lines.length - max);
      const head = rows.filter((r) => r.role === "header").length;
      return { lines: lines.slice(cut), head: Math.max(0, head - cut) };
    },
    ...(cursor ? { cursorRow: cursor } : {}),
  };
  const live = new LiveRegion(out as never, host);
  live.draw(screen);
  writes.length = 0;
  const resize = async (rows: number) => {
    out.rows = rows;
    onResize();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { live, writes, resize, out };
}

describe("a window shrunk and grown again", () => {
  it("erases the rows the terminal pulled back, with the region, and draws the whole flow with its header", async () => {
    const t = setup(async () => 4 + 11); // 4 rows came back above the 11-row region
    await t.resize(8); // 12 lines into 8 rows: 4 scroll away, the header with them
    expect(t.writes.join("")).not.toContain("HEADER");
    t.writes.length = 0;
    await t.resize(24);
    const w = t.writes;
    expect(w[0]).not.toContain("HEADER"); // the region first redraws where it is
    expect(w.at(-1)).toContain("HEADER");
    // The region (11 rows) and the 4 rows above it are erased before the whole flow is drawn.
    expect(count(w.at(-1)!, ERASE)).toBe(15);
    expect(w.at(-1)).toContain("body 10");
  });

  it("assumes the rows came back when the terminal does not answer", async () => {
    const t = setup(async () => null);
    await t.resize(8);
    t.writes.length = 0;
    await t.resize(24);
    expect(count(t.writes.at(-1)!, ERASE)).toBe(15);
    expect(t.writes.at(-1)).toContain("HEADER");
  });

  it("leaves rows alone that did not come back, and still draws the header the window has room for", async () => {
    const t = setup(async () => 11); // the region is at the top: nothing came back
    await t.resize(8);
    t.writes.length = 0;
    await t.resize(24);
    expect(count(t.writes.at(-1)!, ERASE)).toBe(11);
    expect(t.writes.at(-1)).toContain("HEADER");
  });

  it("draws nothing while it waits for the answer, then the latest screen", async () => {
    let answer: (n: number) => void = () => undefined;
    const t = setup(() => new Promise((r) => (answer = r)));
    await t.resize(8);
    t.writes.length = 0;
    await t.resize(24);
    t.writes.length = 0;
    t.live.draw([
      { mark: "rail", spans: [{ text: "NEWER" }], role: "header" },
      { mark: "rail", spans: [{ text: "line" }] },
    ]);
    expect(t.writes).toEqual([]);
    answer(15);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.writes.join("")).toContain("NEWER");
  });
});

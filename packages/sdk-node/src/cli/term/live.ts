// Lines that change in place: the braille spinner beside a waiting step, a countdown, a progress
// bar redrawn at most ten times a second (UI-KITS.md §4.8 "Terminal"). On a terminal that cannot
// animate (not a TTY, CI, TERM=dumb, reduced motion) the region prints its first frame once and
// then only what the flow commits, so a log reads as plain lines (SIGN-IN.md D-77). A region
// follows the terminal's size: it never draws taller than the screen, and a resize lays it out
// again (see LiveRegion).

import { TERMINAL_SPINNER } from "../tokens.generated.js";
import type { TerminalCaps, TerminalOutput } from "./caps.js";
import type { RailRow } from "./layout.js";
import type { Fitted } from "./screen.js";
import { cellWidth } from "./width.js";

/** The timer seam (tests pass a manual one). */
export interface Ticker {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTicker: Ticker = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

const ERASE_LINE = "\r\x1b[2K";
const UP = "\x1b[1A";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** A live screen: rail rows, or a function that builds them (called again on every redraw). */
export type Screen = readonly RailRow[] | (() => readonly RailRow[]);

/** What a live region needs from the flow's context. */
export interface LiveHost {
  caps: Pick<TerminalCaps, "animate" | "rows" | "columns">;
  /** Re-read the terminal's size into `caps` (a resize). */
  refreshSize(): void;
  /** Rail rows to lines at the current width, uncompacted. */
  render(rows: readonly RailRow[]): string[];
  /** Rail rows to lines that fit the terminal: compacted by tier, then cut from the top. */
  fit(rows: readonly RailRow[]): Fitted;
  /**
   * The cursor's row (1-based) from a cursor-position report (ESC [ 6 n), or null when the terminal
   * does not answer in time. Absent when the host cannot ask.
   */
  cursorRow?(): Promise<number | null>;
}

/** Rows `widths` take on a terminal `columns` cells wide (a line wider than that wraps). */
export function physicalRows(
  widths: readonly number[],
  columns: number | undefined,
): number {
  const c = columns && columns > 0 ? columns : Infinity;
  return widths.reduce((n, w) => n + Math.max(1, Math.ceil(w / c)), 0);
}

/** Erase `n` rows, ending with the cursor at the start of the first. */
function eraseRows(n: number): string {
  if (n <= 0) return "";
  let s = ERASE_LINE;
  for (let i = 1; i < n; i++) s += UP + ERASE_LINE;
  return s;
}

const widthsOf = (lines: readonly string[]) => lines.map((l) => cellWidth(l));
const rowsOf = (f: Screen): readonly RailRow[] =>
  typeof f === "function" ? f() : f;

/**
 * While a region hides the cursor, an interrupt or a termination must not leave the user's
 * terminal without one. Only on a real terminal, and only for the signals the host installed no
 * handler of its own for (then the default action, exiting, is kept: the cursor is restored first
 * and the exit code is 130 for SIGINT, 143 for SIGTERM).
 */
export function guardCursor(out: TerminalOutput): () => void {
  if (!out.isTTY || typeof process === "undefined") return () => undefined;
  const restore = () => {
    out.write(SHOW_CURSOR);
  };
  const ours: Array<[NodeJS.Signals, () => void]> = [];
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    if (process.listenerCount(signal) !== 0) continue;
    const on = () => {
      restore();
      process.exit(code);
    };
    process.once(signal, on);
    ours.push([signal, on]);
  }
  process.once("exit", restore);
  return () => {
    process.removeListener("exit", restore);
    for (const [signal, on] of ours) process.removeListener(signal, on);
  };
}

/**
 * A flow's whole screen, redrawn in place. The flow hands over its rail rows (header to key hints)
 * as a function; each draw lays them out spaced, compacts them to fit the terminal (screen.ts) and
 * replaces the previous frame, erased by the rows it really took on the (reflowed) screen.
 *
 * Nothing is written above the region while it is up, so there is no stale line left at an old
 * width: on a resize (SIGWINCH, the stream's `resize` event) the region re-reads the size, erases
 * what it drew, and lays the same screen out again at the new size, as a fresh launch would. Only
 * a screen that cannot fit even compacted loses its top lines from view.
 */
export class LiveRegion {
  private drawn: number[] = [];
  /** Leading drawn lines that are the flow's header. */
  private head = 0;
  /** A resize pushed the header into the scrollback: it is never drawn again. */
  private headerGone = false;
  private screen: Screen | null = null;
  private printedOnce = false;
  private hidden = false;
  private listening = false;
  private unguard: () => void = () => undefined;
  /** Rows of the flow that went into the terminal's scrollback and have not come back. */
  private gone = 0;
  /** Rows the window has grown by since the last cursor-position report was taken. */
  private growth = 0;
  /** The window's height at the last resize. */
  private rowsNow = Infinity;
  /** A cursor-position report is on its way: draws wait for it. */
  private probing = false;
  private again = false;
  private deferred = false;
  private epoch = 0;

  constructor(
    private readonly out: TerminalOutput,
    private readonly host: LiveHost,
  ) {}

  private erase(extra = 0): string {
    const s = eraseRows(physicalRows(this.drawn, this.out.columns) + extra);
    this.drawn = [];
    return s;
  }

  /**
   * The flow ends while a cursor-position report is still on its way: take the rows that came back
   * above the region from the growth of the window, and draw the header again.
   */
  private pendingRestore(): number {
    if (!this.probing || this.gone === 0) return 0;
    const above = Math.min(this.gone, this.growth);
    if (above > 0) this.headerGone = false;
    return above;
  }

  /** The screen's rows, without the header once it has scrolled into the scrollback. */
  private rows(screen: Screen): readonly RailRow[] {
    const rows = rowsOf(screen);
    return this.headerGone ? rows.filter((r) => r.role !== "header") : rows;
  }

  private paint(screen: Screen): string {
    const { lines, head } = this.host.fit(this.rows(screen));
    this.drawn = widthsOf(lines);
    this.head = head;
    return lines.join("\n");
  }

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    if (on) {
      this.rowsNow = this.out.rows ?? Infinity;
      this.out.on?.("resize", this.onResize);
    } else {
      const off = this.out.off ?? this.out.removeListener;
      off?.call(this.out, "resize", this.onResize);
    }
  }

  /** SIGWINCH: lay the whole screen out again at the new size. */
  private readonly onResize = (): void => {
    if (!this.host.caps.animate || this.screen === null) return;
    // The terminal reflowed what we drew. Rows beyond the new height went into its scrollback,
    // where they cannot be erased: if they included the header, it is not drawn again until they
    // come back (see `restore`).
    const reflowed = physicalRows(this.drawn, this.out.columns);
    const rows = this.out.rows ?? Infinity;
    const gone = Math.max(0, reflowed - rows);
    if (gone > 0 && this.head > 0) this.headerGone = true;
    this.gone += gone;
    const growth = rows - this.rowsNow;
    this.rowsNow = rows;
    const s = eraseRows(reflowed - gone);
    this.drawn = [];
    this.host.refreshSize();
    this.out.write(s + this.paint(this.screen));
    if (this.gone > 0 && growth > 0) {
      this.growth += growth;
      void this.probe();
    }
  };

  /**
   * A window that grew after it shrank: most terminals pull the rows that scrolled away back onto
   * the screen, above the region, where they now sit as a stale copy of the top of the flow. Ask
   * where the cursor is (the region ends at it), and the rows above the region's real top are the
   * ones that came back.
   */
  private async probe(): Promise<void> {
    if (this.probing) {
      this.again = true;
      return;
    }
    this.probing = true;
    const epoch = this.epoch;
    try {
      do {
        this.again = false;
        const row = (await this.host.cursorRow?.()) ?? null;
        if (epoch !== this.epoch || this.screen === null) return;
        if (this.again) continue;
        this.restore(row);
      } while (this.again);
    } finally {
      if (epoch === this.epoch) {
        this.probing = false;
        if (this.deferred && this.screen !== null) this.repaint(0);
      }
    }
  }

  private repaint(extra: number): void {
    this.deferred = false;
    if (this.screen === null) return;
    const s = this.erase(extra);
    this.out.write(s + this.paint(this.screen));
  }

  /** The rows that came back above the region are erased with it and the whole flow is drawn again. */
  private restore(row: number | null): void {
    const rows = this.out.rows ?? Infinity;
    const mine = Math.min(physicalRows(this.drawn, this.out.columns), rows);
    // Without an answer, assume the terminal restored as many rows as it grew by, up to the rows
    // that scrolled off.
    const room = row === null ? this.growth : Math.max(0, row - mine);
    const above = Math.min(this.gone, room);
    this.growth = 0;
    this.gone -= above;
    if (above > 0) this.headerGone = false;
    else if (this.headerGone && this.screen !== null) {
      // Nothing came back, but the window may now hold the header again.
      const full = this.host.fit(rowsOf(this.screen));
      if (full.head > 0) this.headerGone = false;
      else if (!this.deferred) return;
    } else if (!this.deferred) return;
    this.repaint(above);
  }

  /** Show `screen` in place of the previous one. */
  draw(screen: Screen): void {
    if (!this.host.caps.animate) {
      const lines = this.host.render(rowsOf(screen));
      if (!this.printedOnce && lines.length)
        this.out.write(`${lines.join("\n")}\n`);
      this.printedOnce = true;
      return;
    }
    this.screen = screen;
    if (this.probing) {
      this.deferred = true;
      return;
    }
    let s = this.erase();
    if (!this.hidden) {
      s = HIDE_CURSOR + s;
      this.hidden = true;
      this.unguard = guardCursor(this.out);
    }
    this.listen(true);
    this.out.write(s + this.paint(screen));
  }

  private stop(): string {
    const show = this.hidden ? SHOW_CURSOR : "";
    this.hidden = false;
    this.unguard();
    this.unguard = () => undefined;
    this.listen(false);
    this.screen = null;
    this.headerGone = false;
    this.head = 0;
    this.gone = 0;
    this.growth = 0;
    this.epoch++;
    this.probing = false;
    this.deferred = false;
    return show;
  }

  /**
   * Replace the region with its final screen (it stays) and stop. Without animation the first
   * frame was already printed once, so only `plain` (the result, no header) prints.
   */
  commit(screen: Screen = [], plain?: Screen): void {
    const animate = this.host.caps.animate;
    const extra = this.pendingRestore();
    const rows =
      animate || plain === undefined ? this.rows(screen) : rowsOf(plain);
    const s = animate ? this.erase(extra) : "";
    const show = this.stop();
    // The result is printed whole: a result taller than the window scrolls (its header and title
    // stay in the scrollback), never cut.
    const lines = this.host.render(rows);
    this.out.write(`${s}${lines.length ? `${lines.join("\n")}\n` : ""}${show}`);
    this.printedOnce = false;
  }

  /** Clear the region without printing (Ctrl-C, an error path). */
  close(): void {
    const extra = this.pendingRestore();
    const s = this.host.caps.animate ? this.erase(extra) : "";
    const show = this.stop();
    if (s || show) this.out.write(s + show);
  }
}

/** The spinner frames for a symbol set. */
export function spinnerFrames(unicode: boolean): readonly string[] {
  return unicode ? TERMINAL_SPINNER.unicode : TERMINAL_SPINNER.ascii;
}

/**
 * Call `render(frame)` now and every 80 ms while the terminal animates. Returns a stop function.
 * Without animation `render` runs once, with frame 0.
 */
export function animate(
  caps: Pick<TerminalCaps, "animate">,
  render: (frame: number) => void,
  ticker: Ticker = realTicker,
  frameMs: number = TERMINAL_SPINNER.frameMs,
): () => void {
  let frame = 0;
  render(frame);
  if (!caps.animate) return () => undefined;
  const h = ticker.setInterval(() => render(++frame), frameMs);
  return () => ticker.clearInterval(h);
}

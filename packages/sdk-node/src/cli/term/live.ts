// Lines that change in place: the braille spinner beside a waiting step, a countdown, a progress
// bar redrawn at most ten times a second (UI-KITS.md §4.8 "Terminal"). On a terminal that cannot
// animate (not a TTY, CI, TERM=dumb, reduced motion) the region prints its first frame once and
// then only what the flow commits, so a log reads as plain lines (SIGN-IN.md D-77). A region
// follows the terminal's size: it never draws taller than the screen, and a resize lays it out
// again (see LiveRegion).

import { TERMINAL_SPINNER } from "../tokens.generated.js";
import type { TerminalCaps, TerminalOutput } from "./caps.js";
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

/** The region's lines, or a function that draws them at the terminal's current size. */
export type Frame = readonly string[] | (() => readonly string[]);

/** Lines a flow printed above its live region, kept so a resize can lay them out again. */
export interface PrintedBlock {
  /** The lines as they were last drawn. */
  lines: readonly string[];
  /** Their cell widths, as drawn. */
  widths: number[];
  /** The same lines at the terminal's current size, or null: they are reprinted as they were. */
  redraw: (() => readonly string[]) | null;
  /** The region that printed these lines above itself because its frame was taller than the screen. */
  owner?: LiveRegion;
}

/** What a live region shares with the flow that owns it (the kit context). */
export interface LiveHost {
  /** Re-read the terminal's size into the caps the flow lays its lines out with. */
  refreshSize(): void;
  /** Everything the flow has printed so far, oldest first; a region adds its committed lines. */
  readonly printed: PrintedBlock[];
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
const linesOf = (f: Frame) => (typeof f === "function" ? f() : f);

/**
 * While a region hides the cursor, an interrupt must not leave the user's terminal without one.
 * Only on a real terminal, and only when the host installed no SIGINT handler of its own (then
 * the default action, exiting, is kept: the cursor is restored first and the exit code is 130).
 */
function guardCursor(out: TerminalOutput): () => void {
  if (!out.isTTY || typeof process === "undefined") return () => undefined;
  const restore = () => {
    out.write(SHOW_CURSOR);
  };
  const ownSigint = process.listenerCount("SIGINT") === 0;
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  process.once("exit", restore);
  if (ownSigint) process.once("SIGINT", onSigint);
  return () => {
    process.removeListener("exit", restore);
    if (ownSigint) process.removeListener("SIGINT", onSigint);
  };
}

/**
 * Lines redrawn in place. Each frame replaces the last, erased by the rows it really took on the
 * screen (a line wider than the terminal wraps, so it takes more than one).
 *
 * A frame taller than the terminal does not fit: the lines at its top that do not fit are printed
 * once above the region and scroll away with the scrollback (the product header first), so the
 * rows that matter, at the bottom (the code, the URL, the keys), stay in view and redraw cleanly.
 *
 * On a resize (SIGWINCH: the stream's `resize` event) the region re-reads the size, erases what it
 * drew by the rows that now take on the reflowed screen, and draws its frame again at the new
 * width. When the flow's earlier lines are all still on the screen they are laid out again too, so
 * narrowing a terminal mid-flow never leaves a line wider than it, a duplicate header or a stack
 * of half-erased progress bars.
 */
export class LiveRegion {
  private drawn: number[] = [];
  private frame: Frame | null = null;
  /** Lines at the top of the current frame already printed above the region. */
  private head = 0;
  private printedOnce = false;
  private hidden = false;
  private listening = false;
  private unguard: () => void = () => undefined;

  constructor(
    private readonly out: TerminalOutput,
    private readonly caps: Pick<TerminalCaps, "animate"> &
      Partial<Pick<TerminalCaps, "rows">>,
    private readonly host?: LiveHost,
  ) {}

  private get columns(): number | undefined {
    return this.out.columns;
  }

  private get rows(): number {
    return this.caps.rows ?? this.out.rows ?? Infinity;
  }

  private erase(): string {
    const s = eraseRows(physicalRows(this.drawn, this.columns));
    this.drawn = [];
    return s;
  }

  /** The frame's lines from `head` on, printing any that do not fit above the region. */
  private place(lines: readonly string[]): string {
    const widths = widthsOf(lines);
    let start = Math.min(this.head, lines.length);
    while (
      start < lines.length - 1 &&
      physicalRows(widths.slice(start), this.columns) > this.rows
    )
      start++;
    let s = "";
    if (start > this.head) {
      const fixed = lines.slice(this.head, start);
      s += `${fixed.join("\n")}\n`;
      this.host?.printed.push({
        lines: fixed,
        widths: widths.slice(this.head, start),
        redraw: null,
        owner: this,
      });
      this.head = start;
    }
    s += lines.slice(start).join("\n");
    this.drawn = widths.slice(start);
    return s;
  }

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    if (on) this.out.on?.("resize", this.onResize);
    else {
      const off = this.out.off ?? this.out.removeListener;
      off?.call(this.out, "resize", this.onResize);
    }
  }

  /** SIGWINCH: lay the region (and the flow's lines above it, when they are all on the screen) out again. */
  private readonly onResize = (): void => {
    if (!this.caps.animate || this.frame === null) return;
    this.host?.refreshSize();
    const region = physicalRows(this.drawn, this.columns);
    const printed = this.host?.printed ?? [];
    const above = printed.reduce(
      (n, b) => n + physicalRows(b.widths, this.columns),
      0,
    );
    let s: string;
    if (printed.length > 0 && above + region <= this.rows) {
      s = eraseRows(above + region);
      // This region's own overflow lines are part of its frame: drawn again with it below.
      for (let i = printed.length - 1; i >= 0; i--)
        if (printed[i]!.owner === this) printed.splice(i, 1);
      this.head = 0;
      for (const b of printed) {
        if (b.redraw) {
          b.lines = b.redraw();
          b.widths = widthsOf(b.lines);
        }
        if (b.lines.length) s += `${b.lines.join("\n")}\n`;
      }
    } else s = eraseRows(region);
    this.drawn = [];
    s += this.place(linesOf(this.frame));
    this.out.write(s);
  };

  /** Show `frame` in place of the previous one. */
  draw(frame: Frame): void {
    if (!this.caps.animate) {
      const lines = linesOf(frame);
      if (!this.printedOnce && lines.length)
        this.out.write(`${lines.join("\n")}\n`);
      this.printedOnce = true;
      return;
    }
    this.frame = frame;
    let s = this.erase();
    if (!this.hidden) {
      s = HIDE_CURSOR + s;
      this.hidden = true;
      this.unguard = guardCursor(this.out);
    }
    this.listen(true);
    s += this.place(linesOf(frame));
    this.out.write(s);
  }

  /** Print lines above the region (they stay), then redraw nothing until the next draw. */
  print(frame: Frame): void {
    const lines = linesOf(frame);
    const s = this.caps.animate ? this.erase() : "";
    this.out.write(`${s}${lines.join("\n")}\n`);
    this.keep(frame, lines);
    this.printedOnce = false;
  }

  private keep(frame: Frame, lines: readonly string[]): void {
    if (lines.length)
      this.host?.printed.push({
        lines,
        widths: widthsOf(lines),
        redraw: typeof frame === "function" ? frame : null,
      });
  }

  private stop(): string {
    const show = this.hidden ? SHOW_CURSOR : "";
    this.hidden = false;
    this.unguard();
    this.unguard = () => undefined;
    this.listen(false);
    this.frame = null;
    this.head = 0;
    return show;
  }

  /** Replace the region with its final lines and stop. */
  commit(frame: Frame = []): void {
    const lines = linesOf(frame);
    const s = this.caps.animate ? this.erase() : "";
    const show = this.stop();
    this.out.write(`${s}${lines.length ? `${lines.join("\n")}\n` : ""}${show}`);
    this.keep(frame, lines);
    this.printedOnce = false;
  }

  /** Clear the region without printing (Ctrl-C, an error path). */
  close(): void {
    const s = this.caps.animate ? this.erase() : "";
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

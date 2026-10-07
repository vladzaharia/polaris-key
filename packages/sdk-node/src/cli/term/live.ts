// Lines that change in place: the braille spinner beside a waiting step, a countdown, a progress
// bar redrawn at most ten times a second (UI-KITS.md §4.8 "Terminal"). On a terminal that cannot
// animate (not a TTY, CI, TERM=dumb, reduced motion) the region prints its first frame once and
// then only what the flow commits, so a log reads as plain lines (SIGN-IN.md D-77).

import { TERMINAL_SPINNER } from "../tokens.generated.js";
import type { TerminalCaps, TerminalOutput } from "./caps.js";

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

export class LiveRegion {
  private drawn = 0;
  private printedOnce = false;
  private hidden = false;
  private unguard: () => void = () => undefined;

  constructor(
    private readonly out: TerminalOutput,
    private readonly caps: Pick<TerminalCaps, "animate">,
  ) {}

  private erase(): string {
    if (this.drawn === 0) return "";
    let s = ERASE_LINE;
    for (let i = 1; i < this.drawn; i++) s += UP + ERASE_LINE;
    this.drawn = 0;
    return s;
  }

  /** Show `lines` in place of the previous frame. */
  draw(lines: readonly string[]): void {
    if (!this.caps.animate) {
      if (!this.printedOnce && lines.length)
        this.out.write(`${lines.join("\n")}\n`);
      this.printedOnce = true;
      return;
    }
    let s = this.erase();
    if (!this.hidden) {
      s = HIDE_CURSOR + s;
      this.hidden = true;
      this.unguard = guardCursor(this.out);
    }
    s += lines.join("\n");
    this.drawn = lines.length;
    this.out.write(s);
  }

  /** Print lines above the region (they stay), then redraw nothing until the next draw. */
  print(lines: readonly string[]): void {
    const s = this.caps.animate ? this.erase() : "";
    this.out.write(`${s}${lines.join("\n")}\n`);
    this.printedOnce = false;
  }

  /** Replace the region with its final lines and stop. */
  commit(lines: readonly string[]): void {
    const s = this.caps.animate ? this.erase() : "";
    const show = this.hidden ? SHOW_CURSOR : "";
    this.hidden = false;
    this.unguard();
    this.unguard = () => undefined;
    this.out.write(`${s}${lines.length ? `${lines.join("\n")}\n` : ""}${show}`);
    this.printedOnce = false;
  }

  /** Clear the region without printing (Ctrl-C, an error path). */
  close(): void {
    const s = this.caps.animate ? this.erase() : "";
    const show = this.hidden ? SHOW_CURSOR : "";
    this.hidden = false;
    this.unguard();
    this.unguard = () => undefined;
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

/**
 * `pkey`'s terminal look (UK-14; docs/design/UI-KITS.md §1.4 "Terminal"): the same primitives the
 * Node SDK's CLI kit draws with, from `@polaris-key/node/terminal` and nothing else of the kit (its
 * copy catalog stays out of the Action bundle; pkey's words are English and live in this package).
 *
 *   colour     ANSI-16 roles through `util.styleText`, only when the stream is a colour terminal:
 *              NO_COLOR, `--no-color`, TERM=dumb and a pipe give plain text; FORCE_COLOR forces it.
 *   symbols    ✓ ✗ ▲ and the braille spinner; ASCII under TERM=dumb, `--ascii` or PKEY_ASCII=1.
 *   spinner    long stages (`pkey release publish`, `pkey listing assets`) draw one line on STDERR,
 *              only when stderr is a terminal and never under CI; stdout is never touched, and
 *              every write the command makes erases the line first, so nothing interleaves.
 */

import {
  animate,
  cellWidth,
  detectTerminal,
  layoutColumns,
  LiveRegion,
  Painter,
  progressSpans,
  realTicker,
  spinnerFrames,
  symbolsFor,
  truncateEnd,
  type Line,
  type RailRow,
  type Symbols,
  type TerminalCaps,
  type Ticker,
} from "@polaris-key/node/terminal";
import type { Out, StageProgress } from "./ci.js";

/** A stream pkey writes to: Node's stdout or stderr, or a test's fake with the same fields. */
export type TermOut = Out & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

export type TermEnv = Readonly<Record<string, string | undefined>>;

/** The flags every command takes (stripped before the command's own parse, `index.ts`). */
export interface TermFlags {
  /** `--color` (true) or `--no-color` (false); undefined follows the environment. */
  color?: boolean;
  /** `--ascii`. */
  ascii?: boolean;
}

/** What one stream can draw: its capabilities, the role painter and the symbol set. */
export interface Term {
  caps: TerminalCaps;
  painter: Painter;
  symbols: Symbols;
}

/**
 * The terminal behind `out`. pkey has no product accent, so the painter is the ink one: the
 * `accent` role draws as `strong` (UI-KITS §1.2 step 3).
 */
export function termFor(
  out: TermOut,
  env: TermEnv,
  flags: TermFlags = {},
): Term {
  const caps = detectTerminal({ env, stdout: out, flags });
  return {
    caps,
    painter: new Painter(caps, null, {}, true),
    symbols: symbolsFor(caps),
  };
}

/** The width of a progress bar beside a spinner label. */
const BAR_WIDTH = 20;

/**
 * The spinner a long command reports its stages to (`StageProgress`). It draws only when stderr
 * animates (a terminal, not CI, not TERM=dumb, not reduced motion); otherwise every call is a
 * no-op, so a CI log and a pipe read exactly as they did.
 */
export class Spinner implements StageProgress {
  private readonly term: Term;
  private readonly region: LiveRegion | null;
  private label = "";
  private done = 0;
  private total = 0;
  private frame = 0;
  private stopTicking: (() => void) | null = null;
  /** False while the last write through `wrap` left the cursor mid-line. */
  private atLineStart = true;

  constructor(
    err: TermOut,
    env: TermEnv,
    flags: TermFlags = {},
    private readonly ticker: Ticker = realTicker,
  ) {
    this.term = termFor(err, env, flags);
    const caps = this.term.caps;
    // The spinner's line is already styled text, so the region's host passes it through as is.
    const render = (rows: readonly RailRow[]) =>
      rows.map((r) => r.spans.map((x) => x.text).join(""));
    this.region = caps.animate
      ? new LiveRegion(err, {
          caps,
          refreshSize: () => {
            if (err.columns) caps.columns = layoutColumns(err.columns);
            if (err.rows) caps.rows = err.rows;
          },
          render,
          fit: (rows) => ({ lines: render(rows), head: 0 }),
        })
      : null;
  }

  /** Whether this spinner draws at all. */
  get active(): boolean {
    return this.region !== null;
  }

  stage(label: string): void {
    if (!this.region) return;
    this.label = label;
    this.done = 0;
    this.total = 0;
    if (!label) {
      this.region.close();
      return;
    }
    if (!this.stopTicking)
      this.stopTicking = animate(
        this.term.caps,
        (frame) => {
          this.frame = frame;
          this.draw();
        },
        this.ticker,
      );
    else this.draw();
  }

  advance(done: number, total: number): void {
    if (!this.region) return;
    this.done = done;
    this.total = total;
    this.draw();
  }

  /** Stop ticking and erase the line (call it in a `finally`). */
  stop(): void {
    this.stopTicking?.();
    this.stopTicking = null;
    this.label = "";
    this.region?.close();
  }

  /**
   * `out`, erasing the spinner before each write so a command's own lines never land beside it;
   * the next frame draws the spinner again below them. Off a terminal `out` comes back as is.
   */
  wrap(out: TermOut): TermOut {
    const region = this.region;
    if (!region) return out;
    const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      region.close();
      if (typeof chunk === "string" && chunk.length > 0)
        this.atLineStart = chunk.endsWith("\n");
      return (out.write as (c: unknown, ...r: unknown[]) => boolean)(
        chunk,
        ...rest,
      );
    };
    return {
      write: write as TermOut["write"],
      isTTY: out.isTTY,
      columns: out.columns,
      rows: out.rows,
    };
  }

  private draw(): void {
    if (!this.region || !this.label || !this.atLineStart) return;
    this.region.draw(() => [{ mark: "none", spans: [{ text: this.line() }] }]);
  }

  /** One line, never wider than the terminal (a wrapped line would break the redraw). */
  private line(): string {
    const { painter, symbols, caps } = this.term;
    const frames = spinnerFrames(caps.unicode);
    const glyph = painter.style(frames[this.frame % frames.length]!, ["muted"]);
    const max = Math.max(10, caps.columns - 1);
    const counted = this.total > 0;
    const count = counted ? `${this.done}/${this.total}` : "";
    // glyph + gap + label [+ gap + bar + space + count]
    const withBar = 3 + 2 + BAR_WIDTH + 1 + cellWidth(count);
    const withCount = 3 + 2 + cellWidth(count);
    if (counted && cellWidth(this.label) + withBar <= max) {
      const bar: Line = progressSpans(
        this.done / this.total,
        symbols,
        BAR_WIDTH,
      );
      return `${glyph}  ${this.label}  ${painter.line(bar)} ${painter.style(count, ["muted"])}`;
    }
    if (counted) {
      const label = truncateEnd(
        this.label,
        Math.max(1, max - withCount),
        symbols.ellipsis,
      );
      return `${glyph}  ${label}  ${painter.style(count, ["muted"])}`;
    }
    return `${glyph}  ${truncateEnd(this.label, max - 3, symbols.ellipsis)}`;
  }
}

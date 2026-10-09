// The rail layout every flow draws (UI-KITS.md §1.4 "Layout", the terminal board): one gutter
// cell for the mark, two cells of gap, then the content, with a continuous rail down the left on
// every line of a flow. 80 columns, degrading to the terminal's width; a long line wraps under its
// own content column, never back under the rail.
//
//   ┌  Tidewater Studio  · activate          start
//   │                                         rail
//   ◆  License key                            active step
//   ◇  License key · pkey_tidewater_••••••    done step
//   ▲  Your license is on 3 of 3 devices      warning   (✓ ok, ✗ fail)
//   └  Enter activate · Esc cancel            end

import {
  TERMINAL_LAYOUT,
  TERMINAL_SYMBOLS,
  type TerminalSymbol,
} from "../tokens.generated.js";
import { MIN_LAYOUT_COLUMNS, type TerminalCaps } from "./caps.js";
import type { Painter } from "./paint.js";
import { cellWidth, wrapSpans, type Line, type Span } from "./width.js";

export type Symbols = Readonly<Record<TerminalSymbol, string>>;

/** The symbol set for a terminal: Unicode, or ASCII under TERM=dumb and --ascii. */
export function symbolsFor(caps: Pick<TerminalCaps, "unicode">): Symbols {
  return caps.unicode ? TERMINAL_SYMBOLS.unicode : TERMINAL_SYMBOLS.ascii;
}

/** The gutter mark of one rail row. */
export type Mark =
  | "start"
  | "rail"
  | "active"
  | "done"
  | "ok"
  | "fail"
  | "warn"
  | "end"
  /** No rail: a line printed outside a flow. */
  | "none"
  /** A spinner frame or any other one-cell glyph, in the muted role. */
  | { glyph: string; style?: readonly string[] };

export interface RailRow {
  mark: Mark;
  spans: Line;
  /**
   * Compaction tier for a live screen taller than the terminal (see `fitScreen`): the row is
   * dropped at this tier when the screen does not fit, lowest first. `undefined` means the row is
   * never dropped (the URL line, the code, the key hints).
   */
  drop?: number;
  /**
   * Never dropped, and a screen that is still too tall after compaction loses its other rows first
   * (the header, the lead-in, the waiting line): the URL line, the code and the key hints stay.
   */
  keep?: boolean;
  /**
   * `spinner` marks the waiting line that the key hints merge onto first; `hints` marks the hints
   * row that merges; `header` marks the flow's header rows, which a live region leaves out once a
   * resize has pushed them into the terminal's scrollback (they cannot be erased, and are never
   * printed a second time).
   */
  role?: "spinner" | "hints" | "header";
}

/** The compaction tiers a live screen drops in order when it is taller than the terminal. */
export const DROP = {
  /** Blank rail rows between prose blocks. */
  blankProse: 2,
  /** The "Check the code there matches this one." line. */
  checkLine: 3,
  /** The blank rail rows around the code chip. */
  blankCode: 4,
  /** The "Code expires in" countdown line. */
  countdown: 5,
} as const;

const MARKS: Record<
  Exclude<Mark, "none" | { glyph: string }>,
  { symbol: TerminalSymbol; style: string[] }
> = {
  start: { symbol: "railStart", style: ["muted"] },
  rail: { symbol: "rail", style: ["muted"] },
  active: { symbol: "stepActive", style: ["accent"] },
  done: { symbol: "stepDone", style: ["muted"] },
  ok: { symbol: "ok", style: ["success"] },
  fail: { symbol: "fail", style: ["danger"] },
  warn: { symbol: "warn", style: ["warning"] },
  end: { symbol: "railEnd", style: ["muted"] },
};

/** Cells between the mark and the content. */
export const GUTTER = TERMINAL_LAYOUT.gutter;

/** A layout too narrow for the rail: it is dropped and the content takes the whole line. */
export function isNarrow(columns: number): boolean {
  return columns < MIN_LAYOUT_COLUMNS;
}

/** Cells the content may use on a rail line of a `columns`-wide layout. */
export function contentWidth(columns: number): number {
  return isNarrow(columns) ? Math.max(5, columns) : columns - 1 - GUTTER;
}

function markGlyph(
  mark: Mark,
  symbols: Symbols,
  painter: Painter,
): { first: string; next: string } {
  const rail = painter.style(symbols.rail, ["muted"]);
  if (mark === "none") return { first: "", next: "" };
  if (typeof mark === "object") {
    const g = painter.style(mark.glyph, mark.style ?? ["muted"]);
    return { first: g, next: rail };
  }
  const m = MARKS[mark];
  const glyph = painter.style(symbols[m.symbol], m.style);
  // Nothing continues below the end mark; the start continues as the rail.
  return { first: glyph, next: mark === "end" ? " " : rail };
}

/**
 * End the rail on the last content row: a bare `end` row under a row on the rail is dropped and
 * that row's last line takes the end mark instead, so no empty `└` row hangs below the content.
 * Under a row with a mark of its own (a ✓ result, a status line) the bare `end` row has nothing
 * to close and is dropped.
 */
export function closeRail(rows: readonly RailRow[]): RailRow[] {
  const out = [...rows];
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  if (last?.mark === "end" && last.spans.length === 0 && prev?.spans.length) {
    if (prev.mark === "rail")
      out.splice(out.length - 2, 2, { ...prev, mark: "end" });
    else if (
      prev.mark === "ok" ||
      prev.mark === "fail" ||
      prev.mark === "warn" ||
      prev.mark === "done" ||
      prev.mark === "active"
    )
      out.pop();
  }
  return out;
}

/** What `railLines` can report about the lines it wrote, one entry per line. */
export interface LineMeta {
  /**
   * The line must stay when the screen is too tall: a kept row's lines, except the words around a
   * URL or a code that wrap onto lines of their own (the URL's pieces stay, the prose goes first).
   */
  keep: boolean[];
  /** The line belongs to a header row. */
  header: boolean[];
}

/** Render rail rows to lines: each row wraps under its content column. */
export function railLines(
  rows: readonly RailRow[],
  painter: Painter,
  symbols: Symbols,
  columns: number,
  meta?: LineMeta,
): string[] {
  const out: string[] = [];
  const gap = " ".repeat(GUTTER);
  const narrow = isNarrow(columns);
  for (const row of closeRail(rows)) {
    const { first, next } = markGlyph(row.mark, symbols, painter);
    const noRail = row.mark === "none" || narrow;
    // A narrow step keeps its mark and a space on its first line, and hangs under it.
    const marked =
      narrow &&
      row.mark !== "none" &&
      row.mark !== "rail" &&
      row.mark !== "start" &&
      row.mark !== "end";
    const width = marked
      ? Math.max(5, contentWidth(columns) - 2)
      : contentWidth(columns);
    const wrapped = row.spans.length
      ? wrapSpans(row.spans, width, symbols.ellipsis)
      : [[]];
    const rail = painter.style(symbols.rail, ["muted"]);
    const hasBreak = row.spans.some((sp) => sp.break !== undefined);
    wrapped.forEach((line, i) => {
      meta?.keep.push(
        row.keep === true && (!hasBreak || line.some((sp) => sp.break)),
      );
      meta?.header.push(row.role === "header");
      // The end mark closes the rail on the row's last line only; a closing line that wraps keeps
      // the rail on every line above it.
      const last = i === wrapped.length - 1;
      const glyph =
        row.mark === "end" ? (last ? first : rail) : i === 0 ? first : next;
      const body = painter.line(line);
      if (narrow && row.mark !== "none") {
        // No rail on a narrow line: a step keeps its mark (✓ ✗ ▲ or the spinner) on its first line.
        out.push(marked && body ? `${i === 0 ? first : " "} ${body}` : body);
      } else if (noRail) out.push(body);
      else out.push(body ? `${glyph}${gap}${body}` : glyph);
    });
  }
  return out;
}

/**
 * Key hints in the catalog's form, `<key> <action> · <key> <action>` (signin.cli.keys): each
 * key in `strong` and each action in `muted`, everywhere (UI-KITS §1.5 rule 13).
 */
export function keyHints(text: string, symbols: Symbols): Line {
  // The catalog writes " · "; in ASCII mode the copy already reads " - ".
  const sepRe = symbols.separator === "·" ? /\s+·\s+/ : /\s+[·-]\s+/;
  const segments = text.split(sepRe);
  const spans: Span[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) spans.push({ text: ` ${symbols.separator} `, style: ["muted"] });
    const m = /^(\S+)(\s+)([\s\S]*)$/.exec(seg);
    if (!m) {
      spans.push({ text: seg, style: ["strong"] });
      return;
    }
    // A key and its label move together ("Esc cancel"), and wrap at the label's spaces only when
    // the pair is wider than the line.
    spans.push({ text: m[1]!, style: ["strong"], keep: true, unit: true });
    spans.push({ text: `${m[2]}${m[3]}`, style: ["muted"], unit: true });
  });
  return spans;
}

/** A catalog string whose separators are "·" in the symbol set's spelling. */
export function separated(text: string, symbols: Symbols): string {
  return symbols.separator === "·"
    ? text
    : text.replace(/ · /g, ` ${symbols.separator} `);
}

/** Two columns: labels padded to the widest, then the values (status rows, help). */
export function columnsOf(
  rows: ReadonlyArray<{ label: Line; value: Line }>,
  gap = 2,
): Line[] {
  const w = Math.max(
    0,
    ...rows.map((r) => cellWidth(r.label.map((s) => s.text).join(""))),
  );
  return rows.map((r) => {
    const lw = cellWidth(r.label.map((s) => s.text).join(""));
    return [...r.label, { text: " ".repeat(w - lw + gap) }, ...r.value];
  });
}

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
import type { TerminalCaps } from "./caps.js";
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
}

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

/** Cells the content may use on a rail line of a `columns`-wide layout. */
export function contentWidth(columns: number): number {
  return Math.max(10, columns - 1 - GUTTER);
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

/** Render rail rows to lines: each row wraps under its content column. */
export function railLines(
  rows: readonly RailRow[],
  painter: Painter,
  symbols: Symbols,
  columns: number,
): string[] {
  const out: string[] = [];
  const gap = " ".repeat(GUTTER);
  for (const row of rows) {
    const { first, next } = markGlyph(row.mark, symbols, painter);
    const noRail = row.mark === "none";
    const width = noRail ? columns : contentWidth(columns);
    const wrapped = row.spans.length
      ? wrapSpans(row.spans, width, symbols.ellipsis)
      : [[]];
    wrapped.forEach((line, i) => {
      const glyph = i === 0 ? first : next;
      const body = painter.line(line);
      if (noRail) out.push(body);
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
    spans.push({ text: m[1]!, style: ["strong"], keep: true });
    spans.push({ text: `${m[2]}${m[3]}`, style: ["muted"] });
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

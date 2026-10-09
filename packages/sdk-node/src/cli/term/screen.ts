// Fitting a live screen to the terminal (docs/design/UI-KITS.md §1.4 Terminal). A live flow draws
// its whole screen (header to key hints) as one list of rail rows, laid out spaced first. When that
// is taller than the terminal (less one row for the cursor), it compacts in a fixed order and stops
// as soon as it fits:
//
//   1. the key hints join the spinner line, when the joined line fits the width;
//   2. the blank rows between prose blocks go (tier DROP.blankProse);
//   3. the "Check the code there matches" line goes;
//   4. the blank rows around the code chip go;
//   5. the "Code expires in" line goes;
//   6. whatever is still too tall loses its top lines (the header and the lead-in) from view.
//
// The URL line, the code and the key hints are never dropped. Printed output (status, devices,
// offline) is never compacted: it scrolls.

import { contentWidth, type LineMeta, type RailRow } from "./layout.js";
import { cellWidth, type Span } from "./width.js";

const widthOf = (spans: readonly Span[]) =>
  cellWidth(
    spans
      .map((s) => s.text)
      .join("")
      .trimEnd(),
  );

/** Merge the hints row onto the spinner row when the joined line fits `columns`. */
export function inlineHints(
  rows: readonly RailRow[],
  columns: number,
  separator: string,
): RailRow[] {
  const h = rows.findIndex((r) => r.role === "hints");
  const s = rows.findIndex((r) => r.role === "spinner");
  if (h < 0 || s < 0) return [...rows];
  const joined = [
    ...rows[s]!.spans,
    { text: ` ${separator} `, style: ["muted"] },
    ...rows[h]!.spans,
  ];
  if (widthOf(joined) > contentWidth(columns)) return [...rows];
  return rows
    .map((r, i) => (i === s ? { ...r, spans: joined, keep: true } : r))
    .filter((_, i) => i !== h);
}

export interface FitOptions {
  /** Lines the screen may take: the terminal's rows less one for the cursor. */
  maxRows: number;
  columns: number;
  separator: string;
  /** `density: "spacious"` keeps every blank row whenever the screen fits. */
  render(rows: readonly RailRow[], meta?: LineMeta): string[];
}

/** The lines that fit, and how many of the leading ones are the flow's header. */
export interface Fitted {
  lines: string[];
  /** Leading lines that belong to header rows (0 once the top lines were cut). */
  head: number;
}

/**
 * The lines of `rows` that fit: spaced if they fit, else compacted in the tier order, else with the
 * top lines cut. Never taller than `maxRows` unless it is a single line.
 */
export function fitScreen(rows: readonly RailRow[], o: FitOptions): Fitted {
  const max = Math.max(1, o.maxRows);
  const headOf = (r: readonly RailRow[], cut = 0) => {
    let n = 0;
    while (n < r.length && r[n]!.role === "header") n++;
    return Math.max(0, (n ? o.render(r.slice(0, n)).length : 0) - cut);
  };
  let lines = o.render(rows);
  if (lines.length <= max) return { lines, head: headOf(rows) };
  let cur = inlineHints(rows, o.columns, o.separator);
  lines = o.render(cur);
  const tiers = [
    ...new Set(
      cur.map((r) => r.drop).filter((d): d is number => d !== undefined),
    ),
  ].sort((a, b) => a - b);
  for (const t of tiers) {
    if (lines.length <= max) break;
    cur = cur.filter((r) => r.drop !== t);
    lines = o.render(cur);
  }
  // Still too tall: the rows that are not essential leave from the top (the header, the lead-in,
  // the waiting line), one at a time; the URL line, the code and the key hints stay.
  while (lines.length > max) {
    const i = cur.findIndex((r) => !r.keep);
    if (i < 0) break;
    cur = cur.filter((_, j) => j !== i);
    lines = o.render(cur);
  }
  // Still too tall: a kept row that wraps (a URL inside its sentence) gives up the lines that are
  // only words, from the top, before any piece of the URL goes.
  const meta: LineMeta = { keep: [], header: [] };
  lines = o.render(cur, meta);
  while (lines.length > max) {
    const j = meta.keep.indexOf(false);
    if (j < 0) break;
    lines.splice(j, 1);
    meta.keep.splice(j, 1);
    meta.header.splice(j, 1);
  }
  // Nothing else can go: the top lines leave the view.
  const cut = Math.max(0, lines.length - max);
  const head = meta.header.slice(cut).findIndex((h) => !h);
  return {
    lines: cut ? lines.slice(cut) : lines,
    head: head < 0 ? meta.header.length - cut : head,
  };
}

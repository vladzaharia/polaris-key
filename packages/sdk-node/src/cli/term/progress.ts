// The progress bar and the terminal QR (UI-KITS.md §1.4 "Feedback", the update board): a thin
// bar of heavy rules, filled in the accent and empty in muted, with the figures beside it; and a
// half-block QR that is shown only when the terminal is at least 70 columns by 20 rows, never in
// ASCII, and never for sign-in (SIGN-IN.md D-67).

import { TERMINAL_LAYOUT } from "../tokens.generated.js";
import { qr } from "../../qr/index.js";
import type { TerminalCaps } from "./caps.js";
import type { Symbols } from "./layout.js";
import type { Span } from "./width.js";

/** The bar for `fraction` (0–1) as spans, `width` cells wide. */
export function progressSpans(
  fraction: number,
  symbols: Symbols,
  width: number = TERMINAL_LAYOUT.barWidth,
): Span[] {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.round(f * width);
  return [
    { text: symbols.barFull.repeat(filled), style: ["accent"] },
    { text: symbols.barEmpty.repeat(width - filled), style: ["muted"] },
  ];
}

/** A whole percentage, never 100 before the end. */
export function percent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  const p = Math.floor((done / total) * 100);
  return done >= total ? 100 : Math.min(99, p);
}

/** Below these the QR is hidden (UI-KITS §1.4). */
export const QR_MIN_COLUMNS = 70;
export const QR_MIN_ROWS = 20;

/**
 * The half-block QR lines for `text`, or null when this terminal should not draw one (too small,
 * ASCII, not a terminal) or the text does not fit a QR. Light themes get the inverted symbol so it
 * scans as dark modules on light.
 */
export function qrLines(
  text: string,
  caps: Pick<TerminalCaps, "unicode" | "tty" | "rows" | "scheme"> & {
    terminalColumns: number;
  },
): string[] | null {
  if (!caps.unicode) return null;
  if (caps.terminalColumns < QR_MIN_COLUMNS || caps.rows < QR_MIN_ROWS)
    return null;
  const t = qr.terminal(text, { invert: caps.scheme === "light" });
  return t ? t.split("\n") : null;
}

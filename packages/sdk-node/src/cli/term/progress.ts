// The progress bar and the terminal QR (UI-KITS.md §1.4 "Feedback", the update board): a thin
// bar of heavy rules, filled in the accent and empty in muted, with the figures beside it; and a
// half-block QR that is shown only where it fits (as wide as the terminal, and the whole screen
// with it as tall), never in ASCII, and never for sign-in (SIGN-IN.md D-67).

import { TERMINAL_LAYOUT } from "../tokens.generated.js";
import { qr } from "../../qr/index.js";
import type { TerminalCaps } from "./caps.js";
import type { Symbols } from "./layout.js";
import { cellWidth, type Span } from "./width.js";

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

/** Cells before a QR row: the rail, the gutter and the code's indent (it lines up with the code). */
export const QR_INDENT = 6;

/**
 * The half-block QR lines for `text`, or null when this terminal should not draw one (ASCII) or
 * the text does not fit a QR. Light themes get the inverted symbol so it scans as dark modules on
 * light. Whether it fits the screen is the caller's to decide with `qrFits`.
 */
export function qrLines(
  text: string,
  caps: Pick<TerminalCaps, "unicode" | "scheme">,
): string[] | null {
  if (!caps.unicode) return null;
  const t = qr.terminal(text, { invert: caps.scheme === "light" });
  return t ? t.split("\n") : null;
}

/**
 * Whether a QR fits: it is drawn only on a terminal, only when it is as narrow as the terminal
 * (its own width plus the indent) and only when the whole screen with it (`screenLines` without
 * it, plus its rows, plus the line the cursor rests on after it) fits the terminal's height. The
 * thresholds come from the content, never fixed numbers, so a QR shows wherever it really fits
 * and never pushes the header off the screen.
 */
export function qrFits(
  lines: readonly string[],
  caps: Pick<TerminalCaps, "tty" | "rows"> & { terminalColumns: number },
  screenLines: number,
): boolean {
  if (!caps.tty || lines.length === 0) return false;
  const width = QR_INDENT + Math.max(...lines.map((l) => cellWidth(l)));
  return (
    width <= caps.terminalColumns && screenLines + lines.length + 1 <= caps.rows
  );
}

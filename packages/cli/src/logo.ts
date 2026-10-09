/**
 * The `pkey` logo: the brand key mark (display cut) as 2x4 braille, 22 cells by 10 rows. The
 * outline is one dot, the body's interior a dither that thickens from the spine to the blade tip,
 * the star solid. BAKED: `scripts/gen-logo.mjs` derives the constants below from
 * `packages/brand/kit/source/geometry.json`, and `test/logo.test.ts` fails when the mark changes.
 *
 * It draws only on a Unicode terminal with room (a tty, 50+ columns and 24+ rows, not CI, dumb or
 * `--json`). A Unicode terminal without room gets the mark's four-point star as a one-line glyph;
 * everywhere else `pkey` prints what it always printed. pkey has no accent, so star cells read
 * `strong` and the rest `muted`.
 */

import type { Line } from "@polaris-key/node/terminal";
import type { Term } from "./terminal.js";

/** Cells wide the art is (every row is at most this). */
export const LOGO_COLS = 22;

/** The art's rows: braille, a space for an empty cell, trailing blanks trimmed. */
export const LOGO_ART: readonly string[] = [
  "       ⣀⡄     ⢀",
  "   ⣀⠤⠖⠍⠅⡇    ⢠⣿⣆",
  "   ⡇⠁⠅⠅⠅⡇  ⣤⣶⣿⣿⣿⣷⣦⡄",
  "   ⡇⠁⠅⠅⠅⡇   ⠉⢻⣿⡿⠋⠁",
  "   ⡇⠁⠅⠅⠅⡇     ⠻⠁",
  "   ⡇⠁⠅⠅⠅⡇⡏⠝⢍⠝⢕⢄",
  "   ⡇⠁⠅⠅⠅⡇⠣⡕⢅⠕⢕⢕⢕⢄",
  "   ⡇⠁⠅⠅⠅⡇ ⠈⠣⡕⢕⢕⢕⢝⢕⡄",
  "   ⡇⠁⠅⢅⣅⠇   ⠈⠳⣕⢕⡽⠋",
  "   ⡧⠕⠋⠁       ⠈⠋",
];

/** Per row and cell, `1` where a lit dot belongs to the star. */
export const LOGO_STAR: readonly string[] = [
  "0000000000000010000000",
  "0000000000000111000000",
  "0000000000011111111000",
  "0000000000001111110000",
  "0000000000000011000000",
  "0000000000000000000000",
  "0000000000000000000000",
  "0000000000000000000000",
  "0000000000000000000000",
  "0000000000000000000000",
];

/** The key mark's four-point star: the collapsed logo, drawn `strong`. */
export const LOGO_STAR_GLYPH = "\u2726";

const MIN_COLUMNS = 50;
const MIN_ROWS = 24;

/** What this terminal can show: the full art, the star glyph alone, or nothing. */
export function logoMode(term: Term): "art" | "star" | null {
  const { caps } = term;
  if (!caps.tty || !caps.unicode || caps.json || caps.ci || caps.dumb)
    return null;
  return caps.columns >= MIN_COLUMNS && caps.rows >= MIN_ROWS ? "art" : "star";
}

/** The art as styled lines, or null when this terminal does not show it. */
export function logoLines(term: Term): Line[] | null {
  if (logoMode(term) !== "art") return null;
  return LOGO_ART.map((row, r) => {
    const line: Line[number][] = [];
    let i = 0;
    for (const ch of row) {
      const role =
        ch === " " ? null : LOGO_STAR[r]![i] === "1" ? "strong" : "muted";
      i += 1;
      const last = line[line.length - 1];
      if (last && (last.style?.[0] ?? null) === role) last.text += ch;
      else line.push(role ? { text: ch, style: [role] } : { text: ch });
    }
    return line;
  });
}

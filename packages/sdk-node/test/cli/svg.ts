// Render a golden's ANSI text as an SVG terminal: a real cell grid (14 px JetBrains Mono at
// line-height 1.2, 8.4 × 16.8 px cells), the ANSI-16 palette of the terminal board
// (docs/design/ui-kits/terminal.html) in a dark and a light theme, truecolor as given. The SVG is
// deterministic text, so it is a golden in its own right; scripts/render-goldens.mjs rasterises
// it to the PNG the docs show.

import { charWidth } from "../../src/cli/term/width.js";

export type SvgTheme = "dark" | "light";

interface Palette extends Record<string, string> {
  bg: string;
  frame: string;
  fg: string;
  strong: string;
  "90": string;
}

const PALETTE: Record<SvgTheme, Palette> = {
  dark: {
    bg: "#101114",
    frame: "#26282e",
    fg: "#d7dae0",
    strong: "#ffffff",
    "31": "#ef6b73",
    "32": "#5fd38d",
    "33": "#e5c07b",
    "35": "#c678dd",
    "36": "#56b6c2",
    "90": "#7f848e",
  },
  light: {
    bg: "#fbfbfc",
    frame: "#dcdee3",
    fg: "#24292f",
    strong: "#0b0d10",
    "31": "#cf222e",
    "32": "#1a7f37",
    "33": "#9a6700",
    "35": "#8250df",
    "36": "#1b7c83",
    "90": "#6e7781",
  },
};

const CELL_W = 8.4;
const CELL_H = 16.8;
const PAD = 16.8;
const BAR = 34;

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
}

interface Cell {
  ch: string;
  style: Style;
}

const plain = (): Style => ({
  fg: null,
  bg: null,
  bold: false,
  underline: false,
  inverse: false,
});

function applySgr(style: Style, params: string): Style {
  const s = { ...style };
  const p = params === "" ? [0] : params.split(";").map(Number);
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!;
    if (n === 0) Object.assign(s, plain());
    else if (n === 1) s.bold = true;
    else if (n === 22) s.bold = false;
    else if (n === 4) s.underline = true;
    else if (n === 24) s.underline = false;
    else if (n === 7) s.inverse = true;
    else if (n === 27) s.inverse = false;
    else if (n === 39) s.fg = null;
    else if (n === 49) s.bg = null;
    else if (n === 38 && p[i + 1] === 2) {
      s.fg = `rgb:${p[i + 2]},${p[i + 3]},${p[i + 4]}`;
      i += 4;
    } else if (n === 48 && p[i + 1] === 2) {
      s.bg = `rgb:${p[i + 2]},${p[i + 3]},${p[i + 4]}`;
      i += 4;
    } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.fg = String(n);
  }
  return s;
}

/** Parse one line of ANSI text into cells (OSC 8 links dropped; their text kept). */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let style = plain();
  const re = /\x1b\[([0-9;]*)m|\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)|([\s\S])/gu;
  for (const m of line.matchAll(re)) {
    if (m[1] !== undefined) style = applySgr(style, m[1]);
    else if (m[2] !== undefined) {
      out.push({ ch: m[2], style });
      if (charWidth(m[2]) === 2) out.push({ ch: "", style });
    }
  }
  return out;
}

function colour(c: string | null, theme: SvgTheme, fallback: string): string {
  if (c === null) return fallback;
  if (c.startsWith("rgb:")) {
    const [r, g, b] = c.slice(4).split(",").map(Number);
    return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  }
  return PALETTE[theme][c] ?? fallback;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The SVG for `text` (escape sequences kept) in a `columns`-wide terminal. */
export function ansiToSvg(
  text: string,
  o: { theme: SvgTheme; columns: number; title: string },
): string {
  const pal = PALETTE[o.theme];
  const lines = text.split("\n");
  const width = Math.round(o.columns * CELL_W + PAD * 2);
  const height = Math.round(BAR + PAD + lines.length * CELL_H + PAD);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="12" fill="${pal.bg}" stroke="${pal.frame}"/>`,
    `<line x1="0" y1="${BAR}" x2="${width}" y2="${BAR}" stroke="${pal.frame}"/>`,
    `<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>`,
    `<text x="${width / 2}" y="21" text-anchor="middle" font-family="Rubik, system-ui, sans-serif" font-size="12" font-weight="500" fill="${pal["90"]}">${esc(o.title)}</text>`,
    `<g font-family="'JetBrains Mono', ui-monospace, monospace" font-size="14">`,
  );
  lines.forEach((line, row) => {
    const y = BAR + PAD + row * CELL_H;
    const cs = cells(line);
    // Backgrounds first, in runs.
    let i = 0;
    while (i < cs.length) {
      const s = cs[i]!.style;
      const bg = s.inverse
        ? colour(s.fg, o.theme, s.bold ? pal.strong : pal.fg)
        : s.bg
          ? colour(s.bg, o.theme, pal.bg)
          : null;
      let j = i + 1;
      while (
        j < cs.length &&
        JSON.stringify(cs[j]!.style) === JSON.stringify(s)
      )
        j++;
      if (bg)
        parts.push(
          `<rect x="${(PAD + i * CELL_W).toFixed(1)}" y="${y.toFixed(1)}" width="${((j - i) * CELL_W).toFixed(1)}" height="${CELL_H}" fill="${bg}"/>`,
        );
      i = j;
    }
    // Then text, one run per style, each glyph placed on its cell.
    i = 0;
    while (i < cs.length) {
      const s = cs[i]!.style;
      let j = i + 1;
      while (
        j < cs.length &&
        JSON.stringify(cs[j]!.style) === JSON.stringify(s)
      )
        j++;
      const run = cs.slice(i, j);
      if (run.some((c) => c.ch.trim() !== "")) {
        const fg = s.inverse
          ? s.bg
            ? colour(s.bg, o.theme, pal.bg)
            : pal.bg
          : colour(s.fg, o.theme, s.bold ? pal.strong : pal.fg);
        // Spaces are not drawn: every glyph gets its own cell's x, so nothing can collapse.
        const placed = run
          .map((c, k) => ({ ch: c.ch, x: (PAD + (i + k) * CELL_W).toFixed(1) }))
          .filter((c) => c.ch !== "" && c.ch !== " ");
        const xs = placed.map((c) => c.x);
        const glyphs = placed.map((c) => c.ch).join("");
        parts.push(
          `<text x="${xs.join(" ")}" y="${(y + 12.6).toFixed(1)}" fill="${fg}"${s.bold ? ' font-weight="600"' : ""}${s.underline ? ' text-decoration="underline"' : ""}>${esc(glyphs)}</text>`,
        );
      }
      i = j;
    }
  });
  parts.push("</g>", "</svg>", "");
  return parts.join("\n");
}

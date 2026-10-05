// THE DESIGN SOURCE for the terminal kits (Node and Python CLIs; UI-KITS.md §2.1 "Terminal", §4.8
// and the terminal board in docs/design/ui-kits/terminal.html). `pnpm gen:brand` writes it to
// packages/sdk-node/src/cli/tokens.generated.ts and sdks/python/src/polaris_key/ui/ansi.py.
//
// Status roles map to the ANSI-16 palette so they follow the user's terminal theme; truecolor is
// used only for the product accent, and only when the terminal says it can (COLORTERM=truecolor
// or 24bit); NO_COLOR, `--no-color` and a non-TTY stdout drop every escape. The accent's ANSI-16
// fallback is cyan.

/** A role and its SGR parameters (`ESC [ <sgr> m`). */
export const TERMINAL_SGR = {
  /** The product accent without truecolor. */
  accent: "36",
  success: "32",
  warning: "33",
  danger: "31",
  info: "35",
  /** Secondary text: bright black, which every modern theme draws as a readable grey. */
  muted: "90",
  strong: "1",
  link: "4",
  /** A chip (the product name in a flow header): inverse video. */
  chip: "7",
  reset: "0",
} as const;

export type TerminalRole = keyof typeof TERMINAL_SGR;

/** The symbols every flow draws, Unicode by default and ASCII under TERM=dumb or `--ascii`. */
export const TERMINAL_SYMBOLS = {
  unicode: {
    stepActive: "◆",
    stepDone: "◇",
    ok: "✓",
    fail: "✗",
    warn: "▲",
    radioOn: "●",
    radioOff: "○",
    rail: "│",
    railStart: "┌",
    railEnd: "└",
    barFull: "━",
    barEmpty: "━",
    separator: "·",
    ellipsis: "…",
    arrows: "↑↓",
  },
  ascii: {
    stepActive: "*",
    stepDone: "o",
    ok: "+",
    fail: "x",
    warn: "!",
    radioOn: "(*)",
    radioOff: "( )",
    rail: "|",
    railStart: "+",
    railEnd: "`",
    barFull: "#",
    barEmpty: "-",
    separator: "-",
    ellipsis: "...",
    arrows: "^v",
  },
} as const;

export type TerminalSymbol = keyof (typeof TERMINAL_SYMBOLS)["unicode"];

/** The waiting spinner: braille frames at 80 ms (ASCII: a turning bar). */
export const TERMINAL_SPINNER = {
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ascii: ["|", "/", "-", "\\"],
  frameMs: 80,
} as const;

/** Layout: the flows target 80 columns and stay legible down to 60. */
export const TERMINAL_LAYOUT = {
  columns: 80,
  minColumns: 60,
  /** Cells between the rail and the content. */
  gutter: 2,
  /** Progress-bar width in cells at 80 columns. */
  barWidth: 36,
} as const;

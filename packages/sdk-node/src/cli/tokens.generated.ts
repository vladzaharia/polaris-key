// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

/**
 * The terminal kit's tables (docs/design/UI-KITS.md §2.1 "Terminal"): SGR parameters per role
 * (status roles in the ANSI-16 palette, so they follow the user's terminal theme; truecolor only
 * for the product accent, only when COLORTERM is truecolor or 24bit), the Unicode and ASCII
 * symbol sets, the spinner and the layout widths. NO_COLOR, `--no-color` and a non-TTY stdout drop
 * every escape; TERM=dumb or `--ascii` selects ASCII.
 */
export const TERMINAL_SGR = {
  accent: "36",
  success: "32",
  warning: "33",
  danger: "31",
  info: "35",
  muted: "2",
  strong: "1",
  link: "4",
  chip: "7",
  reset: "0",
} as const;

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
    barEmpty: "─",
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

export const TERMINAL_SPINNER = {
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ascii: ["|", "/", "-", "\\"],
  frameMs: 80,
} as const;

export const TERMINAL_LAYOUT = {
  columns: 80,
  minColumns: 60,
  gutter: 2,
  barWidth: 36,
} as const;

export type TerminalRole = keyof typeof TERMINAL_SGR;
export type TerminalSymbol = keyof (typeof TERMINAL_SYMBOLS)["unicode"];

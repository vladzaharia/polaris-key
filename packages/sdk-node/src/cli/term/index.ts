// `@polaris-key/node/terminal`: the terminal primitives both Polaris Key CLIs draw with (the
// Node SDK's CLI kit and `pkey`), so the two share one look (docs/design/UI-KITS.md §1.4
// "Terminal"): capability detection, the role painter, the rail layout, cell widths, the
// spinner and live region, the progress bar and QR, OSC 8 and OSC 52, raw-mode keys and the
// clack-style prompts. No copy lives here: callers pass their words in.

export {
  detectTerminal,
  isCi,
  isHeadless,
  queryBackground,
  schemeFromColorFgBg,
  schemeFromOsc11,
  schemeIsGuessed,
  type ColorLevel,
  type ColorScheme,
  type DetectOptions,
  type TerminalCaps,
  type TerminalFlags,
  type TerminalInput,
  type TerminalOutput,
} from "./caps.js";
export {
  Painter,
  roleStyles,
  type ChipColors,
  type Role,
  type RoleColors,
} from "./paint.js";
export {
  columnsOf,
  contentWidth,
  GUTTER,
  keyHints,
  railLines,
  separated,
  symbolsFor,
  type Mark,
  type RailRow,
  type Symbols,
} from "./layout.js";
export {
  cellWidth,
  charWidth,
  padEnd,
  stripAnsi,
  truncateEnd,
  truncateMiddle,
  wrapSpans,
  wrapText,
  type Line,
  type Span,
} from "./width.js";
export {
  animate,
  LiveRegion,
  realTicker,
  spinnerFrames,
  type Ticker,
} from "./live.js";
export { isCancel, isInterrupt, KeyReader, type Key } from "./keys.js";
export {
  CANCEL,
  INTERRUPT,
  plainConfirm,
  plainSecret,
  promptConfirm,
  promptSecret,
  promptSelect,
  type Cancel,
  type ConfirmPrompt,
  type PromptContext,
  type SecretPrompt,
  type SelectOption,
  type SelectPrompt,
} from "./prompt.js";
export {
  percent,
  progressSpans,
  QR_MIN_COLUMNS,
  QR_MIN_ROWS,
  qrLines,
} from "./progress.js";
export { displayUrl, osc52, osc8 } from "./osc.js";
export { clean, CONTROL_CHARS, safeLink } from "./sanitize.js";
export {
  TERMINAL_LAYOUT,
  TERMINAL_SGR,
  TERMINAL_SPINNER,
  TERMINAL_SYMBOLS,
  type TerminalRole,
  type TerminalSymbol,
} from "../tokens.generated.js";

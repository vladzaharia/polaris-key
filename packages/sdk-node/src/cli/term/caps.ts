// What the terminal can draw (docs/design/UI-KITS.md §1.4 "Terminal", §2.1, §4.8; SIGN-IN.md D-68,
// D-77). One pure function decides it from the environment, the streams and the flags, so every
// flow, the goldens and `pkey` agree on when colour, Unicode, links and animation are on.
//
//   colour     NO_COLOR, --no-color, TERM=dumb and a stdout that is not a terminal drop every
//              escape; FORCE_COLOR or --color force ANSI-16. Status roles use the ANSI-16 palette,
//              so they follow the user's theme; truecolor (COLORTERM=truecolor or 24bit) is used
//              only for the product chip.
//   symbols    Unicode by default; ASCII under TERM=dumb, TERM=linux (the kernel console has no
//              braille), PKEY_ASCII=1 or --ascii.
//   animation  a spinner or a redrawn progress line only on a terminal, never under CI, TERM=dumb
//              or reduced motion: anything else prints each line once.
//   layout     80 columns, degrading to the terminal's width below that (60 is the floor the
//              layouts are designed for, UI-KITS §1.5 rule 13).
//   scheme     PKEY_THEME=dark|light, else COLORFGBG, else dark (OSC 11, queryBackground, is
//              asked only when truecolor is on and the flow can wait for an answer).
//   headless   no local browser (SIGN-IN.md D-68): SSH_CONNECTION or SSH_TTY, CI, or Linux with
//              neither DISPLAY nor WAYLAND_DISPLAY.

import { TERMINAL_LAYOUT } from "../tokens.generated.js";

export type ColorLevel = "none" | "ansi16" | "truecolor";
export type ColorScheme = "dark" | "light";

/** The part of a Node stream the terminal kit reads and writes. */
export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
}

/** The part of stdin the prompts read. */
export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  // Listener parameters are `any`: Node's streams declare them that way.
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

/** Flags every verb accepts (UI-KITS §1.4 "Interaction" and "Fallbacks"). */
export interface TerminalFlags {
  /** `--color` (true) or `--no-color` (false); undefined follows the environment. */
  color?: boolean;
  /** `--ascii`: ASCII symbols only. */
  ascii?: boolean;
  /** `--json`: machine output, never a prompt, never an escape. */
  json?: boolean;
}

export interface TerminalCaps {
  color: ColorLevel;
  /** Unicode symbols (rails, braille spinner, half blocks); false is the ASCII set. */
  unicode: boolean;
  /** stdout is a terminal. */
  tty: boolean;
  /** The flow may prompt: stdin and stdout are terminals, not CI, not `--json`. */
  interactive: boolean;
  /** Spinners and redrawn lines; false prints every line once (D-77). */
  animate: boolean;
  /** OSC 8 links and OSC 52 copy. */
  links: boolean;
  /** The layout width: 80, or the terminal's width when it is narrower. */
  columns: number;
  rows: number;
  scheme: ColorScheme;
  ci: boolean;
  /** No browser on this computer (SIGN-IN.md D-68). */
  headless: boolean;
  json: boolean;
}

export interface DetectOptions {
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: TerminalOutput;
  stdin?: { isTTY?: boolean };
  flags?: TerminalFlags;
  platform?: NodeJS.Platform;
  /** The theme's choices that change what is drawn (§3.1). */
  theme?: {
    colorScheme?: "system" | "dark" | "light";
    motion?: "system" | "reduced" | "none";
  };
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** CI as the common runners announce it. */
export function isCi(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS) || truthy(env.BUILDKITE);
}

/** SIGN-IN.md D-68: no usable local browser. */
export function isHeadless(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (truthy(env.SSH_CONNECTION) || truthy(env.SSH_TTY) || isCi(env))
    return true;
  return (
    platform === "linux" && !truthy(env.DISPLAY) && !truthy(env.WAYLAND_DISPLAY)
  );
}

/**
 * `COLORFGBG` ("15;0", "0;default;15") names the background's ANSI index last: 0–6 and 8 are dark
 * grounds, 7 and 9–15 light ones. Null when it is absent or unreadable.
 */
export function schemeFromColorFgBg(
  value: string | undefined,
): ColorScheme | null {
  if (!value) return null;
  const last = value.split(";").at(-1);
  const n = Number(last);
  if (!Number.isInteger(n) || n < 0 || n > 15) return null;
  return n === 7 || n >= 9 ? "light" : "dark";
}

function colorLevel(
  env: Readonly<Record<string, string | undefined>>,
  tty: boolean,
  flags: TerminalFlags,
): ColorLevel {
  if (flags.json) return "none";
  if (flags.color === false) return "none";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  const deep =
    env.COLORTERM === "truecolor" ||
    env.COLORTERM === "24bit" ||
    env.FORCE_COLOR === "3";
  const forced =
    flags.color === true ||
    (env.FORCE_COLOR !== undefined &&
      env.FORCE_COLOR !== "0" &&
      env.FORCE_COLOR !== "false");
  if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") return "none";
  if (!tty && !forced) return "none";
  return deep ? "truecolor" : "ansi16";
}

/** Decide what this terminal draws. Pure: everything comes from `opts`. */
export function detectTerminal(opts: DetectOptions = {}): TerminalCaps {
  const env = opts.env ?? process.env;
  const flags = opts.flags ?? {};
  const platform = opts.platform ?? process.platform;
  const out = opts.stdout;
  const tty = out?.isTTY === true;
  const ci = isCi(env);
  const json = flags.json === true;
  const dumb = env.TERM === "dumb";
  const color = colorLevel(env, tty, flags);
  const unicode =
    !flags.ascii && !dumb && env.TERM !== "linux" && !truthy(env.PKEY_ASCII);
  const motion = opts.theme?.motion ?? "system";
  const reduced =
    motion === "none" ||
    motion === "reduced" ||
    truthy(env.PKEY_REDUCED_MOTION);
  const interactive =
    !json && !ci && tty && opts.stdin?.isTTY === true && !dumb;
  const termCols = tty && out?.columns ? out.columns : TERMINAL_LAYOUT.columns;
  const explicit =
    opts.theme?.colorScheme === "dark" || opts.theme?.colorScheme === "light"
      ? opts.theme.colorScheme
      : env.PKEY_THEME === "dark" || env.PKEY_THEME === "light"
        ? env.PKEY_THEME
        : null;
  return {
    color,
    unicode,
    tty,
    interactive,
    animate: tty && !ci && !dumb && !json && !reduced,
    links: tty && !dumb && !ci && !json,
    columns: Math.max(20, Math.min(TERMINAL_LAYOUT.columns, termCols)),
    rows: tty && out?.rows ? out.rows : 24,
    scheme: explicit ?? schemeFromColorFgBg(env.COLORFGBG) ?? "dark",
    ci,
    headless: isHeadless(env, platform),
    json,
  };
}

/** True when the scheme came from neither the theme, PKEY_THEME nor COLORFGBG. */
export function schemeIsGuessed(opts: DetectOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const s = opts.theme?.colorScheme;
  return (
    s !== "dark" &&
    s !== "light" &&
    env.PKEY_THEME !== "dark" &&
    env.PKEY_THEME !== "light" &&
    schemeFromColorFgBg(env.COLORFGBG) === null
  );
}

/** Parse an OSC 11 answer (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL|ST`) into a scheme. */
export function schemeFromOsc11(answer: string): ColorScheme | null {
  const m = /\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(answer);
  if (!m) return null;
  const channel = (h: string) => parseInt(h, 16) / (16 ** h.length - 1);
  const [r, g, b] = [channel(m[1]!), channel(m[2]!), channel(m[3]!)];
  // Relative luminance (sRGB, linearised); a ground above the midpoint is light.
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 0.4 ? "light" : "dark";
}

/**
 * Ask the terminal for its background (OSC 11) and wait at most `timeoutMs` for the answer.
 * Only meaningful on an interactive terminal; null on silence. The answer is read in raw mode
 * and consumed, so it never reaches the shell.
 */
export function queryBackground(
  stdin: TerminalInput,
  stdout: TerminalOutput,
  timeoutMs = 120,
): Promise<ColorScheme | null> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = "";
    const done = (v: ColorScheme | null) => {
      clearTimeout(timer);
      const off = stdin.off ?? stdin.removeListener;
      off?.call(stdin, "data", onData);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      if (/\x07|\x1b\\/.test(buf)) done(schemeFromOsc11(buf));
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.setRawMode!(true);
    stdin.on("data", onData);
    stdin.resume?.();
    stdout.write("\x1b]11;?\x07");
  });
}

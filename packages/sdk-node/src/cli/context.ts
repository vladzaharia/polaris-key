// One flow's view of the terminal: what it can draw (caps), how it paints, its words (copy), the
// product it shows, its streams and its keys. The adapters build one per command; the goldens
// build one per fixture with fake streams, so a golden is exactly what a user's terminal gets.

import { openInBrowser } from "../identity/client.js";
import { KitCopy, localeFromEnv } from "./copy.js";
import {
  detectTerminal,
  layoutColumns,
  queryBackground,
  schemeIsGuessed,
  type DetectOptions,
  type TerminalCaps,
  type TerminalFlags,
  type TerminalInput,
  type TerminalOutput,
} from "./term/caps.js";
import { CURSOR_POSITION_REQUEST, KeyReader } from "./term/keys.js";
import {
  railLines,
  symbolsFor,
  type LineMeta,
  type RailRow,
  type Symbols,
} from "./term/layout.js";
import { LiveRegion, realTicker, type Ticker } from "./term/live.js";
import { safeLink } from "./term/sanitize.js";
import { fitScreen, type Fitted } from "./term/screen.js";
import { Painter } from "./term/paint.js";
import {
  bundleIdentity,
  readPresentation,
  resolveProduct,
  type PolarisKeyTerminalTheme,
  type PresentationSource,
  type ProductIdentity,
  type ProductPresentation,
  type ResolvedProduct,
} from "./theme.js";

/** The process seams a flow touches. Every field defaults to the real process. */
export interface TerminalIO {
  stdout?: TerminalOutput;
  stderr?: TerminalOutput;
  stdin?: TerminalInput & AsyncIterable<Buffer | string>;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  ticker?: Ticker;
  /** Epoch milliseconds (tests pin it). */
  now?: () => number;
  /** Open a URL in the default browser; false when it could not (D-68's fallback). */
  openUrl?: (url: string) => Promise<boolean> | boolean;
}

export interface KitContext {
  caps: TerminalCaps;
  painter: Painter;
  symbols: Symbols;
  copy: KitCopy;
  product: ResolvedProduct;
  theme: PolarisKeyTerminalTheme;
  /** The command the user runs (`tidewater`), for "Run tidewater login" lines and help. */
  bin: string;
  /** The product slug. */
  slug: string;
  stdout: TerminalOutput;
  stderr: TerminalOutput;
  stdin: TerminalInput & Partial<AsyncIterable<Buffer | string>>;
  ticker: Ticker;
  now: () => number;
  openUrl: (url: string) => Promise<boolean> | boolean;
  /** Keys from stdin while the flow is interactive, else null. */
  keys: KeyReader | null;
  /**
   * Keys for plain questions on a TERM=dumb terminal (no cursor control; D-77), else null. Only
   * one of `keys` and `plainKeys` is ever set.
   */
  plainKeys: KeyReader | null;
  /** Print rail rows on stdout. */
  rows(rows: readonly RailRow[]): void;
  /** Lines for rail rows, without printing. */
  render(rows: readonly RailRow[], meta?: LineMeta): string[];
  /** Lines for rail rows that fit the terminal: compacted by tier, then cut from the top. */
  fit(rows: readonly RailRow[]): Fitted;
  /** Re-read the terminal's size into `caps` (a live region calls it on SIGWINCH). */
  refreshSize(): void;
  /**
   * The cursor's row (1-based) from a cursor-position report, for a live region that must find
   * its own top after the window grew; null when nobody can answer in time.
   */
  cursorRow(): Promise<number | null>;
  /** A live region on stdout that lays its whole screen out again on a resize. */
  live(): LiveRegion;
  /** Release the keyboard (raw mode off). Call when the flow ends. */
  close(): void;
}

export interface CreateContextOptions {
  theme?: PolarisKeyTerminalTheme;
  flags?: TerminalFlags;
  io?: TerminalIO;
  /** The product slug (the name of last resort). */
  slug: string;
  bin?: string;
  /** The SDK's presentation accessor (HA-13), when it has one. */
  presentation?: PresentationSource | null;
  /** The bundle's identity; default: the entry script's package.json. */
  bundle?: Partial<ProductIdentity>;
  /** Ask the terminal for its background over OSC 11 when it matters (default true). */
  queryScheme?: boolean;
}

export async function createKitContext(
  o: CreateContextOptions,
): Promise<KitContext> {
  const io = o.io ?? {};
  const stdout = io.stdout ?? process.stdout;
  const stdin = (io.stdin ?? process.stdin) as KitContext["stdin"];
  const detect = detectOptions(o);
  let scheme: "dark" | "light" | undefined;
  const caps = detectTerminal(detect);
  if (
    o.queryScheme !== false &&
    caps.color === "truecolor" &&
    caps.interactive &&
    schemeIsGuessed(detect)
  )
    scheme = (await queryBackground(stdin, stdout)) ?? undefined;
  const presentation = await readPresentation(o.presentation);
  return buildContext(o, { presentation, scheme });
}

/**
 * The same context without waiting on anything (no OSC 11 question, no presentation read):
 * for help text, which a command-line parser asks for synchronously.
 */
export function createKitContextSync(
  o: CreateContextOptions & { presentationValue?: ProductPresentation | null },
): KitContext {
  return buildContext(o, { presentation: o.presentationValue ?? null });
}

function detectOptions(o: CreateContextOptions): DetectOptions {
  const io = o.io ?? {};
  const theme = o.theme ?? {};
  return {
    env: io.env ?? process.env,
    stdout: io.stdout ?? process.stdout,
    stdin: io.stdin ?? process.stdin,
    flags: { ...o.flags, ascii: o.flags?.ascii || theme.symbols === "ascii" },
    platform: io.platform ?? process.platform,
    theme: {
      ...(theme.colorScheme ? { colorScheme: theme.colorScheme } : {}),
      ...(theme.motion ? { motion: theme.motion } : {}),
    },
  };
}

function buildContext(
  o: CreateContextOptions,
  found: {
    presentation: ProductPresentation | null;
    scheme?: "dark" | "light";
  },
): KitContext {
  const io = o.io ?? {};
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = (io.stdin ?? process.stdin) as KitContext["stdin"];
  const theme = o.theme ?? {};
  const detected = detectTerminal(detectOptions(o));
  const caps = found.scheme ? { ...detected, scheme: found.scheme } : detected;
  const product = resolveProduct({
    theme,
    presentation: found.presentation,
    bundle: o.bundle ?? bundleIdentity(),
    slug: o.slug,
    scheme: caps.scheme,
  });
  // `colors` are hex per role, drawn only in truecolor; the native preset keeps the terminal's
  // own palette, so it takes none of them.
  const painter = new Painter(
    caps,
    product.chip,
    theme.preset === "native" ? {} : (theme.colors?.[caps.scheme] ?? {}),
    // The native preset keeps the terminal's palette: its accent role is ANSI cyan, never ink.
    product.accentSource === "ink" && theme.preset !== "native",
  );
  const symbols = symbolsFor(caps);
  const copy = new KitCopy({
    ...theme.copy,
    locale: theme.copy?.locale ?? localeFromEnv(env),
    ascii: !caps.unicode,
  });
  const keys = caps.interactive ? new KeyReader(stdin) : null;
  const plainKeys =
    caps.dumb && caps.tty && stdin.isTTY === true && !caps.json && !caps.ci
      ? new KeyReader(stdin)
      : null;
  const render = (rows: readonly RailRow[], meta?: LineMeta) =>
    railLines(rows, painter, symbols, caps.columns, meta);
  const fit = (rows: readonly RailRow[]) =>
    fitScreen(rows, {
      maxRows: caps.rows - 1,
      columns: caps.columns,
      separator: symbols.separator,
      render,
    });
  const ctx: KitContext = {
    caps,
    painter,
    symbols,
    copy,
    product,
    theme,
    bin: o.bin ?? o.slug,
    slug: o.slug,
    stdout,
    stderr,
    stdin,
    ticker: io.ticker ?? realTicker,
    now: io.now ?? Date.now,
    // Only a safe link reaches the opener (an https URL, or loopback http, with no whitespace,
    // control character or userinfo); anything else is not opened and the flow falls back.
    openUrl: (url: string) => {
      const safe = safeLink(url);
      return safe ? (io.openUrl ?? openInBrowser)(safe) : false;
    },
    keys,
    plainKeys,
    render,
    fit,
    rows: (rows) => {
      const lines = render(rows);
      if (lines.length) stdout.write(`${lines.join("\n")}\n`);
    },
    refreshSize: () => {
      if (!caps.tty) return;
      if (stdout.columns) caps.columns = layoutColumns(stdout.columns);
      if (stdout.rows) caps.rows = stdout.rows;
    },
    cursorRow: () =>
      keys
        ? keys.cursorRow(() => stdout.write(CURSOR_POSITION_REQUEST), 100)
        : Promise.resolve(null),
    live: () => new LiveRegion(stdout, ctx),
    close: () => {
      keys?.close();
      plainKeys?.close();
    },
  };
  return ctx;
}

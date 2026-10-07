// Clack-style prompts on the rail (UI-KITS.md §1.4 "Interaction", §5.1 Node row): masked secret
// entry, a yes/no confirm and a radio select. Each prompt redraws in place while it is active and
// commits the rows its caller gives for the answered state, so the scrollback keeps one tidy line
// per answered step. Prompts take their words from the caller (the kit passes catalog strings);
// this module holds no copy.
//
// Secret entry never echoes what is typed: the field shows what the caller's `mask` returns (the
// kit shows bullets), keeps the value in memory only, and leaves raw mode on every exit path.

import type { TerminalCaps, TerminalOutput } from "./caps.js";
import { isCancel, type Key, type KeyReader } from "./keys.js";
import { railLines, type RailRow, type Symbols } from "./layout.js";
import { LiveRegion } from "./live.js";
import type { Painter } from "./paint.js";
import type { Line } from "./width.js";

/** A prompt the user cancelled (Esc, Ctrl-C, Ctrl-D). */
export const CANCEL: unique symbol = Symbol("pkey.cancel");
export type Cancel = typeof CANCEL;

export interface PromptContext {
  caps: TerminalCaps;
  painter: Painter;
  symbols: Symbols;
  out: TerminalOutput;
  keys: KeyReader;
  signal?: AbortSignal;
}

/** The longest secret a prompt takes (a pasted key is 42 characters). */
const MAX_SECRET = 512;
/** Bracketed-paste markers some terminals wrap a paste in. */
const PASTE_MARKERS = /\x1b\[20[01]~/g;

function printable(k: Key): string {
  if (k.ctrl || k.meta) return "";
  const s = k.sequence.replace(PASTE_MARKERS, "");
  return /^[^\x00-\x1f\x7f]+$/.test(s) ? s : "";
}

function frame(ctx: PromptContext, rows: RailRow[]): string[] {
  return railLines(rows, ctx.painter, ctx.symbols, ctx.caps.columns);
}

export interface SecretPrompt {
  /** The step's title row (label, then the lede in muted). */
  title: Line;
  /** How the field reads for the current value (never the value itself). */
  mask(value: string): Line;
  /** A live verdict under the field, or null. */
  verdict?(value: string): RailRow | null;
  /** Key hints on the end row. */
  hints: Line;
  /** Called on Enter: a row to show instead of submitting (an empty or cut-short key). */
  check?(value: string): RailRow | null;
  /** The rows that stay once the value is submitted. */
  done(value: string): RailRow[];
  /** The rows that stay when the user cancels. */
  cancelled(): RailRow[];
}

/** Read a secret with masked echo. */
export async function promptSecret(
  ctx: PromptContext,
  p: SecretPrompt,
): Promise<string | Cancel> {
  const live = new LiveRegion(ctx.out, { animate: true });
  let value = "";
  let problem: RailRow | null = null;
  const caret = ctx.symbols.rail === "|" ? "_" : "▌";
  const render = () => {
    const field: Line = [...p.mask(value), { text: caret, style: ["accent"] }];
    const rows: RailRow[] = [
      { mark: "active", spans: p.title },
      { mark: "rail", spans: field },
    ];
    const v = problem ?? p.verdict?.(value) ?? null;
    if (v) rows.push(v);
    rows.push({ mark: "end", spans: p.hints });
    live.draw(frame(ctx, rows));
  };
  try {
    render();
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit(frame(ctx, p.cancelled()));
        return CANCEL;
      }
      if (k.name === "return" || k.name === "enter") {
        problem = p.check?.(value) ?? null;
        if (!problem) {
          live.commit(frame(ctx, p.done(value)));
          return value;
        }
      } else if (k.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        problem = null;
      } else if (k.ctrl && k.name === "u") {
        value = "";
        problem = null;
      } else {
        const s = printable(k);
        if (s) {
          value = (value + s).slice(0, MAX_SECRET);
          problem = null;
        }
      }
      render();
    }
  } finally {
    live.close();
  }
}

export interface ConfirmPrompt {
  /** The question, with its "(y/N)" as the catalog writes it. */
  title: Line;
  /** The rows that stay after an answer. */
  done(yes: boolean): RailRow[];
  cancelled(): RailRow[];
  /** Enter's answer (default no, D-71). */
  initial?: boolean;
}

/** Ask a yes/no question: y or n, Enter for the default, Esc to cancel. */
export async function promptConfirm(
  ctx: PromptContext,
  p: ConfirmPrompt,
): Promise<boolean | Cancel> {
  const live = new LiveRegion(ctx.out, { animate: true });
  try {
    live.draw(frame(ctx, [{ mark: "active", spans: p.title }]));
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit(frame(ctx, p.cancelled()));
        return CANCEL;
      }
      const yes = k.name === "y" ? true : k.name === "n" ? false : null;
      const answer =
        yes ?? (k.name === "return" || k.name === "enter" ? !!p.initial : null);
      if (answer !== null) {
        live.commit(frame(ctx, p.done(answer)));
        return answer;
      }
    }
  } finally {
    live.close();
  }
}

export interface SelectOption<T> {
  value: T;
  label: Line;
  /** A muted line under the label (platform · last used). */
  meta?: Line;
}

export interface SelectPrompt<T> {
  title: Line;
  options: readonly SelectOption<T>[];
  initial?: number;
  hints: Line;
  /** A muted consequence line above the hints, for the focused option. */
  consequence?(value: T): Line | null;
  done(value: T): RailRow[];
  cancelled(): RailRow[];
}

/** A radio list: ↑↓ to move, Enter to choose, Esc to cancel. */
export async function promptSelect<T>(
  ctx: PromptContext,
  p: SelectPrompt<T>,
): Promise<T | Cancel> {
  const live = new LiveRegion(ctx.out, { animate: true });
  let at = Math.min(Math.max(p.initial ?? 0, 0), p.options.length - 1);
  const render = () => {
    const rows: RailRow[] = [{ mark: "active", spans: p.title }];
    p.options.forEach((o, i) => {
      const on = i === at;
      const radio = on ? ctx.symbols.radioOn : ctx.symbols.radioOff;
      rows.push({
        mark: "rail",
        spans: [
          { text: `${radio} `, style: on ? ["accent"] : ["muted"] },
          ...o.label.map((s) =>
            on ? { ...s, style: [...(s.style ?? []), "strong"] } : s,
          ),
        ],
      });
      if (o.meta)
        rows.push({
          mark: "rail",
          spans: [
            { text: "  " },
            ...o.meta.map((s) => ({ ...s, style: ["muted"] })),
          ],
        });
    });
    const c = p.consequence?.(p.options[at]!.value);
    if (c) rows.push({ mark: "rail", spans: [] }, { mark: "rail", spans: c });
    rows.push({ mark: "end", spans: p.hints });
    live.draw(frame(ctx, rows));
  };
  try {
    render();
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit(frame(ctx, p.cancelled()));
        return CANCEL;
      }
      if (k.name === "up" || k.name === "k")
        at = (at - 1 + p.options.length) % p.options.length;
      else if (k.name === "down" || k.name === "j")
        at = (at + 1) % p.options.length;
      else if (k.name === "return" || k.name === "enter") {
        const v = p.options[at]!.value;
        live.commit(frame(ctx, p.done(v)));
        return v;
      }
      render();
    }
  } finally {
    live.close();
  }
}

/**
 * A question on a terminal that takes no cursor control (TERM=dumb, SIGN-IN.md D-77): the label
 * as a plain line, then the answer read in raw mode with no echo at all, ended by Enter. Nothing
 * is redrawn and nothing of the secret is shown, not even a mask.
 */
export async function plainSecret(
  keys: KeyReader,
  out: TerminalOutput,
  label: string,
  signal?: AbortSignal,
): Promise<string | Cancel> {
  out.write(`${label} `);
  let value = "";
  try {
    for (;;) {
      const k = await keys.next(signal);
      if (k === null || isCancel(k)) return CANCEL;
      if (k.name === "return" || k.name === "enter") return value;
      if (k.name === "backspace") value = [...value].slice(0, -1).join("");
      else value = (value + printable(k)).slice(0, MAX_SECRET);
    }
  } finally {
    out.write("\n");
  }
}

/** A yes/no question as a plain line (TERM=dumb): y or n, Enter for `initial`, Esc to cancel. */
export async function plainConfirm(
  keys: KeyReader,
  out: TerminalOutput,
  question: string,
  initial = false,
  signal?: AbortSignal,
): Promise<boolean | Cancel> {
  out.write(`${question} `);
  try {
    for (;;) {
      const k = await keys.next(signal);
      if (k === null || isCancel(k)) return CANCEL;
      if (k.name === "y") return true;
      if (k.name === "n") return false;
      if (k.name === "return" || k.name === "enter") return initial;
    }
  } finally {
    out.write("\n");
  }
}

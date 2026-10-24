// Clack-style prompts on the rail (UI-KITS.md §1.4 "Interaction", §5.1 Node row): masked secret
// entry, a yes/no confirm and a radio select. Each prompt redraws in place while it is active and
// commits the rows its caller gives for the answered state, so the scrollback keeps one tidy line
// per answered step. Prompts take their words from the caller (the kit passes catalog strings);
// this module holds no copy.
//
// Secret entry never echoes what is typed: the field shows what the caller's `mask` returns (the
// kit shows bullets), keeps the value in memory only, and leaves raw mode on every exit path.

import type { TerminalCaps, TerminalOutput } from "./caps.js";
import { isCancel, isInterrupt, type Key, type KeyReader } from "./keys.js";
import { type RailRow, type Symbols } from "./layout.js";
import { LiveRegion, type LiveHost } from "./live.js";
import type { Painter } from "./paint.js";
import type { Line } from "./width.js";

/** A prompt the user cancelled (Esc, Ctrl-D). */
export const CANCEL: unique symbol = Symbol("pkey.cancel");
/** A prompt the user interrupted (Ctrl-C): the flow ends with exit 130. */
export const INTERRUPT: unique symbol = Symbol("pkey.interrupt");
export type Cancel = typeof CANCEL | typeof INTERRUPT;

/** CANCEL or INTERRUPT for the key that ended a prompt (null: the reader closed). */
function cancelled(k: Key | null): Cancel {
  return k !== null && isInterrupt(k) ? INTERRUPT : CANCEL;
}

export interface PromptContext {
  caps: TerminalCaps;
  painter: Painter;
  symbols: Symbols;
  out: TerminalOutput;
  keys: KeyReader;
  signal?: AbortSignal;
  /** The flow's context: it lays the prompt out again on a resize and fits it to the screen. */
  host: LiveHost;
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

/** A prompt's region: it always redraws (typing needs it), even with motion off. */
export function interactiveRegion(
  out: TerminalOutput,
  host: LiveHost,
): LiveRegion {
  return new LiveRegion(out, {
    get caps() {
      return { ...host.caps, animate: true };
    },
    refreshSize: () => host.refreshSize(),
    render: (r) => host.render(r),
    fit: (r) => host.fit(r),
    cursorRow: () => host.cursorRow?.() ?? Promise.resolve(null),
  });
}

function region(ctx: PromptContext): LiveRegion {
  return interactiveRegion(ctx.out, ctx.host);
}

/** The rows of a screen (kept as a function so call sites read the same as before). */
const frame = (_ctx: PromptContext, rows: RailRow[]): RailRow[] => rows;

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
  /** Rows above the prompt that belong to the same screen (the flow's header). */
  lead?(): readonly RailRow[];
  /**
   * The rows that stay once the value is submitted. Empty: the prompt is erased and the flow's
   * next screen draws the answered step itself.
   */
  done(value: string): RailRow[];
  /** The rows that stay when the user cancels. */
  cancelled(): RailRow[];
}

/** Read a secret with masked echo. */
export async function promptSecret(
  ctx: PromptContext,
  p: SecretPrompt,
): Promise<string | Cancel> {
  const live = region(ctx);
  let value = "";
  let problem: RailRow | null = null;
  const caret = ctx.symbols.rail === "|" ? "_" : "▌";
  const render = () => {
    const field: Line = [...p.mask(value), { text: caret, style: ["accent"] }];
    const rows: RailRow[] = [
      ...(p.lead?.() ?? []),
      { mark: "active", spans: p.title },
      { mark: "rail", spans: field },
    ];
    const v = problem ?? p.verdict?.(value) ?? null;
    if (v) rows.push(v);
    rows.push({ mark: "end", spans: p.hints });
    live.draw(() => rows);
  };
  try {
    render();
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit([...(p.lead?.() ?? []), ...p.cancelled()]);
        return cancelled(k);
      }
      if (k.name === "return" || k.name === "enter") {
        problem = p.check?.(value.trim()) ?? null;
        if (!problem) {
          const kept = p.done(value.trim());
          if (kept.length) live.commit([...(p.lead?.() ?? []), ...kept]);
          return value.trim();
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
  /** A muted line under the question: what a yes does. */
  detail?: Line;
  /** Key hints on the end row. */
  hints?: Line;
}

/** Ask a yes/no question: y or n, Enter for the default, Esc to cancel. */
export async function promptConfirm(
  ctx: PromptContext,
  p: ConfirmPrompt,
): Promise<boolean | Cancel> {
  const live = region(ctx);
  try {
    live.draw(
      frame(ctx, [
        { mark: "active", spans: p.title },
        ...(p.detail
          ? [
              {
                mark: "rail" as const,
                spans: p.detail.map((s) => ({ ...s, style: ["muted"] })),
              },
            ]
          : []),
        ...(p.hints ? [{ mark: "end" as const, spans: p.hints }] : []),
      ]),
    );
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit(frame(ctx, p.cancelled()));
        return cancelled(k);
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
  const live = region(ctx);
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
        return cancelled(k);
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

export interface MultiSelectPrompt<T> {
  title: Line;
  options: readonly SelectOption<T>[];
  /** The values ticked when the prompt opens. */
  initial?: readonly T[];
  hints: Line;
  /**
   * Space on an option: the new selection and a note to show, or null. The caller owns the rules
   * (ticking one option may tick or clear another).
   */
  toggle(
    chosen: readonly T[],
    value: T,
  ): { chosen: readonly T[]; note: Line | null };
  /**
   * Why an option cannot be ticked now, or null. Drawn as the option's muted line; Space on it
   * shows `lockedNote` (default: this reason).
   */
  locked?(value: T, chosen: readonly T[]): Line | null;
  /** The note Space shows on a locked option: what to do about it. */
  lockedNote?(value: T, chosen: readonly T[]): Line | null;
  /** Enter: a note to show instead of confirming (nothing ticked), or null to confirm. */
  check?(chosen: readonly T[]): Line | null;
  done(chosen: readonly T[]): RailRow[];
  cancelled(): RailRow[];
}

/** Checkbox glyphs in the symbol set's spelling (Unicode, or ASCII under TERM=dumb and --ascii). */
function boxes(symbols: Symbols): { on: string; off: string; focus: string } {
  return symbols.rail === "|"
    ? { on: "[x]", off: "[ ]", focus: ">" }
    : { on: "◼", off: "◻", focus: "›" };
}

/**
 * A checkbox list: ↑↓ or j/k move, Space toggles, Enter confirms (zero ticked is an answer unless
 * `check` refuses it), Esc cancels. The focused row carries a marker, locked rows included. A
 * screen too short for the list keeps the question and the hints and crops the list around the
 * focus. Resolves with the ticked values in option order.
 */
export async function promptMultiSelect<T>(
  ctx: PromptContext,
  p: MultiSelectPrompt<T>,
): Promise<T[] | Cancel> {
  const live = region(ctx);
  const box = boxes(ctx.symbols);
  let at = 0;
  let chosen: readonly T[] = p.initial ?? [];
  let note: Line | null = null;
  const ordered = () =>
    p.options.map((o) => o.value).filter((v) => chosen.includes(v));
  const render = () => {
    const blocks: RailRow[][] = p.options.map((o, i) => {
      const focus = i === at;
      const ticked = chosen.includes(o.value);
      const lock = p.locked?.(o.value, chosen) ?? null;
      const label = o.label.map((s) =>
        lock
          ? { ...s, style: ["muted"] }
          : focus
            ? { ...s, style: [...(s.style ?? []), "strong"] }
            : s,
      );
      const rows: RailRow[] = [
        {
          mark: "rail",
          spans: [
            {
              text: focus ? `${box.focus} ` : "  ",
              style: ["accent"],
            },
            {
              text: `${ticked ? box.on : box.off} `,
              style: lock
                ? ["muted"]
                : focus || ticked
                  ? ["accent"]
                  : ["muted"],
            },
            ...(focus && lock
              ? label.map((s) => ({
                  ...s,
                  style: [...(s.style ?? []), "strong"],
                }))
              : label),
          ],
        },
      ];
      const meta = lock ?? o.meta;
      if (meta)
        rows.push({
          mark: "rail",
          spans: [
            { text: "    " },
            ...meta.map((s) => ({ ...s, style: ["muted"] })),
          ],
        });
      return rows;
    });
    const tail: RailRow[] = [];
    if (note)
      tail.push({ mark: "rail", spans: [] }, { mark: "rail", spans: note });
    tail.push({ mark: "end", spans: p.hints });
    // Keep the question, the note and the hints; crop the list around the focus.
    const budget = Math.max(3, ctx.caps.rows - 1 - 1 - tail.length);
    let from = 0;
    let to = blocks.length;
    const total = blocks.reduce((n, b) => n + b.length, 0);
    if (total > budget) {
      from = at;
      to = at + 1;
      let used = blocks[at]!.length;
      for (;;) {
        const next =
          to < blocks.length && used + blocks[to]!.length <= budget ? to : -1;
        const prev =
          from > 0 && used + blocks[from - 1]!.length <= budget ? from - 1 : -1;
        if (next < 0 && prev < 0) break;
        if (next >= 0) {
          used += blocks[to]!.length;
          to += 1;
        } else {
          used += blocks[from - 1]!.length;
          from -= 1;
        }
      }
    }
    live.draw(
      frame(ctx, [
        { mark: "active", spans: p.title },
        ...blocks.slice(from, to).flat(),
        ...tail,
      ]),
    );
  };
  try {
    render();
    for (;;) {
      const k = await ctx.keys.next(ctx.signal);
      if (k === null || isCancel(k)) {
        live.commit(frame(ctx, p.cancelled()));
        return cancelled(k);
      }
      if (k.name === "up" || k.name === "k")
        at = (at - 1 + p.options.length) % p.options.length;
      else if (k.name === "down" || k.name === "j")
        at = (at + 1) % p.options.length;
      else if (k.name === "space" || k.sequence === " ") {
        const v = p.options[at]!.value;
        const lock = p.locked?.(v, chosen) ?? null;
        if (lock) note = p.lockedNote?.(v, chosen) ?? lock;
        else {
          const r = p.toggle(chosen, v);
          chosen = r.chosen;
          note = r.note;
        }
        render();
        continue;
      } else if (k.name === "return" || k.name === "enter") {
        const refused = p.check?.(ordered()) ?? null;
        if (refused) {
          note = refused;
          render();
          continue;
        }
        const out = ordered();
        live.commit(frame(ctx, p.done(out)));
        return out;
      }
      note = null;
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
      if (k === null || isCancel(k)) return cancelled(k);
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
      if (k === null || isCancel(k)) return cancelled(k);
      if (k.name === "y") return true;
      if (k.name === "n") return false;
      if (k.name === "return" || k.name === "enter") return initial;
    }
  } finally {
    out.write("\n");
  }
}

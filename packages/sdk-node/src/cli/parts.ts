// The terminal kit's styled parts (docs/design/UI-KITS.md §1.3 layer b, §4.1 "Styled parts"):
// each returns rail rows (term/layout.ts) for one piece of a screen, so a host can compose its
// own flow from the same pieces the drop-in uses. Every string comes from the kit's catalog
// through `ctx.copy`; data (names, versions, ids, URLs) is passed through as data.
//
//   productHeader   ┌  Tidewater Studio  · activate          the chip and the command
//   stepRow         ◆ / ◇ / ✓ / ✗ / ▲ and a title, then muted meta
//   hintsRow        └  Enter activate · Esc cancel          keys strong, actions muted
//   seatMeter       ●●○ 2 of 3 in use                       neutral, never a warning colour
//   codeRows        the user code in reverse video, indented, with air above and below
//   linkSpan        a URL shown without its scheme, an OSC 8 link where the terminal takes it;
//                   it wraps at `/ ? &` and is never cut
//   fixRows         `tidewater activate   Use a different key` command rows, the command above
//                   its label below 50 columns
//   keyMask         the masked key field: the public `pkey_<product>_` prefix, then bullets
//
// Spacing is one rail rhythm: one blank rail row between blocks, never two. A live screen taller
// than the terminal compacts by fit, not by row count (term/screen.ts): the hints join the spinner
// line, then the blank rows, the check line and the countdown go, and only then do the top lines
// leave the view. Printed output never compacts; it scrolls.

import type { KitContext } from "./context.js";
import { keyVerdict, seatCells, type StatusFix } from "./models.js";
import {
  columnsOf,
  contentWidth,
  DROP,
  keyHints,
  separated,
  type Mark,
  type RailRow,
} from "./term/layout.js";
import { displayUrl } from "./term/osc.js";
import { cellWidth, type Line, type Span } from "./term/width.js";

/**
 * A blank rail row between blocks (none under `density: "compact"`). On a live screen it carries a
 * compaction `tier`: the row is dropped only when the screen is taller than the terminal.
 */
export function gap(
  ctx: KitContext,
  tier: number = DROP.blankProse,
): RailRow[] {
  return ctx.theme.density === "compact"
    ? []
    : [{ mark: "rail", spans: [], drop: tier }];
}

/**
 * The flow's first row: the product chip, then the command in muted. A name too long for the line
 * ends in an ellipsis inside the chip, at whatever width the row is laid out at.
 */
export function productHeader(ctx: KitContext, command: string): RailRow[] {
  const sep = ctx.symbols.separator;
  return [
    {
      mark: "start",
      spans: [
        {
          text: ` ${ctx.product.name} `,
          style: ["chip"],
          keep: true,
          shrink: true,
        },
        { text: ` ${sep} ${command}`, style: ["muted"] },
      ],
      role: "header",
    },
    ...gap(ctx).map((r) => ({ ...r, role: "header" as const })),
  ];
}

/** One step: a mark, a title in `strong`, and optional muted meta on the same line. */
export function stepRow(
  mark: Mark,
  title: string | Line,
  meta?: string | Line,
): RailRow {
  const t: Line =
    typeof title === "string" ? [{ text: title, style: ["strong"] }] : title;
  const m: Line =
    meta === undefined
      ? []
      : typeof meta === "string"
        ? [{ text: meta, style: ["muted"] }]
        : meta;
  return { mark, spans: m.length ? [...t, { text: " " }, ...m] : t };
}

/** Body text under a step, on the rail. */
export function textRow(text: string | Line, style?: string[]): RailRow {
  return {
    mark: "rail",
    spans:
      typeof text === "string" ? [{ text, ...(style ? { style } : {}) }] : text,
  };
}

/** A catalog key-hint string as the end row (or a rail row). */
export function hintsRow(
  ctx: KitContext,
  text: string,
  mark: Mark = "end",
): RailRow {
  return { mark, spans: keyHints(text, ctx.symbols), role: "hints" };
}

/** The flow's last row: muted text after the end mark, or the bare mark. */
export function endRow(text?: string | Line): RailRow {
  if (text === undefined) return { mark: "end", spans: [] };
  return {
    mark: "end",
    spans: typeof text === "string" ? [{ text, style: ["muted"] }] : text,
  };
}

/**
 * A URL as a link span: no scheme, never cut and never given an ellipsis. It wraps after `/` or
 * before `?` and `&` when it is wider than a line, and every piece keeps the link.
 */
export function linkSpan(url: string, style: string[] = ["link"]): Span {
  return { text: displayUrl(url), style, link: url, break: "url" };
}

/**
 * The seat meter: filled cells for used seats (§1.5 rule 9). Dots only by default, since the
 * title beside it already says "3 of 3"; `caption` adds the numbers for a screen with no title.
 */
export function seatMeter(
  ctx: KitContext,
  used: number,
  limit: number,
  caption = false,
): RailRow {
  const { filled, empty } = seatCells(used, limit);
  const [on, off] = ctx.caps.unicode ? ["●", "○"] : ["#", "-"];
  return {
    mark: "rail",
    spans: [
      { text: on.repeat(filled), style: ["strong"] },
      { text: off.repeat(empty), style: ["muted"] },
      ...(caption
        ? [
            {
              text: ` ${ctx.copy.t("part.seatMeter.caption", { used, limit })}`,
              style: ["muted"],
            },
          ]
        : []),
    ],
  };
}

/**
 * The user code in reverse video, indented, with a blank rail row above and below (none on a short
 * terminal). The code is never cut: wider than a line, it wraps after a hyphen.
 */
export function codeRows(ctx: KitContext, code: string): RailRow[] {
  return [
    ...gap(ctx, DROP.blankCode),
    {
      mark: "rail",
      spans: [
        { text: "   " },
        { text: ` ${code} `, style: ["code"], break: "code" },
      ],
    },
    ...gap(ctx, DROP.blankCode),
  ];
}

/** Below this many columns a two-column command row stacks: the command, then its label. */
export const STACK_COLUMNS = 50;

/**
 * Command rows: the command in strong, what it does in muted, in two aligned columns; below 50
 * columns, or when a row would not fit its line, the command above its label.
 */
export function commandRows(
  ctx: KitContext,
  rows: ReadonlyArray<{ label: Line; value: Line }>,
): RailRow[] {
  const lines = columnsOf(rows, 3);
  const width = contentWidth(ctx.caps.columns);
  const stack =
    ctx.caps.columns < STACK_COLUMNS ||
    lines.some((l) => cellWidth(l.map((s) => s.text).join("")) > width);
  if (!stack) return lines.map((spans) => ({ mark: "rail" as const, spans }));
  return rows.flatMap((r) => [
    { mark: "rail" as const, spans: r.label },
    { mark: "rail" as const, spans: [{ text: "  " }, ...r.value] },
  ]);
}

/** Commands that fix a state, each as `<bin> <verb>` in strong and what it does in muted. */
export function fixRows(
  ctx: KitContext,
  fixes: readonly StatusFix[],
): RailRow[] {
  return commandRows(
    ctx,
    fixes
      .filter((f) => f.verb !== null)
      .map((f) => ({
        label: [
          { text: `${ctx.bin} ${f.verb}`, style: ["strong"], keep: true },
        ] as Line,
        value: [{ text: ctx.copy.t(f.key), style: ["muted"] }] as Line,
      })),
  );
}

/** Label and value rows aligned in two columns (status, doctor). */
export function tableRows(
  rows: ReadonlyArray<{ mark?: Mark; label: string; value: Line }>,
): RailRow[] {
  const lines = columnsOf(
    rows.map((r) => ({ label: [{ text: r.label }], value: r.value })),
    3,
  );
  return lines.map((spans, i) => ({ mark: rows[i]!.mark ?? "rail", spans }));
}

/** What the masked key field shows: never a character of the secret (UI-KITS §4.3). */
export function keyMask(ctx: KitContext, value: string, fixed = false): Line {
  const v = keyVerdict(value);
  const bullet = ctx.caps.unicode ? "•" : "*";
  // Only the public prefix is ever shown, and only once it is the key format's own.
  const prefix = v.prefix ?? "";
  const secret = [...value.trim()].length - [...prefix].length;
  const count = fixed ? 6 : Math.max(0, Math.min(secret, 40));
  return [{ text: prefix, style: ["muted"] }, { text: bullet.repeat(count) }];
}

/** A catalog string with its " · " in the symbol set's spelling. */
export function sep(ctx: KitContext, text: string): string {
  return separated(text, ctx.symbols);
}

/** A problem: the mark, the title in strong, the message below. */
export function problemRows(
  mark: Mark,
  title: string,
  message?: string,
): RailRow[] {
  return [stepRow(mark, title), ...(message ? [textRow(message)] : [])];
}

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
//   linkSpan        a URL shown without its scheme, an OSC 8 link where the terminal takes it
//   fixRows         `tidewater activate   Use a different key` command rows
//   keyMask         the masked key field: the public `pkey_<product>_` prefix, then bullets

import type { KitContext } from "./context.js";
import { keyVerdict, seatCells, type StatusFix } from "./models.js";
import {
  columnsOf,
  keyHints,
  separated,
  type Mark,
  type RailRow,
} from "./term/layout.js";
import { displayUrl } from "./term/osc.js";
import { cellWidth, truncateEnd, type Line, type Span } from "./term/width.js";

/** A blank rail row between steps (none under `density: "compact"`). */
export function gap(ctx: KitContext): RailRow[] {
  return ctx.theme.density === "compact" ? [] : [{ mark: "rail", spans: [] }];
}

/** The flow's first row: the product chip, then the command in muted. */
export function productHeader(ctx: KitContext, command: string): RailRow[] {
  const sep = ctx.symbols.separator;
  const room = Math.max(8, ctx.caps.columns - 8 - cellWidth(command));
  const name = truncateEnd(ctx.product.name, room, ctx.symbols.ellipsis);
  return [
    {
      mark: "start",
      spans: [
        { text: ` ${name} `, style: ["chip"], keep: true },
        { text: ` ${sep} ${command}`, style: ["muted"] },
      ],
    },
    ...gap(ctx),
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
  return { mark, spans: keyHints(text, ctx.symbols) };
}

/** The flow's last row: muted text after the end mark, or the bare mark. */
export function endRow(text?: string | Line): RailRow {
  if (text === undefined) return { mark: "end", spans: [] };
  return {
    mark: "end",
    spans: typeof text === "string" ? [{ text, style: ["muted"] }] : text,
  };
}

/** A URL as a link span: no scheme, kept whole (cut in the middle when it cannot fit). */
export function linkSpan(url: string, style: string[] = ["link"]): Span {
  return { text: displayUrl(url), style, link: url, keep: true };
}

/** The seat meter: filled cells for used seats, a caption with the numbers (§1.5 rule 9). */
export function seatMeter(
  ctx: KitContext,
  used: number,
  limit: number,
): RailRow {
  const { filled, empty } = seatCells(used, limit);
  const [on, off] = ctx.caps.unicode ? ["●", "○"] : ["#", "-"];
  return {
    mark: "rail",
    spans: [
      { text: on.repeat(filled), style: ["strong"] },
      { text: off.repeat(empty), style: ["muted"] },
      {
        text: ` ${ctx.copy.t("part.seatMeter.caption", { used, limit })}`,
        style: ["muted"],
      },
    ],
  };
}

/** The user code in reverse video, indented, with a blank rail row above and below. */
export function codeRows(ctx: KitContext, code: string): RailRow[] {
  return [
    { mark: "rail", spans: [] },
    {
      mark: "rail",
      spans: [
        { text: "   " },
        { text: ` ${code} `, style: ["code"], keep: true },
      ],
    },
    { mark: "rail", spans: [] },
  ];
}

/** Commands that fix a state, each as `<bin> <verb>` in strong and what it does in muted. */
export function fixRows(
  ctx: KitContext,
  fixes: readonly StatusFix[],
): RailRow[] {
  const rows = fixes
    .filter((f) => f.verb !== null)
    .map((f) => ({
      label: [
        { text: `${ctx.bin} ${f.verb}`, style: ["strong"], keep: true },
      ] as Line,
      value: [{ text: ctx.copy.t(f.key), style: ["muted"] }] as Line,
    }));
  return columnsOf(rows, 3).map((spans) => ({ mark: "rail" as const, spans }));
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

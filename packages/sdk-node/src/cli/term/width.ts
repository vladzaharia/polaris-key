// Cell widths, wrapping and truncation for the terminal kit (UI-KITS.md §1.5 rules 12 and 13).
//
// A terminal lays text out in cells: a CJK ideograph or an emoji takes two, a combining mark
// none. The launch locales include ja, ko and zh-Hans, so every width here is in cells, never in
// UTF-16 units. Escape sequences (SGR colour, OSC 8 links) take no cells.
//
// Keys and user codes never break and never truncate at the end: a token that will not fit is
// cut in the middle (`pkey_tidewater_7Q2M…3WPLDA`).

/** CSI (colour) and OSC (links, clipboard) sequences. */
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The text without escape sequences. */
export function stripAnsi(s: string): string {
  return s.replace(ESCAPES, "");
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const ZERO = /[\p{Mn}\p{Me}\u200b-\u200f\u2060\ufe0f]/u;

/** Cells one code point takes. */
export function charWidth(ch: string): number {
  if (ZERO.test(ch)) return 0;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Cells a string takes on screen. */
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Pad with spaces on the end side to `width` cells. */
export function padEnd(s: string, width: number): string {
  const w = cellWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** Cut `s` to at most `max` cells in the middle, keeping both ends (keys, codes, URLs). */
export function truncateMiddle(s: string, max: number, ellipsis = "…"): string {
  if (cellWidth(s) <= max) return s;
  const room = Math.max(2, max - cellWidth(ellipsis));
  const chars = [...s];
  const headRoom = Math.ceil(room / 2);
  const tailRoom = room - headRoom;
  let head = "";
  let hw = 0;
  for (const ch of chars) {
    const cw = charWidth(ch);
    if (hw + cw > headRoom) break;
    head += ch;
    hw += cw;
  }
  let tail = "";
  let tw = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!);
    if (tw + cw > tailRoom) break;
    tail = chars[i]! + tail;
    tw += cw;
  }
  return head + ellipsis + tail;
}

/** Cut `s` at the end to `max` cells (prose only; never a key or a code). */
export function truncateEnd(s: string, max: number, ellipsis = "…"): string {
  if (cellWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  const room = max - cellWidth(ellipsis);
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** A run of text with one style. `keep` marks a key, code or URL that never breaks. */
export interface Span {
  text: string;
  /** Roles applied in order (see paint.ts). */
  style?: readonly string[];
  /** An OSC 8 target for this run. */
  link?: string;
  /** Never break inside, and cut in the middle when longer than a line. */
  keep?: boolean;
}

export type Line = Span[];

/** Split text into break opportunities: words keep their trailing spaces; wide characters break. */
function pieces(span: Span): Span[] {
  if (span.keep) return [span];
  const out: Span[] = [];
  const re = /[^\s]+\s*|\s+/gu;
  for (const m of span.text.matchAll(re)) {
    const word = m[0];
    // A run of CJK may break between any two ideographs.
    if ([...word].some((c) => charWidth(c) === 2)) {
      let cur = "";
      for (const ch of word) {
        if (charWidth(ch) === 2 && cur !== "") {
          out.push({ ...span, text: cur });
          cur = "";
        }
        cur += ch;
      }
      if (cur) out.push({ ...span, text: cur });
    } else out.push({ ...span, text: word });
  }
  return out;
}

/**
 * Wrap styled spans to `width` cells. Lines break at spaces (and between CJK characters); a `keep`
 * span that does not fit on a line of its own is cut in the middle. Trailing spaces are dropped.
 */
export function wrapSpans(spans: Line, width: number, ellipsis = "…"): Line[] {
  const lines: Line[] = [[]];
  let w = 0;
  const push = (p: Span) => {
    const cur = lines[lines.length - 1]!;
    const last = cur[cur.length - 1];
    if (
      last &&
      last.link === p.link &&
      last.keep === p.keep &&
      (last.style ?? []).join() === (p.style ?? []).join()
    )
      last.text += p.text;
    else cur.push({ ...p });
  };
  for (const span of spans) {
    for (let p of pieces(span)) {
      const pw = cellWidth(p.text.trimEnd());
      if (w > 0 && w + pw > width) {
        lines.push([]);
        w = 0;
        if (/^\s+$/.test(p.text)) continue;
      }
      if (pw > width && p.keep)
        p = { ...p, text: truncateMiddle(p.text, width, ellipsis) };
      push(p);
      w += cellWidth(p.text);
    }
  }
  return lines.map((line) => {
    const last = line[line.length - 1];
    if (last && !last.keep) last.text = last.text.trimEnd();
    return line.filter((s) => s.text !== "");
  });
}

/** Plain text wrapped to `width` cells. */
export function wrapText(text: string, width: number): string[] {
  return wrapSpans([{ text }], width).map((l) => l.map((s) => s.text).join(""));
}

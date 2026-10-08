// Cell widths, wrapping and truncation for the terminal kit (UI-KITS.md §1.5 rules 12 and 13).
//
// A terminal lays text out in cells: a CJK ideograph or an emoji takes two, a combining mark
// none. The launch locales include ja, ko and zh-Hans, so every width here is in cells, never in
// UTF-16 units. Escape sequences (SGR colour, OSC 8 links) take no cells.
//
// Three kinds of token never break at a space like prose does:
//
//   keys       a license key or an id: kept on one line, cut in the middle when it cannot fit
//              (`pkey_tidewater_7Q2M…3WPLDA`); the person compares its ends, never types it.
//   URLs       a page the person may have to type: never cut and never given an ellipsis. One that
//              does not fit the rest of the line starts a line of its own and, when it is wider
//              than a line, wraps after a `/` or before a `?` or `&` (then after a `-` or before a
//              `.`, then anywhere), hanging under the content column. Each piece keeps the link.
//   codes      a user code: never cut; wider than a line, it wraps after a `-`.

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

/** A run of text with one style. */
export interface Span {
  text: string;
  /** Roles applied in order (see paint.ts). */
  style?: readonly string[];
  /** An OSC 8 target for this run. */
  link?: string;
  /** A key or an id: never break inside, and cut in the middle when longer than a line. */
  keep?: boolean;
  /**
   * A URL or a user code: never cut and never given an ellipsis; it wraps at its own break points
   * when it is wider than a line (see above).
   */
  break?: "url" | "code";
  /**
   * Part of one keep-unit (a name, an email, a date, "3 of 3", "38 MB", a key and its label): a
   * maximal run of adjacent spans all marked `unit` moves to the next line whole, and breaks at
   * its own spaces only when it is wider than the line. A separator span (not `unit`) ends a run.
   */
  unit?: boolean;
  /**
   * A name that gives way (the product chip): when the spans do not fit one line, this one is cut
   * at its end with an ellipsis, inside its pad, so the line fits. At the width it is laid out at,
   * so a resize lays it out again.
   */
  shrink?: boolean;
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

/** Split `text` after each character `after` matches and before each one `before` matches. */
function splitAt(text: string, after: RegExp, before?: RegExp): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (before?.test(ch) && cur !== "") {
      out.push(cur);
      cur = "";
    }
    cur += ch;
    if (after.test(ch)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Cut `text` into runs of at most `width` cells (the last resort: no break point fits). */
function hardSplit(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > width && cur !== "") {
      out.push(cur);
      cur = "";
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The pieces a URL or a user code may wrap between, none wider than `width`: a URL after `/` and
 * before `?` and `&`, a piece still too wide after `-` and before `.`; a code after `-`; anything
 * still too wide is cut into runs of `width` cells. Joined, the pieces are the text unchanged.
 */
export function breakPieces(
  text: string,
  kind: "url" | "code",
  width: number,
): string[] {
  const w = Math.max(1, width);
  const first =
    kind === "url" ? splitAt(text, /\//, /[?&]/) : splitAt(text, /-/);
  const second =
    kind === "url"
      ? first.flatMap((p) => (cellWidth(p) > w ? splitAt(p, /-/, /\./) : [p]))
      : first;
  return second.flatMap((p) => (cellWidth(p) > w ? hardSplit(p, w) : [p]));
}

/**
 * Wrap styled spans to `width` cells. Lines break at spaces (and between CJK characters); a `keep`
 * span that does not fit on a line of its own is cut in the middle; a URL or a code wraps at its
 * own break points and is never cut; a last line of one lone word takes the word before it along
 * (UI-KITS §1.5 rule 11). Trailing spaces are dropped.
 */
export function wrapSpans(spans: Line, width: number, ellipsis = "…"): Line[] {
  const lines = wrapPieces(
    shrinkToFit(spans, width, ellipsis),
    width,
    ellipsis,
  );
  balanceLast(lines, width);
  return lines.map(merge);
}

const textOf = (pieces: readonly Span[]) => pieces.map((p) => p.text).join("");
const widthOf = (pieces: readonly Span[]) =>
  cellWidth(textOf(pieces).trimEnd());
const words = (pieces: readonly Span[]) =>
  pieces.filter((p) => p.text.trim() !== "");

/** A last line of one Latin word (CJK lines and kept tokens such as a URL are never orphans). */
function isOrphan(pieces: readonly Span[]): boolean {
  const ws = words(pieces);
  if (ws.length !== 1 || ws[0]!.keep || ws[0]!.break || ws[0]!.unit)
    return false;
  return ![...ws[0]!.text].some((c) => charWidth(c) === 2);
}

/** Move words from the line before an orphan down to it, while both still fit. */
function balanceLast(lines: Span[][], width: number): void {
  const n = lines.length;
  if (n < 2 || !isOrphan(lines[n - 1]!)) return;
  const prev = lines[n - 2]!;
  const last = lines[n - 1]!;
  // Pieces keep their trailing space; the previous line's last word needs one again.
  for (let k = prev.length - 1; k >= 1; k--) {
    // A piece of a URL, a code or a keep-unit stays where it is.
    if (prev.slice(k).some((p) => p.break || p.unit)) return;
    const head = prev.slice(0, k);
    const moved = prev
      .slice(k)
      .map((p, i, all) =>
        i === all.length - 1 && !/\s$/.test(p.text)
          ? { ...p, text: `${p.text} ` }
          : p,
      );
    const tail = [...moved, ...last];
    if (words(head).length === 0) return;
    if (
      widthOf(head) <= width &&
      widthOf(tail) <= width &&
      words(tail).length >= 2
    ) {
      while (head.length > 1 && SEPARATOR.test(head[head.length - 1]!.text))
        head.pop();
      lines[n - 2] = head;
      lines[n - 1] = tail;
      return;
    }
  }
}

/** A separator between items ("·"): it divides items on one line, so a line never ends with one. */
const SEPARATOR = /^\s*·\s*$/;

/** The non-space width of a run of spans. */
const runWidth = (run: readonly Span[]) =>
  cellWidth(
    run
      .map((p) => p.text)
      .join("")
      .trimEnd(),
  );

/** Pull a short trailing lead-in ("go to") off `line` down onto a URL's own line, when it fits. */
function pullLeadIn(line: Span[], first: number, width: number): Span[] {
  const moved: Span[] = [];
  let w = first;
  while (line.length) {
    const word = line[line.length - 1]!;
    if (word.break || word.unit || /^\s+$/.test(word.text)) break;
    const ww = cellWidth(word.text.trimEnd());
    // Only a short lead-in of one or two words moves; a long trailing word stays put.
    if (ww > 6 || moved.length >= 2 || w + ww + 1 > width) break;
    moved.unshift(line.pop()!);
    w += ww + 1;
  }
  // Drop a trailing separator left on the previous line.
  while (line.length && SEPARATOR.test(line[line.length - 1]!.text)) line.pop();
  return moved;
}

function wrapPieces(spans: Line, width: number, ellipsis: string): Span[][] {
  const lines: Span[][] = [[]];
  let w = 0;
  const cur = () => lines[lines.length - 1]!;
  const onlyWhitespace = () => cur().every((p) => /^\s*$/.test(p.text));
  const newLine = () => {
    const last = cur();
    while (last.length > 1 && SEPARATOR.test(last[last.length - 1]!.text))
      last.pop();
    lines.push([]);
    w = 0;
  };
  // A maximal run of adjacent `unit` spans is one token.
  const runs: Span[][] = [];
  for (const span of spans) {
    const last = runs[runs.length - 1];
    if (span.unit && last && last[0]!.unit) last.push(span);
    else runs.push([span]);
  }
  for (const run of runs) {
    if (run[0]!.unit && run.length >= 1 && !run[0]!.break) {
      const rw = runWidth(run);
      // A unit that does not fit the rest of the line moves to the next line whole; wider than a
      // line, it falls through to break at its own spaces.
      if (rw <= width) {
        if (w > 0 && w + rw > width) newLine();
        for (const p of run) {
          cur().push(p);
          w += cellWidth(p.text);
        }
        continue;
      }
    }
    for (const span of run) {
      if (span.break) {
        const tw = cellWidth(span.text);
        if (w > 0 && w + tw > width && !onlyWhitespace()) {
          const lead = pullLeadIn(
            cur(),
            cellWidth(breakPieces(span.text, span.break, width)[0] ?? ""),
            width,
          );
          newLine();
          for (const p of lead) {
            cur().push(p);
            w += cellWidth(p.text);
          }
        }
        for (const text of breakPieces(span.text, span.break, width)) {
          const pw = cellWidth(text);
          if (w > 0 && w + pw > width) newLine();
          cur().push({ ...span, text });
          w += pw;
        }
        continue;
      }
      for (let p of pieces(span)) {
        const pw = cellWidth(p.text.trimEnd());
        if (w > 0 && w + pw > width) {
          newLine();
          if (/^\s+$/.test(p.text)) continue;
        }
        if (pw > width && p.keep)
          p = { ...p, text: truncateMiddle(p.text, width, ellipsis) };
        cur().push(p);
        w += cellWidth(p.text);
      }
    }
  }
  return lines;
}

/** The fewest cells a `shrink` span is cut to; narrower than this, the line wraps instead. */
const SHRINK_FLOOR = 8;

/** Cut the `shrink` span at its end so the spans fit one line of `width` cells, when they can. */
function shrinkToFit(spans: Line, width: number, ellipsis: string): Line {
  const total = cellWidth(
    spans
      .map((s) => s.text)
      .join("")
      .trimEnd(),
  );
  const i = spans.findIndex((s) => s.shrink);
  if (i < 0 || total <= width) return spans;
  const span = spans[i]!;
  const lead = /^\s*/.exec(span.text)![0];
  const trail = /\s*$/.exec(span.text)![0];
  const inner = span.text.slice(lead.length, span.text.length - trail.length);
  const room = Math.max(SHRINK_FLOOR, cellWidth(inner) - (total - width));
  const cut = truncateEnd(inner, room, ellipsis);
  // No space before the ellipsis ("Mastering Suite…", not "Mastering Suite …").
  const name = cut.endsWith(ellipsis)
    ? `${cut.slice(0, -ellipsis.length).trimEnd()}${ellipsis}`
    : cut;
  const out = [...spans];
  out[i] = {
    ...span,
    text: `${lead}${name}${trail}`,
  };
  return out;
}

/** Join neighbouring pieces of one style, and drop the line's trailing space. */
function merge(pieces: Span[]): Line {
  const out: Span[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (
      last &&
      last.link === p.link &&
      last.keep === p.keep &&
      last.break === p.break &&
      last.unit === p.unit &&
      (last.style ?? []).join() === (p.style ?? []).join()
    )
      last.text += p.text;
    else out.push({ ...p });
  }
  const last = out[out.length - 1];
  if (last && !last.keep && !last.break) last.text = last.text.trimEnd();
  return out.filter((s) => s.text !== "");
}

/** Plain text wrapped to `width` cells. */
export function wrapText(text: string, width: number): string[] {
  return wrapSpans([{ text }], width).map((l) => l.map((s) => s.text).join(""));
}

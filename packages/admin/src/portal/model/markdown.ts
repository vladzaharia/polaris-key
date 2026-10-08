/**
 * Release notes as Markdown (owner polish 2026-10-07; PORTAL.md §4.20 What's new). The notes are
 * the developer's text, usually GitHub Markdown, so they are untrusted: this reads them into a
 * small tree of blocks and inlines that the What's new card renders as React elements. Nothing
 * here, or in the renderer, ever produces an HTML string, so raw HTML in the notes is shown as
 * the text it is, and the page's Content-Security-Policy is never involved.
 *
 * What it reads: ATX headings, paragraphs (a single newline is a line break, as GitHub shows
 * release notes), bullet and numbered lists (nested items are read as items of the same list),
 * block quotes, fenced code, thematic breaks; inline code, bold, italic, strikethrough, links,
 * autolinks and bare `https://` URLs, and backslash escapes. An image is its alt text. A link is a
 * link only when its target is a safe absolute URL ({@link safeHref}): anything else is its text.
 *
 * No pattern here can backtrack without bound: the block pass reads line by line, and the inline
 * pass scans each line left to right with a bounded nesting depth.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong" | "em" | "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

/** One line of a paragraph, a list item or a quote. */
export type Line = Inline[];

export type Block =
  /** `level` is the HTML heading level (3–6) once {@link outline} has placed it. */
  | { kind: "heading"; depth: number; level: number; children: Inline[] }
  | { kind: "p"; lines: Line[] }
  | { kind: "ul"; items: Line[][] }
  | { kind: "ol"; start: number; items: Line[][] }
  | { kind: "quote"; lines: Line[] }
  | { kind: "code"; text: string }
  | { kind: "hr" };

/** The deepest inline nesting read ("**_~~x~~_**"); deeper markers are text. */
const MAX_DEPTH = 4;

/**
 * The link target, when it is safe to follow: an absolute `https:` URL with no credentials, or a
 * `mailto:` address. Relative links, `http:`, `javascript:`, `data:` and the rest are null.
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!/^(https:\/\/|mailto:)/i.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return url.pathname.includes("@") ? s : null;
  if (url.protocol !== "https:" || url.username || url.password || !url.host)
    return null;
  return url.href;
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const BULLET = /^[-*+•][ \t]+(.*)$/;
const NUMBERED = /^(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE = /^(`{3,}|~{3,})/;
const RULE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^>[ \t]?(.*)$/;

/** The notes as blocks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // the closing fence, or the end
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      i++;
      // An empty heading ("##") says nothing: it is dropped, never drawn as an empty h3.
      if (!heading[2]?.trim()) continue;
      blocks.push({
        kind: "heading",
        depth: heading[1]!.length,
        level: 3,
        children: parseInline(heading[2]),
      });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: Line[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!.trim())) {
        const q = lines[i]!.trim().match(QUOTE)![1]!.trim();
        if (q) quoted.push(parseInline(q));
        i++;
      }
      if (quoted.length) blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    const bullet = BULLET.test(line);
    const numbered = line.match(NUMBERED);
    if (bullet || numbered) {
      const items: Line[][] = [];
      const pattern = bullet ? BULLET : NUMBERED;
      while (i < lines.length) {
        const l = lines[i]!.trim();
        const m = l.match(pattern);
        if (m) {
          items.push([parseInline(m[m.length - 1]!)]);
          i++;
          continue;
        }
        // An indented line under an item continues it, on a line of its own.
        if (l && /^[ \t]{2,}/.test(lines[i]!) && !isBlockStart(l)) {
          items[items.length - 1]!.push(parseInline(l));
          i++;
          continue;
        }
        // A blank line between two items keeps one list (a "loose" list).
        if (!l) {
          let next = i + 1;
          while (next < lines.length && !lines[next]!.trim()) next++;
          if (next < lines.length && pattern.test(lines[next]!.trim())) {
            i = next;
            continue;
          }
        }
        break;
      }
      blocks.push(
        bullet
          ? { kind: "ul", items }
          : { kind: "ol", start: Number(numbered![1]), items },
      );
      continue;
    }
    const para: Line[] = [];
    while (i < lines.length) {
      const l = lines[i]!.trim();
      if (!l || isBlockStart(l)) break;
      para.push(parseInline(l));
      i++;
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
}

/**
 * Place the headings under the card's own `h2`: the shallowest Markdown depth becomes `h3`, the
 * next `h4`, and so on, never more than one level below the heading before it (so "#### Fixes"
 * first is an `h3`, and the page's outline never skips a level).
 */
export function outline(blocks: Block[], base = 3): Block[] {
  const depths = [
    ...new Set(blocks.flatMap((b) => (b.kind === "heading" ? [b.depth] : []))),
  ].sort((a, b) => a - b);
  let previous = base - 1;
  return blocks.map((b) => {
    if (b.kind !== "heading") return b;
    const ranked = base + depths.indexOf(b.depth);
    const level = Math.min(ranked, previous + 1, 6);
    previous = level;
    return { ...b, level };
  });
}

// ── The summary ─────────────────────────────────────────────────────────────────────────────────

/** How much of the first paragraph or list shows before **Show full notes**. */
export const SUMMARY_LINES = 3;

export interface ReleaseNotes {
  /** What shows at once: any leading headings, then the first paragraph or list, cut to three. */
  summary: Block[];
  /** The rest of the notes, in order: the summary and the rest together are the whole notes. */
  rest: Block[];
}

/**
 * The notes as a short summary and the rest. The summary runs to the first paragraph, list,
 * quote or code block; a paragraph or list longer than {@link SUMMARY_LINES} lines or items is cut
 * there and continues at the start of the rest (a numbered list keeps counting).
 */
export function releaseNotes(text: string, max = SUMMARY_LINES): ReleaseNotes {
  const blocks = outline(parseMarkdown(text));
  const summary: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "heading" || b.kind === "hr") {
      summary.push(b);
      continue;
    }
    const after = blocks.slice(i + 1);
    if ((b.kind === "p" || b.kind === "quote") && b.lines.length > max) {
      summary.push({ ...b, lines: b.lines.slice(0, max) });
      return { summary, rest: [{ ...b, lines: b.lines.slice(max) }, ...after] };
    }
    if (b.kind === "ul" && b.items.length > max) {
      summary.push({ ...b, items: b.items.slice(0, max) });
      return { summary, rest: [{ ...b, items: b.items.slice(max) }, ...after] };
    }
    if (b.kind === "ol" && b.items.length > max) {
      summary.push({ ...b, items: b.items.slice(0, max) });
      return {
        summary,
        rest: [
          { ...b, start: b.start + max, items: b.items.slice(max) },
          ...after,
        ],
      };
    }
    summary.push(b);
    return { summary, rest: after };
  }
  return { summary, rest: [] };
}

// ── Inlines ─────────────────────────────────────────────────────────────────────────────────────

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!~<>|".split(""));

/** One line's inlines. */
export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    // A backslash escape: the next character as itself.
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    // Inline code: up to the same run of backticks, never parsed further.
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      const close = text.indexOf(ticks, i + run);
      if (close >= 0) {
        flush();
        out.push({ kind: "code", text: text.slice(i + run, close).trim() });
        i = close + run;
        continue;
      }
      buf += ticks;
      i += run;
      continue;
    }
    // An image: its alt text only (the notes never load a remote image).
    if (c === "!" && text[i + 1] === "[") {
      const link = readLink(text, i + 1);
      if (link) {
        buf += link.label;
        i = link.end;
        continue;
      }
    }
    if (c === "[") {
      const link = readLink(text, i);
      if (link) {
        flush();
        // A link with no words reads as its address, so it always has a name.
        const children: Inline[] = !link.label.trim()
          ? [{ kind: "text", text: link.href }]
          : depth < MAX_DEPTH
            ? parseInline(link.label, depth + 1)
            : [{ kind: "text", text: link.label }];
        const href = safeHref(link.href);
        if (href) out.push({ kind: "link", href, children });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }
    // An autolink: <https://…> or <mailto:…>.
    if (c === "<") {
      const close = text.indexOf(">", i + 1);
      const inner = close > 0 ? text.slice(i + 1, close) : "";
      const href = inner && !/\s/.test(inner) ? safeHref(inner) : null;
      if (href) {
        flush();
        out.push({
          kind: "link",
          href,
          children: [{ kind: "text", text: inner }],
        });
        i = close + 1;
        continue;
      }
    }
    // A bare https URL, at a word's start, without the punctuation that ends a sentence.
    if (
      (c === "h" || c === "H") &&
      /^https:\/\//i.test(text.slice(i, i + 8)) &&
      (i === 0 || /[\s(]/.test(text[i - 1]!))
    ) {
      let end = i;
      while (end < text.length && !/[\s<>]/.test(text[end]!)) end++;
      while (end > i && /[.,;:!?)\]'"]/.test(text[end - 1]!)) end--;
      const url = text.slice(i, end);
      const href = safeHref(url);
      if (href) {
        flush();
        out.push({
          kind: "link",
          href,
          children: [{ kind: "text", text: url }],
        });
        i = end;
        continue;
      }
    }
    // Emphasis: **strong**, __strong__, *em*, _em_ (at word edges), ~~del~~.
    if (depth < MAX_DEPTH && (c === "*" || c === "_" || c === "~")) {
      const span = readEmphasis(text, i);
      if (span) {
        flush();
        out.push({
          kind: span.kind,
          children: parseInline(span.inner, depth + 1),
        });
        i = span.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** `[label](href)` from `start` (the `[`), or null. */
function readLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  let level = 0;
  let close = -1;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "[") level++;
    else if (ch === "]" && --level === 0) {
      close = j;
      break;
    }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  // The destination ends at its own `)`: parentheses inside it are balanced.
  let end = -1;
  let parens = 0;
  for (let j = close + 2; j < text.length; j++) {
    if (text[j] === "(") parens++;
    else if (text[j] === ")" && parens-- === 0) {
      end = j;
      break;
    }
  }
  if (end < 0) return null;
  // `(url "title")`: the title is dropped.
  const target =
    text
      .slice(close + 2, end)
      .trim()
      .split(/\s+/)[0] ?? "";
  return { label: text.slice(start + 1, close), href: target, end: end + 1 };
}

function readEmphasis(
  text: string,
  start: number,
): { kind: "strong" | "em" | "del"; inner: string; end: number } | null {
  const c = text[start]!;
  const double = text[start + 1] === c;
  if (c === "~" && !double) return null;
  const marker = double ? c + c : c;
  const open = start + marker.length;
  // An opener is followed by a non-space; `_` opens only at a word's start (snake_case stays).
  if (open >= text.length || /\s/.test(text[open]!)) return null;
  if (c === "_" && start > 0 && /\w/.test(text[start - 1]!)) return null;
  let from = open;
  while (from < text.length) {
    const close = text.indexOf(marker, from);
    if (close < 0) return null;
    const inner = text.slice(open, close);
    const next = text[close + marker.length];
    const ok =
      inner.length > 0 &&
      !/\s/.test(text[close - 1]!) &&
      // A single `*` must not close on the first half of a `**`.
      !(!double && next === c) &&
      !(c === "_" && next !== undefined && /\w/.test(next));
    if (ok)
      return {
        kind: c === "~" ? "del" : double ? "strong" : "em",
        inner,
        end: close + marker.length,
      };
    from = close + marker.length;
  }
  return null;
}

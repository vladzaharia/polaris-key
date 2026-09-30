// Text extraction and quote matching for the policy re-check harness. No dependencies.
import { createHash } from "node:crypto";

const ENT = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

/** HTML to readable text: article or main body when present, no script/style/nav, cells joined with " | ". */
export function htmlToText(html) {
  let s = html;
  const body =
    /<article[\s\S]*<\/article>/i.exec(s) ?? /<main[\s\S]*<\/main>/i.exec(s);
  if (body) s = body[0];
  s = s.replace(
    /<(script|style|noscript|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  s = s.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, " | ");
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s);
}

/** Markdown to text: drop emphasis and code marks so quotes match the rendered wording. */
export function mdToText(md) {
  return md.replace(/[*`]/g, "");
}

/** Apple DocC JSON (developer.apple.com/tutorials/data/...) to text. */
export function doccToText(json) {
  const out = [];
  const walk = (y) => {
    if (Array.isArray(y)) return y.forEach(walk);
    if (!y || typeof y !== "object") return;
    if (y.type === "text") out.push(y.text);
    else if (y.type === "codeVoice") out.push(y.code);
    else if (
      ["paragraph", "heading", "listItem", "row", "tableRow"].includes(y.type)
    )
      out.push("\n");
    for (const [k, v] of Object.entries(y)) if (k !== "references") walk(v);
  };
  walk(json);
  return out.join("");
}

/** Normalise for matching: smart quotes, dashes, zero-width, and all whitespace collapse to one space. */
export function norm(s) {
  return s
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasQuote(text, quote) {
  return norm(text).includes(norm(quote));
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function firstMatch(text, regex) {
  const m = regex.exec(text);
  return m ? (m[1] ?? m[0]) : null;
}

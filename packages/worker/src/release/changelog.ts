/// <reference types="@cloudflare/workers-types" />

/**
 * Curated-summary extraction for the `/changelog` surface.
 *
 * A release body usually carries an explicitly-curated, user-facing summary block
 * fenced by HTML comment markers (`<!-- pkey:summary -->...<!-- /pkey:summary -->`,
 * marker token configurable per product). When that block is absent we fall back to
 * the first prose paragraph that appears *above* the first `## ` heading, stripped of
 * markdown noise and length-capped. The marker token is treated literally (escaped),
 * so an operator can pick any token without it being interpreted as regex.
 */

const MAX_SUMMARY_CHARS = 600;
const DEFAULT_MARKER = "pkey:summary";

export interface ChangelogEntry {
  version: string;
  tag: string;
  date: string | null;
  summary: string | null;
  url: string;
}

/** Escape a string for safe literal use inside a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cap(s: string): string {
  const t = s.trim();
  return t.length > MAX_SUMMARY_CHARS
    ? `${t.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…`
    : t;
}

/** Strip light markdown (emphasis, links, leading list/heading markers) to plain prose. */
function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/[*_`]+/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .trim();
}

/**
 * Extract the curated summary from a release body. Prefers the marker block; falls
 * back to the first paragraph above the first `## ` heading. Returns `null` if neither
 * yields prose. `marker` defaults to `pkey:summary`. We use String.match (not
 * RegExp matching against the body) so the engine's lint stays happy.
 */
export function extractSummary(
  body: string | null | undefined,
  marker: string = DEFAULT_MARKER,
): string | null {
  if (!body) return null;

  const tok = escapeRegex(marker.trim() || DEFAULT_MARKER);
  const markerRe = new RegExp(
    `<!--\\s*${tok}\\s*-->\\s*([\\s\\S]*?)\\s*<!--\\s*/${tok}\\s*-->`,
  );
  const fenced = body.match(markerRe)?.[1];
  if (fenced && fenced.trim()) return cap(stripMarkdown(fenced));

  // Fallback: everything before the first `## ` heading, first non-empty paragraph.
  const headingIdx = body.search(/^##\s/m);
  const head = headingIdx >= 0 ? body.slice(0, headingIdx) : body;
  const para = head
    .split(/\n\s*\n/)
    .map((p) => stripMarkdown(p))
    .find((p) => p.length > 0);
  return para ? cap(para) : null;
}

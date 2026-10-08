/**
 * HTML escaping for the Worker's server-rendered pages and emails.
 *
 * ONE module (P0-15). The copies it replaced did not all agree on the apostrophe, and the
 * difference reaches real output (a product name such as "Ada's Game"), so the three spellings
 * are kept as three named functions rather than merged; each caller keeps the bytes it had.
 * New code uses `escapeHtml`.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

function escapeCore(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape for HTML text and quoted attribute values: `& < > " '` (the apostrophe as `&#x27;`). */
export function escapeHtml(s: string): string {
  return escapeCore(s).replace(/'/g, "&#x27;");
}

/** As `escapeHtml`, but the apostrophe as `&#39;` (the download page and the Godot registry). */
export function escapeHtmlDecimalApostrophe(s: string): string {
  return escapeCore(s).replace(/'/g, "&#39;");
}

/**
 * `& < > "` only; an apostrophe passes through. Safe for text and DOUBLE-quoted attributes, never
 * a single-quoted one. Kept for the product sign-in pages, whose output it has always produced.
 */
export function escapeHtmlKeepApostrophe(s: string): string {
  return escapeCore(s);
}

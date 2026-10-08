// OSC 8 hyperlinks and OSC 52 clipboard writes (UI-KITS.md §1.4 "Interaction"; SIGN-IN.md D-68).
// Callers decide whether the terminal takes them (caps.links); these only build the sequences,
// with every control character removed from what goes inside them.

import { clean, safeLink } from "./sanitize.js";

/**
 * `text` as a link to `url` (OSC 8), when the URL is safe to link (an `https:` URL or loopback
 * `http:`, with no whitespace, control character or userinfo); otherwise the text, unlinked.
 */
export function osc8(url: string, text: string): string {
  const safe = safeLink(url);
  if (!safe) return text;
  return `\x1b]8;;${safe}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Copy `text` to the system clipboard through the terminal (OSC 52). */
export function osc52(text: string): string {
  const payload = Buffer.from(clean(text), "utf8").toString("base64");
  return `\x1b]52;c;${payload}\x07`;
}

/** A URL as people read it: no scheme, no trailing slash, no control character. */
export function displayUrl(url: string): string {
  return clean(url)
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

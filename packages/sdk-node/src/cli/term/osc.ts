// OSC 8 hyperlinks and OSC 52 clipboard writes (UI-KITS.md §1.4 "Interaction"; SIGN-IN.md D-68).
// Callers decide whether the terminal takes them (caps.links); these only build the sequences,
// with every control character removed from what goes inside them.

const CONTROL = /[\x00-\x1f\x7f]/g;

/** `text` as a link to `url` (OSC 8). An unsafe or non-http(s) URL leaves the text plain. */
export function osc8(url: string, text: string): string {
  const clean = url.replace(CONTROL, "");
  if (!/^https?:\/\//i.test(clean)) return text;
  return `\x1b]8;;${clean}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Copy `text` to the system clipboard through the terminal (OSC 52). */
export function osc52(text: string): string {
  const payload = Buffer.from(text.replace(CONTROL, ""), "utf8").toString(
    "base64",
  );
  return `\x1b]52;c;${payload}\x07`;
}

/** A URL as people read it: no scheme, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

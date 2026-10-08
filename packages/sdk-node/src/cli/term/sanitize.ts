// Text from the server or the product (a device label, a name, an email, a developer name, a
// changelog summary, a URL, the verification URI) is drawn as text, never as an escape: every
// C0 control, DEL and C1 control is removed before it reaches a terminal (one sanitiser, at the
// writer: Painter). The kit's own escapes (colour, OSC 8, cursor control) are emitted around
// the cleaned text, never inside it. A device label that carried an OSC 52 clipboard write or a
// screen clear is printed as its harmless remainder.

/** C0 controls, DEL and C1 controls: whatever could start, end or smuggle an escape. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** `text` with every control character removed. */
export function clean(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * `url` when it may become an OSC 8 hyperlink: an absolute `https:` URL, or `http:` to a
 * loopback host, with no whitespace, control character or userinfo. Anything else is null, and
 * is drawn as text without a link.
 */
export function safeLink(url: string | undefined | null): string | null {
  if (!url || /[\s\u0000-\u001f\u007f-\u009f]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return url;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return url;
  return null;
}

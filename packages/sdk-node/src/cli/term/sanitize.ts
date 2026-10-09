// Text from the server or the product (a device label, a name, an email, a developer name, a
// changelog summary, a URL, the verification URI) is drawn as text, never as an escape: every
// C0 control, DEL and C1 control is removed before it reaches a terminal (one sanitiser, at the
// writer: Painter). The kit's own escapes (colour, OSC 8, cursor control) are emitted around
// the cleaned text, never inside it. A device label that carried an OSC 52 clipboard write or a
// screen clear is printed as its harmless remainder.

/** C0 controls, DEL and C1 controls: whatever could start, end or smuggle an escape. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Controls, plus what changes how text reads without showing: bidi marks, overrides and isolates
 * (U+061C, U+200E, U+200F, U+202A-202E, U+2066-2069) and the zero-width characters U+200B, U+2060
 * and U+FEFF. A device name with U+202E in it could otherwise read backwards.
 */
export const HIDDEN_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** U+200C and U+200D join letters and emoji (ja, ar, fa): kept inside a string, stripped at its edges. */
const EDGE_JOINERS = /^[\u200c\u200d]+|[\u200c\u200d]+$/g;

/**
 * `text` without control characters, bidi controls or zero-width characters. One zero-width space
 * stays: the one `pkey` puts in front of a leading `::` and inside `##[` so a CI log never reads a
 * server's text as a workflow command (packages/cli/src/untrusted.ts). Stripping it here would
 * undo that defence on every line the kit draws.
 */
export function clean(text: string): string {
  return text
    .replace(HIDDEN_CHARS, (ch, at: number) =>
      ch === "\u200b" &&
      (text.startsWith("::", at + 1) ||
        (text.slice(at - 2, at) === "##" && text[at + 1] === "["))
        ? ch
        : "",
    )
    .replace(EDGE_JOINERS, "");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * `url` when it may become an OSC 8 hyperlink: an absolute `https:` URL, or `http:` to a
 * loopback host, with no whitespace, control character or userinfo. Anything else is null, and
 * is drawn as text without a link.
 */
export function safeLink(url: string | undefined | null): string | null {
  if (
    !url ||
    /[\s\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(
      url,
    )
  )
    return null;
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

/** A legacy GitHub `##[…]`, an Azure Pipelines `##vso[…]` or a TeamCity `##teamcity[…]` command,
 *  which those runners find anywhere in a line. */
const LOG_COMMAND_ANYWHERE = /##(?:vso|teamcity)?\[/i;

/** GitHub's `::` command after leading whitespace. The runner trims with .NET's `TrimStart`,
 *  whose whitespace includes NEL (U+0085), which JavaScript's `\s` and `trimStart` do not: a line
 *  starting `\u0085::add-mask::` is a command there, so NEL counts here too. (JS's `\s` also
 *  takes U+FEFF, which .NET does not trim: that only ever withholds more.) */
const GITHUB_COMMAND = /^[\s\u0085]*::/;

/**
 * Whether a line of `text` would run as a command in a CI log (`readsLogCommands`): one whose
 * start, after leading whitespace (NEL included, as the runner trims), is GitHub's `::`, or one
 * holding `##[`, `##vso[` or `##teamcity[`. Lines break at CR, LF or CRLF, as the runners read
 * them. Used where a value must reach stdout byte for byte (`secret`, `mint`), so it cannot be
 * defused, only withheld.
 */
export function hasLogCommand(text: string): boolean {
  return text
    .split(/\r\n|\r|\n/)
    .some(
      (line) => GITHUB_COMMAND.test(line) || LOG_COMMAND_ANYWHERE.test(line),
    );
}

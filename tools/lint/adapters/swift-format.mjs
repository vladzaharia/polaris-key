/**
 * Adapter for `swift format lint` (P0-46.6): one line per finding,
 * `path:line:col: warning: [Rule] message` (or `error:` for a file it cannot parse, which has no
 * rule). The path is relative to where it ran (sdks/swift, by sdks/swift/tools/lint.sh) or
 * absolute. Lines that are not findings (blank, or a continuation) are skipped; a non-empty
 * input with no finding line at all is foreign and throws.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

const BASE = "sdks/swift";
const LINE = /^(.+?):(\d+):(\d+): (warning|error): (?:\[([A-Za-z0-9]+)\] )?/;

export function parse(text, { root }) {
  const out = [];
  let any = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const m = LINE.exec(line);
    if (!m) continue;
    any = true;
    const [, path, , , , rule] = m;
    const abs = isAbsolute(path) ? path : resolve(root, BASE, path);
    const rel = relative(resolve(root), abs);
    if (rel === "" || rel.startsWith(".."))
      throw new Error(`${path} is outside ${root}`);
    out.push({
      file: rel.split(sep).join("/"),
      rule: `swift-format:${rule ?? "syntax-error"}`,
    });
  }
  if (!any && text.trim() !== "")
    throw new Error("not swift-format's lint output");
  return out;
}

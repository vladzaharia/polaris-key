/**
 * Adapter for `mypy --output json` (P0-46.4): one JSON object per line with `file`, `code` and
 * `severity`. mypy prints paths relative to where it ran; sdks/python/tools/lint.sh runs it in
 * sdks/python, so a relative path is taken from there (an absolute one from the root). Only
 * `error` lines count; notes are hints on an error.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

const BASE = "sdks/python";

export function parse(text, { root }) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not mypy's JSON output`);
    }
    if (
      o === null ||
      typeof o !== "object" ||
      typeof o.file !== "string" ||
      typeof o.severity !== "string"
    )
      throw new Error(`line ${i + 1} is not a mypy message`);
    if (o.severity !== "error") continue;
    let file;
    if (isAbsolute(o.file)) {
      file = relative(resolve(root), o.file).split(sep).join("/");
      if (file.startsWith(".."))
        throw new Error(`${o.file} is outside ${root}`);
    } else file = `${BASE}/${o.file.split(sep).join("/").replace(/^\.\//, "")}`;
    out.push({ file, rule: `mypy:${o.code ?? "error"}` });
  }
  return out;
}

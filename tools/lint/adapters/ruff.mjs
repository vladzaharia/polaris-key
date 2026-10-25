/**
 * Adapter for `ruff check --output-format json` (P0-46.4): one JSON array, each entry with
 * `filename` (absolute) and `code` (null for a syntax error). Paths outside the root throw.
 */

import { relative, resolve, sep } from "node:path";

export function parse(text, { root }) {
  let all;
  try {
    all = JSON.parse(text);
  } catch {
    throw new Error("not ruff's JSON output (expected an array)");
  }
  if (!Array.isArray(all))
    throw new Error("not ruff's JSON output (expected an array)");
  return all.map((f) => {
    if (f === null || typeof f !== "object" || typeof f.filename !== "string")
      throw new Error("a ruff entry has no filename");
    const rel = relative(resolve(root), resolve(f.filename));
    if (rel === "" || rel.startsWith(".."))
      throw new Error(`${f.filename} is outside ${root}`);
    return {
      file: rel.split(sep).join("/"),
      rule: `ruff:${f.code ?? "syntax-error"}`,
    };
  });
}

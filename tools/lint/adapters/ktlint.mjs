/**
 * Adapter for `ktlint --reporter=json` (P0-46.5): a JSON array of `{file, errors: [{line, column,
 * message, rule}]}`. sdks/kotlin/tools/lint.sh runs ktlint in sdks/kotlin with `--relative`, so a
 * relative path is taken from there (an absolute one from the root). A parse error carries an
 * empty rule and is named `ktlint:parse-error`. Rules look like `standard:import-ordering`.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

const BASE = "sdks/kotlin";

export function parse(text, { root }) {
  let all;
  try {
    all = JSON.parse(text);
  } catch {
    throw new Error("not ktlint's JSON output (expected an array)");
  }
  if (!Array.isArray(all))
    throw new Error("not ktlint's JSON output (expected an array)");
  const out = [];
  for (const f of all) {
    if (
      f === null ||
      typeof f !== "object" ||
      typeof f.file !== "string" ||
      !Array.isArray(f.errors)
    )
      throw new Error("a ktlint entry has no file or errors");
    let file;
    if (isAbsolute(f.file)) {
      file = relative(resolve(root), f.file).split(sep).join("/");
      if (file.startsWith(".."))
        throw new Error(`${f.file} is outside ${root}`);
    } else file = `${BASE}/${f.file.split(sep).join("/").replace(/^\.\//, "")}`;
    for (const e of f.errors) {
      if (e === null || typeof e !== "object")
        throw new Error("a ktlint error is not an object");
      out.push({
        file,
        rule: `ktlint:${typeof e.rule === "string" && e.rule !== "" ? e.rule : "parse-error"}`,
      });
    }
  }
  return out;
}

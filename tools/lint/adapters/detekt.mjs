/**
 * Adapter for `detekt-cli --report sarif:<file>` (P0-46.5): SARIF 2.1.0, one run, results with a
 * `ruleId` (`detekt.<ruleset>.<Rule>`) and a `file://` URI. The rule becomes
 * `detekt:<ruleset>.<Rule>`. Paths outside the root throw.
 */

import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function parse(text, { root }) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("not detekt's SARIF output");
  }
  if (
    doc === null ||
    typeof doc !== "object" ||
    !Array.isArray(doc.runs) ||
    typeof doc.version !== "string"
  )
    throw new Error("not detekt's SARIF output (no runs)");
  const out = [];
  for (const run of doc.runs) {
    if (!Array.isArray(run?.results))
      throw new Error("a SARIF run has no results");
    for (const r of run.results) {
      const uri = r?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      if (typeof uri !== "string" || typeof r.ruleId !== "string")
        throw new Error("a detekt result has no ruleId or location");
      const abs = uri.startsWith("file:")
        ? fileURLToPath(uri)
        : resolve(root, uri);
      const rel = relative(resolve(root), abs);
      if (rel === "" || rel.startsWith(".."))
        throw new Error(`${uri} is outside ${root}`);
      out.push({
        file: rel.split(sep).join("/"),
        rule: `detekt:${r.ruleId.replace(/^detekt\./, "")}`,
      });
    }
  }
  return out;
}

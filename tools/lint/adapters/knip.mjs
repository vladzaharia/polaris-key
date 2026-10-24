/**
 * knip (`knip --reporter json`) -> findings (P0-46.2). The rule is the issue type (`files`,
 * `exports`, `types`, `dependencies`, `devDependencies`, `unlisted`, `binaries`, ...); one finding
 * per reported item, on the file knip attributes it to (a manifest for the dependency types).
 */

/** Per-issue arrays that are not findings. */
const NOT_FINDINGS = new Set(["file", "owners"]);

export function parse(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("not JSON (expected `knip --reporter json`)");
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.issues)) {
    throw new Error("not a knip JSON report (no `issues` array)");
  }
  const out = [];
  for (const issue of doc.issues) {
    if (
      issue === null ||
      typeof issue !== "object" ||
      typeof issue.file !== "string"
    ) {
      throw new Error("knip issue without a `file`");
    }
    for (const [type, items] of Object.entries(issue)) {
      if (NOT_FINDINGS.has(type) || !Array.isArray(items)) continue;
      for (let i = 0; i < items.length; i++)
        out.push({ file: issue.file, rule: `knip:${type}` });
    }
  }
  return out;
}

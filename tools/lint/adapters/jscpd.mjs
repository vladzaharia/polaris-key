/**
 * jscpd adapter (P0-46.3): reads jscpd's `jscpd-report.json`.
 *
 * Rule key: `jscpd:duplicate`, counted once per clone per file it touches (a clone whose two sides
 * sit in one file counts once for that file). Line numbers and fragments never enter the key, so
 * an edit that only shifts a clone moves nothing in the ledger; only a clone appearing, vanishing
 * or changing which files it touches does.
 */
import { isAbsolute, relative } from "node:path";

export function parse(text, { root } = {}) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("not JSON: expected jscpd-report.json");
  }
  if (
    !report ||
    typeof report !== "object" ||
    !Array.isArray(report.duplicates)
  ) {
    throw new Error("not a jscpd report: no `duplicates` array");
  }
  const rel = (name) => {
    if (typeof name !== "string" || name === "")
      throw new Error("clone side without a file name");
    const p = isAbsolute(name) && root ? relative(root, name) : name;
    return p.split("\\").join("/").replace(/^\.\//, "");
  };
  const out = [];
  for (const [i, d] of report.duplicates.entries()) {
    if (!d?.firstFile || !d?.secondFile)
      throw new Error(`duplicate ${i} lacks a file side`);
    for (const f of new Set([rel(d.firstFile.name), rel(d.secondFile.name)])) {
      out.push({ file: f, rule: "jscpd:duplicate" });
    }
  }
  return out;
}

/**
 * Adapter for `gdlint` text output (P0-46.7). gdlint has no JSON mode. A finding is one line,
 * `path:line: Error: message (rule-name)`. A file gdtoolkit's grammar cannot parse prints
 * `path:` on a line of its own, then the source line and the parser's complaint; it counts as one
 * `gdlint:parse-error`. Clean runs print `Success: no problems found`; the trailing
 * `Failure: N problems found` summary is checked against the findings read. Paths are relative to
 * where gdlint ran, sdks/godot (lint.sh runs it there).
 */

const BASE = "sdks/godot/";
const FINDING = /^(\S.*\.gd):(\d+): Error: .* \(([a-z0-9-]+)\)$/;
const PARSE_FAILURE = /^(\S.*\.gd):$/;
const SUMMARY =
  /^(?:Success: no problems found|Failure: (\d+) problems? found)$/;

export function parse(text, { root: _root } = {}) {
  const out = [];
  let summary = null;
  for (const line of text.split("\n")) {
    let m = FINDING.exec(line);
    if (m) {
      out.push({ file: BASE + m[1], rule: `gdlint:${m[3]}` });
      continue;
    }
    m = PARSE_FAILURE.exec(line);
    if (m) {
      out.push({ file: BASE + m[1], rule: "gdlint:parse-error" });
      continue;
    }
    m = SUMMARY.exec(line);
    if (m) summary = m[1] === undefined ? 0 : Number(m[1]);
  }
  if (summary === null)
    throw new Error("not gdlint's output (no Success/Failure summary line)");
  // gdlint counts a parse failure as a problem too, so the totals must agree.
  if (summary !== out.length)
    throw new Error(
      `gdlint reported ${summary} problems, the adapter read ${out.length}`,
    );
  return out;
}

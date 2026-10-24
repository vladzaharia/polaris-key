/**
 * Size-budget adapter (P0-30.3): reads tools/lint/size.mjs output, one `path<TAB>lines` per file
 * over the 800-line budget. Rule key `size:over-800`, one finding per file: the line count never
 * enters the key, so a long file may shrink or grow without moving the ledger, until it reaches 800.
 */
export function parse(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const m = /^([^\t]+)\t(\d+)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1}: expected "path<TAB>lines"`);
    out.push({ file: m[1], rule: "size:over-800" });
  }
  return out;
}

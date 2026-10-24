/** Fixture-only adapter for the tests: one JSON object per line, `{"file": ..., "rule": ...}`. */

export function parse(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    out.push({ file: o.file, rule: `jsonl-test:${o.rule}` });
  }
  return out;
}

/** Fixture-only adapter for the tests: one JSON object per line, `{"file": ..., "rule": ...}`. */

import { parseJsonLines } from "./jsonl.mjs";

export function parse(text) {
  return parseJsonLines(text, "is not JSON").map(({ o }) => ({
    file: o.file,
    rule: `jsonl-test:${o.rule}`,
  }));
}

/** Shared by the JSON-lines adapters: each non-blank line is one JSON value. */

export function parseJsonLines(text, notJson) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      out.push({ o: JSON.parse(line), n: i + 1 });
    } catch {
      throw new Error(`line ${i + 1} ${notJson}`);
    }
  }
  return out;
}

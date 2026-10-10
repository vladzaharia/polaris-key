/**
 * The symbol check: a name a covered page writes in prose must be one the SDK exports, or sit on a
 * line that says it is planned. Blocks need no help (the compiler resolves their imports).
 *
 * What counts as naming an export, so that ordinary words in code spans do not:
 * - TypeScript: `PascalCase` with two humps or more, `useThing`, and the `register|expose|create|
 *   with|polaris` verbs (`exposePolarisBridge`).
 * - Python: `PascalCase` with two humps or more, and a `name(` call, checked by its last segment.
 */

export interface Mention {
  name: string;
  line: number;
  text: string;
}

const TS_SHAPES = [
  /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/,
  /^use[A-Z][A-Za-z0-9]*$/,
  /^(?:register|expose|create|with|polaris)[A-Z][A-Za-z0-9]*$/,
];
const PY_PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;

const PLANNED = /planned|coming in/i;

/** Names that are the reader's own or a host global, not exports: the generated config, the
 *  placeholders of ambient.d.ts, and `window.polarisKey`. */
const NOT_EXPORTS = new Set([
  "YourApp",
  "polarisConfig",
  "polarisKey",
  // Python built-ins and the one third-party class the docs name.
  "TimeoutError",
  "DeprecationWarning",
  "TypeError",
  "ValueError",
  "MockTransport",
]);

/** The names a page's prose claims, minus the lines that label them planned. */
export function mentions(
  prose: { line: number; text: string }[],
  language: "ts" | "python",
): Mention[] {
  const out: Mention[] = [];
  for (const { line, text } of prose) {
    if (PLANNED.test(text)) continue;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const raw = (m[1] ?? "").trim();
      if (language === "python") {
        const call = /^(?:[A-Za-z_][\w]*\.)*([a-z_][a-z0-9_]*)\(/.exec(raw);
        if (call?.[1]?.includes("_"))
          out.push({ name: call[1], line, text: raw });
        else if (PY_PASCAL.test(raw) && !NOT_EXPORTS.has(raw))
          out.push({ name: raw, line, text: raw });
        continue;
      }
      const name = raw.replace(/\(.*$/s, "").split(".").pop() ?? "";
      if (!NOT_EXPORTS.has(name) && TS_SHAPES.some((re) => re.test(name)))
        out.push({ name, line, text: raw });
    }
  }
  return out;
}

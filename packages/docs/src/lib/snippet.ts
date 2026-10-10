/**
 * `<Snippet src region>`: reads a region out of a compiled source file (docs plan §4).
 *
 * A region sits between `docs:start <name>` and `docs:end <name>` comment lines (`//` or `#`).
 * The marker lines are not shown, and setup lines outside the region stay hidden. Sources are
 * the examples tree and the docs-snippets targets inside each SDK, whose own CI lane compiles
 * them, so a shown snippet is a snippet that built.
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

const MARK = /^\s*(?:\/\/|#|--)\s*docs:(start|end)\s+([A-Za-z0-9._-]+)\s*$/;

/** The lines of one region, or the whole text with markers removed when no region is named. */
export function extractRegion(text: string, region?: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inside = region === undefined;
  let found = region === undefined;
  for (const line of lines) {
    const m = MARK.exec(line);
    if (m !== null) {
      if (region !== undefined && m[2] === region) {
        inside = m[1] === "start";
        if (inside) found = true;
      }
      continue;
    }
    if (inside) out.push(line);
  }
  if (!found) throw new Error(`Snippet: no "docs:start ${region}" region`);
  return dedent(out).join("\n").replace(/\s+$/, "");
}

function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(min));
}

/** Reads `src` (repo-relative) and returns the region and the file name to show under it. */
export function readSnippet(
  src: string,
  region?: string,
): { code: string; file: string } {
  const abs = resolve(repoRoot, src);
  if (relative(repoRoot, abs).startsWith(".."))
    throw new Error(`Snippet: ${src} is outside the repository`);
  return {
    code: extractRegion(readFileSync(abs, "utf8"), region),
    file: join(src).split("\\").join("/").split("/").pop()!,
  };
}

/**
 * Repo Markdown files that pages import whole (`docs/DEPLOYMENT.md`, `docs/PRIVACY.md`, the
 * style guide). Each opens with its own `# Title`, which would render under the page title as a
 * second h1, and Starlight's "On this page" never sees the headings of imported content.
 * `<ImportedFile>` removes the title where the page renders it; `importedHeadings` lists the
 * headings for the page.
 */
import { readFileSync } from "node:fs";

/** Files whose own `# Title` the page title replaces. */
export const IMPORTED_FILES = [
  "docs/DEPLOYMENT.md",
  "docs/PRIVACY.md",
  "docs/research/2026-10-08-docs/style-guide.md",
] as const;

export interface ImportedHeading {
  depth: number;
  slug: string;
  text: string;
}

/** The level 2 and 3 headings of a Markdown file, fence-aware, with the ids the renderer gives. */
export function markdownHeadings(markdown: string): ImportedHeading[] {
  const seen = new Map<string, number>();
  // github-slugger's rule: lower-case, drop punctuation, spaces to hyphens, then -1, -2 for repeats.
  const slug = (text: string): string => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\- _]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  const out: ImportedHeading[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m === null) continue;
    const text = m[2]!.replace(/[`*]/g, "");
    const id = slug(text);
    if (m[1]!.length > 1) out.push({ depth: m[1]!.length, slug: id, text });
  }
  return out;
}

/** Headings of an imported file named by a page's MDX source, or none. */
export function importedHeadings(
  pageSource: string,
  root: URL,
): ImportedHeading[] {
  for (const f of IMPORTED_FILES) {
    const name = f.split("/").pop()!;
    if (!pageSource.includes(`/${name}"`)) continue;
    return markdownHeadings(readFileSync(new URL(f, root), "utf8"));
  }
  return [];
}

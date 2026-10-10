/** Splits an operator file into its H2 sections (`<RunbookSection>`, docs plan section 5). */

export const slugifyHeading = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export interface RunbookPart {
  heading: string;
  slug: string;
  body: string;
}

/** The H2 sections of a Markdown file, ignoring `##` lines inside code fences. */
export function splitSections(markdown: string): RunbookPart[] {
  const parts: RunbookPart[] = [];
  let fence = false;
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h2 = fence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 !== null) {
      if (current) parts.push(finish(current));
      current = { heading: h2[1]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) parts.push(finish(current));
  return parts;
}

const finish = (c: { heading: string; lines: string[] }): RunbookPart => ({
  heading: c.heading,
  slug: slugifyHeading(c.heading),
  body: c.lines.join("\n").trim(),
});

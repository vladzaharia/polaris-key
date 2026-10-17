/**
 * Pages that render a repository Markdown file whole (`import { Content } from "…/README.md"`).
 * Starlight builds "On this page" from the page's own Markdown, so an imported file's headings
 * never reach it and the list would hold only Overview. `routeData.ts` adds them from the file's
 * `getHeadings()`. The file's own H1 is dropped by `scripts/imported-markdown.mjs`: the page title is the H1.
 */
import type { TocItem } from "./helpMessages";

interface Heading {
  depth: number;
  slug: string;
  text: string;
}
type Module = { getHeadings?: () => Heading[] };

const FILES = import.meta.glob<Module>(
  [
    "../../../sdk-node/README.md",
    "../../../sdk-react/README.md",
    "../../../../sdks/*/README.md",
    "../../../../sdks/kotlin/ui/README.md",
    "../../../../docs/DEPLOYMENT.md",
    "../../../../docs/PRIVACY.md",
    "../../../../docs/research/2026-10-08-docs/style-guide.md",
  ],
  { eager: true },
);

/** The Starlight page id of each page, and the repository file it renders. */
const PAGES: Readonly<Record<string, string>> = {
  "build/sdks/node": "../../../sdk-node/README.md",
  "build/sdks/react": "../../../sdk-react/README.md",
  "build/sdks/python": "../../../../sdks/python/README.md",
  "build/sdks/swift": "../../../../sdks/swift/README.md",
  "build/sdks/kotlin": "../../../../sdks/kotlin/README.md",
  "build/sdks/godot": "../../../../sdks/godot/README.md",
  "build/ui/frameworks/compose": "../../../../sdks/kotlin/ui/README.md",
  "operate/platform/deploy": "../../../../docs/DEPLOYMENT.md",
  "reference/what-apps-collect": "../../../../docs/PRIVACY.md",
  "contribute/writing-docs":
    "../../../../docs/research/2026-10-08-docs/style-guide.md",
};

/** The imported file's headings as TOC items between `min` and `max`, nested by level. */
export function embeddedToc(
  routeId: string,
  min: number,
  max: number,
): TocItem[] {
  const file = PAGES[routeId];
  const headings =
    file === undefined ? [] : (FILES[file]?.getHeadings?.() ?? []);
  const root: TocItem[] = [];
  const stack: TocItem[] = [];
  for (const h of headings) {
    if (h.depth < min || h.depth > max) continue;
    const item: TocItem = {
      depth: h.depth,
      slug: h.slug,
      text: h.text,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= h.depth)
      stack.pop();
    (stack.length > 0 ? stack[stack.length - 1]!.children : root).push(item);
    stack.push(item);
  }
  return root;
}

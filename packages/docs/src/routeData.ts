import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { pathToFileURL } from "node:url";
import { importedHeadings, type ImportedHeading } from "./lib/importedMarkdown";
import { slugifyHeading } from "./lib/runbook";
import {
  HELP_MESSAGES,
  KNOWN_ENTRIES,
  messageToc,
  type TocItem,
} from "./lib/helpMessages";

/**
 * "On this page" for the Help messages pages (docs plan §7.1). Their headings come from
 * components (`<HelpMessage>` for an entry, `<MessageIndex>` for a letter), not from the page's
 * Markdown, so Starlight's heading collector never sees them and the list would hold only
 * Overview. One item per heading goes in after Overview: on a page of 27 entries that list is the
 * way to jump to one, and on a phone the page bar names the one being read.
 *
 * The messages come first on every messages page, ahead of the page's own headings (its one
 * Markdown heading is the developer-only section at the foot of Other messages), so the list
 * stays in the order of the page; `helpMessages.test.ts` keeps it so.
 */
/** Level 2 headings with their level 3 children, in Starlight's TOC shape. */
function nest(headings: ImportedHeading[], maxDepth: number) {
  const items: TocItem[] = [];
  for (const h of headings) {
    const item = { depth: h.depth, slug: h.slug, text: h.text, children: [] };
    const parent = items[items.length - 1];
    if (h.depth === 2) items.push(item);
    else if (h.depth === 3 && maxDepth >= 3 && parent !== undefined)
      parent.children.push(item);
  }
  return items;
}

// The build runs from packages/docs, and this module is bundled, so import.meta.url is no anchor.
const REPO_ROOT = new URL("../../", pathToFileURL(`${process.cwd()}/`));

/**
 * Headings that live outside the page's own Markdown: an imported repo file
 * (`<Deployment />`, the privacy policy, the style guide) or the sections a page pulls in with
 * `<RunbookSection>`. Without them "On this page" lists only the page's own headings, and an
 * operator in an incident cannot jump to a procedure.
 */
async function importedItems(
  body: string,
  maxDepth: number,
): Promise<TocItem[]> {
  const headings: ImportedHeading[] = importedHeadings(body, REPO_ROOT);
  const sections = [
    ...body.matchAll(/<RunbookSection\s+file="([^"]+)"\s+heading="([^"]+)"/g),
  ];
  // Loaded only when a page needs it, so a unit test can import this module without the Astro
  // runtime.
  const getEntry =
    sections.length > 0 ? (await import("astro:content")).getEntry : undefined;
  for (const [, file, heading] of sections) {
    const entry = await getEntry!(
      "runbook",
      `${file}/${slugifyHeading(heading!)}`,
    );
    if (entry === undefined) continue;
    headings.push({
      depth: 2,
      slug: slugifyHeading(heading!),
      text: entry.data.heading,
    });
    const inner = (entry.rendered?.metadata?.headings ?? []) as unknown as {
      depth: number;
      slug: string;
      text: string;
    }[];
    for (const h of inner)
      headings.push({ depth: h.depth, slug: h.slug, text: h.text });
  }
  return nest(headings, maxDepth);
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const { toc, id, entry } = context.locals.starlightRoute;
  // The list is off for the page, or does not show level 2.
  if (toc === undefined || toc.minHeadingLevel > 2 || toc.maxHeadingLevel < 2)
    return;
  const body = (entry as { body?: string } | undefined)?.body ?? "";
  toc.items.splice(
    1,
    0,
    ...messageToc(HELP_MESSAGES, KNOWN_ENTRIES, id),
    ...(await importedItems(body, toc.maxHeadingLevel)),
  );
});

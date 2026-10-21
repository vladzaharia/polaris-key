import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { embeddedToc } from "./lib/embedded";
import {
  HELP_MESSAGES,
  KNOWN_ENTRIES,
  messageToc,
  type TocItem,
} from "./lib/helpMessages";
import { doorOf } from "./lib/doors";
import { CUSTOMER_SITE, helpRoute, scopeSidebar } from "./lib/helpHost";
import { slugifyHeading } from "./lib/runbook";

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
function nest(
  headings: { depth: number; slug: string; text: string }[],
  maxDepth: number,
): TocItem[] {
  const items: TocItem[] = [];
  for (const h of headings) {
    const item: TocItem = {
      depth: h.depth,
      slug: h.slug,
      text: h.text,
      children: [],
    };
    const parent = items[items.length - 1];
    if (h.depth === 2) items.push(item);
    else if (h.depth === 3 && maxDepth >= 3 && parent !== undefined)
      parent.children.push(item);
  }
  return items;
}

/**
 * The headings of the sections a page pulls in with `<RunbookSection>`. Without them "On this
 * page" lists only the page's own headings, and an operator in an incident cannot jump to a
 * procedure.
 */
async function runbookItems(body: string, maxDepth: number) {
  const sections = [
    ...body.matchAll(/<RunbookSection\s+file="([^"]+)"\s+heading="([^"]+)"/g),
  ];
  if (sections.length === 0) return [];
  // Loaded only when a page needs it, so a unit test can import this module without the Astro
  // runtime.
  const { getEntry } = await import("astro:content");
  const headings: { depth: number; slug: string; text: string }[] = [];
  for (const [, file, heading] of sections) {
    const entry = await getEntry(
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
  const route = context.locals.starlightRoute;
  const { toc, id, entry, head } = route;
  // Each page shows its own door's sidebar only.
  const door = doorOf(id)?.door;
  if (route.sidebar && door && door !== "landing")
    route.sidebar = scopeSidebar(route.sidebar, door);
  // Help is the customer's site (LK-09, D7): it is served at polaris.locker/docs/help/, so its
  // name, its address and its home link say so.
  if (helpRoute(id)) {
    route.siteTitle = "Polaris Locker";
    route.siteTitleHref = "/docs/help/";
    for (const h of head ?? []) {
      if (h.tag === "title" && typeof h.content === "string")
        h.content = h.content.replace(/ \| Polaris Key$/, " | Polaris Locker");
      else if (h.tag === "meta" && h.attrs?.property === "og:site_name")
        h.attrs.content = "Polaris Locker";
      else if (h.tag === "meta" && h.attrs?.property === "og:url")
        h.attrs.content = String(h.attrs.content).replace(
          /^https:\/\/[^/]+/,
          CUSTOMER_SITE,
        );
      else if (h.tag === "link" && h.attrs?.rel === "canonical")
        h.attrs.href = String(h.attrs.href).replace(
          /^https:\/\/[^/]+/,
          CUSTOMER_SITE,
        );
    }
  }
  // A gated page is never indexed: a crawler that reaches one gets the access page, but a
  // shared link or a cached copy must not put its text in a search result.
  const tier = doorOf(id)?.tier ?? "admin";
  if (
    tier !== "public" &&
    !head.some((h) => h.tag === "meta" && h.attrs?.name === "robots")
  )
    head.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
  // The list is off for the page, or does not show level 2.
  if (toc === undefined || toc.minHeadingLevel > 2 || toc.maxHeadingLevel < 2)
    return;
  const body = (entry as { body?: string } | undefined)?.body ?? "";
  toc.items.splice(
    1,
    0,
    ...messageToc(HELP_MESSAGES, KNOWN_ENTRIES, id),
    // The headings of a repository file the page renders whole (src/lib/embedded.ts).
    ...(await embeddedToc(id, toc.minHeadingLevel, toc.maxHeadingLevel)),
    ...(await runbookItems(body, toc.maxHeadingLevel)),
  );
});

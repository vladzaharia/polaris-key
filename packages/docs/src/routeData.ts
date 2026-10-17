import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { embeddedToc } from "./lib/embedded";
import { HELP_MESSAGES, KNOWN_ENTRIES, messageToc } from "./lib/helpMessages";

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
export const onRequest = defineRouteMiddleware((context) => {
  const { toc, id } = context.locals.starlightRoute;
  // The list is off for the page, or does not show level 2.
  if (toc === undefined || toc.minHeadingLevel > 2 || toc.maxHeadingLevel < 2)
    return;
  toc.items.splice(1, 0, ...messageToc(HELP_MESSAGES, KNOWN_ENTRIES, id));
  // The headings of a repository file the page renders whole (src/lib/embedded.ts).
  toc.items.splice(
    1,
    0,
    ...embeddedToc(id, toc.minHeadingLevel, toc.maxHeadingLevel),
  );
});

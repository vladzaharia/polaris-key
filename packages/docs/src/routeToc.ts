import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { helpRoute } from "./lib/helpHost";

/**
 * "On this page" is for pages long enough to need it (docs plan 8.3): outside Help, a page whose
 * list holds fewer than three headings has none, and the column goes with it. It runs after
 * routeData.ts, which adds the headings of rendered messages, embedded files and runbook sections.
 */
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const toc = route.toc;
  if (helpRoute(route.id) || toc === undefined) return;
  // The Overview item counts as one.
  if (toc.items.flatMap((i) => [i, ...i.children]).length < 4)
    route.toc = undefined;
});

import type { BrowserContext } from "playwright";

/**
 * The one way an e2e file closes a browser context that has routes. Closing
 * with a mocked route handler still in flight lets the handler throw
 * ("route.fetch: Request context disposed") after the close; unrouteAll with
 * `ignoreErrors` waits for running handlers and swallows what they throw.
 * `routeHygiene.test.ts` fails when a file calls `.route(` without this.
 */
export async function closeContext(ctx: BrowserContext): Promise<void> {
  for (const page of ctx.pages()) {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await ctx.close();
}

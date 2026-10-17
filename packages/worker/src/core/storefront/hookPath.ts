/**
 * The store notification hooks' ONE spelling (CM-29, plans/CM-29.md §3.2).
 *
 * The App Store and Play notification URLs are canonical at `/<p>/distribution/hooks/<hook>`,
 * Commerce's routes at today's URLs: Play's endpoint is a Pub/Sub push subscription in the
 * developer's GCP project and Apple's URL passes only the ASC write gate, which admits this URL
 * alone, so moving either would be a human step per product. They are not aliases.
 * `/<p>/commerce/hooks/*` does not exist.
 *
 * Every reader takes the path from here: the router, the URL builder
 * (`services/distribution/connectors/asc/provision.ts`), the ASC write gate
 * (`core/storefront/rules/appStore.ts`) and CM-21's Play `pushAudience` default.
 * `test/commerce.test.ts` pins them.
 */

/** The last path segment of each store's hook. */
export const STORE_HOOK = {
  app_store: "app-store",
  play: "play-rtdn",
} as const;

export type StoreHookName = (typeof STORE_HOOK)[keyof typeof STORE_HOOK];

/** `distribution/hooks/<hook>`: the path after `/<p>/`. */
export function storeHookPath(store: "app-store" | "play"): string {
  return `distribution/hooks/${store === "app-store" ? STORE_HOOK.app_store : STORE_HOOK.play}`;
}

/** The hook name when `segments` (after `/<p>/distribution`) is exactly `hooks/<store hook>`. */
export function storeHookOf(segments: readonly string[]): StoreHookName | null {
  if (segments.length !== 2 || segments[0] !== "hooks") return null;
  const name = segments[1];
  return name === STORE_HOOK.app_store || name === STORE_HOOK.play
    ? name
    : null;
}

/**
 * Hash routing without a router dependency. Hash routing keeps deep links + back/forward
 * working and lets the static SPA be served under `/admin/` with no server rewrites.
 *
 *   #/                                  -> dashboard
 *   #/products                          -> platform product registry
 *   #/p/<slug>/licenses                 -> licenses list for a product
 *   #/p/<slug>/licenses/<id>            -> a license detail
 *   #/p/<slug>/{tiers|profiles|catalog|releases|oidc|activity|settings}
 *
 * Every per-product view carries the slug as the first path segment so deep links + the
 * product switcher stay in sync.
 */

export type Tab =
  | "licenses"
  | "tiers"
  | "profiles"
  | "catalog"
  | "releases"
  | "oidc"
  | "activity"
  | "settings";

/** The full set of per-product views (tabs plus the license-detail leaf). */
export type View = Tab | "license";

export const TABS: { tab: Tab; label: string }[] = [
  { tab: "licenses", label: "Licenses" },
  { tab: "tiers", label: "Tiers" },
  { tab: "profiles", label: "Profiles" },
  { tab: "catalog", label: "Catalog" },
  { tab: "releases", label: "Releases" },
  { tab: "oidc", label: "OIDC" },
  { tab: "activity", label: "Activity" },
  { tab: "settings", label: "Settings" },
];

const KNOWN_TABS: Tab[] = TABS.map((t) => t.tab);

export type Route =
  | { kind: "dashboard" }
  | { kind: "products" }
  | { kind: "product"; slug: string; view: View; id?: string };

const PRODUCT = /^#\/p\/([^/]+)(?:\/([^/]+))?(?:\/([^/?]+))?/;

export function parseRoute(hash: string): Route {
  if (hash === "" || hash === "#" || hash === "#/") return { kind: "dashboard" };
  if (hash.startsWith("#/products")) return { kind: "products" };
  const m = hash.match(PRODUCT);
  if (m && m[1]) {
    const slug = decodeURIComponent(m[1]);
    const view = (m[2] as View | undefined) ?? "licenses";
    if (view === "license" && m[3]) {
      return { kind: "product", slug, view: "license", id: decodeURIComponent(m[3]) };
    }
    const tab = (KNOWN_TABS as string[]).includes(view) ? (view as Tab) : "licenses";
    return { kind: "product", slug, view: tab };
  }
  return { kind: "dashboard" };
}

/** The active sidebar tab for a route (license detail maps back to its list). */
export function tabOf(route: Route): Tab | null {
  if (route.kind !== "product") return null;
  if (route.view === "license") return "licenses";
  return route.view;
}

export function hashFor(route: Route): string {
  if (route.kind === "dashboard") return "#/";
  if (route.kind === "products") return "#/products";
  if (route.view === "license" && route.id) {
    return `#/p/${encodeURIComponent(route.slug)}/license/${encodeURIComponent(route.id)}`;
  }
  return `#/p/${encodeURIComponent(route.slug)}/${route.view}`;
}

export function navigate(route: Route): void {
  window.location.hash = hashFor(route);
}

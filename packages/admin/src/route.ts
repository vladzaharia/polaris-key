/**
 * Hash routing without a router dependency. Every per-product view carries the product
 * slug as the first path segment so deep links + the product switcher stay in sync:
 *
 *   #/products                          -> platform product registry
 *   #/p/<slug>/licenses                 -> licenses list for a product
 *   #/p/<slug>/licenses/<id>            -> a license detail
 *   #/p/<slug>/tiers | /catalog | /activity
 */

export type View = "licenses" | "license" | "tiers" | "catalog" | "activity";

export type Route =
  | { kind: "products" }
  | { kind: "product"; slug: string; view: View; id?: string };

export type Tab = "licenses" | "tiers" | "catalog" | "activity";

const PRODUCT = /^#\/p\/([^/]+)(?:\/([^/]+))?(?:\/([^/?]+))?/;

export function parseRoute(hash: string): Route {
  if (hash.startsWith("#/products")) return { kind: "products" };
  const m = hash.match(PRODUCT);
  if (m && m[1]) {
    const slug = decodeURIComponent(m[1]);
    const view = (m[2] as View | undefined) ?? "licenses";
    if (view === "license" && m[3]) return { kind: "product", slug, view: "license", id: decodeURIComponent(m[3]) };
    const known: View[] = ["licenses", "tiers", "catalog", "activity"];
    return { kind: "product", slug, view: known.includes(view) ? view : "licenses" };
  }
  return { kind: "products" };
}

export function tabOf(route: Route): Tab | null {
  if (route.kind !== "product") return null;
  if (route.view === "license") return "licenses";
  return route.view;
}

export function hashFor(route: Route): string {
  if (route.kind === "products") return "#/products";
  if (route.view === "license" && route.id) return `#/p/${encodeURIComponent(route.slug)}/license/${encodeURIComponent(route.id)}`;
  return `#/p/${encodeURIComponent(route.slug)}/${route.view}`;
}

export function navigate(route: Route): void {
  window.location.hash = hashFor(route);
}

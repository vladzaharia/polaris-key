import * as React from "react";

/**
 * The customer site's router (PORTAL.md §3.3). Hash routing for the signed-in SPA (ADMIN.md lead
 * decision Q2); product ids in URLs are product slugs.
 *
 * - `#/` is the Library and the default: any hash that names no other page lands there.
 * - The stable links of the old portal redirect (anti-pattern A10) with `history.replaceState`,
 *   so Back never bounces through a dead URL.
 * - `/activate` (the path apps and emails link to) becomes `#/?activate=<key>`: the Library with
 *   the Activate license modal open and the key filled in. It is never a page. The key comes from
 *   the fragment (`/activate#key=…`), which never reaches a server; the legacy query form
 *   (`/activate?key=…`, in links already out) is still read. Both are dropped from the address
 *   bar before the first render (`rewriteActivatePath`).
 *
 * Query parameters live inside the hash (`#/?view=list&q=fern`). `setParams` rewrites them in
 * place (no history entry per keystroke) and notifies subscribers itself, because
 * `replaceState` fires no `hashchange`.
 */

export const PRODUCT_SECTIONS = [
  "get",
  "sync",
  "new",
  "license",
  "devices",
  "package",
  "help",
] as const;
export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

export const ACCOUNT_SECTIONS = [
  "profile",
  "methods",
  "products",
  "sessions",
  "appearance",
  "data",
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

/** The focused flows (§4.25, PX-10): one task in minimal chrome, for apps and email links. */
export const FOCUSED_FLOWS = ["free-device", "download"] as const;
export type FocusedFlowKind = (typeof FOCUSED_FLOWS)[number];

export type PortalRoute =
  | { kind: "library"; params: URLSearchParams }
  | { kind: "discover"; params: URLSearchParams }
  | {
      kind: "product";
      product: string;
      section: ProductSection | null;
      params: URLSearchParams;
    }
  | {
      kind: "focused";
      flow: FocusedFlowKind;
      product: string;
      params: URLSearchParams;
    }
  | { kind: "account"; section: AccountSection | null };

export interface Resolved {
  route: PortalRoute;
  /** The canonical hash when the input was a legacy or unknown spelling. */
  redirect?: string;
}

const enc = encodeURIComponent;

/** Href builders: every link in the site goes through these. */
export const href = {
  library: (params?: Record<string, string>): string => withQuery("#/", params),
  discover: (): string => "#/discover",
  product: (
    slug: string,
    section?: ProductSection,
    params?: Record<string, string>,
  ): string =>
    withQuery(`#/p/${enc(slug)}${section ? `/${section}` : ""}`, params),
  focused: (
    slug: string,
    flow: FocusedFlowKind,
    params?: Record<string, string>,
  ): string => withQuery(`#/p/${enc(slug)}/${flow}`, params),
  account: (section?: AccountSection): string =>
    `#/account${section ? `/${section}` : ""}`,
  activate: (key?: string): string => withQuery("#/", { activate: key ?? "" }),
};

function withQuery(base: string, params?: Record<string, string>): string {
  if (!params) return base;
  const q = new URLSearchParams(params).toString();
  return q ? `${base}?${q}` : base;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Parse a location hash into a route, following §3.3's redirects. Pure. */
export function resolveHash(hash: string): Resolved {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", query = ""] = raw.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  const parts = pathPart.split("/").filter(Boolean).map(decode);
  const [head, a, b] = parts;

  const library = (): Resolved => ({
    route: { kind: "library", params },
  });

  if (!head) return library();
  switch (head) {
    case "discover":
      return { route: { kind: "discover", params } };
    case "p": {
      if (!a) return { ...library(), redirect: "#/" };
      // Focused flows (PX-10): `?for=&return=` and `?platform=` stay with the route.
      if (b && (FOCUSED_FLOWS as readonly string[]).includes(b))
        return {
          route: {
            kind: "focused",
            flow: b as FocusedFlowKind,
            product: a,
            params,
          },
        };
      const section =
        b && (PRODUCT_SECTIONS as readonly string[]).includes(b)
          ? (b as ProductSection)
          : null;
      const route: PortalRoute = {
        kind: "product",
        product: a,
        section,
        params,
      };
      if (b && !section) return { route, redirect: href.product(a) };
      return { route };
    }
    case "account": {
      if (a === "emails" || a === "passkeys" || a === "linked")
        return {
          route: { kind: "account", section: "methods" },
          redirect: href.account("methods"),
        };
      const section =
        a && (ACCOUNT_SECTIONS as readonly string[]).includes(a)
          ? (a as AccountSection)
          : null;
      if (a && !section)
        return {
          route: { kind: "account", section: null },
          redirect: href.account(),
        };
      return { route: { kind: "account", section } };
    }
    // §3.3 redirects: the old portal's links keep working.
    case "licenses": {
      if (a && b) {
        const target = href.product(a, "license", { license: b });
        return { ...resolveHash(target), redirect: target };
      }
      return { ...resolveHash("#/"), redirect: "#/" };
    }
    case "downloads":
      return { ...resolveHash("#/"), redirect: "#/" };
    case "profile":
      return {
        route: { kind: "account", section: null },
        redirect: href.account(),
      };
    case "claim": {
      const target = href.activate(params.get("key") ?? "");
      return { ...resolveHash(target), redirect: target };
    }
    default:
      // Anything else is the Library, the default page.
      return {
        route: { kind: "library", params: new URLSearchParams() },
        redirect: "#/",
      };
  }
}

/**
 * The license key in an `/activate` link's fragment (`#key=…`), or null. A fragment that is a
 * hash route (`#/…`) carries no key. Pure.
 */
export function activateLinkKey(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (raw === "" || raw.startsWith("/")) return null;
  return new URLSearchParams(raw).get("key") || null;
}

/**
 * `/activate[?product=…]#key=…` → `/#/?activate=…[&product=…]`, in place, with
 * `history.replaceState`. Returns whether it rewrote the URL. Run once, before the first render
 * and before any request, so neither the `#key=` fragment nor a legacy `?key=` query (links
 * already out; the fragment wins when both are there) stays in the address bar or the history
 * entry. The key then lives only in this tab's `#/?activate=`, which the signed-in shell
 * consumes as it opens the modal and every sign-in leaves out of its return URL
 * (`carriedKey.ts`). See THREAT-MODEL.md, "Key-bearing deep links".
 */
export function rewriteActivatePath(loc: Location = window.location): boolean {
  const path = loc.pathname.replace(/\/+$/, "");
  if (path !== "/activate") return false;
  const search = new URLSearchParams(loc.search);
  const params: Record<string, string> = {
    activate: activateLinkKey(loc.hash) ?? search.get("key") ?? "",
  };
  const product = search.get("product");
  if (product) params.product = product;
  window.history.replaceState(null, "", `/${href.library(params)}`);
  return true;
}

const ROUTE_EVENT = "pk-portal-route";

function current(): Resolved {
  const resolved = resolveHash(window.location.hash || "#/");
  if (resolved.redirect && resolved.redirect !== window.location.hash) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${resolved.redirect}`,
    );
  }
  return resolved;
}

/** The current route, following redirects; re-renders on navigation. */
export function useRoute(): PortalRoute {
  const [route, setRoute] = React.useState<PortalRoute>(() => current().route);
  React.useEffect(() => {
    const onChange = (): void => setRoute(current().route);
    window.addEventListener("hashchange", onChange);
    window.addEventListener(ROUTE_EVENT, onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener(ROUTE_EVENT, onChange);
    };
  }, []);
  return route;
}

export function navigate(to: string): void {
  if (window.location.hash === to) return;
  window.location.hash = to;
}

/**
 * Merge `patch` into the current hash's query (null or "" removes a key), without adding a
 * history entry.
 */
export function setParams(patch: Record<string, string | null>): void {
  const raw = window.location.hash || "#/";
  const [path = "#/", query = ""] = raw.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") params.delete(k);
    else params.set(k, v);
  }
  const q = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${path}${q ? `?${q}` : ""}`,
  );
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** `document.title` as "<Page> · Polaris Key" (PORTAL.md naming). */
export function useDocumentTitle(page: string | null): void {
  React.useEffect(() => {
    document.title = page ? `${page} · Polaris Key` : "Polaris Key";
  }, [page]);
}

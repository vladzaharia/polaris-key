import * as React from "react";
import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import { MANAGE_FOR_MAX_LENGTH } from "@polaris-key/protocol/license";
import { carriesKey, MAX_RETURN_LENGTH } from "./model/returnUrl.js";

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
 *   bar before the first render (`rewriteActivatePath`). An app's `product=`, `next=`, `for=`
 *   and `return=` come along (`activateLinkParams`, PX-17).
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
 * What an Activate link may ask for after the add (plans/PX-W8.md Q3): only the device-limit
 * flow, for a floating license an app refused with `device_limit`.
 */
export const ACTIVATE_NEXT = ["free-device"] as const;
export type ActivateNext = (typeof ACTIVATE_NEXT)[number];

/**
 * The parameters an `/activate` link carries into `#/?activate=…` (PORTAL.md §4.18; the link
 * shapes are WIRE-CONTRACT-V4 §5.3's, built by the Worker's `manageUrl` and client-core's
 * `withManageReturn` / `withManageKey`):
 *
 * - `activate`: the key, from the `#key=` fragment or a legacy `?key=` (the fragment wins), or
 *   `""` for a link without one. The key goes here and nowhere else.
 * - `product`: the product an app sent the person from, when it is a product slug.
 * - `next`: `free-device` (a floating license at its device limit); anything else is dropped.
 * - `for`: the coarse device label for the free-device flow, at most 64 characters.
 * - `return`: where to go after the add, followed only once validated (`model/returnUrl.ts`:
 *   the login card on this origin, or a target the product declares).
 *
 * Every other parameter is dropped, and so is a `for` or `return` that carries a license key:
 * the hash travels with every sign-in's return URL (`carriedKey.ts`), minus `activate`. Pure.
 */
export function activateLinkParams(
  loc: Pick<Location, "search" | "hash">,
): Record<string, string> {
  const search = new URLSearchParams(loc.search);
  const params: Record<string, string> = {
    activate: activateLinkKey(loc.hash) ?? search.get("key") ?? "",
  };
  const product = search.get("product");
  if (product && PRODUCT_SLUG_RE.test(product)) params.product = product;
  const next = search.get("next");
  if (next && (ACTIVATE_NEXT as readonly string[]).includes(next))
    params.next = next;
  const forLabel = (search.get("for") ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MANAGE_FOR_MAX_LENGTH);
  if (forLabel && !carriesKey(forLabel)) params.for = forLabel;
  const back = search.get("return");
  if (back && back.length <= MAX_RETURN_LENGTH && !carriesKey(back))
    params.return = back;
  return params;
}

/**
 * `/activate[?product=…&next=…&for=…&return=…]#key=…` → `/#/?activate=…[&product=……]`, in place,
 * with `history.replaceState` (`activateLinkParams` says what is kept). Returns whether it
 * rewrote the URL. Run once, before the first render and before any request, so neither the
 * `#key=` fragment nor a legacy `?key=` query (links already out; the fragment wins when both are
 * there) stays in the address bar or the history entry. The key then lives only in this tab's
 * `#/?activate=`, which the signed-in shell consumes as it opens the modal and every sign-in
 * leaves out of its return URL (`carriedKey.ts`). See THREAT-MODEL.md, "Key-bearing deep links".
 */
export function rewriteActivatePath(loc: Location = window.location): boolean {
  const path = loc.pathname.replace(/\/+$/, "");
  if (path !== "/activate") return false;
  window.history.replaceState(
    null,
    "",
    `/${href.library(activateLinkParams(loc))}`,
  );
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

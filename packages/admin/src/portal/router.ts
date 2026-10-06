import * as React from "react";
import { flushSync } from "react-dom";
import {
  reducedMotion,
  viewTransition,
  viewTransitionsSupported,
} from "../ui/motion/index.js";
import { pendingHeadingFocus } from "./focus.js";

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
 *
 * Every navigation between pages (MO-05, notes/S-23 §6.3) runs through the motion layer's
 * `viewTransition()`, typed `forward`, `back` or `route` ({@link navigationKind}); under reduced
 * motion it is an instant swap. It lands at the top of the new page (or the section a deep link
 * names) and focuses the page's `h1`, so a screen reader hears the new page once.
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

// ── Navigation motion, scroll and focus (notes/S-23 §6.3, §6.5; MO-05) ────────────────────────────

/**
 * How one route follows another:
 *
 * - `forward`: into a product from the Library or Discover; `back`: from a product to the Library
 *   or Discover. The main region slides along the reading direction, and the product's art, icon
 *   and name fly between its tile and the product hero (`pk-hero`, `pk-hero-icon`,
 *   `pk-hero-title`).
 * - `route`: between any other two pages (the top-level pages, one product to another, the
 *   focused flows). The main region fades through.
 * - `section`: the same page, another section (`#/p/<slug>/devices` from the product itself).
 *   No transition and no focus move: the page scrolls there, like an in-page link.
 * - `params`: the same page and section with other query parameters (filters, the selected
 *   license, the Activate modal). Nothing moves, so typing never animates (S-23 §6.2 rule 4).
 */
export type PortalNavigation =
  | "forward"
  | "back"
  | "route"
  | "section"
  | "params";

function pageOf(r: PortalRoute): string {
  switch (r.kind) {
    case "product":
      return `product:${r.product}`;
    case "focused":
      return `focused:${r.flow}:${r.product}`;
    default:
      return r.kind;
  }
}

function sectionOf(r: PortalRoute): string | null {
  return r.kind === "product" || r.kind === "account" ? r.section : null;
}

const isTopLevel = (r: PortalRoute): boolean =>
  r.kind === "library" || r.kind === "discover";

/** The kind of navigation from one route to the next (pure). */
export function navigationKind(
  from: PortalRoute,
  to: PortalRoute,
): PortalNavigation {
  if (pageOf(from) === pageOf(to))
    return sectionOf(from) === sectionOf(to) ? "params" : "section";
  if (isTopLevel(from) && to.kind === "product") return "forward";
  if (from.kind === "product" && isTopLevel(to)) return "back";
  return "route";
}

/**
 * Overlays that can be on screen during a navigation: Radix keeps one mounted through its exit
 * (`data-state="closed"`) and, when it leaves, hands focus back to its trigger or opener. A menu
 * counts: the account menu's links navigate.
 */
const OVERLAY_ROLES = ["dialog", "alertdialog", "menu"];
const OVERLAYS = OVERLAY_ROLES.map((r) => `[role="${r}"]`).join(", ");
const CLOSING_OVERLAYS = OVERLAY_ROLES.map(
  (r) => `[role="${r}"][data-state="closed"]`,
).join(", ");
const OPEN_OVERLAYS = OVERLAY_ROLES.map(
  (r) => `[role="${r}"]:not([data-state="closed"])`,
).join(", ");

/**
 * Focus the page heading (`main h1`, unless `target` names another) without scrolling, so a
 * screen reader starts on the new page and hears it once (S-23 §6.5). A dialog or menu still
 * running its exit hands focus back to its opener when it leaves (ui/Dialog.tsx, Radix), so this
 * waits for it to go first; one that is open keeps focus. The heading becomes programmatically
 * focusable (`tabindex="-1"`, which styles.css draws no ring for).
 */
export function focusPageHeading(
  target: () => HTMLElement | null = () =>
    document.querySelector<HTMLElement>("main h1"),
): void {
  let frames = 0;
  const attempt = (): void => {
    if (document.querySelector(CLOSING_OVERLAYS) && frames++ < 60) {
      requestAnimationFrame(attempt);
      return;
    }
    // Radix returns focus in a task after the overlay unmounts: run after that one.
    window.setTimeout(() => {
      const el = target();
      if (!el?.isConnected || document.querySelector(OPEN_OVERLAYS)) return;
      if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }, 0);
  };
  attempt();
}

/** Smooth scrolling only when motion is allowed: it is instant under reduced motion (S-23 §6.6). */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}

function scrollToTop(behavior: ScrollBehavior = "instant"): void {
  if (window.scrollX !== 0 || window.scrollY !== 0)
    window.scrollTo({ top: 0, left: 0, behavior });
}

/**
 * The shared element (S-23 §6.1): the Library or Discover tile a product was opened from. A
 * delegated click listener marks it with `data-vt-source="<slug>"` (LibraryTile and DiscoverTile
 * stay as they are); the navigation that follows names its art, icon and title for that one
 * transition.
 */
export const VT_SOURCE = "data-vt-source";
const TILE = "article, tr";

type Ends = Array<readonly [Element | null, string]>;

/** A tile's (or list row's) art, icon and title: the ends that fly into the product hero. */
function endsOf(tile: Element, slug: string): Ends {
  // The art is the tile's direct child (ProductArt); a list row has none. Only real art flies: a
  // tint field has no hero banner to pair with. The icon (ProductIcon, data-art too) sits in
  // front of the art's lower edge, so it flies as well, or the art would cover it mid-flight.
  const art = tile.querySelector(':scope > [data-art="image"]');
  const icon =
    Array.from(tile.querySelectorAll("[data-art]")).find(
      (el) => el.parentElement !== tile,
    ) ?? null;
  const title =
    tile.querySelector("h2, h3") ??
    Array.from(tile.querySelectorAll("a[href]")).find(
      (a) => a.getAttribute("href") === href.product(slug),
    ) ??
    null;
  return [
    [art, "pk-hero"],
    [icon, "pk-hero-icon"],
    [title, "pk-hero-title"],
  ];
}

function markSource(e: MouseEvent): void {
  if (
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  )
    return;
  const link = (e.target as Element | null)?.closest?.("a[href]");
  const to = link?.getAttribute("href") ?? "";
  if (!link || !to.startsWith("#") || !link.closest("main")) return;
  const { route } = resolveHash(to);
  // The product's page itself, not a deep link into one of its sections.
  if (route.kind !== "product" || route.section) return;
  const tile = link.closest(TILE);
  if (!tile) return;
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`)))
    el.removeAttribute(VT_SOURCE);
  tile.setAttribute(VT_SOURCE, route.product);
}

/** The tile marked as the source for `slug`; any other mark is dropped. */
function takeSource(slug: string): Element | null {
  let found: Element | null = null;
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`))) {
    if (!found && el.getAttribute(VT_SOURCE) === slug) found = el;
    else el.removeAttribute(VT_SOURCE);
  }
  return found;
}

/** The tile that opens `slug` on the page now showing (the Library's grid or list, Discover). */
function tileFor(slug: string): Element | null {
  const target = href.product(slug);
  const link = Array.from(document.querySelectorAll("main a[href]")).find(
    (a) => a.getAttribute("href") === target,
  );
  return link?.closest(TILE) ?? null;
}

/** Elements the router named through the CSSOM for the running transition (S-23 D8). */
let named: HTMLElement[] = [];

function clearNamed(keep: Element | null = null): void {
  for (const el of named) el.style.removeProperty("view-transition-name");
  named = [];
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`)))
    if (el !== keep) el.removeAttribute(VT_SOURCE);
}

function nameNewEnds(ends: Ends): void {
  for (const [el, name] of ends) {
    if (!(el instanceof HTMLElement)) continue;
    el.style.setProperty("view-transition-name", name);
    named.push(el);
  }
}

/**
 * Back on the Library: bring the tile on screen before the new state is captured, so the morph
 * lands on it. The page is at the top by then, so this scrolls only as far as the tile needs.
 */
function reveal(tile: Element): void {
  const r = tile.getBoundingClientRect();
  if (r.height === 0) return;
  if (r.top < 0 || r.bottom > window.innerHeight)
    tile.scrollIntoView?.({ block: "nearest", behavior: "instant" });
}

// The route store: one listener set for every useRoute() (the shell, each QuickAction, the sign-in
// page), so a navigation runs its transition, scroll and focus once.
const listeners = new Set<() => void>();
let snapshot: PortalRoute | null = null;
let generation = 0;
let restoration: ScrollRestoration | null = null;

function read(): PortalRoute {
  snapshot ??= current().route;
  return snapshot;
}

function publish(next: PortalRoute): void {
  snapshot = next;
  for (const listener of Array.from(listeners)) listener();
}

function go(from: PortalRoute, to: PortalRoute): void {
  const kind = navigationKind(from, to);
  if (kind === "params") {
    publish(to);
    return;
  }
  if (kind === "section") {
    publish(to);
    const section = sectionOf(to);
    const el = section ? document.getElementById(`section-${section}`) : null;
    if (el) el.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" });
    else if (!section) scrollToTop(scrollBehavior());
    return;
  }

  const gen = ++generation;
  // An overlay on screen (the JumpPalette, Activate or the account menu running its exit) means no
  // View Transition: one would lift the page above it and its scrim (S-23 §3.4 item 1). The page
  // swaps under the closing overlay instead, and its focus waits for the overlay to leave.
  const animate =
    viewTransitionsSupported() &&
    !reducedMotion() &&
    document.querySelector(OVERLAYS) === null;
  const source =
    animate && kind === "forward" && to.kind === "product"
      ? takeSource(to.product)
      : null;
  // An earlier transition's names go (it is skipped); the source keeps its mark for this one.
  clearNamed(source);
  const shared =
    source && to.kind === "product" ? endsOf(source, to.product) : [];
  // Back pairs the hero's art only if the product page had one (a cover).
  const heroArt =
    animate &&
    kind === "back" &&
    document.querySelector(".pk-vt-hero") !== null;
  const update = (): void => {
    // Before the new page renders, so its own deep link (a section) can scroll on from here.
    scrollToTop();
    flushSync(() => publish(to));
    if (!animate || kind !== "back" || from.kind !== "product") return;
    const tile = tileFor(from.product);
    if (!tile) return;
    reveal(tile);
    nameNewEnds(
      endsOf(tile, from.product).filter(
        ([, name]) => heroArt || name !== "pk-hero",
      ),
    );
  };
  let handle: { updateCallbackDone: Promise<void>; finished: Promise<void> };
  if (animate) handle = viewTransition(update, { type: kind, shared });
  else {
    update();
    handle = {
      updateCallbackDone: Promise.resolve(),
      finished: Promise.resolve(),
    };
  }
  void handle.updateCallbackDone.then(() => {
    // The product page takes a pending request itself, once its heading exists (focus.ts).
    if (gen === generation && pendingHeadingFocus() === null)
      focusPageHeading();
  });
  void handle.finished.then(() => {
    if (gen === generation) clearNamed();
  });
}

function onHashChange(e: Event): void {
  const oldURL = (e as HashChangeEvent).oldURL;
  let from = read();
  if (oldURL) {
    try {
      from = resolveHash(new URL(oldURL).hash || "#/").route;
    } catch {
      // an unreadable old URL: compare with the route on screen
    }
  }
  go(from, current().route);
}

function onParams(): void {
  publish(current().route);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(ROUTE_EVENT, onParams);
    document.addEventListener("click", markSource);
    // The router places the page on every navigation (the top, a section, or the tile Back came
    // from); the browser's own restoration would move the outgoing page first.
    if ("scrollRestoration" in window.history) {
      restoration = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener(ROUTE_EVENT, onParams);
    document.removeEventListener("click", markSource);
    if (restoration) window.history.scrollRestoration = restoration;
    restoration = null;
    snapshot = null;
  };
}

/**
 * The current route, following redirects; re-renders on navigation. A navigation between pages
 * runs in a View Transition typed by {@link navigationKind} (an instant swap under reduced
 * motion), lands at the top of the new page (or the section its deep link names) and focuses the
 * page's heading once the new page is in the DOM.
 */
export function useRoute(): PortalRoute {
  return React.useSyncExternalStore(subscribe, read, read);
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

import * as React from "react";
import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import { MANAGE_FOR_MAX_LENGTH } from "@polaris-key/protocol/license";
import { carriesKey, MAX_RETURN_LENGTH } from "./model/returnUrl.js";
import { flushSync } from "react-dom";
import {
  reducedMotion,
  viewTransition,
  viewTransitionsSupported,
} from "../ui/motion/index.js";
import { pendingHeadingFocus } from "./focus.js";
import { focusRoute } from "../ui/focusRoute.js";
import {
  CLOSING_OVERLAYS,
  OPEN_OVERLAYS,
  createHashRouter,
  overlayOnScreen,
} from "../lib/router-core.js";

/**
 * The customer site's router (PORTAL.md §3.3). Hash routing for the signed-in SPA (ADMIN.md lead
 * decision Q2); product ids in URLs are product slugs.
 *
 * - `#/` is the Library and the default: any hash that names no other page lands there.
 * - `#/discover/:product` is the storefront product page (PS-05, notes/S-21 §6.5): a product the
 *   person could add, with its listing and every way to add it.
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
  "data",
] as const;
export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

export const ACCOUNT_SECTIONS = [
  "profile",
  "methods",
  "packages",
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
  /** The storefront product page (PS-05): `#/discover/:product`. */
  | { kind: "storefront"; product: string }
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
  | {
      kind: "account";
      section: AccountSection | null;
      /** `?connected=` / `?error=&method=` (a provider's Connect), `?remove=`, `?add=email`. */
      params: URLSearchParams;
    };

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
  /** The storefront product page of a product the person could add (PS-05). */
  storefront: (slug: string): string => `#/discover/${enc(slug)}`,
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
  account: (
    section?: AccountSection,
    params?: Record<string, string>,
  ): string => withQuery(`#/account${section ? `/${section}` : ""}`, params),
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
      if (a) {
        const route: PortalRoute = { kind: "storefront", product: a };
        // Nothing lives under a storefront page: a longer path is the page itself.
        return b ? { route, redirect: href.storefront(a) } : { route };
      }
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
      // The QR's link (`#/account/approve?code=`, PX-W14): the dialog over Account, with the
      // code filled in. `approve=` is the one parameter; it holds the code ("" asks for it).
      if (a === "approve") {
        const to = new URLSearchParams({ approve: params.get("code") ?? "" });
        return {
          route: { kind: "account", section: null, params: to },
          redirect: `#/account?${to.toString()}`,
        };
      }
      // Link an existing account (PX-15): the dialog over Account; the sign-in to the other account
      // returns here (`#/account/link`).
      if (a === "link") {
        const to = new URLSearchParams({ link: "1" });
        return {
          route: { kind: "account", section: null, params: to },
          redirect: `#/account?${to.toString()}`,
        };
      }
      if (a === "emails" || a === "passkeys" || a === "linked")
        return {
          route: { kind: "account", section: "methods", params },
          redirect: href.account("methods"),
        };
      const section =
        a && (ACCOUNT_SECTIONS as readonly string[]).includes(a)
          ? (a as AccountSection)
          : null;
      if (a && !section)
        return {
          route: { kind: "account", section: null, params },
          redirect: href.account(),
        };
      return { route: { kind: "account", section, params } };
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
        route: {
          kind: "account",
          section: null,
          params: new URLSearchParams(),
        },
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
 * Every other parameter is dropped, and so is a `for` or `return` that carries a license key
 * (`carriesKey`: as written or percent-decoded): the hash travels with every sign-in's return URL
 * (`carriedKey.ts`), minus `activate`. Pure.
 */
export function activateLinkParams(
  loc: Pick<Location, "search" | "hash">,
): Record<string, string> {
  const search = new URLSearchParams(loc.search);
  return {
    activate: activateLinkKey(loc.hash) ?? search.get("key") ?? "",
    ...activateContext(search),
  };
}

/** What an activate request may carry besides the key, sanitised (`activateContext`). */
export interface ActivateContext {
  product?: string;
  next?: ActivateNext;
  for?: string;
  return?: string;
}

/**
 * `product`, `next`, `for` and `return` from `params`, kept only as `activateLinkParams`
 * describes. The one rule for an `/activate` link's query and for a `#/?activate=…` hash written
 * by hand, which the signed-in shell reads. `for` is checked for a key before it is cut to 64
 * characters, so a key past the cut is never half-kept. Pure.
 */
export function activateContext(params: URLSearchParams): ActivateContext {
  const out: ActivateContext = {};
  const product = params.get("product");
  if (product && PRODUCT_SLUG_RE.test(product)) out.product = product;
  const next = params.get("next");
  if (next && (ACTIVATE_NEXT as readonly string[]).includes(next))
    out.next = next as ActivateNext;
  const forRaw = (params.get("for") ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (forRaw && !carriesKey(forRaw))
    out.for = forRaw.slice(0, MANAGE_FOR_MAX_LENGTH);
  const back = params.get("return");
  if (back && back.length <= MAX_RETURN_LENGTH && !carriesKey(back))
    out.return = back;
  return out;
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

// ── Navigation motion, scroll and focus (notes/S-23 §6.3, §6.5; MO-05) ────────────────────────────

/**
 * How one route follows another:
 *
 * - `forward`: into a product from the Library or Discover; `back`: from a product to the Library
 *   or Discover. A product's storefront page (PS-05) is a product page too: Discover's tile opens
 *   it forward and Back returns to the tile. The main region slides along the reading direction, and the product's art, icon
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
    case "storefront":
      return `storefront:${r.product}`;
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

/** The page about one product a tile opens, as its href: its Library page or its storefront page. */
function productPageHref(r: PortalRoute): string | null {
  if (r.kind === "product") return href.product(r.product);
  if (r.kind === "storefront") return href.storefront(r.product);
  return null;
}

/** The kind of navigation from one route to the next (pure). */
export function navigationKind(
  from: PortalRoute,
  to: PortalRoute,
): PortalNavigation {
  if (pageOf(from) === pageOf(to))
    return sectionOf(from) === sectionOf(to) ? "params" : "section";
  if (isTopLevel(from) && productPageHref(to) !== null) return "forward";
  if (productPageHref(from) !== null && isTopLevel(to)) return "back";
  return "route";
}

/** How long a page may take to show its real heading before the route's focus gives up. */
export const ROUTE_FOCUS_DEADLINE_MS = 10_000;

/** A placeholder heading of a page still loading ("Loading", inside its `aria-busy` skeleton). */
const placeholder = (el: Element | null): boolean =>
  el?.closest('[aria-busy="true"]') != null;

/**
 * Focus the page heading (`main h1`, unless `target` names another) without scrolling, so a
 * screen reader starts on the new page and hears it once (S-23 §6.5). A dialog or menu still
 * running its exit hands focus back to its opener when it leaves (ui/Dialog.tsx, Radix), so this
 * waits for it to go first; one that is open keeps focus. A page still loading shows a placeholder
 * heading; this waits for the real one (about ten seconds at most) rather than announce
 * "Loading". `alive` stops the wait once another navigation has taken over. The heading becomes
 * programmatically focusable (`tabindex="-1"`, which styles.css draws no ring for).
 */
export function focusPageHeading(
  target: () => HTMLElement | null = () =>
    document.querySelector<HTMLElement>("main h1"),
  alive: () => boolean = () => true,
): void {
  let overlayFrames = 0;
  let loadingFrames = 0;
  const attempt = (): void => {
    if (!alive()) return;
    if (document.querySelector(CLOSING_OVERLAYS) && overlayFrames++ < 60) {
      requestAnimationFrame(attempt);
      return;
    }
    if (placeholder(target())) {
      if (loadingFrames++ < 600) requestAnimationFrame(attempt);
      return;
    }
    // Radix returns focus in a task after the overlay unmounts: run after that one.
    window.setTimeout(() => {
      if (!alive()) return;
      const el = target();
      if (!el?.isConnected || document.querySelector(OPEN_OVERLAYS)) return;
      if (placeholder(el)) {
        attempt();
        return;
      }
      if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }, 0);
  };
  attempt();
}

/**
 * Smooth scrolling only when motion is allowed; under reduced motion it is `instant` (not `auto`,
 * which would follow a stylesheet's `scroll-behavior`) (S-23 §6.6).
 */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "instant" : "smooth";
}

function scrollToTop(behavior: ScrollBehavior = "instant"): void {
  if (window.scrollX !== 0 || window.scrollY !== 0)
    window.scrollTo({ top: 0, left: 0, behavior });
}

/**
 * The shared element (S-23 §6.1): the Library or Discover tile a product was opened from. A
 * delegated click listener marks it with `data-vt-source="<page>"`, the hash of the product page
 * it opened (`#/p/<slug>`, or `#/discover/<slug>` for the storefront page, PS-05); LibraryTile and
 * DiscoverTile stay as they are. The navigation that follows names its art, icon and title for
 * that one transition.
 */
export const VT_SOURCE = "data-vt-source";
const TILE = "article, tr";

type Ends = Array<readonly [Element | null, string]>;

/** A tile's (or list row's) art, icon and title: the ends that fly into the product hero. */
function endsOf(tile: Element, page: string): Ends {
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
      (a) => a.getAttribute("href") === page,
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
  if (route.kind === "product" && route.section) return;
  const page = productPageHref(route);
  if (page === null) return;
  const tile = link.closest(TILE);
  if (!tile) return;
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`)))
    el.removeAttribute(VT_SOURCE);
  tile.setAttribute(VT_SOURCE, page);
}

/** The tile marked as the source for the product page `page`; any other mark is dropped. */
function takeSource(page: string): Element | null {
  let found: Element | null = null;
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`))) {
    if (!found && el.getAttribute(VT_SOURCE) === page) found = el;
    else el.removeAttribute(VT_SOURCE);
  }
  return found;
}

/**
 * The tiles that open the product page `page` on the page now showing (the Library's grid or
 * list, Discover), in document order. A product can have more than one (the Library's attention
 * list and its grid).
 */
function tilesFor(page: string): Element[] {
  const tiles: Element[] = [];
  for (const a of Array.from(document.querySelectorAll("main a[href]"))) {
    if (a.getAttribute("href") !== page) continue;
    const tile = a.closest(TILE);
    if (tile && !tiles.includes(tile)) tiles.push(tile);
  }
  return tiles;
}

/** Where the product page showing was opened from: its tile's place among that page's tiles. */
let origin: { page: string; index: number } | null = null;

/** The tile Back returns to: the one the product page was opened from, else its first. */
function tileFor(page: string): Element | null {
  const tiles = tilesFor(page);
  const remembered = origin?.page === page ? tiles[origin.index] : undefined;
  return remembered ?? tiles[0] ?? null;
}

/** Elements the router named through the CSSOM for the running transition (S-23 D8). */
let named: HTMLElement[] = [];

function clearNamed(keep: Element | null = null): void {
  for (const el of named) {
    el.style.removeProperty("view-transition-name");
    el.style.removeProperty("width");
  }
  named = [];
  for (const el of Array.from(document.querySelectorAll(`[${VT_SOURCE}]`)))
    if (el !== keep) el.removeAttribute(VT_SOURCE);
}

function nameNewEnds(ends: Ends): void {
  for (const [el, name] of ends) {
    if (!(el instanceof HTMLElement)) continue;
    el.style.setProperty("view-transition-name", name);
    // A text pair must be as wide as its text at both ends, or the snapshot stretches and a
    // ghost of the old title shows over its neighbours (S-23 §3.4 item 4).
    if (name === "pk-hero-title") el.style.setProperty("width", "fit-content");
    named.push(el);
  }
}

/**
 * Back on the Library: bring the tile on screen (before the new state is captured, so a morph
 * lands on it). The page is at the top by then, so this scrolls only as far as the tile needs.
 */
function reveal(tile: Element): void {
  const r = tile.getBoundingClientRect();
  if (r.height === 0) return;
  if (r.top < 0 || r.bottom > window.innerHeight) {
    tile.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    // The scroll position is a whole number of pixels and a tile's edge is not: rounding down
    // can leave a fraction of a pixel of the tile's bottom edge below the fold.
    const over = tile.getBoundingClientRect().bottom - window.innerHeight;
    if (over > 0)
      window.scrollBy({ top: Math.ceil(over), behavior: "instant" });
  }
}

// The route store is the shared hash-router core (lib/router-core.ts): redirects on read, the
// one publish per navigation, the blockers (none used yet), `setParams`. The portal supplies its
// route table (`resolveHash`), the kind of each navigation, and the runner that places the page.
let generation = 0;
let restoration: ScrollRestoration | null = null;
let subscribers = 0;
/** The navigation the core announced in `onNavigate`, for the runner that follows it. */
let pending: { from: PortalRoute; to: PortalRoute } | null = null;

const routeOf = (hash: string): PortalRoute => resolveHash(hash || "#/").route;

/** The route a navigation runs for: `forward`, `back` or `route`. Section and params publish at once. */
const transitionKind = (from: string, to: string): PortalNavigation | null => {
  const kind = navigationKind(routeOf(from), routeOf(to));
  return kind === "forward" || kind === "back" || kind === "route"
    ? kind
    : null;
};

function onNavigate(fromHash: string, toHash: string): void {
  const from = routeOf(fromHash);
  const to = routeOf(toHash);
  pending = { from, to };
  if (navigationKind(from, to) !== "section") return;
  const section = sectionOf(to);
  // The page's first section is its top, as a deep link to it is on mount (ProductPage marks
  // it with data-first-section).
  const first = document
    .querySelector("main [data-first-section]")
    ?.getAttribute("data-first-section");
  if (!section || section === first) {
    scrollToTop(scrollBehavior());
    return;
  }
  document
    .getElementById(`section-${section}`)
    ?.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" });
}

/**
 * Runs a page change (`forward`, `back` or `route`): names the shared ends, scrolls to the top,
 * swaps the page, reveals Back's tile and focuses the heading. `update` is the core's, which
 * releases the old page.
 */
function runNavigation(
  update: () => void,
  run: { type: string },
): { updateCallbackDone: Promise<void>; finished: Promise<void> } {
  const kind = run.type as "forward" | "back" | "route";
  const { from, to } = pending as { from: PortalRoute; to: PortalRoute };
  const gen = ++generation;
  // An overlay on screen (the JumpPalette, Activate or the account menu running its exit) means no
  // View Transition: one would lift the page above it and its scrim (S-23 §3.4 item 1). The page
  // swaps under the closing overlay instead, and its focus waits for the overlay to leave.
  const animate =
    viewTransitionsSupported() && !reducedMotion() && !overlayOnScreen();
  const toPage = kind === "forward" ? productPageHref(to) : null;
  const source = toPage !== null ? takeSource(toPage) : null;
  // Remembered for Back, motion or not.
  if (toPage !== null)
    origin = source
      ? { page: toPage, index: tilesFor(toPage).indexOf(source) }
      : null;
  // An earlier transition's names go (it is skipped); the source keeps its mark for this one.
  clearNamed(animate ? source : null);
  const shared =
    animate && source && toPage !== null ? endsOf(source, toPage) : [];
  // Back pairs the hero's art only if the product page had one (a cover).
  const heroArt =
    animate &&
    kind === "back" &&
    document.querySelector(".pk-vt-hero") !== null;
  const swap = (): void => {
    // Before the new page renders, so its own deep link (a section) can scroll on from here.
    scrollToTop();
    flushSync(update);
    const fromPage = kind === "back" ? productPageHref(from) : null;
    if (fromPage === null) return;
    // Back lands on the tile it came from, motion or not (the router owns scroll restoration).
    const tile = tileFor(fromPage);
    if (!tile) return;
    reveal(tile);
    if (animate)
      nameNewEnds(
        endsOf(tile, fromPage).filter(
          ([, name]) => heroArt || name !== "pk-hero",
        ),
      );
  };
  let handle: { updateCallbackDone: Promise<void>; finished: Promise<void> };
  if (animate) handle = viewTransition(swap, { type: kind, shared });
  else {
    swap();
    handle = {
      updateCallbackDone: Promise.resolve(),
      finished: Promise.resolve(),
    };
  }
  void handle.updateCallbackDone.then(() => {
    // A pending request for the product being opened is the product page's to take, once its
    // heading exists (focus.ts); a request for any other page never holds this one's focus.
    const ownFocus =
      to.kind === "product" && pendingHeadingFocus() === to.product;
    // focusRoute waits out a closing overlay and a loading placeholder, focuses the h1 and says
    // "{h1}, page loaded" once (D14). Section and params changes never get here.
    if (gen === generation && !ownFocus)
      void focusRoute({
        root: document.querySelector("main") ?? undefined,
        alive: () => gen === generation,
        deadline: ROUTE_FOCUS_DEADLINE_MS,
      });
  });
  void handle.finished.then(() => {
    if (gen === generation) clearNamed();
  });
  return handle;
}

const router = createHashRouter({
  redirect: (hash) => resolveHash(hash || "#/").redirect ?? null,
  classify: (from, to) => transitionKind(from, to),
  transition: runNavigation,
  runUnderOverlay: true,
  onNavigate,
});

function subscribe(listener: () => void): () => void {
  if (subscribers++ === 0) {
    document.addEventListener("click", markSource);
    // The router places the page on every navigation (the top, a section, or the tile Back came
    // from); the browser's own restoration would move the outgoing page first.
    if ("scrollRestoration" in window.history) {
      restoration = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
    }
  }
  const unsubscribe = router.subscribe(listener);
  return () => {
    unsubscribe();
    if (--subscribers > 0) return;
    document.removeEventListener("click", markSource);
    if (restoration) window.history.scrollRestoration = restoration;
    restoration = null;
    pending = null;
    // A navigation still waiting to focus its heading (an overlay leaving, a page loading)
    // belonged to the tree that just unmounted: it must not focus the next one's heading.
    generation++;
  };
}

let memoHash: string | null = null;
let memoRoute: PortalRoute = routeOf("");

/** The route of the hash on screen; one `PortalRoute` object per hash, so renders share it. */
function read(): PortalRoute {
  const hash = router.snapshot();
  if (hash !== memoHash) {
    memoHash = hash;
    memoRoute = routeOf(hash);
  }
  return memoRoute;
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
  router.navigate(to);
}

/**
 * `navigate` for a modal that holds a history entry of its own (activate.tsx): the move replaces
 * that entry, so Back goes to the page the modal opened over and not to a dead copy of it.
 */
export function navigateFromModal(to: string): void {
  const own = (window.history.state as { pkDialog?: string } | null)?.pkDialog;
  router.navigate(to, own ? { replace: true } : {});
}

/** The current hash's query, read now (a page's `params` prop is the last render's). */
export function currentParams(): URLSearchParams {
  const raw = window.location.hash || "#/";
  return new URLSearchParams(raw.split("?", 2)[1] ?? "");
}

/**
 * Merge `patch` into the current hash's query (null, "" or an empty list removes a key; a list
 * repeats the key once per value), without adding a history entry.
 */
export function setParams(
  patch: Record<string, string | readonly string[] | null>,
): void {
  router.setParams(patch);
}

/** Register a navigation guard on the portal's router; returns the unregister function. */
export function blockNavigation(fn: (nextHash: string) => boolean): () => void {
  return router.blockNavigation(fn);
}

/** `document.title` as "<Page> · <brand>" (PORTAL.md naming). */
export function useDocumentTitle(page: string | null): void {
  React.useEffect(() => {
    document.title = page ? `${page} · Polaris Locker` : "Polaris Locker";
  }, [page]);
}

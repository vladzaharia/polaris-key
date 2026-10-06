/**
 * The hash router: a tiny external store over `location.hash`, plus `<Link>`, query state and a
 * navigation blocker (docs/design/ADMIN.md §2.6). No router dependency: the route table is
 * `nav.ts` + `routes.ts`, and this file only watches the hash.
 *
 * - **Redirects.** When the hash is an old or not-ready URL, the canonical hash replaces it with
 *   `history.replaceState`, so Back does not loop through the redirect.
 * - **Links** are real `<a href>` (fixes SH-5): middle-click and open-in-new-tab work.
 * - **Query state.** `useSearchParam(name, codec)` reads and writes one hash-query parameter.
 *   Writes replace the history entry: a filter change is not a page you go Back to.
 * - **The blocker.** `blockNavigation(fn)` registers a guard that may refuse a navigation (the
 *   unsaved-changes guard in chunk 3 is its client). It intercepts `<Link>` clicks and `navigate`,
 *   and on a `hashchange` it cannot prevent (typed URL, Back) it restores the previous hash.
 * - **Motion** (notes/S-23 §6.3; MO-04). A change of page runs in a same-document View Transition
 *   (`navigationTransition` picks its type: `forward` into a deeper path, `back` to a shallower
 *   one, `route` between siblings, `tab` between the tabs of one page or record). The blockers
 *   answer first; the query alone never starts one (filters, sort and paging stay live for the
 *   `list` transitions of the tables, MO-09). Neither does a navigation made while an overlay is on
 *   screen (the palette, a menu, a confirm, the phone navigation, open or still closing): the
 *   snapshots would paint over it (S-23 §3.4), so the page swaps under its exit instead. Under
 *   reduced motion, or without the API, the page swaps at once, exactly as before.
 */

import * as React from "react";
import { flushSync } from "react-dom";
import {
  viewTransition,
  type ViewTransitionType,
} from "../ui/motion/viewTransition.js";
import {
  codecs,
  parseLocation,
  viewKey,
  withParam,
  type ParsedLocation,
  type QueryCodec,
  type Route,
} from "./routes.js";

export { codecs };

type Blocker = (nextHash: string) => boolean;

const listeners = new Set<() => void>();
const blockers = new Set<Blocker>();
/** The last hash every blocker allowed: what a refused `hashchange` is rolled back to. */
let committedHash: string | null = null;
/** The hash the console is at: the last one published to the page. `null` while nothing listens. */
let shownHash: string | null = null;
/**
 * While a navigation's View Transition waits for the browser to capture the old page, the page
 * keeps rendering this, the old hash; the transition's update releases it. `null` otherwise.
 */
let heldHash: string | null = null;
/** What the last `<Link>` click said about the navigation it started. */
let intent: {
  hash: string;
  type?: ViewTransitionType;
  shared: Element | null;
} | null = null;

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** What the page renders: the held old hash during a transition's capture, else the location. */
function snapshot(): string {
  return heldHash ?? shownHash ?? currentHash();
}

function emit(): void {
  for (const l of listeners) l();
}

function allowed(nextHash: string): boolean {
  for (const b of blockers) if (!b(nextHash)) return false;
  return true;
}

function replaceHash(hash: string): void {
  const { pathname, search } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${search}${hash}`,
  );
}

/**
 * An overlay on screen, open or still running its exit: a modal's scrim (dialogs, sheets, the
 * palette, the phone navigation), a drawer, or popper content (menus, popovers, the product
 * switcher). Tooltips do not count: one closes on the click that navigates.
 */
function overlayShown(): boolean {
  if (document.querySelector(".animate-pk-overlay-in, .pk-overlay, .pk-drawer"))
    return true;
  return [
    ...document.querySelectorAll("[data-radix-popper-content-wrapper] > *"),
  ].some((el) => !el.querySelector("[role='tooltip']"));
}

/** A hash's path segments, without its query: `#/p/djdl/license/licenses?q=x` → 4 of them. */
function pathOf(hash: string): string[] {
  const body = hash.replace(/^#/, "");
  const q = body.indexOf("?");
  return (q === -1 ? body : body.slice(0, q)).split("/").filter(Boolean);
}

/**
 * The View Transition a navigation from `from` to `to` runs (S-23 §6.3), or `null` for none.
 *
 * - The same path (only the query differs): `null`. Filters, sort and paging are not a page
 *   change; a table animates them itself with a `list` transition (MO-09, MO-11 rely on this).
 * - The same page or record (`viewKey`), another path: `tab`, a record's route tab.
 * - Otherwise by the depth of the hash path: deeper is `forward` (a drill-down), shallower is
 *   `back`, the same depth is `route` (a sibling page). Redirected hashes count by their target.
 */
export function navigationTransition(
  from: string,
  to: string,
): ViewTransitionType | null {
  const a = parseLocation(from);
  const b = parseLocation(to);
  const pa = pathOf(a.redirect ?? from);
  const pb = pathOf(b.redirect ?? to);
  if (pa.join("/") === pb.join("/")) return null;
  if (viewKey(a.route) === viewKey(b.route)) return "tab";
  if (pb.length > pa.length) return "forward";
  if (pb.length < pa.length) return "back";
  return "route";
}

/**
 * Show `next`, a hash every blocker has allowed. A change of page runs in a View Transition: the
 * page keeps the old hash until the browser has captured it, then renders the new one inside the
 * transition's update (`flushSync`, so the DOM is final when the new state is captured, and the
 * shell's route focus and scroll reset have run by `updateCallbackDone`). The same hash again is
 * a no-op: one navigation fires both `popstate` and `hashchange`. `animate: false` publishes at
 * once (a redirect to the canonical URL is the same page), as does a navigation under an overlay.
 */
function publish(next: string, animate = true): void {
  const from = shownHash;
  const clicked = intent?.hash === next ? intent : null;
  intent = null;
  if (from === null) {
    emit();
    return;
  }
  if (next === from) return;
  shownHash = next;
  const type = animate
    ? (clicked?.type ?? navigationTransition(from, next))
    : null;
  if (type === null || overlayShown()) {
    emit();
    return;
  }
  const source = type === "forward" ? clicked?.shared : null;
  const name = source?.getAttribute("data-vt-shared");
  heldHash ??= from;
  // viewTransition() runs the update right here when no transition starts (reduced motion, no
  // API): the state then updates like any other store change. Only an update the browser calls
  // later, inside a running transition, needs flushSync.
  let inline = true;
  viewTransition(
    () => {
      heldHash = null;
      if (inline) emit();
      else flushSync(emit);
    },
    { type, shared: source && name ? [[source, name]] : [] },
  );
  inline = false;
}

function onHashChange(): void {
  const next = currentHash();
  if (committedHash !== null && next !== committedHash && !allowed(next)) {
    // Too late to prevent: put the URL back and keep the page.
    replaceHash(committedHash);
    return;
  }
  committedHash = next;
  publish(next);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    committedHash = currentHash();
    shownHash = currentHash();
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
      committedHash = null;
      shownHash = null;
      heldHash = null;
      intent = null;
    }
  };
}

let memoHash: string | null = null;
let memoParsed: ParsedLocation = parseLocation("");

/** Parse with a one-entry memo: every consumer of one render shares one `Route` object. */
function parsed(hash: string): ParsedLocation {
  if (hash !== memoHash) {
    memoHash = hash;
    memoParsed = parseLocation(hash);
  }
  return memoParsed;
}

/**
 * Navigate to a hash. Returns `false` when a blocker refused. `replace` swaps the history entry
 * instead of pushing one (redirects, query edits).
 */
export function navigate(
  hash: string,
  opts: { replace?: boolean } = {},
): boolean {
  if (hash === currentHash()) return true;
  if (!allowed(hash)) return false;
  if (opts.replace) {
    replaceHash(hash);
    committedHash = hash;
    publish(hash);
  } else {
    committedHash = hash;
    window.location.hash = hash;
  }
  return true;
}

/** Register a navigation guard; returns the unregister function. */
export function blockNavigation(fn: Blocker): () => void {
  blockers.add(fn);
  return () => {
    blockers.delete(fn);
  };
}

export interface Location {
  hash: string;
  route: Route;
}

/** The current location. Applies a pending redirect (old or not-ready URL) after commit. */
export function useLocation(): Location {
  const hash = React.useSyncExternalStore(subscribe, snapshot, () => "");
  const { route, redirect } = parsed(hash);
  React.useEffect(() => {
    if (redirect && redirect !== hash) {
      replaceHash(redirect);
      committedHash = redirect;
      publish(redirect, false);
    }
  }, [hash, redirect]);
  return { hash: redirect ?? hash, route };
}

/** The current route. */
export function useRoute(): Route {
  return useLocation().route;
}

/**
 * One typed hash-query parameter. The setter replaces the history entry and never remounts the
 * page (views are keyed on product + page + id, not on the query).
 */
export function useSearchParam<T>(
  name: string,
  codec: QueryCodec<T>,
): [T, (value: T) => void] {
  const { route, hash } = useLocation();
  const raw = route.query.get(name);
  const value = React.useMemo(() => codec.parse(raw), [codec, raw]);
  const set = React.useCallback(
    (next: T) => {
      const q = hash.indexOf("?");
      const path = q === -1 ? hash : hash.slice(0, q);
      const query = withParam(route.query, name, codec, next);
      const s = query.toString();
      navigate(`${path || "#/"}${s ? `?${s}` : ""}`, { replace: true });
    },
    [codec, hash, name, route.query],
  );
  return [value, set];
}

export interface LinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  /** A hash built with `r.*`, `productPage` or `globalPage`. */
  to: string;
  /**
   * The View Transition this link's navigation runs, when the path alone would pick the wrong one:
   * `PageTabs` passes `tab`, so a tab kept in the query (`?tab=…`) still moves its indicator.
   */
  transition?: ViewTransitionType;
  ref?: React.Ref<HTMLAnchorElement>;
}

/**
 * A real anchor to a console hash. A plain click consults the blocker; modified and middle clicks
 * are left to the browser (open in a new tab).
 *
 * A drill-down's shared element (S-23 §6.1) starts inside the link: an element marked
 * `data-vt-shared="pk-key"` (the licence name in the Licenses table) is named for the old page
 * only and flies to the new page's `.pk-vt-key` (the record's title).
 */
export function Link({
  to,
  onClick,
  transition,
  ref,
  ...rest
}: LinkProps): React.ReactElement {
  return (
    <a
      ref={ref}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        if (rest.target && rest.target !== "_self") return;
        if (!allowed(to)) {
          e.preventDefault();
          return;
        }
        // The guards have answered for this navigation; the hashchange it causes must not ask
        // them again (a guard would prompt twice).
        committedHash = to;
        intent = {
          hash: to,
          type: transition,
          shared: e.currentTarget.querySelector("[data-vt-shared]"),
        };
      }}
      {...rest}
    />
  );
}

/** Tests: forget the store's state between renders. */
export function resetRouterForTests(): void {
  blockers.clear();
  memoHash = null;
  committedHash = null;
  shownHash = null;
  heldHash = null;
  intent = null;
}

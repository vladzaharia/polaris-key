/**
 * The hash router: a tiny external store over `location.hash`, plus `<Link>`, query state and a
 * navigation blocker (docs/design/ADMIN.md §2.6). No router dependency: the route table is
 * `nav.ts` + `routes.ts`, and this file only watches the hash.
 *
 * - **Redirects.** When the hash is a section root, the canonical hash replaces it with
 *   `history.replaceState`, so Back does not loop through the redirect.
 * - **Links** are real `<a href>` (fixes SH-5): middle-click and open-in-new-tab work.
 * - **Query state.** `useSearchParam(name, codec)` reads and writes one hash-query parameter.
 *   Writes replace the history entry (a filter change is not a page you go Back to); pass
 *   `{ replace: false }` for state that is a place of its own, like a wizard's step.
 * - **The blocker.** `blockNavigation(fn)` registers a guard that may refuse a navigation (the
 *   unsaved-changes guard in chunk 3 is its client). It intercepts `<Link>` clicks and `navigate`,
 *   and on a `hashchange` it cannot prevent (typed URL, Back) it restores the previous hash.
 * - **Motion** (notes/S-23 §6.3; MO-04). A change of page runs in a same-document View Transition
 *   (`navigationTransition` picks its type: `forward` into a deeper path, `back` to a shallower
 *   one, `route` between siblings, `tab` between the tabs of one page or record). The blockers
 *   answer first; the query alone never starts one (filters, sort and paging stay live for the
 *   `list` transitions of the tables, MO-09). Neither does a navigation made while an overlay is on
 *   screen (the palette, a menu, a confirm, the phone navigation, open or still closing; a toast): the
 *   snapshots would paint over it (S-23 §3.4), so the page swaps under its exit instead. Under
 *   reduced motion, or without the API, the page swaps at once, exactly as before.
 */

import * as React from "react";
import { flushSync } from "react-dom";
import {
  blockNavigation as coreBlock,
  createHashRouter,
  navigate as coreNavigate,
} from "../lib/router-core.js";
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

/**
 * The console's router: the shared core (`lib/router-core`) with the console's route table
 * (`redirect`), its transition classifier and the View Transition runner plugged in.
 */
const router = createHashRouter({
  redirect: (hash) => parseLocation(hash).redirect ?? null,
  classify: (from, to) => navigationTransition(from, to),
  transition: (update, run) =>
    viewTransition(update, {
      type: run.type as ViewTransitionType,
      shared: run.shared,
    }),
  flush: (fn) => flushSync(fn),
});

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
 * instead of pushing one (redirects, query edits). `force` skips the blockers, for a change that
 * stays on the page (a section anchor in the query): nothing there can be lost.
 */
export const navigate: typeof coreNavigate = (hash, opts) =>
  router.navigate(hash, opts);

/** Register a navigation guard; returns the unregister function. */
export const blockNavigation: typeof coreBlock = (fn) =>
  router.blockNavigation(fn);

export interface Location {
  hash: string;
  route: Route;
}

/** The current location. The core applies a section root's redirect when it reads the hash. */
export function useLocation(): Location {
  const hash = React.useSyncExternalStore(
    router.subscribe,
    router.snapshot,
    () => "",
  );
  const { route, redirect } = parsed(hash);
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
  options: { replace?: boolean } = {},
): [T, (value: T, opts?: { replace?: boolean; force?: boolean }) => void] {
  const replaceDefault = options.replace ?? true;
  const { route, hash } = useLocation();
  const raw = route.query.get(name);
  const value = React.useMemo(() => codec.parse(raw), [codec, raw]);
  const set = React.useCallback(
    (next: T, opts?: { replace?: boolean; force?: boolean }) => {
      const q = hash.indexOf("?");
      const path = q === -1 ? hash : hash.slice(0, q);
      const query = withParam(route.query, name, codec, next);
      const s = query.toString();
      router.navigate(`${path || "#/"}${s ? `?${s}` : ""}`, {
        replace: opts?.replace ?? replaceDefault,
        force: opts?.force,
      });
    },
    [codec, hash, name, replaceDefault, route.query],
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
        if (!router.allows(to)) {
          e.preventDefault();
          return;
        }
        // The guards have answered for this navigation; the hashchange it causes must not ask
        // them again (a guard would prompt twice).
        router.commit({
          hash: to,
          type: transition,
          shared: e.currentTarget.querySelector("[data-vt-shared]"),
        });
      }}
      {...rest}
    />
  );
}

/** Tests: forget the store's state between renders. */
export function resetRouterForTests(): void {
  memoHash = null;
  router.resetForTests();
}

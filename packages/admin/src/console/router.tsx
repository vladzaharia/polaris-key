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
 */

import * as React from "react";
import {
  codecs,
  parseLocation,
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

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
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

function onHashChange(): void {
  const next = currentHash();
  if (committedHash !== null && next !== committedHash && !allowed(next)) {
    // Too late to prevent: put the URL back and keep the page.
    replaceHash(committedHash);
    return;
  }
  committedHash = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    committedHash = currentHash();
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
    emit();
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
  const hash = React.useSyncExternalStore(subscribe, currentHash, () => "");
  const { route, redirect } = parsed(hash);
  React.useEffect(() => {
    if (redirect && redirect !== hash) {
      replaceHash(redirect);
      committedHash = redirect;
      emit();
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
  ref?: React.Ref<HTMLAnchorElement>;
}

/**
 * A real anchor to a console hash. A plain click consults the blocker; modified and middle clicks
 * are left to the browser (open in a new tab).
 */
export function Link({
  to,
  onClick,
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
        if (!allowed(to)) e.preventDefault();
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
}

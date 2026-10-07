/**
 * URLs: parsing, the redirect table, typed builders and query codecs (docs/design/ADMIN.md §2.5).
 *
 * The scheme is `#/p/<slug>/<section>/<page>[/<id>[/<tab>]][?<query>]` for product pages and
 * `#/<page>` for global ones. Hash routing stays (lead decision Q2): it needs no Worker change and
 * the static SPA keeps serving under `/manage/` with no rewrites.
 *
 * Every page comes from `nav.ts`; this module only knows how a `NavPage` maps to and from a hash.
 *
 * ── Old URLs keep working ─────────────────────────────────────────────────────────────────────
 * `LEGACY_REDIRECTS` maps every pre-redesign path to its new one. The router applies a redirect
 * with `history.replaceState`, so Back does not loop. A page that is not built yet redirects to its
 * `host` the same way. Anything else unrecognised is a not-found page that names the segment:
 * there is no silent fallback any more (SH-8), and `#/productsfoo` is not Products.
 */

import {
  GLOBAL_PAGES,
  PRODUCT_PAGES,
  SECTIONS,
  isProductPage,
  navItems,
  pageOf,
  type GlobalPageId,
  type NavPage,
  type PageId,
  type ProductPageId,
} from "./nav.js";

/** A parsed location. `query` is the hash's query string, always present (maybe empty). */
export type Route =
  | {
      kind: "global";
      page: GlobalPageId;
      /** The record id, for a global page with records (Platform → Package feeds → a feed). */
      id?: string;
      tab?: string;
      child?: RouteChild;
      query: URLSearchParams;
    }
  | {
      kind: "product";
      slug: string;
      page: ProductPageId;
      /** The record id, for a record under a collection page. */
      id?: string;
      /** The record tab, when the record page has tabs and the URL names one. */
      tab?: string;
      /** A record nested under the record (`NavRecord.child`): a package under a feed. */
      child?: RouteChild;
      query: URLSearchParams;
    }
  | {
      kind: "not-found";
      /** The product the URL was under, when it was. */
      slug?: string;
      /** The path that matched nothing, for the not-found copy. */
      path: string;
      query: URLSearchParams;
    };

/** A nested record: its id segments (`[name]`, or `[owner, name]`) and its tab. */
export interface RouteChild {
  ids: string[];
  tab?: string;
}

/** A route plus, when the URL was an old or not-ready one, the canonical hash to replace it with. */
export interface ParsedLocation {
  route: Route;
  redirect?: string;
}

// ── Legacy redirects ───────────────────────────────────────────────────────────────────────────

/**
 * Pre-redesign product paths (the old `route.ts` tabs) → their new path. The function receives the
 * segments after the old tab and returns the new path, or `null` when the old URL had no such
 * shape (it then resolves to not-found). ADMIN.md §2.5's table, exactly; `route.test.ts` walks it.
 */
export const LEGACY_REDIRECTS: Record<
  string,
  (rest: string[]) => string | null
> = {
  overview: (rest) => (rest.length === 0 ? "" : null),
  secrets: (rest) => (rest.length === 0 ? "keys" : null),
  licenses: (rest) => withId("license/licenses", rest),
  tiers: (rest) => (rest.length === 0 ? "license/tiers" : null),
  fingerprints: (rest) => (rest.length === 0 ? "license/enrollment" : null),
  config: (rest) => (rest.length === 0 ? "config/catalog" : null),
  profiles: (rest) => withId("config/profiles", rest),
  releases: (rest) => (rest.length === 0 ? "release/releases" : null),
  deliverables: (rest) => withId("release/deliverables", rest),
  compatibility: (rest) => (rest.length === 0 ? "release/compatibility" : null),
  distribution: (rest) => (rest.length === 0 ? "distribution/matrix" : null),
  "distribution-matrix": (rest) =>
    rest.length === 0 ? "distribution/matrix" : null,
  "distribution-health": (rest) =>
    rest.length === 0 ? "distribution/health" : null,
  updates: (rest) => (rest.length === 0 ? "update/feed" : null),
  identity: (rest) => (rest.length === 0 ? "identity/portal" : null),
};

/** An old list tab with an optional detail id: `<list>[/<id>]`. */
function withId(base: string, rest: string[]): string | null {
  if (rest.length === 0) return base;
  if (rest.length === 1) return `${base}/${encodeURIComponent(rest[0]!)}`;
  return null;
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────

/** Split a hash into its path segments (decoded) and query. `null` on a malformed escape. */
function splitHash(
  hash: string,
): { segments: string[]; rawPath: string; query: URLSearchParams } | null {
  const body = hash.replace(/^#/, "");
  const q = body.indexOf("?");
  const rawPath = (q === -1 ? body : body.slice(0, q)).replace(/^\/+/, "");
  const query = new URLSearchParams(q === -1 ? "" : body.slice(q + 1));
  const parts = rawPath === "" ? [] : rawPath.replace(/\/+$/, "").split("/");
  try {
    return {
      segments: parts.map((p) => decodeURIComponent(p)),
      rawPath,
      query,
    };
  } catch {
    return null;
  }
}

/** Product pages by path, longest first, so `config/catalog/edit` wins over `config/catalog`. */
const PRODUCT_BY_PATH: NavPage[] = [...PRODUCT_PAGES].sort(
  (a, b) => b.path.split("/").length - a.path.split("/").length,
);

const segs = (path: string): string[] => (path === "" ? [] : path.split("/"));

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.every((p, i) => segments[i] === p);
}

interface PathMatch {
  page: NavPage;
  id?: string;
  tab?: string;
  child?: RouteChild;
}

/** Match `segments` against `pages` (longest path first): a page, a record, or a nested record. */
function matchPath(pages: NavPage[], segments: string[]): PathMatch | null {
  for (const page of pages) {
    const base = segs(page.path);
    if (!startsWith(segments, base)) continue;
    const rest = segments.slice(base.length);
    if (rest.length === 0) return { page };
    // A record: `<path>/:id[/:tab]`. Only when the page declares one, and only when the id is not
    // itself another page's path segment (`config/catalog/edit` is matched before this runs).
    if (!page.record) continue;
    if (rest.length === 1) return { page, id: rest[0] };
    if (rest.length === 2 && page.record.tabs?.includes(rest[1]!)) {
      return { page, id: rest[0], tab: rest[1] };
    }
    // A nested record: `<path>/:id/<segment>/:childId…[/:childTab]`.
    const child = page.record.child;
    if (!child || rest[1] !== child.segment) continue;
    const after = rest.slice(2 + child.ids);
    if (rest.length < 2 + child.ids) continue;
    const ids = rest.slice(2, 2 + child.ids);
    if (after.length === 0) return { page, id: rest[0], child: { ids } };
    if (after.length === 1 && child.tabs?.includes(after[0]!)) {
      return { page, id: rest[0], child: { ids, tab: after[0] } };
    }
  }
  return null;
}

/** Match the segments after `#/p/<slug>/` against the product pages. */
function matchProductPath(segments: string[]): PathMatch | null {
  return matchPath(PRODUCT_BY_PATH, segments);
}

/** Global pages by path, longest first; only pages with records match deeper than their path. */
const GLOBAL_BY_PATH: NavPage[] = [...GLOBAL_PAGES].sort(
  (a, b) => b.path.split("/").length - a.path.split("/").length,
);

/** A section key alone (`#/p/x/license`) goes to the section's first page. */
function sectionDefault(segments: string[]): string | null {
  if (segments.length !== 1) return null;
  const section = SECTIONS.find((s) => s.key === segments[0]);
  const first = section ? navItems(section)[0] : undefined;
  return first ? first.path : null;
}

/**
 * Parse a location hash. Total: anything unrecognised is a `not-found` route, never a guess.
 *
 * Product existence is not checked here (the router knows no products); the shell renders the
 * unknown-product page for a slug the session does not have.
 */
export function parseLocation(hash: string): ParsedLocation {
  const split = splitHash(hash);
  if (!split) {
    return {
      route: { kind: "not-found", path: hash, query: new URLSearchParams() },
    };
  }
  const { segments, rawPath, query } = split;
  const qs = query.toString();
  const suffix = qs ? `?${qs}` : "";

  if (segments[0] === "p") {
    const slug = segments[1];
    if (!slug) return { route: { kind: "not-found", path: rawPath, query } };
    const rest = segments.slice(2);
    const matched = matchProductPath(rest);
    if (matched) {
      const { page, id, tab, child } = matched;
      if (!page.ready) {
        return redirectTo(productHref(slug, page.host!, {}, suffix));
      }
      if (id !== undefined && page.record && !page.record.ready) {
        return redirectTo(productHref(slug, page.page, {}, suffix));
      }
      return {
        route: {
          kind: "product",
          slug,
          page: page.page as ProductPageId,
          ...(id !== undefined ? { id } : {}),
          ...(tab !== undefined ? { tab } : {}),
          ...(child !== undefined ? { child } : {}),
          query,
        },
      };
    }
    const legacy = rest[0] ? LEGACY_REDIRECTS[rest[0]] : undefined;
    const target = legacy ? legacy(rest.slice(1)) : sectionDefault(rest);
    if (target !== null && target !== undefined) {
      // Re-parse the target so a redirect into a not-ready page follows on to its host.
      const next = parseLocation(
        `#/p/${encodeURIComponent(slug)}${target ? `/${target}` : ""}${suffix}`,
      );
      return {
        route: next.route,
        redirect:
          next.redirect ??
          `#/p/${encodeURIComponent(slug)}${target ? `/${target}` : ""}${suffix}`,
      };
    }
    return {
      route: { kind: "not-found", slug, path: rest.join("/"), query },
    };
  }

  const globalPath = segments.join("/");
  const global = GLOBAL_PAGES.find((p) => p.path === globalPath);
  if (global) {
    if (!global.ready) return redirectTo(globalHref(global.host!, suffix));
    return {
      route: { kind: "global", page: global.page as GlobalPageId, query },
    };
  }
  // A record under a global page (Platform → Package feeds → a feed, a package).
  const deep =
    segments.length > 0
      ? matchPath(
          GLOBAL_BY_PATH.filter((p) => p.record && p.path !== ""),
          segments,
        )
      : null;
  if (deep && deep.id !== undefined && deep.page.ready) {
    return {
      route: {
        kind: "global",
        page: deep.page.page as GlobalPageId,
        id: deep.id,
        ...(deep.tab !== undefined ? { tab: deep.tab } : {}),
        ...(deep.child !== undefined ? { child: deep.child } : {}),
        query,
      },
    };
  }
  return { route: { kind: "not-found", path: rawPath, query } };
}

/** Redirect to `hash`, following on when it redirects too (`#/platform` → Settings → Deployment). */
function redirectTo(hash: string): ParsedLocation {
  const next = parseLocation(hash);
  return { route: next.route, redirect: next.redirect ?? hash };
}

// ── Building ───────────────────────────────────────────────────────────────────────────────────

export type QueryInit = Record<string, string | number | null | undefined>;

function queryString(query?: QueryInit | URLSearchParams): string {
  if (!query) return "";
  const params =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => [k, String(v)]),
        );
  const s = params.toString();
  return s ? `?${s}` : "";
}

interface RecordOpts {
  id?: string;
  tab?: string;
  child?: RouteChild;
}

/** `/:id[/:tab]` or `/:id/<segment>/:childId…[/:childTab]` for a record of `page`. */
function recordSuffix(page: NavPage, opts: RecordOpts): string {
  if (opts.id === undefined) return "";
  let path = `/${encodeURIComponent(opts.id)}`;
  const child = page.record?.child;
  if (opts.child && child) {
    path += `/${child.segment}`;
    for (const id of opts.child.ids) path += `/${encodeURIComponent(id)}`;
    if (opts.child.tab !== undefined)
      path += `/${encodeURIComponent(opts.child.tab)}`;
    return path;
  }
  if (opts.tab !== undefined) path += `/${encodeURIComponent(opts.tab)}`;
  return path;
}

function globalHref(page: PageId, suffix = "", opts: RecordOpts = {}): string {
  const p = pageOf(page);
  return `#/${p.path}${recordSuffix(p, opts)}${suffix}`;
}

function productHref(
  slug: string,
  page: PageId,
  opts: RecordOpts,
  suffix = "",
): string {
  const p = pageOf(page);
  let path = `#/p/${encodeURIComponent(slug)}`;
  if (p.path) path += `/${p.path}`;
  return `${path}${recordSuffix(p, opts)}${suffix}`;
}

/** The canonical hash for a route. `parseLocation(hrefFor(r))` round-trips every built route. */
export function hrefFor(route: Route): string {
  const suffix = queryString(route.query);
  if (route.kind === "global")
    return globalHref(route.page, suffix, {
      id: route.id,
      tab: route.tab,
      child: route.child,
    });
  if (route.kind === "product") {
    return productHref(
      route.slug,
      route.page,
      { id: route.id, tab: route.tab, child: route.child },
      suffix,
    );
  }
  const prefix = route.slug ? `#/p/${encodeURIComponent(route.slug)}/` : "#/";
  return `${prefix}${route.path}${suffix}`;
}

/** A global page's hash, optionally a record of it. */
export function globalPage(
  page: GlobalPageId,
  query?: QueryInit,
  opts: RecordOpts = {},
): string {
  return globalHref(page, queryString(query), opts);
}

/** A product page's hash, optionally a record (`id`), its tab, or a nested record. */
export function productPage(
  slug: string,
  page: ProductPageId,
  opts: RecordOpts & { query?: QueryInit } = {},
): string {
  return productHref(slug, page, opts, queryString(opts.query));
}

/**
 * Typed route builders, one per page (ADMIN.md §2.6): `r.licenses(slug)`,
 * `r.license(slug, id, "keys")`, `r.home()`. They are thin over `productPage`/`globalPage`, which
 * read the paths from `nav.ts`, so a moved page moves every link with it.
 */
export const r = {
  home: (query?: QueryInit) => globalPage("home", query),
  products: (query?: QueryInit) => globalPage("products", query),
  productNew: (query?: QueryInit) => globalPage("product-new", query),
  platform: () => globalPage("platform"),
  platformSettings: () => globalPage("platform-settings"),
  platformDeployment: () => globalPage("platform-deployment"),
  platformOperations: () => globalPage("platform-operations"),
  platformStores: () => globalPage("platform-stores"),
  platformFeeds: () => globalPage("platform-feeds"),
  platformOverrideMigration: () => globalPage("platform-override-migration"),
  platformFeed: (eco: string, tab?: string) =>
    globalPage("platform-feeds", undefined, { id: eco, tab }),
  platformFeedPackage: (
    eco: string,
    owner: string,
    name: string,
    tab?: string,
  ) =>
    globalPage("platform-feeds", undefined, {
      id: eco,
      child: { ids: [owner, name], tab },
    }),
  page: (slug: string, page: ProductPageId, query?: QueryInit) =>
    productPage(slug, page, { query }),
  overview: (slug: string) => productPage(slug, "overview"),
  services: (slug: string) => productPage(slug, "services"),
  devices: (slug: string, query?: QueryInit) =>
    productPage(slug, "devices", { query }),
  device: (slug: string, deviceId: string) =>
    productPage(slug, "devices", { id: deviceId }),
  users: (slug: string, query?: QueryInit) =>
    productPage(slug, "users", { query }),
  user: (slug: string, subject: string, tab?: string) =>
    productPage(slug, "users", { id: subject, tab }),
  presentation: (slug: string) => productPage(slug, "presentation"),
  keys: (slug: string) => productPage(slug, "keys"),
  activity: (slug: string, query?: QueryInit) =>
    productPage(slug, "activity", { query }),
  settings: (slug: string) => productPage(slug, "settings"),
  licenses: (slug: string, query?: QueryInit) =>
    productPage(slug, "licenses", { query }),
  license: (slug: string, id: string, tab?: string) =>
    productPage(slug, "licenses", { id, tab }),
  tiers: (slug: string) => productPage(slug, "tiers"),
  tier: (slug: string, id: string, tab?: string) =>
    productPage(slug, "tiers", { id, tab }),
  enrollment: (slug: string) => productPage(slug, "enrollment"),
  licenseSettings: (slug: string) => productPage(slug, "license-settings"),
  licenseBatches: (slug: string) => productPage(slug, "license-batches"),
  licenseBatch: (slug: string, id: string) =>
    productPage(slug, "license-batches", { id }),
  catalog: (slug: string) => productPage(slug, "catalog"),
  catalogEdit: (slug: string) => productPage(slug, "catalog-edit"),
  profiles: (slug: string) => productPage(slug, "profiles"),
  profile: (slug: string, id: string, tab?: string) =>
    productPage(slug, "profiles", { id, tab }),
  edgeMint: (slug: string) => productPage(slug, "edge-mint"),
  releases: (slug: string) => productPage(slug, "releases"),
  release: (slug: string, releaseId: string, tab?: string) =>
    productPage(slug, "releases", { id: releaseId, tab }),
  channels: (slug: string, query?: QueryInit) =>
    productPage(slug, "channels", { query }),
  deliverables: (slug: string) => productPage(slug, "deliverables"),
  deliverable: (slug: string, id: string, tab?: string) =>
    productPage(slug, "deliverables", { id, tab }),
  compatibility: (slug: string) => productPage(slug, "compatibility"),
  simulator: (slug: string, query?: QueryInit) =>
    productPage(slug, "simulator", { query }),
  contentKeys: (slug: string) => productPage(slug, "content-keys"),
  matrix: (slug: string, query?: QueryInit) =>
    productPage(slug, "matrix", { query }),
  rollouts: (slug: string) => productPage(slug, "rollouts"),
  outlets: (slug: string) => productPage(slug, "outlets"),
  /** A-18j: `?flow=1&step=…&stores=…` opens "Add to storefronts"; `?store=` pre-scopes it. */
  storefronts: (slug: string, query?: QueryInit) =>
    productPage(slug, "storefronts", { query }),
  listing: (slug: string, query?: QueryInit) =>
    productPage(slug, "listing", { query }),
  appStore: (slug: string, query?: QueryInit) =>
    productPage(slug, "app-store", { query }),
  commerce: (slug: string) => productPage(slug, "commerce"),
  access: (slug: string) => productPage(slug, "access"),
  health: (slug: string, query?: QueryInit) =>
    productPage(slug, "health", { query }),
  credentials: (slug: string) => productPage(slug, "credentials"),
  packageFeeds: (slug: string) => productPage(slug, "package-feeds"),
  packageFeed: (slug: string, eco: string, tab?: string) =>
    productPage(slug, "package-feeds", { id: eco, tab }),
  packageFeedPackage: (slug: string, eco: string, name: string, tab?: string) =>
    productPage(slug, "package-feeds", {
      id: eco,
      child: { ids: [name], tab },
    }),
  feed: (slug: string) => productPage(slug, "feed"),
  portal: (slug: string) => productPage(slug, "portal"),
  signIn: (slug: string) => productPage(slug, "sign-in"),
  syncData: (slug: string) => productPage(slug, "sync-data"),
};

// ── Route facts ────────────────────────────────────────────────────────────────────────────────

/** The page a route shows, if any. */
export function pageOfRoute(route: Route): PageId | null {
  return route.kind === "not-found" ? null : route.page;
}

/** The product a route is under, if any. */
export function slugOfRoute(route: Route): string | null {
  if (route.kind === "product") return route.slug;
  if (route.kind === "not-found") return route.slug ?? null;
  return null;
}

/**
 * The identity a view is keyed on (ADMIN.md §2.6 remount policy): product + page + record id.
 * A query parameter or a record tab does not remount the page, so a filter change keeps its draft.
 */
export function viewKey(route: Route): string {
  const child =
    route.kind !== "not-found" && route.child
      ? `\u0000${route.child.ids.join("\u0000")}`
      : "";
  if (route.kind === "product") {
    return `${route.slug}\u0000${route.page}\u0000${route.id ?? ""}${child}`;
  }
  if (route.kind === "global")
    return route.id === undefined
      ? route.page
      : `${route.page}\u0000${route.id}${child}`;
  return `not-found\u0000${route.slug ?? ""}\u0000${route.path}`;
}

/** Is a product page id? Re-exported for the shell's narrowing. */
export { isProductPage };

// ── Query codecs ───────────────────────────────────────────────────────────────────────────────

/**
 * A query-parameter codec (ADMIN.md §5.7). `parse` gets the raw value (or `null` when absent) and
 * returns the typed value, never throwing; `format` returns the raw value, or `null` to drop the
 * parameter (the default value is never written, so URLs stay short).
 */
export interface QueryCodec<T> {
  parse(raw: string | null): T;
  format(value: T): string | null;
}

export const codecs = {
  /** A free string; empty means absent. */
  string(fallback = ""): QueryCodec<string> {
    return {
      parse: (raw) => (raw === null || raw === "" ? fallback : raw),
      format: (v) => (v === fallback || v === "" ? null : v),
    };
  },
  /** A non-negative integer (offsets, windows). Anything else reads as the fallback. */
  int(fallback: number): QueryCodec<number> {
    return {
      parse: (raw) =>
        raw !== null && /^\d+$/.test(raw) ? Number(raw) : fallback,
      format: (v) =>
        v === fallback || !Number.isInteger(v) || v < 0 ? null : String(v),
    };
  },
  /** One of a fixed set; an unknown value reads as the fallback. */
  oneOf<T extends string>(values: readonly T[], fallback: T): QueryCodec<T> {
    return {
      parse: (raw) =>
        raw !== null && (values as readonly string[]).includes(raw)
          ? (raw as T)
          : fallback,
      format: (v) => (v === fallback ? null : v),
    };
  },
  /** A comma-separated multi-value facet (`?status=active,expired`). Order kept, blanks dropped. */
  list(): QueryCodec<string[]> {
    return {
      parse: (raw) =>
        raw === null ? [] : raw.split(",").filter((v) => v !== ""),
      format: (v) => (v.length === 0 ? null : v.join(",")),
    };
  },
};

/** The query keys pages use, with their meaning (ADMIN.md §5.7). */
export const QUERY_KEYS = {
  q: "search",
  sort: "sort (`-` prefix for descending)",
  status: "facet",
  tier: "facet",
  channel: "facet",
  signin: "facet",
  platform: "facet",
  cursor: "pagination",
  offset: "pagination",
  view: "page state",
  deliverable: "page state",
  window: "page state",
  cell: "page state",
} as const;

/** A copy of `query` with `name` set to `codec.format(value)` (or removed). */
export function withParam<T>(
  query: URLSearchParams,
  name: string,
  codec: QueryCodec<T>,
  value: T,
): URLSearchParams {
  const next = new URLSearchParams(query);
  const raw = codec.format(value);
  if (raw === null) next.delete(name);
  else next.set(name, raw);
  return next;
}

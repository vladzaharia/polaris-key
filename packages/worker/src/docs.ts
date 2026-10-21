/**
 * The documentation site: a static Astro Starlight build served at `/docs`, **gated by tier**
 * (ST-29; docs plan §3.1, owner decision D2 of 2026-10-08).
 *
 * Every path has one access tier, from the directory it lives in (`DOCS_TIERS`, which mirrors the
 * docs site's own `TIER_PREFIXES` in `packages/docs/src/lib/doors.ts`; a test pins the two):
 *
 *   - **public**: the landing page, the access page, Help (`help/`) and the developer sections
 *     (`start/`, `build/`, `features/`, `reference/`), plus the site's shared assets and the
 *     public search bundle. No session.
 *   - **member**: Operate → Console, and its search bundle. Any console member:
 *     `can(principal, platform, "console", "view")`.
 *   - **admin**: Operate → Platform (the runbook included), Contribute, the full search bundle, and every
 *     path no row names (deny by default): `can(principal, platform, "docs", "view")`, which is
 *     Superadmin and Platform admin.
 *
 * The principal comes from the console's one session reader (`resolveConsoleCaller`,
 * `console/api.ts`), so the docs gate and the admin API cannot disagree about who is asking.
 *
 * Why this works at `/docs` at all: the session cookie is `__Host-pkey_admin`, and the
 * `__Host-` prefix REQUIRES `Path=/` (R1-08) — every request to this origin carries it, so
 * the gate needs no path co-location with `/manage`.
 *
 * A sessionless request for a gated path 302s to the public access page (`/docs/access/`), which
 * says who may read it and links to sign-in, and carries the page it wanted as `returnTo`, so sign-in
 * lands back on it. A member who opens an admin page gets the access page's admin wording
 * (`/docs/access/admin/`) under a 403. Search has one Pagefind bundle per tier
 * (`SEARCH_BUNDLES`), so a bundle never holds text its reader may not open.
 *
 * Serving mirrors `serveAdminAsset` (`console/index.ts`): extension-less paths resolve to the
 * directory's `index.html` (Starlight builds with `format: "directory"`), unsafe paths are
 * refused before they reach `URL.pathname` (R1-06), gated HTML is `no-store`, gated assets are `private`, and
 * public-tier files are shared-cacheable (`docsCacheControl`).
 */

import type { Env } from "./platform/env.js";
import { can, PLATFORM, type AreaId, type Principal } from "./console/authz.js";
import { resolveConsoleCaller } from "./console/api.js";
import { isSafeAssetPath } from "./platform/http.js";
import { staticHtmlSecurityHeaders } from "./core/securityHeaders.js";
import { sanitizeReturnTo } from "./console/auth.js";
import {
  DOCS_ASSET_TIERS,
  DOCS_REDIRECT_TIERS,
} from "./docsTiers.generated.js";
import {
  DOCS_SCRIPT_HASHES,
  DOCS_STYLE_ATTR_HASHES,
  DOCS_STYLE_HASHES,
} from "./docsCsp.generated.js";

/**
 * The docs CSP: the same strict shape as `appSecurityHeaders`' policy, plus the SHA-256
 * source expressions for the inline <script>/<style> the docs build emits (collected at build
 * time into `docsCsp.generated.ts`). `'unsafe-inline'` never appears: an inline script is
 * either hashed by the build pipeline or blocked.
 */
function docsCsp(): string {
  const script = ["'self'", ...DOCS_SCRIPT_HASHES].join(" ");
  const style = ["'self'", ...DOCS_STYLE_HASHES].join(" ");
  // Inline `style="…"` attributes (Expressive Code's token colours) are admitted by hash only.
  const styleAttr = ["'unsafe-hashes'", ...DOCS_STYLE_ATTR_HASHES].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${script}`,
    `style-src ${style}`,
    `style-src-attr ${styleAttr}`,
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join("; ");
}

/** The docs response headers: common hardening + the hash-carrying CSP. */
export function docsSecurityHeaders(headers = new Headers()): Headers {
  // Reuse the common hardening set via the static-HTML helper, then replace its CSP with the
  // docs policy (the static policy's `default-src 'none'` would block the site's own assets).
  staticHtmlSecurityHeaders(headers);
  headers.set("content-security-policy", docsCsp());
  return headers;
}

/** Public HTML revalidates after five minutes; a deploy reaches readers within that. */
export const DOCS_PUBLIC_HTML_CACHE = "public, max-age=300, must-revalidate";

/**
 * The cache policy of a docs file served 2xx (docs plan §3.1 "Caching"). Only a `public`-tier file
 * is ever shared-cacheable: its bytes are the same for every reader, whoever's cookie rode along.
 * Public HTML revalidates; the content-hashed `/_astro/` assets and search shards are
 * `public, immutable`; any other public file revalidates every time. A gated file (member or
 * admin tier, per `docsTierOf`) keeps the old policy: HTML `no-store`, assets `private`, so a CDN
 * or proxy never holds text a session earned. A non-2xx answer is never cached.
 */
export function docsCacheControl(
  assetPath: string,
  tier: DocsTier,
  status: number,
): string {
  if (status < 200 || status > 299) return "no-store";
  const html = assetPath.endsWith(".html");
  if (tier === "public") {
    if (html) return DOCS_PUBLIC_HTML_CACHE;
    return isImmutableAsset(assetPath)
      ? "public, max-age=31536000, immutable"
      : "public, no-cache";
  }
  if (html) return "no-store";
  return isImmutableAsset(assetPath)
    ? "private, max-age=31536000, immutable"
    : "private, no-cache";
}

/** Placeholder for tests/local runs without an assets binding — still behind the gate. */
function docsShell(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Polaris Key — Docs</title></head><body><h1>Documentation</h1><p>The docs site has not been built into this worker. Run <code>pnpm --filter @polaris-key/docs build</code> and <code>pnpm --filter @polaris-key/worker assemble</code>.</p></body></html>`,
    {
      status: 200,
      headers: docsSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/**
 * 302 to the public access page, which says who may read the page and links to sign-in. The page
 * the reader wanted rides along as `returnTo` (only when `sanitizeReturnTo` accepts it), and the
 * Worker puts it on the page's Sign in link (`withReturnTo`).
 */
function accessRedirect(pathname: string): Response {
  const returnTo = sanitizeReturnTo(pathname);
  return new Response(null, {
    status: 302,
    headers: {
      location: returnTo
        ? `/docs/access/?returnTo=${encodeURIComponent(returnTo)}`
        : "/docs/access/",
      "cache-control": "no-store",
    },
  });
}

/** The Sign in link in the access pages' source (`access.md`, `access/admin.md`). */
const SIGN_IN_HREF = 'href="/manage/login"';

/**
 * The access page's Sign in link with the validated `returnTo` on it. The query value is
 * re-validated here, so a hand-made `?returnTo=` cannot put anything but an allowlisted path on
 * the link.
 */
function withReturnTo(html: string, returnTo: string | null): string {
  const safe = sanitizeReturnTo(returnTo);
  return safe
    ? html.replace(
        SIGN_IN_HREF,
        `href="/manage/login?returnTo=${encodeURIComponent(safe)}"`,
      )
    : html;
}

/**
 * Resolve a request path under `/docs` to the asset the build emitted, or null if unsafe.
 *
 * Safety is checked on the RESOLVED candidate, not the raw pathname: page URLs legitimately
 * end in `/` (Starlight builds with `format: "directory"`), which `isSafeAssetPath` rejects —
 * but every resolved candidate ends in a real file segment, so the check applies cleanly and
 * still refuses `%`-encodings, dot segments, and empty segments (R1-06).
 */
export function docsAssetPath(pathname: string): string | null {
  let candidate: string;
  if (pathname === "/docs" || pathname === "/docs/") {
    candidate = "/docs/index.html";
  } else if (pathname.endsWith("/")) {
    candidate = `${pathname}index.html`;
  } else {
    const last = pathname.slice(pathname.lastIndexOf("/") + 1);
    candidate = last.includes(".") ? pathname : `${pathname}/index.html`;
  }
  return isSafeAssetPath(candidate) ? candidate : null;
}

/**
 * True for the content-hashed asset families the build emits (immutable by construction).
 *
 * Deliberately NARROW for Pagefind: only its `fragment/` and `index/` shards carry content
 * hashes in their filenames. The loader files (`pagefind.js`, `pagefind-ui.js`,
 * `pagefind-entry.json`, …) have STABLE names — `pagefind-entry.json` is the rotating
 * pointer that names which hashed shards to fetch — so caching them immutable would strand
 * a browser on a deleted shard set after the next deploy and silently break search for up
 * to a year.
 */
function isImmutableAsset(assetPath: string): boolean {
  return (
    assetPath.startsWith("/docs/_astro/") ||
    SEARCH_BUNDLES.some(
      ([dir]) =>
        assetPath.startsWith(`${dir}fragment/`) ||
        assetPath.startsWith(`${dir}index/`),
    )
  );
}

export type DocsTier = "public" | "member" | "admin";

/**
 * One Pagefind bundle per tier, so a search never returns text the reader may not open. Each
 * bundle holds its tier's pages and those of every tier below it (`public` ⊂ `member` ⊂
 * `admin`); `packages/docs/scripts/build-search-bundles.ts` builds them and a test pins this table
 * to the build.
 */
export const SEARCH_BUNDLES: ReadonlyArray<
  readonly [dir: string, tier: DocsTier]
> = [
  ["/docs/pagefind/", "public"],
  ["/docs/pagefind-member/", "member"],
  ["/docs/pagefind-admin/", "admin"],
];

/**
 * The tier of each resolved docs path (ST-29; docs plan §3.1, D2). A prefix ends in `/`; any other
 * row is one exact file. The longest match wins, and a path no row names is `admin`, so a new
 * top-level directory is gated until someone decides otherwise. The page rows mirror the docs
 * site's `TIER_PREFIXES` (`packages/docs/src/lib/doors.ts`); `test/docsGate.test.ts` pins them.
 */
export const DOCS_TIERS: ReadonlyArray<
  readonly [path: string, tier: DocsTier]
> = [
  // Pages, by door. (SEARCH_BUNDLES is declared above this table.)
  ["/docs/index.html", "public"],
  // The site's own "page not found", served for a miss in any tier the reader passed.
  ["/docs/404.html", "public"],
  ["/docs/access/", "public"],
  ["/docs/help/", "public"],
  ["/docs/start/", "public"],
  ["/docs/build/", "public"],
  ["/docs/features/", "public"],
  ["/docs/reference/", "public"],
  ["/docs/operate/", "member"],
  ["/docs/operate/platform/", "admin"],
  ["/docs/contribute/", "admin"],
  // The styles, fonts and scripts every page loads, and the developer door's machine-readable
  // references. The repository that builds them is public.
  ["/docs/_astro/", "public"],
  ["/docs/branding/", "public"],
  ["/docs/schemas/", "public"],
  ["/docs/openapi/", "public"],
  // The sitemap lists public pages only (the build drops the gated ones).
  ["/docs/sitemap-index.xml", "public"],
  ["/docs/sitemap-0.xml", "public"],
  // Help's own sitemap, listed under polaris.locker (the customer host serves it).
  ["/docs/sitemap-help.xml", "public"],
  // One search bundle per tier (SEARCH_BUNDLES).
  ...SEARCH_BUNDLES,
];

/** The tier of a resolved asset path (`docsAssetPath`'s output); `null` (unsafe) is `admin`. */
export function docsTierOf(assetPath: string | null): DocsTier {
  if (assetPath === null) return "admin";
  // Per-file tiers the prefixes cannot say (`docsTiers.generated.ts`): a file only gated pages
  // load, and a moved-page redirect page at its target's tier.
  const file = DOCS_ASSET_TIERS[assetPath] ?? DOCS_REDIRECT_TIERS[assetPath];
  if (file !== undefined) return file;
  let best: (typeof DOCS_TIERS)[number] | null = null;
  for (const row of DOCS_TIERS) {
    const hit = row[0].endsWith("/")
      ? assetPath.startsWith(row[0])
      : assetPath === row[0];
    if (hit && (best === null || row[0].length > best[0].length)) best = row;
  }
  return best?.[1] ?? "admin";
}

/** The `can()` area a gated tier needs at platform scope. */
const TIER_AREA: Record<Exclude<DocsTier, "public">, AreaId> = {
  member: "console",
  admin: "docs",
};

/**
 * True when the principal may read a path of this tier: anyone for `public`, any console member
 * for `member` (`console`), Superadmin and Platform admin for `admin` (`docs`).
 */
export function docsAllows(
  principal: Principal | null | undefined,
  tier: DocsTier,
): boolean {
  return tier === "public" || can(principal, PLATFORM, TIER_AREA[tier], "view");
}

/**
 * `GET|HEAD /docs[/*]` — the tiered documentation site.
 *
 * The gate runs FIRST for every gated path, assets and the search index included, before
 * anything is fetched from the assets root. A sessionless request for a gated path is sent to the
 * access page (`accessRedirect`); a session whose principal lacks the tier's area is a 403, with
 * the access page's admin wording for an admin page.
 */
export async function handleDocs(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }

  const assetPath = docsAssetPath(url.pathname);
  const tier = docsTierOf(assetPath);
  if (tier !== "public") {
    const caller = await resolveConsoleCaller(env, null, req, now);
    if (!caller) return accessRedirect(url.pathname);
    // The principal is resolved from the current platform group, not the groups the cookie was
    // minted with.
    if (!docsAllows(caller.principal, tier)) {
      // A member at an admin page reads the access page's admin wording; anything else (an asset,
      // no assets binding) is the bare refusal.
      if (assetPath?.endsWith(".html") && env.ASSETS) {
        const page = new URL(url);
        page.pathname = "/docs/access/admin/index.html";
        const res = await env.ASSETS.fetch(new Request(page, req));
        if (res.ok)
          return new Response(res.body, {
            status: 403,
            headers: docsSecurityHeaders(
              new Headers({
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
              }),
            ),
          });
      }
      return new Response(null, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  }

  if (!env.ASSETS) return docsShell();

  if (assetPath === null) return docsNotFound(req, env, url);

  url.pathname = assetPath;
  let res = await env.ASSETS.fetch(new Request(url, req));
  if (res.status === 404) return docsNotFound(req, env, url);

  const headers = new Headers(res.headers);
  if (assetPath === "/docs/access/index.html") {
    // The one page the Worker edits: its Sign in link carries the page the reader came from.
    const html = withReturnTo(
      await res.text(),
      url.searchParams.get("returnTo"),
    );
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("cache-control", "no-store");
    docsSecurityHeaders(headers);
    return new Response(req.method === "HEAD" ? null : html, {
      status: res.status,
      headers,
    });
  }
  headers.set("cache-control", docsCacheControl(assetPath, tier, res.status));
  docsSecurityHeaders(headers);
  return new Response(res.body, { status: res.status, headers });
}

/** Serve the site's own styled 404 page (falling back to a plain response without assets). */
async function docsNotFound(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const headers = docsSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  if (env.ASSETS) {
    const notFoundUrl = new URL(url);
    notFoundUrl.pathname = "/docs/404.html";
    const res = await env.ASSETS.fetch(new Request(notFoundUrl, req));
    if (res.ok) {
      return new Response(res.body, { status: 404, headers });
    }
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not found</title><h1>404</h1>`,
    { status: 404, headers },
  );
}

/**
 * The documentation site: a static Astro Starlight build served at `/docs`, **gated by tier**
 * (ST-29; docs plan §3.1, owner decision D2 of 2026-10-08).
 *
 * Every path has one access tier, from the directory it lives in (`DOCS_TIERS`, which mirrors the
 * docs site's own `TIER_PREFIXES` in `packages/docs/src/lib/doors.ts`; a test pins the two):
 *
 *   - **public**: the landing page, the access page and the developer sections (`start/`,
 *     `build/`, `features/`, `reference/`), plus the site's shared assets. No session.
 *   - **member**: Operate → Console (and Help, until D4; see `HELP_TIER`). Any console member:
 *     `can(principal, platform, "console", "view")`.
 *   - **admin**: Operate → Platform (the runbook included), Contribute, the search index, and every
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
 * A sessionless request for a gated path 302s into the normal admin sign-in with a `returnTo`
 * back to the page it wanted (validated by `console/auth.ts`; anything suspicious falls back to
 * `/manage/`). DOC-03b replaces that redirect with the public access page, splits the search
 * index per tier and flips Help public once the owner's support address exists (D4).
 *
 * Serving mirrors `serveAdminAsset` (`console/index.ts`): extension-less paths resolve to the
 * directory's `index.html` (Starlight builds with `format: "directory"`), unsafe paths are
 * refused before they reach `URL.pathname` (R1-06), HTML is `no-store`, and the
 * content-hashed `/_astro/` + `/pagefind/` assets are cached `private` (browser-cacheable,
 * never shared-cacheable).
 */

import type { Env } from "./platform/env.js";
import { can, PLATFORM, type AreaId, type Principal } from "./console/authz.js";
import { resolveConsoleCaller } from "./console/api.js";
import { isSafeAssetPath } from "./platform/http.js";
import { staticHtmlSecurityHeaders } from "./core/securityHeaders.js";
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

/** 302 into the admin sign-in, carrying the requested path for the post-login redirect. */
function loginRedirect(pathname: string): Response {
  const returnTo = encodeURIComponent(pathname);
  return new Response(null, {
    status: 302,
    headers: {
      location: `/manage/login?returnTo=${returnTo}`,
      "cache-control": "no-store",
    },
  });
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
    assetPath.startsWith("/docs/pagefind/fragment/") ||
    assetPath.startsWith("/docs/pagefind/index/")
  );
}

export type DocsTier = "public" | "member" | "admin";

/**
 * Help's tier. The docs plan makes Help public (D1), but only once the owner has given Polaris
 * Key's support and privacy addresses (D4): until then a locked-out reader has nobody to write
 * to, so Help stays member-only. DOC-03b's public switch changes this one value.
 */
export const HELP_TIER: DocsTier = "member";

/**
 * The tier of each resolved docs path (ST-29; docs plan §3.1, D2). A prefix ends in `/`; any other
 * row is one exact file. The longest match wins, and a path no row names is `admin`, so a new
 * top-level directory is gated until someone decides otherwise. The page rows mirror the docs
 * site's `TIER_PREFIXES` (`packages/docs/src/lib/doors.ts`); `test/docsGate.test.ts` pins them.
 */
export const DOCS_TIERS: ReadonlyArray<
  readonly [path: string, tier: DocsTier]
> = [
  // Pages, by door.
  ["/docs/index.html", "public"],
  // The site's own "page not found", served for a miss in any tier the reader passed.
  ["/docs/404.html", "public"],
  ["/docs/access/", "public"],
  ["/docs/help/", HELP_TIER],
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
  // One search index holds every tier's text until DOC-03b builds one bundle per tier.
  ["/docs/pagefind/", "admin"],
];

/** The tier of a resolved asset path (`docsAssetPath`'s output); `null` (unsafe) is `admin`. */
export function docsTierOf(assetPath: string | null): DocsTier {
  if (assetPath === null) return "admin";
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
 * anything is fetched from the assets root. A sessionless request for a gated path is sent to
 * sign-in; a session whose principal lacks the tier's area is a 403.
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
    if (!caller) return loginRedirect(url.pathname);
    // The principal is resolved from the current platform group, not the groups the cookie was
    // minted with.
    if (!docsAllows(caller.principal, tier))
      return new Response(null, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
  }

  if (!env.ASSETS) return docsShell();

  if (assetPath === null) return docsNotFound(req, env, url);

  url.pathname = assetPath;
  let res = await env.ASSETS.fetch(new Request(url, req));
  if (res.status === 404) return docsNotFound(req, env, url);

  const headers = new Headers(res.headers);
  if (assetPath.endsWith(".html")) {
    headers.set("cache-control", "no-store");
  } else if (isImmutableAsset(assetPath)) {
    headers.set("cache-control", "private, max-age=31536000, immutable");
  } else {
    headers.set("cache-control", "private, no-cache");
  }
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

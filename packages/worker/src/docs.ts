/**
 * The documentation site: a static Astro Starlight build served at `/docs`, **gated on the
 * platform-admin session**. There is no public docs surface — the site carries operator
 * material (the real runbook, deployment shape, KEK procedures), and the decision (docs plan
 * N7) was to publish that behind the existing admin OIDC gate rather than scrub it.
 *
 * Why the gate is just "a session exists": admin sessions are only ever issued to identities
 * whose groups pass `hasAnyAdminGrant` (`console/auth.ts` callback) — `core/console/session.ts` states
 * the invariant as "a session either carries full platform authority or it was never issued".
 * So `sessionFromRequest` returning non-null IS the platform-admin check; there is no weaker
 * session to 403.
 *
 * Why this works at `/docs` at all: the session cookie is `__Host-pkey_admin`, and the
 * `__Host-` prefix REQUIRES `Path=/` (R1-08) — every request to this origin carries it, so
 * the gate needs no path co-location with `/manage`.
 *
 * Unauthenticated requests 302 into the normal admin sign-in with a `returnTo` back to the
 * page they wanted (validated by `console/auth.ts`; anything suspicious falls back to
 * `/manage/`). Deep links and bookmarks therefore survive the login round-trip.
 *
 * Serving mirrors `serveAdminAsset` (`console/index.ts`): extension-less paths resolve to the
 * directory's `index.html` (Starlight builds with `format: "directory"`), unsafe paths are
 * refused before they reach `URL.pathname` (R1-06), HTML is `no-store`, and the
 * content-hashed `/_astro/` + `/pagefind/` assets are cached `private` (browser-cacheable,
 * never shared-cacheable — they sit behind an auth gate).
 */

import type { Env } from "./platform/env.js";
import { isPlatformAdmin } from "./console/authz.js";
import { sessionFromRequest } from "./core/console/session.js";
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

/**
 * `GET|HEAD /docs[/*]` — the gated documentation site.
 *
 * Gate FIRST, for every path under `/docs` including assets, the search index, and the
 * machine-readable artifacts (schemas, OpenAPI): nothing under this prefix is servable
 * without a platform-admin session.
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

  const session = await sessionFromRequest(env, req, now);
  if (!session) return loginRedirect(url.pathname);
  // The current platform group, not the groups the cookie was minted with.
  if (!isPlatformAdmin(env, session))
    return new Response(null, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });

  if (!env.ASSETS) return docsShell();

  const assetPath = docsAssetPath(url.pathname);
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

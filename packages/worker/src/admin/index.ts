/**
 * The admin portal's single server entrypoint. The parent router (../router.ts +
 * ../index.ts) owns URL matching; it forwards everything under `/manage` here with `path`
 * = the part AFTER `/manage`:
 *
 *   /manage/login      -> path "/login"      -> OIDC redirect
 *   /manage/callback   -> path "/callback"   -> verify + set session cookie
 *   /manage/api/...    -> path "/api/..."    -> handleAdminApi (JSON surface)
 *   /manage or /manage/ -> path "" or "/"     -> the built admin SPA asset.
 *
 * Auth, group-gating, CSRF, product scoping, catalog validation, secret redaction and
 * auditing all live below this — see ./api.ts. This module is intentionally a thin router.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import {
  handleAdminLogin,
  handleAdminCallback,
  type IdTokenVerifier,
} from "./auth.js";
import { handleAdminApi } from "./api.js";
import { appSecurityHeaders } from "../securityHeaders.js";
import { isSafeAssetPath } from "../http.js";

/** Minimal SPA placeholder for tests/local configurations without an assets binding. */
function spaShell(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key — Admin</title></head><body><div id="root"></div><script type="module" src="/manage/assets/manage.js"></script></body></html>`,
    {
      status: 200,
      headers: appSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/**
 * The files the admin bundle actually owns in the shared assets root, as an ALLOW-list.
 *
 * PK-01: `scripts/assemble-assets.mjs` copies the admin dist to the assets ROOT and the docs
 * build into `docs/` OF THAT SAME ROOT, so `serveAdminAsset` has no prefix confining it and
 * used to address every file in the root. `GET /manage/docs/index.html` therefore reached the
 * platform-admin-gated docs site with no session check of any kind — `handleAdmin` tests only
 * `/login`, `/callback` and `/api` before falling through here, and the router claims
 * `/manage/*` (router.ts) BEFORE the `/docs` reservation is ever consulted.
 *
 * This is an allow-list and not a `/docs` block-list on purpose: a block-list is wrong again
 * the moment anything else is assembled into the root. The admin dist's real top level is
 * `index.html`, `manage.html` and `assets/` — nothing else, and nothing nested.
 */
const ADMIN_ROOT_FILE = /^\/[A-Za-z0-9_~.-]+$/;
const ADMIN_ASSETS_PREFIX = "/assets/";

function adminOwnsAsset(cleanPath: string): boolean {
  if (cleanPath.startsWith(ADMIN_ASSETS_PREFIX)) {
    // One flat directory of build output. A nested path here would be reaching for something
    // the bundle does not emit.
    return ADMIN_ROOT_FILE.test(
      cleanPath.slice(ADMIN_ASSETS_PREFIX.length - 1),
    );
  }
  return ADMIN_ROOT_FILE.test(cleanPath);
}

async function serveAdminAsset(
  req: Request,
  env: Env,
  cleanPath: string,
): Promise<Response> {
  if (!env.ASSETS) return spaShell();
  const url = new URL(req.url);
  // R1-06: `cleanPath` is user-controlled and was assigned straight into `URL.pathname`,
  // whose parser normalises percent-encoded dot segments — `/manage/%2e%2e/%2e%2e/x.html`
  // walked the fetch out of the /manage prefix. Anything that is not a literal, already
  // normalised asset path falls through to the SPA shell.
  //
  // PK-01 adds the second half: being a well-formed asset path is not enough, it must also be
  // a path the ADMIN bundle owns. Everything else — `/docs/...` above all — is the shell, so a
  // deep link still works and a sibling bundle in the same root is unreachable.
  const isShell =
    !isSafeAssetPath(cleanPath) ||
    !cleanPath.includes(".") ||
    !adminOwnsAsset(cleanPath);
  url.pathname = isShell ? "/manage.html" : cleanPath;
  const res = await env.ASSETS.fetch(new Request(url, req));
  const headers = new Headers(res.headers);
  if (isShell) headers.set("cache-control", "no-store");
  // R1-06/R1-09: the security headers are applied to EVERY asset response, not just the
  // shell. Deciding on the resolved pathname was what let the escape above ship CSP-less
  // HTML from the admin origin.
  appSecurityHeaders(headers);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Handle an admin request. `path` is the pathname with the leading `/manage` removed.
 * `opts.verifier` is injectable so tests drive the callback without a live IdP; `opts.now`
 * pins the clock for deterministic session/cookie tests (defaults to wall-clock seconds).
 */
export async function handleAdmin(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  opts: { verifier?: IdTokenVerifier; now?: number } = {},
): Promise<Response> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const verifier = opts.verifier;
  const clean =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (clean === "/login") return handleAdminLogin(req, env);
  if (clean === "/callback")
    return handleAdminCallback(req, env, db, now, verifier);
  if (clean === "/api" || clean.startsWith("/api/")) {
    return handleAdminApi(req, env, db, clean, now);
  }
  // Everything else under /manage is the SPA shell/assets (deep links handled client-side).
  return serveAdminAsset(req, env, clean);
}

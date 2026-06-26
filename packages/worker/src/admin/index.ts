/**
 * The admin portal's single server entrypoint. The parent router (../router.ts +
 * ../index.ts) owns URL matching; it forwards everything under `/admin` here with `path`
 * = the part AFTER `/admin`:
 *
 *   /admin/login      -> path "/login"      -> OIDC redirect
 *   /admin/callback   -> path "/callback"   -> verify + set session cookie
 *   /admin/api/...    -> path "/api/..."    -> handleAdminApi (JSON surface)
 *   /admin or /admin/ -> path "" or "/"     -> the built admin SPA asset.
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

/** Minimal SPA placeholder for tests/local configurations without an assets binding. */
function spaShell(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key — Admin</title></head><body><div id="root"></div><script type="module" src="/admin/assets/main.js"></script></body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function serveAdminAsset(
  req: Request,
  env: Env,
  cleanPath: string,
): Promise<Response> {
  if (!env.ASSETS) return spaShell();
  const url = new URL(req.url);
  if (cleanPath === "" || cleanPath === "/" || !cleanPath.includes(".")) {
    url.pathname = "/index.html";
  } else {
    url.pathname = cleanPath;
  }
  const res = await env.ASSETS.fetch(new Request(url, req));
  if (url.pathname === "/index.html") {
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}

/**
 * Handle an admin request. `path` is the pathname with the leading `/admin` removed.
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
  // Everything else under /admin is the SPA shell/assets (deep links handled client-side).
  return serveAdminAsset(req, env, clean);
}

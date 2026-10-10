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

import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import {
  handleAdminLogin,
  handleAdminCallback,
  type IdTokenVerifier,
} from "./auth.js";
import { handleAdminApi } from "./api.js";
import { appSecurityHeaders } from "../platform/securityHeaders.js";
import { imgOrigin } from "../core/assets/imgHostname.js";
import { isPublicSpaAssetPath } from "../platform/http.js";

/** Minimal SPA placeholder for tests/local configurations without an assets binding. */
function spaShell(env: Env): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key — Admin</title></head><body><div id="root"></div><script type="module" src="/manage/assets/manage.js"></script></body></html>`,
    {
      status: 200,
      headers: appSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
        { imgOrigin: imgOrigin(env) },
      ),
    },
  );
}

async function serveAdminAsset(
  req: Request,
  env: Env,
  cleanPath: string,
): Promise<Response> {
  if (!env.ASSETS) return spaShell(env);
  const url = new URL(req.url);
  // R1-06: `cleanPath` is user-controlled and was assigned straight into `URL.pathname`,
  // whose parser normalises percent-encoded dot segments — `/manage/%2e%2e/%2e%2e/x.html`
  // walked the fetch out of the /manage prefix. Anything that is not a literal, already
  // normalised asset path falls through to the SPA shell.
  const isShell = !isPublicSpaAssetPath(cleanPath);
  url.pathname = isShell ? "/manage.html" : cleanPath;
  const res = await env.ASSETS.fetch(new Request(url, req));
  const headers = new Headers(res.headers);
  if (isShell) headers.set("cache-control", "no-store");
  // R1-06/R1-09: the security headers are applied to EVERY asset response, not just the
  // shell. Deciding on the resolved pathname was what let the escape above ship CSP-less
  // HTML from the admin origin.
  // The console shows product logos from the image host (HA-02): its policy adds exactly that
  // origin to `img-src` (`securityHeaders.ts`). The portal's shell does the same (HA-07,
  // `services/identity/portal/index.ts`).
  appSecurityHeaders(headers, { imgOrigin: imgOrigin(env) });
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

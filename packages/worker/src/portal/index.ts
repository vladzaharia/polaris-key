import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import {
  handleMagicVerify,
  handlePortalCallback,
  handlePortalLogin,
  handlePortalLogout,
} from "./auth.js";
import { handlePortalApi, handlePortalDownload } from "./api.js";
import { portalSecurityHeaders } from "./headers.js";

function portalShell(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key — Portal</title></head><body><div id="root"></div><script type="module" src="/assets/portal.js"></script></body></html>`,
    {
      status: 200,
      headers: {
        ...Object.fromEntries(
          portalSecurityHeaders(
            new Headers({
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            }),
          ),
        ),
      },
    },
  );
}

async function servePortalAsset(
  req: Request,
  env: Env,
  cleanPath: string,
): Promise<Response> {
  if (!env.ASSETS) return portalShell();
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
    portalSecurityHeaders(headers);
    return new Response(res.body, { status: res.status, headers });
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
}

export async function handlePortal(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  opts: { now?: number } = {},
): Promise<Response> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const clean =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (clean === "/login") return handlePortalLogin(req, env, db);
  if (clean === "/callback") return handlePortalCallback(req, env, db, now);
  if (clean === "/logout") return handlePortalLogout();
  if (clean === "/magic/verify") return handleMagicVerify(req, env, db, now);
  if (clean === "/api" || clean.startsWith("/api/")) {
    return handlePortalApi(req, env, db, clean, now);
  }
  const download = clean.match(/^\/download\/([^/]+)$/);
  if (download?.[1]) {
    return handlePortalDownload(
      req,
      env,
      db,
      decodeURIComponent(download[1]),
      now,
    );
  }
  return servePortalAsset(req, env, clean);
}

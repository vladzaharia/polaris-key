/**
 * The root customer portal — Identity's PLATFORM-level surface (design spec §2.1, D-14).
 *
 * ── WHY THE ROUTES DID NOT MOVE WITH THE FILES ──────────────────────────────────────────────
 *
 * `/login`, `/login/<provider>/…` (I-06), `/callback`, `/logout`, `/magic/verify`, `/api/*`
 * (the login card's `/api/signin/*` among them, I-07), `/download/<token>`,
 * `/media/<product>/<asset>` (PX-W1) and `/media/avatar/<asset>` (I-07, PX-W16) are ROOT
 * paths, reserved ahead of every product slug by `router.ts`. They stay exactly where they
 * were, and they must: the portal is one account across every tenant on the deployment — an
 * account can hold licences for several products at once — so there is no `<product>` to scope
 * them under. Namespacing them would have to invent one.
 *
 * What moved is the IMPLEMENTATION. The portal is identity work (accounts, sign-in, licence
 * claiming) and owns identity tables (`portal_*`, spec §5.2), so it lives inside the service;
 * `index.ts` (the composition root) keeps calling `handlePortal` for the platform routes, in
 * the same position it always did. A platform route implemented by a service is not a
 * contradiction — it is the same shape as `manifestIngest`, where Core owns the pipeline and a
 * service owns the rows.
 */

import type { SettingsRegistry } from "../../../core/settings/registry.js";
import {
  isPublicSpaAssetPath,
  type Db,
  type Env,
} from "../../../core/platform.js";
import {
  handleMagicVerify,
  handlePortalCallback,
  handlePortalLogin,
  handlePortalLogout,
} from "./auth.js";
import {
  handlePortalApi,
  handlePortalDownload,
  type PortalHooksFor,
} from "./api.js";
import { portalSecurityHeaders } from "./headers.js";
import { handlePortalMedia } from "./media.js";
import { hostedImageOrigin } from "../../../core/hostedImages.js";
import { serveAvatar } from "../card/avatars.js";
import { handleProviderSignInPath } from "../providers/flow.js";

/**
 * The portal's shell (and its assets) may load images from exactly one more origin: the image host
 * (`IMG_ORIGIN`), where the library's and Discover's art lives since HA-07 (`library.ts`). Only
 * while hosted copies are served (`hostedImageOrigin`); in HA-10's rollback the art is same-origin
 * again and the policy is the one it was. `appSecurityHeaders` writes the origin only after
 * `cspImageOrigin` accepts it (a bare https origin), as for the console's shell.
 */
async function portalSecurityOptions(
  env: Env,
  db: Db,
): Promise<{ imgOrigin: string | null }> {
  return { imgOrigin: await hostedImageOrigin(env, db) };
}

async function portalShell(env: Env, db: Db): Promise<Response> {
  const options = await portalSecurityOptions(env, db);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Key</title></head><body><div id="root"></div><script type="module" src="/assets/portal.js"></script></body></html>`,
    {
      status: 200,
      headers: {
        ...Object.fromEntries(
          portalSecurityHeaders(
            new Headers({
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            }),
            options,
          ),
        ),
      },
    },
  );
}

async function servePortalAsset(
  req: Request,
  env: Env,
  db: Db,
  cleanPath: string,
): Promise<Response> {
  if (!env.ASSETS) return portalShell(env, db);
  const url = new URL(req.url);
  // Same prefix-escape + CSP-stripping shape as the admin proxy (R1-06): only a literal,
  // already-normalised path is proxied, and every response carries the security headers.
  const isShell = !isPublicSpaAssetPath(cleanPath);
  url.pathname = isShell ? "/index.html" : cleanPath;
  // The shell is the same bytes for every query, and a query can carry a secret: a legacy
  // `/activate?key=<license key>` link (one of the links already out from before the key moved
  // into the `#key=` fragment). The query is never passed on, so the key reaches no subrequest;
  // the shell is `no-store` and `Referrer-Policy: no-referrer`, and nothing here echoes or
  // records it.
  if (isShell) url.search = "";
  const res = await env.ASSETS.fetch(new Request(url, req));
  const headers = new Headers(res.headers);
  if (isShell) headers.set("cache-control", "no-store");
  portalSecurityHeaders(headers, await portalSecurityOptions(env, db));
  return new Response(res.body, { status: res.status, headers });
}

export async function handlePortal(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  opts: {
    now?: number;
    /** One product's descriptor hooks, from the composition root (`dispatch.ts`): the portal's
     *  downloads read Distribution's delivery access through them (P2b-04). */
    hooksFor?: PortalHooksFor;
    /** The settings registry (ST-04), from the composition root. */
    settings?: SettingsRegistry;
  } = {},
): Promise<Response> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const clean =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (clean === "/login") return handlePortalLogin(req, env, db, now);
  // I-06: Google, Apple and Steam on the login card (`../providers/flow.ts`).
  if (clean.startsWith("/login/")) {
    return handleProviderSignInPath(req, env, db, clean, { now });
  }
  if (clean === "/callback") return handlePortalCallback(req, env, db, now);
  if (clean === "/logout") return handlePortalLogout(req, env, db, now);
  if (clean === "/magic/verify") return handleMagicVerify(req, env, db, now);
  if (clean === "/api" || clean.startsWith("/api/")) {
    return handlePortalApi(
      req,
      env,
      db,
      clean,
      now,
      opts.hooksFor,
      opts.settings,
    );
  }
  // PX-W1: the same-origin media proxy (`media.ts`): `/media/<product>/<asset>`, public. Every
  // other path under `/media` is its not-found, never the SPA shell.
  // I-07, PX-W16: account pictures, `/media/avatar/<asset>` (`avatar` is a reserved product slug,
  // so this never shadows a product's art).
  const avatar = clean.match(/^\/media\/avatar\/([^/]+)$/);
  if (avatar) return serveAvatar(req, env, avatar[1] ?? "");
  if (clean === "/media" || clean.startsWith("/media/")) {
    const media = clean.match(/^\/media\/([^/]+)\/([^/]+)$/);
    return handlePortalMedia(
      req,
      env,
      db,
      // Not decoded: a slug and an asset name are plain ASCII, and anything else is refused.
      media?.[1] ?? "",
      media?.[2] ?? "",
      now,
      opts.hooksFor,
    );
  }
  const download = clean.match(/^\/download\/([^/]+)$/);
  if (download?.[1]) {
    return handlePortalDownload(
      req,
      env,
      db,
      decodeURIComponent(download[1]),
      now,
      opts.hooksFor,
    );
  }
  return servePortalAsset(req, env, db, clean);
}

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
import { isPublicSpaAssetPath } from "../../../platform/http.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  handleMagicVerify,
  handlePortalCallback,
  handleConnectionLogin,
  handlePortalLogin,
  handlePortalLogout,
} from "./auth.js";
import {
  handlePortalApi,
  handlePortalDownload,
  type PortalHooksFor,
} from "./api.js";
import { appSecurityHeaders as portalSecurityHeaders } from "../../../core/securityHeaders.js";
import { handlePortalMedia } from "./media.js";
import { hostedImageOrigin } from "../../../core/assets/hostedImages.js";
import { serveAvatar } from "../card/avatars.js";
import { handleProviderSignInPath } from "../providers/flow.js";
import { bestRow } from "../../../core/http/routes.js";
import type { HttpMethod, RouteAuth } from "../../../core/http/routes.js";

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
    `<!doctype html><html lang="en" data-brand="locker"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris Locker</title></head><body><div id="root"></div><script type="module" src="/assets/portal.js"></script></body></html>`,
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

/** What the portal's handlers are given beside the request. */
interface PortalCtx {
  req: Request;
  env: Env;
  db: Db;
  now: number;
  /** The path, without its trailing slash. */
  clean: string;
  hooksFor: PortalHooksFor | undefined;
  settings: SettingsRegistry | undefined;
}

/**
 * One row of the root portal's table. The path is a pattern over the root path's segments
 * (`core/http/pathMatch.ts`: `:name` is one segment, a trailing `**` the rest, a literal beats a
 * parameter beats `**`). `methods` is what the route documents, NOT a gate: every handler keeps
 * its own method policy (some answer HEAD, some a richer 405), exactly as the `if` chain this
 * table replaced left them. `auth` names the credential the handler checks, as on the service
 * tables. A row whose `accept` refuses is skipped, so the request falls to the next row (a
 * `/media/avatar/` with no asset reaches the media proxy's not-found, as before).
 */
interface PortalRouteDecl {
  path: string;
  methods: readonly HttpMethod[];
  auth: RouteAuth;
  accept?: (segments: readonly string[]) => boolean;
  handler: (
    c: PortalCtx,
    m: { params: Readonly<Record<string, string>>; rest: readonly string[] },
  ) => Promise<Response>;
}

const nonEmpty = (s: string | undefined): s is string => !!s;
const READ: readonly HttpMethod[] = ["GET", "HEAD"];

/**
 * The root portal's routes. Order is irrelevant: the most specific row wins, comparing segment by
 * segment (literal, then `:param`, then `**`, then an absent segment). Because `**` also matches
 * zero segments and outranks an absent one, a `x/**` row beside a plain `x` row needs an `accept`
 * guard (`s.length > 1`) or it would take `/x`. The last row, the SPA, is the catch-all: any path
 * no other row takes is the shell or one of its assets.
 */
export const PORTAL_ROUTES: readonly PortalRouteDecl[] = [
  {
    path: "login",
    methods: ["GET", "HEAD", "POST"],
    auth: { kind: "none" },
    handler: (c) => handlePortalLogin(c.req, c.env, c.db, c.now),
  },
  // I-30: a platform connection's sign-in (`state` names the connection; `/callback` finishes it).
  // The id is everything after `/login/sso/` (it may hold slashes; the handler refuses those).
  {
    path: "login/sso/:id/**",
    methods: READ,
    auth: { kind: "none" },
    handler: (c, m) =>
      handleConnectionLogin(
        c.req,
        c.env,
        c.db,
        [m.params.id, ...m.rest].join("/"),
        c.now,
      ),
  },
  // I-06: Google, Apple and Steam on the login card (`../providers/flow.ts`).
  {
    path: "login/**",
    methods: ["GET", "HEAD", "POST"],
    auth: { kind: "handler" },
    // `**` matches zero segments and outranks an absent one, so without this `/login` would
    // reach the provider handler instead of its own row (the old `startsWith("/login/")`).
    accept: (s) => s.length > 1,
    handler: (c) =>
      handleProviderSignInPath(c.req, c.env, c.db, c.clean, {
        now: c.now,
        settings: c.settings,
      }),
  },
  {
    path: "callback",
    methods: READ,
    auth: { kind: "code" },
    handler: (c) => handlePortalCallback(c.req, c.env, c.db, c.now, c.settings),
  },
  {
    path: "logout",
    methods: ["GET", "HEAD", "POST"],
    auth: { kind: "session" },
    handler: (c) => handlePortalLogout(c.req, c.env, c.db, c.now),
  },
  {
    path: "magic/verify",
    methods: ["GET", "HEAD", "POST"],
    auth: { kind: "code" },
    handler: (c) => handleMagicVerify(c.req, c.env, c.db, c.now),
  },
  // The portal API: its own path walk, CSRF and session gates (`api.ts`).
  {
    path: "api/**",
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    auth: { kind: "session" },
    handler: (c) =>
      handlePortalApi(
        c.req,
        c.env,
        c.db,
        c.clean,
        c.now,
        c.hooksFor,
        c.settings,
      ),
  },
  // I-07, PX-W16: account pictures, `/media/avatar/<asset>` (`avatar` is a reserved product slug,
  // so this never shadows a product's art).
  {
    path: "media/avatar/:asset",
    methods: READ,
    auth: { kind: "none" },
    accept: (s) => nonEmpty(s[2]),
    handler: (c, m) => serveAvatar(c.req, c.env, m.params.asset ?? ""),
  },
  // PX-W1: the same-origin media proxy (`media.ts`): `/media/<product>/<asset>`, public. Every
  // other path under `/media` is its not-found, never the SPA shell. A slug and an asset name are
  // plain ASCII and not decoded; anything else is refused.
  {
    path: "media/**",
    methods: READ,
    auth: { kind: "none" },
    handler: (c, m) => {
      const [product, asset] = m.rest;
      const exact = m.rest.length === 2 && nonEmpty(product) && nonEmpty(asset);
      return handlePortalMedia(
        c.req,
        c.env,
        c.db,
        exact ? product : "",
        exact ? asset : "",
        c.now,
        c.hooksFor,
      );
    },
  },
  {
    path: "download/:token",
    methods: READ,
    auth: { kind: "code" },
    accept: (s) => nonEmpty(s[1]),
    handler: (c, m) =>
      handlePortalDownload(
        c.req,
        c.env,
        c.db,
        decodeURIComponent(m.params.token ?? ""),
        c.now,
        c.hooksFor,
      ),
  },
  // Everything else: the SPA shell and its assets (`/`, `/index.html`, `/activate`, `/assets/*`).
  {
    path: "**",
    methods: READ,
    auth: { kind: "none" },
    handler: (c) => servePortalAsset(c.req, c.env, c.db, c.clean),
  },
];

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
  // Segments keep their empty strings (`//`): the rows decide what an empty one means.
  const segments = clean === "/" ? [] : clean.slice(1).split("/");
  // The catch-all always matches, so there is a row for every path.
  const best = bestRow(PORTAL_ROUTES, segments, (row) =>
    row.accept ? row.accept(segments) : true,
  )!;
  return best.row.handler(
    {
      req,
      env,
      db,
      now,
      clean,
      hooksFor: opts.hooksFor,
      settings: opts.settings,
    },
    best.matched,
  );
}

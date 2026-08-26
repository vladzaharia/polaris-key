/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { matchRoute, type Route } from "./router.js";
import { loadProduct } from "./product.js";
import { handleDiscovery } from "./discovery.js";
import { handleSchema } from "./schema.js";
import { handleJwks, handleTrustManifest } from "./jwks.js";
import { handleMintAuth, handleMintToken } from "./edgeMint.js";
import {
  handleAuthCallback,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthPoll,
  handleAuthStart,
} from "./oidc.js";
import {
  handleBrowserLogout,
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "./browserSession.js";
import { handleRelease } from "./release/index.js";
import type { Arch } from "./release/assets.js";
import { handleAdmin } from "./admin/index.js";
import { handlePortal } from "./portal/index.js";
import { handleGithubWebhook } from "./githubWebhook.js";
import { notFound } from "./http.js";
import { secureResponse } from "./securityHeaders.js";
import { handleEnroll } from "./enroll.js";
import { handleScheduled } from "./scheduled.js";
import {
  handleAccount,
  handleActivate,
  handleConfig,
  handleDeauthorize,
  handleDevices,
  handleReport,
  handleToken,
} from "./licensing.js";

export { RateLimitDO } from "./rateLimitDo.js";

const PRODUCT_ROUTES = new Set<Route["kind"]>([
  "discovery",
  "jwks",
  "trustManifest",
  "schema",
  "activate",
  "enroll",
  "token",
  "account",
  "devices",
  "deauthorize",
  "config",
  "configReport",
  "browserSession",
  "browserSessionLicense",
  "authStart",
  "authLogin",
  "authLogout",
  "authDeviceStart",
  "authDeviceVerify",
  "authDevicePoll",
  "authCallback",
  "authPoll",
  "mintToken",
  "mintAuth",
  "appcast",
  "install",
  "version",
  "changelog",
  "cli",
  "dmg",
]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // R1-09: EVERY response leaving this worker goes through `secureResponse`, which adds
    // HSTS and — for any `text/html` body that did not set its own policy — the strict
    // script-free CSP. Handlers that set a policy themselves (the SPA shells) keep it. This
    // makes "there is no CSP-less HTML on this origin" a property of the dispatcher rather
    // than something each handler has to remember, and it is what currently covers the two
    // `oidc.ts` pages (device-authorization + "you're signed in"), which set no headers of
    // their own.
    return secureResponse(await dispatch(req, env));
  },

  /**
   * R11-09 / R12-10: for the whole life of this worker there was no `scheduled()` export, so
   * `audit`, `portal_audit` and `release_download_tokens` had no deleter, dormant device seats
   * were reclaimed only as a side effect of somebody else's activation, and the indexes the
   * security invariants rest on were checked by no running code. The schedule lives in
   * `wrangler.toml`'s `[triggers]` block; the work lives in `scheduled.ts`.
   *
   * `await`ed rather than handed to `ctx.waitUntil`: both keep the isolate alive for the sweep,
   * but only the awaited promise's rejection is the handler's own outcome, so a failed step (see
   * `handleScheduled`, which rethrows one aggregate) is recorded as a failed cron invocation
   * instead of arriving as a detached unhandled rejection.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<Env>;

async function dispatch(req: Request, env: Env): Promise<Response> {
  {
    const url = new URL(req.url);
    const route = matchRoute(url.pathname);
    const now = Math.floor(Date.now() / 1000);
    const db = new D1Db(env.DB);

    if ("product" in route && PRODUCT_ROUTES.has(route.kind)) {
      const product = await loadProduct(env, db, route.product);
      if (!product) return notFound();
      switch (route.kind) {
        case "discovery":
          return handleDiscovery(req, db, product);
        case "activate":
          return handleActivate(req, env, db, product, now);
        case "enroll":
          return handleEnroll(req, env, db, product, now);
        case "token":
          return handleToken(req, env, db, product, now);
        case "account":
          return handleAccount(req, env, db, product, now);
        case "devices":
          return handleDevices(req, env, db, product, now, route.deviceId);
        case "config":
          return handleConfig(req, env, db, product, now);
        case "configReport":
          return handleReport(req, env, db, product, now);
        case "deauthorize":
          return handleDeauthorize(req, env, db, product);
        case "schema":
          return handleSchema(db, product);
        case "jwks":
          return handleJwks(db, product);
        case "trustManifest":
          return handleTrustManifest(req, db, product, now);
        case "browserSession":
          return handleBrowserSession(req, env, db, product, now);
        case "browserSessionLicense":
          return handleBrowserSessionLicense(req, env, db, product, now);
        case "mintToken":
          return handleMintToken(req, env, db, product, route.mintId, now);
        case "mintAuth":
          return handleMintAuth(db, product, route.mintId);
        case "authStart":
          return handleAuthStart(req, env, db, product);
        case "authLogin":
          return handleAuthStart(req, env, db, product);
        case "authLogout":
          return handleBrowserLogout(req, env, db, product);
        case "authDeviceStart":
          return handleAuthDeviceStart(req, env, db, product);
        case "authDeviceVerify":
          return handleAuthDeviceVerify(req, env, product);
        case "authDevicePoll":
          return handleAuthDevicePoll(req, env, db, product, now);
        case "authCallback":
          return handleAuthCallback(req, env, db, product, now);
        case "authPoll":
          return handleAuthPoll(req, env, db, product, now);
        case "appcast":
          return handleRelease(
            req,
            env,
            db,
            product,
            route.channel ? "channelAppcast" : "appcast",
            {
              channel: route.channel,
            },
          );
        case "install":
          return handleRelease(req, env, db, product, "install", {});
        case "version":
          return handleRelease(req, env, db, product, "version", {});
        case "changelog":
          return handleRelease(req, env, db, product, "changelog", {});
        case "cli":
          return handleRelease(req, env, db, product, "cli", {
            version: route.version,
            arch: route.arch as Arch,
          });
        case "dmg":
          return handleRelease(req, env, db, product, "dmg", {
            version: route.version,
            arch: route.arch as Arch,
          });
        default:
          return notFound();
      }
    }

    // Admin + platform routes.
    switch (route.kind) {
      case "githubWebhook":
        return handleGithubWebhook(req, env, db, now);
      case "portalSpa":
      case "portalApi":
      case "portalLogin":
      case "portalCallback":
      case "portalLogout":
      case "portalMagicVerify":
        return handlePortal(req, env, db, url.pathname);
      case "portalDownload":
        return handlePortal(
          req,
          env,
          db,
          `/download/${encodeURIComponent(route.token)}`,
        );
      case "adminSpa":
      case "adminApi":
      case "adminLogin":
      case "adminCallback":
      case "products":
        return handleAdmin(
          req,
          env,
          db,
          url.pathname.slice("/manage".length) || "/",
        );
      default:
        return notFound();
    }
  }
}

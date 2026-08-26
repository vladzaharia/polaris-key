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
import { handleEnroll } from "./enroll.js";
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
  },
} satisfies ExportedHandler<Env>;

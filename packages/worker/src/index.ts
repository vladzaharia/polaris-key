/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { matchRoute, type Route } from "./router.js";
import { loadProduct } from "./product.js";
import { handleSchema } from "./schema.js";
import { handleJwks } from "./jwks.js";
import { handleMintAuth, handleMintToken } from "./edgeMint.js";
import { handleSubscribe } from "./subscribe.js";
import { handleAuthCallback, handleAuthPoll, handleAuthStart } from "./oidc.js";
import { handleRelease } from "./release/index.js";
import type { Arch } from "./release/assets.js";
import { handleAdmin } from "./admin/index.js";
import { errorResponse, notFound } from "./http.js";
import {
  handleConfig,
  handleDeauthorize,
  handleEnroll,
  handleReport,
  handleToken,
} from "./licensing.js";

export { HubDO } from "./hub.js";

const PRODUCT_ROUTES = new Set<Route["kind"]>([
  "jwks",
  "schema",
  "enroll",
  "token",
  "deauthorize",
  "config",
  "configReport",
  "configSubscribe",
  "authStart",
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

const NOT_IMPLEMENTED = (what: string): Response =>
  errorResponse(501, "not_implemented", `${what} is not implemented yet`);

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
        case "enroll":
          return handleEnroll(req, env, db, product, now);
        case "token":
          return handleToken(req, env, db, product, now);
        case "config":
          return handleConfig(req, env, db, product, now);
        case "configReport":
          return handleReport(req, env, db, product, now);
        case "deauthorize":
          return handleDeauthorize(req, env, db, product);
        case "schema":
          return handleSchema(db, product);
        case "jwks":
          return handleJwks(product);
        case "configSubscribe":
          return handleSubscribe(req, env, product);
        case "mintToken":
          return handleMintToken(req, env, db, product, route.mintId, now);
        case "mintAuth":
          return handleMintAuth(db, product, route.mintId);
        case "authStart":
          return handleAuthStart(req, env, db, product);
        case "authCallback":
          return handleAuthCallback(req, env, db, product, now);
        case "authPoll":
          return handleAuthPoll(req, env, db, product, now);
        case "appcast":
          return handleRelease(req, env, db, product, route.channel ? "channelAppcast" : "appcast", {
            channel: route.channel,
          });
        case "install":
          return handleRelease(req, env, db, product, "install", {});
        case "version":
          return handleRelease(req, env, db, product, "version", {});
        case "changelog":
          return handleRelease(req, env, db, product, "changelog", {});
        case "cli":
          return handleRelease(req, env, db, product, "cli", { version: route.version, arch: route.arch as Arch });
        case "dmg":
          return handleRelease(req, env, db, product, "dmg", { version: route.version, arch: route.arch as Arch });
        default:
          return notFound();
      }
    }

    // Admin + platform routes.
    switch (route.kind) {
      case "adminSpa":
      case "adminApi":
      case "adminLogin":
      case "adminCallback":
      case "products":
        return handleAdmin(req, env, db, url.pathname.slice("/admin".length) || "/");
      default:
        return notFound();
    }
  },
} satisfies ExportedHandler<Env>;

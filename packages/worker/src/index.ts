/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { matchRoute, type Route } from "./router.js";
import { loadProduct } from "./product.js";
import { handleSchema } from "./schema.js";
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
          return NOT_IMPLEMENTED("jwks"); // Phase 2
        case "configSubscribe":
          return NOT_IMPLEMENTED("config/subscribe"); // Phase 2
        case "authStart":
        case "authCallback":
        case "authPoll":
          return NOT_IMPLEMENTED("oidc"); // Phase 2
        case "mintToken":
        case "mintAuth":
          return NOT_IMPLEMENTED("edge-mint"); // Phase 2
        case "appcast":
          return NOT_IMPLEMENTED("releases"); // Phase 2
        default:
          return notFound();
      }
    }

    // Admin + platform routes — Phase 5.
    switch (route.kind) {
      case "adminSpa":
      case "adminApi":
      case "adminLogin":
      case "adminCallback":
      case "products":
        return NOT_IMPLEMENTED("admin");
      default:
        return notFound();
    }
  },
} satisfies ExportedHandler<Env>;

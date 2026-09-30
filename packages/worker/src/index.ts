/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { matchRoute, type Route } from "./router.js";
import { loadProduct } from "./core/products.js";
import { handleDiscovery } from "./core/discovery.js";
import { handleJwks, handleTrustManifest } from "./core/trust.js";
import { dispatchService } from "./core/registry.js";
import { SERVICES } from "./mount.js";
import { handleAdmin } from "./admin/index.js";
import { handleDocs } from "./docs.js";
// The root customer portal is a PLATFORM surface implemented by the Identity service: one
// account spans every tenant, so there is no product slug to namespace it under and its routes
// stay reserved ahead of product slugs in `router.ts`. Only the implementation moved (D-14).
import { handlePortal } from "./services/identity/index.js";
import { handleGithubWebhook } from "./githubWebhook.js";
import { notFound } from "./core/errors.js";
import { secureResponse } from "./securityHeaders.js";
import { handleScheduled } from "./scheduled.js";
import { handleDevices, handleReport } from "./core/devices.js";
import { handleRegister } from "./core/register.js";
import { dispatchBytesHost, isBytesHost } from "./core/bytesHost.js";

export { RateLimitDO } from "./rateLimitDo.js";

const PRODUCT_ROUTES = new Set<Route["kind"]>([
  "discovery",
  "jwks",
  "trustManifest",
  "devices",
  "report",
  "register",
  "service",
]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // R1-09: EVERY response leaving this worker goes through `secureResponse`, which adds
    // HSTS and — for any `text/html` body that did not set its own policy — the strict
    // script-free CSP. Handlers that set a policy themselves (the SPA shells) keep it. This
    // makes "there is no CSP-less HTML on this origin" a property of the dispatcher rather
    // than something each handler has to remember, and it is what currently covers the two
    // identity OIDC pages (device-authorization + "you're signed in"), which set no headers of
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
    // The bytes host (P2-01) reaches ONLY its byte-route allowlist — never the console, the
    // portal, `/docs` or a product route. With `BLOB_ORIGIN` unset this is always false, and
    // everything below runs exactly as it did before the bytes host existed.
    if (isBytesHost(url, env)) return dispatchBytesHost(req, env);
    const route = matchRoute(url.pathname);
    const now = Math.floor(Date.now() / 1000);
    const db = new D1Db(env.DB);

    if ("product" in route && PRODUCT_ROUTES.has(route.kind)) {
      const product = await loadProduct(env, db, route.product);
      if (!product) return notFound();

      // Services first: `dispatchService` checks THIS product's enablement before the
      // descriptor is consulted, so a service a product has not enabled never runs a line of
      // its own code and is indistinguishable from one that does not exist (see
      // `core/registry.ts`). Everything below is a core route — all five services are carved.
      if (route.kind === "service") {
        return dispatchService(SERVICES, route.slug, product.services, {
          req,
          env,
          db,
          product,
          rest: route.rest,
          now,
          ...(route.alias ? { alias: true } : {}),
        });
      }

      switch (route.kind) {
        case "discovery":
          return handleDiscovery(req, env, db, product, SERVICES);
        case "devices":
          return handleDevices(req, env, db, product, now, route.deviceId);
        case "report":
          return handleReport(req, env, db, product, now);
        case "register":
          // The registry is threaded through because `requires-identity` registration is
          // authorized by the Identity descriptor (`ServiceDescriptor.authorizeRegistration`);
          // Core asks the registry rather than importing the service.
          return handleRegister(req, env, db, product, now, SERVICES);
        case "jwks":
          return handleJwks(db, product);
        case "trustManifest":
          return handleTrustManifest(req, db, product, now);
        default:
          return notFound();
      }
    }

    // Admin + platform routes.
    switch (route.kind) {
      case "githubWebhook":
        return handleGithubWebhook(req, env, db, now);
      // The gated docs site: session-checked inside the handler (docs.ts), for every path
      // under the prefix — assets and machine-readable artifacts included.
      case "docs":
        return handleDocs(req, env, now);
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

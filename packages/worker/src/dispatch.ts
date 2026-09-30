/// <reference types="@cloudflare/workers-types" />
/**
 * Request dispatch — route matching, product loading, and the hand-off to Core routes, the
 * service registry, and the platform surfaces.
 *
 * Split out of `index.ts` so the whole pipeline (CORS included) can be driven from the Node test
 * lane with an in-memory `Db`; `index.ts` keeps only the Worker entry points and the
 * origin-wide `secureResponse` backstop it wraps around this function.
 */
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { matchRoute, type Route } from "./router.js";
import { loadProduct, type Product } from "./core/products.js";
import { corsPreflight, isCorsCoveredRoute, withCors } from "./core/cors.js";
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
import { handleDevices, handleReport } from "./core/devices.js";
import { handleRegister } from "./core/register.js";
import { dispatchBytesHost, isBytesHost } from "./core/bytesHost.js";

const PRODUCT_ROUTES = new Set<Route["kind"]>([
  "discovery",
  "jwks",
  "trustManifest",
  "devices",
  "report",
  "register",
  "service",
]);

export async function dispatch(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const url = new URL(req.url);
  // The bytes host (P2-01) reaches ONLY its byte-route allowlist — never the console, the
  // portal, `/docs` or a product route. With `BLOB_ORIGIN` unset this is always false, and
  // everything below runs exactly as it did before the bytes host existed.
  if (isBytesHost(url, env)) return dispatchBytesHost(req, env, db);
  const route = matchRoute(url.pathname);
  const now = Math.floor(Date.now() / 1000);

  if ("product" in route && PRODUCT_ROUTES.has(route.kind)) {
    const product = await loadProduct(env, db, route.product);
    if (!product) return notFound();

    // CORS (P0-05, `core/cors.ts`). Decided from the path SHAPE and the product's own
    // `web.origins`, before any service runs: a preflight is answered here, so its result can
    // never depend on whether the service behind the path is enabled; and the headers are
    // added only after the handler returns, so nothing a handler stores in the edge cache
    // carries one origin's allow header to the next.
    if (!isCorsCoveredRoute(route)) {
      return dispatchProductRoute(req, env, db, product, route, now);
    }
    if (req.method === "OPTIONS") return corsPreflight(product, req);
    return withCors(
      product,
      req,
      await dispatchProductRoute(req, env, db, product, route, now),
    );
  }

  // Admin + platform routes. These never answer CORS: they share this origin with the admin
  // cookie (THREAT-MODEL R1-09).
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

/** A product-scoped route, once its product has loaded. */
async function dispatchProductRoute(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  route: Route & { product: string },
  now: number,
): Promise<Response> {
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

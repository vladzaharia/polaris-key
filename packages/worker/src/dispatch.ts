/// <reference types="@cloudflare/workers-types" />
/**
 * Request dispatch — route matching, product loading, and the hand-off to Core routes, the
 * service registry, and the platform surfaces.
 *
 * Split out of `index.ts` so the whole pipeline (CORS included) can be driven from the Node test
 * lane with an in-memory `Db`; `index.ts` keeps only the Worker entry points and the
 * origin-wide `secureResponse` backstop it wraps around this function.
 */
import type { Env } from "./platform/env.js";
import type { Db } from "./db/types.js";
import { matchRoute, type Route } from "./router.js";
import {
  loadProduct,
  type Product,
  type ProductPublic,
} from "./core/products.js";
import type { ServiceHooks } from "./core/hooks.js";
import { corsPreflight, isCorsCoveredRoute, withCors } from "./core/cors.js";
import { handleDiscovery } from "./core/discovery.js";
import { handleJwks, handleTrustManifest } from "./core/trust/trust.js";
import { dispatchService, serviceContext } from "./core/registry.js";
import { identityNavigationRedirect } from "./core/accounts/identityGate.js";
import {
  BYTE_ROUTES,
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
  SETTINGS,
} from "./mount.js";
import {
  recordSighting,
  sightingNamespace,
} from "./core/integration/sightings.js";
import { handleAdmin } from "./console/index.js";
import { handleDocs } from "./docs.js";
// The root customer portal is a PLATFORM surface implemented by the Identity service: one
// account spans every tenant, so there is no product slug to namespace it under and its routes
// stay reserved ahead of product slugs in `router.ts`. Only the implementation moved (D-14).
import { handlePortal } from "./services/identity/index.js";
import {
  withoutAccountCookies,
  withoutAccountSetCookies,
} from "./core/accounts/accountCookies.js";
import { handleGithubWebhook } from "./githubWebhook.js";
import { handleDeployHook } from "./platformDeploy.js";
import { ErrorCode, notFound, wireError } from "./core/errors.js";
import { handleDevices, handleReport } from "./core/devices.js";
import { handleRegister } from "./core/register.js";
import {
  handleAttest,
  handleAttestChallenge,
} from "./core/trust/attestation.js";
import { handleAssetsPush } from "./core/assets/hostedAssetUploads.js";
// HA-06: a CI push into a listing-model slot also writes Distribution's listing row; Core takes
// the writer from here rather than importing the service.
import { listingSlotMirror } from "./services/distribution/api.js";
import { dispatchBytesHost, isBytesHost } from "./core/assets/bytesHost.js";
import {
  dispatchRegistryHost,
  isRegistryHost,
} from "./core/registry/registryHost.js";
import { dispatchImgHost, isImgHost } from "./core/assets/imgHost.js";
import {
  drainRenderQueue,
  watchRenderEnqueues,
} from "./core/registry/registryQueue.js";

const PRODUCT_ROUTES = new Set<Route["kind"]>([
  "discovery",
  "jwks",
  "trustManifest",
  "devices",
  "report",
  "register",
  "attestChallenge",
  "attest",
  "assetsPush",
  "service",
]);

/** The slice of the runtime's `ExecutionContext` dispatch uses (P5-02). */
export interface DispatchExecution {
  waitUntil(promise: Promise<unknown>): void;
}

export async function dispatch(
  req: Request,
  env: Env,
  db: Db,
  exec?: DispatchExecution,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  if (!exec) return dispatchWith(req, env, db, now, exec);
  // The package-feed render queue (plans/F-01.md §6.5): a request whose writes enqueued a render
  // (a package publish, yank or channel move; a feed settings write) drains the queue once it has
  // answered, so the feed's documents are re-rendered within the request's `waitUntil`. Every
  // other request costs nothing. The cron drains too (`scheduled.ts`), and the stamp-checked read
  // path covers the moment in between.
  const watched = watchRenderEnqueues(db);
  const res = await dispatchWith(req, env, watched.db, now, exec);
  if (watched.enqueued())
    exec.waitUntil(
      drainRenderQueue(SERVICES, { env, db, now }).catch(() => undefined),
    );
  return res;
}

/**
 * The router seam (P1b-03): `dispatch` with the request clock injected rather than read.
 *
 * Production never calls this directly — `dispatch` reads `Date.now()` exactly as it always did
 * and hands the result here. It exists so the HTTP-transcript scenarios
 * (`test/transcripts/`) can drive the REAL router, product loading, CORS and every service at a
 * pinned instant, which is what makes a recorded conversation byte-stable. A handler that still
 * reads `Date.now()` itself is pinned by the recorder's fake timers instead.
 *
 * It is also the dispatcher's error boundary for a MALFORMED REQUEST. Nothing between
 * `new URL(req.url)` and a handler's first line used to catch anything, so a percent-decode that
 * threw left the Worker as an unhandled rejection. The router no longer throws for the two
 * segments it decodes (`matchRoute` answers `badRequest`), but that does not make this dead
 * code: it covers every OTHER percent-decode on the request path (the bytes, registry and image
 * hosts decode their own segments), and makes the class non-fatal rather than the one known
 * instance impossible.
 *
 * Deliberately narrow. It catches `URIError`, which is what every percent-decode in the runtime
 * throws, and answers 400, because a request that cannot be decoded is a client error no retry
 * would fix. Everything else is rethrown: a D1 outage or a bug in a handler must not be
 * laundered into "bad request", which would send an operator to inspect the caller instead of
 * the outage.
 */
export async function dispatchWith(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  exec?: DispatchExecution,
): Promise<Response> {
  try {
    return await routeRequest(req, env, db, now, exec);
  } catch (e) {
    if (e instanceof URIError) return malformedUrl();
    throw e;
  }
}

/** `dispatchWith` without the boundary: match the host and route, then hand off. */
async function routeRequest(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  exec?: DispatchExecution,
): Promise<Response> {
  const url = new URL(req.url);
  // The bytes host (P2-01) reaches ONLY its byte-route allowlist — never the console, the
  // portal, `/docs` or a product route. With `BLOB_ORIGIN` unset this is always false, and
  // everything below runs exactly as it did before the bytes host existed.
  if (isBytesHost(url, env))
    return dispatchBytesHost(req, env, db, BYTE_ROUTES, SERVICES);
  // The registry host (F-02) reaches ONLY its registry routes, its landing page and OCI's `/v2/`
  // root. With `PKG_ORIGIN` unset (or equal to the bytes host, checked above) this is always
  // false, and routing is exactly what it was before the registry host existed.
  if (isRegistryHost(url, env))
    return dispatchRegistryHost(
      req,
      env,
      db,
      REGISTRY_ROUTES,
      SERVICES,
      exec,
      REGISTRY_OWNERLESS_ROUTES,
    );
  // The image host (HA-02) reaches ONLY the hosted-image routes (`core/assets/imgHost.ts`). With
  // `IMG_ORIGIN` unset (or equal to the bytes or registry host, checked above) this is always
  // false, and routing is exactly what it was before the image host existed.
  if (isImgHost(url, env)) return dispatchImgHost(req, env, db, now, exec);
  const route = matchRoute(url.pathname);
  // The portal is one account across every product, so it has no product to dispatch on; when
  // it reaches a product's downloads it asks for that product's hooks (P2b-04: the delivery
  // access every download surface reads), built here from the composition root's registry under
  // that product's own enablement.
  const hooksFor = (product: ProductPublic, at: number): ServiceHooks =>
    serviceContext("host", SERVICES, product.services, {
      env,
      db,
      product,
      now: at,
    }).hooks;

  if ("product" in route && PRODUCT_ROUTES.has(route.kind)) {
    const product = await loadProduct(env, db, route.product);
    if (!product) return notFound();
    // I-07 (S-16 §5.4 item 7): no product route receives or sets the account realm's cookies.
    // The browser sends the host-only account session to every path on this host; it is removed
    // here, before any product handler runs, and any `Set-Cookie` for it is dropped on the way
    // out (`core/accounts/accountCookies.ts`).
    return withoutAccountSetCookies(
      await dispatchProduct(
        withoutAccountCookies(req),
        env,
        db,
        product,
        route,
        now,
        exec,
      ),
    );
  }

  // Admin + platform routes. These never answer CORS: they share this origin with the admin
  // cookie (THREAT-MODEL R1-09).
  switch (route.kind) {
    case "githubWebhook":
      return handleGithubWebhook(req, env, db, now);
    // F-10 automation: deploy.yml's registration of the platform's own packages.
    case "deployHook":
      return handleDeployHook(req, env, db, now, exec);
    // The gated docs site: session-checked inside the handler (docs.ts), for every path
    // under the prefix — assets and machine-readable artifacts included.
    case "docs":
      return handleDocs(req, env, now);
    case "portalSpa":
    case "portalApi":
    case "portalLogin":
    case "portalProviderSignIn":
    case "portalCallback":
    case "portalLogout":
    case "portalMagicVerify":
    case "portalMedia":
      return handlePortal(req, env, db, url.pathname, {
        hooksFor,
        settings: SETTINGS,
      });
    case "portalDownload":
      return handlePortal(
        req,
        env,
        db,
        `/download/${encodeURIComponent(route.token)}`,
        { hooksFor },
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
    // The router could not PARSE the path, so it never got as far as deciding whether anything
    // lives there: 400, not the `notFound` default below, which would report the result of a
    // lookup that did not happen.
    case "badRequest":
      return malformedUrl();
    default:
      return notFound();
  }
}

/**
 * The one 400 for an unparseable URL, shared by the router's `badRequest` route and the
 * `URIError` boundary in `dispatchWith`, so the two cannot drift into describing the same
 * failure differently. The NESTED wire body: this refusal belongs to the dispatcher, not to a
 * handler that carried a flat body across a service move.
 */
function malformedUrl(): Response {
  return wireError(400, ErrorCode.BadRequest, {
    message: "malformed percent-encoding in the request URL",
  });
}

/** A product route with the account realm's cookies already removed (`dispatchWith`). */
async function dispatchProduct(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  route: Route & { product: string },
  now: number,
  exec?: DispatchExecution,
): Promise<Response> {
  // CORS (P0-05, `core/cors.ts`). Decided from the path SHAPE and the product's own
  // `web.origins`, before any service runs: a preflight is answered here, so its result can
  // never depend on whether the service behind the path is enabled; and the headers are
  // added only after the handler returns, so nothing a handler stores in the edge cache
  // carries one origin's allow header to the next.
  if (!isCorsCoveredRoute(route)) {
    return dispatchProductRoute(req, env, db, product, route, now, exec);
  }
  if (req.method === "OPTIONS") return corsPreflight(product, req);
  return withCors(
    product,
    req,
    await dispatchProductRoute(req, env, db, product, route, now, exec),
  );
}

/**
 * A product-scoped route, once its product has loaded; a 2xx answer to a request that names a
 * known SDK is recorded as a sighting after the response (ST-40, `core/integration/sightings.ts`).
 */
async function dispatchProductRoute(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  route: Route & { product: string },
  now: number,
  exec?: DispatchExecution,
): Promise<Response> {
  const res = await routeProduct(req, env, db, product, route, now, exec);
  if (exec && res.status >= 200 && res.status < 300) {
    const write = recordSighting(
      db,
      product.slug,
      req.headers,
      sightingNamespace(route),
      now,
    );
    if (write) exec.waitUntil(write);
  }
  return res;
}

async function routeProduct(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  route: Route & { product: string },
  now: number,
  exec?: DispatchExecution,
): Promise<Response> {
  // Services first: `dispatchService` checks THIS product's enablement before the
  // descriptor is consulted, so a service a product has not enabled never runs a line of
  // its own code and is indistinguishable from one that does not exist (see
  // `core/registry.ts`). Everything below is a core route — every service is carved.
  if (route.kind === "service") {
    // PX-W17: a person following a sign-in link of an Identity-off product is sent to the
    // friendly card instead of a JSON 404. Core code, before dispatch, so no Identity code runs;
    // every non-navigation caller falls through to `dispatchService`'s `404 not_found`.
    if (route.slug === "identity") {
      const redirect = identityNavigationRedirect(req, product, route.rest);
      if (redirect) return redirect;
    }
    return dispatchService(SERVICES, route.slug, product.services, {
      req,
      env,
      db,
      product,
      rest: route.rest,
      now,
      ...(route.alias ? { alias: true } : {}),
      ...(exec
        ? { waitUntil: (p: Promise<unknown>) => exec.waitUntil(p) }
        : {}),
    });
  }

  switch (route.kind) {
    case "discovery":
      return handleDiscovery(req, env, db, product, SERVICES, now);
    case "devices":
      return handleDevices(req, env, db, product, now, route.deviceId);
    case "report":
      // P6-03: the hooks bound update telemetry to the product's declared outlets and channels.
      return handleReport(
        req,
        env,
        db,
        product,
        now,
        serviceContext("host", SERVICES, product.services, {
          env,
          db,
          product,
          now,
        }).hooks,
      );
    case "register":
      // The registry is threaded through because `requires-identity` registration is
      // authorized by the Identity descriptor (`ServiceDescriptor.authorizeRegistration`);
      // Core asks the registry rather than importing the service.
      return handleRegister(req, env, db, product, now, SERVICES);
    case "attestChallenge":
      return handleAttestChallenge(req, env, db, product, now);
    case "attest":
      // The hooks carry Distribution's store identities (`Delivery.attestationTargets`).
      return handleAttest(
        req,
        env,
        db,
        product,
        now,
        serviceContext("host", SERVICES, product.services, {
          env,
          db,
          product,
          now,
        }).hooks,
      );
    case "assetsPush":
      return handleAssetsPush(
        req,
        env,
        db,
        product.slug,
        now,
        listingSlotMirror,
      );
    case "jwks":
      return handleJwks(db, product);
    case "trustManifest":
      return handleTrustManifest(req, env, db, product, now);
    default:
      return notFound();
  }
}

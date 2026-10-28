/// <reference types="@cloudflare/workers-types" />
/**
 * The core product routes as a table (P0-25b; the service tables' counterpart,
 * `core/http/routes.ts`), and the CORS predicate built from the flags on both.
 *
 * A core route is one of the routes under `/<product>/` that no service owns: discovery, JWKS,
 * the trust manifest, the device routes, report, register, attestation and the hosted-asset
 * push. `router.ts` decides WHICH row a path is (the kind, and `deviceId` for
 * `/devices/<id>`, which it percent-decodes once); this table says what the row is and does:
 *
 *   - `surface` is the OpenAPI templates and lower-case methods `routeCoverage` pins against
 *     the spec, so a route cannot be served and not declared, or declared and not served.
 *   - `cors` is the CORS flag (`core/cors.ts`): the route answers a preflight and decorates its
 *     responses for a page on an origin the product lists. Deny by default; the attestation
 *     routes and the CI asset push stay first-party.
 *   - `auth` names the credential the handler checks, as on the service tables. Declared, not
 *     enforced here: each handler owns its credential's shape.
 *   - `handler` is the dispatch. Handlers keep their own method policy, as they did when this
 *     was a `switch`, so the table adds no refusal and removes none.
 *
 * It lives in the composition layer because the handlers need the service registry (`SERVICES`)
 * and Core never imports a service (`test/boundaries.test.ts`).
 */

import type { Db } from "./db/types.js";
import type { Env } from "./platform/env.js";
import type { Product } from "./core/products.js";
import type { Route } from "./router.js";
import type { RouteAuth } from "./core/http/routes.js";
import { corsCoverage, corsServicePaths } from "./core/cors.js";
import { handleDiscovery } from "./core/discovery.js";
import { handleJwks, handleTrustManifest } from "./core/trust/trust.js";
import { serviceContext } from "./core/registry.js";
import { handleDevices, handleReport } from "./core/devices.js";
import { handleDeviceKeys } from "./core/devices/keysRoute.js";
import { handleKeyring } from "./core/keyring/routes.js";
import { handleRegister } from "./core/register.js";
import {
  handleAttest,
  handleAttestChallenge,
} from "./core/trust/attestation.js";
import { handleAssetsPush } from "./core/assets/hostedAssetUploads.js";
// HA-06: a CI push into a listing-model slot also writes Distribution's listing row; Core takes
// the writer from here rather than importing the service.
import { listingSlotMirror } from "./services/distribution/api.js";
import { SERVICES } from "./mount.js";

/** The route kinds this table covers: the product-scoped ones no service owns. */
export type CoreRouteKind = Exclude<
  Extract<Route, { product: string }>["kind"],
  "service"
>;

/** What a core handler is given. */
export interface CoreRouteCtx {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  /** The matched route (`devices` carries the decoded `deviceId`). */
  route: Route & { product: string };
  now: number;
}

export interface CoreRouteDecl {
  kind: CoreRouteKind;
  /** The spec templates and methods this kind documents. */
  surface: ReadonlyArray<{ path: string; methods: readonly string[] }>;
  /** Browser-readable under the product's `web.origins` (`core/cors.ts`). */
  cors: boolean;
  auth: RouteAuth;
  handler: (c: CoreRouteCtx) => Promise<Response>;
}

/** The descriptor hooks for this product (P6-03 telemetry bounds, the attestation targets). */
function hooksOf(c: CoreRouteCtx) {
  return serviceContext("host", SERVICES, c.product.services, {
    env: c.env,
    db: c.db,
    product: c.product,
    now: c.now,
  }).hooks;
}

export const CORE_ROUTES: readonly CoreRouteDecl[] = [
  {
    kind: "discovery",
    surface: [
      { path: "/{product}/.well-known/polaris.json", methods: ["get"] },
    ],
    cors: true,
    auth: { kind: "none" },
    handler: (c) =>
      handleDiscovery(c.req, c.env, c.db, c.product, SERVICES, c.now),
  },
  {
    kind: "jwks",
    surface: [{ path: "/{product}/.well-known/jwks.json", methods: ["get"] }],
    cors: true,
    auth: { kind: "none" },
    handler: (c) => handleJwks(c.db, c.product),
  },
  {
    kind: "trustManifest",
    surface: [
      { path: "/{product}/.well-known/polaris-trust.jws", methods: ["get"] },
    ],
    cors: true,
    auth: { kind: "none" },
    handler: (c) => handleTrustManifest(c.req, c.env, c.db, c.product, c.now),
  },
  {
    kind: "devices",
    surface: [
      { path: "/{product}/devices", methods: ["get"] },
      {
        path: "/{product}/devices/{deviceId}",
        methods: ["get", "patch", "delete"],
      },
    ],
    cors: true,
    auth: { kind: "device" },
    handler: (c) =>
      handleDevices(
        c.req,
        c.env,
        c.db,
        c.product,
        c.now,
        (c.route as { deviceId?: string }).deviceId,
      ),
  },
  // P6-03: the hooks bound update telemetry to the product's declared outlets and channels.
  {
    kind: "report",
    surface: [{ path: "/{product}/devices/report", methods: ["post"] }],
    cors: true,
    auth: { kind: "device" },
    handler: (c) =>
      handleReport(c.req, c.env, c.db, c.product, c.now, hooksOf(c)),
  },
  // The registry is threaded through because `requires-identity` registration is authorized by
  // the Identity descriptor (`ServiceDescriptor.authorizeRegistration`); Core asks the registry
  // rather than importing the service.
  {
    kind: "register",
    surface: [{ path: "/{product}/devices/register", methods: ["post"] }],
    cors: true,
    auth: { kind: "handler" },
    handler: (c) =>
      handleRegister(c.req, c.env, c.db, c.product, c.now, SERVICES),
  },
  {
    kind: "attestChallenge",
    surface: [
      { path: "/{product}/devices/attest/challenge", methods: ["post"] },
    ],
    cors: false,
    auth: { kind: "device" },
    handler: (c) => handleAttestChallenge(c.req, c.env, c.db, c.product, c.now),
  },
  // The hooks carry Distribution's store identities (`Delivery.attestationTargets`).
  {
    kind: "attest",
    surface: [{ path: "/{product}/devices/attest", methods: ["post"] }],
    cors: false,
    auth: { kind: "device" },
    handler: (c) =>
      handleAttest(c.req, c.env, c.db, c.product, c.now, hooksOf(c)),
  },
  // CC-03.2: a device registers or rotates its keys. Ahead of `/devices/<id>` in the router, so
  // `keys` is never read as a device id. First-party: no CORS flag.
  {
    kind: "deviceKeys",
    surface: [{ path: "/{product}/devices/keys", methods: ["put"] }],
    cors: false,
    auth: { kind: "device" },
    handler: (c) => handleDeviceKeys(c.req, c.env, c.db, c.product, c.now),
  },
  // U-36.2: the Core key ring (WIRE-CONTRACT-V5 §13.11). `404` unless a service needs it for the
  // product (Cloud Sync in end-to-end mode). `rest` is the decoded path after `keyring`.
  {
    kind: "keyring",
    surface: [
      { path: "/{product}/devices/keyring", methods: ["get", "post"] },
      {
        path: "/{product}/devices/keyring/wraps/{deviceId}",
        methods: ["put", "delete"],
      },
      { path: "/{product}/devices/keyring/recovery", methods: ["get", "put"] },
      { path: "/{product}/devices/keyring/adopt", methods: ["post"] },
      { path: "/{product}/devices/keyring/reset", methods: ["post"] },
    ],
    cors: true,
    auth: { kind: "device" },
    handler: (c) =>
      handleKeyring(
        c.req,
        c.env,
        c.db,
        c.product,
        c.now,
        (c.route as { rest?: string[] }).rest ?? [],
      ),
  },
  // HA-06: CI pushes files into hosted-asset slots (`assets:write`, checked by the handler).
  {
    kind: "assetsPush",
    surface: [{ path: "/{product}/assets", methods: ["post"] }],
    cors: false,
    auth: { kind: "handler" },
    handler: (c) =>
      handleAssetsPush(
        c.req,
        c.env,
        c.db,
        c.product.slug,
        c.now,
        listingSlotMirror,
      ),
  },
];

// A kind declared twice would make the second row dead; a row with no surface is undocumented.
for (const [i, r] of CORE_ROUTES.entries()) {
  if (CORE_ROUTES.findIndex((o) => o.kind === r.kind) !== i)
    throw new Error(`core route ${r.kind} is declared twice`);
  if (r.surface.length === 0)
    throw new Error(`core route ${r.kind} has an empty surface`);
}

const CORE_BY_KIND: ReadonlyMap<string, CoreRouteDecl> = new Map(
  CORE_ROUTES.map((r) => [r.kind, r]),
);

/** The table row for a route kind, or `undefined` (the dispatcher answers the not-found). */
export function coreRouteOf(kind: string): CoreRouteDecl | undefined {
  return CORE_BY_KIND.get(kind);
}

/** The route kinds whose rows carry the CORS flag. */
export const CORS_CORE_KINDS: readonly string[] = CORE_ROUTES.filter(
  (r) => r.cors,
).map((r) => r.kind);

/**
 * Does this route answer CORS at all? Decided from the path shape alone: a core route by its
 * row's flag, a service route by the flagged rows of EVERY service's surface, enabled or not.
 */
export const isCorsCoveredRoute = corsCoverage(
  CORS_CORE_KINDS,
  [...SERVICES.values()].flatMap((d) => d.surface),
);

/** The covered service paths, relative to `/<product>/`, in the OpenAPI spelling. */
export const CORS_SERVICE_PATHS: readonly string[] = corsServicePaths(
  [...SERVICES.values()].flatMap((d) => d.surface),
);

/**
 * The service registry — how Core mounts a Polaris service (design spec §5.1, D-02).
 *
 * The worker is a modular monolith, split-ready: one Cloudflare Worker containing an
 * always-on `core/` substrate plus one directory per opt-in service. Adding a service is
 * meant to be exactly two things — a directory and a descriptor — with nothing in Core
 * needing to learn the new service's name.
 *
 * Core owns dispatch, and dispatch is where enablement is enforced. A service that a product
 * has not enabled does not "return an error"; from the outside it does not exist. That is the
 * same hide-don't-reveal posture the rest of the worker already takes for unknown products:
 * an unauthenticated prober must not be able to map which products run which services.
 */

/// <reference types="@cloudflare/workers-types" />

import type { ParsedManifest } from "@plrs/manifest";
import type { Env } from "../env.js";
import type { Product } from "./products.js";
import type { Db, DbStatement } from "../db/types.js";
import type { AdminSession } from "../admin/session.js";
import { ErrorCode, json } from "./errors.js";
import type { ServiceSlug, ServicesMap } from "./services.js";

/** Everything a service handler is given. `rest` is the path AFTER `/<product>/<service>`,
 *  already split — the service owns its own sub-routing from there.
 *
 *  `db` and `now` are handed down rather than re-derived: the tests drive the same handlers
 *  against in-memory SQLite, and a service that opened its own D1 connection could not be
 *  tested; a service that read its own clock could not be given a fixed epoch, which every
 *  document-shape assertion depends on. */
export interface ServiceContext {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  rest: string[];
  /** Epoch seconds for this request — one value for every timestamp it writes or signs. */
  now: number;
  /**
   * True when the request arrived on one of the permanent pre-namespace aliases (§R1,
   * `router.ts`): `/<p>/appcast.xml`, `/<p>/<channel>/appcast.xml`, `/<p>/install.sh`,
   * `/<p>/version`.
   *
   * Present so the route table can be ASSERTED on, not so a handler can branch. The router
   * rewrites an alias into the canonical segments before dispatch, so every handler sees the
   * canonical request and the two spellings are byte-identical by construction. A service that
   * read this flag to change its answer would be re-introducing exactly the divergence the
   * rewrite exists to prevent.
   */
  alias?: boolean;
}

/**
 * What a service is given when Core assembles `/.well-known/polaris.json`.
 *
 * `base` is the product's absolute URL prefix (`https://host/<slug>`), passed in rather than
 * derived: a descriptor has no request to read an origin off, and a document that mixed
 * absolute core URLs with relative service paths would make every consumer implement its own
 * resolution rule. One shape, absolute throughout, decided by the one caller that knows which
 * origin the client actually reached.
 *
 * `db` is here because a fragment reports CAPABILITY, not just routes — whether this product has
 * any edge-mint recipes, which channels Release syncs — and every one of those answers is a row.
 * A descriptor that opened its own connection could not be tested (see `ServiceContext`).
 */
export interface DiscoveryContext {
  product: Product;
  env: Env;
  db: Db;
  base: string;
}

/**
 * One service's contract with Core.
 *
 * `handle` returns `null` — not a 404 — when no route inside the service matched. The
 * distinction matters: only Core knows whether "no match" should be a 404, a fall-through to
 * an alias table, or a redirect, and centralising that decision is what keeps the not-found
 * response byte-identical whether a service is disabled, absent, or simply has no such route.
 */
export interface ServiceDescriptor {
  slug: ServiceSlug;
  /** Handle a product-scoped request. `null` = no route matched inside this service. */
  handle(ctx: ServiceContext): Promise<Response | null>;
  /**
   * This service's fragment of `/.well-known/polaris.json` (design spec §4.3). Only called when
   * enabled — Core emits `{enabled:false}` and nothing else for the rest.
   */
  discoveryFragment(ctx: DiscoveryContext): Promise<Record<string, unknown>>;
  /** Handle `/manage/api/products/<slug>/<service>/…`. `null` = no route matched. */
  adminHandle?(
    ctx: ServiceContext & { session: AdminSession },
  ): Promise<Response | null>;
  /**
   * Rows this service wants written when a product manifest is ingested (link or resync).
   *
   * Returns this repo's `DbStatement`, not `D1PreparedStatement`: every batch site in the
   * worker goes through the `Db` abstraction so the same code runs on D1 and on the in-memory
   * SQLite the tests use. A descriptor that emitted real D1 statements could not be tested and
   * could not be batched with the rest of the ingest.
   */
  manifestIngest?(parsed: ParsedManifest, product: string): DbStatement[];
}

export type ServiceRegistry = Map<ServiceSlug, ServiceDescriptor>;

/**
 * The single not-found answer for the whole service surface.
 *
 * ONE shape for three different causes — service disabled for this product, no descriptor
 * registered for that slug, no route matched inside the service — because telling them apart
 * is precisely the reconnaissance we are refusing to hand out.
 *
 * The body is the wire-v3 nested error shape (`{"error":{"code":…}}`, WIRE-CONTRACT-V3 §5/R4),
 * built on `http.ts`'s `json` helper. It deliberately does NOT use `errorResponse`, which
 * still emits the flat v2 shape (`{"error":"not_found"}`) that the not-yet-migrated routes
 * answer with; those two shapes co-exist until the route move completes.
 */
function serviceNotFound(): Response {
  return json({ error: { code: ErrorCode.NotFound } }, { status: 404 });
}

/**
 * Dispatch a product-scoped request to a service, honouring that product's enablement set.
 *
 * Enablement is checked BEFORE the descriptor is consulted, so a disabled service's code never
 * runs — it cannot read a row, write an audit entry, consume a rate-limit token, or make a
 * timing difference that distinguishes "off" from "absent".
 */
export async function dispatchService(
  registry: ServiceRegistry,
  slug: ServiceSlug,
  services: ServicesMap,
  ctx: ServiceContext,
): Promise<Response> {
  if (!services[slug]?.enabled) return serviceNotFound();
  const descriptor = registry.get(slug);
  if (!descriptor) return serviceNotFound();
  const res = await descriptor.handle(ctx);
  return res ?? serviceNotFound();
}

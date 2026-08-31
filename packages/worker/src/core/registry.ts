/**
 * The service registry — how Core mounts a Polaris Key service (design spec §5.1, D-02).
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

import type { ParsedManifest } from "@polaris-key/manifest";
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
 * What a service is asked when Core is deciding whether to mint a device credential.
 *
 * Deliberately NOT a `ServiceContext`: there is no route here and no `rest` to route, and
 * handing a service the shape it answers requests with would invite it to answer this one with
 * a `Response`. The contract is a predicate — everything about what a refusal looks like
 * (status, body, whether the reason is disclosed) stays Core's (`core/register.ts`).
 */
export interface RegistrationAuthContext {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  /** Epoch seconds for this request — the same value Core will stamp on the binding. */
  now: number;
}

/**
 * One canonical route a service serves, as DATA (B7-09).
 *
 * `path` is the OpenAPI-style template the spec documents it under —
 * `/{product}/license/activate`, `/{product}/config/mint/{mintId}/token` — so the drift gate
 * compares like with like instead of transcribing one shape into another.
 *
 * ── WHY THE DESCRIPTOR AND NOT THE TEST ─────────────────────────────────────────────────────
 *
 * `test/routeCoverage.test.ts` used to carry this list as a hand-written literal, which made the
 * gate answerable in the wrong direction: a service could grow a route in its `routes.ts`, nobody
 * would document it, and the test would stay green because the only thing it compared was one
 * copy of the spec against another copy of the spec. Moving the list here does not make it
 * self-derived — `routes.ts` is imperative and there is nothing to reflect over — but it does two
 * things a test-side literal cannot: it sits in the same directory as the router it describes, so
 * a route added without a surface entry is a diff a reviewer sees in one file; and it is
 * EXECUTABLE, so `routeCoverage` can instantiate every declared path and assert the core router
 * actually dispatches it to this slug. A declared path the router cannot reach now fails.
 */
export interface ServiceRoute {
  /** The OpenAPI path template, product placeholder included. */
  path: string;
  /** Lower-case HTTP methods this route answers. */
  methods: readonly string[];
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
   * The canonical routes this service serves, as spec path templates (B7-09). The permanent
   * pre-namespace aliases are NOT listed: they are the router's rewrites, not a service's
   * surface, and `routeCoverage` pins them separately.
   */
  surface: readonly ServiceRoute[];
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
  /**
   * May this caller be given a device credential? (wire v3 §6, spec §2.3.)
   *
   * The one place Core delegates an AUTHORIZATION decision to a service, and it exists because
   * one of the three registration policies is named after a service: `requires-identity` means
   * "register, but only behind a product login", and only Identity knows what a product login
   * looks like. `core/register.ts` may not import a service, so the substrate declares the
   * predicate and asks the registry for it.
   *
   * Implement it to say YES to something. A descriptor that omits it is one Core can never
   * satisfy a policy with, which is the correct default: an unimplemented hook must not read as
   * an open door.
   */
  authorizeRegistration?(ctx: RegistrationAuthContext): Promise<boolean>;
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

/**
 * Ask a service whether this caller may be given a device credential.
 *
 * Fails CLOSED at every step, and the enablement check leads for the same reason it leads in
 * `dispatchService`: a product whose `services_json` says the service is off must not have that
 * service's code run, even to say no.
 *
 * `validateServices` refuses the `requires-identity` + identity-disabled combination
 * (`registration_requires_identity`), and since A4-04 it does so on ALL THREE writers of
 * `products.services_json` — `linkRepo` and `resyncRepo` reach it through
 * `serializeValidatedServices` now, where they once called `serializeServices` directly and a
 * repo-authored `devices.registration: requires-identity` on an identity-disabled product
 * became live state unexamined.
 *
 * Keep this check anyway. It is no longer the ONLY thing standing between that manifest and a
 * minted device token, but rows written before A4-04 were never re-validated, and a stored
 * column is not re-checked on read. Defence at the point of USE does not expire when defence at
 * the point of WRITE arrives; do not remove it on the grounds that validation "already"
 * happened somewhere upstream.
 */
export async function authorizeRegistration(
  registry: ServiceRegistry,
  slug: ServiceSlug,
  services: ServicesMap,
  ctx: RegistrationAuthContext,
): Promise<boolean> {
  if (!services[slug]?.enabled) return false;
  const descriptor = registry.get(slug);
  if (!descriptor?.authorizeRegistration) return false;
  return descriptor.authorizeRegistration(ctx);
}

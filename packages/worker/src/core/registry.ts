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
import {
  SERVICE_SLUGS,
  type ServiceSlug,
  type ServicesMap,
} from "./services.js";
import {
  buildHooks,
  type DescriptorHooks,
  type ServiceHooks,
} from "./hooks.js";

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
  /**
   * Read-only access to the other services' state (`core/hooks.ts`), built by Core from the
   * registry and THIS product's enablement. An accessor returns `null` when its providing service
   * is off. Never constructed by a caller: `dispatchService` and the admin API build it.
   */
  hooks: ServiceHooks;
  /**
   * Core's manifest-ingest pipeline, bound to the registry (P2b-02): the statements every enabled
   * service's `manifestIngest` contributes to an ingest batch. Handed to the one service that
   * runs an ingest (Release's resync, behind its admin route) so it can put them in ITS batch
   * without ever seeing — or importing — the services that answer. Built by Core like `hooks`.
   */
  ingest: ManifestIngest;
}

/** A `ServiceContext` as a caller hands it to Core — everything but the Core-built `hooks` and
 *  `ingest`. */
export type ServiceRequest = Omit<ServiceContext, "hooks" | "ingest">;

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
  /** The same read-only hooks a request gets (`core/hooks.ts`), gated on this product. */
  hooks: ServiceHooks;
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
 * One service's contract with Core.
 *
 * `handle` returns `null` — not a 404 — when no route inside the service matched. The
 * distinction matters: only Core knows whether "no match" should be a 404, a fall-through to
 * an alias table, or a redirect, and centralising that decision is what keeps the not-found
 * response byte-identical whether a service is disabled, absent, or simply has no such route.
 */
export interface ServiceDescriptor extends DescriptorHooks {
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
   *
   * Run by Core (`manifestIngestStatements`) for ENABLED services only, inside the link or
   * resync batch; `now` is that ingest's epoch. Statements only, so a hook cannot read: write
   * it as an idempotent upsert, and never touch a column an operator owns.
   */
  manifestIngest?(
    parsed: ParsedManifest,
    product: string,
    now: number,
  ): DbStatement[];
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
  // The descriptor hooks — `releaseCatalog?`, `delivery?`, `outletCapabilities?` — come from
  // `DescriptorHooks` (`core/hooks.ts`): read-only views one service offers the others, through
  // Core, under the same fail-closed enablement gate as `authorizeRegistration`.
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
  ctx: ServiceRequest,
): Promise<Response> {
  if (!services[slug]?.enabled) return serviceNotFound();
  const descriptor = registry.get(slug);
  if (!descriptor) return serviceNotFound();
  const res = await descriptor.handle({
    ...ctx,
    ingest: manifestIngestFor(registry),
    hooks: buildHooks(registry, services, {
      env: ctx.env,
      db: ctx.db,
      product: ctx.product,
      now: ctx.now,
    }),
  });
  return res ?? serviceNotFound();
}

/**
 * Ask a service whether this caller may be given a device credential.
 *
 * Fails CLOSED at every step, and the enablement check leads for the same reason it leads in
 * `dispatchService`: a product whose `services_json` says the service is off must not have that
 * service's code run, even to say no.
 *
 * `validateServices` refuses the `requires-identity` + identity-disabled combination on the
 * ADMIN path (`registration_requires_identity`, via `servicesAdmin.ts`) — and ONLY there.
 * Manifest ingest does not call it: `linkRepo`/`resync` go straight to `serializeServices`.
 * So this check is not a redundant second opinion, it is the only thing standing between a
 * repo-authored `devices.registration: requires-identity` on an identity-disabled product and
 * a minted device token. Do not remove it on the grounds that validation "already" happened.
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

/**
 * Core's manifest-ingest pipeline (P2b-02): what a link or resync hands every service.
 *
 * `services` is the enablement the ingest has just settled on — for a link, the manifest's own
 * set; for a resync, the product's stored set AFTER the manifest's write, so an operator who
 * turned a service off live keeps its ingest from running even though the manifest says on.
 */
export type ManifestIngest = (
  parsed: ParsedManifest,
  product: string,
  services: ServicesMap,
  now: number,
) => ManifestIngestResult;

/** What the ingest pipeline produced: the statements, and which services contributed any. */
export interface ManifestIngestResult {
  /** The services whose hook returned at least one statement, in canonical order. */
  slugs: ServiceSlug[];
  statements: DbStatement[];
}

/**
 * Every ENABLED service's `manifestIngest` statements, in canonical `SERVICE_SLUGS` order (so a
 * batch is the same whatever order `mount.ts` registers in). A disabled service's hook never
 * runs — the same fail-closed rule as `dispatchService` and the descriptor hooks — and a service
 * that implements none contributes nothing. Statements only: the caller puts them in its own
 * batch, so the service rows land atomically with the rest of the ingest.
 *
 * This is the registry comment's promised pattern, made real. Release keeps its own ingest
 * (`services/release/{linkRepo,resync}.ts`) as it is; it runs this beside it, and so never
 * imports the services that answer (AGENTS rule 6).
 */
export function manifestIngestStatements(
  registry: ServiceRegistry,
  parsed: ParsedManifest,
  product: string,
  services: ServicesMap,
  now: number,
): ManifestIngestResult {
  const out: ManifestIngestResult = { slugs: [], statements: [] };
  for (const slug of SERVICE_SLUGS) {
    if (!services[slug]?.enabled) continue;
    const ingest = registry.get(slug)?.manifestIngest;
    if (!ingest) continue;
    const statements = ingest(parsed, product, now);
    if (statements.length === 0) continue;
    out.slugs.push(slug);
    out.statements.push(...statements);
  }
  return out;
}

/** {@link manifestIngestStatements}, bound to one registry: what the composition root hands an
 *  ingest path (the webhook, the admin link and resync routes). */
export function manifestIngestFor(registry: ServiceRegistry): ManifestIngest {
  return (parsed, product, services, now) =>
    manifestIngestStatements(registry, parsed, product, services, now);
}

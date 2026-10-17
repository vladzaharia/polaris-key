/**
 * Descriptor contributions (P0-19, CQW-05): how a service hands Core what it used to register
 * as a side effect of being imported.
 *
 * Before this file three module-load registries filled themselves when a service module was
 * loaded (`registerSubjectStore`, `registerLicenseHolderHooks`, `registerAuthorizationListener`),
 * and `scheduled.ts` imported a dozen service internals to run their retention. Each of those is
 * now a member of `ServiceDescriptor.contributes`, so mounting a service is the only act that
 * wires it, and a service that is not mounted contributes nothing:
 *
 *   subjectStores     account × product data (merge, delete, export, size); Core runs every
 *                     mounted service's stores WHATEVER the product's enablement, like
 *                     `licenseMerge`: an erasure that skipped a store because its service was
 *                     switched off would leave the subject's data behind.
 *   licenseHolders    Identity's two licence-to-account association directions.
 *   onAuthorization   listeners told that a device first holds a seat on a licence; gated by the
 *                     product's enablement of the contributing service.
 *   maintenance       the service's retention and reconciliation steps; `scheduled.ts` iterates
 *                     descriptors instead of importing them.
 *   integration       the service's console prerequisites and domain facts for one product
 *                     (consumed by ST-40).
 *
 * Core's own subject store (`core.entitlementEvents`) is added by `subjectHooks.ts`, because Core
 * is not a service.
 *
 * Core answers from the registry the composition root binds once (`bindServiceRegistry`, called
 * by `mount.ts`): the lower-level callers (an account merge, an activation) hold a database and
 * no registry, and threading one through every signature would be a larger change than the
 * single binding it replaces.
 */

/// <reference types="@cloudflare/workers-types" />

import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../platform/env.js";
import type { MigrationJob } from "./migrate/job.js";
import type { AuthorizationListener } from "./authorizationListeners.js";
import type { SubjectStore } from "./accounts/subjectHooks.js";
import type { LicenseHolderHooks } from "./licensing/licenseHolders.js";
import type { ProductPublic } from "./products.js";
import type { ServiceHooks } from "./hooks.js";
import type { ServiceRegistry } from "./registry.js";
import {
  SERVICE_SLUGS,
  type ServiceSlug,
  type ServicesMap,
} from "./services.js";

// ── maintenance ─────────────────────────────────────────────────────────────────────────────

/** Records one step's outcome in the tick's report (`scheduled.ts` implements it). */
export interface MaintenanceRecorder {
  /** Run a bounded step and record its row count, or its failure. Never throws. */
  step(name: string, run: () => Promise<number>): Promise<void>;
  /** `step` over a delete loop: `pass(limit)` runs until it comes back short or the batch budget ends. */
  drain(name: string, pass: (limit: number) => Promise<number>): Promise<void>;
  /** Record a failure that is not a step's own (a lookup that feeds the steps). */
  fail(name: string, error: unknown): void;
}

/** What a service's per-product steps are given. */
export interface ProductMaintenanceContext {
  db: Db;
  env?: Env;
  now: number;
  /** The audit retention cutoff (epoch seconds): rows older than this are past retention. */
  cutoff: number;
  product: string;
}

/** What a service's platform steps are given. */
export interface PlatformMaintenanceContext {
  db: Db;
  env?: Env;
  now: number;
  cutoff: number;
  /** True for the nightly sweep, false for the connector-poll tick. */
  nightly: boolean;
}

export type ProductMaintenance = (
  ctx: ProductMaintenanceContext,
  rec: MaintenanceRecorder,
) => Promise<void>;

export type PlatformMaintenance = (
  ctx: PlatformMaintenanceContext,
  rec: MaintenanceRecorder,
) => Promise<void>;

/**
 * A service's scheduled work. Every member is optional; each runs for every mounted service
 * WHATEVER the product enablement (retention must also reach a switched-off service's rows).
 * Services run in canonical slug order inside each slot.
 */
export interface MaintenanceContribution {
  /** In the nightly product loop, once per swept product (after Core's own product steps). */
  product?: ProductMaintenance;
  /** Nightly, before Core's licensing catch-up (the erasure machinery must precede it). */
  early?: PlatformMaintenance;
  /** Nightly, after Core's catch-up steps and before the blob collector. */
  late?: PlatformMaintenance;
  /**
   * Every connector-poll tick (15 min), failures held back for the nightly report: work that
   * must not wait a day (the erasure sweeps). Run with `nightly: false`.
   */
  frequent?: PlatformMaintenance;
  /** Every tick of either cron, in the registry report (the package-feed housekeeping). */
  registry?: PlatformMaintenance;
}

// ── integration ─────────────────────────────────────────────────────────────────────────────

/** What a service's integration contributor is given: one product, outside any request. */
export interface IntegrationContext {
  env: Env;
  db: Db;
  product: ProductPublic;
  now: number;
  hooks: ServiceHooks;
}

/** One thing the product needs before this service does anything useful. */
export interface IntegrationPrerequisite {
  /** Stable id (`tiers`, `catalog`, `release`), the console keys its step list by it. */
  id: string;
  met: boolean;
}

/** A domain fact about this service's use by the product. Values are plain data. */
export type IntegrationFact = number | boolean | string | null;

/** A service's answer: its prerequisites and the facts the console's Integration page shows. */
export interface IntegrationContribution {
  prerequisites: IntegrationPrerequisite[];
  facts: Record<string, IntegrationFact>;
}

export type IntegrationContributor = (
  ctx: IntegrationContext,
) => Promise<IntegrationContribution>;

// ── the descriptor member ───────────────────────────────────────────────────────────────────

/**
 * The statements erasing this service's rows for a deleted product (`deleteProduct`'s batch). Run
 * for every mounted service WHATEVER its enablement: a service switched off still holds the
 * product's rows, and a deleted product keeps the shape of its licences, not the people.
 * Statements only, idempotent, touching this service's own tables.
 */
export type ProductDeletionContributor = (
  product: string,
  now: number,
) => DbStatement[];

export interface ServiceContributions {
  productDeletion?: ProductDeletionContributor;
  integration?: IntegrationContributor;
  maintenance?: MaintenanceContribution;
  /**
   * Data-migration jobs (P0-49): run only by an operator's request through the runner
   * (`core/migrate/runner.ts`), never by a deploy or a tick. Ids are unique across services.
   */
  migrations?: readonly MigrationJob[];
  /** Stores of account × product data, by their stable registry name. */
  subjectStores?: Readonly<Record<string, SubjectStore>>;
  licenseHolders?: LicenseHolderHooks;
  /** New-authorization listeners, by their stable name. */
  onAuthorization?: Readonly<Record<string, AuthorizationListener>>;
}

// ── the bound registry ──────────────────────────────────────────────────────────────────────

let BOUND: ServiceRegistry | null = null;

/** The composition root binds its service table once (`mount.ts`). Binding twice replaces it. */
export function bindServiceRegistry(registry: ServiceRegistry): void {
  BOUND = registry;
}

/** The bound registry, or an empty one before `mount.ts` has run. */
function bound(): ServiceRegistry {
  return BOUND ?? new Map();
}

/** Every mounted service's contributions in canonical slug order. */
export function contributionsOf(
  registry: ServiceRegistry = bound(),
): Array<[ServiceSlug, ServiceContributions]> {
  const out: Array<[ServiceSlug, ServiceContributions]> = [];
  for (const slug of SERVICE_SLUGS) {
    const contributes = registry.get(slug)?.contributes;
    if (contributes) out.push([slug, contributes]);
  }
  return out;
}

/** Every service-contributed subject store by name. A name claimed twice throws. */
export function contributedSubjectStores(): Array<[string, SubjectStore]> {
  const out = new Map<string, SubjectStore>();
  for (const [slug, c] of contributionsOf())
    for (const [name, store] of Object.entries(c.subjectStores ?? {})) {
      if (out.has(name))
        throw new Error(`subject store "${name}" is claimed twice (${slug})`);
      out.set(name, store);
    }
  return [...out];
}

/** Identity's association hooks, or `null` while no mounted service contributes them. */
export function contributedLicenseHolders(): LicenseHolderHooks | null {
  for (const [, c] of contributionsOf())
    if (c.licenseHolders) return c.licenseHolders;
  return null;
}

/**
 * The new-authorization listeners that apply to one product: a contributing service's listeners
 * run only while that service is enabled for it.
 */
export function contributedAuthorizationListeners(
  services: ServicesMap,
): AuthorizationListener[] {
  const out: AuthorizationListener[] = [];
  for (const [slug, c] of contributionsOf()) {
    if (!services[slug]?.enabled) continue;
    for (const listener of Object.values(c.onAuthorization ?? {}))
      out.push(listener);
  }
  return out;
}

/**
 * Every mounted service's product-deletion statements. Fails CLOSED: before `mount.ts` has bound
 * the registry it throws, because silently skipping them would delete a product and leave its
 * people's rows behind.
 */
export function productDeletionStatements(
  product: string,
  now: number,
): DbStatement[] {
  if (!BOUND)
    throw new Error(
      "deleteProduct needs the service registry bound (core/contributions.ts bindServiceRegistry)",
    );
  return contributionsOf().flatMap(([, c]) =>
    c.productDeletion ? c.productDeletion(product, now) : [],
  );
}

/** The services' maintenance contributions in canonical order. */
export function maintenanceContributions(): MaintenanceContribution[] {
  return contributionsOf().flatMap(([, c]) =>
    c.maintenance ? [c.maintenance] : [],
  );
}

/** Every mounted service's data-migration jobs. An id claimed twice throws. */
export function migrationJobs(): MigrationJob[] {
  const out = new Map<string, MigrationJob>();
  for (const [slug, c] of contributionsOf())
    for (const job of c.migrations ?? []) {
      if (out.has(job.id))
        throw new Error(`migration job "${job.id}" is claimed twice (${slug})`);
      out.set(job.id, job);
    }
  return [...out.values()];
}

/**
 * Ask every ENABLED service for its integration contribution (ST-40's input). A service that
 * is off for the product is absent from the answer, like its discovery fragment; one that
 * throws is reported as `null` rather than failing the others.
 */
export async function integrationContributions(
  registry: ServiceRegistry,
  services: ServicesMap,
  ctx: Omit<IntegrationContext, "hooks">,
  hooks: ServiceHooks,
): Promise<Partial<Record<ServiceSlug, IntegrationContribution | null>>> {
  const out: Partial<Record<ServiceSlug, IntegrationContribution | null>> = {};
  for (const [slug, c] of contributionsOf(registry)) {
    if (!services[slug]?.enabled || !c.integration) continue;
    try {
      out[slug] = await c.integration({ ...ctx, hooks });
    } catch {
      out[slug] = null;
    }
  }
  return out;
}

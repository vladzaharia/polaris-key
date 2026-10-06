/// <reference types="@cloudflare/workers-types" />

// Scheduled maintenance — the worker's only non-request execution path.
//
// R11-09 / R12-10 filed this as a hole with three consequences, all of which were true because
// `index.ts` exported `fetch` and nothing else: `audit`, `portal_audit` and
// `release_download_tokens` had no deleter of any kind and grew for the lifetime of the
// deployment; dormant device seats were only ever reclaimed as a side effect of somebody trying
// to activate a new one; and the indexes the security invariants rest on were asserted by no
// running code, so a half-applied migration was invisible until the invariant it enforced was
// needed. Every helper those jobs need already existed — `idx_audit_time`, `idx_portal_audit_at`,
// `purgeExpiredDownloadTokens`, `releaseDormantSeats` — waiting for a caller. This is the caller.
//
// THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR
//
// 1. PRODUCT-SCOPED. Every delete names one product (or, for the platform-level `portal_audit`
//    rows that name no product, `product IS NULL` explicitly). The sweep never issues a
//    statement whose blast radius is "the table". The shared tables are named exceptions:
//    `platform_audit` (A-12), `platform_job_runs` and `platform_heartbeats` (A-14) have no
//    product column at all, so their passes are by age alone, bounded per pass like every other
//    prune; and `blob_objects` (P4-14's collector) belongs to no
//    product: its sweep deletes only rows that NO product references
//    (the `NOT EXISTS` on `blob_refs` is in every statement), bounded per tick. `account_avatars`
//    (PX-W16) belongs to an account, not a product: its sweep deletes only assets nothing uses
//    (the two `NOT EXISTS` are in the statement), bounded per tick.
// 2. IDEMPOTENT. Every step is a delete-what-is-already-past or a null-what-is-already-dormant,
//    so a second run on the same clock removes nothing and changes nothing. Cron delivery is
//    at-least-once; a duplicate tick must be a no-op, not a double-punishment.
// 3. FAULT-ISOLATED. Steps run through `step()`, which catches. One product's failure must not
//    cost every later product its retention pass — that is how a single poisoned row turns into
//    a table that is never pruned again. Failures are collected and re-thrown as one aggregate
//    at the very end, so the invocation is still recorded as failed.

import { purgeRegistryTokens } from "./core/registryTokens.js";
import { pruneCiCredentials } from "./core/publisher.js";
import { loadProductPublic } from "./core/products.js";
import { runScheduledServices } from "./core/registry.js";
import { drainRenderQueue, selfCheckRenders } from "./core/registryQueue.js";
import { SERVICES } from "./mount.js";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { D1Db } from "./db/d1.js";
import {
  listAllProductSlugs,
  listProducts,
  pruneAudit,
  prunePlatformAudit,
  releaseDormantSeats,
} from "./repo.js";
import {
  prunePortalAudit,
  purgeDownloadTokensForProduct,
} from "./services/identity/portal/repo.js";
import {
  catchUpLegacyAccounts,
  settleOwnershipConflicts,
} from "./services/identity/accounts/legacy.js";
import { sweepAvatars } from "./services/identity/card/avatars.js";
import { pruneStorefrontSeen } from "./services/identity/portal/store/analytics.js";
import { pruneEvents as pruneConnectorEvents } from "./services/distribution/connectors/state.js";
import { REFUSAL_RETENTION_SECONDS, pruneRefusals } from "./core/refusals.js";
import { lazyDeltaProducts } from "./core/deltaDemand.js";
import { refreshPlatformSettings } from "./core/platformSettings.js";
import { sweepLazyDeltas } from "./services/release/packs/deltas/sweep.js";
import { buildHooks } from "./core/hooks.js";
import { recheckHostedAssets } from "./core/hostedAssetPulls.js";
import {
  JOB_RUN_RETENTION_SECONDS,
  pruneHeartbeats,
  pruneJobRuns,
  recordJobRun,
  writeHeartbeat,
  type JobName,
  type StepTiming,
} from "./core/platformOps.js";
import {
  GC_INDEX_READS_PER_TICK,
  applyProductGc,
  effectiveBlobGcSettings,
  markUnreferenced,
  planProductGc,
  pruneGcLog,
  sweepObjects,
} from "./core/blobGc.js";

/**
 * How long an audit record is kept before the sweep deletes it.
 *
 * 180 days. The number is a balance between two real obligations rather than a round figure:
 * an audit log is the evidence for "who disabled that license / retired that signing key", and
 * incidents are routinely discovered a quarter or two after the fact, so anything under ~90 days
 * makes the log useless for the investigations it exists to serve. In the other direction every
 * `audit` row carries `actor_email` and `actor_name`, and `portal_audit` rows carry an account
 * id — indefinite retention of personal data with no stated period is precisely what R11-09
 * describes as unimplementable erasure. Six months keeps two full quarters of forensics and puts
 * a bound on the personal data.
 *
 * It is a constant here, and not per-product configuration, because a per-tenant retention knob
 * is a promise about deletion that needs its own admin surface, its own audit trail and its own
 * migration. Raising or lowering this is a one-line change plus a deploy.
 */
export const AUDIT_RETENTION_SECONDS = 180 * 24 * 60 * 60;

/**
 * Rows deleted per statement, and how many statements a single step may issue.
 *
 * D1 has no statement timeout the worker can rely on and the cron invocation has a wall clock, so
 * an unbounded `DELETE ... WHERE at < ?` against a table with a years-long backlog is a statement
 * that either times out or blocks. Each pass deletes at most `PRUNE_BATCH_ROWS`, and a step stops
 * either when a pass comes back short (nothing left) or after `PRUNE_MAX_BATCHES` passes. A
 * backlog therefore drains over consecutive nights and the steady state — one day of rows —
 * finishes in a single pass.
 */
export const PRUNE_BATCH_ROWS = 500;
export const PRUNE_MAX_BATCHES = 20;

/**
 * The indexes the code's correctness depends on, re-checked on every tick.
 *
 * R11-04: seven of the eleven original migrations fail on replay with `duplicate column name`,
 * and SQLite offers neither `ADD COLUMN IF NOT EXISTS` nor conditional DDL, so replay-idempotency
 * is not reachable in pure SQL. The recommendation was a deploy-time assertion instead — which
 * `migrations/0018_index_assertion.sql` is (succeeded by 0027_i; the deploy re-runs the newest),
 * aborting the migration on a short count. This is its runtime twin, and it catches what a
 * migration-time check structurally cannot: an index dropped after deploy, by hand, from the D1
 * dashboard.
 *
 * Every name is an invariant whose absence is silent. `idx_licenses_enroll_hwid` is
 * one-free-licence-per-machine; `idx_devices_seat` is the UNIQUE arbiter that makes
 * `claimDeviceSeat` atomic instead of check-then-act; `idx_product_keys_one_active` is one active
 * signing key per product; `idx_release_download_tokens_hash` is what makes a download token
 * globally unambiguous; `idx_release_metadata_seq` (P2-03) is "two releases of one deliverable never
 * share a seq", the position the signed release record carries. Without them nothing errors — the
 * constraint simply stops being enforced.
 *
 * A test asserts this list and the newest `migrations/*_index_assertion.sql` (0018, then its
 * successors — 0035_b today) are the same set, so the two cannot drift apart.
 */
export const REQUIRED_INDEXES: readonly string[] = [
  "idx_audit_time",
  "idx_ci_tokens_jti",
  "idx_devices_license_status",
  "idx_devices_seat",
  "idx_licenses_email_lower",
  "idx_licenses_enroll_hwid",
  "idx_licenses_origin",
  "idx_licenses_sub",
  "idx_licenses_sub_global",
  "idx_portal_account_emails_account",
  "idx_portal_account_identities_account",
  "idx_portal_audit_at",
  "idx_portal_audit_product_at",
  "idx_portal_license_links_license",
  "idx_product_keys_one_active",
  "idx_product_keys_verify",
  "idx_release_download_tokens_expiry",
  "idx_release_download_tokens_hash",
  "idx_release_metadata_seq",
];

/** Which of `REQUIRED_INDEXES` are absent from the live schema. */
export async function missingRequiredIndexes(db: Db): Promise<string[]> {
  const placeholders = REQUIRED_INDEXES.map(() => "?").join(", ");
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (${placeholders})`,
    ...REQUIRED_INDEXES,
  );
  const present = new Set(rows.map((r) => r.name));
  return REQUIRED_INDEXES.filter((name) => !present.has(name));
}

/** Throw — loudly, naming every absentee — unless every required index exists. */
export async function assertRequiredIndexes(db: Db): Promise<void> {
  const missing = await missingRequiredIndexes(db);
  if (missing.length > 0) {
    throw new Error(
      `schema is missing ${missing.length} required index(es): ${missing.join(", ")} — ` +
        "re-apply migrations; see the newest migrations/*_index_assertion.sql",
    );
  }
}

export interface MaintenanceReport {
  /** Rows affected, per step name. Absent means the step failed before touching anything. */
  counts: Record<string, number>;
  /** Step name -> message, for every step that threw. */
  failures: Record<string, string>;
  /**
   * Step name -> when it started (epoch ms) and how long it ran, for every step `step()` ran
   * (A-14: persisted into `platform_job_runs` by `handleScheduled`). Optional, so a hand-built
   * report stays valid.
   */
  timings?: Record<string, StepTiming>;
}

/**
 * Run one bounded step, recording either its row count or its failure.
 *
 * The catch is the point of the function, so it is deliberately total: a step that throws is
 * recorded and the sweep continues with the next one. Nothing is rethrown here — see
 * `runScheduledMaintenance`, which raises one aggregate after every step has had its turn.
 */
async function step(
  report: MaintenanceReport,
  name: string,
  run: () => Promise<number>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    report.counts[name] = await run();
  } catch (e) {
    report.failures[name] = e instanceof Error ? e.message : String(e);
  }
  (report.timings ??= {})[name] = {
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Delete in bounded passes until a pass comes back short or the batch budget runs out.
 *
 * The short-pass exit is what makes this idempotent-and-cheap in the steady state: once the
 * table holds nothing older than the cutoff, the first pass deletes 0 and the loop ends, so a
 * duplicate cron delivery costs exactly one statement.
 */
async function drain(
  pass: (limit: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    const removed = await pass(PRUNE_BATCH_ROWS);
    total += removed;
    if (removed < PRUNE_BATCH_ROWS) break;
  }
  return total;
}

/**
 * The blob collector's nightly pass (P4-14, `core/blobGc.ts`), after the retention steps:
 *
 *   1. per LIVE product, fault-isolated (`blobRefs:<slug>`): drop the refs no live release needs,
 *      deciding liveness through that product's own hooks (so a product with Release off, or a
 *      soft-deleted one, keeps every ref — fail closed). Product-scoped: every ref statement names
 *      the product. The order rotates daily so the shared index-read budget reaches every product;
 *   2. `blobMark`: stamp objects no product references, clear the stamp of re-referenced ones;
 *   3. `blobSweep`: delete what has been unreferenced for the grace period and is older than the
 *      bucket lock (one R2 call per tick, at most 1,000 keys), claiming each first;
 *   4. `blobGcLog`: prune the collector's log past the audit retention.
 *
 * Skipped entirely without the BLOBS binding or with `BLOB_GC_MODE=off`. Idempotent: a second run
 * on the same clock drops, stamps and deletes nothing new. Exported for the tests.
 */
export async function runBlobGc(
  report: MaintenanceReport,
  env: Env,
  db: Db,
  now: number,
): Promise<void> {
  if (!env.BLOBS) return;
  const settings = await effectiveBlobGcSettings(env, db);
  if (!settings.enabled) return;
  let slugs: string[] = [];
  try {
    slugs = (await listProducts(db)).map((p) => p.slug).sort();
  } catch (e) {
    report.failures["blobRefs:products"] =
      e instanceof Error ? e.message : String(e);
  }
  const budget = { indexReads: GC_INDEX_READS_PER_TICK };
  const start = slugs.length > 0 ? Math.floor(now / 86400) % slugs.length : 0;
  for (const slug of [...slugs.slice(start), ...slugs.slice(0, start)]) {
    await step(report, `blobRefs:${slug}`, async () => {
      const product = await loadProductPublic(db, slug);
      if (!product) return 0;
      const hooks = buildHooks(SERVICES, product.services, {
        env,
        db,
        product,
        now,
      });
      const plan = await planProductGc({
        db,
        product: slug,
        hooks,
        now,
        settings,
        budget,
      });
      return applyProductGc(db, plan, now, settings);
    });
  }
  await step(report, "blobMark", () => markUnreferenced(db, now));
  const bucket = env.BLOBS;
  await step(
    report,
    "blobSweep",
    async () => (await sweepObjects(db, bucket, now, settings)).deleted,
  );
  await step(report, "blobGcLog", () =>
    drain((limit) => pruneGcLog(db, now - AUDIT_RETENTION_SECONDS, limit)),
  );
}

/**
 * The whole nightly sweep. Exported separately from the handler so it is directly testable
 * against the in-memory SQLite harness, with an injected clock. With `env`, the blob collector
 * runs after the retention steps (`runBlobGc`).
 */
export async function runScheduledMaintenance(
  db: Db,
  now: number,
  env?: Env,
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { counts: {}, failures: {} };
  const cutoff = now - AUDIT_RETENTION_SECONDS;

  // First, because it is the one step whose failure means the OTHER steps' assumptions may not
  // hold — and because a cron tick is the only recurring execution this worker has, it is also
  // the only place a post-deploy schema regression can be noticed at all. It is still a `step()`,
  // so a missing index reports itself without costing the sweep its retention pass.
  await step(report, "indexes", async () => {
    await assertRequiredIndexes(db);
    return 0;
  });

  // Soft-deleted products included on purpose: their rows are the ones most in need of pruning
  // and `listProducts` would hide them. See `listAllProductSlugs`.
  let slugs: string[] = [];
  try {
    slugs = await listAllProductSlugs(db);
  } catch (e) {
    report.failures.products = e instanceof Error ? e.message : String(e);
  }

  for (const product of slugs) {
    await step(report, `audit:${product}`, () =>
      drain((limit) => pruneAudit(db, product, cutoff, limit)),
    );
    await step(report, `portalAudit:${product}`, () =>
      drain((limit) => prunePortalAudit(db, product, cutoff, limit)),
    );
    await step(report, `downloadTokens:${product}`, () =>
      purgeDownloadTokensForProduct(db, product, now, PRUNE_BATCH_ROWS),
    );
    await step(report, `seats:${product}`, () =>
      releaseDormantSeats(db, product, now),
    );
    // P2-02: CI tokens and upload tickets that expired more than a day ago.
    await step(report, `ciCredentials:${product}`, () =>
      pruneCiCredentials(db, product, now),
    );
    // P5-02: store-connector webhook events past `CONNECTOR_EVENT_RETENTION_SECONDS` (30 days).
    // Here and not on the connector poll tick, because the poll reaches only live products with
    // Distribution on and a loadable signing key — a deleted or disabled product's raw payloads
    // would otherwise be kept forever.
    await step(report, `connectorEvents:${product}`, () =>
      drain((limit) => pruneConnectorEvents(db, product, now, limit)),
    );
    // UX-15: the refusal log past `REFUSAL_RETENTION_SECONDS` (30 days, `core/refusals.ts`).
    await step(report, `refusals:${product}`, () =>
      drain((limit) =>
        pruneRefusals(db, product, now - REFUSAL_RETENTION_SECONDS, limit),
      ),
    );
    // PS-04: the storefront's impression dedupe keys older than yesterday (notes/S-21 §6.6:
    // nothing per person is kept past two days).
    await step(report, `storefrontSeen:${product}`, () =>
      drain((limit) => pruneStorefrontSeen(db, product, now, limit)),
    );
  }

  // `portal_audit.product` is nullable — a magic-link sign-in belongs to no tenant — so without
  // this pass those rows would be the one part of the table that still grew forever.
  await step(report, "portalAudit:_platform", () =>
    drain((limit) => prunePortalAudit(db, null, cutoff, limit)),
  );

  // A-12: the product-less admin trail, under the same 180-day retention as `audit`.
  await step(report, "platformAudit", () =>
    drain((limit) => prunePlatformAudit(db, cutoff, limit)),
  );

  // A-14: the Operations page's own rows, 30 days (`core/platformOps.ts`). Product-less by
  // construction like `platformAudit`: by age alone, bounded per pass.
  await step(report, "jobRuns", () =>
    drain((limit) => pruneJobRuns(db, now - JOB_RUN_RETENTION_SECONDS, limit)),
  );
  await step(report, "heartbeats", () =>
    pruneHeartbeats(db, now - JOB_RUN_RETENTION_SECONDS),
  );

  // F-21: registry tokens 90 days past their expiry or revocation (`core/registryTokens.ts`).
  await step(report, "registryTokens", () => purgeRegistryTokens(db, now));

  // I-05: portal rows a pre-I-05 Worker wrote during the deploy window join the account model,
  // then every second account linked to a licence another account owns loses its link, is
  // emailed and is listed in the platform audit log (plans/I-04.md §8 Q1).
  await step(report, "accountsCatchUp", async () => {
    await catchUpLegacyAccounts(db);
    return 0;
  });
  if (env) {
    await step(report, "accountOwnership", () =>
      settleOwnershipConflicts({
        db,
        env,
        now,
        origin: env.CONSOLE_ORIGIN ?? "",
      }),
    );
  }

  // P4-17: the lazy-delta sweep, for products opted in (none while `LAZY_DELTAS` is off). Before
  // the collector, so a delta marked cold tonight loses its ref before tonight's mark pass.
  if (env) await runLazyDeltaSweep(report, env, db, now);

  // HA-05: owed hosted-asset pulls whose back-off has elapsed (failed, stale, never delivered),
  // and, with the Images binding, ready copies still owing their variant ladder, re-enqueued to
  // `pkey-assets-<env>`, at most `RECHECK_MAX_PER_RUN` per night between them. Before the
  // collector, which never touches a ref a row still holds.
  if (env)
    await step(report, "hostedAssets", () => recheckHostedAssets(env, db, now));

  // PX-W16: account pictures nothing has used for a day (a disconnected provider's copy, an
  // upload never saved, a merged account's leftovers, a write that died half way).
  if (env) await step(report, "avatars", () => sweepAvatars(env, db, now));

  if (env) await runBlobGc(report, env, db, now);

  return report;
}

/**
 * The lazy-delta sweep (P4-17, `services/release/packs/deltas/sweep.ts`), one fault-isolated
 * step per opted-in product (`lazyDeltas:<slug>`): refresh the demand aggregate, enqueue the
 * pairs that turned hot (to `DELTA_QUEUE`; the consumer Worker encodes them), and mark cold the
 * deltas no device used for 30 days. Nothing at all while the `LAZY_DELTAS` switch is off (the
 * platform settings store, A-13: a `[vars]` `off` is a hard off).
 */
export async function runLazyDeltaSweep(
  report: MaintenanceReport,
  env: Env,
  db: Db,
  now: number,
): Promise<void> {
  let products: string[] = [];
  try {
    products = await lazyDeltaProducts(env, db);
  } catch (e) {
    report.failures["lazyDeltas:products"] =
      e instanceof Error ? e.message : String(e);
  }
  for (const product of products)
    await step(report, `lazyDeltas:${product}`, async () => {
      const r = await sweepLazyDeltas(env, db, product, now);
      return r.demandRows + r.queued + r.cold;
    });
}

/**
 * The two cron triggers in `wrangler.toml` (`[triggers] crons`). `handleScheduled` dispatches on
 * `event.cron`: the connector cron runs the store-connector poll (P5-02), anything else the
 * nightly maintenance sweep — so an unknown trigger can only ever cause maintenance, which is
 * idempotent, never an unplanned burst of store API calls. `test/scheduled.test.ts` asserts the
 * two constants are exactly `wrangler.toml`'s list.
 */
export const MAINTENANCE_CRON = "17 3 * * *";
export const CONNECTOR_POLL_CRON = "*/15 * * * *";

/**
 * One connector-poll tick (P5-02): every live product's ENABLED services' `scheduled` hooks
 * (`core/registry.ts` `runScheduledServices` — Distribution's store connectors today), each
 * product fault-isolated like the maintenance steps. Soft-deleted products are not polled: their
 * outlets ship nothing. A product whose signing key will not load is skipped (`loadProductPublic`
 * answers null), exactly as every request path skips it.
 */
export async function runConnectorPolls(
  env: Env,
  db: Db,
  now: number,
): Promise<MaintenanceReport & { results: Record<string, unknown> }> {
  const report: MaintenanceReport & { results: Record<string, unknown> } = {
    counts: {},
    failures: {},
    results: {},
  };
  let slugs: string[] = [];
  try {
    slugs = (await listProducts(db)).map((p) => p.slug);
  } catch (e) {
    report.failures.products = e instanceof Error ? e.message : String(e);
  }
  for (const slug of slugs) {
    const startedAt = Date.now();
    try {
      const product = await loadProductPublic(db, slug);
      if (!product) continue;
      const { results, failures } = await runScheduledServices(SERVICES, {
        env,
        db,
        product,
        now,
      });
      report.results[slug] = results;
      report.counts[`poll:${slug}`] = Object.keys(results).length;
      for (const [service, message] of Object.entries(failures))
        report.failures[`poll:${slug}:${service}`] = message;
    } catch (e) {
      report.failures[`poll:${slug}`] =
        e instanceof Error ? e.message : String(e);
    }
    (report.timings ??= {})[`poll:${slug}`] = {
      startedAt,
      durationMs: Date.now() - startedAt,
    };
  }
  return report;
}

/** The step the package-feed renders are recorded under (with `registry:<detail>` names). */
export const REGISTRY_STEP = "registry";

/**
 * The package-feed renders, on EVERY cron tick (plans/F-01.md §6.5): drain the render queue
 * (`core/registryQueue.ts` `drainRenderQueue`, into Distribution's `registryMaterialiser`), then
 * the self-check, which re-renders up to `SELF_CHECK_BUDGET` packages whose stored render stamp
 * differs from D1, across every live product. Both are idempotent and fault-isolated: a failure
 * is recorded under the `registry` step (`registry`, `registry:selfCheck:<slug>`) and the tick's
 * other work stands. Counts land in `report` as `registry:rendered`, `registry:dropped`,
 * `registry:failed` and `registry:selfCheck`.
 *
 * A failed render is not lost: its row stays queued with its attempt counted, behind fresh rows
 * (`core/registryQueue.ts`), and the next tick retries it. `handleScheduled` therefore never fails
 * a connector-poll tick for the `registry` step; the nightly maintenance tick reports it.
 */
export async function runRegistryRenders(
  env: Env,
  db: Db,
  now: number,
  report: MaintenanceReport,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const drained = await drainRenderQueue(SERVICES, { env, db, now });
    report.counts["registry:rendered"] = drained.rendered;
    report.counts["registry:dropped"] = drained.dropped;
    report.counts["registry:failed"] = drained.failed;
    if (drained.failed > 0)
      report.failures[REGISTRY_STEP] =
        `${drained.failed} render(s) failed and stay queued`;
  } catch (e) {
    report.failures[REGISTRY_STEP] = e instanceof Error ? e.message : String(e);
  }
  try {
    const slugs = (await listProducts(db)).map((p) => p.slug);
    const checked = await selfCheckRenders(SERVICES, { env, db, now }, slugs);
    report.counts["registry:selfCheck"] = checked.rerendered;
    for (const [slug, message] of Object.entries(checked.failures))
      report.failures[`registry:selfCheck:${slug}`] = message;
  } catch (e) {
    report.failures["registry:selfCheck"] =
      e instanceof Error ? e.message : String(e);
  }
  (report.timings ??= {})[REGISTRY_STEP] = {
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * A-14: persist the tick for the Operations page — its `platform_job_runs` rows and the `main`
 * heartbeat (`core/platformOps.ts`). Recording is not the job: a failure to record is added to
 * the report as the `opsRecord` step, so it surfaces in the thrown aggregate like any other step,
 * but it never hides or replaces the tick's own outcome. Exported for the tests.
 */
export async function recordTick(
  env: Env,
  db: Db,
  tick: {
    job: JobName;
    cron: string | null;
    startedAtMs: number;
    report: MaintenanceReport;
  },
): Promise<void> {
  const endedAtMs = Date.now();
  const outcome =
    Object.keys(tick.report.failures).length > 0 ? "failed" : "ok";
  try {
    await recordJobRun(db, {
      runId: `${tick.startedAtMs.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
      job: tick.job,
      cron: tick.cron,
      startedAtMs: tick.startedAtMs,
      endedAtMs,
      report: tick.report,
    });
    await writeHeartbeat(db, env, {
      script: "main",
      at: Math.floor(endedAtMs / 1000),
      outcome: `${tick.job}:${outcome}`,
    });
  } catch (e) {
    tick.report.failures.opsRecord = e instanceof Error ? e.message : String(e);
  }
}

/**
 * The `scheduled()` entry point. Throws if any step failed, so the invocation is recorded as
 * errored rather than disappearing into a green dashboard.
 *
 * The message names EVERY failed step and its reason, because that is the whole diagnostic
 * surface. R12 asserts, as a codebase-wide property, that nothing under `packages/worker/src`
 * writes to the runtime log at all — a worker that never logs is a worker that cannot leak a
 * secret through a log — so this handler emits no success summary and the thrown aggregate is
 * doing the job of a log line. It is written to be read cold at 03:20 UTC. Callers that want the
 * row counts (the tests do) take the returned report instead.
 */
export async function handleScheduled(
  env: Env,
  /** Override the binding — the tests drive the real handler against in-memory SQLite. */
  db: Db = new D1Db(env.DB),
  /** `ScheduledController.cron`: which trigger fired (see `CONNECTOR_POLL_CRON`). */
  cron?: string,
): Promise<MaintenanceReport> {
  const startedAtMs = Date.now();
  const now = Math.floor(startedAtMs / 1000);
  // A-13: each invocation starts from a fresh read of the platform settings store (the 30 s
  // per-isolate cache would otherwise carry a value across ticks).
  await refreshPlatformSettings(env, db);
  const poll = cron === CONNECTOR_POLL_CRON;
  const report = poll
    ? await runConnectorPolls(env, db, now)
    : await runScheduledMaintenance(db, now, env);
  const registry: MaintenanceReport = { counts: {}, failures: {} };
  await runRegistryRenders(env, db, now, registry);
  Object.assign(report.counts, registry.counts);
  Object.assign((report.timings ??= {}), registry.timings);
  // A render failure stays queued and is retried every tick, so it is not the connector poll's
  // failure (the Operations page reads a poll tick's failed steps as connector failures). The
  // nightly maintenance tick carries it, under the `registry` step.
  if (!poll) Object.assign(report.failures, registry.failures);
  else
    report.counts["registry:failures"] = Object.keys(registry.failures).length;
  await recordTick(env, db, {
    job: poll ? "connectorPoll" : "maintenance",
    cron: cron ?? null,
    startedAtMs,
    report,
  });
  const failed = Object.entries(report.failures);
  if (failed.length > 0) {
    throw new Error(
      `${poll ? "connector poll" : "scheduled maintenance"}: ${failed.length} step(s) failed — ` +
        failed.map(([name, message]) => `${name}: ${message}`).join("; "),
    );
  }
  return report;
}

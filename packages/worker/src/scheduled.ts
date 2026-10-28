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
// `purgeDownloadTokens`, `releaseDormantSeats` — waiting for a caller. This is the caller.
//
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR
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
// 4. FAIR, AND HONEST ABOUT STOPPING. Every product-scoped step is budgeted, and the product loop
//    used to start at the same slug every night with no memory of where the last run got to — so
//    on any deployment whose sweep does not fit in one tick, the head of the slug list was swept
//    nightly and the tail never, while the report looked identical to a clean run. A nightly run
//    now resumes after the previous run's `cursor` (kept in KV, `SWEEP_STATE_KEY`), spends an
//    explicit product budget, and reports what it did not finish (`truncated`, `deferred`,
//    `complete`) as data rather than leaving it to be inferred from a row count.
//
// There is deliberately no log line in here: `test/attack/R12-secrets.test.ts` asserts that no file
// under `packages/worker/src` names the runtime logger, so "the run stopped early" is carried by
// the machine-readable fields on the returned `MaintenanceReport`, by the aggregate `handleScheduled`
// throws, by the rows `recordTick` persists for the Operations page, and by the `SweepState`
// record written to KV on every nightly tick.

import { purgeAccountTokens } from "./core/accounts/personalTokens.js";
import { purgeExpiredInvites } from "./core/rbac/bindings.js";
import { purgeExpiredPrevious } from "./core/keyring/store.js";
import { purgeRegistryTokens } from "./core/registry/registryTokens.js";
import { pruneCiCredentials } from "./core/publisher.js";
import { loadProductPublic } from "./core/products.js";
import { runScheduledServices, serviceContext } from "./core/registry.js";
import {
  drainRenderQueue,
  selfCheckRenders,
} from "./core/registry/registryQueue.js";
import { SERVICES } from "./mount.js";
import {
  maintenanceContributions,
  type MaintenanceRecorder,
} from "./core/contributions.js";
import type { Env } from "./platform/env.js";
import type { Db } from "./db/types.js";
import { D1Db } from "./db/d1.js";
import { listAllProductSlugs, listProducts } from "./core/products/store.js";
import { releaseDormantSeats } from "./core/devices/store.js";
import { pruneAudit, prunePlatformAudit } from "./core/audit.js";
import { runLicensingCatchUp } from "./core/licensing/licensingCatchUp.js";
import {
  REFUSAL_RETENTION_SECONDS,
  pruneRefusals,
} from "./core/licensing/refusals.js";
import {
  SIGHTING_RETENTION_SECONDS,
  pruneSightings,
} from "./core/integration/sightings.js";
import { refreshPlatformSettings } from "./core/platformSettings.js";
import { recheckHostedAssets } from "./core/assets/hostedAssetPulls.js";
import {
  JOB_RUN_RETENTION_SECONDS,
  SUMMARY_NAMES_MAX,
  pruneHeartbeats,
  pruneJobRuns,
  recordJobRun,
  remainderParts,
  writeHeartbeat,
  type JobName,
  type StepTiming,
} from "./core/ops/platformOps.js";
import { purgePrivacyResidue } from "./privacyResidue.js";
import {
  GC_INDEX_READS_PER_TICK,
  applyProductGc,
  effectiveBlobGcSettings,
  markUnreferenced,
  planProductGc,
  pruneGcLog,
  sweepObjects,
} from "./core/assets/blobGc.js";

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
 * How many products one nightly tick may sweep before it stops and hands the rest to the next
 * tick.
 *
 * A fairness bound, not a performance one. Nothing here is slow in the steady state — one short
 * pass per step per product — but a sweep that does not fit in one invocation's wall clock is
 * killed somewhere in the middle of the list, and when the loop always starts at the
 * alphabetically first slug that "somewhere" is the same place every night: the head of the list
 * is swept nightly and the tail never. With a budget the run stops deliberately, names the
 * products it skipped and returns a cursor, and the next run starts where this one stopped.
 * Every product is therefore swept within ⌈products / SWEEP_MAX_PRODUCTS⌉ nights, whatever the
 * list length.
 */
export const SWEEP_MAX_PRODUCTS = 100;

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
 * share a seq", the position the signed release record carries; `idx_admin_api_tokens_hash` is the
 * unique lookup path of every `pkeya_` admin API token. Without them nothing errors — the
 * constraint simply stops being enforced.
 *
 * A test asserts this list and the newest `migrations/*_index_assertion.sql` (0018, then its
 * successors — 0119_b today) are the same set, so the two cannot drift apart.
 */
export const REQUIRED_INDEXES: readonly string[] = [
  "idx_admin_api_tokens_hash",
  "idx_audit_time",
  "idx_ci_tokens_jti",
  "idx_device_keys_agree",
  "idx_devices_license_status",
  "idx_devices_seat",
  "idx_licenses_email_lower",
  "idx_licenses_enroll_hwid",
  "idx_licenses_origin",
  "idx_licenses_sub",
  "idx_licenses_sub_global",
  "idx_portal_audit_at",
  "idx_portal_audit_product_at",
  "idx_product_keys_one_active",
  "idx_product_keys_verify",
  "idx_release_download_tokens_expiry",
  "idx_release_download_tokens_hash",
  "idx_release_metadata_seq",
  "idx_tiers_implicit",
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
  /**
   * Steps that exited on their BATCH BUDGET (`PRUNE_MAX_BATCHES`) rather than on a short pass,
   * mapped to the rows they did remove: the stop reason `drain()` always knew and never told
   * anyone. A step that deleted 10 000 rows and ran out of batches has work left over; one that
   * deleted 10 000 and stopped on a short pass is finished, and both appear in `counts` as the
   * same number. The value is a floor on what was there, never a remainder — the remainder is
   * unknown by construction, which is why the budget exists. Set by the nightly sweep; absent on
   * a hand-built report.
   */
  truncated?: Record<string, number>;
  /** Products the nightly run never reached, because it spent its `maxProducts` budget first. */
  deferred?: string[];
  /**
   * Where the NEXT nightly run resumes: the last slug this run swept, or null to start at the top
   * of the list (which is what a run that reached every product returns).
   */
  cursor?: string | null;
  /**
   * Did the nightly sweep discharge everything it found? False if any step threw, any step
   * stopped on its batch budget or any product went unvisited.
   */
  complete?: boolean;
}

/** Per-run inputs a caller owns. Optional, so a plain call still means "start at the top". */
export interface MaintenanceOptions {
  /** The `cursor` the previous run returned. The sweep resumes at the first slug AFTER it. */
  cursor?: string | null;
  /** Product budget for this run. Defaults to `SWEEP_MAX_PRODUCTS`. */
  maxProducts?: number;
}

/** Did a tick finish everything it found? Failures, budget stops and unvisited products all say no. */
function isComplete(report: MaintenanceReport): boolean {
  return (
    Object.keys(report.failures).length === 0 &&
    Object.keys(report.truncated ?? {}).length === 0 &&
    (report.deferred ?? []).length === 0
  );
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
 * Delete in bounded passes until a pass comes back short or the batch budget runs out, and say
 * which of the two happened.
 *
 * The short-pass exit is what makes this idempotent-and-cheap in the steady state: once the
 * table holds nothing older than the cutoff, the first pass deletes 0 and the loop ends, so a
 * duplicate cron delivery costs exactly one statement.
 *
 * `truncated` is deliberately conservative: a run whose last pass was a FULL batch is reported
 * as truncated even when the table happened to end exactly there. One extra confirming pass
 * would cost a statement per step per product every night to tell apart two states that are
 * handled identically anyway (the next run finishes the work).
 */
async function drain(
  pass: (limit: number) => Promise<number>,
): Promise<{ removed: number; truncated: boolean }> {
  let removed = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    const n = await pass(PRUNE_BATCH_ROWS);
    removed += n;
    if (n < PRUNE_BATCH_ROWS) return { removed, truncated: false };
  }
  return { removed, truncated: true };
}

/** `step()` over `drain()`: one bounded delete loop, its stop reason recorded in the report. */
async function drainStep(
  report: MaintenanceReport,
  name: string,
  pass: (limit: number) => Promise<number>,
): Promise<void> {
  await step(report, name, async () => {
    const { removed, truncated } = await drain(pass);
    // Recorded before the count is returned, so `truncated[name]` and `counts[name]` agree: a
    // step that appears in one appears in the other with the same number.
    if (truncated) (report.truncated ??= {})[name] = removed;
    return removed;
  });
}

/** The recorder a service's maintenance contribution reports through (`core/contributions.ts`). */
function recorderFor(report: MaintenanceReport): MaintenanceRecorder {
  return {
    step: (name, run) => step(report, name, run),
    drain: (name, pass) => drainStep(report, name, pass),
    fail: (name, error) => {
      report.failures[name] =
        error instanceof Error ? error.message : String(error);
    },
  };
}

/**
 * Run one slot of every mounted service's `contributes.maintenance`, in canonical service order.
 * A contribution that throws outside its own steps is recorded under its slot name and the others
 * still run: a service's scheduled work can never cost another service its turn.
 */
async function runSlot(
  report: MaintenanceReport,
  slot: "early" | "late" | "frequent" | "registry",
  ctx: { db: Db; env?: Env; now: number; nightly: boolean },
): Promise<void> {
  const rec = recorderFor(report);
  const full = { ...ctx, cutoff: ctx.now - AUDIT_RETENTION_SECONDS };
  for (const m of maintenanceContributions()) {
    const run = m[slot];
    if (!run) continue;
    try {
      await run(full, rec);
    } catch (e) {
      rec.fail(`maintenance:${slot}`, e);
    }
  }
}

/**
 * The blob collector's nightly pass (P4-14, `core/assets/blobGc.ts`), after the retention steps:
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
      const hooks = serviceContext("host", SERVICES, product.services, {
        env,
        db,
        product,
        now,
      }).hooks;
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
  await drainStep(report, "blobGcLog", (limit) =>
    pruneGcLog(db, now - AUDIT_RETENTION_SECONDS, limit),
  );
}

/**
 * The whole nightly sweep. Exported separately from the handler so it is directly testable
 * against the in-memory SQLite harness, with an injected clock. With `env`, the blob collector
 * runs after the retention steps (`runBlobGc`).
 *
 * The product-scoped steps run for at most `opts.maxProducts` products, starting after
 * `opts.cursor` and wrapping at the end of the list; the products it did not reach come back in
 * `deferred` and the slug to resume after in `cursor`. The platform-level steps (the product-less
 * audit trails, the ops tables, the erasure sweeps, the blob collector) are not product-scoped:
 * they sit outside that rotation and run on every tick.
 */
export async function runScheduledMaintenance(
  db: Db,
  now: number,
  env?: Env,
  opts: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    counts: {},
    failures: {},
    truncated: {},
    deferred: [],
    cursor: null,
    complete: false,
  };
  const cutoff = now - AUDIT_RETENTION_SECONDS;
  const cursor = opts.cursor ?? null;
  const maxProducts = Math.max(1, opts.maxProducts ?? SWEEP_MAX_PRODUCTS);

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

  // Rotate the list so this run starts after the previous run's cursor, then spend the product
  // budget on the front of it. `listAllProductSlugs` orders by slug, so a strict `>` finds the
  // resume point even when the cursor names a product that has since been deleted (an index
  // would silently shift the whole rotation by one), and a cursor past the end of the list wraps
  // to the top rather than skipping a whole cycle.
  const found = cursor === null ? -1 : slugs.findIndex((s) => s > cursor);
  const resumeAt = Math.max(0, found);
  const rotated = [...slugs.slice(resumeAt), ...slugs.slice(0, resumeAt)];
  const sweeping = rotated.slice(0, maxProducts);
  report.deferred = rotated.slice(maxProducts);
  // A run that reached everyone hands back null so the next one starts at the top; a run that
  // did not hands back its last slug, which is where the next one picks up.
  report.cursor =
    report.deferred.length === 0
      ? null
      : (sweeping[sweeping.length - 1] ?? cursor);

  for (const product of sweeping) {
    await drainStep(report, `audit:${product}`, (limit) =>
      pruneAudit(db, product, cutoff, limit),
    );
    await step(report, `seats:${product}`, () =>
      releaseDormantSeats(db, product, now),
    );
    // P2-02: CI tokens and upload tickets that expired more than a day ago.
    await step(report, `ciCredentials:${product}`, () =>
      pruneCiCredentials(db, product, now),
    );
    // UX-15: the refusal log past `REFUSAL_RETENTION_SECONDS` (30 days, `core/licensing/refusals.ts`).
    await drainStep(report, `refusals:${product}`, (limit) =>
      pruneRefusals(db, product, now - REFUSAL_RETENTION_SECONDS, limit),
    );
    // ST-40: SDK sightings last seen more than 90 days ago.
    await drainStep(report, `sightings:${product}`, (limit) =>
      pruneSightings(db, product, now - SIGHTING_RETENTION_SECONDS, limit),
    );
    // Each mounted service's own per-product steps (`contributes.maintenance.product`).
    const rec = recorderFor(report);
    for (const m of maintenanceContributions())
      try {
        await m.product?.({ db, env, now, cutoff, product }, rec);
      } catch (e) {
        rec.fail(`maintenance:product:${product}`, e);
      }
  }

  // A-12: the product-less admin trail, under the same 180-day retention as `audit`.
  await drainStep(report, "platformAudit", (limit) =>
    prunePlatformAudit(db, cutoff, limit),
  );

  // A-14: the Operations page's own rows, 30 days (`core/ops/platformOps.ts`). Product-less by
  // construction like `platformAudit`: by age alone, bounded per pass.
  await drainStep(report, "jobRuns", (limit) =>
    pruneJobRuns(db, now - JOB_RUN_RETENTION_SECONDS, limit),
  );
  await step(report, "heartbeats", () =>
    pruneHeartbeats(db, now - JOB_RUN_RETENTION_SECONDS),
  );

  // Relink snapshots past their undo window lose the licence's name and
  // email; merge tombstones and subject events past the audit retention are deleted.
  await step(report, "privacyResidue", () => purgePrivacyResidue(db, now));

  // F-21: registry tokens 90 days past their expiry or revocation (`core/registry/registryTokens.ts`).
  await step(report, "registryTokens", () => purgeRegistryTokens(db, now));
  // F-33: personal tokens, the same retention.
  await step(report, "accountTokens", () => purgeAccountTokens(db, now));
  // ST-31.7: console invites that expired more than 7 days ago.
  await step(report, "consoleInvites", () => purgeExpiredInvites(db, now));
  // U-36.3: the key rings a reset replaced more than 30 days ago lose their wraps and marker.
  await step(report, "keyringPrevious", () => purgeExpiredPrevious(db, now));

  // The services' early nightly work (`contributes.maintenance.early`): Identity's erasure
  // ledger replay, its due account deletions and its erasure retries.
  await runSlot(report, "early", { db, env, now, nightly: true });
  // LX-08: the licensing model's rows catch up with what a pre-LX-08 Worker wrote between the
  // migration and the deploy (store grants, purchases, mappings), and the OIDC-provisioned keys
  // of licences that have not signed in since move to their `oidc` grant
  // (`core/licensing/licensingCatchUp.ts`). A no-op once both are done; it changes no document.
  await step(report, "licensingCatchUp", async () => {
    const r = await runLicensingCatchUp(db, SERVICES, now);
    const failed = Object.entries(r.failures);
    if (failed.length > 0)
      throw new Error(
        `licensing reconcile failed for ${failed.map(([p, m]) => `${p}: ${m}`).join("; ")}`,
      );
    return r.provisioned.moved;
  });
  // HA-05: owed hosted-asset pulls whose back-off has elapsed (failed, stale, never delivered),
  // and, with the Images binding, ready copies still owing their variant ladder, re-enqueued to
  // `pkey-assets-<env>`, at most `RECHECK_MAX_PER_RUN` per night between them. Before the
  // collector, which never touches a ref a row still holds.
  if (env)
    await step(report, "hostedAssets", () => recheckHostedAssets(env, db, now));

  // The services' late nightly work (`contributes.maintenance.late`): Identity's ownership
  // settling, avatar, merge-snapshot and connection-domain sweeps, Release's lazy deltas and
  // mirror backfill. Before the collector, which never drops a ref one of them still holds.
  await runSlot(report, "late", { db, env, now, nightly: true });

  if (env) await runBlobGc(report, env, db, now);

  report.complete = isComplete(report);
  return report;
}

/**
 * The two cron triggers in `wrangler.toml` (`[triggers] crons`). `handleScheduled` dispatches on
 * `event.cron`: the connector cron runs the store-connector poll (P5-02), anything else the
 * nightly maintenance sweep — so an unknown trigger can only ever cause maintenance, which is
 * idempotent, never an unplanned burst of store API calls. `test/surfaces/scheduled.test.ts` asserts the
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
 * (`core/registry/registryQueue.ts` `drainRenderQueue`, into Distribution's `registryMaterialiser`), then
 * the self-check, which re-renders up to `SELF_CHECK_BUDGET` packages whose stored render stamp
 * differs from D1, across every live product. Both are idempotent and fault-isolated: a failure
 * is recorded under the `registry` step (`registry`, `registry:selfCheck:<slug>`) and the tick's
 * other work stands. Counts land in `report` as `registry:rendered`, `registry:dropped`,
 * `registry:failed` and `registry:selfCheck`.
 *
 * A failed render is not lost: its row stays queued with its attempt counted, behind fresh rows
 * (`core/registry/registryQueue.ts`), and the next tick retries it. `handleScheduled` therefore never fails
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
 * heartbeat (`core/ops/platformOps.ts`). Recording is not the job: a failure to record is added to
 * the report as the `opsRecord` step, so it surfaces in the thrown aggregate like any other step,
 * but it never hides or replaces the tick's own outcome. Exported for the tests.
 *
 * The heartbeat's outcome is `failed` when a step failed, `partial` when none did but the tick
 * left work unfinished (a step on its batch budget, products not reached), and `ok` otherwise;
 * the rows carry which steps and products (`jobRunRows`).
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
    Object.keys(tick.report.failures).length > 0
      ? "failed"
      : isComplete(tick.report)
        ? "ok"
        : "partial";
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
 * KV key holding the nightly sweep's resume cursor and the last tick's outcome.
 *
 * Not built with `pk()`: the sweep is platform-level and names no product, so it has no product
 * dimension to scope by. The `maint:` prefix keeps it clear of the `p:` namespace where a real
 * slug could otherwise collide with it, as `gh:` and `plat:` do for the keys beside it.
 */
export const SWEEP_STATE_KEY = "maint:sweep";

/**
 * What a nightly tick leaves behind for the next one, written on every tick including the green
 * ones: the cursor to resume after, and the outcome — the only trace a truncated run leaves in
 * production once the Worker's own report is discarded. The three name lists are cut at
 * `SUMMARY_NAMES_MAX`; `counts` holds their full sizes.
 */
export interface SweepState {
  /** Resume point for the next run; see `MaintenanceReport.cursor`. */
  cursor: string | null;
  /** Unix seconds of the run that wrote this record. */
  at: number;
  /** Did that run discharge everything it found? */
  complete: boolean;
  /** Steps that stopped on the batch budget with work remaining. */
  truncated: string[];
  /** Products that run never reached. */
  deferred: string[];
  /** Steps that threw. */
  failed: string[];
  /** The full sizes of the three lists above. */
  counts: { truncated: number; deferred: number; failed: number };
}

/**
 * The cursor the previous nightly run stored, or null when there is none or it does not parse. A
 * corrupt record costs this one run its fairness (it restarts at the top of the list), not its
 * correctness: it is treated as absent rather than fatal, so a bad byte cannot stop retention.
 */
async function readSweepCursor(env: Env): Promise<string | null> {
  const raw = await env.HOT.get(SWEEP_STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { cursor?: unknown } | null;
    return typeof parsed?.cursor === "string" ? parsed.cursor : null;
  } catch {
    return null;
  }
}

/** The record a nightly tick stores for the next one. */
function sweepStateOf(report: MaintenanceReport, now: number): SweepState {
  const truncated = Object.keys(report.truncated ?? {});
  const deferred = report.deferred ?? [];
  const failed = Object.keys(report.failures);
  return {
    cursor: report.cursor ?? null,
    at: now,
    complete: isComplete(report),
    truncated: truncated.slice(0, SUMMARY_NAMES_MAX),
    deferred: deferred.slice(0, SUMMARY_NAMES_MAX),
    failed: failed.slice(0, SUMMARY_NAMES_MAX),
    counts: {
      truncated: truncated.length,
      deferred: deferred.length,
      failed: failed.length,
    },
  };
}

/** The ` — …` tail naming what a tick left unfinished. Empty when it left nothing. */
function remainderSuffix(report: MaintenanceReport): string {
  const parts = remainderParts(report);
  return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

/**
 * The `scheduled()` entry point. Throws if any step failed, so the invocation is recorded as
 * errored rather than disappearing into a green dashboard.
 *
 * The message names EVERY failed step and its reason — and what the tick did not finish — because
 * that is the whole diagnostic surface. R12 asserts, as a codebase-wide property, that nothing
 * under `packages/worker/src` writes to the runtime log at all — a worker that never logs is a
 * worker that cannot leak a secret through a log — so this handler emits no success summary and
 * the thrown aggregate is doing the job of a log line. It is written to be read cold at 03:20
 * UTC. Callers that want the row counts (the tests do) take the returned report instead.
 *
 * The nightly tick is also the only part of the sweep that knows where the resume cursor is kept
 * (`SWEEP_STATE_KEY`): it reads it before the run and writes the tick's `SweepState` after, on
 * every nightly tick. A connector-poll tick sweeps no products and touches neither.
 */
export async function handleScheduled(
  env: Env,
  /** Override the binding — the tests drive the real handler against in-memory SQLite. */
  db: Db = new D1Db(env.DB),
  /** `ScheduledController.cron`: which trigger fired (see `CONNECTOR_POLL_CRON`). */
  cron?: string,
  /** Everything except the cursor, which is this function's to load and to store. */
  opts: Omit<MaintenanceOptions, "cursor"> = {},
): Promise<MaintenanceReport> {
  const startedAtMs = Date.now();
  const now = Math.floor(startedAtMs / 1000);
  // A-13: each invocation starts from a fresh read of the platform settings store (the 30 s
  // per-isolate cache would otherwise carry a value across ticks).
  await refreshPlatformSettings(env, db);
  const poll = cron === CONNECTOR_POLL_CRON;
  let cursor: string | null = null;
  let stateError: string | null = null;
  if (!poll) {
    try {
      cursor = await readSweepCursor(env);
    } catch (e) {
      stateError = `read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const report = poll
    ? await runConnectorPolls(env, db, now)
    : await runScheduledMaintenance(db, now, env, { ...opts, cursor });
  // The erasure ledger replay, due account deletions and failed erasures are run on each
  // connector-poll tick. Their failures wait for the nightly report so the Operations page reads
  // this tick as connector work.
  if (poll) {
    const frequent: MaintenanceReport = { counts: {}, failures: {} };
    await runSlot(frequent, "frequent", { db, env, now, nightly: false });
    // A step that failed here counts 0: its failure waits for the nightly report.
    for (const name of Object.keys(frequent.failures))
      frequent.counts[name] ??= 0;
    Object.assign(report.counts, frequent.counts);
  }
  const registry: MaintenanceReport = { counts: {}, failures: {} };
  await runRegistryRenders(env, db, now, registry);
  // Heal package refs the deploy window's old Worker wrote as `artifact`, every tick.
  await runSlot(registry, "registry", { db, env, now, nightly: !poll });
  Object.assign(report.counts, registry.counts);
  Object.assign((report.timings ??= {}), registry.timings);
  // A render failure stays queued and is retried every tick, so it is not the connector poll's
  // failure (the Operations page reads a poll tick's failed steps as connector failures). The
  // nightly maintenance tick carries it, under the `registry` step.
  if (!poll) Object.assign(report.failures, registry.failures);
  else
    report.counts["registry:failures"] = Object.keys(registry.failures).length;
  if (!poll) {
    try {
      await env.HOT.put(
        SWEEP_STATE_KEY,
        JSON.stringify(sweepStateOf(report, now)),
      );
    } catch (e) {
      stateError = `${stateError ? `${stateError}; ` : ""}write: ${e instanceof Error ? e.message : String(e)}`;
    }
    // A cursor that cannot be read or persisted is the starvation defect returning: every run
    // would restart at the top of the slug list and the tail would starve again, silently and
    // indefinitely. So it is a failed step, not a warning — the sweep still ran, but the
    // invocation goes red.
    if (stateError) report.failures.sweepState = stateError;
    report.complete = isComplete(report);
  }
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
        failed.map(([name, message]) => `${name}: ${message}`).join("; ") +
        remainderSuffix(report),
    );
  }
  return report;
}

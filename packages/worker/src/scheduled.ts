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
//    statement whose blast radius is "the table".
// 2. IDEMPOTENT. Every step is a delete-what-is-already-past or a null-what-is-already-dormant,
//    so a second run on the same clock removes nothing and changes nothing. Cron delivery is
//    at-least-once; a duplicate tick must be a no-op, not a double-punishment.
// 3. FAULT-ISOLATED. Steps run through `step()`, which catches. One product's failure must not
//    cost every later product its retention pass — that is how a single poisoned row turns into
//    a table that is never pruned again. Failures are collected and re-thrown as one aggregate
//    at the very end, so the invocation is still recorded as failed.

import { pruneCiCredentials } from "./core/publisher.js";
import { loadProductPublic } from "./core/products.js";
import { runScheduledServices } from "./core/registry.js";
import { SERVICES } from "./mount.js";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { D1Db } from "./db/d1.js";
import {
  listAllProductSlugs,
  listProducts,
  pruneAudit,
  releaseDormantSeats,
} from "./repo.js";
import {
  prunePortalAudit,
  purgeDownloadTokensForProduct,
} from "./services/identity/portal/repo.js";

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
  try {
    report.counts[name] = await run();
  } catch (e) {
    report.failures[name] = e instanceof Error ? e.message : String(e);
  }
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
 * The whole nightly sweep. Exported separately from the handler so it is directly testable
 * against the in-memory SQLite harness, with an injected clock.
 */
export async function runScheduledMaintenance(
  db: Db,
  now: number,
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
  }

  // `portal_audit.product` is nullable — a magic-link sign-in belongs to no tenant — so without
  // this pass those rows would be the one part of the table that still grew forever.
  await step(report, "portalAudit:_platform", () =>
    drain((limit) => prunePortalAudit(db, null, cutoff, limit)),
  );

  return report;
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
  }
  return report;
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
  const now = Math.floor(Date.now() / 1000);
  const poll = cron === CONNECTOR_POLL_CRON;
  const report = poll
    ? await runConnectorPolls(env, db, now)
    : await runScheduledMaintenance(db, now);
  const failed = Object.entries(report.failures);
  if (failed.length > 0) {
    throw new Error(
      `${poll ? "connector poll" : "scheduled maintenance"}: ${failed.length} step(s) failed — ` +
        failed.map(([name, message]) => `${name}: ${message}`).join("; "),
    );
  }
  return report;
}

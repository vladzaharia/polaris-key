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
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR
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
// 4. FAIR, AND HONEST ABOUT STOPPING. B5-10: every one of these steps is budgeted, and the
//    product loop used to start at the same slug every night with no memory of where the last
//    run got to — so on any deployment whose sweep does not fit in one tick, the head of the
//    slug list was swept nightly and the tail was NEVER swept, while the report looked
//    identical to a clean run. A run now resumes after the previous run's `cursor`, takes an
//    explicit product budget, and reports what it did not finish (`truncated`, `deferred`,
//    `complete`) as data rather than leaving it to be inferred from a row count.
//
// WHY THERE IS NO LOG LINE IN HERE. `test/attack/R12-secrets.test.ts` asserts, over EVERY file
// under `packages/worker/src`, that not one of them so much as names the runtime logger — a
// worker that cannot log is a worker that cannot leak a secret through a log — and the assertion
// has no exemption list, not even for a mention inside a comment (this paragraph had to be
// reworded to get past it). So "the run stopped early" is carried by the machine-readable fields
// on the returned `MaintenanceReport`, by the aggregate `handleScheduled` throws, and — because
// production discards that report — by the `SweepState` record written to KV on every tick.

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { D1Db } from "./db/d1.js";
import {
  listAllProductSlugs,
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
 * How many products one tick may sweep before it stops and hands the rest to the next tick.
 *
 * This is a FAIRNESS bound, not a performance one. Nothing here is slow in the steady state —
 * one short pass per step per product — but a sweep that does not fit in one invocation's wall
 * clock gets killed somewhere in the middle of the list, and before B5-10 that "somewhere" was
 * the same place every night, because the loop always started at the alphabetically first slug.
 * The head of the list was therefore swept nightly and the tail was never swept at all: the
 * retention promise in `docs/PRIVACY.md` silently held for `acme` and silently failed for
 * `zephyr`, and the report gave no way to tell.
 *
 * With a budget the run stops DELIBERATELY, names the products it skipped, and returns a cursor;
 * with the cursor the next run starts where this one stopped. Every product is therefore swept
 * within ⌈products / SWEEP_MAX_PRODUCTS⌉ nights, whatever the list length.
 */
export const SWEEP_MAX_PRODUCTS = 100;

/**
 * The indexes the code's correctness depends on, re-checked on every tick.
 *
 * R11-04: seven of the eleven original migrations fail on replay with `duplicate column name`,
 * and SQLite offers neither `ADD COLUMN IF NOT EXISTS` nor conditional DDL, so replay-idempotency
 * is not reachable in pure SQL. The recommendation was a deploy-time assertion instead — which
 * `migrations/0018_index_assertion.sql` is, aborting the migration on a short count. This is its
 * runtime twin, and it catches what a migration-time check structurally cannot: an index dropped
 * after deploy, by hand, from the D1 dashboard.
 *
 * Every name is an invariant whose absence is silent. `idx_licenses_enroll_hwid` is
 * one-free-licence-per-machine; `idx_devices_seat` is the UNIQUE arbiter that makes
 * `claimDeviceSeat` atomic instead of check-then-act; `idx_product_keys_one_active` is one active
 * DOCUMENT signing key per product and `idx_product_keys_one_active_anchor` its twin for the
 * trust anchor (0026, wire v3 §1.1 — two active anchors would mean two keys able to sign a trust
 * manifest, i.e. two answers to "what do I pin?"); `idx_release_download_tokens_hash` is what
 * makes a download token globally unambiguous. Without them nothing errors — the constraint
 * simply stops being enforced.
 *
 * A test asserts this list and the NEWEST migration-time assertion (0026, which supersedes
 * 0018's list) name the same set, so the two cannot drift apart.
 */
export const REQUIRED_INDEXES: readonly string[] = [
  "idx_audit_time",
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
  "idx_product_keys_one_active_anchor",
  "idx_product_keys_verify",
  "idx_release_download_tokens_expiry",
  "idx_release_download_tokens_hash",
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
        "re-apply migrations; see migrations/0018_index_assertion.sql",
    );
  }
}

export interface MaintenanceReport {
  /** Rows affected, per step name. Absent means the step failed before touching anything. */
  counts: Record<string, number>;
  /** Step name -> message, for every step that threw. */
  failures: Record<string, string>;
  /**
   * Steps that exited on the BATCH BUDGET rather than on a short pass, mapped to the rows they
   * did remove.
   *
   * This is the distinction `drain()` has always known and never told anyone: a step that
   * deleted 10 000 rows and stopped because `PRUNE_MAX_BATCHES` ran out has work left over,
   * while a step that deleted 10 000 rows and stopped because the last pass came back short is
   * finished. Both used to appear in `counts` as the identical number, so "the sweep is keeping
   * up" and "the sweep has been falling behind for a month" were indistinguishable. The value is
   * a FLOOR on what was there, never a remainder — the remainder is unknown by construction,
   * which is the whole reason the budget exists.
   */
  truncated: Record<string, number>;
  /** Products this run never reached, because it spent its `maxProducts` budget first. */
  deferred: string[];
  /**
   * Where the NEXT run must resume: the last slug this run swept, or null to start at the top of
   * the list (which is what a run that reached every product returns).
   */
  cursor: string | null;
  /**
   * The one-field answer to "did this tick discharge the whole retention obligation?" — false if
   * any step threw, any step stopped on its batch budget, or any product went unvisited.
   */
  complete: boolean;
}

/** Per-run inputs that a caller owns. Both are optional so the pre-B5-10 two-argument call
 *  still compiles and still means "start at the top, sweep everything". */
export interface MaintenanceOptions {
  /** The `cursor` the previous run returned. The sweep resumes at the first slug AFTER it. */
  cursor?: string | null;
  /** Product budget for this run. Defaults to `SWEEP_MAX_PRODUCTS`. */
  maxProducts?: number;
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
 * Delete in bounded passes until a pass comes back short or the batch budget runs out, and say
 * WHICH of the two happened.
 *
 * The short-pass exit is what makes this idempotent-and-cheap in the steady state: once the
 * table holds nothing older than the cutoff, the first pass deletes 0 and the loop ends, so a
 * duplicate cron delivery costs exactly one statement.
 *
 * `truncated` is deliberately conservative: a run that spends its last pass on a FULL batch is
 * reported as truncated even in the case where the table happened to end exactly there. The
 * alternative — one extra confirming pass — would cost a statement per step per product every
 * night to distinguish two states that are handled identically anyway (the next run finishes it).
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

/** `step()` over `drain()`: one bounded, resumable delete loop, with its stop reason recorded. */
async function drainStep(
  report: MaintenanceReport,
  name: string,
  pass: (limit: number) => Promise<number>,
): Promise<void> {
  await step(report, name, async () => {
    const { removed, truncated } = await drain(pass);
    // Written before the count is returned, so `truncated[name]` and `counts[name]` cannot
    // disagree: a step that appears in one appears in the other with the same number.
    if (truncated) report.truncated[name] = removed;
    return removed;
  });
}

/**
 * The whole nightly sweep. Exported separately from the handler so it is directly testable
 * against the in-memory SQLite harness, with an injected clock.
 */
export async function runScheduledMaintenance(
  db: Db,
  now: number,
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
  // resume point even when the cursor names a product that has since been deleted — and a cursor
  // past the end of the list simply wraps to the top rather than skipping a whole cycle.
  const resumeAt = cursor === null ? 0 : slugs.findIndex((s) => s > cursor);
  const start = resumeAt < 0 ? 0 : resumeAt;
  const rotated = [...slugs.slice(start), ...slugs.slice(0, start)];
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
    await drainStep(report, `portalAudit:${product}`, (limit) =>
      prunePortalAudit(db, product, cutoff, limit),
    );
    // B5-08 / BLUE-01: this was the one step NOT wrapped in `drain()`, so it deleted at most
    // PRUNE_BATCH_ROWS per NIGHT. A product that mints download tokens faster than 500/day
    // therefore accumulated them forever — the sweep ran, reported a healthy-looking count, and
    // fell further behind every tick. Wrapped, it drains like its two siblings.
    await drainStep(report, `downloadTokens:${product}`, (limit) =>
      purgeDownloadTokensForProduct(db, product, now, limit),
    );
    await step(report, `seats:${product}`, () =>
      releaseDormantSeats(db, product, now),
    );
  }

  // `portal_audit.product` is nullable — a magic-link sign-in belongs to no tenant — so without
  // this pass those rows would be the one part of the table that still grew forever. It is not
  // product-scoped, so it is outside the rotation and runs on every tick.
  await drainStep(report, "portalAudit:_platform", (limit) =>
    prunePortalAudit(db, null, cutoff, limit),
  );

  report.complete =
    Object.keys(report.failures).length === 0 &&
    Object.keys(report.truncated).length === 0 &&
    report.deferred.length === 0;
  return report;
}

/**
 * KV key holding the sweep's resume cursor and the last tick's outcome.
 *
 * Not built with `pk()`: the sweep is platform-level and names no product, so it has no product
 * dimension to scope by. The `maint:` prefix keeps it clear of the `p:` namespace where a real
 * slug could otherwise collide with it, exactly as `gh:` does in `kv.ts`.
 */
export const SWEEP_STATE_KEY = "maint:sweep";

/**
 * What one tick leaves behind for the next one — and the only place a truncated run is visible
 * in production, since `index.ts`'s `scheduled()` discards the returned report and this file
 * may not log (see the header).
 */
export interface SweepState {
  /** Resume point for the next run; see `MaintenanceReport.cursor`. */
  cursor: string | null;
  /** Unix seconds of the run that wrote this record. */
  at: number;
  /** Did that run discharge everything it found? A run of `false` records is the alarm. */
  complete: boolean;
  /** Steps that stopped on the batch budget with work remaining. */
  truncated: string[];
  /** Products that run never reached. */
  deferred: string[];
  /** Steps that threw. */
  failed: string[];
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The stored cursor, or null when there is none / it does not parse. */
async function readSweepState(env: Env): Promise<SweepState | null> {
  const raw = await env.HOT.get(SWEEP_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SweepState;
  } catch {
    // A corrupt record costs this one run its fairness (it restarts at the top), not its
    // correctness. Treated as absent rather than fatal so a bad byte cannot stop retention.
    return null;
  }
}

/** The `— and N step(s) …` tail naming what a run left behind. Empty when it left nothing. */
function remainderSuffix(report: MaintenanceReport): string {
  const parts: string[] = [];
  const truncated = Object.keys(report.truncated);
  if (truncated.length > 0) {
    parts.push(
      `${truncated.length} step(s) stopped on the batch budget with work remaining ` +
        `(${truncated.join(", ")})`,
    );
  }
  if (report.deferred.length > 0) {
    parts.push(
      `${report.deferred.length} product(s) not reached this run ` +
        `(${report.deferred.join(", ")})`,
    );
  }
  return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

/**
 * The `scheduled()` entry point, and the only part of the sweep that knows where the cursor is
 * kept. Throws if any step failed, so the invocation is recorded as errored rather than
 * disappearing into a green dashboard.
 *
 * The message names EVERY failed step and its reason, and now also names what the run did NOT
 * finish, because that is the whole diagnostic surface. R12 asserts, as a codebase-wide
 * property, that nothing under `packages/worker/src` writes to the runtime log at all — a worker
 * that never logs is a worker that cannot leak a secret through a log — so this handler emits no
 * success summary and the thrown aggregate is doing the job of a log line. It is written to be
 * read cold at 03:20 UTC. Callers that want the row counts (the tests do) take the returned
 * report instead; operators read the `SweepState` record, which is written on EVERY tick,
 * including the green ones, precisely so that "stopped early, again" is visible without a log.
 */
export async function handleScheduled(
  env: Env,
  /** Override the binding — the tests drive the real handler against in-memory SQLite. */
  db: Db = new D1Db(env.DB),
  /** Everything except the cursor, which is this function's to load and to store. */
  opts: Omit<MaintenanceOptions, "cursor"> = {},
): Promise<MaintenanceReport> {
  const now = Math.floor(Date.now() / 1000);

  let cursor: string | null = null;
  let stateError: string | null = null;
  try {
    cursor = (await readSweepState(env))?.cursor ?? null;
  } catch (e) {
    stateError = `read: ${messageOf(e)}`;
  }

  const report = await runScheduledMaintenance(db, now, { ...opts, cursor });

  const state: SweepState = {
    cursor: report.cursor,
    at: now,
    complete: report.complete,
    truncated: Object.keys(report.truncated),
    deferred: report.deferred,
    failed: Object.keys(report.failures),
  };
  try {
    await env.HOT.put(SWEEP_STATE_KEY, JSON.stringify(state));
  } catch (e) {
    stateError = `${stateError ? `${stateError}; ` : ""}write: ${messageOf(e)}`;
  }
  // A cursor that cannot be persisted IS the B5-10 defect returning: every run would restart at
  // the top of the slug list and the tail would starve again, silently and indefinitely. So it
  // is a failed step, not a warning — the sweep still ran, but the invocation goes red.
  if (stateError) {
    report.failures.sweepState = stateError;
    report.complete = false;
  }

  const failed = Object.entries(report.failures);
  if (failed.length > 0) {
    throw new Error(
      `scheduled maintenance: ${failed.length} step(s) failed — ` +
        failed.map(([name, message]) => `${name}: ${message}`).join("; ") +
        remainderSuffix(report),
    );
  }
  return report;
}

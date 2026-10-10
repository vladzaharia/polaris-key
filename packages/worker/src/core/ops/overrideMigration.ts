/**
 * The licence-override migration (U-03; notes/S-17 §5.12 steps 1–5, decisions 3, 4, 20 and 21):
 * one platform-wide run that moves every owned licence's config and secret overrides onto its
 * owner's account override row and drops every unowned licence's, with an inventory before it, a
 * notice, and a 90-day report after it.
 *
 * ── THE STATE MACHINE (one row, `override_migration`) ───────────────────────────────────────
 *
 *   1. prerequisites  an operator flags the login card (I-07) and the portal Library with Activate
 *                     License (I-11) live in production. Both are owner facts about production;
 *                     nothing here can observe them, so they are flags, set by hand.
 *   2. notice         refused until both flags are set (decision 21: customers must be able to act
 *                     on it). Starting it fixes the earliest run: notice + 30 days. The console
 *                     shows the inventory, the run date and the count to be dropped throughout.
 *   3. run            refused before `run_not_before`, and it needs the operator's step-up (the
 *                     route's). From its start, PUT /licenses/<id>/overrides refuses config and
 *                     secrets (step 4, `licenseConfigFrozen`); the run then processes product by
 *                     product, resumably, and from its completion `core/licensing/payload.ts` stops reading
 *                     the licence's config and secrets (step 5, `licenseConfigRetired`).
 *   4. afterwards     the report is kept 90 days; then the nightly sweep empties the licences'
 *                     config and secrets columns (step 5), keeping their entitlements.
 *
 * Nothing runs by itself: the production run is the owner's to schedule (docs/RUNBOOK.md,
 * "Licence override migration"). Until then the layer reads both sources and every document is
 * byte-identical to before (the account layer is empty until an operator writes one).
 *
 * ── WHAT THE RUN DOES PER LICENCE ───────────────────────────────────────────────────────────
 *
 *   - owned (`account_id` set): its config and secrets are merged into the owner's row for the
 *     product, sealed values copied as they are (same product, same key, same AAD), any plaintext
 *     secret sealed on the way. Several licences of one product on one account collapse: a key on
 *     one licence is kept; for a key on several, a value already on the account row wins (devices
 *     already received it: the account layer sits above the licence's), else the value from the
 *     licence whose config and secret overrides were updated most recently. Every lost value is
 *     listed in the report (secrets by name only), and the row says `collapsed`.
 *   - unowned (no account, floating or waiting on its email): dropped, with an audit row each.
 *
 * Nothing reads a secret's plaintext, ever: not the inventory, not the dry run, not the report.
 * A value reaches the report only when the active catalog positively declares the key a
 * non-secret `config` key and the stored value is not a sealed envelope (fail closed, as
 * `redactPayload` does).
 *
 * ── THE ACCOUNT ID STAYS INSIDE ─────────────────────────────────────────────────────────────
 *
 * The plan groups licences by account internally; every output (inventory, dry run, report, audit)
 * names the owner only by the product's pairwise subject (S-16 §5.1).
 */

import { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db, DbParam, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { randomId } from "../../platform/crypto.js";
import {
  auditStatement,
  getActiveSchema,
  listAllProductSlugs,
} from "../repo.js";
import { isSealedEnvelope, sealManagedValue } from "../managedSecrets.js";
import {
  existingSubjectFor,
  subjectForOrNull,
} from "../accounts/accountSubjects.js";
import {
  getAccountOverrides,
  parseAccountOverridePayload,
  type AccountOverridePayload,
} from "../accounts/accountOverrides.js";
import { parseJsonOr } from "../../platform/json.js";

/** Decision 21: the notice runs 30 days before the run. */
export const OVERRIDE_MIGRATION_NOTICE_DAYS = 30;
/** Decision 21: the report is kept 90 days. */
export const OVERRIDE_MIGRATION_REPORT_DAYS = 90;
const DAY = 86_400;
/** How long one run request holds the lease (seconds). */
const RUN_LEASE_SECONDS = 120;
/** Licences read per page while scanning a product. */
const SCAN_PAGE = 200;
/** Statements per D1 batch while applying a product (a unit is never split across batches). */
const BATCH_STATEMENTS = 90;
/** Licences whose columns one nightly tick empties after the report window. */
const EMPTY_PER_TICK = 500;
/** Expired report rows one nightly tick deletes. */
const PURGE_PER_TICK = 1_000;

// ── State ───────────────────────────────────────────────────────────────────────────────────

/** The two production facts the notice waits for (decision 21). */
export type OverrideMigrationPrerequisite = "loginCard" | "library";

export interface OverrideMigrationState {
  loginCardLiveAt: number | null;
  loginCardLiveBy: string | null;
  libraryLiveAt: number | null;
  libraryLiveBy: string | null;
  noticeStartedAt: number | null;
  noticeStartedBy: string | null;
  runNotBefore: number | null;
  runId: string | null;
  runStartedAt: number | null;
  runStartedBy: string | null;
  runCompletedAt: number | null;
  productsDone: string[];
  runLeaseUntil: number | null;
  inventory: OverrideInventorySummary | null;
  inventoryComputedAt: number | null;
  columnsEmptiedAt: number | null;
}

interface StateRow {
  login_card_live_at: number | null;
  login_card_live_by: string | null;
  library_live_at: number | null;
  library_live_by: string | null;
  notice_started_at: number | null;
  notice_started_by: string | null;
  run_not_before: number | null;
  run_id: string | null;
  run_started_at: number | null;
  run_started_by: string | null;
  run_completed_at: number | null;
  products_done_json: string | null;
  run_lease_until: number | null;
  run_lease_holder: string | null;
  inventory_json: string | null;
  inventory_computed_at: number | null;
  columns_emptied_at: number | null;
}

/** The migration's state; every field null (nothing started) when the row was never written. */
export async function readOverrideMigrationState(
  db: Db,
): Promise<OverrideMigrationState> {
  const r = await db.first<StateRow>(
    "SELECT * FROM override_migration WHERE id = 'platform'",
  );
  const done = parseJsonOr<unknown>(r?.products_done_json ?? null, []);
  return {
    loginCardLiveAt: r?.login_card_live_at ?? null,
    loginCardLiveBy: r?.login_card_live_by ?? null,
    libraryLiveAt: r?.library_live_at ?? null,
    libraryLiveBy: r?.library_live_by ?? null,
    noticeStartedAt: r?.notice_started_at ?? null,
    noticeStartedBy: r?.notice_started_by ?? null,
    runNotBefore: r?.run_not_before ?? null,
    runId: r?.run_id ?? null,
    runStartedAt: r?.run_started_at ?? null,
    runStartedBy: r?.run_started_by ?? null,
    runCompletedAt: r?.run_completed_at ?? null,
    productsDone: Array.isArray(done)
      ? done.filter((p): p is string => typeof p === "string")
      : [],
    runLeaseUntil: r?.run_lease_until ?? null,
    inventory: parseJsonOr<OverrideInventorySummary | null>(
      r?.inventory_json ?? null,
      null,
    ),
    inventoryComputedAt: r?.inventory_computed_at ?? null,
    columnsEmptiedAt: r?.columns_emptied_at ?? null,
  };
}

/** Step 4: from the run's start, licence config and secrets take no writes. */
export function licenseConfigFrozen(
  state: Pick<OverrideMigrationState, "runStartedAt">,
): boolean {
  return state.runStartedAt !== null;
}

/** Step 5: from the run's completion, documents stop reading licence config and secrets. */
export function licenseConfigRetired(
  state: Pick<OverrideMigrationState, "runCompletedAt">,
): boolean {
  return state.runCompletedAt !== null;
}

/**
 * {@link licenseConfigFrozen} as a SQL condition that holds while licence config and secrets are
 * still writable (the run has not started). License's override route writes config and secrets
 * under it, so its freeze check and its write are one statement: a run that starts between the
 * route's read and its write makes the write apply to nothing.
 */
export const LICENSE_CONFIG_WRITABLE_SQL =
  "NOT EXISTS (SELECT 1 FROM override_migration WHERE id = 'platform' AND run_started_at IS NOT NULL)";

/** {@link licenseConfigFrozen}, as one indexed read (License's override route). */
export async function licenseConfigOverridesFrozen(db: Db): Promise<boolean> {
  const r = await db.first<{ run_started_at: number | null }>(
    "SELECT run_started_at FROM override_migration WHERE id = 'platform'",
  );
  return (r?.run_started_at ?? null) !== null;
}

/** {@link licenseConfigRetired}, as one indexed read (the document hot path). */
export async function licenseConfigOverridesRetired(db: Db): Promise<boolean> {
  const r = await db.first<{ run_completed_at: number | null }>(
    "SELECT run_completed_at FROM override_migration WHERE id = 'platform'",
  );
  return (r?.run_completed_at ?? null) !== null;
}

async function ensureStateRow(db: Db, now: number): Promise<void> {
  await db.run(
    "INSERT OR IGNORE INTO override_migration (id, updated_at) VALUES ('platform', ?)",
    now,
  );
}

/** Who did it: the verified console session, never a request field. */
export interface MigrationActor {
  sub: string;
  name: string | null;
  email: string | null;
}

/**
 * Flag (or unflag) a prerequisite. Unflagging is refused once the notice has started: the notice
 * window is counted from both being live, so withdrawing one means withdrawing the notice first.
 */
export async function setOverrideMigrationPrerequisite(
  db: Db,
  which: OverrideMigrationPrerequisite,
  live: boolean,
  actor: MigrationActor,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: "notice_started" }> {
  await ensureStateRow(db, now);
  const [at, by] =
    which === "loginCard"
      ? ["login_card_live_at", "login_card_live_by"]
      : ["library_live_at", "library_live_by"];
  if (live) {
    // Idempotent: the first flag's time stands.
    await db.run(
      `UPDATE override_migration SET ${at} = COALESCE(${at}, ?), ${by} = COALESCE(${by}, ?),
         updated_at = ? WHERE id = 'platform'`,
      now,
      actor.sub,
      now,
    );
    return { ok: true };
  }
  const changes = await db.runChanges(
    `UPDATE override_migration SET ${at} = NULL, ${by} = NULL, updated_at = ?
      WHERE id = 'platform' AND notice_started_at IS NULL`,
    now,
  );
  return changes > 0 ? { ok: true } : { ok: false, reason: "notice_started" };
}

export type StartNoticeRefusal =
  | "prerequisites_missing"
  | "notice_started"
  | "run_started";

/**
 * Start the notice (S-17 §5.12 step 1). THE guard of decision 21: the conditional UPDATE writes
 * nothing unless the login card and the Library are both flagged live, so no caller can start a
 * notice early by skipping a check.
 */
export async function startOverrideMigrationNotice(
  db: Db,
  actor: MigrationActor,
  now: number,
): Promise<
  | { ok: true; noticeStartedAt: number; runNotBefore: number }
  | {
      ok: false;
      reason: StartNoticeRefusal;
      missing?: OverrideMigrationPrerequisite[];
    }
> {
  await ensureStateRow(db, now);
  const runNotBefore = now + OVERRIDE_MIGRATION_NOTICE_DAYS * DAY;
  const changes = await db.runChanges(
    `UPDATE override_migration
        SET notice_started_at = ?, notice_started_by = ?, run_not_before = ?, updated_at = ?
      WHERE id = 'platform'
        AND login_card_live_at IS NOT NULL AND library_live_at IS NOT NULL
        AND notice_started_at IS NULL AND run_started_at IS NULL`,
    now,
    actor.sub,
    runNotBefore,
    now,
  );
  if (changes > 0) return { ok: true, noticeStartedAt: now, runNotBefore };
  const s = await readOverrideMigrationState(db);
  if (s.runStartedAt !== null) return { ok: false, reason: "run_started" };
  if (s.noticeStartedAt !== null)
    return { ok: false, reason: "notice_started" };
  const missing: OverrideMigrationPrerequisite[] = [];
  if (s.loginCardLiveAt === null) missing.push("loginCard");
  if (s.libraryLiveAt === null) missing.push("library");
  return { ok: false, reason: "prerequisites_missing", missing };
}

/** Withdraw the notice (before the run only): a later notice starts a fresh 30 days. */
export async function withdrawOverrideMigrationNotice(
  db: Db,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: "run_started" }> {
  await ensureStateRow(db, now);
  const changes = await db.runChanges(
    `UPDATE override_migration
        SET notice_started_at = NULL, notice_started_by = NULL, run_not_before = NULL,
            updated_at = ?
      WHERE id = 'platform' AND run_started_at IS NULL`,
    now,
  );
  return changes > 0 ? { ok: true } : { ok: false, reason: "run_started" };
}

// ── Inventory ───────────────────────────────────────────────────────────────────────────────

/** One licence carrying config or secret overrides. INTERNAL: carries the account id. */
interface ScannedLicence {
  product: string;
  licenseId: string;
  accountId: string | null;
  email: string | null;
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
  /** The latest `updatedAt` over its config and secret entries, else the row's `modified_at`. */
  lastUpdatedAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function bucketOf(
  parsed: Record<string, unknown>,
  name: "config" | "secrets",
): Record<string, ManagedEntry> {
  const raw = parsed[name];
  return isRecord(raw) ? (raw as Record<string, ManagedEntry>) : {};
}

/** Every licence of `product` whose overrides carry a config or secret key, in id order. */
async function scanProduct(db: Db, product: string): Promise<ScannedLicence[]> {
  const out: ScannedLicence[] = [];
  let after = "";
  for (;;) {
    const rows = await db.all<{
      id: string;
      account_id: string | null;
      email: string | null;
      overrides_json: string;
      modified_at: number;
    }>(
      // `json_each` over each bucket is the prefilter (a licence with only entitlements, or
      // with empty buckets, never leaves SQLite); the JS check below is the decision.
      `SELECT id, account_id, email, overrides_json, modified_at FROM licenses
        WHERE product = ? AND id > ? AND overrides_json IS NOT NULL AND json_valid(overrides_json)
          AND (EXISTS (SELECT 1 FROM json_each(overrides_json, '$.config'))
            OR EXISTS (SELECT 1 FROM json_each(overrides_json, '$.secrets')))
        ORDER BY id LIMIT ?`,
      product,
      after,
      SCAN_PAGE,
    );
    for (const r of rows) {
      const parsed = parseJsonOr<unknown>(r.overrides_json, null);
      if (!isRecord(parsed)) continue;
      const config = bucketOf(parsed, "config");
      const secrets = bucketOf(parsed, "secrets");
      const entries = [...Object.values(config), ...Object.values(secrets)];
      if (entries.length === 0) continue;
      const stamps = entries
        .map((e) => (isRecord(e) ? Number(e.updatedAt) : NaN))
        .filter((n) => Number.isFinite(n));
      out.push({
        product,
        licenseId: r.id,
        accountId: r.account_id ?? null,
        email: r.email !== null && !/^ *$/.test(r.email) ? r.email : null,
        config,
        secrets,
        lastUpdatedAt: stamps.length > 0 ? Math.max(...stamps) : r.modified_at,
      });
    }
    if (rows.length < SCAN_PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return out;
}

/** One product's counts (what the console shows before the run). */
export interface ProductOverrideInventory {
  product: string;
  /** Licences carrying config or secret overrides. */
  licences: number;
  /** …of which owned (moved to the owner's account override at the run). */
  owned: number;
  /** …of which unowned (dropped at the run). */
  dropped: number;
  /** Accounts holding several such licences of the product (their values collapse). */
  collapsingAccounts: number;
}

export interface OverrideInventorySummary {
  computedAt: number;
  products: ProductOverrideInventory[];
  totals: { licences: number; owned: number; dropped: number };
}

/** One licence in a product's inventory, as the console lists it (no account id, no values). */
export interface InventoryLicence {
  licenseId: string;
  owned: boolean;
  /** The owner's subject when one exists yet (it is created at the run otherwise). */
  ownerSubject: string | null;
  buyerEmail: string | null;
  configKeys: string[];
  secretKeys: string[];
  lastUpdatedAt: number;
}

function countProduct(
  product: string,
  scanned: ScannedLicence[],
): ProductOverrideInventory {
  const perAccount = new Map<string, number>();
  let owned = 0;
  for (const l of scanned) {
    if (l.accountId === null) continue;
    owned++;
    perAccount.set(l.accountId, (perAccount.get(l.accountId) ?? 0) + 1);
  }
  return {
    product,
    licences: scanned.length,
    owned,
    dropped: scanned.length - owned,
    collapsingAccounts: [...perAccount.values()].filter((n) => n > 1).length,
  };
}

/** The platform inventory (counts per product with at least one such licence). */
export async function computeOverrideInventory(
  db: Db,
  now: number,
): Promise<OverrideInventorySummary> {
  const products: ProductOverrideInventory[] = [];
  for (const slug of await listAllProductSlugs(db)) {
    const scanned = await scanProduct(db, slug);
    if (scanned.length > 0) products.push(countProduct(slug, scanned));
  }
  return {
    computedAt: now,
    products,
    totals: {
      licences: products.reduce((n, p) => n + p.licences, 0),
      owned: products.reduce((n, p) => n + p.owned, 0),
      dropped: products.reduce((n, p) => n + p.dropped, 0),
    },
  };
}

/** One product's licence list for the console (read-only; no account id, no values). */
export async function productOverrideInventory(
  db: Db,
  product: string,
): Promise<{ counts: ProductOverrideInventory; licences: InventoryLicence[] }> {
  const scanned = await scanProduct(db, product);
  const subjects = new Map<string, string | null>();
  for (const l of scanned) {
    if (l.accountId === null || subjects.has(l.accountId)) continue;
    subjects.set(
      l.accountId,
      await existingSubjectFor(db, l.accountId, product),
    );
  }
  return {
    counts: countProduct(product, scanned),
    licences: scanned.map((l) => ({
      licenseId: l.licenseId,
      owned: l.accountId !== null,
      ownerSubject:
        l.accountId === null ? null : (subjects.get(l.accountId) ?? null),
      buyerEmail: l.email,
      configKeys: Object.keys(l.config).sort(),
      secretKeys: Object.keys(l.secrets).sort(),
      lastUpdatedAt: l.lastUpdatedAt,
    })),
  };
}

/** Recompute the stored inventory (the nightly job; the console reads the snapshot). */
export async function refreshOverrideInventory(
  db: Db,
  now: number,
): Promise<OverrideInventorySummary> {
  await ensureStateRow(db, now);
  const inventory = await computeOverrideInventory(db, now);
  await db.run(
    `UPDATE override_migration SET inventory_json = ?, inventory_computed_at = ?, updated_at = ?
      WHERE id = 'platform'`,
    JSON.stringify(inventory),
    now,
    now,
  );
  return inventory;
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────

export type ReportOutcome = "moved" | "collapsed" | "dropped";

/** One lost value of a collapse. `kept` / `lost` are present only for a reportable value. */
export interface CollapseEntry {
  bucket: "config" | "secrets";
  key: string;
  /** The licence id whose value won, or `"account"` for a value already on the account row. */
  keptFrom: string;
  kept?: unknown;
  lost?: unknown;
}

/** A report row as the run writes it (and the dry run returns it). */
export interface OverrideReportRow {
  product: string;
  licenseId: string;
  outcome: ReportOutcome;
  /** The owner's subject (moved, collapsed); null when dropped, or in a dry run when the owner
   *  has no subject for the product yet (`subjectCreatedAtRun`). */
  subject: string | null;
  subjectCreatedAtRun?: true;
  buyerEmail: string | null;
  keys: { config: string[]; secrets: string[] };
  values: { config?: Record<string, unknown>; collapsed?: CollapseEntry[] };
}

/** One account's share of a product's plan. INTERNAL: holds the account id. */
interface AccountUnit {
  accountId: string;
  subject: string | null;
  /** The account row as read when planning (`null` = none). */
  existingJson: string | null;
  payload: AccountOverridePayload;
  rows: OverrideReportRow[];
}

interface ProductPlan {
  product: string;
  accounts: AccountUnit[];
  dropped: OverrideReportRow[];
}

/**
 * May this value appear in the report? Only a non-secret `config` value the active catalog
 * positively declares, and never a sealed envelope. Everything else is listed by name only.
 */
function reportable(
  catalog: Catalog | null,
  bucket: "config" | "secrets",
  key: string,
  value: unknown,
): boolean {
  if (bucket !== "config" || !catalog || isSealedEnvelope(value)) return false;
  const entry = catalog.entryByKey(key);
  return !!entry && entry.kind === "config" && entry.secret !== true;
}

function reportableConfig(
  catalog: Catalog | null,
  config: Record<string, ManagedEntry>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(config)) {
    const value = isRecord(entry) ? entry.value : undefined;
    if (reportable(catalog, "config", key, value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const sameEntry = (a: ManagedEntry, b: ManagedEntry): boolean =>
  JSON.stringify([a?.state, a?.value]) === JSON.stringify([b?.state, b?.value]);

async function loadCatalogFor(
  db: Db,
  product: string,
): Promise<Catalog | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json));
  } catch {
    return null;
  }
}

/** Plan one product. Reads only. */
async function planProduct(
  db: Db,
  product: string,
  catalog: Catalog | null,
): Promise<ProductPlan> {
  const scanned = await scanProduct(db, product);
  const byAccount = new Map<string, ScannedLicence[]>();
  const dropped: OverrideReportRow[] = [];
  for (const l of scanned) {
    const keys = {
      config: Object.keys(l.config).sort(),
      secrets: Object.keys(l.secrets).sort(),
    };
    if (l.accountId === null) {
      const config = reportableConfig(catalog, l.config);
      dropped.push({
        product,
        licenseId: l.licenseId,
        outcome: "dropped",
        subject: null,
        buyerEmail: l.email,
        keys,
        values: config ? { config } : {},
      });
      continue;
    }
    const list = byAccount.get(l.accountId) ?? [];
    list.push(l);
    byAccount.set(l.accountId, list);
  }

  const accounts: AccountUnit[] = [];
  for (const [accountId, licences] of byAccount) {
    // Most recently updated first; ties by licence id, so the plan is deterministic.
    licences.sort(
      (a, b) =>
        b.lastUpdatedAt - a.lastUpdatedAt ||
        (a.licenseId < b.licenseId ? -1 : a.licenseId > b.licenseId ? 1 : 0),
    );
    const subject = await existingSubjectFor(db, accountId, product);
    const existingRow = subject
      ? await getAccountOverrides(db, product, subject)
      : null;
    const existing = parseAccountOverridePayload(
      existingRow?.payload_json ?? null,
    );
    const payload: AccountOverridePayload = {
      config: { ...existing.config },
      secrets: { ...existing.secrets },
    };
    const losses = new Map<string, CollapseEntry[]>();
    for (const bucket of ["config", "secrets"] as const) {
      const keys = new Set(licences.flatMap((l) => Object.keys(l[bucket])));
      for (const key of [...keys].sort()) {
        const holders = licences.filter((l) => key in l[bucket]);
        const fromAccount = existing[bucket][key];
        const winner = fromAccount ?? holders[0]![bucket][key]!;
        const keptFrom = fromAccount ? "account" : holders[0]!.licenseId;
        payload[bucket][key] = winner;
        for (const h of holders) {
          const entry = h[bucket][key]!;
          if (sameEntry(entry, winner)) continue;
          const show =
            reportable(catalog, bucket, key, winner?.value) &&
            reportable(catalog, bucket, key, entry?.value);
          const list = losses.get(h.licenseId) ?? [];
          list.push({
            bucket,
            key,
            keptFrom,
            ...(show ? { kept: winner.value, lost: entry.value } : {}),
          });
          losses.set(h.licenseId, list);
        }
      }
    }
    const rows: OverrideReportRow[] = licences.map((l) => {
      const collapsed = losses.get(l.licenseId);
      const config = reportableConfig(catalog, l.config);
      return {
        product,
        licenseId: l.licenseId,
        outcome: collapsed ? "collapsed" : "moved",
        subject,
        ...(subject === null ? { subjectCreatedAtRun: true as const } : {}),
        buyerEmail: l.email,
        keys: {
          config: Object.keys(l.config).sort(),
          secrets: Object.keys(l.secrets).sort(),
        },
        values: {
          ...(config ? { config } : {}),
          ...(collapsed ? { collapsed } : {}),
        },
      };
    });
    accounts.push({
      accountId,
      subject,
      existingJson: existingRow?.payload_json ?? null,
      payload,
      rows,
    });
  }
  return { product, accounts, dropped };
}

/** What the dry run answers: the inventory and the report the run would write, nothing written. */
export interface OverrideMigrationDryRun {
  computedAt: number;
  inventory: OverrideInventorySummary;
  report: OverrideReportRow[];
}

/**
 * The dry run (S-17 §5.12, the gate "dry run on a production-shaped copy"): the inventory and
 * every report row the run would write, for every product or one. It writes NOTHING (not even an
 * owner's subject: an owner with none is reported with `subjectCreatedAtRun`) and reads no
 * secret's plaintext, so it is safe on a production copy without the KEK.
 */
export async function dryRunOverrideMigration(
  db: Db,
  now: number,
  opts: { product?: string } = {},
): Promise<OverrideMigrationDryRun> {
  const slugs =
    opts.product !== undefined
      ? (await listAllProductSlugs(db)).filter((s) => s === opts.product)
      : await listAllProductSlugs(db);
  const report: OverrideReportRow[] = [];
  const products: ProductOverrideInventory[] = [];
  for (const slug of slugs) {
    const plan = await planProduct(db, slug, await loadCatalogFor(db, slug));
    const rows = [...plan.accounts.flatMap((a) => a.rows), ...plan.dropped];
    if (rows.length === 0) continue;
    rows.sort((a, b) => (a.licenseId < b.licenseId ? -1 : 1));
    report.push(...rows);
    products.push({
      product: slug,
      licences: rows.length,
      owned: rows.length - plan.dropped.length,
      dropped: plan.dropped.length,
      collapsingAccounts: plan.accounts.filter((a) => a.rows.length > 1).length,
    });
  }
  return {
    computedAt: now,
    inventory: {
      computedAt: now,
      products,
      totals: {
        licences: products.reduce((n, p) => n + p.licences, 0),
        owned: products.reduce((n, p) => n + p.owned, 0),
        dropped: products.reduce((n, p) => n + p.dropped, 0),
      },
    },
    report,
  };
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────

export type RunRefusal =
  | "notice_not_started"
  | "notice_window"
  | "run_completed"
  | "run_in_progress";

export interface RunProgress {
  runId: string;
  done: boolean;
  completedAt: number | null;
  productsDone: string[];
  productsRemaining: string[];
  /** This request's work: report rows written, by outcome. */
  written: Record<ReportOutcome, number>;
  /**
   * Accounts whose row changed between the plan and its write in this request and were still
   * changing after every re-plan: their product is left undone, and the next call re-plans it.
   */
  conflicts: number;
}

/** A boolean SQL condition a statement of the run is written under (`landed`). */
interface Guard {
  sql: string;
  params: DbParam[];
}

/** `INSERT … VALUES (…)` as `INSERT … SELECT … WHERE <guard>` (the statement applies only then). */
function guarded(stmt: DbStatement, guard: Guard | null): DbStatement {
  if (!guard) return stmt;
  const VALUES = /VALUES \(([^)]*)\)\s*$/;
  if (!VALUES.test(stmt.sql))
    throw new Error("guarded: the INSERT no longer ends in VALUES (…)");
  return {
    sql: stmt.sql.replace(
      VALUES,
      (_m, marks: string) => `SELECT ${marks} WHERE ${guard.sql}`,
    ),
    params: [...stmt.params, ...guard.params],
  };
}

function reportStatement(
  runId: string,
  row: OverrideReportRow,
  subject: string | null,
  now: number,
  guard: Guard | null = null,
): DbStatement {
  return guarded(
    {
      // OR IGNORE: a resumed run never rewrites a row an earlier request committed.
      sql: `INSERT OR IGNORE INTO override_migration_report
            (product, run_id, license_id, outcome, subject, buyer_email, keys_json, values_json,
             created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.product,
        runId,
        row.licenseId,
        row.outcome,
        subject,
        row.buyerEmail,
        JSON.stringify(row.keys),
        JSON.stringify(row.values),
        now,
        now + OVERRIDE_MIGRATION_REPORT_DAYS * DAY,
      ],
    },
    guard,
  );
}

function keyList(keys: { config: string[]; secrets: string[] }): string {
  const all = [...keys.config, ...keys.secrets];
  return all.length > 6
    ? `${all.slice(0, 6).join(", ")} and ${all.length - 6} more`
    : all.join(", ");
}

function auditFor(
  runId: string,
  actor: MigrationActor,
  row: OverrideReportRow,
  subject: string | null,
  now: number,
  guard: Guard | null = null,
): DbStatement {
  const summary =
    row.outcome === "dropped"
      ? `Dropped this license's config and secret overrides at the migration (no account): ${keyList(row.keys)}`
      : `Moved this license's config and secret overrides to ${subject}'s account overrides${row.outcome === "collapsed" ? `; ${row.values.collapsed?.length ?? 0} value(s) lost to another license` : ""}`;
  // A deterministic id per (run, licence) and OR IGNORE, so a stale lease holder that
  // re-applies a unit adds no second audit row.
  const stmt = auditStatement({
    product: row.product,
    id: `aud_om_${runId}_${row.licenseId}`,
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
    action:
      row.outcome === "dropped"
        ? "license.overrides.dropped"
        : "license.overrides.migrated",
    target_kind: "license",
    target_id: row.licenseId,
    parent_id: null,
    summary,
  });
  return guarded(
    { ...stmt, sql: stmt.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") },
    guard,
  );
}

/** Seal any secret value still stored in plaintext (a legacy row), so the account row holds none. */
async function sealPayload(
  env: Env,
  product: string,
  catalog: Catalog | null,
  payload: AccountOverridePayload,
): Promise<AccountOverridePayload> {
  const out: AccountOverridePayload = {
    config: { ...payload.config },
    secrets: { ...payload.secrets },
  };
  for (const [key, entry] of Object.entries(out.secrets)) {
    if (!isSealedEnvelope(entry.value) && entry.value != null)
      out.secrets[key] = {
        ...entry,
        value: (await sealManagedValue(
          env,
          product,
          key,
          entry.value,
        )) as ManagedEntry["value"],
      };
  }
  for (const [key, entry] of Object.entries(out.config)) {
    const meta = catalog?.entryByKey(key);
    if (
      meta?.secret === true &&
      !isSealedEnvelope(entry.value) &&
      entry.value != null
    )
      out.config[key] = {
        ...entry,
        value: (await sealManagedValue(
          env,
          product,
          key,
          entry.value,
        )) as ManagedEntry["value"],
      };
  }
  return out;
}

async function reportedLicences(
  db: Db,
  product: string,
  runId: string,
): Promise<Set<string>> {
  const rows = await db.all<{ license_id: string }>(
    "SELECT license_id FROM override_migration_report WHERE product = ? AND run_id = ?",
    product,
    runId,
  );
  return new Set(rows.map((r) => r.license_id));
}

/** How many times one call re-plans a product whose account rows changed under it. */
const REPLAN_ATTEMPTS = 3;

/**
 * The account row write, as a compare-and-set on the row the plan read (`existingJson`, `null` =
 * no row): an operator's edit, an OIDC sign-in or a merge that lands between the plan and the
 * write makes it write nothing, and the unit is re-planned on top of that edit.
 */
function accountWrite(
  product: string,
  subject: string,
  existingJson: string | null,
  json: string,
  now: number,
): DbStatement {
  return existingJson === null
    ? {
        sql: `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
              SELECT ?, ?, ?, ?, 'migration'
               WHERE NOT EXISTS (SELECT 1 FROM account_overrides WHERE product = ? AND subject = ?)`,
        params: [product, subject, json, now, product, subject],
      }
    : {
        sql: `UPDATE account_overrides SET payload_json = ?, updated_at = ?, updated_by = 'migration'
               WHERE product = ? AND subject = ? AND payload_json = ?`,
        params: [json, now, product, subject, existingJson],
      };
}

/** The unit's write applied: the row holds exactly what it wrote. Its report and audit rows are
 *  written under this condition, so a unit whose write did not apply leaves no trace. */
function landed(product: string, subject: string, json: string): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM account_overrides WHERE product = ? AND subject = ? AND payload_json = ?)",
    params: [product, subject, json],
  };
}

interface Unit {
  stmts: DbStatement[];
  rows: OverrideReportRow[];
  /** The compare-and-set, checked after the batch; absent for a dropped licence. */
  check?: { product: string; subject: string; json: string };
}

/** Run the units in batches (a unit never split across batches); answers the ones that applied. */
async function runUnits(db: Db, units: Unit[]): Promise<Unit[]> {
  const applied: Unit[] = [];
  let batch: Unit[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const stmts = batch.flatMap((u) => u.stmts);
    const changes = db.batchChanges
      ? await db.batchChanges(stmts)
      : (await db.batch(stmts), null);
    let at = 0;
    for (const u of batch) {
      let ok = true;
      if (u.check) {
        ok =
          changes !== null
            ? changes[at]! > 0
            : (
                await db.first<{ payload_json: string }>(
                  "SELECT payload_json FROM account_overrides WHERE product = ? AND subject = ?",
                  u.check.product,
                  u.check.subject,
                )
              )?.payload_json === u.check.json;
      }
      if (ok) applied.push(u);
      at += u.stmts.length;
    }
    batch = [];
  };
  let size = 0;
  for (const unit of units) {
    if (size > 0 && size + unit.stmts.length > BATCH_STATEMENTS) {
      await flush();
      size = 0;
    }
    batch.push(unit);
    size += unit.stmts.length;
  }
  await flush();
  return applied;
}

/**
 * Apply one product's plan, unit by unit: an account's row with its licences' report and audit
 * rows (guarded on the row's compare-and-set), or one dropped licence. A unit whose account row
 * changed under it is re-planned, up to {@link REPLAN_ATTEMPTS} times; the product is marked done
 * only once every unit applied, so a call that gives up leaves it to the next one.
 */
async function applyProduct(
  env: Env,
  db: Db,
  product: string,
  runId: string,
  actor: MigrationActor,
  now: number,
): Promise<{ written: Record<ReportOutcome, number>; conflicts: number }> {
  const written: Record<ReportOutcome, number> = {
    moved: 0,
    collapsed: 0,
    dropped: 0,
  };
  const catalog = await loadCatalogFor(db, product);
  let conflicts = 0;
  for (let attempt = 0; attempt < REPLAN_ATTEMPTS; attempt++) {
    const plan = await planProduct(db, product, catalog);
    const already = await reportedLicences(db, product, runId);
    const units: Unit[] = [];
    for (const unit of plan.accounts) {
      const todo = unit.rows.filter((r) => !already.has(r.licenseId));
      if (todo.length === 0) continue;
      const subject =
        unit.subject ??
        (await subjectForOrNull(db, unit.accountId, product, now));
      // An account being erased is skipped (SEC-WP-04); it has no override rows to move.
      if (subject === null) continue;
      // An owner whose subject the plan did not know has no row (rows exist only for subjects).
      const existingJson = unit.subject === null ? null : unit.existingJson;
      const payload = await sealPayload(env, product, catalog, unit.payload);
      const json = JSON.stringify({
        config: payload.config,
        secrets: payload.secrets,
      });
      const guard = landed(product, subject, json);
      units.push({
        stmts: [
          accountWrite(product, subject, existingJson, json, now),
          ...todo.flatMap((r) => [
            reportStatement(runId, r, subject, now, guard),
            auditFor(runId, actor, r, subject, now, guard),
          ]),
        ],
        rows: todo,
        check: { product, subject, json },
      });
    }
    for (const r of plan.dropped) {
      if (already.has(r.licenseId)) continue;
      units.push({
        stmts: [
          reportStatement(runId, r, null, now),
          auditFor(runId, actor, r, null, now),
        ],
        rows: [r],
      });
    }
    const applied = await runUnits(db, units);
    for (const u of applied) for (const r of u.rows) written[r.outcome]++;
    conflicts = units.length - applied.length;
    if (conflicts === 0) break;
  }
  if (conflicts > 0) return { written, conflicts };
  await db.run(
    `UPDATE override_migration
        SET products_done_json = json_insert(COALESCE(products_done_json, '[]'), '$[#]', ?),
            updated_at = ?
      WHERE id = 'platform' AND run_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(products_done_json, '[]')) WHERE value = ?)`,
    product,
    now,
    runId,
    product,
  );
  return { written, conflicts: 0 };
}

/**
 * Start the run, or continue it (S-17 §5.12 steps 2–5). Refused before the notice window ends and
 * after completion; the route adds the operator's step-up. Each call processes at most
 * `maxProducts` products under a short lease, so a large platform finishes over several calls and
 * a call that dies part-way resumes exactly (report rows are the per-licence progress marker).
 */
export async function runOverrideMigration(
  env: Env,
  db: Db,
  actor: MigrationActor,
  now: number,
  opts: {
    maxProducts?: number;
    /** Epoch seconds for the lease (tests); defaults to the later of `now` and the wall clock. */
    clock?: () => number;
  } = {},
): Promise<
  | { ok: true; progress: RunProgress }
  | { ok: false; reason: RunRefusal; runNotBefore?: number | null }
> {
  await ensureStateRow(db, now);
  let state = await readOverrideMigrationState(db);
  if (state.runCompletedAt !== null)
    return { ok: false, reason: "run_completed" };
  if (state.noticeStartedAt === null || state.runNotBefore === null)
    return { ok: false, reason: "notice_not_started" };
  if (now < state.runNotBefore)
    return {
      ok: false,
      reason: "notice_window",
      runNotBefore: state.runNotBefore,
    };
  if (state.runId === null) {
    // Step 4 starts here: from this write on, licence config and secrets are frozen.
    await db.run(
      `UPDATE override_migration
          SET run_id = ?, run_started_at = ?, run_started_by = ?, products_done_json = '[]',
              updated_at = ?
        WHERE id = 'platform' AND run_id IS NULL AND notice_started_at IS NOT NULL
          AND run_not_before <= ?`,
      randomId("ovm"),
      now,
      actor.sub,
      now,
      now,
    );
    state = await readOverrideMigrationState(db);
    if (state.runId === null)
      return { ok: false, reason: "notice_not_started" };
  }
  const runId = state.runId!;
  // The lease: one holder at a time, renewed before every product, cleared only by its holder.
  const holder = randomId("ovl");
  const clock =
    opts.clock ?? (() => Math.max(now, Math.floor(Date.now() / 1000)));
  const leased = await db.runChanges(
    `UPDATE override_migration SET run_lease_until = ?, run_lease_holder = ?
      WHERE id = 'platform' AND (run_lease_until IS NULL OR run_lease_until <= ?)`,
    clock() + RUN_LEASE_SECONDS,
    holder,
    now,
  );
  if (leased === 0) return { ok: false, reason: "run_in_progress" };
  const written: Record<ReportOutcome, number> = {
    moved: 0,
    collapsed: 0,
    dropped: 0,
  };
  let conflicts = 0;
  try {
    const all = await listAllProductSlugs(db);
    const done = new Set(state.productsDone);
    const remaining = all.filter((s) => !done.has(s));
    const budget = Math.max(1, opts.maxProducts ?? 25);
    for (const product of remaining.slice(0, budget)) {
      const renewed = await db.runChanges(
        `UPDATE override_migration SET run_lease_until = ?
          WHERE id = 'platform' AND run_lease_holder = ?`,
        clock() + RUN_LEASE_SECONDS,
        holder,
      );
      // Lost the lease (it expired and another request took it): stop; that request continues.
      if (renewed === 0) break;
      const w = await applyProduct(env, db, product, runId, actor, now);
      written.moved += w.written.moved;
      written.collapsed += w.written.collapsed;
      written.dropped += w.written.dropped;
      conflicts += w.conflicts;
    }
    state = await readOverrideMigrationState(db);
    const doneNow = new Set(state.productsDone);
    const left = all.filter((s) => !doneNow.has(s));
    let completedAt: number | null = null;
    if (left.length === 0) {
      // Step 5 starts here: documents stop reading licence config and secrets.
      await db.run(
        `UPDATE override_migration SET run_completed_at = COALESCE(run_completed_at, ?), updated_at = ?
          WHERE id = 'platform' AND run_id = ?`,
        now,
        now,
        runId,
      );
      completedAt = (await readOverrideMigrationState(db)).runCompletedAt;
    }
    return {
      ok: true,
      progress: {
        runId,
        done: left.length === 0,
        completedAt,
        productsDone: [...doneNow].sort(),
        productsRemaining: left,
        written,
        conflicts,
      },
    };
  } finally {
    await db.run(
      `UPDATE override_migration SET run_lease_until = NULL, run_lease_holder = NULL
        WHERE id = 'platform' AND run_lease_holder = ?`,
      holder,
    );
  }
}

// ── The report ──────────────────────────────────────────────────────────────────────────────

export interface StoredReportRow {
  product: string;
  runId: string;
  licenseId: string;
  outcome: ReportOutcome;
  subject: string | null;
  buyerEmail: string | null;
  keys: { config: string[]; secrets: string[] };
  values: { config?: Record<string, unknown>; collapsed?: CollapseEntry[] };
  createdAt: number;
  expiresAt: number;
}

/** The live report rows (not yet expired), optionally for one product, in a stable order. */
export async function listOverrideMigrationReport(
  db: Db,
  now: number,
  opts: { product?: string } = {},
): Promise<StoredReportRow[]> {
  const rows = await db.all<{
    product: string;
    run_id: string;
    license_id: string;
    outcome: ReportOutcome;
    subject: string | null;
    buyer_email: string | null;
    keys_json: string;
    values_json: string;
    created_at: number;
    expires_at: number;
  }>(
    `SELECT product, run_id, license_id, outcome, subject, buyer_email, keys_json, values_json,
            created_at, expires_at
       FROM override_migration_report
      WHERE expires_at > ? ${opts.product !== undefined ? "AND product = ?" : ""}
      ORDER BY product, license_id`,
    now,
    ...(opts.product !== undefined ? [opts.product] : []),
  );
  return rows.map((r) => ({
    product: r.product,
    runId: r.run_id,
    licenseId: r.license_id,
    outcome: r.outcome,
    subject: r.subject,
    buyerEmail: r.buyer_email,
    keys: parseJsonOr(r.keys_json, { config: [], secrets: [] }),
    values: parseJsonOr(r.values_json, {}),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? ""
      : typeof v === "string"
        ? v
        : JSON.stringify(v);
  // A leading formula character is neutralised: a spreadsheet must never evaluate a stored value.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The report as CSV, one row per licence (the console's download). */
export function overrideMigrationReportCsv(rows: StoredReportRow[]): string {
  const head = [
    "product",
    "license_id",
    "outcome",
    "subject",
    "buyer_email",
    "config_keys",
    "secret_keys",
    "config_values",
    "collapsed",
    "run_id",
    "created_at",
    "expires_at",
  ];
  const lines = [head.join(",")];
  for (const r of rows)
    lines.push(
      [
        r.product,
        r.licenseId,
        r.outcome,
        r.subject,
        r.buyerEmail,
        r.keys.config.join(" "),
        r.keys.secrets.join(" "),
        r.values.config ?? "",
        r.values.collapsed ?? "",
        r.runId,
        new Date(r.createdAt * 1000).toISOString(),
        new Date(r.expiresAt * 1000).toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  return `${lines.join("\n")}\n`;
}

// ── Nightly ─────────────────────────────────────────────────────────────────────────────────

/**
 * The nightly step (`scheduled.ts`): recompute the inventory until the run completes (S-17: "the
 * count falls as customers attach"), delete report rows past 90 days, and once the report window
 * has passed, empty the licences' config and secrets columns (step 5), keeping entitlements.
 * Bounded per tick and idempotent. Answers how many rows it changed.
 */
export async function overrideMigrationNightly(
  db: Db,
  now: number,
): Promise<number> {
  await ensureStateRow(db, now);
  const state = await readOverrideMigrationState(db);
  let changed = 0;
  if (state.runCompletedAt === null) {
    await refreshOverrideInventory(db, now);
  }
  changed += await db.runChanges(
    `DELETE FROM override_migration_report WHERE rowid IN (
       SELECT rowid FROM override_migration_report WHERE expires_at <= ? LIMIT ?)`,
    now,
    PURGE_PER_TICK,
  );
  if (
    state.runCompletedAt !== null &&
    state.columnsEmptiedAt === null &&
    now >= state.runCompletedAt + OVERRIDE_MIGRATION_REPORT_DAYS * DAY
  ) {
    const rows = await db.all<{ product: string; id: string }>(
      `SELECT product, id FROM licenses
        WHERE overrides_json IS NOT NULL AND json_valid(overrides_json)
          AND (EXISTS (SELECT 1 FROM json_each(overrides_json, '$.config'))
            OR EXISTS (SELECT 1 FROM json_each(overrides_json, '$.secrets')))
        LIMIT ?`,
      EMPTY_PER_TICK,
    );
    for (let i = 0; i < rows.length; i += BATCH_STATEMENTS) {
      await db.batch(
        rows.slice(i, i + BATCH_STATEMENTS).map((r) => ({
          sql: `UPDATE licenses
                   SET overrides_json = json_set(overrides_json, '$.config', json('{}'), '$.secrets', json('{}'))
                 WHERE product = ? AND id = ?`,
          params: [r.product, r.id],
        })),
      );
    }
    changed += rows.length;
    if (rows.length < EMPTY_PER_TICK)
      await db.run(
        "UPDATE override_migration SET columns_emptied_at = ?, updated_at = ? WHERE id = 'platform'",
        now,
        now,
      );
  }
  return changed;
}

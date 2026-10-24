/**
 * LX-33.5: the P0-49 job `license.limits-materialise`.
 *
 * Release N of LX-33 moves every licence's limits onto "licence, else tier, else platform" without
 * changing a document or an enforced value. This job writes the data: it seeds each License
 * product's implicit Default tier, gives tierless licences that tier and copies onto a licence the
 * values the old chain derived from elsewhere. What to write is `limitsPlan.ts`'s decision (pure);
 * this file reads the rows for it, and applies its answer.
 *
 *   units   the License-enabled products (a product with License off has no licences to move).
 *   plan    reads only. Merged entitlements come from `prefetchedLayerSource`, once per page of
 *           licences. The detail is counts plus capped id lists, never a value.
 *   apply   re-plans from the rows as they are now, then writes in batches: the seed
 *           (`INSERT ... WHERE NOT EXISTS`), then per licence one `UPDATE` that compares-and-sets on
 *           the planned old values, with its ledger rows. A licence edited since the read fails the
 *           compare, is skipped and shows in the next dry run. `modified_at`, `modified_by` and
 *           `expires_at` are never written: the first is the stamped entries' `updatedAt`.
 *   down    restores from `license_limit_backfill`, a column only while it still holds the value the
 *           job wrote, and deletes the seeded tier once no licence references it.
 *
 * The ledger keeps the FIRST "before" for a (subject, field) (`INSERT OR IGNORE`), so a re-run
 * never overwrites the original. A ledger row is written in the same batch as the write it records,
 * and only if the row now holds the written value.
 *
 * The runner passes a job no run id, so ledger rows carry `lx33@<epoch seconds of the apply call>`.
 * Nothing starts this job but an operator's request; a deploy and the scheduled tick never do.
 */
import type { Db, DbParam, DbStatement } from "../../../db/types.js";
import type { MigrationJob } from "../../../core/migrate/job.js";
import { listProducts } from "../../../core/products/store.js";
import { serviceStateOf } from "../../../core/services.js";
import { resolveMergedPayload } from "../../../core/licensing/payload.js";
import { prefetchedLayerSource } from "../../../core/licensing/payloadPrefetch.js";
import { listTiers } from "../../../core/licensing/store.js";
import type { LicenseRow, ProductRow, TierRow } from "../../../core/repo.js";
import {
  planLimitsMaterialisation,
  type LimitColumns,
  type LimitsPlan,
  type LimitsSeed,
  type PlanProduct,
} from "./limitsPlan.js";

/** Licences planned per read. One page's layers are prefetched together. */
export const LIMITS_PAGE = 500;
/**
 * Licences written per `db.batch`. A licence is one `UPDATE` plus one ledger row per changed
 * column (usually the tier alone: two statements), so a batch is about a hundred statements: one
 * D1 round trip, well inside the 1000-queries-per-invocation budget when a run applies a product
 * of tens of thousands of licences, and small enough that a failed batch redoes little.
 */
export const LIMITS_BATCH = 50;
/** How many ids a dry run's detail lists per category. */
export const LIMITS_ID_CAP = 20;

const COLUMNS = [
  "tier_id",
  "channels_json",
  "min_version",
  "max_version",
  "device_limit",
  "max_offline_days",
] as const satisfies ReadonlyArray<keyof LimitColumns>;
type Column = (typeof COLUMNS)[number];

/** The implicit tier's columns the seed controls. */
const TIER_COLUMNS = [
  "policy_device_limit",
  "policy_offline_grace_days",
  "channels_json",
  "min_version",
  "max_version",
  "profile_id",
  "policy_fingerprint",
  "policy_expiry_days",
  "rank",
] as const;
type TierColumn = (typeof TIER_COLUMNS)[number];

const LEDGER_INSERT = `INSERT OR IGNORE INTO license_limit_backfill
  (product, subject_kind, subject_id, field, before_json, after_json, run_id, at)`;

const planProductOf = (p: ProductRow): PlanProduct => ({
  defaultDeviceLimit: p.default_device_limit,
  defaultMaxOfflineDays: p.default_max_offline_days,
  compat: { min: p.compat_min, max: p.compat_max },
});

async function licencePage(
  db: Db,
  product: string,
  after: string,
): Promise<LicenseRow[]> {
  return db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND id > ? ORDER BY id LIMIT ?",
    product,
    after,
    LIMITS_PAGE,
  );
}

/** A licence's merged `deviceLimit` entitlement, for the whole page, from layers read once. */
async function mergedDeviceLimits(
  db: Db,
  product: string,
  page: readonly LicenseRow[],
  now: number,
): Promise<Map<string, number | null>> {
  const source = await prefetchedLayerSource(db, product, page, now);
  const out = new Map<string, number | null>();
  for (const l of page) {
    const { payload } = await resolveMergedPayload(db, product, l, null, now, {
      entitlementsOnly: true,
      source,
    });
    const v = payload.entitlements["deviceLimit"];
    out.set(l.id, v && typeof v.value === "number" ? v.value : null);
  }
  return out;
}

/** Plans one page of licences against the product's tiers as they stand. */
async function planPage(
  db: Db,
  slug: string,
  p: ProductRow,
  tiers: readonly TierRow[],
  page: readonly LicenseRow[],
  now: number,
): Promise<LimitsPlan> {
  return planLimitsMaterialisation({
    product: planProductOf(p),
    tiers,
    licences: page,
    mergedDeviceLimit: await mergedDeviceLimits(db, slug, page, now),
  });
}

async function licenseEnabledProduct(
  db: Db,
  slug: string,
): Promise<ProductRow | null> {
  const row = (await listProducts(db)).find((r) => r.slug === slug) ?? null;
  return row && serviceStateOf(row).services.license.enabled ? row : null;
}

const cap = (ids: string[], id: string): void => {
  if (ids.length < LIMITS_ID_CAP) ids.push(id);
};

export const limitsMaterialiseJob: MigrationJob = {
  id: "license.limits-materialise",
  summary:
    "Give every licence a tier and copy the limits its documents derive from elsewhere onto it (LX-33)",
  units: async ({ db }) =>
    (await listProducts(db))
      .filter((r) => serviceStateOf(r).services.license.enabled)
      .map((r) => r.slug),

  async plan({ db, now }, slug) {
    const product = await licenseEnabledProduct(db, slug);
    if (!product) return { changes: 0, detail: { seed: "none", licences: 0 } };
    const tiers = await listTiers(db, slug);
    const head = await planPage(db, slug, product, tiers, [], now);
    const writes: Record<Column, number> = {
      tier_id: 0,
      channels_json: 0,
      min_version: 0,
      max_version: 0,
      device_limit: 0,
      max_offline_days: 0,
    };
    const danglingIds: string[] = [];
    const docDiffIds: string[] = [];
    const docDiffReasons: Record<string, number> = {};
    let licences = 0;
    let writeLicences = 0;
    let dangling = 0;
    let docDiffs = 0;
    for (let after = ""; ; ) {
      const page = await licencePage(db, slug, after);
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      licences += page.length;
      const plan = await planPage(db, slug, product, tiers, page, now);
      writeLicences += plan.writes.length;
      for (const w of plan.writes)
        for (const k of Object.keys(w.after) as Column[]) writes[k] += 1;
      dangling += plan.dangling.length;
      for (const d of plan.dangling) cap(danglingIds, d.licenseId);
      docDiffs += plan.docDiffs.length;
      for (const d of plan.docDiffs) {
        cap(docDiffIds, d.licenseId);
        for (const r of d.reasons)
          docDiffReasons[r] = (docDiffReasons[r] ?? 0) + 1;
      }
    }
    return {
      changes: writeLicences + (head.seed ? 1 : 0),
      detail: {
        seed: head.seed ? head.seed.action : "none",
        seedId: head.seed?.id ?? null,
        licences,
        assigned: writes.tier_id,
        writes,
        dangling,
        danglingIds,
        devOnlyTiers: head.devOnlyTiers.length,
        devOnlyTierIds: head.devOnlyTiers.slice(0, LIMITS_ID_CAP),
        docDiffs,
        docDiffIds,
        docDiffReasons,
      },
    };
  },

  apply: (ctx, slug) => applyLimitsUnit(ctx, slug),
  down: (ctx, slug) => downLimitsUnit(ctx, slug),
};

// ── apply ────────────────────────────────────────────────────────────────────────────────────

export interface ApplyHooks {
  /** Test seam: called after a page is read and planned, before its first write. */
  afterPlan?: () => Promise<void>;
}

const runIdOf = (now: number): string => `lx33@${now}`;

/** Guard: every given column of the licence row holds the given value. */
function licenceHolds(vals: Partial<LimitColumns>): {
  sql: string;
  params: DbParam[];
} {
  const keys = Object.keys(vals) as Column[];
  return {
    sql: keys.map((k) => `${k} IS ?`).join(" AND "),
    params: keys.map((k) => vals[k] as DbParam),
  };
}

function seedStatements(
  slug: string,
  seed: LimitsSeed,
  existing: TierRow | null,
  runId: string,
  now: number,
): DbStatement[] {
  const r = seed.row;
  if (seed.action === "create") {
    return [
      {
        sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
                channels_json, min_version, max_version, policy_fingerprint, rank,
                policy_offline_grace_days, modified_by, modified_at, source, implicit)
              SELECT ?, ?, 'Default', NULL, NULL, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, ?, 'console', 1
               WHERE NOT EXISTS (SELECT 1 FROM tiers WHERE product = ? AND (implicit = 1 OR id = ?))`,
        params: [
          slug,
          seed.id,
          r.policy_device_limit,
          r.policy_offline_grace_days,
          now,
          slug,
          seed.id,
        ],
      },
      {
        sql: `${LEDGER_INSERT}
              SELECT ?, 'tier', ?, 'created', NULL, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM tiers WHERE product = ? AND id = ? AND implicit = 1
                                AND label = 'Default' AND modified_at = ?)`,
        params: [
          slug,
          seed.id,
          JSON.stringify(seed.id),
          runId,
          now,
          slug,
          seed.id,
          now,
        ],
      },
    ];
  }
  // update: re-seed the values, compare-and-set on what the plan read.
  const before = existing as unknown as Record<TierColumn, DbParam>;
  const after = r as unknown as Record<TierColumn, DbParam>;
  const changed = TIER_COLUMNS.filter(
    (c) => (before[c] ?? null) !== (after[c] ?? null),
  );
  if (changed.length === 0) return [];
  const stmts: DbStatement[] = [
    {
      sql: `UPDATE tiers SET ${changed.map((c) => `${c} = ?`).join(", ")}
             WHERE product = ? AND id = ? AND implicit = 1 AND ${changed
               .map((c) => `${c} IS ?`)
               .join(" AND ")}`,
      params: [
        ...changed.map((c) => after[c] ?? null),
        slug,
        seed.id,
        ...changed.map((c) => before[c] ?? null),
      ],
    },
  ];
  for (const c of changed)
    stmts.push({
      sql: `${LEDGER_INSERT}
            SELECT ?, 'tier', ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM tiers WHERE product = ? AND id = ? AND ${c} IS ?)`,
      params: [
        slug,
        seed.id,
        c,
        JSON.stringify(before[c] ?? null),
        JSON.stringify(after[c] ?? null),
        runId,
        now,
        slug,
        seed.id,
        after[c] ?? null,
      ],
    });
  return stmts;
}

async function batchCounts(db: Db, stmts: DbStatement[]): Promise<number[]> {
  if (stmts.length === 0) return [];
  if (db.batchChanges) return db.batchChanges(stmts);
  await db.batch(stmts);
  return stmts.map(() => 1);
}

/**
 * Apply one product. Exported with its hook for the tests; the runner calls the job's `apply`.
 * Answers the rows changed: the seed (1) plus the licences whose compare-and-set took.
 */
export async function applyLimitsUnit(
  ctx: { db: Db; now: number },
  slug: string,
  hooks: ApplyHooks = {},
): Promise<number> {
  const { db, now } = ctx;
  const runId = runIdOf(now);
  let changed = 0;
  const product = await licenseEnabledProduct(db, slug);
  if (!product) return 0;

  // 1. The seed. The writes below plan against the tier as it is after this, so a tier another
  //    writer created in the meantime is used, not duplicated.
  let tiers = await listTiers(db, slug);
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await planPage(db, slug, product, tiers, [], now);
    if (!head.seed) break;
    const existing = tiers.find((t) => t.implicit === 1) ?? null;
    const stmts = seedStatements(slug, head.seed, existing, runId, now);
    const counts = await batchCounts(db, stmts);
    if ((counts[0] ?? 0) > 0) changed += 1;
    tiers = await listTiers(db, slug);
  }

  // 2. The licences, a page at a time, a batch at a time.
  for (let after = ""; ; ) {
    const page = await licencePage(db, slug, after);
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    const plan = await planPage(db, slug, product, tiers, page, now);
    if (plan.writes.length === 0) continue;
    await hooks.afterPlan?.();
    for (let i = 0; i < plan.writes.length; i += LIMITS_BATCH) {
      const stmts: DbStatement[] = [];
      const updateAt: number[] = [];
      for (const w of plan.writes.slice(i, i + LIMITS_BATCH)) {
        const cols = Object.keys(w.after) as Column[];
        const set = cols.map((c) => `${c} = ?`).join(", ");
        const cas = licenceHolds(w.before);
        updateAt.push(stmts.length);
        stmts.push({
          sql: `UPDATE licenses SET ${set} WHERE product = ? AND id = ? AND ${cas.sql}`,
          params: [
            ...cols.map((c) => w.after[c] as DbParam),
            slug,
            w.licenseId,
            ...cas.params,
          ],
        });
        const held = licenceHolds(w.after);
        for (const c of cols)
          stmts.push({
            sql: `${LEDGER_INSERT}
                  SELECT ?, 'license', ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM licenses WHERE product = ? AND id = ? AND ${held.sql})`,
            params: [
              slug,
              w.licenseId,
              c,
              JSON.stringify(w.before[c] ?? null),
              JSON.stringify(w.after[c] ?? null),
              runId,
              now,
              slug,
              w.licenseId,
              ...held.params,
            ],
          });
      }
      const counts = await batchCounts(db, stmts);
      for (const at of updateAt) changed += counts[at] ?? 0;
    }
  }
  return changed;
}

// ── down ─────────────────────────────────────────────────────────────────────────────────────

interface LedgerRow {
  subject_kind: "license" | "tier";
  subject_id: string;
  field: string;
  before_json: string | null;
  after_json: string | null;
}

const isColumn = (f: string): f is Column =>
  (COLUMNS as readonly string[]).includes(f);
const isTierColumn = (f: string): f is TierColumn =>
  (TIER_COLUMNS as readonly string[]).includes(f);
const parseValue = (j: string | null): DbParam =>
  j === null ? null : (JSON.parse(j) as DbParam);

/**
 * Undo one product from the ledger. A column goes back only while it still holds the value the
 * job wrote: a later console edit is kept. The ledger row goes with the restore. Licences first,
 * then the tier's own columns, then the seeded tier if nothing references it.
 */
export async function downLimitsUnit(
  ctx: { db: Db; now: number },
  slug: string,
): Promise<number> {
  const { db } = ctx;
  const rows = await db.all<LedgerRow>(
    `SELECT subject_kind, subject_id, field, before_json, after_json
       FROM license_limit_backfill WHERE product = ? ORDER BY subject_kind DESC, subject_id, field`,
    slug,
  );
  let changed = 0;
  const licenceRows = rows.filter((r) => r.subject_kind === "license");
  for (let i = 0; i < licenceRows.length; i += LIMITS_BATCH * 2) {
    const stmts: DbStatement[] = [];
    const updateAt: number[] = [];
    for (const r of licenceRows.slice(i, i + LIMITS_BATCH * 2)) {
      if (!isColumn(r.field)) continue;
      updateAt.push(stmts.length);
      stmts.push({
        sql: `UPDATE licenses SET ${r.field} = ? WHERE product = ? AND id = ? AND ${r.field} IS ?`,
        params: [
          parseValue(r.before_json),
          slug,
          r.subject_id,
          parseValue(r.after_json),
        ],
      });
      stmts.push(ledgerDelete(slug, "license", r, "licenses", "id"));
    }
    const counts = await batchCounts(db, stmts);
    for (const at of updateAt) changed += counts[at] ?? 0;
  }
  for (const r of rows.filter((x) => x.subject_kind === "tier")) {
    if (r.field === "created") continue;
    if (!isTierColumn(r.field)) continue;
    const counts = await batchCounts(db, [
      {
        sql: `UPDATE tiers SET ${r.field} = ? WHERE product = ? AND id = ? AND implicit = 1 AND ${r.field} IS ?`,
        params: [
          parseValue(r.before_json),
          slug,
          r.subject_id,
          parseValue(r.after_json),
        ],
      },
      ledgerDelete(slug, "tier", r, "tiers", "id"),
    ]);
    changed += counts[0] ?? 0;
  }
  for (const r of rows.filter(
    (x) => x.subject_kind === "tier" && x.field === "created",
  )) {
    const counts = await batchCounts(db, [
      {
        sql: `DELETE FROM tiers WHERE product = ? AND id = ? AND implicit = 1
                AND NOT EXISTS (SELECT 1 FROM licenses WHERE product = ? AND tier_id = ?)`,
        params: [slug, r.subject_id, slug, r.subject_id],
      },
      {
        sql: `DELETE FROM license_limit_backfill
               WHERE product = ? AND subject_kind = 'tier' AND subject_id = ? AND field = 'created'
                 AND NOT EXISTS (SELECT 1 FROM tiers WHERE product = ? AND id = ?)`,
        params: [slug, r.subject_id, slug, r.subject_id],
      },
    ]);
    changed += counts[0] ?? 0;
  }
  return changed;
}

/** Drops a ledger row once its subject holds the "before" value again. */
function ledgerDelete(
  slug: string,
  kind: "license" | "tier",
  r: LedgerRow,
  table: "licenses" | "tiers",
  idColumn: "id",
): DbStatement {
  return {
    sql: `DELETE FROM license_limit_backfill
           WHERE product = ? AND subject_kind = ? AND subject_id = ? AND field = ?
             AND EXISTS (SELECT 1 FROM ${table} WHERE product = ? AND ${idColumn} = ? AND ${r.field} IS ?)`,
    params: [
      slug,
      kind,
      r.subject_id,
      r.field,
      slug,
      r.subject_id,
      parseValue(r.before_json),
    ],
  };
}

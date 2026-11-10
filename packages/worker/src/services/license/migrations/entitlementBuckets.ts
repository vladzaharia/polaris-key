/**
 * LX-34.8: the P0-49 job `license.entitlement-buckets`.
 *
 * Release N of LX-34 moves a product's entitlements off the managed-payload profiles without
 * changing a document: the entitlements bucket of a tier's profile is copied to
 * `tiers.entitlements_json`, and the buckets of a licence's profiles go under the entries in the
 * licence's own overrides. What to write is `core/licensing/entitlementBuckets.ts`'s decision
 * (pure, and it proves each licence safe on both chains); this file reads the rows for it and
 * applies its answer.
 *
 *   units   the License-enabled products.
 *   plan    reads only. The detail is counts plus capped id lists, never a value. `docDiffs` is
 *           what the job will not move (a profile key a store or OIDC grant also sets, a tier
 *           bucket that holds something else, unreadable overrides): the owner decides each case.
 *   apply   re-plans from the rows as they are now, then writes in batches: per tier and per
 *           licence one `UPDATE` that compares-and-sets on the planned old value, with its ledger
 *           row. A row edited since the read fails the compare, is skipped and shows in the next
 *           dry run. Profiles are never touched; `modified_at` and `modified_by` are never written.
 *   down    restores from `entitlement_bucket_backfill`, a column only while it still holds the
 *           value the job last wrote.
 *
 * Compare-and-set guards only the column it writes. A store grant added on a moved key between the
 * plan and the write is not seen by the write; the next dry run reports it as `grant-key`.
 *
 * The ledger keeps the FIRST "before" for a (subject, field) and the LAST "after", so a re-run
 * never loses the original and `down` still matches. A ledger row is written in the same batch as
 * the write it records, and only if the row now holds the written value.
 *
 * The runner passes a job no run id, so ledger rows carry `lx34@<epoch seconds of the apply call>`.
 * Nothing starts this job but an operator's request.
 */
import type { Db, DbStatement } from "../../../db/types.js";
import type { MigrationJob } from "../../../core/migrate/job.js";
import { catalogDefaultPayload } from "../../../core/licensing/payload.js";
import { oidcGrantRowsFor } from "../../../core/licensing/grants.js";
import { storeGrantRowsFor } from "../../../core/licensing/storeGrants.js";
import {
  listLicenseProfileRows,
  listProfiles,
  listTiers,
} from "../../../core/licensing/store.js";
import {
  planEntitlementBuckets,
  type BucketLicence,
  type BucketPlan,
} from "../../../core/licensing/entitlementBuckets.js";
import type { LicenseRow, TierRow } from "../../../core/repo.js";
import {
  batchCounts,
  cap,
  eachLicencePage,
  licenseEnabledSlugs,
  parseValue,
  type LedgerRow,
  licenseEnabledProduct,
  LIMITS_BATCH,
  LIMITS_ID_CAP,
} from "./limitsMaterialise.js";

const runIdOf = (now: number): string => `lx34@${now}`;

/** The tier column and the licence column the job writes. */
const TIER_FIELD = "entitlements_json";
const LICENCE_FIELD = "overrides_json";

const LEDGER_UPSERT = `INSERT INTO entitlement_bucket_backfill
  (product, subject_kind, subject_id, field, before_json, after_json, run_id, at)`;
const LEDGER_KEEP_FIRST_BEFORE = `ON CONFLICT (product, subject_kind, subject_id, field)
  DO UPDATE SET after_json = excluded.after_json, run_id = excluded.run_id, at = excluded.at`;

/** The bucket JSON the job last wrote on each tier, from the ledger. */
async function ownedTierBuckets(
  db: Db,
  slug: string,
): Promise<Map<string, string>> {
  const rows = await db.all<{ subject_id: string; after_json: string | null }>(
    `SELECT subject_id, after_json FROM entitlement_bucket_backfill
      WHERE product = ? AND subject_kind = 'tier' AND field = ?`,
    slug,
    TIER_FIELD,
  );
  const out = new Map<string, string>();
  for (const r of rows)
    if (r.after_json !== null) {
      const v: unknown = JSON.parse(r.after_json);
      if (typeof v === "string") out.set(r.subject_id, v);
    }
  return out;
}

/** The product-wide inputs: tiers, profiles and the tiers' ledger. Read once per plan or apply. */
async function productInputs(db: Db, slug: string, now: number) {
  const [tiers, profileRows, owned, catalogDefault] = await Promise.all([
    listTiers(db, slug),
    listProfiles(db, slug),
    ownedTierBuckets(db, slug),
    catalogDefaultPayload(db, slug, now),
  ]);
  return {
    tiers,
    profiles: new Map(profileRows.map((p) => [p.id, p.payload_json])),
    owned,
    catalogDefault,
  };
}

type ProductInputs = Awaited<ReturnType<typeof productInputs>>;

/** Plans one page of licences (none = the tiers alone). */
async function planPage(
  db: Db,
  slug: string,
  inputs: ProductInputs,
  page: readonly LicenseRow[],
  now: number,
): Promise<BucketPlan> {
  const ids = page.map((l) => l.id);
  const [profileRefs, storeGrants, oidcGrants] = await Promise.all([
    listLicenseProfileRows(db, slug, ids),
    storeGrantRowsFor(db, slug, ids),
    oidcGrantRowsFor(db, slug, ids, now),
  ]);
  const licences: BucketLicence[] = page.map((l) => ({
    row: l,
    profileIds: (profileRefs.get(l.id) ?? []).map((r) => r.profile_id),
    storeGrants: storeGrants.get(l.id) ?? [],
    oidcGrants: oidcGrants.get(l.id) ?? [],
  }));
  return planEntitlementBuckets({
    catalogDefault: inputs.catalogDefault,
    tiers: inputs.tiers as readonly TierRow[],
    profiles: inputs.profiles,
    ownedTierBuckets: inputs.owned,
    licences,
  });
}

export const entitlementBucketsJob: MigrationJob = {
  id: "license.entitlement-buckets",
  summary:
    "Copy each tier profile's entitlements to its tier and each licence profile's under the licence's overrides (LX-34)",
  units: ({ db }) => licenseEnabledSlugs(db),

  async plan({ db, now }, slug) {
    if (!(await licenseEnabledProduct(db, slug)))
      return { changes: 0, detail: { licences: 0 } };
    const inputs = await productInputs(db, slug, now);
    const head = await planPage(db, slug, inputs, [], now);
    const docDiffIds: string[] = [];
    const docDiffReasons: Record<string, number> = {};
    let docDiffs = 0;
    const count = (plan: BucketPlan): void => {
      docDiffs += plan.docDiffs.length;
      for (const d of plan.docDiffs) {
        cap(docDiffIds, `${d.subjectKind}:${d.subjectId}`);
        for (const r of d.reasons)
          docDiffReasons[r] = (docDiffReasons[r] ?? 0) + 1;
      }
    };
    count(head);
    let licences = 0;
    let licenceWrites = 0;
    let keys = 0;
    await eachLicencePage(db, slug, async (page) => {
      licences += page.length;
      const plan = await planPage(db, slug, inputs, page, now);
      // A page's tier verdicts repeat the head's; only its licences are new.
      count({
        ...plan,
        docDiffs: plan.docDiffs.filter((d) => d.subjectKind === "license"),
      });
      licenceWrites += plan.licenceWrites.length;
      for (const w of plan.licenceWrites) keys += w.keys.length;
    });
    return {
      changes: head.tierWrites.length + licenceWrites,
      detail: {
        licences,
        tiers: inputs.tiers.length,
        tierWrites: head.tierWrites.length,
        tierWriteIds: head.tierWrites
          .map((w) => w.tierId)
          .slice(0, LIMITS_ID_CAP),
        licenceWrites,
        keys,
        docDiffs,
        docDiffIds,
        docDiffReasons,
      },
    };
  },

  apply: (ctx, slug) => applyBucketsUnit(ctx, slug),
  down: (ctx, slug) => downBucketsUnit(ctx, slug),
};

// ── apply ────────────────────────────────────────────────────────────────────────────────────

export interface ApplyHooks {
  /** Test seam: called after a page is read and planned, before its first write. */
  afterPlan?: () => Promise<void>;
}

/** One compare-and-set write with its ledger row. */
function writeStatements(
  slug: string,
  kind: "tier" | "license",
  id: string,
  w: { before: string | null; after: string },
  runId: string,
  now: number,
): DbStatement[] {
  const table = kind === "tier" ? "tiers" : "licenses";
  const column = kind === "tier" ? TIER_FIELD : LICENCE_FIELD;
  return [
    {
      sql: `UPDATE ${table} SET ${column} = ? WHERE product = ? AND id = ? AND ${column} IS ?`,
      params: [w.after, slug, id, w.before],
    },
    {
      sql: `${LEDGER_UPSERT}
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM ${table} WHERE product = ? AND id = ? AND ${column} IS ?)
            ${LEDGER_KEEP_FIRST_BEFORE}`,
      params: [
        slug,
        kind,
        id,
        column,
        JSON.stringify(w.before),
        JSON.stringify(w.after),
        runId,
        now,
        slug,
        id,
        w.after,
      ],
    },
  ];
}

/**
 * Apply one product. Exported with its hook for the tests; the runner calls the job's `apply`.
 * Answers the rows changed: the tiers and licences whose compare-and-set took.
 */
export async function applyBucketsUnit(
  ctx: { db: Db; now: number },
  slug: string,
  hooks: ApplyHooks = {},
): Promise<number> {
  const { db, now } = ctx;
  const runId = runIdOf(now);
  if (!(await licenseEnabledProduct(db, slug))) return 0;
  let changed = 0;

  // 1. The tiers. The licences below plan against the tiers as they are after this.
  let inputs = await productInputs(db, slug, now);
  const head = await planPage(db, slug, inputs, [], now);
  const tierStmts: DbStatement[] = [];
  const tierAt: number[] = [];
  for (const w of head.tierWrites) {
    tierAt.push(tierStmts.length);
    tierStmts.push(...writeStatements(slug, "tier", w.tierId, w, runId, now));
  }
  for (const at of tierAt) {
    const counts = await batchCounts(db, tierStmts.slice(at, at + 2));
    changed += counts[0] ?? 0;
  }
  if (tierAt.length > 0) inputs = await productInputs(db, slug, now);

  // 2. The licences, a page at a time, a batch at a time.
  await eachLicencePage(db, slug, async (page) => {
    const plan = await planPage(db, slug, inputs, page, now);
    if (plan.licenceWrites.length === 0) return;
    await hooks.afterPlan?.();
    for (let i = 0; i < plan.licenceWrites.length; i += LIMITS_BATCH) {
      const stmts: DbStatement[] = [];
      const updateAt: number[] = [];
      for (const w of plan.licenceWrites.slice(i, i + LIMITS_BATCH)) {
        updateAt.push(stmts.length);
        stmts.push(
          ...writeStatements(slug, "license", w.licenseId, w, runId, now),
        );
      }
      const counts = await batchCounts(db, stmts);
      for (const at of updateAt) changed += counts[at] ?? 0;
    }
  });
  return changed;
}

// ── down ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Undo one product from the ledger. A column goes back only while it still holds the value the
 * job last wrote: a later edit is kept. The ledger row goes with the restore.
 */
export async function downBucketsUnit(
  ctx: { db: Db; now: number },
  slug: string,
): Promise<number> {
  const { db } = ctx;
  const rows = await db.all<LedgerRow>(
    `SELECT subject_kind, subject_id, field, before_json, after_json
       FROM entitlement_bucket_backfill WHERE product = ? ORDER BY subject_kind DESC, subject_id, field`,
    slug,
  );
  let changed = 0;
  for (let i = 0; i < rows.length; i += LIMITS_BATCH) {
    const stmts: DbStatement[] = [];
    const updateAt: number[] = [];
    for (const r of rows.slice(i, i + LIMITS_BATCH)) {
      const table =
        r.subject_kind === "tier" && r.field === TIER_FIELD
          ? "tiers"
          : r.subject_kind === "license" && r.field === LICENCE_FIELD
            ? "licenses"
            : null;
      if (!table) continue;
      updateAt.push(stmts.length);
      stmts.push({
        sql: `UPDATE ${table} SET ${r.field} = ? WHERE product = ? AND id = ? AND ${r.field} IS ?`,
        params: [
          parseValue(r.before_json),
          slug,
          r.subject_id,
          parseValue(r.after_json),
        ],
      });
      // The ledger row goes once the subject holds the "before" value again.
      stmts.push({
        sql: `DELETE FROM entitlement_bucket_backfill
               WHERE product = ? AND subject_kind = ? AND subject_id = ? AND field = ?
                 AND EXISTS (SELECT 1 FROM ${table} WHERE product = ? AND id = ? AND ${r.field} IS ?)`,
        params: [
          slug,
          r.subject_kind,
          r.subject_id,
          r.field,
          slug,
          r.subject_id,
          parseValue(r.before_json),
        ],
      });
    }
    const counts = await batchCounts(db, stmts);
    for (const at of updateAt) changed += counts[at] ?? 0;
  }
  return changed;
}

/**
 * The two apply jobs of the P2-12 switch (P2-12.8, plans/P2-12.md §6.5), both P0-49 jobs:
 *
 *   `release.backfill-store`            runs the P0-26 sync for a linked product whose truth store
 *                                       is empty, or holds GitHub-listed releases that lack
 *                                       `listedAssets` (written since P2-12 D3). Down answers 0:
 *                                       a sync is not undone, GitHub is the source it rewrote
 *                                       from.
 *   `release.materialise-workflow-beta` writes `release_metadata.channel = 'beta'` on the
 *                                       releases a channel-workflow product's `beta` selector
 *                                       resolves among today, so the store's answer for `beta`
 *                                       is the workflow's (D6) once the resolver switches. The
 *                                       dry run snapshots the workflow, the branch and the tag
 *                                       set; apply uses that snapshot, never a fresh read.
 *
 * Both write an audit row (`core/audit.ts`) for what they changed.
 */

import { appendAudit, SYSTEM_ACTORS, actorColumns } from "../../core/audit.js";
import type {
  MigrationContext,
  MigrationJob,
  UnitOutcome,
  UnitPlan,
} from "../../core/migrate/job.js";
import { listAllProductSlugs } from "../../core/products/store.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { classifyChannel } from "./channels.js";
import { getReleaseConfig, isResolved } from "./config.js";
import { channelTagsFor, meterUpstreamCalls } from "./gateway.js";
import { parsesInScheme, prereleaseOf } from "./resolve.js";
import { versionFromTag } from "./channels.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import type { FetchImpl } from "./githubApp.js";
import { syncReleaseStoreReport } from "./sync.js";

export interface ReleaseResolverJobOptions {
  /** The GitHub fetch; default the runtime's. */
  fetchImpl?: FetchImpl;
}

/** Releases of a product that no ingested descriptor owns. */
const UNDESCRIBED_SQL =
  "COALESCE(json_extract(metadata_json, '$.descriptor.status'), '') <> 'ingested'";

async function linkedProducts(ctx: MigrationContext): Promise<string[]> {
  const out: string[] = [];
  for (const slug of await listAllProductSlugs(ctx.db)) {
    const cfg = await getReleaseConfig(ctx.db, slug);
    if (cfg && isResolved(cfg)) out.push(slug);
  }
  return out;
}

async function auditRow(
  ctx: MigrationContext,
  product: string,
  action: string,
  summary: string,
  after: unknown,
): Promise<void> {
  await appendAudit(ctx.db, {
    product,
    at: ctx.now,
    ...actorColumns(SYSTEM_ACTORS.platform),
    action,
    target_kind: "migration",
    target_id: product,
    summary,
    after_json: JSON.stringify(after),
  });
}

// ── release.backfill-store ───────────────────────────────────────────────────────────────────

/** What a product's store lacks: no `app` row at all, or listed rows without `listedAssets`. */
async function storeGap(
  ctx: MigrationContext,
  product: string,
): Promise<{ appRows: number; unlisted: number }> {
  const row = await ctx.db.first<{ n: number; unlisted: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN json_extract(metadata_json, '$.tag') IS NOT NULL
                      AND json_extract(metadata_json, '$.listedAssets') IS NULL
                     THEN 1 ELSE 0 END) AS unlisted
       FROM release_metadata WHERE product = ? AND deliverable_id = ?`,
    product,
    APP_DELIVERABLE_ID,
  );
  return { appRows: row?.n ?? 0, unlisted: row?.unlisted ?? 0 };
}

export function createBackfillStoreJob(
  opts: ReleaseResolverJobOptions = {},
): MigrationJob {
  const upstream: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  return {
    id: "release.backfill-store",
    summary:
      "Sync the release truth store from GitHub for a linked product whose store is empty or predates listedAssets",
    units: linkedProducts,
    async plan(ctx, unit): Promise<UnitPlan> {
      const gap = await storeGap(ctx, unit);
      return {
        changes: gap.appRows === 0 ? 1 : gap.unlisted,
        detail: gap,
      };
    },
    async apply(ctx, unit): Promise<UnitOutcome> {
      const gap = await storeGap(ctx, unit);
      if (gap.appRows > 0 && gap.unlisted === 0)
        return { changes: 0, detail: { skipped: "store is current" } };
      // Charged to the product's hourly GitHub budget, like serving and the freshness pass.
      const report = await syncReleaseStoreReport(
        ctx.env,
        ctx.db,
        unit,
        ctx.now,
        meterUpstreamCalls(ctx.env, unit, ctx.now, upstream),
      );
      const after = await storeGap(ctx, unit);
      const changes = Math.max(
        0,
        (gap.appRows === 0 ? 1 : gap.unlisted) -
          (after.appRows === 0 ? 1 : after.unlisted),
      );
      if (report.statements > 0)
        await auditRow(
          ctx,
          unit,
          "migration.release.backfill-store",
          `Synced the release store from GitHub (${gap.appRows} release(s) before, ${after.appRows} after)`,
          { before: gap, after, statements: report.statements },
        );
      return { changes, detail: { before: gap, after } };
    },
    /** A sync is not undone: GitHub is where it read from, and the rows it wrote are current. */
    async down(): Promise<UnitOutcome> {
      return {
        changes: 0,
        detail: {
          skipped:
            "a sync rewrites the store from GitHub; there is no earlier state to restore",
        },
      };
    },
  };
}

// ── release.materialise-workflow-beta ────────────────────────────────────────────────────────

/** What the dry run snapshots for a unit (`detail`). */
interface BetaSnapshot {
  channelWorkflow: string;
  betaBranch: string;
  /** The tags the channel workflow's successful runs on the beta branch name. */
  tags: string[];
}

function snapshotOf(detail: unknown): BetaSnapshot | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (
    typeof d.channelWorkflow !== "string" ||
    typeof d.betaBranch !== "string" ||
    !Array.isArray(d.tags) ||
    !d.tags.every((t) => typeof t === "string")
  )
    return null;
  return {
    channelWorkflow: d.channelWorkflow,
    betaBranch: d.betaBranch,
    tags: d.tags as string[],
  };
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * The ids in `tags` the apply would set: undescribed `app` rows whose channel is unset. A
 * release GitHub does not flag as a prerelease and whose tag is a semver is a stable build that
 * the workflow's beta set happens to name; it stays on `stable` and is never marked.
 */
async function candidates(
  ctx: MigrationContext,
  product: string,
  tags: readonly string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const rows = await ctx.db.all<{
    release_id: string;
    metadata_json: string | null;
  }>(
    `SELECT release_id, metadata_json FROM release_metadata
      WHERE product = ? AND deliverable_id = ? AND channel IS NULL AND ${UNDESCRIBED_SQL}
        AND release_id IN (${marks(tags.length)}) ORDER BY release_id`,
    product,
    APP_DELIVERABLE_ID,
    ...tags,
  );
  return rows
    .filter(
      (r) =>
        prereleaseOf(r) ||
        !parsesInScheme("semver", versionFromTag(r.release_id)),
    )
    .map((r) => r.release_id);
}

export function createMaterialiseWorkflowBetaJob(
  opts: ReleaseResolverJobOptions = {},
): MigrationJob {
  const upstream: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  return {
    id: "release.materialise-workflow-beta",
    summary:
      "Record the channel workflow's beta releases as channel=beta in the release store (undescribed rows only)",
    async units(ctx) {
      const out: string[] = [];
      for (const slug of await linkedProducts(ctx)) {
        const cfg = await getReleaseConfig(ctx.db, slug);
        if (cfg?.channel_workflow) out.push(slug);
      }
      return out;
    },
    async plan(ctx, unit): Promise<UnitPlan> {
      const cfg = await getReleaseConfig(ctx.db, unit);
      if (!cfg || !isResolved(cfg) || !cfg.channel_workflow)
        return { changes: 0, detail: { skipped: "no channel workflow" } };
      const sel = classifyChannel("beta", []);
      const set = sel
        ? await channelTagsFor(ctx.env, cfg, sel, ctx.now, upstream)
        : undefined;
      const tags = [...(set ?? [])].sort();
      const snapshot: BetaSnapshot = {
        channelWorkflow: cfg.channel_workflow,
        betaBranch: cfg.beta_branch,
        tags,
      };
      const ids = await candidates(ctx, unit, tags);
      return { changes: ids.length, detail: { ...snapshot, wouldSet: ids } };
    },
    async apply(ctx, unit, reported): Promise<UnitOutcome> {
      const snapshot = snapshotOf(reported);
      if (!snapshot)
        throw new Error("no_report_snapshot: dry-run this unit again");
      const cfg = await getReleaseConfig(ctx.db, unit);
      // The report is what the operator read: a changed workflow or branch makes it stale.
      if (
        !cfg ||
        cfg.channel_workflow !== snapshot.channelWorkflow ||
        cfg.beta_branch !== snapshot.betaBranch
      )
        throw new Error("config_changed: dry-run this unit again");
      // Only what the operator read: the apply never sets a row the dry run did not list.
      const listed = Array.isArray(
        (reported as { wouldSet?: unknown }).wouldSet,
      )
        ? new Set((reported as { wouldSet: unknown[] }).wouldSet)
        : null;
      const ids = (await candidates(ctx, unit, snapshot.tags)).filter(
        (id) => !listed || listed.has(id),
      );
      // One statement: it applies in full or not at all, and RETURNING names exactly the rows it
      // set, which is what `down` is handed. A concurrent change that took a row first drops it.
      const set =
        ids.length === 0
          ? []
          : (
              await ctx.db.all<{ release_id: string }>(
                `UPDATE release_metadata SET channel = 'beta'
                  WHERE product = ? AND deliverable_id = ? AND channel IS NULL AND ${UNDESCRIBED_SQL}
                    AND release_id IN (${marks(ids.length)})
                  RETURNING release_id`,
                unit,
                APP_DELIVERABLE_ID,
                ...ids,
              )
            )
              .map((r) => r.release_id)
              .sort();
      let auditError: string | undefined;
      if (set.length > 0) {
        // The rows are set; a failure to record them must not lose the list `down` needs.
        try {
          await auditRow(
            ctx,
            unit,
            "migration.release.materialise-workflow-beta",
            `Set channel=beta on ${set.length} release(s) of the channel workflow`,
            { workflow: snapshot.channelWorkflow, ids: set },
          );
          await bumpReleaseGeneration(ctx.env, unit, ctx.now);
        } catch (e) {
          auditError = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        changes: set.length,
        detail: { ids: set, ...(auditError ? { auditError } : {}) },
      };
    },
    async down(ctx, unit, applied): Promise<UnitOutcome> {
      const ids =
        applied &&
        typeof applied === "object" &&
        Array.isArray((applied as { ids?: unknown }).ids)
          ? (applied as { ids: unknown[] }).ids.filter(
              (i): i is string => typeof i === "string",
            )
          : [];
      const reset: string[] = [];
      for (const id of ids) {
        const n = await ctx.db.runChanges(
          `UPDATE release_metadata SET channel = NULL
            WHERE product = ? AND release_id = ? AND deliverable_id = ?
              AND channel = 'beta' AND ${UNDESCRIBED_SQL}`,
          unit,
          id,
          APP_DELIVERABLE_ID,
        );
        if (n > 0) reset.push(id);
      }
      if (reset.length > 0) {
        await auditRow(
          ctx,
          unit,
          "migration.release.materialise-workflow-beta.down",
          `Cleared channel=beta on ${reset.length} release(s) the apply had set`,
          { ids: reset, skipped: ids.length - reset.length },
        );
        await bumpReleaseGeneration(ctx.env, unit, ctx.now);
      }
      return {
        changes: reset.length,
        detail: { ids: reset, skipped: ids.length - reset.length },
      };
    },
  };
}

export const backfillStoreJob = createBackfillStoreJob();
export const materialiseWorkflowBetaJob = createMaterialiseWorkflowBetaJob();

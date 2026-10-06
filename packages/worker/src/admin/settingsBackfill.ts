/**
 * The settings backfill's runs (ST-01c; notes/S-18 §4.14, owner decision D19): one product
 * (`runSettingsBackfill`) and the platform batch over every product (`runPlatformBackfill`).
 * The classifier, the apply's statements, the state guard and the report storage are Core's
 * (`core/settingsBackfill.ts`); this file reads the manifest and the stored state and runs the
 * batch. It lives in the admin layer, beside `systemProduct.ts`, because it composes Release's
 * manifest read with Core's, License's and Config's rows in one batch, which no service may do
 * on its own (rule 6).
 *
 * Which manifest:
 *
 *   - a repo-linked product: the default branch's head, resolved by GitHub and pinned to one
 *     commit, read exactly as a resync reads it (`readLinkedManifest`, ST-01a; never the stored
 *     `product_sync_state.commit_sha`, which can be an unapplied feature-branch push). That stored
 *     sha is read ONLY as corroboration: its documents' digest is compared with the pinned read's
 *     (S-18 §4.14.2 step 2) and never applied (R6-05);
 *   - the system product (`system = 1`): its last deploy-hook snapshot (`product_manifest_snapshot`),
 *     the root `.pkey/` at the deployed commit. The deploy hook is its only writer (ST-20), so the
 *     backfill never reads the monorepo's default branch for it and never writes its snapshot;
 *   - any other product (`release_source` is not `github`): no manifest exists, so nothing is
 *     classified or written, and the report says `unlinked`.
 *
 * A dry run stores its report and writes nothing else. An apply stores its report in the SAME
 * batch as the writes (guarded by the product's state token, see the Core module), with the
 * manifest snapshot (origin `backfill`, when the stored one does not already describe this
 * manifest) and one `setting.backfill` audit row; an apply that changes nothing stores an empty
 * report and no audit row, so a second apply is a no-op.
 */

import type { ParsedManifest } from "@polaris-key/manifest";
import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import {
  getActiveSchema,
  getProduct,
  getProductSyncState,
  listProducts,
  type ProductRow,
} from "../repo.js";
import { listProfiles, listTiers } from "./repo.js";
import {
  getManifestSnapshot,
  gitShaOrNull,
  manifestFilesSha256,
  manifestSnapshotStatement,
} from "../core/manifestSnapshot.js";
import type { AuditActor, ProductSettingRow } from "../core/settingsClaims.js";
import {
  newBatchId,
  newReportId,
  planBackfill,
  readEvidence,
  readStateToken,
  stmtBackfillAudit,
  stmtInsertReport,
  type BackfillCorroboration,
  type BackfillEvidenceBasis,
  type BackfillManifest,
  type BackfillOutcome,
  type BackfillReport,
  type BackfillSource,
} from "../core/settingsBackfill.js";
import type { FetchImpl } from "../services/release/githubApp.js";
import {
  readLinkedManifest,
  screenCatalog,
  withStoredSecrets,
} from "../services/release/resync.js";
import { readManifestFilesAt } from "../services/release/manifestFetch.js";

export interface BackfillRunOptions {
  dryRun: boolean;
  actor: AuditActor;
  now: number;
  fetchImpl?: FetchImpl;
  /** The platform batch this run belongs to (`null` for a single-product run). */
  batchId?: string | null;
  /**
   * The commit the operator's dry run was read at. When given, the apply refuses (409
   * `commit_moved`) if the default branch's head is no longer it, so the apply writes what the
   * reviewed dry run showed. Compared only, never fetched at.
   */
  expectCommit?: string | null;
}

export type BackfillRun =
  | { ok: true; report: BackfillReport }
  | {
      ok: false;
      status: 404 | 409;
      reason: "unknown_product" | "commit_moved" | "backfill_conflict";
      message: string;
    };

/** The manifest a run classifies against, or why there is none. */
type ManifestSource =
  | {
      ok: true;
      manifest: BackfillManifest;
      source: BackfillSource;
      /** Linked products: the raw documents (the snapshot records them). */
      files: Record<string, string> | null;
      corroborate: (() => Promise<BackfillCorroboration>) | null;
    }
  | {
      ok: false;
      outcome: "unlinked" | "unreadable";
      message: string;
      errors?: string[];
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The system product's manifest: its stored deploy-hook snapshot (a normalised ParsedManifest),
 * checked for the members the backfill reads before it is trusted.
 */
function snapshotManifest(json: string): BackfillManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  const product = m.product;
  if (
    !isRecord(product) ||
    typeof product.name !== "string" ||
    typeof product.defaultMaxOfflineDays !== "number" ||
    typeof product.defaultDeviceLimit !== "number" ||
    !isRecord(m.catalog) ||
    !Array.isArray(m.tiers) ||
    !Array.isArray(m.profiles) ||
    !Array.isArray(m.webOrigins) ||
    !isRecord(m.services)
  )
    return null;
  return parsed as BackfillManifest;
}

async function manifestFor(
  env: Env,
  db: Db,
  product: ProductRow,
  opts: BackfillRunOptions,
): Promise<ManifestSource> {
  if (product.release_source !== "github")
    return {
      ok: false,
      outcome: "unlinked",
      message:
        "the product is not linked to a repository: no manifest exists, so nothing is classified or written",
    };
  if (product.system === 1) {
    const snapshot = await getManifestSnapshot(db, product.slug);
    const manifest = snapshot ? snapshotManifest(snapshot.manifest_json) : null;
    if (!snapshot || !manifest)
      return {
        ok: false,
        outcome: "unreadable",
        message: snapshot
          ? "cannot read .pkey/: the system product's manifest snapshot does not parse"
          : "cannot read .pkey/: no deploy has applied the root .pkey/ yet (no manifest snapshot); deploy, then run the backfill",
      };
    return {
      ok: true,
      manifest,
      source: {
        kind: "deploy-snapshot",
        commit: snapshot.applied_sha,
        appliedAt: snapshot.applied_at,
      },
      files: null,
      corroborate: null,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const read = await readLinkedManifest(
    env,
    db,
    product.slug,
    opts.now,
    fetchImpl,
  );
  if (!read.ok)
    return {
      ok: false,
      outcome: "unreadable",
      message: `cannot read .pkey/: ${read.error}`,
      ...(read.errors ? { errors: read.errors } : {}),
    };
  const { owner, repo, token, commit, files } = read;
  return {
    ok: true,
    manifest: read.manifest,
    source: { kind: "github", repository: `${owner}/${repo}`, commit },
    files,
    corroborate: async () => {
      const sync = await getProductSyncState(db, product.slug);
      const sha = gitShaOrNull(sync?.commit_sha ?? null);
      if (!sha)
        return {
          commitSha: null,
          note: "no push is recorded (never synced by a webhook, or only resynced by hand): nothing to corroborate",
        };
      if (sha === commit) return { commitSha: sha, matches: true };
      try {
        const atPush = await readManifestFilesAt(
          token,
          owner,
          repo,
          sha,
          fetchImpl,
        );
        return {
          commitSha: sha,
          matches:
            (await manifestFilesSha256(atPush)) ===
            (await manifestFilesSha256(files)),
        };
      } catch (e) {
        return {
          commitSha: sha,
          error: e instanceof Error ? e.message : "github read failed",
        };
      }
    },
  };
}

/** The evidence bound (S-18 §4.14.2 steps 3–4): the last apply, else the product's creation. */
async function evidenceBasis(
  db: Db,
  product: ProductRow,
): Promise<BackfillEvidenceBasis> {
  const [snapshot, sync] = await Promise.all([
    getManifestSnapshot(db, product.slug),
    getProductSyncState(db, product.slug),
  ]);
  const applied = snapshot?.applied_at ?? null;
  const synced = sync?.last_synced_at ?? null;
  if (applied !== null && (synced === null || applied >= synced))
    return { basis: "snapshot", since: applied, weak: false };
  if (synced !== null)
    return { basis: "last-sync", since: synced, weak: false };
  return { basis: "created", since: product.created_at, weak: true };
}

function emptyReport(
  product: string,
  opts: BackfillRunOptions,
  outcome: BackfillOutcome,
  extra: Partial<BackfillReport>,
): BackfillReport {
  return {
    version: 1,
    id: newReportId(),
    product,
    at: opts.now,
    mode: opts.dryRun ? "dry-run" : "apply",
    outcome,
    items: [],
    changes: 0,
    snapshot: "not-applicable",
    batchId: opts.batchId ?? null,
    actor: { sub: opts.actor.sub, name: opts.actor.name },
    ...extra,
  };
}

/** Store a report that wrote nothing else (a dry run, or a product with nothing to apply). */
async function storeOnly(db: Db, report: BackfillReport): Promise<BackfillRun> {
  await db.batch([stmtInsertReport(report)]);
  return { ok: true, report };
}

/**
 * Backfill one product (S-18 §4.14.2): read its manifest, classify every field and row, and either
 * store the classification (`dryRun`) or apply it with the report, the snapshot and the audit row
 * in one batch.
 */
export async function runSettingsBackfill(
  env: Env,
  db: Db,
  slug: string,
  opts: BackfillRunOptions,
): Promise<BackfillRun> {
  const product = await getProduct(db, slug);
  if (!product)
    return {
      ok: false,
      status: 404,
      reason: "unknown_product",
      message: `unknown product ${slug}`,
    };

  // The token first: any console write after this read, however it lands relative to the reads
  // below, makes the apply's guarded report insert abort the batch.
  const token = await readStateToken(db, slug);

  const source = await manifestFor(env, db, product, opts);
  if (!source.ok)
    return storeOnly(
      db,
      emptyReport(slug, opts, source.outcome, {
        message: source.message,
        ...(source.errors ? { errors: source.errors } : {}),
      }),
    );
  const { manifest } = source;
  const commit = source.source.commit;
  if (!opts.dryRun && opts.expectCommit && opts.expectCommit !== commit)
    return {
      ok: false,
      status: 409,
      reason: "commit_moved",
      message: `the manifest moved since the dry run (${opts.expectCommit.slice(0, 12)} → ${commit ? commit.slice(0, 12) : "none"}): run the dry run again`,
    };

  const corroboration = source.corroborate
    ? await source.corroborate()
    : undefined;
  const evidence = await evidenceBasis(db, product);
  const [settings, tiers, profiles, activeSchema, evidenceRows] =
    await Promise.all([
      db.all<ProductSettingRow>(
        "SELECT * FROM product_settings WHERE product = ? ORDER BY key",
        slug,
      ),
      listTiers(db, slug),
      listProfiles(db, slug),
      getActiveSchema(db, slug),
      readEvidence(db, slug, evidence.since),
    ]);

  // The catalog the profile carry-forward (R2) asks which keys are managed secrets: the
  // manifest's, which is what the product runs once the backfill has applied. Compiled (as a
  // resync screens a changed catalog) only when the apply would publish it, below.
  const screened = screenCatalog(manifest as ParsedManifest, false);
  if (!screened.ok)
    return storeOnly(
      db,
      emptyReport(slug, opts, "refused", {
        message: screened.error,
        source: source.source,
        ...(corroboration ? { corroboration } : {}),
      }),
    );
  const plan = planBackfill(
    manifest,
    {
      product,
      settings,
      tiers,
      profiles,
      activeSchema,
      evidence: evidenceRows,
    },
    {
      now: opts.now,
      system: product.system === 1,
      profilePayload: (p, stored) =>
        withStoredSecrets(p.payload, stored?.payload_json, screened.catalog),
    },
  );
  const publishesCatalog = plan.items.some(
    (i) => i.key === "config.catalog" && i.action === "revert",
  );
  const compiled = publishesCatalog
    ? screenCatalog(manifest as ParsedManifest, true)
    : screened;
  if (!compiled.ok)
    return storeOnly(
      db,
      emptyReport(slug, opts, "refused", {
        message: compiled.error,
        source: source.source,
        ...(corroboration ? { corroboration } : {}),
        evidence,
        items: plan.items,
        changes: plan.changes,
      }),
    );

  // The snapshot (ST-01a) for a linked product: recorded by an apply when the stored one does not
  // already describe these documents. Never for the system product (the deploy hook's).
  let snapshotStmt: DbStatement | null = null;
  if (!opts.dryRun && source.files) {
    const stored = await getManifestSnapshot(db, slug);
    if (stored?.files_sha256 !== (await manifestFilesSha256(source.files)))
      snapshotStmt = await manifestSnapshotStatement(
        slug,
        "backfill",
        commit,
        source.files,
        manifest,
        opts.now,
      );
  }

  const report: BackfillReport = {
    ...emptyReport(slug, opts, "planned", {}),
    source: source.source,
    ...(corroboration ? { corroboration } : {}),
    evidence,
    items: plan.items,
    changes: plan.changes,
    snapshot: source.files
      ? opts.dryRun
        ? "not-applicable"
        : snapshotStmt
          ? "written"
          : "current"
      : "not-applicable",
  };
  if (opts.dryRun) return storeOnly(db, report);

  const changed = plan.changes > 0 || snapshotStmt !== null;
  report.outcome = changed ? "applied" : "unchanged";
  const stmts: DbStatement[] = [stmtInsertReport(report, { token })];
  if (changed) {
    stmts.push(...plan.writes);
    if (snapshotStmt) stmts.push(snapshotStmt);
    stmts.push(stmtBackfillAudit(report, opts.actor));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if ((await readStateToken(db, slug)) !== token)
      return {
        ok: false,
        status: 409,
        reason: "backfill_conflict",
        message:
          "the product's settings changed while the backfill ran (a console edit landed); nothing was written: run it again",
      };
    throw e;
  }
  return { ok: true, report };
}

/** One product's line in a platform batch's answer. */
export interface BatchEntry {
  product: string;
  outcome: BackfillOutcome | "conflict" | "commit_moved" | "error";
  reportId: string | null;
  changes: number;
  message?: string;
}

/** Products per platform batch request; `next` continues after the last one. */
export const BATCH_LIMIT = 20;

/**
 * The platform batch: every registered product in slug order, at most `BATCH_LIMIT` per call
 * (`after` continues). Each runs exactly as a single-product run, its report carrying the batch
 * id. A product that fails is listed with its error and the batch goes on.
 */
export async function runPlatformBackfill(
  env: Env,
  db: Db,
  opts: Omit<BackfillRunOptions, "batchId" | "expectCommit"> & {
    after?: string | null;
  },
): Promise<{
  batchId: string;
  dryRun: boolean;
  products: BatchEntry[];
  next: string | null;
}> {
  const batchId = newBatchId();
  const all = (await listProducts(db)).filter(
    (p) => !opts.after || p.slug > opts.after,
  );
  const page = all.slice(0, BATCH_LIMIT);
  const products: BatchEntry[] = [];
  for (const p of page) {
    try {
      const run = await runSettingsBackfill(env, db, p.slug, {
        ...opts,
        batchId,
      });
      products.push(
        run.ok
          ? {
              product: p.slug,
              outcome: run.report.outcome,
              reportId: run.report.id,
              changes: run.report.changes,
              ...(run.report.message ? { message: run.report.message } : {}),
            }
          : {
              product: p.slug,
              outcome:
                run.reason === "backfill_conflict"
                  ? "conflict"
                  : run.reason === "commit_moved"
                    ? "commit_moved"
                    : "error",
              reportId: null,
              changes: 0,
              message: run.message,
            },
      );
    } catch (e) {
      products.push({
        product: p.slug,
        outcome: "error",
        reportId: null,
        changes: 0,
        message: e instanceof Error ? e.message : "unknown error",
      });
    }
  }
  return {
    batchId,
    dryRun: opts.dryRun,
    products,
    next: all.length > page.length ? page[page.length - 1]!.slug : null,
  };
}

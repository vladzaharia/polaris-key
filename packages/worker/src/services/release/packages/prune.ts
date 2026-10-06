/**
 * Feed retention: pruning a package's `main` prereleases once it is released (owner request
 * 2026-10-06; decisions recorded in docs/security/THREAT-MODEL.md, "Feed retention", and
 * docs/RUNBOOK.md).
 *
 * `publish-sdks.yml` publishes every push to main as a prerelease of the NEXT version on the
 * `main` channel: semver `<next>-main.<N>` and, on PyPI, PEP 440 `<next>.dev<N>`. Once `<next>`
 * itself is published on `stable`, those builds are noise in every version list and dead weight
 * in the blob store. So:
 *
 *   WHAT   When version V of a package is published on `stable` (a final release: no prerelease
 *          part), the package's `main`-channel prereleases that sort below V are pruned: semver
 *          `X-main.N` and PEP 440 `X.devN` with X <= V. Never a stable or beta version, never a
 *          prerelease of a version newer than V, never another package. A `beta` publish (a
 *          prerelease tag) prunes nothing.
 *   KEPT   A candidate a channel policy points at (a promote or a pin), or that any other row
 *          still names (a revocation, a pack pin or hold, a download token, a legacy channel row),
 *          is kept and reported: retention never breaks a pointer.
 *   HOW    Per version, one D1 batch: the `release_packages`, `release_artifacts`,
 *          `release_yanks` and `release_metadata` rows go, the version's `artifact` blob refs are
 *          dropped (`core/blobs.ts` `stmtDropRefs`), a tombstone is written
 *          (`release_package_prunes`, which keeps the version unique forever: ingest refuses to
 *          republish it), the deletion is audited (`package.version.prune`: package, version,
 *          actor, bytes) and the package's render is enqueued. The feeds re-render from D1, so
 *          every ecosystem's metadata drops the version at once (npm `versions`/`time` and a
 *          dist-tag that named it, the PyPI simple index, Swift's release list, Maven's
 *          `maven-metadata.xml`, OCI tags, Godot's lists, the Cargo index and the Go list), and
 *          every read path is stamp-checked against D1, so a pruned version is a 404 everywhere
 *          before the drain has run.
 *   SPACE  Bytes are never deleted here. Dropping the refs leaves an object that NOTHING else
 *          references (no ref from any product, of any kind, including a remaining version that
 *          shares the content-addressed blob) for the blob collector (`core/blobGc.ts`) to
 *          reclaim after its grace period and the bucket lock's age; an object another ref holds
 *          stays. `freedBytes` is what the collector will reclaim; `bytes` the version's total.
 *   WHEN   Automatically, right after a stable publish is committed (`pruneAfterStablePublish`,
 *          called by the ingest), for that package only, unless the product turned retention off
 *          (`release.packages.prunePrereleases`; the system product always prunes). A failure
 *          never fails the publish: it is logged and audited (`package.prune.failed`), and the
 *          next stable publish retries it, as does the backfill (`prunePackages`, the admin and CI
 *          routes and `pkey feeds prune`), which dry-runs by default.
 *   IDEMPOTENT  Every statement is idempotent, a pruned version is no longer a candidate, and a
 *          version whose batch failed is retried as a whole the next time.
 *
 * Release-owned tables only (rule 6); the blob refs through Core's helpers.
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db, DbStatement, Env } from "../../../core/platform.js";
import { randomId } from "../../../core/platform.js";
import { appendAudit, auditStatement } from "../../../core/data.js";
import { heldObjects, refsBeyond, stmtDropRefs } from "../../../core/blobs.js";
import { stmtEnqueuePackageRender } from "../../../core/registryQueue.js";
import { bumpReleaseGeneration } from "../ghCache.js";

/** The actor the automatic prune records (`pruned_by`, the audit's `actor_sub`). */
export const PRUNE_ACTOR = "system:feed-retention";

/** The channel `publish-sdks.yml`'s builds of main are published on. */
export const MAIN_CHANNEL = "main";

/** The blob-ref kind a package version's files are held by (`ingest.ts`). */
const ARTIFACT_REF = "artifact";

// ── Versions ─────────────────────────────────────────────────────────────────────────────────

/** A release number: `1.2.3` as `[1, 2, 3]`. */
export type ReleaseNumber = readonly number[];

const NUMBER = "(\\d+(?:\\.\\d+)*)";
/** Semver-shaped feeds (npm, Swift, Maven, OCI, Godot, Cargo; Go with its `v`). */
const SEMVER_FINAL = new RegExp(`^v?${NUMBER}$`);
const SEMVER_MAIN = new RegExp(`^v?${NUMBER}-main\\.(\\d+)$`);
/** PEP 440 (PyPI): a final release, and a developmental release of one. */
const PEP440_FINAL = new RegExp(`^${NUMBER}$`);
const PEP440_MAIN = new RegExp(`^${NUMBER}\\.dev(\\d+)$`);

function numberOf(text: string): ReleaseNumber {
  return text.split(".").map((n) => Number(n));
}

/** The release number of a FINAL version (`1.4.0`, Go's `v1.4.0`), or `null` for anything else. */
export function finalRelease(
  ecosystem: string,
  version: string,
): ReleaseNumber | null {
  const m = (ecosystem === "pypi" ? PEP440_FINAL : SEMVER_FINAL).exec(version);
  return m ? numberOf(m[1]!) : null;
}

/**
 * The release number X of a build of main (`X-main.N`, or PyPI's `X.devN`), or `null` when the
 * version is not one. A beta (`1.4.0-rc.1`, `1.4.0rc1`) is never one.
 */
export function mainPrerelease(
  ecosystem: string,
  version: string,
): ReleaseNumber | null {
  const m = (ecosystem === "pypi" ? PEP440_MAIN : SEMVER_MAIN).exec(version);
  return m ? numberOf(m[1]!) : null;
}

/** Compare two release numbers, missing parts as 0 (`1.4` = `1.4.0`). */
export function compareRelease(a: ReleaseNumber, b: ReleaseNumber): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Does publishing `version` on `channel` prune? Only a final release on `stable`: a beta (a
 * prerelease tag, on `beta`) or a build of main never does.
 */
export function triggersPrune(
  ecosystem: string,
  version: string,
  channel: string | null | undefined,
): boolean {
  return channel === "stable" && finalRelease(ecosystem, version) !== null;
}

// ── The setting ──────────────────────────────────────────────────────────────────────────────

export interface PruneRetention {
  /** The effective value: prune `main` prereleases on a stable publish. */
  prunePrereleases: boolean;
  /** The system product always prunes; its value cannot be turned off. */
  locked: boolean;
  /** 0 = never written (the default, on). */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** `release.packages.prunePrereleases` for `product` (no row: on; the system product: on). */
export async function pruneRetentionOf(
  db: Db,
  product: string,
): Promise<PruneRetention> {
  const row = await db.first<{
    prune_prereleases: number;
    version: number;
    updated_at: number;
    updated_by: string | null;
  }>(
    `SELECT prune_prereleases, version, updated_at, updated_by
       FROM release_package_retention WHERE product = ?`,
    product,
  );
  const locked = product === SYSTEM_PRODUCT_SLUG;
  return {
    prunePrereleases: locked || !row || row.prune_prereleases === 1,
    locked,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/**
 * Set `product`'s retention switch, only while its version is still `expectedVersion` (0 for a
 * row never written). Answers whether it was written; the system product's is refused (locked).
 */
export async function setPruneRetention(
  db: Db,
  product: string,
  enabled: boolean,
  expectedVersion: number,
  by: string,
  now: number,
): Promise<"written" | "stale" | "locked"> {
  if (product === SYSTEM_PRODUCT_SLUG) return "locked";
  const changed =
    expectedVersion === 0
      ? await db.runChanges(
          `INSERT INTO release_package_retention
             (product, prune_prereleases, version, updated_at, updated_by)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(product) DO NOTHING`,
          product,
          enabled ? 1 : 0,
          now,
          by,
        )
      : await db.runChanges(
          `UPDATE release_package_retention
              SET prune_prereleases = ?, version = version + 1, updated_at = ?, updated_by = ?
            WHERE product = ? AND version = ?`,
          enabled ? 1 : 0,
          now,
          by,
          product,
          expectedVersion,
        );
  return changed > 0 ? "written" : "stale";
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

export interface PruneVersion {
  releaseId: string;
  version: string;
  /** The version's files, and their total size. */
  files: number;
  bytes: number;
  /** The part of `bytes` no remaining ref holds: what the collector will reclaim. */
  freedBytes: number;
}

export interface PruneKept {
  releaseId: string;
  version: string;
  /** `pinned`: a channel points at it; `referenced`: another row names it. */
  reason: "pinned" | "referenced";
}

export interface PackagePrunePlan {
  deliverableId: string;
  ecosystem: string;
  name: string;
  nameNorm: string;
  /** The stable version the plan prunes below. */
  stable: string;
  prune: PruneVersion[];
  kept: PruneKept[];
  bytes: number;
  freedBytes: number;
}

interface CandidateRow {
  release_id: string;
  version: string;
  ecosystem: string;
  name: string;
  name_norm: string;
  channel: string | null;
  published_at: number;
}

async function packageRows(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<CandidateRow[]> {
  return db.all<CandidateRow>(
    `SELECT p.release_id, p.version, p.ecosystem, p.name, p.name_norm, m.channel,
            p.published_at
       FROM release_packages p
       JOIN release_metadata m ON m.product = p.product AND m.release_id = p.release_id
      WHERE p.product = ? AND p.deliverable_id = ?
      ORDER BY p.published_at ASC, p.version ASC`,
    product,
    deliverableId,
  );
}

/** Why a release may not be deleted, or `null` when nothing but its own rows names it. */
async function holdOn(
  db: Db,
  product: string,
  releaseId: string,
): Promise<PruneKept["reason"] | null> {
  const p = product;
  const r = releaseId;
  const row = await db.first<{ pinned: number; referenced: number }>(
    `SELECT
       EXISTS (SELECT 1 FROM release_channel_policy
                WHERE product = ? AND pointer_release_id = ?) AS pinned,
       (EXISTS (SELECT 1 FROM release_revocations
                 WHERE product = ? AND (target_release_id = ? OR replacement_release_id = ?))
        OR EXISTS (SELECT 1 FROM release_channels WHERE product = ? AND release_id = ?)
        OR EXISTS (SELECT 1 FROM release_download_tokens WHERE product = ? AND release_id = ?)
        OR EXISTS (SELECT 1 FROM release_pins
                    WHERE product = ? AND (app_release_id = ? OR pack_release_id = ?))
        OR EXISTS (SELECT 1 FROM release_holds
                    WHERE product = ? AND (app_release_id = ? OR pack_release_id = ?))
       ) AS referenced`,
    ...[p, r, p, r, r, p, r, p, r, p, r, r, p, r, r],
  );
  if (row?.pinned) return "pinned";
  if (row?.referenced) return "referenced";
  return null;
}

/** The ref ids a release's files are held by (`<releaseId>/<artifactId>`, `ingest.ts`). */
async function artifactRefIds(
  db: Db,
  product: string,
  releaseId: string,
): Promise<string[]> {
  const rows = await db.all<{ artifact_id: string }>(
    "SELECT artifact_id FROM release_artifacts WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
  return rows.map((r) => `${releaseId}/${r.artifact_id}`);
}

/**
 * What pruning `deliverableId` below `stable` would delete, and what it keeps. `null` when the
 * deliverable has no package version at all, or `stable` is not a final release of its
 * ecosystem. Reads only; nothing is written.
 */
export async function planPackagePrune(
  db: Db,
  product: string,
  deliverableId: string,
  stable: string,
): Promise<PackagePrunePlan | null> {
  const rows = await packageRows(db, product, deliverableId);
  const first = rows[0];
  if (!first) return null;
  const ceiling = finalRelease(first.ecosystem, stable);
  if (!ceiling) return null;
  const plan: PackagePrunePlan = {
    deliverableId,
    ecosystem: first.ecosystem,
    name: first.name,
    nameNorm: first.name_norm,
    stable,
    prune: [],
    kept: [],
    bytes: 0,
    freedBytes: 0,
  };
  const chosen: { row: CandidateRow; refIds: string[] }[] = [];
  for (const row of rows) {
    if (row.channel !== MAIN_CHANNEL) continue;
    const base = mainPrerelease(row.ecosystem, row.version);
    if (!base || compareRelease(base, ceiling) > 0) continue;
    const hold = await holdOn(db, product, row.release_id);
    if (hold) {
      plan.kept.push({
        releaseId: row.release_id,
        version: row.version,
        reason: hold,
      });
      continue;
    }
    chosen.push({
      row,
      refIds: await artifactRefIds(db, product, row.release_id),
    });
  }
  // The refcount: a key is freed only when no ref outside the WHOLE plan holds it (a later
  // version, another package, another product, a pack, an OCI push); a key two pruned versions
  // share is counted once, against the first.
  const allRefIds = chosen.flatMap((c) => c.refIds);
  const held = await heldObjects(db, product, ARTIFACT_REF, allRefIds);
  const beyond = await refsBeyond(
    db,
    held.map((h) => h.storageKey),
    { product, refKind: ARTIFACT_REF, refIds: allRefIds },
  );
  const byRef = new Map<string, typeof held>();
  for (const h of held) {
    const list = byRef.get(h.refId) ?? [];
    list.push(h);
    byRef.set(h.refId, list);
  }
  const counted = new Set<string>();
  for (const { row, refIds } of chosen) {
    let bytes = 0;
    let freed = 0;
    const seen = new Set<string>();
    for (const id of refIds)
      for (const h of byRef.get(id) ?? []) {
        if (seen.has(h.storageKey)) continue;
        seen.add(h.storageKey);
        bytes += h.size;
        if (
          (beyond.get(h.storageKey) ?? 0) === 0 &&
          !counted.has(h.storageKey)
        ) {
          counted.add(h.storageKey);
          freed += h.size;
        }
      }
    plan.prune.push({
      releaseId: row.release_id,
      version: row.version,
      files: refIds.length,
      bytes,
      freedBytes: freed,
    });
    plan.bytes += bytes;
    plan.freedBytes += freed;
  }
  return plan;
}

/** The newest final release of a deliverable published on `stable`, or `null`. */
export async function newestStable(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<string | null> {
  let best: { version: string; n: ReleaseNumber } | null = null;
  for (const row of await packageRows(db, product, deliverableId)) {
    if (row.channel !== "stable") continue;
    const n = finalRelease(row.ecosystem, row.version);
    if (n && (!best || compareRelease(n, best.n) > 0))
      best = { version: row.version, n };
  }
  return best?.version ?? null;
}

// ── Applying it ──────────────────────────────────────────────────────────────────────────────

/** Who prunes: the audit row's actor. */
export interface PruneActor {
  sub: string;
  name: string;
  email?: string | null;
}

/** The automatic prune's actor. */
export const SYSTEM_PRUNE_ACTOR: PruneActor = {
  sub: PRUNE_ACTOR,
  name: "Feed retention",
};

export interface PruneApplied {
  pruned: PruneVersion[];
  failed: { version: string; error: string }[];
}

/** The statements that delete one version, tombstone it, audit it and re-render its package. */
function pruneStatements(
  product: string,
  plan: PackagePrunePlan,
  v: PruneVersion,
  refIds: readonly string[],
  actor: PruneActor,
  now: number,
): DbStatement[] {
  const rel = [product, v.releaseId];
  return [
    {
      sql: `INSERT INTO release_package_prunes
              (product, ecosystem, name_norm, version, deliverable_id, release_id, stable, files,
               bytes, freed_bytes, pruned_at, pruned_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(product, ecosystem, name_norm, version) DO NOTHING`,
      params: [
        product,
        plan.ecosystem,
        plan.nameNorm,
        v.version,
        plan.deliverableId,
        v.releaseId,
        plan.stable,
        v.files,
        v.bytes,
        v.freedBytes,
        now,
        actor.sub,
      ],
    },
    stmtDropRefs(product, ARTIFACT_REF, refIds),
    {
      sql: "DELETE FROM release_packages WHERE product = ? AND release_id = ?",
      params: rel,
    },
    {
      sql: "DELETE FROM release_artifacts WHERE product = ? AND release_id = ?",
      params: rel,
    },
    {
      sql: "DELETE FROM release_yanks WHERE product = ? AND release_id = ?",
      params: rel,
    },
    {
      sql: "DELETE FROM release_metadata WHERE product = ? AND release_id = ?",
      params: rel,
    },
    auditStatement({
      product,
      id: randomId("aud"),
      at: now,
      actor_sub: actor.sub,
      actor_name: actor.name,
      actor_email: actor.email ?? null,
      action: "package.version.prune",
      target_kind: "package",
      target_id: `${plan.ecosystem}:${plan.name}@${v.version}`,
      parent_id: null,
      summary: `Pruned ${plan.name} ${v.version} (a build of main below ${plan.stable}): ${v.files} file${v.files === 1 ? "" : "s"}, ${v.bytes} bytes, ${v.freedBytes} bytes no longer referenced`,
    }),
    stmtEnqueuePackageRender(product, plan.deliverableId, "prune", now),
  ];
}

/**
 * Prune what `plan` lists: one batch per version, so a failure leaves the others done and that
 * version whole for the next run. A version some other writer pinned since the plan was read is
 * kept (re-checked just before its batch).
 */
export async function applyPackagePrune(
  db: Db,
  env: Env,
  product: string,
  plan: PackagePrunePlan,
  actor: PruneActor,
  now: number,
): Promise<PruneApplied> {
  const out: PruneApplied = { pruned: [], failed: [] };
  for (const v of plan.prune) {
    try {
      if (await holdOn(db, product, v.releaseId)) continue;
      const refIds = await artifactRefIds(db, product, v.releaseId);
      await db.batch(pruneStatements(product, plan, v, refIds, actor, now));
      out.pruned.push(v);
    } catch (e) {
      out.failed.push({
        version: v.version,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (out.pruned.length) await bumpReleaseGeneration(env, product, now);
  return out;
}

/** Log and audit a prune that failed (never thrown back at the publish). */
async function recordFailure(
  db: Db,
  product: string,
  target: string,
  stable: string,
  detail: string,
  now: number,
): Promise<void> {
  console.error(
    JSON.stringify({
      event: "package.prune.failed",
      product,
      package: target,
      stable,
      error: detail,
    }),
  );
  try {
    await appendAudit(db, {
      product,
      id: randomId("aud"),
      at: now,
      actor_sub: PRUNE_ACTOR,
      actor_name: SYSTEM_PRUNE_ACTOR.name,
      actor_email: null,
      action: "package.prune.failed",
      target_kind: "package",
      target_id: target,
      parent_id: null,
      summary:
        `Pruning the builds of main below ${stable} failed (retried on the next stable publish, or run pkey feeds prune): ${detail}`.slice(
          0,
          1000,
        ),
    });
  } catch {
    // The log line above is the record of last resort.
  }
}

export type AutoPruneOutcome =
  | { status: "not-stable" }
  | { status: "off" }
  | { status: "pruned"; plan: PackagePrunePlan; applied: PruneApplied }
  | { status: "failed"; error: string };

/**
 * The automatic prune, after a package version was published and committed: when it is a final
 * release on `stable` and the product keeps retention on, prune that package's builds of main
 * below it. NEVER throws: a failure is logged and audited, and the next stable publish (or the
 * backfill) retries it.
 */
export async function pruneAfterStablePublish(
  db: Db,
  env: Env,
  product: string,
  published: {
    deliverableId: string;
    ecosystem: string;
    name: string;
    version: string;
    channel: string | null | undefined;
  },
  now: number,
): Promise<AutoPruneOutcome> {
  if (!triggersPrune(published.ecosystem, published.version, published.channel))
    return { status: "not-stable" };
  const target = `${published.ecosystem}:${published.name}`;
  try {
    if (!(await pruneRetentionOf(db, product)).prunePrereleases)
      return { status: "off" };
    const plan = await planPackagePrune(
      db,
      product,
      published.deliverableId,
      published.version,
    );
    if (!plan)
      return {
        status: "pruned",
        plan: emptyPlan(published),
        applied: { pruned: [], failed: [] },
      };
    const applied = await applyPackagePrune(
      db,
      env,
      product,
      plan,
      SYSTEM_PRUNE_ACTOR,
      now,
    );
    for (const f of applied.failed)
      await recordFailure(
        db,
        product,
        `${target}@${f.version}`,
        published.version,
        f.error,
        now,
      );
    return { status: "pruned", plan, applied };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await recordFailure(db, product, target, published.version, error, now);
    return { status: "failed", error };
  }
}

function emptyPlan(p: {
  deliverableId: string;
  ecosystem: string;
  name: string;
  version: string;
}): PackagePrunePlan {
  return {
    deliverableId: p.deliverableId,
    ecosystem: p.ecosystem,
    name: p.name,
    nameNorm: p.name,
    stable: p.version,
    prune: [],
    kept: [],
    bytes: 0,
    freedBytes: 0,
  };
}

// ── The backfill ─────────────────────────────────────────────────────────────────────────────

export interface PrunePackageReport extends PackagePrunePlan {
  /** Only with `apply`: what went, and what failed (retry by running it again). */
  failed?: { version: string; error: string }[];
}

export interface PruneReport {
  product: string;
  dryRun: boolean;
  /** The product's retention setting (the backfill runs either way: it is an explicit act). */
  prunePrereleases: boolean;
  packages: PrunePackageReport[];
  /** Packages with no stable release yet, which nothing is pruned below. */
  skipped: { deliverableId: string; reason: "no-stable" }[];
  totals: {
    versions: number;
    bytes: number;
    freedBytes: number;
    failed: number;
  };
}

/**
 * The backfill: for each package of `product` (or the one `deliverable`), prune its builds of
 * main below its NEWEST stable release. `apply: false` (the default everywhere it is exposed)
 * only plans; `apply: true` deletes, auditing each version under `actor`.
 */
export async function prunePackages(
  db: Db,
  env: Env,
  product: string,
  opts: {
    apply: boolean;
    deliverable?: string;
    actor: PruneActor;
    now: number;
  },
): Promise<PruneReport | null> {
  const ids = (
    await db.all<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM release_deliverables
        WHERE product = ? AND kind = 'package'
        ORDER BY deliverable_id`,
      product,
    )
  )
    .map((r) => r.deliverable_id)
    .filter((id) => opts.deliverable === undefined || id === opts.deliverable);
  if (opts.deliverable !== undefined && ids.length === 0) return null;
  const report: PruneReport = {
    product,
    dryRun: !opts.apply,
    prunePrereleases: (await pruneRetentionOf(db, product)).prunePrereleases,
    packages: [],
    skipped: [],
    totals: { versions: 0, bytes: 0, freedBytes: 0, failed: 0 },
  };
  for (const id of ids) {
    const stable = await newestStable(db, product, id);
    if (!stable) {
      report.skipped.push({ deliverableId: id, reason: "no-stable" });
      continue;
    }
    const plan = await planPackagePrune(db, product, id, stable);
    if (!plan) continue;
    let entry: PrunePackageReport = plan;
    if (opts.apply) {
      const applied = await applyPackagePrune(
        db,
        env,
        product,
        plan,
        opts.actor,
        opts.now,
      );
      const done = new Set(applied.pruned.map((v) => v.releaseId));
      const pruned = plan.prune.filter((v) => done.has(v.releaseId));
      entry = {
        ...plan,
        prune: pruned,
        bytes: pruned.reduce((a, v) => a + v.bytes, 0),
        freedBytes: pruned.reduce((a, v) => a + v.freedBytes, 0),
        failed: applied.failed,
      };
      report.totals.failed += applied.failed.length;
    }
    report.packages.push(entry);
    report.totals.versions += entry.prune.length;
    report.totals.bytes += entry.bytes;
    report.totals.freedBytes += entry.freedBytes;
  }
  return report;
}

/** Is `version` of this package a pruned one (the tombstone)? Ingest refuses to republish it. */
export async function prunedVersion(
  db: Db,
  product: string,
  ecosystem: string,
  nameNorm: string,
  version: string,
): Promise<{ stable: string; prunedAt: number } | null> {
  const row = await db.first<{ stable: string; pruned_at: number }>(
    `SELECT stable, pruned_at FROM release_package_prunes
      WHERE product = ? AND ecosystem = ? AND name_norm = ? AND version = ?`,
    product,
    ecosystem,
    nameNorm,
    version,
  );
  return row ? { stable: row.stable, prunedAt: row.pruned_at } : null;
}

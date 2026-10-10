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
 *          The ceiling is a LIVE stable row: a yanked or deprecated stable never is one, so it
 *          cannot pull builds of main above the newest live release into the prune.
 *   KEPT   A candidate a channel policy points at (a promote or a pin), or that any other row
 *          still names (a revocation, a pack pin or hold, a download token, a legacy channel row),
 *          is kept and reported: retention never breaks a pointer. One that became held between
 *          the plan and its deletion is `skipped` and reported the same way, never dropped
 *          silently.
 *   HOW    In atomic D1 batches of up to 20 versions (at most 200 per run): per version, the
 *          `release_packages`, `release_artifacts`, `release_yanks` and `release_metadata` rows
 *          go, the version's `package-file` blob refs are dropped (`core/assets/blobs.ts` `stmtDropRefs`), a
 *          tombstone is written (`release_package_prunes`, which keeps the version unique
 *          forever: ingest refuses to republish it), the deletion is audited
 *          (`package.version.prune`: package, version, actor, bytes; its `parent_id` the stable
 *          release that set the ceiling) and the package's render is enqueued. The feeds
 *          re-render from D1, so every ecosystem's metadata drops the version at once (npm
 *          `versions`/`time` and a dist-tag that named it, the PyPI simple index, Swift's release
 *          list, Maven's `maven-metadata.xml`, OCI tags, Godot's lists, the Cargo index and the Go
 *          list), and every read path is stamp-checked against D1, so the Worker stops serving a
 *          pruned version before the drain has run. The residual is the edge Cache API: a data
 *          centre whose cache already holds one of the version's immutable byte URLs can still
 *          answer it until that copy is evicted, and the Worker cannot purge other data centres
 *          (THREAT-MODEL "Feed retention").
 *   SPACE  Bytes are never deleted here. Dropping the refs leaves an object that NOTHING else
 *          references (no ref from any product, of any kind, including a remaining version that
 *          shares the content-addressed blob) for the blob collector (`core/assets/blobGc.ts`) to
 *          reclaim after its grace period and the bucket lock's age; an object another ref holds
 *          stays. `bytes` is the version's total; `freedBytes` the part no remaining ref holds.
 *          A plan counts it against the whole plan; an apply recounts it per batch against the
 *          refs left after that batch, so a run the cap or a failure cuts short records (in the
 *          tombstone, the audit and the report) only what its own deletions left unreferenced.
 *   WHEN   Automatically, right after a stable publish is committed (`pruneAfterStablePublish`,
 *          called by the ingest), for that package only, when the product turned retention on
 *          (`release.packages.prunePrereleases`: off by default for a tenant product, which opts
 *          in; the system product always prunes). A failure never fails the publish: it is
 *          audited (`package.prune.failed`), and the next stable publish retries it, as does the
 *          backfill (`prunePackages`, the admin and CI routes and `pkey feeds prune`), which
 *          dry-runs by default.
 *   IDEMPOTENT  Every statement is idempotent, a pruned version is no longer a candidate, and a
 *          version whose batch failed is retried as a whole the next time.
 *
 * Release-owned tables only (rule 6); the blob refs through Core's helpers.
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { randomId } from "../../../platform/crypto.js";
import { appendAudit, auditStatement } from "../../../core/repo.js";
import {
  PACKAGE_FILE_REF,
  heldObjects,
  refsBeyond,
  stmtDropRefs,
  type HeldObject,
} from "../../../core/assets/blobs.js";
import { stmtEnqueuePackageRender } from "../../../core/registry/registryQueue.js";
import { bumpReleaseGeneration } from "../ghCache.js";
import {
  writeSetting,
  type AuditActor,
  type SettingsWriteContext,
  type WriteRefusal,
} from "../../../core/settings/write.js";

/** The actor the automatic prune records (`pruned_by`, the audit's `actor_sub`). */
export const PRUNE_ACTOR = "system:feed-retention";

/** The channel `publish-sdks.yml`'s builds of main are published on. */
export const MAIN_CHANNEL = "main";

/** The blob-ref kind a package version's files are held by (`ingest.ts`; SEC-DST-1). */
const ARTIFACT_REF = PACKAGE_FILE_REF;

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
  /** 0 = never written (the default: off for a tenant product, on for the system product). */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

/**
 * `release.packages.prunePrereleases` for `product`: no row is the default, OFF for a tenant
 * product (it opts in); the system product is always on.
 *
 * ST-04: the setting is written through `writeSetting()` (its column adapter is in
 * `../settingsColumns.ts`), whose `product_settings` row carries the version a write must name,
 * so `version` is read from there. The table keeps its own audit columns, which stand in for the
 * author of a value written before ST-04.
 */
export async function pruneRetentionOf(
  db: Db,
  product: string,
): Promise<PruneRetention> {
  const row = await db.first<{
    prune_prereleases: number;
    updated_at: number;
    updated_by: string | null;
  }>(
    `SELECT prune_prereleases, updated_at, updated_by
       FROM release_package_retention WHERE product = ?`,
    product,
  );
  const setting = await db.first<{
    version: number;
    updated_at: number;
    updated_by: string;
  }>(
    "SELECT version, updated_at, updated_by FROM product_settings WHERE product = ? AND key = ?",
    product,
    PRUNE_SETTING_KEY,
  );
  const locked = retentionLocked(product);
  return {
    prunePrereleases: locked || row?.prune_prereleases === 1,
    locked,
    version: setting?.version ?? 0,
    updatedAt: setting?.updated_at ?? row?.updated_at ?? null,
    updatedBy: setting?.updated_by ?? row?.updated_by ?? null,
  };
}

/** The registry key of the retention switch. */
export const PRUNE_SETTING_KEY = "release.packages.prunePrereleases";

/** The system product always prunes: its switch is locked on and a write is refused. */
export function retentionLocked(product: string): boolean {
  return product === SYSTEM_PRODUCT_SLUG;
}

/**
 * Set `product`'s retention switch through `writeSetting()` (ST-04), only while the setting's
 * version is still `expectedVersion` (0: never written). The system product's is refused
 * (`locked`). The stored author keeps the table's `admin:<sub>` spelling; the audit row
 * (`feed.retention.update`) names the operator as every audit row does.
 */
export async function setPruneRetention(
  ctx: SettingsWriteContext,
  w: {
    product: {
      slug: string;
      system?: number | null;
      release_source?: string | null;
    };
    enabled: boolean;
    expectedVersion: number;
    actor: AuditActor;
    now: number;
  },
): Promise<"written" | "stale" | "locked" | WriteRefusal> {
  if (retentionLocked(w.product.slug)) return "locked";
  const res = await writeSetting(
    ctx,
    {
      key: PRUNE_SETTING_KEY,
      value: w.enabled,
      expectedVersion: w.expectedVersion,
      audit: {
        action: "feed.retention.update",
        target: { kind: "feed", id: "retention" },
        summary: w.enabled
          ? "Turned on pruning of the builds of main once a version is released"
          : "Turned off pruning of the builds of main once a version is released",
      },
    },
    {
      actor: w.actor,
      author: `admin:${w.actor.sub ?? "system"}`,
      origin: "console",
      now: w.now,
      product: w.product,
      // The route's contract always carried `expectedVersion`; its confirmation is the console's.
      strict: false,
    },
  );
  if (res.ok) return "written";
  return res.reason === "version_conflict" ? "stale" : res;
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

/** A version the plan listed that became held before its batch: kept, and reported. */
export type PruneSkipped = PruneKept;

export interface PackagePrunePlan {
  deliverableId: string;
  ecosystem: string;
  name: string;
  nameNorm: string;
  /** The stable version the plan prunes below. */
  stable: string;
  /** That stable version's release id (`<deliverable>@<stable>`): the audit rows' `parent_id`. */
  stableReleaseId: string;
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
  /** `live`, `yanked` or `deprecated`: only a live stable row is ever a ceiling. */
  state: string;
  channel: string | null;
  published_at: number;
}

/** Is `row` a live final release on `stable`: a row that may set a prune's ceiling? */
function isLiveStable(row: CandidateRow): boolean {
  return (
    row.channel === "stable" &&
    row.state === "live" &&
    finalRelease(row.ecosystem, row.version) !== null
  );
}

async function packageRows(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<CandidateRow[]> {
  return db.all<CandidateRow>(
    `SELECT p.release_id, p.version, p.ecosystem, p.name, p.name_norm, p.state, m.channel,
            p.published_at
       FROM release_packages p
       JOIN release_metadata m ON m.product = p.product AND m.release_id = p.release_id
      WHERE p.product = ? AND p.deliverable_id = ?
      ORDER BY p.published_at ASC, p.version ASC`,
    product,
    deliverableId,
  );
}

/** Release ids per `json_each` parameter. */
const IDS_PER_QUERY = 500;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Why each of `releaseIds` may not be deleted (absent: nothing but its own rows names it). One
 * query per 500 ids, so a plan stays inside D1's per-invocation query budget.
 */
async function holdsOf(
  db: Db,
  product: string,
  releaseIds: readonly string[],
): Promise<Map<string, PruneKept["reason"]>> {
  const out = new Map<string, PruneKept["reason"]>();
  for (const ids of chunks([...new Set(releaseIds)], IDS_PER_QUERY)) {
    const p = product;
    const j = JSON.stringify(ids);
    const rows = await db.all<{
      id: string;
      pinned: number;
      referenced: number;
    }>(
      `SELECT ids.value AS id,
         EXISTS (SELECT 1 FROM release_channel_policy
                  WHERE product = ? AND pointer_release_id = ids.value) AS pinned,
         (EXISTS (SELECT 1 FROM release_revocations
                   WHERE product = ? AND (target_release_id = ids.value
                                          OR replacement_release_id = ids.value))
          OR EXISTS (SELECT 1 FROM release_channels WHERE product = ? AND release_id = ids.value)
          OR EXISTS (SELECT 1 FROM release_download_tokens
                      WHERE product = ? AND release_id = ids.value)
          OR EXISTS (SELECT 1 FROM release_pins
                      WHERE product = ? AND (app_release_id = ids.value
                                             OR pack_release_id = ids.value))
          OR EXISTS (SELECT 1 FROM release_holds
                      WHERE product = ? AND (app_release_id = ids.value
                                             OR pack_release_id = ids.value))
         ) AS referenced
         FROM json_each(?) AS ids`,
      p,
      p,
      p,
      p,
      p,
      p,
      j,
    );
    for (const r of rows) {
      if (r.pinned) out.set(r.id, "pinned");
      else if (r.referenced) out.set(r.id, "referenced");
    }
  }
  return out;
}

/** The ref ids each release's files are held by (`<releaseId>/<artifactId>`, `ingest.ts`). */
async function artifactRefIdsOf(
  db: Db,
  product: string,
  releaseIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of releaseIds) out.set(id, []);
  for (const ids of chunks([...new Set(releaseIds)], IDS_PER_QUERY)) {
    const rows = await db.all<{ release_id: string; artifact_id: string }>(
      `SELECT release_id, artifact_id FROM release_artifacts
        WHERE product = ? AND release_id IN (SELECT value FROM json_each(?))
        ORDER BY release_id, artifact_id`,
      product,
      JSON.stringify(ids),
    );
    for (const r of rows)
      out.get(r.release_id)?.push(`${r.release_id}/${r.artifact_id}`);
  }
  return out;
}

/**
 * Per version, its files' total size and the part no ref outside `excluded` holds (`freed`): the
 * refcount. A key two of `versions` share is counted once, against the first; a key any ref
 * beyond the exclusion holds (a version not in the set, another package, another product, a
 * pack, an OCI push) is never freed.
 */
function sizeVersions(
  versions: readonly { refIds: readonly string[] }[],
  held: readonly HeldObject[],
  beyond: ReadonlyMap<string, number>,
): { bytes: number; freed: number }[] {
  const byRef = new Map<string, HeldObject[]>();
  for (const h of held) {
    const list = byRef.get(h.refId) ?? [];
    list.push(h);
    byRef.set(h.refId, list);
  }
  const counted = new Set<string>();
  return versions.map(({ refIds }) => {
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
    return { bytes, freed };
  });
}

/**
 * What pruning `deliverableId` below `stable` would delete, and what it keeps. `null` when the
 * deliverable has no package version at all, `stable` is not a final release of its ecosystem,
 * or it is not a LIVE stable release of this deliverable (a yanked or deprecated stable is never
 * a ceiling). Reads only; nothing is written.
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
  const ceilingRow = rows.find((r) => r.version === stable && isLiveStable(r));
  if (!ceilingRow) return null;
  const plan: PackagePrunePlan = {
    deliverableId,
    ecosystem: first.ecosystem,
    name: first.name,
    nameNorm: first.name_norm,
    stable,
    stableReleaseId: ceilingRow.release_id,
    prune: [],
    kept: [],
    bytes: 0,
    freedBytes: 0,
  };
  const candidates = rows.filter((row) => {
    if (row.channel !== MAIN_CHANNEL) return false;
    const base = mainPrerelease(row.ecosystem, row.version);
    return base !== null && compareRelease(base, ceiling) <= 0;
  });
  const holds = await holdsOf(
    db,
    product,
    candidates.map((r) => r.release_id),
  );
  const free = candidates.filter((row) => {
    const hold = holds.get(row.release_id);
    if (hold)
      plan.kept.push({
        releaseId: row.release_id,
        version: row.version,
        reason: hold,
      });
    return !hold;
  });
  const refIdsByRelease = await artifactRefIdsOf(
    db,
    product,
    free.map((r) => r.release_id),
  );
  const chosen = free.map((row) => ({
    row,
    refIds: refIdsByRelease.get(row.release_id) ?? [],
  }));
  // The refcount, against the WHOLE plan: a key is freed only when no ref outside it holds it.
  const allRefIds = chosen.flatMap((c) => c.refIds);
  const held = await heldObjects(db, product, ARTIFACT_REF, allRefIds);
  const beyond = await refsBeyond(
    db,
    held.map((h) => h.storageKey),
    { product, refKind: ARTIFACT_REF, refIds: allRefIds },
  );
  const sizes = sizeVersions(chosen, held, beyond);
  chosen.forEach(({ row, refIds }, i) => {
    const { bytes, freed } = sizes[i]!;
    plan.prune.push({
      releaseId: row.release_id,
      version: row.version,
      files: refIds.length,
      bytes,
      freedBytes: freed,
    });
    plan.bytes += bytes;
    plan.freedBytes += freed;
  });
  return plan;
}

/**
 * The newest LIVE final release of a deliverable published on `stable`, or `null`: a yanked or
 * deprecated stable is never the ceiling, so it cannot make newer builds of main candidates.
 */
export async function newestStable(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<string | null> {
  let best: { version: string; n: ReleaseNumber } | null = null;
  for (const row of await packageRows(db, product, deliverableId)) {
    if (!isLiveStable(row)) continue;
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
  /** What went, each `freedBytes` counted against the refs this run's deletions left. */
  pruned: PruneVersion[];
  failed: { version: string; error: string }[];
  /** Planned versions a pin or another row took hold of before their batch: kept, reported. */
  skipped: PruneSkipped[];
}

/** The statements that delete one version, tombstone it and audit it (the batch adds the render). */
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
      // The stable release that set the ceiling (the publish, or the backfill's newest stable).
      parent_id: plan.stableReleaseId,
      summary: `Pruned ${plan.name} ${v.version} (a build of main below ${plan.stable}): ${v.files} file${v.files === 1 ? "" : "s"}, ${v.bytes} bytes, ${v.freedBytes} bytes no longer referenced`,
    }),
  ];
}

/** Versions per D1 batch: each batch is atomic, so a failure leaves its versions whole. */
const VERSIONS_PER_BATCH = 20;

/**
 * The most versions one run deletes (an automatic prune or one backfill request), so a run stays
 * inside D1's per-invocation query budget; what is left is reported (`more`) and the next run,
 * or the next stable publish, takes it.
 */
export const PRUNE_MAX_PER_RUN = 200;

/**
 * Prune what `plan` lists, at most `limit` versions, in atomic batches of
 * `VERSIONS_PER_BATCH`: a failed batch leaves its versions whole for the next run and the others
 * done. A version some other writer pinned since the plan was read is kept and reported in
 * `skipped` (the holds are read again just before the batches). Each version's `freedBytes` is
 * recounted just before its batch against the refs that batch leaves, so the tombstone and the
 * audit never claim a blob a version this run did not delete (cut off by `limit`, or in a later
 * or failed batch) still holds.
 */
export async function applyPackagePrune(
  db: Db,
  env: Env,
  product: string,
  plan: PackagePrunePlan,
  actor: PruneActor,
  now: number,
  limit: number = PRUNE_MAX_PER_RUN,
): Promise<PruneApplied> {
  const out: PruneApplied = { pruned: [], failed: [], skipped: [] };
  const todo = plan.prune.slice(0, Math.max(0, limit));
  const go: PruneVersion[] = [];
  const skipped: PruneSkipped[] = [];
  let refIds: Map<string, string[]>;
  let objects: HeldObject[];
  try {
    const ids = todo.map((v) => v.releaseId);
    const held = await holdsOf(db, product, ids);
    for (const v of todo) {
      const reason = held.get(v.releaseId);
      if (reason)
        skipped.push({ releaseId: v.releaseId, version: v.version, reason });
      else go.push(v);
    }
    refIds = await artifactRefIdsOf(
      db,
      product,
      go.map((v) => v.releaseId),
    );
    objects = await heldObjects(
      db,
      product,
      ARTIFACT_REF,
      go.flatMap((v) => refIds.get(v.releaseId) ?? []),
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    for (const v of todo) out.failed.push({ version: v.version, error });
    return out;
  }
  out.skipped = skipped;
  for (const batch of chunks(go, VERSIONS_PER_BATCH)) {
    try {
      const versions = batch.map((v) => ({
        v,
        refIds: refIds.get(v.releaseId) ?? [],
      }));
      const batchRefIds = versions.flatMap((x) => x.refIds);
      const mine = new Set(batchRefIds);
      const batchObjects = objects.filter((h) => mine.has(h.refId));
      // Earlier batches' refs are gone by now; later and failed batches' refs still count.
      const beyond = await refsBeyond(
        db,
        batchObjects.map((h) => h.storageKey),
        { product, refKind: ARTIFACT_REF, refIds: batchRefIds },
      );
      const sizes = sizeVersions(versions, batchObjects, beyond);
      const sized = versions.map(
        ({ v }, i): PruneVersion => ({ ...v, freedBytes: sizes[i]!.freed }),
      );
      await db.batch([
        ...sized.flatMap((v) =>
          pruneStatements(
            product,
            plan,
            v,
            refIds.get(v.releaseId) ?? [],
            actor,
            now,
          ),
        ),
        stmtEnqueuePackageRender(product, plan.deliverableId, "prune", now),
      ]);
      out.pruned.push(...sized);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      for (const v of batch) out.failed.push({ version: v.version, error });
    }
  }
  if (out.pruned.length) await bumpReleaseGeneration(env, product, now);
  return out;
}

/** Audit a prune that failed (never thrown back at the publish). */
async function recordFailure(
  db: Db,
  product: string,
  target: string,
  stable: string,
  detail: string,
  now: number,
): Promise<void> {
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
    // Nothing else to write to: the Worker never logs to the console (R12), and the next
    // stable publish or the backfill retries the prune whether or not this row landed.
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
 * below it. NEVER throws: a failure is audited, and the next stable publish (or the
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
        applied: { pruned: [], failed: [], skipped: [] },
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
    stableReleaseId: `${p.deliverableId}@${p.version}`,
    prune: [],
    kept: [],
    bytes: 0,
    freedBytes: 0,
  };
}

// ── The backfill ─────────────────────────────────────────────────────────────────────────────

export interface PrunePackageReport extends PackagePrunePlan {
  /** Only with `apply`: what failed (retry by running it again). */
  failed?: { version: string; error: string }[];
  /** Only with `apply`: planned versions that became held before their batch, so were kept. */
  skipped?: PruneSkipped[];
}

export interface PruneReport {
  product: string;
  dryRun: boolean;
  /** The product's retention setting (the backfill runs either way: it is an explicit act). */
  prunePrereleases: boolean;
  packages: PrunePackageReport[];
  /** Packages with no live stable release yet, which nothing is pruned below. */
  skipped: { deliverableId: string; reason: "no-stable" }[];
  totals: {
    versions: number;
    bytes: number;
    freedBytes: number;
    failed: number;
    /** Versions skipped because they became held between the plan and the deletion. */
    skipped: number;
  };
  /**
   * Only with `apply`: versions were left for another run (at most `PRUNE_MAX_PER_RUN` go per
   * request). `pkey feeds prune --apply` repeats until it is false.
   */
  more: boolean;
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
    totals: { versions: 0, bytes: 0, freedBytes: 0, failed: 0, skipped: 0 },
    more: false,
  };
  let budget = PRUNE_MAX_PER_RUN;
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
        budget,
      );
      if (plan.prune.length > budget) report.more = true;
      budget = Math.max(0, budget - plan.prune.length);
      // What this run deleted, with the freed bytes its own deletions left unreferenced.
      const pruned = applied.pruned;
      entry = {
        ...plan,
        prune: pruned,
        bytes: pruned.reduce((a, v) => a + v.bytes, 0),
        freedBytes: pruned.reduce((a, v) => a + v.freedBytes, 0),
        failed: applied.failed,
        skipped: applied.skipped,
      };
      report.totals.failed += applied.failed.length;
      report.totals.skipped += applied.skipped.length;
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

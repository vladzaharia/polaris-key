/// <reference types="@cloudflare/workers-types" />
/**
 * The blob collector (P4-14, CONTENT §11, notes/E8 §5.7): Core deletes blob-store objects that no
 * live reference needs, after a grace period and never before the R2 bucket lock's age.
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────────────────────────────
 *
 * Every read of the blob store goes through `hasRef`: a product serves a key only while it holds a
 * `blob_refs` row for it (P2-01). So an object with NO ref from ANY product is unservable, and is
 * the only thing the sweep ever deletes. The collector's whole job is therefore in two halves:
 *
 *   1. COLLECT, per product (product-scoped, fault-isolated): drop the refs that no live reference
 *      needs any more — and only the pack refs, whose liveness the hooks can decide;
 *   2. MARK and SWEEP, over the shared `blob_objects` table: stamp objects with no ref at all
 *      (`unreferenced_since`), and delete those unreferenced for the grace period AND older than
 *      the bucket lock, claiming each first so no publish can earn a ref to bytes being deleted.
 *
 * Fail closed throughout: anything the collector cannot read (Release off, an unreadable record or
 * index, a budget spent) means "keep", never "drop".
 *
 * ── WHAT IS LIVE (per product, through Core's hooks only) ───────────────────────────────────
 *
 * Live APP releases: every app release live on any channel (`liveLevels`), every app release an
 * outlet lists (a stored availability record not `rejected`/`removed`) and every app release a
 * rollout names. Live PACK releases are then the union of:
 *
 *   a. the pins and holds of a live app release (`pins`, `holdsFor`; P4-12's hooks);
 *   b. every member of every channel's current stored sets (`packSets`);
 *   c. the previous release (by `seq`, not yanked, not revoked) of each (b) member, so a rollback
 *      to the previous set still finds its bytes;
 *   d. a pack channel's pointer (`channelPolicies`);
 *   e. every release a rollout names (`delivery.rollouts`), so a gate's target and fallback stay;
 *   f. every release an outlet lists (`delivery.reportedAvailability`, stored records only: a
 *      derived record is computed FROM the blob store and must not keep itself alive);
 *   g. the replacement of every revocation in force;
 *   h. every not-yanked, not-revoked release NEWER than the newest live release of its pack (or
 *      every one, when none is live): a release published ahead of the app release that will use
 *      it is not dead.
 *
 * REVOKED releases are never live (plans/P4-13.md §8.5): no client installs one, whatever pins it.
 * A yanked release stays live only through (a), (e) or (f).
 *
 * ── WHICH REFS ARE DROPPED ──────────────────────────────────────────────────────────────────
 *
 *   artifact, feed, anything else   never: an app release's artifacts are served as long as its
 *                                   row exists, and the F-Droid relay replaces its own `feed` refs
 *   pack-object (ref id = release)  when the release is a known pack release that is not live
 *   pack-upload (ref id = pack)     when the key is in no live pack release's record objects,
 *                                   files index (`packFiles`) or chunk index (`packChunks`), of ANY
 *                                   pack of the product (a key one pack uploaded may be named by
 *                                   another's index), and the WHOLE live set was read this tick.
 *                                   A `pack-upload` ref means possession, not liveness (P4-02).
 *                                   A key under `bundles/` is kept while Release has no
 *                                   `packChunks` (the P4-22 hook point, P4-10 decision 16)
 *
 * and only once the ref is older than the grace period, so an upload or an ingest in flight is
 * never undercut. Each drop is logged (`blob_gc_log`) and summarised in the product's audit.
 *
 * ── MARK, CLAIM, SWEEP ──────────────────────────────────────────────────────────────────────
 *
 *   mark    `unreferenced_since := now` on objects with no ref and no stamp; `:= NULL` on stamped
 *           objects that have a ref again. A re-promote (`recordObject`) clears it too.
 *   claim   one conditional UPDATE: `gc_claimed_at := token` where still unclaimed, stamped past
 *           the grace period (a delta whose endpoint is gone or unreferenced needs no grace: it is
 *           a disposable cache, E8 §5.7), created before the lock age, and still without a ref.
 *           `recordObject` refuses a claimed object, so `promote` answers `changed` and no ref can
 *           be earned while the delete runs. The claim and `recordObject` are each one atomic
 *           statement, and a promote clears the stamp, so the two can never both win.
 *   delete  one R2 `delete` of at most `GC_SWEEP_KEYS` keys, then the rows, still conditional on
 *           the claim and on having no ref. An R2 failure releases the claims and fails the step
 *           (`blob_gc_log` `delete-failed`). A claim older than `GC_STALE_CLAIM_SECONDS` (a tick
 *           that died between its claim and its row delete) is finished by the next sweep.
 *
 * Objects never move between prefixes (P4-05), so the same rules hold under `gated/`.
 *
 * ── THE BUCKET LOCK ─────────────────────────────────────────────────────────────────────────
 *
 * `blobs/`, `bundles/`, `deltas/` and `gated/` are locked BY AGE for 180 days (P2-01): a delete
 * before then fails. The sweep never tries one: an object is a candidate only once `created_at` is
 * older than `BLOB_LOCK_AGE_SECONDS` (`created_at` is when the object was first stored, and a
 * re-promote never moves it). In practice the lock age, not the grace period, bounds how soon
 * anything goes. If the lock were ever made indefinite the sweep would only ever fail: escalate,
 * never weaken the lock.
 *
 * ── LIMITS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Bounded per tick, and the next tick resumes: `GC_INDEX_READS_PER_TICK` index reads across every
 * product (a product the budget does not reach drops no `pack-upload` ref this tick; the order
 * rotates daily so every product gets its turn), `GC_DROPS_PER_PRODUCT` refs per product,
 * `GC_MARK_ROWS` per mark pass, and one sweep of `GC_SWEEP_KEYS` keys (one R2 call, R2's limit).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import { appendAudit } from "./data.js";
import { randomId } from "./platform.js";
import { blobKey, parseKey } from "./blobs.js";
import type { CatalogRelease, ReleaseCatalog, ServiceHooks } from "./hooks.js";
import { adminJson, adminNotFound, err } from "./adminApi.js";
import { ErrorCode } from "./errors.js";

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

/** The R2 bucket lock's age on `blobs/`, `bundles/`, `deltas/` and `gated/` (P2-01). */
export const BLOB_LOCK_AGE_SECONDS = 180 * 24 * 60 * 60;
/** How long an object stays unreferenced before the sweep may take it (default; configurable). */
export const DEFAULT_GC_GRACE_SECONDS = 30 * 24 * 60 * 60;
/**
 * The shortest grace period a deployment may configure. Upload tickets and ingests finish within
 * minutes; a day keeps every one of them inside the window that protects its refs.
 */
export const MIN_GC_GRACE_SECONDS = 24 * 60 * 60;
/** Index reads (`packFiles`, `packChunks`) per tick, across every product. */
export const GC_INDEX_READS_PER_TICK = 400;
/** Refs one product drops per tick. */
export const GC_DROPS_PER_PRODUCT = 5000;
/** Rows one mark pass stamps; a pass repeats up to `GC_MARK_PASSES` times. */
export const GC_MARK_ROWS = 2000;
export const GC_MARK_PASSES = 10;
/** Keys one sweep deletes: one R2 `delete` call (R2 takes at most 1,000). */
export const GC_SWEEP_KEYS = 1000;
/** A claim this old was left by a tick that died mid-sweep: the next sweep finishes it. */
export const GC_STALE_CLAIM_SECONDS = 60 * 60;
/** Availability states in which an outlet still lists a release. */
const UNLISTED_STATES: ReadonlySet<string> = new Set(["rejected", "removed"]);
/** Keys per `json_each` parameter (well inside D1's 2 MB value limit). */
const JSON_KEYS = 500;

export interface BlobGcSettings {
  /** `off` stops the collector entirely (`BLOB_GC_MODE=off`, the operator's kill switch). */
  enabled: boolean;
  graceSeconds: number;
}

/**
 * The deployment's settings: `BLOB_GC_MODE` (`on`, the default, or `off`) and `BLOB_GC_GRACE_DAYS`
 * (default 30, at least 1). An unparseable value falls back to the default, never to "no grace".
 */
export function blobGcSettings(env: Env): BlobGcSettings {
  const vars = env as unknown as Record<string, unknown>;
  const mode = vars.BLOB_GC_MODE;
  const days = Number(vars.BLOB_GC_GRACE_DAYS);
  const grace =
    Number.isFinite(days) && days > 0
      ? Math.max(MIN_GC_GRACE_SECONDS, Math.floor(days * 24 * 60 * 60))
      : DEFAULT_GC_GRACE_SECONDS;
  return { enabled: mode !== "off", graceSeconds: grace };
}

// ── Liveness ─────────────────────────────────────────────────────────────────────────────────

/** One ref the collector would drop. */
export interface PlannedDrop {
  storageKey: string;
  refKind: "pack-object" | "pack-upload";
  refId: string;
  createdAt: number;
}

export interface ProductGcPlan {
  product: string;
  /** Why nothing is planned (Release off, a record unreadable, …), else null. */
  skipped: string | null;
  /** Whether every live release's files and chunks were read: `pack-upload` drops need it. */
  complete: boolean;
  /** Why `complete` is false, else null. */
  incomplete: string | null;
  /** Live pack release ids, sorted. */
  liveReleases: string[];
  /** The refs to drop (at most `GC_DROPS_PER_PRODUCT`). */
  drops: PlannedDrop[];
  /** Whether more drops were found than one tick takes. */
  truncated: boolean;
  /** When the dropped refs' objects become deletable at the earliest, if nothing else holds them. */
  earliestDeletion: number | null;
}

/** A shared per-tick budget of index reads. */
export interface GcBudget {
  indexReads: number;
}

export interface CollectContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  settings: BlobGcSettings;
  budget: GcBudget;
}

/** Compare by UTF-8 code points (deterministic output). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The live pack releases of one product (see the file header), plus the releases a revocation
 * makes dead. `null` when Release is off.
 */
export async function livePackReleases(
  hooks: ServiceHooks,
): Promise<{ live: Set<string>; packs: Map<string, CatalogRelease[]> } | null> {
  const catalog = hooks.releaseCatalog();
  if (!catalog) return null;
  const delivery = hooks.delivery();
  const deliverables = await catalog.deliverables();
  const packIds = deliverables
    .filter((d) => d.id !== APP_DELIVERABLE_ID)
    .map((d) => d.id);
  const packs = new Map<string, CatalogRelease[]>();
  for (const id of packIds) packs.set(id, await catalog.releases(id));
  const byId = new Map<string, CatalogRelease>();
  for (const list of packs.values())
    for (const r of list) byId.set(r.releaseId, r);

  const revocations = await catalog.revocations();
  const revoked = new Set(revocations.map((r) => r.targetReleaseId));
  const live = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && byId.has(id) && !revoked.has(id)) live.add(id);
  };

  const rollouts = delivery ? await delivery.rollouts() : [];
  const reported = delivery ? await delivery.reportedAvailability() : [];
  const listed = reported.filter((r) => !UNLISTED_STATES.has(r.state));

  // Live app releases.
  const apps = new Set<string>();
  const channels = [...new Set(await catalog.knownChannels())].sort();
  for (const channel of channels)
    for (const l of await catalog.liveLevels(APP_DELIVERABLE_ID, channel))
      for (const id of l.appReleases) apps.add(id);
  const appIds = new Set(
    (await catalog.releases(APP_DELIVERABLE_ID)).map((r) => r.releaseId),
  );
  for (const r of listed) if (appIds.has(r.releaseId)) apps.add(r.releaseId);
  for (const r of rollouts)
    if (r.deliverableId === APP_DELIVERABLE_ID) apps.add(r.releaseId);

  // (a) pins and holds of live app releases.
  for (const app of [...apps].sort()) {
    for (const p of await catalog.pins(app)) add(p.packReleaseId);
    for (const h of await catalog.holdsFor(app)) add(h.packReleaseId);
  }
  // (b) current sets, (c) the previous release of each member.
  const members = new Set<string>();
  for (const channel of channels)
    for (const s of await catalog.packSets(channel))
      for (const m of s.packs) members.add(m.releaseId);
  for (const id of members) {
    add(id);
    const r = byId.get(id);
    if (!r || r.seq === null) continue;
    const previous = (packs.get(r.deliverableId) ?? [])
      .filter(
        (x) =>
          x.seq !== null &&
          x.seq < (r.seq as number) &&
          !x.yanked &&
          !revoked.has(x.releaseId),
      )
      .sort((a, b) => (b.seq as number) - (a.seq as number))[0];
    add(previous?.releaseId);
  }
  // (d) pack pointers.
  for (const p of await catalog.channelPolicies())
    if (p.deliverableId !== APP_DELIVERABLE_ID) add(p.pointerReleaseId);
  // (e) rollouts, (f) listed on an outlet, (g) replacements.
  for (const r of rollouts) add(r.releaseId);
  for (const r of listed) add(r.releaseId);
  for (const r of revocations) add(r.replacement?.releaseId);
  // (h) newer than the newest live release of its pack (every release when none is live). A
  // release with no `seq` (pre-P2-03) cannot be ordered: it is kept.
  for (const [, list] of packs) {
    const liveSeqs = list
      .filter((r) => live.has(r.releaseId) && r.seq !== null)
      .map((r) => r.seq as number);
    const newest = liveSeqs.length > 0 ? Math.max(...liveSeqs) : -1;
    for (const r of list)
      if (
        !r.yanked &&
        !revoked.has(r.releaseId) &&
        (r.seq === null || r.seq > newest)
      )
        live.add(r.releaseId);
  }
  return { live, packs };
}

/**
 * Plan one product's ref drops (no write). Fail closed: `skipped` with no drops whenever the live
 * set cannot be decided; `complete: false` (no `pack-upload` drops) whenever a live release's
 * record, files index or chunk index could not be read within the budget.
 */
export async function planProductGc(
  ctx: CollectContext,
): Promise<ProductGcPlan> {
  const { db, product, now, settings } = ctx;
  const plan: ProductGcPlan = {
    product,
    skipped: null,
    complete: true,
    incomplete: null,
    liveReleases: [],
    drops: [],
    truncated: false,
    earliestDeletion: null,
  };
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) {
    plan.skipped = "Release is off for this product: its refs are kept";
    plan.complete = false;
    return plan;
  }
  const liveness = await livePackReleases(ctx.hooks);
  if (!liveness) {
    plan.skipped = "Release is off for this product: its refs are kept";
    plan.complete = false;
    return plan;
  }
  const { live, packs } = liveness;
  plan.liveReleases = [...live].sort(cmp);
  const cutoff = now - settings.graceSeconds;
  const packOf = new Map<string, string>();
  for (const [id, list] of packs)
    for (const r of list) packOf.set(r.releaseId, id);

  // Dead pack-object refs: a known pack release that is not live, ref older than the grace.
  const objectRefs = await db.all<{
    storage_key: string;
    ref_id: string;
    created_at: number;
  }>(
    `SELECT storage_key, ref_id, created_at FROM blob_refs
      WHERE product = ? AND ref_kind = 'pack-object' AND created_at <= ?
      ORDER BY ref_id, storage_key`,
    product,
    cutoff,
  );
  for (const r of objectRefs) {
    if (!packOf.has(r.ref_id) || live.has(r.ref_id)) continue;
    plan.drops.push({
      storageKey: r.storage_key,
      refKind: "pack-object",
      refId: r.ref_id,
      createdAt: r.created_at,
    });
  }

  // The live keys: every live release's record objects, files and chunks.
  const liveKeys = new Set<string>();
  const hasChunks = typeof catalog.packChunks === "function";
  for (const id of plan.liveReleases) {
    const pack = packOf.get(id);
    if (!pack) continue;
    const rec = await catalog.packRelease(pack, id);
    if (!rec) {
      plan.complete = false;
      plan.incomplete = `the record of live release ${id} could not be read`;
      break;
    }
    for (const v of rec.variants) {
      for (const o of v.objects) liveKeys.add(o.key);
      if (v.objects.some((o) => o.role === "files-index")) {
        if (ctx.budget.indexReads <= 0) {
          plan.complete = false;
          plan.incomplete =
            "the tick's index-read budget is spent; the next tick resumes";
          break;
        }
        ctx.budget.indexReads--;
        const files = await catalog.packFiles(id, v.variantKey);
        if (!files) {
          plan.complete = false;
          plan.incomplete = `the files index of live release ${id} (${v.variantKey || "default"}) could not be read`;
          break;
        }
        for (const f of files) liveKeys.add(f.blob.key);
      }
      if (hasChunks) {
        if (ctx.budget.indexReads <= 0) {
          plan.complete = false;
          plan.incomplete =
            "the tick's index-read budget is spent; the next tick resumes";
          break;
        }
        ctx.budget.indexReads--;
        const chunks = await catalog.packChunks!(id, v.variantKey);
        if (chunks) for (const c of chunks) liveKeys.add(c.bundleKey);
      }
    }
    if (!plan.complete) break;
  }

  // Dead pack-upload refs, only when the whole live set was read.
  if (plan.complete) {
    const declared = new Set(packs.keys());
    let after = "";
    for (;;) {
      const page = await db.all<{
        storage_key: string;
        ref_id: string;
        created_at: number;
      }>(
        `SELECT storage_key, ref_id, created_at FROM blob_refs
          WHERE product = ? AND ref_kind = 'pack-upload' AND created_at <= ?
            AND storage_key > ?
          ORDER BY storage_key, ref_id LIMIT 1000`,
        product,
        cutoff,
        after,
      );
      for (const r of page) {
        if (liveKeys.has(r.storage_key) || !declared.has(r.ref_id)) continue;
        const parsed = parseKey(r.storage_key);
        // The P4-22 hook point: a bundle's liveness needs `packChunks`.
        if (
          !parsed ||
          (parsed.area === "locked" && parsed.kind === "bundle" && !hasChunks)
        )
          continue;
        plan.drops.push({
          storageKey: r.storage_key,
          refKind: "pack-upload",
          refId: r.ref_id,
          createdAt: r.created_at,
        });
      }
      if (page.length < 1000 || plan.drops.length > GC_DROPS_PER_PRODUCT) break;
      after = page[page.length - 1]!.storage_key;
    }
  }

  if (plan.drops.length > GC_DROPS_PER_PRODUCT) {
    plan.truncated = true;
    plan.drops = plan.drops.slice(0, GC_DROPS_PER_PRODUCT);
  }
  if (plan.drops.length > 0) {
    const created = await objectCreatedAt(
      db,
      plan.drops.map((d) => d.storageKey),
    );
    let earliest: number | null = null;
    for (const d of plan.drops) {
      const at = Math.max(
        now + settings.graceSeconds,
        (created.get(d.storageKey) ?? now) + BLOB_LOCK_AGE_SECONDS,
      );
      if (earliest === null || at < earliest) earliest = at;
    }
    plan.earliestDeletion = earliest;
  }
  return plan;
}

async function objectCreatedAt(
  db: Db,
  keys: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += JSON_KEYS) {
    const chunk = unique.slice(i, i + JSON_KEYS);
    for (const r of await db.all<{ storage_key: string; created_at: number }>(
      `SELECT storage_key, created_at FROM blob_objects
        WHERE storage_key IN (SELECT value FROM json_each(?))`,
      JSON.stringify(chunk),
    ))
      out.set(r.storage_key, r.created_at);
  }
  return out;
}

/**
 * Apply one product's plan: delete exactly the planned refs (each still older than the grace
 * period), log each, audit the summary. Product-scoped: every statement names the product.
 * Idempotent: a second run finds the refs gone. Returns the refs dropped.
 */
export async function applyProductGc(
  db: Db,
  plan: ProductGcPlan,
  now: number,
  settings: BlobGcSettings,
): Promise<number> {
  if (plan.drops.length === 0) return 0;
  const cutoff = now - settings.graceSeconds;
  // Group by (kind, ref id): one statement per group per chunk of keys.
  const groups = new Map<string, PlannedDrop[]>();
  for (const d of plan.drops) {
    const k = `${d.refKind}\u0000${d.refId}`;
    const list = groups.get(k) ?? [];
    list.push(d);
    groups.set(k, list);
  }
  let dropped = 0;
  for (const list of groups.values()) {
    const { refKind, refId } = list[0]!;
    for (let i = 0; i < list.length; i += JSON_KEYS) {
      const keys = JSON.stringify(
        list.slice(i, i + JSON_KEYS).map((d) => d.storageKey),
      );
      const results = await batchCounts(db, [
        {
          sql: `INSERT INTO blob_gc_log (at, action, storage_key, product, ref_kind, ref_id)
                SELECT ?, 'ref-dropped', r.storage_key, r.product, r.ref_kind, r.ref_id
                  FROM blob_refs r
                 WHERE r.product = ? AND r.ref_kind = ? AND r.ref_id = ? AND r.created_at <= ?
                   AND r.storage_key IN (SELECT value FROM json_each(?))`,
          params: [now, plan.product, refKind, refId, cutoff, keys],
        },
        {
          sql: `DELETE FROM blob_refs
                 WHERE product = ? AND ref_kind = ? AND ref_id = ? AND created_at <= ?
                   AND storage_key IN (SELECT value FROM json_each(?))`,
          params: [plan.product, refKind, refId, cutoff, keys],
        },
      ]);
      dropped += results[1] ?? 0;
    }
  }
  if (dropped > 0) {
    const releases = new Set(
      plan.drops.filter((d) => d.refKind === "pack-object").map((d) => d.refId),
    );
    const uploads = plan.drops.filter(
      (d) => d.refKind === "pack-upload",
    ).length;
    await appendAudit(db, {
      product: plan.product,
      id: randomId("aud"),
      at: now,
      actor_sub: "system:blob-gc",
      actor_name: "Blob collector",
      actor_email: null,
      action: "core.blob_gc.refs_dropped",
      target_kind: "blob-refs",
      target_id: plan.product,
      parent_id: null,
      summary: (
        `Dropped ${dropped} blob refs no live release needs: ` +
        `${releases.size} dead pack release(s)` +
        (releases.size > 0
          ? ` (${[...releases].sort(cmp).slice(0, 8).join(", ")}${releases.size > 8 ? ", …" : ""})`
          : "") +
        `, ${uploads} upload ref(s) no live index lists` +
        (plan.earliestDeletion !== null
          ? `. Objects nothing else references are deleted from ${new Date(plan.earliestDeletion * 1000).toISOString().slice(0, 10)} at the earliest`
          : "") +
        (plan.truncated ? "; more remain for the next tick" : "")
      ).slice(0, 1000),
    });
  }
  return dropped;
}

/** An atomic batch answering each statement's changed rows (`batchChanges`, which both real
 *  engines implement; a test double without it runs the statements one by one). */
async function batchCounts(db: Db, stmts: DbStatement[]): Promise<number[]> {
  if (db.batchChanges) return db.batchChanges(stmts);
  const out: number[] = [];
  for (const st of stmts) out.push(await db.runChanges(st.sql, ...st.params));
  return out;
}

// ── Mark and sweep (global) ──────────────────────────────────────────────────────────────────

/** Stamp unreferenced objects and clear the stamp of re-referenced ones. Returns rows changed. */
export async function markUnreferenced(db: Db, now: number): Promise<number> {
  let changed = await db.runChanges(
    `UPDATE blob_objects SET unreferenced_since = NULL
      WHERE unreferenced_since IS NOT NULL AND gc_claimed_at IS NULL
        AND EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
  );
  for (let i = 0; i < GC_MARK_PASSES; i++) {
    const n = await db.runChanges(
      `UPDATE blob_objects SET unreferenced_since = ?
        WHERE storage_key IN (
          SELECT o.storage_key FROM blob_objects o
           WHERE o.unreferenced_since IS NULL AND o.gc_claimed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = o.storage_key)
           LIMIT ?)`,
      now,
      GC_MARK_ROWS,
    );
    changed += n;
    if (n < GC_MARK_ROWS) break;
  }
  return changed;
}

/** One candidate the sweep would delete. */
export interface SweepCandidate {
  storageKey: string;
  size: number;
  kind: string;
  /** `grace` (unreferenced past the grace period) or `delta-endpoint` (its base is collectable). */
  why: "grace" | "delta-endpoint";
}

/**
 * The sweep's candidates (no write): unclaimed, unreferenced, created before the lock age, and
 * either stamped past the grace period or a delta whose endpoint is gone or itself unreferenced.
 */
export async function sweepCandidates(
  db: Db,
  now: number,
  settings: BlobGcSettings,
  limit: number = GC_SWEEP_KEYS,
): Promise<SweepCandidate[]> {
  const lockCutoff = now - BLOB_LOCK_AGE_SECONDS;
  const graceCutoff = now - settings.graceSeconds;
  const graced = await db.all<{
    storage_key: string;
    size: number;
    kind: string;
  }>(
    `SELECT storage_key, size, kind FROM blob_objects o
      WHERE o.gc_claimed_at IS NULL AND o.unreferenced_since IS NOT NULL
        AND o.unreferenced_since <= ? AND o.created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = o.storage_key)
      ORDER BY o.unreferenced_since, o.storage_key LIMIT ?`,
    graceCutoff,
    lockCutoff,
    limit,
  );
  const out: SweepCandidate[] = graced.map((r) => ({
    storageKey: r.storage_key,
    size: r.size,
    kind: r.kind,
    why: "grace",
  }));
  if (out.length >= limit) return out;
  // Deltas inside the grace period whose endpoint is collectable (E8 §5.7: a disposable cache).
  const deltas = await db.all<{
    storage_key: string;
    size: number;
    kind: string;
  }>(
    `SELECT storage_key, size, kind FROM blob_objects o
      WHERE o.kind = 'delta' AND o.gc_claimed_at IS NULL AND o.unreferenced_since IS NOT NULL
        AND o.unreferenced_since > ? AND o.created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = o.storage_key)
      ORDER BY o.unreferenced_since, o.storage_key LIMIT ?`,
    graceCutoff,
    lockCutoff,
    limit - out.length,
  );
  for (const d of deltas) {
    const parsed = parseKey(d.storage_key);
    if (!parsed || parsed.area !== "locked" || parsed.kind !== "delta")
      continue;
    const ends = [parsed.fromSha256, parsed.toSha256].map((h) =>
      blobKey(h, { gated: parsed.gated }),
    );
    const rows = await db.all<{
      storage_key: string;
      unreferenced_since: number | null;
    }>(
      `SELECT storage_key, unreferenced_since FROM blob_objects
        WHERE storage_key IN (?, ?)`,
      ends[0]!,
      ends[1]!,
    );
    const collectable = ends.some((k) => {
      const row = rows.find((r) => r.storage_key === k);
      return !row || row.unreferenced_since !== null;
    });
    if (collectable)
      out.push({
        storageKey: d.storage_key,
        size: d.size,
        kind: d.kind,
        why: "delta-endpoint",
      });
  }
  return out;
}

export interface SweepResult {
  deleted: number;
  bytes: number;
}

/**
 * Claim, delete from R2, delete the rows (see the file header). Throws after releasing its claims
 * when R2 refuses, so the step is recorded as failed and nothing is left half-claimed.
 */
export async function sweepObjects(
  db: Db,
  bucket: R2Bucket,
  now: number,
  settings: BlobGcSettings,
): Promise<SweepResult> {
  const lockCutoff = now - BLOB_LOCK_AGE_SECONDS;
  const graceCutoff = now - settings.graceSeconds;
  // A unique claim token per sweep: the claim time in milliseconds, plus a random tail, so two
  // overlapping ticks (cron delivery is at-least-once) never read each other's claims as theirs.
  const token = now * 1000 + Math.floor(Math.random() * 1000);

  // Finish a claim a dead tick left behind: it was unreferenced, unservable and refused to
  // `recordObject` from the moment it was claimed, so completing its delete is safe. (One that has
  // a ref, which the claim exists to make impossible, is released rather than finished.)
  await db.run(
    `UPDATE blob_objects SET gc_claimed_at = NULL
      WHERE gc_claimed_at IS NOT NULL AND gc_claimed_at < ?
        AND EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
    (now - GC_STALE_CLAIM_SECONDS) * 1000,
  );
  await db.run(
    `UPDATE blob_objects SET gc_claimed_at = ?
      WHERE gc_claimed_at IS NOT NULL AND gc_claimed_at < ?
        AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
    token,
    (now - GC_STALE_CLAIM_SECONDS) * 1000,
  );

  const candidates = await sweepCandidates(db, now, settings);
  const graced = candidates
    .filter((c) => c.why === "grace")
    .map((c) => c.storageKey);
  const deltas = candidates
    .filter((c) => c.why === "delta-endpoint")
    .map((c) => c.storageKey);
  if (graced.length > 0)
    await db.run(
      `UPDATE blob_objects SET gc_claimed_at = ?
        WHERE storage_key IN (SELECT value FROM json_each(?))
          AND gc_claimed_at IS NULL AND unreferenced_since IS NOT NULL
          AND unreferenced_since <= ? AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
      token,
      JSON.stringify(graced),
      graceCutoff,
      lockCutoff,
    );
  if (deltas.length > 0)
    await db.run(
      `UPDATE blob_objects SET gc_claimed_at = ?
        WHERE storage_key IN (SELECT value FROM json_each(?))
          AND kind = 'delta' AND gc_claimed_at IS NULL AND unreferenced_since IS NOT NULL
          AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
      token,
      JSON.stringify(deltas),
      lockCutoff,
    );
  const claimed = await db.all<{ storage_key: string; size: number }>(
    `SELECT storage_key, size FROM blob_objects WHERE gc_claimed_at = ?
      ORDER BY storage_key LIMIT ?`,
    token,
    GC_SWEEP_KEYS,
  );
  if (claimed.length === 0) return { deleted: 0, bytes: 0 };
  const keys = claimed.map((c) => c.storage_key);
  const keysJson = JSON.stringify(keys);

  try {
    await bucket.delete(keys);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.batch([
      {
        sql: `INSERT INTO blob_gc_log (at, action, storage_key, size, detail)
              SELECT ?, 'delete-failed', storage_key, size, ? FROM blob_objects
               WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))`,
        params: [
          now,
          `R2 refused the delete: ${message}`.slice(0, 500),
          token,
          keysJson,
        ],
      },
      {
        sql: `UPDATE blob_objects SET gc_claimed_at = NULL
               WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))`,
        params: [token, keysJson],
      },
    ]);
    throw new Error(
      `the R2 delete of ${keys.length} unreferenced object(s) failed (claims released): ${message}`,
    );
  }

  const results = await batchCounts(db, [
    {
      sql: `INSERT INTO blob_gc_log (at, action, storage_key, size)
            SELECT ?, 'deleted', storage_key, size FROM blob_objects
             WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
      params: [now, token, keysJson],
    },
    {
      sql: `DELETE FROM blob_objects
             WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.storage_key = blob_objects.storage_key)`,
      params: [token, keysJson],
    },
  ]);
  const deleted = results[1] ?? 0;
  if (deleted !== keys.length) {
    // A ref appeared on a claimed object, which `recordObject` and the claim's conditions exist to
    // make impossible. The bytes are gone; say so loudly and keep the row for an operator.
    await db.run(
      `INSERT INTO blob_gc_log (at, action, storage_key, size, detail)
       SELECT ?, 'delete-failed', storage_key, size, 'a ref appeared after the claim; the R2 object was deleted'
         FROM blob_objects WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))`,
      now,
      token,
      keysJson,
    );
    await db.run(
      `UPDATE blob_objects SET gc_claimed_at = NULL
        WHERE gc_claimed_at = ? AND storage_key IN (SELECT value FROM json_each(?))`,
      token,
      keysJson,
    );
    throw new Error(
      `${keys.length - deleted} claimed object(s) gained a ref during the sweep; see blob_gc_log`,
    );
  }
  return {
    deleted,
    bytes: claimed.reduce((n, c) => n + c.size, 0),
  };
}

/** Prune the collector's log past `retentionSeconds`, in bounded passes. */
export async function pruneGcLog(
  db: Db,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM blob_gc_log WHERE id IN (
       SELECT id FROM blob_gc_log WHERE at < ? ORDER BY at LIMIT ?)`,
    cutoff,
    limit,
  );
}

// ── The console's views ──────────────────────────────────────────────────────────────────────

/** One bundle this product holds, with its live-data ratio (P4-14, for later repacking). */
export interface BundleLiveness {
  storageKey: string;
  size: number;
  /** Bytes of the bundle a live release's chunk index reads; null until `packChunks` exists. */
  liveBytes: number | null;
  /** `liveBytes / size`; null until `packChunks` exists. */
  ratio: number | null;
}

/**
 * Every chunk bundle the product holds a ref to, with the share of its bytes that live releases
 * still read. Until Release implements `packChunks` (P4-22) the ratio cannot be known and reads
 * `null`. Never another product's refs.
 */
export async function bundleLiveness(
  db: Db,
  product: string,
  hooks: ServiceHooks,
): Promise<{ available: boolean; bundles: BundleLiveness[] }> {
  const held = await db.all<{ storage_key: string; size: number }>(
    `SELECT DISTINCT o.storage_key, o.size FROM blob_refs r
       JOIN blob_objects o ON o.storage_key = r.storage_key
      WHERE r.product = ? AND o.kind = 'bundle'
      ORDER BY o.storage_key LIMIT 1000`,
    product,
  );
  const catalog: ReleaseCatalog | null = hooks.releaseCatalog();
  if (!catalog || typeof catalog.packChunks !== "function")
    return {
      available: false,
      bundles: held.map((b) => ({
        storageKey: b.storage_key,
        size: b.size,
        liveBytes: null,
        ratio: null,
      })),
    };
  const liveness = await livePackReleases(hooks);
  const chunks = new Map<string, Map<number, number>>();
  for (const id of liveness ? [...liveness.live].sort(cmp) : []) {
    const pack = [...(liveness?.packs ?? new Map()).entries()].find(
      ([, list]) => (list as CatalogRelease[]).some((r) => r.releaseId === id),
    )?.[0] as string | undefined;
    if (!pack) continue;
    const rec = await catalog.packRelease(pack, id);
    for (const v of rec?.variants ?? []) {
      const list = await catalog.packChunks(id, v.variantKey);
      for (const c of list ?? []) {
        const m = chunks.get(c.bundleKey) ?? new Map<number, number>();
        m.set(c.offset, c.bytes);
        chunks.set(c.bundleKey, m);
      }
    }
  }
  return {
    available: true,
    bundles: held.map((b) => {
      const live = [...(chunks.get(b.storage_key)?.values() ?? [])].reduce(
        (n, x) => n + x,
        0,
      );
      return {
        storageKey: b.storage_key,
        size: b.size,
        liveBytes: live,
        ratio: b.size > 0 ? Math.min(1, live / b.size) : null,
      };
    }),
  };
}

// ── The console route ────────────────────────────────────────────────────────────────────────

/** The most planned drops the dry run lists (the counts are always complete). */
export const GC_DRY_RUN_LIST = 500;

/**
 * `GET /manage/api/products/<slug>/blob-gc` — the collector's DRY RUN for this product: the live
 * pack releases, the refs the next tick would drop, and when their objects become deletable at the
 * earliest. `GET …/blob-gc/bundles` — the product's chunk bundles with their live-data ratio.
 * Read-only (the budget is a fresh one, nothing is written).
 *
 * Only THIS product's refs are listed, and never whether another product holds the same bytes:
 * "would this object become unreferenced" would be a cross-tenant existence oracle (THREAT-MODEL
 * §3), so the earliest-deletion date assumes nothing else references the object.
 */
export async function handleBlobGcAdmin(
  req: Request,
  env: Env,
  db: Db,
  slug: string,
  hooks: ServiceHooks,
  sub: string | undefined,
  now: number,
): Promise<Response> {
  if (req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (sub === "bundles")
    return adminJson(await bundleLiveness(db, slug, hooks));
  if (sub !== undefined) return adminNotFound();
  const settings = blobGcSettings(env);
  const plan = await planProductGc({
    db,
    product: slug,
    hooks,
    now,
    settings,
    budget: { indexReads: GC_INDEX_READS_PER_TICK },
  });
  return adminJson({
    enabled: settings.enabled && env.BLOBS !== undefined,
    graceSeconds: settings.graceSeconds,
    lockAgeSeconds: BLOB_LOCK_AGE_SECONDS,
    skipped: plan.skipped,
    complete: plan.complete,
    incomplete: plan.incomplete,
    liveReleases: plan.liveReleases,
    drops: {
      packObject: plan.drops.filter((d) => d.refKind === "pack-object").length,
      packUpload: plan.drops.filter((d) => d.refKind === "pack-upload").length,
      truncated: plan.truncated,
      listed: plan.drops.slice(0, GC_DRY_RUN_LIST),
    },
    earliestDeletion: plan.earliestDeletion,
  });
}

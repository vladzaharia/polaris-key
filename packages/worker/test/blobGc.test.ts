/**
 * P4-14 — the blob collector against real published packs (`core/assets/blobGc.ts`): it never deletes a
 * live object — a set member, the previous release, the recent ones, an app release's artifacts —
 * and deletes a dead pack release's objects only past grace and lock; a revoked release is no live
 * reference; and it stays safe across concurrent publishes: a promote racing the sweep's claim is
 * refused and then succeeds, a publish reusing a dead object's bytes keeps them, and a ref a racing
 * drop took from a live release is restored on the next tick.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appContent,
  FOES,
  L10N,
  NOW,
  packWorld,
  SLUG,
  type PackWorld,
  type Published,
} from "./packWorld.js";
import {
  BLOB_LOCK_AGE_SECONDS,
  DEFAULT_GC_GRACE_SECONDS,
  blobGcSettings,
  livePackReleases,
  planProductGc,
  GC_INDEX_READS_PER_TICK,
} from "../src/core/assets/blobGc.js";
import { runBlobGc, type MaintenanceReport } from "../src/scheduled.js";
import { promote, stagingKey } from "../src/core/assets/blobs.js";
import { ingest } from "../src/core/assets/hostedAssets.js";
import { asR2 } from "./r2Mock.js";
import type { Env } from "../src/platform/env.js";
import { seedProduct } from "./seed.js";

afterEach(() => vi.useRealTimers());

const GRACE = DEFAULT_GC_GRACE_SECONDS;
const T = NOW + BLOB_LOCK_AGE_SECONDS + 1;
const key = (sha256: string) => `blobs/sha256/${sha256}`;
const keysOf = (p: Published) => p.objects.map((o) => key(o.sha256));

async function tick(w: PackWorld, at: number, env: Env = w.env) {
  const report: MaintenanceReport = { counts: {}, failures: {} };
  await runBlobGc(report, env, w.db, at);
  expect(report.failures).toEqual({});
  return report;
}

async function stored(w: PackWorld, k: string): Promise<boolean> {
  const row = await w.db.first(
    "SELECT 1 AS one FROM blob_objects WHERE storage_key = ?",
    k,
  );
  return row !== null && w.r2.has(k);
}

/** foes 1.0.0–1.0.5, l10n 1.0.0, app 1.4.0 at contentApi 4 (live on stable). */
async function world() {
  const w = await packWorld();
  const foes: Published[] = [];
  for (let i = 0; i <= 5; i++) foes.push(await w.publishPack(FOES, `1.0.${i}`));
  const l10n = await w.publishPack(L10N, "1.0.0", { contentApi: null });
  const app = await w.submitApp("1.4.0", 14, appContent());
  expect(app.status, JSON.stringify(app.body)).toBe(200);
  return { w, foes, l10n };
}

describe("the collector never deletes a live object (P4-14)", () => {
  it("keeps the set, the previous and the recent releases and the app's artifacts; deletes a dead release's objects past grace and lock", async () => {
    const { w, foes, l10n } = await world();
    await w.addOutlet("web", "web");
    const plan = await planProductGc({
      db: w.db,
      product: SLUG,
      hooks: await w.hooks(T),
      now: T,
      settings: blobGcSettings(w.env),
      budget: { indexReads: GC_INDEX_READS_PER_TICK },
    });
    expect(plan.complete).toBe(true);
    expect(plan.liveReleases).toEqual(
      [
        `${FOES}@1.0.3`,
        `${FOES}@1.0.4`,
        `${FOES}@1.0.5`,
        l10n.releaseId,
      ].sort(),
    );
    const appKeys = (
      await w.db.all<{ storage_key: string }>(
        "SELECT storage_key FROM blob_refs WHERE product = ? AND ref_kind = 'artifact'",
        SLUG,
      )
    ).map((r) => r.storage_key);
    expect(appKeys.length).toBe(2);
    const live = [
      ...foes.slice(3).flatMap(keysOf),
      ...keysOf(l10n),
      ...appKeys,
    ];
    const dead = foes.slice(0, 3).flatMap(keysOf);

    const first = await tick(w, T);
    expect(first.counts[`blobRefs:${SLUG}`]).toBeGreaterThan(0);
    expect(first.counts.blobSweep).toBe(0);
    // Inside the grace period nothing goes.
    await tick(w, T + GRACE - 1);
    for (const k of [...live, ...dead])
      expect(await stored(w, k), k).toBe(true);
    // Past grace and lock: exactly the dead objects go, from R2 and from D1.
    const sweep = await tick(w, T + GRACE);
    expect(sweep.counts.blobSweep).toBe(dead.length);
    for (const k of live) expect(await stored(w, k), k).toBe(true);
    for (const k of dead) {
      expect(w.r2.has(k), k).toBe(false);
      expect(
        await w.db.first(
          "SELECT 1 AS one FROM blob_objects WHERE storage_key = ?",
          k,
        ),
      ).toBeNull();
    }
    // The drops were audited per product, the deletes logged.
    expect(
      await w.db.first(
        "SELECT actor_sub FROM audit WHERE product = ? AND action = 'core.blob_gc.refs_dropped'",
        SLUG,
      ),
    ).toEqual({ actor_sub: "system:blob-gc" });
    // Idempotent, and the live release still reads as available.
    const again = await tick(w, T + GRACE);
    expect(again.counts.blobSweep).toBe(0);
    expect(again.counts[`blobRefs:${SLUG}`]).toBe(0);
    const avail = await (await w.hooks(T + GRACE))
      .delivery()!
      .availability(`${FOES}@1.0.5`);
    expect(avail.map((a) => [a.outletId, a.state])).toEqual([["web", "live"]]);
  });

  it("a revoked release is no live reference", async () => {
    const { w, foes } = await world();
    await w.db.run(
      `INSERT INTO release_revocations
         (product, deliverable_id, target_release_id, target_sha256, record_sha256, kid, jws,
          reason, issued_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, 'k', 'jws', 'bad', ?, ?)`,
      SLUG,
      FOES,
      foes[4]!.releaseId,
      foes[4]!.sha256,
      "f".repeat(64),
      NOW,
      NOW,
    );
    const plan = await planProductGc({
      db: w.db,
      product: SLUG,
      hooks: await w.hooks(T),
      now: T,
      settings: blobGcSettings(w.env),
      budget: { indexReads: GC_INDEX_READS_PER_TICK },
    });
    expect(plan.liveReleases).not.toContain(foes[4]!.releaseId);
    expect(plan.liveReleases).toContain(foes[3]!.releaseId);
    expect(plan.liveReleases).toContain(foes[2]!.releaseId);
    expect(
      plan.drops.some(
        (d) => d.refKind === "pack-object" && d.refId === foes[4]!.releaseId,
      ),
    ).toBe(true);
  });

  it("with Release off for the product, every ref is kept", async () => {
    const { w } = await world();
    await w.db.run(
      `UPDATE products SET services_json = json_set(services_json, '$.services.release.enabled', json('false'))
        WHERE slug = ?`,
      SLUG,
    );
    const r = await tick(w, T);
    expect(r.counts[`blobRefs:${SLUG}`]).toBe(0);
  });
});

describe("concurrent publishes (P4-14)", () => {
  it("a promote racing the sweep's claim is refused, and succeeds once the delete is done", async () => {
    const { w, foes } = await world();
    await tick(w, T);
    const victim = foes[0]!.objects[0]!;
    const k = key(victim.sha256);
    const outcomes: unknown[] = [];
    const racing = {
      ...asR2(w.r2),
      head: (x: string) => asR2(w.r2).head(x),
      get: (x: string, o?: R2GetOptions) => asR2(w.r2).get(x, o),
      put: (...a: Parameters<R2Bucket["put"]>) => asR2(w.r2).put(...a),
      delete: async (keys: string | string[]) => {
        // A CI publish of the same bytes arrives between the claim and the R2 delete.
        const staged = stagingKey(SLUG, "race", victim.sha256);
        w.r2.seed(staged, victim.bytes, { withSha256: true });
        outcomes.push(
          await promote(
            asR2(w.r2),
            staged,
            k,
            { sha256: victim.sha256, size: victim.bytes.length },
            { db: w.db, now: T + GRACE, product: SLUG },
          ),
        );
        return asR2(w.r2).delete(keys);
      },
    } as unknown as R2Bucket;
    await tick(w, T + GRACE, { ...w.env, BLOBS: racing } as Env);
    expect(outcomes[0]).toEqual({ ok: false, reason: "changed" });
    expect(await stored(w, k)).toBe(false);
    // The retry stores the bytes again and records them.
    const staged = stagingKey(SLUG, "retry", victim.sha256);
    w.r2.seed(staged, victim.bytes, { withSha256: true });
    const retry = await promote(
      asR2(w.r2),
      staged,
      k,
      { sha256: victim.sha256, size: victim.bytes.length },
      { db: w.db, now: T + GRACE, product: SLUG },
    );
    expect(retry).toMatchObject({ ok: true, alreadyStored: false });
    expect(await stored(w, k)).toBe(true);
  });

  it("a new release reusing a dead release's bytes keeps them", async () => {
    const { w, foes } = await world();
    await tick(w, T);
    const reused = keysOf(foes[0]!);
    // Unreferenced and stamped now; a publish of the same content arrives inside the grace.
    vi.setSystemTime((T + 10) * 1000);
    const again = await w.publishPack(FOES, "1.0.6", {
      seed: `${FOES}-1.0.0`,
    });
    expect(keysOf(again).sort()).toEqual(reused.sort());
    await tick(w, T + 20);
    await tick(w, T + GRACE + 20);
    await tick(w, T + 3 * GRACE);
    for (const k of reused) expect(await stored(w, k), k).toBe(true);
  });

  it("a ref a racing drop took from a live release is restored on the next tick, and the object is never swept", async () => {
    const { w, foes } = await world();
    await tick(w, T);
    const liveFile = key(foes[5]!.objects[2]!.sha256);
    // An operator's (or anything else's) delete is NOT restored: only what the collector took.
    await w.db.run(
      "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
      SLUG,
      liveFile,
    );
    expect((await tick(w, T + 1)).counts[`blobRefs:${SLUG}`]).toBe(0);
    // As an apply computed before the ingest would have dropped it: the ref goes, and is logged.
    await w.db.run(
      `INSERT INTO blob_gc_log (at, action, storage_key, product, ref_kind, ref_id)
       VALUES (?, 'ref-dropped', ?, ?, 'pack-upload', ?)`,
      T + 1,
      liveFile,
      SLUG,
      FOES,
    );
    const healed = await tick(w, T + 2);
    expect(healed.counts[`blobRefs:${SLUG}`]).toBe(1);
    expect(
      await w.db.first(
        "SELECT ref_kind, ref_id FROM blob_refs WHERE product = ? AND storage_key = ?",
        SLUG,
        liveFile,
      ),
    ).toEqual({ ref_kind: "pack-upload", ref_id: FOES });
    expect(
      await w.db.first(
        "SELECT action, product FROM blob_gc_log WHERE action = 'ref-restored' AND storage_key = ?",
        liveFile,
      ),
    ).toEqual({ action: "ref-restored", product: SLUG });
    await tick(w, T + GRACE + 1);
    await tick(w, T + 3 * GRACE);
    expect(await stored(w, liveFile)).toBe(true);
  });
});

describe("chunk bundles: the packChunks hook (P4-10 decision 16, P4-22) and the console views", () => {
  /** foes 1.0.0–1.0.5 with chunk indexes (1.0.5's names 1.0.0's bundle), l10n, the app. */
  async function chunkWorld() {
    const w = await packWorld();
    const foes: Published[] = [];
    for (let i = 0; i <= 5; i++)
      foes.push(
        await w.publishPack(FOES, `1.0.${i}`, {
          chunks: i === 5 ? { reuse: foes[0]!.bundle! } : {},
        }),
      );
    const l10n = await w.publishPack(L10N, "1.0.0", { contentApi: null });
    const app = await w.submitApp("1.4.0", 14, appContent());
    expect(app.status, JSON.stringify(app.body)).toBe(200);
    return { w, foes, l10n };
  }

  it("keeps every bundle a live index names — an older, dead release's included — and collects the rest after grace", async () => {
    const { w, foes } = await chunkWorld();
    const catalog = (await w.hooks(T)).releaseCatalog()!;
    // Release reads a live variant's chunks from its stored index.
    expect(await catalog.packChunks!(foes[5]!.releaseId, "")).toEqual([
      { bundleKey: key(foes[5]!.bundle!.sha256), offset: 8, bytes: 48 },
      { bundleKey: key(foes[0]!.bundle!.sha256), offset: 0, bytes: 48 },
    ]);
    expect(await catalog.packChunks!(foes[5]!.releaseId, "nope")).toBeNull();
    const p = await plan(w, T);
    expect(p.complete).toBe(true);
    expect(p.liveReleases).toEqual(
      expect.arrayContaining([
        foes[3]!.releaseId,
        foes[4]!.releaseId,
        foes[5]!.releaseId,
      ]),
    );
    expect(p.liveReleases).not.toContain(foes[0]!.releaseId);
    const dropped = new Set(
      p.drops
        .filter((d) => d.refKind === "pack-upload")
        .map((d) => d.storageKey),
    );
    // 1.0.0's bundle is named by live 1.0.5's index: its pack-upload ref stays.
    expect(dropped.has(key(foes[0]!.bundle!.sha256))).toBe(false);
    for (const f of foes.slice(3))
      expect(dropped.has(key(f.bundle!.sha256))).toBe(false);
    for (const f of foes.slice(1, 3))
      expect(dropped.has(key(f.bundle!.sha256))).toBe(true);

    await tick(w, T);
    await tick(w, T + GRACE - 1);
    for (const f of foes)
      expect(await stored(w, key(f.bundle!.sha256))).toBe(true);
    await tick(w, T + GRACE);
    // Kept: every bundle a live index names. Collected: the dead releases' own bundles no live
    // index names, and their indexes.
    for (const f of [foes[0]!, ...foes.slice(3)])
      expect(await stored(w, key(f.bundle!.sha256)), f.version).toBe(true);
    for (const f of foes.slice(1, 3)) {
      expect(await stored(w, key(f.bundle!.sha256)), f.version).toBe(false);
      expect(await stored(w, key(f.chunkIndex!.sha256)), f.version).toBe(false);
    }
    expect(await stored(w, key(foes[0]!.chunkIndex!.sha256))).toBe(false);
    for (const f of foes.slice(3))
      expect(await stored(w, key(f.chunkIndex!.sha256)), f.version).toBe(true);
  });

  it("a live variant whose chunk index cannot be read keeps every pack-upload ref (fail closed)", async () => {
    const { w, foes } = await chunkWorld();
    w.r2.delete(key(foes[4]!.chunkIndex!.sha256));
    const p = await plan(w, T);
    expect(p.complete).toBe(false);
    expect(p.incomplete).toMatch(
      /chunk index of live release djdl\.foes@1\.0\.4/,
    );
    expect(p.drops.some((d) => d.refKind === "pack-upload")).toBe(false);
  });

  it("against a catalog without packChunks, a bundles/ key's ref is kept and a live chunk index makes the plan incomplete", async () => {
    const { w } = await chunkWorld();
    const bundle = `bundles/sha256/${"b".repeat(64)}`;
    await w.db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, 4096, 'bundle', 0, ?, ?)`,
      bundle,
      "b".repeat(64),
      NOW,
      NOW,
    );
    await w.db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES (?, ?, 'pack-upload', ?, ?)`,
      SLUG,
      bundle,
      FOES,
      NOW,
    );
    const hooks = await w.hooks(T);
    const { packChunks: _omit, ...without } = hooks.releaseCatalog()!;
    const p = await planProductGc({
      db: w.db,
      product: SLUG,
      hooks: { ...hooks, releaseCatalog: () => without },
      now: T,
      settings: blobGcSettings(w.env),
      budget: { indexReads: GC_INDEX_READS_PER_TICK },
    });
    expect(p.complete).toBe(false);
    expect(p.incomplete).toMatch(/Release reads no chunk indexes/);
    expect(p.drops.some((d) => d.storageKey === bundle)).toBe(false);
  });

  it("shows the dry run and the bundles a live index names, with their live-data ratio", async () => {
    const { w, foes } = await chunkWorld();
    vi.setSystemTime(T * 1000);
    const dry = await w.admin("GET", "/blob-gc");
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as Record<string, any>;
    expect(body).toMatchObject({
      enabled: true,
      graceSeconds: GRACE,
      lockAgeSeconds: BLOB_LOCK_AGE_SECONDS,
      complete: true,
    });
    expect(body.drops.packObject).toBeGreaterThan(0);
    expect(
      (body.drops.listed as { storageKey: string }[]).some(
        (d) => d.storageKey === key(foes[0]!.bundle!.sha256),
      ),
    ).toBe(false);
    // A dry run writes nothing.
    expect(await w.db.first("SELECT COUNT(*) AS n FROM blob_gc_log")).toEqual({
      n: 0,
    });
    const bundles = (await (
      await w.admin("GET", "/blob-gc/bundles")
    ).json()) as {
      available: boolean;
      bundles: { storageKey: string; size: number; liveBytes: number }[];
    };
    expect(bundles.available).toBe(true);
    const byKey = new Map(bundles.bundles.map((b) => [b.storageKey, b]));
    // 1.0.0's bundle: only its second chunk (48 of 104 bytes) is still read, by 1.0.5.
    expect(byKey.get(key(foes[0]!.bundle!.sha256))).toEqual({
      storageKey: key(foes[0]!.bundle!.sha256),
      size: 104,
      liveBytes: 48,
      ratio: 48 / 104,
    });
    expect(byKey.get(key(foes[4]!.bundle!.sha256))).toMatchObject({
      size: 104,
      liveBytes: 96,
    });
    // A dead release's bundle no live index names is not listed (nothing marks it a bundle).
    expect(byKey.has(key(foes[1]!.bundle!.sha256))).toBe(false);
  });
});

async function plan(
  w: PackWorld,
  at: number,
  indexReads = GC_INDEX_READS_PER_TICK,
) {
  return planProductGc({
    db: w.db,
    product: SLUG,
    hooks: await w.hooks(at),
    now: at,
    settings: blobGcSettings(w.env),
    budget: { indexReads },
  });
}

describe("review fixes: nothing live is ever deleted (P4-14 B1–B4)", () => {
  it("B1: a sweep that runs between promote's head and its row write cannot leave a row without bytes", async () => {
    const { w, foes } = await world();
    await tick(w, T);
    const victim = foes[0]!.objects[0]!;
    const k = key(victim.sha256);
    expect(await stored(w, k)).toBe(true);
    let swept = false;
    const real = asR2(w.r2);
    const racing = {
      ...real,
      get: (x: string, o?: R2GetOptions) => real.get(x, o),
      put: (...a: Parameters<R2Bucket["put"]>) => real.put(...a),
      delete: (x: string | string[]) => real.delete(x),
      head: async (x: string) => {
        const h = await real.head(x);
        if (!swept && x === k) {
          swept = true;
          // The nightly sweep runs right after promote confirmed the bytes.
          await tick(w, T + GRACE);
          expect(w.r2.has(k)).toBe(false);
        }
        return h;
      },
    } as unknown as R2Bucket;
    const staged = stagingKey(SLUG, "b1", victim.sha256);
    w.r2.seed(staged, victim.bytes, { withSha256: true });
    const r = await promote(
      racing,
      staged,
      k,
      { sha256: victim.sha256, size: victim.bytes.length },
      { db: w.db, now: T + GRACE, product: SLUG },
    );
    expect(swept).toBe(true);
    expect(r).toMatchObject({ ok: true, alreadyStored: false });
    // The bytes are back under the recorded row.
    expect(await stored(w, k)).toBe(true);
  });

  it("B2: a halted pack's fallback at another contentApi level keeps its bytes (interleaved levels)", async () => {
    const w = await packWorld();
    await w.addOutlet("web", "web");
    const s: Published[] = [];
    // s1 s2 s3 serve level 4; s4 s5 need level 5; s6 serves level 4; s7 s8 s9 need level 5.
    const ranges = ["4", "4", "4", ">=5", ">=5", "4", ">=5", ">=5", ">=5"];
    for (let i = 0; i < ranges.length; i++)
      s.push(
        await w.publishPack(FOES, `1.0.${i + 1}`, { contentApi: ranges[i]! }),
      );
    await w.publishPack(L10N, "1.0.0", { contentApi: null });
    expect((await w.submitApp("1.4.0", 14, appContent())).status).toBe(200);
    // Level 4's set names s6; halt it on web.
    const halted = await w.post("distribution/rollouts/web/stable", {
      deliverable: FOES,
      releaseId: s[5]!.releaseId,
      bp: 2500,
    });
    expect(halted.status, await halted.clone().text()).toBe(200);
    expect(
      (
        await w.post("distribution/rollouts/web/stable/halt", {
          deliverable: FOES,
        })
      ).status,
    ).toBe(200);
    const gates = (await w.feed("web")).packSets.outlets.web.gates;
    expect(gates[s[5]!.sha256]).toEqual({
      halted: true,
      fallback: s[2]!.sha256,
    });
    // s3 is neither a set member, the previous release by seq (s5), nor one of the newest three.
    const p = await plan(w, T);
    expect(p.liveReleases).toContain(s[2]!.releaseId);
    await tick(w, T);
    await tick(w, T + GRACE);
    await tick(w, T + 3 * GRACE);
    for (const k of keysOf(s[2]!)) expect(await stored(w, k), k).toBe(true);
  });

  it("B3: a live index's file held only by a dead release's pack-object ref is never orphaned", async () => {
    const { w, foes } = await world();
    // As after a single-file → tree move: the live release's file IS the dead release's object,
    // and ingest accepted it because the product held that pack-object ref.
    const file = key(foes[5]!.objects[2]!.sha256);
    await w.db.run(
      "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
      SLUG,
      file,
    );
    await w.db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES (?, ?, 'pack-object', ?, ?)`,
      SLUG,
      file,
      foes[0]!.releaseId,
      NOW,
    );
    const p = await plan(w, T);
    expect(p.complete).toBe(true);
    expect(p.drops.some((d) => d.storageKey === file)).toBe(false);
    await tick(w, T);
    await tick(w, T + GRACE);
    await tick(w, T + 3 * GRACE);
    expect(await stored(w, file)).toBe(true);
    expect(
      await w.db.first(
        "SELECT ref_id FROM blob_refs WHERE product = ? AND storage_key = ?",
        SLUG,
        file,
      ),
    ).toEqual({ ref_id: foes[0]!.releaseId });
  });

  it("an incomplete plan (budget spent, or an index unreadable) drops nothing at all", async () => {
    const { w, foes } = await world();
    const broke = await plan(w, T, 0);
    expect(broke.complete).toBe(false);
    expect(broke.incomplete).toMatch(/budget/);
    expect(broke.drops).toEqual([]);
    const before = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ?",
      SLUG,
    );
    const report: MaintenanceReport = { counts: {}, failures: {} };
    // A product whose index cannot be read: the live release's files index is gone from R2.
    const index = key(foes[5]!.objects[1]!.sha256);
    w.r2.delete(index);
    const unreadable = await plan(w, T);
    expect(unreadable.complete).toBe(false);
    expect(unreadable.incomplete).toMatch(/files index/);
    expect(unreadable.drops).toEqual([]);
    await runBlobGc(report, w.env, w.db, T);
    expect(report.counts[`blobRefs:${SLUG}`]).toBe(0);
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ?",
        SLUG,
      ),
    ).toEqual(before);
  });

  it("B4a: a revocations() entry of another kind is never read as a release id", async () => {
    const { w, foes } = await world();
    const hooks = await w.hooks(T);
    const catalog = hooks.releaseCatalog()!;
    const delegation = {
      kind: "delegation" as const,
      deliverableId: FOES,
      targetReleaseId: foes[5]!.releaseId,
      targetSha256: "d".repeat(64),
      recordSha256: "e".repeat(64),
      version: "1.0.5",
      seq: 6,
      kid: "k",
      replacement: { releaseId: foes[0]!.releaseId, sha256: foes[0]!.sha256 },
      reason: "delegation revoked",
      issuedAt: NOW,
      ingestedAt: NOW,
    };
    const wrapped = {
      ...hooks,
      releaseCatalog: () => ({
        ...catalog,
        revocations: async () => [delegation],
      }),
    };
    const live = (await livePackReleases(wrapped))!.live;
    // Not treated as revoking foes 1.0.5, nor as keeping its "replacement" alive.
    expect(live.has(foes[5]!.releaseId)).toBe(true);
    expect(live.has(foes[0]!.releaseId)).toBe(false);
  });

  it("P4-19: a release a delegation revocation yanks is no live reference, not through pins, rollouts or outlet listings", async () => {
    const { w, foes } = await world();
    const hooks = await w.hooks(T);
    const catalog = hooks.releaseCatalog()!;
    const delivery = hooks.delivery()!;
    const dead = foes[5]!;
    const appId = (await catalog.releases("app"))[0]!.releaseId;
    // Before: foes 1.0.5 is live (a current set member).
    expect((await livePackReleases(hooks))!.live.has(dead.releaseId)).toBe(
      true,
    );
    const wrapped = {
      ...hooks,
      releaseCatalog: () => ({
        ...catalog,
        revocations: async () => [
          {
            kind: "delegation" as const,
            deliverableId: "djdl.events",
            targetReleaseId: "",
            targetSha256: "d".repeat(64),
            recordSha256: "e".repeat(64),
            version: "1",
            seq: 1,
            kid: "k",
            replacement: null,
            reason: "content key retired",
            issuedAt: NOW,
            ingestedAt: NOW,
            delegatedReleaseIds: [dead.releaseId],
          },
        ],
        // (a): the live app release pins it.
        pins: async (app: string) => [
          ...(await catalog.pins(app)),
          ...(app === appId
            ? [
                {
                  appReleaseId: appId,
                  pack: FOES,
                  packReleaseId: dead.releaseId,
                  recordSha256: dead.sha256,
                  required: true,
                  delivery: "essential",
                },
              ]
            : []),
        ],
      }),
      delivery: () => ({
        ...delivery,
        // (e): a rollout names it; (f): an outlet lists it.
        rollouts: async () => [
          ...(await delivery.rollouts()),
          {
            deliverableId: FOES,
            releaseId: dead.releaseId,
            state: "complete",
          } as never,
        ],
        reportedAvailability: async () => [
          ...(await delivery.reportedAvailability()),
          { releaseId: dead.releaseId, state: "available" } as never,
        ],
      }),
    };
    const live = (await livePackReleases(wrapped as never))!.live;
    expect(live.has(dead.releaseId)).toBe(false);
    // The other releases are untouched (the previous one stays live through the set).
    expect(live.has(foes[4]!.releaseId)).toBe(true);
  });
});

describe("P4-19: delegation revocations through the real catalog", () => {
  it("reads a stored delegation revocation and its delegated records from D1 (readDelegationRevocations), so the yanked release is no live reference", async () => {
    const { w, foes } = await world();
    const dead = foes[5]!;
    const before = (await livePackReleases(await w.hooks(T)))!.live;
    expect(before.has(dead.releaseId)).toBe(true);
    const delegation = "d".repeat(64);
    await w.db.run(
      `INSERT INTO release_delegations
         (product, record_sha256, deliverable_id, seq, version, kid, jws, public_key, types_json,
          issued_at, expires_at, ingested_at, origin, revocation_sha256, revocation_jws,
          revocation_kid, revocation_reason, revocation_issued_at)
       VALUES (?, ?, ?, 1, '1', 'djdl-release-test-2026', 'x.y.z', ?, '["files.tree"]',
               ?, ?, ?, 'submit', ?, 'r.s.t', 'djdl-release-test-2026', 'retired', ?)`,
      SLUG,
      delegation,
      FOES,
      "A".repeat(43),
      NOW - 100,
      NOW + 86400,
      NOW,
      "e".repeat(64),
      NOW,
    );
    await w.db.run(
      "INSERT INTO release_delegated_records (product, record_sha256, delegation_sha256) VALUES (?, ?, ?)",
      SLUG,
      dead.sha256,
      delegation,
    );
    const hooks = await w.hooks(T);
    const revs = await hooks.releaseCatalog()!.revocations();
    expect(revs).toContainEqual(
      expect.objectContaining({
        kind: "delegation",
        targetSha256: delegation,
        delegatedReleaseIds: [dead.releaseId],
      }),
    );
    const live = (await livePackReleases(hooks))!.live;
    expect(live.has(dead.releaseId)).toBe(false);
    expect(live.has(foes[4]!.releaseId)).toBe(true);
  });
});

describe("review fixes: tenancy (P4-14 S3)", () => {
  it("an object another product still references is kept, and a restore never grants a ref only another product holds", async () => {
    const { w, foes } = await world();
    await seedProduct(w.db, "other");
    const shared = key(foes[0]!.objects[0]!.sha256);
    await w.db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('other', ?, 'artifact', 'r/x', ?)`,
      shared,
      NOW,
    );
    await tick(w, T);
    // djdl dropped its refs (foes 1.0.0 is dead); the other product still holds one.
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ? AND storage_key = ?",
        SLUG,
        shared,
      ),
    ).toEqual({ n: 0 });
    await tick(w, T + GRACE);
    await tick(w, T + 3 * GRACE);
    expect(await stored(w, shared)).toBe(true);

    // A live file whose djdl ref vanished outside the collector, held by the other product: no
    // restore (the collector puts back only what it took).
    const file = key(foes[5]!.objects[2]!.sha256);
    await w.db.run(
      "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
      SLUG,
      file,
    );
    await w.db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('other', ?, 'artifact', 'r/y', ?)`,
      file,
      NOW,
    );
    await tick(w, T + 3 * GRACE + 1);
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ? AND storage_key = ?",
        SLUG,
        file,
      ),
    ).toEqual({ n: 0 });
  });
});

describe("hosted assets (HA-01)", () => {
  const png = (seed: number) => {
    const out = new Uint8Array(4096).fill(seed);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return out;
  };
  const hexOf = async (b: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");

  it("a hosted-asset ref is never dropped; a replaced copy's bytes are swept after grace and lock", async () => {
    const { w } = await world();
    const upload = (bytes: Uint8Array, now: number) =>
      ingest(
        { env: { BLOBS: asR2(w.r2) }, db: w.db, now },
        SLUG,
        "presentation.icon",
        {
          kind: "stream",
          body: new Response(bytes).body!,
          size: bytes.length,
          sourceKind: "upload",
          origin: "console",
        },
      );
    const a = png(1);
    const b = png(2);
    expect(await upload(a, NOW)).toMatchObject({ ok: true });
    const ka = key(await hexOf(a));
    await tick(w, T);
    await tick(w, T + GRACE);
    await tick(w, T + 3 * GRACE);
    expect(await stored(w, ka)).toBe(true);

    const R = T + 3 * GRACE + 1;
    expect(await upload(b, R)).toMatchObject({ ok: true });
    await tick(w, R);
    await tick(w, R + GRACE + 1);
    await tick(w, R + 3 * GRACE);
    expect(await stored(w, ka)).toBe(false);
    expect(await stored(w, key(await hexOf(b)))).toBe(true);
  });
});

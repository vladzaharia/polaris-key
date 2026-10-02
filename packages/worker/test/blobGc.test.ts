/**
 * P4-14 — the blob collector against real published packs (`core/blobGc.ts`): it never deletes a
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
} from "../src/core/blobGc.js";
import { runBlobGc, type MaintenanceReport } from "../src/scheduled.js";
import { promote, stagingKey } from "../src/core/blobs.js";
import { asR2 } from "./r2Mock.js";
import type { Env } from "../src/env.js";
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

describe("the P4-22 hook point and the console views (P4-14)", () => {
  it("keeps a bundle's ref while Release has no packChunks, and shows the dry run and the bundle ratios", async () => {
    const { w } = await world();
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
        (d) => d.storageKey === bundle,
      ),
    ).toBe(false);
    // A dry run writes nothing.
    expect(await w.db.first("SELECT COUNT(*) AS n FROM blob_gc_log")).toEqual({
      n: 0,
    });
    const bundles = await w.admin("GET", "/blob-gc/bundles");
    expect(await bundles.json()).toEqual({
      available: false,
      bundles: [
        { storageKey: bundle, size: 4096, liveBytes: null, ratio: null },
      ],
    });
    await tick(w, T);
    expect(
      await w.db.first(
        "SELECT ref_kind FROM blob_refs WHERE product = ? AND storage_key = ?",
        SLUG,
        bundle,
      ),
    ).toEqual({ ref_kind: "pack-upload" });
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

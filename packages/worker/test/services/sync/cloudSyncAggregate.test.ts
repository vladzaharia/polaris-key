/**
 * U-05.9: the 15-minute per-product aggregate (`sync_product_usage`, L6) and the daily-counter
 * retention (L17).
 */
import { knownPlatform } from "../../../src/core/devices/platformFamily.js";
import { describe, expect, it } from "vitest";
import "../../../src/index.js";
import type { ScheduledServiceContext } from "../../../src/core/registry.js";
import type { MaintenanceRecorder } from "../../../src/core/contributions.js";
import { syncService } from "../../../src/services/sync/index.js";
import { syncMaintenance } from "../../../src/services/sync/maintenance.js";
import { syncScheduled } from "../../../src/services/sync/scheduled.js";
import { makeTestDb } from "../../helpers.js";

const NOW = 1_760_000_000; // epoch seconds
const DAY = 86_400;

async function dir(
  db: ReturnType<typeof makeTestDb>,
  product: string,
  subject: string,
  r: {
    bytes: number;
    quota?: number;
    tier?: string | null;
    platform?: string | null;
    active?: number;
    revisions?: number;
    recordBytes?: number;
  },
) {
  await db.run(
    `INSERT INTO sync_directory (product, subject, bytes, quota_bytes, tier_id, platform,
       last_active_at, revision_bytes, record_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    product,
    subject,
    r.bytes,
    r.quota ?? 1000,
    r.tier ?? null,
    r.platform ?? null,
    r.active ?? NOW,
    r.revisions ?? 0,
    r.recordBytes ?? 0,
  );
}

const ctxOf = (db: ReturnType<typeof makeTestDb>, slug: string) =>
  ({ db, now: NOW, product: { slug } }) as unknown as ScheduledServiceContext;

const read = (db: ReturnType<typeof makeTestDb>, p: string) =>
  db.first<Record<string, unknown>>(
    "SELECT * FROM sync_product_usage WHERE product = ?",
    p,
  );

describe("sync product aggregate (U-05.9)", () => {
  it("is the descriptor's scheduled hook and its maintenance contribution", () => {
    expect(syncService.scheduled).toBe(syncScheduled);
    expect(syncService.contributes?.maintenance).toBe(syncMaintenance);
  });

  it("totals, users (bytes > 0) and the breakdown by tier, kind and platform", async () => {
    const db = makeTestDb();
    await dir(db, "acme", "s1", {
      bytes: 100,
      tier: "free",
      platform: "macos",
      revisions: 5,
    });
    await dir(db, "acme", "s2", {
      bytes: 900,
      quota: 1000,
      tier: "free",
      platform: "ios",
    });
    await dir(db, "acme", "s3", {
      bytes: 300,
      tier: "free",
      platform: "macos",
      active: NOW - 8 * DAY,
    });
    await dir(db, "acme", "s4", {
      bytes: 800,
      quota: 1000,
      tier: "pro",
      platform: "macos",
    });
    await dir(db, "acme", "s5", { bytes: 0, tier: "pro", platform: "web" });
    await dir(db, "other", "s9", { bytes: 7777, tier: "pro", platform: "web" });
    const out = await syncScheduled(ctxOf(db, "acme"));
    expect(out).toEqual({ users: 4, bytes: 2100 });
    const row = await read(db, "acme");
    expect(row).toMatchObject({
      bytes: 2100,
      users: 4,
      settings_bytes: 2100,
      record_bytes: 0,
      file_bytes: 0,
      revision_bytes: 5,
      computed_at: NOW,
    });
    expect(JSON.parse(String(row?.breakdown_json))).toEqual({
      byTier: [
        { tierId: "free", people: 3, bytes: 1300, medianBytes: 300, over80: 1 },
        { tierId: "pro", people: 1, bytes: 800, medianBytes: 800, over80: 1 },
      ],
      byKind: { settings: 2100, records: 0, files: 0, revisions: 5 },
      byPlatform: [
        { platform: "ios", peopleThisWeek: 1, lastSyncAt: NOW },
        { platform: "macos", peopleThisWeek: 2, lastSyncAt: NOW },
        { platform: "web", peopleThisWeek: 1, lastSyncAt: NOW },
      ],
    });
    // byPlatform keys stay in the closed set the directory records (or null).
    const keys = JSON.parse(String(row?.breakdown_json)).byPlatform.map(
      (p: { platform: string | null }) => p.platform,
    );
    for (const k of keys)
      expect(k === null || knownPlatform(k) !== null).toBe(true);
    expect(await read(db, "other")).toBeNull();
  });

  it("splits the bytes into records' and settings' (U-09.9), and never reads more records than bytes", async () => {
    const db = makeTestDb();
    await dir(db, "acme", "s1", { bytes: 1000, recordBytes: 700 });
    await dir(db, "acme", "s2", { bytes: 500, recordBytes: 0 });
    // A directory row written by hand or by an older build cannot make settings negative.
    await dir(db, "acme", "s3", { bytes: 100, recordBytes: 400 });
    await syncScheduled(ctxOf(db, "acme"));
    const row = await read(db, "acme");
    expect(row).toMatchObject({
      bytes: 1600,
      settings_bytes: 500 + 300 + 0,
      record_bytes: 700 + 100,
    });
    expect(JSON.parse(String(row?.breakdown_json)).byKind).toMatchObject({
      settings: 800,
      records: 800,
    });
  });

  it("the median of an even tier averages its two middle people; a rerun replaces the row", async () => {
    const db = makeTestDb();
    for (const [i, b] of [10, 20, 30, 50].entries())
      await dir(db, "acme", `s${i}`, { bytes: b, tier: "t" });
    await syncScheduled(ctxOf(db, "acme"));
    const first = JSON.parse(String((await read(db, "acme"))?.breakdown_json));
    expect(first.byTier[0].medianBytes).toBe(25);
    await db.run("DELETE FROM sync_directory WHERE product = 'acme'");
    await syncScheduled(ctxOf(db, "acme"));
    expect(await read(db, "acme")).toMatchObject({ users: 0, bytes: 0 });
  });

  it("an empty product writes an empty aggregate", async () => {
    const db = makeTestDb();
    await syncScheduled(ctxOf(db, "acme"));
    const row = await read(db, "acme");
    expect(JSON.parse(String(row?.breakdown_json))).toMatchObject({
      byTier: [],
      byPlatform: [],
    });
  });
});

describe("sync daily retention (U-05.9)", () => {
  it("keeps 90 days, per product", async () => {
    const db = makeTestDb();
    const day = (n: number) =>
      new Date((NOW - n * DAY) * 1000).toISOString().slice(0, 10);
    for (const p of ["acme", "other"])
      for (const n of [0, 89, 90, 91, 200])
        await db.run(
          "INSERT INTO sync_product_daily (product, day, syncs, conflicts) VALUES (?, ?, 1, 0)",
          p,
          day(n),
        );
    const counts: Record<string, number> = {};
    const rec: MaintenanceRecorder = {
      step: async (name, run) => {
        counts[name] = await run();
      },
      drain: async () => {},
      fail: () => {},
    };
    await syncMaintenance.product!(
      { db, now: NOW, cutoff: 0, product: "acme" },
      rec,
    );
    expect(counts["syncDaily:acme"]).toBe(2);
    const left = await db.all<{ product: string; day: string }>(
      "SELECT product, day FROM sync_product_daily ORDER BY product, day",
    );
    expect(left.filter((r) => r.product === "acme").map((r) => r.day)).toEqual([
      day(90),
      day(89),
      day(0),
    ]);
    expect(left.filter((r) => r.product === "other")).toHaveLength(5);
  });
});

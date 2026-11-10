/**
 * LX-33.5: the P0-49 job `license.limits-materialise`, driven through the real runner.
 *
 * A dry run writes nothing; the apply gives every licence a tier, is a no-op the second time,
 * resumes after a kill, skips a licence edited between its read and its write, and `down`
 * restores the rows byte for byte. The signed licence and config documents of every licence are
 * identical before and after, and the second dry run reports no changes and no document diffs.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import {
  applyOf,
  applyKeepingDocuments,
  downOf,
  expectContributed,
  dumpTables,
  expectDownRestores,
  expectSettled,
  finishWorld,
  dryThenApply,
  dryOf,
  killingBatch,
  newEnv,
  SLUG,
  unitDetail,
  type World,
} from "./migrationJobHarness.js";
import {
  DJDL_CATALOG,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../seed.js";
import type { Db } from "../../src/db/types.js";
import {
  applyLimitsUnit,
  limitsMaterialiseJob as job,
  LIMITS_BATCH,
} from "../../src/services/license/migrations/limitsMaterialise.js";
import { insertLicense } from "../../src/core/licensing/store.js";

/** Tiers and licences covering every rule: assign, union, tighter bound, offline days. */
async function world(): Promise<World> {
  const db = makeTestDb();
  const env = newEnv();
  await seedProduct(db, SLUG, { catalog: DJDL_CATALOG });
  await seedTier(db, SLUG, "pro", {
    channels: ["beta"],
    minVersion: "1.0.0",
    deviceLimit: 10,
  });
  await db.run(
    "UPDATE tiers SET label = 'Pro', policy_offline_grace_days = 14 WHERE product = ? AND id = 'pro'",
    SLUG,
  );
  const mk = async (
    id: string,
    o: Parameters<typeof seedLicenseWithKey>[2] & {
      deviceLimit?: number;
      offline?: number;
    } = {},
  ) => {
    const r = await seedLicenseWithKey(db, SLUG, { id, ...o });
    if (o.deviceLimit !== undefined || o.offline !== undefined)
      await db.run(
        "UPDATE licenses SET device_limit = ?, max_offline_days = ? WHERE product = ? AND id = ?",
        o.deviceLimit ?? null,
        o.offline ?? null,
        SLUG,
        id,
      );
    return { id, key: r.key };
  };
  const licences = [
    await mk("lic_a"),
    await mk("lic_b", {
      tierId: "pro",
      channels: ["stable"],
      minVersion: "1.2.0",
    }),
    await mk("lic_c", { tierId: "pro" }),
    await mk("lic_d", { deviceLimit: 3, offline: 7, channels: ["dev"] }),
  ];
  return finishWorld(db, env, licences);
}

const dump = (db: Db): Promise<string> =>
  dumpTables(db, ["licenses", "tiers", "license_limit_backfill"]);

const noTier = (db: Db) =>
  db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND tier_id IS NULL",
    SLUG,
  );

describe("license.limits-materialise", () => {
  it("is contributed by the License service and runs License products only", async () => {
    await expectContributed(await world(), job);
  });

  it("a dry run writes nothing and reports counts and capped ids", async () => {
    const w = await world();
    const before = await dump(w.db);
    const report = await dryOf(w, job);
    expect(await dump(w.db)).toBe(before);
    // 1 seed + lic_a, lic_b, lic_c, lic_d (assigned to Default); lic_b also gets its union,
    // lic_c/lic_b their offline days.
    const detail = (await unitDetail(w.db, report.id)) as Record<string, any>;
    expect(detail).toMatchObject({
      seed: "create",
      seedId: "default",
      licences: 4,
      assigned: 2,
      dangling: 0,
      docDiffs: 0,
      docDiffIds: [],
    });
    expect(detail["writes"]).toMatchObject({
      tier_id: 2,
      channels_json: 1,
      min_version: 0,
      max_offline_days: 2,
    });
    expect(report.changes).toBeGreaterThan(0);
  });

  it("applies: every licence has a tier, documents are byte-identical, the second apply and dry run do nothing", async () => {
    const w = await world();
    const report = await applyKeepingDocuments(w, job);

    expect((await noTier(w.db))!.n).toBe(0);
    expect(
      (await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tiers WHERE product = ? AND implicit = 1",
        SLUG,
      ))!.n,
    ).toBe(1);
    // The licence's own record of what the old chain gave it.
    const b = await w.db.first<Record<string, unknown>>(
      "SELECT * FROM licenses WHERE product = ? AND id = 'lic_b'",
      SLUG,
    );
    expect(b).toMatchObject({
      channels_json: '["beta","stable"]',
      min_version: "1.2.0",
      max_offline_days: 30,
      modified_at: NOW,
      modified_by: null,
    });

    await expectSettled(w, job, report.id);
    // A direct re-apply changes no row either.
    const snap = await dump(w.db);
    expect(await applyLimitsUnit({ db: w.db, now: NOW + 4 }, SLUG)).toBe(0);
    expect(await dump(w.db)).toBe(snap);
  });

  it("resumes an apply that was interrupted between batches", async () => {
    const w = await world();
    for (let i = 0; i < LIMITS_BATCH + 20; i++)
      await insertLicense(w.db, {
        product: SLUG,
        id: `lic_bulk_${String(i).padStart(3, "0")}`,
        status: "active",
        sub: null,
        name: null,
        email: null,
        groups_json: null,
        tier_id: null,
        activated_at: NOW,
        expires_at: null,
        max_offline_days: null,
        overrides_json: null,
        channels_json: null,
        min_version: null,
        max_version: null,
        modified_by: null,
        modified_at: NOW,
      });
    const report = await dryOf(w, job);
    const flaky = killingBatch(w.db, 3);
    const killed = await applyOf(w, job, report.id, NOW + 1, flaky);
    expect(killed.ok && killed.run.status).toBe("failed");
    const left = (await noTier(w.db))!.n;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(LIMITS_BATCH + 24);

    const resumed = await applyOf(w, job, report.id, NOW + 2);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    expect((await noTier(w.db))!.n).toBe(0);
    expect((await dryOf(w, job, NOW + 3)).changes).toBe(0);
  });

  it("skips a licence edited between its read and its write; the next dry run shows it", async () => {
    const w = await world();
    const n = await applyLimitsUnit({ db: w.db, now: NOW + 1 }, SLUG, {
      afterPlan: async () => {
        await w.db.run(
          "UPDATE licenses SET channels_json = '[\"stable\",\"x\"]' WHERE product = ? AND id = 'lic_b'",
          SLUG,
        );
      },
    });
    const b = await w.db.first<Record<string, unknown>>(
      "SELECT * FROM licenses WHERE product = ? AND id = 'lic_b'",
      SLUG,
    );
    expect(b!["tier_id"]).toBe("pro");
    expect(b!["channels_json"]).toBe('["stable","x"]');
    expect(b!["max_offline_days"]).toBeNull();
    // Its ledger holds nothing for fields it did not write.
    expect(
      await w.db.all(
        "SELECT field FROM license_limit_backfill WHERE subject_id = 'lic_b'",
      ),
    ).toEqual([]);
    expect(n).toBeGreaterThan(0);
    const next = await dryOf(w, job, NOW + 2);
    expect(next.changes).toBe(1);
    expect(((await unitDetail(w.db, next.id)) as any).seed).toBe("none");
  });

  it("down restores the rows byte for byte and removes the seeded tier", async () => {
    await expectDownRestores(await world(), job, dump);
  });

  it("down keeps a later edit and a seeded tier that a licence now uses", async () => {
    const w = await world();
    const { applied } = await dryThenApply(w, job);
    await w.db.run(
      "UPDATE licenses SET max_offline_days = 99 WHERE product = ? AND id = 'lic_c'",
      SLUG,
    );
    await insertLicense(w.db, {
      product: SLUG,
      id: "lic_new",
      status: "active",
      sub: null,
      name: null,
      email: null,
      groups_json: null,
      tier_id: "default",
      activated_at: NOW,
      expires_at: null,
      max_offline_days: null,
      overrides_json: null,
      channels_json: null,
      min_version: null,
      max_version: null,
      modified_by: null,
      modified_at: NOW,
    });
    await downOf(w, job, applied.run.id, NOW + 2);
    const c = await w.db.first<Record<string, unknown>>(
      "SELECT max_offline_days FROM licenses WHERE product = ? AND id = 'lic_c'",
      SLUG,
    );
    expect(c!["max_offline_days"]).toBe(99);
    expect(
      await w.db.first(
        "SELECT id FROM tiers WHERE product = ? AND id = 'default'",
        SLUG,
      ),
    ).not.toBeNull();
  });

  it("re-seeds an existing Default tier whose values drifted, and down puts them back", async () => {
    const w = await world();
    await seedTier(w.db, SLUG, "default", { deviceLimit: 9 });
    await w.db.run(
      "UPDATE tiers SET label = 'Default', implicit = 1, source = 'console' WHERE product = ? AND id = 'default'",
      SLUG,
    );
    const before = await dump(w.db);
    const report = await dryOf(w, job);
    expect(((await unitDetail(w.db, report.id)) as any).seed).toBe("update");
    const applied = await applyOf(w, job, report.id, NOW + 1);
    if (!applied.ok) throw new Error("apply");
    const t = await w.db.first<Record<string, unknown>>(
      "SELECT policy_device_limit, policy_offline_grace_days FROM tiers WHERE product = ? AND id = 'default'",
      SLUG,
    );
    expect(t).toEqual({
      policy_device_limit: 5,
      policy_offline_grace_days: 30,
    });
    await downOf(w, job, applied.run.id, NOW + 2);
    expect(await dump(w.db)).toBe(before);
  });

  it("reports a deviceLimit entitlement as a document diff and a dangling tier id, and leaves the dangling one", async () => {
    const w = await world();
    await seedLicenseWithKey(w.db, SLUG, {
      id: "lic_e",
      entitlements: {
        deviceLimit: { state: "enforced", value: 2, updatedAt: NOW },
      },
    });
    await seedLicenseWithKey(w.db, SLUG, { id: "lic_f", tierId: "gone" });
    const report = await dryOf(w, job);
    const d = (await unitDetail(w.db, report.id)) as any;
    expect(d.docDiffIds).toContain("lic_e");
    expect(d.docDiffReasons["device-entitlement"]).toBeGreaterThan(0);
    expect(d.danglingIds).toEqual(["lic_f"]);
    await applyOf(w, job, report.id, NOW + 1);
    const f = await w.db.first<{ tier_id: string }>(
      "SELECT tier_id FROM licenses WHERE product = ? AND id = 'lic_f'",
      SLUG,
    );
    expect(f!.tier_id).toBe("gone");
  });
});

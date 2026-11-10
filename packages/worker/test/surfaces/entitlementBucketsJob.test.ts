/**
 * LX-34.8: the P0-49 job `license.entitlement-buckets`, driven through the real runner.
 *
 * A dry run writes nothing; the apply moves the profile buckets, is a no-op the second time,
 * resumes after a kill, skips a row edited between its read and its write, and `down` restores
 * the rows byte for byte. The signed licence and config documents of every licence are identical
 * before and after, and the second dry run reports no changes.
 */
import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "../helpers.js";
import {
  DJDL_CATALOG,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../seed.js";
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
import type { Db } from "../../src/db/types.js";
import {
  applyBucketsUnit,
  entitlementBucketsJob as job,
} from "../../src/services/license/migrations/entitlementBuckets.js";

const entry = (
  value: ManagedEntry["value"],
  state: ManagedEntry["state"] = "default",
  updatedAt = 5,
): ManagedEntry => ({
  state,
  value,
  updatedAt,
});

async function profile(
  db: Db,
  id: string,
  entitlements: Record<string, unknown>,
): Promise<void> {
  await db.run(
    `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at, source)
     VALUES (?, ?, ?, '', ?, NULL, ?, 'console')`,
    SLUG,
    id,
    id,
    JSON.stringify({ config: {}, secrets: {}, entitlements }),
    NOW,
  );
}

const attach = (db: Db, licenseId: string, profileId: string) =>
  db.run(
    "INSERT INTO license_profiles (product, license_id, profile_id, sort_order) VALUES (?, ?, ?, 0)",
    SLUG,
    licenseId,
    profileId,
  );

/** A tier profile, licence profiles, a licence with its own entitlements, and a store-grant clash. */
async function world(): Promise<World> {
  const db = makeTestDb();
  const env = newEnv();
  await seedProduct(db, SLUG, { catalog: DJDL_CATALOG });
  await profile(db, "tp", {
    polarisVpn: entry(true, "enforced", 7),
    seats: entry(3),
  });
  await profile(db, "lp", { beta: entry(true, "default", 9), seats: entry(8) });
  await profile(db, "lp2", { clash: entry(true) });
  await seedTier(db, SLUG, "pro");
  await db.run(
    "UPDATE tiers SET profile_id = 'tp' WHERE product = ? AND id = 'pro'",
    SLUG,
  );
  await seedTier(db, SLUG, "free");
  const mk = async (
    id: string,
    o: Parameters<typeof seedLicenseWithKey>[2] = {},
  ) => ({ id, key: (await seedLicenseWithKey(db, SLUG, { id, ...o })).key });
  const licences = [
    await mk("lic_a", { tierId: "pro" }),
    await mk("lic_b", {
      tierId: "pro",
      entitlements: { seats: entry(20, "default", 6), own: entry(1) },
    }),
    await mk("lic_c", { tierId: "free" }),
    await mk("lic_d"),
  ];
  await attach(db, "lic_b", "lp");
  await attach(db, "lic_c", "lp");
  return finishWorld(db, env, licences);
}

const dump = (db: Db): Promise<string> =>
  dumpTables(db, [
    "licenses",
    "tiers",
    "profiles",
    "license_profiles",
    "entitlement_bucket_backfill",
  ]);

const bucketOf = async (db: Db, tier: string) =>
  (await db.first<{ entitlements_json: string | null }>(
    "SELECT entitlements_json FROM tiers WHERE product = ? AND id = ?",
    SLUG,
    tier,
  ))!.entitlements_json;
const overridesOf = async (db: Db, id: string) =>
  JSON.parse(
    (await db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE product = ? AND id = ?",
      SLUG,
      id,
    ))!.overrides_json,
  ) as { entitlements: Record<string, unknown> };

describe("license.entitlement-buckets", () => {
  it("is contributed by License; a dry run writes nothing and reports counts and capped ids", async () => {
    const w = await world();
    await expectContributed(w, job);
    const before = await dump(w.db);
    const report = await dryOf(w, job);
    expect(await dump(w.db)).toBe(before);
    expect(await unitDetail(w.db, report.id)).toMatchObject({
      licences: 4,
      tierWrites: 1,
      tierWriteIds: ["pro"],
      licenceWrites: 2,
      keys: 4,
      docDiffs: 0,
      docDiffIds: [],
    });
    expect(report.changes).toBe(3);
  });

  it("applies: buckets move, documents are byte-identical, the second apply and dry run do nothing", async () => {
    const w = await world();
    const report = await applyKeepingDocuments(w, job);

    expect(JSON.parse((await bucketOf(w.db, "pro"))!)).toEqual({
      polarisVpn: entry(true, "enforced", 7),
      seats: entry(3),
    });
    expect(await bucketOf(w.db, "free")).toBeNull();
    // lic_b keeps its own entries over the profile's; the profile's key is merged in.
    const b = await overridesOf(w.db, "lic_b");
    expect(Object.keys(b.entitlements)).toEqual(["beta", "seats", "own"]);
    expect(b.entitlements["seats"]).toEqual(entry(20, "default", 6));
    expect((await overridesOf(w.db, "lic_c")).entitlements["beta"]).toEqual(
      entry(true, "default", 9),
    );

    await expectSettled(w, job, report.id);
    const snap = await dump(w.db);
    expect(await applyBucketsUnit({ db: w.db, now: NOW + 4 }, "djdl")).toBe(0);
    expect(await dump(w.db)).toBe(snap);
  });

  it("resumes an apply that was interrupted between batches", async () => {
    const w = await world();
    const report = await dryOf(w, job);
    const flaky = killingBatch(w.db, 2);
    const killed = await applyOf(w, job, report.id, NOW + 1, flaky);
    expect(killed.ok && killed.run.status).toBe("failed");
    expect(await bucketOf(w.db, "pro")).not.toBeNull();
    expect((await dryOf(w, job, NOW + 2)).changes).toBe(2);

    const resumed = await applyOf(w, job, report.id, NOW + 3);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    expect((await dryOf(w, job, NOW + 4)).changes).toBe(0);
  });

  it("skips a licence edited between its read and its write; the next dry run shows it", async () => {
    const w = await world();
    await applyBucketsUnit({ db: w.db, now: NOW + 1 }, SLUG, {
      afterPlan: async () => {
        await w.db.run(
          `UPDATE licenses SET overrides_json = '{"entitlements":{"own":{"state":"default","value":2,"updatedAt":9}}}'
            WHERE product = ? AND id = 'lic_b'`,
          SLUG,
        );
      },
    });
    expect(
      Object.keys((await overridesOf(w.db, "lic_b")).entitlements),
    ).toEqual(["own"]);
    expect(
      await w.db.all(
        "SELECT subject_id FROM entitlement_bucket_backfill WHERE subject_id = 'lic_b'",
      ),
    ).toEqual([]);
    expect(
      (await overridesOf(w.db, "lic_c")).entitlements["beta"],
    ).toBeDefined();
    const next = await dryOf(w, job, NOW + 2);
    expect(next.changes).toBe(1);
  });

  it("down restores the rows byte for byte", async () => {
    await expectDownRestores(await world(), job, dump);
  });

  it("down keeps a later edit", async () => {
    const w = await world();
    const { applied } = await dryThenApply(w, job);
    await w.db.run(
      "UPDATE tiers SET entitlements_json = '{}' WHERE product = ? AND id = 'pro'",
      SLUG,
    );
    await downOf(w, job, applied.run.id, NOW + 2);
    expect(await bucketOf(w.db, "pro")).toBe("{}");
    expect(
      Object.keys((await overridesOf(w.db, "lic_b")).entitlements),
    ).toEqual(["seats", "own"]);
  });

  it("re-applies after a profile changes, and down still restores the first state", async () => {
    const w = await world();
    const before = await dump(w.db);
    const original = (await w.db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = ? AND id = 'tp'",
      SLUG,
    ))!.payload_json;
    const first = await dryOf(w, job);
    await applyOf(w, job, first.id, NOW + 1);
    await w.db.run(
      `UPDATE profiles SET payload_json = ? WHERE product = ? AND id = 'tp'`,
      JSON.stringify({ entitlements: { polarisVpn: entry(false) } }),
      SLUG,
    );
    const second = await dryOf(w, job, NOW + 2);
    expect(second.changes).toBe(1);
    const applied = await applyOf(w, job, second.id, NOW + 3);
    if (!applied.ok) throw new Error("apply");
    expect(JSON.parse((await bucketOf(w.db, "pro"))!)).toEqual({
      polarisVpn: entry(false),
    });
    await downOf(w, job, applied.run.id, NOW + 4);
    // The first state is back (the profile edit is the operator's, so put it back to compare).
    await w.db.run(
      "UPDATE profiles SET payload_json = ? WHERE product = ? AND id = 'tp'",
      original,
      SLUG,
    );
    expect(await dump(w.db)).toBe(before);
  });

  it("reports a profile key a store grant also sets and leaves that licence alone", async () => {
    const w = await world();
    await seedLicenseWithKey(w.db, SLUG, { id: "lic_e" });
    await attach(w.db, "lic_e", "lp2");
    await w.db.run(
      `INSERT INTO license_store_grants (product, license_id, flag, store, purchase_key_hash, state, granted_at)
       VALUES (?, 'lic_e', 'clash', 'steam', 'h1', 'active', 4)`,
      SLUG,
    );
    const report = await dryOf(w, job);
    const d = (await unitDetail(w.db, report.id)) as any;
    expect(d.docDiffs).toBe(1);
    expect(d.docDiffIds).toEqual(["license:lic_e"]);
    expect(d.docDiffReasons).toEqual({ "grant-key": 1 });
    await applyOf(w, job, report.id, NOW + 1);
    expect((await overridesOf(w.db, "lic_e")).entitlements).toEqual({});
    const next = await dryOf(w, job, NOW + 2);
    expect(((await unitDetail(w.db, next.id)) as any).docDiffs).toBe(1);
  });
});

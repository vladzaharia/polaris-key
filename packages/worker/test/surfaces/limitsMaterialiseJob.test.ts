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
import { KvMock } from "../kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../seed.js";
import type { Db, DbStatement } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { matchRoute } from "../../src/router.js";
import { dispatchService } from "../../src/core/registry.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { SERVICES } from "../../src/mount.js";
import { apply, down, dryRun, getRun } from "../../src/core/migrate/runner.js";
import type { MigrationContext } from "../../src/core/migrate/job.js";
import {
  applyLimitsUnit,
  limitsMaterialiseJob as job,
  LIMITS_BATCH,
} from "../../src/services/license/migrations/limitsMaterialise.js";
import { insertLicense } from "../../src/core/licensing/store.js";
import { migrationJobs } from "../../src/core/contributions.js";

const SLUG = "djdl";
const ACTOR = { sub: "op", name: "Op", email: null };

interface World {
  db: Db;
  env: Env;
  product: Product;
  licences: Array<{ id: string; key: string }>;
}

/** Tiers and licences covering every rule: assign, union, tighter bound, offline days. */
async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
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
  return {
    db,
    env,
    product: (await loadProduct(env, db, SLUG))!,
    licences,
  };
}

const ctxOf =
  (w: { db: Db; env: Env }) =>
  (at = NOW): MigrationContext => ({ env: w.env, db: w.db, now: at });

async function dump(db: Db): Promise<string> {
  const out: unknown[] = [];
  for (const t of ["licenses", "tiers", "license_limit_backfill"])
    out.push(await db.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`));
  return JSON.stringify(out);
}

async function call(w: World, path: string, headers: Record<string, string>) {
  const route = matchRoute(path);
  if (route.kind !== "service") throw new Error(`not a service route: ${path}`);
  return dispatchService(SERVICES, route.slug, w.product.services, {
    req: mkReq("GET", headers),
    env: w.env,
    db: w.db,
    product: w.product,
    rest: route.rest,
    now: NOW,
  });
}

/** Activate each licence once; the tokens serve both the before and the after read. */
async function tokens(w: World): Promise<string[]> {
  const out: string[] = [];
  for (const l of w.licences) {
    const route = matchRoute(`/${SLUG}/license/activate`);
    if (route.kind !== "service") throw new Error("route");
    const res = await dispatchService(
      SERVICES,
      route.slug,
      w.product.services,
      {
        req: mkReq("POST", {
          authorization: `Bearer ${l.key}`,
          "x-pkey-device": `dev-${l.id}`,
        }),
        env: w.env,
        db: w.db,
        product: w.product,
        rest: route.rest,
        now: NOW,
      },
    );
    expect(res.status).toBe(200);
    out.push(((await res.json()) as { token: string }).token);
  }
  return out;
}

async function documents(w: World, toks: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of toks) {
    const headers = { authorization: `Bearer ${t}`, "x-pkey-version": "1.5.0" };
    for (const kind of ["license", "config"]) {
      const res = await call(w, `/${SLUG}/${kind}/document`, headers);
      expect(res.status).toBe(200);
      out.push(await res.text());
    }
  }
  return out;
}

const noTier = (db: Db) =>
  db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND tier_id IS NULL",
    SLUG,
  );

describe("license.limits-materialise", () => {
  it("is contributed by the License service and runs License products only", async () => {
    expect(migrationJobs().map((j) => j.id)).toContain(job.id);
    const w = await world();
    expect(await job.units(ctxOf(w)())).toEqual([SLUG]);
  });

  it("a dry run writes nothing and reports counts and capped ids", async () => {
    const w = await world();
    const before = await dump(w.db);
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
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
    const toks = await tokens(w);
    const docsBefore = await documents(w, toks);
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    const res = await apply(ctxOf(w)(NOW + 1), job, ACTOR, report.id);
    expect(res.ok && res.run.status).toBe("applied");

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
    expect(await documents(w, toks)).toEqual(docsBefore);

    const again = await apply(ctxOf(w)(NOW + 2), job, ACTOR, report.id);
    expect(again.ok && again.noop).toBe(true);
    const second = await dryRun(ctxOf(w)(NOW + 3), job, ACTOR);
    expect(second.changes).toBe(0);
    expect(((await unitDetail(w.db, second.id)) as any).docDiffs).toBe(0);
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
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    let batches = 0;
    const flaky: Db = {
      all: (s, ...p) => w.db.all(s, ...p),
      first: (s, ...p) => w.db.first(s, ...p),
      run: (s, ...p) => w.db.run(s, ...p),
      runChanges: (s, ...p) => w.db.runChanges(s, ...p),
      batch: (s: DbStatement[]) => w.db.batch(s),
      batchChanges: async (s: DbStatement[]) => {
        // The seed is batch 1; kill the second licence batch.
        if (++batches === 3) throw new Error("killed");
        return w.db.batchChanges!(s);
      },
    };
    const killed = await apply(
      { env: w.env, db: flaky, now: NOW + 1 },
      job,
      ACTOR,
      report.id,
    );
    expect(killed.ok && killed.run.status).toBe("failed");
    const left = (await noTier(w.db))!.n;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(LIMITS_BATCH + 24);

    const resumed = await apply(ctxOf(w)(NOW + 2), job, ACTOR, report.id);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    expect((await noTier(w.db))!.n).toBe(0);
    expect((await dryRun(ctxOf(w)(NOW + 3), job, ACTOR)).changes).toBe(0);
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
    const next = await dryRun(ctxOf(w)(NOW + 2), job, ACTOR);
    expect(next.changes).toBe(1);
    expect(((await unitDetail(w.db, next.id)) as any).seed).toBe("none");
  });

  it("down restores the rows byte for byte and removes the seeded tier", async () => {
    const w = await world();
    const before = await dump(w.db);
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    const applied = await apply(ctxOf(w)(NOW + 1), job, ACTOR, report.id);
    if (!applied.ok) throw new Error("apply");
    expect(await dump(w.db)).not.toBe(before);
    const undone = await down(ctxOf(w)(NOW + 2), job, ACTOR, applied.run.id);
    expect(undone.ok && undone.run.status).toBe("reverted");
    expect(await dump(w.db)).toBe(before);
  });

  it("down keeps a later edit and a seeded tier that a licence now uses", async () => {
    const w = await world();
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    const applied = await apply(ctxOf(w)(NOW + 1), job, ACTOR, report.id);
    if (!applied.ok) throw new Error("apply");
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
    await down(ctxOf(w)(NOW + 2), job, ACTOR, applied.run.id);
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
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    expect(((await unitDetail(w.db, report.id)) as any).seed).toBe("update");
    const applied = await apply(ctxOf(w)(NOW + 1), job, ACTOR, report.id);
    if (!applied.ok) throw new Error("apply");
    const t = await w.db.first<Record<string, unknown>>(
      "SELECT policy_device_limit, policy_offline_grace_days FROM tiers WHERE product = ? AND id = 'default'",
      SLUG,
    );
    expect(t).toEqual({
      policy_device_limit: 5,
      policy_offline_grace_days: 30,
    });
    await down(ctxOf(w)(NOW + 2), job, ACTOR, applied.run.id);
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
    const report = await dryRun(ctxOf(w)(), job, ACTOR);
    const d = (await unitDetail(w.db, report.id)) as any;
    expect(d.docDiffIds).toContain("lic_e");
    expect(d.docDiffReasons["device-entitlement"]).toBeGreaterThan(0);
    expect(d.danglingIds).toEqual(["lic_f"]);
    await apply(ctxOf(w)(NOW + 1), job, ACTOR, report.id);
    const f = await w.db.first<{ tier_id: string }>(
      "SELECT tier_id FROM licenses WHERE product = ? AND id = 'lic_f'",
      SLUG,
    );
    expect(f!.tier_id).toBe("gone");
  });
});

/** The stored detail of a dry run's only unit. */
async function unitDetail(db: Db, runId: string): Promise<unknown> {
  const run = (await getRun(db, runId)) as unknown as {
    units: Array<{ unit: string; detail?: unknown }>;
  };
  return run.units.find((u) => u.unit === SLUG)?.detail;
}

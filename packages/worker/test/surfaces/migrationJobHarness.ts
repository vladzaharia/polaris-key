/**
 * Shared by the migration job tests that drive a job through the real runner and compare the signed
 * documents of a product's licences before and after: the dispatch helpers, the activation tokens
 * and a unit's stored dry-run detail.
 */
import { expect } from "vitest";
import { migrationJobs } from "../../src/core/contributions.js";
import { loadProduct } from "../../src/core/products.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, mkReq, NOW } from "../seed.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { matchRoute } from "../../src/router.js";
import { dispatchService } from "../../src/core/registry.js";
import type { Product } from "../../src/core/products.js";
import { SERVICES } from "../../src/mount.js";
import { apply, down, dryRun, getRun } from "../../src/core/migrate/runner.js";
import type {
  MigrationContext,
  MigrationJob,
} from "../../src/core/migrate/job.js";

export const SLUG = "djdl";
export const ACTOR = { sub: "op", name: "Op", email: null };

export interface World {
  db: Db;
  env: Env;
  product: Product;
  licences: Array<{ id: string; key: string }>;
}

export const newEnv = (): Env => makeEnv(new KvMock(), [SLUG]);

export const ctxOf =
  (w: { db: Db; env: Env }) =>
  (at = NOW): MigrationContext => ({ env: w.env, db: w.db, now: at });

export async function call(
  w: World,
  path: string,
  headers: Record<string, string>,
) {
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
export async function tokens(w: World): Promise<string[]> {
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

export async function documents(w: World, toks: string[]): Promise<string[]> {
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

/** The stored detail of a dry run's only unit. */
export async function unitDetail(db: Db, runId: string): Promise<unknown> {
  const run = (await getRun(db, runId)) as unknown as {
    units: Array<{ unit: string; detail?: unknown }>;
  };
  return run.units.find((u) => u.unit === SLUG)?.detail;
}

/** A dry run of `job` over the world at `at`. */
export const dryOf = (w: World, job: MigrationJob, at = NOW) =>
  dryRun(ctxOf(w)(at), job, ACTOR);

/** Applies the dry run `runId` of `job` at `at`. */
export const applyOf = (
  w: World,
  job: MigrationJob,
  runId: string,
  at = NOW,
  via: Db = w.db,
) => apply({ ...ctxOf(w)(at), db: via }, job, ACTOR, runId);

/** Undoes the apply `runId` of `job` at `at`. */
export const downOf = (w: World, job: MigrationJob, runId: string, at = NOW) =>
  down(ctxOf(w)(at), job, ACTOR, runId);

/** A dry run and its apply, the apply narrowed to a finished one. */
export async function dryThenApply(w: World, job: MigrationJob, at = NOW + 1) {
  const report = await dryOf(w, job);
  const applied = await applyOf(w, job, report.id, at);
  if (!applied.ok) throw new Error("apply");
  return { report, applied };
}

/** The database, with its `nth` batch (counting from 1) killed. */
export function killingBatch(db: Db, nth: number): Db {
  let batches = 0;
  return {
    all: (s, ...p) => db.all(s, ...p),
    first: (s, ...p) => db.first(s, ...p),
    run: (s, ...p) => db.run(s, ...p),
    runChanges: (s, ...p) => db.runChanges(s, ...p),
    batch: (s) => db.batch(s),
    batchChanges: async (s) => {
      if (++batches === nth) throw new Error("killed");
      return db.batchChanges!(s);
    },
  };
}

/** The world a job test starts from, once its rows are seeded. */
export async function finishWorld(
  db: Db,
  env: Env,
  licences: World["licences"],
): Promise<World> {
  return { db, env, product: (await loadProduct(env, db, SLUG))!, licences };
}

/** Every row of the given tables, in a stable order, as one string. */
export async function dumpTables(
  db: Db,
  tables: readonly string[],
): Promise<string> {
  const out: unknown[] = [];
  for (const t of tables)
    out.push(await db.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`));
  return JSON.stringify(out);
}

/** Applying the same report again is a no-op, and a fresh dry run reports nothing to do. */
export async function expectSettled(
  w: World,
  job: MigrationJob,
  runId: string,
): Promise<void> {
  const again = await applyOf(w, job, runId, NOW + 2);
  expect(again.ok && again.noop).toBe(true);
  const second = await dryOf(w, job, NOW + 3);
  expect(second.changes).toBe(0);
  expect(((await unitDetail(w.db, second.id)) as any).docDiffs).toBe(0);
}

/** Applies the job, then `down` puts every row back exactly as `dump` sees it. */
export async function expectDownRestores(
  w: World,
  job: MigrationJob,
  dump: (db: Db) => Promise<string>,
): Promise<void> {
  const before = await dump(w.db);
  const { applied } = await dryThenApply(w, job);
  expect(await dump(w.db)).not.toBe(before);
  const undone = await downOf(w, job, applied.run.id, NOW + 2);
  expect(undone.ok && undone.run.status).toBe("reverted");
  expect(await dump(w.db)).toBe(before);
}

/** The job is contributed by the License service and runs the License-enabled products only. */
export async function expectContributed(
  w: World,
  job: MigrationJob,
): Promise<void> {
  expect(migrationJobs().map((j) => j.id)).toContain(job.id);
  expect(await job.units(ctxOf(w)())).toEqual([SLUG]);
}

/** Dry-runs and applies the job; every licence's signed documents are identical afterwards. */
export async function applyKeepingDocuments(
  w: World,
  job: MigrationJob,
): Promise<{ id: string }> {
  const toks = await tokens(w);
  const docsBefore = await documents(w, toks);
  const report = await dryOf(w, job);
  const res = await applyOf(w, job, report.id, NOW + 1);
  expect(res.ok && res.run.status).toBe("applied");
  expect(await documents(w, toks)).toEqual(docsBefore);
  return report;
}

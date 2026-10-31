/**
 * U-05.8: erasure, export, size and product deletion for Cloud Sync's per-person objects, through
 * Core's subject-store hooks and the product-deletion contributions.
 */
import { describe, expect, it } from "vitest";
import "../../../src/index.js";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import {
  runSubjectDelete,
  runSubjectDeleteIsolated,
  runSubjectExport,
  subjectDataSize,
} from "../../../src/core/accounts/subjectHooks.js";
import {
  productDeletionStatements,
  purgeProductData,
} from "../../../src/core/contributions.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import {
  absorbCloudSync,
  callCloudSync,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import {
  PURGE_OBJECTS_PER_RUN,
  syncProductPurge,
} from "../../../src/services/sync/productDeletion.js";
import { CLOUD_SYNC_STORE } from "../../../src/services/sync/subjectStore.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { KvMock, asKv } from "../../kvMock.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
  ERASED_LEFTOVERS,
  erasureLeftovers,
} from "../../cloudSyncDoMock.js";

const P = "acme";
const Q = "other";
const C1 = "c_000000000000000client1";
const T0 = 1_760_000_000_000;
const at = (n: number) => formatHlc(T0 + n * 1000, 0);
const USER: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};
const PLATFORM: Classification = {
  verdict: "accept",
  scope: "platform",
  policy: "lastWrite",
};
const MERGE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "merge",
};

// The purge sets its flag in KV first (U-05.13, `purgeFlag.ts`).
type Cs = { CLOUD_SYNC: DurableObjectNamespace; HOT: KVNamespace };
function world() {
  const ns = new CloudSyncNamespaceMock();
  const env: Cs = {
    CLOUD_SYNC: asCloudSyncNamespace(ns),
    HOT: asKv(new KvMock()),
  };
  return { ns, env, db: makeTestDb() };
}

let id = 1;
const m = (
  key: string,
  op: SyncMutation["op"],
  n: number,
  extra: Partial<SyncMutation> = {},
  scope: "user" | "platform" = "user",
): SyncMutation => ({
  mutationId: id++,
  target: { setting: key, scope },
  op,
  editedHlc: at(n),
  ...extra,
});

/** A person with a plain value, a tombstone, a merged setting and a dormant platform row. */
async function populate(env: Cs, product: string, subject: string) {
  await callCloudSync<"push">(
    env,
    { product, subject },
    {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000_000 },
      request: {
        clientId: C1,
        cursor: 0,
        mutations: [
          m("theme", "set", 1, { value: "dark" }),
          m("old", "set", 2, { value: 1 }),
          m("old", "clear", 3),
          m("keys", "setMember", 4, { member: "jump", value: "space" }),
          m("res", "set", 5, { value: 1080 }, "platform"),
        ],
      },
      classified: [USER, USER, USER, MERGE, PLATFORM],
      serverNow: T0 + 3_600_000,
    },
  );
}

const putDir = (db: ReturnType<typeof makeTestDb>, p: string, s: string) =>
  db.run(
    `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
       quota_bytes, tier_id, platform, last_active_at, updated_at)
     VALUES (?, ?, 100, 2, 0, 0, 20, 1000, 'free', 'desktop', 5, 6)`,
    p,
    s,
  );

const tablesOf = (ns: CloudSyncNamespaceMock, name: string) =>
  ns
    .instance(name)
    .storage.sql.db.prepare(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();

describe("erasure", () => {
  it("leaves no data in the object, only the pin and the erasure time with a cleanup alarm; the directory row goes; a stranger's object stays", async () => {
    const { ns, env, db } = world();
    await populate(env, P, "a");
    await populate(env, P, "b");
    await populate(env, Q, "a"); // same subject name, another product
    await putDir(db, P, "a");
    await putDir(db, P, "b");
    await ns.instance(`${P}:a`).storage.setAlarm(T0);
    const ctx = { db, env: env as never, now: 1 };
    const failures = await runSubjectDeleteIsolated(ctx, {
      product: P,
      subject: "a",
    });
    expect(failures).toEqual([]);
    expect(erasureLeftovers(ns, `${P}:a`)).toEqual(ERASED_LEFTOVERS);
    expect(await ns.instance(`${P}:a`).storage.getAlarm()).not.toBeNull();
    expect(
      await db.all<{ product: string; subject: string }>(
        "SELECT product, subject FROM sync_directory ORDER BY subject",
      ),
    ).toEqual([{ product: P, subject: "b" }]);
    for (const other of [`${P}:b`, `${Q}:a`])
      expect(tablesOf(ns, other).length).toBeGreaterThan(0);
    // The erased pair has nothing to export, and a repeat is a no-op.
    expect(
      (await runSubjectExport(ctx, { product: P, subject: "a" }))[
        CLOUD_SYNC_STORE
      ],
    ).toMatchObject({ settings: null, directory: null });
    await runSubjectDelete(ctx, { product: P, subject: "a" });
  });

  it("erases records of every shape and the copies an account merge parked (U-09.8)", async () => {
    const { ns, env, db } = world();
    const rec = (
      subject: string,
      mutations: SyncMutation[],
      classified: Classification[],
    ) =>
      callCloudSync<"push">(
        env,
        { product: P, subject },
        {
          op: "push",
          deviceId: "d1",
          family: "desktop",
          limits: { quotaBytes: 1_000_000_000 },
          request: { clientId: C1, cursor: 0, mutations },
          classified,
          serverNow: T0 + 3_600_000,
        },
      );
    const r = (c: string, key: string, op: SyncMutation["op"], x = {}) => ({
      mutationId: id++,
      target: { record: [c, key] as [string, string] },
      op,
      editedHlc: at(1),
      ...x,
    });
    const kinds = (policy: "revision" | "merge" | "union"): Classification => ({
      verdict: "record",
      policy,
      maxRecords: 10,
    });
    for (const [subject, value] of [
      ["a", 1],
      ["b", 2],
    ] as const)
      await rec(
        subject,
        [
          r("saves", "s", "set", { value }),
          r("notes", "n", "setField", { field: "f", value }),
          r("tags", "t", "add", { element: value }),
        ],
        [kinds("revision"), kinds("merge"), kinds("union")],
      );
    const doc = (await exportCloudSync(env, { product: P, subject: "b" }))!;
    await absorbCloudSync(env, { product: P, subject: "a" }, doc);
    const held = (await exportCloudSync(env, { product: P, subject: "a" }))!;
    expect(held.records).toHaveLength(3);
    expect(held.parked).toHaveLength(1);
    const failures = await runSubjectDeleteIsolated(
      { db, env: env as never, now: 1 },
      { product: P, subject: "a" },
    );
    expect(failures).toEqual([]);
    expect(erasureLeftovers(ns, `${P}:a`)).toEqual(ERASED_LEFTOVERS);
  });

  it("a failing object is reported by store, keeps the directory row, and the retry finishes", async () => {
    const { ns, env, db } = world();
    await populate(env, P, "a");
    await putDir(db, P, "a");
    const real = asCloudSyncNamespace(ns);
    let down = true;
    const flaky = {
      idFromName: (n: string) => real.idFromName(n),
      get: (i: DurableObjectId) => {
        const stub = real.get(i) as unknown as {
          fetch: (u: string, o?: RequestInit) => Promise<Response>;
        };
        return {
          fetch: async (u: string, o?: RequestInit) => {
            if (down) throw new Error("do unavailable");
            return stub.fetch(u, o);
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    const failures = await runSubjectDeleteIsolated(
      { db, env: { CLOUD_SYNC: flaky } as never, now: 1 },
      { product: P, subject: "a" },
    );
    expect(failures.map((f) => f.store)).toEqual([CLOUD_SYNC_STORE]);
    expect(await db.all("SELECT 1 FROM sync_directory")).toHaveLength(1);
    expect(tablesOf(ns, `${P}:a`).length).toBeGreaterThan(0);
    down = false;
    expect(
      await runSubjectDeleteIsolated(
        { db, env: env as never, now: 1 },
        { product: P, subject: "a" },
      ),
    ).toEqual([]);
    expect(erasureLeftovers(ns, `${P}:a`)).toEqual(ERASED_LEFTOVERS);
    expect(await db.all("SELECT 1 FROM sync_directory")).toHaveLength(0);
  });
});

describe("export", () => {
  it("hands out everything: live rows, tombstones, member cells, dormant platform rows, client bindings and the directory counters", async () => {
    const { env, db } = world();
    await populate(env, P, "a");
    await putDir(db, P, "a");
    const out = (
      await runSubjectExport(
        { db, env: env as never, now: 1 },
        { product: P, subject: "a" },
      )
    )[CLOUD_SYNC_STORE] as any;
    expect(out.settings).toMatchObject({ product: P, subject: "a" });
    const byKey = Object.fromEntries(
      out.settings.settings.map((r: any) => [r.key, r]),
    );
    expect(Object.keys(byKey).sort()).toEqual(["keys", "old", "res", "theme"]);
    expect(byKey.old.deleted).toBe(true);
    expect(byKey.keys.members).toEqual([
      ["jump", expect.objectContaining({ value: "space", removed: false })],
    ]);
    expect(byKey.res).toMatchObject({ scope: "platform", family: "desktop" });
    expect(out.settings.clients).toEqual([
      { clientId: C1, deviceId: "d1", lastMutationId: expect.any(Number) },
    ]);
    expect(out.directory).toMatchObject({
      bytes: 100,
      revisionBytes: 20,
      tierId: "free",
    });
  });
});

describe("size", () => {
  it("is the directory's bytes plus revisions, else the object's own total, else 0", async () => {
    const { env, db } = world();
    const ctx = { db, env: env as never, now: 1 };
    await populate(env, P, "a");
    await populate(env, P, "b");
    await putDir(db, P, "a");
    expect(
      (await subjectDataSize(ctx, { product: P, subject: "a" })).total,
    ).toBe(120);
    const unflushed = (await subjectDataSize(ctx, { product: P, subject: "b" }))
      .total;
    const usage = await callCloudSync<"usage">(
      env,
      { product: P, subject: "b" },
      { op: "usage" },
    );
    expect(unflushed).toBe(usage.usage.bytes);
    expect(unflushed).toBeGreaterThan(0);
    expect(
      (await subjectDataSize(ctx, { product: P, subject: "nobody" })).total,
    ).toBe(0);
  });
});

describe("product deletion", () => {
  async function fixture() {
    const w = world();
    for (const p of [P, Q]) await seedProduct(w.db, p);
    for (const s of ["a", "b", "c"]) {
      await populate(w.env, P, s);
      await putDir(w.db, P, s);
    }
    await populate(w.env, Q, "a");
    await putDir(w.db, Q, "a");
    for (const p of [P, Q])
      await w.db.run(
        "INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at) VALUES (?, 1, 1, 1, 0, 0, 0, '{}', 1)",
        p,
      );
    return w;
  }

  it("erases every object of the product (found through the directory), then the rows; another product is untouched", async () => {
    const { ns, env, db } = await fixture();
    expect(await purgeProductData(db, env as never, P, NOW)).toBe(true);
    for (const s of ["a", "b", "c"])
      expect(erasureLeftovers(ns, `${P}:${s}`)).toEqual(ERASED_LEFTOVERS);
    await deleteProduct(db, P, NOW);
    for (const t of ["sync_directory", "sync_product_usage"])
      expect(
        await db.all<{ product: string }>(`SELECT product FROM ${t}`),
      ).toEqual([{ product: Q }]);
    expect(tablesOf(ns, `${Q}:a`).length).toBeGreaterThan(0);
  });

  it("is part of the statements deleteProduct runs for every product, whatever its services", () => {
    const sql = productDeletionStatements(P, NOW)
      .map((s) => s.sql)
      .join("\n");
    for (const t of [
      "sync_directory",
      "sync_product_usage",
      "sync_product_daily",
    ])
      expect(sql).toContain(t);
  });

  it("a failure part way leaves the unerased subjects in the directory and the retry completes", async () => {
    const { ns, env, db } = await fixture();
    const real = asCloudSyncNamespace(ns);
    let calls = 0;
    const flaky = {
      idFromName: (n: string) => real.idFromName(n),
      get: (i: DurableObjectId) => {
        const stub = real.get(i) as unknown as {
          fetch: (u: string, o?: RequestInit) => Promise<Response>;
        };
        return {
          fetch: async (u: string, o?: RequestInit) => {
            if (++calls === 2) throw new Error("boom");
            return stub.fetch(u, o);
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    await expect(
      syncProductPurge({
        db,
        env: { CLOUD_SYNC: flaky, HOT: env.HOT } as never,
        product: P,
        now: NOW,
      }),
    ).rejects.toThrow("boom");
    expect(
      (
        await db.all<{ subject: string }>(
          "SELECT subject FROM sync_directory WHERE product = ? ORDER BY subject",
          P,
        )
      ).map((r) => r.subject),
    ).toEqual(["b", "c"]);
    expect(await purgeProductData(db, env as never, P, NOW)).toBe(true);
    for (const s of ["a", "b", "c"])
      expect(erasureLeftovers(ns, `${P}:${s}`)).toEqual(ERASED_LEFTOVERS);
  });

  it("a run is bounded: past the cap it answers not done, and the next run finishes", async () => {
    const { env, db } = world();
    await seedProduct(db, P);
    const n = PURGE_OBJECTS_PER_RUN + 5;
    await db.batch(
      Array.from({ length: n }, (_, i) => ({
        sql: `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
                quota_bytes, tier_id, platform, last_active_at, updated_at)
              VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, 1, 1)`,
        params: [P, `s${String(i).padStart(4, "0")}`],
      })),
    );
    expect(await purgeProductData(db, env as never, P, NOW)).toBe(false);
    expect(
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sync_directory",
      ))!.n,
    ).toBe(5);
    expect(await purgeProductData(db, env as never, P, NOW)).toBe(true);
  });
});

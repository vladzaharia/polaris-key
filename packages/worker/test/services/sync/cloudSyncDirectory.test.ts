/**
 * U-05.9: the coalesced directory flush, in the object's alarm (plans/U-05-slices.md §3; L5, L7).
 * The real `CloudSyncDO` over the SQLite mock and an in-memory D1 stand-in.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import type { Db, DbStatement } from "../../../src/db/types.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import { callCloudSync } from "../../../src/services/sync/do/client.js";
import {
  FLUSH_WINDOW_MS,
  IDLE_RETENTION_SECONDS,
} from "../../../src/services/sync/do/directory.js";
import { syncProductPurge } from "../../../src/services/sync/productDeletion.js";
import { ABSORBED_RETENTION_MS } from "../../../src/services/sync/do/cloudSyncDo.js";
import {
  absorbCloudSync,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { cloudSyncStore } from "../../../src/services/sync/subjectStore.js";
import { makeTestDb } from "../../helpers.js";
import { seedProduct } from "../../seed.js";
import { KvMock, asKv } from "../../kvMock.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
  ERASED_LEFTOVERS,
  erasureLeftovers,
} from "../../cloudSyncDoMock.js";

const T0 = 1_760_000_000_000;
const DAY = 86_400_000;
const P = "acme";
const A = "sub_alice";
const B = "sub_bob";
const C1 = "c_000000000000000client1";
const NAME = (s: string) => `${P}:${s}`;
const LAST_WRITE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};

async function world(flushTimeoutMs?: number) {
  const clock = { t: T0 };
  const inner = makeTestDb();
  const batches: DbStatement[][] = [];
  const state = {
    fail: false,
    failAfterCommit: false,
    gate: null as Promise<void> | null,
  };
  // The object flushes through `batchChanges` (the last statement's changed-row count tells it the
  // product is gone); `batch` stays the same recorded, fault-injected path for older callers.
  const through = async (s: DbStatement[]): Promise<number[]> => {
    batches.push(s);
    if (state.gate) await state.gate;
    if (state.fail) throw new Error("d1 down");
    const changes = await inner.batchChanges!(s);
    if (state.failAfterCommit) throw new Error("reply lost");
    return changes;
  };
  const db: Db = Object.assign(Object.create(inner) as Db, {
    batch: async (s: DbStatement[]) => {
      await through(s);
    },
    batchChanges: through,
  });
  const ns = new CloudSyncNamespaceMock({
    db: () => db,
    now: () => clock.t,
    ...(flushTimeoutMs ? { flushTimeoutMs } : {}),
  });
  const env = { CLOUD_SYNC: asCloudSyncNamespace(ns) };
  await seedProduct(inner, P);
  return { clock, db: inner, batches, state, ns, env };
}

let id = 1;
const mut = (
  key: string,
  op: SyncMutation["op"],
  at: number,
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: id++,
  target: { setting: key, scope: "user" },
  op,
  editedHlc: formatHlc(at, 0),
  ...extra,
});

async function write(
  w: Awaited<ReturnType<typeof world>>,
  subject: string,
  mutations: SyncMutation[],
  extra: Record<string, unknown> = {},
) {
  const r = await callCloudSync<"push">(
    w.env,
    { product: P, subject },
    {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1000 },
      request: { clientId: C1, cursor: 0, mutations },
      classified: mutations.map(() => LAST_WRITE),
      serverNow: w.clock.t,
      ...extra,
    },
  );
  if (!r.outcome.ok) throw new Error("push refused");
  return r.outcome;
}

const dirRow = (w: Awaited<ReturnType<typeof world>>, subject: string) =>
  w.db.first<Record<string, unknown>>(
    "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
    P,
    subject,
  );

describe("directory flush (U-05.9)", () => {
  it("the first write schedules an alarm at once, and the alarm makes the directory row", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: "x" })], {
      tierId: "pro",
      platform: "macos",
    });
    expect(w.ns.instance(NAME(A)).storage.alarm).toBe(T0);
    expect(await dirRow(w, A)).toBeNull();
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).toMatchObject({
      bytes: expect.any(Number),
      settings: 1,
      quota_bytes: 1000,
      tier_id: "pro",
      platform: "macos",
      last_active_at: T0 / 1000,
      updated_at: T0 / 1000,
    });
    expect(Number((await dirRow(w, A))?.bytes)).toBeGreaterThan(0);
    // The product purge finds it: its enumeration is this row.
    expect(
      (
        await w.db.all(
          "SELECT subject FROM sync_directory WHERE product = ?",
          P,
        )
      ).length,
    ).toBe(1);
  });

  it("later writes coalesce: one alarm per window, one D1 batch for many writes", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(1);
    w.clock.t = T0 + 60_000;
    await write(w, A, [mut("b", "set", w.clock.t - 1000, { value: 2 })]);
    const alarm = w.ns.instance(NAME(A)).storage.alarm;
    expect(alarm).toBe(T0 + FLUSH_WINDOW_MS);
    w.clock.t = T0 + 120_000;
    await write(w, A, [mut("c", "set", w.clock.t - 1000, { value: 3 })]);
    expect(w.ns.instance(NAME(A)).storage.alarm).toBe(alarm); // not rescheduled
    expect(w.batches).toHaveLength(1);
    w.clock.t = T0 + FLUSH_WINDOW_MS;
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(2);
    expect((await dirRow(w, A))?.settings).toBe(3);
  });

  it("a clean alarm does nothing", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    await w.ns.fireAlarm(NAME(A));
    w.clock.t += FLUSH_WINDOW_MS;
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(1);
    expect(w.ns.instance(NAME(A)).storage.alarm).toBeNull();
  });

  it("counts the day's syncs and conflicts, per UTC day, and adds across flushes", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    // A stale edit loses to the newer one: a conflict.
    await write(w, A, [mut("a", "set", T0 - 90_000, { value: 0 })]);
    await w.ns.fireAlarm(NAME(A));
    const day = new Date(T0).toISOString().slice(0, 10);
    const r = await w.db.first<{ syncs: number; conflicts: number }>(
      "SELECT syncs, conflicts FROM sync_product_daily WHERE product = ? AND day = ?",
      P,
      day,
    );
    expect(r?.syncs).toBe(2);
    expect(r?.conflicts).toBeGreaterThanOrEqual(0);
    w.clock.t += FLUSH_WINDOW_MS;
    await write(w, B, [mut("a", "set", w.clock.t - 1000, { value: 1 })]);
    await w.ns.fireAlarm(NAME(B));
    expect(
      (
        await w.db.first<{ syncs: number }>(
          "SELECT syncs FROM sync_product_daily WHERE product = ? AND day = ?",
          P,
          new Date(w.clock.t).toISOString().slice(0, 10),
        )
      )?.syncs,
    ).toBe(3);
  });

  it("platform is the device's own, the last seen; a push without one keeps it", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.clock.t += 1000;
    await write(w, A, [mut("b", "set", w.clock.t - 500, { value: 1 })], {
      family: "mobile",
      platform: "ios",
    });
    await w.ns.fireAlarm(NAME(A));
    expect((await dirRow(w, A))?.platform).toBe("ios");
    w.clock.t += 1000;
    await write(w, A, [mut("c", "set", w.clock.t - 500, { value: 2 })]);
    await w.ns.fireAlarm(NAME(A));
    expect((await dirRow(w, A))?.platform).toBe("ios");
  });

  it("the directory column is a closed set: an unknown or odd platform is stored as null", async () => {
    for (const odd of [
      "mobile",
      "Windows 11",
      "<script>",
      "x".repeat(500),
      "__proto__",
      "",
    ]) {
      const w = await world();
      await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })], {
        platform: odd,
      });
      await w.ns.fireAlarm(NAME(A));
      expect((await dirRow(w, A))?.platform, odd).toBeNull();
    }
  });

  it("a D1 failure leaves the object dirty and the retry flushes", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.state.fail = true;
    await expect(w.ns.fireAlarm(NAME(A))).rejects.toThrow("d1 down");
    expect(await dirRow(w, A)).toBeNull();
    w.state.fail = false;
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).not.toBeNull();
  });

  it("an alarm after deleteAll writes nothing and recreates no row", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    await callCloudSync<"deleteAll">(
      w.env,
      { product: P, subject: A },
      { op: "deleteAll" },
    );
    // Only the cleanup alarm of the erasure marker is left: it flushes nothing, and a day on
    // it erases the marker too.
    expect(w.ns.instance(NAME(A)).storage.alarm).toBe(T0 + 86_400_000);
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(0);
    expect(await dirRow(w, A)).toBeNull();
    expect(erasureLeftovers(w.ns, NAME(A))).toEqual(ERASED_LEFTOVERS);
    w.clock.t = T0 + 86_400_000;
    await w.ns.fireAlarm(NAME(A));
    expect(erasureLeftovers(w.ns, NAME(A))).toBeNull();
    expect(w.ns.instance(NAME(A)).storage.alarm).toBeNull();
  });

  it("a deleteAll that races an in-flight flush waits for it, and the object stays erased", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    let release!: () => void;
    w.state.gate = new Promise<void>((r) => (release = r));
    const alarm = w.ns.fireAlarm(NAME(A));
    const del = callCloudSync<"deleteAll">(
      w.env,
      { product: P, subject: A },
      { op: "deleteAll" },
    );
    release();
    await alarm;
    await del;
    // The subject store deletes the directory row after the object, so it ends erased.
    await cloudSyncStore.delete(
      { db: w.db, env: w.env as never, now: T0 / 1000 } as never,
      { product: P, subject: A },
    );
    expect(await dirRow(w, A)).toBeNull();
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).toBeNull();
    expect(erasureLeftovers(w.ns, NAME(A))).toEqual(ERASED_LEFTOVERS);
  });

  it("size falls back to the object until the alarm runs, then the directory answers", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: "xxxx" })]);
    const ctx = { db: w.db, env: w.env as never, now: T0 / 1000 } as never;
    const before = await cloudSyncStore.size!(ctx, { product: P, subject: A });
    expect(before).toBeGreaterThan(0);
    await w.ns.fireAlarm(NAME(A));
    expect(await cloudSyncStore.size!(ctx, { product: P, subject: A })).toBe(
      before,
    );
    expect((await dirRow(w, A))?.bytes).toBe(before);
  });

  it("a first write is enumerable by the product purge within one alarm", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    await w.ns.fireAlarm(NAME(A));
    const out = await syncProductPurge({
      db: w.db,
      // The purge sets its flag in KV first (U-05.13).
      env: { ...w.env, HOT: asKv(new KvMock()) } as never,
      product: P,
      now: T0 / 1000,
    });
    expect(out.done).toBe(true);
    expect(erasureLeftovers(w.ns, NAME(A))).toEqual(ERASED_LEFTOVERS);
  });

  describe("the merge marker's cleanup alarm (SR-2)", () => {
    const mergeDelete = async (w: Awaited<ReturnType<typeof world>>) => {
      const doc = (
        await callCloudSync<"exportAll">(
          w.env,
          { product: P, subject: A },
          { op: "exportAll" },
        )
      ).document!;
      return callCloudSync<"deleteAll">(
        w.env,
        { product: P, subject: A },
        {
          op: "deleteAll",
          absorbedInto: B,
          ifSeq: doc.seq,
          ifWrites: doc.writes,
        },
      );
    };

    it("the alarm is set when the marker is written, a day out, and a retry does not push it out", async () => {
      const w = await world();
      await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
      expect((await mergeDelete(w)).deleted).toBe(true);
      const due = T0 + ABSORBED_RETENTION_MS;
      expect(w.ns.instance(NAME(A)).storage.alarm).toBe(due);
      w.clock.t += 3_600_000;
      // The retried delete finds the marker: still one day from the FIRST absorption.
      const again = await callCloudSync<"deleteAll">(
        w.env,
        { product: P, subject: A },
        { op: "deleteAll", absorbedInto: B, ifSeq: 0, ifWrites: 0 },
      );
      expect(again.deleted).toBe(true);
      expect(w.ns.instance(NAME(A)).storage.alarm).toBe(due);
      // The alarm erases the whole object.
      w.clock.t = due;
      await w.ns.fireAlarm(NAME(A));
      expect(
        w.ns
          .instance(NAME(A))
          .storage.sql.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all(),
      ).toEqual([]);
    });

    it("a setAlarm that fails is a retryable failure and wipes nothing", async () => {
      const w = await world();
      await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
      const storage = w.ns.instance(NAME(A)).storage;
      const real = storage.setAlarm.bind(storage);
      storage.setAlarm = async () => {
        throw new Error("alarm storage down");
      };
      await expect(mergeDelete(w)).rejects.toMatchObject({
        status: 503,
        code: "unavailable",
      });
      expect(
        (
          await callCloudSync<"usage">(
            w.env,
            { product: P, subject: A },
            { op: "usage" },
          )
        ).empty,
      ).toBe(false);
      storage.setAlarm = real;
      // The retry completes, with the first absorption time.
      const doc = (
        await callCloudSync<"exportAll">(
          w.env,
          { product: P, subject: A },
          { op: "exportAll" },
        )
      ).document;
      expect(doc).toBeNull();
      const done = await callCloudSync<"deleteAll">(
        w.env,
        { product: P, subject: A },
        { op: "deleteAll", absorbedInto: B, ifSeq: 0, ifWrites: 0 },
      );
      expect(done.deleted).toBe(true);
      expect(storage.alarm).toBe(T0 + ABSORBED_RETENTION_MS);
    });
  });

  it("an absorb that changed the survivor is flushed", async () => {
    const w = await world();
    await write(w, B, [mut("k", "set", T0 - 1000, { value: 1 })]);
    const doc = (
      await callCloudSync<"exportAll">(
        w.env,
        { product: P, subject: B },
        {
          op: "exportAll",
        },
      )
    ).document!;
    await callCloudSync<"absorb">(
      w.env,
      { product: P, subject: A },
      {
        op: "absorb",
        document: doc,
      },
    );
    expect(w.ns.instance(NAME(A)).storage.alarm).toBe(T0);
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).toMatchObject({ settings: 1, quota_bytes: 0 });
  });
});

/** A write and an alarm on day `d`: the daily activity that keeps the tombstone clock marking. */
const tickTo = async (w: Awaited<ReturnType<typeof world>>, d: number) => {
  w.clock.t = T0 + d * DAY;
  await write(w, A, [mut("z", "set", w.clock.t - 500, { value: d })]);
  await w.ns.fireAlarm(NAME(A));
};

describe("housekeeping in the alarm (U-05.9)", () => {
  const pullAt = (w: Awaited<ReturnType<typeof world>>, cursor: number) =>
    callCloudSync<"pull">(
      w.env,
      { product: P, subject: A },
      { op: "pull", cursor, deviceId: "d1", family: "desktop", clientId: C1 },
    );

  it("collects tombstones older than 90 days, never younger, and advances the watermark", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.clock.t += 1000;
    await write(w, A, [mut("a", "clear", w.clock.t - 500)]);
    await w.ns.fireAlarm(NAME(A)); // day 0 mark
    const seq0 = w.ns
      .instance(NAME(A))
      .storage.sql.db.prepare("SELECT value FROM meta WHERE key = 'seq'")
      .get() as { value: string };
    const tomb = () =>
      (
        w.ns
          .instance(NAME(A))
          .storage.sql.db.prepare("SELECT COUNT(*) AS n FROM tombstones")
          .get() as { n: number }
      ).n;
    expect(tomb()).toBe(1);
    // Daily activity keeps the clock marking; 89 days on, still there.
    for (const d of [1, 23, 45, 67, 89]) await tickTo(w, d);
    expect(tomb()).toBe(1);
    await tickTo(w, 91);
    expect(tomb()).toBe(0);
    const wm = w.ns
      .instance(NAME(A))
      .storage.sql.db.prepare("SELECT value FROM meta WHERE key = 'watermark'")
      .get() as { value: string };
    expect(Number(wm.value)).toBeGreaterThanOrEqual(Number(seq0.value));
    // A cursor below the watermark can no longer be served.
    const stale = await pullAt(w, 1);
    expect(stale.outcome).toMatchObject({ ok: false });
  });

  it("expires client bindings idle 90 days, and keeps an active one", async () => {
    const w = await world();
    const other = "c_000000000000000client2";
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.clock.t = T0 + 50 * DAY;
    await callCloudSync<"push">(
      w.env,
      { product: P, subject: A },
      {
        op: "push",
        deviceId: "d2",
        family: "desktop",
        limits: { quotaBytes: 1000 },
        request: {
          clientId: other,
          cursor: 0,
          mutations: [mut("b", "set", w.clock.t - 500, { value: 1 })],
        },
        classified: [LAST_WRITE],
        serverNow: w.clock.t,
      },
    );
    w.clock.t = T0 + (IDLE_RETENTION_SECONDS / 86400 + 1) * DAY;
    await w.ns.fireAlarm(NAME(A));
    const doc = (
      await callCloudSync<"exportAll">(
        w.env,
        { product: P, subject: A },
        {
          op: "exportAll",
        },
      )
    ).document!;
    expect(doc.clients.map((c) => c.clientId)).toEqual([other]);
  });
});

const dailyOf = async (w: Awaited<ReturnType<typeof world>>) =>
  w.db.first<{ syncs: number; conflicts: number }>(
    "SELECT SUM(syncs) AS syncs, SUM(conflicts) AS conflicts FROM sync_product_daily WHERE product = ?",
    P,
  );
const metaOf = (
  w: Awaited<ReturnType<typeof world>>,
  name: string,
  key: string,
) =>
  (
    w.ns
      .instance(name)
      .storage.sql.db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined
  )?.value;

describe("the flush is idempotent under an at-least-once alarm (U-05.9 B1)", () => {
  it("D1 commits, then the alarm throws: the retry does not double the counters", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.state.failAfterCommit = true;
    await expect(w.ns.fireAlarm(NAME(A))).rejects.toThrow("reply lost");
    expect((await dailyOf(w))?.syncs).toBe(1); // D1 holds it
    w.state.failAfterCommit = false;
    await w.ns.fireAlarm(NAME(A));
    expect((await dailyOf(w))?.syncs).toBe(1);
    expect(w.batches).toHaveLength(2); // the retry did send, and added nothing
    // Clean now.
    w.clock.t += FLUSH_WINDOW_MS;
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(2);
  });

  it("a failure before the commit counts once on the retry", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.state.fail = true;
    await expect(w.ns.fireAlarm(NAME(A))).rejects.toThrow("d1 down");
    expect(await dailyOf(w)).toMatchObject({ syncs: null });
    w.state.fail = false;
    await w.ns.fireAlarm(NAME(A));
    expect((await dailyOf(w))?.syncs).toBe(1);
  });

  it("writes between retries are counted in the next window, neither lost nor doubled", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.state.failAfterCommit = true;
    await expect(w.ns.fireAlarm(NAME(A))).rejects.toThrow();
    w.clock.t += 1000;
    await write(w, A, [mut("b", "set", w.clock.t - 500, { value: 2 })]);
    w.state.failAfterCommit = false;
    await w.ns.fireAlarm(NAME(A)); // the retry: clears the pending flush
    expect((await dailyOf(w))?.syncs).toBe(1);
    expect(w.ns.instance(NAME(A)).storage.alarm).not.toBeNull();
    w.clock.t += FLUSH_WINDOW_MS;
    await w.ns.fireAlarm(NAME(A));
    expect((await dailyOf(w))?.syncs).toBe(2);
    expect((await dirRow(w, A))?.settings).toBe(2);
  });

  it("a flush that races the product's deletion writes nothing", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    await w.db.run("UPDATE products SET status = 'deleted' WHERE slug = ?", P);
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).toBeNull();
    expect((await dailyOf(w))?.syncs).toBeNull();
    // The object erased itself (SR-2 B2), pending flush included.
    expect(w.ns.instance(NAME(A)).storage.alarm).toBeNull();
  });

  it("the object a stale push left for an erased product erases itself at its alarm (SR-2 B2)", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    const inst = w.ns.instance(NAME(A));
    expect(inst.storage.alarm).not.toBeNull();
    await w.db.run("UPDATE products SET status = 'deleted' WHERE slug = ?", P);
    await w.ns.fireAlarm(NAME(A));
    // Nothing is left: no setting, no alarm.
    expect(inst.storage.alarm).toBeNull();
    const usage = await callCloudSync<"usage">(
      w.env,
      { product: P, subject: A },
      { op: "usage" },
    );
    expect(usage).toMatchObject({ empty: true, seq: 0 });
  });
});

describe("alarm robustness (U-05.9 N-items)", () => {
  it("a duplicate or fully refused push neither counts nor dirties the object", async () => {
    const w = await world();
    const m = mut("a", "set", T0 - 1000, { value: 1 });
    await write(w, A, [m]);
    await w.ns.fireAlarm(NAME(A));
    w.clock.t += FLUSH_WINDOW_MS;
    await write(w, A, [m]); // the same mutation id: duplicate
    expect(metaOf(w, NAME(A), "directory_dirty")).toBe("0");
    expect(w.ns.instance(NAME(A)).storage.alarm).toBeNull();
    await w.ns.fireAlarm(NAME(A));
    expect(w.batches).toHaveLength(1);
    expect((await dailyOf(w))?.syncs).toBe(1);
  });

  it("a D1 batch that hangs times out, throws, and stays owed", async () => {
    const w = await world(20);
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    w.state.gate = new Promise<void>(() => {});
    await expect(w.ns.fireAlarm(NAME(A))).rejects.toThrow("timed out");
    w.state.gate = null;
    await w.ns.fireAlarm(NAME(A));
    expect((await dailyOf(w))?.syncs).toBe(1);
  });

  it("a setAlarm failure after a committed push does not fail the push", async () => {
    const w = await world();
    const st = w.ns.instance(NAME(A)).storage;
    st.setAlarm = async () => {
      throw new Error("alarm storage down");
    };
    const out = await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    expect(out.ok).toBe(true);
    expect(metaOf(w, NAME(A), "directory_dirty")).toBe("1");
    // The next write schedules it.
    st.setAlarm = async (at) => {
      st.alarm = typeof at === "number" ? at : at.getTime();
    };
    w.clock.t += 1000;
    await write(w, A, [mut("b", "set", w.clock.t - 500, { value: 1 })]);
    expect(st.alarm).not.toBeNull();
  });

  it("a bad tierId is refused before anything is stored", async () => {
    const w = await world();
    await expect(
      write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })], {
        tierId: "x".repeat(300),
      }),
    ).rejects.toThrow();
    expect(w.ns.instance(NAME(A)).storage.alarm).toBeNull();
  });

  it("an alarm on a v1 object migrates it, then flushes", async () => {
    const w = await world();
    await write(w, A, [mut("a", "set", T0 - 1000, { value: 1 })]);
    const raw = w.ns.instance(NAME(A)).storage.sql.db;
    raw.exec("ALTER TABLE clients DROP COLUMN last_seen");
    // A v1 object has neither the v3 `kid` columns nor the record tables (those are made fresh).
    for (const table of ["settings", "tombstones", "setting_members"])
      raw.exec(`ALTER TABLE ${table} DROP COLUMN kid`);
    raw.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    w.ns.instance(NAME(A)).obj["store"].reset();
    await w.ns.fireAlarm(NAME(A));
    expect(metaOf(w, NAME(A), "schema_version")).toBe("3");
    expect(await dirRow(w, A)).not.toBeNull();
  });
});

describe("housekeeping and the SR-1 write guard (U-05.9)", () => {
  const exportOf = async (w: Awaited<ReturnType<typeof world>>, s: string) =>
    (
      await callCloudSync<"exportAll">(
        w.env,
        { product: P, subject: s },
        { op: "exportAll" },
      )
    ).document;

  it("expiring a client moves the write count; a replayed push refreshes last_seen", async () => {
    const w = await world();
    const m = mut("a", "set", T0 - 1000, { value: 1 });
    await write(w, A, [m]);
    const before = (await exportOf(w, A))!.writes;
    // The client keeps replaying (an unchanged record) and stays bound.
    w.clock.t = T0 + 80 * DAY;
    await write(w, A, [m]);
    w.clock.t = T0 + 100 * DAY;
    await w.ns.fireAlarm(NAME(A));
    expect((await exportOf(w, A))!.clients).toHaveLength(1);
    // An idle one expires, and the guard's counter moves.
    w.clock.t = T0 + 200 * DAY;
    const mid = (await exportOf(w, A))!.writes;
    await w.ns.fireAlarm(NAME(A));
    const after = await exportOf(w, A);
    expect(after!.clients).toHaveLength(0);
    expect(after!.writes).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(before);
  });

  it("tombstone GC leaves cells and members consistent", async () => {
    const w = await world();
    const MERGE: Classification = {
      verdict: "accept",
      scope: "user",
      policy: "merge",
    };
    const t = (n: number) => T0 - 10_000 + n;
    const send = (ms: SyncMutation[]) =>
      callCloudSync<"push">(
        w.env,
        { product: P, subject: A },
        {
          op: "push",
          deviceId: "d1",
          family: "desktop",
          limits: { quotaBytes: 1000 },
          request: { clientId: C1, cursor: 0, mutations: ms },
          classified: ms.map(() => MERGE),
          serverNow: w.clock.t,
        },
      );
    await send([
      mut("keys", "setMember", t(1), { member: "jump", value: "space" }),
      mut("keys", "setMember", t(2), { member: "run", value: "shift" }),
    ]);
    await send([mut("keys", "removeMember", t(3), { member: "jump" })]);
    await w.ns.fireAlarm(NAME(A));
    const raw = w.ns.instance(NAME(A)).storage.sql.db;
    const members = () =>
      raw
        .prepare("SELECT member, removed FROM setting_members ORDER BY member")
        .all();
    expect(members()).toEqual([
      { member: "jump", removed: 1 },
      { member: "run", removed: 0 },
    ]);
    w.clock.t = T0 + 91 * DAY;
    await send([mut("other", "set", w.clock.t - 500, { value: 1 })]);
    await w.ns.fireAlarm(NAME(A));
    expect(members()).toEqual([{ member: "run", removed: 0 }]);
    const doc = (await exportOf(w, A))!;
    const row = doc.settings.find((r) => r.key === "keys")!;
    expect((row.members ?? []).map(([n]) => n)).toEqual(["run"]);
    expect(row.deleted).toBe(false);
  });
});

describe("the absorbed marker's lifetime (U-05.9)", () => {
  it("is erased a day after the merge, does no flush before, and marks nothing dirty", async () => {
    const w = await world();
    await write(w, B, [mut("k", "set", T0 - 1000, { value: 1 })]);
    await w.ns.fireAlarm(NAME(B));
    const doc = (
      await callCloudSync<"exportAll">(
        w.env,
        { product: P, subject: B },
        { op: "exportAll" },
      )
    ).document!;
    const flushed = w.batches.length;
    expect(
      await deleteCloudSyncIfUnchanged(
        w.env,
        { product: P, subject: B },
        { seq: doc.seq, writes: doc.writes },
        A,
      ),
    ).toBe(true);
    const st = w.ns.instance(NAME(B)).storage;
    const due = T0 + ABSORBED_RETENTION_MS;
    expect(st.alarm).toBe(due);
    expect(metaOf(w, NAME(B), "absorbed_into")).toBe(A);
    expect(metaOf(w, NAME(B), "directory_dirty")).toBeUndefined();
    // An early alarm leaves the marker (and reschedules).
    w.clock.t = T0 + ABSORBED_RETENTION_MS / 2;
    await w.ns.fireAlarm(NAME(B));
    expect(metaOf(w, NAME(B), "absorbed_into")).toBe(A);
    expect(st.alarm).toBe(due);
    expect(w.batches).toHaveLength(flushed);
    // At 30 days it erases itself: no tables, no alarm, no D1 write.
    w.clock.t = due;
    await w.ns.fireAlarm(NAME(B));
    expect(
      st.sql.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all(),
    ).toEqual([]);
    expect(st.alarm).toBeNull();
    expect(w.batches).toHaveLength(flushed);
  });
});

describe("merge delete order and paged GC (U-05.9)", () => {
  it("a crash between the marker and the wipe leaves a marked object, and the retry finishes the wipe", async () => {
    const w = await world();
    await write(w, B, [mut("k", "set", T0 - 1000, { value: 1 })]);
    const doc = (
      await callCloudSync<"exportAll">(
        w.env,
        { product: P, subject: B },
        { op: "exportAll" },
      )
    ).document!;
    // The state after the marker is written and before the wipe: data and marker together.
    const raw = w.ns.instance(NAME(B)).storage.sql.db;
    raw.exec(
      "INSERT INTO meta (key, value) VALUES ('absorbed_into', 'sub_alice')",
    );
    raw.exec("INSERT INTO meta (key, value) VALUES ('absorbed_at', '1')");
    // It already refuses writes.
    await expect(
      write(w, B, [mut("z", "set", T0 - 500, { value: 1 })]),
    ).rejects.toThrow();
    expect(
      await deleteCloudSyncIfUnchanged(
        w.env,
        { product: P, subject: B },
        { seq: doc.seq, writes: doc.writes },
        A,
      ),
    ).toBe(true);
    expect(raw.prepare("SELECT 1 FROM settings").all()).toEqual([]);
    expect(metaOf(w, NAME(B), "absorbed_into")).toBe(A);
  });

  it("collects more tombstones than one page holds", async () => {
    const w = await world();
    const keys = Array.from({ length: 130 }, (_, i) => `k${i}`);
    for (let i = 0; i < keys.length; i += 10) {
      await write(
        w,
        A,
        keys
          .slice(i, i + 10)
          .map((k) => mut(k, "set", T0 - 5000 + i, { value: 1 })),
      );
    }
    await write(
      w,
      A,
      keys.slice(0, 10).map((k) => mut(k, "clear", T0 - 100)),
    );
    for (let i = 10; i < 130; i += 10)
      await write(
        w,
        A,
        keys.slice(i, i + 10).map((k) => mut(k, "clear", T0 - 100)),
      );
    await w.ns.fireAlarm(NAME(A));
    const raw = w.ns.instance(NAME(A)).storage.sql.db;
    const n = () =>
      (
        raw.prepare("SELECT COUNT(*) AS n FROM tombstones").get() as {
          n: number;
        }
      ).n;
    expect(n()).toBe(130);
    w.clock.t = T0 + 91 * DAY;
    await write(w, A, [mut("z", "set", w.clock.t - 500, { value: 1 })]);
    await w.ns.fireAlarm(NAME(A));
    expect(n()).toBe(0);
  });
});

describe("records in the directory and in housekeeping (U-09.9)", () => {
  const REC = (policy: "revision" | "merge" | "union"): Classification => ({
    verdict: "record",
    policy,
    maxRecords: 100,
  });
  const rec = (
    collection: string,
    rid: string,
    op: SyncMutation["op"],
    at: number,
    extra: Partial<SyncMutation> = {},
  ): SyncMutation => ({
    mutationId: id++,
    target: { record: [collection, rid] },
    op,
    editedHlc: formatHlc(at, 0),
    ...extra,
  });
  const send = (
    w: Awaited<ReturnType<typeof world>>,
    items: [SyncMutation, Classification][],
  ) =>
    write(
      w,
      A,
      items.map(([m]) => m),
      {
        classified: items.map(([, c]) => c),
        limits: { quotaBytes: 100_000 },
      },
    );
  const usage = (w: Awaited<ReturnType<typeof world>>) =>
    callCloudSync<"usage">(
      w.env,
      { product: P, subject: A },
      { op: "usage" },
    ).then((r) => r.usage);

  it("the flush writes the live record count and the records' bytes, inside the total", async () => {
    const w = await world();
    await write(w, A, [mut("theme", "set", T0 - 1000, { value: "dark" })]);
    await send(w, [
      [
        rec("saves", "a", "set", T0 - 900, { value: { hp: 3 } }),
        REC("revision"),
      ],
      [
        rec("notes", "n", "setField", T0 - 800, { field: "f", value: 1 }),
        REC("merge"),
      ],
      [rec("tags", "t", "add", T0 - 700, { element: "x" }), REC("union")],
    ]);
    await w.ns.fireAlarm(NAME(A));
    const u = await usage(w);
    expect(u.records).toBe(3);
    expect(u.recordBytes).toBeGreaterThan(0);
    expect(u.bytes).toBeGreaterThan(u.recordBytes);
    expect(await dirRow(w, A)).toMatchObject({
      records: 3,
      record_bytes: u.recordBytes,
      bytes: u.bytes,
      settings: 1,
    });
    // A delete takes the record out of both counters at the next flush.
    w.clock.t += FLUSH_WINDOW_MS;
    await send(w, [
      [rec("saves", "a", "delete", w.clock.t - 500), REC("revision")],
    ]);
    await w.ns.fireAlarm(NAME(A));
    expect(await dirRow(w, A)).toMatchObject({ records: 2 });
  });

  it("an object that only absorbed records is flushed with them", async () => {
    const w = await world();
    await send(w, [
      [
        rec("saves", "a", "set", T0 - 900, { value: { hp: 3 } }),
        REC("revision"),
      ],
    ]);
    const doc = (await exportCloudSync(w.env, { product: P, subject: A }))!;
    await absorbCloudSync(w.env, { product: P, subject: B }, doc);
    await w.ns.fireAlarm(NAME(B));
    const row = await w.db.first<Record<string, unknown>>(
      "SELECT records, record_bytes FROM sync_directory WHERE product = ? AND subject = ?",
      P,
      B,
    );
    expect(row).toMatchObject({ records: 1 });
    expect(Number(row?.record_bytes)).toBeGreaterThan(0);
  });

  it("the alarm forgets record tombstones and removed field cells older than 90 days, and nothing younger", async () => {
    const w = await world();
    await send(w, [
      [rec("saves", "gone", "set", T0 - 900, { value: 1 }), REC("revision")],
      [rec("saves", "kept", "set", T0 - 900, { value: 2 }), REC("revision")],
      [
        rec("notes", "n", "setField", T0 - 800, { field: "a", value: 1 }),
        REC("merge"),
      ],
      [
        rec("notes", "n", "setField", T0 - 790, { field: "b", value: 2 }),
        REC("merge"),
      ],
      [rec("tags", "t", "add", T0 - 700, { element: "x" }), REC("union")],
    ]);
    await send(w, [
      [rec("saves", "gone", "delete", T0 - 500), REC("revision")],
      [
        rec("notes", "n", "removeField", T0 - 400, { field: "a" }),
        REC("merge"),
      ],
    ]);
    await w.ns.fireAlarm(NAME(A)); // day 0 mark
    const raw = w.ns.instance(NAME(A)).storage.sql.db;
    const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
    const tombs = () =>
      count("SELECT COUNT(*) AS n FROM records WHERE deleted = 1");
    const removed = () =>
      count("SELECT COUNT(*) AS n FROM record_fields WHERE removed = 1");
    const before = await usage(w);
    expect([tombs(), removed()]).toEqual([1, 1]);
    // 89 days on, nothing has gone.
    for (const d of [22, 44, 66, 88]) await tickTo(w, d);
    expect([tombs(), removed()]).toEqual([1, 1]);
    await tickTo(w, 91);
    expect([tombs(), removed()]).toEqual([0, 0]);
    // The live records, their live cells and the set are untouched, and the usage did not move.
    expect(count("SELECT COUNT(*) AS n FROM records WHERE deleted = 0")).toBe(
      3,
    );
    expect(count("SELECT COUNT(*) AS n FROM record_fields")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM set_elements")).toBe(1);
    const after = await usage(w);
    expect(after.records).toBe(before.records);
    expect(after.recordBytes).toBe(before.recordBytes);
    // A cursor from before the collection can no longer be served.
    const stale = await callCloudSync<"pull">(
      w.env,
      { product: P, subject: A },
      {
        op: "pull",
        cursor: 1,
        deviceId: "d1",
        family: "desktop",
        clientId: C1,
      },
    );
    expect(stale.outcome).toMatchObject({ ok: false });
  });
});

/**
 * U-05.7: the real `CloudSyncDO` class under workerd, bound from wrangler.toml's `CLOUD_SYNC`
 * (migration tag v4, SQLite-backed). The Node lane proves the engine and the object over a
 * better-sqlite3 mock; this proves the part that mock cannot: the real `SqlStorage`, the real
 * `transactionSync`, `deleteAll` and the alarm accessors.
 */
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  absorbCloudSync,
  callCloudSync,
  cloudSyncObjectName,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../src/services/sync/do/client.js";
import { D1Db } from "../src/db/d1.js";
import { seedProduct } from "./seed.js";
import { formatHlc } from "../src/services/sync/engine/hlc.js";
import type { Classification } from "../src/services/sync/engine/types.js";

const NOW = Date.now();
const LAST_WRITE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};
const C1 = "c_000000000000000client1";

const set = (id: number, key: string, value: string) => ({
  mutationId: id,
  target: { setting: key, scope: "user" as const },
  op: "set" as const,
  value,
  editedHlc: formatHlc(NOW - 1000, 0),
});

// The first write schedules an alarm that the runtime delivers by itself, and an object whose
// product is not live erases itself there (SR-2 B2): the product the tests write to must exist.
beforeAll(async () => {
  await seedProduct(env, new D1Db(env.DB), "wd", {
    schemaVersion: 1,
    entries: [],
  });
});

const pushTo = (pin: { product: string; subject: string }, key: string) =>
  callCloudSync<"push">(env, pin, {
    op: "push",
    deviceId: "d1",
    family: "desktop",
    platform: "macos",
    limits: { quotaBytes: 1_000_000 },
    request: { clientId: C1, cursor: 0, mutations: [set(1, key, "dark")] },
    classified: [LAST_WRITE],
    serverNow: NOW,
  });

describe("CloudSyncDO under workerd (U-05.7)", () => {
  it("is bound, and a push then a pull round-trips on SQLite-backed storage", async () => {
    expect(env.CLOUD_SYNC).toBeDefined();
    const pin = { product: "wd", subject: "sub_roundtrip" };
    const pushed = await pushTo(pin, "theme");
    expect(pushed.outcome).toBeDefined();
    // U-05.18: the runtime's own cursor counts, not a mock's.
    expect(pushed.meter?.rowsWritten).toBeGreaterThan(0);
    const pulled = await callCloudSync<"pull">(env, pin, {
      op: "pull",
      cursor: 0,
      deviceId: "d1",
      family: "desktop",
      clientId: C1,
    });
    expect(JSON.stringify(pulled.outcome)).toContain("theme");
    expect(pulled.meter?.rowsRead).toBeGreaterThan(0);
    const usage = await callCloudSync<"usage">(env, pin, { op: "usage" });
    expect(usage.empty).toBe(false);
  });

  it("stores records on SQLite-backed storage: create, delete, the tombstone bound and the usage (U-09.4)", async () => {
    const pin = { product: "wd", subject: "sub_records" };
    const route: Classification = {
      verdict: "record",
      policy: "revision",
      maxRecords: 1,
    };
    const rec = (id: number, rid: string, op: "set" | "delete") => ({
      mutationId: id,
      target: { record: ["saves", rid] as [string, string] },
      op,
      ...(op === "set" ? { value: { n: id } } : {}),
      editedHlc: formatHlc(NOW - 1000 + id, 0),
    });
    const mutations = [
      rec(1, "r1", "set"),
      rec(2, "r1", "delete"),
      rec(3, "r2", "set"),
      rec(4, "r2", "delete"),
      rec(5, "r3", "set"),
      rec(6, "r3", "delete"),
      rec(7, "r4", "set"),
    ];
    const pushed = await callCloudSync<"push">(env, pin, {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      platform: "macos",
      limits: { quotaBytes: 1_000_000 },
      request: { clientId: C1, cursor: 0, mutations },
      classified: mutations.map(() => route),
      serverNow: NOW,
    });
    expect(
      pushed.outcome.ok && pushed.outcome.results.map((r) => r.status),
    ).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    const stub = env.CLOUD_SYNC.get(
      env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)),
    );
    const rows = await runInDurableObject(stub, async (_obj, state) =>
      state.storage.sql
        .exec("SELECT id, deleted FROM records ORDER BY id")
        .toArray(),
    );
    // Two tombstones kept (2 x maxRecords), the oldest forgotten, and the live one.
    expect(rows).toEqual([
      { id: "r2", deleted: 1 },
      { id: "r3", deleted: 1 },
      { id: "r4", deleted: 0 },
    ]);
    const usage = await callCloudSync<"usage">(env, pin, { op: "usage" });
    expect(usage.usage).toMatchObject({ records: 1 });
  });

  it("creates nothing on a read, and refuses another pair on the same object", async () => {
    const pin = { product: "wd", subject: "sub_lazy" };
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
    expect(
      (await callCloudSync<"exportAll">(env, pin, { op: "exportAll" }))
        .document,
    ).toBeNull();
    await pushTo(pin, "k");
    const stub = env.CLOUD_SYNC.get(
      env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)),
    );
    const r = await stub.fetch("https://do/", {
      method: "POST",
      body: JSON.stringify({
        op: "usage",
        product: "wd",
        subject: "sub_other",
      }),
    });
    expect(r.status).toBe(403);
  });

  it("migrates a v0 object lazily on its first read", async () => {
    const pin = { product: "wd", subject: "sub_v0" };
    const stub = env.CLOUD_SYNC.get(
      env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)),
    );
    // A v0 object: a meta table, no version row, nothing else.
    await runInDurableObject(stub, async (_obj, state) => {
      state.storage.sql.exec(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
      );
    });
    const usage = await callCloudSync<"usage">(env, pin, { op: "usage" });
    expect(usage.empty).toBe(true);
    const version = await runInDurableObject(
      stub,
      async (_obj, state) =>
        state.storage.sql
          .exec("SELECT value FROM meta WHERE key = 'schema_version'")
          .one().value,
    );
    expect(version).toBe("3");
  });

  it("deleteAll clears the data and the alarm, and the object can be written again", async () => {
    const pin = { product: "wd", subject: "sub_delete" };
    await pushTo(pin, "gone");
    const stub = env.CLOUD_SYNC.get(
      env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)),
    );
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.setAlarm(Date.now() + 3_600_000);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await callCloudSync<"deleteAll">(env, pin, { op: "deleteAll" });
    // U-19.2: the erasure leaves a marker with a cleanup alarm a day out, and the marker refuses a
    // push that was already on its way.
    await runInDurableObject(stub, async (_obj, state) => {
      const due = await state.storage.getAlarm();
      expect(due).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect(due).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    });
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
    await expect(pushTo(pin, "again")).rejects.toMatchObject({
      status: 410,
      code: "absorbed",
    });
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
  });
});

describe("account-merge absorb under workerd (U-05.8)", () => {
  it("absorbs an export into a never-written survivor, is idempotent, and deletes the source only while unchanged", async () => {
    const from = { product: "wd", subject: "sub_from" };
    const to = { product: "wd", subject: "sub_to" };
    await pushTo(from, "theme");
    const doc = (await exportCloudSync(env, from))!;
    expect(await absorbCloudSync(env, to, doc)).toBeGreaterThan(0);
    // The same export again changes nothing (no new sequence number).
    const seq = (await callCloudSync<"usage">(env, to, { op: "usage" })).seq;
    expect(await absorbCloudSync(env, to, doc)).toBe(0);
    expect((await callCloudSync<"usage">(env, to, { op: "usage" })).seq).toBe(
      seq,
    );
    const mine = (await exportCloudSync(env, to))!;
    expect(mine.settings.map((r) => r.key)).toEqual(["theme"]);
    // A stale sequence keeps the source; the current one deletes it.
    expect(
      await deleteCloudSyncIfUnchanged(
        env,
        from,
        { seq: doc.seq + 1, writes: doc.writes },
        to.subject,
      ),
    ).toBe(false);
    expect(
      await deleteCloudSyncIfUnchanged(
        env,
        from,
        { seq: doc.seq, writes: doc.writes + 1 },
        to.subject,
      ),
    ).toBe(false);
    expect(await exportCloudSync(env, from)).not.toBeNull();
    expect(
      await deleteCloudSyncIfUnchanged(
        env,
        from,
        { seq: doc.seq, writes: doc.writes },
        to.subject,
      ),
    ).toBe(true);
    expect(await exportCloudSync(env, from)).toBeNull();
    // The absorbed object is marked: a later push is a 410 absorbed, on real storage.
    await expect(pushTo(from, "late")).rejects.toMatchObject({
      status: 410,
      code: "absorbed",
    });
    // The marker's cleanup alarm is set, a day out, on real storage.
    const stub = env.CLOUD_SYNC.get(
      env.CLOUD_SYNC.idFromName(cloudSyncObjectName(from)),
    );
    const due = await runInDurableObject(stub, (_o, st) =>
      st.storage.getAlarm(),
    );
    expect(due).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    // An erasure replaces the merge marker with the erasure marker (U-19.2): no data, and writes
    // stay refused for the day.
    await callCloudSync<"deleteAll">(env, from, { op: "deleteAll" });
    await expect(pushTo(from, "again")).rejects.toMatchObject({
      status: 410,
      code: "absorbed",
    });
  });
});

describe("atomic batches and incremental merge writes under workerd (SR-1)", () => {
  it("an atomic batch with one refusal rolls the nested savepoint back whole and leaves a clean round trip", async () => {
    const pin = { product: "wd", subject: "sub_atomic" };
    await pushTo(pin, "kept");
    const before = await callCloudSync<"usage">(env, pin, { op: "usage" });
    const r = await callCloudSync<"push">(env, pin, {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000 },
      request: {
        clientId: C1,
        cursor: 0,
        atomic: true,
        mutations: [set(2, "first", "x"), set(3, "second", "y")],
      },
      classified: [
        LAST_WRITE,
        { verdict: "reject", code: "setting_not_synced" },
      ],
      serverNow: NOW,
    });
    const outcome = r.outcome as {
      ok: true;
      results: { status: string }[];
    };
    expect(outcome.results.map((x) => x.status)).toEqual([
      "aborted",
      "rejected",
    ]);
    const after = await callCloudSync<"usage">(env, pin, { op: "usage" });
    expect(after.seq).toBe(before.seq);
    expect(after.usage).toEqual(before.usage);
    const doc = (await exportCloudSync(env, pin))!;
    expect(doc.settings.map((x) => x.key)).toEqual(["kept"]);
    // The object still takes the next write (the savepoint stack is clean).
    const next = await callCloudSync<"push">(env, pin, {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000 },
      request: {
        clientId: C1,
        cursor: 0,
        atomic: true,
        mutations: [set(4, "first", "x")],
      },
      classified: [LAST_WRITE],
      serverNow: NOW,
    });
    expect(
      (next.outcome as { results: { status: string }[] }).results[0]?.status,
    ).toBe("ok");
  });

  it("a member update on a wide merge row upserts in place: the cell keeps its place and the others are untouched", async () => {
    const pin = { product: "wd", subject: "sub_wide" };
    const MERGE: Classification = {
      verdict: "accept",
      scope: "user",
      policy: "merge",
    };
    const member = (id: number, name: string) => ({
      mutationId: id,
      target: { setting: "tags", scope: "user" as const },
      op: "setMember" as const,
      member: name,
      value: id,
      editedHlc: formatHlc(NOW - 1000, id),
    });
    for (let b = 0; b < 2; b++) {
      const muts = Array.from({ length: 100 }, (_, i) =>
        member(b * 100 + i + 1, `m${b * 100 + i}`),
      );
      await callCloudSync<"push">(env, pin, {
        op: "push",
        deviceId: "d1",
        family: "desktop",
        limits: { quotaBytes: 1_000_000 },
        request: { clientId: C1, cursor: 0, mutations: muts },
        classified: muts.map(() => MERGE),
        serverNow: NOW,
      });
    }
    await callCloudSync<"push">(env, pin, {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000 },
      request: { clientId: C1, cursor: 0, mutations: [member(201, "m0")] },
      classified: [MERGE],
      serverNow: NOW,
    });
    const doc = (await exportCloudSync(env, pin))!;
    const row = doc.settings.find((x) => x.key === "tags")!;
    expect(row.members).toHaveLength(200);
    expect(row.members![0]![0]).toBe("m0");
    expect(row.members![0]![1].value).toBe(201);
  });
});

describe("directory flush alarm under workerd (U-05.9)", () => {
  const stubOf = (pin: { product: string; subject: string }) =>
    env.CLOUD_SYNC.get(env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)));
  const rowOf = (pin: { product: string; subject: string }) =>
    env.DB.prepare(
      "SELECT bytes, settings, platform, quota_bytes FROM sync_directory WHERE product = ? AND subject = ?",
    )
      .bind(pin.product, pin.subject)
      .first<{ bytes: number; settings: number; platform: string }>();

  it("the first write flushes at once: the directory row and the day's counters reach real D1 with no trigger", async () => {
    // The flush writes for a live product only.
    await seedProduct(env, new D1Db(env.DB), "wdalarm", {
      schemaVersion: 1,
      entries: [],
    });
    const pin = { product: "wdalarm", subject: "sub_first" };
    await pushTo(pin, "theme");
    // The alarm was set for now; the runtime delivers it by itself (no trigger from here).
    await vi.waitFor(async () => expect(await rowOf(pin)).not.toBeNull(), {
      timeout: 5000,
    });
    expect(await rowOf(pin)).toMatchObject({
      settings: 1,
      platform: "macos",
    });
    const daily = await env.DB.prepare(
      "SELECT syncs FROM sync_product_daily WHERE product = ?",
    )
      .bind(pin.product)
      .first<{ syncs: number }>();
    expect(daily?.syncs).toBe(1);
    // Clean now: nothing is scheduled and nothing runs.
    expect(await runDurableObjectAlarm(stubOf(pin))).toBe(false);
  });

  it("an alarm that follows deleteAll recreates no row and no storage", async () => {
    const pin = { product: "wdalarm", subject: "sub_gone" };
    await pushTo(pin, "theme");
    const stub = stubOf(pin);
    await callCloudSync<"deleteAll">(env, pin, { op: "deleteAll" });
    // The flush may have run before the erasure; the subject store removes its row after the
    // object (subjectStore.ts), so clear it the same way, then no alarm may bring it back.
    await env.DB.prepare(
      "DELETE FROM sync_directory WHERE product = ? AND subject = ?",
    )
      .bind(pin.product, pin.subject)
      .run();
    // The erasure marker's own alarm (a day out) may run; it must not bring the row or the data back.
    await runDurableObjectAlarm(stub);
    expect(await rowOf(pin)).toBeNull();
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
  });

  it("an object whose product was erased erases itself at its alarm (SR-2 B2)", async () => {
    await seedProduct(env, new D1Db(env.DB), "wdgone", {
      schemaVersion: 1,
      entries: [],
    });
    const pin = { product: "wdgone", subject: "sub_orphan" };
    await pushTo(pin, "theme");
    await env.DB.prepare(
      "UPDATE products SET status = 'deleted' WHERE slug = ?",
    )
      .bind(pin.product)
      .run();
    // Whichever alarm delivery sees the deleted product, the object ends empty and silent.
    await vi.waitFor(
      async () =>
        expect(
          (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
        ).toBe(true),
      { timeout: 5000 },
    );
    expect(await rowOf(pin)).toBeNull();
    expect(await runDurableObjectAlarm(stubOf(pin))).toBe(false);
  });
});

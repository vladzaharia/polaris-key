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
import { describe, expect, it, vi } from "vitest";
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

const pushTo = (pin: { product: string; subject: string }, key: string) =>
  callCloudSync<"push">(env, pin, {
    op: "push",
    deviceId: "d1",
    family: "desktop",
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
    const pulled = await callCloudSync<"pull">(env, pin, {
      op: "pull",
      cursor: 0,
      deviceId: "d1",
      family: "desktop",
      clientId: C1,
    });
    expect(JSON.stringify(pulled.outcome)).toContain("theme");
    const usage = await callCloudSync<"usage">(env, pin, { op: "usage" });
    expect(usage.empty).toBe(false);
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
    expect(version).toBe("2");
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
    await runInDurableObject(stub, async (_obj, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
    await pushTo(pin, "again");
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(false);
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
    // An erasure removes the marker.
    await callCloudSync<"deleteAll">(env, from, { op: "deleteAll" });
    expect((await pushTo(from, "again")).outcome.ok).toBe(true);
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
      platform: "desktop",
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
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(await rowOf(pin)).toBeNull();
    expect(
      (await callCloudSync<"usage">(env, pin, { op: "usage" })).empty,
    ).toBe(true);
  });
});

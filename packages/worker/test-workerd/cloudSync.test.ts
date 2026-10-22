/**
 * U-05.7: the real `CloudSyncDO` class under workerd, bound from wrangler.toml's `CLOUD_SYNC`
 * (migration tag v4, SQLite-backed). The Node lane proves the engine and the object over a
 * better-sqlite3 mock; this proves the part that mock cannot: the real `SqlStorage`, the real
 * `transactionSync`, `deleteAll` and the alarm accessors.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  callCloudSync,
  cloudSyncObjectName,
} from "../src/services/sync/do/client.js";
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
    expect(version).toBe("1");
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

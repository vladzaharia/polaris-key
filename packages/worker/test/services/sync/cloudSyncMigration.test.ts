/**
 * U-05.3's `0131_cloud_sync_directory.sql` and `0132_cloud_sync_daily.sql` (numbers are the lead's
 * to assign), rehearsed on a scratch SQLite: every earlier migration, a populated fixture, then the
 * files statement by statement and in one transaction, a replay, and the down scripts. Also the
 * `sync.cloudSync` subject store over the directory row.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../../../src/index.js";
import {
  runSubjectMerge,
  runSubjectDelete,
  subjectStores,
} from "../../../src/core/accounts/subjectHooks.js";
import { CLOUD_SYNC_STORE } from "../../../src/services/sync/subjectStore.js";
import { TABLE_OWNERS } from "../../../src/db/owners.js";
import { makeTestDb } from "../../helpers.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "../../cloudSyncDoMock.js";
import { callCloudSync } from "../../../src/services/sync/do/client.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { TEST_ROOT } from "../../paths.js";

let lastNs: CloudSyncNamespaceMock;
/** An Env with the Cloud Sync namespace over the real class (the Node mock). */
function envWith(): { CLOUD_SYNC: DurableObjectNamespace } {
  lastNs = new CloudSyncNamespaceMock();
  return { CLOUD_SYNC: asCloudSyncNamespace(lastNs) };
}
/** Write one setting into the person's object. */
async function seedObject(
  env: { CLOUD_SYNC: DurableObjectNamespace },
  subject: string,
) {
  await callCloudSync<"push">(
    env,
    { product: "acme", subject },
    {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000_000 },
      request: {
        clientId: "c_000000000000000client1",
        cursor: 0,
        mutations: [
          {
            mutationId: 1,
            target: { setting: "theme", scope: "user" },
            op: "set",
            value: "dark",
            editedHlc: formatHlc(Date.now() - 1000, 0),
          },
        ],
      },
      classified: [{ verdict: "accept", scope: "user", policy: "lastWrite" }],
      serverNow: Date.now(),
    },
  );
}

const ROOT = join(TEST_ROOT, "..");
const DIR = join(ROOT, "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const DIRECTORY = FILES.find((f) => /_cloud_sync_directory\.sql$/.test(f))!;
const DAILY = FILES.find((f) => /_cloud_sync_daily\.sql$/.test(f))!;
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const down = (f: string) =>
  readFileSync(
    join(ROOT, "scripts", "rollback", f.replace(/\.sql$/, ".down.sql")),
    "utf8",
  );
const NEW = ["sync_directory", "sync_product_usage", "sync_product_daily"];
const split = (s: string) =>
  s
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f === DIRECTORY) break;
    raw.exec(sql(f));
  }
  raw
    .prepare(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('acme', 'acme', 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, 1, 1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO product_sync_state (product, source, status, last_checked_at, last_synced_at, message)
       VALUES ('acme', 'webhook', 'ok', 1, 1, 'kept')`,
    )
    .run();
  return raw;
}
const master = (raw: Database.Database) =>
  raw
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all();
const upFiles = [DIRECTORY, DAILY];

describe("cloud sync migrations", () => {
  it("apply statement by statement, replay, and leave existing rows alone", () => {
    const raw = before();
    const pre = master(raw);
    for (const f of upFiles) for (const st of split(sql(f))) raw.exec(st);
    const once = master(raw);
    for (const f of upFiles) raw.exec(sql(f)); // replay: every statement is IF NOT EXISTS
    expect(master(raw)).toEqual(once);
    const names = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of NEW) expect(names).toContain(t);
    expect(raw.prepare("SELECT message FROM product_sync_state").all()).toEqual(
      [{ message: "kept" }],
    );
    expect(pre.length).toBeLessThan(once.length);
  });

  it("apply in one transaction", () => {
    const raw = before();
    raw.exec("BEGIN");
    for (const f of upFiles) raw.exec(sql(f));
    raw.exec("COMMIT");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keys are (product, subject), (product) and (product, day), with no foreign keys", () => {
    const raw = before();
    for (const f of upFiles) raw.exec(sql(f));
    const pk = (t: string) =>
      (raw.prepare(`PRAGMA table_info(${t})`).all() as any[])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(pk("sync_directory")).toEqual(["product", "subject"]);
    expect(pk("sync_product_usage")).toEqual(["product"]);
    expect(pk("sync_product_daily")).toEqual(["product", "day"]);
    for (const t of NEW)
      expect(raw.prepare(`PRAGMA foreign_key_list(${t})`).all()).toEqual([]);
  });

  it("the down scripts restore sqlite_master exactly, and run twice", () => {
    const raw = before();
    const pre = master(raw);
    for (const f of upFiles) raw.exec(sql(f));
    for (const f of [...upFiles].reverse()) {
      raw.exec(down(f));
      raw.exec(down(f));
    }
    expect(master(raw)).toEqual(pre);
  });

  it("owns all three tables as `sync`", () => {
    expect([...TABLE_OWNERS.sync!].sort()).toEqual([...NEW].sort());
  });
});

describe("sync.cloudSync subject store", () => {
  const put = (db: any, subject: string, o: Record<string, unknown>) =>
    db.run(
      `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
         quota_bytes, tier_id, platform, last_active_at, updated_at)
       VALUES ('acme', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 1)`,
      subject,
      o.bytes,
      o.settings,
      o.rev ?? 0,
      o.quota ?? 0,
      o.tier ?? null,
      o.platform ?? null,
      o.at,
    );

  it("is registered and claims sync_directory and the Durable Object", () => {
    const s = subjectStores().find(([n]) => n === CLOUD_SYNC_STORE)![1];
    expect(s.tables).toEqual(["sync_directory"]);
    expect(s.durableObjects).toEqual(["CloudSyncDO"]);
  });

  it("merge absorbs the object into the survivor's, then merges the directory rows (U-05.8)", async () => {
    const db = makeTestDb();
    const env = envWith();
    await put(db, "from", { bytes: 10, settings: 1, at: 9 });
    await seedObject(env, "from");
    await runSubjectMerge(
      { db, env: env as any, now: 1 },
      { product: "acme", from: "from", to: "to" },
    );
    expect(await db.all<any>("SELECT subject FROM sync_directory")).toEqual([
      { subject: "to" },
    ]);
    expect(
      lastNs
        .instance("acme:to")
        .storage.sql.db.prepare("SELECT key FROM settings")
        .all(),
    ).toEqual([{ key: "theme" }]);
  });

  it("delete clears the object and its alarm, export carries its settings, and a stranger's object is untouched", async () => {
    const db = makeTestDb();
    const env = envWith();
    const store = subjectStores().find(([n]) => n === CLOUD_SYNC_STORE)![1];
    const ctx = { db, env: env as any, now: 1 };
    await seedObject(env, "a");
    await seedObject(env, "b");
    const dump = (await store.export!(ctx, {
      product: "acme",
      subject: "a",
    })) as any;
    expect(dump.settings.subject).toBe("a");
    expect(dump.settings.settings.map((r: any) => r.key)).toEqual(["theme"]);
    await lastNs.instance("acme:a").storage.setAlarm(Date.now() + 1000);
    await runSubjectDelete(ctx, { product: "acme", subject: "a" });
    expect(await lastNs.instance("acme:a").storage.getAlarm()).toBeNull();
    const after = (await store.export!(ctx, {
      product: "acme",
      subject: "a",
    })) as any;
    expect(after.settings).toBeNull();
    const other = (await store.export!(ctx, {
      product: "acme",
      subject: "b",
    })) as any;
    expect(other.settings.settings).toHaveLength(1);
  });

  it("names the object by product and subject only, and the object refuses another pair", async () => {
    const env = envWith();
    await seedObject(env, "a");
    expect([...lastNs.instances.keys()]).toEqual(["acme:a"]);
    await expect(
      callCloudSync<"usage">(
        env,
        { product: "acme", subject: "a" },
        { op: "usage" },
      ),
    ).resolves.toMatchObject({ empty: false });
    // Same object, wrong pair in the body: the pin answers 403.
    const stub = asCloudSyncNamespace(lastNs).get(lastNs.idFromName("acme:a"));
    const r = await stub.fetch("https://do/", {
      method: "POST",
      body: JSON.stringify({ op: "usage", product: "acme", subject: "b" }),
    });
    expect(r.status).toBe(403);
  });

  it("an unbound namespace is a 503, not a silent skip", async () => {
    await expect(
      callCloudSync<"usage">(
        {} as any,
        { product: "acme", subject: "a" },
        { op: "usage" },
      ),
    ).rejects.toMatchObject({ status: 503, code: "unbound" });
  });

  it("merge sums the counters, keeps the later platform, deletes the absorbed row, and is idempotent", async () => {
    const db = makeTestDb();
    const ctx = { db, env: envWith() as any, now: 500 };
    await put(db, "from", {
      bytes: 10,
      settings: 2,
      rev: 4,
      quota: 100,
      tier: "pro",
      platform: "ios",
      at: 90,
    });
    await put(db, "to", {
      bytes: 5,
      settings: 1,
      quota: 50,
      tier: "free",
      platform: "web",
      at: 40,
    });
    const args = { product: "acme", from: "from", to: "to" };
    await runSubjectMerge(ctx, args);
    await runSubjectMerge(ctx, args);
    const rows = await db.all<any>(
      "SELECT * FROM sync_directory ORDER BY subject",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: "to",
      bytes: 15,
      settings: 3,
      revision_bytes: 4,
      quota_bytes: 100,
      tier_id: "pro",
      platform: "ios",
      last_active_at: 90,
      updated_at: 500,
    });
  });

  it("merge re-keys when the survivor has no row", async () => {
    const db = makeTestDb();
    await put(db, "from", { bytes: 7, settings: 1, platform: "mac", at: 9 });
    await runSubjectMerge(
      { db, env: envWith() as any, now: 1 },
      { product: "acme", from: "from", to: "to" },
    );
    expect(
      await db.all<any>("SELECT subject, bytes FROM sync_directory"),
    ).toEqual([{ subject: "to", bytes: 7 }]);
  });

  it("delete, export and size are per (product, subject)", async () => {
    const db = makeTestDb();
    const ctx = { db, env: envWith() as any, now: 1 };
    await put(db, "a", { bytes: 10, settings: 1, rev: 3, at: 1 });
    await put(db, "b", { bytes: 99, settings: 1, at: 1 });
    const store = subjectStores().find(([n]) => n === CLOUD_SYNC_STORE)![1];
    expect(await store.size!(ctx, { product: "acme", subject: "a" })).toBe(13);
    expect(
      (await store.export!(ctx, { product: "acme", subject: "a" })) as any,
    ).toMatchObject({
      directory: { bytes: 10, revisionBytes: 3 },
    });
    await runSubjectDelete(ctx, { product: "acme", subject: "a" });
    expect(await db.all<any>("SELECT subject FROM sync_directory")).toEqual([
      { subject: "b" },
    ]);
    expect(
      (await store.export!(ctx, { product: "acme", subject: "a" })) as any,
    ).toEqual({ settings: null, directory: null });
  });
});

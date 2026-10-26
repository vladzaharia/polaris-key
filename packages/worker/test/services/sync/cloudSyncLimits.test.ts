/**
 * U-05.14: the push limits and the users ceiling (`services/sync/limits.ts`).
 *
 * Driven through the real `dispatch` pipeline and the real `CloudSyncDO` class over a
 * better-sqlite3 `SqlStorage` mock. A scripted namespace stands in for the object where a test
 * needs an answer the real one gives only in a race (`absorbed`) or needs to see what the Worker
 * sent (the limits).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type {
  MutationResult,
  PushResponse,
  SyncJson,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "../../cloudSyncDoMock.js";
import { dispatch } from "../../../src/dispatch.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { serializeServices } from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeWebOrigins } from "../../../src/core/cors.js";
import { loadProduct } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import {
  SYNC_LIMITER_SHARDS,
  syncLimiterShard,
} from "../../../src/services/sync/limits.js";
import { recordLimiterChecks } from "../../rlMock.js";
import { syncProductPurge } from "../../../src/services/sync/productDeletion.js";
import { productIsPurging } from "../../../src/services/sync/purgeFlag.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import {
  callCloudSync,
  deleteCloudSync,
} from "../../../src/services/sync/do/client.js";
import { SYNC_MAX_SETTINGS } from "@polaris-key/protocol/sync";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const LISTED = "https://play.djdl.example";
const DEVICE = "dev-push-1";
const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";

const entry = (key: string, schema: unknown, extra: object = {}) => ({
  key,
  kind: "config",
  category: "test",
  label: key,
  description: key,
  schema,
  ...extra,
});

const CATALOG = {
  schemaVersion: 2,
  entries: [
    entry("audio.volume", { type: "number", minimum: 0, maximum: 1 }),
    entry("ui.theme", { type: "string", enum: ["dark", "light"] }),
    entry("video.quality", { type: "string" }, { user: { sync: "platform" } }),
    entry("game.best", { type: "number" }, { user: { conflict: "max" } }),
    entry(
      "ui.flags",
      {
        type: "object",
        properties: { a: { type: "boolean" } },
        additionalProperties: false,
      },
      { user: { conflict: "merge" } },
    ),
    entry("local.cache", { type: "string" }, { user: { sync: "local" } }),
    entry("locked.mode", { type: "string" }, { managementDefault: "enforced" }),
    entry("hidden.mode", { type: "string" }, { managementDefault: "hidden" }),
    entry("api.token", { type: "string" }, { kind: "secret" }),
    entry("feature.beta", { type: "boolean" }, { kind: "flag" }),
    entry("audio.gain", { type: "number" }),
  ],
  cloudSync: {
    migrations: [
      {
        toSchemaVersion: 2,
        rename: { "old.vol": "audio.volume" },
        drop: ["gone.key"],
      },
    ],
  },
};

interface World {
  db: Db;
  env: Env;
  ns: CloudSyncNamespaceMock;
  kv: KvMock;
  token: string;
  subject: string;
}

async function enable(db: Db, over: { sync?: boolean } = {}): Promise<void> {
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: over.sync ?? true },
        commerce: { enabled: false },
        connect: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

async function world(opts: { signedIn?: boolean } = {}): Promise<World> {
  const db = makeTestDb();
  const ns = new CloudSyncNamespaceMock();
  const kv = new KvMock();
  const env = makeEnv(kv, []);
  env.CLOUD_SYNC = asCloudSyncNamespace(ns);
  await seedProduct(db, SLUG, { catalog: CATALOG });
  await enable(db);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    serializeWebOrigins([LISTED]),
    SLUG,
  );
  const { key } = await seedLicenseWithKey(db, SLUG);
  const product = (await loadProduct(env, db, SLUG))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": DEVICE }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token: string }).token;
  let subject = "";
  if (opts.signedIn !== false) {
    const r = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (r.status !== "signed_in") throw new Error(r.status);
    subject = r.subject!;
    expect(await setDeviceSubject(env, db, SLUG, DEVICE, subject)).toBe(true);
  }
  return { db, env, ns, kv, token, subject };
}

const authed = (w: World, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${w.token}`,
  "x-pkey-device": DEVICE,
  ...extra,
});

function send(
  w: Pick<World, "db" | "env">,
  body: unknown,
  headers: Record<string, string>,
  path = `/${SLUG}/sync/ops`,
  method = "POST",
) {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(method === "POST"
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    }) as unknown as Request,
    w.env,
    w.db,
  );
}

let mid = 1;
const hlc = formatHlc(NOW * 1000 - 1000, 0);
const mut = (
  key: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
  scope: "user" | "platform" = "user",
): SyncMutation => ({
  mutationId: mid++,
  target: { setting: key, scope },
  op,
  editedHlc: hlc,
  ...extra,
});
const set = (
  key: string,
  value: SyncJson,
  scope: "user" | "platform" = "user",
) => mut(key, "set", { value }, scope);

const batch = (mutations: SyncMutation[], extra: object = {}) => ({
  clientId: CLIENT,
  cursor: 0,
  mutations,
  ...extra,
});

async function push(
  w: World,
  mutations: SyncMutation[],
  extra: object = {},
  headers: Record<string, string> = {},
) {
  return send(w, batch(mutations, extra), authed(w, headers));
}

const resultsOf = async (res: Response): Promise<MutationResult[]> => {
  expect(res.status).toBe(200);
  return ((await res.json()) as PushResponse).results;
};

afterEach(() => vi.useRealTimers());

/** Pin `Date.now()` (the pipeline's clock) so the fixed windows do not straddle a boundary. */
const pin = (): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
};

const errorBody = async (res: Response) =>
  (await res.json()) as { error: { code: string } };

const setUsers = (w: World, users: number) =>
  w.db.run(
    `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
     VALUES (?, 0, ?, 0, 0, 0, 0, '{}', 1)`,
    SLUG,
    users,
  );

describe("Cloud Sync push limits: the shards", () => {
  it("names eight objects by subject hash and spreads subjects over all of them", () => {
    const names = new Set<string>();
    for (let i = 0; i < 400; i++)
      names.add(syncLimiterShard("djdl", `subject-${i}`));
    expect(names.size).toBe(SYNC_LIMITER_SHARDS);
    for (const n of names) expect(n).toMatch(/^sync:product:djdl:[0-7]$/);
    expect(syncLimiterShard("djdl", "s1")).toBe(syncLimiterShard("djdl", "s1"));
  });

  it("a push charges both buckets in the caller's shard", async () => {
    const w = await world();
    pin();
    const checks = recordLimiterChecks(w.env);
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    expect(checks.map((c) => c.bucket)).toEqual([
      "syncPushDevice",
      "syncPushProduct",
    ]);
    expect(checks[0]).toMatchObject({ id: DEVICE, limit: 60, windowSec: 60 });
    expect(checks[1]).toMatchObject({ id: SLUG, limit: 250, windowSec: 1 });
  });
});

describe("Cloud Sync push limits: 429 rate_limited", () => {
  it("the 61st push of a minute from one device is 429 with Retry-After, and costs the object nothing", async () => {
    const w = await world();
    pin();
    for (let i = 0; i < 60; i++)
      expect((await push(w, [set("audio.gain", i)])).status).toBe(200);
    const objectCalls = w.ns.calls?.length;
    const res = await push(w, [set("audio.gain", 99)]);
    expect(res.status).toBe(429);
    expect((await errorBody(res)).error.code).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe(String(60 - (NOW % 60)));
    if (objectCalls !== undefined) expect(w.ns.calls?.length).toBe(objectCalls);
    // The next window is open again.
    vi.setSystemTime((NOW + 60) * 1000);
    expect((await push(w, [set("audio.gain", 100)])).status).toBe(200);
  });

  it("the product limit answers 429 with Retry-After 1 and does not spend the device's budget", async () => {
    const w = await world();
    pin();
    // Fill the product bucket in this subject's shard: 250 a second.
    const { rateLimitOk } = await import("../../../src/core/rateLimit.js");
    const shard = syncLimiterShard(SLUG, w.subject);
    for (let i = 0; i < 250; i++)
      expect(
        await rateLimitOk(
          w.env,
          shard,
          { bucket: "syncPushProduct", id: SLUG, limit: 250, windowSec: 1 },
          NOW,
        ),
      ).toBe(true);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await errorBody(res)).error.code).toBe("rate_limited");
    // The next second is open.
    vi.setSystemTime((NOW + 1) * 1000);
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
  });

  it("limiter down: both buckets fail open (L10) and the push goes through", async () => {
    const w = await world();
    pin();
    w.env.RL = {
      idFromName: (n: string) => ({ name: n }) as unknown as DurableObjectId,
      get: () => ({
        fetch: () => Promise.reject(new Error("Durable Object reset")),
      }),
    } as unknown as DurableObjectNamespace;
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(200);
  });

  it("a limiter answering 500 also fails open", async () => {
    const w = await world();
    pin();
    w.env.RL = {
      idFromName: (n: string) => ({ name: n }) as unknown as DurableObjectId,
      get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
  });
});

describe("Cloud Sync push: the users ceiling", () => {
  it("at 100,000 users an object that never held data is refused growth (product scope)", async () => {
    const w = await world();
    pin();
    await setUsers(w, 100_000);
    const results = await resultsOf(await push(w, [set("audio.gain", 1)]));
    expect(results[0]).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "product",
    });
  });

  it("an object that already holds data keeps writing", async () => {
    const w = await world();
    pin();
    expect(
      (await resultsOf(await push(w, [set("audio.gain", 1)])))[0]!.status,
    ).toBe("ok");
    await setUsers(w, 100_000);
    expect(
      (await resultsOf(await push(w, [set("audio.gain", 2)])))[0]!.status,
    ).toBe("ok");
    expect(
      (await resultsOf(await push(w, [set("ui.theme", "dark")])))[0]!.status,
    ).toBe("ok");
  });

  it("under the ceiling a new object writes", async () => {
    const w = await world();
    pin();
    await setUsers(w, 99_999);
    expect(
      (await resultsOf(await push(w, [set("audio.gain", 1)])))[0]!.status,
    ).toBe("ok");
  });
});

const objectCount = (w: World, table: string, where = "1 = 1"): number => {
  const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
  if (!inst) return 0;
  return (
    inst.storage.sql.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .get() as { n: number }
  ).n;
};

describe("Cloud Sync abuse bounds", () => {
  it("clearing names the store never held writes no row, however many a device sends", async () => {
    const w = await world();
    pin();
    for (let b = 0; b < 4; b++) {
      const res = await push(
        w,
        Array.from({ length: 100 }, (_, i) => mut(`junk.${b}.${i}`, "clear")),
      );
      expect(res.status).toBe(200);
    }
    expect(objectCount(w, "tombstones")).toBeLessThanOrEqual(SYNC_MAX_SETTINGS);
    expect(objectCount(w, "tombstones")).toBe(0);
  });

  it("an empty batch from a fresh clientId adds no client binding", async () => {
    const w = await world();
    pin();
    for (let i = 0; i < 30; i++) {
      const id = `c_${String(i).padStart(22, "A")}`;
      expect((await push(w, [], { clientId: id })).status).toBe(200);
    }
    expect(objectCount(w, "clients")).toBe(0);
  });

  it("a new person at the users ceiling cannot grow after a clear-only push", async () => {
    const w = await world();
    pin();
    await setUsers(w, 100_000);
    const first = await resultsOf(await push(w, [set("audio.gain", 1)]));
    expect(first[0]!.status).toBe("rejected");
    expect((await push(w, [mut("x.y", "clear")])).status).toBe(200);
    // A declared key's clear keeps its tombstone; the person is still new.
    expect((await push(w, [mut("audio.gain", "clear")])).status).toBe(200);
    const again = await resultsOf(await push(w, [set("audio.gain", 1)]));
    expect(again[0]!.status).toBe("rejected");
  });

  it("a push between the purge finishing and the product row flipping is refused", async () => {
    const w = await world();
    pin();
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    const done = await syncProductPurge({
      db: w.db,
      env: w.env,
      product: SLUG,
      now: NOW,
    });
    expect(done.done).toBe(true);
    expect(await productIsPurging(w.env, SLUG)).toBe(true);
    expect((await push(w, [set("audio.volume", 0.5)])).status).toBe(404);
    await deleteProduct(w.db, SLUG, NOW);
    expect(objectCount(w, "settings", "key = 'audio.volume'")).toBe(0);
  });

  it("the pull answers 429 to a device that pulls more than 120 times a minute", async () => {
    const w = await world();
    pin();
    const path = `/${SLUG}/sync`;
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++)
      statuses.push((await send(w, null, authed(w), path, "GET")).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    const limited = await send(w, null, authed(w), path, "GET");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(60 - (NOW % 60)));
  });

  it("refuses a push that was in flight when the person's object was erased", async () => {
    const w = await world();
    pin();
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    const pinned = { product: SLUG, subject: w.subject };
    await deleteCloudSync(w.env, pinned);
    await expect(
      callCloudSync<"push">(w.env, pinned, {
        op: "push",
        deviceId: DEVICE,
        family: "desktop",
        limits: { quotaBytes: 1 << 20 },
        request: {
          clientId: CLIENT,
          cursor: 0,
          mutations: [set("audio.gain", 2)],
        },
        classified: [{ verdict: "accept", scope: "user", policy: "lastWrite" }],
        serverNow: NOW * 1000,
      }),
    ).rejects.toMatchObject({ status: 410, code: "absorbed" });
    expect(objectCount(w, "settings")).toBe(0);
  });
});

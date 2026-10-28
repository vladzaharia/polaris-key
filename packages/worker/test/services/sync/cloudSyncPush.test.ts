/**
 * U-05.13: `POST /<p>/sync/ops`, the Cloud Sync push (WIRE-CONTRACT-V4 §13.1, §13.3).
 *
 * Driven through the real `dispatch` pipeline and the real `CloudSyncDO` class over a
 * better-sqlite3 `SqlStorage` mock. A scripted namespace stands in for the object where a test
 * needs an answer the real one gives only in a race (`absorbed`) or needs to see what the Worker
 * sent (the limits).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type {
  MutationResult,
  PushResponse,
  SyncJson,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import { makeTestDb, NO_HOOKS } from "../../helpers.js";
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
import { loadProduct, type Product } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { purgeProductData } from "../../../src/core/contributions.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { callCloudSync } from "../../../src/services/sync/do/client.js";
import { handlePush } from "../../../src/services/sync/handlers/push.js";
import { syncProductPurge } from "../../../src/services/sync/productDeletion.js";
import {
  markProductPurging,
  productIsPurging,
} from "../../../src/services/sync/purgeFlag.js";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const LISTED = "https://play.djdl.example";
const UNLISTED = "https://evil.example";
const DEVICE = "dev-push-1";
const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_CLIENT = "c_BBBBBBBBBBBBBBBBBBBBBB";

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
    // These tests drive the server-mode wire (`value`); E2E has its own (cloudSyncE2e.test.ts).
    encryption: "server",
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
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe("POST /<p>/sync/ops: classification", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("classifies every branch of the catalog", async () => {
    const m = [
      set("audio.volume", 0.5), // synced, valid
      set("audio.volume", 7), // synced, against its entry
      set("ui.theme", "dark"),
      set("ui.theme", "blue"),
      set("video.quality", "high", "platform"), // synced at platform
      set("video.quality", "high", "user"), // wrong scope
      set("game.best", 12), // max
      mut("ui.flags", "setMember", { member: "a", value: true }),
      mut("ui.flags", "setMember", { member: "a", value: "yes" }),
      mut("ui.flags", "setMember", { member: "b", value: true }),
      set("local.cache", "x"), // local
      set("locked.mode", "x"), // locked
      set("hidden.mode", "x"), // hidden
      set("api.token", "x"), // secret
      set("feature.beta", true), // flag
      set("open.setting", { n: 1 }), // open
      set("open.platform", 1, "platform"), // open, wrong scope
      mut("open.members", "setMember", { member: "a", value: 1 }), // open is lastWrite
      set("open.big", "x".repeat(8191)), // 8193 bytes
      set("open.edge", "x".repeat(8190)), // 8192 bytes
      set("__proto__", 1), // open, just data
      set("old.vol", 0.2), // renamed
      set("gone.key", 1), // dropped
      {
        mutationId: mid++,
        target: { record: ["saves", "slot1"] as [string, string] },
        op: "set" as const,
        value: {},
      },
    ];
    const results = await resultsOf(await push(w, m));
    const by = (i: number) => {
      const r = results[i]!;
      return r.status === "rejected"
        ? `rejected:${r.code}`
        : r.status === "ok" && "renamedTo" in r && r.renamedTo
          ? `ok:renamedTo:${r.renamedTo}`
          : r.status === "ok" && "dropped" in r && r.dropped
            ? "ok:dropped"
            : r.status;
    };
    expect(m.map((_, i) => by(i))).toEqual([
      "ok",
      "rejected:value_invalid",
      "ok",
      "rejected:value_invalid",
      "ok",
      "rejected:setting_not_synced",
      "ok",
      "ok",
      "rejected:value_invalid",
      "rejected:value_invalid",
      "rejected:setting_not_synced",
      "rejected:setting_not_synced",
      "rejected:setting_not_synced",
      "rejected:setting_not_synced",
      "rejected:setting_not_synced",
      "ok",
      "rejected:setting_not_synced",
      "rejected:op_invalid_for_policy",
      "rejected:value_invalid",
      "ok",
      "ok",
      "ok:renamedTo:audio.volume",
      "ok:dropped",
      "rejected:collection_unknown",
    ]);
  });

  it("stores accepted rows under the device row's family and answers them in the pull members", async () => {
    const res = await push(w, [
      set("audio.gain", 3),
      set("video.quality", "high", "platform"),
    ]);
    const body = (await res.json()) as PushResponse;
    expect(body.subject).toBe(w.subject);
    expect(
      body.changes.map((c) => ("setting" in c ? c.setting : "")).sort(),
    ).toEqual(["audio.gain", "video.quality"]);
    expect(body.lastMutationId).toBeGreaterThan(0);
    expect(body.catalogVersion).toBe(2);
    expect(body.aliases).toEqual({ "old.vol": "audio.volume" });
    expect(body.usage.settings).toBe(2);
    expect(body.quota).toEqual({ bytes: 268_435_456, files: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers the pull since the request's cursor", async () => {
    const first = (await (
      await push(w, [set("audio.gain", 1)])
    ).json()) as PushResponse;
    const second = (await (
      await push(w, [set("ui.theme", "light")], { cursor: first.cursor })
    ).json()) as PushResponse;
    expect(
      second.changes.map((c) => ("setting" in c ? c.setting : "")),
    ).toEqual(["ui.theme"]);
  });

  it("applies an atomic batch all or nothing", async () => {
    const res = await push(w, [set("audio.gain", 1), set("audio.volume", 99)], {
      atomic: true,
    });
    const results = await resultsOf(res);
    expect(results.map((r) => r.status)).toEqual(["aborted", "rejected"]);
  });
});

describe("POST /<p>/sync/ops: the caller", () => {
  it("is 401 for a missing token, a cookie, or another device's header", async () => {
    const w = await world();
    const body = batch([set("audio.gain", 1)]);
    expect((await send(w, body, {})).status).toBe(401);
    expect(
      (
        await send(w, body, {
          cookie: "pkey_session=abc",
          "x-pkey-device": DEVICE,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send(w, body, {
          authorization: `Bearer ${w.token}`,
          "x-pkey-device": "someone-else",
        })
      ).status,
    ).toBe(401);
    expect(
      (await send(w, body, { authorization: `Bearer ${w.token}` })).status,
    ).toBe(400);
    expect(w.ns.calls).toEqual([]);
  });

  it("is 403 account_required with no principal, before anything else", async () => {
    const w = await world({ signedIn: false });
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("account_required");
    expect(w.ns.calls).toEqual([]);
  });

  it("is 404 with Cloud Sync, and only a GET-less route, off; 405 for another method", async () => {
    const w = await world();
    await enable(w.db, { sync: false });
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(404);
    await enable(w.db);
    expect(
      (await send(w, {}, authed(w), `/${SLUG}/sync/ops`, "GET")).status,
    ).toBe(405);
  });

  it("ignores a subject in the body: the principal is the token's", async () => {
    const w = await world();
    const res = await push(w, [set("audio.gain", 1)], { subject: "ps_other" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PushResponse).subject).toBe(w.subject);
    expect(w.ns.calls.every((c) => c.includes(w.subject))).toBe(true);
  });
});

describe("POST /<p>/sync/ops: the kill switch", () => {
  it("answers 503 writes_paused with Retry-After 300 before the object; the pull is still served", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(await errorOf(res)).toBe("writes_paused");
    expect(w.ns.calls).toEqual([]);
    const pull = await send(w, "", authed(w), `/${SLUG}/sync`, "GET");
    expect(pull.status).toBe(200);
  });
});

describe("POST /<p>/sync/ops: device trust (cloudSyncWrite)", () => {
  const policy = (w: World, enforce: boolean) =>
    w.db.run(
      "UPDATE products SET trust_policy_json = ? WHERE slug = ?",
      JSON.stringify({ cloudSyncWrite: "attested", enforce }),
      SLUG,
    );
  const audits = (w: World) =>
    w.db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action LIKE 'device.trust.%'",
    );

  it("log-only audits the would-be refusal and goes on", async () => {
    const w = await world();
    await policy(w, false);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(200);
    expect((await audits(w)).map((a) => a.action)).toEqual([
      "device.trust.would_refuse",
    ]);
  });

  it("enforced answers 403 attestation_required for the whole request, before the object", async () => {
    const w = await world();
    await policy(w, true);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("attestation_required");
    expect(w.ns.calls).toEqual([]);
    expect((await audits(w)).map((a) => a.action)).toEqual([
      "device.trust.refused",
    ]);
  });

  it("the default policy (basic) costs no audit row", async () => {
    const w = await world();
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    expect(await audits(w)).toEqual([]);
  });

  it("an attested device passes an enforced policy", async () => {
    const w = await world();
    await policy(w, true);
    await w.db.run(
      "UPDATE devices SET trust_level = 'attested' WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
  });
});

describe("POST /<p>/sync/ops: quota and the product ceiling", () => {
  const entitle = (w: World, bytes: number) =>
    w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          "pkey.cloudSync.bytes": {
            state: "enforced",
            value: bytes,
            updatedAt: NOW,
          },
        },
      }),
      SLUG,
    );

  it("a device with no usable licence is at 1 MiB with files refused, and the object is told so", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ?",
      SLUG,
    );
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PushResponse).quota).toEqual({
      bytes: 1_048_576,
      files: false,
    });
  });

  it("sends the device row's own platform, from the row only and only if it is a known one", async () => {
    for (const [stored, expected] of [
      ["ios", "ios"],
      ["Windows 11", undefined],
    ] as const) {
      const w = await world();
      const seen: Record<string, unknown>[] = [];
      w.env.CLOUD_SYNC = scripted((_n, body) => {
        seen.push(body);
        return body.op === "push" ? okPush() : okPull();
      }).ns;
      await w.db.run(
        "UPDATE devices SET platform = ? WHERE product = ?",
        stored,
        SLUG,
      );
      await push(w, [set("audio.gain", 1)], { platform: "macos" });
      const sent = seen.find((b) => b.op === "push")!;
      expect(sent.platform, stored).toBe(expected);
    }
  });

  it("sends the device's quota and tier from syncAccess, never from the request", async () => {
    const w = await world();
    const seen: Record<string, unknown>[] = [];
    w.env.CLOUD_SYNC = scripted((_n, body) => {
      seen.push(body);
      return body.op === "push" ? okPush() : okPull();
    }).ns;
    await entitle(w, 5000);
    await push(w, [set("audio.gain", 1)], {
      quota: 1e12,
      limits: { quotaBytes: 1e12 },
    });
    const sent = seen.find((b) => b.op === "push")!;
    expect(sent.limits).toEqual({ quotaBytes: 5000 });
    expect(sent.family).toBe("desktop");
    // The directory's platform is the device row's own, never a body field.
    expect(sent.platform).toBeUndefined();
    expect(sent.deviceId).toBe(DEVICE);
    expect(Object.keys(sent.request as object).sort()).toEqual([
      "clientId",
      "cursor",
      "mutations",
    ]);
  });

  it("a write over the person's quota is quota_exceeded; a clear always passes", async () => {
    const w = await world();
    await entitle(w, 1);
    const results = await resultsOf(
      await push(w, [set("audio.gain", 123456), mut("audio.gain", "clear")]),
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
    expect(results[1]!.status).toBe("ok");
  });

  it("quota 0 is reads only, and still lets a clear through", async () => {
    const w = await world();
    await entitle(w, 0);
    const results = await resultsOf(
      await push(w, [set("audio.gain", 1), mut("audio.gain", "clear")]),
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "ok"]);
  });

  const usage = (w: World, bytes: number) =>
    w.db.run(
      `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
       VALUES (?, ?, 1, ?, 0, 0, 0, '{}', 1)`,
      SLUG,
      bytes,
      bytes,
    );
  const ceiling = (w: World, bytes: number) =>
    w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'cloudSync.ceiling.bytes', ?, 'console', ?, 'test')`,
      SLUG,
      JSON.stringify(bytes),
      NOW,
    );

  it("past the product ceiling growth is quota_exceeded scope product; a clear and a delete-like write pass", async () => {
    const w = await world();
    await push(w, [set("audio.volume", 0.5)]);
    await usage(w, 1000);
    await ceiling(w, 500);
    const results = await resultsOf(
      await push(w, [set("audio.gain", 5), mut("audio.volume", "clear")]),
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "product",
    });
    expect(results[1]!.status).toBe("ok");
  });

  it("under the ceiling nothing changes; the default ceiling is 50 GiB", async () => {
    const w = await world();
    await usage(w, 1000);
    await ceiling(w, 100_000);
    expect(
      (await resultsOf(await push(w, [set("audio.gain", 5)])))[0]!.status,
    ).toBe("ok");
    const v = await world();
    await usage(v, 10 * 1024 ** 3);
    expect(
      (await resultsOf(await push(v, [set("audio.gain", 5)])))[0]!.status,
    ).toBe("ok");
    const x = await world();
    await usage(x, 50 * 1024 ** 3);
    expect(
      (await resultsOf(await push(x, [set("audio.gain", 5)])))[0],
    ).toMatchObject({ status: "rejected", scope: "product" });
  });
});

describe("POST /<p>/sync/ops: the request", () => {
  it("more than 100 mutations is 400 bad_request", async () => {
    const w = await world();
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...set("audio.gain", i),
      mutationId: 10_000 + i,
    }));
    const res = await push(w, many);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("bad_request");
    const exact = Array.from({ length: 100 }, (_, i) => ({
      ...set("audio.gain", i),
      mutationId: 20_000 + i,
    }));
    expect((await push(w, exact)).status).toBe(200);
  });

  it("a malformed body is 400, whatever the shape problem", async () => {
    const w = await world();
    for (const body of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ cursor: 0, mutations: [] }),
      JSON.stringify({ clientId: "nope", cursor: 0, mutations: [] }),
      JSON.stringify({ clientId: CLIENT, cursor: -1, mutations: [] }),
      JSON.stringify({ clientId: CLIENT, cursor: 0, mutations: [{}] }),
      JSON.stringify({
        clientId: CLIENT,
        cursor: 0,
        atomic: "yes",
        mutations: [],
      }),
    ]) {
      const res = await send(w, body, authed(w));
      expect(res.status, body).toBe(400);
    }
    expect(w.ns.calls).toEqual([]);
  });

  it("a body over 256 KiB is 413 body_too_large, declared or streamed", async () => {
    const w = await world();
    const big = JSON.stringify(
      batch([set("audio.gain", 1)], { pad: "x".repeat(262_144) }),
    );
    const declared = await send(w, big, authed(w));
    expect(declared.status).toBe(413);
    expect(await errorOf(declared)).toBe("body_too_large");
    const streamed = await dispatch(
      new Request(`${BASE}/${SLUG}/sync/ops`, {
        method: "POST",
        headers: authed(w),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit) as unknown as Request,
      w.env,
      w.db,
    );
    expect(streamed.status).toBe(413);
    expect(w.ns.calls).toEqual([]);
  });

  it("a clientId bound to another device is 409 client_mismatch and writes nothing", async () => {
    const w = await world();
    await callCloudSync<"push">(
      w.env,
      { product: SLUG, subject: w.subject },
      {
        op: "push",
        deviceId: "dev-other",
        family: "desktop",
        limits: { quotaBytes: 1e9 },
        request: batch([set("audio.gain", 1)], {
          clientId: OTHER_CLIENT,
        }) as never,
        classified: [{ verdict: "accept", scope: "user", policy: "lastWrite" }],
        serverNow: NOW * 1000,
      },
    );
    const res = await send(
      w,
      batch([set("audio.gain", 2)], { clientId: OTHER_CLIENT }),
      authed(w),
    );
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("client_mismatch");
  });

  it("a mutation id at or below the last processed is a duplicate", async () => {
    const w = await world();
    const m = [set("audio.gain", 1)];
    expect((await resultsOf(await push(w, m)))[0]!.status).toBe("ok");
    expect((await resultsOf(await push(w, m)))[0]!.status).toBe("duplicate");
  });
});

// ── The object's refusals (SR-2) ───────────────────────────────────────────────────────────────

type Script = (
  call: number,
  body: Record<string, unknown>,
) => { status: number; body: unknown };

function scripted(script: Script) {
  const seen: Record<string, unknown>[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        seen.push(body);
        const r = script(seen.length, body);
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, seen };
}

const okPush = () => ({
  status: 200,
  body: {
    op: "push",
    outcome: {
      ok: true,
      results: [],
      lastMutationId: 0,
      seq: 0,
      usage: { settings: 0, settingsBytes: 0, bytes: 0 },
      counts: { accepted: 0, conflicts: 0 },
    },
  },
});
const okPull = () => ({
  status: 200,
  body: {
    op: "pull",
    outcome: {
      ok: true,
      cursor: 0,
      more: false,
      lastMutationId: 0,
      empty: true,
      changes: [],
      tombstones: [],
      usage: { bytes: 0, settings: 0, records: 0, files: 0 },
      etag: '"0.0"',
    },
  },
});
const reply = (body: Record<string, unknown>) =>
  body.op === "push" ? okPush() : okPull();

describe("POST /<p>/sync/ops: the object's refusals are mapped, never copied", () => {
  it("a persistent 410 absorbed is a retryable 503 that does not name the object's code", async () => {
    const w = await world();
    const s = scripted(() => ({ status: 410, body: { error: "absorbed" } }));
    w.env.CLOUD_SYNC = s.ns;
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "unavailable" } });
    expect(text).not.toContain("absorbed");
    expect(s.seen).toHaveLength(2);
  });

  it("one 410 absorbed is re-resolved and retried once", async () => {
    const w = await world();
    const s = scripted((n, body) =>
      n === 1 ? { status: 410, body: { error: "absorbed" } } : reply(body),
    );
    w.env.CLOUD_SYNC = s.ns;
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(200);
    expect(s.seen.map((b) => b.op)).toEqual(["push", "push", "pull"]);
  });

  it("an absorbed object whose person signed out is account_required", async () => {
    const w = await world();
    const s = scripted(() => ({ status: 410, body: { error: "absorbed" } }));
    const orig = s.ns.get.bind(s.ns);
    s.ns.get = ((id: DurableObjectId) => {
      const stub = orig(id);
      return {
        fetch: async (u: string, i?: RequestInit) => {
          await w.db.run(
            "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
            SLUG,
            DEVICE,
          );
          return stub.fetch(u, i as never);
        },
      };
    }) as never;
    w.env.CLOUD_SYNC = s.ns;
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("account_required");
  });

  /** The device is re-bound while the first push is in the object (the second call is the pull). */
  const rebindDuringPush = async (w: World, asMerge: boolean) => {
    const other = await signIn(
      w.db,
      { issuerKey: "email", subject: "bo@example.com", kind: "email" },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (other.status !== "signed_in") throw new Error(other.status);
    const merge = async (): Promise<void> => {
      if (!asMerge) return;
      // A merge: the old subject stops being live and becomes an alias of the survivor.
      await w.db.run(
        "DELETE FROM account_product_subjects WHERE product = ? AND subject = ?",
        SLUG,
        w.subject,
      );
      await w.db.run(
        "INSERT INTO account_product_subject_aliases (product, alias, subject, merged_at) VALUES (?, ?, ?, ?)",
        SLUG,
        w.subject,
        other.subject!,
        NOW,
      );
    };
    const s = scripted((_n, body) => reply(body));
    const orig = s.ns.get.bind(s.ns);
    s.ns.get = ((id: DurableObjectId) => {
      const stub = orig(id);
      return {
        fetch: async (u: string, i?: RequestInit) => {
          const r = await stub.fetch(u, i as never);
          if (s.seen.length === 2) {
            await merge();
            await w.db.run(
              "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
              other.subject!,
              SLUG,
              DEVICE,
            );
          }
          return r;
        },
      };
    }) as never;
    w.env.CLOUD_SYNC = s.ns;
    return { s, other: other.subject! };
  };

  it("a subject merged away after the push is repeated against the survivor", async () => {
    const w = await world();
    const { s, other } = await rebindDuringPush(w, true);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PushResponse).subject).toBe(other);
    expect(s.seen.filter((b) => b.op === "push")).toHaveLength(2);
    expect(s.seen.at(-1)!.subject).toBe(other);
  });

  it("a device re-bound to an unrelated person is never replayed into that person's object (SR-2)", async () => {
    const w = await world();
    const { s, other } = await rebindDuringPush(w, false);
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "account_required",
    );
    expect(s.seen.filter((b) => b.op === "push")).toHaveLength(1);
    expect(s.seen.some((b) => b.subject === other)).toBe(false);
  });

  it("another object failure is retryable or 500 and never names the object's code", async () => {
    const w = await world();
    for (const [status, code, want] of [
      [500, "boom", 503],
      [403, "pin_mismatch", 500],
      [400, "bad_request", 500],
    ] as const) {
      w.env.CLOUD_SYNC = scripted(() => ({ status, body: { error: code } })).ns;
      const res = await push(w, [set("audio.gain", 1)]);
      expect(res.status, code).toBe(want);
      expect(await res.text()).not.toContain(code);
    }
    w.env.CLOUD_SYNC = undefined as never;
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(503);
  });

  it("an expired cursor after the push landed is 410 cursor_expired (the retry is all duplicates)", async () => {
    const w = await world();
    const m = [set("audio.gain", 1)];
    const res = await push(w, m, { cursor: 9999 });
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toBe("cursor_expired");
    const again = await push(w, m, { cursor: 0 });
    expect((await resultsOf(again))[0]!.status).toBe("duplicate");
  });

  it("an unreadable catalog is retryable: a declared key is never stored as an open one", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE product_schema SET catalog_json = '{\"entries\": [' WHERE product = ?",
      SLUG,
    );
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(503);
    expect(w.ns.calls).toEqual([]);
  });
});

describe("POST /<p>/sync/ops: a deleted or erasing product is refused before the object (SR-2)", () => {
  const direct = (w: World, product: Product) =>
    handlePush({
      req: new Request(`${BASE}/${SLUG}/sync/ops`, {
        method: "POST",
        headers: authed(w),
        body: JSON.stringify(batch([set("audio.gain", 1)])),
      }) as unknown as Request,
      env: w.env,
      db: w.db,
      product,
      rest: [],
      now: NOW,
      hooks: NO_HOOKS,
      ingest: undefined as never,
    });

  it("a soft-deleted product is 404 through the router and through a handler already past it", async () => {
    const w = await world();
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    await w.db.run(
      "UPDATE products SET status = 'deleted' WHERE slug = ?",
      SLUG,
    );
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(404);
    expect((await direct(w, product as Product)).status).toBe(404);
    expect(w.ns.calls).toEqual([]);
  });

  it("a product mid-purge is refused even though its row is still live; the first purge run sets the flag", async () => {
    const w = await world();
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    w.ns.calls.length = 0;
    // The purge is bounded: a first run that is not done leaves the product row alone. More
    // listed people than one run erases (400) keep it from finishing.
    await w.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 450)
       INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes, quota_bytes, tier_id, platform, last_active_at, updated_at)
       SELECT ?, 'sub_' || i, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, 0 FROM n`,
      SLUG,
    );
    expect(await productIsPurging(w.env, SLUG)).toBe(false);
    await purgeProductData(w.db, w.env, SLUG, NOW);
    w.ns.calls.length = 0;
    expect(await productIsPurging(w.env, SLUG)).toBe(true);
    expect(
      w.kv.ttlOf(w.kv.keys().find((k) => k.includes("sync-purging"))!),
    ).toBe(3600);
    expect((await loadProduct(w.env, w.db, SLUG))?.slug).toBe(SLUG);
    expect((await push(w, [set("audio.gain", 2)])).status).toBe(404);
    expect((await direct(w, product as Product)).status).toBe(404);
    expect(w.ns.calls).toEqual([]);
  });

  it("a finished purge keeps the flag, so a push before the product row flips is still refused", async () => {
    const w = await world();
    await markProductPurging(w.env, SLUG);
    expect(await productIsPurging(w.env, SLUG)).toBe(true);
    // Nothing is listed: this run is the last, and the flag stays until its TTL lapses.
    const out = await syncProductPurge({
      db: w.db,
      env: w.env,
      product: SLUG,
      now: NOW,
    });
    expect(out).toEqual({ done: true });
    expect(await productIsPurging(w.env, SLUG)).toBe(true);
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(404);
  });

  it("the flag is per product, and reads (the pull) are not refused", async () => {
    const w = await world();
    await markProductPurging(w.env, "other-product");
    expect((await push(w, [set("audio.gain", 1)])).status).toBe(200);
    await markProductPurging(w.env, SLUG);
    const pull = await send(w, "", authed(w), `/${SLUG}/sync`, "GET");
    expect(pull.status).toBe(200);
  });

  it("a KV that cannot answer refuses the push (retryable) rather than assuming no purge", async () => {
    const w = await world();
    const real = w.kv.get.bind(w.kv);
    let broken = false;
    w.kv.get = async (key: string) => {
      if (broken && key.includes("sync-purging")) throw new Error("kv down");
      return real(key);
    };
    broken = true;
    const res = await push(w, [set("audio.gain", 1)]);
    expect(res.status).toBe(503);
    expect(w.ns.calls).toEqual([]);
  });
});

describe("POST /<p>/sync/ops: CORS", () => {
  it("a listed origin may call it, an unlisted one gets nothing, credentials are never allowed", async () => {
    const w = await world();
    const ok = await push(w, [set("audio.gain", 1)], {}, { origin: LISTED });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const no = await push(w, [set("audio.gain", 2)], {}, { origin: UNLISTED });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await send(
      w,
      "",
      { origin: LISTED, "access-control-request-method": "POST" },
      `/${SLUG}/sync/ops`,
      "OPTIONS",
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    const refused = await send(
      w,
      "",
      { origin: UNLISTED },
      `/${SLUG}/sync/ops`,
      "OPTIONS",
    );
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the meter header (U-05.18)", () => {
  const FORM =
    /^sync;desc="(push|pull)";dur=\d+\.\d, mut;desc="(\d+)", rr;desc="(\d+)", rw;desc="(\d+)"$/;

  it("rides a push and a pull, carries no identifier, and is not CORS-exposed", async () => {
    const w = await world();
    const res = await push(
      w,
      [set("audio.gain", 3), set("ui.theme", "dark")],
      {},
      {
        origin: LISTED,
      },
    );
    expect(res.status).toBe(200);
    const h = res.headers.get("server-timing")!;
    const m = FORM.exec(h)!;
    expect(m[1]).toBe("push");
    expect(m[2]).toBe("2");
    expect(Number(m[4])).toBeGreaterThan(0);
    for (const secret of [w.subject, DEVICE, SLUG, "ada@example.com", w.token])
      expect(h).not.toContain(secret);
    expect(res.headers.get("access-control-expose-headers") ?? "").not.toMatch(
      /server-timing/i,
    );
    expect(res.headers.get("timing-allow-origin")).toBeNull();

    const pulled = await send(w, "", authed(w), `/${SLUG}/sync`, "GET");
    expect(pulled.status).toBe(200);
    const p = FORM.exec(pulled.headers.get("server-timing")!)!;
    expect(p[1]).toBe("pull");
    expect(p[2]).toBe("0");
    expect(Number(p[3])).toBeGreaterThan(0);
  });

  it("is absent when the request never reached the object", async () => {
    const w = await world();
    const res = await send(w, batch([]), {}, `/${SLUG}/sync/ops`);
    expect(res.status).toBe(401);
    expect(res.headers.get("server-timing")).toBeNull();
  });
});

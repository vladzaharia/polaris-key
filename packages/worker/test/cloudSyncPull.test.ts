/**
 * U-05.12: `GET /<p>/sync`, the Cloud Sync pull (WIRE-CONTRACT-V4 §13.1, §13.4; plans/U-05-slices.md).
 *
 * Driven through the real `dispatch` pipeline and the real `CloudSyncDO` class over a
 * better-sqlite3 `SqlStorage` mock. A scripted namespace stands in for the object where a test
 * needs an answer the real one gives only in a race (`absorbed`, a page with `more`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { formatHlc } from "../src/services/sync/engine/hlc.js";
import type { Classification } from "../src/services/sync/engine/types.js";
import type { SyncJson, SyncMutation } from "@polaris-key/protocol/sync";
import { makeTestDb, NO_HOOKS } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "./cloudSyncDoMock.js";
import { dispatch } from "../src/dispatch.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { serializeWebOrigins } from "../src/core/cors.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { setDeviceSubject } from "../src/core/accounts/accountSubjects.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../src/services/license/activation.js";
import { callCloudSync } from "../src/services/sync/do/client.js";
import { handlePull } from "../src/services/sync/handlers/pull.js";
import type { PullResponse } from "@polaris-key/protocol/sync";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const LISTED = "https://play.djdl.example";
const UNLISTED = "https://evil.example";
const DEVICE = "dev-pull-1";
const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";

const LAST_WRITE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};

interface World {
  db: Db;
  env: Env;
  ns: CloudSyncNamespaceMock;
  token: string;
  subject: string;
}

async function enable(
  db: Db,
  over: Partial<
    Record<"config" | "identity" | "sync" | "license", boolean>
  > = {},
  slug = SLUG,
): Promise<void> {
  const on = (k: "config" | "identity" | "sync" | "license") => ({
    enabled: over[k] ?? true,
  });
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: on("license"),
        config: on("config"),
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: on("identity"),
        sync: on("sync"),
        commerce: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

/** A key-activated device (token in hand); `signedIn` binds an account to it. */
async function world(opts: { signedIn?: boolean } = {}): Promise<World> {
  const db = makeTestDb();
  const ns = new CloudSyncNamespaceMock();
  const env = makeEnv(new KvMock(), []);
  env.CLOUD_SYNC = asCloudSyncNamespace(ns);
  await seedProduct(db, SLUG);
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
  return { db, env, ns, token, subject };
}

function get(
  w: Pick<World, "db" | "env">,
  query = "",
  headers: Record<string, string> = {},
  path = `/${SLUG}/sync`,
  method = "GET",
) {
  return dispatch(
    new Request(`${BASE}${path}${query}`, {
      method,
      headers,
    }) as unknown as Request,
    w.env,
    w.db,
  );
}

const authed = (w: World, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${w.token}`,
  "x-pkey-device": DEVICE,
  ...extra,
});

let mid = 1;
const mut = (
  key: string,
  op: "set" | "clear",
  value?: SyncJson,
  scope: "user" | "platform" = "user",
): SyncMutation => ({
  mutationId: mid++,
  target: { setting: key, scope },
  op,
  ...(value !== undefined ? { value } : {}),
  editedHlc: formatHlc(NOW * 1000 - 1000, 0),
});

async function pushRows(
  w: World,
  muts: SyncMutation[],
  family = "desktop",
  scope: "user" | "platform" = "user",
): Promise<void> {
  const reply = await callCloudSync<"push">(
    w.env,
    { product: SLUG, subject: w.subject },
    {
      op: "push",
      deviceId: DEVICE,
      family,
      limits: { quotaBytes: 1_000_000_000 },
      request: { clientId: CLIENT, cursor: 0, mutations: muts },
      classified: muts.map(() => ({ ...LAST_WRITE, scope })),
      serverNow: NOW * 1000,
    },
  );
  expect(reply.outcome.ok).toBe(true);
}

const bodyOf = async (res: Response) => (await res.json()) as PullResponse;

describe("GET /<p>/sync: the answer", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("answers a person with nothing stored as an empty snapshot", async () => {
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b).toMatchObject({
      subject: w.subject,
      cursor: 0,
      more: false,
      lastMutationId: 0,
      aliases: {},
      empty: true,
      changes: [],
      tombstones: [],
      usage: { bytes: 0, settings: 0, records: 0, files: 0 },
    });
    expect(b.serverNow).toBeGreaterThan(1_700_000_000_000);
    expect(res.headers.get("etag")).toBe('"0.0"');
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("passes the quota from syncAccess through: the platform default for a licensed device", async () => {
    const b = await bodyOf(await get(w, "", authed(w)));
    expect(b.quota).toEqual({ bytes: 268_435_456, files: true });
  });

  it("passes a licence's pkey.cloudSync.bytes entitlement through", async () => {
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          "pkey.cloudSync.bytes": {
            state: "enforced",
            value: 5000,
            updatedAt: NOW,
          },
        },
      }),
      SLUG,
    );
    const b = await bodyOf(await get(w, "", authed(w)));
    expect(b.quota).toEqual({ bytes: 5000, files: true });
  });

  it("passes the floor through for a device with no usable licence", async () => {
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ?",
      SLUG,
    );
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).quota).toEqual({
      bytes: 1_048_576,
      files: false,
    });
  });

  it("returns rows, the person's usage and the device's lastMutationId; ETag and 304", async () => {
    await pushRows(w, [
      mut("audio.volume", "set", 0.6),
      mut("ui.theme", "set", "dark"),
    ]);
    const res = await get(w, `?clientId=${CLIENT}`, authed(w));
    const b = await bodyOf(res);
    expect(b.changes.map((c) => "setting" in c && c.setting)).toEqual([
      "audio.volume",
      "ui.theme",
    ]);
    expect(b.empty).toBeUndefined();
    expect(b.usage.settings).toBe(2);
    expect(b.usage.bytes).toBeGreaterThan(0);
    expect(b.lastMutationId).toBe(mid - 1);
    const etag = res.headers.get("etag")!;
    expect(etag).toBe(`"${b.cursor}.${b.lastMutationId}"`);

    const again = await get(
      w,
      `?cursor=${b.cursor}&clientId=${CLIENT}`,
      authed(w, { "if-none-match": etag }),
    );
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    // A clientId of another device sees lastMutationId 0, so its tag differs.
    const other = await get(
      w,
      `?clientId=c_BBBBBBBBBBBBBBBBBBBBBB`,
      authed(w, { "if-none-match": etag }),
    );
    expect(other.status).toBe(200);
  });

  it("is incremental: only rows after the cursor, with tombstones", async () => {
    await pushRows(w, [mut("a", "set", 1), mut("b", "set", 2)]);
    const first = await bodyOf(await get(w, "", authed(w)));
    await pushRows(w, [mut("a", "clear")]);
    const next = await bodyOf(
      await get(w, `?cursor=${first.cursor}`, authed(w)),
    );
    expect(next.changes).toEqual([]);
    expect(next.tombstones.map((t) => "setting" in t && t.setting)).toEqual([
      "a",
    ]);
  });

  it("returns the platform rows of the device's own family only", async () => {
    await pushRows(
      w,
      [mut("res", "set", 1, "platform")],
      "desktop",
      "platform",
    );
    await pushRows(w, [mut("pad", "set", 2, "platform")], "mobile", "platform");
    await pushRows(w, [mut("shared", "set", 3)]);
    const b = await bodyOf(await get(w, "", authed(w)));
    expect(b.changes.map((c) => "setting" in c && c.setting)).toEqual([
      "res",
      "shared",
    ]);
  });

  it("pages: 500 rows, no ETag and no 304 while more remain, then the rest", async () => {
    // 600 tombstones (tombstones on open keys are not bounded by the settings budget).
    for (let round = 0; round < 6; round++) {
      const keys = Array.from({ length: 100 }, (_, i) => `k.${round}.${i}`);
      await pushRows(
        w,
        keys.map((k) => mut(k, "set", 1)),
      );
      await pushRows(
        w,
        keys.map((k) => mut(k, "clear")),
      );
    }
    const p1 = await get(w, "", authed(w));
    const b1 = await bodyOf(p1);
    expect(b1.more).toBe(true);
    expect(b1.changes.length + b1.tombstones.length).toBe(500);
    expect(p1.headers.get("etag")).toBeNull();
    // Even the store's current tag cannot stop the paging: a page with more is never 304.
    const again = await get(w, "", authed(w, { "if-none-match": '"1200.0"' }));
    expect(again.status).toBe(200);
    const p2 = await get(w, `?cursor=${b1.cursor}`, authed(w));
    const b2 = await bodyOf(p2);
    expect(p2.status).toBe(200);
    expect(b2.more).toBe(false);
    expect(
      b1.changes.length +
        b1.tombstones.length +
        b2.changes.length +
        b2.tombstones.length,
    ).toBe(600);
    expect(b2.cursor).toBeGreaterThan(b1.cursor);
    expect(p2.headers.get("etag")).toBe(`"${b2.cursor}.0"`);
  });

  it("answers 410 cursor_expired for a cursor past the store", async () => {
    await pushRows(w, [mut("a", "set", 1)]);
    const res = await get(w, "?cursor=999", authed(w));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: { code: "cursor_expired" } });
  });

  it("maps catalogVersion and aliases from the active catalog's migrations", async () => {
    const row = (await w.db.first<{
      catalog_json: string;
      catalog_version: number;
    }>(
      "SELECT catalog_json, catalog_version FROM product_schema WHERE product = ? AND active = 1",
      SLUG,
    ))!;
    const catalog = JSON.parse(row.catalog_json);
    catalog.cloudSync = {
      migrations: [
        {
          toSchemaVersion: catalog.schemaVersion,
          rename: { "old.a": "mid.a", "mid.a": "new.a", "x.gone": "y" },
          drop: ["x.gone"],
        },
        {
          toSchemaVersion: catalog.schemaVersion + 5,
          rename: { "future.k": "later.k" },
        },
      ],
    };
    await w.db.run(
      "UPDATE product_schema SET catalog_json = ? WHERE product = ? AND active = 1",
      JSON.stringify(catalog),
      SLUG,
    );
    const b = await bodyOf(await get(w, "", authed(w)));
    expect(b.catalogVersion).toBe(catalog.schemaVersion);
    expect(b.aliases).toEqual({ "old.a": "new.a", "mid.a": "new.a" });
  });
});

describe("GET /<p>/sync: who may ask", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("is bearer only: no credential, a cookie alone, a bad token and a licence key are 401", async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { cookie: "pkey_session=abc", "x-pkey-device": DEVICE },
      {
        authorization: `Bearer pkeyt_${"z".repeat(43)}`,
        "x-pkey-device": DEVICE,
      },
      { authorization: "Bearer pkey_notadevicetoken", "x-pkey-device": DEVICE },
    ]) {
      const res = await get(w, "", headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(w.ns.calls).toEqual([]);
  });

  it("needs the device header: missing is 400, another device's id is 401", async () => {
    expect(
      (await get(w, "", { authorization: `Bearer ${w.token}` })).status,
    ).toBe(400);
    expect(
      (
        await get(w, "", {
          authorization: `Bearer ${w.token}`,
          "x-pkey-device": "someone-else",
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a malformed cursor or clientId with 400, before the object is called", async () => {
    for (const q of [
      "?cursor=-1",
      "?cursor=abc",
      "?cursor=1.5",
      "?cursor=01",
      "?cursor=1&cursor=2",
      "?cursor=99999999999999999",
      "?clientId=nope",
      `?clientId=${CLIENT}&clientId=${CLIENT}`,
    ]) {
      const res = await get(w, q, authed(w));
      expect(res.status, q).toBe(400);
    }
    expect(w.ns.calls).toEqual([]);
  });

  it("answers other methods 405", async () => {
    const res = await get(w, "", authed(w), `/${SLUG}/sync`, "POST");
    expect(res.status).toBe(405);
  });

  it("a token of product A is not accepted by product B", async () => {
    await seedProduct(w.db, "other");
    await enable(w.db, {}, "other");
    const res = await get(w, "", authed(w), "/other/sync");
    expect(res.status).toBe(401);
    expect(w.ns.calls).toEqual([]);
  });

  it("is 404 while Cloud Sync is off, and while Config or Identity is off", async () => {
    await enable(w.db, { sync: false });
    expect((await get(w, "", authed(w))).status).toBe(404);
    for (const off of ["config", "identity"] as const) {
      // The service table refuses this combination on write; a stored row must still answer 404.
      await enable(w.db, { sync: true, [off]: false });
      expect((await get(w, "", authed(w))).status, off).toBe(404);
    }
    expect(w.ns.calls).toEqual([]);
  });

  it("is 404 for a soft-deleted product, and the handler refuses it before the object (SR-2)", async () => {
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    await w.db.run(
      "UPDATE products SET status = 'deleted' WHERE slug = ?",
      SLUG,
    );
    expect((await get(w, "", authed(w))).status).toBe(404);
    // The router's own check aside: a request that was already past it.
    const res = await handlePull({
      req: new Request(`${BASE}/${SLUG}/sync`, {
        headers: authed(w),
      }) as unknown as Request,
      env: w.env,
      db: w.db,
      product: product as Product,
      rest: [],
      now: NOW,
      hooks: NO_HOOKS,
      ingest: undefined as never,
    });
    expect(res.status).toBe(404);
    expect(w.ns.calls).toEqual([]);
  });
});

describe("GET /<p>/sync: account_required", () => {
  it("a key-activated device with no sign-in gets 403 with the sign-in link; nothing changes", async () => {
    const w = await world({ signedIn: false });
    const snap = async () =>
      JSON.stringify([
        await w.db.all("SELECT * FROM licenses ORDER BY id"),
        await w.db.all("SELECT * FROM devices ORDER BY device_id"),
        await w.db.all("SELECT * FROM keys_index ORDER BY key_hash"),
      ]);
    const before = await snap();
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "account_required",
        message: "Sign in to use Cloud Sync.",
        signInUrl: `${BASE}/signin?product=${SLUG}`,
      },
    });
    expect(await snap()).toBe(before);
    expect(w.ns.calls).toEqual([]);
  });

  it("is 403 on a licence an account owns when the device is only key-activated", async () => {
    const w = await world({ signedIn: false });
    const owner = await signIn(
      w.db,
      { issuerKey: "email", subject: "owner@example.com", kind: "email" },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (owner.status !== "signed_in") throw new Error(owner.status);
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ?",
      owner.account.id,
      SLUG,
    );
    expect((await get(w, "", authed(w))).status).toBe(403);
    expect(w.ns.calls).toEqual([]);
  });
});

describe("GET /<p>/sync: CORS", () => {
  it("a listed origin may read the answer and the ETag; credentials are never allowed", async () => {
    const w = await world();
    const res = await get(w, "", authed(w, { origin: LISTED }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(res.headers.get("access-control-expose-headers")).toContain("ETag");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("an unlisted origin gets no CORS header", async () => {
    const w = await world();
    const res = await get(w, "", authed(w, { origin: UNLISTED }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers the preflight for a listed origin only", async () => {
    const w = await world();
    const ok = await get(
      w,
      "",
      { origin: LISTED, "access-control-request-method": "GET" },
      `/${SLUG}/sync`,
      "OPTIONS",
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(LISTED);
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const no = await get(
      w,
      "",
      { origin: UNLISTED },
      `/${SLUG}/sync`,
      "OPTIONS",
    );
    expect(no.status).toBe(204);
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── The object's refusals (SR-2) ───────────────────────────────────────────────────────────────

type Script = (
  call: number,
  body: Record<string, unknown>,
) => { status: number; body: unknown };

/** A namespace whose objects answer from a script; records every request body. */
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

const okPull = (subjectEcho = "") => ({
  status: 200,
  body: {
    op: "pull",
    outcome: {
      ok: true,
      cursor: 7,
      more: false,
      lastMutationId: 0,
      changes: [],
      tombstones: [],
      usage: { bytes: 0, settings: 0, records: 0, files: 0 },
      etag: '"7.0"',
      subjectEcho,
    },
  },
});

describe("GET /<p>/sync: the object's refusals are mapped, never copied", () => {
  it("a persistent 410 absorbed is a retryable 503 that does not name the object's code", async () => {
    const w = await world();
    const s = scripted(() => ({ status: 410, body: { error: "absorbed" } }));
    w.env.CLOUD_SYNC = s.ns;
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "unavailable" } });
    expect(text).not.toContain("absorbed");
    expect(s.seen).toHaveLength(2);
  });

  it("one 410 absorbed is re-resolved and retried once", async () => {
    const w = await world();
    const s = scripted((n) =>
      n === 1 ? { status: 410, body: { error: "absorbed" } } : okPull(),
    );
    w.env.CLOUD_SYNC = s.ns;
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(200);
    expect(s.seen).toHaveLength(2);
    expect((await bodyOf(res)).subject).toBe(w.subject);
  });

  it("a subject merged away while the object answered is pulled again from the survivor", async () => {
    const w = await world();
    const survivor = await signIn(
      w.db,
      { issuerKey: "email", subject: "bo@example.com", kind: "email" },
      NOW,
      { unfenced: true, product: { slug: SLUG } },
    );
    if (survivor.status !== "signed_in") throw new Error(survivor.status);
    const s = scripted(() => okPull());
    w.env.CLOUD_SYNC = s.ns;
    // The merge lands while the object answers the first call: the device now carries the survivor.
    const orig = s.ns.get.bind(s.ns);
    s.ns.get = ((id: DurableObjectId) => {
      const stub = orig(id);
      return {
        fetch: async (u: string, i?: RequestInit) => {
          const r = await stub.fetch(u, i as never);
          if (s.seen.length === 1)
            await w.db.run(
              "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
              survivor.subject!,
              SLUG,
              DEVICE,
            );
          return r;
        },
      };
    }) as never;
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(200);
    expect(s.seen.map((b) => b.subject)).toEqual([w.subject, survivor.subject]);
    expect((await bodyOf(res)).subject).toBe(survivor.subject);
  });

  it("a pin mismatch or a bad reply is a 500 with no object code; an unbound object is retryable", async () => {
    const w = await world();
    const s = scripted(() => ({
      status: 403,
      body: { error: "pin_mismatch" },
    }));
    w.env.CLOUD_SYNC = s.ns;
    const res = await get(w, "", authed(w));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("pin_mismatch");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error" } });

    delete (w.env as { CLOUD_SYNC?: unknown }).CLOUD_SYNC;
    const unbound = await get(w, "", authed(w));
    expect(unbound.status).toBe(503);
    expect(unbound.headers.get("retry-after")).toBe("5");
  });
});

// ── Nothing on the gate's path reaches Cloud Sync ──────────────────────────────────────────────

describe("import graph", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const IMPORT =
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  function reachable(entries: string[]): Set<string> {
    const seen = new Set<string>();
    const todo = entries.map((e) => join(SRC, e));
    while (todo.length > 0) {
      const file = todo.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!spec || !spec.startsWith(".")) continue;
        todo.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    return seen;
  }

  it("the payload, the documents and the build gate do not reach services/sync", () => {
    const files = reachable([
      "core/licensing/payload.ts",
      "core/licensing/gate.ts",
      "core/documents.ts",
    ]);
    expect(files.size).toBeGreaterThan(5);
    const hit = [...files].filter((f) =>
      f.includes(`${join("services", "sync")}`),
    );
    expect(hit).toEqual([]);
  });
});

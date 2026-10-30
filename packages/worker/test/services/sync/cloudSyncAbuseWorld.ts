/**
 * Harness: the real dispatch pipeline and the real CloudSyncDO over a
 * better-sqlite3 mock, one signed-in device on a License-on product with Cloud Sync enabled.
 */
import { expect } from "vitest";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { SyncJson, SyncMutation } from "@polaris-key/protocol/sync";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { asR2, type R2Mock } from "../../r2Mock.js";
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
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { serializeServices } from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { loadProduct } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";

export const SLUG = "djdl";
export const BASE = "https://key.plrs.im";
export const DEVICE = "dev-attack-1";
export const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";
export { NOW };

export interface World {
  db: Db;
  env: Env;
  ns: CloudSyncNamespaceMock;
  kv: KvMock;
  token: string;
  subject: string;
}

export async function world(
  opts: {
    catalog?: unknown;
    gate?: "on" | "off";
    /** A file store for the Worker and the objects (U-10): `SYNC_FILES`. */
    files?: R2Mock;
  } = {},
): Promise<World> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, []);
  if (opts.files) env.SYNC_FILES = asR2(opts.files);
  const ns = new CloudSyncNamespaceMock({}, env);
  env.CLOUD_SYNC = asCloudSyncNamespace(ns);
  if (opts.gate !== undefined) {
    (env as unknown as Record<string, string>).LAUNCH_SYNC_E2E = opts.gate;
    invalidatePlatformSettings(env, db);
  }
  await seedProduct(db, SLUG, {
    // The abuse tests push `value`s: the server-mode wire, unless a test asks for another.
    catalog: opts.catalog ?? {
      schemaVersion: 1,
      entries: [],
      cloudSync: { encryption: "server" },
    },
  });
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
        sync: { enabled: true },
        commerce: { enabled: false },
        connect: { enabled: false },
      },
    }),
    "manifest",
    NOW,
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
  const r = await signIn(
    db,
    { issuerKey: "email", subject: "ada@example.com", kind: "email" },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  expect(await setDeviceSubject(env, db, SLUG, DEVICE, r.subject!)).toBe(true);
  return { db, env, ns, kv, token, subject: r.subject! };
}

export const authed = (w: World) => ({
  authorization: `Bearer ${w.token}`,
  "x-pkey-device": DEVICE,
});

export function send(
  w: Pick<World, "db" | "env">,
  headers: Record<string, string>,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
) {
  return dispatch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
  );
}

let mid = 1;
export const hlc = formatHlc(NOW * 1000 - 1000, 0);
export const nextId = () => mid++;
export const mut = (
  key: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: mid++,
  target: { setting: key, scope: "user" },
  op,
  editedHlc: hlc,
  ...extra,
});
export const set = (key: string, value: SyncJson) => mut(key, "set", { value });
export const clear = (key: string) => mut(key, "clear");

export function push(
  w: World,
  mutations: SyncMutation[],
  clientId = CLIENT,
  extra: object = {},
) {
  return send(w, authed(w), `/${SLUG}/sync/ops`, "POST", {
    clientId,
    cursor: 0,
    mutations,
    ...extra,
  });
}

export const pull = (w: World) => send(w, authed(w), `/${SLUG}/sync`, "GET");

/** The person's Durable Object database. */
export function objectDb(w: World): {
  prepare(sql: string): { get(): unknown };
} {
  const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
  if (!inst) throw new Error("no object");
  return inst.storage.sql.db;
}
export const count = (w: World, table: string): number =>
  (
    objectDb(w).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

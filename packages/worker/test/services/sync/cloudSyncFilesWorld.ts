/**
 * Harness for the Cloud Sync file routes (U-10.5 on): the real dispatch pipeline, the real
 * `CloudSyncDO` over the SQLite mock, and an `R2Mock` standing in for `SYNC_FILES`, on a product
 * whose catalog declares the collections below. Server mode (`enc: "none"`), the launch gate on.
 */
import { createHash } from "node:crypto";
import { dispatch } from "../../../src/dispatch.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { NOW } from "../../seed.js";
import { R2Mock } from "../../r2Mock.js";
import {
  BASE,
  SLUG,
  authed,
  count,
  objectDb,
  push,
  world,
  type World,
} from "./cloudSyncAbuseWorld.js";

export { SLUG, authed, count, objectDb, push };

/** The collections the file tests use. */
export const FILES_CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "saves", template: "saves" },
      {
        name: "big",
        label: "Big",
        files: { maxBytes: 104_857_600, keepRevisions: 2 },
      },
      { name: "vip", label: "VIP", requires: "game.vip" },
      { name: "one", label: "One", maxRecords: 1 },
      {
        name: "delta",
        label: "Delta",
        files: { delta: true, maxBytes: 10_485_760, keepRevisions: 1 },
      },
    ],
  },
};

export interface FilesWorld extends World {
  r2: R2Mock;
}

export async function filesWorld(
  opts: { catalog?: unknown; r2?: R2Mock } = {},
): Promise<FilesWorld> {
  const r2 = opts.r2 ?? new R2Mock();
  const w = await world({
    catalog: opts.catalog ?? FILES_CATALOG,
    files: r2,
  });
  return Object.assign(w, { r2 });
}

/** Turns the operator's launch gate on or off for the world's Worker. */
export function setGate(w: World, value: "on" | "off" | undefined): void {
  const env = w.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env.LAUNCH_SYNC_FILES;
  else env.LAUNCH_SYNC_FILES = value;
  invalidatePlatformSettings(w.env, w.db);
}

export const filesPath = (collection: string, id: string, tail: string) =>
  `/${SLUG}/sync/files/${collection}/${id}/${tail}`;

/** One request through the real pipeline. A JSON body is sent as JSON; bytes as given. */
export function call(
  w: Pick<World, "db" | "env" | "token">,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: {
    json?: unknown;
    bytes?: Uint8Array;
    headers?: Record<string, string>;
    anonymous?: boolean;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(opts.anonymous
      ? {}
      : {
          authorization: `Bearer ${w.token}`,
          "x-pkey-device": "dev-attack-1",
        }),
    ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  const body =
    opts.json !== undefined
      ? JSON.stringify(opts.json)
      : (opts.bytes as BodyInit | undefined);
  return dispatch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
  );
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** RFC 9530: `sha-256=:<base64>:` of `bytes`. */
export const digestHeader = (bytes: Uint8Array): string =>
  `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;

/** A `PUT` of `bytes` with the headers an honest client sends; `over` replaces or (undefined) drops one. */
export function putBytes(
  w: Pick<World, "db" | "env" | "token">,
  path: string,
  bytes: Uint8Array,
  over: Record<string, string | undefined> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.length),
    "content-digest": digestHeader(bytes),
  };
  for (const [k, v] of Object.entries(over))
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  return call(w, "PUT", path, { bytes, headers });
}

/** A deterministic body of `n` bytes. */
export const bytesOf = (n: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

export interface BeginBody {
  size: number;
  sha256: string;
  format: "whole" | "chunks";
  enc: "e2e" | "none";
  baseVersion?: number | "*";
}

/** A `begin` body for `bytes` (or just a size, with a made-up hash). */
export const beginBody = (
  bytes: Uint8Array | number,
  over: Partial<BeginBody> = {},
): BeginBody => ({
  size: typeof bytes === "number" ? bytes : bytes.length,
  sha256: typeof bytes === "number" ? "ab".repeat(32) : sha256Hex(bytes),
  format: "whole",
  enc: "none",
  ...over,
});

export const begin = (
  w: FilesWorld,
  collection: string,
  id: string,
  body: unknown,
): Promise<Response> =>
  call(w, "POST", filesPath(collection, id, "begin"), { json: body });

export const uploadPath = (collection: string, id: string, uploadId: string) =>
  filesPath(collection, id, `upload/${uploadId}`);

/** The person's stored usage meta, straight from the object's database. */
export function meta(w: World, key: string): string | undefined {
  const row = objectDb(w)
    .prepare(`SELECT value FROM meta WHERE key = '${key}'`)
    .get() as { value: string } | undefined;
  return row?.value;
}

/** The rate limiter's Durable Object is down: every call rejects (the file limits fail open). */
export function breakLimiter(w: Pick<World, "env">): void {
  const down = { fetch: () => Promise.reject(new Error("object reset")) };
  const ns = { idFromName: (name: string) => ({ name }), get: () => down };
  w.env.RL = ns as unknown as DurableObjectNamespace;
}

/** The device's licence carries these entitlement values. */
export function entitle(
  w: World,
  entitlements: Record<string, unknown>,
): Promise<void> {
  const granted = Object.entries(entitlements).map(([name, value]) => [
    name,
    { state: "enforced", value, updatedAt: NOW },
  ]);
  return w.db.run(
    "UPDATE licenses SET overrides_json = ? WHERE product = ?",
    JSON.stringify({
      config: {},
      secrets: {},
      entitlements: Object.fromEntries(granted),
    }),
    SLUG,
  );
}

/** The device's licence grants `bytes` of Cloud Sync storage (`pkey.cloudSync.bytes`). */
export const setQuota = (w: World, bytes: number): Promise<void> =>
  entitle(w, { "pkey.cloudSync.bytes": bytes });

/** `POST …/finalize` for an upload. */
export const finalize = (
  w: FilesWorld,
  collection: string,
  id: string,
  uploadId: string,
): Promise<Response> =>
  call(w, "POST", filesPath(collection, id, "finalize"), {
    json: { uploadId },
  });

/** Rows of a query on the person's object (the SQL is the test's, never a request's). */
export function rows(w: World, sql: string): Record<string, unknown>[] {
  const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
  if (!inst) throw new Error("no object");
  return inst.storage.sql.db.prepare(sql).all() as Record<string, unknown>[];
}

/** The person's usage counters as the object keeps them. */
export function usageOf(w: World): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows(
    w,
    "SELECT key, value FROM meta WHERE key LIKE 'usage_%'",
  ))
    out[(r.key as string).replace(/^usage_/, "")] = Number(r.value);
  return out;
}

/** One upload session row, straight from the person's object. */
export function uploadRow(
  w: World,
  uploadId: string,
): Record<string, unknown> | undefined {
  return objectDb(w)
    .prepare(`SELECT * FROM uploads WHERE upload_id = '${uploadId}'`)
    .get() as Record<string, unknown> | undefined;
}

/** The `error.code` of a nested wire error body. */
export const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

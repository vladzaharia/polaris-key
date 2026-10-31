/**
 * Harness for the Cloud Sync file routes (U-10.5 on): the real dispatch pipeline, the real
 * `CloudSyncDO` over the SQLite mock, and an `R2Mock` standing in for `SYNC_FILES`, on a product
 * whose catalog declares the collections below. Server mode (`enc: "none"`), the launch gate on.
 */
import { createHash } from "node:crypto";
import type {
  BeginFileResponse,
  FinalizeResponse,
} from "@polaris-key/protocol/sync";
import { expect } from "vitest";
import { dispatch } from "../../../src/dispatch.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { syncLimiterShard } from "../../../src/services/sync/limits.js";
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
  // The alarm writes the directory to D1: a stub that takes the batch (the directory has its own tests).
  (w.ns as unknown as { opts: { db?: unknown } }).opts.db = () => ({
    batch: async () => undefined,
    batchChanges: async (s: unknown[]) => s.map(() => 1),
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

/**
 * The rate limiter's Durable Object is down: every call rejects (file reads proceed, file writes
 * answer 503). Returns a function that brings the limiter back.
 */
export function breakLimiter(w: Pick<World, "env">): () => void {
  const up = w.env.RL;
  const down = { fetch: () => Promise.reject(new Error("object reset")) };
  const ns = { idFromName: (name: string) => ({ name }), get: () => down };
  w.env.RL = ns as unknown as DurableObjectNamespace;
  return () => {
    w.env.RL = up;
  };
}

/** Counts the R2 calls that create state (an object, an upload, a part) while `run` executes. */
export async function r2Writes(
  w: Pick<World, "env">,
  run: () => Promise<void>,
): Promise<number> {
  const r2 = w.env.SYNC_FILES as unknown as Record<string, unknown>;
  let n = 0;
  const wrap = (name: string): (() => void) => {
    const orig = r2[name] as (...a: unknown[]) => unknown;
    r2[name] = (...a: unknown[]) => {
      n++;
      return orig.apply(r2, a);
    };
    return () => {
      r2[name] = orig;
    };
  };
  const undo = ["put", "createMultipartUpload", "resumeMultipartUpload"].map(
    wrap,
  );
  try {
    await run();
  } finally {
    for (const u of undo) u();
  }
  return n;
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

/** A file stored on a record through the routes: begin, a single `PUT`, finalize. */
export async function stored(
  w: FilesWorld,
  collection: string,
  id: string,
  bytes: Uint8Array,
  over: Partial<BeginBody> = {},
): Promise<FinalizeResponse> {
  const res = await begin(w, collection, id, beginBody(bytes, over));
  expect(res.status).toBe(200);
  const up = (await res.json()) as BeginFileResponse;
  expect(
    (await putBytes(w, uploadPath(collection, id, up.uploadId), bytes)).status,
  ).toBe(204);
  const done = await finalize(w, collection, id, up.uploadId);
  expect(done.status).toBe(200);
  return (await done.json()) as FinalizeResponse;
}

/** The world's device now belongs to another person (Bob); the first person's data stays put. */
export async function becomeBob(w: Pick<World, "db" | "env">): Promise<void> {
  const r = await signIn(
    w.db,
    { issuerKey: "email", subject: "bob@example.com", kind: "email" },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  expect(
    await setDeviceSubject(w.env, w.db, SLUG, "dev-attack-1", r.subject!),
  ).toBe(true);
}

/** Spends `spend` of a device's allowance in a limiter bucket of `limit` per `windowSec`, at `NOW`. */
export async function spendLimit(
  w: Pick<World, "env" | "subject">,
  bucket: "syncFilesDevice" | "syncParts",
  spend: number,
  limit: number,
  windowSec: number,
): Promise<void> {
  const shard = syncLimiterShard(SLUG, w.subject);
  for (let i = 0; i < spend; i++)
    expect(
      await rateLimitOk(
        w.env,
        shard,
        { bucket, id: "dev-attack-1", limit, windowSec },
        NOW,
      ),
    ).toBe(true);
}

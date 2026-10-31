/// <reference types="@cloudflare/workers-types" />

/**
 * The chunk routes of a delta file (U-37; WIRE-CONTRACT-V5 §13.8.2, §13.8.3), under
 * `/<product>/sync/files/{collection}/{id}/upload/{uploadId}`:
 *
 *   POST …/chunks             the plan call: which named chunks the collection stores        (U-37.2)
 *   PUT  …/chunks/{chunkId}   one chunk object, create-only                                  (U-37.3)
 *
 * and, under `/<product>/sync/files/{collection}/chunks/{chunkId}`, the read of a chunk (U-37.3).
 *
 * The front door is the file routes' own (`fileHandler`): the gate, the principal, the pause, the
 * 600 a minute limit and device trust. The object owns every session and chunk row; the Worker
 * checks only shapes, and streams the bytes. The server never reads a chunk object: it checks
 * length and digest, and a reader checks the id against the plaintext.
 */

import {
  SYNC_CHUNK_MAX_STORED_BYTES,
  SYNC_CHUNK_PLAN_MAX_IDS,
  type ChunkPlanRequest,
  type ChunkPlanResponse,
} from "@polaris-key/protocol/sync";
import { matchCollection } from "@polaris-key/catalog";
import type { ServiceContext } from "../../../core/registry.js";
import type { RouteMatch } from "../../../core/http/routes.js";
import { checksumHex } from "../../../core/assets/blobs.js";
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import { callCloudSync } from "../do/client.js";
import {
  fileCall,
  fileHandler,
  readCatalog,
  withObject,
  type FileCall,
} from "./files.js";
import { fixedLength, parseContentDigest } from "./fileStream.js";
import { liveRefusal, overCeiling, retryable } from "./common.js";

const NO_STORE = { "cache-control": "no-store" } as const;

const HEX64 = /^[0-9a-f]{64}$/;
/** 1,024 entries of about 85 bytes each, with room to spare. */
const PLAN_BODY_CAP = 131_072;

/** The plan body, or null when it is not one: `{chunks: [[id, storedBytes], …]}`, ids distinct. */
function parsePlan(v: unknown): ChunkPlanRequest | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const list = (v as { chunks?: unknown }).chunks;
  if (
    !Array.isArray(list) ||
    list.length < 1 ||
    list.length > SYNC_CHUNK_PLAN_MAX_IDS
  )
    return null;
  const seen = new Set<string>();
  const chunks: ChunkPlanRequest["chunks"] = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [id, bytes] = entry as [unknown, unknown];
    if (
      typeof id !== "string" ||
      !HEX64.test(id) ||
      seen.has(id) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > SYNC_CHUNK_MAX_STORED_BYTES
    )
      return null;
    seen.add(id);
    chunks.push([id, bytes]);
  }
  return { chunks };
}

export const handleChunkPlan = fileHandler(
  {
    method: "POST",
    write: true,
    limiter: "parts",
    body: { cap: PLAN_BODY_CAP, parse: parsePlan },
  },
  chunkPlan,
);

async function chunkPlan(
  ctx: ServiceContext,
  match: RouteMatch,
  call: FileCall,
  request: ChunkPlanRequest,
): Promise<Response> {
  const { env, db, product } = ctx;
  const { caller, collection, id } = call;

  const gone = await liveRefusal(env, db, product.slug);
  if (gone) return gone;
  const loaded = await readCatalog(ctx);
  if (loaded instanceof Response) return loaded;
  const decl = matchCollection(loaded.catalog, collection);
  if (decl === null) return wireError(400, "collection_unknown");
  const ceilings = await overCeiling(ctx);

  const out = await withObject(ctx, caller, (pin, c) =>
    callCloudSync<"fileChunkPlan">(env, pin, {
      op: "fileChunkPlan",
      collection,
      recordId: id,
      uploadId: match.params.uploadId as string,
      chunks: request.chunks,
      maxBytes: decl.files.maxBytes,
      limits: {
        quotaBytes: c.access.quota.bytes,
        ...(ceilings.bytes ? { productOverCeiling: true } : {}),
        ...(ceilings.users ? { usersAtCeiling: true } : {}),
      },
      serverNow: ctx.now * 1000,
    }),
  );
  if (out instanceof Response) return out;
  const r = out.value.outcome;
  if (r.ok) {
    const body: ChunkPlanResponse = { missing: r.missing, present: r.present };
    return json(body);
  }
  if ("mismatch" in r) return wireError(400, "upload_mismatch");
  if (r.error === "upload_expired") return wireError(410, "upload_expired");
  if (r.error === "not_found") return notFound();
  if (r.error === "file_too_large") return wireError(413, "file_too_large");
  if (r.error === "quota_exceeded")
    return wireError(403, "quota_exceeded", { scope: r.scope });
  return wireError(400, ErrorCode.BadRequest);
}

// ── PUT …/upload/{uploadId}/chunks/{chunkId} ─────────────────────────────────────────────────

/** A non-negative integer `Content-Length`, or null for a missing or malformed one. */
function contentLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^[0-9]{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The body is never read on a refusal: say so, so the connection is not held for it. */
async function refuse(req: Request, res: Response): Promise<Response> {
  await req.body?.cancel().catch(() => undefined);
  return res;
}

/**
 * One chunk object, create-only. The order is the part `PUT`'s: the front door, the headers against
 * the cap, the session against the plan (an id the plan answered `missing`, and the exact size it
 * declared), and only then the bytes, streamed to R2 with the digest as the store's checksum. The
 * object records the chunk after R2 took it.
 */
export async function handleChunkPut(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const { req, env } = ctx;
  if (req.method !== "PUT") return wireError(405, "method_not_allowed");
  const call = await fileCall(ctx, match, { write: true, limiter: "parts" });
  if (call instanceof Response) return refuse(req, call);

  // Headers against the cap, before the object is asked anything.
  const length = contentLength(req);
  if (length !== null && length > SYNC_CHUNK_MAX_STORED_BYTES)
    return refuse(req, wireError(413, "body_too_large"));
  const digest = parseContentDigest(req.headers.get("content-digest"));
  if (length === null || length < 1 || digest === null)
    return refuse(req, wireError(400, "upload_mismatch"));

  const chunkId = match.params.chunkId as string;
  const address = {
    collection: call.collection,
    recordId: call.id,
    uploadId: match.params.uploadId as string,
    chunkId,
    serverNow: ctx.now * 1000,
  };
  const prepared = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"chunkPrepare">(env, pin, { op: "chunkPrepare", ...address }),
  );
  if (prepared instanceof Response) return refuse(req, prepared);
  const out = prepared.value.outcome;
  if (!out.ok) {
    if ("mismatch" in out)
      return refuse(req, wireError(400, "upload_mismatch"));
    return refuse(
      req,
      out.error === "upload_expired"
        ? wireError(410, "upload_expired")
        : notFound(),
    );
  }
  // Present, or landed already: a resend of a chunk the upload holds stores nothing.
  if (out.have) {
    await req.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 204, headers: NO_STORE });
  }
  if (length !== out.bytes)
    return refuse(req, wireError(400, "upload_mismatch"));

  const bucket = env.SYNC_FILES as R2Bucket;
  try {
    const put = await bucket.put(
      out.key,
      fixedLength(req.body as ReadableStream<Uint8Array>, out.bytes),
      {
        sha256: digest,
        onlyIf: new Headers({ "If-None-Match": "*" }),
        // A server-mode chunk is stored under the person's key (SSE-C, D-8), like a server-mode file.
        ...(out.ssecKey !== undefined ? { ssecKey: out.ssecKey } : {}),
      },
    );
    if (put === null) {
      // The object is there already: a resend that landed, or a concurrent upload of the same
      // chunk. It stands only if it is this very object (create-only means nothing replaced it).
      const head = await bucket.head(out.key);
      if (!head || head.size !== out.bytes || checksumHex(head) !== digest)
        return wireError(400, "upload_mismatch");
    }
  } catch {
    try {
      await bucket.head(out.key);
    } catch {
      return retryable();
    }
    return wireError(400, "upload_mismatch");
  }

  const saved = await withObject(ctx, prepared.caller, (pin) =>
    callCloudSync<"chunkStored">(env, pin, {
      op: "chunkStored",
      ...address,
      bytes: out.bytes,
    }),
  );
  if (saved instanceof Response) return saved;
  // The session closed while the bytes were on their way: the object has its row, and the
  // collector takes it. The caller is told as for any call on a closed session.
  if (!saved.value.outcome.ok) return notFound();
  return new Response(null, { status: 204, headers: NO_STORE });
}

// ── GET …/files/{collection}/chunks/{chunkId} ────────────────────────────────────────────────

/**
 * One chunk object, as stored. The object answers only for a chunk some file of that collection
 * references (the existence of anything else is not told: `404`, whatever the reason). One of the
 * 600 requests a minute. `attachment`, `nosniff`, `no-store`, with the stored object's SHA-256 as
 * its `ETag`.
 */
export async function handleChunkGet(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const { env, req } = ctx;
  if (req.method !== "GET") return wireError(405, "method_not_allowed");
  const call = await fileCall(ctx, match, { write: false, limiter: "parts" });
  if (call instanceof Response) return call;
  const resolved = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"chunkResolve">(env, pin, {
      op: "chunkResolve",
      collection: call.collection,
      chunkId: match.params.chunkId as string,
    }),
  );
  if (resolved instanceof Response) return resolved;
  const out = resolved.value.outcome;
  if (!out.ok) return notFound();

  let obj: R2ObjectBody | R2Object | null;
  try {
    obj = await (env.SYNC_FILES as R2Bucket).get(
      out.key,
      out.ssecKey !== undefined ? { ssecKey: out.ssecKey } : undefined,
    );
  } catch {
    return retryable();
  }
  // The row says the object is there and this long; if it is not, nothing is sent.
  if (!obj || !("body" in obj) || obj.size !== out.size)
    return wireError(500, "internal_error");
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": "attachment",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-length": String(out.size),
  });
  const sum = checksumHex(obj);
  if (sum !== null) headers.set("etag", `"${sum}"`);
  return new Response(obj.body, { status: 200, headers });
}

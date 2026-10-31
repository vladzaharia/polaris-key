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
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import { callCloudSync } from "../do/client.js";
import {
  fileHandler,
  readCatalog,
  withObject,
  type FileCall,
} from "./files.js";
import { liveRefusal, overCeiling } from "./common.js";

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

/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Sync file routes (U-10; WIRE-CONTRACT-V5 §13.2, §13.8), under
 * `/<product>/sync/files/{collection}/{id}`:
 *
 *   POST   …/begin                       open an upload session and reserve its bytes     (U-10.5)
 *   GET    …/upload/{uploadId}           the resume answer                                (U-10.5)
 *   DELETE …/upload/{uploadId}           abort the session, release the reservation       (U-10.5)
 *
 * ── THE ORDER (each step refuses before the next costs anything) ─────────────────────────────
 *
 *   1. The gate: the Worker has a file store AND `launch.syncFiles` is on, else `404`, whatever
 *      the caller holds. Config and Identity on (`404` otherwise).
 *   2. The bearer, the device header, the principal (`401`, `400`, `403 account_required`).
 *   3. A write only: `cloudSync.writesPaused` (`503`), then the device trust check
 *      (`cloudSyncWrite`).
 *   4. The limiter: `begin` is one of 30 transfers a device an hour, every other call one of 600
 *      requests a minute (`429 rate_limited`, both fail open).
 *   5. `begin` only: the body, then the plan's §2.3 checks 1 to 4 against the catalog (the object
 *      makes 5 to 7 against stored state).
 *
 * The object's refusals are never copied: `410 absorbed` re-resolves the principal and retries
 * once, and every other object failure is mapped by `objectFailure`. R2 keys come from the
 * object's session rows, never from the request path.
 */

import {
  SYNC_KEY_PATTERN,
  type BeginFileRequest,
  type BeginFileResponse,
} from "@polaris-key/protocol/sync";
import { Catalog, matchCollection } from "@polaris-key/catalog";
import type { ServiceContext } from "../../../core/registry.js";
import type { RouteMatch } from "../../../core/http/routes.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import { resolveSubject } from "../../../core/accounts/accountSubjects.js";
import { syncAccess } from "../../../core/accounts/syncAccess.js";
import { getDevice } from "../../../core/devices/store.js";
import { getActiveSchema } from "../../../core/products/store.js";
import { randomToken } from "../../../platform/random.js";
import { trustRefusal } from "../../../core/trust/deviceTrust.js";
import { callCloudSync } from "../do/client.js";
import type { DoPin } from "../do/protocol.js";
import { syncTransferPlan } from "../engine/files.js";
import { isBlinded } from "../engine/sealed.js";
import { filesLimited, partsLimited } from "../limits.js";
import {
  accountRequired,
  fileStoreOn,
  isAbsorbed,
  liveRefusal,
  objectFailure,
  overCeiling,
  pausedRefusal,
  retryable,
  syncCaller,
  syncMode,
  type SyncCaller,
} from "./common.js";

/** A `begin` body is a handful of members; this is far above any honest one. */
const BEGIN_BODY_CAP = 4096;
const HEX64 = /^[0-9a-f]{64}$/;

/** The route's `:param` constraints (a segment that fails is no route at all). */
export const FILE_PARAMS = {
  collection: new RegExp(SYNC_KEY_PATTERN),
  id: new RegExp(SYNC_KEY_PATTERN),
  uploadId: /^up_[A-Za-z0-9_-]{22}$/,
  // Digits only; whether the number lies in the file's range is a `400` the handler answers.
  n: /^[0-9]{1,9}$/,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `begin` body, or null when it is not one. Only the wire members go on. */
function parseBegin(v: unknown): BeginFileRequest | null {
  if (!isRecord(v)) return null;
  const { size, sha256, format, enc, baseVersion } = v;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    return null;
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) return null;
  if (format !== "whole" && format !== "chunks") return null;
  if (enc !== "e2e" && enc !== "none") return null;
  if (
    baseVersion !== undefined &&
    baseVersion !== "*" &&
    !(
      typeof baseVersion === "number" &&
      Number.isSafeInteger(baseVersion) &&
      baseVersion >= 0
    )
  )
    return null;
  return {
    size,
    sha256,
    format,
    enc,
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

/** What every file route resolves before its own work. */
export interface FileCall {
  caller: SyncCaller;
  collection: string;
  id: string;
}

/**
 * Steps 1 to 4. `write` marks the calls that change state (`begin` here; the part and `finalize`
 * routes of U-10.6 and .7): they honour the pause and the trust policy. `limiter` picks the bucket.
 */
export async function fileCall(
  ctx: ServiceContext,
  match: RouteMatch,
  opts: { write: boolean; limiter: "files" | "parts" },
): Promise<FileCall | Response> {
  const { env, db, product, now } = ctx;
  if (!(await fileStoreOn(env, db))) return notFound();
  const caller = await syncCaller(ctx);
  if (caller instanceof Response) return caller;

  if (opts.write) {
    const paused = await pausedRefusal(env, db);
    if (paused) return paused;
  }
  const limit = opts.limiter === "files" ? filesLimited : partsLimited;
  const limited = await limit(
    env,
    product.slug,
    caller.access.subject,
    caller.device.device_id,
    now,
  );
  if (limited) return limited;

  if (opts.write) {
    const refused = await trustRefusal(
      env,
      db,
      product,
      caller.device,
      "cloudSyncWrite",
      now,
      "wire",
    );
    if (refused) return refused;
  }
  return {
    caller,
    collection: match.params.collection as string,
    id: match.params.id as string,
  };
}

/**
 * A file route's handler: the method gate and the front door (`fileCall`) in front of `run`, which
 * receives the resolved caller. Every file route is built with it, so none can skip a step.
 */
export function fileHandler<T = undefined>(
  opts: {
    method: "POST" | "GET" | "PUT" | "DELETE";
    write: boolean;
    limiter: "files" | "parts";
    /** A JSON body under `cap` bytes, `parse`d to `T` (null: `400 bad_request`). */
    body?: { cap: number; parse: (v: unknown) => T | null };
  },
  run: (
    ctx: ServiceContext,
    match: RouteMatch,
    call: FileCall,
    body: T,
  ) => Promise<Response>,
): (ctx: ServiceContext, match: RouteMatch) => Promise<Response> {
  return async (ctx, match) => {
    if (ctx.req.method !== opts.method)
      return wireError(405, "method_not_allowed");
    const call = await fileCall(ctx, match, opts);
    if (call instanceof Response) return call;
    if (!opts.body) return run(ctx, match, call, undefined as T);
    const raw = await readJsonBody(ctx.req, opts.body.cap);
    if (raw instanceof Response) return raw;
    const body = opts.body.parse(raw);
    return body === null
      ? wireError(400, ErrorCode.BadRequest)
      : run(ctx, match, call, body);
  };
}

/**
 * Calls the person's object. A `410 absorbed` (the subject was merged away while the request ran)
 * re-resolves the principal and tries once more; a device that now belongs to someone else, or to
 * a subject the old one was not merged into, is `account_required`, exactly as the push does.
 */
export async function withObject<T>(
  ctx: ServiceContext,
  caller: SyncCaller,
  call: (pin: DoPin, caller: SyncCaller) => Promise<T>,
): Promise<{ value: T; caller: SyncCaller } | Response> {
  const { env, db, product, req, now } = ctx;
  let current = caller;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pin = { product: product.slug, subject: current.access.subject };
      return { value: await call(pin, current), caller: current };
    } catch (e) {
      if (!isAbsorbed(e)) return objectFailure(e);
      const device = await getDevice(
        db,
        product.slug,
        current.device.device_id,
      );
      const again = device
        ? await syncAccess(env, db, product, device, now)
        : null;
      if (again === null) return await accountRequired(env, db, req, product);
      if (
        again.subject !== current.access.subject &&
        (await resolveSubject(db, product.slug, current.access.subject)) !==
          again.subject
      )
        return await accountRequired(env, db, req, product);
      current = { ...current, access: again };
    }
  }
  return retryable();
}

/** The product's active catalog, or a `503` when it cannot be read (it cannot classify). */
export async function readCatalog(
  ctx: ServiceContext,
): Promise<
  { catalog: Catalog | null; row: { catalog_json: string } | null } | Response
> {
  const row = await getActiveSchema(ctx.db, ctx.product.slug);
  if (!row) return { catalog: null, row: null };
  try {
    return { catalog: new Catalog(JSON.parse(row.catalog_json)), row };
  } catch {
    return retryable();
  }
}

const NO_STORE = { "cache-control": "no-store" } as const;

/** A JSON body under `cap` bytes: the value, or the `413`/`400` to answer with. */
export async function readJsonBody(
  req: Request,
  cap: number,
): Promise<unknown | Response> {
  let text: string;
  try {
    text = await readBodyText(req, cap);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return wireError(413, "body_too_large");
    throw e;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return wireError(400, ErrorCode.BadRequest);
  }
}

// ── POST …/begin ─────────────────────────────────────────────────────────────────────────────

export const handleFileBegin = fileHandler(
  {
    method: "POST",
    write: true,
    limiter: "files",
    body: { cap: BEGIN_BODY_CAP, parse: parseBegin },
  },
  fileBegin,
);

async function fileBegin(
  ctx: ServiceContext,
  _match: RouteMatch,
  call: FileCall,
  request: BeginFileRequest,
): Promise<Response> {
  const { env, db, product } = ctx;
  const { caller, collection, id } = call;

  // §2.3 checks 1 to 4, against the catalog.
  const loaded = await readCatalog(ctx);
  if (loaded instanceof Response) return loaded;
  const decl = matchCollection(loaded.catalog, collection);
  if (decl === null) return wireError(400, "collection_unknown");
  const entitlements = caller.access.entitlements;
  if (
    !caller.access.quota.files ||
    (decl.requires !== null &&
      !(
        Object.hasOwn(entitlements, decl.requires) &&
        entitlements[decl.requires] === true
      ))
  )
    return wireError(403, "entitlement_required");
  const mode = await syncMode(env, db, product.slug, loaded.row);
  const sealed = mode.serve === "e2e";
  if (request.enc !== (sealed ? "e2e" : "none") || (sealed && !isBlinded(id)))
    return wireError(400, "encryption_mismatch");
  // The chunks mode is U-37's: until it lands, a chunked file is not a request this Worker serves.
  if (request.format === "chunks") return wireError(400, ErrorCode.BadRequest);
  if (request.size > decl.files.maxBytes)
    return wireError(413, "file_too_large");
  // A whole file never takes the chunks mode, so the plan is read as for a collection without delta.
  const plan = syncTransferPlan(request.size, false);
  if (plan.mode === "too_large") return wireError(413, "file_too_large");
  if (plan.mode === "chunks") return wireError(400, ErrorCode.BadRequest);

  // The product is live and not being erased, and its ceilings (read right before the object).
  const gone = await liveRefusal(env, db, product.slug);
  if (gone) return gone;
  const ceilings = await overCeiling(ctx);

  const uploadId = `up_${randomToken(16)}`;
  const out = await withObject(ctx, caller, (pin, c) =>
    callCloudSync<"fileBegin">(env, pin, {
      op: "fileBegin",
      uploadId,
      deviceId: c.device.device_id,
      collection,
      recordId: id,
      request,
      mode: plan.mode,
      ...(plan.mode === "multipart" ? { partBytes: plan.partBytes } : {}),
      maxRecords: decl.maxRecords,
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
    const body: BeginFileResponse = {
      uploadId: r.uploadId,
      mode: r.mode,
      ...(r.partBytes !== undefined ? { partBytes: r.partBytes } : {}),
      expiresAt: r.expiresAt,
    };
    return json(body);
  }
  if (r.error === "revision_conflict")
    return wireError(409, "revision_conflict", {
      server: { version: r.version },
    });
  if (r.error === "rate_limited") {
    const res = wireError(429, "rate_limited");
    res.headers.set("retry-after", "60");
    return res;
  }
  return wireError(403, "quota_exceeded", { scope: r.scope });
}

// ── GET and DELETE …/upload/{uploadId} ───────────────────────────────────────────────────────

/** A session call (`fileStatus` or `fileAbort`): the same address, the same limiter, no write. */
async function sessionCall<O extends "fileStatus" | "fileAbort">(
  ctx: ServiceContext,
  match: RouteMatch,
  op: O,
) {
  const call = await fileCall(ctx, match, { write: false, limiter: "parts" });
  if (call instanceof Response) return call;
  return withObject(ctx, call.caller, (pin) =>
    callCloudSync<O>(ctx.env, pin, {
      op,
      collection: call.collection,
      recordId: call.id,
      uploadId: match.params.uploadId as string,
      serverNow: ctx.now * 1000,
    } as Parameters<typeof callCloudSync<O>>[2]),
  );
}

export async function handleUploadStatus(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const out = await sessionCall(ctx, match, "fileStatus");
  if (out instanceof Response) return out;
  const r = out.value.outcome;
  if (r.ok) return json(r.status);
  return r.error === "upload_expired"
    ? wireError(410, "upload_expired")
    : notFound();
}

export async function handleUploadAbort(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const out = await sessionCall(ctx, match, "fileAbort");
  if (out instanceof Response) return out;
  return out.value.outcome.ok
    ? new Response(null, { status: 204, headers: NO_STORE })
    : notFound();
}

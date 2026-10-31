/// <reference types="@cloudflare/workers-types" />

/**
 * The read routes of a record's file (U-10.8; WIRE-CONTRACT-V5 §13.2, §13.8, plans/U-10-U-11a-slices.md
 * §2.5):
 *
 *   GET …/files/{collection}/{id}[?version=]   the stored file
 *   GET …/files/{collection}/{id}/revisions    the kept older versions
 *
 * ── THE ORDER (each step refuses before the next costs anything) ─────────────────────────────
 *
 *   1. The file routes' front door (`fileCall`): the gate, the principal, the limiter. A whole-file
 *      `GET` is one of 30 transfers a device an hour; a request for one byte range is one of 600
 *      requests a minute. A range that turns out to be the whole file is charged as the transfer it
 *      is (step 4), so `Range: bytes=0-` is no way round the hourly limit.
 *   2. `?version=` is a positive integer, else `400 bad_request`.
 *   3. The object resolves the file from its own rows: the R2 key, the size and the hash. The
 *      request names a record and a version and nothing else; no key, prefix or bucket is ever read
 *      from it, so one person cannot ask for another's bytes. A record with no such file, a deleted
 *      one, a file waiting to be collected and a parked one are `404`.
 *   4. `Range` (RFC 9110 §14.2): a single `bytes` range, clamped to the file. One that starts past
 *      the end is `416` with the unsatisfied `Content-Range` (the file's size); one that is malformed or lists several
 *      ranges is ignored and the whole file is served. `If-Range` with any validator but this
 *      file's strong ETag also serves the whole file, so a resumed download never splices versions.
 *   5. The bytes stream from R2 to the caller; nothing is buffered.
 *
 * Every answer is `no-store`. The bytes are served as `application/octet-stream`, `attachment`,
 * `nosniff`: they are an app's data (ciphertext in E2E mode), never a page. No public, presigned
 * or `r2.dev` URL exists; this route is the only way out.
 */

import type { FileRevisionsResponse } from "@polaris-key/protocol/sync";
import type { ServiceContext } from "../../../core/registry.js";
import type { RouteMatch } from "../../../core/http/routes.js";
import { parseRange, reprDigest } from "../../../core/assets/blobs.js";
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import { callCloudSync } from "../do/client.js";
import { filesLimited } from "../limits.js";
import { fileCall, withObject } from "./files.js";
import { retryable } from "./common.js";

/**
 * Whether `Range` is one usable `bytes` range whatever the file's size: the cases `parseRange`
 * answers null for on any size are not. Those are served whole, so they are whole-file transfers.
 */
function isByteRange(header: string | null): boolean {
  if (!header) return false;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return false;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return false;
  return !(a !== "" && b !== "" && Number(b) < Number(a));
}

/** `?version=`: absent is `undefined`; a positive integer is itself; anything else is `null`. */
function versionOf(req: Request): number | undefined | null {
  const raw = new URL(req.url).searchParams.get("version");
  if (raw === null) return undefined;
  if (!/^[0-9]{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

// ── GET …/files/{collection}/{id} ────────────────────────────────────────────────────────────

export async function handleFileGet(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const { env, req, product, now } = ctx;
  if (req.method !== "GET") return wireError(405, "method_not_allowed");
  const ranged = isByteRange(req.headers.get("range"));
  const call = await fileCall(ctx, match, {
    write: false,
    limiter: ranged ? "parts" : "files",
  });
  if (call instanceof Response) return call;
  const version = versionOf(req);
  if (version === null) return wireError(400, ErrorCode.BadRequest);

  const resolved = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"fileResolve">(env, pin, {
      op: "fileResolve",
      collection: call.collection,
      recordId: call.id,
      ...(version !== undefined ? { version } : {}),
    }),
  );
  if (resolved instanceof Response) return resolved;
  const out = resolved.value.outcome;
  if (!out.ok) return notFound();
  const file = out.file;

  const etag = `"${file.sha256}"`;
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": "attachment",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    etag,
    "repr-digest": reprDigest(file.sha256),
    "accept-ranges": "bytes",
  });

  // A validator that is not exactly this strong ETag means "send the whole thing".
  const ifRange = req.headers.get("if-range");
  const rangeHeader =
    ifRange === null || ifRange.trim() === etag
      ? req.headers.get("range")
      : null;
  const range = parseRange(rangeHeader, file.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.size}`);
    headers.delete("content-type");
    headers.delete("content-disposition");
    return new Response(null, { status: 416, headers });
  }
  // A range that is the whole file is a whole-file transfer: it spends the hourly allowance too.
  if (range && range.offset === 0 && range.length === file.size) {
    const limited = await filesLimited(
      env,
      product.slug,
      resolved.caller.access.subject,
      resolved.caller.device.device_id,
      now,
    );
    if (limited) return limited;
  }

  const length = range ? range.length : file.size;
  const status = range ? 206 : 200;
  headers.set("content-length", String(length));
  if (range)
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
    );

  const bucket = env.SYNC_FILES as R2Bucket;
  let obj: R2ObjectBody | R2Object | null;
  try {
    obj = await bucket.get(file.key, {
      ...(range ? { range } : {}),
      ...(file.ssecKey !== undefined ? { ssecKey: file.ssecKey } : {}),
    });
  } catch {
    return retryable();
  }
  // The row says the object is there and this long. If it is not, the bytes are lost or wrong, and
  // nothing is sent under this ETag and digest.
  if (!obj || !("body" in obj) || obj.size !== file.size)
    return wireError(500, "internal_error");
  return new Response(obj.body, { status, headers });
}

// ── GET …/files/{collection}/{id}/revisions ──────────────────────────────────────────────────

export async function handleFileRevisions(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  if (ctx.req.method !== "GET") return wireError(405, "method_not_allowed");
  const call = await fileCall(ctx, match, { write: false, limiter: "parts" });
  if (call instanceof Response) return call;
  const out = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"fileRevisions">(ctx.env, pin, {
      op: "fileRevisions",
      collection: call.collection,
      recordId: call.id,
    }),
  );
  if (out instanceof Response) return out;
  const body: FileRevisionsResponse = {
    revisions: out.value.outcome.revisions,
  };
  return json(body);
}

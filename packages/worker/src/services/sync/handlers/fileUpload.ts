/// <reference types="@cloudflare/workers-types" />

/**
 * The byte routes of a file upload (U-10.6; WIRE-CONTRACT-V5 §13.8.1, plans/U-10-U-11a-slices.md
 * §2.2):
 *
 *   PUT …/upload/{uploadId}             mode `single`: the whole file
 *   PUT …/upload/{uploadId}/parts/{n}   mode `multipart`: part `n`, from 1
 *
 * The Worker streams; the object owns the session. Nothing is buffered, and the server never reads
 * a file's content: it checks only size and SHA-256 (D-6, GF7).
 *
 * ── THE ORDER (each step refuses before the next costs anything) ─────────────────────────────
 *
 *   1. The file routes' front door (`fileCall`): the gate, the principal, the pause, the 600 a
 *      minute limit, device trust.
 *   2. The headers, before the object: `Content-Length` over 16 MiB on a single `PUT` is `413
 *      body_too_large`; a missing `Content-Length` or `Content-Digest` is `400 upload_mismatch`.
 *   3. The session (`filePrepare`): unknown, ended or another record's is `404`; past 24 hours
 *      `410 upload_expired`. Then the request against it, still without reading a byte: the route
 *      must match the session's mode, a part number must lie in `1…⌈size / partBytes⌉`, the length
 *      must be exactly the part's (the last is shorter) or the file's, and a single `PUT`'s digest
 *      must be the one `begin` declared. Any miss is `400 upload_mismatch`.
 *   4. The bytes, streamed. A single `PUT` goes to R2 with `sha256` as the put option and
 *      create-only, so R2 itself refuses bytes that do not hash to the declared value and nothing is
 *      stored. A part is hashed with a `DigestStream` on its way to `uploadPart` and compared with
 *      its `Content-Digest` afterwards; a part that does not verify is forgotten, because R2 may
 *      have replaced a good part of the same number with it.
 *   5. The object records the part. A session that closed meanwhile takes nothing, and a single
 *      object that landed in that window is deleted.
 */

import { SYNC_SINGLE_PUT_MAX_BYTES } from "@polaris-key/protocol/sync";
import type { ServiceContext } from "../../../core/registry.js";
import type { RouteMatch } from "../../../core/http/routes.js";
import { checksumHex } from "../../../core/assets/blobs.js";
import { notFound, wireError } from "../../../core/errors.js";
import { callCloudSync } from "../do/client.js";
import type { FilePrepareOutcome } from "../do/protocol.js";
import { fileCall, withObject, type FileCall } from "./files.js";
import { fixedLength, hashBody, parseContentDigest } from "./fileStream.js";
import { retryable } from "./common.js";

const NO_STORE = { "cache-control": "no-store" } as const;

type Prepared = Extract<FilePrepareOutcome, { ok: true }>;

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

/** R2 refused or failed a write: a bad body when the store itself answers, else try again. */
async function storeFailure(bucket: R2Bucket, key: string): Promise<Response> {
  try {
    await bucket.head(key);
  } catch {
    return retryable();
  }
  return wireError(400, "upload_mismatch");
}

/**
 * The session a byte request streams against, or the response to send. `part` is the part number
 * of a multipart route, `null` for the single `PUT`.
 */
async function session(
  ctx: ServiceContext,
  match: RouteMatch,
  part: number | null,
): Promise<{ prep: Prepared; call: FileCall } | Response> {
  const call = await fileCall(ctx, match, { write: true, limiter: "parts" });
  if (call instanceof Response) return call;
  const prepared = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"filePrepare">(ctx.env, pin, {
      op: "filePrepare",
      collection: call.collection,
      recordId: call.id,
      uploadId: match.params.uploadId as string,
      serverNow: ctx.now * 1000,
    }),
  );
  if (prepared instanceof Response) return prepared;
  const out = prepared.value.outcome;
  if (!out.ok)
    return out.error === "upload_expired"
      ? wireError(410, "upload_expired")
      : notFound();
  // The route against the session's mode: a part belongs to a multipart session, the whole to a single one.
  if ((part === null) !== (out.mode === "single"))
    return wireError(400, "upload_mismatch");
  return { prep: out, call: { ...call, caller: prepared.caller } };
}

/** What the object records and the Worker answers once the bytes are in. */
async function recorded(
  ctx: ServiceContext,
  match: RouteMatch,
  call: FileCall,
  part: { n: number; etag?: string; bytes?: number },
): Promise<boolean | Response> {
  const out = await withObject(ctx, call.caller, (pin) =>
    callCloudSync<"filePart">(ctx.env, pin, {
      op: "filePart",
      collection: call.collection,
      recordId: call.id,
      uploadId: match.params.uploadId as string,
      ...part,
      serverNow: ctx.now * 1000,
    }),
  );
  if (out instanceof Response) return out;
  return out.value.outcome.ok;
}

// ── PUT …/upload/{uploadId}: mode single ─────────────────────────────────────────────────────

export async function handleUploadPut(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const { req, env } = ctx;
  if (req.method !== "PUT") return wireError(405, "method_not_allowed");
  const s = await session(ctx, match, null);
  if (s instanceof Response) return refuse(req, s);
  const { prep, call } = s;

  // Headers against the session, before a byte is read.
  const length = contentLength(req);
  if (length !== null && length > SYNC_SINGLE_PUT_MAX_BYTES)
    return refuse(req, wireError(413, "body_too_large"));
  const digest = parseContentDigest(req.headers.get("content-digest"));
  if (length !== prep.size || digest !== prep.sha256)
    return refuse(req, wireError(400, "upload_mismatch"));

  const bucket = env.SYNC_FILES as R2Bucket;
  let etag: string;
  try {
    const body =
      prep.size === 0 || req.body === null
        ? new Uint8Array(0)
        : fixedLength(req.body, prep.size);
    const put = await bucket.put(prep.key, body, {
      sha256: prep.sha256,
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (put !== null) etag = put.etag;
    else {
      // The object is there already: a resend of a `PUT` that landed. It stands only if it is the
      // verified one (create-only means nothing replaced it).
      const head = await bucket.head(prep.key);
      if (!head || head.size !== prep.size || checksumHex(head) !== prep.sha256)
        return wireError(400, "upload_mismatch");
      etag = head.etag;
    }
  } catch {
    return storeFailure(bucket, prep.key);
  }

  const saved = await recorded(ctx, match, call, {
    n: 1,
    etag,
    bytes: prep.size,
  });
  if (saved instanceof Response) return saved;
  if (!saved) {
    // The session closed while the bytes were on their way; they belong to no one.
    await bucket.delete(prep.key).catch(() => undefined);
    return notFound();
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}

// ── PUT …/upload/{uploadId}/parts/{n}: mode multipart ────────────────────────────────────────

export async function handlePartPut(
  ctx: ServiceContext,
  match: RouteMatch,
): Promise<Response> {
  const { req, env } = ctx;
  if (req.method !== "PUT") return wireError(405, "method_not_allowed");
  const n = Number(match.params.n);
  const s = await session(ctx, match, Number.isSafeInteger(n) ? n : 0);
  if (s instanceof Response) return refuse(req, s);
  const { prep, call } = s;

  // The part number and length against the plan, then the digest header, before a byte is read.
  const partBytes = prep.partBytes as number;
  if (n < 1 || n > prep.parts)
    return refuse(req, wireError(400, "upload_mismatch"));
  const expected =
    n < prep.parts ? partBytes : prep.size - (prep.parts - 1) * partBytes;
  const digest = parseContentDigest(req.headers.get("content-digest"));
  if (contentLength(req) !== expected || digest === null)
    return refuse(req, wireError(400, "upload_mismatch"));

  const bucket = env.SYNC_FILES as R2Bucket;
  const forget = () => recorded(ctx, match, call, { n }).catch(() => undefined);
  let etag: string;
  try {
    const hashed = hashBody(req.body as ReadableStream<Uint8Array>);
    const uploaded = await bucket
      .resumeMultipartUpload(prep.key, prep.multipartId as string)
      .uploadPart(n, fixedLength(hashed.stream, expected));
    if ((await hashed.digest) !== digest) {
      await forget();
      return wireError(400, "upload_mismatch");
    }
    etag = uploaded.etag;
  } catch {
    await forget();
    return storeFailure(bucket, prep.key);
  }

  const saved = await recorded(ctx, match, call, { n, etag, bytes: expected });
  if (saved instanceof Response) return saved;
  return saved
    ? new Response(null, { status: 204, headers: NO_STORE })
    : notFound();
}

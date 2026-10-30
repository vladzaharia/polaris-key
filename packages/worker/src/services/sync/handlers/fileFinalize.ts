/// <reference types="@cloudflare/workers-types" />

/**
 * `POST …/finalize` (U-10.7; WIRE-CONTRACT-V5 §13.8.1, GF2 and GF3, plans/U-10-U-11a-slices.md
 * §2.2): the step that makes an upload a record's file.
 *
 *   1. The front door (`fileHandler`), then the body `{uploadId}`.
 *   2. The object `prepares`: the parts must all be there (`409 upload_incomplete` with `missing`),
 *      a multipart upload is completed in R2, and the session is claimed. A session that already
 *      finished answers its stored result: `finalize` is idempotent per `uploadId`, and a repeat
 *      charges nothing. One being finished by another call is a retryable `503`.
 *   3. The Worker streams the stored object through SHA-256 (about 1 s of CPU per GiB) and checks
 *      size and hash against what `begin` declared. A single upload's object carries the hash R2
 *      verified at the `PUT`, which stands in for the stream. A mismatch ends the upload, deletes
 *      the object and releases the reservation (`400 upload_mismatch`).
 *   4. The object `commits`: the record write. It re-checks `begin`'s `baseVersion` (`409
 *      revision_conflict` with the server's `version`: any write since is a conflict), takes the
 *      next store sequence for the record and the file, charges the bytes, releases the
 *      reservation and keeps the previous file as a revision. A refusal ends the upload.
 */

import type {
  FinalizeRequest,
  FinalizeResponse,
} from "@polaris-key/protocol/sync";
import { matchCollection } from "@polaris-key/catalog";
import type { ServiceContext } from "../../../core/registry.js";
import type { RouteMatch } from "../../../core/http/routes.js";
import { checksumHex, streamSha256 } from "../../../core/assets/blobs.js";
import { json, notFound, wireError } from "../../../core/errors.js";
import { b64urlEncode } from "../../../platform/bytes.js";
import { sha256 } from "../../../platform/hash.js";
import { callCloudSync } from "../do/client.js";
import {
  fileHandler,
  readCatalog,
  withObject,
  type FileCall,
} from "./files.js";
import { liveRefusal, retryable } from "./common.js";

const BODY_CAP = 1024;
const UPLOAD_ID = /^up_[A-Za-z0-9_-]{22}$/;

/** The clientId-shaped name a file write is stamped with: derived from the device, since the file routes carry none. */
async function fileClientId(deviceId: string): Promise<string> {
  const h = await sha256(`pkey-sync-file-writer:${deviceId}`);
  return `c_${b64urlEncode(h.subarray(0, 16))}`;
}

function parseFinalize(v: unknown): FinalizeRequest | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const id = (v as { uploadId?: unknown }).uploadId;
  return typeof id === "string" && UPLOAD_ID.test(id) ? { uploadId: id } : null;
}

export const handleFinalize = fileHandler(
  {
    method: "POST",
    write: true,
    limiter: "parts",
    body: { cap: BODY_CAP, parse: parseFinalize },
  },
  finalizeUpload,
);

async function finalizeUpload(
  ctx: ServiceContext,
  _match: RouteMatch,
  call: FileCall,
  request: FinalizeRequest,
): Promise<Response> {
  const { env, db, product } = ctx;
  const { caller, collection, id } = call;

  const gone = await liveRefusal(env, db, product.slug);
  if (gone) return gone;

  const address = {
    collection,
    recordId: id,
    uploadId: request.uploadId,
    serverNow: ctx.now * 1000,
  };

  // 2. Prepare.
  const prepared = await withObject(ctx, caller, (pin) =>
    callCloudSync<"fileFinalizePrepare">(env, pin, {
      op: "fileFinalizePrepare",
      ...address,
    }),
  );
  if (prepared instanceof Response) return prepared;
  let live = prepared.caller;
  const p = prepared.value.outcome;
  if (!p.ok) {
    if ("busy" in p) return retryable(1);
    if ("mismatch" in p) return wireError(400, "upload_mismatch");
    if ("missing" in p)
      return wireError(409, "upload_incomplete", { missing: p.missing });
    return p.error === "upload_expired"
      ? wireError(410, "upload_expired")
      : notFound();
  }
  if ("replay" in p) return json(p.replay satisfies FinalizeResponse);

  // The claim is given back when the call cannot finish (`discard`: the bytes are wrong).
  const end = (discard: boolean) =>
    withObject(ctx, live, (pin) =>
      callCloudSync<"fileFinalizeEnd">(env, pin, {
        op: "fileFinalizeEnd",
        ...address,
        discard,
      }),
    ).catch(() => undefined);

  // 3. The bytes: the stored object against what `begin` declared.
  const bucket = env.SYNC_FILES as R2Bucket;
  const { key, size, sha256: declared } = p.verify;
  let verified = false;
  try {
    const head = await bucket.head(key);
    if (head !== null && head.size === size) {
      // A single `PUT` was hashed by R2 itself, and that stored hash stands in for the stream; a
      // completed multipart object has none, and is streamed.
      verified =
        checksumHex(head) === declared ||
        (await hashedObject(bucket, key, size)) === declared;
    }
  } catch {
    await end(false);
    return retryable();
  }
  if (!verified) {
    await end(true);
    return wireError(400, "upload_mismatch");
  }

  // The collection is still declared, and its `maxRecords`.
  const loaded = await readCatalog(ctx);
  if (loaded instanceof Response) {
    await end(false);
    return loaded;
  }
  const decl = matchCollection(loaded.catalog, collection);
  if (decl === null) {
    await end(true);
    return wireError(400, "collection_unknown");
  }

  // 4. Commit.
  const clientId = await fileClientId(live.device.device_id);
  const committed = await withObject(ctx, live, (pin, c) => {
    live = c;
    return callCloudSync<"fileFinalizeCommit">(env, pin, {
      op: "fileFinalizeCommit",
      ...address,
      deviceId: c.device.device_id,
      clientId,
      maxRecords: decl.maxRecords,
    });
  });
  if (committed instanceof Response) return committed;
  const out = committed.value.outcome;
  if (out.ok) return json(out.result satisfies FinalizeResponse);
  if (out.error === "revision_conflict")
    return wireError(409, "revision_conflict", {
      server: { version: out.version },
    });
  if (out.error === "quota_exceeded")
    return wireError(403, "quota_exceeded", { scope: out.scope });
  return notFound();
}

/** The SHA-256 of a stored object, streamed; null when the object is gone or the wrong length. */
async function hashedObject(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<string | null> {
  const obj = await bucket.get(key);
  if (!obj || !("body" in obj)) return null;
  const { sha256: got, bytes } = await streamSha256(obj.body);
  return bytes === size ? got : null;
}

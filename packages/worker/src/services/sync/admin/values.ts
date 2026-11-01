/// <reference types="@cloudflare/workers-types" />

/**
 * The Data tab's reads of values and files, and its delete (U-11a.2), under
 * `/manage/api/products/<slug>/sync/subjects/<subject>/…`. Console API routes: rule 10 does not
 * apply, as for the summary (`subject.ts`); the RBAC area is `sync`.
 *
 *   GET  values                          the person's setting values
 *   GET  values?collection=&cursor=      one page of a collection's live records
 *   GET  files/<collection>/<id>[?version=]   the stored file, as a download
 *   GET  files/<collection>/<id>/revisions    its kept older versions
 *   POST delete                          the person's Cloud Sync data, the directory row and the key ring
 *
 * ── THE ORDER, each step refusing before the next costs anything ───────────────────────────
 *   1. The subject is a live subject of THIS product, else `404` (another product's, an absorbed
 *      one and a malformed one look the same; no audit row is written).
 *   2. The product serves server mode, else `404` for values and files: an end-to-end product's
 *      server holds ciphertext and no name, so the console answers sizes and counts (the summary)
 *      and nothing else. This is the same `404` a product with Cloud Sync off gets.
 *   3. A step-up no older than five minutes (`403 step_up_required`, `requireStepUp`).
 *   4. The read or the delete, then ONE audit row (`sync.data.values.view`,
 *      `sync.file.revisions.view`, `sync.file.download`, `sync.data.delete`) with the subject as
 *      target. The delete writes its row FIRST, before anything is erased.
 *
 *   The values, files and revisions GETs need `edit` (route rows in `console/routes.ts`): they
 *      show the person's content, which the aggregate summary does not. A row carries no value, record id or file name.
 *
 * A download streams from R2 as `application/octet-stream`, `attachment`, `nosniff`, `no-store`;
 * the request names a record and a version, never a key (the object resolves it from its own rows).
 */

import type { FileRevisionsResponse } from "@polaris-key/protocol/sync";
import { audit } from "../../../core/audit.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import {
  AdminBodyError,
  adminJson,
  err,
  notFound,
  readBody,
} from "../../../core/console/respond.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import { keyringStore } from "../../../core/keyring/store.js";
import { getActiveSchema } from "../../../core/products/store.js";
import {
  isSteppedUp,
  STEP_UP_MAX_AGE_SECONDS,
} from "../../../core/console/session.js";
import { CloudSyncDoError, callCloudSync } from "../do/client.js";
import { syncMode } from "../handlers/common.js";
import { cloudSyncStore } from "../subjectStore.js";
import { declaredOf } from "./subject.js";
import type { SyncAdminContext } from "./index.js";

const NAME = /^[A-Za-z0-9._~:@-]{1,128}$/;
const PAGE = 50;

const unavailable = (): Response =>
  err(503, "unavailable", "Try again in a moment.");

/** Steps 1 to 3: null when the caller may go on, else the refusal. `needServer`: values and files. */
async function guard(
  ctx: SyncAdminContext,
  subject: string,
  needServer: boolean,
  stepUp: boolean,
): Promise<{ catalogJson: string | undefined } | Response> {
  const { env, db, product, now, session } = ctx;
  if (!product.services.sync.enabled) return notFound();
  if (!PAIRWISE_SUBJECT_PATTERN.test(subject)) return notFound();
  if ((await resolveSubject(db, product.slug, subject)) !== subject)
    return notFound();
  const schemaRow = await getActiveSchema(db, product.slug);
  if (needServer) {
    const mode = await syncMode(env, db, product.slug, schemaRow);
    if (mode.serve !== "server") return notFound();
  }
  if (stepUp && !isSteppedUp(session, now))
    return err(
      403,
      "step_up_required",
      "Sign in again to confirm it's you. This needs a sign-in from the last 5 minutes.",
      { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
    );
  return { catalogJson: schemaRow?.catalog_json };
}

/** Downloads a minute and MiB an hour, per signed-in session (U-11a.F). */
export const DOWNLOAD_PER_MINUTE = 60;
export const DOWNLOAD_MIB_PER_HOUR = 2048;
const MIB = 1024 * 1024;

const slowDown = (windowSec: number, now: number): Response => {
  const res = err(429, "rate_limited", "Too many downloads. Try again later.");
  res.headers.set("retry-after", String(windowSec - (now % windowSec)));
  return res;
};

/**
 * The download budget: null while the session is within it. The count is charged first; the byte
 * budget is read before the file is fetched and charged by the file's size, so one file may end
 * a window a little over, and the next is refused until the window ends.
 */
async function overDownloadBudget(
  ctx: SyncAdminContext,
  size: number | null,
): Promise<Response | null> {
  const { env, now, session } = ctx;
  const id = session.principal?.memberId ?? session.sub;
  const minute = { limit: DOWNLOAD_PER_MINUTE, windowSec: 60 };
  const hour = { limit: DOWNLOAD_MIB_PER_HOUR, windowSec: 3600 };
  if (size === null) {
    if (
      !(await rateLimitOk(
        env,
        "_admin",
        { bucket: "adminSyncDownload", id, ...minute },
        now,
      ))
    )
      return slowDown(minute.windowSec, now);
    if (
      !(await rateLimitOk(
        env,
        "_admin",
        { bucket: "adminSyncDownloadMiB", id, ...hour },
        now,
        true,
      ))
    )
      return slowDown(hour.windowSec, now);
    return null;
  }
  const cost = Math.max(1, Math.ceil(size / MIB));
  const bytes = { bucket: "adminSyncDownloadMiB", id, ...hour, cost };
  return (await rateLimitOk(env, "_admin", bytes, now))
    ? null
    : slowDown(hour.windowSec, now);
}

const seconds = (ms: number): number => Math.floor(ms / 1000);

// ── GET values ───────────────────────────────────────────────────────────────────────────────

export async function handleValues(
  ctx: SyncAdminContext,
  subject: string,
): Promise<Response> {
  const { env, db, product, now, session } = ctx;
  const ok = await guard(ctx, subject, true, true);
  if (ok instanceof Response) return ok;
  const params = new URL(ctx.req.url).searchParams;
  const collection = params.get("collection") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  if (
    (collection !== undefined && !NAME.test(collection)) ||
    (cursor !== undefined && (collection === undefined || !NAME.test(cursor)))
  )
    return err(400, "bad_request");

  let out: Awaited<ReturnType<typeof callCloudSync<"inspectValues">>>;
  try {
    out = await callCloudSync<"inspectValues">(
      env,
      { product: product.slug, subject },
      {
        op: "inspectValues",
        limit: PAGE,
        ...(collection !== undefined ? { collection } : {}),
        ...(cursor !== undefined ? { after: cursor } : {}),
      },
    );
  } catch (e) {
    if (e instanceof CloudSyncDoError) return unavailable();
    throw e;
  }
  const declared = declaredOf(ok.catalogJson);
  await audit(
    db,
    product.slug,
    session,
    now,
    "sync.data.values.view",
    { kind: "user", id: subject },
    "Viewed Cloud Sync values",
  );
  return adminJson({
    settings:
      out.settings?.map((s) => ({
        key: s.key,
        declared: declared.routes.has(s.key),
        platform: s.scope === "platform" ? (s.family ?? null) : null,
        bytes: s.bytes,
        updatedAt: seconds(s.updatedAt),
        value: s.value,
        sealed: s.sealed,
      })) ?? null,
    records: out.records.map((r) => ({
      ...r,
      updatedAt: seconds(r.updatedAt),
    })),
    next: out.next,
  });
}

// ── GET files/… ──────────────────────────────────────────────────────────────────────────────

export async function handleFile(
  ctx: SyncAdminContext,
  subject: string,
  target: { collection: string; id: string; revisions: boolean },
): Promise<Response> {
  const { env, db, product, now, session } = ctx;
  const ok = await guard(ctx, subject, true, true);
  if (ok instanceof Response) return ok;
  const { collection, id, revisions } = target;
  if (!NAME.test(collection) || !NAME.test(id)) return notFound();
  const raw = new URL(ctx.req.url).searchParams.get("version");
  let version: number | undefined;
  if (raw !== null) {
    if (!/^[0-9]{1,15}$/.test(raw) || Number(raw) < 1)
      return err(400, "bad_request");
    version = Number(raw);
  }
  const pin = { product: product.slug, subject };
  const who = { kind: "user" as const, id: subject };

  try {
    if (revisions) {
      const out = await callCloudSync<"fileRevisions">(env, pin, {
        op: "fileRevisions",
        collection,
        recordId: id,
      });
      await audit(
        db,
        product.slug,
        session,
        now,
        "sync.file.revisions.view",
        who,
        "Viewed a Cloud Sync file's revisions",
      );
      const body: FileRevisionsResponse = {
        revisions: out.outcome.revisions,
      };
      return adminJson(body);
    }

    const refused = await overDownloadBudget(ctx, null);
    if (refused) return refused;
    const resolved = await callCloudSync<"fileResolve">(env, pin, {
      op: "fileResolve",
      collection,
      recordId: id,
      ...(version !== undefined ? { version } : {}),
    });
    const out = resolved.outcome;
    if (!out.ok) return notFound();
    const over = await overDownloadBudget(ctx, out.file.size);
    if (over) return over;
    const bucket = env.SYNC_FILES as R2Bucket | undefined;
    if (!bucket) return unavailable();
    let obj: R2ObjectBody | R2Object | null;
    try {
      obj = await bucket.get(out.file.key, {
        ...(out.file.ssecKey !== undefined
          ? { ssecKey: out.file.ssecKey }
          : {}),
      });
    } catch {
      return unavailable();
    }
    if (!obj || !("body" in obj) || obj.size !== out.file.size)
      return err(500, "internal_error");
    await audit(
      db,
      product.slug,
      session,
      now,
      "sync.file.download",
      who,
      "Downloaded a Cloud Sync file",
    );
    const headers = appSecurityHeaders(
      new Headers({
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "content-length": String(out.file.size),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        etag: `"${out.file.sha256}"`,
      }),
    );
    // The bytes are the person's: never run, never framed.
    headers.set(
      "content-security-policy",
      `${headers.get("content-security-policy") ?? "default-src 'none'"}; sandbox`,
    );
    return new Response(obj.body, { status: 200, headers });
  } catch (e) {
    if (e instanceof CloudSyncDoError) return unavailable();
    throw e;
  }
}

// ── POST delete ──────────────────────────────────────────────────────────────────────────────

/**
 * Erases the person's Cloud Sync data: the object (every row and R2 object, SSE-C keys first), the
 * directory row, then the key ring (D-12). A crash between steps leaves a directory row or a ring
 * the repeat removes; the object goes first so no key outlives the data it opens. Works in either
 * mode: a person's data can be removed whether or not the server can read it. The body must say
 * `{"confirm": true}`; the console's typed word is the user-facing half.
 */
export async function handleDelete(
  ctx: SyncAdminContext,
  subject: string,
): Promise<Response> {
  const { env, db, product, now, session } = ctx;
  const ok = await guard(ctx, subject, false, true);
  if (ok instanceof Response) return ok;
  let body: unknown;
  try {
    body = await readBody(ctx.req);
  } catch (e) {
    if (e instanceof AdminBodyError) return err(400, "bad_request");
    throw e;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { confirm?: unknown }).confirm !== true
  )
    return err(400, "bad_request", "Confirm the deletion.");
  const at = { product: product.slug, subject };
  // The row goes first: the object's erase removes files and keys before it can fail, so a
  // failure part-way still leaves the trail of an irreversible action (SEC M-1).
  await audit(
    db,
    product.slug,
    session,
    now,
    "sync.data.delete",
    { kind: "user", id: subject },
    "Deleted Cloud Sync data",
  );
  try {
    await cloudSyncStore.delete({ db, env, now }, at);
  } catch (e) {
    if (e instanceof CloudSyncDoError) return unavailable();
    throw e;
  }
  await keyringStore.delete({ db, env, now }, at);
  return adminJson({ deleted: true });
}

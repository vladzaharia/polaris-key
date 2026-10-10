/// <reference types="@cloudflare/workers-types" />
/**
 * Multi-request native uploads (F-22): twine and Maven send one version as several requests.
 *
 * `npm publish` and `swift package-registry publish` send a whole version in one request and
 * publish it at once. twine uploads each wheel and the sdist in a POST of its own, and Maven and
 * Gradle PUT each file (then checksums, then `maven-metadata.xml`) separately. A package version
 * is unique forever and never gains files after it is published (F-03), so such a version is
 * gathered first: each request stages its file and records it in the version's upload session
 * (`release_native_uploads`, one row per `(owner, ecosystem, name, version)`), and the session is
 * published once, as one release, through the same descriptor and ingest as everything else.
 *
 * WHEN A SESSION IS PUBLISHED:
 *   - Maven: when the client PUTs the artifact's `maven-metadata.xml`, which Maven and Gradle
 *     both upload after every file of the version (`maven.ts`);
 *   - twine: when the uploads have SETTLED. twine sends nothing after its last file, so each
 *     upload, once answered, waits `SETTLE_SECONDS` (inside the request's `waitUntil`) and
 *     publishes the session unless another request from the same token touched it meanwhile.
 *     Every upload request touches its token's open sessions on the feed BEFORE it reads its body
 *     (`touchSessions`), so a slow next upload holds the settle back however long its body takes;
 *   - both: the Release cron (`sweepNativeSessions`, every 15 minutes) publishes a session idle
 *     for `IDLE_FINALIZE_SECONDS`, the fallback when a `waitUntil` never ran or a client never
 *     sent its metadata.
 *
 * Every refusal the publish can meet is checked when each file arrives (a dry run of the version
 * as gathered so far), so the client is told; a publish that still fails (a race) leaves the
 * session `failed` with its reason and an audit row. A session is the token's alone: another
 * token's upload of the same version is refused while it is open. Staged files live under the
 * owner's `staging/` prefix, which the bucket's one-day rule clears, so an abandoned session is
 * marked failed after a day and its row purged a week later.
 */

import type { PackageEcosystem } from "@polaris-key/manifest";
import { parseJsonOr } from "../../../../platform/json.js";
import { randomId } from "../../../../platform/crypto.js";
import type { Db } from "../../../../db/types.js";
import type { RegistryRouteContext } from "../../../../core/registry/registryHost.js";
import type { PublishPrincipal } from "../../../../core/registry/registryPublish.js";
import { appendAudit } from "../../../../core/repo.js";
import {
  answeringFeed,
  commitNative,
  nativeActor,
  nativeDescriptor,
  nativeRefusal,
  type CommitResult,
  type NativeClient,
  type NativeRefusal,
  type StagedFile,
} from "./publish.js";

/** How long a twine upload waits for the next one before publishing its version. */
export const SETTLE_SECONDS = 10;
/** The cron publishes an open session idle this long. */
export const IDLE_FINALIZE_SECONDS = 10 * 60;
/** A session still open after this long lost its staged files to the bucket's one-day rule. */
export const ABANDON_SECONDS = 23 * 60 * 60;
/** Finished rows are kept this long (the console's and the audit's context), then purged. */
export const RETAIN_SECONDS = 7 * 86_400;
/** A session stuck `finalizing` this long (a crashed publish) is retried by the cron. */
const STUCK_SECONDS = 10 * 60;

/** The parts of a route context a session publish needs (the cron has the same). */
export type SessionContext = Pick<
  RegistryRouteContext,
  "env" | "db" | "product" | "now" | "hooks"
>;

interface SessionRow {
  product: string;
  ecosystem: string;
  name_norm: string;
  version: string;
  deliverable_id: string;
  name: string;
  session_id: string;
  principal_id: string;
  principal_json: string;
  client: string;
  files_json: string;
  metadata_json: string;
  channel: string | null;
  state: string;
  error: string | null;
  release_id: string | null;
  touch_seq: number;
  created_at: number;
  updated_at: number;
}

/** One upload session, parsed. */
export interface NativeSession {
  readonly key: SessionKey;
  readonly deliverableId: string;
  readonly name: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly principal: PublishPrincipal;
  readonly client: NativeClient;
  readonly files: readonly StagedFile[];
  readonly metadata: Record<string, unknown>;
  readonly channel: string | null;
  readonly state: "open" | "finalizing" | "published" | "failed";
  readonly error: string | null;
  readonly releaseId: string | null;
  readonly touchSeq: number;
  readonly updatedAt: number;
}

export interface SessionKey {
  readonly product: string;
  readonly ecosystem: PackageEcosystem;
  readonly nameNorm: string;
  readonly version: string;
}

function sessionOf(r: SessionRow): NativeSession {
  return {
    key: {
      product: r.product,
      ecosystem: r.ecosystem as PackageEcosystem,
      nameNorm: r.name_norm,
      version: r.version,
    },
    deliverableId: r.deliverable_id,
    name: r.name,
    sessionId: r.session_id,
    principalId: r.principal_id,
    principal: parseJsonOr<PublishPrincipal>(r.principal_json, {
      kind: "registry",
      product: r.product,
      tokenId: r.principal_id,
    }),
    client: r.client as NativeClient,
    files: parseJsonOr<StagedFile[]>(r.files_json, []),
    metadata: parseJsonOr<Record<string, unknown>>(r.metadata_json, {}),
    channel: r.channel,
    state: r.state as NativeSession["state"],
    error: r.error,
    releaseId: r.release_id,
    touchSeq: r.touch_seq,
    updatedAt: r.updated_at,
  };
}

const KEY_SQL =
  "product = ? AND ecosystem = ? AND name_norm = ? AND version = ?";
function keyParams(k: SessionKey): string[] {
  return [k.product, k.ecosystem, k.nameNorm, k.version];
}

/** One session, or `null`. */
export async function readSession(
  db: Db,
  key: SessionKey,
): Promise<NativeSession | null> {
  const row = await db.first<SessionRow>(
    `SELECT * FROM release_native_uploads WHERE ${KEY_SQL}`,
    ...keyParams(key),
  );
  return row ? sessionOf(row) : null;
}

/** The principal's id, as sessions key on it. */
export function principalId(p: PublishPrincipal): string {
  return p.kind === "registry" ? `rtok:${p.tokenId}` : `ci:${p.tokenId}`;
}

/**
 * Mark that a request from `principal` on this feed has begun (before its body is read), so a
 * pending settle of any of its open sessions stands down until that request has answered.
 */
export async function touchSessions(
  db: Db,
  product: string,
  ecosystem: PackageEcosystem,
  principal: PublishPrincipal,
): Promise<void> {
  await db.run(
    `UPDATE release_native_uploads SET touch_seq = touch_seq + 1
      WHERE product = ? AND ecosystem = ? AND principal_id = ? AND state = 'open'`,
    product,
    ecosystem,
    principalId(principal),
  );
}

export interface SessionStart {
  readonly key: SessionKey;
  readonly deliverableId: string;
  readonly name: string;
  readonly principal: PublishPrincipal;
  readonly client: NativeClient;
  readonly channel: string | null;
  readonly now: number;
}

/**
 * The version's open session for this principal, opening one when there is none (or the last
 * one failed). Refused while another token's session of the version is open (`upload-in-progress`)
 * or once the version's session has published (`package-version-taken`).
 */
export async function openSession(
  db: Db,
  s: SessionStart,
): Promise<NativeSession | NativeRefusal> {
  const pid = principalId(s.principal);
  const existing = await readSession(db, s.key);
  if (existing) {
    if (existing.state === "published")
      return nativeRefusal(
        409,
        "release_exists",
        "package-version-taken",
        `${existing.name} ${s.key.version} is already published; a package version is never republished.`,
      );
    if (existing.state !== "failed") {
      if (existing.principalId !== pid)
        return nativeRefusal(
          409,
          "bad_request",
          "upload-in-progress",
          `another token is uploading ${existing.name} ${s.key.version}; wait for it to finish.`,
        );
      if (existing.state === "finalizing")
        return nativeRefusal(
          409,
          "bad_request",
          "upload-publishing",
          `${existing.name} ${s.key.version} is being published from the files already uploaded; publish a new version to add files.`,
        );
      return existing;
    }
  }
  const sessionId = randomId("nup").replace(/[^A-Za-z0-9_-]/g, "");
  await db.run(
    `INSERT INTO release_native_uploads
       (product, ecosystem, name_norm, version, deliverable_id, name, session_id, principal_id,
        principal_json, client, files_json, metadata_json, channel, state, error, release_id,
        touch_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, 'open', NULL, NULL, 0, ?, ?)
     ON CONFLICT(product, ecosystem, name_norm, version) DO UPDATE SET
       deliverable_id = excluded.deliverable_id, name = excluded.name,
       session_id = excluded.session_id, principal_id = excluded.principal_id,
       principal_json = excluded.principal_json, client = excluded.client, files_json = '[]',
       metadata_json = '{}', channel = excluded.channel, state = 'open', error = NULL,
       release_id = NULL, touch_seq = 0, created_at = excluded.created_at,
       updated_at = excluded.updated_at
     WHERE release_native_uploads.state = 'failed'`,
    s.key.product,
    s.key.ecosystem,
    s.key.nameNorm,
    s.key.version,
    s.deliverableId,
    s.name,
    sessionId,
    pid,
    JSON.stringify(s.principal),
    s.client,
    s.channel,
    s.now,
    s.now,
  );
  const opened = await readSession(db, s.key);
  if (!opened || opened.principalId !== pid || opened.state !== "open")
    return nativeRefusal(
      409,
      "bad_request",
      "upload-in-progress",
      `another upload of ${s.name} ${s.key.version} began at the same moment; retry.`,
    );
  return opened;
}

/** The session's files with `file` added (a same-name file with the same bytes is a retry). */
export function withFile(
  session: NativeSession,
  file: StagedFile,
): StagedFile[] | NativeRefusal {
  const same = session.files.find((f) => f.name === file.name);
  if (same) {
    if (same.sha256 === file.sha256 && same.size === file.size)
      return [...session.files];
    return nativeRefusal(
      409,
      "bad_request",
      "file-exists",
      `${file.name} was already uploaded for ${session.name} ${session.key.version} with other bytes; a file is never replaced.`,
    );
  }
  return [...session.files, file];
}

/**
 * Record the session's files and metadata after a file was staged; answers the touch sequence
 * the caller's settle waits on. Only while the session is still open and this principal's.
 */
export async function saveSession(
  db: Db,
  session: NativeSession,
  files: readonly StagedFile[],
  metadata: Record<string, unknown>,
  now: number,
): Promise<number | null> {
  const changed = await db.runChanges(
    `UPDATE release_native_uploads
        SET files_json = ?, metadata_json = ?, updated_at = ?, touch_seq = touch_seq + 1
      WHERE ${KEY_SQL} AND state = 'open' AND session_id = ?`,
    JSON.stringify(files),
    JSON.stringify(metadata),
    now,
    ...keyParams(session.key),
    session.sessionId,
  );
  if (changed !== 1) return null;
  return (await readSession(db, session.key))?.touchSeq ?? null;
}

/**
 * Publish an open session: claim it (only while its touch sequence is still `expectedSeq`, when
 * given: a request that touched it since will settle it itself), build its descriptor from the
 * gathered files and ingest it. A session already published answers its release. A failure is
 * recorded on the row and audited.
 */
export async function finalizeSession(
  ctx: SessionContext,
  key: SessionKey,
  expectedSeq: number | null,
): Promise<CommitResult | { ok: false; skipped: true }> {
  const { db } = ctx;
  const claimed = await db.runChanges(
    `UPDATE release_native_uploads SET state = 'finalizing', updated_at = ?
      WHERE ${KEY_SQL} AND state = 'open'${expectedSeq === null ? "" : " AND touch_seq = ?"}`,
    ctx.now,
    ...keyParams(key),
    ...(expectedSeq === null ? [] : [expectedSeq]),
  );
  if (claimed !== 1) {
    const s = await readSession(db, key);
    if (s?.state === "published" && s.releaseId)
      return { ok: true, releaseId: s.releaseId, outcome: "unchanged" };
    return { ok: false, skipped: true };
  }
  const session = await readSession(db, key);
  if (!session) return { ok: false, skipped: true };
  // The credential that gathered the files must still be live at publish time. A
  // token revoked after the upload began (a leaked publish credential, found and revoked) can
  // not land a version through the settle or the sweep.
  const result = !(await principalStillLive(db, session.principal))
    ? nativeRefusal(
        403,
        "forbidden",
        "token-revoked",
        "the token that uploaded these files was revoked before the upload finished",
      )
    : await publishSession(ctx, session);
  if (result.ok)
    await db.run(
      `UPDATE release_native_uploads SET state = 'published', release_id = ?, error = NULL,
              updated_at = ? WHERE ${KEY_SQL}`,
      result.releaseId,
      ctx.now,
      ...keyParams(key),
    );
  else {
    await db.run(
      `UPDATE release_native_uploads SET state = 'failed', error = ?, updated_at = ?
        WHERE ${KEY_SQL}`,
      `${result.reason}: ${result.message}`.slice(0, 1000),
      ctx.now,
      ...keyParams(key),
    );
    await appendAudit(db, {
      product: key.product,
      id: randomId("aud"),
      at: ctx.now,
      actor_sub: nativeActor(session.principal),
      actor_name:
        session.principal.kind === "registry"
          ? "Registry token"
          : "CI (native client)",
      actor_email: null,
      action: "release.publish.failed",
      target_kind: "release",
      target_id: `${session.deliverableId}@${key.version}`,
      parent_id: null,
      summary:
        `Could not publish package ${session.name} ${key.version} from its native upload (${result.reason}): ${result.message}`.slice(
          0,
          1000,
        ),
    });
  }
  return result;
}

/** Is the session's publishing token (registry or CI) still unrevoked? */
async function principalStillLive(
  db: Db,
  p: PublishPrincipal,
): Promise<boolean> {
  const row =
    p.kind === "registry"
      ? await db.first<{ revoked_at: number | null }>(
          "SELECT revoked_at FROM registry_tokens WHERE product = ? AND token_id = ?",
          p.product,
          p.tokenId,
        )
      : await db.first<{ revoked_at: number | null }>(
          "SELECT revoked_at FROM ci_tokens WHERE product = ? AND token_id = ?",
          p.product,
          p.tokenId,
        );
  return row !== null && row.revoked_at === null;
}

async function publishSession(
  ctx: SessionContext,
  s: NativeSession,
): Promise<CommitResult> {
  const feed = await answeringFeed(
    ctx as RegistryRouteContext,
    s.key.ecosystem,
  );
  if (!feed)
    return nativeRefusal(
      404,
      "not_found",
      "feed-off",
      `the ${s.key.ecosystem} feed was switched off before the upload finished`,
    );
  if (s.files.length === 0)
    return nativeRefusal(
      400,
      "bad_request",
      "no-files",
      "the upload carries no files",
    );
  const descriptor = nativeDescriptor({
    product: s.key.product,
    deliverable: s.deliverableId,
    ecosystem: s.key.ecosystem,
    name: s.name,
    version: s.key.version,
    channel: s.channel,
    files: s.files,
    metadata: { ...s.metadata, name: s.name, version: s.key.version },
  });
  return commitNative(
    ctx as RegistryRouteContext,
    descriptor,
    s.files,
    feed,
    s.principal,
    s.client,
  );
}

/**
 * Settle a twine upload: wait `seconds`, then publish the session unless a request touched it
 * meanwhile. Run inside the request's `waitUntil` (Workers keep it alive up to 30 s after the
 * answer); without one the cron publishes it.
 */
export async function settleSession(
  ctx: SessionContext,
  key: SessionKey,
  seq: number,
  seconds = SETTLE_SECONDS,
): Promise<void> {
  if (seconds > 0) await new Promise((r) => setTimeout(r, seconds * 1000));
  await finalizeSession(
    { ...ctx, now: Math.floor(Date.now() / 1000) },
    key,
    seq,
  ).catch(() => undefined);
}

/**
 * The Release cron's sweep for one product: publish sessions idle `IDLE_FINALIZE_SECONDS` (and
 * retry ones stuck `finalizing`), fail those abandoned past the staging rule, purge finished rows.
 */
export async function sweepNativeSessions(
  ctx: SessionContext,
): Promise<{ published: number; failed: number; purged: number }> {
  const { db, now } = ctx;
  const out = { published: 0, failed: 0, purged: 0 };
  let rows: SessionRow[];
  try {
    rows = await db.all<SessionRow>(
      `SELECT * FROM release_native_uploads
        WHERE product = ? AND ((state = 'open' AND updated_at < ?)
                            OR (state = 'finalizing' AND updated_at < ?))
        ORDER BY updated_at LIMIT 50`,
      ctx.product.slug,
      now - IDLE_FINALIZE_SECONDS,
      now - STUCK_SECONDS,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return out;
    throw err;
  }
  for (const r of rows) {
    const s = sessionOf(r);
    if (s.updatedAt < now - ABANDON_SECONDS) {
      await db.run(
        `UPDATE release_native_uploads SET state = 'failed', error = ?, updated_at = ?
          WHERE ${KEY_SQL} AND state IN ('open', 'finalizing')`,
        "abandoned: the upload was left unfinished for a day, and its staged files are gone",
        now,
        ...keyParams(s.key),
      );
      out.failed++;
      continue;
    }
    if (s.state === "finalizing")
      await db.run(
        `UPDATE release_native_uploads SET state = 'open' WHERE ${KEY_SQL} AND state = 'finalizing'`,
        ...keyParams(s.key),
      );
    const res = await finalizeSession(ctx, s.key, null);
    if (res.ok) out.published++;
    else if (!("skipped" in res)) out.failed++;
  }
  out.purged = await db.runChanges(
    `DELETE FROM release_native_uploads
      WHERE product = ? AND state IN ('published', 'failed') AND updated_at < ?`,
    ctx.product.slug,
    now - RETAIN_SECONDS,
  );
  return out;
}

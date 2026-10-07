/// <reference types="@cloudflare/workers-types" />

/**
 * Pull on register and resync (HA-05; notes/S-20 §6.3 "Pull a URL" / "Pull a repo path", §6.4).
 *
 * A manifest names the images Polaris Key hosts as asset refs (HA-04): `.pkey/product`
 * `presentation.icon`, and the `.pkey/distribution` listing's `icon`, `header` and
 * `screenshots[]`. Each one is either an https URL or a path in the product's own repo. This module
 * turns a manifest apply into queued pulls and runs them:
 *
 *   1. PLAN (`planHostedAssetPulls`, at link and resync, after the apply's batch). Each declared
 *      ref maps to a slot (`manifestAssetSlots`). A slot whose ref is new or changed, or a repo path
 *      whose git blob changed at the synced commit, owes a pull: its row records the wanted ref and
 *      a message goes to the queue `pkey-assets-<env>`. A slot whose ref is unchanged enqueues
 *      nothing, unless its last pull failed and its back-off has elapsed. A slot the manifest no
 *      longer names loses its row and refs (the collector reclaims the bytes later, §6.4).
 *   2. PULL (`processAssetPull`, the queue consumer in the main script, `src/index.ts`). The
 *      message is re-checked against the row (a later resync supersedes it), then the bytes go
 *      through `ingest` (HA-01): guarded fetch, cap, sniff, hash, put, one batch. The slot keeps
 *      serving its old copy until the new one is `ready`; `ingest` swaps it atomically.
 *   3. RE-CHECK (`recheckHostedAssets`, the nightly maintenance sweep). Owed pulls whose back-off
 *      has elapsed are enqueued again, a bounded number per run.
 *
 * ── OWED LADDERS (HA-03's fallback, retried) ────────────────────────────────────────────────
 *
 * An ingest whose variant ladder failed (error 9422, any other binding or store error) or ran
 * without the binding still makes a ready copy, with `variants_json = '[]'`. While the Images
 * binding is bound, such a copy in a ladder slot (`ladderOwedSql`) is retryable like a pull: the
 * planner (for a declared slot with nothing to pull) and the nightly re-check send a ladder
 * message (`AssetLadderMessage`), and the consumer runs `rebuildLadder`, which reads the stored
 * original back and builds only the ladder; it never pulls the source again. The back-off is the
 * pulls' (`attempts`, `next_attempt_at`: an owed pull and an owed ladder never share a row, since
 * a pull rebuilds the ladder itself), and the re-check's budget is shared. Without the binding,
 * and for slots without a ladder family, nothing is retried: the original serves alone.
 *
 * ── RULES (§6.4, S-18 model C) ──────────────────────────────────────────────────────────────
 *
 * - A console-claimed slot (`origin = 'console'`, HA-06) is never overwritten by a pull. Its row
 *   still records the manifest's ref (`wanted_ref`), so Revert knows where the slot goes back to.
 * - A failed pull never blocks a register: planning and enqueueing are best-effort, and a slot
 *   whose source is failing is reported as the warning `asset_unreachable`, never an error.
 * - Back-off is exponential per slot, `PULL_BACKOFF_BASE_SECONDS` doubling, capped at 24 h.
 * - Pulls run only at register, resync, an operator action or the nightly re-check, never on an
 *   end user's request (owner decision 3), and only for refs a manifest author wrote.
 */

import type {
  ManifestAssetRef,
  ManifestDistribution,
  ManifestPresentation,
} from "@polaris-key/manifest";
import { isAssetRepoPath, isAssetUrl } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import {
  HOSTED_ASSET_REF,
  hostedAssetRefId,
  ingest,
  isHostedAssetLocale,
  ladderOwedSql,
  parseVariants,
  PULL_BACKOFF_BASE_SECONDS,
  rebuildLadder,
  variantFamily,
  type IngestContext,
  type IngestInput,
  type LadderOutcome,
} from "./hostedAssets.js";
import { gitShaOrNull } from "./manifestSnapshot.js";

/** The first back-off step after a failed pull or ladder retry; it doubles per failure. */
export { PULL_BACKOFF_BASE_SECONDS } from "./hostedAssets.js";
/** The back-off never exceeds a day. */
export const PULL_BACKOFF_CAP_SECONDS = 24 * 60 * 60;
/** How many owed pulls and ladder retries one nightly run enqueues, at most (one budget). */
export const RECHECK_MAX_PER_RUN = 50;
/**
 * How many budget-sized pages of due rows one nightly run reads, at most. Rows the re-check
 * cannot act on are read past rather than counted, so this bounds the reading, not the budget.
 */
export const RECHECK_MAX_PAGES = 20;
/** Queues' `sendBatch` limit. */
const SEND_BATCH_MAX = 100;

/** The back-off after `attempts` consecutive failures (≥ 1), in seconds. */
export function pullBackoffSeconds(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  if (n > 16) return PULL_BACKOFF_CAP_SECONDS;
  return Math.min(
    PULL_BACKOFF_BASE_SECONDS * 2 ** (n - 1),
    PULL_BACKOFF_CAP_SECONDS,
  );
}

/**
 * SQL: the back-off after one more failure, from the row's stored `attempts` (before the
 * increment): `pullBackoffSeconds(attempts + 1)`. Computed in SQL so concurrent deliveries never
 * race one another down to a shorter wait.
 */
function backoffAfterFailureSql(): string {
  const steps = Array.from(
    { length: 8 },
    (_, i) => `WHEN ${i} THEN ${pullBackoffSeconds(i + 1)}`,
  ).join(" ");
  return `CASE attempts ${steps} ELSE ${PULL_BACKOFF_CAP_SECONDS} END`;
}

/**
 * SQL over a `hosted_assets` row (columns prefixed by `p`): is a pull owed? The manifest wants a
 * ref (every-locale row, not console-claimed) that the stored copy was not pulled for, or whose
 * last pull failed or never ran.
 */
function pullOwedSql(p = ""): string {
  return `(${p}wanted_ref IS NOT NULL AND ${p}locale = '' AND ${p}origin <> 'console'
    AND (${p}status IN ('failed', 'stale', 'pending') OR ${p}pulled_ref IS NOT ${p}wanted_ref))`;
}

/**
 * SQL: does the row owe a ladder retry (whatever its back-off)? Never without the Images binding
 * (`images`), and never while a pull is owed: the pull's ingest builds the ladder itself.
 */
function ladderRetrySql(images: boolean, p = ""): string {
  return images ? `(${ladderOwedSql(p)} AND NOT ${pullOwedSql(p)})` : "0";
}

/** One slot a manifest declares, with where in which document it was declared. */
export interface ManifestAssetSlot {
  slot: string;
  ref: ManifestAssetRef;
  document: "product" | "distribution";
  /** The JSON pointer of the declaration (for `asset_unreachable`). */
  path: string;
}

/** The parts of a parsed manifest this module reads. */
export interface ManifestAssetSource {
  presentation?: ManifestPresentation;
  distribution?: ManifestDistribution;
}

/**
 * The slots a manifest declares (S-20 §6.1): `presentation.icon`; `listing.icon` (falling back to
 * `presentation.icon` when the listing names none), `listing.header`, `listing.screenshot:<n>`
 * (1-based, in order). Every one for every locale (`''`).
 */
export function manifestAssetSlots(
  manifest: ManifestAssetSource,
): ManifestAssetSlot[] {
  const out: ManifestAssetSlot[] = [];
  const icon = manifest.presentation?.icon;
  if (icon)
    out.push({
      slot: "presentation.icon",
      ref: icon,
      document: "product",
      path: "/presentation/icon",
    });
  const listing = manifest.distribution?.listing;
  if (listing?.icon)
    out.push({
      slot: "listing.icon",
      ref: listing.icon,
      document: "distribution",
      path: "/listing/icon",
    });
  else if (icon)
    out.push({
      slot: "listing.icon",
      ref: icon,
      document: "product",
      path: "/presentation/icon",
    });
  if (listing?.header)
    out.push({
      slot: "listing.header",
      ref: listing.header,
      document: "distribution",
      path: "/listing/header",
    });
  for (const [i, shot] of (listing?.screenshots ?? []).entries())
    out.push({
      slot: `listing.screenshot:${i + 1}`,
      ref: shot,
      document: "distribution",
      path: `/listing/screenshots/${i}`,
    });
  return out;
}

/** Is `slot` one a manifest can declare (so a manifest that stops declaring it removes it)? */
export function isManifestAssetSlot(slot: string): boolean {
  return (
    slot === "presentation.icon" ||
    slot === "listing.icon" ||
    slot === "listing.header" ||
    /^listing\.screenshot:[1-9][0-9]?$/.test(slot)
  );
}

/** The canonical spelling of a ref, stored as `wanted_ref` / `pulled_ref` and compared exactly. */
export function wantedRefOf(ref: ManifestAssetRef): string {
  return JSON.stringify(
    ref.sha256
      ? { kind: ref.kind, src: ref.src, sha256: ref.sha256 }
      : { kind: ref.kind, src: ref.src },
  );
}

/** A stored `wanted_ref` read back, re-validated; `null` when it is not one. */
export function parseWantedRef(
  value: string | null | undefined,
): ManifestAssetRef | null {
  if (typeof value !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sha =
    typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)
      ? r.sha256
      : undefined;
  if (r.sha256 !== undefined && !sha) return null;
  if (r.kind === "url" && isAssetUrl(r.src))
    return { kind: "url", src: r.src, ...(sha ? { sha256: sha } : {}) };
  if (
    r.kind === "repo" &&
    isAssetRepoPath(r.src) &&
    !(r.src as string).startsWith("./")
  )
    return { kind: "repo", src: r.src, ...(sha ? { sha256: sha } : {}) };
  return null;
}

/** One queued pull. Everything but the slot's identity is re-read from the row on delivery. */
export interface AssetPullMessage {
  v: 1;
  product: string;
  slot: string;
  locale: string;
  /** The `wanted_ref` this pull is for; a row that wants something else drops the message. */
  wanted: string;
  /** A repo ref: the commit to read the path at. */
  commit?: string;
  /** A repo ref: the git blob SHA the planner saw at `commit`, recorded on success. */
  blob?: string;
  reason: "sync" | "recheck" | "operator";
}

/**
 * One queued ladder retry: rebuild the variants of the copy `sha256` in the slot from the stored
 * original. Everything else is re-read from the row on delivery; a row that no longer holds
 * `sha256` with an empty ladder drops the message.
 */
export interface AssetLadderMessage {
  v: 1;
  kind: "ladder";
  product: string;
  slot: string;
  locale: string;
  sha256: string;
  reason: "sync" | "recheck";
}

/** Anything the asset queue carries. */
export type AssetQueueMessage = AssetPullMessage | AssetLadderMessage;

/** A message read off the queue, validated; `null` when it is not one of ours. */
export function readAssetPullMessage(body: unknown): AssetPullMessage | null {
  if (!body || typeof body !== "object") return null;
  const m = body as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== undefined) return null;
  if (typeof m.product !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.product))
    return null;
  if (typeof m.slot !== "string" || !isManifestAssetSlot(m.slot)) return null;
  if (m.locale !== "") return null;
  if (typeof m.wanted !== "string" || m.wanted.length > 4096) return null;
  if (m.commit !== undefined && gitShaOrNull(m.commit as string) === null)
    return null;
  if (m.blob !== undefined && gitShaOrNull(m.blob as string) === null)
    return null;
  if (m.reason !== "sync" && m.reason !== "recheck" && m.reason !== "operator")
    return null;
  return {
    v: 1,
    product: m.product,
    slot: m.slot,
    locale: "",
    wanted: m.wanted,
    ...(m.commit !== undefined ? { commit: m.commit as string } : {}),
    ...(m.blob !== undefined ? { blob: m.blob as string } : {}),
    reason: m.reason,
  };
}

/** A ladder retry read off the queue, validated; `null` when it is not one. */
export function readAssetLadderMessage(
  body: unknown,
): AssetLadderMessage | null {
  if (!body || typeof body !== "object") return null;
  const m = body as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "ladder") return null;
  if (typeof m.product !== "string" || !/^[a-z0-9-]{1,64}$/.test(m.product))
    return null;
  if (typeof m.slot !== "string" || variantFamily(m.slot) === null) return null;
  if (!isHostedAssetLocale(m.locale)) return null;
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256))
    return null;
  if (m.reason !== "sync" && m.reason !== "recheck") return null;
  return {
    v: 1,
    kind: "ladder",
    product: m.product,
    slot: m.slot,
    locale: m.locale,
    sha256: m.sha256,
    reason: m.reason,
  };
}

/** The git blob SHA of a repo path at the synced commit, `"missing"`, or `"error"` (unknown). */
export type RepoBlobLookup = (
  path: string,
) => Promise<string | "missing" | "error">;

/** `asset_unreachable` (S-20 §6.4): a declared asset whose source is failing. Never an error. */
export interface AssetWarning {
  code: "asset_unreachable";
  document: "product" | "distribution";
  path: string;
  message: string;
}

export interface PlanInput {
  product: string;
  manifest: ManifestAssetSource;
  /** The commit the manifest was read at; repo refs are skipped without one. */
  commit: string | null;
  /** Resolves a repo path's blob at `commit`; without it, a repo ref is compared by string only. */
  repoBlob?: RepoBlobLookup;
  /** Is the Images binding bound? Only then is an owed ladder retried (`syncHostedAssets`). */
  images?: boolean;
  now: number;
}

export interface PlanResult {
  messages: AssetQueueMessage[];
  statements: DbStatement[];
  warnings: AssetWarning[];
}

interface PullRow {
  slot: string;
  origin: string;
  source_ref: string | null;
  status: string;
  error: string | null;
  sha256: string | null;
  wanted_ref: string | null;
  pulled_ref: string | null;
  source_blob: string | null;
  next_attempt_at: number | null;
}

/** The statement that holds a slot off for one back-off step while its message is in flight. */
function stmtHold(
  product: string,
  slot: string,
  locale: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE hosted_assets SET next_attempt_at = ? WHERE product = ? AND slot = ? AND locale = ?`,
    params: [now + PULL_BACKOFF_BASE_SECONDS, product, slot, locale],
  };
}

function ladderMessage(
  product: string,
  slot: string,
  locale: string,
  sha256: string,
  reason: AssetLadderMessage["reason"],
): AssetLadderMessage {
  return { v: 1, kind: "ladder", product, slot, locale, sha256, reason };
}

/** The statement that marks a pull as enqueued (it holds off a duplicate for one back-off step). */
function stmtEnqueued(
  product: string,
  slot: string,
  now: number,
  wanted: string,
  resetAttempts: boolean,
): DbStatement {
  return {
    sql: `UPDATE hosted_assets SET wanted_ref = ?, next_attempt_at = ?${resetAttempts ? ", attempts = 0" : ""}
           WHERE product = ? AND slot = ? AND locale = ''`,
    params: [wanted, now + PULL_BACKOFF_BASE_SECONDS, product, slot],
  };
}

/**
 * Plan the pulls one manifest apply owes (S-20 §6.4). Reads the product's rows, asks GitHub for
 * repo blobs only where a repo ref is otherwise unchanged at a new commit, and returns the
 * statements (one batch), the messages and the warnings. Writes nothing itself.
 */
export async function planHostedAssetPulls(
  db: Db,
  input: PlanInput,
): Promise<PlanResult> {
  const { product, now } = input;
  const commit = gitShaOrNull(input.commit);
  const rows = new Map(
    (
      await db.all<PullRow & { ladder_owed: number }>(
        `SELECT slot, origin, source_ref, status, error, sha256, wanted_ref, pulled_ref,
                source_blob, next_attempt_at, ${ladderRetrySql(!!input.images)} AS ladder_owed
           FROM hosted_assets WHERE product = ? AND locale = ''`,
        product,
      )
    ).map((r) => [r.slot, r]),
  );
  const out: PlanResult = { messages: [], statements: [], warnings: [] };
  const declared = manifestAssetSlots(input.manifest).filter(
    (d) => d.ref.kind === "url" || commit !== null,
  );
  const named = new Set(declared.map((d) => d.slot));

  for (const d of declared) {
    const wanted = wantedRefOf(d.ref);
    const row = rows.get(d.slot);
    const message = (blob?: string): AssetPullMessage => ({
      v: 1,
      product,
      slot: d.slot,
      locale: "",
      wanted,
      ...(d.ref.kind === "repo" ? { commit: commit! } : {}),
      ...(blob ? { blob } : {}),
      reason: "sync",
    });
    const blobOf = async (): Promise<string | "missing" | "error"> =>
      d.ref.kind === "repo" && input.repoBlob
        ? input.repoBlob(d.ref.src)
        : "error";
    const enqueue = async (resetAttempts: boolean) => {
      const blob = await blobOf();
      out.statements.push(
        stmtEnqueued(product, d.slot, now, wanted, resetAttempts),
      );
      out.messages.push(
        message(blob !== "missing" && blob !== "error" ? blob : undefined),
      );
    };
    const due =
      !row || row.next_attempt_at === null || row.next_attempt_at <= now;
    // Nothing to pull, but a ladder the copy's ingest could not build (HA-03's fallback): rebuilt
    // from the stored copy once the back-off has elapsed, never by pulling again.
    const ladder = () => {
      if (!row?.ladder_owed || !row.sha256 || !due) return;
      out.statements.push(stmtHold(product, d.slot, "", now));
      out.messages.push(ladderMessage(product, d.slot, "", row.sha256, "sync"));
    };

    // S-18 model C: a console upload claims the slot. Record what the manifest wants, pull nothing.
    if (row?.origin === "console") {
      if (row.wanted_ref !== wanted)
        out.statements.push({
          sql: `UPDATE hosted_assets SET wanted_ref = ? WHERE product = ? AND slot = ? AND locale = ''`,
          params: [wanted, product, d.slot],
        });
      ladder();
      continue;
    }

    if (
      row &&
      row.wanted_ref === wanted &&
      (row.status === "failed" || row.status === "stale")
    )
      out.warnings.push({
        code: "asset_unreachable",
        document: d.document,
        path: d.path,
        message: `${d.slot} could not be pulled (${row.error ?? "unknown"}); ${
          row.sha256
            ? "the last good copy keeps serving"
            : "nothing is served for it yet"
        }. Polaris Key retries with back-off.`,
      });

    if (!row) {
      // A new slot: a pending row (nothing served yet), then the pull.
      const sourceRef =
        d.ref.kind === "repo" ? `${d.ref.src}@${commit}` : d.ref.src;
      out.statements.push({
        sql: `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, source_ref,
                status, modified_at, wanted_ref, attempts, next_attempt_at)
              VALUES (?, ?, '', 'manifest', ?, ?, 'pending', ?, ?, 0, ?)
              ON CONFLICT(product, slot, locale) DO NOTHING`,
        params: [
          product,
          d.slot,
          d.ref.kind,
          sourceRef,
          now,
          wanted,
          now + PULL_BACKOFF_BASE_SECONDS,
        ],
      });
      const blob = await blobOf();
      out.messages.push(
        message(blob !== "missing" && blob !== "error" ? blob : undefined),
      );
      continue;
    }

    if (row.wanted_ref !== wanted) {
      // A changed ref: the old copy keeps serving until the new one is ready.
      await enqueue(true);
      continue;
    }

    if (
      row.pulled_ref !== wanted ||
      row.status === "failed" ||
      row.status === "stale" ||
      row.status === "pending"
    ) {
      // Unchanged ref, but the pull it owes has not succeeded: only once the back-off elapsed.
      if (due) await enqueue(false);
      continue;
    }

    // Ready and unchanged. A repo path at a new commit is compared by its git blob.
    if (d.ref.kind === "repo" && row.source_ref !== `${d.ref.src}@${commit}`) {
      const blob = await blobOf();
      if (blob !== "missing" && blob !== "error" && blob === row.source_blob) {
        // The same file at the new commit: record the commit, pull nothing.
        out.statements.push({
          sql: `UPDATE hosted_assets SET source_ref = ? WHERE product = ? AND slot = ? AND locale = ''`,
          params: [`${d.ref.src}@${commit}`, product, d.slot],
        });
      } else if (blob !== "error") {
        out.statements.push(stmtEnqueued(product, d.slot, now, wanted, true));
        out.messages.push(message(blob === "missing" ? undefined : blob));
        continue;
      }
    }

    // Nothing to pull.
    ladder();
  }

  // Slots the manifest stopped declaring (§6.4 "Removed slot"): a manifest copy loses its row and
  // its refs (the collector reclaims the bytes after the age lock); any other copy only forgets
  // the manifest's ref. A repo ref skipped for want of a commit is not "stopped declaring".
  const skipped = new Set(
    manifestAssetSlots(input.manifest)
      .filter((d) => !named.has(d.slot))
      .map((d) => d.slot),
  );
  for (const row of rows.values()) {
    if (
      !isManifestAssetSlot(row.slot) ||
      named.has(row.slot) ||
      skipped.has(row.slot)
    )
      continue;
    if (row.origin === "manifest") {
      out.statements.push(
        {
          sql: `DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ?`,
          params: [product, HOSTED_ASSET_REF, hostedAssetRefId(row.slot, "")],
        },
        {
          sql: `DELETE FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ''`,
          params: [product, row.slot],
        },
      );
    } else if (row.wanted_ref !== null) {
      out.statements.push({
        sql: `UPDATE hosted_assets SET wanted_ref = NULL WHERE product = ? AND slot = ? AND locale = ''`,
        params: [product, row.slot],
      });
    }
  }
  return out;
}

/** Send pulls (and ladder retries) to `pkey-assets-<env>`. Returns how many were sent; 0 when
 *  the queue is unbound. */
export async function enqueueAssetPulls(
  env: Pick<Env, "HOSTED_ASSET_QUEUE">,
  messages: readonly AssetQueueMessage[],
): Promise<number> {
  const queue = env.HOSTED_ASSET_QUEUE;
  if (!queue || messages.length === 0) return 0;
  for (let i = 0; i < messages.length; i += SEND_BATCH_MAX)
    await queue.sendBatch(
      messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })),
    );
  return messages.length;
}

/**
 * Plan, record and enqueue one apply's pulls. Best-effort by construction: a register or a resync
 * never fails because of a hosted asset, so every failure here is swallowed into "nothing
 * enqueued" and the nightly re-check picks the slot up. Without a queue binding nothing is planned
 * at all (the rows would only claim pulls nobody runs).
 */
export async function syncHostedAssets(
  env: Pick<Env, "HOSTED_ASSET_QUEUE" | "IMAGES">,
  db: Db,
  input: PlanInput,
): Promise<{ enqueued: number; warnings: AssetWarning[] }> {
  if (!env.HOSTED_ASSET_QUEUE) return { enqueued: 0, warnings: [] };
  try {
    const plan = await planHostedAssetPulls(db, {
      ...input,
      images: !!env.IMAGES,
    });
    if (plan.statements.length > 0) await db.batch(plan.statements);
    let enqueued = 0;
    try {
      enqueued = await enqueueAssetPulls(env, plan.messages);
    } catch {
      // The rows say a pull is owed and when; the nightly re-check sends it.
    }
    return { enqueued, warnings: plan.warnings };
  } catch {
    return { enqueued: 0, warnings: [] };
  }
}

/** Where a repo path's bytes are read from: the raw Contents URL and the token header. */
export interface RepoPullSource {
  url: string;
  headers: Record<string, string>;
}

/** Resolves a product's repo path at a commit through its GitHub App installation, or `null`. */
export type RepoSourceResolver = (
  product: string,
  path: string,
  commit: string,
) => Promise<RepoPullSource | null>;

export type PullOutcome =
  /** The row no longer wants this pull (a later resync, a console claim, a removed slot). */
  | "superseded"
  | "ready"
  | "unchanged"
  /** Refused and recorded on the row, with back-off. */
  | "failed"
  /** A transient store race: the consumer retries the message. */
  | "retry"
  /** No blob store bound: nothing attempted. */
  | "unavailable";

/**
 * Record a failed pull's back-off (the row's status and error are `ingest`'s, or set here). Never
 * on a slot an operator uploaded while the pull ran (HA-06): the claim is not the pull's to mark.
 */
function stmtPullFailed(
  product: string,
  slot: string,
  wanted: string,
  now: number,
  error: string | null,
): DbStatement {
  return {
    sql: `UPDATE hosted_assets SET attempts = attempts + 1,
            next_attempt_at = ? + ${backoffAfterFailureSql()}
            ${error ? ", status = 'failed', error = ?, checked_at = ?" : ""}
           WHERE product = ? AND slot = ? AND locale = '' AND wanted_ref = ?
             AND origin <> 'console'`,
    params: error
      ? [now, error, now, product, slot, wanted]
      : [now, product, slot, wanted],
  };
}

/**
 * Run one queued pull (the consumer, `src/index.ts`). Never throws for a refusal: the outcome is
 * recorded on the row. Throws only for an unexpected failure (D1 down), which the consumer turns
 * into a retry and, after the queue's retries, the dead-letter queue.
 */
export async function processAssetPull(
  ctx: IngestContext,
  msg: AssetPullMessage,
  resolveRepo: RepoSourceResolver,
): Promise<PullOutcome> {
  const { db, now } = ctx;
  const row = await db.first<PullRow>(
    `SELECT slot, origin, source_ref, status, error, sha256, wanted_ref, pulled_ref, source_blob,
            next_attempt_at
       FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ''`,
    msg.product,
    msg.slot,
  );
  if (!row || row.origin === "console" || row.wanted_ref !== msg.wanted)
    return "superseded";
  const ref = parseWantedRef(msg.wanted);
  if (!ref) return "superseded";

  let input: IngestInput;
  let blob: string | null = null;
  if (ref.kind === "url") {
    input = {
      kind: "pull",
      url: ref.src,
      origin: "manifest",
      sourceKind: "url",
      sourceRef: ref.src,
      expectedSha256: ref.sha256 ?? null,
      // A console upload that lands while this pull is in flight wins (HA-06, S-18 model C).
      yieldsTo: ["console"],
    };
  } else {
    const commit = gitShaOrNull(msg.commit);
    if (!commit) return "superseded";
    const source = await resolveRepo(msg.product, ref.src, commit);
    if (!source) {
      await db.batch([
        stmtPullFailed(
          msg.product,
          msg.slot,
          msg.wanted,
          now,
          "repo:no-access",
        ),
      ]);
      return "failed";
    }
    blob = msg.blob ?? null;
    input = {
      kind: "pull",
      url: source.url,
      headers: source.headers,
      origin: "manifest",
      sourceKind: "repo",
      sourceRef: `${ref.src}@${commit}`,
      expectedSha256: ref.sha256 ?? null,
      // The raw Contents URL changes with the commit; a validator from another commit means nothing.
      force: true,
      yieldsTo: ["console"],
    };
  }

  const result = await ingest(ctx, msg.product, msg.slot, input);
  if (result.ok) {
    // The pull is done; its back-off is cleared. A copy left owing its ladder (the ingest's ladder
    // failed) counts that failure as the ladder's first attempt, as `ingest` records for a new
    // copy: its retry waits one back-off step. (This also settles the same bytes and a 304.)
    const owed = ctx.env.IMAGES ? ladderOwedSql() : "0";
    await db.batch([
      {
        sql: `UPDATE hosted_assets SET pulled_ref = ?, source_blob = ?,
                attempts = CASE WHEN ${owed} THEN 1 ELSE 0 END,
                next_attempt_at = CASE WHEN ${owed} THEN ? ELSE NULL END
               WHERE product = ? AND slot = ? AND locale = '' AND wanted_ref = ?
                 AND origin <> 'console'`,
        params: [
          msg.wanted,
          blob,
          now + PULL_BACKOFF_BASE_SECONDS,
          msg.product,
          msg.slot,
          msg.wanted,
        ],
      },
    ]);
    return result.status === "ready" ? "ready" : "unchanged";
  }
  if (result.reason === "retry") return "retry";
  if (result.reason === "unavailable") return "unavailable";
  // An operator uploaded the slot while the pull ran: the claim stands, nothing is recorded.
  if (result.reason === "claimed") return "superseded";
  await db.batch([
    stmtPullFailed(msg.product, msg.slot, msg.wanted, now, null),
  ]);
  return "failed";
}

/**
 * Run one queued ladder retry (the consumer, `src/assetQueue.ts`): `rebuildLadder` from the stored
 * original, then the pulls' back-off on the row: cleared once the ladder is written (or owed no
 * more), one step longer after a failure. Never for a row that owes a pull (that pull's ingest
 * builds the ladder, and the back-off is the pull's), and never written when the row no longer
 * holds `msg.sha256`. Throws only for an unexpected failure (D1 down), as `processAssetPull` does.
 */
export async function processLadderRetry(
  ctx: IngestContext,
  msg: AssetLadderMessage,
): Promise<LadderOutcome> {
  const outcome = await rebuildLadder(
    ctx,
    msg.product,
    msg.slot,
    msg.locale,
    msg.sha256,
  );
  if (outcome !== "built" && outcome !== "none" && outcome !== "failed")
    return outcome;
  const settled = outcome !== "failed";
  await ctx.db.batch([
    {
      sql: `UPDATE hosted_assets SET
              attempts = ${settled ? "0" : "attempts + 1"},
              next_attempt_at = ${settled ? "NULL" : `? + ${backoffAfterFailureSql()}`}
             WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?
               AND NOT ${pullOwedSql()}`,
      params: [
        ...(settled ? [] : [ctx.now]),
        msg.product,
        msg.slot,
        msg.locale,
        msg.sha256,
      ],
    },
  ]);
  return outcome;
}

/**
 * The nightly re-check (S-20 §6.3): owed pulls whose back-off has elapsed — failed, stale, still
 * pending, or wanting a ref the stored copy was not pulled for — enqueued again; and, while the
 * Images binding is bound, ready copies that still owe their ladder (`ladderOwedSql`), as ladder
 * retries. Oldest-due first across both, at most `limit` per run. A repo ref is read at the
 * product's last applied commit (the manifest snapshot). Returns how many were enqueued; nothing
 * without a queue binding.
 *
 * A due row the re-check cannot act on (an unreadable `wanted_ref`, a repo ref with no applied
 * commit to read it at) is read past, never counted: the budget is what is enqueued, so such rows
 * cannot crowd every ladder retry out of a run. Each is also held off as a failed pull is
 * (`attempts` up, the next back-off step), so it sorts behind the rows that fell due before it
 * rather than staying the oldest due and filling the pages of every run. The cost: a resync that
 * brings the missing commit waits out that back-off (15 minutes, doubling to about a day; with
 * the nightly run, two days at worst), as the planner does for any unchanged ref. Reading is
 * bounded by `RECHECK_MAX_PAGES` pages of `limit` rows.
 */
export async function recheckHostedAssets(
  env: Pick<Env, "HOSTED_ASSET_QUEUE" | "IMAGES">,
  db: Db,
  now: number,
  limit = RECHECK_MAX_PER_RUN,
): Promise<number> {
  if (!env.HOSTED_ASSET_QUEUE || limit <= 0) return 0;
  const messages: AssetQueueMessage[] = [];
  const statements: DbStatement[] = [];
  // Nothing is written until every page is read, so this run's own holds never move a row from one
  // OFFSET page to another. Concurrent writes (a resync's planner, a consumer recording an outcome)
  // still can: a row may then be read twice, which `seen` acts on once, or stepped past, which the
  // next run reads.
  const seen = new Set<string>();
  for (let page = 0; page < RECHECK_MAX_PAGES; page++) {
    const due = await db.all<{
      product: string;
      slot: string;
      locale: string;
      wanted_ref: string | null;
      sha256: string | null;
      applied_sha: string | null;
      pull: number;
    }>(
      `SELECT h.product, h.slot, h.locale, h.wanted_ref, h.sha256, s.applied_sha,
              ${pullOwedSql("h.")} AS pull
         FROM hosted_assets h
         JOIN products p ON p.slug = h.product
         LEFT JOIN product_manifest_snapshot s ON s.product = h.product
        WHERE p.deleted_at IS NULL
          AND (${pullOwedSql("h.")} OR ${ladderRetrySql(!!env.IMAGES, "h.")})
          AND (h.next_attempt_at IS NULL OR h.next_attempt_at <= ?)
        ORDER BY COALESCE(h.next_attempt_at, 0), h.product, h.slot, h.locale
        LIMIT ? OFFSET ?`,
      now,
      limit,
      page * limit,
    );
    for (const r of due) {
      if (messages.length >= limit) break;
      const key = `${r.product}|${r.slot}|${r.locale}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!r.pull) {
        if (!r.sha256 || variantFamily(r.slot) === null) continue;
        messages.push(
          ladderMessage(r.product, r.slot, r.locale, r.sha256, "recheck"),
        );
        statements.push(stmtHold(r.product, r.slot, r.locale, now));
        continue;
      }
      if (r.wanted_ref === null) continue;
      const ref = parseWantedRef(r.wanted_ref);
      const commit = gitShaOrNull(r.applied_sha);
      if (
        !ref ||
        !isManifestAssetSlot(r.slot) ||
        (ref.kind === "repo" && !commit)
      ) {
        // Nothing to send: held off as a failed pull is, never counted against the budget.
        statements.push(
          stmtPullFailed(r.product, r.slot, r.wanted_ref, now, null),
        );
        continue;
      }
      messages.push({
        v: 1,
        product: r.product,
        slot: r.slot,
        locale: "",
        wanted: r.wanted_ref,
        ...(ref.kind === "repo" ? { commit: commit! } : {}),
        reason: "recheck",
      });
      statements.push(stmtHold(r.product, r.slot, "", now));
    }
    if (messages.length >= limit || due.length < limit) break;
  }
  if (messages.length > 0) await enqueueAssetPulls(env, messages);
  if (statements.length > 0) await db.batch(statements);
  return messages.length;
}

/** One hosted asset as the console's Presentation page reads it (`GET …/assets`). */
export interface HostedAssetView {
  slot: string;
  locale: string;
  origin: string;
  sourceKind: string;
  sourceRef: string | null;
  status: string;
  error: string | null;
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  checkedAt: number | null;
  modifiedAt: number;
  /** What the manifest declares for the slot now, or `null` when no manifest names it. */
  wanted: ManifestAssetRef | null;
  /** A pull is owed: the manifest wants a ref the stored copy was not pulled for. */
  pullPending: boolean;
  attempts: number;
  nextAttemptAt: number | null;
  /**
   * HA-06: a ready copy that still owes its WebP size ladder (`ladderOwedSql`) while the Images
   * binding is bound, so HA-05 retries it. Without the binding the original serves alone, by
   * design, and nothing is pending.
   */
  sizesPending: boolean;
  /** The widths of the copy's size ladder (`variants_json`), ascending. */
  widths: number[];
}

/**
 * Every hosted asset of `product`, ordered by slot and locale. `images` says whether the Images
 * binding is bound (`sizesPending` is only ever true while it is).
 */
export async function listHostedAssetViews(
  db: Db,
  product: string,
  opts: { images?: boolean } = {},
): Promise<HostedAssetView[]> {
  const rows = await db.all<{
    slot: string;
    locale: string;
    origin: string;
    source_kind: string;
    source_ref: string | null;
    status: string;
    error: string | null;
    sha256: string | null;
    size: number | null;
    content_type: string | null;
    width: number | null;
    height: number | null;
    checked_at: number | null;
    modified_at: number;
    wanted_ref: string | null;
    pulled_ref: string | null;
    attempts: number;
    next_attempt_at: number | null;
    variants_json: string | null;
    ladder_owed: number;
  }>(
    `SELECT slot, locale, origin, source_kind, source_ref, status, error, sha256, size,
            content_type, width, height, checked_at, modified_at, wanted_ref, pulled_ref,
            attempts, next_attempt_at, variants_json, ${ladderOwedSql()} AS ladder_owed
       FROM hosted_assets WHERE product = ? ORDER BY slot, locale`,
    product,
  );
  return rows.map((r) => ({
    slot: r.slot,
    locale: r.locale,
    origin: r.origin,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    status: r.status,
    error: r.error,
    sha256: r.sha256,
    size: r.size,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    checkedAt: r.checked_at,
    modifiedAt: r.modified_at,
    wanted: parseWantedRef(r.wanted_ref),
    pullPending:
      r.wanted_ref !== null &&
      r.origin !== "console" &&
      r.wanted_ref !== r.pulled_ref,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    sizesPending: !!opts.images && r.ladder_owed === 1,
    widths: parseVariants(r.variants_json)
      .map((v) => v.w)
      .sort((a, b) => a - b),
  }));
}

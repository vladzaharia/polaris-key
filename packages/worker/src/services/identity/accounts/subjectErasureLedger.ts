/**
 * The per-product removal ledger (U-12.1): where "remove my data from <Product>" is recorded
 * OUTSIDE D1, so a D1 restore cannot bring the removed data back unnoticed.
 *
 * A removal ends one pairwise subject: its managed overrides, key ring, Cloud Sync object and
 * directory row, the device bindings and the subject row itself. A D1 Time Travel restore rewinds
 * all the D1 half of that together. The ledger is the record a restore does not touch: one
 * object per removed (product, subject) in the existing `BLOBS` bucket,
 *
 *   subject-erasures/<product>/<subject>   {"v":1,"product":"…","subject":"…","erasedAt":<unix seconds>}
 *
 * The product slug, the random pairwise subject and a timestamp: nothing that names the person.
 * The prefix is NOT `erasures/`: the account replay reads every key under that prefix as an
 * account id, and the two ledgers never see each other's entries.
 *
 * REPLAY (U-12.2). {@link replaySubjectErasures} walks the ledger (paged, bounded per pass). A
 * ledger entry whose subject row is live in D1 means a removal is owed: a request that left a
 * store failing, or a restore that brought the rows back. The pass hands each one to the removal
 * (`completeProductRemoval`: fence, stores, commit), at most {@link SUBJECT_REPLAY_MAX_COMPLETE}
 * subjects per pass, and deletes entries older than {@link SUBJECT_ERASURE_RETENTION_SECONDS}
 * whose subject is gone. A D1 restore does not touch Durable Object storage, so the object stays
 * erased; a Durable Object point-in-time restore is not noticed by the pass, and an operator asks
 * for the objects pass of that product ({@link OBJECTS_REQUEST_KEY}).
 *
 * WRITE-AHEAD AND CREATE-ONLY. The removal records here BEFORE it clears a device binding or
 * deletes a store. The write is `If-None-Match: *`: the first record wins and a repeat answers
 * `exists`. A write that fails refuses the removal while nothing has been removed.
 */

import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import { PAIRWISE_SUBJECT_PATTERN } from "../../../core/accounts/accountSubjects.js";
import { runSubjectDeleteIsolated } from "../../../core/accounts/subjectHooks.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { pk } from "../../../platform/kv.js";
import { ErasureLedgerError } from "./erasureLedger.js";

/** Every per-product ledger object lives under this prefix. Never `erasures/`. */
export const SUBJECT_ERASURE_PREFIX = "subject-erasures/";

/** The record's `v`. */
export const SUBJECT_ERASURE_RECORD_VERSION = 1;

/** What the ledger stores per removed subject. */
export interface SubjectErasureRecord {
  v: typeof SUBJECT_ERASURE_RECORD_VERSION;
  product: string;
  subject: string;
  /** Unix seconds. */
  erasedAt: number;
}

/** The ledger key of one (product, subject). */
export function subjectErasureKey(product: string, subject: string): string {
  return `${SUBJECT_ERASURE_PREFIX}${product}/${subject}`;
}

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Record a removal, create-only. `created` the first time; `exists` when the ledger already holds
 * it (the first record, and its timestamp, stand). Throws {@link ErasureLedgerError} when the
 * record cannot be made durable or the names are not a product slug and a pairwise subject: the
 * caller must not start the removal.
 */
export async function recordSubjectErasure(
  env: Env,
  product: string,
  subject: string,
  erasedAt: number,
): Promise<"created" | "exists"> {
  if (!PRODUCT_SLUG_RE.test(product) || !PAIRWISE_SUBJECT_PATTERN.test(subject))
    throw new ErasureLedgerError(
      "a removal record needs a product slug and a pairwise subject",
    );
  const bucket = env.BLOBS;
  if (!bucket)
    throw new ErasureLedgerError(
      "removal ledger unavailable: the BLOBS bucket is not bound, so the removal cannot be recorded",
    );
  const record: SubjectErasureRecord = {
    v: SUBJECT_ERASURE_RECORD_VERSION,
    product,
    subject,
    erasedAt,
  };
  let stored: R2Object | null;
  try {
    stored = await bucket.put(
      subjectErasureKey(product, subject),
      JSON.stringify(record),
      {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: "application/json" },
      },
    );
  } catch (e) {
    throw new ErasureLedgerError(
      `removal ledger unavailable: recording the removal failed: ${messageOf(e)}`,
      { cause: e },
    );
  }
  return stored === null ? "exists" : "created";
}

// ── Replay ──────────────────────────────────────────────────────────────────────────────────

/** R2 answers at most 1,000 keys per `list` call. */
export const SUBJECT_LEDGER_PAGE = 1000;
/** Pages one pass reads (5,000 entries); a longer ledger resumes on the next pass. */
export const SUBJECT_REPLAY_MAX_PAGES = 5;
/** Subjects one pass completes; the rest wait for the next tick. */
export const SUBJECT_REPLAY_MAX_COMPLETE = 25;
/** Entries older than this whose subject is gone are deleted: past the 30-day windows of D1 Time
 *  Travel and Durable Object point-in-time recovery. */
export const SUBJECT_ERASURE_RETENTION_SECONDS = 35 * 24 * 60 * 60;
/** Ledger entries deleted per pass (one R2 `delete` call takes at most 1,000 keys). */
const SWEEP_MAX = 1000;
const RESUME_TTL_SECONDS = 3 * 24 * 60 * 60;
const RESUME_KEY = pk("_platform", "subject-erasure-ledger", "resume");
const OBJECTS_RESUME_KEY = pk(
  "_platform",
  "subject-erasure-ledger",
  "resume-objects",
);
/**
 * The operator's request for an objects pass (after a Durable Object point-in-time restore): a
 * `HOT` KV key whose value is the product slug (`wrangler kv key put`). The next maintenance tick
 * runs the stores' deletes for every ledger subject of the product, whether or not D1 still has the
 * subject, and deletes the key when it has walked the whole ledger without a failure.
 */
export const OBJECTS_REQUEST_KEY = pk(
  "_platform",
  "subject-erasure-ledger",
  "objects",
);

/** What bounds one pass. The defaults are the production ones; a test lowers them. */
export interface SubjectReplayBounds {
  pageSize: number;
  maxPages: number;
  maxComplete: number;
}

const DEFAULT_BOUNDS: SubjectReplayBounds = {
  pageSize: SUBJECT_LEDGER_PAGE,
  maxPages: SUBJECT_REPLAY_MAX_PAGES,
  maxComplete: SUBJECT_REPLAY_MAX_COMPLETE,
};

export interface SubjectReplayFailure {
  product: string;
  /** The opaque pairwise subject; never an account id. */
  subject: string;
  step: "complete" | "objects";
  message: string;
}

/** A removal still owed after this long is reported to the operator (seconds). */
export const SUBJECT_ERASURE_STALE_SECONDS = 7 * 24 * 60 * 60;

export interface SubjectReplayResult {
  /** Ledger entries read this pass. */
  scanned: number;
  /** Owed removals completed (the subject row is gone). */
  completed: number;
  /** Objects pass only: ledger subjects whose stores were run. */
  objects: number;
  /** Ledger entries deleted after the retention window. */
  swept: number;
  /** Removals still owed whose ledger entry is older than {@link SUBJECT_ERASURE_STALE_SECONDS}. */
  stale: number;
  /** Objects pass: some pass of this cycle (this one included) had a failure. */
  cycleFailed: boolean;
  /** The pass stopped at a bound; the next one continues after the last entry it handled. */
  more: boolean;
  failures: SubjectReplayFailure[];
}

/** What {@link replaySubjectErasures} needs from the removal state machine (`deletion.ts`). */
export type CompleteRemoval = (args: {
  product: string;
  subject: string;
}) => Promise<{ removed: boolean; pending?: true; failedStores?: string[] }>;

interface Entry {
  key: string;
  product: string;
  subject: string;
  /** Unix seconds R2 stored the record. */
  at: number;
}

/** The (product, subject) a ledger key names, or `null` for a key that is not one of ours. */
function parseKey(key: string): { product: string; subject: string } | null {
  if (!key.startsWith(SUBJECT_ERASURE_PREFIX)) return null;
  const parts = key.slice(SUBJECT_ERASURE_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  const [product, subject] = parts as [string, string];
  if (!PRODUCT_SLUG_RE.test(product) || !PAIRWISE_SUBJECT_PATTERN.test(subject))
    return null;
  return { product, subject };
}

async function liveSubjects(
  db: Db,
  entries: readonly Entry[],
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const rows = await db.all<{ product: string; subject: string }>(
    `SELECT p.product, p.subject
       FROM account_product_subjects p
       JOIN json_each(?) j ON p.product = json_extract(j.value, '$[0]')
                          AND p.subject = json_extract(j.value, '$[1]')`,
    JSON.stringify(entries.map((e) => [e.product, e.subject])),
  );
  return new Set(rows.map((r) => `${r.product}/${r.subject}`));
}

async function readResume(env: Env, key: string): Promise<string | null> {
  try {
    return (await env.HOT.get(key)) ?? null;
  } catch {
    return null; // a lost marker only restarts the cycle
  }
}

async function writeResume(
  env: Env,
  key: string,
  value: string | null,
): Promise<void> {
  try {
    if (value === null) await env.HOT.delete(key);
    else await env.HOT.put(key, value, { expirationTtl: RESUME_TTL_SECONDS });
  } catch {
    // The next pass starts from the beginning: slower to reach a long ledger's tail, never wrong.
  }
}

/** The product an operator asked an objects pass for, or `null`. */
export async function pendingObjectsPass(env: Env): Promise<string | null> {
  try {
    const v = await env.HOT.get(OBJECTS_REQUEST_KEY);
    return v !== null && PRODUCT_SLUG_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The objects pass for `product` ran to the end of its ledger: the request is spent. */
export async function finishObjectsPass(env: Env): Promise<void> {
  await env.HOT.delete(OBJECTS_REQUEST_KEY);
  await writeResume(env, OBJECTS_RESUME_KEY, null);
}

/**
 * One bounded pass over the subject ledger (see the module comment). An unreachable ledger or
 * database THROWS (the scheduled step reports it); one subject's failure is collected in
 * `failures` and the pass goes on.
 *
 * Normal pass: every entry whose subject row is live is handed to `complete`; entries past the
 * retention window whose subject is gone are deleted. With `objects` and a `product`, the pass
 * reads only that product's entries and runs the stores' deletes for every one of them, live or
 * not (the stores answer "nothing there" for an empty object), without sweeping.
 */
export async function replaySubjectErasures(
  ctx: { db: Db; env: Env; now: number },
  complete: CompleteRemoval,
  opts: { objects?: boolean; product?: string } = {},
  bounds: Partial<SubjectReplayBounds> = {},
): Promise<SubjectReplayResult> {
  const b: SubjectReplayBounds = { ...DEFAULT_BOUNDS, ...bounds };
  const { db, env, now } = ctx;
  const result: SubjectReplayResult = {
    scanned: 0,
    completed: 0,
    objects: 0,
    swept: 0,
    stale: 0,
    cycleFailed: false,
    more: false,
    failures: [],
  };
  const bucket = env.BLOBS;
  if (!bucket) return result;
  const objects = opts.objects === true && opts.product !== undefined;
  if (opts.product !== undefined && !PRODUCT_SLUG_RE.test(opts.product))
    return result;
  const prefix =
    opts.product === undefined
      ? SUBJECT_ERASURE_PREFIX
      : `${SUBJECT_ERASURE_PREFIX}${opts.product}/`;
  const resumeKey = objects ? OBJECTS_RESUME_KEY : RESUME_KEY;

  // The objects cursor belongs to one product and carries whether the cycle has failed so far.
  const rawResume = await readResume(env, resumeKey);
  let cycleFailed = false;
  let resumedFrom: string | null = rawResume;
  if (objects) {
    resumedFrom = null;
    try {
      const c = JSON.parse(rawResume ?? "null") as {
        product?: unknown;
        key?: unknown;
        failed?: unknown;
      } | null;
      if (c && c.product === opts.product && typeof c.key === "string") {
        resumedFrom = c.key;
        cycleFailed = c.failed === true;
      }
    } catch {
      // an unreadable cursor restarts the cycle
    }
  }
  let from: { cursor: string } | { startAfter: string } | null =
    resumedFrom === null ? null : { startAfter: resumedFrom };
  let handledKey: string | null = null;
  let budget = b.maxComplete;
  let stopped = false;
  const sweep: string[] = [];

  for (let pages = 1; !stopped; pages++) {
    const listed = await bucket.list({
      prefix,
      limit: b.pageSize,
      ...(from ?? {}),
    });
    const entries: Entry[] = [];
    for (const o of listed.objects) {
      const named = parseKey(o.key);
      if (named)
        entries.push({
          key: o.key,
          ...named,
          at: Math.floor(o.uploaded.getTime() / 1000),
        });
    }
    result.scanned += entries.length;
    const live = await liveSubjects(db, entries);
    for (const e of entries) {
      const isLive = live.has(`${e.product}/${e.subject}`);
      if (isLive && now - e.at > SUBJECT_ERASURE_STALE_SECONDS) result.stale++;
      if (isLive || objects) {
        if (budget === 0) {
          stopped = true;
          result.more = true;
          break;
        }
        budget--;
        try {
          if (isLive) {
            const out = await complete({
              product: e.product,
              subject: e.subject,
            });
            if (out.removed) result.completed++;
            if (objects) result.objects++;
            if (out.pending)
              result.failures.push({
                product: e.product,
                subject: e.subject,
                step: "complete",
                message:
                  `stores failed: ${(out.failedStores ?? []).join(", ")}`.slice(
                    0,
                    160,
                  ),
              });
          } else {
            const failed = await runSubjectDeleteIsolated(
              { db, env, now },
              { product: e.product, subject: e.subject },
            );
            result.objects++;
            if (failed.length > 0)
              result.failures.push({
                product: e.product,
                subject: e.subject,
                step: "objects",
                message:
                  `stores failed: ${failed.map((f) => f.store).join(", ")}`.slice(
                    0,
                    160,
                  ),
              });
          }
        } catch (error) {
          result.failures.push({
            product: e.product,
            subject: e.subject,
            step: isLive ? "complete" : "objects",
            message: messageOf(error),
          });
        }
      } else if (
        !objects &&
        now - e.at > SUBJECT_ERASURE_RETENTION_SECONDS &&
        sweep.length < SWEEP_MAX
      ) {
        sweep.push(e.key);
      }
      handledKey = e.key;
    }
    if (stopped) break;
    if (listed.objects.length > 0)
      handledKey = listed.objects[listed.objects.length - 1]!.key;
    if (!listed.truncated) break;
    if (pages >= b.maxPages) {
      result.more = true;
      break;
    }
    from = { cursor: listed.cursor };
  }

  if (sweep.length > 0) {
    await bucket.delete(sweep);
    result.swept = sweep.length;
  }
  // A finished cycle starts over from the first key; a pass that stopped at a bound resumes after
  // the last entry it handled.
  result.cycleFailed = cycleFailed || result.failures.length > 0;
  const next = result.more ? handledKey : null;
  if (objects) {
    const value =
      next === null
        ? null
        : JSON.stringify({
            product: opts.product,
            key: next,
            failed: result.cycleFailed,
          });
    if (value !== rawResume) await writeResume(env, resumeKey, value);
  } else if (next !== resumedFrom) await writeResume(env, resumeKey, next);
  return result;
}

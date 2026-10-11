/**
 * The erasure ledger (I-11; S-16 §5.5): where an account erasure is recorded OUTSIDE D1.
 *
 * Why it exists. The id-only `account_tombstones` row the final erasure batch writes cannot keep
 * the promise the privacy notice makes ("a restore applies the deletion again"): a D1 Time Travel
 * restore rewinds the whole database, the tombstone and the erased account alike, so the account
 * comes back with nothing in D1 to say it was erased. The ledger is the record a restore does not
 * touch: one object per erased account in the existing `BLOBS` bucket (no new binding),
 *
 *   erasures/<account id>      {"v":1,"accountId":"<account id>","erasedAt":<unix seconds>}
 *
 * The opaque `acct_…` surrogate and a timestamp, nothing else: no email, name, product, token or
 * any other personal data, so keeping it indefinitely holds nothing the D1 tombstone did not.
 * No code path deletes a ledger object, and no other key builder can produce the prefix: the blob
 * store refuses the layout (`test/erasureLedger.test.ts`) and the collector sweeps only what D1
 * tracks (`test/scheduled.test.ts`).
 *
 * WRITE-AHEAD AND CREATE-ONLY. `deleteAccount` records the id here BEFORE its first irreversible
 * step (the status flip that closes the account), and the sweeper does the same for an erasure an
 * older Worker already closed. The write is `If-None-Match: *`: the first record wins, a second
 * attempt (a retry, a double invoke, the replay) answers `exists` and changes nothing. A write
 * that fails (R2 down, the bucket unbound) refuses the erasure while D1 is still untouched; the
 * due request is claimed again after its lease. A scheduled request that is merely PENDING (the
 * fourteen-day window, still cancellable) is never recorded: a cancellation would have to delete
 * from an append-only ledger.
 *
 * REPLAY. After a D1 restore the ledger is ahead of D1. {@link replayErasureLedger} walks it
 * (paged, bounded per pass) and, in this order:
 *
 *   1. ensures the id-only D1 tombstone of every listed id, so the legacy catch-up
 *      (`legacy.ts`: copies only portal accounts absent from `accounts` AND `account_tombstones`)
 *      cannot copy the account back;
 *   2. hands every account that is live again (`status <> 'deleted'`) to the erasure state
 *      machine, which closes it (no sign-in, no session, no registry token) and erases its data.
 *      An account already erasing is left to the retry sweeper and its back-off;
 *   3. copies D1 erasure tombstones the ledger lacks INTO the ledger (erasures that finished
 *      before the ledger shipped), over the same key range, so one pass reconciles both ways.
 *
 * Every step is idempotent: a pass over a consistent state changes nothing. The pass runs on the
 * 15-minute connector tick and in the nightly maintenance, before the legacy catch-up.
 *
 * REQUEST TIME. The replay is cleanup, not the fence. A restore brings an erased account back with
 * its sessions, sign-in methods and package tokens, so each gate that decides on them asks the
 * fence (`core/accounts/erasureFence.ts`: one `HEAD` of `erasures/<account id>`, remembered per
 * isolate) before it grants anything, and refuses an erased account from the moment the restore
 * lands, and refuses too while the ledger cannot be read. The replay then closes the account in D1
 * and erases its data, at most {@link ERASURE_REPLAY_MAX_REAPPLY} accounts per pass. It is not a
 * restore hook: Cloudflare documents no restore event, so an operator who restores D1 waits for
 * (or triggers) the next tick.
 */

import { jsonList } from "../../../core/sqlIn.js";
import {
  ERASURE_PREFIX,
  erasureKey,
  noteErased,
} from "../../../core/accounts/erasureFence.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { pk } from "../../../platform/kv.js";

/** The record's `v`. */
export const ERASURE_RECORD_VERSION = 1;

/** What the ledger stores per erased account: the opaque id and when the erasure was recorded. */
export interface ErasureRecord {
  v: typeof ERASURE_RECORD_VERSION;
  accountId: string;
  /** Unix seconds. */
  erasedAt: number;
}

/** R2 answers at most 1,000 keys per `list` call. */
export const ERASURE_LEDGER_PAGE = 1000;
/** Pages one pass reads (5,000 ids); a longer ledger resumes on the next pass. */
export const ERASURE_REPLAY_MAX_PAGES = 5;
/** Live accounts one pass hands to the erasure state machine; the rest wait for the next tick. */
export const ERASURE_REPLAY_MAX_REAPPLY = 25;
/** D1 erasure tombstones one pass copies into the ledger. */
export const ERASURE_LEDGER_MIRROR_MAX = 100;
/** Where a pass that stopped at its page bound left off (KV; self-heals by expiring). */
const RESUME_KEY = pk("_platform", "erasure-ledger", "resume");
const RESUME_TTL_SECONDS = 3 * 24 * 60 * 60;

/** The ledger could not record an erasure (R2 unavailable, the bucket unbound). */
export class ErasureLedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ErasureLedgerError";
  }
}

/** The account id a ledger key names, or `null` for a key that is not a ledger record. */
function idOfKey(key: string): string | null {
  if (!key.startsWith(ERASURE_PREFIX)) return null;
  const id = key.slice(ERASURE_PREFIX.length);
  return id.length > 0 ? id : null;
}

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Record an erasure, create-only. `created` the first time; `exists` when the ledger already holds
 * the id (the first record, and its timestamp, stand). Throws {@link ErasureLedgerError} when the
 * record cannot be made durable: the caller must not start the erasure.
 */
export async function recordErasure(
  env: Env,
  accountId: string,
  erasedAt: number,
): Promise<"created" | "exists"> {
  if (accountId.length === 0)
    throw new ErasureLedgerError("an erasure record needs an account id");
  const bucket = env.BLOBS;
  if (!bucket)
    throw new ErasureLedgerError(
      `erasure ledger unavailable: the BLOBS bucket is not bound, so the erasure of ${accountId} cannot be recorded`,
    );
  const record: ErasureRecord = {
    v: ERASURE_RECORD_VERSION,
    accountId,
    erasedAt,
  };
  let stored: R2Object | null;
  try {
    stored = await bucket.put(erasureKey(accountId), JSON.stringify(record), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    throw new ErasureLedgerError(
      `erasure ledger unavailable: recording the erasure of ${accountId} failed: ${messageOf(e)}`,
      { cause: e },
    );
  }
  // Record or already recorded, the account is erased from here on: this isolate need not read it.
  noteErased(env, accountId);
  return stored === null ? "exists" : "created";
}

/** One ledger entry as the replay reads it: the id and when R2 stored the record (unix seconds). */
interface LedgerEntry {
  accountId: string;
  erasedAt: number;
}

interface LedgerPage {
  entries: LedgerEntry[];
  /** The last key this page returned (whatever it is), where a later pass resumes. */
  lastKey: string | null;
  /** The account id of `lastKey`, the upper edge of the key range this page covers. */
  lastId: string | null;
  truncated: boolean;
  /** R2's continuation token; set only while `truncated`. */
  cursor: string | null;
}

type ListFrom = { cursor: string } | { startAfter: string } | null;

async function listLedgerPage(
  bucket: R2Bucket,
  from: ListFrom,
  limit: number,
): Promise<LedgerPage> {
  const listed = await bucket.list({
    prefix: ERASURE_PREFIX,
    limit,
    ...(from === null ? {} : from),
  });
  const entries: LedgerEntry[] = [];
  for (const o of listed.objects) {
    const accountId = idOfKey(o.key);
    if (accountId !== null)
      entries.push({
        accountId,
        erasedAt: Math.floor(o.uploaded.getTime() / 1000),
      });
  }
  const lastKey = listed.objects.at(-1)?.key ?? null;
  return {
    entries,
    lastKey,
    lastId: lastKey === null ? null : idOfKey(lastKey),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  };
}

/**
 * Step 1: the id-only tombstone of every entry. `INSERT OR IGNORE` leaves an existing row (an
 * erasure tombstone already there, or a merge tombstone that must not be rewritten) alone. Returns
 * how many rows it created.
 */
async function ensureErasureTombstones(
  db: Db,
  entries: readonly LedgerEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  return db.runChanges(
    `INSERT OR IGNORE INTO account_tombstones (id, email_hash, merged_into, deleted_at)
     SELECT json_extract(j.value, '$[0]'), NULL, NULL, json_extract(j.value, '$[1]')
       FROM json_each(?) AS j`,
    JSON.stringify(entries.map((e) => [e.accountId, e.erasedAt])),
  );
}

/**
 * Step 2: the ledger ids whose account is live again. An account at `deleted` is already being
 * erased: the retry sweeper owns it and its back-off (`sweepErasures` adopts one that has no
 * progress row), and calling the state machine from here would spend its attempts.
 */
async function liveAccountIds(
  db: Db,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM accounts WHERE status <> 'deleted' AND id IN ${jsonList()} ORDER BY id`,
    JSON.stringify(ids),
  );
  return rows.map((r) => r.id);
}

/**
 * Step 3: D1 erasure tombstones (`merged_into IS NULL`) inside the key range a page covers that
 * the page does not list, oldest id first. `after` is exclusive, `upTo` inclusive (`null`: no upper
 * bound, the last page). SQLite orders TEXT by bytes and R2 lists keys by UTF-8 bytes, so the two
 * agree on what "inside the range" means.
 */
async function unledgeredTombstones(
  db: Db,
  listed: readonly string[],
  range: { after: string; upTo: string | null },
  limit: number,
): Promise<LedgerEntry[]> {
  const rows = await db.all<{ id: string; deleted_at: number }>(
    `SELECT id, deleted_at FROM account_tombstones
      WHERE merged_into IS NULL AND id > ?${range.upTo === null ? "" : " AND id <= ?"}
        AND id NOT IN ${jsonList()}
      ORDER BY id LIMIT ?`,
    range.after,
    ...(range.upTo === null ? [] : [range.upTo]),
    JSON.stringify(listed),
    limit,
  );
  return rows.map((r) => ({ accountId: r.id, erasedAt: r.deleted_at }));
}

async function readResume(env: Env): Promise<string | null> {
  try {
    return (await env.HOT.get(RESUME_KEY)) ?? null;
  } catch {
    return null; // a lost marker only restarts the cycle
  }
}

async function writeResume(env: Env, key: string | null): Promise<void> {
  try {
    if (key === null) await env.HOT.delete(RESUME_KEY);
    else
      await env.HOT.put(RESUME_KEY, key, { expirationTtl: RESUME_TTL_SECONDS });
  } catch {
    // The next pass starts from the beginning: slower to reach a long ledger's tail, never wrong.
  }
}

/** What bounds one pass. The defaults are the production ones; a test lowers them. */
export interface ReplayBounds {
  /** Ids per `list` call (at most {@link ERASURE_LEDGER_PAGE}). */
  pageSize: number;
  /** `list` calls per pass. */
  maxPages: number;
  /** Live accounts handed to the erasure state machine per pass. */
  maxReapply: number;
  /** Tombstones copied into the ledger per pass. */
  maxMirror: number;
}

const DEFAULT_BOUNDS: ReplayBounds = {
  pageSize: ERASURE_LEDGER_PAGE,
  maxPages: ERASURE_REPLAY_MAX_PAGES,
  maxReapply: ERASURE_REPLAY_MAX_REAPPLY,
  maxMirror: ERASURE_LEDGER_MIRROR_MAX,
};

export interface ReplayFailure {
  /** The opaque `acct_…` id; never anything else. */
  accountId: string;
  step: "reapply" | "mirror";
  message: string;
}

export interface ReplayResult {
  /** Ledger ids read this pass. */
  scanned: number;
  /** D1 tombstones the pass had to create: ledger ids a restore (or a crash) left without one. */
  tombstoned: number;
  /** Live accounts handed to the erasure state machine and accepted by it. */
  reapplied: number;
  /** Live accounts left for the next pass: this pass's bound was reached. */
  deferred: number;
  /** D1 erasure tombstones created in the ledger. */
  mirrored: number;
  /** The pass stopped at its page bound; the next one continues after the last key it read. */
  more: boolean;
  /** Accounts whose re-erasure or ledger copy failed (a thrown error); the rest stood. */
  failures: ReplayFailure[];
}

/**
 * One bounded replay pass (see the module comment). An unreachable ledger or database THROWS (the
 * scheduled step reports it); a single account's failure is collected in `failures` and the pass
 * goes on. Nothing happens without a `BLOBS` bucket: there is no ledger, and no erasure can have
 * been recorded (`recordErasure` refuses) since the binding went away.
 *
 * `reapply` is the erasure state machine's entry for an account the ledger already names
 * (`deletion.ts` `reapplyErasure`): it closes the account and erases it, without writing the
 * ledger again.
 */
export async function replayErasureLedger(
  { db, env }: { db: Db; env: Env },
  reapply: (accountId: string) => Promise<{ ok: boolean }>,
  bounds: Partial<ReplayBounds> = {},
): Promise<ReplayResult> {
  const b: ReplayBounds = { ...DEFAULT_BOUNDS, ...bounds };
  const result: ReplayResult = {
    scanned: 0,
    tombstoned: 0,
    reapplied: 0,
    deferred: 0,
    mirrored: 0,
    more: false,
    failures: [],
  };
  const bucket = env.BLOBS;
  if (!bucket) return result;

  const resumedFrom = await readResume(env);
  let from: ListFrom =
    resumedFrom === null ? null : { startAfter: resumedFrom };
  // The key range the pages read so far cover ends here (exclusive for the next page's D1 side).
  let coveredTo = resumedFrom === null ? "" : (idOfKey(resumedFrom) ?? "");
  let lastKey: string | null = null;
  let reapplyLeft = b.maxReapply;
  let mirrorLeft = b.maxMirror;

  for (let pages = 1; ; pages++) {
    const page = await listLedgerPage(bucket, from, b.pageSize);
    const ids = page.entries.map((e) => e.accountId);
    result.scanned += ids.length;

    if (ids.length > 0) {
      result.tombstoned += await ensureErasureTombstones(db, page.entries);
      for (const accountId of await liveAccountIds(db, ids)) {
        if (reapplyLeft === 0) {
          result.deferred++;
          continue;
        }
        reapplyLeft--;
        try {
          if ((await reapply(accountId)).ok) result.reapplied++;
        } catch (e) {
          result.failures.push({
            accountId,
            step: "reapply",
            message: messageOf(e),
          });
        }
      }
    }

    // A page that is truncated yet empty names no upper edge: leave its range to the next page.
    const rangeKnown = !page.truncated || page.lastId !== null;
    if (mirrorLeft > 0 && rangeKnown) {
      const missing = await unledgeredTombstones(
        db,
        ids,
        { after: coveredTo, upTo: page.truncated ? page.lastId : null },
        mirrorLeft,
      );
      for (const t of missing) {
        mirrorLeft--;
        try {
          if ((await recordErasure(env, t.accountId, t.erasedAt)) === "created")
            result.mirrored++;
        } catch (e) {
          result.failures.push({
            accountId: t.accountId,
            step: "mirror",
            message: messageOf(e),
          });
        }
      }
    }

    if (page.lastId !== null) coveredTo = page.lastId;
    if (page.lastKey !== null) lastKey = page.lastKey;
    if (!page.truncated) break;
    if (pages >= b.maxPages) {
      result.more = true;
      break;
    }
    from = { cursor: page.cursor! };
  }

  // A finished cycle starts over from the first key. A pass that stopped at its bound resumes
  // after the last key it read, unless it left live accounts deferred: those are re-read first,
  // so the bound slows the walk instead of starving them.
  const next = result.more
    ? result.deferred > 0
      ? resumedFrom
      : lastKey
    : null;
  if (next !== resumedFrom) await writeResume(env, next);
  return result;
}

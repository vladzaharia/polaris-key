/// <reference types="@cloudflare/workers-types" />

/**
 * The request-time erasure fence (I-11; S-16 §5.5): whether an account is on the erasure ledger,
 * asked on the request path.
 *
 * Why it exists. The ledger (`services/identity/accounts/erasureLedger.ts`) is the one record of an
 * erasure that a D1 Time Travel restore does not rewind: one object per erased account in the
 * `BLOBS` bucket. A restore brings the erased account back with its status, sessions, sign-in
 * methods and package tokens, and every D1 gate (`accounts.status`, `account_sessions`,
 * `account_links`, `registry_tokens`) would accept them again until the next replay tick re-erases
 * the account. The fence is the gate that does not read D1: a request that has proved WHO it is
 * (a signed cookie, a link row, a pairwise subject, a token row) asks here whether that account was
 * erased, before anything is granted, minted or written.
 *
 * THE VERDICT. {@link erasureVerdict} never throws and fails closed. `erased`: the ledger holds a
 * record for the account (or for any one of the accounts asked about). `unavailable`: the answer
 * could not be read, because the `BLOBS` bucket is unbound or R2 failed. `clear`: the ledger holds
 * none. Only `clear` lets a request through. How a refusal looks is the gate's: an API route
 * answers 503 so the browser keeps its cookie and tries again, a sign-in refuses, a product browser
 * session reads as signed out and keeps its record, a package token resolves as anonymous.
 *
 * THE READ. One `HEAD` of `erasures/<account id>`. The ledger is create-only, an object is never
 * deleted by code, account ids are random and never reused, and R2 is strongly consistent, so
 * "the object exists" is the authority for `erased` and a missing object is "not erased as far as
 * the ledger knows". A deletion that is only scheduled (the fourteen-day window, still
 * cancellable) is never on the ledger, by design.
 *
 * THE MEMORY. Per isolate and per bucket binding. An `erased` answer is kept for the isolate's
 * life (an erasure is never undone). A `clear` answer is believed for
 * {@link ERASURE_CLEAR_TTL_SECONDS}, so a busy account costs one R2 read per window rather than one
 * per request; the isolate that recorded an erasure ({@link noteErased}) knows it at once. An
 * `unavailable` answer is never kept. Both maps are bounded and emptied when full: that only costs
 * a re-read.
 */

import type { Env } from "../../platform/env.js";

/** Every ledger object lives under this prefix, keyed by the opaque account id and nothing else. */
export const ERASURE_PREFIX = "erasures/";

/** The ledger key of an account. */
export function erasureKey(accountId: string): string {
  return `${ERASURE_PREFIX}${accountId}`;
}

/** What the ledger says about the accounts asked about. Only `clear` lets a request through. */
export type ErasureVerdict = "clear" | "erased" | "unavailable";

/** How long "not on the ledger" is believed, in seconds. */
export const ERASURE_CLEAR_TTL_SECONDS = 30;
/** Entries each map holds before it is emptied (the same bound as the registry token cache). */
const MAX_ENTRIES = 5_000;

interface Memory {
  /** Ids the ledger holds. An erasure is never undone, so these never expire. */
  readonly erased: Set<string>;
  /** Ids the ledger did not hold, and until when (unix seconds) that answer stands. */
  readonly clear: Map<string, number>;
}

/**
 * Keyed by the binding itself: nothing outlives the bucket it was read from, and two buckets (two
 * tests, two deployments) never share an answer.
 */
const memories = new WeakMap<R2Bucket, Memory>();

function memoryOf(bucket: R2Bucket): Memory {
  let memory = memories.get(bucket);
  if (!memory) {
    memory = { erased: new Set(), clear: new Map() };
    memories.set(bucket, memory);
  }
  return memory;
}

function rememberErased(memory: Memory, accountId: string): void {
  memory.clear.delete(accountId);
  if (memory.erased.size >= MAX_ENTRIES) memory.erased.clear();
  memory.erased.add(accountId);
}

async function verdictOf(
  bucket: R2Bucket,
  memory: Memory,
  accountId: string,
  now: number,
): Promise<ErasureVerdict> {
  if (memory.erased.has(accountId)) return "erased";
  const until = memory.clear.get(accountId);
  if (until !== undefined) {
    if (until > now) return "clear";
    memory.clear.delete(accountId);
  }
  let found: R2Object | null;
  try {
    found = await bucket.head(erasureKey(accountId));
  } catch {
    return "unavailable";
  }
  if (found !== null) {
    rememberErased(memory, accountId);
    return "erased";
  }
  if (memory.clear.size >= MAX_ENTRIES) memory.clear.clear();
  memory.clear.set(accountId, now + ERASURE_CLEAR_TTL_SECONDS);
  return "clear";
}

/**
 * Whether the ledger holds a record for any of `accountIds` (empty and absent ids are skipped; none
 * left is `clear`). Name every id the request acts as: the one a cookie or link carries and the one
 * it resolves to after a merge are different accounts. `now` is unix seconds, the clock the
 * `clear` answers expire on.
 *
 * `erased` outranks `unavailable`: one account known erased refuses the request whatever the
 * others' reads did.
 */
export async function erasureVerdict(
  env: Env,
  now: number,
  ...accountIds: ReadonlyArray<string | null | undefined>
): Promise<ErasureVerdict> {
  const ids = [
    ...new Set(
      accountIds.filter(
        (id): id is string => typeof id === "string" && id !== "",
      ),
    ),
  ];
  if (ids.length === 0) return "clear";
  const bucket = env.BLOBS;
  if (!bucket) return "unavailable";
  const memory = memoryOf(bucket);
  const verdicts = await Promise.all(
    ids.map((id) => verdictOf(bucket, memory, id, now)),
  );
  if (verdicts.includes("erased")) return "erased";
  return verdicts.includes("unavailable") ? "unavailable" : "clear";
}

/**
 * Record that this isolate wrote (or found) the ledger record of `accountId`, so its own next
 * request is refused without a read. The erasure write-ahead calls it; nothing else should.
 */
export function noteErased(env: Env, accountId: string): void {
  if (!env.BLOBS) return;
  rememberErased(memoryOf(env.BLOBS), accountId);
}

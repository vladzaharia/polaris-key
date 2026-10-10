/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./platform/env.js";

// Atomic fixed-window rate limiter. One Durable Object instance per product, or per shard of
// a sharded limiter (see SHARDING below); the DO serializes requests and its storage input-gate makes
// the read→increment→write race-free. One stored key per (bucket, id) holds
// `{window, count, expiresAt}`.
//
// STORAGE IS NOT SELF-BOUNDING (R10-04b). The previous comment here claimed storage "stays
// bounded by the active client set because a counter rolls over when the window advances" —
// that is false. Rollover overwrites the VALUE; it never removes the KEY. Since `id` is
// usually `clientNetwork(req)` and an attacker with a routed IPv6 /64 has 2^64 source addresses
// for free, every one of which mints a permanent key, the object grew without limit and never
// self-healed. An `alarm()` sweep now deletes counters whose window has already elapsed: once
// a window is over, the stored counter can never be read again (the next request in a new
// window starts from zero), so deleting it is always safe.
//
// SHARDING (R10-04a). A product's limiter is one object per product (`RL.idFromName(product)`);
// it is tenant-scoped already. The two platform-global names, `_admin` and `_portal`, used to
// be literal object names too, so interactive sign-in for the ENTIRE platform serialised
// through two objects. They are now split across `RL_SHARDS` objects each, chosen by a hash of
// the counter's `(bucket, id)` (`rateLimitShard` in `core/rateLimit.ts`), as are the email
// buckets in every limiter. One counter still lives in exactly one object, so limits stay exact.

interface CheckRequest {
  bucket: string;
  id: string;
  limit: number;
  windowSec: number;
  now: number;
}

interface Counter {
  window: number;
  count: number;
  /** Epoch seconds at which this counter's window ends; the sweep's only input. */
  expiresAt?: number;
}

/** How often to sweep. Long enough to be negligible cost, short enough to bound growth. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Max keys examined per sweep, so one alarm can never run unbounded. */
const SWEEP_BATCH = 2000;

/** Where the sweep resumes; stored beside the data and skipped when sweeping. */
export const SWEEP_CURSOR_KEY = "__sweep_cursor__";

/** The gap between alarms while a sweep is still walking a large key space. */
const SWEEP_CONTINUE_MS = 60 * 1000;

export class RateLimitDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { bucket, id, limit, windowSec, now } =
      (await request.json()) as CheckRequest;
    // A `windowSec` of 0 would divide by zero (a permanent lockout, an uncollectable key).
    if (
      typeof bucket !== "string" ||
      typeof id !== "string" ||
      !Number.isFinite(limit) ||
      limit < 0 ||
      !Number.isInteger(windowSec) ||
      windowSec < 1 ||
      !Number.isFinite(now)
    )
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const window = Math.floor(now / windowSec);
    const key = `${bucket}:${id}`;

    const stored = await this.state.storage.get<Counter>(key);
    const counter: Counter =
      stored && stored.window === window
        ? stored
        : { window, count: 0, expiresAt: (window + 1) * windowSec };

    let ok: boolean;
    if (counter.count >= limit) {
      ok = false;
    } else {
      counter.count += 1;
      counter.expiresAt = (window + 1) * windowSec;
      await this.state.storage.put(key, counter);
      await this.ensureSweepScheduled();
      ok = true;
    }
    return new Response(JSON.stringify({ ok }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Arm the sweep if it isn't already armed. Cheap: one storage read on the write path. */
  private async ensureSweepScheduled(): Promise<void> {
    const storage = this.state.storage;
    if (typeof storage.getAlarm !== "function") return;
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /**
   * Delete counters whose window has already ended. Re-arms itself while anything is still
   * resident so a busy object keeps sweeping, and stops arming once the object is empty —
   * an idle DO costs nothing and does not wake up.
   */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const nowSec = Math.floor(Date.now() / 1000);
    // Resume after the last key the previous alarm examined, so a flood
    // of live keys at the front of the key space cannot starve the rest of the sweep.
    const cursor = await storage.get<string>(SWEEP_CURSOR_KEY);
    const entries = await storage.list<Counter>({
      limit: SWEEP_BATCH,
      ...(cursor ? { startAfter: cursor } : {}),
    });

    const stale: string[] = [];
    for (const [key, counter] of entries) {
      if (key === SWEEP_CURSOR_KEY) continue;
      // A counter written before this change carries no `expiresAt`; it is by definition from
      // an earlier deploy, hence an elapsed window, hence collectable.
      const expiresAt = counter?.expiresAt;
      if (typeof expiresAt !== "number" || expiresAt <= nowSec) stale.push(key);
    }
    // The storage API deletes at most 128 keys per call.
    for (let i = 0; i < stale.length; i += 128)
      await storage.delete(stale.slice(i, i + 128));

    const remaining = entries.size - stale.length;
    // Re-arm while live counters remain, or while the batch cap may have left more behind.
    if (entries.size === SWEEP_BATCH) {
      const last = [...entries.keys()].pop() as string;
      await storage.put(SWEEP_CURSOR_KEY, last);
      await storage.setAlarm(Date.now() + SWEEP_CONTINUE_MS);
    } else {
      // End of the key space: the next pass starts over. A pass that began mid-space has not seen
      // the earlier keys this time, so it re-arms once more rather than conclude "empty".
      if (cursor) await storage.delete(SWEEP_CURSOR_KEY);
      if (remaining > 0 || cursor)
        await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }
}

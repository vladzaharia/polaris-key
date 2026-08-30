/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

// Atomic fixed-window rate limiter. One Durable Object instance per product
// (`RL.idFromName(product)`); the DO serializes requests and its storage input-gate makes
// the read→increment→write race-free. One stored key per (bucket, id) holds
// `{window, count, expiresAt}`.
//
// STORAGE IS NOT SELF-BOUNDING (R10-04b). The previous comment here claimed storage "stays
// bounded by the active client set because a counter rolls over when the window advances" —
// that is false. Rollover overwrites the VALUE; it never removes the KEY. Since `id` is
// usually `clientIp(req)` and an attacker with a routed IPv6 /64 has 2^64 source addresses
// for free, every one of which mints a permanent key, the object grew without limit and never
// self-healed. An `alarm()` sweep now deletes counters whose window has already elapsed: once
// a window is over, the stored counter can never be read again (the next request in a new
// window starts from zero), so deleting it is always safe.
//
// SHARDING (R10-04a / B2-03, fixed). `_admin` and `_portal` are literal scope names, so a
// single object per scope meant interactive sign-in for the ENTIRE platform — every tenant,
// every operator — serialized through exactly two Durable Objects, reachable with no
// credentials. `rateLimitOk` now names the object `${scope}:${bucket}:${hash(id) % N}`
// (`core/rateLimit.ts`, `RL_SHARDS`), so contention spreads while counting does not change: an
// id is a pure function of the shard it lands in, and the storage key inside the object is
// still `${bucket}:${id}`. Nothing in THIS file depends on the naming scheme.

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

/**
 * Where the next sweep resumes (B5-09 / B2-04).
 *
 * `list({ limit })` returns keys in lexicographic order from the START of the keyspace every
 * time, so a sweep with no cursor re-examined the same first 2,000 keys on every tick and
 * never reached key 2,001 — the counters most in need of collection (an IPv6 flood mints them
 * faster than one batch can drain) were the ones structurally guaranteed never to be looked
 * at. Persisting the last key seen and passing it as `startAfter` makes each tick continue
 * where the previous one stopped, so a backlog drains in `ceil(n / SWEEP_BATCH)` ticks
 * instead of never.
 *
 * The namespace prefix is `￿` — above every character a bucket name can contain — so the
 * cursor sorts after every counter and can never be mistaken for one by the sweep that reads
 * it back. (`bucket` reaches the key through `rateLimitOk` from call sites in this repo only,
 * but a cursor that could be shadowed by a stored counter is not a bound worth relying on.)
 */
const CURSOR_KEY = "￿__sweep_cursor";

export class RateLimitDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { bucket, id, limit, windowSec, now } =
      (await request.json()) as CheckRequest;
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
   *
   * Each tick examines at most `SWEEP_BATCH` keys STARTING AFTER the previous tick's last key,
   * so consecutive ticks walk the whole keyspace instead of re-reading its first page. A pass
   * that comes back short has reached the end and resets the cursor, which is what makes the
   * walk a loop rather than a one-way scan: keys minted behind the cursor are collected on the
   * next lap.
   */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const nowSec = Math.floor(Date.now() / 1000);
    const cursor = await storage.get<string>(CURSOR_KEY);
    const entries = await storage.list<Counter>({
      limit: SWEEP_BATCH,
      ...(typeof cursor === "string" ? { startAfter: cursor } : {}),
    });

    const stale: string[] = [];
    let lastKey: string | undefined;
    let examined = 0;
    for (const [key, counter] of entries) {
      if (key === CURSOR_KEY) continue;
      lastKey = key;
      examined++;
      // A counter written before this change carries no `expiresAt`; it is by definition from
      // an earlier deploy, hence an elapsed window, hence collectable.
      const expiresAt = counter?.expiresAt;
      if (typeof expiresAt !== "number" || expiresAt <= nowSec) stale.push(key);
    }
    if (stale.length > 0) await storage.delete(stale);

    // A short page means the keyspace ran out: start the next lap from the beginning. A full
    // page means there is more behind it, so remember where to resume.
    const exhausted = entries.size < SWEEP_BATCH;
    if (exhausted || lastKey === undefined) {
      if (typeof cursor === "string") await storage.delete(CURSOR_KEY);
    } else {
      await storage.put(CURSOR_KEY, lastKey);
    }

    const remaining = examined - stale.length;
    // Re-arm while live counters remain, or while the batch cap may have left more behind.
    if (remaining > 0 || !exhausted) {
      await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }
}

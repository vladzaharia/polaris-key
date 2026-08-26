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
// SHARDING IS STILL A SINGLE GLOBAL OBJECT PER PRODUCT (R10-04a, unfixed here). Worse,
// `_admin` and `_portal` are literal shard names, so interactive sign-in for the ENTIRE
// platform — every tenant, every operator — serializes through exactly two Durable Objects.
// That is a cross-tenant availability chokepoint and the most attractive DoS target in the
// system, because reaching it needs no credentials. Fixing it means keying the shard as
// `${product}:${bucket}:${hash(id) % N}`, which changes every call site (several outside this
// lane) — tracked separately.

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
   */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const nowSec = Math.floor(Date.now() / 1000);
    const entries = await storage.list<Counter>({ limit: SWEEP_BATCH });

    const stale: string[] = [];
    for (const [key, counter] of entries) {
      // A counter written before this change carries no `expiresAt`; it is by definition from
      // an earlier deploy, hence an elapsed window, hence collectable.
      const expiresAt = counter?.expiresAt;
      if (typeof expiresAt !== "number" || expiresAt <= nowSec) stale.push(key);
    }
    if (stale.length > 0) await storage.delete(stale);

    const remaining = entries.size - stale.length;
    // Re-arm while live counters remain, or while the batch cap may have left more behind.
    if (remaining > 0 || entries.size === SWEEP_BATCH) {
      await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }
}

/**
 * THE STORE BUDGET METER (P5-02's App Store rate budget, moved into Core by A-17a and generalised
 * by A-18a; notes/S-14 §5.5, notes/S-15 §6.3, THREAT-MODEL control (f)).
 *
 * Each adapter declares how its upstream meters it (`capabilities.rate`, a `RateSpec`):
 *
 *   - `header`      the store reports the remainder on every response (Apple's
 *                   `X-Rate-Limit: user-hour-lim:3600;user-hour-rem:…`, a rolling hour). The client
 *                   parses it and `writeRate` keeps the last observation;
 *   - `per-minute`, `per-day`  a counter the Worker keeps itself (Play: 3,000 per minute per
 *                   bucket; Steam: 100,000 per day), fed by `recordSpend`;
 *   - `retry-after` the store says when to come back (Microsoft); `recordStop` keeps it;
 *   - `stopOn403`   a 403 means the store has rate-limited the Worker (Steam rate-limits the IP):
 *                   `recordStop` holds every call until the window ends.
 *
 * Slots live in KV, keyed by store and credential:
 *
 *   - a product's OWN key has a slot in the product's namespace (`p:<slug>:<action>-rate:<id>`);
 *   - a platform TEAM key has ONE platform-wide slot (`plat:<action>-rate:<credential>`, outside
 *     the `p:` namespace no slug can reach), because every product that falls back to it, the
 *     poller, A-16's app listing and the provisioning flows all spend that one budget. For the App
 *     Store these are A-17a's keys exactly (`plat:asc-rate:app-store.api-key`).
 *
 * `budgetAllows` decides who may spend what is left, so a provisioning flow cannot starve every
 * product's poller and a poller can never block an operator (A-17a's tiers, unchanged):
 *
 *   share left    poll                   background (wizard polling, resumes)   operator
 *   ≥ 20 %        every step             yes                                    yes
 *   5–20 %        phased-release step    no                                     yes
 *   < 5 %         nothing                no                                     yes
 *   stopped       nothing                no                                     no
 *
 * `stopped` (a `stopOn403` 403, or a `Retry-After` still running) is the store's own hard limit,
 * like a 429: nobody spends until it lifts. Nothing known counts as a full budget. The meter is
 * advisory: a KV failure never blocks a call; the store's own refusal is the hard limit.
 */

import type { RateSpec } from "../adapters/contract.js";
import type { Env } from "../../platform/env.js";
import { pk as kvKey } from "../../platform/kv.js";
import { storefrontAdapter, type StorefrontId } from "./adapter.js";

/** What is left of a budget. */
export interface StoreRate {
  limit: number;
  remaining: number;
  /** The store has stopped the Worker (a 403 under `stopOn403`, a `Retry-After`). */
  stopped?: boolean;
}

/** Whose budget a call spends: a product's own key, or the platform team key. */
export type BudgetKey =
  | { source: "product"; credentialId: string }
  | { source: "platform" };

/** The last observation kept for a key, and when. */
export interface StoredRate extends StoreRate {
  at: number;
  /** When a stop lifts (epoch seconds). */
  until?: number;
}

/** A `header` meter's window: Apple's rolling hour. An older observation says nothing. */
export const RATE_WINDOW = 3600;

function specOf(store: StorefrontId): RateSpec {
  return storefrontAdapter(store)?.capabilities.rate ?? { kind: "none" };
}

/** The window a spec counts over, in seconds. */
export function rateWindow(spec: RateSpec): number {
  switch (spec.kind) {
    case "per-minute":
      return 60;
    case "per-day":
      return 86_400;
    default:
      return RATE_WINDOW;
  }
}

/** The KV slot of one store's key. */
export function rateSlot(
  store: StorefrontId,
  product: string,
  key: BudgetKey,
): string {
  const adapter = storefrontAdapter(store);
  const action = adapter?.audit.action ?? store;
  return key.source === "product"
    ? kvKey(product, `${action}-rate`, key.credentialId)
    : `plat:${action}-rate:${adapter?.credential ?? store}`;
}

/** The App Store team key's one platform-wide slot (A-17a's key). */
export const TEAM_RATE_KEY = rateSlot("app-store", "", { source: "platform" });

async function readSlot(env: Env, slot: string): Promise<StoredRate | null> {
  try {
    const raw = await env.HOT.get(slot);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredRate;
    if (
      typeof v.limit !== "number" ||
      typeof v.remaining !== "number" ||
      typeof v.at !== "number"
    )
      return null;
    return v;
  } catch {
    return null;
  }
}

async function writeSlot(
  env: Env,
  slot: string,
  v: StoredRate,
  ttl: number,
): Promise<void> {
  try {
    await env.HOT.put(slot, JSON.stringify(v), {
      expirationTtl: Math.max(60, ttl),
    });
  } catch {
    /* the budget is advisory */
  }
}

/**
 * One budget slot under one `RateSpec`: what every store's meter does, independent of which store
 * (the store-level functions below resolve the spec and slot from the adapter).
 */
export interface BudgetMeter {
  /** What is left now, or null when nothing is known (a lifted stop, a stale observation). */
  read(now: number): Promise<StoredRate | null>;
  /** Keep a `header` observation. */
  observe(rate: StoreRate | null, now: number): Promise<void>;
  /** Count one call against a `per-minute` or `per-day` budget (a no-op for other kinds). */
  spend(now: number): Promise<void>;
  /** The store stopped the Worker: for `seconds`, or until the window ends. */
  stop(now: number, seconds?: number): Promise<void>;
}

export function budgetMeter(
  env: Env,
  slot: string,
  spec: RateSpec,
): BudgetMeter {
  const window = rateWindow(spec);
  return {
    async read(now) {
      const v = await readSlot(env, slot);
      if (!v) return null;
      if (v.stopped && typeof v.until === "number" && now >= v.until)
        return null;
      if (now - v.at > window) return null;
      return v;
    },
    async observe(rate, now) {
      if (!rate) return;
      await writeSlot(
        env,
        slot,
        { limit: rate.limit, remaining: rate.remaining, at: now },
        window,
      );
    },
    async spend(now) {
      if (
        (spec.kind !== "per-minute" && spec.kind !== "per-day") ||
        !spec.limit
      )
        return;
      const v = await readSlot(env, slot);
      const fresh = !v || now - v.at >= window;
      const next: StoredRate = fresh
        ? { limit: spec.limit, remaining: spec.limit - 1, at: now }
        : {
            limit: spec.limit,
            remaining: Math.max(0, v.remaining - 1),
            at: v.at,
            ...(v.stopped && typeof v.until === "number"
              ? { stopped: true, until: v.until }
              : {}),
          };
      await writeSlot(env, slot, next, window - (now - next.at));
    },
    async stop(now, seconds) {
      const hold =
        seconds !== undefined && Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds, window)
          : window;
      await writeSlot(
        env,
        slot,
        {
          limit: spec.limit ?? 1,
          remaining: 0,
          stopped: true,
          at: now,
          until: now + hold,
        },
        hold,
      );
    },
  };
}

/** A store key's meter: the adapter's `RateSpec` on the key's slot. */
export function storeMeter(
  env: Env,
  store: StorefrontId,
  product: string,
  key: BudgetKey,
): BudgetMeter {
  return budgetMeter(env, rateSlot(store, product, key), specOf(store));
}

/** What is left of a store key's budget now, or null when nothing is known. */
export function readRate(
  env: Env,
  store: StorefrontId,
  product: string,
  key: BudgetKey,
  now: number,
): Promise<StoredRate | null> {
  return storeMeter(env, store, product, key).read(now);
}

/** Keep a `header` observation (the client parsed it from the store's response). */
export function writeRate(
  env: Env,
  store: StorefrontId,
  product: string,
  key: BudgetKey,
  rate: StoreRate | null,
  now: number,
): Promise<void> {
  return storeMeter(env, store, product, key).observe(rate, now);
}

/** Keep a store's team-key budget after a team-wide call (the apps listing, provisioning). */
export function recordTeamRate(
  env: Env,
  store: StorefrontId,
  rate: StoreRate | null,
  now: number,
): Promise<void> {
  return writeRate(env, store, "", { source: "platform" }, rate, now);
}

/** Whether a store's response should stop the meter (`stopOn403`), with its hold in seconds. */
export function stopsBudget(
  spec: RateSpec,
  status: number,
  retryAfter: string | null,
): { stop: boolean; seconds?: number } {
  if (spec.stopOn403 && status === 403) return { stop: true };
  if (spec.kind === "retry-after" && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return { stop: true, seconds: secs };
  }
  return { stop: false };
}

/**
 * How much the poller may spend, from the remaining share of the limit:
 *
 *   - `full`    ≥ 20 % left (or nothing known): every step;
 *   - `reduced` 5–20 % left: the phased-release step only (nothing else has an operator waiting
 *               on it minute by minute; webhooks still arrive);
 *   - `skip`    < 5 % left, or stopped: nothing this tick. Controls an operator presses are only
 *               held by a stop.
 */
export type PollBudget = "full" | "reduced" | "skip";

export function pollBudget(rate: StoreRate | null): PollBudget {
  if (rate?.stopped) return "skip";
  if (!rate || rate.limit <= 0) return "full";
  const share = rate.remaining / rate.limit;
  if (share < 0.05) return "skip";
  if (share < 0.2) return "reduced";
  return "full";
}

/**
 * Who is spending: the store's `poll`, `background` work no operator is waiting on step by step
 * (the New-app wizard's 10-second app detection, a resumed flow), or an `operator` pressing a
 * control (refused by the meter only while the store has stopped the Worker).
 */
export type StoreSpend = "poll" | "background" | "operator";

/** Whether `spend` may call now. `poll` callers use `pollBudget` for the finer answer. */
export function budgetAllows(
  rate: StoreRate | null,
  spend: StoreSpend,
): boolean {
  if (rate?.stopped) return false;
  if (spend === "operator") return true;
  const level = pollBudget(rate);
  if (spend === "poll") return level !== "skip";
  return level === "full";
}

/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

// The atomic single-use store (I-02, S-16 §3.2 G15 and §5.4 item 8). Every single-use Identity
// artefact (sign-in flow records, portal magic links, device codes and their user-code index,
// email codes, and later WebAuthn challenges and authorization codes) lives here instead of in
// KV, because KV `get` then `delete` is not atomic across regions: two callbacks racing on one
// `state`, or two clicks on one magic link, could both read the record before either delete
// landed. A Durable Object serialises every request to one object and its storage input gate
// makes each read→modify→write below race-free, so `consume` hands a record out AT MOST ONCE.
//
// Sharding: the client (`core/singleUse.ts`) addresses one of `SINGLE_USE_SHARDS` objects by a
// hash of the artefact's address (kind + id), so no object is a global chokepoint and every
// record of one address always lands in the same object. The id is already a peppered hash of
// the secret (R12-04), so a storage listing holds nothing usable.
//
// Records expire on their own: every read treats a record past `exp` as absent, and an alarm
// sweep (as in `RateLimitDO`, R10-04b) deletes expired records so storage stays bounded by the
// live set.
//
// Only the Worker reaches this object (the binding is not routable), and the protocol is one
// JSON `POST` per operation. Nothing here returns WHY an operation failed beyond what its
// caller needs: `consume` and `redeem` answer the same "no" for a missing, expired, dead or
// wrong artefact.

/** One stored artefact. */
export interface SingleUseRecord {
  /** The caller's payload, opaque here except to `update` (which needs a JSON object). */
  v: string;
  /** Epoch milliseconds after which the record is gone. */
  exp: number;
  /** Failed attempts so far. */
  n: number;
  /** Failed attempts that kill the record; absent: unlimited. */
  max?: number;
  /** A secret's hash that `redeem` compares against; never returned. */
  proof?: string;
}

/** The internal payload of a strike counter (`strike`/`locked`). */
interface StrikeState {
  /** Epoch-ms times of the strikes inside the current window, oldest first. */
  hits: number[];
  /** Epoch ms until which the address is locked; absent: not locked. */
  lockedUntil?: number;
}

export type SingleUseOp =
  | {
      op: "put";
      key: string;
      value: string;
      ttlSec: number;
      maxAttempts?: number;
      proof?: string;
      ifAbsent?: boolean;
    }
  | { op: "get"; key: string }
  | { op: "consume"; key: string }
  | { op: "delete"; key: string }
  | { op: "attempt"; key: string }
  | { op: "redeem"; key: string; proof: string }
  | {
      op: "update";
      key: string;
      expect?: Record<string, unknown>;
      set?: Record<string, unknown>;
      unset?: string[];
    }
  | {
      op: "strike";
      key: string;
      windowSec: number;
      threshold: number;
      lockSec: number;
    }
  | { op: "locked"; key: string };

/** How often to sweep, and how many keys one sweep examines (as in `RateLimitDO`). */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 2000;

/** Longest lifetime any artefact may ask for: a day. Bounds a caller bug, not an attacker. */
export const MAX_TTL_SECONDS = 86_400;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `expect` semantics: `null` means "the field is absent (or null)"; anything else must be
 *  deep-equal by JSON encoding. Only top-level fields are compared. */
function matches(
  obj: Record<string, unknown>,
  expect: Record<string, unknown>,
): boolean {
  for (const [field, want] of Object.entries(expect)) {
    const have = obj[field];
    if (want === null) {
      if (have !== undefined && have !== null) return false;
    } else if (JSON.stringify(have) !== JSON.stringify(want)) {
      return false;
    }
  }
  return true;
}

/** Length-independent comparison of two hex digests. */
function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class SingleUseDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  /** The live record at `key`, or null (absent or expired; an expired one is deleted). */
  private async live(
    key: string,
    now: number,
  ): Promise<SingleUseRecord | null> {
    const rec = await this.state.storage.get<SingleUseRecord>(key);
    if (!rec) return null;
    if (rec.exp <= now) {
      await this.state.storage.delete(key);
      return null;
    }
    return rec;
  }

  private async write(key: string, rec: SingleUseRecord): Promise<void> {
    await this.state.storage.put(key, rec);
    await this.ensureSweepScheduled();
  }

  async fetch(request: Request): Promise<Response> {
    let op: SingleUseOp;
    try {
      op = (await request.json()) as SingleUseOp;
    } catch {
      return reply({ error: "bad_request" }, 400);
    }
    if (typeof op?.key !== "string" || op.key === "")
      return reply({ error: "bad_request" }, 400);
    const now = Date.now();
    const storage = this.state.storage;

    switch (op.op) {
      case "put": {
        const ttl = Math.min(
          Math.max(1, Math.floor(op.ttlSec)),
          MAX_TTL_SECONDS,
        );
        if (typeof op.value !== "string" || !Number.isFinite(ttl))
          return reply({ error: "bad_request" }, 400);
        if (op.ifAbsent && (await this.live(op.key, now)))
          return reply({ ok: false });
        const rec: SingleUseRecord = {
          v: op.value,
          exp: now + ttl * 1000,
          n: 0,
        };
        if (typeof op.maxAttempts === "number" && op.maxAttempts > 0)
          rec.max = Math.floor(op.maxAttempts);
        if (typeof op.proof === "string") rec.proof = op.proof;
        await this.write(op.key, rec);
        return reply({ ok: true });
      }
      case "get": {
        const rec = await this.live(op.key, now);
        return reply({ value: rec ? rec.v : null });
      }
      case "consume": {
        const rec = await this.live(op.key, now);
        if (rec) await storage.delete(op.key);
        return reply({ value: rec ? rec.v : null });
      }
      case "delete": {
        await storage.delete(op.key);
        return reply({ ok: true });
      }
      case "attempt": {
        const rec = await this.live(op.key, now);
        if (!rec) return reply({ alive: false, remaining: 0 });
        rec.n += 1;
        if (rec.max !== undefined && rec.n >= rec.max) {
          await storage.delete(op.key);
          return reply({ alive: false, remaining: 0 });
        }
        await storage.put(op.key, rec);
        return reply({
          alive: true,
          remaining: rec.max === undefined ? null : rec.max - rec.n,
        });
      }
      case "redeem": {
        const rec = await this.live(op.key, now);
        if (!rec || rec.proof === undefined || typeof op.proof !== "string")
          return reply({ ok: false });
        if (sameProof(rec.proof, op.proof)) {
          await storage.delete(op.key);
          return reply({ ok: true, value: rec.v });
        }
        rec.n += 1;
        if (rec.max !== undefined && rec.n >= rec.max)
          await storage.delete(op.key);
        else await storage.put(op.key, rec);
        return reply({ ok: false });
      }
      case "update": {
        const rec = await this.live(op.key, now);
        const obj = rec ? parseObject(rec.v) : null;
        if (!rec || !obj)
          return reply({ ok: false, value: rec ? rec.v : null });
        if (op.expect && !matches(obj, op.expect))
          return reply({ ok: false, value: rec.v });
        for (const [field, value] of Object.entries(op.set ?? {}))
          obj[field] = value;
        for (const field of op.unset ?? []) delete obj[field];
        rec.v = JSON.stringify(obj);
        await storage.put(op.key, rec);
        return reply({ ok: true, value: rec.v });
      }
      case "strike": {
        const windowMs = Math.max(1, Math.floor(op.windowSec)) * 1000;
        const lockMs = Math.max(1, Math.floor(op.lockSec)) * 1000;
        const threshold = Math.max(1, Math.floor(op.threshold));
        const rec = await this.live(op.key, now);
        const prior = rec ? (parseObject(rec.v) as StrikeState | null) : null;
        const hits = (Array.isArray(prior?.hits) ? prior.hits : []).filter(
          (t) => typeof t === "number" && t > now - windowMs,
        );
        hits.push(now);
        // Keep no more history than the threshold needs.
        while (hits.length > threshold) hits.shift();
        let lockedUntil =
          typeof prior?.lockedUntil === "number" && prior.lockedUntil > now
            ? prior.lockedUntil
            : undefined;
        if (hits.length >= threshold) lockedUntil = now + lockMs;
        const next: StrikeState = {
          hits,
          ...(lockedUntil ? { lockedUntil } : {}),
        };
        const exp = Math.max(now + windowMs, lockedUntil ?? 0);
        await this.write(op.key, { v: JSON.stringify(next), exp, n: 0 });
        return reply({ locked: lockedUntil !== undefined });
      }
      case "locked": {
        const rec = await this.live(op.key, now);
        const st = rec ? (parseObject(rec.v) as StrikeState | null) : null;
        return reply({
          locked: typeof st?.lockedUntil === "number" && st.lockedUntil > now,
        });
      }
      default:
        return reply({ error: "bad_request" }, 400);
    }
  }

  /** Arm the sweep if it isn't already armed. */
  private async ensureSweepScheduled(): Promise<void> {
    const storage = this.state.storage;
    if (typeof storage.getAlarm !== "function") return;
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /** Delete expired records; re-arm while anything live (or unexamined) remains. */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const now = Date.now();
    const entries = await storage.list<SingleUseRecord>({ limit: SWEEP_BATCH });
    const stale: string[] = [];
    for (const [key, rec] of entries) {
      if (typeof rec?.exp !== "number" || rec.exp <= now) stale.push(key);
    }
    // The storage API deletes at most 128 keys per call.
    for (let i = 0; i < stale.length; i += 128)
      await storage.delete(stale.slice(i, i + 128));
    const remaining = entries.size - stale.length;
    if (remaining > 0 || entries.size === SWEEP_BATCH) {
      await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }
}

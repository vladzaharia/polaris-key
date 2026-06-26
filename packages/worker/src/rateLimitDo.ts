/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

// Atomic fixed-window rate limiter. One Durable Object instance per product
// (`RL.idFromName(product)`); the DO serializes requests and its storage input-gate makes
// the read→increment→write race-free. One stored key per (bucket, id) holds `{window, count}` and
// rolls over when the window advances, so storage stays bounded by the active client set.

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
}

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
      stored && stored.window === window ? stored : { window, count: 0 };

    let ok: boolean;
    if (counter.count >= limit) {
      ok = false;
    } else {
      counter.count += 1;
      await this.state.storage.put(key, counter);
      ok = true;
    }
    return new Response(JSON.stringify({ ok }), {
      headers: { "content-type": "application/json" },
    });
  }
}

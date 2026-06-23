/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

// A fixed-window per-(product, bucket, id) counter in KV — cheap abuse protection on the
// credential-minting hot paths (enroll/token/mint). Not a precise limiter, but enough to
// blunt brute-force + minting floods. Keys are product-scoped like everything else.

export interface RateLimit {
  bucket: string;
  id: string;
  limit: number;
  windowSec: number;
}

/** Returns true if the call is within the limit (and counts it), false if it should 429. */
export async function rateLimitOk(env: Env, product: string, rl: RateLimit, now: number): Promise<boolean> {
  const window = Math.floor(now / rl.windowSec);
  const key = `p:${product}:rl:${rl.bucket}:${rl.id}:${window}`;
  const current = Number((await env.HOT.get(key)) ?? "0");
  if (current >= rl.limit) return false;
  await env.HOT.put(key, String(current + 1), { expirationTtl: rl.windowSec * 2 });
  return true;
}

/** The caller's IP, for per-client limiting (Cloudflare sets cf-connecting-ip). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
}

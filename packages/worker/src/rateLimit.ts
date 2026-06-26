/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

// Abuse protection on the credential-minting hot paths (activate/token/mint) and admin login.
// Backed by an atomic per-product Durable Object (see rateLimitDo.ts) so concurrent bursts
// can't slip past a non-atomic counter. Keyed by (product, bucket, id) — product-scoped like
// everything else.

export interface RateLimit {
  bucket: string;
  id: string;
  limit: number;
  windowSec: number;
}

/** Returns true if the call is within the limit (and counts it), false if it should 429. */
export async function rateLimitOk(
  env: Env,
  product: string,
  rl: RateLimit,
  now: number,
): Promise<boolean> {
  const stub = env.RL.get(env.RL.idFromName(product));
  const res = await stub.fetch("https://rl/check", {
    method: "POST",
    body: JSON.stringify({
      bucket: rl.bucket,
      id: rl.id,
      limit: rl.limit,
      windowSec: rl.windowSec,
      now,
    }),
  });
  const { ok } = (await res.json()) as { ok: boolean };
  return ok;
}

/**
 * The caller's IP, for per-client limiting. Cloudflare sets `cf-connecting-ip` at the edge
 * and it cannot be spoofed by the client; we deliberately do NOT fall back to the
 * client-controlled `x-forwarded-for` header (which would let an attacker rotate the limit
 * key freely). Requests with no edge IP share the `unknown` bucket.
 */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

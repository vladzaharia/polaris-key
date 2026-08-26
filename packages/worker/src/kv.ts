// Hot-path KV. Every key is product-scoped via `pk()` — the ONLY way to build a KV key —
// so a bug can never read another tenant's credentials. KV holds just the two lookups on
// the request hot path: token-hash -> device, and key-hash -> license.

import type { Env } from "./env.js";

/** Build a product-scoped KV key. Never construct raw KV key strings elsewhere. */
export function pk(product: string, kind: string, id: string): string {
  return `p:${product}:${kind}:${id}`;
}

export interface TokenRecord {
  product: string;
  deviceId: string;
  licenseId: string;
}

export async function getTokenRecord(
  env: Env,
  product: string,
  tokenHash: string,
): Promise<TokenRecord | null> {
  const raw = await env.HOT.get(pk(product, "token", tokenHash));
  return raw ? (JSON.parse(raw) as TokenRecord) : null;
}

/**
 * How long a cached token record may outlive its last use (R10-12).
 *
 * D1 — not KV — is the authority for a device token: `validateDeviceToken` falls back to
 * `getDeviceByTokenHash` whenever the record is absent and re-populates it, so expiry costs one
 * indexed read and never a false 401. Without a TTL the namespace was append-only: every token
 * ever minted, including every rotated-away and every revoked one, persisted for the lifetime of
 * the deployment, and a purged record could be resurrected by replaying the dead token. 30 days
 * comfortably exceeds any refresh interval a live client uses.
 */
export const TOKEN_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function putTokenRecord(
  env: Env,
  product: string,
  tokenHash: string,
  rec: TokenRecord,
): Promise<void> {
  await env.HOT.put(pk(product, "token", tokenHash), JSON.stringify(rec), {
    expirationTtl: TOKEN_RECORD_TTL_SECONDS,
  });
}

export async function deleteTokenRecord(
  env: Env,
  product: string,
  tokenHash: string,
): Promise<void> {
  await env.HOT.delete(pk(product, "token", tokenHash));
}

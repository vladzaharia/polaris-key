// Hot-path KV. Every key is product-scoped via `pk()` — the ONLY way to build a KV key —
// so a bug can never read another tenant's credentials. KV holds just the two lookups on
// the request hot path: token-hash -> machine, and key-hash -> license.

import type { Env } from "./env.js";

/** Build a product-scoped KV key. Never construct raw KV key strings elsewhere. */
export function pk(product: string, kind: string, id: string): string {
  return `p:${product}:${kind}:${id}`;
}

export interface TokenRecord {
  product: string;
  machineId: string;
  licenseId: string;
}

export interface KeyRecord {
  product: string;
  licenseId: string;
  status: "active" | "revoked";
}

export async function getTokenRecord(
  env: Env,
  product: string,
  tokenHash: string,
): Promise<TokenRecord | null> {
  const raw = await env.HOT.get(pk(product, "token", tokenHash));
  return raw ? (JSON.parse(raw) as TokenRecord) : null;
}

export async function putTokenRecord(
  env: Env,
  product: string,
  tokenHash: string,
  rec: TokenRecord,
): Promise<void> {
  await env.HOT.put(pk(product, "token", tokenHash), JSON.stringify(rec));
}

export async function deleteTokenRecord(env: Env, product: string, tokenHash: string): Promise<void> {
  await env.HOT.delete(pk(product, "token", tokenHash));
}

export async function getKeyRecord(
  env: Env,
  product: string,
  keyHash: string,
): Promise<KeyRecord | null> {
  const raw = await env.HOT.get(pk(product, "key", keyHash));
  return raw ? (JSON.parse(raw) as KeyRecord) : null;
}

export async function putKeyRecord(
  env: Env,
  product: string,
  keyHash: string,
  rec: KeyRecord,
): Promise<void> {
  await env.HOT.put(pk(product, "key", keyHash), JSON.stringify(rec));
}

export async function deleteKeyRecord(env: Env, product: string, keyHash: string): Promise<void> {
  await env.HOT.delete(pk(product, "key", keyHash));
}

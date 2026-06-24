/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings + secrets. Known bindings are typed; per-product secrets (signing keys,
 * OIDC client secrets, edge-mint key material) are looked up by NAME via `secret(env, ...)`
 * — their names are stored in D1 (e.g. `signing_key_secret`), the values are Worker secrets.
 */
export interface Env {
  // bindings
  DB: D1Database;
  HOT: KVNamespace;
  HUB: DurableObjectNamespace;
  RL: DurableObjectNamespace;

  // platform-wide secrets / vars (optional so tests can omit them)
  KEY_HASH_PEPPER?: string;
  ADMIN_SESSION_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  PLATFORM_ADMIN_GROUP?: string;

  // per-product secrets resolved by name (SIGNING_KEY__<SLUG>, etc.)
  [key: string]: unknown;
}

/** Read a named secret/var from the env (per-product signing keys, OIDC secrets, …). */
export function secret(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

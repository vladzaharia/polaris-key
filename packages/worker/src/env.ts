/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings + platform secrets. Product signing keys, OIDC client secrets, and
 * edge-mint key material are sealed in D1 under PLATFORM_KEK, not stored as Worker secrets.
 */
export interface Env {
  // bindings
  DB: D1Database;
  HOT: KVNamespace;
  RL: DurableObjectNamespace;
  ASSETS?: Fetcher;

  // platform-wide secrets / vars (optional so tests can omit them)
  // The single platform KEK (base64 of 32 random bytes) under which per-product signing keys
  // + secrets are envelope-encrypted in D1. See src/keyvault.ts.
  PLATFORM_KEK?: string;
  PLATFORM_KEK_ID?: string;
  KEY_HASH_PEPPER?: string;
  ADMIN_SESSION_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  PLATFORM_ADMIN_GROUP?: string;

  // additional platform secrets/vars resolved by name
  [key: string]: unknown;
}

/** Read a named platform secret/var from the env. */
export function secret(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

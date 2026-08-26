// Hot-path KV. Product-scoped keys are built with `pk()` — the ONLY way to build a
// product-scoped KV key — so a bug can never read another tenant's credentials. KV holds
// the two lookups on the request hot path (token-hash -> device, key-hash -> license) plus
// two derived caches that are NOT product-scoped because the thing they cache is not:
// `ghInstallationTokenKey()` (below) and the Sparkle verdict memo in `release/sparkle.ts`.
//
// R12-03: the one KV entry that holds a *directly usable* credential — the GitHub App
// installation token — is sealed under `PLATFORM_KEK` before it is written, so a KV dump
// yields ciphertext. Everything else credential-shaped in KV is a hash.

import type { Env } from "./env.js";

/** Build a product-scoped KV key. Never construct raw KV key strings elsewhere. */
export function pk(product: string, kind: string, id: string): string {
  return `p:${product}:${kind}:${id}`;
}

/**
 * KV key for a cached GitHub App installation token (R5-03).
 *
 * Deliberately NOT `pk()`. An installation token is a property of
 * `(installation, down-scope)` and has no product dimension at all: `installId` is what a
 * GitHub App installs against, and one org-wide installation backs every product in that
 * org. Keying it by a caller-supplied "product" string was the bug — `getInstallationToken`'s
 * second argument is the **repo name** at `release/linkRepo.ts` / `release/resync.ts` and the
 * **product slug** at `release/index.ts` / `release/health.ts`, so with `installId` constant
 * those callers shared one cache entry and one caller's broad token was served to another.
 *
 * `scope` is the down-scope the token was minted against — `"<owner>/<repo>"`, or `"*"` for
 * an installation-wide token. Because it is part of the key, a narrow and a broad token can
 * never alias, whatever the caller passes. The `gh:` prefix keeps this out of the `p:`
 * product namespace, where a real slug could otherwise collide with it.
 */
export function ghInstallationTokenKey(
  installId: number,
  scope: string,
): string {
  // owner/repo come from operator-owned config; normalise anyway so no caller-shaped string
  // can inject separators and land on another entry.
  const safe = scope.toLowerCase().replace(/[^a-z0-9._*/-]/g, "_");
  return `gh:install:${installId}:token:${safe}`;
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

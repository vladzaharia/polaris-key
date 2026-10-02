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
  /**
   * The Core blob store (P2-01, `core/blobs.ts`): one R2 bucket per environment holding
   * content-addressed objects under `blobs/`, `bundles/`, `deltas/`, `gated/` (age-locked) and
   * `staging/` (CI uploads, expired after a day). OPTIONAL on purpose: an unbound store means
   * "no blob store", every byte route answers not-found, and the Worker otherwise runs exactly
   * as it did before the binding existed.
   */
  BLOBS?: R2Bucket;
  /**
   * The bytes host's origin, e.g. `https://dl.plrs.im`. A request whose host is this origin's
   * host reaches ONLY the byte routes (`core/bytesHost.ts`); everything else there — the
   * console, the portal, `/docs`, discovery — answers not-found. Unset (or unparsable) ⇒ there
   * is no bytes host and routing is byte-identical to a Worker without it. A `[vars]` value, not
   * a secret: it is public and differs per environment.
   */
  BLOB_ORIGIN?: string;
  /**
   * The console host's origin, e.g. `https://key.plrs.im` (P2b-06). The public download page on
   * the bytes host links the storefront feeds, which are served here, through it. Unset (or
   * equal to the bytes host) ⇒ the page leaves the feed rows (AltStore, SideStore, Obtainium,
   * F-Droid, Scoop) out. A `[vars]` value, public, per environment.
   */
  CONSOLE_ORIGIN?: string;

  // platform-wide secrets / vars (optional so tests can omit them)
  //
  // ── The platform KEK keyring ────────────────────────────────────────────────────────────
  // Per-product signing keys + secrets are envelope-encrypted in D1 under a KEK: one ACTIVE
  // kid for new seals, plus any secondary kids `open` still accepts. Two accepted shapes —
  // see src/keyvault.ts and docs/RUNBOOK.md § "Rotating PLATFORM_KEK".
  //
  //   keyring (rotation-capable, preferred):
  //     PLATFORM_KEK_KEYS   = {"k1":"<base64 of 32 bytes>","k2":"<base64 of 32 bytes>"}
  //     PLATFORM_KEK_ACTIVE = "k2"
  //
  //   legacy single key (exactly equivalent to a one-entry ring; still fully supported):
  //     PLATFORM_KEK    = "<base64 of 32 bytes>"
  //     PLATFORM_KEK_ID = "default"   ← OPTIONAL, and DANGEROUS to change on its own
  //
  /** Legacy single platform KEK: base64 of 32 random bytes. Ignored when PLATFORM_KEK_KEYS
   *  is set. */
  PLATFORM_KEK?: string;
  /** The kid stamped into blobs sealed under the legacy `PLATFORM_KEK`. Defaults to
   *  `"default"`, which is the kid every pre-keyring blob carries.
   *
   *  DO NOT set this to rotate a KEK: it renames the kid `seal` writes AND the only kid the
   *  legacy shape can open, so every existing blob becomes unopenable and every product route
   *  404s. To rotate, move to `PLATFORM_KEK_KEYS`/`PLATFORM_KEK_ACTIVE` — that is the shape
   *  that has a read window. */
  PLATFORM_KEK_ID?: string;
  /** The KEK keyring: a JSON object of kid -> base64 of 32 bytes. EVERY kid listed here can be
   *  opened; only `PLATFORM_KEK_ACTIVE` is sealed under. Write both in ONE `wrangler secret
   *  bulk` call — two `secret put`s deploy two versions, and the intermediate one fails closed
   *  platform-wide. */
  PLATFORM_KEK_KEYS?: string;
  /** The kid within `PLATFORM_KEK_KEYS` that new seals use. Must be a key of that map. */
  PLATFORM_KEK_ACTIVE?: string;
  KEY_HASH_PEPPER?: string;
  ADMIN_SESSION_SECRET?: string;
  PORTAL_SESSION_SECRET?: string;
  PLATFORM_OIDC_ISSUER?: string;
  PLATFORM_OIDC_CLIENT_ID?: string;
  PLATFORM_OIDC_CLIENT_SECRET?: string;
  PORTAL_EMAIL_FROM?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  PLATFORM_ADMIN_GROUP?: string;
  /**
   * Comma/whitespace-separated `host[:port]` allowlist of the identity providers a **repo
   * `.pkey/` manifest** may name as `oidc.issuer` (R9-01).
   *
   * This one FAILS CLOSED: with it unset, no manifest may introduce or change a custom
   * issuer at all — `linkRepo` and `resyncRepo` refuse the push. That is deliberate. The
   * issuer is the base of the token exchange carrying the product's OIDC `client_secret`,
   * and it arrives from a file any repo *writer* can push. Shape validation cannot help,
   * because nothing distinguishes `https://id.example` from `https://exfil.attacker.example`
   * except an operator's knowledge.
   *
   * Issuers ALREADY stored in D1 keep working whether or not this is set — only a new or
   * changed value is gated, so shipping this does not take a running product offline.
   * Products using `provider: "platform"` (e.g. `djdl`) store no issuer and never reach it.
   *
   * Set with: `wrangler secret put OIDC_ISSUER_ALLOWLIST --env prod`
   */
  OIDC_ISSUER_ALLOWLIST?: string;
  EMAIL?: SendEmail;

  // additional platform secrets/vars resolved by name
  [key: string]: unknown;
}

/** Read a named platform secret/var from the env. */
export function secret(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

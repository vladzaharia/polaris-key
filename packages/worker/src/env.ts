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
  /**
   * The atomic single-use store (I-02, `src/singleUseDo.ts`): sign-in flow records, magic links,
   * device codes, email codes. Reached only through `core/singleUse.ts`, which fails closed
   * when it is unbound or unreachable.
   */
  SINGLE_USE: DurableObjectNamespace;
  /**
   * Update-health counters (P6-03, `src/updateHealthDo.ts`): one object per (product,
   * deliverable, release), reached only through `core/updateHealth.ts`. OPTIONAL: unbound, the
   * report still stores its `updates` but counts nothing, and the funnel and auto-halt read no
   * data (auto-halt never trips on missing data).
   */
  UPDATE_HEALTH?: DurableObjectNamespace;
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
   * The blob collector's kill switch (P4-14, `core/blobGc.ts`). A `[vars]` value, never a secret.
   * A-13: read only through the platform settings store (`core/platformSettings.ts`, `ceiling`):
   * `off` here is a hard off; otherwise the console's value, then `on`/unset = on.
   */
  BLOB_GC_MODE?: string;
  /** The collector's grace period in days (default 30, never under 1). A `[vars]` value; A-13: a
   *  console value (1 to 365) wins over it (`runtime` precedence). */
  BLOB_GC_GRACE_DAYS?: string;
  /**
   * Lazy hot-pair deltas (P4-17, `core/deltaDemand.ts`, `services/release/packs/deltas/`): the
   * deployment's kill switch. On lets an opted-in product (`lazy_delta_settings`) count demand
   * and generate deltas. A `[vars]` value, read only through the platform settings store (A-13,
   * `core/platformSettings.ts`, `ceiling`): `off` is a hard off; `runtime` (committed in every
   * environment) lets the console decide, default off; `on` means on unless the console says off.
   */
  LAZY_DELTAS?: string;
  /**
   * The lazy-delta queue (P4-17; `pkey-deltas-<env>`). The main Worker only PRODUCES to it (the
   * nightly sweep's hot pairs); the consumer is its own Worker script (`wrangler.deltas.toml`,
   * `src/deltasEntry.ts`), which produces to it too (an R2 event fans out into pair jobs), so no
   * request ever shares an isolate with an encode. OPTIONAL: unbound, nothing is enqueued.
   */
  DELTA_QUEUE?: Queue<unknown>;
  /**
   * The lazy-delta dead-letter queue (A-14; `pkey-deltas-dlq-<env>`), bound to the request Worker
   * as a producer ONLY so `GET /manage/api/platform/operations` can read its backlog through
   * `metrics()`. Nothing sends to it (the consumer Worker's `dead_letter_queue` setting is what
   * fills it); `test/platformOperations.test.ts` asserts no source file calls `.send` or
   * `.sendBatch` on it. OPTIONAL: unbound, the Operations page reports the DLQ as not bound.
   */
  DELTA_DLQ?: Queue<unknown>;
  /**
   * The consumer's per-side cap in bytes (default 33,554,432 = 32 MiB, notes/S-08 §4.2): a pair
   * with either payload larger is refused as `over-worker-cap`. A `[vars]` value; A-13: a console
   * value (1 MiB to the 32 MiB ceiling, so it can only lower it) wins over it.
   */
  LAZY_DELTA_MAX_BYTES?: string;
  /**
   * The bytes host's origin, e.g. `https://dl.plrs.im`. A request whose host is this origin's
   * host reaches ONLY the byte routes (`core/bytesHost.ts`); everything else there — the
   * console, the portal, `/docs`, discovery — answers not-found. Unset (or unparsable) ⇒ there
   * is no bytes host and routing is byte-identical to a Worker without it. A `[vars]` value, not
   * a secret: it is public and differs per environment.
   */
  BLOB_ORIGIN?: string;
  /**
   * The registry host's origin, e.g. `https://pkg.plrs.im` (F-02, plans/F-01.md §6.1). A request
   * whose host is this origin's host reaches ONLY the registry routes (`core/registryHost.ts`),
   * the host's landing page at `/` and OCI's `/v2/` root; everything else answers not-found.
   * Unset (or unparsable, or equal to the bytes host) ⇒ there is no registry host and routing is
   * byte-identical to a Worker without it. A `[vars]` value, public, per environment.
   */
  PKG_ORIGIN?: string;
  /**
   * The console host's origin, e.g. `https://key.plrs.im` (P2b-06). The public download page on
   * the bytes host links the storefront feeds, which are served here, through it. Unset (or
   * equal to the bytes host) ⇒ the page leaves the feed rows (AltStore, SideStore, Obtainium,
   * F-Droid, Scoop) out. A `[vars]` value, public, per environment.
   */
  CONSOLE_ORIGIN?: string;
  /**
   * Which deployment this Worker is: `prod`, `staging` or `dev` (ADMIN.md A-1). `/manage/api/me`
   * echoes it so the console can badge staging and dev; unset or anything else reads as `null`
   * and no badge shows. A `[vars]` value, public, per environment.
   */
  PKEY_ENVIRONMENT?: string;
  /**
   * Deploy identity (A-11, notes/S-13 §4): the release tag (`v0.8.6`) and the 40-hex commit the
   * production deploy built, injected by `.github/workflows/deploy.yml` as
   * `wrangler deploy --var PKEY_RELEASE_TAG:<tag> --var PKEY_GIT_SHA:<sha>`. Unset in tests, in
   * `wrangler dev` and on a hand deploy, which `GET /manage/api/platform/version` reports as
   * `null`. Public, not secrets; and configuration, so a hand deploy could set anything. The
   * unforgeable half is `CF_VERSION_METADATA`.
   */
  PKEY_RELEASE_TAG?: string;
  PKEY_GIT_SHA?: string;
  /**
   * The version metadata binding (A-11; `[env.*.version_metadata]` in both wrangler configs, NOT
   * inherited from the top level): Cloudflare's own `{ id, tag, timestamp }` for the running
   * version. Configuration cannot forge it. OPTIONAL: absent in the Node test lane.
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata;

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
  /**
   * A-16 — the platform's TEAM-level store credentials, for ops bootstrap. Each is JSON of the
   * same shape as the outlet-credential kind it stands in for, and is consulted only when no
   * console-managed credential is stored (Platform → Store connections). The API and console show
   * presence and metadata only. A product uses one only for the app a platform admin assigned to
   * it (`core/platformCredentials.ts`). Set with `wrangler secret put <NAME> --env prod`.
   *
   *   PLATFORM_ASC_API_KEY            {"keyId","issuerId","p8"}            (asc-api-key)
   *   PLATFORM_APP_STORE_SERVER_KEY   {"keyId","issuerId","p8"}            (app-store-server-key)
   *   PLATFORM_GOOGLE_SERVICE_ACCOUNT the service account's JSON key file  (google-service-account)
   *   PLATFORM_MS_PARTNER_CENTER      {"tenantId","clientId","clientSecret","sellerId"}
   *   PLATFORM_STEAM_PUBLISHER_KEY    {"key"}                              (steam-publisher-key)
   */
  PLATFORM_ASC_API_KEY?: string;
  PLATFORM_APP_STORE_SERVER_KEY?: string;
  PLATFORM_GOOGLE_SERVICE_ACCOUNT?: string;
  PLATFORM_MS_PARTNER_CENTER?: string;
  PLATFORM_STEAM_PUBLISHER_KEY?: string;
  /** A-16 — the Apple Developer Team ID (10 characters), App Attest's platform default. Not
   *  secret: a var or a secret. A console value (Platform → Store connections) wins over it. */
  PLATFORM_APPLE_TEAM_ID?: string;
  EMAIL?: SendEmail;

  // additional platform secrets/vars resolved by name
  [key: string]: unknown;
}

/** Read a named platform secret/var from the env. */
export function secret(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

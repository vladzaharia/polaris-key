/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings + platform secrets. Product signing keys, OIDC client secrets, and
 * edge-mint key material are sealed in D1 under PLATFORM_KEK, not stored as Worker secrets.
 *
 * ST-02 (notes/S-18 §4.13): this interface is the source of the platform inventory. Every member
 * carries one `@inventory <kind> <area>` tag on its own JSDoc line, and a registry-backed var also
 * `@editable <key>` (its `PLATFORM_SETTINGS` key, `core/platformSettings.ts`):
 *
 *   kind  `binding` a Cloudflare binding (`wrangler.toml`), never a string
 *         `var`     a value the console may show (a `[vars]` entry, a `--var` injected at deploy,
 *                   or a non-secret identifier set with `wrangler secret put`)
 *         `secret`  credential material: reported as present or absent, NEVER a value
 *   area  deployment · identity · delivery · email · keyring · stores · jobs
 *
 * `pnpm gen:platform-inventory` writes `platformInventory.generated.ts` from these tags. Its
 * `--check` mode (also the worker suite's `platformInventory` test) fails when a member has no
 * valid tag, when the generated file is stale, when a wrangler config names a var or binding this
 * interface lacks, when a var or secret here is named nowhere in `wrangler.toml`, when a secret is
 * missing from its required-secrets comment, or when `src/` reads a name this interface lacks.
 */
export interface Env {
  // bindings
  /**
   * The D1 database.
   * @inventory binding deployment
   */
  DB: D1Database;
  /**
   * The hot-path KV namespace.
   * @inventory binding deployment
   */
  HOT: KVNamespace;
  /**
   * The per-subject rate limiter (`RateLimitDO`).
   * @inventory binding deployment
   */
  RL: DurableObjectNamespace;
  /**
   * The atomic single-use store (I-02, `src/singleUseDo.ts`): sign-in flow records, magic links,
   * device codes, email codes. Reached only through `core/singleUse.ts`, which fails closed
   * when it is unbound or unreachable.
   * @inventory binding identity
   */
  SINGLE_USE: DurableObjectNamespace;
  /**
   * Update-health counters (P6-03, `src/updateHealthDo.ts`): one object per (product,
   * deliverable, release), reached only through `core/updateHealth.ts`. OPTIONAL: unbound, the
   * report still stores its `updates` but counts nothing, and the funnel and auto-halt read no
   * data (auto-halt never trips on missing data).
   * @inventory binding jobs
   */
  UPDATE_HEALTH?: DurableObjectNamespace;
  /**
   * The assembled console + docs assets root (`scripts/assemble-assets.mjs`).
   * @inventory binding deployment
   */
  ASSETS?: Fetcher;
  /**
   * The Core blob store (P2-01, `core/blobs.ts`): one R2 bucket per environment holding
   * content-addressed objects under `blobs/`, `bundles/`, `deltas/`, `gated/` (age-locked) and
   * `staging/` (CI uploads, expired after a day). OPTIONAL on purpose: an unbound store means
   * "no blob store", every byte route answers not-found, and the Worker otherwise runs exactly
   * as it did before the binding existed.
   * @inventory binding delivery
   */
  BLOBS?: R2Bucket;
  /**
   * The Cloudflare Images binding (S-20 §6.3 step 6, §6.6). OPTIONAL: `core/hostedAssets.ts` reads
   * an ingested image's dimensions with `.info()` when it is bound, and records none otherwise.
   * HA-03 binds it in `wrangler.toml` and builds the variant ladder with it.
   * @inventory binding delivery
   */
  IMAGES?: ImagesBinding;
  /**
   * The blob collector's kill switch (P4-14, `core/blobGc.ts`). A `[vars]` value, never a secret.
   * A-13: read only through the platform settings store (`core/platformSettings.ts`, `ceiling`):
   * `off` here is a hard off; otherwise the console's value, then `on`/unset = on.
   * @inventory var jobs
   * @editable BLOB_GC_MODE
   */
  BLOB_GC_MODE?: string;
  /**
   * The collector's grace period in days (default 30, never under 1). A `[vars]` value; A-13: a
   * console value (1 to 365) wins over it (`runtime` precedence).
   * @inventory var jobs
   * @editable BLOB_GC_GRACE_DAYS
   */
  BLOB_GC_GRACE_DAYS?: string;
  /**
   * S-19 §7.4 (LX-05): `warn` or `error`, the severity of an incompatible reserved entitlement-name
   * declaration at manifest ingest and on console catalog writes. A `[vars]` value, unset in every
   * environment; read only through the platform settings store (`runtime`): a console value wins,
   * then this, then the code default `warn`.
   * @inventory var licensing
   * @editable LICENSING_RESERVED_NAMES
   */
  LICENSING_RESERVED_NAMES?: string;
  /**
   * Lazy hot-pair deltas (P4-17, `core/deltaDemand.ts`, `services/release/packs/deltas/`): the
   * deployment's kill switch. On lets an opted-in product (`lazy_delta_settings`) count demand
   * and generate deltas. A `[vars]` value, read only through the platform settings store (A-13,
   * `core/platformSettings.ts`, `ceiling`): `off` is a hard off; `runtime` (committed in every
   * environment) lets the console decide, default off; `on` means on unless the console says off.
   * @inventory var jobs
   * @editable LAZY_DELTAS
   */
  LAZY_DELTAS?: string;
  /**
   * The lazy-delta queue (P4-17; `pkey-deltas-<env>`). The main Worker only PRODUCES to it (the
   * nightly sweep's hot pairs); the consumer is its own Worker script (`wrangler.deltas.toml`,
   * `src/deltasEntry.ts`), which produces to it too (an R2 event fans out into pair jobs), so no
   * request ever shares an isolate with an encode. OPTIONAL: unbound, nothing is enqueued.
   * @inventory binding jobs
   */
  DELTA_QUEUE?: Queue<unknown>;
  /**
   * The lazy-delta dead-letter queue (A-14; `pkey-deltas-dlq-<env>`), bound to the request Worker
   * as a producer ONLY so `GET /manage/api/platform/operations` can read its backlog through
   * `metrics()`. Nothing sends to it (the consumer Worker's `dead_letter_queue` setting is what
   * fills it); `test/platformOperations.test.ts` asserts no source file calls `.send` or
   * `.sendBatch` on it. OPTIONAL: unbound, the Operations page reports the DLQ as not bound.
   * @inventory binding jobs
   */
  DELTA_DLQ?: Queue<unknown>;
  /**
   * The consumer's per-side cap in bytes (default 33,554,432 = 32 MiB, notes/S-08 §4.2): a pair
   * with either payload larger is refused as `over-worker-cap`. A `[vars]` value; A-13: a console
   * value (1 MiB to the 32 MiB ceiling, so it can only lower it) wins over it.
   * @inventory var jobs
   * @editable LAZY_DELTA_MAX_BYTES
   */
  LAZY_DELTA_MAX_BYTES?: string;
  /**
   * The bytes host's origin, e.g. `https://dl.plrs.im`. A request whose host is this origin's
   * host reaches ONLY the byte routes (`core/bytesHost.ts`); everything else there — the
   * console, the portal, `/docs`, discovery — answers not-found. Unset (or unparsable) ⇒ there
   * is no bytes host and routing is byte-identical to a Worker without it. A `[vars]` value, not
   * a secret: it is public and differs per environment.
   * @inventory var delivery
   */
  BLOB_ORIGIN?: string;
  /**
   * The registry host's origin, e.g. `https://pkg.plrs.im` (F-02, plans/F-01.md §6.1). A request
   * whose host is this origin's host reaches ONLY the registry routes (`core/registryHost.ts`),
   * the host's landing page at `/` and OCI's `/v2/` root; everything else answers not-found.
   * Unset (or unparsable, or equal to the bytes host) ⇒ there is no registry host and routing is
   * byte-identical to a Worker without it. A `[vars]` value, public, per environment.
   * @inventory var delivery
   */
  PKG_ORIGIN?: string;
  /**
   * The console host's origin, e.g. `https://key.plrs.im` (P2b-06). The public download page on
   * the bytes host links the storefront feeds, which are served here, through it. Unset (or
   * equal to the bytes host) ⇒ the page leaves the feed rows (AltStore, SideStore, Obtainium,
   * F-Droid, Scoop) out. A `[vars]` value, public, per environment.
   * @inventory var delivery
   */
  CONSOLE_ORIGIN?: string;
  /**
   * Trusted publishing (P2-02, `core/publisher.ts`): the bucket name the upload tickets' R2
   * temporary credentials are scoped to (the same bucket as `BLOBS`; the S3 API names buckets,
   * the binding does not). A `[vars]` value, public, per environment.
   * @inventory var delivery
   */
  BLOBS_BUCKET_NAME?: string;
  /**
   * Trusted publishing (P2-02): the Cloudflare account id (32 hex) the R2 S3 API is reached
   * through. An identifier, not credential material; set with `wrangler secret put`.
   * @inventory var delivery
   */
  R2_ACCOUNT_ID?: string;
  /**
   * Trusted publishing (P2-02): the parent R2 API token's access key id, from which the upload
   * tickets' temporary credentials are derived. Unset ⇒ `/release/publish/uploads` answers 404.
   * @inventory secret delivery
   */
  R2_PARENT_ACCESS_KEY_ID?: string;
  /**
   * Trusted publishing (P2-02): the parent R2 API token's secret access key.
   * @inventory secret delivery
   */
  R2_PARENT_SECRET_ACCESS_KEY?: string;
  /**
   * Which deployment this Worker is: `prod`, `staging` or `dev` (ADMIN.md A-1). `/manage/api/me`
   * echoes it so the console can badge staging and dev; unset or anything else reads as `null`
   * and no badge shows. A `[vars]` value, public, per environment.
   * @inventory var deployment
   */
  PKEY_ENVIRONMENT?: string;
  /**
   * Deploy identity (A-11, notes/S-13 §4): the release tag (`v0.8.6`) and the 40-hex commit the
   * production deploy built, injected by `.github/workflows/deploy.yml` as
   * `wrangler deploy --var PKEY_RELEASE_TAG:<tag> --var PKEY_GIT_SHA:<sha>`. Unset in tests, in
   * `wrangler dev` and on a hand deploy, which `GET /manage/api/platform/version` reports as
   * `null`. Public, not secrets; and configuration, so a hand deploy could set anything. The
   * unforgeable half is `CF_VERSION_METADATA`.
   * @inventory var deployment
   */
  PKEY_RELEASE_TAG?: string;
  /**
   * Deploy identity (A-11): the 40-hex commit, injected beside `PKEY_RELEASE_TAG`.
   * @inventory var deployment
   */
  PKEY_GIT_SHA?: string;
  /**
   * The deploy hook's policy (F-10 automation, `src/platformDeploy.ts`): the platform monorepo
   * (`owner/repo`) and GitHub's NUMERIC ids for it and its owner, whose
   * `.github/workflows/deploy.yml` may call `POST /webhooks/deploy` with its OIDC token, from the
   * `PLATFORM_DEPLOY_ENVIRONMENT` environment (default `production`). Public `[vars]`, not
   * secrets: the token is what authenticates. Any of the three unset ⇒ there is no deploy hook.
   * @inventory var deployment
   */
  PLATFORM_REPOSITORY?: string;
  /**
   * The deploy hook: GitHub's numeric id of `PLATFORM_REPOSITORY`.
   * @inventory var deployment
   */
  PLATFORM_REPOSITORY_ID?: string;
  /**
   * The deploy hook: GitHub's numeric id of `PLATFORM_REPOSITORY`'s owner.
   * @inventory var deployment
   */
  PLATFORM_REPOSITORY_OWNER_ID?: string;
  /**
   * The deploy hook: the GitHub environment the deploy job must run in (default `production`).
   * @inventory var deployment
   */
  PLATFORM_DEPLOY_ENVIRONMENT?: string;
  /**
   * The version metadata binding (A-11; `[env.*.version_metadata]` in both wrangler configs, NOT
   * inherited from the top level): Cloudflare's own `{ id, tag, timestamp }` for the running
   * version. Configuration cannot forge it. OPTIONAL: absent in the Node test lane.
   * @inventory binding deployment
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
  //   both (the rotation path when nobody holds the current PLATFORM_KEK): the ring is
  //   PLATFORM_KEK_KEYS, plus PLATFORM_KEK under its legacy kid for OPENING ONLY. New seals use
  //   PLATFORM_KEK_ACTIVE, which must be a PLATFORM_KEK_KEYS entry. The same kid in both with
  //   different bytes fails closed. RUNBOOK § "Rotating when the old KEK is unknown".
  //
  /**
   * Legacy single platform KEK: base64 of 32 random bytes. On its own it is the whole ring.
   * Beside PLATFORM_KEK_KEYS it is the legacy key: open-only, under the kid PLATFORM_KEK_ID
   * names, kept until the sweep has re-sealed every value under it, then deleted.
   * @inventory secret keyring
   */
  PLATFORM_KEK?: string;
  /**
   * The kid stamped into blobs sealed under the legacy `PLATFORM_KEK`, and the kid that key opens
   * under when it sits beside `PLATFORM_KEK_KEYS`. Defaults to `"default"`, which is the kid every
   * pre-keyring blob carries.
   *
   * DO NOT set this to rotate a KEK: it renames the kid `seal` writes AND the only kid the
   * legacy shape can open, so every existing blob becomes unopenable and every product route
   * 404s. To rotate, move to `PLATFORM_KEK_KEYS`/`PLATFORM_KEK_ACTIVE` — that is the shape
   * that has a read window. A kid NAME, not key material.
   * @inventory var keyring
   */
  PLATFORM_KEK_ID?: string;
  /**
   * The KEK keyring: a JSON object of kid -> base64 of 32 bytes. EVERY kid listed here can be
   * opened; only `PLATFORM_KEK_ACTIVE` is sealed under. Write both in ONE `wrangler secret
   * bulk` call — two `secret put`s deploy two versions, and the intermediate one fails closed
   * platform-wide.
   * @inventory secret keyring
   */
  PLATFORM_KEK_KEYS?: string;
  /**
   * The kid within `PLATFORM_KEK_KEYS` that new seals use. Must be a key of that map. A kid
   * NAME, not key material.
   * @inventory var keyring
   */
  PLATFORM_KEK_ACTIVE?: string;
  /**
   * The pepper of the stored licence-key hashes.
   * @inventory secret keyring
   */
  KEY_HASH_PEPPER?: string;
  /**
   * F-21 (plans/F-20.md §6.4): the HMAC key of the registry host's OCI pull tokens (32 random
   * bytes, base64). With it unset, `GET /v2/token` answers 503 and `GET /v2/` stays a plain 200;
   * once set, `/v2/` challenges callers without a valid pull token (Q1). Set per environment
   * before deploying: `wrangler secret put REGISTRY_TOKEN_KEY --env <env>`.
   * @inventory secret keyring
   */
  REGISTRY_TOKEN_KEY?: string;
  /**
   * The previous `REGISTRY_TOKEN_KEY`, still accepted for verification during a rotation (pull
   * tokens live 300 s, so it can be removed five minutes after the new key is live).
   * @inventory secret keyring
   */
  REGISTRY_TOKEN_KEY_PREVIOUS?: string;
  /**
   * PX-W3 (plans/PX-W3.md §6.1): the HMAC key of the portal's download tickets (32 random bytes,
   * base64, used as string HMAC material like `REGISTRY_TOKEN_KEY`). With it unset, licensed
   * files held only on R2 stay `not_hosted` in the portal and the bytes host ignores `?ticket=`.
   * Set per environment: `wrangler secret put DOWNLOAD_TICKET_KEY --env <env>`.
   * @inventory secret keyring
   */
  DOWNLOAD_TICKET_KEY?: string;
  /**
   * The previous `DOWNLOAD_TICKET_KEY`, still accepted for verification during a rotation
   * (tickets live 120 s, so it can be removed two minutes after the new key is live).
   * @inventory secret keyring
   */
  DOWNLOAD_TICKET_KEY_PREVIOUS?: string;
  /**
   * Signs console sessions.
   * @inventory secret identity
   */
  ADMIN_SESSION_SECRET?: string;
  /**
   * Signs customer portal sessions (falls back to `ADMIN_SESSION_SECRET` when unset).
   * @inventory secret identity
   */
  PORTAL_SESSION_SECRET?: string;
  /**
   * The shared platform identity provider's issuer (the portal and `provider: platform`
   * products; the console too until `ADMIN_OIDC_*` is set).
   * @inventory var identity
   */
  PLATFORM_OIDC_ISSUER?: string;
  /**
   * The shared platform client's id.
   * @inventory var identity
   */
  PLATFORM_OIDC_CLIENT_ID?: string;
  /**
   * The shared platform client's secret.
   * @inventory secret identity
   */
  PLATFORM_OIDC_CLIENT_SECRET?: string;
  /**
   * The console's own operator sign-in client (I-03). Read by `adminOidcConfig` only; when the
   * issuer or client id is unset the console falls back to `PLATFORM_OIDC_*`. The portal and
   * `provider: platform` products never read these. Set all three in ONE `wrangler secret
   * bulk` call so no deployed version sees half a trio.
   * @inventory var identity
   */
  ADMIN_OIDC_ISSUER?: string;
  /**
   * The console client's id (I-03).
   * @inventory var identity
   */
  ADMIN_OIDC_CLIENT_ID?: string;
  /**
   * The console client's secret (I-03).
   * @inventory secret identity
   */
  ADMIN_OIDC_CLIENT_SECRET?: string;
  /**
   * I-06: the login card's platform sign-in clients (`services/identity/providers/config.ts`).
   * The ids are plain vars; the three secrets are SEALED blobs (`pnpm --filter
   * @polaris-key/worker signin:seal`), not raw credentials. A provider is offered only when all
   * of its values are set and its sealed secret opens. This one: the Google client id.
   * @inventory var identity
   */
  SIGNIN_GOOGLE_CLIENT_ID?: string;
  /**
   * I-06: the Google client secret, sealed under `PLATFORM_KEK`.
   * @inventory secret identity
   */
  SIGNIN_GOOGLE_CLIENT_SECRET?: string;
  /**
   * I-06: the Apple Services ID (Polaris's Sign in with Apple client).
   * @inventory var identity
   */
  SIGNIN_APPLE_SERVICES_ID?: string;
  /**
   * I-06: the Apple team id that owns the Services ID.
   * @inventory var identity
   */
  SIGNIN_APPLE_TEAM_ID?: string;
  /**
   * I-06: the id of the Sign in with Apple key.
   * @inventory var identity
   */
  SIGNIN_APPLE_KEY_ID?: string;
  /**
   * I-06: the Sign in with Apple `.p8` key, sealed under `PLATFORM_KEK`.
   * @inventory secret identity
   */
  SIGNIN_APPLE_PRIVATE_KEY?: string;
  /**
   * I-06: the Steam Web API key, sealed under `PLATFORM_KEK`.
   * @inventory secret identity
   */
  SIGNIN_STEAM_WEB_API_KEY?: string;
  /**
   * Older sender setting ("Name <addr>"). Only its ADDRESS is still honoured, and only while
   * `EMAIL_SENDER_ADDRESS` is unset; the display name is never configurable (I-18).
   * @inventory var email
   */
  PORTAL_EMAIL_FROM?: string;
  /**
   * I-18: the one shared sender address (a bare `local@domain` on the auth sending subdomain,
   * `noreply@auth.plrs.im`, once the owner has onboarded it on Email Sending). Unset = the
   * legacy `noreply@plrs.im` (`core/emailSender.ts`).
   * @inventory var email
   */
  EMAIL_SENDER_ADDRESS?: string;
  /**
   * I-18: the deploy-wide daily cap on one product's passthrough sign-in mail (a positive
   * integer). A product's `email_product_caps` row wins; unset = the code default (500).
   * @inventory var email
   */
  EMAIL_PRODUCT_DAILY_CAP?: string;
  /**
   * I-18: `"registered"` once the owner has registered the sender domain and address for Apple's
   * private email relay; until then relay recipients get `email_unavailable`, not a bounce.
   * @inventory var email
   */
  EMAIL_APPLE_RELAY?: string;
  /**
   * The GitHub App's numeric id (manifest sync and webhooks).
   * @inventory var delivery
   */
  GITHUB_APP_ID?: string;
  /**
   * The GitHub App's private key.
   * @inventory secret delivery
   */
  GITHUB_APP_PRIVATE_KEY?: string;
  /**
   * The GitHub App's webhook signing secret.
   * @inventory secret delivery
   */
  GITHUB_WEBHOOK_SECRET?: string;
  /**
   * The identity-provider group whose members are platform admins (`admin/authz.ts`).
   * @inventory var identity
   */
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
   * @inventory var identity
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
   *
   * @inventory secret stores
   */
  PLATFORM_ASC_API_KEY?: string;
  /**
   * A-16: the team App Store Server API key (see `PLATFORM_ASC_API_KEY`).
   * @inventory secret stores
   */
  PLATFORM_APP_STORE_SERVER_KEY?: string;
  /**
   * A-16: the team Google service account (see `PLATFORM_ASC_API_KEY`).
   * @inventory secret stores
   */
  PLATFORM_GOOGLE_SERVICE_ACCOUNT?: string;
  /**
   * A-16: the team Microsoft Partner Center credential (see `PLATFORM_ASC_API_KEY`).
   * @inventory secret stores
   */
  PLATFORM_MS_PARTNER_CENTER?: string;
  /**
   * A-16: the team Steam publisher key (see `PLATFORM_ASC_API_KEY`).
   * @inventory secret stores
   */
  PLATFORM_STEAM_PUBLISHER_KEY?: string;
  /**
   * A-16 — the Apple Developer Team ID (10 characters), App Attest's platform default. Not
   * secret: a var or a secret. A console value (Platform → Store connections) wins over it.
   * @inventory var stores
   */
  PLATFORM_APPLE_TEAM_ID?: string;
  /**
   * Cloudflare Email Service (I-18): sign-in and account mail.
   * @inventory binding email
   */
  EMAIL?: SendEmail;
  /**
   * I-07 — Cloudflare Turnstile on the login card's email start (S-16 §5.4 item 4). The site key
   * is public (a var; the portal reads it from `/api/capabilities`), the secret key is a secret
   * (`wrangler secret put TURNSTILE_SECRET_KEY --env prod`). With no secret configured the
   * Worker does not ask for a token (local development and tests); production sets both
   * (RUNBOOK "Login card"). This one: the public site key.
   * @inventory var identity
   */
  TURNSTILE_SITE_KEY?: string;
  /**
   * I-07 — the Turnstile secret key; with it unset the email start asks for no token.
   * @inventory secret identity
   */
  TURNSTILE_SECRET_KEY?: string;

  // additional platform secrets/vars resolved by name
  [key: string]: unknown;
}

/** Read a named platform secret/var from the env. */
export function secret(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

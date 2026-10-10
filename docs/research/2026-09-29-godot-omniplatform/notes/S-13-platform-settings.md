> Research note for [Godot on Polaris Key](../README.md), 2026-10-03. Spike S-13, commissioned
> by the lead on the owner's direction of 2026-10-03 (an instance-wide Settings & Version page),
> widened the same day to a **Platform section** of the console (Settings, Deployment,
> Operations). It has no program brief: the admin overhaul is tracked in
> [`docs/design/ADMIN.md`](../../../design/ADMIN.md) §7, not in `workpackages.json`, so the
> breakdown in §9 proposes ids in ADMIN.md's own namespace. Research and design only: no product
> code changed, nothing was deployed, and no Cloudflare credential was used. File references are
> to the tree at `25e6209c` (`W/` = `packages/worker/`, `A/` = `packages/admin/src/`).

# S-13: the Platform section: settings, deployment and operations

Evidence tags, as in the other notes:

- **[V]**: primary source read raw (this repo's code, config and docs; the installed
  `@cloudflare/workers-types` and `wrangler` 4.116.0);
- **[M]**: measured here (a command run on this machine);
- **[D]**: read in Cloudflare's documentation on 2026-10-03;
- **[U]**: unverified: needs the owner's account or a staging deploy (§10 lists each one);
- **[I]**: inference or recommendation.

## 1. Question

The owner wants an instance-wide console page that (a) shows what version of Polaris Key is
deployed and (b) holds every setting that applies to the platform as a whole. A second owner
note widened it: the console should also show deployment information, Worker status, queues and
similar operational data. The lead recommended a **Platform** sidebar section with three pages,
Settings, Deployment and Operations, with S-12's Package feeds as a sibling.

The spike answers:

1. Which version facts can the Worker know, and how does each get there?
2. Which platform-wide settings exist today? For each: is it deploy-time only (shown
   read-only), safe to make runtime-editable (stored in D1, audited), or a secret (presence
   only)? Which editable settings come first, and what is the storage design?
3. What is the security model, and does the threat model change?
4. What do the pages look like within ADMIN.md, and what admin API do they need?
5. Where does the operational data come from: self-reported, Cloudflare's APIs, or a mix? What
   would the owner have to provision?
6. What is the work-package breakdown?

## 2. Short answer

- **Fill the reserved slot, but as a section, not a page.** ADMIN.md reserves one global
  Platform page (`#/platform`, T4: KEK keyring, environment, session, build version;
  `docs/design/ADMIN.md:267`). It is declared in `A/console/nav.ts:575-584` with `ready: false`
  and redirects to Home. The widened scope fits a **Platform section** better:
  - **Settings** (T4): settings by area, the KEK keyring, and secrets presence;
  - **Deployment**: the current build, deploy history, D1 migrations, bindings and the two
    deployed scripts;
  - **Operations** (T1 dashboard): health, the queue and DLQ, cron steps, connectors, storage
    and recent errors;
  - **Package feeds** (S-12), a sibling the S-12 spike designs.

  `#/platform` redirects to `#/platform/settings`. [I]

- **Version identity costs one deploy-step change and one binding.**
  - `wrangler deploy` in `deploy.yml` gains `--var PKEY_RELEASE_TAG:<tag>`,
    `--var PKEY_GIT_SHA:<sha>`, `--tag <tag>` and `--message <sha>`. wrangler 4.116.0 supports
    all four on `deploy` [M].
  - A `[version_metadata]` binding gives the Worker its own Cloudflare version id and upload
    timestamp, which configuration cannot forge [D][V].
  - The deploy step also writes one `platform_deploys` row with the GitHub Actions run URL. The
    Worker never calls GitHub or Cloudflare to learn its own history. [I]
- **Settings today are almost all deploy-time.**
  - There is **no** platform settings table: every D1 settings table is per product
    (`lazy_delta_settings`, `dist_connector_settings`, `portal_product_settings`).
  - There is **no product-less audit trail**: `audit.product` is `NOT NULL REFERENCES products`
    (`W/migrations/0001_init.sql:181-195`), so the KEK re-seal sweep writes one row into each
    product it touched (`W/src/admin/handlers/products.ts:838-850`).
  - The inventory (§5) finds 8 `[vars]`, 22 secret or secret-shaped names (3 of them legacy
    aliases), 8 bindings, 2 crons, and dozens of code constants that act as policy (TTLs,
    about 30 rate-limit buckets, retention).
- **Make four settings runtime-editable first, all operational kill switches or tunables of
  background jobs:** `BLOB_GC_MODE`, `BLOB_GC_GRACE_DAYS`, `LAZY_DELTAS` and
  `LAZY_DELTA_MAX_BYTES`.
  - Today each needs an edit to `wrangler.toml` and a deploy (`docs/RUNBOOK.md:477-512`).
    `LAZY_DELTAS` needs **two** deploys, because both scripts read it.
  - Nothing that is an origin, an identity root, a privilege root, key material or a security
    gate becomes editable. [I]
- **Storage:** one `platform_settings` table and one `platform_audit` table.
  - A typed registry in code is the only list of editable keys.
  - Precedence: a valid D1 value, then the `[vars]` value, then the code default. Kill switches
    work differently: `[vars]` can **force off**, and D1 decides only when `[vars]` allows it.
  - Each isolate caches the table for 30 s. Writes use `expectedVersion`, and every write
    records the before and after values. [I]
- **Operations data: hybrid, self-reported first.** Almost everything the owner listed can come
  from the Worker itself, with no Cloudflare token:
  - queue backlog through `Queue.metrics()`, a binding method added in April 2026 [D][V];
  - D1 size through `meta.size_after` [D][V];
  - R2 committed bytes from `blob_objects.size` [V];
  - required indexes through the existing `missingRequiredIndexes` [V];
  - cron step outcomes, persisted from the report that `handleScheduled` already builds [V];
  - consumer heartbeats.

  What only Cloudflare can see goes in an **optional** second phase, behind an account-owned
  token with one permission, _Account Analytics: Read_, used by the GraphQL Analytics API [D]:
  request and error rates and CPU per script, KV usage, and DLQ operations. No write-capable
  token ever reaches the Worker. [I]

- **Seven work packages** (§9): five Worker additions and three console pages. The additions
  are A-11 deploy identity, A-12 platform audit, A-13 settings store, A-14 self-reported
  operations and A-15 the optional analytics adapter. The pages are chunk 4P-1 Settings, 4P-2
  Deployment and 4P-3 Operations. The Worker additions can start now. The pages wait for ADMIN.md
  chunk 3 (the component system). None touches the wire: no corpus, transcript or
  `PROTOCOL_VERSION` change, and admin routes are narrative-only under rule 10. [V][I]
- **Three owner decisions** (§11): the operations data source and token; runtime precedence
  and the first editable set; and the IA amendment.

## 3. Method

1. Read `AGENTS.md`, `docs/design/ADMIN.md` (§2 IA, §3 T1/T4, §5.2 destructive levels, §5.10
   permissions, §6.9 product Settings, §7 chunks and API additions, lead decisions) and
   `docs/design/BRAND.md` §6.
2. Read the Worker's configuration surface:
   - `W/src/env.ts` in full;
   - `W/wrangler.toml` and `W/wrangler.deltas.toml`;
   - every `env.X`, `env["X"]` and `secret(env, "X")` reference under `W/src`, enumerated with
     `git grep` [M];
   - the code constants named `*_TTL*`, `*_SECONDS`, `*_DAYS`, `*LIMIT*` and `*RETENTION*`, and
     every `rateLimitOk` bucket [M].
3. Read the admin surface:
   - `W/src/admin/api.ts` (posture and routing);
   - `authz.ts` and `audit.ts`;
   - `handlers/me.ts`;
   - the KEK keyring handler in `handlers/products.ts`;
   - the route-coverage test (`W/test/routeCoverage.test.ts:33-49`);
   - `W/src/scheduled.ts`;
   - the console's `A/console/nav.ts`, `routes.ts` and `shell/Sidebar.tsx`.
4. Read the operations material:
   - `.github/workflows/deploy.yml`;
   - `docs/DEPLOYMENT.md` §3–4 and `docs/RUNBOOK.md` (KEK, blob collector, lazy deltas);
   - `docs/security/THREAT-MODEL.md` §2 (assets), AT-2 (admin plane), §9 (review triggers) and
     the P4-17 section.
5. Checked the Cloudflare side against the docs (2026-10-03) and the installed tooling:
   - version metadata binding;
   - `wrangler deploy` flags (also `npx wrangler deploy --help` on 4.116.0 [M]);
   - `Queue.metrics()` (the `@cloudflare/workers-types@4.20260623.1` declarations [V]);
   - `D1Result.meta.size_after`;
   - GraphQL Analytics datasets, the token permission and rate limits;
   - R2 metrics;
   - granular Workers token roles.
6. Did not read S-12's note: it had no commits yet. Package feeds is referenced only as a
   sibling page.

## 4. Version information: what the Worker can know

| Fact                               | Source today                                                                                         | Proposed source                                                                                                                                                                                                                                                                                                                     | Safe to show? |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Release tag (`v0.8.6`)             | none in the Worker; the tag only gates `deploy.yml:42-46`                                            | `--var PKEY_RELEASE_TAG:$TAG` on `wrangler deploy` (`deploy.yml:126-132`) [M flag exists]                                                                                                                                                                                                                                           | yes           |
| Git SHA                            | none                                                                                                 | `--var PKEY_GIT_SHA:$GITHUB_SHA`                                                                                                                                                                                                                                                                                                    | yes           |
| Cloudflare version id, upload time | none                                                                                                 | `[version_metadata] binding = "CF_VERSION_METADATA"`: `{ id, tag, timestamp }` [D][V types L15960]. Configuration cannot forge it. `--tag $TAG` also makes `tag` the release tag                                                                                                                                                    | yes           |
| Environment                        | `PKEY_ENVIRONMENT` → `/manage/api/me` `environment` (`W/src/admin/handlers/me.ts:23-28,60`)          | unchanged                                                                                                                                                                                                                                                                                                                           | yes           |
| `PROTOCOL_VERSION` (4)             | `packages/shared-protocol/src/core.ts:9`; already public in discovery (`W/src/core/discovery.ts:90`) | import it                                                                                                                                                                                                                                                                                                                           | yes           |
| Discovery document version (2)     | `W/src/core/discovery.ts:89`                                                                         | export the literal as a constant                                                                                                                                                                                                                                                                                                    | yes           |
| D1 migrations applied              | `d1_migrations` (written by `wrangler d1 migrations apply`, `deploy.yml:94`)                         | `SELECT name, applied_at FROM d1_migrations ORDER BY id`. The table is an ordinary table, not a reserved `_cf_*` one [I][U]. An absent table (tests, a hand-built database) reads as "unknown"                                                                                                                                      | yes           |
| Latest migration in the build      | the `W/migrations/` directory (64 files, newest `0051_lazy_deltas.sql`)                              | a `LATEST_MIGRATION` constant pinned by a test to the newest file, the same pattern as `REQUIRED_INDEXES` against the newest `*_index_assertion.sql` (`W/src/scheduled.ts:110-132`). This adds no generator family (rule 3)                                                                                                         | yes           |
| Required indexes present           | `missingRequiredIndexes(db)` (`W/src/scheduled.ts:135-145`), today run only by cron                  | call it on demand                                                                                                                                                                                                                                                                                                                   | yes           |
| Admin SPA build                    | none                                                                                                 | Vite `define` of the same tag and SHA at `pnpm --filter @polaris-key/admin build`. The SPA compares its own stamp with `/platform/version` and offers "Reload to update" on a mismatch (a tab left open across a deploy)                                                                                                            | yes           |
| Docs site build                    | assembled in the same deploy (`deploy.yml:124-125`)                                                  | the same tag. Shown once, since docs, SPA and Worker ship as one assets root                                                                                                                                                                                                                                                        | yes           |
| `@polaris-key/*` package versions  | every JS package is `0.0.0` [M]                                                                      | **don't show**: they carry no information. The release tag is the version                                                                                                                                                                                                                                                           | n/a           |
| SDK minimums                       | none server-side; the SDKs version independently (Python 0.1.0, Godot 0.1.0)                         | show only what the Worker enforces: `PROTOCOL_VERSION`. Per-product compat floors live in Update → Feed                                                                                                                                                                                                                             | yes           |
| Lazy-delta consumer build          | none                                                                                                 | the same `--var`/`--tag` on its deploy (`deploy.yml:117-123`). It reports through its heartbeat row (§7)                                                                                                                                                                                                                            | yes           |
| Deploy history                     | GitHub Actions only                                                                                  | a final deploy step: `wrangler d1 execute … --command "INSERT INTO platform_deploys (…)"`. It records tag, SHA, run URL (`$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID`), the scripts deployed, the migrations applied and the time. The deploy token already holds D1 edit, because it applies the migrations | yes           |
| "A newer tag exists"               | none                                                                                                 | **not built** (§8.4). The Deployment page links to the repo's releases page, which is a browser navigation, not a Worker call                                                                                                                                                                                                       | n/a           |

**`--var` or `--define`?** [I] Prefer `--var` for tag and SHA:

- it follows the existing `PKEY_ENVIRONMENT` pattern (an `Env` field, testable by passing an
  env);
- the version metadata binding supplies the part that cannot be forged.

`--define` would bake the values into the bundle but needs a `typeof` guard in tests and dev.

**A side effect to keep in mind** [D]: without `--keep-vars`, `wrangler deploy` deletes every var
set in the dashboard. That is another reason runtime settings belong in D1, not in dashboard
vars: a dashboard var silently resets on the next tag.

## 5. Inventory: every platform-wide setting today

Classes:

- **(a)** deploy-time only, shown read-only, with its effective value;
- **(b)** proposed for runtime editing in D1, with an audit row;
- **(c)** secret: the page shows only whether it is set, never the value, a length or a hash;
- **(k)** a code constant that acts as policy, shown read-only. It changes only through a code
  change.

"Stored as secret" marks a non-sensitive value that the deployment docs tell operators to set with
`wrangler secret put`. The page may show its value.

### 5.1 Vars and secrets

| Name                                                                    | Where today                                                                                                                      | What it does                                                                       | Class         | Notes                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PKEY_ENVIRONMENT`                                                      | `[env.*.vars]` (`W/wrangler.toml:154,198,239`); `W/src/env.ts:69-74`                                                             | names the deployment; the console badge                                            | a             | identity of the deployment                                                                                                                                                      |
| `BLOB_ORIGIN`                                                           | vars (`wrangler.toml:155`); `env.ts:54-61`                                                                                       | the bytes host. Requests to that host reach only byte routes (`core/bytesHost.ts`) | a             | **never editable**: an origin decides routing isolation, cookies and the same-site exception (THREAT-MODEL §3 "The blob store and the bytes host")                              |
| `CONSOLE_ORIGIN`                                                        | vars (`wrangler.toml:157`); `env.ts:62-68`                                                                                       | where the download page links storefront feeds                                     | a             | an origin: never editable                                                                                                                                                       |
| `BLOBS_BUCKET_NAME`                                                     | vars (`wrangler.toml:160`); read in `core/publisher.ts:1117`                                                                     | the bucket that upload-ticket credentials are scoped to                            | a             | must match the `BLOBS` binding                                                                                                                                                  |
| `LAZY_DELTAS`                                                           | vars in **both** scripts (`wrangler.toml:163`, `wrangler.deltas.toml` `[env.*.vars]`); `env.ts:35-41`; `core/deltaDemand.ts:130` | kill switch for lazy deltas                                                        | **b**         | today `off`, and turning it on takes two deploys (`RUNBOOK.md:497-512`). Kill-switch precedence (§6.2)                                                                          |
| `LAZY_DELTA_MAX_BYTES`                                                  | deltas vars (`33554432`); `env.ts:49-53`                                                                                         | the consumer's per-side cap                                                        | **b**         | bounded to [1 MiB, 32 MiB]. 32 MiB is the measured ceiling (notes/S-08 §4.2), so the setting can only lower it                                                                  |
| `BLOB_GC_MODE`                                                          | unset (on by default); `env.ts:28-32`; `core/blobGc.ts:165-170`                                                                  | kill switch for the blob collector                                                 | **b**         | turning it off is always safe. Turning it on is L1                                                                                                                              |
| `BLOB_GC_GRACE_DAYS`                                                    | unset (30); `env.ts:33`; `core/blobGc.ts:134-139`                                                                                | the collector's grace period                                                       | **b**         | ≥ 1 (`MIN_GC_GRACE_SECONDS`). The 180-day bucket lock still bounds deletion. Lowering it is L1                                                                                  |
| `PORTAL_EMAIL_FROM`                                                     | optional secret; `services/identity/portal/email.ts:4`                                                                           | the portal sender                                                                  | b (2nd wave)  | the `send_email` binding's `allowed_sender_addresses` (`wrangler.toml:164-166`) already restricts it. Editing it only changes the display name or picks among allowed addresses |
| `PLATFORM_ADMIN_GROUP`                                                  | stored as secret (`DEPLOYMENT.md:465`); `W/src/admin/authz.ts:19-23,40-43`                                                       | **the one privilege root**: membership is console access                           | a             | **never editable**. A runtime edit is privilege escalation or a self-lockout. Show the group name                                                                               |
| `PLATFORM_OIDC_ISSUER`, `PLATFORM_OIDC_CLIENT_ID`                       | stored as secret; `W/src/platformOidc.ts:11-27`                                                                                  | the admin and platform IdP                                                         | a             | never editable (admin authentication root). The values are visible in the OIDC redirect anyway, so show them                                                                    |
| `ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID`, `ADMIN_OIDC_CLIENT_SECRET` | legacy fallbacks (`platformOidc.ts:13-27`, `admin/lib/shape.ts:306-316`)                                                         | old names for the three above                                                      | a / c         | show a **"legacy name in use"** warning when the fallback is what resolved                                                                                                      |
| `OIDC_ISSUER_ALLOWLIST`                                                 | stored as secret (`env.ts:120-137`); `services/identity/oidc.ts:219`, `services/release/linkRepo.ts:123`                         | the hosts a repo manifest may name as a custom issuer. **Fails closed**            | a             | **never editable**. It is a security gate against exfiltrating a product's `client_secret` (`env.ts:124-130`). Show the parsed host list, which is not credential material      |
| `PLATFORM_OIDC_CLIENT_SECRET`                                           | secret                                                                                                                           | the IdP client secret                                                              | c             |                                                                                                                                                                                 |
| `PLATFORM_KEK`, `PLATFORM_KEK_KEYS`                                     | secret (`env.ts:91-108`)                                                                                                         | asset A1                                                                           | c             | the keyring panel shows the active kid, the kid list and per-kid counts. This exists today: `GET /manage/api/products/kek` (`handlers/products.ts:782-815`)                     |
| `PLATFORM_KEK_ACTIVE`, `PLATFORM_KEK_ID`                                | secret                                                                                                                           | kid names                                                                          | a (kid shown) | **warn** when `PLATFORM_KEK_ID` is set: `env.ts:94-100` calls it dangerous to change on its own                                                                                 |
| `KEY_HASH_PEPPER`                                                       | secret                                                                                                                           | HMAC pepper for keys and tokens                                                    | c             |                                                                                                                                                                                 |
| `ADMIN_SESSION_SECRET`                                                  | secret (`admin/session.ts:97-103`)                                                                                               | asset A4                                                                           | c             |                                                                                                                                                                                 |
| `PORTAL_SESSION_SECRET`                                                 | optional secret (`services/identity/portal/session.ts:81-90`)                                                                    | portal session HMAC                                                                | c             | **warn** when unset: it then falls back to `ADMIN_SESSION_SECRET`, so the two realms share key material (THREAT-MODEL §9)                                                       |
| `GITHUB_APP_ID`                                                         | secret                                                                                                                           | GitHub App id                                                                      | a             | not sensitive; show it                                                                                                                                                          |
| `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`                       | secret                                                                                                                           | asset A3                                                                           | c             |                                                                                                                                                                                 |
| `R2_ACCOUNT_ID`                                                         | secret (`core/publisher.ts:1114`)                                                                                                | the account for upload tickets                                                     | a             | not sensitive. A-15 reuses it as the GraphQL `accountTag`                                                                                                                       |
| `R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY`                | secret (`core/publisher.ts:1115-1116`)                                                                                           | asset A13                                                                          | c             | presence only. "Trusted publishing off" when absent                                                                                                                             |
| _(new, A-15)_ `CF_ANALYTICS_TOKEN`                                      | —                                                                                                                                | read-only analytics                                                                | c             | §7.3                                                                                                                                                                            |

### 5.2 Bindings, triggers and limits

| Binding         | Declared                                                                                                      | If unbound (from `env.ts`)                                              | Class |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `DB` (D1)       | `wrangler.toml:140-143`                                                                                       | the Worker fails                                                        | a     |
| `HOT` (KV)      | `wrangler.toml:137-139`                                                                                       | the Worker fails (78 references)                                        | a     |
| `RL` (DO)       | `wrangler.toml:31-33,131-133`                                                                                 | the limiter fails open or closed per bucket (`core/rateLimit.ts:31-60`) | a     |
| `UPDATE_HEALTH` | `wrangler.toml:38-40`                                                                                         | optional: nothing is counted and auto-halt never trips (`env.ts:12-18`) | a     |
| `BLOBS` (R2)    | `wrangler.toml:144-146`                                                                                       | optional: every byte route answers not-found (`env.ts:20-27`)           | a     |
| `DELTA_QUEUE`   | `wrangler.toml:149-151`                                                                                       | optional: nothing is enqueued (`env.ts:42-48`)                          | a     |
| `EMAIL`         | prod only (`wrangler.toml:164-166`)                                                                           | the portal's magic-link email is unavailable                            | a     |
| `ASSETS`        | `wrangler.toml:25-29`                                                                                         | no console and no docs                                                  | a     |
| Crons           | `[triggers] crons = ["17 3 * * *", "*/15 * * * *"]` (`wrangler.toml:86-87`, pinned by `scheduled.ts:373-374`) | —                                                                       | a     |
| Consumer limits | `wrangler.deltas.toml`: `cpu_ms = 60000`, batch 1, concurrency 1, retries 3, DLQ                              | —                                                                       | a     |

### 5.3 Code constants that act as policy (k)

These are shown read-only so an operator can see them. None are proposed editable.

| Area                | Constant (file:line)                                                                                                                                                                                   | Why it stays code                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Sessions            | admin 8 h hard (`admin/session.ts:50`); portal 14 d (`services/identity/portal/session.ts:12`); identity browser 30 d (`services/identity/browserSession.ts:74`); OIDC flow 600 s (`admin/auth.ts:30`) | lengthening a session weakens AT-2. A shortening knob would be safe, but no one has asked for it                               |
| Retention           | audit 180 d (`scheduled.ts:76`); seat dormancy 90 d (`repo.ts:1051`); connector events 30 d; update health 30 d; demand 30 d                                                                           | `scheduled.ts:59-75` argues explicitly that retention is a promise about deletion and should stay a constant                   |
| Rate limits         | about 30 buckets, for example `adminApi` 600/60 s (`admin/api.ts:276-289`), `adminLogin` 20/60 s, `activate` 30/60 s, `portalMagic` 8/60 s; fail modes in `core/rateLimit.ts:31-60`                    | a runtime-raisable limit is an attacker's first edit after taking a session (AT-2). Keep them in code, where review sees them  |
| CI and publishing   | OIDC CI token 30 min, static CI token ≤ 90 d, ticket ≤ 1 h (`core/publisher.ts:84-106`)                                                                                                                | security bounds (A12, A13)                                                                                                     |
| Caches              | trust 300 s, feed 300 s, JWKS 3600 s, CORS max-age 600                                                                                                                                                 | correctness and performance; nothing to tune                                                                                   |
| Lazy-delta defaults | `DEFAULT_HOT_DEVICES = 25`, `DEFAULT_DAILY_CAP = 20` (`core/deltaDemand.ts:48,55`)                                                                                                                     | per-product overrides already exist in `lazy_delta_settings`. A platform default is a possible second-wave (b), but not needed |
| Blob store          | lock age 180 d (`core/blobGc.ts:132`), 1,000 deletes per night                                                                                                                                         | must match the bucket's age lock (RUNBOOK: "never shorten")                                                                    |

### 5.4 Per-product settings: not on this page

Each product's own settings stay on its pages: Core → Settings (ADMIN.md §6.9); Distribution →
Access; Update → Feed; Identity → Portal; trust policy; connectors; `lazy_delta_settings`.

The Platform Settings page links out where a platform switch gates a product setting. For
example, the Lazy deltas section reads "3 products opted in", links to them, and is the only
place the deployment switch lives. ADMIN.md's rule is "Set this elsewhere" with a link
(`ADMIN.md:702`). [I]

No commerce admin endpoints exist in the Worker today. `commerce` appears only as a descriptor
field (`W/src/core/hooks.ts:957`), so there is no pattern to copy and no platform commerce
setting to list. [V]

## 6. Runtime settings: storage, precedence and audit

### 6.1 Schema

The schema is a sketch. The migration is the next free number (`0052_…` at the time of writing).
It uses CREATE … IF NOT EXISTS only, so it replays cleanly. The tables are owned by Core:
`TABLE_OWNERS.core` in `packages/docs/scripts/gen-reference.mjs:312`.

```sql
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,          -- a key of PLATFORM_SETTINGS (code); unknown keys are ignored
  value_json  TEXT NOT NULL,             -- validated by the registry on read AND write
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL              -- session subject
);
CREATE TABLE IF NOT EXISTS platform_audit (  -- product-less twin of `audit`
  id TEXT PRIMARY KEY, at INTEGER NOT NULL,
  actor_sub TEXT, actor_name TEXT, actor_email TEXT,
  action TEXT NOT NULL, target_kind TEXT, target_id TEXT,
  summary TEXT, before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit(at DESC, id DESC);
CREATE TABLE IF NOT EXISTS platform_deploys (   -- written ONLY by deploy.yml (A-11)
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, tag TEXT NOT NULL, git_sha TEXT NOT NULL,
  run_url TEXT, scripts TEXT NOT NULL, migrations_applied TEXT
);
```

A-14 adds `platform_job_runs` and `platform_heartbeats` (§7.2). _A-14 as built_ (`migrations/0057_platform_operations.sql`): a run is a group of rows sharing
`run_id` rather than one row with `counts_json`/`failures_json`: a `*` summary row, one row per
successful step family (per-product steps folded, so a run stays about a dozen rows), and one row
per failed step with its truncated reason. Step timings come from `step()` in `scheduled.ts`.

`platform_audit` falls under the same 180-day retention as `audit`. The nightly sweep gains one
step, and it is product-less by construction, which `scheduled.ts:15-20`'s "product-scoped"
property must name explicitly, as it already does for `portal_audit`'s `product IS NULL` rows.
The KEK re-seal sweep also writes one `platform_audit` row, as well as its existing
per-product rows.

### 6.2 Registry and precedence

`W/src/core/platformSettings.ts` (new) declares `PLATFORM_SETTINGS`. Each entry has:

- `key`, `area`, `label`;
- a validator and a code default;
- the `[vars]` fallback name;
- the scripts that read it (`main`, `deltas`);
- the precedence mode;
- the ADMIN.md §5.2 confirm level for each direction of change.

The table is the only list of editable keys. A D1 row whose key is not in the registry is
ignored.

There are two precedence modes:

- **`runtime`** (tunables): a valid D1 row, then the `[vars]` value, then the code default. Used by
  `BLOB_GC_GRACE_DAYS` and `LAZY_DELTA_MAX_BYTES`. A D1 value outside its range is never
  applied: it falls through and the Settings page shows "stored value invalid, using …".
- **`ceiling`** (kill switches): `[vars]` = `off` forces off, whatever D1 says. That is the
  break-glass that survives a compromised console session, because it needs a deploy. Any other
  `[vars]` value, or none, means D1 decides, and with no row the code default (`off` for
  `LAZY_DELTAS`, `on` for `BLOB_GC_MODE`) applies.

  Shipping this means changing the committed `LAZY_DELTAS = "off"` to `"runtime"` in both TOML
  files. Until then nothing changes in behaviour: owner decision 2.

  _As built (A-13):_ a valid `[vars]` value other than `off` still counts below a D1 row, so
  `[vars]` = `on` with no row means on (the test lanes and a hand deploy rely on it) and
  `"runtime"` with no row is the code default. An unreadable store resolves a kill switch to
  off. `LAZY_DELTA_MAX_BYTES` and `BLOB_GC_GRACE_DAYS` keep their pre-A-13 `[vars]` parsing;
  the [1 MiB, 32 MiB] and [1, 365] bounds apply to runtime values.

`lazyDeltasOn(env)` (`core/deltaDemand.ts:130`) and `blobGcSettings(env)`
(`core/blobGc.ts:165-170`) become `…(env, settings)`. The consumer (`src/deltasEntry.ts`) reads
the same rows: it already binds `DB`. One D1 row then replaces two deploys. [I]

### 6.3 Caching

- The table is tiny (fewer than 20 rows), so it is read with one
  `SELECT key, value_json, version FROM platform_settings`.
- The result is memoised per isolate for **30 s**.
- The cron handlers and the consumer read fresh at the start of each invocation.
- The settings are not mirrored to KV: KV is eventually consistent for about 60 s and would add
  a second write path to keep coherent.
- Documented propagation: "within 30 seconds". A setting that needs to take effect instantly
  doesn't belong in this table. [I]

### 6.4 Writes

- `PATCH /manage/api/platform/settings/<key>` with `{ value, expectedVersion }`:
  - 409 on a version mismatch (the A-6 pattern for the catalog);
  - 422 from the validator;
  - an L2-level change must carry `{ confirm: "<key>" }`.
- `DELETE /manage/api/platform/settings/<key>` reverts to the `[vars]` value or the default.
  It is audited the same way.
- Every write appends a `platform_audit` row with `before_json` and `after_json`, which is safe
  because no secret is in the registry. The actor comes from the verified session, as in
  `W/src/admin/audit.ts:10-31`.

## 7. Operations data: where it comes from

### 7.1 The options

| Source                                                   | What it gives                                                                                                                                                                                                                                                                        | Cost / risk                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-reported** (bindings plus rows the Workers write) | deploy identity; migrations; indexes; binding presence; probes of D1, KV and R2; queue backlog for any queue the Worker binds (`metrics()`); D1 size; committed R2 bytes; cron step outcomes and durations; consumer heartbeat; connector last-poll; the Worker's own handled errors | no token, no outbound call. A few D1 writes per cron tick and per consumer message. Blind to what never reaches our code: exceptions outside `dispatch`, CPU-limit kills (1102), request volume                  |
| **Cloudflare GraphQL Analytics API**                     | per-script requests, errors by invocation status, CPU quantiles (`workersInvocationsAdaptive`) [D]; R2 storage and operations [D]; D1 rows and storage; KV operations; queue operations [D, dataset names to confirm by introspection, U]                                            | one account-owned token with **Account Analytics: Read** [D]. Outbound host `api.cloudflare.com`. Default limit 300 queries per 5 min per token [D]. No published per-query charge [I]. Data lags by minutes [D] |
| Cloudflare REST APIs (Workers deployments, Queues)       | deployment list, queue configuration                                                                                                                                                                                                                                                 | needs Workers Scripts Read or Queues Read. **Not needed**: deploy history comes from `deploy.yml`, and the backlog comes from `metrics()`                                                                        |
| Workers Observability telemetry API                      | log search                                                                                                                                                                                                                                                                           | a broader read of every log line. The R12 "the Worker never logs" property (`W/src/scheduled.ts:426-431`) makes it low-value. Not recommended                                                                    |

### 7.2 Recommendation: hybrid, self-reported first (A-14), analytics optional (A-15)

**Phase 1, self-reported (A-14).** It covers every item the owner listed except per-script
request and error rates and KV usage:

- **Worker health.**
  - Main Worker: answering the request is itself the health signal. The Operations endpoint
    reports, for each binding, present or absent and the probe latency: D1 `SELECT 1`; KV `get`
    of a fixed absent key; R2 `head` of a fixed absent key; `DELTA_QUEUE.metrics()`.
  - The scheduled handler writes a `main` heartbeat on each tick.
  - Consumer: on each batch, `polaris-key-deltas-<env>` writes
    `platform_heartbeats(script='deltas', at, version_tag, last_outcome, backlog_count)`.
    `MessageBatch` metrics give the backlog after the batch [V types L2357-2365]. "Last
    processed" is the heartbeat's `at`.
  - The consumer has no fetch route, so it can't be pinged. A service binding with an RPC
    `health()` is possible later but adds a surface. Not proposed. [I]
- **Queues.**
  - `pkey-deltas-<env>`: `DELTA_QUEUE.metrics()` returns `backlogCount`, `backlogBytes` and
    `oldestMessageTimestamp` in real time [D][V types L2315,2357-2365].
  - DLQ `pkey-deltas-dlq-<env>`: add a **producer binding `DELTA_DLQ` to the main Worker, used
    only for `metrics()`**. A source-check test asserts that nothing calls `.send` on it, in the
    style of the existing encoder source check (THREAT-MODEL P4-17 section). The binding gives
    send capability on a queue with no consumer, whose messages expire after 4 days; that risk is
    accepted and recorded.
  - Configuration (batch 1, concurrency 1, 3 retries) is shown from `wrangler.deltas.toml` as
    (a) facts.
- **Cron and scheduled jobs.**
  - `handleScheduled` already builds a `MaintenanceReport` with per-step `counts` and `failures`
    (`W/src/scheduled.ts:162-170,432-455`).
  - Persist it as `platform_job_runs(id, cron, started_at, duration_ms, ok, counts_json,
failures_json)`: one row per tick, failure reasons truncated to 300 characters, pruned after
    30 days. That is about 3,000 rows a month at a 15-minute cadence.
  - The thrown aggregate stays as the invocation's outcome, so nothing about cron failure
    semantics changes.
- **Connectors.**
  - ASC, Play and Microsoft Store: aggregate across products from the existing connector tables
    (`dist_connector_objects` / `dist_connector_events`, `W/migrations/0041_…`; `connectors/state.ts`):
    last successful poll, last error and products configured.
  - Commerce: none exists today (§5.4). The row shows "not available".
- **Storage.**
  - D1: `meta.size_after` from any query [D][V types L13303].
  - R2 committed bytes and object count: `SELECT SUM(size), COUNT(*) FROM blob_objects`, by kind
    and gated [V schema `0026_blob_store.sql:15-23`]. It excludes `staging/`, which is labelled.
  - KV: not self-reportable. Phase 2.
- **Recent errors.**
  - The failed steps of the last N `platform_job_runs`.
  - The consumer's refusals (`release_lazy_deltas` `refused` rows with a reason).
  - An unhandled-exception ring in `dispatch` is **not** proposed. It would turn the R12
    no-logging property into a no-_persistent_-free-text property that needs its own review.
    Phase 2's error counts cover the gap. [I]

**Phase 2, analytics (A-15).** It is optional and switched on by the presence of the secret:

- `CF_ANALYTICS_TOKEN` is used with `R2_ACCOUNT_ID` as the `accountTag`.
- **One** fixed GraphQL document is compiled into the Worker. The browser never supplies query
  text, script names or filters, as Cloudflare's guidance for multi-tenant analytics requires
  [D].
- It reads the last 24 h for both scripts and the account's storage: requests, errors by status
  and CPU p50/p99; R2, D1 and KV storage and operations; queue operations.
- The result is cached in KV for 60 s, and loads are rate-limited to one per 60 s, so the most
  it can use is 5 of 300 queries per 5 minutes.
- On error or when unset, the panels show "Cloudflare analytics not configured" with a docs
  link. Nothing else degrades.

**Why not analytics-only?** It would need the token for basics the Worker can know for free,
and it can't see our own semantics: cron steps, connector state, migrations, settings.

**Why not self-reported-only?** It is blind to the failure the owner most wants to see: requests
that die before our code can record anything (1101 and 1102, CPU limits).

### 7.3 What the owner provisions

**Phase 1:** nothing new.

- `deploy.yml` gains `--var`, `--tag` and `--message` on both `wrangler deploy` calls, and one
  `wrangler d1 execute` that inserts the `platform_deploys` row. The existing
  `CLOUDFLARE_API_TOKEN` already has D1 edit, because it applies migrations (`deploy.yml:87-108`).
- The `DELTA_DLQ` producer binding needs the existing DLQ (the queues preflight at
  `deploy.yml:79-86` already checks it) and the token's existing Queues Edit.
- Owner review of the `deploy.yml` change, which is CI with production credentials.

**Phase 2** (owner decision 1), per environment:

1. Create an **account-owned API token** named `polaris-key-analytics-read-<env>`:
   - permission: _Account → Account Analytics → Read_, and nothing else;
   - resource: the one Cloudflare account;
   - a 1-year TTL with a calendar reminder;
   - no IP filter, because Worker egress addresses are not fixed [I].
2. `npx wrangler secret put CF_ANALYTICS_TOKEN --env <env>`.
3. Confirm the token is read-only: a GraphQL query succeeds, and any REST write (for example
   `PUT …/workers/scripts/…`) is refused with 403 [U].
4. The rotation runbook entry: delete and recreate the token, `secret put`; the panels recover
   within 60 s.

**The Worker never holds a token that can write**, and the token has no Workers, Queues, D1, R2
or KV permission. It reads only aggregates, the same data the dashboard shows, and contains no
customer data. [I]

## 8. Security

### 8.1 Access

The Platform pages use the existing admin dispatcher. That gives them:

- the session gate;
- the `PLATFORM_ADMIN_GROUP` gate, the only privilege level (`W/src/admin/authz.ts:1-13`);
- the per-subject 600/min limiter;
- CSRF on every mutation;
- audit (`W/src/admin/api.ts:1-35`).

There is no new privilege level. ADMIN.md §5.10's `useCan` gate applies unchanged, so a future
read-only role makes the whole section read-only through a gate change. [V][I]

### 8.2 What can never become runtime-editable

Each item below stays deploy-time, and the registry refuses to declare it:

- an **origin** (`BLOB_ORIGIN`, `CONSOLE_ORIGIN`);
- the **privilege root** (`PLATFORM_ADMIN_GROUP`);
- the **admin IdP** (`PLATFORM_OIDC_*`);
- a **security gate** (`OIDC_ISSUER_ALLOWLIST`, which fails closed);
- **key material** or kid selection (`PLATFORM_KEK*`, `*_SECRET`, `KEY_HASH_PEPPER`, the GitHub
  App, the R2 parent);
- any **session TTL** or **rate limit**;
- **retention**;
- **bucket names**.

A registry test asserts that none of these names appears in `PLATFORM_SETTINGS`. It is the same
deny-by-construction style as the route-coverage table.

The reason is AT-2 (`THREAT-MODEL.md:3057-3065`). Whoever takes the admin plane already reaches
A2, A3, A5 and A6 through the API. A runtime knob that _widens_ what a session can do (a longer
session, a looser issuer allowlist, a raised limit, a new admin group) would turn a time-bounded
session compromise into a persistent one. Deploy-time settings need the repo and the deploy
token, a separate boundary. [I]

### 8.3 The editable four, and why they are safe

- Each is a background job's kill switch or tunable. The worst a hostile session can do with
  them:
  - waste delta CPU, bounded by the per-product daily cap and the 32 MiB ceiling;
  - stop the collector, which only costs storage;
  - restart the collector with a 1-day grace. The 180-day R2 age lock still bounds deletion, and
    the collector deletes only unreferenced objects (THREAT-MODEL P4-14 section).
- None changes what a device is offered or what is signed.
- The `ceiling` mode leaves a deploy-time off switch that a session cannot override.
- Confirm levels (ADMIN.md §5.2):
  - turning the collector **on**, or lowering the grace, is L1 (caution, with consequences);
  - turning lazy deltas on is L1;
  - turning either **off** is L0 with Undo;
  - none is L2 or L3, so the `{confirm}` echo is reserved for future settings.

### 8.4 Outbound calls and update awareness

- Phase 1 makes **no** outbound call.
- Phase 2 calls only `api.cloudflare.com/client/v4/graphql`, with a fixed document.
- "A newer tag exists" would need the Worker to call `api.github.com` about the platform repo,
  which the GitHub App is not necessarily installed on. It also leaks the deployment's existence
  on every check. **Not built.** The Deployment page shows the deployed tag with a link to the
  repo's releases. [I]

### 8.5 Threat-model changes

Add a "Platform settings and operations (A-11…A-15)" subsection to THREAT-MODEL §3, and these
lines to §9's review triggers:

- a setting is added to `PLATFORM_SETTINGS`;
- a setting's precedence changes from `ceiling` to `runtime`;
- the analytics token gains a permission, or the Worker gains an outbound host;
- the DLQ binding is used for anything but `metrics()`;
- persistent free-text error capture is added.

Cron failure reasons are stored in `platform_job_runs`. These are the same strings the thrown
aggregate already puts in Cloudflare's invocation logs (`wrangler.toml:11-15`, `persist = true`),
now admin-readable for 30 days: [I]

- they are truncated;
- they contain no request data;
- their writers are step names and caught exceptions, which the R12 posture already keeps
  secret-free.

## 9. Page design and work packages

### 9.1 IA (ADMIN.md amendment)

- **§2.1:** the sidebar's platform links become Home and Products plus a **Platform** group. Like
  the product sections:
  - no header icon;
  - an icon on every item;
  - no section bit (BRAND.md §6: no bit on Home, Products, Platform and Core pages);
  - the `core` accent;
  - shown whether or not a product is in scope (`A/console/shell/Sidebar.tsx:107-118`).
- **§2.3 global pages:**

  | Page          | URL                                     | Template          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | ------------- | --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Settings      | `#/platform/settings`                   | T4                | sections: **Background jobs** (blob collector, lazy deltas: the editable four, with each one's source shown); **Identity & access** (admin group, IdP issuer and client, issuer allowlist, session lengths; read-only); **Delivery** (bytes host, console origin, bucket; read-only); **Email**; **Limits** (rate limits, retention, CI bounds; read-only, collapsed); **Keyring** (the KEK panel: kids, counts, progress, re-seal sweep L3 "type reseal"); **Secrets** (presence list with warnings) |
  | Deployment    | `#/platform/deployment`                 | T1-style + tables | current build card (tag, SHA, Cloudflare version id, deployed at, environment, `PROTOCOL_VERSION`, discovery v2, SPA stamp); deploy history (from `platform_deploys`, run links); migrations (applied vs latest, missing indexes); bindings and the two scripts with their versions                                                                                                                                                                                                                   |
  | Operations    | `#/platform/operations`                 | T1 dashboard      | health strip (bindings and probes); queue and DLQ cards; cron table (last run, duration, outcome and failed steps for each trigger); connectors; storage; recent errors; phase-2 analytics panels when configured                                                                                                                                                                                                                                                                                     |
  | Package feeds | `#/platform/feeds` (S-12 owns the name) | (S-12)            | sibling, `ready: false` until S-12's work lands                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

- `#/platform` redirects to `#/platform/settings`.
- The old `docs: "/docs/admin/kek/"` help link moves to the Keyring section's help.
- A version chip ("v0.8.6 · prod") in the user menu links to Deployment, so version information is
  reachable from every page, not only the section.

**Components** (chunk 3's set, nothing new):

- `PageHeader`, `SourceBadge` (sources: "code default", "deploy var", "runtime"), `SaveBar` (one
  scope per setting, each its own row: ADMIN.md T4 "never one Save across two endpoints");
- `ConfirmDialog`;
- `StatTile` and status pills for health;
- `DataTable` for history, cron and migrations;
- `EmptyState` ("Cloudflare analytics not configured").

The Settings page's **SourceBadge** is the heart of the design: every value says whether it is
the code default, the deploy var, or a runtime value set by whom and when. "Revert" deletes the
runtime row.

### 9.2 Admin API (narrative-only)

Admin API routes are narrative-only: `adminApi` is in `NARRATIVE_ONLY`
(`W/test/routeCoverage.test.ts:33-49`). So rule 10's OpenAPI coverage does not apply, and no
corpus or transcript changes. Each route needs a worker test, an audit row where it mutates, and
its `packages/docs/src/content/docs/admin/*` narrative (ADMIN.md §7.3).

The routes are a new `head === "platform"` branch in `W/src/admin/api.ts` (beside `me`, `products`):

| Route                                               | WP   | Notes                                                                                         |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `GET /manage/api/platform/version`                  | A-11 | build identity. Cheap; the SPA calls it for the skew check                                    |
| `GET /manage/api/platform/deployment`               | A-11 | history, migrations, indexes, bindings, scripts                                               |
| `GET /manage/api/platform/activity`                 | A-12 | `platform_audit`, keyset-paginated. A-2b's platform-wide feed merges it with product audit    |
| `GET /manage/api/platform/settings`                 | A-13 | every row of §5: value or presence, source, class, editable, version                          |
| `PATCH`/`DELETE /manage/api/platform/settings/:key` | A-13 | §6.4                                                                                          |
| `GET /manage/api/platform/operations`               | A-14 | probes, queues, cron, connectors, storage, recent errors                                      |
| `GET /manage/api/platform/analytics`                | A-15 | cached aggregates, or `{ configured: false }`                                                 |
| _(existing)_ `GET/POST /manage/api/products/kek`    | —    | stays where it is. The Keyring section calls it (ADMIN.md §7.3 "KEK through existing routes") |

### 9.3 Work packages

The pkey-implementer role runs all of them. **None is plan-mode**: none touches `shared-protocol`,
`shared-jws`, `client-core`, a signed document, `PROTOCOL_VERSION` or the corpus, and
`gen transcripts --check` must stay green. Two need **owner review** because they change
production CI or add a credential.

| ID       | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Deps                                      | Size | Flags                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| **A-11** | **Deploy identity.** `[version_metadata]` binding (both TOML files, per environment if non-inheritable [U]); `PKEY_RELEASE_TAG` and `PKEY_GIT_SHA` in `Env`; `deploy.yml` `--var`/`--tag`/`--message` on both deploys plus the `platform_deploys` insert; the `LATEST_MIGRATION` constant and its test; admin build `define` stamp; `GET platform/version` and `platform/deployment`; `d1_migrations` read with an absent-table fallback; docs `admin/deploy.mdx`, DEPLOYMENT §7                                | —                                         | S    | owner review (`deploy.yml`); workerd smoke                                       |
| **A-12** | **Platform audit.** `platform_audit` table and helper; the KEK sweep also writes one platform row; `GET platform/activity`; a retention step in `scheduled.ts`; TABLE_OWNERS                                                                                                                                                                                                                                                                                                                                    | —                                         | S    | migration                                                                        |
| **A-13** | **Platform settings store.** `platform_settings`; `core/platformSettings.ts` registry, resolver (`runtime`/`ceiling`), 30 s cache; the four settings rewired in both scripts (`deltaDemand.ts`, `blobGc.ts`, `deltasEntry.ts`); `GET/PATCH/DELETE platform/settings`; the read-only inventory and secrets presence (§5) with the legacy-name, KEK-ID and portal-secret warnings; the deny-list test (§8.2); THREAT-MODEL §3 and §9; RUNBOOK "Lazy deltas" and "blob collector" rewritten for the console        | A-12                                      | M    | migration; threat-model edit; `ceiling` default flip in TOML is owner decision 2 |
| **A-14** | **Self-reported operations.** `platform_job_runs` (from `MaintenanceReport`), `platform_heartbeats` (scheduled and consumer), the `DELTA_DLQ` producer binding with a no-send source check; probes; queue `metrics()`; D1 `size_after`; `blob_objects` totals; connector aggregate; `GET platform/operations`; pruning steps; THREAT-MODEL §3                                                                                                                                                                   | A-11 (heartbeats carry the tag)           | M    | migration; new binding; threat-model edit                                        |
| **A-15** | **Cloudflare analytics adapter** (optional). `CF_ANALYTICS_TOKEN`; one fixed GraphQL document (dataset names confirmed by introspection in staging); KV cache 60 s; a 1/min limiter; `GET platform/analytics`; THREAT-MODEL outbound-host entry; DEPLOYMENT §4 token recipe; RUNBOOK rotation                                                                                                                                                                                                                   | A-14; owner decision 1                    | M    | owner provisions the token; new outbound host                                    |
| **4P-1** | **Platform section and Settings page.** The ADMIN.md §2.1/§2.3/§2.5/§7 amendment; `nav.ts` gains a platform section (`GlobalPageId` + `platform-settings`, `platform-deployment`, `platform-operations`, `platform-feeds` reserved); redirects; Sidebar group; palette entries; the Settings page (T4) including Keyring (closes the "KEK has no console UI" note) and Secrets; tests per ADMIN.md §7.2 (states, mutation and invalidation, confirm levels, axe); `admin/kek.mdx` and a new `admin/platform.md` | ADMIN.md chunk 3; A-13 (A-12 for History) | M    | docs help-link drift gate (`docsLinks.test.ts`, `check:links`)                   |
| **4P-2** | **Deployment page** and the SPA skew banner                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | chunk 3; 4P-1; A-11                       | S    | —                                                                                |
| **4P-3** | **Operations page** (T1). Analytics panels are hidden until A-15                                                                                                                                                                                                                                                                                                                                                                                                                                                | chunk 3; 4P-1; A-14 (A-15 optional)       | M    | —                                                                                |

**Ordering:**

- A-11 and A-12 can start today, in parallel.
- A-13 and A-14 come after them.
- 4P-1 to 4P-3 join ADMIN.md's chunk 4. They run beside Home and Products, which 4P-1 does not
  touch: disjoint files except `nav.ts`, where 4P-1 goes second.
- A-15 is last and optional.

**Coordination:**

- A-11 to A-14 each add a migration. They must take numbers in merge order, as P-series WPs do.
- S-12's Package feeds page slots into 4P-1's section as `platform-feeds` and owns its own API.

## 10. Limits of this spike

- **[U]** Reading `d1_migrations` from the Worker binding was not tried against a real D1. Check
  it on staging in A-11. The fallback is "unknown".
- **[U]** Whether `[version_metadata]` is inheritable into `[env.*]`. A-11 checks with
  `wrangler deploy --dry-run --env staging` and repeats it under each environment if needed.
- **[U]** The queue GraphQL dataset names and the D1 and KV storage dataset fields were not
  confirmed from the docs this spike could reach. A-15 confirms them by introspection with the
  real token.
- **[U]** The token being read-only (§7.3 step 3) needs the owner's account.
- **[U]** `Queue.metrics()` and `MessageBatch` metrics exist in the installed types and the April
  2026 changelog. Their behaviour on a producer-only binding to a consumerless DLQ is unmeasured.
  _A-14 update:_ measured in the workerd lane (`test-workerd/operations.test.ts`, miniflare's
  local queues): `metrics()` answers on a producer-only binding to a queue nothing consumes.
  Hosted Queues is confirmed on the first deploy (DEPLOYMENT.md §7); if it refuses, the
  Operations snapshot reports the reason and the backlog as unknown.
- Not measured: the D1 write cost of heartbeats and job runs (estimated at about 3,000 job rows
  and a few hundred heartbeats a month, which is negligible).
- S-12 was not read. The sibling page's name and route are placeholders.

## 11. Owner decisions (three)

1. **Operations data source.**
   - **Recommended:** hybrid. Phase 1 is self-reported (A-14) and needs nothing provisioned.
     Phase 2 is the optional A-15, which needs one account-owned token with _Account Analytics:
     Read_ only, stored as `CF_ANALYTICS_TOKEN` (§7.3).
   - **Alternatively:** self-reported only, without per-script error and CPU rates or KV usage.
2. **Runtime-editable settings and precedence.**
   - **Recommended:** approve the `platform_settings` store, with the first editable four
     (`BLOB_GC_MODE`, `BLOB_GC_GRACE_DAYS`, `LAZY_DELTAS`, `LAZY_DELTA_MAX_BYTES`):
     - D1 overrides `[vars]` for tunables;
     - for kill switches, `[vars]` = `off` stays a deploy-time hard off;
     - the committed default becomes `"runtime"` in both TOML files.
   - The §8.2 list stays deploy-time permanently.
   - **Alternatively:** keep every setting deploy-time and build the Settings page read-only.
3. **IA amendment.**
   - **Recommended:** replace ADMIN.md's single reserved Platform page with a **Platform section**:
     - Settings, which holds the KEK keyring and secrets presence;
     - Deployment, which holds version information;
     - Operations;
     - Package feeds, from S-12.

     `#/platform` redirects to Settings, and a version chip goes in the user menu.

   - **Alternatively:** one Platform page with version, settings and keyring, and the operations
     data deferred.

## 12. Sources

- Repo (all [V], at `25e6209c`):
  - `AGENTS.md` (rules 3, 6, 10);
  - `docs/design/ADMIN.md:187-280,498-529,702-727,904-926,1718-1760,1870-1895,2102-2277`;
  - `docs/design/BRAND.md` §6;
  - `packages/admin/src/console/nav.ts:77,544-584,668-670`;
  - `packages/admin/src/console/routes.ts:309`;
  - `packages/admin/src/console/shell/Sidebar.tsx:97-118`;
  - `packages/worker/src/env.ts:1-148`;
  - `packages/worker/wrangler.toml:1-261`;
  - `packages/worker/wrangler.deltas.toml`;
  - `packages/worker/src/admin/{api.ts,authz.ts,audit.ts,session.ts:50,97-103}`;
  - `packages/worker/src/admin/handlers/me.ts:1-63`;
  - `packages/worker/src/admin/handlers/products.ts:1-30,136-138,782-860`;
  - `packages/worker/src/admin/lib/shape.ts:280-330`;
  - `packages/worker/src/platformOidc.ts:11-27`;
  - `packages/worker/src/scheduled.ts:1-170,373-374,420-456`;
  - `packages/worker/src/index.ts:31-71`;
  - `packages/worker/src/core/{blobGc.ts:132-170,deltaDemand.ts:48-55,130,rateLimit.ts:31-60,publisher.ts:74-106,1110-1117,discovery.ts:89-90}`;
  - `packages/worker/src/services/identity/{oidc.ts:219,portal/session.ts:12,81-90,portal/email.ts:4,browserSession.ts:74}`;
  - `packages/worker/src/services/release/linkRepo.ts:123`;
  - `packages/worker/migrations/{0001_init.sql:181-195,0026_blob_store.sql:15-23,0041_…,0042_…:1-27,0051_lazy_deltas.sql:1-25}`;
  - `packages/worker/test/routeCoverage.test.ts:1-49`;
  - `packages/docs/scripts/gen-reference.mjs:312`;
  - `.github/workflows/deploy.yml:1-167`;
  - `docs/DEPLOYMENT.md:443-485`;
  - `docs/RUNBOOK.md:138-179,468-529`;
  - `docs/security/THREAT-MODEL.md:24-66,2166-2233,3057-3065,3128-…`.
- Tooling:
  - [M] `wrangler deploy --help` (4.116.0): `--tag`, `--message`, `--var`, `--define`,
    `--keep-vars`;
  - [V] `@cloudflare/workers-types@4.20260623.1` `index.d.ts`: `Queue.metrics()` (L2315),
    `QueueMetrics` and `MessageBatchMetrics` (L2357-2365), `D1Result.meta.size_after` (L13303),
    `WorkerVersionMetadata` (L15960).
- Cloudflare docs, read 2026-10-03 [D]:
  - Version metadata binding (`/workers/runtime-apis/bindings/version-metadata/`);
  - Wrangler commands, `deploy` flags (`/workers/wrangler/commands/workers/`);
  - "Realtime backlog metrics now available for Queues" (changelog 2026-04-28);
  - D1 `D1Result` meta (`/d1/worker-api/prepared-statements/`);
  - R2 metrics and analytics (`/r2/platform/metrics-analytics/`);
  - Workers metrics and `workersInvocationsAdaptive`
    (`/workers/observability/metrics-and-analytics/`; Workers for Platforms observability);
  - GraphQL Analytics limits and account-based rate limiting (`/analytics/graphql-api/limits/`,
    `/analytics/graphql-api/account-based-rate-limiting/`);
  - API token _Account Analytics: Read_ (`/analytics/analytics-engine/sql-api/`);
  - Workers roles and granular token scopes (`/workers/authorization/workers/`, changelog
    2026-09-15);
  - API rate limits (`/fundamentals/api/reference/limits/`).

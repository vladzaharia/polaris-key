# Security plan: per-link GitHub webhook secrets and scoped installation tokens

| Field            | Value                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief            | None yet. This is an unowned security finding; approval creates the implementation work package(s).                                                                                                                                         |
| Status           | awaiting approval: merging this plan is the approval                                                                                                                                                                                        |
| Basis            | `main` at `d27467ef8`; receiver is `packages/worker/src/githubWebhook.ts` (not the stale `services/release/githubWebhook.ts` path in the finding), token code is `services/release/githubApp.ts`, and vault code is `platform/keyvault.ts`. |
| Wire change      | **None.** This changes an inbound GitHub control-plane receiver only. No device route, signed document, claim, SDK API, `PROTOCOL_VERSION`, `corpusVersion`, `shared-protocol`, or `shared-jws` change.                                     |
| Corpus / SDKs    | None. Existing device transcripts and all SDK behavior remain byte-identical.                                                                                                                                                               |
| Human dependency | A GitHub App registration has one App-level webhook URL/secret, not per-installation secrets. True per-tenant isolation requires repository webhooks and a human-approved `repository_hooks: write` App permission.                         |

## 1. Summary and scope

The current receiver validates every GitHub delivery with one platform secret
(`src/githubWebhook.ts:235-264`). It already has important mitigations: a capped body, current +
previous global-secret verification, delivery/body replay claims, and fail-closed installation
binding. `resyncRepo` reads the DB-configured repository’s actual default-branch head rather than
the webhook’s `after`, so a forged delivery cannot inject a chosen ref; it can still trigger
cross-tenant resync/API/D1 work and poison the display-only trigger SHA.

A GitHub App cannot solve this with one secret per installation: GitHub documents one webhook URL
and one “Webhook secret” on the App registration
([Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)).
The required design therefore creates a **repository webhook per linked product/repository**. Each
hook gets an independently random 256-bit secret, stored only sealed under the platform key vault.
A leaked secret can authenticate only that link’s delivery route.

Scope:

1. provision, verify, rotate, reconcile, and delete per-link repository hooks;
2. receive a link-scoped hook at an opaque path, verify current/previous sealed secrets, and act
   only on that link;
3. migrate one link at a time from the global App webhook through a dual-verify state;
4. retire `GITHUB_WEBHOOK_SECRET` and `_PREVIOUS` only after every link has migrated; and
5. remove the dead bare-string installation-token fallback in `githubApp.ts` (Appendix A).

Out of scope: a tenant-supplied GitHub App, a general GitHub integration platform, GitHub Actions
OIDC publisher changes, new product manifest fields, or any device-wire change.

## 2. Contract and hard rules

This is not a Polaris Key wire-contract change. The only public route addition is an inbound GitHub
control-plane endpoint; it gets an OpenAPI and route-coverage entry under hard rule 10 but never
appears in a signed document or SDK.

- **Hard rule 1:** no corpus/transcript/mirror edits.
- **Hard rule 2:** protocol/corpus versions remain unchanged.
- **Hard rule 5:** secrets and links are data rows, never `if (product === ...)` code.
- **Hard rule 6:** sealed-secret access belongs behind a release-owned store; root receiver code
  may compose it but no console handler reads sealed columns directly.
- **Hard rule 10:** add the path to OpenAPI and `routeCoverage` in the same change.
- New migration files use `00XX_` placeholders; `TABLE_OWNERS`, docs-reference generation,
  platform inventory, and config/deployment docs are updated through their generators.

## 3. Catalog and manifests

None. Hook secrets, hook ids, and hook state are operator-owned infrastructure, not `.pkey/`
manifest data. No catalog/schema/mutation-table change is valid or needed.

## 4. Corpus, transcripts, and mirrors

None. GitHub webhook payloads are not part of the device conformance corpus. Worker tests use
signed synthetic payloads and injected fetches; existing user/device transcripts must not change.

## 5. SDKs

None. The same app, CLI, CI, device, and registry credentials continue to operate. GitHub hook
provisioning is a console/release-service concern and exposes no new SDK API.

## 6. Worker design

### 6.1 Per-link data and vault custody

Add one release-owned table rather than widening `release_config` with secret columns:

```sql
CREATE TABLE IF NOT EXISTS release_repo_webhooks (
  product                 TEXT PRIMARY KEY REFERENCES products(slug),
  hook_ref                TEXT NOT NULL UNIQUE,       -- random, opaque, URL-safe handle
  gh_hook_id              INTEGER UNIQUE,              -- set after GitHub creates the hook
  gh_repository_id        INTEGER NOT NULL,            -- GitHub numeric repository identity
  gh_owner                TEXT NOT NULL,
  gh_repo                 TEXT NOT NULL,
  state                   TEXT NOT NULL,               -- legacy | pending | active | rotating | error
  current_secret_sealed   TEXT NOT NULL,
  next_secret_sealed      TEXT,
  previous_secret_sealed  TEXT,
  previous_until          INTEGER,
  last_delivery_at        INTEGER,
  last_error              TEXT,
  created_at              INTEGER NOT NULL,
  modified_at             INTEGER NOT NULL
);
```

`00XX_release_repo_webhooks.sql` creates it with trigger-enforced vocabulary if SQLite/D1 cannot
add the desired CHECK without a rebuild. It is one product-link per row; if two products share one
monorepo they receive two distinct GitHub hooks, paths, and secrets, so one product’s secret cannot
resync the other.

Generate each secret with 32 random bytes. Add `"release-webhook-secret"` to `SealContext.kind`.
Seal slots with distinct AAD ids:

```text
pkey:v2:<product>:release-webhook-secret:<hook_ref>:current
pkey:v2:<product>:release-webhook-secret:<hook_ref>:next
pkey:v2:<product>:release-webhook-secret:<hook_ref>:previous
```

The key-vault reseal/status sweep currently enumerates one sealed column per table in
`console/handlers/products.ts:688-716`. Extend its descriptor to walk all three webhook slots,
count their `kekId`s, re-seal under the same AAD, and report unreadable rows. Add a reach test like
`outletCredentialReach.test.ts`; `deleteProduct` deletes the local row in the same product cleanup
batch. Secrets are never returned by list/status APIs or audit payloads.

### 6.2 Hook provisioning and least privilege

GitHub’s repository-webhook endpoints accept a per-hook `config.secret` and support multiple hooks
per repository ([Repository webhook API](https://docs.github.com/en/rest/repos/webhooks)). Their
App permission is `repository_hooks: write` ([GitHub App permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).

Add a dedicated, uncached `mintRepositoryWebhookToken` path:

- input is structured `{ owner, repo }`, discovered/stored installation id, and a hooks purpose;
- POSTs an installation token request narrowed to `repositories: [repo]` and only mandatory
  metadata plus `repository_hooks: "write"`;
- never shares a cache key with the release-read token and never falls back to installation-wide
  access;
- is called only by link, rotate, reconcile, and unlink/delete hook lifecycle operations.

Creation sequence is idempotent and crash-safe:

1. resolve/pin the numeric repository id through the existing GitHub identity read;
2. generate `hook_ref` and seal current secret; insert `state='pending'` before the external call;
3. `POST /repos/{owner}/{repo}/hooks` with JSON content, `push` and `release` events, active true,
   `https://<platform-origin>/webhooks/github/<hook_ref>`, and the random secret;
4. conditionally store returned GitHub hook id. A crash after GitHub success is repaired by listing
   hooks for the known callback URL and adopting/reconciling the one row, never creating endless
   duplicates;
5. accept GitHub’s signed `ping` event only at this path; it marks the row active. A pending hook
   does not resync production data until its ping verifies.

The default is App-managed provisioning after the human grants/installation owners accept the new
permission. A manual fallback may display this one hook URL + secret once for an owner to enter in
GitHub settings; it uses the same pending/verified state machine. It is not a different trust
model.

### 6.3 Link-scoped receiver

Add:

```text
POST /webhooks/github/<hook_ref>
```

The opaque random ref selects one row before parsing the body; it is a lookup hint, not an
authorization factor. Unknown ref, malformed method/body/signature, hook-id mismatch, repository
mismatch, and an unavailable sealed secret all return the same unauthenticated shape without
naming the product. Retain the existing body cap before JSON parsing.

After bounded-body read:

1. open current and, only while allowed, next/previous secret slots;
2. verify `X-Hub-Signature-256` against the raw bytes using constant-time comparison; a match must
   identify one allowed slot;
3. parse JSON only after signature verification; require the signed `repository.id` to equal
   `gh_repository_id` and owner/repo to match case-insensitively; when an installation id exists,
   it must still match the stored release config;
4. cross-check `X-GitHub-Hook-ID` once `gh_hook_id` is known. The header is not trusted alone;
   its only role is defense-in-depth after HMAC success;
5. claim delivery/body replay under **link-namespaced** keys. The current unscoped body hash would
   incorrectly drop a legitimate second product hook that receives the same monorepo event;
6. handle `ping` as state confirmation and `push`/`release` by operating on this one product only.
   The normal resync still reads GitHub’s default-branch head server-side; no webhook `after` or
   other body field chooses content/ref.

Before approval, run a sandbox spike: create a repository hook through an installation token, push,
and record the actual headers/body. GitHub documents that `installation` appears for deliveries
configured for/sent to a GitHub App; do not assume it is present on an ordinary repository hook.
The numeric repository id + per-link secret is the authoritative binding either way.

### 6.4 Migration and global-secret cutover

Keep the existing `/webhooks/github` App route and its current/previous global-secret verification
unchanged during expansion. Link state is the no-downgrade control:

| State      | App-level global delivery                | Link delivery                                | Meaning                                         |
| ---------- | ---------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `legacy`   | process normally                         | none                                         | pre-migration behavior                          |
| `pending`  | process normally                         | signed ping only                             | provisioning/permission recovery                |
| `active`   | acknowledge `superseded` without resync  | process                                      | global secret no longer authorizes this product |
| `rotating` | same as active                           | accept current + next/previous allowed slots | GitHub config update in flight                  |
| `error`    | legacy only until a verified hook exists | refuse unverified                            | no silent partial cutover                       |

This prevents the global secret from retaining authority over a migrated tenant. It also avoids
double resync: a pending hook may confirm only by ping; after active, the App receiver skips that
product entirely.

Final contract phase is separate and only after a report proves zero legacy/pending/error links:

1. human disables Push and Release subscriptions on the GitHub App registration;
2. deploy code that treats the old global endpoint as retired; monitor real repo hooks;
3. remove `GITHUB_WEBHOOK_SECRET` and `_PREVIOUS` from Env, config guard, deploy preflight,
   platform inventory, runbook/deployment/threat-model docs, and tests;
4. delete legacy receiver code in a clean cutover PR.

### 6.5 Per-link rotation

Rotation must survive a GitHub/Worker partial failure:

1. generate and seal `next` under `:<hook_ref>:next`; persist `state='rotating'` before calling
   GitHub;
2. PATCH the hook config with the new secret. GitHub requires the secret to be supplied on a
   webhook config update or it removes the existing secret;
3. while rotating, verifier accepts old current and new next. If PATCH succeeds, atomically promote
   next → current, current → previous, and set `previous_until` (recommend 24 hours); if it fails,
   keep current authoritative and retain/retry next without an authentication gap;
4. accept previous only until expiry; a verified next delivery/ping is audit evidence of success,
   not a reason to erase the previous slot early;
5. operator can cancel a pending rotation only before GitHub has been patched. After patch, repair
   forward or deliberately patch old material back; never silently delete both candidates.

Every create/rotate/delete/reconcile action produces a security/audit event without URL secret or
ciphertext. Delivery refusal/failure counts are observable per product so a tenant-deleted hook is
detected rather than silently losing sync.

### 6.6 Tests

1. Link A secret never validates link B’s path, repository id, or product, including same-monorepo
   products; body claims are namespaced per link.
2. Current/next/previous secret order, expiry, cancellation, crash-between-persist-and-PATCH, and
   ping activation all have deterministic clock tests.
3. Unknown ref/header and bad signature have the same response shape; malformed/oversized body is
   capped before JSON parsing; no secret/ciphertext reaches logs or response.
4. Global route processes only legacy/pending links and cannot resync active links; active hook
   processes only its product; default-head pinning and existing replay semantics remain covered.
5. Hook API requests are repo-scoped, request only hooks write + required metadata, never cache
   write-capable tokens, and handle unaccepted permission/403/422 without falsely activating a
   link.
6. Migration, vault AAD, reseal sweep/count, product deletion, reach ownership, hook reconciliation,
   OpenAPI/routeCoverage, boundaries, and worker-workerd tests are covered.
7. A real GitHub sandbox integration test proves actual hook headers/payload fields, create/ping,
   rotate, delete, and an App-permission upgrade on a non-production installation.

## 7. Rollout and rollback

1. **Human setup first:** approve repository Webhooks read/write on the App, have every existing
   installation owner accept the permission change, and provide a sandbox repo/install for the
   payload/header spike.
2. **Expand:** deploy table/vault/receiver/state/reporting code with every link still `legacy`.
   Existing global webhook behavior remains intact.
3. **Migrate incrementally:** provision one link, require verified ping, then flip only it active.
   Observe resync/refusal/audit counters before proceeding. A denied permission remains legacy;
   it is visible and cannot pretend migration succeeded.
4. **Rotate rehearsal:** on sandbox, rotate a per-link secret and prove both in-flight old and new
   signatures work inside the grace window.
5. **Contract:** only after zero legacy links and explicit owner approval disable App Push/Release,
   then remove global secret support in a later deployment.

Rollback before contract is per-link: set active hook back to legacy and leave the App-level webhook
as its verified path. Do not delete a per-link secret until GitHub hook deletion succeeds or is
recorded for reconciliation. After global-secret removal, rollback requires re-enabling the App
subscription and restoring its secret via the documented incident procedure; it is intentionally
not a casual code rollback.

## 8. Risks and decisions for the human

1. **Approve `repository_hooks: write` for the GitHub App?**
   - **Recommend yes only before external-tenant onboarding**, after sandbox proof. It enables true
     per-link secrets and no human-visible secret in automatic provisioning.
   - Cost: a compromised App private key gains permission to create/modify/delete repo hooks across
     installations, widening that credential’s blast radius. Existing installation owners must
     accept the permission upgrade.
2. **Automatic App-managed hooks versus manual owner setup?**
   - **Recommend App-managed with manual fallback.** Manual-only avoids the new permission but
     makes provisioning/rotation error-prone and hard to audit.
3. **Timing:** implement now or gate on first third-party tenant?
   - **Recommend gate before the first third-party repository is linked.** The current global-secret
     residual is primarily cross-tenant resync/API amplification because content is default-head
     pinned; it is still the wrong foundation for third-party tenant isolation.
4. **Grace period:** approve 24 hours for previous hook-secret verification. **Recommend yes.** It
   covers delayed deliveries/manual redelivery without leaving an old secret indefinite.
5. **Sandbox facts required:** confirm repository-hook payload/header shape, whether an installation
   object is present, GitHub behavior for redelivery after secret rotation, and the installation
   permission-upgrade UX. The plan fails closed rather than assuming these details.
6. **Legacy retirement:** approve disabling App Push/Release only after the report is zero for every
   link. A date-based forced cutoff is not recommended unless an alternate polling/resync path is
   approved.

## 9. Acceptance

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test boundaries
mise exec node@22 -- pnpm --filter @polaris-key/worker test R5-isolation
mise exec node@22 -- pnpm --filter @polaris-key/worker test R12-secrets
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm format
```

Plus a human-run sandbox GitHub App/repository-hook rehearsal covering creation, signed ping,
push/release, rotation, deletion, permission denial, and rollback. No implementation is accepted
until its real delivery payload proves the binding assumptions above.

---

## Appendix A — remove the unscoped installation-token fallback

`services/release/githubApp.ts:249-335` still accepts `InstallationTokenScope | string`. Only the
legacy string form appends a third token-mint attempt with no `repositories` field
(`:302-307`), yielding an installation-wide read token if GitHub rejects narrowing. All current
production callers use structured `{ owner, repo }` scopes (`assetSource`, `gateway`, `health`,
`linkExisting`, `linkRepo`, and `resync`); bare strings remain in tests only.

The approved small cutover is:

1. make `InstallationTokenScope` the only accepted scope type in `normalizeScope`,
   `installationTokenSlot`, and `getInstallationToken`;
2. remove `UNSCOPED`, `legacy`, the `?/<repo>` cache descriptor, and the third no-repositories
   attempt;
3. keep the first two attempts: requested repo-scoped permissions, then the same repo with
   `BASE_PERMISSIONS` when optional Actions/Pull Requests permissions are rejected;
4. remove/update tests that assert legacy success; add a negative recorder assertion that every
   release-read mint request contains exactly the intended `repositories: [repo]` and never mints
   an unscoped token;
5. leave `mintListingToken` unchanged: its installation-wide `metadata: read` token is an explicit,
   uncached repository-listing capability, not this fallback.

This needs no migration, wire change, or SDK work. A 404/422 for a structured repo scope now fails
closed rather than silently widening to the whole installation.

# Security plan: per-link GitHub webhook secrets and scoped installation tokens

| Field            | Value                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief            | None yet. This is an unowned security finding; approval creates the implementation work package(s).                                                                                                                                                                                                                                                   |
| Status           | Approved 2026-10-16 as design of record (lead, delegated); Appendix A now; per-link hooks deferred until the sandbox spike passes and a third-party tenant is near                                                                                                                                                                                    |
| Basis            | `main` at `d27467ef8`; receiver is `packages/worker/src/githubWebhook.ts` (not the stale `services/release/githubWebhook.ts` path in the finding), token code is `services/release/githubApp.ts`, and vault code is `platform/keyvault.ts`.                                                                                                           |
| Wire change      | **None.** This changes an inbound GitHub control-plane receiver only. No device route, signed document, claim, SDK API, `PROTOCOL_VERSION`, `corpusVersion`, `shared-protocol`, or `shared-jws` change.                                                                                                                                               |
| Corpus / SDKs    | None. Existing device transcripts and all SDK behavior remain byte-identical.                                                                                                                                                                                                                                                                         |
| Human dependency | A GitHub App registration has one App-level webhook URL/secret, not per-installation secrets. True per-tenant isolation requires repository webhooks and a human-approved `repository_hooks: write` App permission. Contract, and any post-contract rollback, also need human-run App registration changes (event subscriptions, App webhook secret). |

## Decisions (lead, 2026-10-16)

Delegated by the owner; rulings on §8. This plan is the **design of record**: Appendix A (remove the unscoped installation-token fallback) is implemented now; the per-link hook work is deferred until the sandbox spike passes and a third-party tenant is near.

1. **`repository_hooks: write`:** only after the sandbox proof and before any external tenant.
2. **Manual secret display:** no.
3. **Timing:** gated on the first third-party repository link.
4. **Previous-secret grace:** 24 hours.
5. **Sandbox facts are required inputs.** If the delivery GUID is not shared between App-level and repository-hook deliveries, the plan returns for review.
6. **Legacy retirement:** C1, then C2 only after every link, the system product included, is active.
7. **Recovery:** replacement-secret restore, not escrow.

Amendments: the `SEALED_TABLES` cite is `console/handlers/products.ts:~745`. `/webhooks/github` is not in `openapi/polaris-key.v3.yaml`; the new route follows the existing route's classification (see §2, hard rule 10).

Owner preconditions (also in the owner-steps checklist):

1. Approve the `repository_hooks: write` permission upgrade on the GitHub App, and run the sandbox spike (decision 5), before any external tenant.
2. Install the App on the platform repository, so the system product can become active before C2.
3. Decide per-link handling for any installation owner who declines the permission.
4. Choose the C1/C2 soak length (14 days recommended).

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

1. provision, verify, rotate, reconcile, retire, and delete per-link repository hooks, with an exact
   inventory of every linked product (legacy ones included) kept by backfill and reconciliation;
2. receive a link-scoped hook at an opaque path, verify current/next/previous sealed secrets,
   require the hook to match the product’s _current_ release repository before any write, and act
   only on that link;
3. migrate one link at a time from the global App webhook; both ingress routes claim one durable
   per-product, per-event idempotency key, so no event is processed twice across a cutover or a
   rollback;
4. retire `GITHUB_WEBHOOK_SECRET` and `_PREVIOUS` only after every link has migrated, behind a
   rehearsed rollback that never depends on GitHub’s currently stored App secret; and
5. remove the dead bare-string installation-token fallback in `githubApp.ts` (Appendix A).

Out of scope: a tenant-supplied GitHub App, a general GitHub integration platform, GitHub Actions
OIDC publisher changes, new product manifest fields, any device-wire change, and a manual
owner-entered hook setup that would display a platform-generated secret (removed in §6.2: a link
whose installation owner declines the permission stays on the global route).

## 2. Contract and hard rules

This is not a Polaris Key wire-contract change. The only public route addition is an inbound GitHub
control-plane endpoint; it gets an OpenAPI and route-coverage entry under hard rule 10 but never
appears in a signed document or SDK. The report and lifecycle operations of §6.4 are platform-area
console routes, not public ones.

- **Hard rule 1:** no corpus/transcript/mirror edits.
- **Hard rule 2:** protocol/corpus versions remain unchanged.
- **Hard rule 5:** secrets and links are data rows, never `if (product === ...)` code.
- **Hard rule 6:** sealed-secret access belongs behind a release-owned store; root receiver code
  may compose it but no console handler reads sealed columns directly. The one existing exception
  is the key-vault reseal/status sweep (`SEALED_TABLES`, `console/handlers/products.ts:~745`): it is
  the KEK rotation itself, it is extended to the three webhook slots (§6.1), and a reach test, like
  `outletCredentialReach.test.ts`, keeps it the only one.
- **Hard rule 10:** the existing `/webhooks/github` route is not in `openapi/polaris-key.v3.yaml`; `routeCoverage.test.ts` lists `githubWebhook` as narrative-only (`:69`) and as a non-CORS surface (`:825`). The new `/webhooks/github/<hook_ref>` route follows that classification: check `routeCoverage.test.ts` and do not assume an OpenAPI entry is required.
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

Add release-owned tables rather than widening `release_config` with secret columns. One row per
linked product holds the link state (§6.4 keeps that set exact); a second table queues hooks that
still have to be deleted at GitHub (§6.5); a third, defined in §6.5, is the cross-ingress
idempotency ledger.

```sql
CREATE TABLE IF NOT EXISTS release_repo_webhooks (
  product                 TEXT PRIMARY KEY REFERENCES products(slug),
  state                   TEXT NOT NULL,      -- legacy | pending | active | rotating
  -- The link this row was provisioned for: copied from release_config and compared with it on
  -- every delivery (6.3). Never the source of truth for which repository the product follows.
  gh_installation_id      INTEGER,            -- NULL where release_config has none (system product may)
  gh_owner                TEXT NOT NULL,
  gh_repo                 TEXT NOT NULL,
  gh_repository_id        INTEGER,            -- GitHub numeric repository id, pinned at provisioning
  -- Hook identity and secret material exist only once a hook is being provisioned.
  hook_ref                TEXT UNIQUE,        -- random, opaque, URL-safe handle (at least 128 bits)
  gh_hook_id              INTEGER UNIQUE,     -- set after GitHub creates the hook
  current_secret_sealed   TEXT,
  next_secret_sealed      TEXT,
  previous_secret_sealed  TEXT,
  previous_until          INTEGER,
  patch_started_at        INTEGER,            -- rotation: set before the GitHub PATCH is sent (6.7)
  rotation_mode           TEXT,               -- rotation: normal | emergency, fixed when it starts (6.7)
  activated_at            INTEGER,            -- first verified ping; NULL = never verified
  catchup_due_at          INTEGER,            -- a catch-up sync has been owed since this time (6.5)
  last_delivery_at        INTEGER,
  last_error              TEXT,
  created_at              INTEGER NOT NULL,
  modified_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_repo_webhook_cleanup (
  hook_ref            TEXT NOT NULL PRIMARY KEY,  -- finds the hook by callback URL when gh_hook_id is unknown
  gh_installation_id  INTEGER,
  gh_owner            TEXT NOT NULL,
  gh_repo             TEXT NOT NULL,
  gh_repository_id    INTEGER,
  gh_hook_id          INTEGER,
  reason              TEXT NOT NULL,          -- relink | unlink | deleted | rollback | repository | aborted | orphan
  state               TEXT NOT NULL,          -- pending | abandoned (removed once the hook is deleted or found absent)
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          INTEGER NOT NULL
);
```

`00XX_release_repo_webhooks.sql` creates them, with the state vocabulary and the per-state rules
below enforced by CHECKs (or triggers, where D1 cannot add the desired CHECK without a rebuild). The
state decides which columns exist, so a `legacy` row never requires secret material that does not
exist:

| State      | `hook_ref` | `gh_hook_id` | `gh_repository_id` | `current_secret_sealed` | `activated_at` | `next_secret_sealed`, `patch_started_at`, `rotation_mode` | `previous_*`    |
| ---------- | ---------- | ------------ | ------------------ | ----------------------- | -------------- | --------------------------------------------------------- | --------------- |
| `legacy`   | NULL       | NULL         | may be NULL        | NULL                    | NULL           | all NULL                                                  | NULL            |
| `pending`  | set        | may be NULL  | set                | set                     | NULL           | all NULL                                                  | NULL            |
| `active`   | set        | set          | set                | set                     | set            | all NULL                                                  | both or neither |
| `rotating` | set        | set          | set                | set                     | set            | all set                                                   | both or neither |

`previous_*` is the pair `previous_secret_sealed` and `previous_until`, both set or both NULL.
`rotation_mode` is `normal` or `emergency`, and is set exactly when `next_secret_sealed` is.
`catchup_due_at`, `last_delivery_at`, `last_error` and the timestamps are unrestricted in every
state. `last_error` is health, not authority: a failure never changes which ingress route is
authoritative (§6.5). Every legal transition in §6.2, §6.5 and §6.7 produces a row that satisfies
the table, and test 3 inserts each one. It is one product-link per row; if two products share one
monorepo they receive two distinct GitHub hooks, paths, and secrets, so one product’s secret cannot
resync the other.

Generate each secret with 32 random bytes. Add `"release-webhook-secret"` to `SealContext.kind`.
Seal slots with distinct AAD ids:

```text
pkey:v2:<product>:release-webhook-secret:<hook_ref>:current
pkey:v2:<product>:release-webhook-secret:<hook_ref>:next
pkey:v2:<product>:release-webhook-secret:<hook_ref>:previous
```

The AAD binds a ciphertext to its slot, so ciphertext is never moved between columns: AES-GCM
refuses to open it under the destination AAD. Every slot move is `open` under the **source** slot’s
AAD followed by `seal` under the **destination** slot’s AAD (`seal` always uses the active KEK, so a
move also re-keys the value). Both results are computed in memory before the single
compare-and-swap that commits them (§6.7); until it succeeds, the old readable state is unchanged.

The key-vault reseal/status sweep currently enumerates one sealed column per table in
`console/handlers/products.ts:688-716`. Extend its descriptor to walk all three webhook slots,
count their `kekId`s, re-seal each under its own slot’s AAD, skip NULL slots (a `legacy` row
contributes nothing), and report unreadable rows. Each sweep write is a compare-and-swap on the
ciphertext it read, so a sweep racing a rotation retries instead of overwriting a promotion. Add a
reach test like `outletCredentialReach.test.ts`. Rows are retired with their link, never left
behind by `deleteProduct` or a relink (§6.4). No route, status API, audit payload, or log line
returns or records secret material; plaintext exists only in memory between generation or `open`
and the GitHub request (§6.2 removes the one path that would have displayed it).

### 6.2 Hook provisioning and least privilege

GitHub’s repository-webhook endpoints accept a per-hook `config.secret` and support multiple hooks
per repository ([Repository webhook API](https://docs.github.com/en/rest/repos/webhooks)). Their
App permission is `repository_hooks`, and GitHub gates the endpoints by level: `write` to create,
update (including `…/config`) and delete hooks, `read` to list and read hooks and deliveries and for
`POST …/pings`
([GitHub App permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).

Add a dedicated, uncached `mintRepositoryWebhookToken` path:

- input is structured `{ owner, repo }`, discovered/stored installation id, and a hooks purpose,
  `read` or `write`;
- POSTs an installation token request narrowed to `repositories: [repo]` and only mandatory
  metadata plus `repository_hooks` at that level: `read` for reconciliation, drift reads and pings,
  `write` only for provision, rotate, repair (reconciliation’s convergence of a diverged secret is a
  repair) and retire/cleanup;
- never shares a cache key with the release-read token and never falls back to installation-wide
  access;
- is called only by the provision, rotate, repair, reconcile and retire/cleanup lifecycle
  operations.

Creation sequence is idempotent, crash-safe and resumable. The row already exists as `legacy`
(§6.4):

1. before any state change, resolve/pin the numeric repository id through the existing GitHub
   identity read (`getRepoIdentity`; it must agree with `release_config`, owner/repo equal
   case-insensitively) and mint the write-level hooks token. A permission or identity failure
   (403/404/422) leaves the row `legacy` with `last_error` and nothing to undo;
2. generate `hook_ref` and seal the current secret; move the row `legacy → pending` with a
   compare-and-swap on `state = 'legacy'` and `LINK_BOUND` (§6.3), so two provisioners cannot both
   proceed;
3. `POST /repos/{owner}/{repo}/hooks` with JSON content, `push` and `release` events, active true,
   `https://<platform-origin>/webhooks/github/<hook_ref>`, and the random secret. A definitive
   refusal (4xx) aborts with `pending → legacy` in one batch that queues a URL-keyed cleanup entry
   (reason `aborted`, no hook id), clears `hook_ref` and the secrets, and sets `last_error`. The
   entry removes itself when the cleanup job finds no hook at that URL, so the abort never asserts
   that nothing exists (an earlier unknown-outcome attempt may have left a hook). An unknown
   outcome (timeout, 5xx, a crash) leaves the row `pending`, and reconciliation resumes it (§6.4);
4. store the returned GitHub hook id with a conditional update on `product`, `hook_ref`,
   `LINK_BOUND` and (`gh_hook_id` unset or equal). If it changes no row, re-read: our `hook_ref`
   still present (pending, or already activated by the creation ping, which stores the id itself)
   is success with nothing to delete; a missing or different `hook_ref`, or a changed link, queues
   the hook just created for deletion (an insert keyed by `hook_ref` that ignores a duplicate,
   recording the id) instead of adopting it. A crash after GitHub success is repaired by listing
   hooks for the known callback URL and adopting the one, never creating duplicates;
5. accept GitHub’s signed `ping` event only at this path; a verified ping flips `pending → active`
   (§6.5). A pending hook does not resync production data until its ping verifies.

Provisioning is App-managed only. If an installation owner has not accepted the
`repository_hooks: write` permission the attempt fails (403/422), the row stays `legacy` with
`last_error`, and the report lists the link as unmigrated (§6.4); nothing pretends the migration
succeeded. The earlier idea of a manual fallback that displays one hook URL and secret to an owner
is removed: it would be the only path that returns a decrypted secret, and the default design does
not need it. If the human wants it back, it is a separate reviewed addition that must at least
require a privileged role with fresh step-up, a single retrieval bound to the provisioning
operation, no logging/storage/client caching of the response, and an audit event that records the
reveal without secret material (decision 2).

### 6.3 Link-scoped receiver

Add:

```text
POST /webhooks/github/<hook_ref>
```

The opaque random ref selects one row before parsing the body; it is a lookup hint, not an
authorization factor. Its exact shape (length and charset) is validated before any store access, so
a malformed ref costs no read. Unknown ref, a ref that no longer resolves (a `legacy` row has
none), malformed method/body/signature, hook-id mismatch, repository mismatch, stale-link mismatch,
and an unavailable sealed secret all return the same unauthenticated shape without naming the
product. Retain the existing body cap before JSON parsing.

**Current-link binding.** The webhook row records the link a hook was provisioned for; the
authoritative link is the product’s `release_config`. A delivery may be acted on only while the two
agree, so `LINK_BOUND(product)`, one shared SQL fragment, is evaluated before **any** replay,
delivery-state, ping-state or resync write, and again inside every state-changing statement that
follows (the event claim, the ping activation, the lifecycle writes). It requires:

- `products.release_source = 'github'` and the product is not soft-deleted;
- `lower(release_config.gh_owner)` and `lower(release_config.gh_repo)` equal `lower(gh_owner)` and
  `lower(gh_repo)` of the row, and `release_config.gh_installation_id IS` the row’s
  `gh_installation_id` (NULL-safe: the system product may have none, and keeps a stored one).

After the bounded body read:

1. one indexed read loads the row for `hook_ref` with the product’s current link and evaluates
   `LINK_BOUND`. A mismatch is the generic unauthenticated answer, before any KV, DO or D1 write: a
   still-valid hook for a repository the product no longer follows cannot cause a replay claim, a
   delivery timestamp, a ping activation or a resync;
2. open current and, only while allowed (next while `rotating`, previous until `previous_until`),
   the other secret slots;
3. verify `X-Hub-Signature-256` against the raw bytes using constant-time comparison; a match must
   identify one allowed slot. A match under `next` is proof GitHub already holds that secret and
   triggers the promotion in §6.7;
4. parse JSON only after signature verification; require the signed `repository.id` to equal
   `gh_repository_id` and owner/repo to match the row (hence the current link) case-insensitively;
   when the payload carries an installation id and the row has one, they must be equal (a row
   without one, the system product, accepts any);
5. cross-check `X-GitHub-Hook-ID` once `gh_hook_id` is known. The header is not trusted alone;
   its only role is defense-in-depth after HMAC success;
6. a `ping` takes its own path (§6.5): its authority is a row in `pending`, `active` or `rotating`
   with this `hook_ref` and `LINK_BOUND`, and it takes no ledger claim and no body claim (activation
   is a conditional update and idempotent, and byte-identical pings are legitimate). Every other
   event claims the event in the shared per-product ledger (§6.5), whose statement re-evaluates the
   route’s authority and `LINK_BOUND` atomically, then the body under a **link-namespaced** key
   (`gh-body:<product>:<sha256>`; the current unscoped body hash would incorrectly drop a legitimate
   second product hook that receives the same monorepo event). A refused body claim gives the
   ledger row back, so only a request that will do the work holds either claim;
7. act: `ping` confirms state and `push`/`release` operate on this one product only. The normal
   resync reads its coordinates from `release_config` (which step 1 proved equal the hook’s) and
   GitHub’s default-branch head server-side; no webhook `after` or other body field chooses content
   or ref.

Before implementation starts, run a sandbox spike (§7 step 1): create a repository hook through an
installation token, push, and record the actual headers/body. GitHub documents that `installation`
appears for deliveries configured for/sent to a GitHub App; do not assume it is present on an
ordinary repository hook. The numeric repository id + per-link secret is the authoritative binding
either way. The spike also records whether `X-GitHub-Delivery` is the same on the App-level
delivery and the repository-hook delivery of one event, and on redelivery: the idempotency key in
§6.5 depends on it. Its findings return to the owner before any implementation starts, and a result
that contradicts an assumption of this plan (decision 5) returns the plan for review instead of
being coded around.

### 6.4 Link inventory, backfill, and reconciliation

**Authoritative link set.** A product is _linked_ when `release_source = 'github'`, it is not
soft-deleted, and its `release_config` row names an owner and a repo: exactly the join the global
receiver uses to find the products a delivery may act on (`listProductsByGithubRepo`). The
implementation factors that join into one shared predicate used by the receiver, the backfill and
the report, so a product cannot be actable by the global route yet missing from the inventory. The
system product is an ordinary member even though the deploy hook links it with no installation id:
its numeric repository id comes from GitHub like the others, its installation is discovered at
provisioning (`discoverInstallation`), and its `.pkey/` push stays refused on both routes
(`systemResyncRefusal`; only its release-truth refresh is driven by a hook). If the App is not
installed on the platform repository it stays `legacy`, which holds the contract open (§6.6).

**Invariant I1.** Every linked product has exactly one `release_repo_webhooks` row whose
`(gh_installation_id, gh_owner, gh_repo)` equals its current `release_config`, and every row belongs
to a linked product. A link that was never provisioned has a `legacy` row and nothing more.

**Backfill.** `00XX_release_repo_webhooks.sql` creates the three tables, then runs one idempotent
`INSERT … SELECT … ON CONFLICT(product) DO NOTHING` over the linked set that writes
`state = 'legacy'`, copies `gh_installation_id`, `gh_owner` and `gh_repo` from `release_config`, and
sets the timestamps. It invents no secret, `hook_ref`, hook id or numeric repository id (the
state-conditional CHECKs forbid them on a `legacy` row), makes no GitHub call, and seals nothing, so
it is plain SQL that runs before any App-permission or KEK step. It is expand-only: a Worker
deployed before it never names the tables. Afterwards an absent row is treated as `legacy`: the
global route is superseded for a product only by an `active`/`rotating` row that satisfies
`LINK_BOUND`, so a missing, stale or unreconciled row can never block the legacy path.

**Writers keep I1 true.** Every code path that changes a link or its liveness appends one pure
statement builder, `stmtRetargetWebhook(product, newLink | null)`, to the **same D1 batch** as the
link write. It lives beside `stmtInsertReleaseConfig` in `core/repo.ts`, so Core’s `deleteProduct`
and the release service share it without a cross-service import. The paths are the callers of
`stmtInsertReleaseConfig` (`linkRepo`, `linkExisting`, `linkSystemProduct`), `linkExisting`’s
rollback statements, `deleteProduct`’s soft delete, and any other write of `release_source` or
`release_config`’s link columns. The builder is placed after the write and derives the link in SQL
from the post-write `release_config` (and `products`), not from its parameters, so columns a writer
deliberately preserves (the system product keeps a stored installation id) cannot register as a
change. When the post-write link differs from the row’s snapshot (compared case-insensitively), the
statements (a) copy the old hook identity (installation, owner, repo, numeric id, `hook_ref`,
`gh_hook_id`) into `release_repo_webhook_cleanup`, only where `hook_ref IS NOT NULL`, and (b) reset
the row to `legacy` bound to the new link with every hook and secret column NULL; with
`newLink = null` they delete the row. `linkExisting` only links a product that is not yet linked, so
its rollback always unlinks and calls the builder with `newLink = null`. A write that leaves the
link unchanged (the deploy hook re-asserts the system product on every deploy) leaves the row and
its hook alone, and a first link inserts the `legacy` row. Because that batch is atomic and
`LINK_BOUND` compares the two on every delivery, there is no instant at which the new link exists
while the old hook still authorizes anything. A reach test fails if any source file writes
`release_config`’s link columns or `products.release_source` outside the builder, and
`tableCrossings.test.ts` is updated for the new tables.

**Reconciliation** is idempotent and read-mostly. It runs nightly as a fault-isolated `step()` in
the maintenance sweep and on demand through a platform-operator route. It compares the linked set
with the rows and:

- inserts a `legacy` row for a linked product that has none (`missing`);
- retires a row whose link snapshot no longer equals `release_config`, or whose product is no longer
  linked (`stale`): the retire transition of §6.5, which §6.3 already makes harmless in the
  meantime;
- for rows that have a hook, reads GitHub with a read-level hooks token (hook exists and is active,
  URL is this ref, events are push and release, repository id and name unchanged, and no recent
  4xx from this platform on a non-ping delivery in the hook’s delivery log, which would mean GitHub
  signs with a secret the row does not accept) in bounded, resumable batches and records drift in
  `last_error`. A secret divergence is converged with the §6.7 PATCH rule (a `repair`, write-level
  token), re-pinged, and confirmed from the ping delivery’s `status_code`; a missing hook, a wrong
  URL or changed events are reported for an operator’s `repair`. A quiet repository is not a fault,
  so `last_delivery_at` is informational. Drift never changes which route is authoritative; the one
  exception is a changed repository id, which retires the hook. A renamed repository stays refused
  (the signed name no longer equals `release_config`’s) and is reported until an operator relinks
  it;
- resumes a `pending` row once it is older than the creation timeout plus a margin (ten minutes, so
  a live provisioner is not raced): it lists the repository’s hooks for the callback URL, adopts the
  one it finds, POSTs with the stored secret if there is none, and re-pings a hook whose first ping
  did not verify;
- reruns up to twenty rows with `catchup_due_at` set (§6.5), retries the cleanup queue (bounded
  attempts, then `abandoned` and reported), and queues orphan hooks for cleanup (reason `orphan`):
  hooks on linked repositories whose callback URL has this platform’s `/webhooks/github/` prefix but
  a ref that no row and no cleanup entry owns.

The **report** is a read-only platform-area console route, served by the release-owned webhook
store, that computes per request and with no secret material: counts by state; `linked`, `rows`,
`missing` and `stale`; the number of sealed slots that fail to `open` (the store attempts the open
and returns only booleans, so no console handler reads a sealed column); cleanup `pending` and
`abandoned`; orphan hooks; and per product `last_delivery_at`, `last_error`, `catchup_due_at`, the
live `claimed` ledger rows and the recent `webhook.refused` events. **Complete** means
`missing = 0`, `stale = 0` and `linked = rows`. Provisioning, every migration step and the contract
gate (§6.6) require a complete report, not a count of whichever rows happen to exist. The
provision, rotate, repair, `expire-previous`, retire/rollback and reconcile operations are
release-service actions behind platform-area, step-up console routes. Their route table is fixed in
the implementation PR: each route is declared in `console/routes.ts` with its RBAC-matrix row and
step-up entry (`console/stepUp.ts`) in the same change and, per hard rule 10, is pinned in OpenAPI
and in `routeCoverage`’s `ADMIN_KIND_PATHS`, as the U-03 platform routes are.

### 6.5 Migration states and the cross-ingress fence

Keep the existing `/webhooks/github` App route and its current/previous global-secret verification
unchanged during expansion. Which route may act on a product is a function of its row’s `state` and
of whether that row is still bound to the product’s current link (no row counts as `legacy`);
health never changes it. Link state is the no-downgrade control:

| State      | App-level global delivery               | Link delivery                                            | Meaning                                         |
| ---------- | --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `legacy`   | process normally                        | none (no ref resolves)                                   | pre-migration behavior                          |
| `pending`  | process normally                        | signed ping only; other events acknowledged, unprocessed | hook provisioned, not yet verified              |
| `active`   | acknowledge `superseded` without resync | process                                                  | global secret no longer authorizes this product |
| `rotating` | same as active                          | accept current + next (+ previous while live)            | GitHub config update in flight                  |

There is no `error` state. A provisioning or drift failure records `last_error` and leaves
authority where it was, so a failure can neither silently hand a migrated tenant back to the shared
secret nor silently strand it: a hook that breaks after `active` is a visible fault to repair
(`repair`, §6.7) or an explicit, audited rollback (§6.6). The one automatic exit from `active` is
the retire on a changed repository id (the pinned repository is gone, so the binding is void).

This prevents the global secret from retaining authority over a migrated tenant. The fence below
is what makes _no double resync_ hold across the flip.

**One idempotency key for both routes.** GitHub documents `X-GitHub-Delivery` as the GUID that
identifies the _event_
([delivery headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers)),
and the REST delivery `guid` as shared with all deliveries for all webhooks that subscribe to that
event (the published OpenAPI description, `hook-delivery`). The App-level delivery and the
repository-hook delivery of one event, and a redelivery of either, therefore carry the same GUID
(the sandbox spike confirms it; decision 5). Both routes claim the same durable key,
`(product, X-GitHub-Delivery)`, in one release-owned ledger, and only the claim’s owner does work
for that product:

```sql
CREATE TABLE IF NOT EXISTS release_webhook_events (
  product      TEXT NOT NULL REFERENCES products(slug),
  delivery_id  TEXT NOT NULL,   -- X-GitHub-Delivery: bounded length, restricted charset
  route        TEXT NOT NULL,   -- app | link: the route that holds or finished the claim
  state        TEXT NOT NULL,   -- claimed | done
  claim_nonce  TEXT NOT NULL,   -- random per claim or takeover; finish and give-back must match it
  claimed_at   INTEGER NOT NULL,
  lease_until  INTEGER NOT NULL,
  done_at      INTEGER,
  PRIMARY KEY (product, delivery_id)
);
```

The claim is one D1 statement: an `INSERT … SELECT` guarded by the route’s authority, which takes
over an existing row only through `ON CONFLICT … DO UPDATE` when that row’s lease has expired. Its
changed-row count says who owns the event. It is D1 rather than the single-use DO because the claim
must be atomic with the very rows that decide authority; two stores could not be. The two
authorities are these predicates (`LINK_BOUND` is §6.3’s fragment over the same row `w`):

```sql
-- App route: superseded only by an active/rotating row that is still bound to the current link
NOT EXISTS (SELECT 1 FROM release_repo_webhooks w
             WHERE w.product = :product AND w.state IN ('active', 'rotating') AND LINK_BOUND(w))
-- link route: this ref's row is active/rotating and bound
EXISTS     (SELECT 1 FROM release_repo_webhooks w
             WHERE w.product = :product AND w.hook_ref = :ref
               AND w.state IN ('active', 'rotating') AND LINK_BOUND(w))
```

- `<authority>` is the route’s authority at that instant, one of the predicates above (a `ping`
  never claims; see below). Check and claim are one atomic statement, so a `pending → active` flip
  or a rollback cannot interleave between them: after the flip no new App claim succeeds, and
  before it no link claim does;
- no row: the caller owns the event (lease five minutes) under a fresh `claim_nonce`. A `claimed`
  row with a live lease: the event is in flight on some route, and the caller is told `in-flight`. A
  `claimed` row past its lease (a crashed owner): the caller takes it over with a new nonce. A
  `done` row: `duplicate`. `done` rows are kept seven days, the existing delivery-marker TTL, and
  pruned by the nightly sweep;
- the owner marks the row `done` when the product’s work ran to an answer (any 2xx/4xx outcome, as
  today’s replay marker). A thrown or 5xx outcome deletes its own `claimed` row, exactly as today’s
  replay claims are given back, so GitHub’s redelivery can do the work. Both writes are conditional
  on the owner’s `claim_nonce`, so a slow owner whose lease was taken over can neither finish nor
  delete the new owner’s row; and
- a route that is not authoritative acknowledges (`superseded`) without claiming, so it cannot
  consume the claim the authoritative route needs.

A `ping` takes no ledger claim and no body claim. Its authority is a row in `pending`, `active` or
`rotating` with this `hook_ref` and `LINK_BOUND`; activation is a conditional update and idempotent,
and ping bodies are low-entropy, so byte-identical pings are legitimate and must all be processed.

A global delivery that passed its `pending` check is therefore already in flight under a `claimed`
row (or finished as `done`) when the ping activates the link; the link route’s copy of the same
event finds that row and answers `duplicate`/`in-flight` instead of resyncing a second time. The
same holds in reverse on rollback. Distinct events stay independent, as today: every resync reads
GitHub’s current head, so any order converges, and the claim’s job is to stop the _same_ event
running twice, not to serialize different ones. The global route keeps its whole-delivery replay
claims unchanged and adds this per-product claim around each product’s work (a product whose claim
is not owned is skipped; one that threw gives its claim back, and one already `done` is not redone
when GitHub redelivers). The link route takes the ledger claim first and keeps only the namespaced
body-hash claim beside it, because the ledger replaces its per-delivery claim.

**Transitions** are each one conditional statement. Every change that can leave an event
unprocessed also sets `catchup_due_at` in the same statement: `pending → active`, the retire back to
`legacy`, `repair` (§6.7), an emergency promotion and `expire-previous`. It is a durable obligation
to run one catch-up sync (`resyncRepo` plus the release-store sync for an ordinary product, the
release-store sync alone for the system product), covering any event lost to a failed claim owner,
to the flip, or to deliveries the platform refused meanwhile. The sync runs off the response path
where an execution context exists (`handleGithubWebhook` is given one, as the deploy hook has). Only
a sync that started at or after the marker and ran to an answer clears it: success, or a definitive
refusal recorded as the product’s sync state like any push. A transient failure keeps the marker and
sets `last_error`, and so does a runtime cut-off, an evicted isolate or a crash. Reconciliation
(nightly and on demand) reruns up to twenty due rows per pass; a resync that started before the
marker, such as one in flight across the flip, does not clear it.

- `legacy → pending` (§6.2);
- `pending → legacy` (§6.2): the abort of a definitive creation failure, which clears `hook_ref` and
  the secrets and queues a URL-keyed cleanup entry that removes itself when nothing is found;
- `pending → active`: the verified ping at the hook’s own path (no ledger claim), conditional on
  `state = 'pending'`, the row’s `hook_ref` and `LINK_BOUND`. It stores `gh_hook_id` from the signed
  ping if it was never stored, sets `activated_at`, and sets `catchup_due_at`;
- **retire** (relink, unlink, product delete, per-link rollback, a changed repository id): in one
  batch, copy the hook identity into `release_repo_webhook_cleanup` and null every hook and secret
  column with `state = 'legacy'` for the new link and `catchup_due_at` set, or delete the row. The
  sealed secrets are destroyed by this write; they are not needed to delete a hook. A hook that
  still exists at GitHub posts to a ref that no longer resolves and gets the generic answer until
  the cleanup job deletes it (by hook id, or by callback URL when the id was never stored); after
  bounded failures the entry is `abandoned` and reported, and the hook is harmless without a
  secret.

### 6.6 Contract and recoverable rollback

The contract is separate and happens only when its gate passes.

**Gate** (each item evidenced in the approval):

1. the §6.4 report is complete and every row is `active`: none `legacy`, `pending` or `rotating`,
   none with an unresolved `last_error` or a `catchup_due_at`, the cleanup queue is empty, and no
   sealed slot fails to open. The system product counts; a link whose owner declines the
   permission keeps the gate closed (decision 6);
2. the owner’s soak has passed (recommend 14 days after the last activation, including one real
   rotation) and every `webhook.refused` event and recent failed delivery in GitHub’s delivery logs
   is explained;
3. the global restore below and the per-link rollback were both rehearsed end to end on the sandbox
   App from a contract-state deployment, the restore ending with a real GitHub App delivery
   verified by the Worker; and
4. the owner approved the recovery material (decision 7).

**Two steps, reversible until the last:**

- **C1 (registration and mode only).** A human disables the Push and Release subscriptions on the
  GitHub App registration, and a deployment makes the global route answer `retired` without work, so
  from here the global secret authorizes nothing. `GITHUB_WEBHOOK_SECRET` and the App’s webhook
  configuration are left untouched: undoing C1 is re-enabling the subscriptions and redeploying the
  previous build (or `wrangler rollback`, which is safe here because the secret is unchanged).
  Monitor real repo hooks.
- **C2 (destructive).** Remove `GITHUB_WEBHOOK_SECRET` and `_PREVIOUS` from Env, config guard,
  deploy preflight, platform inventory, runbook/deployment/threat-model docs, and tests, and delete
  the legacy receiver code, in one clean PR that carries no schema change (so the rows and states
  stay readable to a restored build) and can be reverted as one commit. With no global ingress
  left, linking a product runs the §6.2 provisioning after its link batch commits. If that fails
  the link is not rolled back: the row stays `legacy` with `last_error` (which now only means “no
  webhook yet”), the report and console show it, and the manual Resync action still works.

**GitHub’s active secret.** GitHub keeps signing App deliveries with whatever secret is saved on the
App registration, and Worker secrets are write-only (RUNBOOK, “Rotating when the old KEK is
unknown”), so after C2 nothing may assume the two sides still hold the same value. A restore
therefore never reinstates the old value: it sets a fresh secret on **both** sides and proves it
with a real delivery. The same holds per hook: the plan does not assume GitHub returns a hook’s
stored secret, so recovery relies on confirmed writes and on GitHub’s own delivery log, never on
reading a secret back. The Worker’s row is authoritative. After a D1 restore or any
`wrangler rollback` (which restores old secret bindings; RUNBOOK, “`wrangler rollback` un-rotates
secrets”), reconciliation converges every hook to the row’s target secret with a confirmed PATCH
(the converge-to-row rule, §6.7; a hook that answers 404 is reported for `repair`) and then pings it,
confirming end to end from the ping delivery’s `status_code` in the hook’s delivery log (2xx means
the Worker verified it). A `rotating` row keeps accepting `next` as well, so this never opens a gap.

**Global restore (post-C2, platform-wide fallback).** This is the incident procedure. The
implementation adds it to `docs/RUNBOOK.md` as “Restoring the App-level GitHub webhook”, and it is
rehearsed before the contract is approved:

1. declare the incident and run no webhook lifecycle operation meanwhile;
2. revert the C2 and C1 PRs and deploy (the receiver returns in its pre-contract mode, not
   `retired`). Code only: the tables are unchanged, so every `active` link still supersedes the
   global route and nothing changes yet;
3. generate a **new** 256-bit secret and `wrangler secret put GITHUB_WEBHOOK_SECRET` (do not set
   `_PREVIOUS`; nothing old needs to verify);
4. set GitHub’s App webhook secret to the same new value (`PATCH /app/hook/config` with an App JWT,
   or the registration page), confirm the App webhook is active at
   `https://<origin>/webhooks/github`, and have a human re-enable the Push and Release subscriptions
   in the registration (`GET /app` lists the subscribed `events` to confirm);
5. verify with a push that changes no `.pkey/` path: the receiver verifies the signature and answers
   `ignored: no-manifest-changes`, and `GET /app/hook/deliveries` shows a 2xx. A 401 means the two
   sides disagree: repeat steps 3–4 with another value; and
6. only now flip links to `legacy` with the audited rollback.

**Per-link versus global fallback.** The rollback action turns one `active` link `legacy` (the
retire transition plus a catch-up sync). It is allowed only while a global ingress is **verified
live**, which is evidence of a working App route and not just configuration: `GITHUB_WEBHOOK_SECRET`
is configured, `GET /app` lists `push` and `release`, `GET /app/hook/config` names this platform’s
`/webhooks/github` URL, and `GET /app/hook/deliveries?status=success` shows a 2xx delivery to it
within the last day (the operator produces one with the side-effect-free probe push when the
platform is quiet). From C1 on the action is available only after C1 is undone and those checks
pass, and after C2 only after the restore above has passed step 5. A global fallback is that action
over every link; a partial fallback leaves healthy links on their own hooks (mixed mode is legal
because authority is per link). The order is always global ingress first, link flip second, so a
link is never left without a working route, and a link’s secret is destroyed only by its own flip.

### 6.7 Per-link rotation

Rotation is roll-forward only. It must survive a GitHub/Worker partial failure and must never
leave a slot holding ciphertext sealed for another slot’s AAD:

1. refuse unless the row is `active`, no rotation is open, and `previous_until` is not in the
   future (an emergency rotation, below, may start while `previous` is live). Generate the new
   secret S2, `seal` it under `:next`, and in one compare-and-swap (`state = 'active'`,
   `next_secret_sealed IS NULL`, `LINK_BOUND`) write `next_secret_sealed`, `state = 'rotating'`,
   `patch_started_at` and `rotation_mode` (`normal` or `emergency`), all before any GitHub call.
   From here the verifier accepts current (S1) and next (S2), so there is no authentication gap
   whichever secret GitHub is signing with;
2. update the hook’s configuration with `PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config`,
   sending the full set (`url`, `content_type: json`, `insecure_ssl: 0`, `secret: S2`) so nothing
   is dropped by omission (a full-hook update that omits the secret removes it:
   [Update a repository webhook](https://docs.github.com/en/rest/repos/webhooks#update-a-repository-webhook));
3. **promote** once GitHub has S2: on a 2xx PATCH, or on the first delivery or ping that verifies
   under `next` (positive proof that GitHub holds S2). Whichever path promotes (the rotate action,
   the receiver, reconciliation) reads `rotation_mode` from the row. In memory:
   `S2 = open(next, :next)` then `current' = seal(S2, :current)`, and
   `S1 = open(current, :current)` then `previous' = seal(S1, :previous)`. Then one
   compare-and-swap, which requires `state = 'rotating'` and both stored ciphertexts to equal the
   values read, sets `current_secret_sealed = current'`, `previous_secret_sealed = previous'`,
   `previous_until = now + 24 hours`, `next_secret_sealed = NULL`, `patch_started_at = NULL`,
   `rotation_mode = NULL` and `state = 'active'`. For an `emergency` rotation it leaves both
   `previous` columns NULL instead (the old secrets stop verifying at once) and sets
   `catchup_due_at`, because deliveries signed with the dropped secrets were refused. Nothing is
   written until both reseals exist. If an `open` or `seal` throws, the compare-and-swap changes no
   row (a KEK sweep or another promoter changed the ciphertext), or the Worker dies in between, the
   row is exactly as before: still `rotating`, S1 under `current` and S2 under `next`, both
   readable and both accepted. Promotion is idempotent, is retried by the next verified `next`
   delivery or by reconciliation, and a lost compare-and-swap re-reads and retries a bounded number
   of times;
4. accept `previous` only until `previous_until`; the sweep or the next verification NULLs both
   `previous` columns with a compare-and-swap on expiry. A verified `next` delivery or ping is audit
   evidence of success, not a reason to erase `previous` early (the explicit `expire-previous`
   action below is);
5. **unknown outcome** (the PATCH timed out, or the Worker died after `patch_started_at`): roll
   forward only, on positive proof. A delivery or ping that verifies under `next` proves GitHub
   holds S2, so promote. A verification under `current` proves nothing (delayed or redelivered
   S1-signed deliveries verify too, and the PATCH may still land), so repeat the same idempotent
   PATCH with S2 until it returns 2xx and then promote. There is no cancel: abandoning a rotation
   would mean PATCHing S1 back, which a still-in-flight PATCH of S2 could overtake, leaving GitHub
   on a secret the row no longer accepts. To return to a known value, rotate again to a fresh
   secret. `next` is never discarded while the row is `rotating`.

**Converge-to-row rule.** Every secret-writing PATCH (rotation, post-restore, divergence repair)
sends the row’s target secret (`next` while `rotating`, otherwise `current`), re-reads the row after
the 2xx and repeats with the new target if it changed, and never starts a rotation of its own. A
stale writer therefore cannot leave GitHub on a secret the row no longer targets, and any
divergence that still arises is caught by the delivery-log check in §6.4.

**Containment actions that exist in every build** (each audited and behind step-up):
`expire-previous` (a compare-and-swap NULLs both `previous` columns and sets `catchup_due_at`,
ending a suspected leak’s grace window early); an _emergency_ rotation (the mode is persisted by
the start compare-and-swap, so every promoter drops `previous`); and `repair`, which re-creates a
missing hook or restores drifted configuration with the row’s target secret and the same URL.
`repair` replaces the stored hook id with a conditional update on `product`, `hook_ref`, the old id
and `LINK_BOUND`, and sets `catchup_due_at`; authority never moves. Only the retire/rollback action
is absent from the contract-state build.

Every create/rotate/repair/retire/reconcile action produces a security/audit event without URL
secret, plaintext or ciphertext. A delivery that verifies and is then refused (repository or hook
id mismatch) is recorded as a debounced `webhook.refused` platform security event against the
product (one per product and reason per hour). Refusals before the HMAC (unknown ref, stale link,
bad signature) deliberately have no per-product counter, because the ref may be unknown or the
caller unauthenticated. Silent loss of sync is detected by reconciliation, which reads the hook’s
configuration and its recent failed deliveries from GitHub’s own delivery log (§6.4), not by
receiver counters.

### 6.8 Tests

1. Link A’s secret never validates link B’s path, repository id, or product, including
   same-monorepo products; body claims are namespaced per link.
2. Rotation: a promotion that moves ciphertext between slots without re-sealing fails to open (the
   negative case), while the real promotion opens under the source AAD and reseals under the
   destination AAD. Fault injection at every step (the second `seal` throws, the compare-and-swap
   loses to a KEK sweep, the Worker dies after the PATCH, the PATCH response is lost, a delayed
   PATCH of S2 lands after the promotion) leaves both secrets readable and accepted and never a
   `current` that cannot open. Promotion by the rotate action, by the receiver on a `next` match and
   by reconciliation all honour the persisted `rotation_mode`: an emergency rotation leaves
   `previous` NULL and sets `catchup_due_at`. Current/next/previous order, expiry, refusal of a
   second rotation while `previous` is live, `expire-previous`, and ping activation all have
   deterministic clock tests, and no path discards `next` while the row is `rotating`.
3. Inventory and schema: the migration is idempotent and yields one `legacy` row per linked product
   with every hook and secret column NULL; the CHECKs accept the row every legal transition
   produces (including a promotion that sets `previous_*` and a rotation that sets
   `patch_started_at` and `rotation_mode`) and reject a `legacy` row that carries secret material
   and a non-`legacy` row that lacks it; the writer reach test fails on any `release_config` link or
   `release_source` write outside the retarget builder; reconciliation finds and repairs `missing`
   and `stale` rows and queues orphan hooks (a callback URL of this platform that no row and no
   cleanup entry owns) for cleanup; a missing row is `legacy` to the
   global route; the system product (NULL installation id) is inventoried and compared NULL-safely;
   the report is complete only when `linked = rows`.
4. Current-link binding and the retarget builder: after a relink, an unlink, a soft delete, an
   installation change or a rename, a validly signed delivery for the _old_ hook gets the generic
   answer and causes no KV, DO or D1 write (asserted through instrumented stores); the retire batch
   is atomic with the link write (a failure applies neither), destroys the sealed secrets, and
   queues the hook for cleanup; `linkExisting`’s rollback (its previous state is never linked)
   deletes the row; deploying the system product twice with a stored installation id retires
   nothing.
5. Cross-ingress idempotency: one event delivered to both routes causes exactly one resync
   (instrumented `resyncRepo`), including with the ping’s `pending → active` flip landing while the
   first delivery is in flight (gated fetch) and with a rollback flip in the other direction;
   concurrent identical deliveries produce exactly one claim owner; a superseded route acknowledges
   without claiming; a failed owner’s claim is given back and the redelivery works; an expired
   lease is taken over and the slow original owner can neither finish nor delete the new owner’s
   row (claim nonce); two products on one monorepo claim independently; a ping in `pending`
   activates although the ledger authority is false, and two byte-identical pings inside 24 hours
   are both processed.
6. Durable catch-up: the flip, the retire, `repair`, an emergency promotion and `expire-previous`
   set `catchup_due_at`; a kill after the flip, a missing execution context and a cut-off
   post-response task all leave it set, and reconciliation (nightly and on demand, a bounded number
   of rows per pass) reruns the sync; only a sync that started at or after the marker and ran to an
   answer clears it (an in-flight resync that started before the flip does not, and a transient
   failure keeps it).
7. Provisioning: a denied permission leaves the row `legacy` with `last_error`; a definitive POST
   refusal aborts `pending → legacy` and queues a URL-keyed cleanup entry that removes itself when
   nothing is found; a crash between the `legacy → pending` write and the POST (and an unknown POST
   outcome) leaves a `pending` row that reconciliation resumes, but only once it is older than the
   creation timeout plus a margin (a live provisioner is not raced), by listing the hook by URL and
   POSTing only if none exists; a creation ping arriving before the hook id is stored activates the
   row and is not treated as a changed link; a link changed in flight queues the new hook for
   cleanup.
8. Unknown ref/header and bad signature have the same response shape; the ref’s shape is validated
   before any store access, and a flood of unknown refs and of known-ref/bad-signature requests
   performs no writes and bounded reads (an R10-style test); malformed/oversized body is capped
   before JSON parsing; no secret, plaintext or ciphertext reaches logs, responses, audit rows or
   any API (the `R12-secrets` check covers the hook lifecycle), and no code path returns a
   decrypted hook secret. The host-isolation and CORS suites (`bytesHost`, `imgHost`,
   `registryHost`, `cors`) pin the new `/webhooks/github/<hook_ref>` prefix route as they pin the
   global path.
9. Global route processes only legacy/pending links and cannot resync active links; active hook
   processes only its product; default-head pinning and existing replay semantics remain covered;
   in C1 mode a validly signed global delivery performs no resync, claim or store write.
10. Hook API requests are repo-scoped, read-level for reconciliation, drift reads and pings and
    write-level only for provision, rotate, repair and retire, never cache write-capable tokens,
    and handle unaccepted permission/403/422 without falsely activating a link.
11. Rollback and repair: the per-link rollback is refused unless a global ingress is verified live
    (§6.6: the secret is configured, `GET /app` lists `push` and `release`,
    `GET /app/hook/config` names this platform’s URL, and a 2xx App delivery is under a day old),
    with stubbed cases for an inactive webhook, a wrong URL and a stale secret; post-restore
    reconciliation converges every hook to the row’s target secret with a confirmed PATCH and
    confirms with the ping delivery’s `status_code` read from GitHub’s delivery log; reconciliation
    treats a recent 4xx from this platform on a non-ping delivery in that log as divergence and
    converges the hook; `repair` of a deleted hook replaces `gh_hook_id` (the row stays `active`,
    deliveries from the new hook are accepted, `catchup_due_at` is set); the contract-state build
    contains no retire/rollback action but keeps `repair`, `expire-previous` and rotation, and
    after C2 linking a product runs provisioning after its link batch commits (a failure leaves the
    row `legacy` with `last_error`, no automatic sync, and the manual Resync working). The global
    restore itself is the human rehearsal in §9.
12. Migration, vault AAD, reseal sweep/count over all three slots (NULL slots skipped), product
    deletion, reach ownership, hook reconciliation, OpenAPI/routeCoverage, boundaries, and
    worker-workerd tests are covered.
13. A real GitHub sandbox integration test proves actual hook headers/payload fields, create/ping,
    the GUID shared between the App and hook deliveries, rotate, delete, and an App-permission
    upgrade on a non-production installation.

## 7. Rollout and rollback

1. **Human setup first:** approve repository Webhooks read/write on the App, have every existing
   installation owner accept the permission change, and provide a sandbox repo/install for the
   payload/header spike (§6.3), including the delivery-GUID check the idempotency key depends on.
   The spike’s findings return to the owner before implementation starts, and a result that
   contradicts an assumption (decision 5) returns the plan for review.
2. **Expand:** deploy the migration first (the three tables and the idempotent `legacy` backfill,
   §6.4), then the receiver, state, fence, reconciliation and report code, with every link still
   `legacy`. Existing global webhook behavior remains intact. Provision nothing until the first
   report is complete (`missing = 0`, `stale = 0`, `linked = rows`).
3. **Migrate incrementally:** provision one link, require the verified ping to flip it `active`
   (its catch-up sync runs), and observe the ledger (`done` and live `claimed` rows),
   `last_delivery_at`, `webhook.refused` and audit events before proceeding. A denied permission
   remains `legacy` with `last_error`; it is visible and cannot pretend migration succeeded. Re-run
   the report after every batch of links and after any relink or product deletion.
4. **Rotate rehearsal:** on sandbox, rotate a per-link secret and prove both in-flight old and new
   signatures work inside the grace window, including a lost PATCH response, a failed promotion and
   an emergency rotation (§6.7).
5. **Contract:** only after §6.6’s gate and explicit owner approval, in two steps: C1 (disable App
   Push/Release; the global route answers `retired`), then C2 (remove the global secret and the
   receiver code) in a later deployment.

Rollback before contract is per link: the audited rollback turns one `active` link `legacy` (the
retire transition and a catch-up sync, §6.5) while a global ingress is verified live (§6.6), so the
App-level webhook is again its verified path. The link’s sealed secrets are destroyed by that write
and the old hook is deleted through the cleanup queue (retried, then reported if abandoned). After
C1, undo is re-enabling the App subscriptions and redeploying the previous build (or
`wrangler rollback`: the secret is unchanged). After C2, it is the global-restore procedure in
§6.6: a **fresh** secret on both the Worker and the App registration, proven by a real delivery
before any link flips. That is intentionally not a casual code rollback, and it is rehearsed before
the contract is approved. A D1 restore or `wrangler rollback` is never used to undo a per-link
rotation: reconcile instead (converge every hook to the row’s target secret with a confirmed PATCH,
§6.7, then confirm with a ping).

## 8. Risks and decisions for the human

1. **Approve `repository_hooks: write` for the GitHub App?**
   - **Recommend yes only before external-tenant onboarding**, after sandbox proof. It enables true
     per-link secrets and no human-visible secret in automatic provisioning.
   - Cost: a compromised App private key gains permission to create/modify/delete repo hooks across
     installations, widening that credential’s blast radius. Existing installation owners must
     accept the permission upgrade.
2. **Manual owner setup and displaying a hook secret?**
   - **Recommend App-managed provisioning only; the manual fallback that displayed a hook secret is
     removed from this plan.** Provisioning never returns plaintext, so there is no reveal control
     to build or to get wrong.
   - Cost: an installation owner who declines the permission leaves that link on the shared global
     route (today’s exposure) and holds the contract open (decision 6). Manual-only setup would
     avoid the new permission but makes provisioning/rotation error-prone and hard to audit.
   - If the human wants a manual path anyway, it is a separate reviewed addition that must at least
     require a privileged role with fresh step-up, a single retrieval bound to the provisioning
     operation, no logging/storage/client caching of the response, and an audit event that records
     the reveal without secret material.
3. **Timing:** implement now or gate on first third-party tenant?
   - **Recommend gate before the first third-party repository is linked.** The current global-secret
     residual is primarily cross-tenant resync/API amplification because content is default-head
     pinned; it is still the wrong foundation for third-party tenant isolation.
4. **Grace period:** approve 24 hours for previous hook-secret verification. **Recommend yes.** It
   covers delayed deliveries/manual redelivery without leaving an old secret indefinite.
5. **Sandbox facts required:** confirm repository-hook payload/header shape, whether an installation
   object is present, whether `X-GitHub-Delivery` is the same on the App-level and the
   repository-hook delivery of one event and on redelivery, GitHub behavior for redelivery after
   secret rotation, the `ping` that hook creation and `POST …/pings` send, the exact
   `PATCH …/hooks/{id}/config` request that rotates a secret, whether `PATCH /app/hook/config`
   works with the App JWT, any per-repository hook limit for a monorepo with many products, and the
   installation permission-upgrade UX. The plan fails closed rather than assuming these details. If
   the delivery GUID is not shared, the plan returns for review: a payload-derived key (event +
   `repository.id` + `ref`/`before`/`after`) cannot tell a repeated push of the same commit pair
   from a duplicate, so it is not substituted silently.
6. **Legacy retirement:** approve disabling App Push/Release only after the §6.4 report is complete
   and every link is `active`, system product included. The system product needs the App installed
   on the platform repository; otherwise the contract stays closed until the owner approves a
   separate plan for another trigger of its release truth (for example the deploy hook). A link
   whose installation owner will not accept the permission also holds the contract open: decide per
   link to offboard it, keep it on the global route, or approve an alternate polling/resync path. A
   date-based forced cutoff is not recommended without that path.
7. **Recovery material for the global secret at contract:**
   - **Recommend a replacement-secret restore (§6.6):** destroy the old value at C2 and, in an
     incident, generate a new one and set it on both the Worker and the App registration. It leaves
     no standing platform-wide credential and never depends on GitHub’s stored secret equalling
     anything the Worker still holds.
   - Alternative: escrow the old secret off-platform (as the RUNBOOK already does for the KEK) for a
     same-value restore. Cost: a standing credential that can forge deliveries for every legacy
     tenant, plus having to prove nobody changed GitHub’s side meanwhile. Not recommended; if
     chosen, the rehearsal still verifies a real delivery before any link flips.
   - The soak before C1/C2 (recommend 14 days after the last activation, including one real
     rotation) is also the owner’s call.

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
mise exec node@22 -- pnpm --filter @polaris-key/worker test tableCrossings
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm format
```

Plus a human-run sandbox GitHub App/repository-hook rehearsal covering creation, signed ping,
push/release delivered through both the App route and the hook with one shared delivery GUID,
rotation (including a lost PATCH response, a failed promotion and an emergency rotation),
deletion, repair of a deleted hook, relink of a hooked product, permission denial, per-link
rollback, and the global restore from a contract-state deployment (§6.6). No implementation is
accepted until its real delivery payload proves the binding assumptions above.

---

## Appendix A — remove the unscoped installation-token fallback

`services/release/githubApp.ts:249-335` still accepts `InstallationTokenScope | string`. Only the
legacy string form appends a third token-mint attempt with no `repositories` field
(`:302-307`), yielding an installation-wide read token if GitHub rejects narrowing. All current
production callers use structured `{ owner, repo }` scopes (`assetSource`, `gateway`, `health`,
`linkExisting`, `linkRepo`, and `resync`); bare strings remain in tests only.

The proposed small cutover is:

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

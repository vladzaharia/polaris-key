# Security plan: versioned credential peppers, dual-read, and safe retirement

| Field          | Value                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief          | None yet. This is an unowned security finding; approval creates the implementation work package(s).                                                                                                                                   |
| Status         | Approved 2026-10-16 (lead, delegated); implement after SEC-adminsession                                                                                                                                                               |
| Basis          | `main` at `d27467ef8`; `packages/worker/src/platform/crypto.ts:117-120`, `core/configGuard.ts:17-30`, `docs/DEPLOYMENT.md:39-46`, and `docs/security/arch/operational-resilience.md` §1.4.                                            |
| Wire change    | **None.** Credential text (`pkey_`, `pkeyt_`, `pkeyci_`, `pkeyr_`) remains byte-for-byte unchanged. No device route, signed document, claim, SDK API, `PROTOCOL_VERSION`, `corpusVersion`, `shared-protocol`, or `shared-jws` change. |
| Corpus / SDKs  | None. The Worker changes its at-rest lookup implementation only. Existing SDKs continue sending the same opaque credentials.                                                                                                          |
| Migration lane | D1. Every file uses an `00XX_` placeholder name; the lead numbers it during rebase. One `ALTER TABLE` per file, plus one fence migration (§7.1). Down scripts under `scripts/rollback/` abort once the fence closes.                  |
| Rotation fence | A deployment and data fence precedes any rotation (§7.1); a compromised pepper follows §7.3, not lazy rehash; Appendix A withdraws the optional `product_keys` rebuild.                                                               |

## Decisions (lead, 2026-10-16)

Delegated by the owner; rulings on §8 as numbered there.

1. **Pepper at first credential:** treat as unknown; add the verify-only `unkeyed` candidate until a known-credential probe proves otherwise.
2. **Credential ring** (`KEY_HASH_PEPPERS` + `KEY_HASH_PEPPER_ACTIVE`, scalar retained): yes.
3. **Stable derivation secret** for `mbr_` and durable asset ids: yes.
4. **Retirement:** retain the old pepper until the straggler report is zero; no time-based retirement.
5. **Per-product HKDF:** deferred.
6. **Fail closed** outside an explicit test environment: yes.
7. **Rotation fence (§7.1):** yes, but only once a deployable non-production environment exists; until then ship only the compat deploy (§7.2 steps 1 and 3).
8. **Compromise policy §7.3:** yes.
9. **Replacement capacity:** decided later from the licence census.
10. **A-1 native CHECK on `product_keys.status`:** no. The triggers in `migrations/0015_data_integrity.sql` already enforce it.

Amendments: the `pkeya_` admin API token family (`admin_api_tokens.token_hash`, migration 0119) joins the §5, §6.2, §6.5 and §7.3 inventories (stamp column `00XX_g`, fence trigger in `00XX_f`, revoke by token id). Ordering with SEC-adminsession on `core/console/sessionRevocation.ts` is in §6.3. Drifted cites re-anchored to `main@23534d886`: `platform/crypto.ts:117-120`; `docs/RUNBOOK.md` rollback `:579-583`, KEK compromise `:587-598`, keyring steps `:448-463`, `:517-521`, `:676-693`; `docs/DEPLOYMENT.md` placeholders `:997-999`, `:1311-1313`.

Owner preconditions (also in the owner-steps checklist):

1. Answer whether `KEY_HASH_PEPPER` was set before the first production credential (decision 1).
2. Provision a deployable non-production environment (staging/dev still carry `REPLACE_ME_*`), or name a disposable one.
3. Name the incident lead and the approver of A1 to A5 before the first production rotation.
4. Count licences for the replacement-capacity decision (decision 9).

## 1. Summary and scope

`hashKey(value, pepper?)` currently returns unkeyed SHA-256 when its optional pepper is absent and
HMAC-SHA-256 when present (`platform/crypto.ts:117-120`). Both outputs are indistinguishable
64-character hex strings. `configGuard` now fails closed for a missing/short pepper only when
`PKEY_ENVIRONMENT` is `prod`, `staging`, or `dev`; changing the secret nevertheless invalidates
every persisted hash at once.

The immediate goals are:

1. turn the scalar pepper into an active/verify-only **pepper ring** with immutable ids;
2. remove the implicit SHA-256 fallback—unkeyed lookup is explicit, temporary, and never used for
   a new write;
3. dual-read candidate hashes, rehash a successful old match to the active id, and report the
   remaining old population before retirement;
4. preserve behavior for licence keys, device tokens, CI tokens, registry tokens, and TTL-bound
   security artefacts while the old pepper remains accepted;
5. keep stable derived identifiers separate from a rotating credential pepper;
6. fence every rotation so a scalar-only Worker revision can never read, write, or be rolled back
   across rehashed rows (§7.1); and
7. define the response to a compromised pepper, which rehash-on-use cannot deliver on its own
   (§7.3).

This is not a per-product-pepper/HKDF plan, a new token-format plan, or a bulk credential reissue
tool. In a planned rotation the old pepper remains verify-only until the operator has an
evidence-backed retirement decision; an exposed pepper follows §7.3 instead.

Below, **S0** is any scalar-only Worker revision (`hashKey(value, env.KEY_HASH_PEPPER)`, as on
`main@d27467ef8`) and **R1** is the first ring-aware revision this plan ships; §7.1 defines the
fence between them.

**Rehash-on-use is a migration mechanism, never a remediation.** It re-keys a row only when its
holder presents the plaintext, so it cannot reach a dormant credential, and it would carry a forged
row forward under the new pepper. No step in this plan treats a completed rehash as proof that an
exposed pepper is harmless.

## 2. Contract and hard rules

No frozen wire contract changes. A user still types `pkey_<product>_<22 base64url chars>`; CI,
registry, browser, and device token prefixes remain unchanged. A stored hash, pepper id, or
rotation state is never returned in a device response, signed document, discovery document, or
SDK API.

- **Hard rule 1:** no corpus or generated corpus/mirror edits.
- **Hard rule 2:** `PROTOCOL_VERSION` stays 4; all device wire and corpus counters stay unchanged.
- **Hard rule 5:** no product-specific conditional. Ring lookup is a platform primitive; a
  product is an input only where a table is already product-scoped.
- **Hard rule 6:** crypto/ring parsing stays in `platform/`; persistence-specific dual-read code
  stays in its owning core/service store, never in a console handler.
- **Fence placement (rule 6):** the D1 fence read and the close operation live in Core beside the
  request guard. `platform/` parses the ring and is handed the answer; it never reads storage.
  Every entrypoint that can hash (`fetch`, `scheduled`, `queue`) runs the same guard.
- **Hard rule 9:** no manifest/catalog validation change.
- Generated platform inventory, settings/reference docs, migrations reference, and any new
  `TABLE_OWNERS` rows are regenerated by their owners; generated files are never hand-edited.

## 3. Catalog and manifests

None. Pepper material is deployment secret configuration, never a product manifest field or
console-editable setting. The console may display only ids, row counts, state, and warnings—never
a secret value.

## 4. Corpus, transcripts, and mirrors

None. Hash values are server-at-rest implementation details. Existing HTTP transcripts remain
byte-identical; an unexpected transcript change is a regression.

## 5. SDKs

None. Every client continues presenting the same opaque values:

| Family          | External spelling | At-rest consequence                                                                                                                |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| licence key     | `pkey_`           | `keys_index` lookup dual-reads and lazily rehashes on presentation                                                                 |
| device token    | `pkeyt_`          | device token D1/KV lookup dual-reads; active devices converge on use                                                               |
| CI token        | `pkeyci_`         | token lookup dual-reads; finite expiry bounds the tail                                                                             |
| registry token  | `pkeyr_`          | token lookup dual-reads; finite expiry bounds the tail                                                                             |
| admin API token | `pkeya_`          | `admin_api_tokens.token_hash` lookup (`console/apiTokens.ts:256-258`) dual-reads; `expires_at` is NOT NULL, so the tail is bounded |

No SDK release is required. Server errors remain existing unauthorized/misconfigured behavior;
the implementation must never expose “old pepper matched” to a caller.

## 6. Worker design

### 6.1 Configuration and ring primitive

Mirror the validated `PLATFORM_KEK_KEYS` / `PLATFORM_KEK_ACTIVE` model in
`platform/keyvault.ts:135-301`:

```text
legacy no-op shape:
  KEY_HASH_PEPPER=<existing secret>
  KEY_HASH_PEPPER_ID=default                 # optional; default "default"

ring shape:
  KEY_HASH_PEPPERS={"p1":"<secret>","p2":"<secret>"}
  KEY_HASH_PEPPER_ACTIVE=p2
  KEY_HASH_PEPPER=<old secret>                # mandatory until its id is disabled or retired
  KEY_HASH_PEPPER_STATES={"default":"disabled"}   # optional; §7.3 only
```

Rules:

- Parse strictly: a non-empty JSON object of non-empty ids and secrets; active must name an object
  member; ids are display-safe ASCII tokens; secret values meet the existing 32-character minimum.
- With both shapes configured, `KEY_HASH_PEPPER` joins as a verify-only legacy id. It can never be
  selected for new hashes unless it is also the active ring member with byte-identical material.
- **Compat mode (fence open, §7.1).** Until the D1 fence record exists the ring is single-id:
  `KEY_HASH_PEPPER` is **mandatory** (≥ 32 characters) and is the active id. A ring or
  `KEY_HASH_PEPPER_ACTIVE` naming another id, a missing scalar, any `KEY_HASH_PEPPER_STATES` entry,
  or a scalar whose material differs from a ring member of the same id fails closed with
  `server_misconfigured` (name only). Extra ring members may be pre-loaded as verify-only
  candidates, but compat mode writes only `HMAC(scalar)` hashes and makes no rehash, so a
  scalar-only revision and a ring-aware revision write byte-identical rows.
- **Member states.** `KEY_HASH_PEPPER_STATES` is strict JSON mapping an id to `quarantined` or
  `disabled`; an id it does not name is verify-only (or active, when `KEY_HASH_PEPPER_ACTIVE` names
  it). A _quarantined_ id still verifies, is never rehashed forward, and every match emits a
  security event. A _disabled_ id never verifies a credential or session; it stays a deny-only
  candidate for security state (revocation, lockout and replay markers) until their maximum TTL has
  drained (§6.3), so its secret is deleted only after that, and its name stays so the report counts
  its rows as `disabled` rather than `unopenable`. The active id can be neither. These states are
  how §7.3 keeps rehash-on-use from laundering a possibly forged row and renders an exposed pepper
  unusable before its secret is deleted.
- Cache imported HMAC keys per isolate by the literal ring fingerprint. This avoids importing every
  HMAC key on every device/admin request.
- Add one explicit, **verify-only** `unkeyed` candidate only when a human confirms pre-guard rows
  may be plain SHA-256. It is not an environment fallback, cannot be active, and is reported as a
  high-severity retirement blocker.
- `hashKey` loses its optional pepper argument. New-write callers obtain the active digest through
  the ring; candidate-reading callers use `hashCandidates(value)`. A missing/malformed ring throws
  before any hash is stored or accepted.
- `configGuard`, deploy preflight, Env typing, platform inventory, deployment/runbook docs, and
  test env factories all require the ring/legacy no-op shape. An unrecognised/empty deployed
  environment must not silently make an unkeyed write possible. The preflight
  (`scripts/check-config.mjs:12-17`) keeps requiring `KEY_HASH_PEPPER` until the scalar's id is
  disabled or retired.

### 6.2 Persistent credential migration

Use a nullable `hash_pepper_id` column. It makes progress queryable without changing the 64-hex
hash format or breaking existing admin URLs that currently name a hash.

| Placeholder migration                               | Table/family                                                               | Meaning of existing `NULL`                             | New write |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | --------- |
| `00XX_a_keys_index_hash_pepper_id.sql`              | licence keys (`pkey_`)                                                     | historical/unknown; resolve by candidates at first use | active id |
| `00XX_b_devices_token_hash_pepper_id.sql`           | device tokens (`pkeyt_`)                                                   | historical/unknown                                     | active id |
| `00XX_c_ci_tokens_hash_pepper_id.sql`               | CI tokens (`pkeyci_`)                                                      | historical/unknown                                     | active id |
| `00XX_d_registry_tokens_hash_pepper_id.sql`         | registry tokens (`pkeyr_`)                                                 | historical/unknown                                     | active id |
| `00XX_e_release_download_tokens_hash_pepper_id.sql` | portal download tokens                                                     | historical/unknown                                     | active id |
| `00XX_g_admin_api_tokens_hash_pepper_id.sql`        | admin API tokens (`pkeya_`, `admin_api_tokens.token_hash`, migration 0119) | historical/unknown                                     | active id |
| `00XX_f_credential_pepper_fence.sql`                | fence for the tables above, `00XX_g` included                              | n/a                                                    | n/a       |

`00XX_g` adds the `hash_pepper_id` stamp column to `admin_api_tokens`; `00XX_f` carries its fence insert trigger like every other row of this table (the letters are placeholders, the lead numbers them; `_f` still closes the set).

The implementer inventories every remaining D1 hash column before the migration lands. If a table
is not a credential lookup (for example an audit/derived identifier), it must not receive a
credential-ring column merely for uniformity. Every table that does gains its fence trigger in
`00XX_f`, so the inventory also fixes the fence's coverage. Every migration is expand-only, has a
down script under `scripts/rollback/` (the `0105_licensing.down.sql` convention) that stops being
valid when the fence closes (§7.1), and updates table ownership/reference generation if it adds an
owned column.

Lookup algorithm for a persistent credential:

1. compute active `(kid, digest)` plus every verify-only candidate digest, in priority order;
2. query the existing indexed hash predicate with the candidate set; never broaden by product-less
   scan where the existing store is product-scoped;
3. if the returned row has a known `hash_pepper_id`, require it to agree with the matched candidate;
   `NULL` is the explicit legacy/unknown state. A disagreement means something wrote the row outside
   this contract: deny, emit a security event, and block retirement of both ids until it is
   explained;
4. if the fence record exists (§7.1) and the matched id is neither quarantined nor disabled, bring
   the row to the active id with the compare-and-set below: a rehash when the matched id is not
   active, a stamp-only write when it is active but the stamp is `NULL`. A lost race changing zero
   rows is success, not a denial;
5. write all fresh rows under active id only.

The rehash write is best-effort only after successful authentication/authorization. It must never
turn a valid credential into a 500 or weaken revocation. For a table whose hash is also a route
identifier, the console must first cut over to an immutable row id or reload the current row after
mutation; it must not claim a stale hash URL still names the same record.

**Write discipline (no scan-then-overwrite).** Every statement that writes a hash column or
`hash_pepper_id` is either an INSERT stamped with the active id or a compare-and-set keyed on the
row's current value. Nothing rewrites a hash from a row snapshot read earlier.

- Rehash: `UPDATE <table> SET <hash> = :new, hash_pepper_id = :active WHERE <existing key> AND
<hash> = :old AND hash_pepper_id IS :oldStamp`. It writes no other column: `status`,
  `expires_at`, `revoked_at`, `used_at`, `last_used_at`, `last_seen`, `seat_no`, labels, scopes and
  every other metadata column are untouched, so a revoked or expired row stays revoked or expired.
- Models already in the repository: `rotateDeviceToken`'s compare-and-set
  (`core/devices.ts:864-875`) and `touchDeviceMetadata`'s narrow guarded UPDATE, which replaced a
  stale-snapshot upsert that had resurrected a deauthorized device (`core/devices.ts:922-941`).
  `upsertDevice` (`core/repo.ts:1596-1636`) is the one full-row writer of `token_hash`. It writes a
  freshly minted hash and MUST stamp `hash_pepper_id` in both its INSERT and its `DO UPDATE SET`;
  no new full-row upsert of a hash column may be added.
- A revoke addressed by hash, or one that reads a hash and writes by it later, must not lose to a
  rehash silently. `setKeyStatus` ignores the changed-row count (`core/repo.ts:1217-1229`) and its
  caller answers `ok: true` regardless (`services/license/admin/keys.ts:86-102`); `revokeCiToken`
  reads the token's hash by `token_id`, writes by that hash in a later batch, and answers `true`
  whatever the batch changed (`core/publisher.ts:914-938`). Each writes by stable identity or
  checks the changed-row count and answers 404/409 on zero rows. The ticket cap can re-resolve the
  current hash inside its own statement, as `console/systemProduct.ts:435-439` already does. Bulk
  revocation (§7.3) addresses rows by stable identity (`license_id`, `token_id`, product), never by
  hash value, as product deletion already does (`core/console/repo.ts:164-171,200-202`).
- A hash copied into a dependent table moves in the same atomic batch as its parent, or the parent
  is not rehashed while dependents exist. `ci_upload_tickets.token_hash` mirrors
  `ci_tokens.token_hash`, and revocation caps unredeemed tickets by that value
  (`core/publisher.ts:931-935`). CI and registry tokens expire within 90 and 365 days
  (`core/publisher.ts:89-90`, `migrations/0067_registry_tokens.sql:16`), so the implementer may
  leave them un-rehashed to age out; the choice is recorded per family in the inventory.

### 6.3 KV, DO, and short-lived records

D1 is not the entire surface. A hash can also be embedded in a KV key or a single-use artefact id.
Classify each call site before implementation:

| Class                        | Examples                                                          | Rotation behavior                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Long-lived credential lookup | device-token KV cache, licence/device/CI/registry rows            | active-first dual-read; copy/update on use; retain old id until retirement gate passes                               |
| Security state               | `admin-revoked`, token/session revocation, replay/lockout markers | dual-read every accepted id through its maximum TTL; do not let a rotation resurrect a revoked session or replay     |
| Short-lived flow             | OIDC/admin/portal flows, magic/email/device codes                 | active writes; dual-read only through the documented maximum TTL, then let old entries expire/restart                |
| Stable derived identifier    | `mbr_` audit actor, avatar asset id/R2 key, any durable id        | **not** governed by rotating credential pepper; move/pin under a separate stable derivation secret before a rotation |
| Ephemeral derived salt       | daily storefront dedupe salt                                      | active version may apply at next natural period boundary; document reset effect                                      |

`admin-revoked` is critical: it currently names its artefact with `hashKey(sub,
KEY_HASH_PEPPER)` (`core/console/sessionRevocation.ts:24-53`). During a rotation it must read all
accepted candidates until its one-hour TTL drains; otherwise changing peppers can accidentally
make a logged-out cookie valid again.

**Cross-plan ordering.** SEC-adminsession lands first and changes this same file (`core/console/sessionRevocation.ts`: the targeted-revoke route and keep-max mark). The ring change here is then made on top of it, and the reader checks every accepted candidate for both the logout mark and the targeted-revoke mark.

### 6.4 Stable derivations are a prerequisite, not a hidden exception

A rotating credential key must not silently rotate durable identities. Before the first real
pepper rotation, extract direct `KEY_HASH_PEPPER` derivations that are not credential lookups:

- console `mbr_` member ids used in audit and rate-limit identity;
- content-addressed avatar ids and their persisted asset/R2 references;
- any ledger/idempotency keys whose equality survives beyond a short TTL.

Use a separately named, non-rotating derivation secret/keyring (or an explicitly pinned legacy
kid with an approved migration) and document its rotation policy. Audit history must continue to
identify one operator as one member across a credential-pepper rotation. This work is sequenced
before retiring a credential pepper; it is not permission to leave unreviewed direct uses behind.

### 6.5 Family-specific retirement policy

| Family                    | Tail                                          | Retirement rule                                                                                                                             |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkey_` licence keys      | potentially years; plaintext shown once       | retain old verify-only pepper until report is zero, or make an explicit owner-approved reissue/stranding decision; never silently retire it |
| `pkeyt_` device tokens    | active devices converge; dormant/offline tail | retain through the documented dormancy/offline window plus a report of remaining rows                                                       |
| `pkeyci_` CI tokens       | bounded by token expiry                       | retain through maximum static-token lifetime plus grace; report zero active old-id rows                                                     |
| `pkeyr_` registry tokens  | bounded by maximum expiry                     | retain through maximum token lifetime plus grace; report zero active old-id rows                                                            |
| `pkeya_` admin API tokens | bounded by `expires_at` (NOT NULL)            | retain through maximum token lifetime plus grace; report zero live old-id rows                                                              |
| flows/codes               | minutes/hours                                 | keep candidate only through maximum TTL; then remove it                                                                                     |

**Dormant rows.** Rehash-on-use cannot reach a credential nobody presents, so in a planned
rotation the old id stays verify-only for those rows (the table above). The only existing bound on
a dormant device token is `releaseDormantSeats`, which nulls `token_hash` after
`SEAT_DORMANCY_SECONDS` (90 days) for seat-holding rows only (`core/repo.ts:1324,1398-1417`); it is
not a general bound. An exposed pepper gets no such grace (§7.3).

The admin/deployment report displays counts grouped by table and pepper id, `NULL` legacy rows,
last old-id match, and blockers. A row is _required_ while its credential is live (the predicates
are in §7.3); a row whose hash column is `NULL` holds no credential and is excluded. A row stamped
with an id missing from the ring is reported as `unopenable`, as the KEK report does
(`console/handlers/products.ts:854-862`), and a row of a `disabled` id as `disabled`. A retirement
operation refuses while any required row remains; an explicit break-glass override requires
step-up, an audit event, a human-approved customer impact plan, and updates the threat
model/runbook.

### 6.6 Tests

1. Ring parser tests: legacy no-op, ring, mixed ring/legacy verify-only member, malformed JSON,
   empty ids, missing active id, duplicate kid/material conflict, short secrets, and unkeyed never
   active.
2. `hashKey` tests: missing ring throws; no code path silently obtains plain SHA-256; fixed test
   env always supplies a known pepper.
3. Per-family dual-read tests for `pkey_`, `pkeyt_`, `pkeyci_`, and `pkeyr_`: active match, old
   match, legacy `NULL`, conditional rehash, race, revoke/delete/list, and old id rejection after
   approved retirement.
4. KV/DO tests: old/new key fallback obeys TTL; rotation never makes `admin-revoked`, lockout, or
   replay state disappear early.
5. Privacy/identity tests: `mbr_` audit identity and existing avatar references remain stable
   across a credential-ring activation.
6. Migration tests assert every `hash_pepper_id` column, existing-row `NULL` behavior, indexes used
   by candidate lookups, and no unscoped product read.
7. Regression test/sweep report uses a real test DB and reports counts by kid; it cannot declare a
   pepper retireable merely because no request happened to use an old row recently.
8. Frozen scalar-only fixtures. A fixture module holds, verbatim, S0's hash computation
   (`hashKey(value, KEY_HASH_PEPPER)`, with and without a pepper) and S0's SQL for every
   hash-writing path: `insertKey`, `replaceLicenseKeys`, `upsertDevice`, `rotateDeviceToken`'s
   compare-and-set, the CI/registry/download-token inserts, and the KV/DO artefact addresses.
   Against the post-migration schema: (a) fence open: S0 writes succeed, the ring-aware reader
   finds them, and S0 finds R1's `default` rows; (b) fence closed: every S0-shaped INSERT or upsert
   aborts and leaves the row byte-identical, every S0-shaped compare-and-set changes 0 rows on a
   row hashed under another id, and an S0 read of a rehashed row answers unauthorized and writes
   nothing; (c) S0 with no scalar under a non-deployed `PKEY_ENVIRONMENT` (the unkeyed write)
   aborts once the fence is closed. A static sweep fails when any statement writes a hash column or
   `hash_pepper_id` outside this reviewed list.
9. Fence and compat guard. Compat mode refuses a ring/active id other than the scalar's, a missing
   scalar, a differing scalar, and any `KEY_HASH_PEPPER_STATES`; it makes no rehash. The
   fence-close operation needs a platform admin with step-up, stores the attestation in exactly
   one audit event, refuses unless the required triggers exist, and cannot be reversed through any
   route. A non-`default` active id without the record, or with one that cannot be read, fails
   closed; the fence read runs only for such a config and caches a positive result.
10. Rollback boundary. Flipping the active id back to `default` keeps rows stamped with the new id
    readable; removing a member that still has stamped rows is refused and the rows are reported
    `unopenable`; a row stamped with an id missing from the ring is denied and counted; the down
    scripts for the stamp columns and the fence abort once a fence row exists.
11. Interleavings. Using the repository's patterns (`interleaved(db, before)`,
    `test/descriptor.test.ts:1505-1521`; `test/keyStateMachine.test.ts:163-176`), in both orders:
    rehash against `rotateDeviceToken`, `upsertDevice`, `releaseDormantSeats`, an admin or portal
    revoke, `replaceLicenseKeys`, `revokeCiToken`, and a second rehash (the loser reports success).
    In every case the columns the statement does not name are byte-identical and a revoked row
    stays revoked.
12. Compromise runbook (§7.3). The report counts rows by `(table, id)` including `NULL`,
    `unopenable` and `disabled`; a quarantined id verifies without rewriting the row and emits an
    event; the cutoff sweep revokes by stable predicate in bounded batches and a second run changes
    nothing; revoke-before-disable leaves no row both `active` and unverifiable; a canary minted
    under the exposed id is refused after cutoff and a replacement under the new id is accepted;
    stable derivations are unchanged.

## 7. Rollout, compatibility fence, rollback, and compromise

### 7.1 Compatibility fence (mandatory sequencing)

**S0** is any scalar-only revision: `hashKey(value, env.KEY_HASH_PEPPER)` as of `main@d27467ef8`
(`platform/crypto.ts:118-120`). **R1** is the first ring-aware revision this plan ships. A rotation is
an irreversible data transition: a rehash replaces a hash that only the plaintext can recompute, so
no rollback can restore it.

Why a fence is needed:

- Old revisions stay reachable. A gradual deployment serves two versions at once, and a rollback
  can target any of the 100 most recently published versions; Cloudflare itself warns that a
  rollback can fail when "the structure of data has changed"
  ([gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/),
  [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). CI
  deploys with a plain `wrangler deploy` (`.github/workflows/deploy.yml:201-212`) but applies D1
  migrations first (`:150-157`), so every deploy already runs the previous revision against the new
  schema.
- A rollback restores that version's own bindings, secrets included, so it can also restore a
  pre-rotation ring (`docs/RUNBOOK.md:579-583`).
- S0 cannot find a row rehashed under a new id. With no scalar it refuses every request on a
  deployed label (`core/configGuard.ts:15,46-59`) and, under any other `PKEY_ENVIRONMENT`, writes
  unkeyed SHA-256 (`platform/crypto.ts:118-119`).

The fence has four parts. All four are required before the first write under a non-`default` id.

1. **Compat mode (code).** R1 starts in the compat mode of §6.1: scalar mandatory, active id the
   scalar's, new rows stamped `default`, no rehash. S0 and R1 can then serve together for any
   length of time (a split deployment, a slow drain, a rollback from one to the other) without
   diverging: each reads the other's rows and both write byte-identical hashes. The migrations
   ship first and are inert for S0: the columns are nullable and the triggers of part 3 do
   nothing while the fence record is absent.
2. **Drain evidence (human, attested).** Per environment, recorded in the work package and in the
   close operation's audit event:
   - `wrangler deployments list --env <env>` shows one deployment, one version, 100%, no split;
     that version's `--message` carries the commit the deploy workflow stamps
     (`.github/workflows/deploy.yml:182-187,210-212`), and
     `git merge-base --is-ancestor <R1 commit> <that commit>` succeeds. The request Worker's cron
     and queue handlers are part of the same script, so they run on whichever version the
     deployment lists. The lazy-delta consumer (`wrangler.deltas.toml:28`) does not import the hash
     primitive at its direct imports (`src/deltasEntry.ts:14-24`); the implementer re-verifies its
     import graph;
   - at least 15 minutes have passed since it reached 100%: the `*/15` cron (`wrangler.toml:99`)
     has run on R1 only and in-flight requests have ended;
   - the environment's `KEY_HASH_PEPPER` is the ring's legacy member, and G0 (§7.2) passed;
   - the operator records that S0 builds remain among the 100 rollback targets, and that closing
     the fence turns that exposure from silent divergence into fail-closed writes (part 3).
   - exception: an environment whose first deployment is R1 or later closes its fence at creation,
     with "no earlier revision ever served" as its whole attestation.
3. **Fence record (data).** A single-row `credential_pepper_fence` table (a Core table, so one
   `TABLE_OWNERS` row) and a `BEFORE INSERT` trigger on every table that gains `hash_pepper_id`,
   created `IF NOT EXISTS` and inert while the table is empty. Once a row exists the trigger aborts
   any INSERT that carries a hash and a `NULL` `hash_pepper_id`, including the INSERT half of an
   upsert, which is exactly what an S0 statement writes (S0 does not name the column). A spot-check
   on SQLite 3.54.0 confirmed that such a trigger fires for an upsert that takes the `DO UPDATE`
   branch and leaves the existing row untouched; the migration test re-proves it on the
   repository's SQLite and on workerd D1. The remaining S0 hash-changing statements are the
   compare-and-set on the old hash (`core/devices.ts:864-868`), which cannot match a row S0 could
   not already read, so a row it re-keys was hashed under S0's own scheme and its stamp (`NULL` or
   `default`) stays truthful; and the seat release that nulls a hash (`core/repo.ts:1406-1408`),
   which leaves no credential to mis-hash. (Under a mislabeled `PKEY_ENVIRONMENT` S0 can still
   re-key a pre-guard unkeyed row this way; its stamp stays `NULL`, never a false `default`, and
   the report keeps counting it.) A revision that is still serving S0 code when the fence closes
   therefore cannot insert a row or overwrite a stamped one: it fails visibly instead of
   diverging. The row is inserted only by a platform-admin, step-up, audited operation that stores
   part 2's attestation and refuses unless the required triggers exist (`REQUIRED_TRIGGERS`,
   Appendix A); no route deletes it.
4. **Rollback boundary (policy and tests).** The table and rules below.

| State                                    | Permitted                                                                                                   | Forbidden                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fence open                               | Move the code between S0 and R1 in either direction (compat writes are S0-compatible); run the down scripts | Any non-`default` active id; any rehash by R1                                                                                                                       |
| Fence closed, no non-`default` write yet | Move R1 and later revisions back and forth                                                                  | Rolling back to S0 (its writes abort); the down scripts; removing an id that stamps rows                                                                            |
| After the first non-`default` write      | Flip the active id back to `default`; a forward fix (below)                                                 | Rolling back to S0; `wrangler rollback` or the dashboard rollback to any version; the down scripts; removing or disabling an id that stamps rows, except under §7.3 |

- Rolling back to S0 is forbidden after the fence closes, in every environment, during an incident
  too.
- After the first non-`default` write the only supported code recovery is a forward fix: build the
  previous ring-aware commit and `wrangler deploy` it as a new version, which takes the current
  secrets. A rollback restores a version's captured bindings (`docs/RUNBOOK.md:579-583`), which may
  omit a ring member that already stamps rows. A ring that lost such a member shows up as
  `unopenable` in the report (the KEK report's own signal, `console/handlers/products.ts:854-862`)
  and as denied credentials, never as a silent downgrade.
- Down scripts (`scripts/rollback/00XX_*.down.sql`, the `0105_licensing.down.sql` convention) for
  the stamp columns and the fence abort before any DDL once a fence row exists. Dropping
  `hash_pepper_id` afterwards would destroy the only record of which pepper hashed a row and would
  let S0 write again.

### 7.2 Rollout sequence and rollback

1. **Preflight / human census.** Determine whether any production rows predate a configured
   pepper. Use a read-only known-credential probe and deployment history; do not infer provenance
   from a 64-hex value. If unknown, enter the explicit `unkeyed` verify-only migration path.
2. **G0: mixed-version rehearsal (non-production, before any production step).** It needs a
   deployable non-production environment (decision 7). With a real split deployment
   (`wrangler versions upload`, then `wrangler versions deploy`, 50/50) of the last S0 tag and R1,
   for one credential of each family: create on S0 and use on R1, then the reverse; check the
   stamps (`NULL` against `default`); close the fence; confirm S0 writes abort and R1 is
   unaffected; rotate; confirm S0 answers unauthorized for rehashed and new rows and writes
   nothing; then attempt a rollback to S0 and confirm nothing diverges. Record the version ids,
   commands and outputs in the work package.
3. **R1 compat deploy.** The migrations (`00XX_a` to `00XX_f`: columns, fence table, inert
   triggers) apply first, as CI already orders them, then R1 with the current secrets unchanged:
   ring primitive, candidate reads, stamps on new rows, no rehash, no new id. S0 and R1 may
   overlap.
4. **G1: drain and close the fence.** §7.1 part 2, then the audited close operation; one
   environment at a time, non-production first.
5. **Dual-read deploy.** Enable rehash-on-use and the report. With the active id still `default`
   the only rehash is `unkeyed` to `default`, which makes rows readable that S0 never could.
   Watch the per-id report and security events. Test a credential from each affected family in
   the non-production environment first.
6. **G2: rotation.** Preconditions: the fence is closed (the guard enforces it), §6.4's stable
   derivations have shipped, and the baseline report and one known canary credential per family are
   captured. Add the new member to the ring **without activating it** (one `wrangler secret bulk`
   call), confirm the ring loads, then activate it in a second call, as `docs/RUNBOOK.md:448-463`
   does for the KEK; two `put`s would deploy an intermediate version that names a missing id. The
   old scalar stays bound and mandatory. Rehash on use. Never remove the old value merely because
   a deploy succeeded.
7. **Retirement.** Enforce each family's report/expiry rule. Licence-key stragglers require an
   explicit owner decision and customer communication/reissue plan. An exposed pepper does not wait
   for this step: §7.3.
8. **Rollback.** Only what the boundary table in §7.1 permits. Recovery after the first
   non-`default` write is a forward fix. The active id may be flipped back to `default`, which
   changes new writes only and never deletes rows or secrets. `wrangler rollback` is not an
   incident response here: it can restore a pre-rotation ring or a compromised secret binding.

### 7.3 Compromised or suspected pepper

Until R1 ships there is no safe response to an exposed pepper: changing the secret invalidates
every stored hash at once (`docs/DEPLOYMENT.md:40-42`). Shipping §7.2 steps 1 to 4 is therefore the
first containment step, and no later step here may start before the fence is closed. Unlike a KEK
compromise, which re-sealing undoes in place because the Worker can open every blob
(`docs/RUNBOOK.md:587-598`), nothing stored under a pepper can be re-keyed unless its holder
presents the credential.

**What an exposed pepper is worth.** Credentials are high-entropy: licence keys carry 128 random
bits (`platform/crypto.ts:12-15`), device and opaque tokens 256 (`:24-27`; the `pkeya_` admin token is `:50-52`), so a hash plus
the pepper does not yield a credential. The pepper protects (a) low-entropy inputs that are also
hashed under it and (b) lookup integrity against anyone who can write to D1, KV or a Durable
Object. The KEK runbook states the same split for a leaked key that a writer can exploit
(`docs/RUNBOOK.md:594-598`).

| Class                                                         | Evidence                                                                                          | What the holder can do                                                                                      | Exposed id during the window                                    | Rehash                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| C0: pepper only                                               | Seen in a log, CI output or ticket; no sign of data access                                        | Nothing on its own                                                                                          | Verify-only until the owner's date D                            | On                                         |
| C1: pepper and data read                                      | A D1 export or backup, a KV listing, or hashed values in a log                                    | Guess low-entropy inputs offline and confirm known addresses, `sub` values and pictures (below)             | Verify-only until D                                             | On: no write capability, so no forged rows |
| C2: pepper and write or code execution, or capability unknown | Write access to D1, KV or a Durable Object; a compromised Worker, secret store or deploy pipeline | Forge a credential, session or flow row that verifies; a forged row is indistinguishable from a genuine one | `disabled` at once, or `quarantined` for an owner-signed window | Off for that id                            |

Low-entropy inputs hashed under the pepper: email codes are 6 digits and live 10 minutes
(`docs/security/THREAT-MODEL.md:3671-3672`), device user codes carry about 34.5 bits and live 5
minutes (`:6807`), and a known address, `sub` or picture can be confirmed against a stored hash
(the storefront-key case is already documented, `:6622-6625`).

C2 is a platform incident: every Worker secret and the KEK are in scope, and the steps below are
necessary but not sufficient. Unknown capability is treated as C2. Each state names the exposed
ids; a `NULL` stamp counts as exposed when the historical scalar is.

**What must be replaced or revoked.** The scope is every _required_ row: live, and stamped with an
exposed id (or `NULL`), including the dormant rows that rehash-on-use would never reach.

| Family                                 | Required row (live)                                                          | Revoke by stable key, never by hash                                                                                                                                                                                                              | Replace through                                            |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `pkey_` licence key                    | `keys_index.status = 'active'`                                               | `UPDATE keys_index SET status = 'revoked' WHERE product = ? AND status = 'active' AND <stamp predicate>`, the shape of `replaceLicenseKeys`' first statement (`core/repo.ts:1238-1270`) and of product deletion (`core/console/repo.ts:168-171`) | Portal reissue or operator mint (note 1)                   |
| `pkeyt_` device token                  | `devices.status = 'authorized' AND token_hash IS NOT NULL`                   | `UPDATE devices SET token_hash = NULL WHERE product = ? AND status = 'authorized' AND <stamp predicate>`, the form `releaseDormantSeats` uses (`core/repo.ts:1406-1408`)                                                                         | Re-activation with a valid licence key (note 2)            |
| `pkeyci_` CI token                     | `ci_tokens.revoked_at IS NULL AND expires_at > now`                          | `revokeCiToken`'s statements keyed by `token_id`, with `<stamp predicate>` (note 3)                                                                                                                                                              | Operator mints a static token; OIDC tokens re-mint per run |
| `pkeyr_` registry token                | `registry_tokens.revoked_at IS NULL AND expires_at > now` (at most 365 days) | By `(product, token_id)` with `<stamp predicate>`, as `stmtRevokeProductRegistryTokens` does by product (`core/registry/registryTokens.ts:509`)                                                                                                  | Console or portal mint                                     |
| `pkeya_` admin API token               | `admin_api_tokens.revoked_at IS NULL AND expires_at > now`                   | `UPDATE admin_api_tokens SET revoked_at = :now WHERE id = :token_id AND revoked_at IS NULL AND <stamp predicate>`, by token id, never by hash                                                                                                    | Operator mints a new token (`pkey` admin API token roster) |
| Tickets, flows, codes, download tokens | Unexpired                                                                    | None: they expire by their own TTL (upload tickets at most 1 hour, `core/publisher.ts:109-110`)                                                                                                                                                  | The user restarts the flow                                 |
| Sessions                               | `account_sessions` unrevoked and unexpired; KV browser sessions              | Per account, or by disabling the id (note 4)                                                                                                                                                                                                     | The user signs in again                                    |

`<stamp predicate>` is `hash_pepper_id IN (<exposed ids>)`, plus `OR hash_pepper_id IS NULL` when
the historical scalar is exposed, evaluated inside the same statement.

1. Licence keys: plaintext is shown once, so no replacement is derivable from a stored hash, and
   **no bulk reissue exists**. The portal path is `handleKeyReissue`
   (`services/identity/portal/selfService.ts:813-897`): step-up within 5 minutes (`:811`), 5 an
   hour (`:838-847`), a notice by email, and only where the product's `key_reissue_enabled` setting
   is on, which defaults to off (`services/identity/portal/repo.ts:675,703`,
   `services/identity/portal/api.ts:769`). The operator path is a per-licence mint
   (`services/license/admin/keys.ts:45-82`). A licence with no portal link can be replaced only
   through the operator path, and is told through the licence's own address, as the portal flow
   does (`services/identity/portal/selfService.ts:889-894`).
2. Device tokens: replacing a licence key leaves devices untouched (`core/repo.ts:1231-1236`), so
   tokens need their own sweep. A refused device must re-activate with a valid licence key, which
   mints a fresh token (`core/devices.ts:532-536`); the KV token record is never the authority,
   the D1 row is (`core/devices.ts:820-824`). Whether a given SDK re-activates on its own is client
   behavior this plan does not change; the drill records it per SDK.
3. CI tokens: static tokens live at most 90 days, minted ones 30 minutes
   (`core/publisher.ts:87-90`); revoke by `token_id`, and cap unredeemed tickets with a statement
   that re-resolves the current hash (`console/systemProduct.ts:435-439`).
4. Sessions: a forged `account_sessions` row alone is not a session, because the cookie is also
   signed with `PORTAL_SESSION_SECRET` (`docs/DEPLOYMENT.md:37-38`) and checked first
   (`services/identity/portal/accountSessions.ts:159-177`). `revokeAllAccountSessions` is per
   account (`:249`); disabling the id makes every session lookup miss, which signs everyone out.
   KV browser sessions live 30 days (`services/identity/browserSession.ts:111`).

**Procedure (mandatory order).**

1. **Declare and classify.** The incident lead the owner named (decision 8) records C0, C1 or C2
   and the evidence in an audit event. Unknown capability is C2. Pause unrelated deploys.
2. **Close the fence.** If it is open, complete §7.1 parts 1 to 3 first: one deploy and the
   15-minute drain. There is no faster safe path.
3. **Stage the replacement path.** Run the replace path of every in-scope family against the
   non-production environment, including that `key_reissue_enabled` is on for every in-scope
   product. The owner approves the customer-impact list (the report's counts per family), the
   notices, and whether per-licence flows can carry the count (decision 9). Cut-now is a
   platform-wide credential outage until replacements land.
4. **Mint the replacement.** A new id, never a reused one; 32 random bytes from a CSPRNG, generated
   off the Worker and delivered through `wrangler secret bulk` over stdin, never a command line
   (the pattern of `docs/RUNBOOK.md:676-693`), added to the ring inactive and confirmed loaded, as
   in §7.2 step 6. First mint one canary credential per family under the exposed id, or keep an
   owner-held one stamped with it, and keep its plaintext (V2).
5. **Activate and set states in one `wrangler secret bulk` call.** The new id becomes active. The
   exposed id stays verify-only for C0 and C1, and becomes `disabled` (cut now) or `quarantined`
   (a window the owner signs for) for C2. Delete nothing yet.
6. **Window (C0, C1, or a C2 quarantine).** Rehash-on-use runs for every id that is not
   quarantined; replacements go out; TTL-bound artefacts drain. The window ends on the recorded
   date D, never because the report happened to reach zero, and an exposed pepper is never kept
   verify-only without an end date: the dormant rows rehash-on-use cannot reach are what step 7
   exists for.
7. **Cutoff: revoke, then disable, then forget.**
   - **(a) Sweep.** Per family, every required row still stamped with an exposed id or `NULL` is
     revoked by a stable predicate that names the stamp inside the same statement (a row a customer
     has just rehashed is skipped, and the rehash writes no status, so a revoked row is never
     revived), in bounded batches, idempotent and resumable (the KEK sweep is the model,
     `console/handlers/products.ts:944-955`), with one audit event per batch and the family's
     count.
   - **(b) Disable.** Set the exposed id `disabled`: instant, and its rows now count as
     `disabled`.
   - **(c) Forget.** When the report shows no live row under it and the longest security-state
     TTL (§6.3) has passed since (b), deploy a ring without its secret and delete the scalar in
     the same call (`null` deletes a secret in `wrangler secret bulk`, `docs/RUNBOOK.md:517-521`;
     containment is not complete while the leaked scalar stays bound, `:558-562`). Only the id's
     name remains in `KEY_HASH_PEPPER_STATES`.
   - **Why this order.** Revoking first means no row is both `active` and unverifiable, and a
     restore or a mistaken re-add cannot revive a revoked row.
8. **Verify** V1 to V5 and close the incident record.

- **V1.** The report shows no live row under an exposed id or `NULL` in any family, and no
  `unopenable` row.
- **V2.** Each canary from step 4 answers 401 after cutoff, and a replacement under the new id
  succeeds.
- **V3.** The audit trail holds the declaration, the fence close, the activation, every revocation
  batch, the disable and the forget, each with actor and step-up.
- **V4.** The exposed material is gone from Worker secrets in every environment, from the GitHub
  environment secrets that `.github/workflows/sync-worker-secrets.yml` reads (`:43,79`), from
  local `.dev.vars` and from password stores. Any retained sealed copy has an owner and a
  destruction date.
- **V5.** A D1 backup, bookmark or rollback target from before cutoff restores rows that cannot
  verify, because their id is disabled. Do not re-add the exposed id to make them work without a
  new incident decision.

**Owner approvals required.** A1 the class and the capability assumption. A2 the policy: cut now,
or the window and its end date D (any C2 window is a signed risk acceptance), and whether an
emergency rotation before §6.4's stable derivations ship may change `mbr_` audit identity and
avatar ids. A3 the customer-impact list and the notices. A4 replacement capacity (decision 9). A5
destruction or escrow of the exposed secret. The break-glass override of §6.5 never substitutes for
the step 7(a) sweep. A pepper incident does not touch the stable-derivation secret of §6.4; if that
one is exposed too, it is a separate incident.

## 8. Risks and decisions for the human

1. **Was `KEY_HASH_PEPPER` present before the first production credential?** Required answer.
   - If yes, legacy rows are `default`/unknown, not unkeyed.
   - If no/unknown, permit the explicit unkeyed verify-only reader until measured coverage and an
     owner-approved sunset; do not silently make SHA-256 a new-write fallback.
2. **Credential-ring shape.** Approve `KEY_HASH_PEPPERS` + `KEY_HASH_PEPPER_ACTIVE` with the
   current scalar retained: mandatory while the fence is open, verify-only afterwards. **Recommend
   yes**; it is the KEK-keyring precedent and makes the first deploy a no-op.
3. **Stable derivation secret.** Approve a separate non-rotating key for `mbr_` and durable asset
   identifiers before the first pepper rotation. **Recommend yes.** Reusing a rotating credential
   pepper breaks audit/asset identity; pinning forever leaves an undocumented leak boundary.
4. **Licence-key stragglers.** Decide whether an old pepper may remain verify-only indefinitely or
   whether a retirement may deliberately strand/reissue unused licence keys. **Recommend retain
   until zero; no time-only automatic retirement.** This is the planned-rotation policy: an exposed
   pepper follows §7.3, which overrides it.
5. **Per-product pepper derivation.** The architecture review suggests HKDF-derived per-product
   peppers. Keep it out of this first cut; decide separately after the ring makes safe rotation
   possible. Combining both changes makes incident recovery harder to verify.
6. **Config posture.** Approve failure closed whenever the Worker is not an explicitly test/local
   environment and the ring is absent/malformed. **Recommend yes.** A typo in `PKEY_ENVIRONMENT`
   must not resurrect unkeyed writes.
7. **Rotation fence.** Approve §7.1: compat mode, the drain attestation, the D1 fence record with
   its insert triggers, no rollback to a scalar-only revision after closure, and forward-fix-only
   recovery after rotation. **Recommend yes.** The fence record is the only control that survives
   a `wrangler rollback`, which restores a version's own bindings (`docs/RUNBOOK.md:579-583`). It
   needs a deployable non-production environment for G0: `staging` and `dev` still carry
   `REPLACE_ME_*` placeholders and cannot deploy (`docs/DEPLOYMENT.md:997-999,1311-1313`), and the
   deployment is production-only by design (`docs/DEPLOYMENT.md:3-6`). The owner provisions one
   first, or names another disposable environment. If the owner declines the fence, ship only the
   compat deploy (§7.2 steps 1 and 3): the ring primitive, stamps and candidate reads, with no
   rehash and no rotation.
8. **Compromise policy.** Approve §7.3: who may declare C0, C1 or C2 (name the person or role;
   unknown capability is C2), the three member states, revoke-before-disable, and the canary
   verification. **Recommend yes.** It depends on decision 7: without the fence §7.3 has no safe
   first step. Name the incident lead and the approver of A1 to A5 before the first production
   rotation, so the procedure is executable during an incident.
9. **Replacement capacity.** No bulk replacement exists: only per-licence portal reissue (step-up
   within 5 minutes, 5 an hour, enabled per product) and operator mint. From the census count,
   decide whether those flows are an acceptable path for a C2 cut-now outage, or whether a
   separate bulk-reissue work package is commissioned first. **Recommend deciding from the census
   count before the first production rotation.** This plan creates no bulk tool.
10. **Native `CHECK` on `product_keys.status`.** Appendix A, decision A-1. **Recommend no.**

## 9. Acceptance

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test R12-secrets
mise exec node@22 -- pnpm --filter @polaris-key/worker test R5-isolation
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminSessions
mise exec node@22 -- pnpm --filter @polaris-key/worker test pepper
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm format
```

Plus the full green gate in `AGENTS.md`; every new test file named `pepper*` so the filter above
runs the set (the trigger and batch tests also run under `test:workerd`); a staging rotation
rehearsal for one non-production credential from every listed family; the G0 mixed-version
rehearsal record and the G1 drain attestation for every environment before its fence closes
(§7.1 and §7.2); a compromise drill in the non-production environment that runs §7.3 steps 3 to 8
against one credential of every family and ends with V1 to V4; and a human-reviewed report proving
the old pepper has no unresolved required rows before a real retirement. Appendix A adds a
required-trigger assertion and the `product_keys` writer tests, and no migration.

---

## Appendix A — `product_keys.status` (R11-07 / migration 0003)

### Current code correction

The assignment's premise is partly stale. `migrations/0003_keyvault.sql` creates
`product_keys.status` with the obsolete comment `active | retired`, but
`migrations/0015_data_integrity.sql:108-119` already enforces the four real values
`active`, `staged`, `retired`, and `revoked` through `BEFORE INSERT` and `BEFORE UPDATE OF status`
triggers. `test/attack/R11-data.test.ts:329-372` proves an invalid insert is rejected. The active
key retire/revoke guard is also implemented in `console/handlers/products.ts:1669-1707`.

Therefore this is **not** a request to ship a duplicate functional fix. First correct the
migration comment and add update/upsert/trigger-survival tests. A true SQLite `CHECK` is owner
decision A-1 below because it requires rebuilding the signing-key table; SQLite cannot add it with
`ALTER TABLE`, and `0017_portal_fk_cascade.sql:21-31` deliberately avoids rebuilding `product_keys`
because D1 has no wrapping transaction and dropping a table drops its triggers and indexes.

### The native CHECK rebuild is withdrawn from this plan

A `product_keys_v2` rebuild (copy with `INSERT OR IGNORE`, `DROP TABLE`, `RENAME`) is not part of
this plan, and no draft of its SQL is kept here. Such a rebuild is correct only if nothing writes
`product_keys` between the copy and the `DROP`, and production has five writers that can land in
that window:

| Writer           | Statement                                                                                    | Source                                   |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Stage a key      | `INSERT INTO product_keys …`                                                                 | `core/repo.ts:470-486`, `:895-910`       |
| Activate         | Retire the outgoing key and promote the staged one, each `WHERE status = …`                  | `keyTransitions.ts:32-50`                |
| Retire or revoke | `UPDATE … SET status, rotated_at, revoked_at WHERE … status IN (…)`                          | `keyTransitions.ts:53-72`                |
| Delete a product | `UPDATE … SET status = 'revoked', rotated_at, revoked_at WHERE product = ?`, no status guard | `core/console/repo.ts:172-175`           |
| KEK re-seal      | Compare-and-set of `enc_private_json` on the old blob                                        | `console/handlers/products.ts:1006-1013` |

A row changed after the copy (a revoke, an activation, a re-seal, a product delete) is skipped by
`OR IGNORE` because the shadow already holds its primary key, and `DROP TABLE` then discards the
only current copy. Row counts and `PRAGMA foreign_key_check` cannot see a same-key stale value. The
outcome is signing-key state restored from the past: a revoked key `active` again, a deleted
product's key live, or a re-sealed blob replaced by one sealed under a KEK that may since have been
retired. The repository's own precedent declines this rebuild for this table
(`0017_portal_fk_cascade.sql:22-30`), and the premise a rebuild would lean on is disputed: the
repository records D1 migration files as non-transactional (`0015_data_integrity.sql:5-12`,
`0017_portal_fk_cascade.sql:32-46`), while Cloudflare documents a failing migration as rolled back
([`d1 migrations apply`](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)).
This plan depends on neither.

This plan authorizes **no** `product_keys` migration. Approving it authorizes only: (1) the comment
correction in `0003_keyvault.sql`; (2) the update/upsert/trigger-survival tests; (3) a
required-trigger assertion, a `REQUIRED_TRIGGERS` list beside `REQUIRED_INDEXES`
(`scheduled.ts:156-199`) naming `trg_product_keys_status_ins`, `trg_product_keys_status_upd` and
the fence triggers (§7.1), checked at deploy by a successor of the newest `*_index_assertion.sql`
(the deploy step runs the newest by name, `.github/workflows/deploy.yml:165-171`) and on every
tick, with the existing test that the lists agree; and (4) the writer tests below. A rebuild drops
a table's triggers (`0017_portal_fk_cascade.sql:22-26`), which is exactly what the assertion
catches.

**Owner decision A-1: native `CHECK` on `product_keys.status` (the original owner choice,
unchanged).** **Recommend no.** The triggers already refuse an invalid status on INSERT and UPDATE
(`0015_data_integrity.sql:111-119`, `test/attack/R11-data.test.ts:329-372`); a native `CHECK` adds
schema visibility, not protection worth rebuilding the platform signing-key table. A yes does
**not** unlock implementation here. It requires a new, separately reviewed plan that meets every
item of this bar:

1. **No copy-then-ignore.** The shadow is never filled by a one-time `INSERT OR IGNORE` while
   writers can still change the source. Either (a) one atomic D1 `batch()` creates the shadow,
   copies with a plain `INSERT` into the empty shadow, asserts equality, drops, renames and
   recreates; D1 documents `batch()` as one SQL transaction that rolls back the whole sequence on
   failure and runs statements "sequentially, non-concurrently"
   ([D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)); or (b)
   every writer in the table above is blocked for the whole interval by a mechanism the plan
   proves, not by convention, and a replay overwrites existing shadow rows with the source's
   current values, never ignores them.
2. **Values, not counts.** Before the `DROP`, the same unit asserts that
   `SELECT <all nine columns> FROM product_keys EXCEPT SELECT … FROM product_keys_v2` and the
   reverse are both empty, with the abort-on-mismatch `CHECK` idiom of
   `0027_i_index_assertion.sql:15-21`. Row counts and `foreign_key_check` are extra, not
   substitutes.
3. **Everything dropped is rebuilt in the same unit:** `idx_product_keys_one_active`,
   `idx_product_keys_verify`, and the two status triggers or their native replacement. The
   required-index and required-trigger assertions pass before the unit commits.
4. **Every column byte-identical:** `product`, `kid`, `alg`, `public_b64url`, `enc_private_json`,
   `status`, `created_at`, `rotated_at`, `revoked_at`, the nine columns that migrations `0003` and
   `0021` define. There is no use counter or other column to carry.
5. **Interleaving tests**, each writer in the table above landing before the copy, between copy and
   swap, and after the swap, through a `Db` wrapper like `interleaved`
   (`test/descriptor.test.ts:1505-1521`) and the pattern of `test/keyStateMachine.test.ts:163-176`;
   a crash/replay test at every statement boundary of any non-atomic variant; and a rehearsal
   against live writers in the non-production environment.
6. **Recovery, not a control.** A D1 Time Travel bookmark recorded immediately before is recovery
   only: it restores the whole database and loses every later write.

**Tests this plan does require (no rebuild involved).** Each asserts that every column the
statement under test does not name is byte-identical afterwards, using a row-equality helper; that
is the preservation spec for `status`, `rotated_at`, `revoked_at`, `enc_private_json` and the rest.

1. An invalid `status` is rejected on INSERT, UPDATE, `INSERT OR REPLACE` and upsert, and the
   triggers still exist after the full migration set.
2. Re-seal against activate, retire and revoke, in both orders: the final row has the transition's
   `status`, `rotated_at` and `revoked_at` and the re-sealed blob, never the old blob and never an
   older status.
3. Product delete against stage and activate, in both orders: no interleaving leaves an `active`
   key on a deleted product, and a lost activation reports 409 (0 rows).
4. Stage against activate: `idx_product_keys_one_active` still allows at most one active key per
   product.

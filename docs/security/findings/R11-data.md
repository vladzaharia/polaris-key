# R11 — Data layer: schema, migrations, constraints, integrity

Lane: the 11 migrations in `packages/worker/migrations/`, everything in
`packages/worker/src/db/`, `src/repo.ts`, `src/admin/repo.ts`, `src/portal/repo.ts`, and every
call site that mutates or reads them.

Tree: branch `lewd-owl` at HEAD `bd26e0b`. All line numbers are against that tree.

PoC file: `packages/worker/test/attack/R11-data.test.ts` — **44 tests, all green**
(`npx vitest run test/attack/R11-data.test.ts` under Node 22). No source file and no migration
was modified. `npx prettier --check` on the PoC file is clean.

All 11 migrations were read in full before anything below was written.

## Summary

| ID     | Severity | Title                                                                                                                                                  | PoC                    |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| R11-01 | High     | `countLicensesUsingProfile` misses `tiers.profile_id`; deleting a tier's profile silently strips that tier's entire managed payload                    | ✅ proven              |
| R11-02 | High     | Seat consumption is check-then-act with no DB-level guard, and a `<= 0` device limit disables the check outright                                       | ✅ proven              |
| R11-03 | Medium   | `resyncRepo` mutates five tables outside any batch, then can bail — leaving a half-resynced product with **zero active schemas**                       | ✅ proven (schema arm) |
| R11-04 | Medium   | Migrations are not re-runnable; a partially-applied migration silently omits `idx_licenses_enroll_hwid`, the DB guard the free-licence flow depends on | ✅ proven              |
| R11-05 | Medium   | Unauthenticated `GET /download/<token>` full-scans a never-purged `release_download_tokens` — unrate-limited amplification                             | ✅ proven (query plan) |
| R11-06 | Medium   | Unguarded `JSON.parse` of DB columns takes admin/OIDC/edge-mint handlers to a 500                                                                      | ✅ proven              |
| R11-07 | Medium   | No `CHECK` on any status/origin column; retiring or revoking the **active** signing key bricks the product                                             | ✅ proven              |
| R11-08 | Medium   | `licenses` has no `email` index; the portal's cross-tenant `lower(email)` sweep is a full scan on every request                                        | ✅ proven              |
| R11-09 | Medium   | Soft delete retains PII forever; `audit`, `portal_audit` and `release_download_tokens` are unbounded with no cron                                      | ✅ proven              |
| R11-10 | Low      | No `(product, license_id, status)` index — the seat count scans the product's whole authorized device set                                              | ✅ proven              |
| R11-11 | Low      | `SqliteDb` vs `D1Db` divergences: empty `batch()`, `ArrayBuffer` params, `r.results ?? []` swallowing D1 errors                                        | ✅ proven              |
| R11-12 | Low      | `getPortalDownloadToken` breaks the "every query is product-scoped" invariant (cross-ref R5-10)                                                        | ✅ proven              |
| R11-13 | Info     | `customers` and `identity` are dead PII-bearing schema with no reader or writer anywhere in `src/`                                                     | ✅ proven              |

**Eleven seeded or self-generated hypotheses were refuted** — see the REFUTED section. Most
notably, hypothesis 2's central claim is wrong: key revocation _does_ work server-side.

---

## R11-01 — Deleting a profile a **tier** points at bypasses the reference guard

**Severity: High.** A single, audited, 200-OK admin action silently removes the managed
payload — config defaults, secrets, and **entitlements** — that every license on that tier
inherits. Nothing in the schema, the guard, or the response indicates it happened.

**Files**

- `packages/worker/src/admin/repo.ts:236-249` — `countLicensesUsingProfile` counts **only**
  `license_profiles`:
  ```sql
  SELECT COUNT(*) AS n FROM license_profiles WHERE product = ? AND profile_id = ?
  ```
  It never looks at `tiers.profile_id`.
- `packages/worker/src/admin/handlers/profiles.ts:123-129` — the DELETE handler's only guard is
  that count.
- `packages/worker/src/admin/repo.ts:224-234` — `deleteProfile` is a bare
  `DELETE FROM profiles WHERE product = ? AND id = ?`.
- `packages/worker/migrations/0001_init.sql:51-61` — `tiers.profile_id` is a plain `TEXT`
  column. **No foreign key.** `migrations/0004_license_profiles.sql:3-9` — `license_profiles`
  likewise declares no FK to `profiles` or `licenses`.
- `packages/worker/src/licenseCore.ts:200-216` — the consumer swallows the dangle:
  ```ts
  const p = await getProfile(db, product, tier.profile_id);
  layers.push(p?.payload_json ?? null); // missing profile === empty layer
  ```

**Preconditions.** Any product admin. No race, no concurrency, no special timing.

**Exploit / accident steps**

1. Tier `pro` has `profile_id = 'pro-baseline'`; 500 licenses sit on tier `pro`.
2. No license has `pro-baseline` in `license_profiles` (it is inherited through the tier, which
   is the _documented_ way to attach a baseline — `0001_init.sql:38-39`, _"Shared managed-payload
   baselines (a tier attaches one)"_).
3. `DELETE /api/products/acme/profiles/pro-baseline` → `countLicensesUsingProfile` returns 0 →
   guard passes → row deleted.
4. `tiers.profile_id` now dangles. Every subsequent `/config` for those 500 licenses resolves
   with one fewer layer. Enforced entitlements that lived in that profile are gone.

**Impact.** Silent, product-wide loss of the enforced-entitlement layer. Any feature gate,
quota or secret expressed in the tier baseline evaporates; whether that fails open or closed
depends entirely on what the client does with an absent entitlement. There is no error, no
`409`, and the audit trail records a benign `profile.delete`.

**Wider pattern.** This is one instance of a schema-wide gap:

- **Not one FK in the entire schema declares `ON DELETE` or `ON UPDATE`** (proven by scanning
  `sqlite_master`). Every reference is `NO ACTION`.
- `keys_index`, `devices`, `identity` and `license_profiles` declare **exactly one FK each —
  `product` → `products(slug)`** — and none to `licenses`. A `keys_index` row with a
  `license_id` that never existed inserts cleanly (proven).
- `portal_license_links` (`0008_portal.sql:37-46`) references `portal_accounts` and `products`
  but **not** `licenses`, so a link to a nonexistent license persists forever, invisible behind
  the `JOIN` in `listPortalLicenses` (proven).
- `deleteTier` (`admin/repo.ts:298-304`) leaves `licenses.tier_id` dangling; `getTier` then
  returns `null` and `injectAdminPolicy(payload, null, …)` drops the tier's `policy_device_limit`,
  `channels_json`, `min_version`/`max_version` **and** `policy_fingerprint` in one go — a
  fingerprint-enforcement downgrade. Its handler _does_ guard (`tiers.ts:155-160`), but the
  guard is a non-atomic check-then-act and `resyncRepo` reaches the same DELETE without it.
- `resyncRepo` (`release/resync.ts:222,251,277,298,306`) mass-`DELETE`s five manifest-owned
  tables per run.

**PoC** — `R11-01 missing foreign keys / no ON DELETE anywhere` (7 tests).

**Fix direction**

1. Extend the guard to every referrer:
   ```sql
   SELECT (SELECT COUNT(*) FROM license_profiles WHERE product = ?1 AND profile_id = ?2)
        + (SELECT COUNT(*) FROM tiers            WHERE product = ?1 AND profile_id = ?2) AS n;
   ```
2. Back it with the DB rather than the application. SQLite cannot add an FK to an existing
   table, so this needs a rebuild migration under `PRAGMA defer_foreign_keys` (the D1-supported
   lever — `PRAGMA foreign_keys = off` is not available on D1):
   ```sql
   -- tiers
   FOREIGN KEY (product, profile_id) REFERENCES profiles(product, id) ON DELETE RESTRICT
   -- license_profiles
   FOREIGN KEY (product, license_id) REFERENCES licenses(product, id) ON DELETE CASCADE,
   FOREIGN KEY (product, profile_id) REFERENCES profiles(product, id) ON DELETE RESTRICT
   -- keys_index / devices / identity
   FOREIGN KEY (product, license_id) REFERENCES licenses(product, id) ON DELETE CASCADE
   -- portal_license_links
   FOREIGN KEY (product, license_id) REFERENCES licenses(product, id) ON DELETE CASCADE
   ```
   `CASCADE` for rows that are meaningless without their parent (a key or device without a
   license is a live credential pointing at nothing); `RESTRICT` for policy references an
   operator must consciously repoint.
3. `resolveEffective` should not treat a missing profile as an empty layer. A dangling
   `profile_id` is a data-integrity fault; log it and fail closed on the entitlement layer.

---

## R11-02 — Seat consumption is check-then-act, and a `<= 0` limit disables it entirely

**Severity: High.** Device-limit enforcement is the only thing standing between one purchased
license and unlimited installs. It is enforced by two independent statements with an `await`
between them and no database constraint behind it.

**Files**

- `packages/worker/src/licenseCore.ts:336-352`:
  ```ts
  const limit = resolveDeviceLimit(eff, product.defaultDeviceLimit);
  if (limit > 0) {
    const count = await countActiveDevices(db, product.slug, license.id);
    if (count >= limit)
      return { error: "device_limit", limit, deviceCount: count };
  }
  ```
  then `licenseCore.ts:362+` `upsertDevice(...)` — a **separate** statement.
- `packages/worker/src/repo.ts:913-924` — `countActiveDevices`.
- `packages/worker/src/repo.ts:926-955` — `upsertDevice`, an unconditional `ON CONFLICT` upsert
  with no seat predicate.
- `packages/worker/src/db/d1.ts:12-33` — the `Db` interface exposes `all`/`first`/`run`/`batch`
  and **no transaction primitive**, so the two statements cannot be made atomic today.
- `packages/worker/migrations/0011_auto_issue.sql:28-30` — the contrast: enroll uniqueness _is_
  enforced by a partial unique index, with a comment explicitly celebrating that
  _"a race between two concurrent enrolments therefore cannot mint two licenses"_.

**Preconditions.** A valid license key (or an OIDC identity) and the ability to issue N
concurrent `POST /<product>/activate` requests with distinct `X-Device-Id` values. Worker
isolates handle these in parallel; D1 auto-commits each statement.

**Two independent defects**

1. **The race.** N requests all read `count = limit - 1` before any writes, all pass, all
   upsert. Final seat count = `limit - 1 + N`. Proven by an interleaved PoC
   (`countA`/`countB` both read below the limit, both commit, count ends at 3 with a limit of 2).
   The `activate` rate limit (`licensing.ts:298-307`, 30/60s per IP) bounds the burst but does
   not serialise it, and it is per-IP.

2. **`limit > 0` makes a non-positive limit mean _unlimited_, not _zero_.** There is no
   `CHECK (policy_device_limit > 0)` on `tiers`, no `CHECK` on `products.default_device_limit`,
   and `admin/handlers/tiers.ts:79-82` accepts `typeof body.policyDeviceLimit === "number"`
   verbatim. `PATCH {"policyDeviceLimit": -1}` (or `0`) on a tier removes the seat check for
   every license on it. Proven: `-5` and `-99` insert cleanly and `p.b > 0` is `false`.

**Impact.** License-count enforcement bypass — the core commercial control of the product.
Defect 2 needs only a mistyped or fuzzed admin field; defect 1 needs no privilege beyond a
single valid key.

**PoC** — `R11-03 seat-count race` (2 tests) and
`R11-09 … no numeric CHECK anywhere` (1 test).

**Fix direction**

The exact DDL that makes seat consumption atomic — give each authorized device an explicit
seat ordinal and make the ordinal unique per license:

```sql
-- 0012_seats.sql
ALTER TABLE devices ADD COLUMN seat_no INTEGER;

-- One device per (license, seat). A concurrent claimant for the same ordinal loses at the
-- DB, exactly as idx_licenses_enroll_hwid already does for enrolment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_seat
  ON devices(product, license_id, seat_no)
  WHERE status = 'authorized' AND seat_no IS NOT NULL;

-- And make the seat count an indexed lookup rather than a scan (see R11-10):
CREATE INDEX IF NOT EXISTS idx_devices_license_status
  ON devices(product, license_id, status);
```

Then replace check-then-act with a single conditional insert that the DB arbitrates:

```sql
INSERT INTO devices (product, device_id, license_id, status, seat_no, …)
SELECT ?1, ?2, ?3, 'authorized',
       (SELECT MIN(s.n) FROM (SELECT 1 AS n UNION ALL SELECT 2 … ) s   -- or a seats CTE
         WHERE s.n <= ?limit
           AND s.n NOT IN (SELECT seat_no FROM devices
                            WHERE product = ?1 AND license_id = ?3
                              AND status = 'authorized' AND seat_no IS NOT NULL)),
       …
WHERE (SELECT COUNT(*) FROM devices
        WHERE product = ?1 AND license_id = ?3 AND status = 'authorized') < ?limit
ON CONFLICT(product, device_id) DO UPDATE SET …;
```

A loser gets `changes() == 0` (or a `UNIQUE constraint failed: idx_devices_seat`) and returns
`device_limit`. Separately: add `CHECK (policy_device_limit IS NULL OR policy_device_limit > 0)`
to `tiers`, `CHECK (default_device_limit > 0)` to `products`, and change `limit > 0` to an
explicit `limit === null ? unlimited : limit <= 0 ? deny : …`.

---

## R11-03 — `resyncRepo` writes five tables outside any batch and can bail mid-flight

**Severity: Medium.** A resync that reports `ok: false` — or throws — has already committed
part of its work. One of the intermediate states leaves the product with **no active catalog**.

**Files** — `packages/worker/src/release/resync.ts`:

| Line      | Write                                                                      | In a batch?         |
| --------- | -------------------------------------------------------------------------- | ------------------- |
| `143-155` | `UPDATE products SET name, compat_min, compat_max, default_*, admin_group` | no                  |
| `160-169` | `setFingerprintPolicy`                                                     | no                  |
| `172-181` | `setAutoIssuePolicy`                                                       | no                  |
| `186-197` | `deactivateSchemas` **then** `insertSchema` — two `db.run()`s              | no                  |
| `201-217` | `UPDATE release_config … metadata_access, artifacts_access`                | no                  |
| `220-324` | oidc / profiles / tiers / provisioning / edgeMint DELETE+INSERT            | yes, one `db.batch` |

Between the non-batched writes and the batch sit two guards that `return { ok: false }`:
`resync.ts:244-249` (profile still referenced) and `resync.ts:270-275` (tier still referenced).

**Preconditions.** Any admin (or repo-push webhook) triggering a resync whose manifest drops a
profile or tier that is still in use — a completely ordinary operator mistake.

**Impact**

- **Zero active schemas.** `deactivateSchemas` (`admin/repo.ts:81-89`,
  `UPDATE product_schema SET active = 0 WHERE product = ?`) commits; if `insertSchema`
  then fails — a `PRIMARY KEY (product, catalog_version)` conflict from a concurrent resync, or
  any D1 error — the product has no `active = 1` row. `getActiveSchema` returns `null`, so
  `catalogDefaultPayload` returns `null` (`licenseCore.ts:163`), the defence-in-depth
  re-validation in `licensing.ts:509-518` is **skipped entirely**, and `admin/lib/shape.ts:88`
  returns a null catalog so admin override editing degrades. Proven by PoC.
- **Half-applied policy.** The `ok: false` return at `:244` happens _after_ the product row,
  fingerprint policy, auto-issue policy, schema version and release access modes were written.
  The operator sees a failure and reasonably assumes nothing changed. `metadata_access` /
  `artifacts_access` (`0007_backend_contracts.sql:3-4`) are **access-control columns**, so the
  partial write can leave a product's release artifacts more public than the operator believes.
- `db.batch` at `:324` is not wrapped in `try/catch`; a constraint failure inside it propagates
  as an uncaught exception rather than a structured `ResyncResult`.

**PoC** — `R11-09 … multi-step flows OUTSIDE batch() are not atomic` (schema arm proven;
the ordering and the early-return placement are code-proven by the table above).

**Fix direction.** Compose the _whole_ resync as one `DbStatement[]` and issue a single
`db.batch` — D1 guarantees the batch is a SQL transaction that rolls back on any failure. Move
the two reference guards ahead of every write. Replace `deactivateSchemas` + `insertSchema`
with two statements in that same batch, and add
`CREATE UNIQUE INDEX idx_product_schema_one_active ON product_schema(product) WHERE active = 1`
so "exactly one active row per product" (asserted in the `0001_init.sql:27-28` comment) becomes
a DB invariant rather than a convention.

---

## R11-04 — Migrations are not re-runnable, and a partial apply silently drops a security index

**Severity: Medium.** `deploy.yml:44-51` runs `wrangler d1 migrations apply` and
`deploy.yml:52-58` then deploys the worker. There is **no rollback step**. Because a failed
migration is not recorded in `d1_migrations`, the next deploy replays it from statement 1 — and
seven of the eleven cannot survive a replay.

**Files** — every migration with a bare `ALTER TABLE … ADD COLUMN` (SQLite has no
`ADD COLUMN IF NOT EXISTS`):

`0002_channels.sql:6-11`, `0003_keyvault.sql:32-33`, `0006_hardening.sql:5-8`,
`0007_backend_contracts.sql:3-4`, `0009_oidc_provider.sql:1`, `0010_fingerprint.sql:65,69,73`,
`0011_auto_issue.sql:10,14,20,23`.

Measured replay result on an already-migrated database (PoC output):

```
OK   0001_init.sql
FAIL 0002_channels.sql          :: duplicate column name: channels_json
FAIL 0003_keyvault.sql          :: duplicate column name: release_source
OK   0004_license_profiles.sql
OK   0005_product_sync_state.sql
FAIL 0006_hardening.sql         :: duplicate column name: status
FAIL 0007_backend_contracts.sql :: duplicate column name: metadata_access
OK   0008_portal.sql
FAIL 0009_oidc_provider.sql     :: duplicate column name: provider
FAIL 0010_fingerprint.sql       :: duplicate column name: policy_fingerprint
FAIL 0011_auto_issue.sql        :: duplicate column name: auto_issue_json
```

**The sharp edge.** `0011_auto_issue.sql` is ordered `auto_issue_json` (`:10`) →
`auto_issue_source` (`:14`) → `licenses.origin` (`:20`) → `licenses.enroll_hwid` (`:23`) →
`CREATE UNIQUE INDEX idx_licenses_enroll_hwid` (`:28-30`). If the run dies after statement 1,
**every replay dies on statement 1 too** and never reaches the index. The migration's own
comment says that index is what makes "one free licence per machine" safe _"enforced by the
DATABASE rather than by application logic"_. Without it, `getLicenseByEnrollHwid`
(`repo.ts:717-728`) is a pure check-then-act and unlimited free licences can be minted per
machine. Proven: after the simulated partial apply, `licenses.enroll_hwid` is absent and
`idx_licenses_enroll_hwid` does not exist.

The test harness cannot catch any of this — `makeTestDb` (`test/helpers.ts:17-23`) always starts
from an empty in-memory DB and has no `d1_migrations` bookkeeping (proven).

**Fix direction**

- Make every `ADD COLUMN` conditional. Either split each migration so one file adds exactly one
  column, or precede each with a guard the runner tolerates. The robust pattern for D1 is
  one-statement-per-file plus a `.sql` naming convention.
- Order every migration so schema-only statements precede index creation, and put
  security-critical index creation in its own file so it cannot be stranded behind a failed
  `ALTER`.
- Add a post-migration assertion step to `deploy.yml` between `:51` and `:58` that verifies the
  expected indexes exist before the new code is released:
  `wrangler d1 execute … --command "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_licenses_enroll_hwid','idx_product_keys_one_active','idx_licenses_sub')"` and fail the
  deploy on a short count.
- Add a documented rollback runbook; there is currently none.

---

## R11-05 — Unauthenticated `/download/<token>` full-scans a table that is never purged

**Severity: Medium.** An unauthenticated, unrate-limited GET forces a full table scan of a
table that grows monotonically for the lifetime of the deployment.

**Files**

- `packages/worker/src/portal/index.ts:73-82` — the route. It sits **after**
  `/login`, `/callback`, `/magic/verify` and `/api/*` and requires **no session, no CSRF, no
  rate limit** (the only `rateLimitOk` calls in `portal/` are `api.ts:273`, `auth.ts:172`,
  `auth.ts:309` — none on this path).
- `packages/worker/src/portal/api.ts:648` → `packages/worker/src/portal/repo.ts:607-617`:
  ```sql
  SELECT * FROM release_download_tokens WHERE token_hash = ?
  ```
- `packages/worker/migrations/0007_backend_contracts.sql:130` — `PRIMARY KEY (product, token_hash)`.
  A predicate on `token_hash` alone cannot use that index. Measured query plan:
  `SCAN release_download_tokens` — no index (proven).
- **Nothing deletes from this table.** A `grep -rn "DELETE FROM"` over `src/` returns eight
  statements, none of them against `release_download_tokens`; the worker has **no `scheduled()`
  handler at all**. `idx_release_download_tokens_expiry` (`0007:137-138`) exists but has no
  consumer. `markPortalDownloadUsed` (`portal/repo.ts:619-631`) sets `used_at` and leaves the row.

**Impact.** Cost amplification and latency DoS with zero credentials: each request is
O(rows-in-table) and the table only ever grows (every portal download-URL mint at
`portal/repo.ts:575-605` adds a row with a 300-second TTL and infinite retention). D1 bills read
rows. Over months the scan cost per anonymous request grows without bound.

**Fix direction**

1. Scope the read and index it:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_release_download_tokens_hash
     ON release_download_tokens(token_hash);
   ```
   (globally unique is correct — the hash is a 256-bit secret, and this also removes the
   cross-product ambiguity in R11-12).
2. Add a `scheduled()` cron that runs
   `DELETE FROM release_download_tokens WHERE expires_at < ?` — the expiry index already exists
   for exactly this.
3. Rate-limit `/download/<token>` per IP, as the other portal entry points already are.

**PoC** — `R11-05 product scoping` and `R11-06 unindexed hot queries`.

---

## R11-06 — `JSON.parse` of a DB column with no `try`/`catch`

**Severity: Medium.** A corrupt or hostile JSON column throws a `SyntaxError` out of the
handler, producing a 500 and, for the OIDC path, an unrecoverable sign-in failure.

`packages/worker/src/licenseCore.ts:230-247` is the **correct** pattern and is explicitly
commented as such. These are the ones that are not:

| File:line                        | Column                                       | Reached from                                                     |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `admin/lib/shape.ts:117`         | `licenses.channels_json`                     | `licenseSummary` — the license **list** and **detail** endpoints |
| `admin/handlers/licenses.ts:184` | `licenses.groups_json`                       | license detail                                                   |
| `admin/handlers/licenses.ts:211` | `devices.reported_json`                      | license detail                                                   |
| `admin/handlers/tiers.ts:56`     | `tiers.channels_json`                        | tier list                                                        |
| `oidc.ts:251`                    | `provisioning_config.entitlement_value_json` | `applyProvisioning`, every OIDC sign-in                          |
| `oidc.ts:266`                    | `provisioning_config.allowed_hosts_json`     | same                                                             |
| `oidc.ts:299`                    | `oidc_config.group_role_map_json`            | `activateFromIdentity`, every OIDC sign-in                       |
| `edgeMint.ts:207`                | `edge_mint_config.claims_template_json`      | every edge-token mint                                            |

`admin/lib/shape.ts:117` is the worst: `licenseSummary` is called for **every row** of the
license list, so one corrupt `channels_json` anywhere in a product takes down the entire admin
license view — including the view an operator would use to repair it. Proven: `licenseSummary`
rejects with `SyntaxError`.

**How the column gets corrupted.** No `CHECK (json_valid(channels_json))` exists on any `_json`
column; `patchLicense` (`admin/repo.ts:131-166`) writes whatever the caller passes; `resyncRepo`
and the manifest path write `JSON.stringify` output but a truncated D1 write, a manual
`wrangler d1 execute` repair, or any future writer that forgets `stringify` produces an
unparseable value that is accepted silently.

**Fix direction.** Route every `_json` column read through a single guarded helper — the
codebase already has three of them (`portal/repo.ts:86-93`, `portal/api.ts:101-107`,
`admin/lib/shape.ts:51-61`) and simply does not use them consistently. Add
`CHECK (x IS NULL OR json_valid(x))` to every `_json` column in a rebuild migration so the DB
refuses to store garbage in the first place.

---

## R11-07 — No `CHECK` on any status column; retiring the active signing key bricks the product

**Severity: Medium.**

**Part A — vocabulary is unconstrained.** `products.status`, `licenses.status`,
`licenses.origin`, `keys_index.status`, `devices.status`, `product_keys.status` and
`product_sync_state.status`/`source` have **no `CHECK` constraint**. Compare
`customers.status` (`0007:19`), `release_metadata.metadata_access` (`0007:60-61`),
`release_health` (`0007:113-114`), `portal_accounts.status` (`0008:12`),
`portal_license_links.source` (`0008:45`) and `device_fingerprints.status` (`0010:30`), which
all _do_ have one — the pattern exists and was simply not applied to the security-relevant
columns. Proven: `licenses.status = 'aktive'`, `keys_index.status = 'ACTIVE'`,
`devices.status = 'authorised'` and `licenses.origin = 'whatever'` all insert cleanly, and each
then fails closed at read time in a way that is **unrecoverable through the API** (no handler
matches the value).

`product_keys.status` is documented as `active | retired` (`0003_keyvault.sql:15`) but four
distinct values are written in practice: `'active'`/`'staged'` (`admin/handlers/products.ts:657`,
`:719`), `'retired'` (`repo.ts:359`, `products.ts:731`) and `'revoked'`
(`admin/repo.ts:74`, `products.ts:731`).

**Part B — the actual bug.** `admin/handlers/products.ts:730-737` implements `retire` and
`revoke` with **no guard on the key's current status**:

```ts
if (action === "retire" || action === "revoke") {
  const status = action === "retire" ? "retired" : "revoked";
  await db.run("UPDATE product_keys SET status = ?, rotated_at = ? WHERE product = ? AND kid = ?", …);
```

Contrast the `activate` arm at `:698-704`, which _does_ validate (`only staged keys can be
activated`). Retiring or revoking the **currently active** key leaves the product with zero
active keys. `getActiveProductKey` (`repo.ts:314-322`) returns `null`, so `loadProduct`
(`product.ts:93-95`) returns `null` — and every signed surface for that product goes dark
until an operator stages and activates a replacement. `idx_product_keys_one_active`
(`0006_hardening.sql:11-13`) enforces **at most** one active key; nothing enforces **at least**
one. Proven.

**Fix direction**

- Reject the operation when `row.status === 'active'` unless a replacement is being activated in
  the same batch, mirroring the existing `stmtRetireProductKeys` + `stmtSetProductKeyStatus`
  pairing at `products.ts:717-720`.
- Add `CHECK (status IN ('active','staged','retired','revoked'))` to `product_keys`,
  `CHECK (status IN ('active','disabled'))` to `licenses`,
  `CHECK (origin IN ('admin','oidc','enroll'))` to `licenses`,
  `CHECK (status IN ('active','revoked'))` to `keys_index`,
  `CHECK (status IN ('authorized','deauthorized'))` to `devices`,
  and `CHECK (status IN ('active','disabled','deleted'))` to `products`.
- Update the `0003_keyvault.sql:15` comment, which is now three values out of date.

**PoC** — `R11-02 status vocabulary drift` (5 tests).

---

## R11-08 — `licenses` has no `email` index; the portal's cross-tenant sweep is a full scan

**Severity: Medium.** Amplification and cost. (The _cross-tenant_ half of this is R5-01's
territory; recorded here for the index/schema dimension, which R5 notes but does not quantify.)

**Files**

- `packages/worker/src/portal/repo.ts:265-311` — `syncAccountLicenseLinks` runs
  `SELECT product, id FROM licenses WHERE lower(email) = ?` once **per verified email on the
  account**, then `SELECT product, id FROM licenses WHERE sub = ?` once **per linked identity**.
- Called on **every authenticated portal request** — `portal/api.ts:294`, `:330`, `:609`;
  `portal/auth.ts:292`, `:389`.
- The complete index set on `licenses` (measured):
  `sqlite_autoindex_licenses_1` (the PK), `idx_licenses_sub(product, sub)`,
  `idx_licenses_status(product, status)`, `idx_licenses_enroll_hwid(product, enroll_hwid)`,
  `idx_licenses_origin(product, origin)`. **There is no index touching `email` at all.**
- Both queries measure as `SCAN licenses` (proven). `lower(email)` is not indexable even if an
  `email` index existed; `WHERE sub = ?` cannot use `idx_licenses_sub` because `product` is the
  leading column.
- The inconsistency is telling: `0007_backend_contracts.sql:27-29` creates
  `idx_customers_email` on the _unused_ `customers` table (see R11-13) while the table that is
  actually swept has none.

**Impact.** Every portal page load performs two O(all licenses across all tenants) scans per
email and per identity. On D1 that is billed rows-read and adds latency proportional to total
platform size. An attacker with a portal account and many verified emails multiplies the cost
per request.

**Fix direction**

```sql
-- Store normalised and index it; portal/repo.ts:82-84 already has normalizeEmail().
CREATE INDEX IF NOT EXISTS idx_licenses_email_lower ON licenses(lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_licenses_sub_global  ON licenses(sub) WHERE sub IS NOT NULL;
```

Better still, normalise `licenses.email` on write and make the query `WHERE email = ?` so a
plain `(email)` index applies. Independently, add the `product` predicate the module comment at
`repo.ts:1-3` promises — see R5-01/R5-02.

---

## R11-09 — Soft delete retains PII; three tables grow without bound

**Severity: Medium.** Right-to-erasure is structurally unimplementable in the current schema.

**Retained PII after "deletion"**

- `packages/worker/src/admin/repo.ts:51-78` — `deleteProduct` sets `products.status='deleted'`
  and flips license/device/key statuses. It **deletes nothing**. `licenses.email`,
  `licenses.name`, `licenses.sub` and `licenses.groups_json` survive verbatim, proven.
  `migrations/0006_hardening.sql:5-6` added the soft-delete columns; no hard-delete path exists.
- `customers` (`0007:6-20`) allows `status = 'deleted'` while keeping `email`, `name`, `sub`,
  `groups_json` and `metadata_json`. Proven.
- `portal_account_emails.email` is the **PRIMARY KEY** (`0008:15-20`), proven. Erasure therefore
  means deleting the row, which severs `portal_license_links` (there is no FK, so the links
  survive as orphans — R11-01) rather than anonymising it. There is no `deleted_at`, no
  tombstone, and no way to record "this address was erased" without re-storing the address.
- `device_fingerprints` and `device_facts` _are_ purged correctly on deauthorize
  (`repo.ts:957-992`) — this is the one retention path in the codebase that is done right, and
  the `0010_fingerprint.sql:6-8` comment documents why.

**Unbounded growth, no cron**

- `audit` (`0001:181-195`) and `portal_audit` (`0008:62-71`) have no retention column, no TTL,
  no index supporting a time-range delete for `portal_audit`, and no deleter. Proven.
- `release_download_tokens` — see R11-05.
- The worker exports **no `scheduled()` handler**, so no retention job can exist today.

**Fix direction.** Add a real erasure path: `UPDATE licenses SET email=NULL, name=NULL,
sub=NULL, groups_json=NULL` alongside the status flip in `deleteProduct`, plus an explicit
per-subject erase endpoint. Re-key `portal_account_emails` on a surrogate id with a unique index
on `email`, so a row can be tombstoned. Add a `scheduled()` cron with configurable retention for
`audit`, `portal_audit` and `release_download_tokens`, and an index on `portal_audit(at)` to
support it.

---

## R11-10 — The seat-count query cannot use `idx_devices_license`

**Severity: Low** (performance/cost; contributes to R11-02's exploit window).

`repo.ts:918-922` issues
`SELECT COUNT(*) FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'`.
The available indexes are `idx_devices_license(product, license_id)` (`0001:119`),
`idx_devices_license_present(product, license_id) WHERE license_id IS NOT NULL` (`0007:33-35`,
a redundant duplicate of the former, since `license_id` is `NOT NULL`) and
`idx_devices_status(product, status, last_seen DESC)` (`0007:42-43`).

Measured plan: `SEARCH devices USING INDEX idx_devices_status (product=? AND status=?)` — the
planner takes the status index and filters `license_id` row by row, so **every activation scans
the product's entire authorized device set**. Proven.

**Fix.** `CREATE INDEX idx_devices_license_status ON devices(product, license_id, status);` and
drop the redundant `idx_devices_license_present`.

---

## R11-11 — `SqliteDb` vs `D1Db` divergences

**Severity: Low.** Three ways a test can pass while production fails (or vice versa).

1. **Empty batch.** `SqliteDb.batch([])` resolves cleanly (proven). `D1Database.batch([])`
   rejects with `No SQL statements detected`. Every current caller guards on length
   (`resync.ts:324`) or always has at least one statement, but the abstraction does not, so a
   future `db.batch(items.map(…))` over an empty list is green in CI and 500s in production.
2. **`ArrayBuffer` params.** `DbParam` (`db/types.ts:5-11`) includes `ArrayBuffer` and
   `normParam` passes it through. D1 accepts it; better-sqlite3 throws
   `SQLite3 can only bind numbers, strings, bigints, buffers, and null` (proven). The type says
   it is legal and the test engine cannot express it — a trap in the opposite direction.
3. **`r.results ?? []` swallows a failed D1 result.** `db/d1.ts:16-18`:
   ```ts
   const r = await this.stmt(sql, params).all<T>();
   return r.results ?? [];
   ```
   `r.success` and `r.error` are never inspected. Any `D1Result` that reports failure without
   throwing becomes an **empty result set**, indistinguishable from "no rows". `db/d1.ts:24`
   does the same with `?? null` for `first`. Combined with the `?? 0` defaults in
   `countActiveDevices` (`repo.ts:923`), `countKeysByLicense` (`admin/repo.ts:192`) and
   `nextSchemaVersion` (`admin/repo.ts:99`), a swallowed error becomes **seat count 0** — i.e.
   fail-open on the device limit. Check `r.success`/`r.error` and throw.

**Also verified about the harness (not divergences, but integrity gaps in both engines):**
no table uses `STRICT`, so a `TEXT` value stores happily in an `INTEGER` column and a float
stores as `REAL` (proven); `normParam` maps `undefined` → `NULL`, so an accidentally-`undefined`
field is a _destructive_ write rather than a no-op (proven); integer binding loses precision
identically in both engines, so no unit test can ever catch an overflow.

---

## R11-12 — `getPortalDownloadToken` is not product-scoped

**Severity: Low.** Cross-referenced with **R5-10**, which covers the trust dimension. The
data-layer observation: `repo.ts:1-3` and `admin/repo.ts:1-5` both state that _"EVERY query is
product-scoped … so the tenant boundary holds even on a logic bug"_.
`portal/repo.ts:613-616` is the counterexample — `SELECT * FROM release_download_tokens WHERE
token_hash = ?` with no `product`. Because the PK is `(product, token_hash)`, `token_hash` is
**not globally unique**: the PoC inserts the same hash under two products and both rows persist,
with `db.first` returning an arbitrary one (proven). The practical exploitability is nil (a
256-bit hash will not collide) but the stated invariant is broken and the missing index is a
real cost (R11-05). Fixing R11-05's unique index on `token_hash` also closes this.

---

## R11-13 — `customers` and `identity` are dead PII-bearing schema

**Severity: Info.**

- `customers` (`0007_backend_contracts.sql:6-31`) carries `sub`, `name`, `email`,
  `groups_json`, `metadata_json`, four indexes and a `CHECK` — and has **no reader or writer
  anywhere in `src/`** (`grep -rn "FROM customers|INTO customers|UPDATE customers"` → nothing).
  Only `devices.customer_id` (`repo.ts:928`, always written as the previous value or `null`) and
  `release_download_tokens.customer_id` (`portal/repo.ts:597`, always written as `null`) refer to
  it. A `deleted` status is defined that no code path can ever set.
- `identity` (`0001_init.sql:172-178`) — no `FROM identity` or `INTO identity` anywhere. Its
  role was superseded by `licenses.sub` + `idx_licenses_sub`.

Unused tables that are nonetheless _reachable_ from the D1 console and any future feature are
latent PII stores with no owner and no retention story. Either wire them up with the erasure
path from R11-09 or drop them.

---

# REFUTED

Eleven hypotheses — including the seeded ones — that did **not** hold up.

**1. "Key revocation may not work server-side" (seeded hypothesis 2) — REFUTED.**
`listVerificationProductKeys` (`repo.ts:324-334`) selects
`status IN ('active','staged','retired')`. `'revoked'` is **excluded**, so a revoked key is
dropped from `loadPublicSigningKeys` (`product.ts:67-81`) and therefore from the JWKS. `'retired'`
is **included by design** — `0006_hardening.sql:10` states it explicitly: _"Staged and retired
keys can still verify."_ The two spellings are not a bug; they are two different operations
(`retire` = stop signing, keep verifying; `revoke` = stop both), and `admin/handlers/products.ts:730-731`
implements exactly that distinction. Proven by PoC. The real defect in this area is Part B of
R11-07 (no guard against retiring the _active_ key), not the vocabulary.

**2. "`product` may not be column 1 of every relevant PK" (seeded hypothesis 5) — REFUTED.**
Enumerating all 31 tables and checking `PRAGMA table_info().pk == 1` shows `product` is the
first PK column on **all 25** product-scoped tables. The six exceptions are exactly the ones
`0008_portal.sql:1-3` documents as intentionally platform-global (`portal_accounts`,
`portal_account_emails`, `portal_account_identities`, `portal_license_links`, `portal_audit`)
plus `products` itself (PK `slug`). Proven by PoC. The scoping failures in this codebase are in
the _queries_ (R11-08, R11-12), not the schema.

**3. Dynamic-column SQL injection in `patchLicense` / `updateProduct` — REFUTED.**
`admin/repo.ts:35-48` and `:152-165` build `SET` clauses from `Object.entries(fields)`, which
looks injectable. Every call site (`admin/handlers/licenses.ts:232-268`, `:373-380`;
`admin/handlers/products.ts:177-198`) constructs the object with **hardcoded literal keys** and
only the _values_ come from the request body — and those are bound. `Partial<Pick<…>>` types
prevent a new key from being added without a compile error.

**4. License status/expiry may not be enforced — REFUTED.**
`licenseUsable` (`licenseCore.ts:142-149`) checks both `status !== 'active'` and `expires_at`,
and is called on the activation path (`licenseCore.ts:267`), the refresh path (`:474`), the
OIDC path (`oidc.ts:395`, `:420`) and the portal (`portal/api.ts:185`, `:245`). All four
license-key entry points (`licensing.ts:316`, `browserSession.ts:268`, `portal/api.ts:380`,
`admin/handlers/keys.ts:87`) additionally check `keyRow.status !== 'active'` and fail closed.
`deleteProduct`'s `status='disabled'` sweep therefore does take effect.

**5. Migrate-then-deploy ordering may be unsafe (seeded hypothesis 6) — REFUTED for the
ordering itself.** All 11 migrations are strictly additive: no `DROP TABLE`, no `DROP COLUMN`,
no `RENAME` anywhere, and every `NOT NULL` `ADD COLUMN` carries a `DEFAULT` (proven). Old code
running against the new schema only ever sees extra columns it ignores. `deploy.yml:51` before
`:58` is the correct direction. The migration problem is _replay_ (R11-04), not ordering.

**6. `D1.batch()` may not be atomic — REFUTED.** Cloudflare's documentation is explicit:
_"Batched statements are SQL transactions. If a statement in the sequence fails, then an error is
returned for that specific statement, and it aborts or rolls back the entire sequence."_
`SqliteDb.batch` (`db/sqlite.ts:29-35`) wraps in `db.transaction()` and matches (rollback proven
by PoC). No divergence. The atomicity problem is that most multi-step flows **do not use**
`batch` (R11-03), not that `batch` is weak.

**7. `RETURNING` support divergence — REFUTED.** No statement anywhere in `src/` uses
`RETURNING`. `insertPortalAccount` (`portal/repo.ts:105-124`) does the insert-then-select dance
instead, which works identically on both engines.

**8. `PRAGMA foreign_keys = ON` may be a production no-op that disables FK enforcement —
REFUTED as an exposure.** It _is_ effectively a no-op on D1 (Cloudflare's docs direct you to
`PRAGMA defer_foreign_keys` and do not offer `PRAGMA foreign_keys`), but D1 enforces foreign
keys by default, and better-sqlite3 also defaults to on (`PRAGMA foreign_keys` returns 1 in the
harness, proven). Both engines enforce. The problem is that there are almost no FKs to enforce
(R11-01), not that enforcement is off. Worth deleting the misleading lines from
`0001:7`, `0010:10`, `0011:7` so nobody relies on them.

**9. `portal_account_emails.email` as PK may enable account takeover via an unverified email —
REFUTED on the portal path.** `portal/auth.ts:113-128` computes `emailVerified` from
`payload.email_verified === true` and `:286` passes `email` only when verified. `linkEmail`
(`portal/repo.ts:212-240`) uses `ON CONFLICT(email) DO UPDATE SET verified_at = …` and
deliberately does **not** update `account_id`, so an existing binding cannot be stolen.
(The `src/oidc.ts` path _does_ skip `email_verified` — that is R5-01, a different lane.)

**10. Integer overflow as a test-vs-production divergence — REFUTED.**
`Number.MAX_SAFE_INTEGER + 10` is already rounded to `9007199254741000` by JavaScript before it
reaches either driver; both store the same value with `typeof = 'integer'` (proven). Identical
behaviour, so this is a shared gap (no bounds `CHECK`s anywhere — R11-02 part 2), not a
divergence.

**11. `upsertTier` may silently wipe `tiers.policy_fingerprint` — REFUTED.**
`admin/repo.ts:272-296` omits `policy_fingerprint` from both the `INSERT` column list and the
`ON CONFLICT DO UPDATE SET` list, so an admin tier edit **preserves** an existing value rather
than nulling it. `stmtInsertTier` (`repo.ts:494-513`) does write the column, so the resync path
sets it correctly. The residual issue is functional, not security: there is no admin API to set
a tier's fingerprint policy at all.

---

## Reproduction

```bash
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"
cd packages/worker
npx vitest run test/attack/R11-data.test.ts     # 44 passed
npx prettier --check test/attack/R11-data.test.ts
```

---

# Remediation

Applied on branch `lewd-owl` by the remediation lane owning `repo.ts`, `db/**`, `portal/repo.ts`,
`portal/api.ts`, `admin/repo.ts`, `admin/lib/**`, `admin/handlers/**` and `migrations/**`.

Full worker suite: **647 passed / 647** (`pnpm --filter @polaris-key/worker test`, Node 22).
`npx tsc --noEmit` clean; `npx prettier --check src test migrations` clean. Every PoC whose
attack no longer works was inverted in place and carries a `FIXED (<id>)` comment naming the
finding, so a regression fails loudly rather than silently re-passing.

## New migrations

| File                        | Contents                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0012_replay_guard.sql`     | Idempotent re-assertion of `idx_licenses_enroll_hwid`, `idx_licenses_origin`, `idx_licenses_sub`, `idx_product_keys_one_active`, `idx_product_keys_verify` |
| `0013_portal_auto_link.sql` | `ALTER TABLE portal_product_settings ADD COLUMN auto_link_enabled INTEGER` (one statement, nothing after it)                                               |
| `0014_device_seats.sql`     | `ALTER TABLE devices ADD COLUMN seat_no INTEGER` (one statement)                                                                                           |
| `0015_data_integrity.sql`   | Seat + hot-path indexes, the download-token unique index, `portal_audit(at)`, and 16 status/origin/numeric constraints                                     |
| `0016_drop_dead_pii.sql`    | Rebuilds `release_download_tokens` without `customer_id`, then drops `customers` and `identity`                                                            |

`0006_hardening.sql` and `0007_backend_contracts.sql` were reordered so their idempotent
statements run BEFORE their `ALTER TABLE ... ADD COLUMN`s. No existing migration's _effect_ on a
fresh database changed, and no file was renamed, so `d1_migrations` bookkeeping is untouched.

## What was fixed

### R12-02 — managed secrets are sealed at rest (High)

`admin/lib/managedSecrets.ts` is new. `applyOverrides` is now `async` and takes `(env, product,
…)`; a value under a `kind: "secret"` entry or a `secret: true` config entry is passed through
`keyvault.seal()` before it can reach `profiles.payload_json` / `licenses.overrides_json`.
Validation still runs on the plaintext, so catalog schemas are unaffected. AAD is
`pkey:v2:<product>:product-secret:managed:<key>`, binding a ciphertext to both the product and
the catalog key — a blob lifted between products fails the auth tag (asserted in the PoC).
A state-only update carries the stored (already sealed) value forward, so nothing double-seals.

`redactPayload` additionally blanks any value that _is_ a sealed envelope, whatever the current
catalog says — that is what closes the "v2 catalog drops the `secret` flag" arm of R12-01.

**Not a `.sql` migration for existing rows**: AES-GCM is not expressible in SQLite DDL.
`openManagedValue` is envelope-detecting, so legacy plaintext rows keep working and are re-sealed
on the next admin write (lazy migration). A one-shot backfill needs a Worker-side script — see
REPORTED below.

### R12-01 — redaction fails closed (Medium)

`admin/lib/redact.ts` — an entry that cannot be _positively_ classified as non-secret is blanked.
Unknown key ⇒ redact; null catalog ⇒ redact; sealed value ⇒ redact. `state`/`updatedAt` survive
so the admin UI keeps its change metadata. A key the catalog positively declares non-secret is
still echoed in full.

### R11-01 — silent data loss on profile delete (High)

`admin/repo.ts countLicensesUsingProfile` now counts `license_profiles` **and** `tiers.profile_id`
in one statement. Deleting a tier's baseline profile returns 409 instead of 200-and-silent-loss.

### R11-07 — status vocabularies + the bricking guard (Medium)

`0015` constrains `products.status`, `licenses.status`, `licenses.origin`, `keys_index.status`,
`devices.status`, `product_keys.status`. `admin/handlers/products.ts` now refuses
`retire`/`revoke` when `row.status === 'active'` (409), mirroring the `activate` arm; rotation is
unaffected because `activate` retires the outgoing key in the same batch. The `retired`/`revoked`
distinction was left exactly as R11 verified it.

**Constraints are expressed as `BEFORE INSERT/UPDATE` triggers that `RAISE(ABORT)`, not `CHECK`.**
SQLite has no `ALTER TABLE ... ADD CONSTRAINT`; a real CHECK means rebuilding six tables with all
indexes and foreign keys, on D1, with no wrapping transaction. Triggers are enforced by the same
engine at the same point and are additive. `.rejects.toThrow(/licenses.status/)` in the PoC.

### R11-02 / R3-02 — seat-count TOCTOU (High, DB half)

DDL shipped (`0014` + `0015`):

```sql
ALTER TABLE devices ADD COLUMN seat_no INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_seat
  ON devices(product, license_id, seat_no)
  WHERE status = 'authorized' AND seat_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_license_status
  ON devices(product, license_id, status);          -- also fixes R11-10
```

`repo.ts` gained `claimDeviceSeat(db, product, licenseId, deviceId, limit, now): Promise<boolean>`
— lowest-free-ordinal claim, retried against a UNIQUE violation, idempotent for a device that
already holds a seat, denying on `limit <= 0`. `setDeviceStatus(..., 'deauthorized')` now calls
`releaseDeviceSeat` alongside `purgeDeviceData`, so every deauthorize path frees the ordinal.
`Db` gained `runChanges()` (D1 `meta.changes` / better-sqlite3 `info.changes`), the primitive
that makes a conditional write atomic without a transaction.

Both device-limit columns now reject `<= 0` at the DB, and the tier/product admin handlers return
422, so a `0`/negative limit can no longer read as _unlimited_ through `licenseCore`'s `limit > 0`.

### R11-06 — guarded `_json` reads (Medium)

`admin/lib/shape.ts` exports `parseJsonColumn` / `parseJsonList`, now used by `licenseSummary`
(`channels_json`), `admin/handlers/licenses.ts` (`groups_json`, `reported_json`) and
`admin/handlers/tiers.ts` (`channels_json`). A corrupt column degrades to `[]`/`undefined`.

### R11-08 / R10-13 — the portal's per-request sweeps (Medium)

`idx_licenses_email_lower ON licenses(lower(email))` (deliberately **not** partial — SQLite will
not use a partial index whose condition it cannot prove from `lower(email) = ?`) and
`idx_licenses_sub_global ON licenses(sub) WHERE sub IS NOT NULL`. Both sweeps now measure as
`SEARCH licenses`.

### R5-01 / R5-02 — cross-tenant license injection (High)

Cross-product portal visibility stays, per the owner's decision. The join is hardened three ways
in `portal/repo.ts syncAccountLicenseLinks`:

1. **Issuer qualifier on the `sub` join.** The left side is always a platform-IdP subject
   (`portal/auth.ts` hardcodes `provider: "oidc"` with the issuer from `platformOidcConfig`), so
   the right side is restricted to licenses whose product also authenticates against the platform
   issuer: `AND COALESCE(o.provider, 'platform') = 'platform'`, derived from `oidc_config`. No new
   denormalised column, so the product-OIDC lane needs no change.
2. **`portal_product_settings.auto_link_enabled`**, tri-state. NULL = "auto" =
   `CASE WHEN COALESCE(o.provider,'platform') = 'custom' THEN 0 ELSE 1 END`, so a product on a
   tenant-controlled issuer is opted **out** by default — including one configured _after_ the
   migration. Settable via `PATCH /api/products/<slug>/portal {"autoLinkEnabled": true|false|null}`.
3. **Verified emails only**: `WHERE account_id = ? AND verified_at > 0`.

### R5-06 — capability aggregation (Medium)

`portalAuthCapabilities(db, product?)`. With a product it evaluates that product's row alone.
Without it, it keeps the platform aggregate for the one surface with no product context (the root
login page) — now an explicit, documented choice. `/api/capabilities?product=<slug>` exposes the
scoped answer.

### R5-10 / R11-12 / R11-05 / R9-05b — download tokens (Low)

`/download/<token>` carries no product, so the read cannot be product-scoped; instead
`idx_release_download_tokens_hash` makes `token_hash` globally unique (the real invariant for a
256-bit secret), which removes both the ambiguity and the `SCAN` on an unauthenticated,
unrate-limited endpoint. `getPortalDownloadToken` also pushes expiry and `used_at IS NULL` into
SQL. `markPortalDownloadUsed` is a compare-and-swap (`AND used_at IS NULL`, returns whether it
won) and `handlePortalDownload` 404s the loser — exactly one of N concurrent redemptions wins.
`purgeExpiredDownloadTokens` is called opportunistically from the download path.

### R11-09 / R11-13 / R12-10 — PII (Medium)

`deleteProduct` now nulls `licenses.email`, `.name`, `.sub`, `.groups_json`, `.enroll_hwid` and
deletes the product's `portal_license_links` in the same atomic batch. `customers` and `identity`
are dropped, along with `release_download_tokens.customer_id`. `idx_portal_audit_at` exists so a
retention job becomes expressible.

## REPORTED, not fixed

1. **[licensing lane — R11-02/R3-02] `licenseCore.authorizeDevice` still check-then-act.**
   Replace `licenseCore.ts:336-352`:
   ```ts
   const limit = resolveDeviceLimit(eff, product.defaultDeviceLimit);
   if (limit > 0) {
     const count = await countActiveDevices(db, product.slug, license.id);
     if (count >= limit)
       return { error: "device_limit", limit, deviceCount: count };
   }
   ```
   with the atomic claim (`repo.ts` already exports it):
   ```ts
   const limit = resolveDeviceLimit(eff, product.defaultDeviceLimit);
   if (limit !== null) {
     // null === unlimited; <= 0 is now impossible
     if (
       !(await claimDeviceSeat(
         db,
         product.slug,
         license.id,
         deviceId,
         limit,
         now,
       ))
     ) {
       return {
         error: "device_limit",
         limit,
         deviceCount: await countActiveDevices(db, product.slug, license.id),
       };
     }
   }
   ```
   `upsertDevice` needs no change — it does not list `seat_no` in its `ON CONFLICT ... SET`, so
   the ordinal survives the subsequent upsert.
2. **[licensing lane — R12-02] `resolveEffective` must open sealed managed secrets.**
   `licenseCore.ts:185` has no `env`. Thread it from the three callers (`licensing.ts:497`,
   `browserSession.ts:176`, `portal/api.ts:133`) and wrap the return:
   `return openManagedPayload(env, product, payload)` from `admin/lib/managedSecrets.ts`. Until
   that lands, a _newly written_ managed secret is sealed at rest but is pruned from the signed
   doc by `configDoc.validatePayload` (fail-closed: the ciphertext fails the catalog schema, so
   the key is dropped rather than delivered). Existing plaintext rows are unaffected.
3. **[ops — R12-02] One-shot re-seal backfill.** SQLite cannot AES-GCM, so `0016` cannot re-seal
   historic rows. Needs a Worker-side script that reads every `profiles.payload_json` /
   `licenses.overrides_json`, calls `sealManagedValue` for keys the active catalog marks secret,
   and writes back. `isSealedEnvelope` makes it idempotent.
4. **[R11-04] Full replay-idempotency of `0002/0003/0006/0007/0009/0010/0011/0013/0014`.**
   SQLite has no `ADD COLUMN IF NOT EXISTS` and no conditional DDL; the only pure-SQL route is a
   copy/drop/rename rebuild of five tables, which is riskier on D1 (no wrapping transaction) than
   the defect. What is fixed is _stranding_. Recommended instead: a post-migration assertion step
   in `deploy.yml` between `:51` and `:58` failing the deploy on a short count of
   `('idx_licenses_enroll_hwid','idx_product_keys_one_active','idx_licenses_sub','idx_devices_seat',
'idx_release_download_tokens_hash')`, plus a rollback runbook.
5. **[R11-09/R12-10] No `scheduled()` handler.** `index.ts` (out of lane) exports `fetch` only and
   `wrangler.toml` declares no `[triggers]`. `audit` and `portal_audit` therefore still grow
   without bound; `idx_audit_time` and the new `idx_portal_audit_at` support the deletes, and
   `purgeExpiredDownloadTokens(db, now)` is ready to be called from a cron. Also still missing:
   `DELETE /api/me` and a per-subject erase endpoint.
6. **[R11-06] Four unguarded `JSON.parse` outside this lane** — `oidc.ts:251`, `:266`, `:299`
   and `edgeMint.ts:207`. Route them through the same helper; `oidc.ts` already has
   `parseJsonColumn` and simply does not use it in those four places.
7. **[R11-01] Foreign keys.** No FK anywhere declares `ON DELETE`/`ON UPDATE`, and
   `keys_index`/`devices`/`license_profiles`/`portal_license_links` still have no FK to
   `licenses`. Adding them needs the same five-table rebuild as (4). The application-level guard
   is fixed; the schema-level one is not.
8. **[R11-11] `D1Db` swallows failed results** — `db/d1.ts` `r.results ?? []` / `?? null` never
   inspect `r.success`/`r.error`, and combined with `?? 0` defaults a swallowed error becomes
   _seat count 0_, i.e. fail-open on the device limit. Not changed here because turning silent
   empties into throws changes the failure mode of every read on the hot path and wants its own
   review. `runChanges` uses `r.meta?.changes ?? 0`, which fails CLOSED (a lost CAS).
9. **[R5-06] `portal/auth.ts`'s four `portalAuthCapabilities` call sites** stay on the platform
   aggregate — those flows genuinely have no product context. A real platform-level setting
   (rather than an implicit OR over tenants) is the correct end state.
10. **Deliberate out-of-lane edit**: `admin/api.ts:155` — `handleProfiles(req, env, db, …)`. Two
    tokens, no logic change; the profile payload editor cannot seal without `env`.
11. **Adjusted another lane's fixture**: `test/attack/R6-release.test.ts:1042` seeded an
    "incident lockdown" tier with `policy_device_limit = 0`, which under `limit > 0` meant
    UNLIMITED — the opposite of the test's intent — and is now refused by the DB. Changed to `1`.

---

# Remediation, round 2 — the residuals

Applied on branch `lewd-owl` by the remediation lane owning `src/index.ts`, `src/scheduled.ts`,
`src/repo.ts`, `src/portal/repo.ts`, `src/portal/api.ts`, `migrations/0017+` and `wrangler.toml`.
This round closes four of the items the first round left in **REPORTED, not fixed** above:
(5) no `scheduled()` handler, (5) no `DELETE /api/me`, (7) foreign keys with no `ON DELETE`, and
(4) replay-idempotency — the last one via the deploy-time index assertion R11-04 recommended in
place of the five-table rebuild it rejected.

Full worker suite: **736 passed / 736** (`pnpm --filter @polaris-key/worker test`, Node 22).
`npx tsc --noEmit` clean; `npx prettier --check src test migrations` clean.

## New migrations

| File                         | Contents                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `0017_portal_fk_cascade.sql` | Rebuilds the four portal tables with `ON DELETE CASCADE`; adds `idx_portal_audit_product_at`           |
| `0018_index_assertion.sql`   | Single-row `schema_index_assertion` whose `CHECK` aborts the migration when a required index is absent |

## Residual 2 — `scheduled()` (FIXED)

`src/index.ts` now exports `scheduled()` alongside `fetch`, and `wrangler.toml` carries
`[triggers] crons = ["17 3 * * *"]` — daily, 03:17 UTC. `triggers` is an **inheritable** wrangler
key (verified against wrangler's own config parser: `triggers: inheritable(...)`), so the single
top-level block covers `prod`, `staging` and `dev` without a per-environment copy. The odd minute
is deliberate: `0 3 * * *` puts the job in the same second as every other cron on the platform.

`src/scheduled.ts` is the handler. Four jobs, all product-scoped, all idempotent:

| Step                    | Statement                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `audit:<product>`       | `repo.pruneAudit` — `at < now - AUDIT_RETENTION_SECONDS`, via `idx_audit_time`          |
| `portalAudit:<product>` | `portal/repo.prunePortalAudit`, plus one `product IS NULL` pass for platform-level rows |
| `downloadTokens:<slug>` | `portal/repo.purgeDownloadTokensForProduct` — expired **and** spent                     |
| `seats:<product>`       | `repo.releaseDormantSeats` — now exported, product-wide                                 |

- **Retention is `AUDIT_RETENTION_SECONDS = 180 * 24 * 60 * 60`**, a named constant with the
  reasoning attached: under ~90 days the log stops covering the quarter-late discovery of the
  incidents it exists to serve, and `audit` rows carry `actor_email`/`actor_name`, so indefinite
  retention is the unbounded personal-data store R11-09 describes. Six months is two quarters of
  forensics with a stated bound. Not per-product config — a per-tenant deletion promise needs its
  own admin surface, audit trail and migration.
- **Product-scoped.** Every delete names one product. `portal_audit.product` is nullable, so the
  `product IS NULL` pass is a required arm, not an edge case; `idx_portal_audit_product_at` (0017)
  serves both (SQLite indexes NULLs).
- **Bounded.** `PRUNE_BATCH_ROWS = 500`, `PRUNE_MAX_BATCHES = 20`. `drain()` stops as soon as a
  pass comes back short, so a years-long backlog drains over consecutive nights and the steady
  state costs one statement. D1 gives the worker no statement timeout to rely on.
- **Fault-isolated.** Every job runs through `step()`, which catches and records. One poisoned
  product cannot cost every later product its retention pass. Failures are re-thrown by
  `handleScheduled` as a single aggregate naming every failed step, so the invocation is recorded
  as errored. It is `await`ed rather than `ctx.waitUntil`-ed precisely so the rejection is the
  handler's own outcome. No `console.*` — R12 asserts as a codebase-wide property that nothing
  under `packages/worker/src` writes to the runtime log, so the thrown aggregate is the whole
  diagnostic surface and is written to be read cold.
- **Soft-deleted products are included** (`repo.listAllProductSlugs`, deliberately _not_
  `listProducts`): their rows are the ones most in need of pruning.

`releaseDormantSeats` was private and licence-scoped. It is now exported with `licenseId`
optional; `claimDeviceSeat` still passes it for the just-in-time reclaim, the sweep omits it. This
matters beyond tidiness — under the just-in-time path alone, a 2-seat licence whose only two
devices went dark reads as **full** in the portal and the admin console until somebody tries to
activate a third.

Tests: `test/scheduled.test.ts` (18) — retention boundary at exactly 180 days, cross-tenant
non-reachability, idempotency of a duplicate cron delivery, multi-batch drain, soft-deleted
products, expired-vs-spent-vs-live tokens, seat reclamation leaving `status`/rows untouched, and a
fault-injecting `Db` proving one failed step does not abort the rest.

## Residual — `DELETE /api/me` (FIXED)

`portal/api.ts handleMeDelete` + `portal/repo.ts deletePortalAccount`. Authenticated (the handler
only ever erases `session.accountId` — there is no id in the path or body to tamper with),
CSRF-checked by the existing mutation gate in `handlePortalApi`, and rate-limited on the account's
own budget. It is dispatched **before** the per-request `syncAccountLicenseLinks` sweep: re-deriving
links for an account about to be deleted is waste, and a failure there must not be able to block
the account holder from deleting.

**No schema change was needed for the delete itself.** R11-09 calls `portal_account_emails.email`
being the PRIMARY KEY "structurally awkward", and it is — there is nowhere to record _"this address
was erased"_ that does not re-store the address. But that makes deleting the row the _correct_
reading of erasure rather than a compromise: a tombstone keyed on the address would retain exactly
the datum the person asked to have removed. Re-keying on a surrogate id, as the original fix
direction suggested, would have bought a tombstone nobody should want.

What is erased: `portal_accounts` (`primary_email`, `display_name`), `portal_account_emails`,
`portal_account_identities`, `portal_license_links`, and the account's `portal_audit` history.
What survives, deliberately: the product's own `licenses` row — a portal account is a _view_ onto
licences that already existed, and deleting it must unlink, not destroy a tenant's customer record
(per-product erasure is `deleteProduct`'s PII scrub) — and one terminal `portal.account.delete`
audit row carrying the opaque `acct_…` surrogate, no email, no name, no product. The account it
pointed at is gone, so the id resolves to nobody; what remains is a dated receipt that an erasure
happened, which is the one record an erasure must not delete.

The notice email is sent **before** the delete, because afterwards there is no address to send it
to. The session cookie is cleared on the way out, and the session stops validating regardless
(`requireSession` re-reads `portal_accounts`).

Tests: 9 in `test/portal.test.ts` — full erasure, the license row surviving untouched, the audit
receipt carrying no PII, the pre-delete notice, 401 without a session, 403 with a missing _and_ a
wrong CSRF token (account intact in both), and the cookie going dead immediately after.

## Residual 6 — foreign keys (PARTIALLY FIXED, deliberately)

`0017_portal_fk_cascade.sql` rebuilds `portal_account_emails`, `portal_account_identities`,
`portal_license_links` and `portal_product_settings` so their foreign keys declare
`ON DELETE CASCADE`. Those are the four where it genuinely reduces risk: the three children of
`portal_accounts` are the reason `DELETE /api/me` exists and the ones whose orphans would be _PII_,
and the fourth carries the same `products(slug)` edge as `portal_license_links`. All four are
small, have no triggers, no incoming foreign keys and at most one index each.

**Each rebuild is `create / re-assert / copy / drop / rename`, and every crash point converges.**
D1 runs a migration file with no wrapping transaction, so R11-04's half-applied schema applies to
rebuilds too. Dying before the drop is handled by `IF NOT EXISTS` + `INSERT OR IGNORE`. Dying
_between_ the drop and the rename is the sharp one — the original is gone, `_v2` holds the only
copy, and a naive replay dies on `SELECT … FROM <original>` with `no such table` and stays stuck
forever. The `CREATE TABLE IF NOT EXISTS <original>` before each copy closes it: the replay
recreates the original empty, copies zero rows into a `_v2` that already holds them all, drops the
shell and renames. Verified exhaustively: crashing after each of the 24 statements and replaying
twice yields byte-identical data and schema at all 24 points. (`0016_drop_dead_pii.sql` still has
the open window; it is one statement group and was left alone.)

**NOT rebuilt, and this is the recommendation, not an omission.** `licenses`, `devices`,
`keys_index`, `product_keys`, `products`, `tiers`, `audit`, `license_profiles` and `release_*` keep
their `ON DELETE`-less foreign keys. A `DROP TABLE` takes a table's triggers with it, so rebuilding
any of the first six means reconstructing the sixteen `RAISE(ABORT)` triggers 0015 hangs off them,
on D1, with no transaction; `licenses` alone carries five indexes including two partial-unique
security invariants. A rebuild that half-lands leaves a populated table with **no constraints**,
which is strictly worse than the missing `ON DELETE` it was fixing. They also do not need it:
nothing in `src/` hard-deletes a product — `deleteProduct` is a status flip plus a PII scrub — so
the parent row those keys point at is never actually removed.

`portal_license_links` also still has **no** FK to `licenses(product, id)`. Adding one would abort
the whole migration on any deployment already holding a link to a deleted license, because
`INSERT OR IGNORE` skips uniqueness/NOT NULL/CHECK violations but **not** foreign-key ones, and the
listing JOIN already hides such rows. Reported, not fixed. `ON UPDATE` is declared nowhere,
including on the rebuilt tables: a product slug and a portal account id are immutable primary keys,
so there is no update to cascade.

## R11-04 — the deploy-time index assertion (FIXED as recommended)

Replay-idempotency of the seven `duplicate column name` migrations remains unreachable in pure
SQL and is still not attempted. What R11-04 recommended instead now exists, in two halves that a
test pins to the same 17-name list so they cannot drift:

1. **Migration-time.** `0018_index_assertion.sql` counts the required indexes in `sqlite_master`
   and writes the result into `schema_index_assertion`, whose
   `CONSTRAINT required_indexes_are_missing CHECK (found = expected)` aborts the INSERT — and
   therefore `wrangler d1 migrations apply`, and therefore the deploy, which runs migrations
   _before_ `wrangler deploy` — on a short count. Idempotent (DELETE then INSERT). The header
   carries the diagnostic query to run when it fires.
2. **Runtime.** `scheduled.ts assertRequiredIndexes()` re-checks the identical list on every cron
   tick and throws naming every absentee. This catches what a migration-time check structurally
   cannot: an index dropped by hand after deploy.

Every name is an invariant whose absence is _silent_ — `idx_licenses_enroll_hwid`
(one-free-licence-per-machine), `idx_devices_seat` (the UNIQUE arbiter behind `claimDeviceSeat`),
`idx_product_keys_one_active`, `idx_release_download_tokens_hash`. Nothing errors when one is
missing; the constraint simply stops being enforced.

**Known limit, stated plainly:** `wrangler d1 migrations apply` records 0018 in `d1_migrations`, so
the SQL half runs **once per database** — on the deploy that introduces it, and on any database
built from scratch. That is the case R11-04 is about (a historical stranding is caught the first
time 0018 runs; a fresh apply that dies mid-file aborts the whole run anyway). Continuous
per-deploy coverage would need one extra CI step,
`npx wrangler d1 execute "$DATABASE" --env "$ENV" --remote --file migrations/0018_index_assertion.sql`,
in `.github/workflows/deploy.yml` between "Apply D1 migrations" and "Deploy worker" — that file is
outside this lane and currently being edited by another, so it is reported rather than taken.

## Adversarial tests inverted in place

- `R11-01 "NOT ONE foreign key … declares ON DELETE / ON UPDATE"` → now asserts the four portal
  tables **do** cascade while every other table still does not, plus a new test proving a
  `DELETE FROM portal_accounts` cascades to emails, identities and links.
- `R11-05 "every product-scoped table has product as PK column 1"` → `schema_index_assertion` added
  to `globalByDesign`; it is a single-row assertion about the schema and holds no tenant data.
- `R11-08 "migrations are additive only"` → `0017_portal_fk_cascade.sql` joins
  `0016_drop_dead_pii.sql` as an allowed rebuild. It changes no column and no name, only the
  foreign-key clause, so old code reads and writes the tables exactly as before.

## Still REPORTED, not fixed

1. **Per-deploy index assertion in `deploy.yml`** — see the known limit above.
2. **FKs on the product-scoped tables**, and `portal_license_links → licenses`. Rationale above.
3. **`0016_drop_dead_pii.sql`'s drop/rename window** is still open; 0017's pattern would close it.
4. **A per-subject erase endpoint.** `DELETE /api/me` erases a _portal account_. Erasing one
   person from one product's `licenses` still has no API; `deleteProduct` erases all of them.
5. **Retention is a compile-time constant.** No admin surface, no per-product override, and no
   audit record of the retention policy itself.
6. Items 1–4 and 6–11 of the first round's REPORTED list that this round did not touch.

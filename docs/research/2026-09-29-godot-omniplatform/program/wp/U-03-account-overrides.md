# U-03 Account override layer replacing licence config overrides everywhere: `account_overrides`, `overrideAccount` with the licence-owner fallback, console editor, its merge hook, and the platform-wide migration with inventory, notice and report

| Field       | Value                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                 |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                        |
| Depends on  | [U-02](U-02-principal-binding.md), [I-05](I-05-accounts-core.md), [I-12](I-12-console-users.md)                                                                                                               |
| Unblocks    | [U-12](U-12-privacy-settings-portal.md), [U-11a](U-11a-console-data-settings.md)                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                            |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                                                                                      |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); console CSP parity; the eight §5.12 tests; signed corpus unchanged (asserted); migration dry run on a production-shaped copy |
| Human input | owner schedules the production migration run, no earlier than the notice window after I-07 and I-11 are both live in production (decision 21)                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** `override_migration_report`; the account layer applies outside `if (license)`; provisioned secrets; the LX-09 seam (§6.3).
- **[`plans/I-24.md`](../plans/I-24.md):** Q6: a device on a named-user seat gets the seat user's own account layer, not the licence owner's. Licence overrides still apply to every device of the licence.

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Floating comes from LX-26's helpers** ([LX-26](LX-26-licence-holders-worker.md)). "Floating
  licences get no account layer" is decided by `isFloatingLicense` and `floatingLicenseSql`
  (`core/accountSubjects.ts`: no account and no email, where a blank or spaces-only email counts as
  none). The holder model, the licence list's filter and Cloud Sync's principal
  (`resolveSyncPrincipal`) use the same predicate. `overrideAccount` (`overrideSubject` in
  `plans/U-01.md` §6.3) calls it instead of testing `account_id` or `email` itself, and checks it
  before the device's binding, as `resolveSyncPrincipal` does: a floating licence has no account
  features whatever binding the device carries (S-24, owner, 2026-10-06).
- **The D19 decision: Remove from my library** (lead decision under the owner's delegation, 2026-10-06, on
  [S-24](../../notes/S-24-licence-holders.md) D19; [PX-23](PX-23-portal-floating-keys.md)
  implements the core). An explicit **Remove from my library** clears the Cloud Sync principal of
  the removing account's devices for that licence. The auto-attach block row
  (`license_auto_attach_blocks(product, license_id, account_id)`) marks the pair. For this package:
  `overrideAccount` reads `device.subject` first, so a device bound by that account's sign-in would
  still get that account's layer for a licence it removed. Apply the same pair check there, so
  Config agrees with Cloud Sync: a device whose licence carries a block for the account its binding
  resolves to gets no account layer from that account. There is no owner fallback either, because
  a removed licence has no `account_id`. Use the predicate PX-23 adds rather than a second one.

## Goal

The licence-level config override layer is gone on every product. Operators write user-level managed config for one account on one product (`account_overrides`), Core merges it where licence overrides sat, licence-key devices on owned licences keep their values through the owner fallback, floating licences get no account layer, and one platform-wide migration moves owned licences' overrides and drops unowned ones with an operator-visible report.

## Why

Owner decisions 3 and 4 ([S-17 owner decisions](../../notes/S-17-user-data-sync.md), [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions)): removed everywhere, replaced by the account override; overrides on licences with no owner dropped at migration, no grace period.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/U-01.md`.
- [S-17 owner decisions](../../notes/S-17-user-data-sync.md), [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision) (all of it), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks) (account merge), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-03, [S-17 §7.1](../../notes/S-17-user-data-sync.md#71-risks) risk 6, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decisions 3, 4, 20 and 21.
- `packages/worker/src/core/payload.ts:137-142`, `packages/worker/src/admin/lib/overrides.ts`, `packages/worker/src/admin/lib/managedSecrets.ts`, `packages/worker/src/core/authz.ts:140-190`, `packages/worker/src/core/entitledAccess.ts:161`.

## Scope

**In:**

- `account_overrides (product, subject)` with `config` and `secrets` sealed under `PLATFORM_KEK`; `TABLE_OWNERS`.
- Merge order: catalog defaults → tier profile → licence profiles → store grants → **account overrides** → device overrides.
- `overrideAccount(device) = device.subject ?? subjectFor(license.account_id, product) ?? none`.
- Console editor on I-12's Users row and an admin route (rule 10). The layer and its editor exist on every product, Identity on or off: the account is platform-level and I-12's Users page is Core's, not gated by the Identity toggle (owner clarification, 2026-10-04). The licence page says "No account: managed config for this customer needs an account" with the portal link (an offer to the customer, never forced). This owner fallback is Config's only: Cloud Sync has none (owner, 2026-10-04, final answers).
- The account-merge hook: rows re-keyed to the surviving pairwise subject (D21: the survivor's subject wins, the other becomes an alias, the developer gets `subject.merged`), per-key surviving value, collisions reported ([S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks)).
- **The migration** ([S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision) steps 1–5): daily inventory and notice in the console; owned licences merged into the owner's row (multi-licence collapse by most recently updated, listed in the report); unowned licences' overrides dropped with an audit row each and a 90-day report (secret values by name only); freeze of `PUT /licenses/<id>/overrides` for `config` and `secrets` (`entitlements` stay writable there); `payload.ts` stops reading licence config and secrets in the same release.

**Out** (and where it belongs instead):

- Cloud Sync data (→ U-05); export and deletion of account overrides (→ U-12).

## Design notes

- Entitlement overrides stay on the licence on every product, floating ones included (decision 20, decided by the owner 2026-10-04 in the final answers): step 4's freeze makes `PUT /licenses/<id>/overrides` accept only `entitlements`, refusing `config` and `secrets`; the signed licence document's inputs do not change.
- The notice must not start before I-07 and I-11 are live in production; the run is an owner-scheduled step after the notice window (decision 21, decided: 30-day notice, 90-day report).
- The config document's shape, signing and corpus are unchanged; ETags change correctly with the layer.
- T16 is intended: the owner fallback delivers only what the licence override delivered before ([S-17 §5.14](../../notes/S-17-user-data-sync.md#514-threat-model-deltas)).

## Corrections from the code (U-03, 2026-10-06)

Where the brief and the code disagreed, the code won:

- **The layer's reads and the migration are Core's** (`core/accountOverrides.ts`,
  `core/overrideMigration.ts`): `core/payload.ts` merges the layer, License's override route
  enforces the freeze and Identity's OIDC provisioning writes secrets to it, and no service may
  import another (rule 6). The tables stay Config's (`TABLE_OWNERS`), and Config registers the
  subject store (`services/config/accountOverrideStore.ts`).
- **`overrideAccount` is `overrideSubject`** (plans/U-01.md §6.3's name). Its signed-in line IS
  the Cloud Sync principal (`resolveSyncPrincipal`), with every check it makes: an authorized
  device, a live or aliased subject, never a floating licence even with a binding, a missing
  licence row fails closed. PX-23 (not yet on `main` at hand-off) adds S-24 D19's "removed from
  this account's library" check to the principal; `overrideSubject` makes the same check itself
  (`removedFromAccountLibrary`, with a test), so "Remove drops the account's layer for that
  licence" holds whatever order the two merge in. The owner line reads `existingSubjectFor`, not
  `subjectFor`: rows exist only for subjects that exist, so a document GET never writes.
- **Expand-phase order.** Until the run completes, the licence's whole override column is still
  read, BELOW the account layer, so documents are byte-identical until an operator writes an
  account row. That is also why a value already on the account row wins a collapse at the run.
- **The collapse rule, precisely:** "the licence whose overrides were updated most recently" is
  the licence whose config and secret entries carry the latest `updatedAt` (else its
  `modified_at`), ties by licence id; a value already on the owner's row beats every licence's.
- **A third table, `override_migration`** (one platform-level row: prerequisites, notice, run,
  progress, lease, daily inventory). The plan's §6.2 lists two tables; the state had to live
  somewhere, and it is product-less by design (added to R11-05's list with its reason).
- **The report has a `subject` column**, so U-02's registry guard requires a store to claim it:
  the Config store claims both tables (a merge re-keys a subject's report rows, a deletion removes
  them).
- **The registry guard requires `merge`, `delete` and `export`** from every store that claims a
  table, so U-03 implements the store's delete and export hooks (secrets by name only). U-12 keeps
  the person-facing export and deletion surfaces.
- **R11-08's attack check** ("no table named like `%migration%`", meaning no `d1_migrations`
  bookkeeping in the harness) now excludes the two U-03 data-migration tables by name; every other
  name still counts.
- **"I-07 and I-11 flagged live"** are operator-set flags on the state row
  (`PUT /manage/api/platform/override-migration/prerequisites`): nothing in the Worker can observe
  a production rollout. The notice's conditional write is the guard.
- **The run is resumable and bounded:** up to 25 products per call under a lease, report rows as
  the per-licence progress marker, the step-up on the route. The freeze starts at the run's start,
  the retirement at its completion. The run does not rewrite licences: the nightly job empties
  their config and secrets after the 90-day report window (step 5), so a rollback inside the
  window still finds the values.
- **Merge collisions are listed in the product's activity log** (`user.overrides.merge`, with
  non-secret values). The registry hook runs before Identity's merge batch and `subject_events`
  takes only Identity's own `subject.merged` payload, so S-17 §5.5's "subject.merged audit row"
  is this audit row.
- **Provisioned secrets** (S-19 §8 U-03 row): from the run's start, `activateFromIdentity` and the
  sign-in rewrite put the provisioning's declared secret keys on the licence OWNER's account row,
  sealed (`activateFromIdentity` gained `opts.env`, passed by all four callers), and keep only the
  entitlement half on the licence. A licence with no owner gets none, by decision 4: an OIDC
  licence not yet in an account (djdl's `proxy.subscriptionUrl`) stops receiving the secret at
  the run. The inventory lists those licences before the notice ends.
- **Seats (plans/I-24.md Q6)** need no code here: no seat code exists yet (I-24a is todo), and a
  seat device is signed in as the seat user, so the signed-in line gives the seat user's own layer.
- **Entitlement-only merge callers** (`resolveEntitlements`, `licenseDeviceLimitInfo`,
  `core/entitledAccess.ts`, `core/syncAccess.ts`) pass `entitlementsOnly` and never read the
  account layer, so the licence document's hot path gains no reads; their answers are identical
  (the buckets are disjoint).
- **Rule 10 for platform routes.** `admin/handlers/platform.ts` kept its admin routes narrative-only
  by convention; this brief's gate puts every U-03 route in the OpenAPI spec and routeCoverage's
  `ADMIN_KIND_PATHS`, plus `PUT …/licenses/{licenseId}/overrides`, whose contract changed.
- **Catalog key usage** (`config/catalog/usage`) also answers `accounts`; after the run a licence
  uses a key only through its entitlements.
- **"Byte for byte, apart from timestamps"**: a catalog default's `updatedAt` is the request time
  (`catalogDefaultPayload`), so test 1 compares documents minted at the same instant; their ETags
  match too.
- **The migration is `0103_account_overrides.sql`**, the number the lead assigned (built as
  `00XX_account_overrides.sql`); `LATEST_MIGRATION` names it.
- **Review round 1 (2026-10-06):** the run's account-row write is a compare-and-set on the row
  it planned from (a unit's report and audit rows are written only if it applied; a changed row
  is re-planned, up to three times per call); the lease has a holder, is renewed per product and
  is cleared only by its holder (`run_lease_holder`); the licence route's freeze check and its
  config write are one conditional UPDATE; the claim path clears every declared secret key;
  `deleteProduct` deletes the product's account overrides and report; the RUNBOOK and the console
  say what decision 4 costs OIDC licences with no account.
- **Test 8** (the signed corpus is unchanged) is the gate's `pnpm gen corpus --check`: no signed
  shape, claim or fixture changes.

## Steps

1. Table, merge position and `overrideAccount` with the eight tests.
2. Console editor and admin route; merge hook.
3. Inventory, report and the migration with a production-shaped dry run.
4. Freeze `config` and `secrets` on `PUT /licenses/<id>/overrides` (entitlements stay) and retire licence config and secrets in `payload.ts`.

## Acceptance criteria

- [x] The eight tests listed in [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision) pass.
- [x] Dry run on a production-shaped copy produces the inventory and report; secret values never appear (test).
- [x] `gen corpus --check` unchanged.
- [x] The migration notice cannot be started before I-07 and I-11 are flagged live (test or guard).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header. At
      hand-off every step was green except `test/recordDeploy.test.ts`, which refuses an
      unnumbered `00XX_` migration by design; with the lead's number (0103) it passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- payload overrides migration
mise exec node@22 -- pnpm gen corpus --check
```

## Hand-off

- U-11a shows account overrides on the Data tab; U-12 exports and deletes them; U-15a writes the operators' migration notice.
- Follow-ups from the review (2026-10-06), not done here:
  - **N3:** batch the plan's reads (owners' subjects with `existingSubjectsFor`, their account
    rows in one query) and check the cost against the production dry run;
  - **N5:** an `If-Match` (ETag of the stored row) on `PUT …/users/<subject>/overrides`, so the
    console's compare-and-set covers the operator's whole edit session, not only the server's
    read-to-write window;
  - **N9:** bound the nightly inventory per tick (a cursor over products), like the report purge
    and the column emptying;
  - **PX-W12's undo gap:** a merge's hook folds the absorbed account's row into the survivor's and
    deletes it, so an undo cannot give it back. Keep the absorbed row verbatim, still sealed, for
    the 72-hour undo window (PX-W12's snapshot, or a store-side copy) if an exact undo of operator
    config is wanted.

The role agent sets `--set U-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-03 done`.

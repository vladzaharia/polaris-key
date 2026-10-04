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

## Steps

1. Table, merge position and `overrideAccount` with the eight tests.
2. Console editor and admin route; merge hook.
3. Inventory, report and the migration with a production-shaped dry run.
4. Freeze `config` and `secrets` on `PUT /licenses/<id>/overrides` (entitlements stay) and retire licence config and secrets in `payload.ts`.

## Acceptance criteria

- [ ] The eight tests listed in [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision) pass.
- [ ] Dry run on a production-shaped copy produces the inventory and report; secret values never appear (test).
- [ ] `gen:corpus -- --check` unchanged.
- [ ] The migration notice cannot be started before I-07 and I-11 are flagged live (test or guard).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- payload overrides migration
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- U-11a shows account overrides on the Data tab; U-12 exports and deletes them; U-15a writes the operators' migration notice.

The role agent sets `--set U-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-03 done`.

# U-02 Principal binding: Core's `resolveSyncPrincipal` and `subjectFor` over I-05's device binding, the one clearing hook's Cloud Sync cases, and the merge- and deletion-hook registry with its guard test

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                            |
| Size        | 0.6–0.85 engineer-weeks                                                                  |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [I-05](I-05-accounts-core.md)                           |
| Unblocks    | [U-03](U-03-account-overrides.md), [U-05](U-05-cloud-sync-do.md)                         |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | THREAT-MODEL; boundaries test (rule 6); no account id in any S-17 row or Cloud Sync key  |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

Core resolves a device to its Cloud Sync principal and an account to a product's subject without importing Identity: `resolveSyncPrincipal(device)` and `subjectFor(account, product)` exist over I-05's device binding, the one clearing hook covers Cloud Sync's cases, and the merge- and deletion-hook registry fails a test for any subject-keyed store without hooks.

## Why

Cloud Sync is the first device-writable data service; a slip is a cross-tenant or cross-account leak ([S-17 §7.1](../../notes/S-17-user-data-sync.md#71-risks) risk 1). Account merge re-keys data, so every store must register its hooks in the package that creates its data ([S-17 §7.1](../../notes/S-17-user-data-sync.md#71-risks) risk 8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`, `plans/U-01.md`.
- [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model) (principal), [S-17 §5.8](../../notes/S-17-user-data-sync.md#58-security) item 2, [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-02, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 2.
- `packages/worker/src/core/devices.ts:136-142`, `packages/worker/src/core/hooks.ts`, I-05's binding and registry code.

## Scope

**In:**

- `resolveSyncPrincipal(device)` → `(product, subject)` as `devices.subject ?? subjectFor(license.account_id, product)`, the same rule as Config's account-override line (owner clarification, 2026-10-04: Cloud Sync depends on the account, not on the product's Identity toggle). The signed-in line works only on products with Identity on; the licence-owner line works on every product, so a device on a product without Identity gets a principal once its licence is attached to an account. Floating licences with no binding resolve to "no principal" (`account_required`). Merge aliases resolve to the surviving subject (D21); a deleted subject resolves to "no principal".
- `subjectFor(account, product)` for Config's owner fallback and Cloud Sync's licence-owner line (creates the subject on first use).
- Clearing-hook cases for Cloud Sync: sign-out, disable, deletion, sign out everywhere, relink of the device's licence; not plain detach (the binding stays, but a detach ends the licence-owner line, so an unbound device on that licence resolves to no principal).
- The guard test over the merge and deletion registries.

**Out** (and where it belongs instead):

- The binding column and its migration (done in I-05; correction recorded in U-01's brief).
- Hook bodies (→ U-03, U-05).

## Design notes

- Licence-key activation never sets `devices.subject` (test); a key-activated device reaches a principal only through the licence-owner line. The binding is never signed.
- **Principal change.** A detach or relink changes what the licence-owner line resolves to; Cloud Sync answers the next request for the old subject with `account_required` (or the new subject's state), and the SDK handles it like sign-out (U-06 and siblings).
- **Residual risk, Identity-off products** ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 22, proposed): with no `license_owned` refusal there, anyone holding an owned licence's key can enrol a device and reach the owner's Cloud Sync data through the licence-owner line. Mitigation: the owner is emailed on each new device on an owned licence and can remove it in the portal (I-11), which ends its access. Add the test that a removed device resolves to no principal.
- Rule 6: Cloud Sync and Config call Core, never Identity.

## Steps

1. Accessors with alias and deletion cases.
2. Clearing-hook cases and the registry guard test.

## Acceptance criteria

- [ ] A licence-key activation never sets the binding (test); every clearing trigger clears it (tests).
- [ ] An aliased subject resolves to the survivor; a deleted one to no principal (tests).
- [ ] A key-activated device on an owned licence resolves to the owner's subject on a product with Identity off and on; after detach it resolves to no principal; a floating licence never resolves (tests).
- [ ] The guard test fails on a subject-keyed store without merge and deletion hooks.
- [ ] The `boundaries` test passes; no S-17 row or key holds the account id.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- devices boundaries sync
```

## Hand-off

- U-03 reads `subjectFor`; U-05 reads `resolveSyncPrincipal`.

The role agent sets `--set U-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-02 done`.

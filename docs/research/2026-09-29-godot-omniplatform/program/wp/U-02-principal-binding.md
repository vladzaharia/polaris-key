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

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** `syncAccess`, and the no-owner-fallback test (§2.1, §6.1).

## Corrections and decisions recorded during implementation (2026-10-05)

The code is the fact; these record where it differed from the text above, and the open questions
decided with the recommended option (the owner delegated decisions to the lead).

- **Already in I-05.** `subjectFor`, `resolveSubject`, `clearDeviceSubjects` with every Cloud Sync
  reason (`signout`, `signout_everywhere`, `account_disabled`, `account_deleted`,
  `product_removed`, `relinked`), and its callers for disable, deletion, per-product removal and
  relink were merged with I-05. U-02 adds `resolveSyncPrincipal` (`core/accountSubjects.ts`),
  `syncAccess` (new `core/syncAccess.ts`), a test per trigger, and the registry guard.
- **Sign-out callers.** `POST /<p>/identity/signout` (I-09) and the sign out everywhere surface
  (I-11) do not exist yet; the hook's `signout`/`signout_everywhere` cases are tested directly and
  those packages call it. The existing browser-session logout (`/identity/auth/logout`) now runs
  the hook before deauthorizing its device.
- **Stale binding on re-bind (fixed).** `bindDevice`/`registerDeviceBinding` carried
  `existing.subject` into every re-bind, so a key re-entry on a revoked device, or a move to another
  licence by key, resurrected the old account as the principal. Fix round (review, 2026-10-06):
  carrying it even on an authorized device on the same licence let open re-registration by device
  id, or key re-entry, inherit the signed-in account's principal. Any re-bind without a sign-in now
  writes `subject = NULL`; only `opts.subject` (an Identity sign-in) binds.
- **Floating licences have no account features (S-24, owner ruling 2026-10-06).**
  `resolveSyncPrincipal` also reads the device's `license_id` and returns `null` when that licence
  is floating (`account_id IS NULL` and no email), whatever binding the device holds, and also
  when the licence row it names does not exist (fail closed). A device that names no licence
  (`NO_LICENSE_ID`) is unaffected: a License-off product's device, and equally a keyless device
  registered on a License-on product with `registration: "open"` (S-24 decides floating from a
  licence's facts, and such a device has no licence). LX-26 moved the rule into one exported
  helper, `isFloatingLicense` (with `floatingLicenseSql` for list filters), and made
  `resolveSyncPrincipal`'s `license_id` required, as on `DeviceRow`. The check lives in
  `core/accountSubjects.ts` (the scan test bans `account_id` in `core/syncAccess.ts`). A plain
  detach still keeps the binding; the principal is hidden while the licence floats. This
  supersedes the brief's and THREAT-MODEL's earlier "a floating licence has a principal once
  someone signs in".
- **`resolveSyncPrincipal` shape.** `(db, device) → {product, subject} | null`; a non-`authorized`
  device or a malformed value resolves to `null` as well.
- **`syncAccess` shape.** `(db, product, device, now) → {subject, anchorUsable, licensed,
entitlements, topTier} | null` (`null` = no principal). `topTier` is the anchor's tier id
  (`tiers.rank` does not exist before S-19's LX packages); `anchorUsable` is scoped as
  `coreDeviceAllowed` (true when the License service is off).
- **No-owner-fallback test.** The `licensing.entitlementHolder` setting does not exist yet (LX-\*);
  `syncAccess` reads no holder setting, so the test covers an owned licence on a key-activated
  device and another account signed in on the owner's device. LX-09 keeps the test when it swaps
  the body.
- **Guard mechanics.** `SubjectStore` gains optional `tables` and `durableObjects` declarations and
  `subjectStores()`; the guard (`test/subjectStores.test.ts`) requires `merge`, `delete` and
  `export` of every store (plan §6.1), classifies every table with a `subject`/`*_subject` column
  and every `wrangler.toml` Durable Object class, and refuses an `account_id` column on a claimed
  table. `export` stays optional in the type until I-11 calls it.

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

- `resolveSyncPrincipal(device)` → `(product, subject)` as `devices.subject` only, after one check against Identity's subject table (owner, 2026-10-04, final answers): Cloud Sync needs sign-in, so there is no licence-owner fallback. A device with no binding (key-activated, floating licence, never signed in) resolves to "no principal" (`account_required`). Merge aliases resolve to the surviving subject (D21); a deleted subject resolves to "no principal".
- `subjectFor(account, product)` for Config's account-override owner fallback only (creates the subject on first use); Cloud Sync never calls it.
- Clearing-hook cases for Cloud Sync: sign-out, disable, deletion, sign out everywhere, relink of the device's licence; not plain detach.
- The guard test over the merge and deletion registries.

**Out** (and where it belongs instead):

- The binding column and its migration (done in I-05; correction recorded in U-01's brief).
- Hook bodies (→ U-03, U-05).

## Design notes

- Licence-key activation never sets `devices.subject` (test), so a key-activated device has no Cloud Sync principal until it signs in. The binding is never signed.
- **Principal change.** A clearing trigger or a merge alias changes what the binding resolves to; Cloud Sync answers the next request for the old subject with `account_required` (or the survivor's state), and the SDK handles it like sign-out (U-06 and siblings).
- Rule 6: Cloud Sync and Config call Core, never Identity.

## Steps

1. Accessors with alias and deletion cases.
2. Clearing-hook cases and the registry guard test.

## Acceptance criteria

- [ ] A licence-key activation never sets the binding (test); every clearing trigger clears it (tests).
- [ ] An aliased subject resolves to the survivor; a deleted one to no principal (tests).
- [ ] A key-activated device on an owned licence and a floating licence both resolve to no principal; the same device after sign-in resolves to its pairwise subject (tests).
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

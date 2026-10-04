# I-11 Portal as the Library: Library, Discover (Add to library), Activate License modal, product pages with a reserved Cloud Sync section, account settings (sign-in methods, Profile, devices and sessions, connected apps), export and deletion, the one Core revocation hook

| Field       | Value                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                            |
| Size        | 1.6–2.25 engineer-weeks                                                                                           |
| Depends on  | [I-05](I-05-accounts-core.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md)                 |
| Unblocks    | [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [U-12](U-12-privacy-settings-portal.md)              |
| Role        | `pkey-implementer`                                                                                                |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                          |
| Gates       | D1 migration; `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; privacy docs; console CSP parity |
| Human input | none                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                         |

## Goal

The customer portal becomes the account's home, a proto-Steam Library: Library (default), Discover with "Add to library", the Activate License modal, product pages with a reserved Cloud Sync section, and account settings (sign-in methods, Profile, devices and sessions, connected apps, privacy), with per-product and full export and deletion. It owns the one Core revocation hook.

## Why

The owner chose a Steam-like account home ([S-16 owner decisions](../../notes/S-16-identity-service.md)); the portal is a platform concern for every product (G10, D7). The Activate License modal is where key entry turns into accounts, and the Library must be live before S-17's migration notice starts ([S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (portal), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes) (registry tokens), [S-16 §5.7](../../notes/S-16-identity-service.md#57-portal-surface), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-11, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 12; [S-17 §5.15](../../notes/S-17-user-data-sync.md#515-how-it-composes) (portal).
- [`plans/F-20.md`](../plans/F-20.md) and the F-21 brief; `packages/worker/src/services/identity/portal/{session,repo,api,auth}.ts`; `docs/design/BRAND.md`.

## Scope

**In:**

- **Library:** every licence attached to the account, grouped by product: tier, entitlements, devices (with remove), downloads, support link. Floating licences appear only once attached.
- **Discover:** products whose auto-issue policy makes this account eligible; Add to library mints the licence through the sign-in auto-issue path.
- **Activate License modal:** paste a key; if not signed in, each entry prompts the account upgrade, skippable while entries remain and forced at the limit; the licence then attaches under the claim rules; `/activate?product=<slug>` deep links preselect the product.
- **Product page:** licence details, devices, downloads, export my data for this product, remove my data from this product (with "also remove the licence from my Library", D25), and a reserved Cloud Sync section shown only when the product has that service on (filled by U-12).
- **Account settings:** sign-in methods (connect and disconnect under step-up, last-method guard, audited and emailed; link-existing-account merge; QR sign-in on another device), Profile (choose a linked provider's name or picture, or upload), devices and sessions with sign out everywhere, connected apps with consented claims and revoke, privacy (full export; account deletion soft for 14 days, then hard).
- Per-product and full export and deletion call I-05's deletion registry (Cloud Sync and account overrides hook, U-12).
- The one Core revocation hook (licence detached or account deleted) against I-04's contract; extend F-21's if it landed first.

**Out** (and where it belongs instead):

- The Cloud Sync section's content (→ U-12); console pages (→ I-12).

## Design notes

- **Portal UI follows the brand system** (`docs/design/BRAND.md`, and `docs/design/PORTAL.md` once it lands); do not invent a parallel design.
- F-21 is a soft dependency only: whichever lands first writes against I-04's hook contract ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 12).
- Cloud Sync appears only on product pages of products with the service; never a global Cloud Sync page.
- Account deletion: removes the account and all links, cascades to sessions, passkeys, grants, personal details and R2 avatars, every pairwise subject and all account × product data, detaches licences (D27), scrubs audit rows to a tombstone id, and records a tombstone re-applied after any D1 restore ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

## Steps

1. API and data for Library, Discover and product pages.
2. Activate License with the upgrade prompt and limit.
3. Account settings, merge flow and sessions.
4. Export, deletion and the revocation hook.

## Acceptance criteria

- [ ] At the entry limit the modal cannot be skipped and the licence attaches only under the claim rules (tests).
- [ ] Add to library mints a licence only for eligible auto-issue products (test).
- [ ] Removing the last sign-in method is refused; every link change needs step-up and sends an email (tests).
- [ ] Per-product removal deletes account × product data and the subject but keeps the licence unless chosen (test).
- [ ] Account deletion cascades as above and survives a simulated restore through the tombstone list (test).
- [ ] Detaching a licence revokes F-20 licence-bound tokens through the one hook (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal identity revocation
```

## Hand-off

- U-12 fills the Cloud Sync section and the export and deletion hook; U-03's migration notice starts only once I-07 and I-11 are live.

The role agent sets `--set I-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-11 done`.

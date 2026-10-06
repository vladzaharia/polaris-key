# LX-26 Licence holders on the Worker: a derived `holder` (floating or assigned, in an account or waiting) on licence reads and list filters, association at creation when an account verified the email, one `onAccountEmailVerified` Core hook, `license_auto_attach_blocks` so a removed licence stays removed, holder audit

| Field       | Value                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                                                               |
| Size        | 0.6–1 engineer-weeks                                                                                                                                             |
| Depends on  | [I-05](I-05-accounts-core.md)                                                                                                                                    |
| Unblocks    | [LX-27](LX-27-create-limit-delivery.md), [LX-28](LX-28-bulk-floating-keys.md), [LX-30](LX-30-console-holder-surfaces.md), [PX-23](PX-23-portal-floating-keys.md) |
| Role        | `pkey-implementer`                                                                                                                                               |
| Plan mode   | no                                                                                                                                                               |
| Gates       | D1 migration; `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; workerd                                                                         |
| Human input | none                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                        |

## Corrections (as built, 2026-10-06)

Where the brief and the code disagreed, the code was the fact:

- **A fourth list filter, `inAccount`.** `holder=floating|assigned|waiting` cannot express LX-30's
  "In an account" filter (`assigned` is in an account or waiting), so the list also takes
  `holder=inAccount`. An unknown value is `400 bad_request` (`fields: ["holder"]`).
- **The "Added to your library" notice is not reused for an email attach.** It exists as
  `licenseAddedNotice` (`portal/notices.ts`, "<Product> is in your library"), sent on a portal key
  claim (`portal/selfService.ts`), but its copy says the licence was added "with a license key",
  which is false for an association by email. S-24 D11 and D12 make LX-27's key email ("Your
  <Product> license", sent in the create request) the person's message for a licence the
  developer assigned. `attachLicense`'s own notice goes only to a licence email the account has
  NOT verified (S-16), which an email attach never is, so `via: "email"` sends nothing.
  Follow-up for LX-27: a "from <Developer>" variant of the library notice, if a separate notice is
  wanted for an association that happens after creation (at the email's first verification).
- **Removal keeps the email, so the licence reads assigned and waiting, not floating.** The
  acceptance ("another account that verifies the email still can") needs the email kept; the
  derived holder of an email-bearing licence with no account is assigned/waiting. PX-23's
  "Remove ... becomes floating" copy should say "not in an account" (follow-up for PX-23).
- **There is no portal "Remove from my library" route on `main`.** `detachLicense` is reached by
  I-12's console detach today; PX-23 adds the portal route. The tests call `detachLicense` as the
  portal will.
- **The hook is `onAccountEmailVerified(db, accountId, email, now)`** (`core/licenseHolders.ts`),
  implemented by Identity (`services/identity/accounts/holders.ts`) and registered with Core at
  module load, like a subject store; the creation direction is `associateLicenseHolder`. It
  re-checks that the address is verified on the account. The link sweep's email half is its body,
  run per verified address, so every sign-in on `main` (portal OIDC, the card's code, register,
  gate and provider sign-ins through `finishSignIn`, device login) reaches it through the sweep it
  already runs; `linkIdentity` (adding a sign-in method in Account) calls it directly. PX-W15 and
  I-08 are not on `main`; they call the hook when they land, and the per-request sweeps stay.
- **`reassignLicense` writes a block for the account it moves a licence away from and lifts the
  block of the account it moves it into**, so a relink's undo deletes the block the relink wrote.
  A key or device claim (`attachLicense` with `via: key | device`) lifts the claimer's block too.
- **Both halves of the sweep honour the block** (a licence's `sub` re-attached it as well as its
  email), and every automatic attach is now audited (`account.license.attach`, `email` or `oidc`);
  before, the sweep attached silently.
- **Also removed with their owner:** an account deletion deletes its blocks, and a licence
  deletion deletes the licence's (`coreLicenseDeleteStatements`; `licenseDelete.test.ts` claims
  the table).
- **Floating is one helper** (U-02 follow-up): `isFloatingLicense` and `floatingLicenseSql` in
  `core/accountSubjects.ts`; an email that is empty or only spaces counts as none. Create and PATCH
  store the email trimmed, blank as `NULL`.
- **Rule 10:** the admin licence routes were narrative only. `GET`/`POST …/license/licenses` and
  `GET`/`PATCH …/license/licenses/{licenseId}` are now in the spec (tag `admin`, `routeCoverage`'s
  `products` kind); `DELETE` stays narrative.
- The migration is `0092_license_auto_attach_blocks.sql`; the lead numbered it 0092.

## Goal

Every licence read says whether the licence is **floating** or **assigned** (in an account, or
waiting for its email), an assigned licence joins the account that verified its email at creation
or at the moment of verification (not only on portal requests), and a licence the holder removed
from their library stays out of that account.

## Why

The owner ruled on 2026-10-06 that a licence is floating or assigned, nothing else
([S-24](../../notes/S-24-licence-holders.md) R2, §5.1). The facts exist (`licenses.account_id`,
`licenses.email`) but no read exposes them, association by email runs only inside portal handlers
(S-24 H4), and removing an email-bearing licence from the library is undone by the next portal
request (H5: `detachLicense` keeps `email`; `syncAccountLicenseLinks` re-attaches it).

## Read first

- AGENTS.md (rules 6 and 10) and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §4 (H2–H5, H13), §5.1–§5.5, §6.1, §6.3, §7 (D1–D4,
  D19).
- `packages/worker/src/services/identity/portal/repo.ts` (`syncAccountLicenseLinks`,
  `AUTO_LINK_ENABLED_SQL`, `linkLicense`), `services/identity/portal/api.ts:500,613,1201`,
  `portal/auth.ts:382,524`.
- `services/identity/accounts/claim.ts` (`evaluateAttach`, `attachLicense`, `detachLicense`,
  `reassignLicense`), `accounts/repo.ts` (`verifiedAccountEmails`), `accounts/merge.ts`.
- `services/license/admin/licenses.ts` (create, list, read, PATCH), `core/accountSubjects.ts`.

## Scope

**In:**

- **`holder` on reads.** `GET …/license/licenses` and `GET …/licenses/<id>` answer
  `holder: {kind: "floating"} | {kind: "assigned", inAccount: boolean, email?: string}` (the
  licence's own `email`; never the account's details) computed from `account_id` and `email` (D1;
  no column). List filters `holder=floating|assigned|waiting`.
- **Association at creation** (D3): `POST …/license/licenses` with an `email` attaches the licence
  in the same request when an account has verified that address and the product's auto-link
  resolves on, through `attachLicense(…, via: "email")` (pairwise subject, `account.license.attach`,
  the "Added to your library" notice). The response never says which happened (D4): it answers the
  same `holder` shape the read would, and the console decides what to show.
- **`PATCH` assigns.** Setting `email` on a floating licence assigns it (and attaches as above);
  clearing `email` on an assigned licence is refused with `400 bad_request` with a message pointing at Make floating (an existing code; Make floating is
  LX-30's I-12 action).
- **One Core hook, `onAccountEmailVerified(accountId, email)`,** called wherever an address becomes
  verified (portal sign-in, the card's code and register steps, the email gate, provider sign-in,
  adding an email in Account). It runs the email half of `syncAccountLicenseLinks` for that address.
  The per-request calls in `portal/api.ts` stay until I-07 and PX-W15 call the hook, then go.
- **`license_auto_attach_blocks(product, license_id, account_id, created_at)`** (Core-owned,
  `TABLE_OWNERS`): `detachLicense` writes a row; the sync, the creation-time attach and the hook skip
  blocked pairs; `mergeAccounts` moves rows to the survivor; `reassignLicense`'s undo deletes the row
  it created. Audited `account.license.auto_attach_block` in `portal_audit`.
- **Audit**: `license.create` summary gains `holder`; `license.holder.assign` on a PATCH that
  assigns.
- OpenAPI and `routeCoverage` for the new members and filters (rule 10).

**Out** (and where it belongs instead):

- Delivery, `deviceLimit` on create, Send a new key (→ LX-27). Batches (→ LX-28).
- Console surfaces (→ LX-29, LX-30). Portal copy (→ PX-23).
- Make floating and Reassign (→ LX-30 on I-12's relink tool).

## Design notes

- A waiting licence on a product whose auto-link resolves off (custom issuer, R5-01) joins only by
  key with a verified matching email; `holder` still says assigned, and the console explains it.
- The creation-time attach must not leak timing either: run the lookup on every create with an
  email, whatever the outcome.
- Legacy rows need no migration: email + no account is assigned and waiting.
- THREAT-MODEL: T-H2 (no account enumeration through the console) and T-H4 (a removed licence does
  not return).

## Steps

1. Migration for `license_auto_attach_blocks`; `TABLE_OWNERS`; the block reads in the sync and in
   `attachLicense(via: "email")`.
2. `holder` computation, read members, list filter; OpenAPI.
3. Creation-time and PATCH association; `onAccountEmailVerified` hook and its callers that exist on
   `main`.
4. Tests: create with an email of a verified account attaches; of an unknown email waits;
   detach then `/api/me` does not re-attach; merge moves blocks; undo removes its block.

## Acceptance criteria

- [x] `holder` is correct for floating, waiting and in-account licences, including legacy rows
      (tests).
- [x] A licence created for a verified account's email is attached in the same request; one for an
      unknown email waits and joins at the email's first verification (tests).
- [x] After **Remove from my library**, no portal request, sign-in or verification re-attaches it to
      that account; another account that verifies the email still can (tests).
- [x] The create answer is the same shape whether or not an account exists (test).
- [x] OpenAPI and `routeCoverage` pass; THREAT-MODEL rows T-H2 and T-H4 added.
- [x] The green gate passes (AGENTS.md), including the migration and workerd checks. The
      migration is `0092_license_auto_attach_blocks.sql` (the lead's number) and `LATEST_MIGRATION`
      names it. The gate ran before the numbering, with the file under a provisional number,
      because `recordDeploy.test.ts` refuses a `00XX_` placeholder as `LATEST_MIGRATION`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license identity portal routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- LX-27, LX-28, LX-29, LX-30 and PX-23 read `holder`.
- `onAccountEmailVerified` is the hook I-07, PX-W15 and I-08 call when they land.

The role agent sets `--set LX-26 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-26
done`.

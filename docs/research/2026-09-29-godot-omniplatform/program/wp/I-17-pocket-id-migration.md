# I-17 Move `provider: platform` end users from Pocket ID to the Polaris Key account by claim at next sign-in; Pocket ID becomes operator-only

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                   |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                  |
| Depends on  | [I-03](I-03-console-oidc-client.md), [I-07](I-07-login-card-email.md)                                                                                    |
| Unblocks    | none                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                 |
| Gates       | D1 migration; THREAT-MODEL; `check:links`; rollout runbook; owner sign-off                                                                               |
| Human input | owner sign-off on the rollout and the sunset date (set after the email-less count); optional: a Pocket ID admin API key, only if a bulk export is wanted |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Migrated users enrol their passkeys again** ([I-16](I-16-passkeys.md)). Pocket ID passkeys are
  bound to `rp_id = id.plrs.im`; Polaris Key's are bound to the console host (`CONSOLE_ORIGIN`:
  `key.plrs.im`, staging `key-staging.plrs.im`), so none carries over. A migrated account starts
  with no passkey. The runbook and the migration's notice say so, and the post-sign-in nudge
  (`GET /api/me/passkeys` → `canAdd`) offers **Add a passkey** once the email is verified.
- **The platform `/callback` join offer** ([PX-W15](PX-W15-email-gate.md)). `signInRefusal`
  (`portal/auth.ts`) still answers a platform-OIDC `join_offer` with a 409 page that sends the
  person away. SIGN-IN.md D-34 routes it into the email gate's join step (`card/gate.ts`,
  `email_in_use`, both accounts proven in one session), which is also this package's "conflicting
  email gets the join offer" criterion. PX-W15 left it until PX-21 renders that step. It moves here
  or to PX-21 (recorded in both); whichever does it says so in its hand-off, and the other drops
  it.
- **The contract phase drops `accounts.terms_json`** ([PX-W15](PX-W15-email-gate.md)). PX-W15 moved
  terms acceptances to `account_terms_acceptances` (migration 0091). `accounts.terms_json` (I-05's
  `0068_a_accounts.sql`) stays, neither read nor written, while migrations are expand-only. The
  contract-phase migration after this package (`plans/I-04.md` §6.1: the `portal_*` tables and
  `idx_licenses_sub` "stay until a contract-phase migration after I-17") drops it too, with
  `terms_json` in `AccountRow` (`accounts/repo.ts`).

## Goal

`provider: platform` end users move from Pocket ID to the Polaris Key account, by claim at each user's next sign-in, and Pocket ID becomes operator-only.

## Why

Operators and customers should not share a directory ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 1); end users leave Pocket ID, operators stay (owner).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (Pocket ID facts), [S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-17, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 11.
- `packages/worker/src/platformOidc.ts`, `packages/worker/src/services/identity/oidc.ts`, `docs/RUNBOOK.md`.

## Scope

**In:**

- On a `provider: platform` sign-in, match the Pocket ID subject to an account by its verified email (`email_verified` claim) or create one, keeping a temporary `oidc:https://id.plrs.im` link.
- Email-less subjects keep that link until a sunset date set after a count.
- Runbook for the rollout; optional bulk export only with an owner-issued admin API key.

**Out** (and where it belongs instead):

- Console operator sign-in (stays on Pocket ID; I-03 gave it its own client).

## Design notes

- **Pocket ID facts (lead, 2026-10-04).** `email_verified` is in `claims_supported` [M]; the admin REST users endpoint answers 401 without an admin API key [M]. So this migrates by claim at next sign-in.
- The sunset date follows the count, never precedes it.
- Migrating by email here is not "linking by email match across accounts": the Pocket ID subject is the same person's previous Polaris sign-in, and it lands on an account only if no other account holds that email. Otherwise the email step offers to join that account, with both proven in one session (the person signs in to the existing account by any of its methods), and never joins silently (owner, 2026-10-04).
- Migrated accounts are ordinary accounts for dormancy: no sign-in and no licence for 36 months means a warning email, then deletion (D23, decided by the owner 2026-10-04).

## Corrections against the code (I-17 builder, 2026-10-06)

- **Two front doors, not one.** The portal's **Continue with single sign-on** (`/login` →
  `/callback`) already ended in I-05's `signIn`, so it already made accounts with the Pocket ID
  subject as an `oidc` link keyed by the issuer. The `provider: platform` product sign-in
  (`/<p>/identity/auth/*`, `oidc.ts`) made only `sub`-keyed licences (I-04 §8 Q6). The claim is
  therefore mostly the product path's: `services/identity/accounts/platformMigration.ts`
  (`claimPlatformSubject`), called from both callbacks. On the portal it adds the join offer,
  `operators-only` and the sunset.
- **The switch is two deploy-time vars**, off by default: `PLATFORM_OIDC_MIGRATION`
  (`off` | `claim` | `operators-only`) and `PLATFORM_OIDC_SUNSET` (`YYYY-MM-DD`, unset). Not a
  console setting: the AT-2 deny-list refuses OIDC-named platform settings, and a console session
  should not move people between sign-in paths. Both are `NOT_A_SETTING` rows and inventory vars.
- **The join offer is the email step's** (I-07's gate, `beginProviderSignIn`): the portal callback
  opens it for a conflicting address, and it joins only with the other account proven in the
  same browser. Its card UI is PX-21 (todo); until then the person lands on the sign-in card and
  signs in to the other account as before. A product route cannot open the gate (it never sees
  the account realm's cookies, I-07), so the app's "signed in" page links to the portal's
  single sign-on instead. Two or more accounts on the address: nothing written, nothing offered.
- **Licences attach** through the portal's existing link sweep (`syncAccountLicenseLinks`) after
  the flow's licence is activated (the browser callback, the I-26 chooser, the device-code poll),
  so the R5-01/R5-02 and first-attach rules are unchanged. A moved person's later app sign-ins
  therefore meet I-26's licence chooser (their account owns the licence) until I-08 replaces it.
- **No D1 migration.** `account_links`, `accounts` and `licenses` hold everything; the count reads
  them. No `TABLE_OWNERS` change.
- **The count** is `GET /manage/api/platform/identity-migration` (platform admins; counts only;
  works with the mode off). It cannot be read from this repository, so the PR reports it as
  pending: the owner reads it after deploying this build with both vars unset (RUNBOOK).
- **No bulk export**: optional, and no admin API key was issued.
- **Review fix round (2026-10-06), lead decisions.**
  - **B1: the portal's single sign-on is bound to its browser, in every mode.** `/login` sets
    `__Host-pkey_sso` (random, `SameSite=Lax`, ten minutes, in `ACCOUNT_REALM_COOKIES`) and the
    flow keeps its peppered hash; `/callback` refuses any other browser with the generic "We
    couldn't confirm that sign-in" before exchanging the code, and clears the cookie once used.
    This deliberately changes `off` behaviour too: it closes the login CSRF this path had (R8-03;
    `R8-oidc.test.ts` now asserts the fix), and the planted-join attack the review proved in
    `claim` mode (regression test in `identityPlatformMigration.test.ts`). A flow minted before
    the binding existed is refused; the person starts again.
  - **N3:** `signIn` keeps a provider address another account uses as unverified on an existing
    method, as the gate's `createAccount` does, so no address is verified on two accounts.
  - **N5:** a `provider: platform` product's `/auth/start` (the page) and `/device/start`
    (`404 disabled`, the answer a device client already gets when sign-in is off) refuse past the
    sunset before anyone is sent to the IdP.
  - **N9 (follow-up, not changed):** a disabled account's subject still signs in to a product
    through its floating `sub`-keyed licence, as before I-17.

## Steps

1. Claim-on-sign-in path with tests.
2. Count of email-less subjects; runbook.

## Acceptance criteria

- [x] A platform user with a verified email lands on one account on next sign-in (test); a conflicting email gets the join offer (both accounts proven in one session, never joined silently) (test).
- [x] Email-less subjects keep signing in through the temporary link (test).
- [ ] Runbook updated; the count is reported in the PR. Runbook: done (RUNBOOK "Moving end users
      off the platform IdP (I-17)"). The count: **pending**, it can only be read from production
      (`GET /manage/api/platform/identity-migration` after deploying this build with both vars
      unset); the owner reads it and the lead records it in the RUNBOOK's decision table.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header (lead
      gate, scoped: GREEN 2026-10-06; no D1 migration, so no `TABLE_OWNERS` change).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity platform
```

## Hand-off

- The owner sets the sunset date from the count.
- Follow-up (N9, pre-existing): a product sign-in through the platform IdP for a subject whose
  account is disabled still completes on its floating `sub`-keyed licence; the claim does not
  refuse it. Owner: whoever takes account disable across product sign-ins (the login card's
  `signIn` refuses a disabled account; the legacy product flow never consults it).

The role agent sets `--set I-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-17 done`.

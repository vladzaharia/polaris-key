# PX-W15 Email gate (G31): gate record per sign-in, verified-provider fast path, code path on the I-02 store, terms acceptances per version, `email_in_use` hand-off, no tokens before the gate passes

| Field       | Value                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                    |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                     |
| Depends on  | [I-02](I-02-single-use-store.md), [I-05](I-05-accounts-core.md)                                                                                                                            |
| Unblocks    | [PX-21](PX-21-email-gate-ui.md)                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                         |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); D1 migration (next free number at the final gate); `TABLE_OWNERS`; THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                  |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- The email gate is already built on `wp/I-07-login-card-email-gate` (`card/gate.ts`). Reconcile with it before building: this package keeps only what that branch does not ship, and its copy follows SIGN-IN.md §3.5.

## Goal

A first sign-in through a provider passes a server-held email gate: a provider-verified address (Google `email_verified: true`, Apple) confirms at once, otherwise `POST /api/signin/confirm-email` sends a code on the I-02 store and `…/verify` confirms; terms acceptances are stored per account, product and terms version; a confirmed email owned by another account returns `email_in_use` with a link hand-off; no session or app token is issued before the gate passes.

## Why

The first provider sign-in must not ship without the gate ([PORTAL.md §11.4](../../../../design/PORTAL.md#114-order), [PORTAL.md §4.29](../../../../design/PORTAL.md#429-confirm-your-email-first-provider-sign-in)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.29](../../../../design/PORTAL.md#429-confirm-your-email-first-provider-sign-in), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)
- `wp/I-05-accounts-core.md`, `wp/I-07-login-card-email.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- Gate record, verified-provider fast path, code path, terms acceptances, `email_in_use` hand-off; D1 migration and `TABLE_OWNERS`.

**Out** (and where it belongs instead):

- UI (→ PX-21)
- Profile import (→ PX-W16)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **THREAT-MODEL:** unverified provider emails, Apple relay addresses (`privaterelay.appleid.com`), takeover through a claimed email; `email_in_use` only after proof.
- **Overlap with the re-cut S-16/S-17 graph:** I-07 also names the required first-provider-sign-in interstitial. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W15:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W15 in-review`.

## Acceptance criteria

- [x] Tests: Google unverified → code; Apple relay → no code; Steam → empty field; no token before pass. Google rule (lead, 2026-10-06): Gmail verified → no code; Workspace with a matching `hd` → no code; non-Gmail without `hd` → code; `hd` mismatch → code.
- [x] The migration and `TABLE_OWNERS` entry land together; OpenAPI and `routeCoverage` cover every route.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Corrections from the code (implementer, 2026-10-06)

- **I-07 shipped the gate.** The gate record (I-02's single-use store, `__Host-pkey_gate`), the
  verified-provider fast path, the code path (`issueEmailCode`/`verifyEmailCode` bound to the
  gate's record), the `email_in_use` join offer and its proof rules, cancel and the picture proxy
  are all in `services/identity/card/gate.ts`, with their routes already in OpenAPI and
  `routeCoverage`. PX-W15 adds no route and builds only what that branch did not ship.
- **PX-W4 is not a prerequisite.** The gate's code path already runs on I-02's primitives; nothing
  here waits for PX-W4's account email code.
- **Terms acceptances per version.** I-07 kept only the latest version per product in
  `accounts.terms_json` (`plans/I-04.md` §6.1), so a new version overwrote the record of the old
  one. PX-W15 moves them to `account_terms_acceptances` (one row per account, product and version,
  written once; migration `0091_account_terms_acceptances.sql`, the lead's number; `TABLE_OWNERS`
  identity), read and written through `accounts/terms.ts`. A merge moves the absorbed account's
  rows to the survivor, account deletion and product deletion erase them. `terms_json` stays but
  is neither read nor written; there is no backfill because no deployed Worker ever wrote it (no
  front door passes a product's terms before I-08 and I-09).
- **Per-account `emailConfirmedAt` (G31) is `accounts.primary_email_verified_at`** (I-05), which
  the card sees as the gate view's `emailRequired`. It is not added to `/api/me` here: the account
  views belong to I-11 and PX-W16.
- **"No token before the gate passes."** Account-bound app tokens arrive with I-08. Today the
  gate is the only response that sets the account session and the only one that hands back the
  passthrough `request` (PX-W13), and every session-gated route refuses the gate cookie; the
  tests pin both at every step before the pass.
- **Product terms reach the gate only through I-08 and I-09** (`identity.requireTerms`); I-06's
  callbacks pass no product context yet, so the terms path is exercised through
  `beginProviderSignIn` in the tests.
- **Left as is:** the platform-OIDC (`/callback`) `join_offer` page (SIGN-IN.md D-34). Routing it
  into the gate before PX-21 renders the step would land people on a screen the portal cannot
  show yet; it moves with PX-21 or I-17.
- **Google's `email_verified` is narrowed (lead decision under the owner's delegation,
  2026-10-06).** A Google address counts as provider-verified, with no code, only when
  `email_verified` is true AND it is `@gmail.com`/`@googlemail.com` or the token's `hd` claim
  equals its domain (Workspace), case-insensitively; otherwise the gate asks for a code as for a
  typed address. Apple, private relay included, is unchanged. I-06's Google module passes the
  signed `hd` claim through (`hostedDomain`), and the gate applies the rule to the identity as it
  enters (`providerVouchesForEmail`), so the Google link also stores such an address as
  unverified and it claims no licence. This closes the residual THREAT-MODEL recorded; SIGN-IN.md
  §3.5 and §4.6, the OpenAPI operation and the portal page say so. I-07's and I-06's tests that
  relied on a verified non-Gmail Google address now give it a matching `hd`.
- The tests are `test/portalEmailGate.test.ts` (matched by the Verify filter) beside I-07's
  `test/identityCardGate.test.ts`.

## Hand-off

PX-21 builds `EmailGate`.

The role agent sets `--set PX-W15 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W15 done`.

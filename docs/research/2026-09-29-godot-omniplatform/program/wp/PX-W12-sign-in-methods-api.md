# PX-W12 Sign-in methods and linking API (G27): methods list, connect flows, disconnect with step-up and the last-method refusal, join accounts with proof of both and 72 h undo, audit and notices

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 1–1.6 engineer-weeks                                                                                                    |
| Depends on  | [I-05](I-05-accounts-core.md), [I-16](I-16-passkeys.md), [I-07](I-07-login-card-email.md)                               |
| Unblocks    | [PX-13](PX-13-account-v2.md), [PX-15](PX-15-after-sign-in.md)                                                           |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

`GET /api/me/methods`, `POST /api/me/methods/:kind/start` and its callback, `DELETE /api/me/methods/:id` (fresh step-up ≤ 5 min, `last_method` refusal), and `POST /api/me/link/start|confirm` (proof of both accounts, block on conflict, 72 h undo) exist, every change audited and emailed to all verified addresses.

## Why

Sign-in methods are the account's core ([PORTAL.md §4.26](../../../../design/PORTAL.md#426-account)); linking without proof of both is an account-takeover path ([PORTAL.md §4.11](../../../../design/PORTAL.md#411-link-an-existing-account)). PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.11](../../../../design/PORTAL.md#411-link-an-existing-account), [PORTAL.md §4.26](../../../../design/PORTAL.md#426-account), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `wp/I-05-accounts-core.md`, `wp/I-07-login-card-email.md`, `wp/I-16-passkeys.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- The methods and linking routes on I-05's links model; audit and notices (PX-W7 templates).

**Out** (and where it belongs instead):

- UI (→ PX-13, PX-15)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Providers** (owner decisions): one login card for every entry; the provider row is logo-only Apple, Google and Steam, filtered per product by where it ships; no Discord anywhere.
- **THREAT-MODEL (takeover via linking):** join needs proof of both identities in one session; disconnect needs fresh step-up; never orphan an account.
- **Overlap with the re-cut S-16/S-17 graph:** I-11 and I-05 also name sign-in methods, step-up disconnect and the link-existing-account merge. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W12:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W12 in-review`.

## Corrections from the code (PX-W12 builder, 2026-10-06)

- **`last_link`, not `last_method`.** I-05's link engine and I-16's passkey removal already answer
  the registered `last_link` (409) for the account's last sign-in method; G27's `last_method` would
  be a second code for the same refusal (errors.json, eight copy locales, every SDK's constants).
  The methods routes reuse `last_link`; the acceptance criterion below says so.
- **Step-up is the existing rule:** a sign-in no older than 5 minutes (`STEP_UP_MAX_AGE_SECONDS`),
  checked when each change lands. "Use your passkey to disconnect (or an email code)" is signing in
  again on the card with that method; there is no separate assertion endpoint.
- **Connect callbacks are the providers' registered sign-in callbacks.** `POST
/api/me/methods/<provider>/start` puts `purpose: "connect"` (with the account and its session row)
  in the same single-use flow record, so `/login/<provider>/callback` finishes a connect without new
  redirect URIs at Google, Apple or Steam. `email` connects by a code (`POST
/api/me/methods/email/verify`); `passkey` hands over to I-16's registration routes.
- **Join = the existing primitive.** Both the card's join offer and Link an existing account end in
  `accounts/merge.ts`; the 72-hour undo is a snapshot that `mergeAccounts` writes in its own batch
  (`account_merges`, migration `0098_account_merges.sql`, the number the lead assigned) and
  `accounts/mergeUndo.ts` replays. Routes: `GET /api/me/link`, `POST /api/me/link/start|confirm|
cancel|undo`. The two proofs are collected in one browser by a `__Host-pkey_link` flow cookie
  while the session moves to the other account on the login card.
- **"Block on conflict"** is `link_conflict` for a method another account holds, plus
  `merge_pending`: an account that can still undo a join of its own is never absorbed, so the undo
  stays possible. Developers keep the `subject.merged` alias after an undo (`subject_events` has a
  CHECK that allows only merged and deleted); the restored account gets a fresh pairwise subject
  where its old one became an alias (THREAT-MODEL "Sign-in methods and joining accounts").
- **Not in G27, left for PX-13:** "Make primary" for an email, a passkey's Rename, and the
  products each method brought in. Removing the primary email promotes the oldest other address.

## Acceptance criteria

- [x] Never-orphan tests: removing the last method returns `last_link` (the registered code; see the corrections above).
- [x] Join requires both proofs; undo works within 72 h (tests).
- [x] Every change writes an audit row and sends a notice (tests); OpenAPI and `routeCoverage` cover every route.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header. (Builder, 2026-10-06: every step green except `test/recordDeploy.test.ts`, which refused the then-unnumbered migration by design; with the lead's number, 0098, it passes.)

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-13 builds `SignInMethods`; PX-15 builds `LinkAccounts`.

The role agent sets `--set PX-W12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W12 done`.

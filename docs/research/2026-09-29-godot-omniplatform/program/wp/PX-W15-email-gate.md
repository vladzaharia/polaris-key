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

- [ ] Tests: Google unverified → code; Apple relay → no code; Steam → empty field; no token before pass.
- [ ] The migration and `TABLE_OWNERS` entry land together; OpenAPI and `routeCoverage` cover every route.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-21 builds `EmailGate`.

The role agent sets `--set PX-W15 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W15 done`.

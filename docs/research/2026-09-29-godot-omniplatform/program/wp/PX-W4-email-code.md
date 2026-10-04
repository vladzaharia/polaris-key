# PX-W4 Email code for the account sign-in on the I-02 single-use store

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                  |
| Depends on  | [I-02](I-02-single-use-store.md)                                                                                        |
| Unblocks    | [PX-12](PX-12-login-card-v2.md)                                                                                         |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

The account sign-in accepts a six-digit email code issued and consumed atomically on the I-02 single-use store, with rate limits in the `_portal` buckets and enumeration-safe responses, so the login card can offer "Email me a code" next to the magic link.

## Why

Codes work across devices where links do not ([PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code)); I-02's atomic store makes them safe. PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- the I-02 single-use store (`wp/I-02-single-use-store.md`)
- `packages/worker/src/services/identity/portal/auth.ts`, `packages/worker/src/services/identity/portal/email.ts`

## Scope

**In:**

- Code issue and verify routes for the account sign-in on the I-02 store.
- Rate limits in the `_portal` buckets; enumeration-safe responses.

**Out** (and where it belongs instead):

- UI (→ PX-12)
- Product email login inside apps (→ I-07)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Overlap with the re-cut S-16/S-17 graph:** I-07 also names email codes for the login card. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W4:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W4 in-review`.

## Acceptance criteria

- [ ] Responses are identical for known and unknown addresses (test).
- [ ] A code is single-use under concurrent verify (test on the I-02 store).
- [ ] OpenAPI and `routeCoverage` cover the new routes.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-12 renders `CodeEntry` against these routes.

The role agent sets `--set PX-W4 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W4 done`.

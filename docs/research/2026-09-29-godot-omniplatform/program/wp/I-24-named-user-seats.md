# I-24 Named-user seats: user claim in the licence `profile`, seat holders on the device binding, per-user caps

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (later)                                                                  |
| Size        | 1–2 engineer-weeks                                                                                                                          |
| Depends on  | [I-05](I-05-accounts-core.md)                                                                                                               |
| Unblocks    | none                                                                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                       |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-24.md` first; it needs human approval before code                                                  |
| Gates       | plan mode; signed corpus regeneration; all six SDKs (`parity:check`); D1 migration; `TABLE_OWNERS`; generated docs pages (`gen-docs` drift) |
| Human input | none                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Goal

Named-user seats: a licence can name N users with M devices each, with a user claim in the licence document's `profile` and seat holders recorded on the device binding.

## Why

Keygen `maxUsers` and Cryptlex named-user licences are table stakes for teams ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J10). It changes the signed licence document, so it is a corpus and all-SDK event ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-24.md` once approved.
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J10, [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (last row), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-24, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D9; [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) ("I-24 reuses `devices.subject`").
- `packages/shared-protocol/src/license.ts:7-13` (`DocProfile`), `docs/security/WIRE-CONTRACT-V4.md:875` (P4-19 precedent).

## Scope

**In:** the plan, the additive `profile` member, seat holders on the existing device binding (no `holder_account_id` column), per-user caps, corpus regeneration, all six SDKs.

**Out** (and where it belongs instead):

- B2B organisations (later, no package yet).

## Design notes

- Optional and deferred; the owner's D9 keeps the licence document account-free until this lands.

## Steps

1. Plan, approved. 2. Corpus, then SDKs.

## Acceptance criteria

- [ ] Corpus regenerated; every SDK verifies the new member; parity rows updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None planned.

The role agent sets `--set I-24 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-24 done`.

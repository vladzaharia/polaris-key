# U-16 Developer-backend Cloud Sync API for `ownerRead` and `server` collections, addressed by pairwise subject, with layer 2 issuer client credentials

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U4 later)                                                            |
| Size        | 0.8–1.1 engineer-weeks                                                                     |
| Depends on  | [U-09](U-09-collections-backend.md), [I-21](I-21-product-issuer.md)                        |
| Unblocks    | none                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                      |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/U-16.md` first; it needs human approval before code |
| Gates       | plan mode; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL                               |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Goal

A developer's backend can read and write `ownerRead` and `server` collections addressed by pairwise subject, authenticated with layer 2 issuer client credentials carrying a `pkey:sync` scope.

## Why

Decision 12 ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions)): I-21 client credentials by default, else an RFC 7523 assertion (I-25).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/U-16.md` once approved; [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-16, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 12.

## Scope

**In:** the plan, the API, the credential check, audit.

**Out** (and where it belongs instead):

- None.

## Design notes

- Optional; addressed by pairwise subject only, never the account id.

## Steps

1. Plan, approved. 2. API.

## Acceptance criteria

- [ ] A token without `pkey:sync` or for another product is refused (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync backend
```

## Hand-off

- None.

The role agent sets `--set U-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-16 done`.

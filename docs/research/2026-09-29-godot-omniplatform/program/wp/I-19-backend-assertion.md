# I-19 RFC 7523 product-backend assertion (console platforms) with jti replay cache and console key management

| Field       | Value                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (later)                                                                                                     |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                 |
| Depends on  | [I-10](I-10-exchange-endpoint.md)                                                                                                      |
| Unblocks    | none                                                                                                                                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-19.md` first; no code before a human approves it                                              |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL |
| Human input | none                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                              |

## Goal

Optional, later: console platforms (PSN, Xbox, Nintendo) sign in through an RFC 7523 assertion signed by the product's backend, with a `jti` replay cache and assertion keys managed in the console.

## Why

Console verification is under NDA and cannot ship in open-source code; a backend assertion or EOS Connect covers it (J12) ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J12, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-19; I-10's plan.

## Scope

**In:**

- A plan; `kind: assertion` on the exchange endpoint; `jti` replay cache on the single-use store; console key management.

**Out** (and where it belongs instead):

- NDA verification code (never in this repo).

## Design notes

- Optional: outside the owner's phases 0–3 scope.

## Steps

1. Plan and approval.
2. Verifier, keys, transcripts.

## Acceptance criteria

- [ ] A replayed `jti` is refused (test); transcripts and OpenAPI updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity exchange assertion
```

## Hand-off

- None planned.

The role agent sets `--set I-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-19 done`.

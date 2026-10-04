# I-18 Named-user seats: user claim in the licence `profile`, device holders, per-user caps

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (later)                                                                                                              |
| Size        | 1–2 engineer-weeks                                                                                                                              |
| Depends on  | [I-06](I-06-users-and-links.md)                                                                                                                 |
| Unblocks    | none                                                                                                                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                           |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-18.md` first; no code before a human approves it                                                       |
| Gates       | plan mode; corpus regeneration; all six SDKs + `parity:check`; D1 migration; `TABLE_OWNERS`; generated docs pages (regenerate, never hand-edit) |
| Human input | none                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                       |

## Goal

Optional, later: named-user seats, with a user claim in the licence document's `profile`, `devices.holder_user_id` and per-user caps, regenerated across the corpus and all six SDKs.

## Why

J10 needs the user principal first and touches the signed licence document; owner decision D9 keeps the document unchanged until this is commissioned ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D9).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J10, [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (J10 row), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-18.
- `packages/shared-protocol/src/license.ts:7-13`, `docs/security/WIRE-CONTRACT-V4.md:875`.

## Scope

**In:**

- A plan, then the additive `profile` member, corpus regeneration and all six SDKs.
- `devices.holder_user_id` and per-user caps.

**Out** (and where it belongs instead):

- B2B organisations (not yet a package).

## Design notes

- Optional: not committed by the owner's phases 0–3 scope. Only start when commissioned.
- An additive optional member can keep `PROTOCOL_VERSION` 4 (P4-19 precedent).

## Steps

1. Plan and approval.
2. Contract, corpus, SDKs.

## Acceptance criteria

- [ ] Approved plan; corpus regenerated; every SDK passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
- [ ] Every SDK's `parity.json` is updated and `pnpm parity:check` passes.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None planned.

The role agent sets `--set I-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-18 done`.

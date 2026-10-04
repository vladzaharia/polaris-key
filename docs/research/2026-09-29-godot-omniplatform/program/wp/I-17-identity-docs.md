# I-17 Identity docs: concepts, recovery, email sign-in and bring-your-own-auth quickstarts

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1–2)                                                   |
| Size        | 0.6–0.85 engineer-weeks                                                                  |
| Depends on  | [I-07](I-07-console-users.md), [I-22](I-22-sdk-identity-v2-exchange.md)                  |
| Unblocks    | none                                                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package |
| Gates       | `check:links`; generated docs pages (regenerate, never hand-edit)                        |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

Developers can learn and adopt Identity from the docs: concepts (user, identity link, login method, portal account), recovery ("the developer's job beyond links"), email sign-in, and bring-your-own-auth quickstarts for Clerk, Firebase, Auth0 and Supabase.

## Why

S-16 budgets docs per phase ([S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut)); the recovery policy in particular must be stated plainly because Polaris runs no recovery desk.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (recovery), [S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-17.
- `packages/docs/src/content/docs/services/identity/`, `start/concepts.md`.

## Scope

**In:**

- Concepts page updates (rule 4 glossary from I-04).
- Recovery page: remaining links; passkeys only after email; platform identities recover through the platform; beyond that the developer's support with the console tool (I-07).
- Email sign-in guide (hosted and in-app; device-code confirm screen).
- Bring-your-own-auth quickstarts (Clerk, Firebase, Auth0, Supabase).

**Out** (and where it belongs instead):

- Steam and Game Center guides (written with → I-12).
- "Sign in with <Product>" recipes (written with → I-16, whose estimate includes them).

## Design notes

- Generated pages are regenerated, never hand-edited.
- Each later Identity package keeps its own docs current; this package covers the phase 1–2 core set.

## Steps

1. Concepts and recovery.
2. Email guide.
3. Quickstarts.

## Acceptance criteria

- [ ] The pages exist and `check:links` passes.
- [ ] The recovery page says Polaris runs no recovery desk and describes the console tool's safeguards.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- I-12 and I-16 link their guides from the Identity index this package maintains.

The role agent sets `--set I-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-17 done`.

# LX-04 Portal and licence document agree on flag defaults and tier channels; stale comments and docs (G14, G19)

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.2–0.3 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | none                                                                                    |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | generated docs pages (`docs gen:check`; regenerate, never hand-edit); portal e2e        |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

The portal and the licence document agree on flag defaults and tier channels, and the stale comments and docs in G14 and G19 are corrected.

## Why

The portal's `entitlementView` falls back to catalog defaults that documents never include, and several comments and docs are wrong (G14, G19, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps) G14, G19, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-04.

## Scope

**In:**

- Portal entitlement view aligned with the document; comment and docs fixes listed in G19.

**Out** (and where it belongs instead):

- The resolver-based portal (→ LX-15).

## Design notes

- Regenerate generated docs pages; never hand-edit.

## Steps

1. Portal fix with tests.
2. Docs fixes.

## Acceptance criteria

- [ ] Portal and document show the same value for every catalog key in a fixture (test).
- [ ] Each G19 location is corrected.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- None.

The role agent sets `--set LX-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-04 done`.

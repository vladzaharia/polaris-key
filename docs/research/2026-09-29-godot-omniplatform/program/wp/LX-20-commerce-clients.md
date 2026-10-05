# LX-20 Commerce client parity: Swift (StoreKit 2), Kotlin (Play), Node (Steam and Electron), React through client-core, Python `allowedNa`; restore `transferred` result

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire) |
| Size        | 1–1.4 engineer-weeks                                                           |
| Depends on  | [LX-11](LX-11-commerce-rework.md)                                              |
| Unblocks    | none                                                                           |
| Role        | `pkey-sdk-porter`                                                              |
| Plan mode   | no                                                                             |
| Gates       | all six SDKs (`parity:check`); macOS CI; Android CI                            |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Goal

Commerce clients reach parity: Swift (StoreKit 2), Kotlin (Play), Node (Steam and Electron) implement bind and claim; React goes through client-core; Python is `allowedNa`; restore returns a `transferred` result.

## Why

Only Godot can bind and claim today (G17, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)); decision 13 sets the scope.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.7](../../notes/S-19-licensing-model.md#77-store-purchases-under-oc), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-20.

## Scope

**In:**

- Client implementations; parity rows; platform suites.

**Out** (and where it belongs instead):

- Server changes (→ LX-11).

## Design notes

- Rename clashes from G18 (StoreKit's "entitlements").

## Steps

1. Swift.
2. Kotlin.
3. Node; React via client-core.
4. Parity.

## Acceptance criteria

- [ ] `commerce.receipt` parity row is implemented or `allowedNa` per SDK.
- [ ] macOS and Android CI pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None.

The role agent sets `--set LX-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-20 done`.

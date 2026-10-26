# I-49 Silent restore and PlatformBackupStore: iCloud Keychain, Block Store, revoke the restore secret on sign-out

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                                                        |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                    |
| Depends on  | [I-13](I-13-exchange-endpoint.md), [I-44](I-44-swift-auto-signin.md), [I-45](I-45-kotlin-auto-signin.md), [CC-01](CC-01-combined-plan.md) |
| Unblocks    | [U-39](U-39-e2e-client-swift-kotlin.md)                                                                                                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                     |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                       |
| Gates       | plan-mode, rule-10, migration, threat-model                                                                                               |
| Human input | none                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                 |

## Goal

Silent restore and PlatformBackupStore: iCloud Keychain, Block Store, revoke the restore secret on sign-out. Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

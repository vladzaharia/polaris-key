# I-47 Node and Python autoSignIn(): stored, nearby (D and M sides), loopback, terminal views

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                                                               |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                           |
| Depends on  | [I-40](I-40-account-initiated-pairing.md), [CC-15](CC-15-nearby-mode-v.md), [I-15](I-15-native-redirect.md), [CC-26](CC-26-device-key-stores.md) |
| Unblocks    | none                                                                                                                                             |
| Role        | `pkey-sdk-porter`                                                                                                                                |
| Plan mode   | no                                                                                                                                               |
| Gates       | all-sdks, drift-gate                                                                                                                             |
| Human input | none                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Goal

Node and Python autoSignIn(): stored, nearby (D and M sides), loopback, terminal views. Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

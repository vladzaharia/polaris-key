# I-42 identity.platformSignIn and identity.nearby: manifest, settings, console

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) |
| Size        | 0.4–0.6 engineer-weeks                                             |
| Depends on  | [I-09](I-09-key-entry-attach.md), [CC-01](CC-01-combined-plan.md)  |
| Unblocks    | [I-13](I-13-exchange-endpoint.md)                                  |
| Role        | `pkey-implementer`                                                 |
| Plan mode   | no                                                                 |
| Gates       | rule-9, drift-gate, settings, pkey-ux-reviewer                     |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

identity.platformSignIn and identity.nearby: manifest, settings, console. Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- This package builds UI: the `pkey-ux-reviewer` gate applies.

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

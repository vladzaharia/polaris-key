# I-48 Godot autoSignIn(): GDScript ladder, Apple and Android natives, PKeySignIn states (rungs 1-4; rungs 6-7 after I-15; nearby after I-40 and CC-15)

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                                                                                                     |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                   |
| Depends on  | [I-13](I-13-exchange-endpoint.md), [I-43](I-43-link-offer.md), [I-46](I-46-web-auto-signin.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [CC-26](CC-26-device-key-stores.md) |
| Unblocks    | none                                                                                                                                                                                   |
| Role        | `pkey-godot-engineer`                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                     |
| Gates       | all-sdks, drift-gate, corpus:mirror                                                                                                                                                    |
| Human input | none                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                              |

## Goal

Godot autoSignIn(): GDScript ladder, Apple and Android natives, PKeySignIn states (rungs 1-4; rungs 6-7 after I-15; nearby after I-40 and CC-15). Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- Slice gating: rungs 1-4 need only the deps below; rungs 6-7 need I-15; the nearby slices need I-40 and this SDK's CC-15 slice. The graph lists the rungs 1-4 deps only (R-18).

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

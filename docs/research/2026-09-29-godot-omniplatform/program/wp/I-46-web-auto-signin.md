# I-46 Web autoSignIn(): FedCM and GIS, ui-core states, React and elements kits; shared copy and states (.1: kit copy, SignIn states, NearbyApproval, ui-matrix rows)

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                                                                   |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                               |
| Depends on  | [I-13](I-13-exchange-endpoint.md), [I-43](I-43-link-offer.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [CC-26](CC-26-device-key-stores.md) |
| Unblocks    | [I-44](I-44-swift-auto-signin.md), [I-45](I-45-kotlin-auto-signin.md), [I-48](I-48-godot-auto-signin.md), [U-42](U-42-kit-sync-screens.md)           |
| Role        | `pkey-sdk-porter`                                                                                                                                    |
| Plan mode   | no                                                                                                                                                   |
| Gates       | all-sdks, drift-gate, corpus, ui-snapshots, pkey-ux-reviewer                                                                                         |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Goal

Web autoSignIn(): FedCM and GIS, ui-core states, React and elements kits; shared copy and states (.1: kit copy, SignIn states, NearbyApproval, ui-matrix rows). Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- This package builds UI: the `pkey-ux-reviewer` gate applies.

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

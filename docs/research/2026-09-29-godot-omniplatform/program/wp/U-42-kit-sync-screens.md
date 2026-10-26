# U-42 Kit sync screens: unlock sync (nearby, recovery code, start over), save your recovery code, locked status; four kits

| Field       | Value                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                      |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                    |
| Depends on  | [U-38](U-38-e2e-client-node-react-python.md), [U-39](U-39-e2e-client-swift-kotlin.md), [U-40](U-40-e2e-client-godot.md), [I-46](I-46-web-auto-signin.md), [CC-15](CC-15-nearby-mode-v.md) |
| Unblocks    | [U-15a](U-15a-docs-settings.md)                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                        |
| Gates       | ui-snapshots, modernity-lint, pkey-ux-reviewer, drift-gate                                                                                                                                |
| Human input | none                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                 |

## Goal

Kit sync screens: unlock sync (nearby, recovery code, start over), save your recovery code, locked status; four kits. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

- This package builds UI: the `pkey-ux-reviewer` gate applies.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

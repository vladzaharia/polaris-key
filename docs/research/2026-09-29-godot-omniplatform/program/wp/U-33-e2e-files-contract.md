# U-33 Sync E2E and files contract: WIRE-CONTRACT-V5 section 13, protocol/sync types, errors, features, catalog and manifest

| Field       | Value                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17)                                                                                                                                                                                                     |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                   |
| Depends on  | [U-01b](U-01b-cloud-sync-plan-amendment-two-stores-one.md), [U-05](U-05-cloud-sync-do.md), [CC-04](CC-04-wire-v5.md), [CC-01](CC-01-combined-plan.md)                                                                    |
| Unblocks    | [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md), [U-32](U-32-catalog-templates-cloud-sync-page-minted.md), [U-34](U-34-client-core-e2e.md), [U-35](U-35-machine-v3.md), [U-36](U-36-core-key-ring.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                                                      |
| Gates       | plan-mode, rule-9, drift-gate, corpus, threat-model                                                                                                                                                                      |
| Human input | none                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                |

## Goal

Sync E2E and files contract: WIRE-CONTRACT-V5 section 13, protocol/sync types, errors, features, catalog and manifest. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-sync.md`](../plans/CC-01-cloud-sync.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

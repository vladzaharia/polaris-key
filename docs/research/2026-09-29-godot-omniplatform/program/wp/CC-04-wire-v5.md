# CC-04 Wire v5: WIRE-CONTRACT-V5 (.1 first), pkey-peer+jws and pkey-ring+jws, corpus sections, client-core verify

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md)                       |
| Size        | 0.9–1.2 engineer-weeks                                                                                                                                                       |
| Depends on  | [CC-01](CC-01-combined-plan.md)                                                                                                                                              |
| Unblocks    | [I-13](I-13-exchange-endpoint.md), [CC-03](CC-03-core-device-keys.md), [CC-05](CC-05-peer-engine.md), [CC-06](CC-06-connect-identity.md), [U-33](U-33-e2e-files-contract.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                          |
| Gates       | plan-mode, protocol-version, corpus, corpus-runner, corpus:mirror, drift-gate, all-sdks, threat-model, security-review                                                       |
| Human input | none                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Goal

Wire v5: WIRE-CONTRACT-V5 (.1 first), pkey-peer+jws and pkey-ring+jws, corpus sections, client-core verify. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

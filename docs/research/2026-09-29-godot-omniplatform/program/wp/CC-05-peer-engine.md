# CC-05 pkey-peer/1: AES-GCM Noise vectors, peer matrix, SAS commit-reveal, client-core session engine

| Field       | Value                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md)                                                                       |
| Size        | 0.9–1.2 engineer-weeks                                                                                                                                                                                                       |
| Depends on  | [CC-04](CC-04-wire-v5.md), [CC-01](CC-01-combined-plan.md)                                                                                                                                                                   |
| Unblocks    | [CC-07](CC-07-relay-do.md), [CC-08](CC-08-node-connect.md), [CC-10](CC-10-python-connect.md), [CC-11](CC-11-swift-connect.md), [CC-12](CC-12-kotlin-connect.md), [CC-14](CC-14-godot-connect.md), [CC-25](CC-25-noise-ik.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                                                                                          |
| Gates       | plan-mode, corpus, corpus-runner, corpus:mirror, drift-gate, all-sdks, security-review                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                    |

## Goal

pkey-peer/1: AES-GCM Noise vectors, peer matrix, SAS commit-reveal, client-core session engine. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

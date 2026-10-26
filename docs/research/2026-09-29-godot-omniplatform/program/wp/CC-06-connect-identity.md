# CC-06 Connect identity on the Worker: certificates, rings, discovery keys, linked-devices route

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-02](CC-02-service-row.md), [CC-03](CC-03-core-device-keys.md), [CC-04](CC-04-wire-v5.md), [CC-01](CC-01-combined-plan.md)                          |
| Unblocks    | [CC-07](CC-07-relay-do.md), [CC-08](CC-08-node-connect.md), [CC-16](CC-16-console-section.md)                                                          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                  |
| Plan mode   | yes: executes the approved [`plans/CC-01.md`](../plans/CC-01.md) and the plan above                                                                    |
| Gates       | plan-mode, migration, table-owners, rule-10, rule-6, drift-gate, threat-model, workerd, security-review                                                |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Connect identity on the Worker: certificates, rings, discovery keys, linked-devices route. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

## Progress and continuation (2026-10-26)

**CC-06.1 done on `wp/CC-06.1-connect-identity` (slice, not the package).**

- [x] `connect_rings` (migration `0146_connect_rings.sql`, the lead renumbers), `TABLE_OWNERS` row `connect`, the subject store `connect.rings` and product deletion.
- [x] `services/connect/ring.ts`: members through the principal rule (`accountDeviceKeys`, `seatsHeld` when License is on), `members_hash`, epoch bump with a new K_disc (previous key delivered 24 h), `pkey-ring+jws` and `pkey-peer+jws` signing.
- [x] `GET /<p>/connect/identity` (`{ring, certificate, discKeys}`) and `GET /<p>/connect/devices`, both device bearer and `cors: true`; OpenAPI, descriptor `surface`, `connect` off `ROUTELESS`; discovery fragment endpoints (`ticket` stays `null` for CC-07.3).
- [x] `device_keys_required` (errors.json, copy in 9 locales, constants regenerated).
- [x] Roster lifetime: the signer refuses a roster whose span is outside 1..`RING_SECONDS`; V5 §15.3 says so.

**Left for CC-06.2 / CC-06.3:** the verifier side of the roster span (an all-languages wire change with its corpus case; the corpus lane was held), the `onDeviceChange` listener and audit (CC-06.3), the threat-model entry.

**Corrections to the plan:** CC-06.2's identity/devices/discovery steps were built here at the lead's request; the identity answer's shape is defined in OpenAPI (`ConnectIdentity`), not in V5.

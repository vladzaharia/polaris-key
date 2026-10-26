# CC-02 Cloud Connect service row, descriptor, coherence, manifest block, settings and console stub

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC: Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (plans/CC-01-cloud-connect.md) |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                 |
| Depends on  | [CC-01](CC-01-combined-plan.md)                                                                                                                        |
| Unblocks    | [CC-06](CC-06-connect-identity.md)                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                     |
| Plan mode   | no                                                                                                                                                     |
| Gates       | new-service, rule-9, rule-10, drift-gate, docs-generated, docs-links, console-csp-parity                                                               |
| Human input | confirm production tolerates unknown slugs (layout.md step 1)                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

Cloud Connect service row, descriptor, coherence, manifest block, settings and console stub. Scope, wire shapes, slices and tests: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-cloud-connect.md`](../plans/CC-01-cloud-connect.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

## Progress and continuation (2026-10-26)

- CC-02.1 done on `wp/CC-02.1-service-row`: services.json row and `cloud-connect` feature, the stub
  `services/connect/` descriptor (empty routes table, integration contributor, discovery fragment
  `{enabled:true}`), `connect_requires_identity` (worker, manifest, schema, mutation row, console
  message), OpenAPI `services.required`, sighting bit 1024.
- Correction to the plan: a new service row also widens `ServiceSlug` in the admin and brand
  packages, so CC-02.1 carries three placeholders that CC-02.3 replaces: the brand accent
  (`connect` aliases Cloud Sync's teal in `SERVICE_ALIAS`; the Radar glyph is vendored), the
  `SERVICE_AREA` entry (`connect` shares `sync` until the `connect` RBAC area lands with the admin
  routes), and a null admin section module. The admin `nav.ts` `SECTIONS` entry is not added, so
  admin `test/serviceTable.test.ts` fails until CC-02.3.

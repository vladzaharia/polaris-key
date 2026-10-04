# A-17c ASC product app setup API: ASN URL, beta groups, testers, availability and price defaults

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | A: Admin: store provisioning (asc)                                       |
| Size        | 0.5–1 engineer-weeks                                                     |
| Depends on  | [A-17a](A-17a-asc-write-substrate.md), [P6-01](P6-01-commerce-bridge.md) |
| Unblocks    | [A-17f](A-17f-console-asc-new-app.md)                                    |
| Role        | `pkey-implementer`                                                       |
| Plan mode   | no                                                                       |
| Gates       | rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations)    |
| Human input | none (the ASN PATCH stays [U] until A-17h runs)                          |
| Repo        | `vladzaharia/polaris-key`                                                |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17c and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17c.

## Changes required by S-15

No change to scope. Once A-18a lands, its writes call `performStoreWrite` instead of `performAscWrite`: an import change only (S-15 §11).

## Acceptance criteria

- [ ] S-14 §10's A-17c row is met.
- [ ] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17c in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17c done`.

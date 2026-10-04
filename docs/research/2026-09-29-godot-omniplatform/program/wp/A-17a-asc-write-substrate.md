# A-17a ASC write substrate: client, deny-by-default write gate, ledger, budget, audit projection

| Field       | Value                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                                                                                                                                                                                      |
| Size        | 1–2 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                                                                    |
| Unblocks    | [A-17b](A-17b-asc-team-provisioning.md), [A-17c](A-17c-asc-product-setup.md), [A-17d](A-17d-asc-distribute.md), [A-17e](A-17e-asc-iap.md), [A-18a](A-18a-storefront-adapter-layer.md), [A-18c](A-18c-listing-import.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                                      |
| Gates       | migration and TABLE_OWNERS; THREAT-MODEL edit; spec-classification CI test (mandatory, S-14 decision 1)                                                                                                                 |
| Human input | none (A-16's team key is already held)                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                               |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17a and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17a: the App Store Connect write substrate, with the deny-by-default gate that is the
only barrier in front of the Admin team key (S-14 decision 1). In flight on
`wp/A-17a-asc-write-gate`.

## Changes required by S-15 (owner decision 3, 2026-10-04)

The lead sequences these with A-17a's reviewer before the branch merges:

- Rename the ledger table `asc_operations` to **`store_operations`**, add a `store` column
  (`'app-store'` for every A-17 row), and rename `apple_status` and `apple_code` to
  `vendor_status` and `vendor_code`. Update `TABLE_OWNERS` to match. Nothing else changes.
- If A-17a has already merged when this lands, the rename moves to A-18a as a rebuild migration
  instead (S-15 §6.3).
- The gate's rule table, deny list, spec pin and tests are **moved by A-18a, not rewritten**. Keep
  `performAscWrite`'s step shape generic (it becomes `performStoreWrite`, S-15 §6.3).

## Acceptance criteria

- [ ] S-14 §10's A-17a row is met.
- [ ] The ledger is `store_operations` with `store`, `vendor_status` and `vendor_code`
      (or the lead has recorded that A-18a carries the rebuild).
- [ ] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17a in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17a done`.

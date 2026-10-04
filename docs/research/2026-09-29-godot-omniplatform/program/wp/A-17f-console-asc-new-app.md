# A-17f Console: App Store New app wizard and Set up on assigned apps

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                                           |
| Size        | 1–2 engineer-weeks                                                           |
| Depends on  | [A-17b](A-17b-asc-team-provisioning.md), [A-17c](A-17c-asc-product-setup.md) |
| Unblocks    | none                                                                         |
| Role        | `pkey-implementer`                                                           |
| Plan mode   | no                                                                           |
| Gates       | docs help-link drift gate; console CSP parity                                |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17f and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17f: the App Store New app wizard (T6) in A-16's Store connections page, with **Set
up** on assigned apps.

## Changes required by S-15

- **If A-17f has not started when A-18j is dispatched, the lead merges it into A-18j and marks
  this package `dropped`** (S-15 §10 item 7, §11). The New app wizard then becomes the Apple
  adapter's `plan()` inside A-18j's Add to storefronts flow, and is not built twice.
- If it has started, A-18j wraps it. Either way, its deep-link constant table lives in
  `core/storefront/deeplinks.ts` (A-18a), not in an Apple-only file, and the copy card is filled
  from the listing model (A-18b) once that lands.

## Acceptance criteria

- [ ] S-14 §10's A-17f row is met, or the package is dropped in favour of A-18j.
- [ ] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17f in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17f done`.

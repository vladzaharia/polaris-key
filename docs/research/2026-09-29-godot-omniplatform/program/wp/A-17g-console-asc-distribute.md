# A-17g Console: App Store Distribute flow and App Store products

| Field       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                          |
| Size        | 1–2 engineer-weeks                                          |
| Depends on  | [A-17d](A-17d-asc-distribute.md), [A-17e](A-17e-asc-iap.md) |
| Unblocks    | none                                                        |
| Role        | `pkey-implementer`                                          |
| Plan mode   | no                                                          |
| Gates       | docs help-link drift gate; console CSP parity               |
| Human input | none                                                        |
| Repo        | `vladzaharia/polaris-key`                                   |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17g and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17g: the Distribute flow (T6) in the product's Distribution App Store panel, and
**App Store products** (T2) in Commerce.

## Changes required by S-15

- Distribute's release-notes step edits the shared per-locale notes
  (`dist_listing_release_notes`, A-18b), the same notes every store reads. App Store products
  default their localizations from the model.
- Reuse the console's shared components; capability and status badges are the ones A-18j and F-11
  share.

## Acceptance criteria

- [ ] S-14 §10's A-17g row is met.
- [ ] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17g in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17g done`.

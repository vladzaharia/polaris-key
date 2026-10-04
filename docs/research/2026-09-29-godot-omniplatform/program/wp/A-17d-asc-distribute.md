# A-17d ASC Distribute API: builds, localizations, beta review, versions, phased release, review submissions

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                                                                        |
| Size        | 1–2 engineer-weeks                                                                                        |
| Depends on  | [A-17a](A-17a-asc-write-substrate.md), [P5-02](P5-02-asc-connector.md)                                    |
| Unblocks    | [A-17e](A-17e-asc-iap.md), [A-17g](A-17g-console-asc-distribute.md), [A-18m](A-18m-apple-listing-push.md) |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations)                                     |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17d and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17d: the Distribute API.

## Changes required by S-15

- Per-locale release notes (`whatsNew`) come from `dist_listing_release_notes` (A-18b), not from
  the release record directly, and the preflight shows the model's Apple fit report (S-15 §7.5).
  **If A-17d lands first, A-18b retrofits that one read**; A-17d does not wait for A-18b.
- The gate surface does not widen here. The Apple listing push (description, keywords, URLs, name,
  subtitle, screenshot sets) is A-18m (owner decision 1).
- Writes call `performStoreWrite` once A-18a lands: an import change only.

## Corrections (as built, 2026-10-04)

- **A-17d landed before A-18b.** `distribute/beta-localization` and `distribute/version-localization`
  take the notes from the request body; A-18b retrofits that one read to
  `dist_listing_release_notes`, and the preflight's Apple fit report joins then.
- **Writes call A-17a's `performAscWrite`**, the substrate that exists today; A-18a's
  `performStoreWrite` is an import change when it lands.
- The rest of the departures from S-14 are recorded in S-14's "Corrections (A-17d as built)".

## Acceptance criteria

- [x] S-14 §10's A-17d row is met.
- [x] The green gate passes (`AGENTS.md`).

## Hand-off

The role agent sets `--set A-17d in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17d done`.

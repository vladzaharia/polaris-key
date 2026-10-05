# A-17e ASC in-app purchases from commerce mappings

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (asc)                                                                         |
| Size        | 1–2 engineer-weeks                                                                                         |
| Depends on  | [A-17a](A-17a-asc-write-substrate.md), [A-17d](A-17d-asc-distribute.md), [P6-01](P6-01-commerce-bridge.md) |
| Unblocks    | [A-17g](A-17g-console-asc-distribute.md)                                                                   |
| Role        | `pkey-implementer`                                                                                         |
| Plan mode   | no                                                                                                         |
| Gates       | rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations)                                      |
| Human input | none                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Status of this brief

A-17 was planned in [notes/S-14 §10](../../notes/S-14-asc-provisioning.md#10-work-packages), not in this program. This entry exists so that the storefront packages
(A-18a…m, [notes/S-15 §11](../../notes/S-15-storefront-provisioning.md#11-work-packages)) can depend on it in the graph. **The scope, design and acceptance criteria are
S-14 §10's row for A-17e and the S-14 sections it cites**; this brief does not restate them. Where
S-14 and the code disagree, the code is the fact, as everywhere in the program.

## Goal

S-14 §10, A-17e.

## Changes required by S-15

No change to scope. Once A-18a lands, its writes call `performStoreWrite`: an import change only. Once A-18b lands, IAP localization display names and descriptions default from the listing model's locales (S-15 §7.5).

## Acceptance criteria

- [x] S-14 §10's A-17e row is met: `commerce/appleCatalog.ts` reads status by `filter[productId]`;
      creates the non-consumable IAP, its version and localizations; looks up price points and
      sets the schedule; sets availability; a price change is typed (server-side and in the gate);
      IAP and Background Asset versions join A-17d's submission (`distribute/submit`).
- [x] The green gate passes (`AGENTS.md`).

## Corrections (as built)

The departures from S-14 are recorded in S-14's "Corrections (A-17e as built, 2026-10-04)": the
handlers sit in the App Store Connect connector's tables, A-17d's plumbing moved to
`connectors/asc/flow.ts`, a price change is immediate only (no future-dated schedule), an
availability already set is never changed, the first-IAP rule counts approved IAPs only, the
A-18b localization defaults are not applied (A-18b has not landed), and A-17a's migration is
renumbered `0060` after main's `0059`.

## Hand-off

The role agent sets `--set A-17e in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-17e done`.

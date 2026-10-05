# LX-01 Plan the licensing model (OC): decision record, DDL, contributors and combine rules, anchor rule, expand and contract schedule, I-04, I-05, U-01 and I-20 amendments

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only) |
| Size        | 0.4–0.55 engineer-weeks                                                                      |
| Depends on  | [I-05](I-05-accounts-core.md)                                                                |
| Unblocks    | [LX-08](LX-08-licensing-expand.md), [LX-18](LX-18-licensing-wire.md)                         |
| Role        | `pkey-wire-planner` (planning only)                                                          |
| Plan mode   | yes: the plan [`plans/LX-01.md`](../plans/LX-01.md) needs human approval before code         |
| Gates       | plan mode; owner approval of the plan                                                        |
| Human input | plan approval (`plans/LX-01.md`)                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                    |

## Goal

An approved plan, `program/plans/LX-01.md`, fixes the licensing model's exact DDL, contributor and combine rules, the anchor rule, the expand/dual-write/switch/contract schedule, and the amendments to I-04, I-05, U-01 and I-20, so LX-08 onward implement without reopening design.

## Why

The owner adopted model OC ([S-19 owner decisions](../../notes/S-19-licensing-model.md) item 1 (model OC adopted)) and accepted the account in the document's inputs ([S-19 owner decisions](../../notes/S-19-licensing-model.md) item 2). The note's DDL is a sketch; the plan makes it exact and records the open questions LX-01 owns ([S-19 §10.2](../../notes/S-19-licensing-model.md#102-open-questions-not-blocking)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7](../../notes/S-19-licensing-model.md#7-the-recommended-design-oc-fully-specified) in full, [S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-01, [S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) (all decisions, as accepted).
- `program/plans/I-04.md` (its 2026-10-04 amendment on `anchorPolicy`), I-05's merged migrations (`0068_*`).

## Scope

**In:**

- Decision record for OC with decisions 1–23 as accepted (decision 4: `entitlementHolder: device`).
- Exact DDL for every §7.2 table and column, Core-owned, additive only until LX-16.
- Contributors (§7.3.1), combine and state rules (§7.4), anchor rule (§7.5), migration schedule (§7.14).
- Answers to the open questions it owns: store mappings in `.pkey/distribution`?; the licence document's current answer for a licence-less device.
- Proposed amendment text for I-04, I-05 (LX-13 follow-ups), U-01 (Q2, decision 19) and I-20.

**Out** (and where it belongs instead):

- Any code (→ LX-08 onward).
- The wire plan (→ LX-18, plan mode of its own).

## Design notes

- Licensing settings are claimable `product_settings` rows in S-18's registry (LX-06), not `products.licensing_json`; the plan uses that shape.
- D9 is read as a content rule; S-17 D20's outcome is kept (decision 2).

## Steps

1. Draft the plan.
2. Owner approval.
3. Merge the plan; the lead unblocks LX-08.

## Acceptance criteria

- [ ] `program/plans/LX-01.md` exists, names every table, column, migration file and WP it touches, and is approved by the owner.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- LX-08, LX-09 and LX-18 execute against this plan.

The role agent sets `--set LX-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-01 done`.

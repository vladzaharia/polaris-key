# LX-13 Developer backend for entitlements and add-on grants

| Field       | Value                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                        |
| Size        | 0.6–0.85 engineer-weeks                                                                                             |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-09](LX-09-entitlement-resolver.md), [I-05](I-05-accounts-core.md)           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-22](LX-22-licensing-closeout.md), [CM-05](CM-05-checkout-fulfilment.md) |
| Role        | `pkey-implementer`                                                                                                  |
| Plan mode   | no                                                                                                                  |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; privacy docs                                                     |
| Human input | none                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                           |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q4: `entitlements.changed` is delivered through `entitlement_events` with a pull cursor, and webhooks come later, so drop "webhook" from the scope. The I-05 follow-ups: `mergeAccounts`' batch moves account-held grants, keeps the survivor's `dist_holder_bindings` row, inserts `dist_binding_aliases` for the absorbed binding, re-keys first-held `dist_purchases` and bumps both versions. Account deletion and per-product removal clear `grants.account_id` holders according to D25 and D27 (D27 pending legal review).
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** use `identityEnabled` to decide whether to create licence-held grants.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Grants API takes addonId only (every grant references an add-on); a one-off comp is a licence entitlement override, a repeatable one is a comp add-on; subjects/<s>/entitlements returns the duration; subscription routes move to LX-41, consumable routes to LX-42; written as route-table entries.

- Title: was "Developer backend for entitlements: admin grants API, `subjects/<s>/entitlements`, `entitlements.changed` event and webhook, account-merge re-keying, deletion of account-held grants".

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Until SP-66 is approved, LX-13 keeps pull feeds; it moves to SP-66's push format afterwards.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: its account-merge binding steps are dropped (keeping the survivor's `dist_holder_bindings` row and inserting `dist_binding_aliases`): there are no account bindings (D5), and purchases move with their licences.
- [`plans/LX-41.md`](../plans/LX-41.md) §13: `subjects/<s>/entitlements` returns `licenseTerm`; no subscription routes.

## Goal

Developer backends can manage entitlements: an admin grants API, `subjects/<s>/entitlements`, an `entitlements.changed` event and webhook, account-merge re-keying inside I-05's merge batch, and deletion of account-held grants.

## Why

A developer selling on their own site has no route to ask what a subject holds and no change event (G20, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)); I-05 needs the merge and deletion follow-ups ([S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes) I-05 row).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.9](../../notes/S-19-licensing-model.md#79-apis), [S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes) I-05 row, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-13.

## Scope

**In:**

- Routes with OpenAPI and `routeCoverage`; event and webhook contract; merge re-keying; deletion path.

**Out** (and where it belongs instead):

- Web checkout sources (→ LX-23).

## Design notes

- Grants move only by an audited developer "Move grant" (decision 20).
- Privacy docs updated for account-held grants.

## Steps

1. API.
2. Event.
3. Merge and deletion.

## Acceptance criteria

- [ ] Merge re-keys grants and bindings (test).
- [ ] Deleting an account removes its grants (test).
- [ ] Webhook contract test passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-22.

The role agent sets `--set LX-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-13 done`.

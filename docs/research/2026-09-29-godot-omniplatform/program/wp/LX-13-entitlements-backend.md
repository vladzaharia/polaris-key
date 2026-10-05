# LX-13 Developer backend for entitlements: admin grants API, `subjects/<s>/entitlements`, `entitlements.changed` event and webhook, account-merge re-keying, deletion of account-held grants

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)              |
| Size        | 0.6–0.85 engineer-weeks                                                                                   |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-09](LX-09-entitlement-resolver.md), [I-05](I-05-accounts-core.md) |
| Unblocks    | [LX-22](LX-22-licensing-closeout.md), [CM-05](CM-05-checkout-fulfilment.md)                               |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; privacy docs                                           |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q4: `entitlements.changed` is delivered through `entitlement_events` with a pull cursor, and webhooks come later, so drop "webhook" from the scope. The I-05 follow-ups: `mergeAccounts`' batch moves account-held grants, keeps the survivor's `dist_holder_bindings` row, inserts `dist_binding_aliases` for the absorbed binding, re-keys first-held `dist_purchases` and bumps both versions. Account deletion and per-product removal clear `grants.account_id` holders according to D25 and D27 (D27 pending legal review).
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** use `identityEnabled` to decide whether to create licence-held grants.

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

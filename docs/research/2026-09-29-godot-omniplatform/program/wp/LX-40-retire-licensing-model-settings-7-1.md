# LX-40 Retire the licensing-model settings (7 to 1)

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                       |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                 |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [LX-12](LX-12-licence-lifecycle.md), [LX-05b](LX-05b-reserved-names-error.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-16](LX-16-licensing-contract.md)                                                                           |
| Role        | `pkey-implementer`                                                                                                                                     |
| Plan mode   | no                                                                                                                                                     |
| Gates       | `rule-9`                                                                                                                                               |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-40** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Goal

Retire the licensing-model settings (7 to 1), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-40** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.4, for **LX-40**.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- Remove licensing.entitlementModel (its one-time switch is a lead-run P0-49 job, no console card), entitlementHolder, anchorPolicy, reanchor, clampGraceToExpiry (always on), refundGraceHours and reservedNames from the registry, manifest (rule 9 deprecation warnings) and console (shared-manifest index.ts:223-241); keep license.dunningGraceDays, shown only when a subscription source exists; delete LicenseSettingsPage, COMBINED_ENTITLEMENT_MODEL_SINCE and entitlementModelFor; gen:settings --check.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-40**; DX consolidation E: Licensing model.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Registry lists one licensing key
- [ ] Manifests with retired keys warn, not fail, during the window
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-40 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-40 done`.

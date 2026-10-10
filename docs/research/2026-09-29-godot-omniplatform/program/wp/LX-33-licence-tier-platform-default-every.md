# LX-33 Licence > tier > platform default for every limit; every licence has a tier

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                       |
| Size        | 1–1.4 engineer-weeks                                                                                                                                   |
| Depends on  | [LX-32](LX-32-one-resolver-licence-limits-duration.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-34](LX-34-entitlement-catalog-in-licensing-tier.md), [LX-41](LX-41-durations-subscriptions-core-trials.md) |
| Role        | `pkey-implementer`                                                                                                                                     |
| Plan mode   | no                                                                                                                                                     |
| Gates       | `migration`, `table-owners`, `rule-9`                                                                                                                  |
| Human input | none                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-33** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

## Goal

Licence > tier > platform default for every limit; every licence has a tier, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-33** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **LX-33**.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- Every licence has a tier: tierless licences move onto a 'Default' tier seeded from products.default\__ through a P0-49 job; issuance defaults to the product's first tier; then the product layer goes (products.default_device_limit/default_max_offline_days reads, the license.defaults._ keys, manifest defaultDeviceLimit/defaultMaxOfflineDays with rule-9 warnings), so limits resolve licence > tier > platform constant, exactly the brief's chain. Channels: the base set overrides (licence, then tier, then ['stable']); add-ons add by union; stable is always granted (WIRE-CONTRACT-V4 §5.1 rule 4). 'dev includes beta' is applied at write time only: the tier and licence editors and the manifest validator store ['beta','dev'] when dev is chosen; the resolver and every SDK match grants as stored. Version window: override from the anchor licence only, then the keepVersion clamp (S-19's widest-window combine dropped; today core/authz.ts:150 intersects), compared as semver. The deviceLimit entitlement stops being a source (seat packs add); tier offline days are read. Two releases: N materialises today's effective values as explicit licence values through a P0-49 job; N+1 switches the resolver once the report shows zero diffs. The console Limits form shows inherited values with Override.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-33**; DX consolidation E: Licensing model.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 8 mockup item(s):** `licenses.bulk-keys`, `licenses.change-tier`, `licenses.detail`, `licenses.tiers-states`, `licenses.tiers`, `entitlements.duration-version`, `entitlements.duration`, `packages.release-tracks`.

## Acceptance criteria

- [ ] P0-49 report lists every effective-value change before the switch (expected none)
- [ ] Signed licence and update documents byte-identical across the switch (channels never rewritten)
- [ ] No tierless licence remains; precedence tests per field
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/model` (holder states, tiers, limits); `help/license-status`, `help/messages/license-status`; `reference/settings`.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-33 done`.

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

## Corrections (2026-10-22)

Verified against the code by the LX-33 slice plan (`_lead/plans/LX-33-slices.md` §0); the code is the fact.

1. `core/authz.ts:150` has moved. The intersect is `tighterMin`/`tighterMax` in `packages/worker/src/core/licensing/entitlements.ts:72-90`; LX-32's resolver calls it (`core/licensing/terms.ts:152-161`) and `injectAdminPolicy` stamps the result (`entitlements.ts:200-245`).
2. The console Limits form with **Override** already exists (`packages/admin/src/console/sections/license/components/LimitsTable.tsx`). LX-33 changes its sources, not its shape.
3. "dev includes beta" is already applied by the server-side tier and licence write paths (`withIncludedChannels`, `core/channels.ts:119`; P2-08) and WIRE-CONTRACT-V4 §5.1 says so. Missing: the manifest path (tier channels are stored as declared: `shared-manifest/src/index.ts:5292` plus ingest) and the console showing it.
4. The owner note (2026-10-07) overrides the "rule-9 warnings": a removed manifest field is an error that names its replacement (the ST-38 precedent, `shared-manifest/src/index.ts:2996-3008`). Each field has three spellings (`/product/*`, root, `/licensing/*`; `spellings.ts:172-199`).
5. Tier offline days exist (`tiers.policy_offline_grace_days`, LX-08; manifest `policyOfflineGraceDays`), but the tier admin API, `upsertTier` and TierForm do not write them.
6. The keepVersion clamp does not exist yet (LX-41). LX-33 adds an identity clamp seam in its place.
7. Seat packs do not exist yet (LX-35/LX-14). "Seat packs add" becomes an `extraSeats` input that is 0 until LX-35.
8. The platform constants are `DEFAULT_DEVICE_LIMIT = 5` and `DEFAULT_MAX_OFFLINE_DAYS = 30` (`core/settings/platform.ts:47-52`). djdl's defaults equal them (`products/djdl/product.json:9-10`) and its only tier sets `policyDeviceLimit: 5`.
9. The P0-49 job belongs to License (`licenses` and `tiers` are owned by `license`, `db/owners.ts`). It is contributed through `services/license/index.ts` `contributes.migrations`, like identity's `platformConnectionSeedJob`. The operator runs it with `pkey migrate list|dry-run|report` (`cli/src/migrate.ts`) and applies from the console session.
10. DOC-12a is still todo, so there is no changelog collection with `replaces` yet. The Upgrade row follows ST-38's hand-written section in `packages/docs/src/content/docs/build/upgrade-to-0-9.md`.

Also recorded by LX-33.1: the schema files are `0129_a_default_tier.sql` and `0129_b_index_assertion.sql`. The assertion must sort after the file that creates `idx_tiers_implicit`, and `0129_b` sorts before `0129_default_tier`, hence the `_a` (the 0105_g/0105_h precedent). The lead renumbers both at merge time and keeps the `_a`/`_b` order.

# ST-05a One settings read and write path

| Field       | Value                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                      |
| Size        | 0.6–0.8 engineer-weeks                                                                                                                                                                                           |
| Depends on  | [ST-04](ST-04-settings-resolver.md), [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-07](ST-07-settings-row-v2.md), [ST-11](ST-11-sql-only-settings.md), [ST-27](ST-27-alert-destinations.md), [ST-05b](ST-05b-generic-settings-routes-bespoke-routes.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                               |
| Gates       | `rule-10`                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **ST-05 (split)** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Absorbs ST-05 (split; this package takes its share): ST-05a: one settings read/write path (fold the A-13 platform store into the registry resolver and writeSetting). ST-05b: the generic routes (S-18 §4.7 minus history, as-of and restore), with the bespoke routes removed in the same release (no alias, no adapter).

## Goal

One settings read and write path, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **ST-05 (split)** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **ST-05 (split)**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **ST-05 (split)**.

## Scope

**In:**

- Fold the A-13 platform store into the registry resolver and writeSetting(): delete PlatformSettingDef and its parallel validator, confirm, resolver and writer; strip rowSettings route checks; move the 8 A-13 readers to resolvePlatformSetting; /platform/settings PATCH and DELETE become strict writes; storefront.polarisKey.enabled written through the registry.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **ST-05 (split)**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections (ST-05a, verified against the code)

- `core/platformSettings.ts` stays as the `platform_settings` row cache only (30-second per-isolate copy, tombstone, refresh and invalidate): the resolver reads rows through it. Its definition list, validator, confirm, resolver and writers are deleted.
- The eight readers go through `core/settings/platformRead.ts`, a typed wrapper over `resolvePlatformSetting()` on Core's registry (Core cannot import `mount.ts`); a deploy-time hard off still answers without a read.
- `/platform/settings` PATCH and DELETE are strict `writeSetting()` calls and now serve any live operator-edited switch, integer or enum platform entry by registry key or alias (so `storefront.polarisKey.enabled` is written through the registry, behind its L2 typed confirmation). The GET list is unchanged: the aliased A-13 entries.
- The product row-settings route keeps only its scope check and `not_claimed`; value, version, reason and pending checks are `writeSetting()`'s (`requireVersion` / `requireReason` options). Refusal reasons are now `writeSetting()`'s (`expected_version_required`, `pending_setting`).
- `storefrontSwitch.ts` is a separate fail-safe reader (a bad stored value hides the storefront); the resolver would ignore such a value, so it is left as is.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] One resolver and one writer for platform and product settings
- [x] No A-13 parallel settings code remains
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-05a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-05a done`.

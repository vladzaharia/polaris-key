# U-07 Synced settings on `config.*` in Swift and Kotlin

| Field       | Value                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                               |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                                                                                                                     |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-08](U-08-merge-prompt.md), [U-14](U-14-live-pokes.md)                                                                                                                                                            |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                           |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); CI: macOS; CI: Android                                                                                                                  |
| Human input | none                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** client codes from §2.8 (`body_too_large`, not `payload_too_large`); the Q5 policy source: `user` policies come from `/config/schema` cached beside the journal, the compiled mirror before the first fetch, and a refetch when the pull's `catalogVersion` changes; a stale LWW write answers `conflict` with the server copy (Q6).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> As U-06 for Swift and Kotlin: @PolarisSetting and rememberSetting wrap config.setting(key).

- Title: was "SDK user settings in Swift and Kotlin: the same as U-06 plus `@PolarisSetting`, `rememberSetting`, WorkManager retry, `scenePhase` flush, first-sign-in upload, scenario runners".
- Depends on: added SP-35.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: D8's names and codes, `setting(key).sync()`, routes from `syncedSettings` (with `deviceLocal` on the existing `config.local` store), `importLocal` at the HLC floor, the v2 runner plus `settingCases`, and the `setting-*` codes dropped.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: `setting(key).sync` and the `cloudSync` kind as recorded in `api.json`. U-07 gives Kotlin the D9 setting handle.

## Goal

Swift and Kotlin persist and sync user settings like U-06, plus `@PolarisSetting`, `rememberSetting` (optional `:compose`), Android WorkManager retry, Swift `scenePhase` flush, first-sign-in upload and scenario runners.

## Why

Same as U-06 for the native SDKs ([S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-07.
- `sdks/swift/`, `sdks/kotlin/`.

## Scope

**In:** the U-06 surface in both SDKs, property wrappers, background retry and flush, runners, transcripts, parity rows.

**Out** (and where it belongs instead):

- Saves and collections (→ U-25, U-23).

## Design notes

- Native sign-in is device code or QR until I-15.
- **Cloud Sync needs sign-in** (owner, 2026-10-04, final answers): the device has a principal only when it signed in through the product, which needs the product's Identity service (Cloud Sync requires it). A key-activated device, a floating licence or a device that never signed in keeps settings locally only; at the first sign-in local values upload per key with original edit clocks, no prompt.
- **The offer on `account_required`:** the SDK and UI kit offer sign-in (I-08's passthrough: device code or QR, web redirect, native redirect once I-15 lands); never forced, and licence state is untouched.
- **Principal change** (sign-out, a relink of the device's licence that clears the binding, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- `PolarisKeyUI` and the Kotlin component show the sign-in offer screen.

## Steps

1. Swift. 2. Kotlin. 3. Runners and transcripts.

## Acceptance criteria

- [ ] Both SDKs pass the scenario corpus and the settings transcripts; macOS and Android CI green.
- [ ] `parity.json` updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-08 and U-25 build on it.

The role agent sets `--set U-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-07 done`.

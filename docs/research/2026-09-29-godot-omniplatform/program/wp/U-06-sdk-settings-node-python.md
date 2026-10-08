# U-06 Synced settings on `config.*` in Node and Python

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                      |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-15a](U-15a-docs-settings.md), [U-08](U-08-merge-prompt.md), [U-32](U-32-catalog-templates-cloud-sync-page-minted.md)                                    |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                               |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`)                                                                                 |
| Human input | none                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** client codes from §2.8 (`body_too_large`, not `payload_too_large`); the Q5 policy source: `user` policies come from `/config/schema` cached beside the journal, the compiled mirror before the first fetch, and a refetch when the pull's `catalogVersion` changes; a stale LWW write answers `conflict` with the server copy (Q6).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Extend the shipped config.set/clear/setting/onConfigChange with sync state and origin; no setConfig, clearConfig, settingState or onChange; status is a cloudSync events kind. Node and Python.

- Title: was "SDK user settings in Node and Python: local persistence, journal, `setConfig`/`clearConfig`/`settingState`/`onChange`, flush hooks, sign-out rules, first-sign-in upload, `account_required` handling, scenario runner".
- Depends on: added SP-35.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: D8's names and codes, `setting(key).sync()`, routes from `syncedSettings` (with `deviceLocal` on the existing `config.local` store), `importLocal` at the HLC floor, the v2 runner plus `settingCases`, and the `setting-*` codes dropped.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: `setting(key).sync` and the `cloudSync` kind as recorded in `api.json`.
- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: appends its rows to `ui-matrix.json` (§4.8).

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- `config.set` validates against the cached catalog (Python).

## Goal

Node and Python persist user settings locally and, with Cloud Sync on and a signed-in account, sync them: journal, `setConfig`, `clearConfig`, `settingState`, `onChange` with origin, member diffs, flush hooks (`beforeExit`, `atexit`), sign-out rules, first-sign-in upload of the local partition, `account_required` handling that never touches licence state, and a scenario runner.

## Why

User settings fill the existing `local` slot durably ([S-17 §1](../../notes/S-17-user-data-sync.md#1-summary-and-recommendation), [S-17 §5.6](../../notes/S-17-user-data-sync.md#56-how-settings-resolve-on-the-client)); both SDKs today take a fixed table with no setter.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks), [S-17 §5.6](../../notes/S-17-user-data-sync.md#56-how-settings-resolve-on-the-client), [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-06.
- `packages/sdk-node/src/config/`, `sdks/python/src/polaris_key/config/`.

## Scope

**In:** the calls above in both SDKs, transcripts, scenario runner, parity rows.

**Out** (and where it belongs instead):

- Collections and saves (→ U-22, U-13).

## Design notes

- Native sign-in is device code or QR until I-15 (soft dependency).
- Before sign-in, settings persist locally only.
- **Cloud Sync needs sign-in** (owner, 2026-10-04, final answers): the device has a principal only when it signed in through the product, which needs the product's Identity service (Cloud Sync requires it). A key-activated device, a floating licence or a device that never signed in keeps settings locally only; at the first sign-in local values upload per key with original edit clocks, no prompt.
- **The offer on `account_required`:** the SDK and UI kit offer sign-in (I-08's passthrough: device code or QR, web redirect, native redirect once I-15 lands); never forced, and licence state is untouched.
- **Principal change** (sign-out, a relink of the device's licence that clears the binding, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- Never consulted by licence or entitlement code (T5).

## Steps

1. Local persistence and journal. 2. Sync and flush. 3. Runner and transcripts.

## Acceptance criteria

- [ ] Both SDKs pass the full scenario corpus and the settings transcripts.
- [ ] `account_required` sets `status()` to `blocked` without touching licence state (test), and surfaces the sign-in offer (test).
- [ ] A key-activated device whose licence is attached to an account but which never signed in stays local-only (scenario).
- [ ] `parity.json` updated for both SDKs.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/sdk-node test
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-08 adds the merge prompt; U-15a documents the API.

The role agent sets `--set U-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-06 done`.

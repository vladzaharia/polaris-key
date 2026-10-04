# U-06 SDK user settings in Node and Python: local persistence, journal, `setConfig`/`clearConfig`/`settingState`/`onChange`, flush hooks, sign-out rules, first-sign-in upload, `account_required` handling, scenario runner

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                     |
| Size        | 1–1.4 engineer-weeks                                                                                                                              |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10a](I-10a-sdk-identity-node-react-python.md) |
| Unblocks    | [U-15a](U-15a-docs-settings.md), [U-08](U-08-merge-prompt.md)                                                                                     |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                              |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                 |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`)                                |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Goal

Node and Python persist user settings locally and, with Cloud Sync on and a principal (signed in, or the licence attached to an account), sync them: journal, `setConfig`, `clearConfig`, `settingState`, `onChange` with origin, member diffs, flush hooks (`beforeExit`, `atexit`), sign-out rules, first-sign-in upload of the local partition, `account_required` handling that never touches licence state, and a scenario runner.

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

- Native sign-in (Identity products only) is device code or QR until I-15 (soft dependency).
- Before the device binds, settings persist locally only.
- **When the device binds** (owner clarification, 2026-10-04): Cloud Sync depends on the Polaris Key account, not on the product's Identity toggle. The device has a principal when it signed in through the product (Identity on) or when its licence is attached to an account (any product: portal Activate License, Library, Discover). "First sign-in" below means this first bind; local values upload then, per key with original edit clocks, no prompt.
- **The offer on `account_required`:** on a product without Identity the SDK and UI kit never show app sign-in; they show "Add this licence to your Polaris Key account to sync" with the Worker-built portal link (an offer, never forced). On a product with Identity they may also offer sign-in.
- **Principal change** (detach or relink on the licence-owner line, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- Never consulted by licence or entitlement code (T5).

## Steps

1. Local persistence and journal. 2. Sync and flush. 3. Runner and transcripts.

## Acceptance criteria

- [ ] Both SDKs pass the full scenario corpus and the settings transcripts.
- [ ] `account_required` sets `status()` to `blocked` without touching licence state (test), and surfaces the portal link, with sign-in only when Identity is on (test).
- [ ] A device whose licence is attached later starts syncing without sign-in on a product with Identity off (scenario).
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

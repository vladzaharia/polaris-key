# U-20 Synced settings on `config.*` in React

| Field       | Value                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                                         |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                  |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-08](I-08-app-passthrough.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-31](SP-31-node-bridge-v4.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-08](U-08-merge-prompt.md)                                                                                                                                                                                                  |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                  |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                                     |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`)                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                             |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** client codes from §2.8 (`body_too_large`, not `payload_too_large`); the Q5 policy source: `user` policies come from `/config/schema` cached beside the journal, the compiled mirror before the first fetch, and a refetch when the pull's `catalogVersion` changes; a stale LWW write answers `conflict` with the server copy (Q6).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> As U-06 for React: useConfigSetting (plus useConfig), no useSetting; bridge v4 (SP-31) carries the existing verbs on desktop.

- Title: was "SDK user settings in React: web (IndexedDB journal, one writer tab, bearer device token from I-08's web redirect, `pagehide` flush) and desktop (bridge v4), `useSetting`, `ConfigPanel` persistence, first-sign-in upload, scenario runner".
- Depends on: added SP-35 and SP-31.

## Goal

React persists and syncs user settings on the web (IndexedDB journal, one writer tab over `BroadcastChannel`, bearer device token from I-08's web redirect, `pagehide` flush) and on desktop (main-process journal, bridge v4), with `useSetting`, `ConfigPanel` persistence, first-sign-in upload and a scenario runner.

## Why

A web app is a browser device with a bearer token, never a cookie ([S-17 §1](../../notes/S-17-user-data-sync.md#1-summary-and-recommendation), decision 19).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md); `plans/I-04.md` (web redirect).
- [S-17 §1](../../notes/S-17-user-data-sync.md#1-summary-and-recommendation) (browser), [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) (bridge v4), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-20, [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 19.
- `packages/sdk-react/src/components/ConfigPanel.tsx:52-55`, `packages/sdk-react/src/desktop/bridge.ts:1-30`.

## Scope

**In:** both runtimes, `useSetting`, `ConfigPanel` persistence, bridge contract v3 → v4, transcripts including CORS, scenario runner, parity rows.

**Out** (and where it belongs instead):

- Saves UI (→ U-13).

## Design notes

- Strict-CSP guidance for web apps (T13); the token is scoped to one user in one product.
- **Cloud Sync needs sign-in** (owner, 2026-10-04, final answers): the device has a principal only when it signed in through the product, which needs the product's Identity service (Cloud Sync requires it). A key-activated device, a floating licence or a device that never signed in keeps settings locally only; at the first sign-in local values upload per key with original edit clocks, no prompt.
- **The offer on `account_required`:** the SDK and UI kit offer sign-in (I-08's passthrough: device code or QR, web redirect, native redirect once I-15 lands); never forced, and licence state is untouched.
- **Principal change** (sign-out, a relink of the device's licence that clears the binding, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- **Web Cloud Sync uses I-08's web redirect** ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 23, decided by the owner 2026-10-04 in the final answers): the browser device token comes only from that sign-in, which needs the product's Identity service; there is no key-activated browser path, and a web app that has not signed in gets local persistence only (test). React desktop signs in like the native SDKs.

## Steps

1. Web journal and single writer. 2. Desktop bridge v4. 3. Runner and transcripts.

## Acceptance criteria

- [ ] Web and desktop pass the scenario corpus; CORS transcripts pass from a listed origin and fail from an unlisted one.
- [ ] `parity.json` updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/sdk-react test
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-13 adds saves; U-08 adds the merge prompt component.

The role agent sets `--set U-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-20 done`.

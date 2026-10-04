# U-20 SDK user settings in React: web (IndexedDB journal, one writer tab, bearer device token from I-08's web redirect, `pagehide` flush) and desktop (bridge v4), `useSetting`, `ConfigPanel` persistence, first-sign-in upload, scenario runner

| Field       | Value                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                      |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-08](I-08-app-passthrough.md) |
| Unblocks    | [U-08](U-08-merge-prompt.md)                                                                                                                                                       |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                               |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`)                                                                 |
| Human input | none                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                          |

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

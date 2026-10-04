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
- **When the device binds** (owner clarification, 2026-10-04): Cloud Sync depends on the Polaris Key account, not on the product's Identity toggle. The device has a principal when it signed in through the product (Identity on) or when its licence is attached to an account (any product: portal Activate License, Library, Discover). "First sign-in" below means this first bind; local values upload then, per key with original edit clocks, no prompt.
- **The offer on `account_required`:** on a product without Identity the SDK and UI kit never show app sign-in; they show "Add this licence to your Polaris Key account to sync" with the Worker-built portal link (an offer, never forced). On a product with Identity they may also offer sign-in.
- **Principal change** (detach or relink on the licence-owner line, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- **Web on a product without Identity ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 23, proposed).** I-08's web redirect is sign-in through the product, so it exists only with Identity on. Default: no new route; a browser device activated by licence key follows its licence owner like any device, and a web app with neither gets local persistence only. U-01 records the rule; this package tests both cases. React desktop follows the licence-owner line like the native SDKs.

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

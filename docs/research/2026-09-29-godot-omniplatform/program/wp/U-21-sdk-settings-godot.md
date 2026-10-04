# U-21 SDK user settings in Godot: `PKeyUserSettingsStore`, journal in `user://` (IndexedDB on web export), autoload flush, `PKeySettingsPanel`, first-sign-in upload, GDScript scenario runner

| Field       | Value                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                      |
| Size        | 1–1.4 engineer-weeks                                                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md) |
| Unblocks    | [U-15a](U-15a-docs-settings.md), [U-08](U-08-merge-prompt.md), [U-14](U-14-live-pokes.md)                                                          |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                           |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); web export check               |
| Human input | none                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                          |

## Goal

Godot persists and syncs user settings: `PKeyUserSettingsStore` (journal in `user://`, IndexedDB on web export) becomes the default store, an autoload flushes on pause and close, `PKeySettingsPanel` edits settings, first sign-in uploads local values, and a GDScript runner replays the scenario corpus.

## Why

Godot already has a writable, local-only `PKeyOverrideStore`; this makes it durable and synced ([S-17 §1](../../notes/S-17-user-data-sync.md#1-summary-and-recommendation)). Godot is first on the path to save slots ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages), the Godot path).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md).
- [S-17 §5.11](../../notes/S-17-user-data-sync.md#511-sdk-api-sketches), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-21 and "The Godot path".
- `sdks/godot/addons/polaris_key/services/config/override_store.gd`, `sdks/godot/addons/polaris_key/polaris_key.gd:34-44, 185, 220`.

## Scope

**In:** the store, autoload flush, settings panel, first-sign-in upload, runner, transcripts, parity rows, web export.

**Out** (and where it belongs instead):

- Saves (→ U-25).

## Design notes

- Avoid `sync` in API names (`sync()`, `sync_finished` exist); the namespace is `cloud_sync`.
- **When the device binds** (owner clarification, 2026-10-04): Cloud Sync depends on the Polaris Key account, not on the product's Identity toggle. The device has a principal when it signed in through the product (Identity on) or when its licence is attached to an account (any product: portal Activate License, Library, Discover). "First sign-in" below means this first bind; local values upload then, per key with original edit clocks, no prompt.
- **The offer on `account_required`:** on a product without Identity the SDK and UI kit never show app sign-in; they show "Add this licence to your Polaris Key account to sync" with the Worker-built portal link (an offer, never forced). On a product with Identity they may also offer sign-in.
- **Principal change** (detach or relink on the licence-owner line, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- The `addons/polaris_key/ui` offer screen shows the portal link as a QR code for TVs.

## Steps

1. Store and journal. 2. Flush and panel. 3. Runner, transcripts, web export check.

## Acceptance criteria

- [ ] The GDScript runner passes the scenario corpus; the web export persists settings.
- [ ] `parity.json` updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-08's Godot slice can start as soon as this lands.

The role agent sets `--set U-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-21 done`.

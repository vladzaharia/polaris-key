# U-21 Synced settings on `config.*` in Godot

| Field       | Value                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                               |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                        |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-15a](U-15a-docs-settings.md), [U-08](U-08-merge-prompt.md), [U-14](U-14-live-pokes.md)                                                                                                                           |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                           |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; all six SDKs (`parity:check`); web export check                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** client codes from §2.8 (`body_too_large`, not `payload_too_large`); the Q5 policy source: `user` policies come from `/config/schema` cached beside the journal, the compiled mirror before the first fetch, and a refetch when the pull's `catalogVersion` changes; a stale LWW write answers `conflict` with the server copy (Q6).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> As U-06 for Godot: config.set and config.setting over PKeyUserSettingsStore; one event(kind, data) signal, no settings_changed/status_changed.

- Title: was "SDK user settings in Godot: `PKeyUserSettingsStore`, journal in `user://` (IndexedDB on web export), autoload flush, `PKeySettingsPanel`, first-sign-in upload, GDScript scenario runner".
- Depends on: added SP-35.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: D8's names and codes, `setting(key).sync()`, routes from `syncedSettings` (with `deviceLocal` on the existing `config.local` store), `importLocal` at the HLC floor, the v2 runner plus `settingCases`, and the `setting-*` codes dropped.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: `setting(key).sync` and the `cloudSync` kind as recorded in `api.json`.

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
- **Cloud Sync needs sign-in** (owner, 2026-10-04, final answers): the device has a principal only when it signed in through the product, which needs the product's Identity service (Cloud Sync requires it). A key-activated device, a floating licence or a device that never signed in keeps settings locally only; at the first sign-in local values upload per key with original edit clocks, no prompt.
- **The offer on `account_required`:** the SDK and UI kit offer sign-in (I-08's passthrough: device code or QR, web redirect, native redirect once I-15 lands); never forced, and licence state is untouched.
- **Principal change** (sign-out, a relink of the device's licence that clears the binding, or a different subject after a merge alias resolves) is handled like sign-out: no flush to the new principal, the cloud cache is dropped, local values stay as the unbound partition (scenario).
- The `addons/polaris_key/ui` offer screen shows the device-code sign-in as a QR code for TVs.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

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

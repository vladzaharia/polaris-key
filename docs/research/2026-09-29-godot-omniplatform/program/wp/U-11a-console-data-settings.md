# U-11a Users -> Data tab (absorbs U-11b, U-11c)

| Field       | Value                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                                                               |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                                                                                                                     |
| Depends on  | [U-03](U-03-account-overrides.md), [U-05](U-05-cloud-sync-do.md), [I-12](I-12-console-users.md), [ST-08](ST-08-product-settings-hub.md), [U-29](U-29-effective-config-provenance.md), [U-09](U-09-collections-backend.md), [U-10](U-10-saves-backend.md), [ST-07](ST-07-settings-row-v2.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                          |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                                                                                                                                                                    |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; accessibility and console tests; cross-product visibility test                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the registry hub area (S-18) for the Cloud Sync data settings.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One Users -> Data tab: per-key table from U-29's effective-config read (account override, synced choice, effective), quota meter, records and files browser with history and restore (absorbs U-11b, U-11c), audit and step-up; on ST-07's settings engine; components shared with PX-18.

- Title: was "Console Data tab, settings half: settings, account overrides, "what the app sees", quota meters, audit and step-up on I-12's Users page".
- Depends on: added U-29, U-09, U-10 and ST-07.
- Absorbs U-11b: One Data tab for one store.
- Absorbs U-11c: One browser for one store.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: one quota number per tier, shown read-only with a link to Tiers, plus the ceiling and the pause state. Labels are read server-side.

## Goal

The console's Users page (I-12) gains a Data tab for one pairwise subject: settings, account overrides, "what the app sees" (the effective values with sources), quota meters, and audit, with step-up for writes.

## Why

Operators need to support customers' synced settings without seeing other products ([S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces)).

## Read first

- `AGENTS.md` (always); `docs/design/ADMIN.md`.
- [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-11.
- I-12's Users page.

## Scope

**In:** the settings half of the Data tab.

**Out** (and where it belongs instead):

- Saves (→ U-11b); collections (→ U-11c).

## Design notes

- **In the settings hub (S-18, owner, 2026-10-04).** The Cloud Sync console section lands as an area of the product settings hub built by [ST-08](ST-08-product-settings-hub.md), using `SettingsRow` v2.
- Pairwise subject only; every read and write audited (T10).
- The Data tab appears on I-12's Users page for every product with Cloud Sync on, which implies Identity on (owner, 2026-10-04, final answers).
- Contact email follows S-16 D19 (accepted): the buyer email, and the account's primary email only with the person's consent.

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

1. Admin routes. 2. Tab UI.

## Acceptance criteria

- [ ] The tab shows only this product's subject data (test).
- [ ] Writes need step-up and are audited (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- U-11b and U-11c add their halves.

The role agent sets `--set U-11a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-11a done`.

# ST-17 Resync dry-run on the core ingest pipeline

| Field       | Value                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (phase 4: manifest round trip)                                                  |
| Size        | 0.8–1.1 engineer-weeks                                                                                                         |
| Depends on  | [ST-01c](ST-01c-settings-backfill.md), [ST-08](ST-08-product-settings-hub.md), [P0-26](P0-26-core-manifest-ingest-pipeline.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-18](ST-18-promote-export.md), [ST-25](ST-25-legacy-retirement.md)                  |
| Role        | `pkey-implementer`                                                                                                             |
| Plan mode   | no                                                                                                                             |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); console CSP parity                                                                        |
| Human input | none                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                      |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> The dry-run plan is produced by P0-26's core ingest pipeline; resync, link and the deploy hook all call it.

- Title: was "Resync dry-run plan shared by resync, link and the deploy hook; drift endpoint and view from the snapshot; Revert and Keep".
- Depends on: added P0-26.

## Goal

Resync, link and the deploy hook share one dry-run plan (`apply`, `skipClaimed`, `delete`, `conflicts`), stored in `product_sync_state.plan_json`; the hub shows drift from the snapshot with Revert and Keep.

## Why

Model C is safe only if operators can see what a resync will do and where console and manifest differ ([S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 4–5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-17.

## Scope

**In:**

- `POST …/resync?dryRun=1`; plan function shared by the three paths; `plan_json`; drift endpoint and view.
- The plan carries the validator's `warnings[]` (`validateIngestDocuments`; ST-19's
  `deprecated_spelling` and `conflicting_spelling` among them), stored in `plan_json` with the rest,
  and the console's Resync confirm shows them ([`plans/ST-19.md`](../plans/ST-19.md) owner decision
  Q6). Warnings never block an apply.

**Out** (and where it belongs instead):

- Promote to repo (→ ST-18).

## Design notes

- Reuses ST-01c's classifier.

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

1. Plan function.
2. Endpoint.
3. Drift view.

## Acceptance criteria

- [ ] The webhook path records the same plan it applies (test).
- [ ] Drift lists every claimed field with Revert and Keep (e2e).
- [ ] A manifest with a deprecated spelling shows its warning in the dry-run plan and the Resync confirm (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-18 promotes selected claims.

The role agent sets `--set ST-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-17 done`.

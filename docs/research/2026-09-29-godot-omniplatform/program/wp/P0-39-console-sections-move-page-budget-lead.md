# P0-39 Console sections move and page budget (lead window)

| Field       | Value                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                  |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                                                                 |
| Depends on  | [P0-31](P0-31-console-shared-layer-cleanup-lead-window.md)                                                                                                                                                                                                                                             |
| Unblocks    | [P0-32](P0-32-one-data-layer-console-portal.md), [P0-34](P0-34-shared-hash-router-core.md), [P0-35](P0-35-vocabularies-as-data-platforms.md), [P0-51](P0-51-1-0-readiness-review.md), [ST-07](ST-07-settings-row-v2.md), [ST-39](ST-39-wizard-kit.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                                                                     |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-10** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Console sections move and page budget (lead window), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-10** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.1, §4.2, §4.3, for **CQF-10**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- Mechanical move to console/sections/<section>/{pages,components,model,data.ts} with git mv and an import codemod in the batch-6 window; a 600-line page budget test with a shrinking allow-list (AppStorePage, platformStores, Overview, ReleaseRecord, platformOperations, CredentialsPage, OutletsPage are split by the domain packages that rebuild them); TabPanel on every record (MO-13 follow-up); update FeedPage renamed UpdateChannelsPage.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-10**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Run by the lead in a short window (tracks.md rule 2); every package that touches the moved files depends on it, so no branch is in flight across the codemod.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Sections layout in place; history preserved by git mv
- [ ] Page budget test blocking for new pages
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-39 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-39 done`.

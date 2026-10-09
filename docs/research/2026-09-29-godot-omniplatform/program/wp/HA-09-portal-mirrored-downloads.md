# HA-09 Portal licensed downloads prefer the mirrored R2 copy with PX-W3's download ticket over GitHub's `browser_download_url` (fixes private-repo 404s)

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 3: serve) |
| Size        | 0.2–0.4 engineer-weeks                                                            |
| Depends on  | [HA-08](HA-08-release-mirroring.md), [PX-W3](PX-W3-licensed-r2-downloads.md)      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-09](PX-09-get-it-complete.md)         |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | portal e2e; THREAT-MODEL                                                          |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Small; ship before PX-09 (fixes private-repo 404s). P0-23 later moves its mint behind the delivery.downloadToken hook.

## Goal

`downloadTarget` picks the R2 copy with a ticket first, then today's order. A licensed file in a private GitHub repo downloads from the portal instead of 404ing.

## Why

GitHub's `browser_download_url` for a private repo 404s for an anonymous browser ([S-20 §4.3](../../notes/S-20-hosted-assets.md#43-release-deliverables-and-update-feeds) R3). Once files are mirrored, PX-W3's ticket covers them.

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- PX-W3 plan (`plans/PX-W3.md`).
- `portal/api.ts` (`downloadTarget`, `redirectableSourceUrl`).

## Scope

**In:**

- Reorder `downloadTarget`. Tests for public, licensed with a mirror, and licensed without a mirror.

**Out** (and where it belongs instead):

- The ticket itself (PX-W3).

## Design notes

- No new reason code. `not_hosted` stays for files with no serving location.

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

1. Reorder and test.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `distribution.download-page`.

## Acceptance criteria

- [ ] A licensed private-repo fixture returns a dl URL with `?ticket=` (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

None.

The role agent sets `--set HA-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-09 done`.

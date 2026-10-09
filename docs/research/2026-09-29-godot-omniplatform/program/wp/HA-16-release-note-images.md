# HA-16 Optional: release-note images hosted (`notes-image:<urlhash>` slots) and rendered from the media host at render time; the signed `notes` text is never rewritten

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 6: optional) (optional) |
| Size        | 0.4–0.6 engineer-weeks                                                                          |
| Depends on  | [HA-05](HA-05-pull-on-sync.md), [HA-07](HA-07-serve-hosted-copies.md)                           |
| Unblocks    | none                                                                                            |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no                                                                                              |
| Gates       | THREAT-MODEL; portal e2e; feed goldens                                                          |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive after A-27 if notes need hosted images; What's New formatting ships in ST-36. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Release-note images. Revive after A-27 if notes need hosted images; What's New formatting ships in ST-36.

## Goal

Image links in release notes are pulled into hosted copies. The portal's What's New, the download page and the AltStore source render those images from the media host, or drop them, instead of mangling (`!alt`) or hotlinking them.

## Why

Notes images are mangled or hotlinked today. The notes text is inside the signed release record and cannot change ([S-20 §4.4](../../notes/S-20-hosted-assets.md#44-release-notes-docs-links-and-email) N1).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.4.
- `release/changelog.ts`, `page/model.ts` (`stripMarkdown`), `portal/components/product/WhatsNew.tsx`, `feeds/render.ts`.

## Scope

**In:**

- Extract https image links at release ingest and pull them (5 MiB cap).
- Render-time URL map.
- The portal renders `<img>` only for hosted URLs.

**Out** (and where it belongs instead):

- Rewriting signed notes (forbidden).

## Design notes

- Unhosted images render as their alt text, never as a hotlink.

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

1. Extract and pull.
2. Render.

## Acceptance criteria

- [ ] A notes image appears from the media host in What's New, and the signed record bytes are unchanged (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

None.

The role agent sets `--set HA-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-16 done`.

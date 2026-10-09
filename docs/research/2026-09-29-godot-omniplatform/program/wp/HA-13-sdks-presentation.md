# HA-13 SDKs and UI kits read presentation: client-core, React, Node, Python, Swift, Kotlin (icon verified by SHA-256, accent default, integrator override wins)

| Field       | Value                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                                                                                |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                            |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-12](HA-12-presentation-discovery.md)                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-41](ST-41-integration-page-overview-card.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [UK-41](UK-41-must-tier-closeout.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                            |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md)                                                                                                                |
| Gates       | plan mode; all SDKs; corpus and transcript runners; UI snapshots                                                                                                                |
| Human input | none                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> SDKs read presentation through the PresentationSource seam the kits consume.

## Goal

Each SDK exposes the product's presentation from discovery. React, Swift and Kotlin UI kits default their logo to the verified icon, and their accent to the product accent, when the integrator passes nothing. Parity manifests are updated.

## Why

It completes "zero integrator work" for every non-Godot SDK ([S-20 §6.9](../../notes/S-20-hosted-assets.md#69-sdks-and-ui-kits-icon-and-accent-with-zero-integrator-work)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- `plans/HA-11.md`.
- PARITY.md; each kit's theme (`sdk-react/src/components/brand.tsx`, `PolarisTheme.swift`, `PolarisTheme.kt`).

## Scope

**In:**

- Discovery types, icon fetch and cache keyed by `sha256`, kit defaults, UI snapshots.

**Out** (and where it belongs instead):

- Godot (→ HA-14).

## Design notes

- A failed or mismatched icon falls back to the letter tile silently.
- **UI kits (owner decision, 2026-10-05).** This package is the only path by which presentation reaches a kit. Expose it as each SDK's presentation accessor and implement the kit core's `PresentationSource` seam: `@polaris-key/ui-core` (UK-03), the Swift presentation core (UK-07), Kotlin `commonMain` (UK-09) and `polaris_key.ui.core` (UK-12). Where a UK kit has not landed yet, wire today's kit theme as planned; the UK kit then reads the same accessor. No kit fetches discovery or caches the icon itself. UK-41 verifies the default end to end ([UI-KITS.md](../../../../design/UI-KITS.md) §1.2, §10).

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

## Approved plan (2026-10-06)

[`plans/HA-11.md`](../plans/HA-11.md) is approved. This package does rows 1–5 of the plan's §5.

- **client-core is consumed, not written.** HA-12 writes `@polaris-key/client-core/presentation`
  (`parsePresentation`, `pickIconSize`, `iconMatches`, `PresentationSource`). React and Node use
  it directly.
- **Ports.** Python, Swift and Kotlin port the parse, size-choice and verify rules and the
  `PresentationSource` seam:
  - Python: `polaris_key.presentation.PresentationSource`;
  - Swift: `PresentationSource` in `PolarisKeyCore`;
  - Kotlin: `im.plrs.key.core.PresentationSource`.

  The UK kits import these seams; none defines its own.

- **Matrix runners** for `presentation-matrix.json`: Node (`conformance/runners/node`), the
  browser runner, Python, Swift and Kotlin `:conformance`. Each SDK replays
  `discovery-presentation.json`.
- **Fetch-rule unit tests.** No auth, cookies or `X-PKey-*` headers; no redirects; 10 s timeout;
  10 MiB cap; cache by `sha256` outside the Core cache record; `presentation.json` persisted for
  cold boots; at most 4 cached files.
- **Parity.** Flip `core.presentation` to `implemented` in each manifest.

**Amended by [`plans/HA-12.md`](../plans/HA-12.md) (approved 2026-10-06).**

- The contract text is `WIRE-CONTRACT-V4.md` **§5.5**, not §5.3.
- The usable-URL rule pins no host; staging and dev serve images from `img-staging` and `img-dev`
  (not `media-staging` and `media-dev`).
- Read every limit from the generated constants (Q6), never a literal: `PRESENTATION_TEXT_MAX_BYTES`,
  `PRESENTATION_URL_MAX_BYTES`, `PRESENTATION_MAX_ICON_SIZES`, `PRESENTATION_MAX_ICON_WIDTH`,
  `PRESENTATION_ICON_MAX_DIMENSION`, `PRESENTATION_ICON_MAX_BYTES`,
  `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS`, `PRESENTATION_CACHE_MAX_FILES` and
  `PRESENTATION_ICON_TYPES`.
- The §5.5 text rule drops a `name` or `developerName` holding a C0 control, DEL, a C1 control
  or a lone surrogate, and nothing else, so bidi controls survive (Q5). The URL rule is §5.5
  rule 5 as HA-12 tightened it in review (port, host and `{w}` placement). Every kit renders
  `name` and `developerName` in a bidi-isolated run (`<bdi>` or `dir="auto"` on the web, FSI…PDI
  elsewhere).

## Steps

1. Per the plan, in its SDK order.

## Acceptance criteria

- [ ] Every SDK in scope runs `presentation-matrix.json` (`parseCases`, `pickCases`, `verifyCases`) green and replays `discovery-presentation.json`.
- [ ] Transcript replayers pass in every SDK.
- [ ] UI snapshots show the product icon for a fixture with presentation, and today's output without it.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `build/ui/theming` (presentation).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm test
```

## Hand-off

None.

The role agent sets `--set HA-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-13 done`.

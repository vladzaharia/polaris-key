# A-23 Channel setup: wizards and the setup runner

| Field       | Value                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                             |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                              |
| Depends on  | [A-22](A-22-channel-page-status-releases-listing.md), [ST-39](ST-39-wizard-kit.md), [A-28](A-28-one-store-app-binding-derived-identity.md), [P0-27](P0-27-one-adapter-store-delivery-commerce.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-33](A-33-channels-enable-in-one-confirmation.md)                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                |
| Gates       | none beyond the green gate                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-06** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-55, UX-68.

## Goal

Channel setup: wizards and the setup runner, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-06** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **DC-06**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- Human-step wizards per facet (UX-55) on ui/wizard's drawer host; the setup runner (UX-68) over each store adapter's requirements() (P0-27) performs every automatable action after one Set up consent (a core.setup choice) and re-runs on fact changes (a new build platform, a new credential); team-key app matching to build identities; testing tracks receive every release by the channel's track map (P2-08), and mapping no track means no automatic sends (no per-channel switch). Non-store channels (Homebrew, winget, Scoop, package feeds, Polaris Key) automate now; each store's rows stay human steps until A-18k verifies that store.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-06**; DX consolidation H: Distribution channels, storefronts and commerce.
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

- [ ] Homebrew's setup runs end to end from the wizard with the GitHub App's write access
- [ ] Store rows are human steps until A-18k's verified answer for that store (test fixture)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-23 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-23 done`.

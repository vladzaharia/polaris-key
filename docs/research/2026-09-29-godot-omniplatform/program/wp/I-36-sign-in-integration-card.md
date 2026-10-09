# I-36 Sign-in Integration card

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                                                                  |
| Size        | 0.6–1 engineer-weeks                                                                                                                                                                               |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-29](I-29-retire-product-account-toggles-one-app.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md), [ST-41](ST-41-integration-page-overview-card.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                 |
| Gates       | `console-csp-parity`                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                          |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-11** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Goal

Sign-in Integration card, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-11** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §5, for **IX-11**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- The Sign-in card on Integration (the web card writes core.web.origins and redirectPaths in one confirmed action; native cards derived; device code needs nothing) with SP-33a snippets; Verified per sign-in surface from the identity bit of sdk_sightings (the SDK calls I-08's token endpoint). No test-sign-in mode: the operator signs in with their own account or uses ST-41's inline test licence.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-11**; DX consolidation F: Identity.
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

- [ ] The card renders on ST-41
- [ ] Verified ticks on the first real sign-in per sign-in surface
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-36 done`.

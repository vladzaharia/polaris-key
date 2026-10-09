# LX-19 Six SDKs on the licensing wire (one wave with LX-20)

| Field       | Value                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire)                                                                                                                              |
| Size        | 1.6–2.25 engineer-weeks                                                                                                                                                                                     |
| Depends on  | [LX-18](LX-18-licensing-wire.md), [LX-17](LX-17-sdk-licenseid-audit.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [UK-03](UK-03-ui-core.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-15](CM-15-sdk-purchase-handoff.md)                                                                                                                              |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/LX-18.md`](../plans/LX-18.md) (no separate plan)                                                                                                                         |
| Gates       | plan mode; all six SDKs (`parity:check`); every conformance runner; visual baselines (both themes, phone)                                                                                                   |
| Human input | none                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                   |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One SDK wave with LX-20 on SP-35's names (entitlements.has/value/grants, quantity, duration via term(), consume and acknowledge for consumables); kit badges render through ui-core in the rebuilt kits.

- Title: was "Six SDKs and four UI kits on the licensing wire: `isEntitled` gated on usable and expiry, `entitlement()`, `grants()`, `licenseExpiresAt()`, status reasons, LX-17 fixes, migration guide and release notes".
- Depends on: added SP-35 and UK-03.

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/SP-35.md`](../plans/SP-35.md) §12: the `entitlements.*` names, `license.term()` and the `entitlement` kind. [`plans/UK-02b.md`](../plans/UK-02b.md) §8: appends its rows to `ui-matrix.json` (§4.8).

## Goal

All six SDKs and four UI kits implement the licensing wire: `isEntitled` false unless the gate is usable and unexpired, `entitlement()`, `grants()`, `licenseExpiresAt()`, status reasons, the LX-17 fixes, plus a migration guide and release notes.

## Why

Decision 14 makes `isEntitled` false whenever the gate is not usable, in all six SDKs ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 14).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.10](../../notes/S-19-licensing-model.md#710-wire-impact-plan-mode), [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-19.
- `program/plans/LX-18.md`.

## Scope

**In:**

- Node, React (client-core), Python, Swift, Kotlin, Godot; UI kits; LX-17 fixes; migration guide; release notes.

**Out** (and where it belongs instead):

- Commerce clients (→ LX-20).

## Design notes

- Behaviour is defined by the corpus and transcripts; verdicts must match byte for byte.

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

1. client-core first, then each SDK.
2. UI kits.
3. Docs.

## Acceptance criteria

- [ ] Every conformance runner passes.
- [ ] `parity.json` updated in every SDK.
- [ ] Migration guide published.
- [ ] Every kit renders renew copy for an expired licence, from the reason LX-18 carries ([SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- LX-21 may use `onRefresh` once LX-17's failures are fixed here.

The role agent sets `--set LX-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-19 done`.

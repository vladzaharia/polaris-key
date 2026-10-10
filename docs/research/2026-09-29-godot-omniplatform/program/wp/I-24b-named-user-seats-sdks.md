# I-24b Named-user seats in the SDKs: Node, React, Python, Swift, Godot and Kotlin read the user claim and policy keys, `device_limit` `scope: "user"` and `account_required` copy, plus the React, SwiftUI, Godot and Compose kits

| Field       | Value                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (later)                                                                                                       |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                             |
| Depends on  | [I-24](I-24-named-user-seats.md), [I-24a](I-24a-named-user-seats-server.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                                                                             |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                             |
| Plan mode   | yes: executes the approved [`plans/I-24.md`](../plans/I-24.md) §5 (SDKs and UI kits)                                                                                             |
| Gates       | plan mode; all six SDKs (`parity:check`, `gen constants --check`); transcripts replayed; UI-kit snapshots; macOS and Android CI                                                  |
| Human input | none                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                        |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive condition (the note): Parked with I-24a; kit screens would render in the rebuilt kits only. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Parked with I-24a; kit screens would render in the rebuilt kits only.

## Goal

Node, React, Python, Swift, Godot and Kotlin expose the named-user seat claim and the policy keys,
show `device_limit` with `scope: "user"` and `account_required` with the right copy, and the React,
SwiftUI, Godot and Compose kits render them, each proven by I-24a's transcripts.

## Why

[`plans/I-24.md`](../plans/I-24.md) Q8 (approved 2026-10-05) splits the SDK half out of I-24, following
the I-10a and I-10b precedent.

## Read first

- `AGENTS.md` (always); [`plans/I-24.md`](../plans/I-24.md) §5 and its owner-decisions header.
- I-24a's PR (the readers, codes and transcripts); I-10a and I-10b (the identity surface this builds on).

## Scope

**In:** plans/I-24.md §5 for the six SDKs and four UI kits, in the plan's order.

**Out:** the server, corpus and client-core (→ I-24a).

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

1. Node over client-core, then React, Python, Swift, Godot and Kotlin.
2. The UI kits with their SDKs.

## Acceptance criteria

- [ ] Each SDK replays I-24a's transcripts and passes `parity:check`.
- [ ] UI-kit snapshots for the per-user refusal.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen constants --check
```

## Hand-off

- LX-24 builds per-seat features on top.

The role agent sets `--set I-24b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-24b done`.

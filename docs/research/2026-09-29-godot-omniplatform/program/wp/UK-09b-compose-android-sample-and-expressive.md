# UK-09b Compose kit: Android sample, tabs, M3 Expressive, navigation, tablet list-detail, ChannelPicker, BUILT UX

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 0.2–0.3 engineer-weeks                                                       |
| Depends on  | [UK-09](UK-09-compose-android.md)                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                       |
| Role        | `pkey-sdk-porter`                                                            |
| Plan mode   | no                                                                           |
| Gates       | `modernity-lint`, `ci:android`, `ci:kotlin`, `docs-links`                    |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Split 2026-10-22 (triage)

Filed from [UK-09](UK-09-compose-android.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 1–1.5 days). UK-09 carries what is on staging; this package carries the rest.

On staging already: UK-09 on staging: KMP `:ui` / `:ui-core`, MatrixSnapshotTest, Compose UK-59 gaps closed. The 10 `ui.*` parity rows are flipped in UK-09 itself (45 min) before it is set done.

## Goal

Compose kit: Android sample, tabs, M3 Expressive, navigation, tablet list-detail, ChannelPicker, BUILT UX. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [UK-09](UK-09-compose-android.md), its Progress and Split notes.

## Scope

**In:**

- The remainder of UK-09 after the parity flip: `examples/ui/compose-android` (90 min), Compose tabs on the 25 component pages (90 min), Material 3 Expressive (2–3 h), nav graph, deep links and the self-starting gate (2 h), tablet list-detail (90 min), the ChannelPicker (1 h) and the BUILT UX pass (1 h).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything UK-09 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `examples/ui/compose-android` builds and runs
- [ ] Compose tab on each of the 25 component pages
- [ ] M3 Expressive applied; nav graph, deep links and self-starting gate work
- [ ] Tablet list-detail layout; ChannelPicker
- [ ] `pkey-ux-reviewer` passes the built screens (BUILT mode)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-09b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-09b done`.

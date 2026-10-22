# UK-12b Qt kit: scrim, Mica, QSS, QAccessible, Flatpak, Qt tabs, BUILT UX

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 0.2 engineer-weeks                                                           |
| Depends on  | [UK-12](UK-12-python-qt.md)                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                       |
| Role        | `pkey-sdk-porter`                                                            |
| Plan mode   | no                                                                           |
| Gates       | `modernity-lint`, `docs-links`                                               |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Split 2026-10-22 (triage)

Filed from [UK-12](UK-12-python-qt.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size about 1 day). UK-12 carries what is on staging; this package carries the rest.

On staging already: UK-12 on staging: `ui/qt/*`, 219 PNG baselines, `examples/ui/qt`, `qt.mdx`.

## Goal

Qt kit: scrim, Mica, QSS, QAccessible, Flatpak, Qt tabs, BUILT UX. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [UK-12](UK-12-python-qt.md), its Progress and Split notes.

## Scope

**In:**

- The remainder of UK-12 after KX-QT-DROP and KX-PY-MODELS land and the `ui.*` parity flip: scrim, Mica, QSS wiring, QAccessible and Flatpak (about 3 h), Qt tabs on the 25 component pages (90 min), and the BUILT UX pass.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything UK-12 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Scrim, Mica, QSS wiring, QAccessible and Flatpak done
- [ ] Qt tab on each of the 25 component pages
- [ ] `pkey-ux-reviewer` passes the built screens (BUILT mode)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-12b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-12b done`.

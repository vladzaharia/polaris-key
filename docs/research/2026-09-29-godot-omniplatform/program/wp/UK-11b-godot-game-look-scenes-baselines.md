# UK-11b Godot kit: game look, five standalone scenes, PNG baselines, UK-59 leftovers, BUILT UX

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 0.3 engineer-weeks                                                           |
| Depends on  | [UK-11](UK-11-godot-kit.md)                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                       |
| Role        | `pkey-godot-engineer`                                                        |
| Plan mode   | no                                                                           |
| Gates       | `modernity-lint`, `docs-links`                                               |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Split 2026-10-22 (triage)

Filed from [UK-11](UK-11-godot-kit.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size about 1.5 days). UK-11 carries what is on staging; this package carries the rest.

On staging already: UK-11 on staging: headless models, all 10 `ui.*` rows implemented, catalog copy; KP-godot, KP-godot-spec, KP-godot-comp, GODOT-tail, GODOT-expired.

## Goal

Godot kit: game look, five standalone scenes, PNG baselines, UK-59 leftovers, BUILT UX. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [UK-11](UK-11-godot-kit.md), its Progress and Split notes.

## Scope

**In:**

- The remainder of UK-11 after KX-GD-PLAY and KX-GD-ID land: the game look (glass sheet, input glyphs, tweens, system scheme, sound and haptics, 60 px TV; 4–6 h), five standalone scenes (3–4 h), PNG baselines (2–3 h), the UK-59 leftovers and the BUILT UX pass. Also the `main` CI Godot 4.4.1 `ui_matrix sign_in / native28` overflow (399 px on a 390 px screen).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything UK-11 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Game look: glass sheet, glyphs, tweens, system scheme, sound/haptics, 60 px TV targets
- [ ] Five standalone scenes
- [ ] PNG baselines committed
- [ ] The Godot 4.4.1 `sign_in / native28` 1170x2532 overflow is fixed
- [ ] UK-59 leftovers closed; `pkey-ux-reviewer` passes the built screens (BUILT mode)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-11b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-11b done`.

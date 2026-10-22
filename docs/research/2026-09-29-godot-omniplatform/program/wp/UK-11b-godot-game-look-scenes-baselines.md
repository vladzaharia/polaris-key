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

## Verified against the code (2026-10-22, tip 328e1a12e)

The code is the fact. Corrections to the scope above:

- **Already shipped; not slice work.** 60 px controls (`PKeyKitTokens.CONTROL_HEIGHT`, the `spacious` density default) and the scrim with its opaque page under `ui_reduce_transparency` and `ui_reduce_motion` (UK-11, DL16). KX-GD-PLAY: nodes run while the tree is paused, `PolarisKey.in_play` and `input_captured`, the shared toast host (`PKeyToast`, `toast_anchor`), What's new and All changes in the update prompt. KX-GD-ID: the live key verdict, the input hint under the key field (words only: "Enter to activate", "A to select"; no glyph), `product.wordmark` and `product.art` in the theme.
- **Standalone scenes already exist** with scenarios, text snapshots and matrix rows: `PKeyDeviceList` (Devices), `PKeyAccountTab`, `PKeyToast`, `PKeyUpdateProgress`, `PKeyLicenseChoice`; the device limit is a state of the gate and the activation panel, and release notes are a section of `PKeyUpdatePrompt`. Still missing as scenes of their own: Paywall (copy exists, no scene), CloudSyncStatus, About, a standalone DeviceLimit, a standalone ReleaseNotes. "Five standalone scenes" is those five, not the nine named in the UK-11 scope.
- **Not shipped before this slice:** glass card, focus glow (`FOCUS_GLOW` was unused), tweens (none), `colorScheme: system`, sound hooks, haptics, the input glyph control. Glass blur (`SCRIM_*_BLUR`, both 0 in the tokens) stays out.
- **The 4.4.1 `sign_in / native28 / 1170x2532@3` overflow is already fixed, but the same row failed on 4.7.2 on the scrim path.** Commit 0b5782771 counts the icon's width in `_fit_label` before Godot 4.5, and `ui_matrix sign_in native28` passes on 4.4.1 (checked 2026-10-22). On 4.7.2 with `PKEY_UI_REDUCE_TRANSPARENCY=0` the row failed on the unchanged base too (the dialog's minimum 400 px on a 390 px screen: the Open browser button's minimum still counts its icon when it does not wrap, so `_fit_label` saw 246 px against a 280 px room and did not wrap). Hidden until now because the 4.7 lane runs the opaque path. Fixed in slice 1: `_icon_extent` counts the icon on every engine.
- **PNG baselines:** `tests/ui/snapshots/` holds text snapshots only; `tools/ui_screenshots.gd` and the new `tools/ui_look_shots.gd` render PNGs but no suite compares them. The kit is not yet in ui-qa's `BASELINE_DIRS`.

## Slices

Each is 90 minutes or less and ends with a BUILT UX review (`pkey-ux-reviewer`, screens built and run, not mockups). Order:

1. **Game look, part 1 (this slice, built).** `PKEY_UI_REDUCE_TRANSPARENCY=0/1` override (and `run_tests.sh` `PKEY_UI_MATRIX_PATHS=both`, set for the 4.7.2 lane in `ci.yml`, so the matrix runs on the scrim path and the opaque path); glass card on the scrim path (94 % dark, 96 % light until the blur ships; opaque under reduced transparency, web and `gl_compatibility`); light scrim 35 %; a ring for multi-line fields before Godot 4.6; focus glow; dialog fade-in and press scale (`PKeyUiMotion`, off under reduced motion); `ui_brand_scheme = "system"` following the OS live; sound hook and haptics (`PKeyUiFeedback`, `ui_sound_hook`, `ui_haptics`); `PKeyInputGlyphs` with the confirm swap, on the activation hint. Look shots: `tools/ui_look_shots.gd`.
2. **Game look, part 2. Must ship before the next Godot SDK release:** until the catalog verb keys land, the hint reads "[Enter] Enter to activate" (the glyph repeats the key name), so hide the glyph if this slice slips past a release. Step crossfade and sheet exit tween; the hint bar on the gate, update prompt and sign-in (needs catalog verb keys, `pnpm gen brand`, so the hint words stop carrying the key name); toast anchor inside 5 % title-safe verified at TV; scheme-follow test on a real OS change; BUILT UX review of slices 1 and 2 together.
3. **PNG baselines.** The shots wait for the entry fade to finish; they must not inherit reduced motion (the loading bar would render its still variant). Promote `ui_screenshots.gd` to a compared suite: dark and light, the UI-KITS §7.1 sizes, committed lossless under `tests/ui/snapshots/`; add the kit to ui-qa's `BASELINE_DIRS`. Largest of the slices; may need two sessions if the compare tolerance across engines is not stable.
4. **Standalone scenes, A:** Paywall and a standalone DeviceLimit on the view models, with scenarios, snapshots and matrix rows.
5. **Standalone scenes, B:** CloudSyncStatus, About and a standalone ReleaseNotes, same shape; BUILT UX review.
6. **UK-59 leftovers** (the Godot targets on the UK-59 boards, listed against the built screens), then the final BUILT UX pass, the full `ui_matrix` on 4.4.1 and on 4.7.2 (both paths) and `set UK-11b in-review`.

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

# UK-50 Godot drop-in fixes ahead of UK-11

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.5–2 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-godot-engineer`                                                                                     |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`                                                                                            |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Goal

Godot drop-in fixes ahead of UK-11, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-50) and §10.4.

## Scope

**In:** `boot()` resolves at READY through Retry (`resolve_on_stop` opts out); `PKeyUiView.sdk` as a setter that re-renders nested views; re-entrant `boot()` and a persistent gate mode; the banner's expired state; starting focus and accessibility names on every interactive screen; one update prompt (a game-placed one replaces the kept one), themed, always with an action; activation not reported ok until documents verify, with verify-failure copy and a developer `push_error`; `for_result` through `message_for`; `confirm_identity` on `boot()`; the settings panel fetches its schema; key entry follows `effective_capabilities`; resources freed at exit; a friendly device name; register and finish the uncommitted `fix/godot-ui-responsive` worktree (product header, landscape sign-in, 1280×720 matrix).

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Registers and finishes the `fix/godot-ui-responsive` worktree (product header, landscape sign-in); its screens are tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] OFFLINE → Try again → READY resolves the awaited `boot()` and changes the scene.
- [ ] Every dialog opened from a live gate renders its content.
- [ ] A re-boot after `sign_out()` shows key entry and Sign in.
- [ ] From a cold boot with no pointer, focus lands on the first control and `ui_down` walks the chain.
- [ ] The branded and neutral sign-in cards fit 1280×720 and 1280×800.
- [ ] A wrong pin and a +2-day clock never show "Activated.".
- [ ] No product screen shows the Pinned K.
- [ ] No leak warning at exit.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-50 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-50 done`.

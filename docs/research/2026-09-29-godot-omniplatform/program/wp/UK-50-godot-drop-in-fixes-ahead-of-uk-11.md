# UK-50 Godot drop-in fixes ahead of UK-11

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.5–2 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-59](UK-59-built-kit-boards-refresh.md)                        |
| Role        | `pkey-godot-engineer`                                                                                     |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`                                                                                            |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: a QR only on pad-only, TV and console screens).
- **In this kit:** Registers the `fix/godot-ui-responsive` work, which carries DL1, DL3, DL10 and DL15, and adds initial focus on every screen (DL9), one update prompt that always has an action (DL4, DL6), and no Pinned K on any product screen (DL5). Drop the QR behind Use another device on phones (DL14).
- **Minimum check:** `suite_ui_matrix` at 1280×720, 1280×800, 640×360 and 1080×2400 in the brand and native looks, with the cold-start focus pass.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- QR (B10): on a keyboard or pointer device Godot runs the §3.17 desktop flow (Continue in browser, Finish in your browser with Open browser again, Cancel and Use a code instead; the code view shows URL, code and Copy, no QR). QR only when `pad_only()` (TV, console, Steam Deck game mode) and for the offline-activation request. Tell the Godot builder: the desktop and tablet QR is dropped. [ ] Matrix assertion 'no QR node visible' on every non-pad row of godot.sign_in; pad-only rows keep it at 160 physical px or more and 42% of the short side or less. (sdk-c-02, sdk-c-03)
- Host owns pause and input: kit-owned roots (sheet and dialog hosts, the autoload's request nodes) run `PROCESS_MODE_ALWAYS` by default with an option to inherit; the kit never sets `SceneTree.paused`; it emits `input_captured(bool)` so the host can pause and route input. [ ] suite_ui: pause the tree while the code view polls; the countdown keeps stepping, the poll completes, Back still cancels, focus returns to the opener; with inherit the kit freezes with the host. Verify in a real engine. (sdk-c-02, sdk-c-03)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `kitboard:godot.html:gate`, `kitboard:godot.html:sign-in`, `kitboard:godot.html:update-toast`.
- `B10.3`, `kitboard:godot.html:update-toast`: B10: the toast keeps title-safe placement and the host-owns-pause rule (set process_mode so kit dialogs survive tree pause; verify in the engine); tell the Godot builder the desktop/tablet QR is dropped; QR-allowed contexts become a ui-matrix row (UK-02b).
- `kitboard:godot.html:sign-in`: B10: the Godot QR is for pad-only/console input only; drop it on desktop, tablet and phone; show the vanity URL.

## Corrections (verified against the code)

- The branch is based on `fix/godot-ui-responsive`, so registering that worktree is this branch.
  Its review nits and the settings-on-a-short-screen defect are the first commits.
- `boot()` resolves at READY in `PKeyBoot.run()`, so the scene and the autoload agree;
  `resolve_on_stop` is read there. A second call joins a run in progress and, after a stop, restarts.
- "Not ok until documents verify" covers a document that arrives and does not verify (an unpinned
  signer, a clock outside its window). A document that does not arrive (no answer, a 5xx) keeps the
  activation ok: the token is good and the next sync fetches it (`license/test_reregister.gd`).
- The friendly device name is the boot's host setting (`options.device_name` when empty); the
  contract's default (model, else the OS name) is unchanged.
- Key entry follows the outlet's `commerce` capability (`store-iap`), so the Microsoft Store now
  hides it too.
- The matrix gains 2532x1170@3 and 750x1334@2 for the settings list. The other screens fail there
  today (the offline dialog's Import below the fold in the native and custom looks, the German and
  Japanese gate a few points wide at 375 pt, a Polaris Key card that scrolls at 844x390): UK-11.

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
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.
- [x] OFFLINE → Try again → READY resolves the awaited `boot()` and changes the scene.
- [x] Every dialog opened from a live gate renders its content.
- [x] A re-boot after `sign_out()` shows key entry and Sign in.
- [x] From a cold boot with no pointer, focus lands on the first control and `ui_down` walks the chain.
- [x] The branded and neutral sign-in cards fit 1280×720 and 1280×800.
- [x] A wrong pin and a +2-day clock never show "Activated.".
- [x] No product screen shows the Pinned K.
- [x] No leak warning at exit.
- [x] `pkey-ux-reviewer` passes every changed screen.
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-50 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-50 done`.

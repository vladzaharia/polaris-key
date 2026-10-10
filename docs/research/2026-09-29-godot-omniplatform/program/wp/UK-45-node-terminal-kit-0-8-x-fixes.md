# UK-45 Node terminal kit 0.8.x fixes

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                                                    |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`                                                                                            |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** The fixes in this package are language fixes: product-first strings (DL5, DL8), refusals with their fix (DL6), errors that end in the next step (DL7), catalog labels for tiers, platforms and settings (DL8), and OSC 11 skipped once the theme is decided (DL13).
- **Minimum check:** The terminal rows for each changed screen, plus a resize sequence; cross-kit text parity with the Python kit at 80×24.
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

Node terminal kit 0.8.x fixes, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-45) and §10.4.

## Scope

**In:** devices "last seen" from the roster in seconds; status holder is name or email (empty counts as absent) and signed-in comes from `identity.current()`; login ends "Signed in as <name>" and confirms before attaching when a key licence is held (`waitForSignIn({confirm})`, default No); every flow ensures discovery before deciding a capability is off; `update apply` names the reason and next step (the upgrade command for package-manager installs, a download link otherwise; update copy for not-configured); interim refusal copy covering expiry with the portal link; `core.gate.revoked` not titled "Signed out" for key-only devices; product-first strings; one spelling of licence; `secret` and `mint` never print values without `--reveal`; catalog labels for tiers, platforms and settings; OSC 11 skipped when the theme is already decided.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Align terminal detection in one capability table (env x streams x flags to color, unicode, interactive, animate, links) in the `cli` family of `ui-matrix.json`, run by both kits: CI truthiness over `CI`, `GITHUB_ACTIONS` and `BUILDKITE` (CI=0 or false is not CI); OSC 8 links only on a TTY; the animation rule; no OSC 11 query under NO_COLOR. (sdk-c-09, sdk-c-10, sdk-c-30)
- `activate` with no key reads piped stdin only when it is a file, FIFO or socket, stops at the first non-empty line and gives up after about 2 s with `cli.activate.noKey` (exit 2). [ ] A test with an open, silent stdin returns within the bound; `echo key | activate` still works. (sdk-c-09, sdk-c-10, sdk-c-30)
- Update apply: downloading (bar, '38 of 61 MB · 20 s left'), verifying (spinner, `update.verifying`), ready ('2.5.0 is ready · Restart to finish'), installed only after restart; never '100% · Up to date' while a restart is pending. Up to three What's new lines when the release carries notes. (sdk-c-09, sdk-c-10, sdk-c-30)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

### Corrections after verifying against the code (2026-10-09)

- **Capability table.** `ui-matrix.json` and its `cli` family do not exist yet: UK-51 (plan mode,
  corpus) creates them. The Node detection already met every row the brief names (CI truthiness over
  `CI`, `GITHUB_ACTIONS` and `BUILDKITE` with `CI=0` and `CI=false` not CI; OSC 8 links only on a TTY
  stdout; animation follows stdout, never stdin; no OSC 11 under `NO_COLOR`), so this package adds
  the table as a test (`test/cli/uk45.test.ts`, "the terminal capability table") for UK-51 to lift
  into the matrix, and changes no detection code.
- **OSC 11.** `createKitContext` already skips the question when `PKEY_THEME` or `COLORFGBG` decides;
  a test pins it, `NO_COLOR` included.
- **Time unit.** The consumer was reading `lastVerifiedAt` with a "too large to be seconds" guess.
  `DeviceInfo` now carries the roster's `lastSeen` (epoch seconds) and documents `lastVerifiedAt` as
  this device's own, in milliseconds; `client-core`'s comment already said milliseconds.
- **Refusal marks.** Gate and activation refusals keep ✗: the shared parity board
  (`docs/design/ui-kits/terminal-parity.json`) pins `✗  Signed out` for both kits, and UK-51 owns
  the move to ▲ and exit 4 for both at once.
- **Holder.** The email is shown first, then the name (the parity board's `Pro · mara@…`); an empty
  one counts as absent, and the signed-in account's is preferred to the license profile's.
- **`core.gate.revoked`.** The core copy is shared (LX-19, SP-39 own it), so the kit says "This
  license key no longer works" from its own catalog for a key-only device and leaves the core
  title for a signed-in one.
- **Not touched.** The Python kit's flows (UK-13, UK-48): it picks the new catalog strings up from
  the regenerated tables, and its own platform names, stdin bound and `--reveal` remain theirs.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 13 mockup item(s):** `kitboard:terminal:sign-in-device-code`, `kitboard:terminal:activate-masked-key`, `kitboard:terminal:device-limit`, `kitboard:terminal:status-update-finished`, `kitboard:terminal:blocked-status`, `kitboard:terminal:boot-healthy-offline`, `kitboard:terminal:grouped-help`, `kitboard:terminal:fallbacks`, `kitboard:terminal:cols-60`, `kitboard:terminal:short-40x12`, `kitboard:terminal:narrow-32x24`, `kitboard:terminal:ended-result-block`, `kitboard:terminal:offline-request-120`.

## Acceptance criteria

- [x] Goldens with a real client's status (ms `lastVerifiedAt`) and an empty-email profile.
- [x] A key-held login prompts, defaults to No and keeps the key license.
- [x] `login` works from the documented factory without a manual `discover()`.
- [x] `update apply` goldens for npm, pnpm, brew, npx, no driver and not-configured each end in an actionable line.
- [x] A lint finds no kit string naming Polaris Key where the product fits.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [x] The acceptance in "Design language v2 (2026-10-08)" above holds (terminal rows, a resize sequence and the parity board, on a real pty: `_lead/evidence/UK-45`).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-45 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-45 done`.

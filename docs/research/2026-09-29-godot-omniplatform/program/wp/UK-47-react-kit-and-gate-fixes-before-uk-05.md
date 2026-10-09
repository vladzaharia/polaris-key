# UK-47 React kit and gate fixes before UK-05

| Field       | Value                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08))            |
| Size        | 1.2–1.6 engineer-weeks                                                                                               |
| Depends on  | none                                                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-59](UK-59-built-kit-boards-refresh.md), [UK-62](UK-62-kit-playground.md) |
| Role        | `pkey-implementer`                                                                                                   |
| Plan mode   | no                                                                                                                   |
| Gates       | `ui-snapshots`, `modernity-lint`                                                                                     |
| Human input | none                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                            |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only; the web browses, so no QR).
- **In this kit:** These are the React fix round's rules applied before UK-05: the neutral device-limit callout with Replace a device as the primary, revoked with actions (DL6), errors in their slots and no false empty state (DL7), the scheme resolved against the host and an opaque Sign out (DL2, DL13), and hard-coded strings moved into the copy defaults (DL8).
- **Minimum check:** The React browser suite's sizes in both schemes and both presets, for every changed screen.
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

React kit and gate fixes before UK-05, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-47) and §10.4.

## Scope

**In:** no wire change, no new names (additive fields only once SP-35 names them). The bearer device-code hand-off from the `signInWithOidc` handle (code, open, copy, QR, expiry, cancel) with every rejection in the card; refusals stay on login with the typed key, the custom slot and "Replace a device"; refreshes never clear an activation refusal; revoked gets three actions and 401 backoff; typed update codes, never "up to date" after a failure, one shared check; a StrictMode-safe Provider; a development-only error for missing pins or an origin missing from `web.origins`; `React.JSX.Element` and a React 18 and 19 consumer typecheck; `lastVerifiedAt` in seconds; one discovery fetch per load; hard-coded strings into `theme.copy`; copy helpers re-exported from the root; `PolarisLogout` visible on a light host; React added to kit-lint with its debt recorded, and Playwright baselines of today's kit.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No wire change and no new names; additive fields only once SP-35 names them.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- React kit: under `branding='polaris-key'` with no product accent the primary is ink, never violet (B2/DL13: kits keep the host or product accent); the name 'Polaris Key' appears only in `signin.footer` and the device URL; the Welcome primary reads 'Sign in' (catalog `welcome.signIn`). (sdk-a-20)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 23 mockup item(s):** `kitboard:web:gate-1440`, `kitboard:web:gate-390`, `kitboard:web:activate-1440`, `kitboard:web:sign-in-1440`, `kitboard:web:sign-in-390`, `kitboard:web:device-limit-1440`, `kitboard:web:device-limit-390`, `kitboard:web:update-prompt`, `kitboard:web:settings-1440`, `kitboard:web:settings-390`, `kitboard:web:theming-four-themes`, `kitboard:web:states-sheet`, `kitboard:web:components-boot`, `kitboard:web:components-status-screen`, `kitboard:web:components-grace-toasts`, `kitboard:web:components-devices`, `kitboard:web:components-paywall`, `kitboard:web:components-cloudsync`, `kitboard:web:layers-b-styled-parts`, `kitboard:web:layers-c-headless`, `kitboard:web:motion`, `kitboard:web:forced-colors`, `kitboard:web:native-preset`.

## Acceptance criteria

- [ ] Jsdom tests over transcripts: bearer sign-in shows the code and URL and Cancel stops polling.
- [ ] A refused key keeps the screen, the key and the message across a refresh.
- [ ] Device-limit shows "Replace a device" with a `manageUrl`.
- [ ] Revoked has at least two actions and backs off.
- [ ] A 404 on `/update/version` never shows "up to date".
- [ ] `onConfigChange` fires under StrictMode.
- [ ] The corpus and transcripts are unchanged.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-47 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-47 done`.

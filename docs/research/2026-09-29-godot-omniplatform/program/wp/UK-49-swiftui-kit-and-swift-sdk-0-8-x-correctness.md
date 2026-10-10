# UK-49 SwiftUI kit and Swift SDK 0.8.x correctness pass

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 1–1.5 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-59](UK-59-built-kit-boards-refresh.md)                        |
| Role        | `pkey-sdk-porter`                                                                                         |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`, `ci:macos`                                                                                |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only).
- **In this kit:** The SwiftUI fix round's rules on today's kit: every blocking state gets an action that can change it (DL6), the accent goes through `PolarisAccent.resolve` (DL13), Return submits and refusals are announced (DL7, DL9), and a licensed launch never flashes the activation card (DL7). The device-limit callout turns neutral, replacing the round's danger-subtle ground.
- **Minimum check:** The `KitLayoutTests` rows (iPhone, SE, iPad and Mac, at L, AX3 and AX5) in both schemes and both presets, for every changed screen.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [x] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [x] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [x] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [x] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [x] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [x] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [x] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [x] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [x] pkey-ux-reviewer passes the built screens (BUILT mode).

## Goal

SwiftUI kit and Swift SDK 0.8.x correctness pass, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-49) and §10.4.

## Scope

**In:** terminal gate states get actions (use a different key, sign in, renew or manage, a host slot) with matching copy; `.polarisKey(client, theme:, options: GateOptions)` keeps the device-limit manage URL and return URL, key entry and offline activation (off on iOS); `ActivationResult` redacts its token; `StoreError` is a `LocalizedError`; the accent through `PolarisAccent.resolve`; Return submits and refusals are announced; the default name from `CFBundleDisplayName`; no activation card before the first reload; "Signed in as" with "Not you?" on ready; the `WebAuthenticationSignInBrowser` isolation fix; no `try?` in `client.update`; update-not-configured copy; `LicenseClient.deactivate()` emits the licence event; `JSONValue` descriptions; the five README snippets, `platforms:` and `from:`.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- SwiftUI patch: remove the 'or' divider and `PolarisCopy.orDividerLabel`; Mac quiet links use the resolved accent fg, not system blue; Activate offline is hidden on iPhone by default. UK-08: at 900x640, 1440x900 and 1920x1080 the Welcome form is one top-aligned block capped at about 440 pt beside the art pane (no hero-scale whitespace), filled fields under polaris-key and `.roundedBorder` only under native; inline one-form sign-in (no QR; /device; Open Browser primary). (sdk-a-19, sdk-b-16)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections and follow-ups (UK-49 hand-off)

Verified against the code (step 1):

- Return submits, the refusal announcement, Replace a device, the neutral device-limit callout and the
  `CFBundleDisplayName` default already existed. What was missing and is now fixed: the same refusal
  twice was not announced again, the return URL never reached the Replace a device link, and the bundle
  name ignored a localized value.
- "Revoked" showed the activation form directly; it now shows the blocking page with its actions, so
  Use a different key and Sign in are reachable the same way as from Expired.
- The README had more than five wrong snippets (install `platforms:`/`from:`, the device-code `.ready`
  pattern and its stale identity note, the gate snippet, the `UpdateDecision` patterns and an
  incomplete `switch`); all are fixed and typechecked.
- Tests: GateUITests (XCUITest over a scripted host, in `PlatformHostTests/run.sh`) drives the flows;
  the first-frame check is a macOS KitLayoutTests render (no controls before the first read).

Follow-ups, not done here:

- Move the new `PolarisKitCopy` and `UpdateCopy` strings into the shared copy catalog (plan-mode: the
  catalog is generated into every SDK).
- `installUpdateBootHooks` still turns a failed `update.decide()` into "no decision" (`try?`). A refused
  pin is named by `client.update.decide()` itself, but the boot machine has no event to carry it; add a
  boot event for a refused update configuration.
- VoiceOver focus after Cancel on the different-key form is left to the system; verify on a device.

## Screen acceptance evidence (2026-10-09)

Real iOS simulator (iPhone 17) and hosted renders, in `/private/tmp/claude-501/uk49-evidence/`
(not committed; regenerate with `PlatformHostTests/run.sh` and `KitLayoutTests` with
`TEST_RUNNER_PKEY_KIT_SNAPSHOTS`):

- `ui-tests/`: screenshots and accessibility trees (VoiceOver names) for expired, expired-different-key,
  expired-sign-in, revoked, revoked-refused, device-limit, signed-in and welcome.
- `layout-ios/swiftui.<screen>/`: gate, gate-expired, gate-revoked, gate-version-too-old,
  gate-different-key, gate-limit, signin, signin-ready, offline at iPhone SE/Max, iPad, landscape; L, AX3
  and AX5; native and polaris presets; dark and light.

Rows: Keyboard (Return submits, Cancel and Escape back out, UI tests), Screen readers (every button
named, in the trees), Sizing (AX3 and AX5 rows pass), Themes (dark and light, both presets, accent
contrast test), States (loading ground, refusal, expired, revoked, device limit), Motion (none added),
Hierarchy and copy (one filled primary per state), Native (Dynamic Type, VoiceOver names) hold for the
screens this package ships. Not applicable: landmarks/h1/zoom/forced-colors rows are web terms; gamepad,
TV and terminal rows do not apply to the iOS and Mac gate. pkey-ux-reviewer (BUILT): pass, no blocking
findings (expired good, revoked good, different key good, signed in good, device-limit callout ok).

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `kitboard:ios.html:gate`, `kitboard:ios.html:activate`.

## Acceptance criteria

- [x] UI tests drive a licence to expired and to revoked and reach the activation form through "Use a different key" and through Sign in without relaunching.
- [x] A device-limit refusal shows a working "Replace a device".
- [x] No `pkeyt_` in `String(describing:)`, `String(reflecting:)` or `dump`.
- [x] Contrast at least 4.5:1 on `#FF6A3D` in both schemes.
- [x] A licensed cold launch never renders the activation card (first-frame snapshot).
- [x] The README blocks compile in SP-45b's lane.
- [x] `pkey-ux-reviewer` passes every changed screen.
- [x] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-49 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-49 done`.

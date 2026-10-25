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

## Progress

- Slice 1 done: V-1 + list-detail. One shared two-pane layout (`PolarisTwoPane` in `PolarisScreen.kt`): art or icon alone on a `surfaceContainerLow` panel in the start pane, title, lede, detail and actions top-aligned in the end pane (TV keeps its split). `PolarisAccountScreen` / `PolarisAccount` is the tablet list-detail (list in the start pane, the chosen Settings or Devices screen in the end pane at 840 dp and wider; list, then item, with predictive Back on a phone). Left for later slices: the compose-android example, Compose tabs, M3 Expressive, nav graph and deep links, the self-starting gate.

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

## Corrections (2026-10-24)

The code is the fact; these replace what the sections above say where they differ. Sliced in `_lead/plans/UK-09b-UK-31-SP-52b-slices.md` (UK-09b.2 to .8).

- **C1. The ChannelPicker exists.** `PolarisChannelPicker` (`sdks/kotlin/ui/src/commonMain/kotlin/im/plrs/key/ui/PolarisChannelPicker.kt`) has default, locked and licence-locked states and an error line; its model is `PolarisChannelUi` (`ui-core/.../PolarisSettingsState.kt`), Settings draws it and `ChannelPickerTest.kt` tests it. What is left is a parity check against React, elements and Swift, and its place in the tablet list-detail's end pane. It has no ui-matrix family (`packages/brand/kit-copy/components.json` says `family: null`); its Compose snapshots come from `KitSamples.kt`. No corpus change.
- **C2. The self-starting gate exists under another name.** `PolarisKeyApp(client) { App() }` already calls `client.start()`. No `PolarisKeyGate` composable exists in Kotlin (the name lives only in ui-core's `gate("PolarisKeyGate")`). The one-liner named in UK-09 is added in UK-09b.3, with `PolarisKeyApp` kept as a deprecated wrapper.
- **C3. There are 23 component pages, not 25.** `build/ui/components/` holds 25 files, and two are `_template.mdx` and `index.mdx`. No page has a Compose tab yet (0 of 23). Tabs are Starlight `<Tabs syncKey="ui-kit">`, the label comes from `uiKits.ts`, and a `kotlin android` fence compiles in `:docs-snippets-android`.
- **C4. M3 Expressive is mostly out of reach on the pinned toolchain.** `:ui` follows Godot 4.7.2's template (AGP 8.6.1, compileSdk 36, Kotlin 2.1.21; Compose BOM 2026.06.01 brings Material 3 1.4.0). Available: `MaterialExpressiveTheme` and the `motionScheme` overload of `MaterialTheme`. Internal: `MotionScheme.expressive()`. Absent: `LoadingIndicator`, `ButtonGroup`, `MaterialShapes` and the wavy progress composables (they need BOM 2026.08.00 or later, compileSdk 37 and AGP 9.1). Until the kit has a version line decoupled from the Godot template pins, those are recorded as blocked and the kit draws its own.
  - **C4 was wrong on one point (UK-09b.4).** `MaterialExpressiveTheme` is `internal` in material3 1.4.0's Kotlin metadata, so the theme seam keeps plain `MaterialTheme` on the pinned line. The rest of C4 stands.
- **C5. No navigation or deep links exist.** The kit navigates by state (`rememberSaveable` plus `PolarisBackHandler`); there is no navigation-compose, `NavHost`, `material3-adaptive` or `WindowSizeClass`, and no deep-link copy key. The only `pkey://` is a URI the desktop opener must refuse. UK-09b.3 adds `PolarisKeyRoute` and `PolarisKeyLinks` (an allow-list parser), and wires navigation-compose in the sample only.
- **C6. The sample folder.** `examples/ui/compose-android/` is the Gradle module `:sample-compose-android` in `sdks/kotlin/settings.gradle.kts`, inside the Android include block, like UK-10.10's `:sample-compose-desktop`. `examples/ui/README.md` has two rows, "Compose (Android)" and "Compose Desktop".
- **C7. UK-09 silently dropped two items.** "Credential Manager first" (no code exists) and "Material Symbols Rounded" (`PolarisSymbols.kt` exists; whether it is the Rounded set is unverified). UK-09b.4 and the plan's D-7 decide both.
- **C8. Naming drift on an end-user surface.** `sdks/kotlin/ui/src/androidMain/res/values/strings.xml` `pkey_ui_polaris_key_mark` reads "Polaris Key", and this legacy `PolarisCopy` label reaches TalkBack. It must read "Polaris Locker". The catalog itself is clean. Fixed in UK-09b.4 (the sample, UK-09b.2, does not touch `:ui`).
- **C9. Slice 1 is merged.** `PolarisTwoPane` and `PolarisAccount` / `PolarisAccountScreen` (list-detail at 840 dp or wider, `ListDetailTest.kt`). "Tablet list-detail" only needs the ChannelPicker in its end pane and the BUILT review.
- **C10. UK-09's BUILT verdict is still owed.** UK-09 stays in review until a verdict is recorded. The BUILT review in UK-09b.7 records both.
- **C11. Local emulators exist.** `~/Library/Android/sdk/emulator` has android-24, -34 and -36.1 images and AVDs (pk-s06, titan2, s04lowend). Export `ANDROID_HOME`, use JDK 17 through mise, and run Gradle with `--no-daemon` through heavy.sh.

## Acceptance criteria

- [x] examples/ui/compose-android builds and runs (UK-09b.8 CI job; LaunchTest on the emulator, UK-09b.9a; renders in /Users/vlad/Repos/pk-wt/\_evidence/UK-09b.9a/ and \_evidence/UK-09b.7/)
- [x] Compose tab on each component page (23 pages, not 25: C3; UK-09b.6a 12 + UK-09b.6b 11)
- [ ] M3 Expressive applied: not met. MaterialExpressiveTheme is internal on the pinned material3 1.4.0 (C4), so the theme seam draws plain MaterialTheme; Expressive connected licence rows ship (UK-09b.4). Blocked on a kit version line decoupled from the Godot template pins.
- [x] Nav graph, deep links and self-starting gate work (UK-09b.3: PolarisKeyGate, PolarisKeyRoute, PolarisKeyLinks, the sample's navigation-compose 2.9.8 graph and intent filter; deep-link renders \_evidence/UK-09b.7/44-46)
- [x] Tablet list-detail layout; ChannelPicker (UK-09b slice 1 and .5; tablet renders \_evidence/UK-09b.7/24-26)
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode): not met. UK-09b.7 verdict was FIX (UK-09 also FIX); UK-09b.9a and .9b fixed it; no re-review is recorded, so no pass is entered in ux-reviews.json.
- [ ] The green gate passes (AGENTS.md): not run in this package (release freeze; CI-only lanes android and kotlin).

## Screen acceptance (close, 2026-10-24)

The built-screen evidence is the UK-09b.7 emulator run (/Users/vlad/Repos/pk-wt/\_evidence/UK-09b.7/, 47 renders) and the UK-09b.9a re-run (/Users/vlad/Repos/pk-wt/\_evidence/UK-09b.9a/). The checklist rows live in UK-09's brief; rows with no recorded evidence stay open there.

- Keyboard, screen readers, states, motion, hierarchy: no review pass recorded; open until the re-review.
- Sizing (font scale 200 %): partly shown, `34`-`38` in UK-09b.7 (font2 gate, sign-in, limit, account, devices). Open until the re-review.
- Themes: dark and light shown (UK-09b.7 27-29, 32-33); forced-colors, contrast measures: no evidence, open.
- N/A, route and URL: a native kit has no route or URL for the kit itself; deep links are covered by the `pkey` link parser tests and `44`-`46`.
- N/A, 400 % zoom: Android has font scale, not page zoom; the 200 % row stands in.
- N/A, TV: covered by UK-09's TV split.
- N/A, gamepad: no gamepad input on the phone and tablet screens this package ships.
- N/A, terminal: no terminal surface in this package.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-09b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-09b done`.

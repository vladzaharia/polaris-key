# S-06 Spike: outlet-detection signals the research could not verify

| Field       | Value                                                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                                                                                                                                                                                    |
| Size        | 0.5–1 engineer-weeks                                                                                                                                                                                                                                                                                                         |
| Depends on  | none                                                                                                                                                                                                                                                                                                                         |
| Unblocks    | none in the graph; informs [P3-01](P3-01-wire-v4-plan.md) (the `outlet-matrix.json` signal vocabulary), [P3-11](P3-11-outlet-detection.md), [P3-10](P3-10-godot-updater.md), [P1-05](P1-05-godot-devices.md), [P1-11](P1-11-godot-export-plugin.md), [P5-05](P5-05-apple-plugin-package.md) and [P5-06](P5-06-kotlin-aar.md) |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                           |
| Gates       | none beyond `pnpm format` on the files it adds                                                                                                                                                                                                                                                                               |
| Human input | none in the graph. Needed in practice: an iPhone with AltStore or SideStore; an Apple account for development-signed builds; a Mac; a Windows 10/11 machine; a Linux machine with Flatpak and snapd; a Steam account with any installed game; an Android phone with F-Droid and Obtainium                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                    |

## Goal

A research note, `notes/S-06-outlet-signals.md`, gives a verified or refuted verdict, with the raw
observation, for every outlet-detection signal in
[notes/E9 §1.1](../../notes/E9-runtime-building-blocks.md#11-signal-catalogue) that is not tagged
[V], and for the items in [notes/E9 §13](../../notes/E9-runtime-building-blocks.md#13-spikes-and-open-questions)
that concern detection (3, 4, 11, 12). It ends with a proposed signal-to-outlet table in the shape
P3-01 plans for `outlet-matrix.json`: signals named `<platform>.<signal>`, the outlet id each
implies, a confidence level, and precedence over the build stamp.

## Why

Outlet detection decides which updater may run and which capabilities apply: a store build must
never self-update, and runtime evidence overrides the build stamp
([README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet)). It is the least portable
feature: only iOS and Android have first-party APIs, and Android's install source is declared by
the installer, not proven ([PARITY §7](../../PARITY.md#7-runtime-limits-that-become-typed-nas)). So it
gets its own corpus, `outlet-matrix.json` ([PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data)),
and P3-01 says unverified signals stay marked "until S-06 reports". Diceroll's real bug, the
updater running inside Steam and itch installs ([README §9.2](../../README.md#92-diceroll-for-the-diceroll-side)
item 2), is the kind of mistake unverified signals would repeat.

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [notes/E9 §1](../../notes/E9-runtime-building-blocks.md#1-outlet-detection) and [§13](../../notes/E9-runtime-building-blocks.md#13-spikes-and-open-questions); [notes/E1 §A2](../../notes/E1-apple.md#a2-is-a-newer-version-on-the-app-store-and-testflight-updates) ("Detecting the install source in-app").
- [README §3.1](../../README.md#31-vocabulary) (the outlet ids: `direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`, `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`, `flathub`, `snap`, `winget`, `web`) and [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet).
- [PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data) and [§7](../../PARITY.md#7-runtime-limits-that-become-typed-nas).
- [P3-01](P3-01-wire-v4-plan.md) item 11 (row schema, naming, confidence levels).
- Code to reuse: `prototype/tests/suite_platform.gd` (prints `OS.*` identity values and feature
  tags from GDScript).

## Scope

**In** — the signals to verify, per platform (tag in notes/E9 in brackets):

| Platform    | Signals                                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS         | `AppDistributor.current` on development-signed, ad hoc and AltStore/SideStore installs (§13 item 4); `embedded.mobileprovision` present per install type [I]; the bundle-id rewrite by AltStore/SideStore [I]; the `web` case (§13 item 11), from documentation only unless a Web Distribution build exists                            |
| macOS       | `AppTransaction.shared.environment` for TestFlight, Mac App Store and Developer ID (§13 item 4; the community says TestFlight reports `sandbox`); `Contents/_MASReceipt/receipt`; the signing authority (Developer ID vs Apple Distribution/Development) [M]; the Homebrew Cask path when the app is copied to `/Applications` [M]/[I] |
| Windows     | what distinguishes a sparse-package identity from a packaged install (`GetCurrentPackageFullName`, `Package.Current.SignatureKind`, `InstalledLocation`, `GetAppInstallerInfo()`; §13 item 12); App Installer vs Store vs sideloaded MSIX; winget, Scoop and Chocolatey path conventions [I]                                           |
| Linux       | `/.flatpak-info` [M]; `SNAP`, `SNAP_NAME`, `SNAP_REVISION`, `SNAP_INSTANCE_NAME` [S]; a cheap re-check of `APPIMAGE`/`APPDIR` [V]                                                                                                                                                                                                      |
| Steam       | `SteamAppId` and `SteamGameId` set by the client on Windows, macOS, Linux and Proton; `steamapps/appmanifest_<id>.acf` fields (`buildid`, `installdir`, the beta key) and how to find the library from the executable path; `steam_appid.txt` dev mode (§13 item 3)                                                                    |
| itch        | what the itch app sets when it launches a game (environment, install path); notes/E9 has no itch row, yet README §4.7 relies on detecting it                                                                                                                                                                                           |
| Android     | `getInstallSourceInfo` fields and `getPackageSource()` as set by Play (a test track), the F-Droid client, Obtainium, a browser download and `adb install`                                                                                                                                                                              |
| Web         | installed-PWA signals marked [M] (low priority)                                                                                                                                                                                                                                                                                        |
| Godot reach | for each desktop signal: readable from pure GDScript (`OS.get_environment`, `OS.get_executable_path`, `FileAccess`, `OS.execute`) or only from native code                                                                                                                                                                             |

**Out** (and where it belongs instead):

- The `outlet-matrix.json` file itself and its row schema (→ P3-01 plan, P3-02 corpus).
- Detection code in any SDK (→ P3-11), the Godot outlet adapters (→ P3-10), the Apple and Android
  native calls as product code (→ P5-05, P5-06).
- MSIX `user://` behaviour (→ S-05 item d).

## Design notes

- **Probes, not products.** A GDScript probe built from `suite_platform.gd` plus environment and
  file checks, exported for each desktop platform; a one-screen Swift app for `AppDistributor` and
  `AppTransaction` (they need an app context); a PowerShell or C# snippet for `Package.Current`; on
  Android, `adb shell dumpsys package <pkg>` shows the installer fields without writing an app
  (cross-check once from app code if S-05 or P5-06 has a plugin).
- **Steam environment:** on Linux and Proton set the game's launch options to
  `env > ~/steam_env.txt; %command%`; on Windows and macOS add the probe as a non-Steam shortcut
  and note that shortcuts may differ from real apps.
- **Unverifiable rows stay unverified.** If an input is missing (for example no Web Distribution
  build), mark the row "not verified" with the reason. Do not substitute search results for
  observations.
- Record OS and client versions for every observation; several signals changed across OS releases
  (`Bundle.appStoreReceiptURL` is deprecated from iOS 18 and macOS 15).
- Keep device identifiers, Apple team ids and paths with user names out of the note.

## Steps

1. Build the probes under `prototype/outlet-signals/`.
2. Install each target through each outlet available; run the probe; save raw output.
3. Fill the verdict table: signal, platform, install type, observed value, verdict, evidence tag.
4. Draft the proposed signal-to-outlet table with confidence and precedence, and list the signals
   that need native code per runtime.
5. Write the note and the probes' README.

## Acceptance criteria

- [ ] `notes/S-06-outlet-signals.md` exists with the provenance blockquote, question, short answer,
      method, environment, results, recommendation, affected briefs and sources, with evidence tags.
- [ ] Every non-[V] signal in notes/E9 §1.1 and E9 §13 items 3, 4, 11 and 12 has a row: verified,
      refuted, or not verified with the reason.
- [ ] The itch row exists (verified or not).
- [ ] A proposed signal-to-outlet table uses `<platform>.<signal>` names and README §3.1 outlet ids,
      states a confidence level and precedence for each row, and marks which signals Godot reads in
      pure GDScript.
- [ ] `prototype/outlet-signals/` holds the probes with a README; no personal identifiers are committed.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
godot --headless --path docs/research/2026-09-29-godot-omniplatform/prototype --script res://tests/cli.gd -- platform
```

## Hand-off

P3-01 takes the signal vocabulary, confidence levels and precedence for `outlet-matrix.json`, and
drops the "unverified" markers S-06 resolves. P3-11 and P3-10 take the per-runtime split between
pure-language and native signals. P1-05 uses the verified outlet ids for its `outlet` report key,
and P1-11 the rule for when the build stamp wins. P5-05 and P5-06 take the Apple and Android API
observations. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-06 done`.

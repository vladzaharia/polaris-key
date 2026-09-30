# outlet-signals: S-06 probes

Probes for [S-06](../../program/wp/S-06-outlet-signals.md). Results and verdicts are in
[notes/S-06-outlet-signals.md](../../notes/S-06-outlet-signals.md). The probes only record raw
observations. None of them decides an outlet, and none is product code (detection belongs to
P3-11).

Everything they write goes to `out/`, which is git-ignored. `out/.gdignore` keeps the Godot
editor from importing the exports. The outputs contain local paths and may contain account
names: redact before quoting them anywhere.

## Layout

| Path                          | What it does                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `godot/outlet_probe.gd`       | The `outlet` suite of the prototype runner (`tests/suite_outlet.gd`). It prints `OUTLET_PROBE_JSON {…}` with every signal pure GDScript reaches. `outlet acf <steamapps>` parses a real Steam library read-only; `outlet bundle <App.app>` runs the macOS checks against another bundle |
| `godot/export.sh`             | Exports the prototype with official 4.7.2 templates into `out/<target>` (`macos`, `linux`, `windows`, `pack`); `LINUX_ARCH=arm64` for arm hosts                                                                                                                                         |
| `godot/emulate-layouts.sh`    | Runs the macOS export inside **emulated** layouts: a Steam library with an ACF, `steam_appid.txt`, an itch cave with a receipt, and an inherited Steam environment                                                                                                                      |
| `godot/linux-docker.sh`       | Runs the Linux export in Docker under **emulated** Flatpak, Snap, AppImage and Steam environments                                                                                                                                                                                       |
| `godot/linux-flatpak.sh`      | Runs the Linux export as a **real** Flatpak app (`flatpak run`, runtime from Flathub) in a privileged container                                                                                                                                                                         |
| `swift/OutletProbe.swift`     | `AppDistributor`, `AppTransaction` and code-signing info, each raced against a timeout; prints `OUTLET_SWIFT_JSON {…}`                                                                                                                                                                  |
| `swift/build.sh`              | Builds it without Xcode (`ios-sim` or `macos`, ad hoc signed). For other signings: `codesign -s "<identity kind>" --force <app>`                                                                                                                                                        |
| `android/assemble-apk.sh`     | Packs the probe into the official `android_debug.apk` template (package `com.godot.game`), with `assets/_cl_` starting the `outlet` suite                                                                                                                                               |
| `android/run-variants.sh`     | `adb` install variants (`adb`, `adb -i <installer>`, a shell session, `--update-ownership`), each followed by `dumpsys` and the probe                                                                                                                                                   |
| `android/system-installer.sh` | Installs through the system Package Installer (`VIEW` on a Downloads file), optionally with a browser `EXTRA_REFERRER`                                                                                                                                                                  |
| `android/chrome-download.sh`  | Chrome downloads the APK from a host server (`adb reverse`) and opens it from Chrome's Downloads page. The `uiautomator` taps are best-effort: Chrome's UI changes between versions                                                                                                     |
| `android/range-server.py`     | Static server with `Range` and `ETag`, for the Obtainium run                                                                                                                                                                                                                            |
| `web/display-mode.mjs`        | Playwright: display-mode media queries, `navigator.standalone` and `getInstalledRelatedApps` in a Chromium tab, a Chromium `--app` window and WebKit                                                                                                                                    |
| `node/probe.cjs`              | Node CLI channel signals (`npm_config_user_agent`, `npm_execpath`, module path, `node:sea` `isSea()`); run it plainly, via `npm run`/`pnpm run`, and via `npx`/`pnpm dlx` on `npm pack` output                                                                                          |
| `windows/probe.ps1`           | Package identity (`GetCurrentPackageFullName`, `Package.Current`), `GetAppInstallerInfo`, the external location and path conventions. **Not run in S-06**: there was no Windows machine                                                                                                 |

## Running

Prerequisites: Godot 4.7.2 with templates on `PATH`, Xcode for the Swift probe, `ANDROID_HOME`
and a JDK 17+ for Android, Docker for Linux, and Node 22 with `npm i playwright` for the web probe.

```sh
# Godot exports and the pure-GDScript probe
./godot/export.sh macos && ./godot/emulate-layouts.sh
out/macos/OutletProbe.app/Contents/MacOS/pkey-ed25519-lab --headless -- outlet bundle /Applications/<App>.app
out/macos/OutletProbe.app/Contents/MacOS/pkey-ed25519-lab --headless -- outlet acf "$HOME/Library/Application Support/Steam/steamapps"
LINUX_ARCH=arm64 ./godot/export.sh linux && ./godot/linux-docker.sh && ./godot/linux-flatpak.sh
# (editor) godot --headless --path .. --script res://tests/cli.gd -- outlet

# Steam-set environment of a real game (macOS): launch it through the client, then read its env
open steam://rungameid/<appid>; ps -wwE -p "$(pgrep -f '<Game>.app/Contents/MacOS' | head -1)" -o command= | tr ' ' '\n' | grep -E '^(SteamAppId|SteamGameId|SteamOverlayGameId|SteamClientLaunch|SteamEnv)='

# Swift probe
./swift/build.sh ios-sim && xcrun simctl install <udid> out/swift/ios-sim/OutletProbe.app
SIMCTL_CHILD_PK_TIMEOUT=30 xcrun simctl launch --console-pty <udid> org.example.pkey.outletprobe
./swift/build.sh macos && out/swift/macos/OutletProbe.app/Contents/MacOS/OutletProbe

# Android (emulator or device)
./android/assemble-apk.sh
SERIAL=emulator-5558 ./android/run-variants.sh
SERIAL=emulator-5558 ./android/system-installer.sh                       # packageSource LOCAL_FILE
SERIAL=emulator-5558 ./android/system-installer.sh https://example.org/x  # DOWNLOADED_FILE
SERIAL=emulator-5558 ./android/chrome-download.sh

# Web
(cd web && npm i playwright && node display-mode.mjs)
```

### Obtainium and F-Droid (by hand)

These installs were driven by hand through `uiautomator` taps, because both apps change their UI
often:

1. **Obtainium**: install the release APK (verify it against the release's `.sha256`), then
   `appops set dev.imranr.obtainium REQUEST_INSTALL_PACKAGES allow`. Serve `out/android/` from a
   server that supports `Range` and `ETag` (Obtainium's "Partial APK hash" versioning needs one;
   `python3 -m http.server` does not work: use `android/range-server.py out/android 8765`), then `adb reverse tcp:8765 tcp:8765`. Add app → URL
   `http://127.0.0.1:8765/outletprobe.apk` → Add → Install → the system prompt's Install.
2. **F-Droid**: install `https://f-droid.org/F-Droid.apk`, let it sync the main repo, and install
   any small app. Then read that app's install source with
   `dumpsys package <pkg> | grep -E 'installer|initiating|originating|packageSource|updateOwner'`.
   The probe itself is not in an F-Droid repo, so this row comes from `dumpsys` only.

Uninstall the installers and the probe afterwards.

## Privacy

- The probe rewrites `$HOME` to `~` and reduces `ITCHIO_API_KEY` to its length.
- It never reads `SteamUser`, `SteamAppUser` or the ACF `LastOwner`.
- `codesign` authorities are cut at the colon, so no developer name or team id is kept.
- Do not commit anything from `out/`.

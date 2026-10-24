# Compose Desktop sample

Tidewater Studio on the Compose kit's real desktop windows: the gate window with its menu bar, the update
window, and the Settings window. It is the Gradle module `:sample-compose-desktop` in `sdks/kotlin/`, which
exists where `:ui` does (an Android SDK, no `-Ppkey.jvmOnly=true`).

Run it from `sdks/kotlin/` with JDK 17:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew :sample-compose-desktop:run                       # the fixtures, the whole walk
./gradlew :sample-compose-desktop:run --args="--state update --scheme dark --preset native"
./gradlew :sample-compose-desktop:smoke                     # reach the gate on the fixtures, exit 0
./gradlew :sample-compose-desktop:shots -Pshots=/tmp/shots  # window-only PNGs of the walk, then exit
```

## Fixtures and `--live`

By default the app runs on Tidewater fixtures: a real `PolarisKeyClient` over a scripted Worker, so no server
runs and nothing leaves the process.

- Activation accepts any license key. A key containing `FULL` is refused with the device limit (3 of 3).
- "Sign In" shows the code `WDJB-MJHT`; the scripted Worker approves it 12 seconds later.
- The menu's "Check for updates" offers 2.5.0. "Install and Relaunch" runs a fake installer that downloads 48 MB in
  about 9 seconds, then reports that the app would quit.

`--live` uses `PolarisKeyDesktop.client(...)`: the OS keyring and the desktop updater. It reads
`PKEY_PRODUCT`, `PKEY_TRUST` (`k1=<key>,...`), `PKEY_BASE_URL` (default `https://key.plrs.im`), and
`PKEY_RELEASE_KEYS` to pin the update keys.

## Flags

| Flag                                                                       | Meaning                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `--state walk\|activate\|limit\|gate\|update\|progress\|settings\|devices` | Where it starts; `walk` is not activated, with every step by hand.                        |
| `--scheme light\|dark`                                                     | The host's scheme; the OS's when omitted.                                                 |
| `--preset polaris\|native`                                                 | The Polaris Key look, or the platform's own layers.                                       |
| `--platform macos\|windows\|gnome`                                         | Force a chrome; the real OS otherwise. The window frame stays this OS's.                  |
| `--size WxH`                                                               | The gate window's size in dp, 960x640 by default.                                         |
| `--plain`                                                                  | No full-size content view on macOS.                                                       |
| `--shots <dir>`                                                            | Walks the flow and writes a window-only PNG per window to `<dir>/<variant>/`, then exits. |
| `--smoke`                                                                  | Starts on an activated product, reaches the gate, exits 0 (1 after 60 seconds).           |

## Screenshots

`--shots` captures one window by its window id (`screencapture -l` on macOS), so nothing that overlaps it is in
the image, and it posts its keys to the app's own event queue, never to another app. macOS needs Screen
Recording for the JVM; without it the run exits 3 and writes nothing. The menu bar is native on macOS, so the
walk calls the two menu actions on the window state (`requestCheck`, `manageLicense`) instead of clicking.

## Packaging

`nativeDistributions` in `build.gradle.kts` lists `modules("jdk.accessibility")`, which puts the Java Access
Bridge in the packaged runtime so Windows screen readers see the window.

# Low-end performance harness (S-04)

This is research code for [Godot on Polaris Key](../../README.md). It backs
[S-04: crypto, hashing and zstd on low-end devices](../../notes/S-04-low-end-performance.md). It is
not part of the green gate and not a published SDK.

It measures, per device and runtime:

- the pure-GDScript verifier (`PKEd25519Fast`, `PKSha512`);
- the engine's SHA-256 (`HashingContext`) and zstd;
- the content bench (full, chunk, delta and file apply);
- a frame-time probe;
- in browsers, WebCrypto Ed25519, SHA-256, the WASM zstd decoder, OPFS and the 75 content cases.

It reuses the prototype's code rather than copying it into git:

- `sync.sh` copies `../addons/polaris_key`, the vectors and a derived content core into `project/`
  (all git-ignored);
- the browser side extends `../content/runners/browser/` (`server.mjs` mounts and result POSTs;
  `worker.mjs` gains the `ed25519` and `lowbench` ops).

## What is here

| Path                              | What                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project/`                        | the wrapper Godot project: `main.tscn` + `lowend.gd` run a fixed list with no command line and write `user://results.json`                                                                           |
| `project/lowend.gd`               | the list: correctness first (SHA-512 24, Ed25519 26 fast and sliced, jwsCases 36, corpus signatures 68, content 75), then interleaved timing rounds (one warm-up, then 5), then the frame-time probe |
| `project/sliced_verify.gd`        | `PKLowendSliced`: the same verify with the SHA-512 block loop and the double-scalar multiply yielding to the next frame when a slice budget is spent                                                 |
| `project/export_presets.cfg`      | macOS (universal), Android (arm64, release, no Gradle), iOS (Xcode project only) and Web (no threads, small vector set only); all release templates                                                  |
| `sync.sh`                         | copies the verifier and vectors in; derives `lib/content_core.gd` (`PKLowendContent`) from `content_runner.gd` minus its SceneTree entry points                                                      |
| `gen_bench_vectors.mjs`           | picks the three Ed25519 timing inputs (252 B, 87,474 B, 349,618 B signing inputs) from `corpus_sigs.json`                                                                                            |
| `collect.sh`                      | pulls one run into `results/<name>.json`: Android via logcat chunks (`S04CHUNK`), the iOS simulator or a device via its app container, macOS via `app_userdata`                                      |
| `report.mjs`                      | turns `results/*.json` into the note's Markdown tables                                                                                                                                               |
| `ios-sim-retarget.py`             | Godot 4.7.2's `ios.zip` ships an x86_64-only simulator slice; this retargets the arm64 device `libgodot.a` to the arm64 simulator (patches `LC_BUILD_VERSION`)                                       |
| `ios-sim-metal-stub.m`            | two Metal constants the retargeted engine needs and the simulator SDK lacks                                                                                                                          |
| `browser/index.html`              | the browser matrix as one page (phones load it directly): caps, WebCrypto Ed25519 on page and worker, the 75 cases per primitive combo, the throughput bench; POSTs to `/results/<tag>`              |
| `browser/drive.mjs`               | Playwright driver for Chromium, WebKit and Firefox, for the matrix page or (`GODOT=1`) the Godot web export; `CPU=<n>` throttles Chromium through CDP                                                |
| `browser/linux-matrix.sh`         | the same on Linux, in the official Playwright image (its WebKit is the Linux port, the WebKitGTK stand-in)                                                                                           |
| `browser/edprobe.mjs`             | isolates WebCrypto Ed25519 failures per step and bisects the message size                                                                                                                            |
| `browser/gtk.html`, `gtkprobe.py` | the distro WebKitGTK (the engine Tauri uses on Linux) running the Ed25519 size probe under Xvfb                                                                                                      |

Generated data (`build/`, `results/`, the synced `project/` copies, keystores) is git-ignored.

## Prerequisites

- Godot 4.7.2 standard editor on `PATH`, with the official export templates.
- Node 22 for `sync.sh`, and Node 24 (≥ 22.19) for `server.mjs`, which needs `zlib.zstdDecompressSync`.
- The prototype's generated inputs:
  - `node ../vectors/gen_corpus.mjs`;
  - the content vector sets (`../content/README.md` steps 1–2);
  - `../content/npm` with `playwright-core@1.63.0`, `hash-wasm`, `@noble/hashes` and `@bokuweb/zstd-wasm`;
  - the decoder WASM (`../content/wasm/build.sh`).
- Android: the SDK, a JDK (Android Studio's `jbr` works) and `adb`.
- iOS: Xcode.
- Linux browsers: Docker.

## Run it

All commands run from this directory.

```sh
./sync.sh both                 # small + large vector sets; the Web preset ships only small
godot --headless --path project --import
godot --headless --path project -- rounds=1 probe_reps=1 large=0   # editor sanity run
```

Godot reads `export/android/java_sdk_path` only from editor settings, so exports use a throwaway
`HOME` holding its own `editor_settings-4.7.tres` and a link to the real templates. The user's own
settings stay untouched:

```sh
GH=$PWD/build/godot-home; G="$GH/Library/Application Support/Godot"; mkdir -p "$G"
ln -sfn "$HOME/Library/Application Support/Godot/export_templates" "$G/export_templates"
# write $G/editor_settings-4.7.tres with export/android/{android_sdk_path,java_sdk_path,debug_keystore*}
keytool -genkeypair -keystore build/android/s04-throwaway.keystore -alias s04 -keyalg RSA -validity 3650 \
  -storepass s04-throwaway -keypass s04-throwaway -dname "CN=S-04 throwaway"
HOME=$GH GODOT_ANDROID_KEYSTORE_RELEASE_PATH=$PWD/build/android/s04-throwaway.keystore \
  GODOT_ANDROID_KEYSTORE_RELEASE_USER=s04 GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD=s04-throwaway \
  godot --headless --path project --export-release Android
HOME=$GH godot --headless --path project --export-release macOS
HOME=$GH godot --headless --path project --export-release Web
HOME=$GH godot --headless --path project --export-release iOS      # Xcode project only
```

### Desktop

```sh
build/macos/pkey-s04.app/Contents/MacOS/pkey-s04-lowend --headless -- rounds=5 probe_reps=3 large=1
./collect.sh macos macos-headless
```

### Android

This works on a device or an emulator. A release APK cannot be `run-as`'d, so the results come
back through logcat.

```sh
adb install -r build/android/pkey-s04.apk && adb logcat -G 8M && adb logcat -c
adb shell am start -n org.polariskey.s04lowend/com.godot.game.GodotAppLauncher
# wait for "[s04] done" in `adb logcat -s godot:I`
./collect.sh android <name> [serial]
```

### iOS simulator

```sh
python3 ios-sim-retarget.py build/ios
xcrun -sdk iphonesimulator clang -target arm64-apple-ios15.0-simulator -fobjc-arc -c ios-sim-metal-stub.m \
  -o build/ios-sim-metal-stub.o
(cd build/ios && xcodebuild -project pkey-s04.xcodeproj -scheme pkey-s04 -configuration Release \
  -sdk iphonesimulator -arch arm64 -derivedDataPath ../ios-dd CODE_SIGNING_ALLOWED=NO \
  OTHER_LDFLAGS="\$(inherited) $PWD/build/ios-sim-metal-stub.o" build)
xcrun simctl install <udid> build/ios-dd/Build/Products/Release-iphonesimulator/pkey-s04.app
xcrun simctl launch <udid> org.polariskey.s04lowend
./collect.sh ios-sim <name> <udid>
```

A physical iPhone needs the same Xcode project signed with a team (a human-held input). Build it
without the retarget step, then run `./collect.sh ios-device <name> <udid>`.

### Browsers

Run these from `..`, the prototype directory:

```sh
MOUNTS=/lowend=$PWD/lowend RESULTS_DIR=$PWD/lowend/results/posted \
  node content/runners/browser/server.mjs "$PWD/content" 8431 &
node lowend/browser/drive.mjs chromium http://127.0.0.1:8431           # webkit works too; LARGE=1 for 37 MB
GODOT=1 CPU=20 node lowend/browser/drive.mjs chromium http://127.0.0.1:8431   # 4/6 ≈ mid-range, 20 ≈ A53-class
LARGE=1 lowend/browser/linux-matrix.sh                                   # Linux WebKit, Firefox, Chromium
GODOT=1 lowend/browser/linux-matrix.sh webkit
GODOT=1 HEADFUL=1 lowend/browser/linux-matrix.sh firefox                 # headed under xvfb-run for WebGL2
```

A page needs a secure context. For phones:

- the iOS simulator shares the host's `localhost`: `xcrun simctl openurl <udid> "http://localhost:8431/lowend/browser/index.html?tag=ios-safari&large=1"`;
- an Android device or emulator needs `adb reverse tcp:8431 tcp:8431`, then an intent to Chrome with the same URL;
- a real iPhone needs an HTTPS origin it can reach (a human-held input).

Results arrive as `results/posted/<tag>-<time>.json`.

## Caveats

- **Timings on a shared host measure the host's contention too.** `collect.sh` records `uptime` in
  each result. Run timing passes when the load average is well below the core count.
- **Simulators and emulators run at host CPU speed.** They check correctness and give ratios, not
  phone timings.
- **Playwright's macOS WebKit is not WebKitGTK.** Use `linux-matrix.sh` or `gtkprobe.py` for Linux.
- **Headless Firefox in a GPU-less container has no WebGL2,** even with the software-GL prefs
  `drive.mjs` sets. Run the Godot export in Firefox with `HEADFUL=1` (under `xvfb-run`).
- **CPU throttling (`CPU=<n>`) slows only the page's main thread,** not workers, so it models the
  Godot web build and not the JavaScript matrix.

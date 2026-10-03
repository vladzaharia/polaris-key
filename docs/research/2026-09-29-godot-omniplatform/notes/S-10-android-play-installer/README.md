# S-10 probe code

Research code behind
[notes/S-10](../S-10-android-play-installer.md). It is not part of the green gate and not a
published SDK. P5-06 rewrites it as `sdks/kotlin/` (the platform AAR) and
`sdks/godot/native/android/` (the Godot plugin).

| Path                               | What it is                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/`                          | A Gradle project (AGP 8.6.1, Kotlin 2.1.21, Gradle 8.11.1, the versions of Godot 4.7.2's build template) with one Android library module and two flavours, `play` and `direct`. It compiles against `org.godotengine:godot:4.7.2.stable` (`compileOnly`) and is a Godot v2 plugin |
| `plugin/plugin/src/main/`          | `S10Plugin` (singleton `PKeyS10`, signals `iau_state`, `pad_state`, `pi_status`, `probe`), `InstallSource` (`getInstallSourceInfo` and signer digests) and `KeyVault` (AES-256-GCM in AndroidKeyStore)                                                                            |
| `plugin/plugin/src/play/`          | In-App Updates (the real manager and `FakeAppUpdateManager`, driven by a step script) and Play Asset Delivery                                                                                                                                                                     |
| `plugin/plugin/src/direct/`        | Verified `PackageInstaller` self-update (hash, package, signer, higher versionCode) and the manifest-declared status receiver                                                                                                                                                     |
| `plugin/plugin/src/testPlay/`      | A Robolectric test of the flexible flow through `FakeAppUpdateManager`: the JVM-side check P5-06's CI can run                                                                                                                                                                     |
| `game/`                            | The Godot 4.7.2 probe project. `probe.gd` runs a JSON plan against the plugin and writes the result after every step. `addons/pkey_s10/export_plugin.gd` picks the flavour per preset and adds the AAR, the Maven dependencies and (direct only) the install permissions          |
| `build.sh`                         | Exports the probe with the Gradle build: `direct` gives an APK, `play` an AAB with two extra asset packs (fast-follow `s10ff`, on-demand `s10od`) plus a `--local-testing` APK set                                                                                                |
| `run.sh`                           | Pushes a plan, launches the app, waits for the result and pulls it                                                                                                                                                                                                                |
| `seq_direct.sh`, `seq_play.sh`     | The sequences the note reports (`SUF=_36` for the Android 16 run)                                                                                                                                                                                                                 |
| `summarize.py`, `summarize_iau.py` | Print the results                                                                                                                                                                                                                                                                 |

## Running it

Needs macOS or Linux, the Android SDK (`ANDROID_HOME`, default `~/Library/Android/sdk`, with
`platforms;android-36`, `build-tools;36.1.0`, the emulator and an arm64 `google_apis` image), mise,
Godot 4.7.2 with its export templates, and bundletool 1.18.3.

```sh
mise install java@temurin-21
# 1. The AARs (generate the wrapper once: gradle wrapper --gradle-version 8.11.1)
(cd plugin && echo "sdk.dir=$ANDROID_HOME" > local.properties && mise exec java@temurin-21 -- ./gradlew :plugin:assembleRelease :plugin:testPlayDebugUnitTest)
# 2. A self-contained editor (so the export uses its own JDK setting): copy Godot.app to editor/,
#    `xattr -dr com.apple.quarantine editor/Godot.app`, `touch editor/._sc_`, run it once with
#    `--headless -e --quit --path <any project>`, link the 4.7.2 templates into
#    editor/editor_data/export_templates/, and set export/android/java_sdk_path and
#    android_sdk_path in editor/editor_data/editor_settings-4.7.tres.
# 3. The builds (throwaway keystores are generated under keys/)
BUNDLETOOL=/path/to/bundletool-all-1.18.3.jar ./build.sh play 1
for a in "direct 1" "direct 2" "direct 3" "direct 2 s10other" "direct 1 s10 true direct-v1-omit" "direct 2 s10 true direct-v2-omit"; do ./build.sh $a; done
# 4. One emulator; a private adb server, because other users of the machine restart the default one
ANDROID_AVD_HOME=$PWD/avd emulator -avd <arm64 google_apis AVD> -port 5610 -no-window -no-snapshot &
ANDROID_ADB_SERVER_PORT=5099 adb connect 127.0.0.1:5611
ANDROID_ADB_SERVER_PORT=5099 java -jar $BUNDLETOOL install-apks --apks out/play-v1-s10.apks --device-id 127.0.0.1:5611
./seq_play.sh && ./seq_direct.sh all
python3 summarize.py d1 d2 d3 d4 d5 d6; python3 summarize_iau.py results/result_iau.json results/plan_iau.json
```

Nothing here uses a Play Console account, uploads anything or signs with a real key.

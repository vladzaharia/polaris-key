# PolarisKeyAndroid — the Godot Android plugin (P5-06, P6-10)

A Godot Android plugin (v2) over `polaris-key-platform` (sdks/kotlin `:platform`) and nothing else
from the Kotlin SDK: verification, the licence client, the updater and the pack engine stay in the
Godot SDK's GDScript core, as on every other target (Godot on iOS likewise links only Swift's
`PolarisKeyPlatform`). The binding is a JSON layer: every Android edge (install source, Keystore,
In-App Updates, Play Asset Delivery, Play Integrity, PackageInstaller) is the platform module's
code, and `./gradlew :godot:checkPlatformOnly` (part of `check`, run by the `android` CI job) fails
if any other SDK module (a project or an `im.plrs.key` module) enters any of its classpaths. Godot instantiates
`im.plrs.key.godot.PolarisKeyAndroidPlugin` at start-up and registers it as the Engine singleton
`PolarisKeyAndroid`; the GDScript facade is `addons/polaris_key/native/pkey_android.gd`
(`PKeyAndroid`). Needs Godot 4.2+ with the Gradle build (`gradle_build/use_gradle_build`).

| Path               | What                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.gradle.kts` | the `:godot` project: depends on `im.plrs.key:polaris-key-platform-<flavour>` only (substituted by `:platform`), `checkPlatformOnly`, the local publication |
| `src/main/`        | the plugin class, `Commands` (the JSON surface), the event queue, the v2 manifest entry                                                                     |
| `src/play/`        | `PlayCommands`: In-App Updates, Play Asset Delivery and Play Integrity                                                                                      |
| `src/direct/`      | `DirectCommands`: the verified PackageInstaller self-update                                                                                                 |
| `src/test*/`       | Robolectric tests of the command surface per flavour                                                                                                        |
| `build.sh`         | publishes both flavours of platform and binding to `sdks/kotlin/build/repo` and installs those AARs into `addons/polaris_key/native/android/bin/`           |
| `export_check.sh`  | headless Gradle exports of `e2e/game` per flavour, their checks, and an optional device run                                                                 |
| `e2e/game/`        | the device probe project                                                                                                                                    |

## Surface

One method, `cmd(json: String) -> String` (no method may share a name with an `Object` method:
`call`, `get`, `set`, … are shadowed in GDScript and silently return null, notes/S-10 §5). Calls
arrive on Godot's render thread; Play Core and activity work is posted to Android's UI thread and
APK hashing to a worker. An asynchronous op answers `{ok: true, req}` at once; its result is a
queued `{ev: "result", req, …}`. Unsolicited events: `update_state`, `update_result`,
`pack_state`, `install_status`, `resumed`. PKeyAndroid drains the queue with `poll` once per frame
on Godot's main thread and emits its own signals, as PKeyApple does (P5-05), so no signal crosses
JNI.

| Ops                                                                                                                                                                   | Flavour |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `capabilities`, `install_source`, `ks_get`, `ks_set`, `ks_delete`, `ks_info`, `poll`                                                                                  | both    |
| `iau_check`, `iau_start`, `iau_complete`, `pad_state`, `pad_fetch`, `pad_location`, `pad_remove`, `pad_cancel`, `pad_confirm`, `integrity_prepare`, `integrity_token` | play    |
| `pi_can_install`, `pi_open_settings`, `pi_verify`, `pi_install`, `pi_last`, `pi_abandon_stale`, `pi_constraints`                                                      | direct  |

The other flavour's ops answer `{ok: false, unsupported: true, reason: "outlet"}`.

`integrity_prepare {cloudProjectNumber}` and `integrity_token {cloudProjectNumber, requestHash}`
(P6-02) run the standard Play Integrity API; the token result is `{token, prepared, reprepared}`
and a failure `{error: "integrity", errorCode, exception, message}`. `PolarisKey.devices.attest()`
posts the token to `POST /<product>/devices/attest`.

## Publication

Per flavour, `im.plrs.key:polaris-key-godot-play` and `im.plrs.key:polaris-key-godot-direct`
(AAR, POM, sources jar, Gradle module metadata), each depending on
`im.plrs.key:polaris-key-platform-<same flavour>` and on no other SDK module, written to the
local repository `sdks/kotlin/build/repo` only: no signing, no Maven Central, no remote
repository. `sdks/kotlin/tools/check_publication.sh` checks them, and that the export plugin's
Play Core list equals the libraries the platform play POM names. The Godot addon itself ships on
its own feed (F-09); a game gets the AARs through `build.sh`.

## Building into a game

```sh
sdks/godot/native/android/build.sh          # JDK 17+, the Android SDK
```

In the Android export preset set `polaris_key/android_flavor` (`play` by default, `direct`, or
`none`; `PKEY_ANDROID_FLAVOR` in CI) and turn on the Gradle build. The export plugin
(`addons/polaris_key/native/android_export_plugin.gd`) then adds the flavour's two AARs (the
platform module's and this thin binding), Play Core (app-update, asset-delivery, integrity) from
Maven for `play`, and for `direct` only the manifest entries `REQUEST_INSTALL_PACKAGES` and
`UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Without the Gradle build or the AARs the export carries no
plugin, warns, and PKeyAndroid answers `dependency`.

## Export and device check

```sh
JAVA_HOME=<jdk17> BUNDLETOOL=<bundletool-all-1.18.3.jar> sdks/godot/native/android/export_check.sh
# and with an emulator (no Play Store needed):
DEVICE=127.0.0.1:5621 ANDROID_ADB_SERVER_PORT=5099 SKIP_BUILD=1 … export_check.sh
```

Measured on 2026-10-03 (Godot 4.7.2, an arm64 `google_apis` API 34 emulator, JDK 17): each
headless Gradle export 9–16 s (direct APK 73.6 MB arm64, play AAB 29.2 MB); the direct preset has
both permissions, the meta-data and the receiver, no Play Core; the play AAB has no install
permission, no session code and no direct class. On the emulator: a Keystore round trip 9–14 ms
(software-backed, `securityLevel` 0); refusals for a public path and a wrong hash (115–270 ms for
74 MB); a real silent v1 → v2 self-update (`apk_install` 471 ms to commit, no prompt; and again
through the update driver, `PKeyDirectAdapter` → `PKeyApkUpdate`, download from a loopback server
plus verify plus commit in 1.2 s), after which
the next launch reads the journaled `success` and an install source of `selfUpdated` with
`packageSource` 0; In-App Updates `outlet` for a non-Play install; an on-demand pack under
`--local-testing` fetched (PENDING → DOWNLOADING → TRANSFERRING → COMPLETED), located under
`files/assetpacks/probeod/1/1/assets/` and mounted in 1.8 ms.

Re-run on 2026-10-04 after the binding was rebuilt on the platform module alone (P6-10; the same
emulator image, JDK 17, Godot 4.7.2): headless exports 7–15 s; the SDK classes in each export are
only `im.plrs.key.godot` and `im.plrs.key.platform` (69 in direct, 114 in play), and the play
export now carries the Play Integrity library; Keystore round trip 11–13 ms; refusals 116–285 ms;
the silent v1 → v2 self-update through the update driver 0.6 s; the on-demand pack fetched and
mounted in 2.3 ms. Every check green.

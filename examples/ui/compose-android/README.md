# Compose Android sample

Tidewater Studio on the Compose kit: `PolarisKeyGate` around a product screen, with the update prompt
and the Account screen (settings and devices), with navigation-compose and deep links. It is the Gradle module `:sample-compose-android` in
`sdks/kotlin/`, which exists where `:ui` does (an Android SDK, no `-Ppkey.jvmOnly=true`).

Build it from `sdks/kotlin/` with JDK 17:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew :sample-compose-android:assembleDebug        # the debug APK
./gradlew :sample-compose-android:installDebug         # on a running emulator or device
./gradlew :sample-compose-android:testDebugUnitTest    # the smoke test (Robolectric)
```

## Fixtures and live

By default the app runs on Tidewater fixtures: a real `PolarisKeyClient` over a scripted Worker, so no
server runs and nothing leaves the process.

- Activation accepts any license key. A key containing `FULL` is refused with the device limit (3 of 3).
- "Sign In" shows the code `WDJB-MJHT`; the scripted Worker approves it 12 seconds later.
- "Check for updates" (and the `update` start) offers 2.5.0. "Update now" runs a fake installer that
  downloads 48 MB in about 9 seconds.
- The Account screen shows the roster of three devices. The scripted Worker serves no config
  document, so its settings list shows the kit's error and Retry.

`pkey.live` builds the real client instead (`PolarisKeyAndroid`: the Android Keystore, the direct
installer). It reads `BuildConfig`, set from Gradle properties:

```sh
./gradlew :sample-compose-android:installDebug -Ppkey.product=<slug> -Ppkey.trust=k1=<key> \
  [-Ppkey.baseUrl=https://key.plrs.im] [-Ppkey.releaseKeys=k1=<key>]
adb shell am start -n im.plrs.key.samples.composeandroid/.MainActivity --ez pkey.live true
```

## Intent extras

Every extra is optional; an unknown value keeps the default.

| Extra        | Values                                                         | Meaning                                                            |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pkeyState`  | `walk` `activate` `limit` `gate` `update` `progress` `account` | Where it starts; `walk` is not activated, with every step by hand. |
| `pkeyScheme` | `light` `dark`                                                 | The host's scheme; the system's when omitted.                      |
| `pkeyPreset` | `polaris` `native`                                             | The Polaris look, or the host's own Material theme.                |
| `pkeyAccent` | `#rrggbb`                                                      | The product accent; the kit's own when omitted.                    |
| `pkey.live`  | boolean                                                        | The real client instead of the fixtures.                           |

```sh
adb shell am start -n im.plrs.key.samples.composeandroid/.MainActivity \
  --es pkeyState update --es pkeyScheme dark --es pkeyPreset native --es pkeyAccent '#26847a'
```

## Navigation and deep links

The kit owns no navigation. The sample holds a `NavHost` (navigation-compose 2.9.8, pinned exactly in the version
catalog and used only here); Account, Devices and Settings are the kit's screens as destinations. A deep link goes
through `PolarisKeyLinks("tidewater://polaris", client)`, which accepts only that return URI followed by one of
`account`, `devices`, `settings`, `update` or `sign-in` (as the path, or as the one query value `route`), ignores
every other query value and the fragment, and refuses everything else. An accepted link syncs the client and opens
the route, after the gate has let the product through. A link that opens nothing says so.

```sh
adb shell am start -a android.intent.action.VIEW -d tidewater://polaris/account
adb shell am start -a android.intent.action.VIEW -d 'tidewater://polaris?route=devices'
```

`update` offers the fixture update; `sign-in` opens nothing here, because the device is already signed in and the
kit's sign-in belongs to the gate. The kit never puts a token, code or key in a link.

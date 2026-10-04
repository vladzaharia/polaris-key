# Polaris Key UI for Jetpack Compose

`polaris-key-ui` (`im.plrs.key:polaris-key-ui`, the Kotlin SDK's `:ui` module) is a set of
Material 3 screens over the Kotlin SDK: a boot shell, the licence gate, activation, sign-in with a
QR code, settings, devices, an update banner and prompt, and pack progress. It is Android only and
needs Compose with Material 3. It depends on `polaris-key-sdk` and renders the state the SDK
resolves. It never calls the network itself, and it never depends on the platform module or the
Android glue.

## Neutral by default, branded by one switch

With the defaults, the kit inherits your app's look. Every colour, shape and text style comes from
your `MaterialTheme`, dynamic colour included. The logo slot is empty, and no Polaris Key colour,
font, mark or badge appears.

```kotlin
MyAppTheme {                       // your MaterialTheme
    PolarisTheme {                 // neutral: the kit looks like your app
        PolarisBoot(boot, gate = gate, onSignIn = { showSignIn = true }) {
            MyApp()
        }
    }
}
```

One parameter switches to the Polaris Key design system. You get the generated brand palette (dark
first, light supported), the core violet as primary, the service accents on the small section
indicators, Rubik and the bit-less Pinned K as the logo:

```kotlin
PolarisTheme(branding = PolarisBranding.PolarisKey) { ... }
```

The "Powered by Polaris Key" badge is a separate switch. It is off by default and does not depend
on branding:

```kotlin
PolarisTheme(showPoweredBy = true) { ... }                                        // neutral + badge
PolarisTheme(branding = PolarisBranding.PolarisKey, showPoweredBy = true) { ... } // branded + badge
```

`logo = { Image(...) }` puts your own logo at the top of the kit's screens in either mode.
`darkTheme` picks the branded palette's theme. It follows the system by default.

## The screens

Each screen is a stateless composable over a UI value, plus a state holder that exposes that value
as a `StateFlow` and turns the player's actions into SDK calls. You can use the drop-in pieces, or
compose your own flow from the same parts.

| Screen                     | Drop-in                                            | State holder (from `PolarisKeyClient`)                                | Stateless                                      |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| Boot shell                 | `PolarisBoot(boot, gate, packs) { … }`             | `PolarisBootState`, driven by `boot.launch(scope, client.bootHost())` | `PolarisBootScreen`                            |
| Gate and activation        | `PolarisGate(gate) { … }`                          | `PolarisGateState(client.gateActions(), scope)`                       | `PolarisGateScreen`, `PolarisActivationScreen` |
| Sign-in with QR (RFC 8628) | `PolarisSignIn(signIn)`                            | `PolarisSignInState(client.signInActions(), scope)`                   | `PolarisSignInScreen`                          |
| Settings                   | `PolarisSettings(settings)`                        | `PolarisSettingsState(client.settingsActions(labels), scope)`         | `PolarisSettingsScreen`                        |
| Devices                    | `PolarisDevices(devices)`                          | `PolarisDevicesState(client.devicesActions(), scope)`                 | `PolarisDevicesScreen`                         |
| Update banner and prompt   | `PolarisUpdateBanner`, `PolarisUpdatePromptDialog` | `PolarisUpdateState`, fed `client.update.decide()`                    | `PolarisUpdatePrompt`                          |
| Pack progress              | `PolarisPackProgress(packs)`                       | `PolarisPackProgressState(client.packProgressSource())`               | `PolarisPackProgressScreen`, `PolarisPackList` |

`PolarisBoot` drives the shared stage machine from `:core` (`ui.stages`): idle, shell, guard, sync,
gate, decide, fetch, mount and ready, plus the offline, blocked and error stops. It renders each
stage in place and cross-fades between screens rather than navigating. While a stage works, you see
a labelled progress view. While the licence waits, you see the gate or activation screen, and the
boot retries by itself once the gate reports a usable licence. A fetch shows the consent card and
pack progress, and a stop shows a message with Try again (and Play offline at a playable offline
stop). At `ready`, your content renders. `PolarisKeyClient.bootHost()` does each stage's work over
the umbrella client. Pass `fetch` and `mount` to do your own content work there, or send
`BootEvent`s yourself with `boot.send(...)`.

The gate renders your content when the licence is `ok` or `not-applicable`. When it is `grace`, it
renders your content under an offline-grace banner. It shows the activation screen for
`needs-activation`, and for `revoked` with the revocation notice on top. It shows a full-screen
message, with Reconnect or Try again, for `expired`, `version-too-old`, `version-too-new` and
`channel-not-entitled`. The server's allowed version window is appended when it sends one.

Every screen shares one scaffold, `PolarisScreen`. It applies the safe-drawing insets (bars,
cutouts, the keyboard) and centres one column of at most 480 dp. That column scrolls rather than
clipping when a large font scale or a landscape phone leaves too little height.

## Copy and translation

Every string the kit renders is a field of `PolarisCopy`, chrome included. Each field also has a
string resource named `pkey_ui_<field in snake case>`, with the same English text. There are two
ways to change the copy:

- in code: `PolarisTheme(copy = PolarisCopy.localized().copy(productName = "Diceroll"))`;
- per locale: ship `values-fr/strings.xml` in your app with the kit's names, for example
  `<string name="pkey_ui_retry">Réessayer</string>`. `PolarisCopy.localized()`, the default copy,
  reads them.

The mapping from state to copy is pure and unit-tested without rendering. It decides which title a
revoked licence shows, how an activation error reads, and how a version window is phrased
(`gateMessage`, `activationMessage`, `blockedMessage`, `bootStageLabel`).

## Accessibility

- Every screen has a heading, so TalkBack's heading navigation lands on the title.
- Every control is at least 48 x 48 dp and has a name.
- The QR code and the marks have descriptions, and decorative icons are hidden.
- The sign-in code is spelled out character by character.
- Errors, the grace banner and progress labels are live regions.
- Text scales with the system font size. Settings rows stack their value under their name at large
  scales, and every screen scrolls instead of clipping.
- The branded palette's text and indicator pairs meet WCAG contrast in both themes. A test checks
  them.

## Brand rules

The neutral theme reads everything from `MaterialTheme`. A test scans the module and fails on a
colour literal, font or corner shape outside the theme and the generated token file. The brand
values come from `@polaris-key/brand`: `pnpm gen:brand` writes `PolarisBrandTokens.generated.kt`
(colours, accents, radii, optical cuts, badge minimums, and the Pinned K and badge as vector data)
and copies the kit's Rubik TTFs into `res/font`. `pnpm gen:brand -- --check` fails the green gate
on any drift. Rubik is under the SIL Open Font License 1.1, and its `OFL.txt` and the kit notice
ship in the module's assets, so they travel inside every APK that carries the fonts. A neutral kit
never loads the fonts, so R8's resource shrinking can drop them from an app that never brands.

## Tests and snapshots

```sh
cd sdks/kotlin
./gradlew :ui:verifyRoborazziDebug   # every unit, branding, contrast and TalkBack suite, plus the snapshots
./gradlew :ui:recordRoborazziDebug   # re-record the snapshots after an intended change
```

The snapshot tool is Roborazzi, running over Robolectric's native graphics, so no emulator is
needed. Every screen is rendered in seven variants, and the committed references live in
`src/test/snapshots/<screen>/<variant>.png`:

- a phone, neutral and branded, light and dark;
- a phone at a 200 % font scale;
- a landscape tablet, neutral and branded.

The badge has its own references under `powered-by/`.

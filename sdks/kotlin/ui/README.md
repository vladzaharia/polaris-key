# Polaris Key UI for Jetpack Compose

`polaris-key-ui` (`im.plrs.key:polaris-key-ui`, the Kotlin SDK's `:ui` module) is a set of
Material 3 screens over the Kotlin SDK: a boot shell, the license gate, activation, sign-in with a
QR code, settings, devices, an update banner and prompt, and pack progress. It is Android only and
needs Compose with Material 3. It depends on `polaris-key-sdk` and renders the state the SDK
resolves. It never calls the network itself, and it never depends on the platform module or the
Android glue.

## Neutral by default, branded by one switch

With the defaults, the kit inherits your app's look. Every colour, shape and text style comes from
your `MaterialTheme`, dynamic colour included. Only warning and success, which Material 3 has no
role for, are the brand's fixed amber and green. No Polaris Key colour, font, mark or badge
appears.

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
indicators, Rubik at 400, 500 and 600, full-round buttons and radius-16 fields:

```kotlin
PolarisTheme(branding = PolarisBranding.PolarisKey) { ... }
```

The "Powered by Polaris Key" badge is a separate switch. It is off by default and does not depend
on branding:

```kotlin
PolarisTheme(showPoweredBy = true) { ... }                                        // neutral + badge
PolarisTheme(branding = PolarisBranding.PolarisKey, showPoweredBy = true) { ... } // branded + badge
```

Your product is the hero, in either mode. `logo = { Image(...) }` is your product's icon: at hero
size on the welcome, beside your product's name on focused steps and on the update prompt. Without
one the kit draws a monogram tile of your product's initial. The Pinned K appears only inside the
optional Powered-by badge.
`accent = Color(0xFF369186)` applies your product's colour in either mode. It replaces the primary
roles (the core violet when branded, your scheme's primary when neutral) after the accent resolver
has adjusted it for contrast in the current scheme. Without it, neutral keeps your scheme exactly,
dynamic colour included.
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
a labelled progress view. While the license waits, you see the gate or activation screen, and the
boot retries by itself once the gate reports a usable license. A fetch shows the consent card and
pack progress, and a stop shows a message with Try again (and Play offline at a playable offline
stop). At `ready`, your content renders. `PolarisKeyClient.bootHost()` does each stage's work over
the umbrella client. Pass `fetch` and `mount` to do your own content work there, or send
`BootEvent`s yourself with `boot.send(...)`.

By default `bootHost()` wires every stage (notes/SDK-PARITY-PASS.md §3.4): the guard is
`client.bootGuard()` (it counts unconfirmed launches and confirms the launch once the boot settles,
after `BOOT_OK_SECONDS` of `ready` where the stage machine asks for that), decide hands each
`UpdateCheck` to `onCheck` (pass `updateState::show`), and fetch is `client.packs.bootFetch` over
the content stamp when packs are configured, with the metered-download consent.

### One call: `PolarisKeyApp`

```kotlin
setContent { MyAppTheme { PolarisTheme { PolarisKeyApp(client) { App() } } } }
```

`PolarisKeyApp` composes the pieces above, unchanged: the boot shell over `client.bootHost()`, the
gate for its activation stop, pack progress, and the update banner over `client.updateActions()`
(`client.update.install(check)`; a Play flexible update's progress and "Restart to finish", which
runs `finish()`). It provides the client through `LocalPolarisKey`, so any screen reads it with
`polarisKey()` and the live helpers `rememberPolarisLicense()`, `rememberPolarisEntitled(name)` and
`rememberPolarisSetting(key)`.

### Headless behaviour the screens consume

- `PolarisGateState.continueFree()` runs keyless enrolment (`client.enroll()`); a refusal lands on
  the activation form like an activation's.
- `client.settingsActions(editable = true)` types each row from the served catalog
  (`PolarisSettingEntry.editor`: `Toggle`, `Choice`, `Number`, `Text`; none for an enforced row or a
  secret), and `PolarisSettingsState.set(key, value)` / `reset(key)` persist or clear a local
  override (`client.config.set` / `clear`), with a refusal in `PolarisSettingsUi.error`.
- `PolarisUpdateState.install(actions, scope)` hands the offer to the installer, `follow(actions,
scope)` tracks a background install (`progress`, then the `Restart` kind) and the offer's `error`
  carries a failure.

The settings screen still renders the read-only summary, and the activation screen has no "Continue
free", "Buy", "Activate offline" or "Manage devices" buttons yet: drawing those belongs to the UI-kit
program (`docs/design/UI-KITS.md`), which rebuilds the kit's look.

The gate renders your content when the license is `ok` or `not-applicable`. When it is `grace`, it
renders your content under an offline-grace banner. It shows the activation screen for
`needs-activation`, and for `revoked` with the revocation notice on top. It shows a full-screen
message, with Reconnect or Try again, for `expired`, `version-too-old`, `version-too-new` and
`channel-not-entitled`. The server's allowed version window is appended when it sends one.

When an activation is refused because every seat is taken and the Worker sent a portal link
(`ActivationResult.DeviceLimit.manageUrl`, PX-W8), the activation screen shows **Replace a device**
under the error. It is a button that opens the link, or a QR code with a "scan with your phone"
line on Android TV. The link carries the key fragment on an `/activate` link and the `returnUrl`
you pass to `PolarisGateState`.

Every screen shares one scaffold, `PolarisScreen`. It applies the safe-drawing insets (bars,
cutouts, the keyboard) and picks the layout from the space it is given:

- **A tall window** (a phone, a foldable, a portrait tablet): one column of at most 480 dp (520 on a
  tablet, 600 on a large window). A focused step, such as the sign-in code, starts under a 48 dp
  inset and docks its controls at the foot, where they ride above the keyboard. The welcome centres
  your product's icon, title and lede above them. It scrolls rather than clipping when a large font
  scale leaves too little height.
- **Two panes** for a screen with a control group (sign-in, activation): in a short window (under
  480 dp tall, such as a phone in landscape), on Android TV, and in a landscape window 840 dp wide
  or more. The content sits on the start side and the controls on the end side, each pane
  scrolling on its own, so the primary action never falls below the fold. Pass your own screen's
  controls as `PolarisScreen`'s `actions` to get the same behaviour.
- **Message screens** (an expired license, a boot stop) never split: a centred column on a phone,
  and elsewhere one start-aligned block with its actions in a trailing row, on a card on TV and in
  wide windows.

On a large window (1600 x 900 dp or more) the title steps up again and the screen's type scale is
1.125x. On TV the screens keep a 48 dp overscan margin, the D-pad starts on the first real
control, and focused controls show the kit's focus ring and grow slightly; with a keyboard on a
phone the ring shows too.

Spacing follows one rhythm on the 4 dp grid: 8 dp between a title and its lede, 12 dp between
stacked controls, 24 dp between two groups of controls, and a section gap between the header, the
content and the controls (24 dp on a phone, 32 on a tablet, 40 on a large window and 16 in a short
one).

Sign-in shows the product header (your icon and product name), "Sign in with a code", the address
set inline in the lede (your `deviceCodeUrl` when you pass one to `PolarisTheme`), the user code at
hero size in a monospace face with no letter spacing and a copy button for the pre-filled link,
and a countdown ring. On Android TV it leads with a QR code instead and offers no "Open sign-in
page", since a TV may have no browser; pass `showQr` to `PolarisSignInScreen` to override that.
When no browser can open a link, the screen says so and stays put. The license key field is the
Material 3 filled field.

Hold `PolarisSignInState` in a ViewModel (with `viewModelScope`), so a rotation or a trip through
navigation keeps the same code: when `PolarisSignIn` comes back it resumes polling that code
rather than asking for a new one. `PolarisKeyApp(client, signIn = true)` (or `PolarisGate(state,
signIn = ...)`) runs sign-in inside the gate instead, and its "Use a license key instead" comes
back to the key field.

## Copy and translation

Every string the kit renders is a field of `PolarisCopy`, chrome included. Each field also has a
string resource named `pkey_ui_<field in snake case>`, with the same English text. There are two
ways to change the copy:

- in code: `PolarisTheme(copy = PolarisCopy.localized().copy(productName = "Diceroll"))`;
- per locale: ship `values-fr/strings.xml` in your app with the kit's names, for example
  `<string name="pkey_ui_retry">Réessayer</string>`. `PolarisCopy.localized()`, the default copy,
  reads them.

The mapping from state to copy is pure and unit-tested without rendering. It decides which title a
revoked license shows, how an activation error reads, and how a version window is phrased
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
values come from `@polaris-key/brand`: `pnpm gen brand` writes `PolarisBrandTokens.generated.kt`
(colours, accents, radii, optical cuts, badge minimums, and the Pinned K and badge as vector data)
and copies the kit's Rubik TTFs into `res/font`. `pnpm gen brand --check` fails the green gate
on any drift. Rubik is under the SIL Open Font License 1.1, and its `OFL.txt` and the kit notice
ship in the module's assets, so they travel inside every APK that carries the fonts. A neutral kit
reads Rubik only for the monogram tile it draws when you pass no product icon.

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

The responsive suite renders sign-in, the gate's screens, devices, settings and the update prompt
at six more sizes, each neutral (`native-*`) and branded (`polaris-*`): 360 x 640, a phone in
landscape at 891 x 411, a small phone in landscape at 640 x 360, a foldable at 673 x 841, a desktop
window at 1920 x 1080, and a phone at a 150 % font scale. Every message screen also renders at
891 x 411 and 640 x 360; sign-in and activation at 960 x 540, 1280 x 720 and 2560 x 1440; sign-in,
its stops, activation, device limit, revoked and expired on Android TV at 960 x 540. `focus/` holds
the focus ring on TV and with a keyboard, and `accent/` a product accent over a custom host.

`ResponsiveLayoutTest` checks, at all of those sizes and at 800 x 600, 1280 x 800, 1366 x 768, a
411 x 440 split, 891 x 411 at 150 % and 200 % and 640 x 360 at 150 %, that on sign-in, activation,
the device-limit screens, every message screen and the update dialog every control is fully on
screen and at least 48 dp tall, and that the sign-in code is never cut. `FlowTest` covers sign-in
resuming after the screen leaves composition, no browser, "Use another license" and inline sign-in.

The badge has its own references under `powered-by/`.

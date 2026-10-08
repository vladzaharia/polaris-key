# Changelog

All notable changes to the Polaris Key Godot addon (`addons/polaris_key`). Versions follow
[SemVer](https://semver.org/); before 1.0 a minor version may change the API. One version is one
value in four places: `plugin.cfg`'s `version`, `PolarisKey.SDK_VERSION` (also sent as
`X-PKey-SDK-Version`), the release tag `godot-vX.Y.Z` and the zip's name. The release workflow
(`.github/workflows/release-godot.yml`) uses the section below whose heading is the tag's version
as the GitHub Release notes, and the same text is the Asset Store version's changelog.

## Unreleased

- **Responsive drop-in screens.** Every UI kit scene lays itself out for the area it is given:
  side by side in landscape (the device code beside its QR code, the product beside the activation
  form, the offline request beside its import), one column in portrait, following a resize live.
  The Polaris Key look scales with the screen (0.75 on 640×360 to 2 on 2560×1440), every look
  keeps the page margin, caps its width and centres, keeps a phone's safe area clear and never
  draws a QR code under 160 physical pixels. A card scrolls only as a last resort for a game's
  oversized theme. New `options.ui_density` (spacious, comfortable, compact; it steps down on a
  small screen), `ui_product_name` and `ui_product_icon`.
- **A spacing system and type scale** in every stock theme (`PKeyLayout` constants and the
  container variations `PKeyStack`, `PKeyTight`, `PKeySections`, `PKeyRow`, `PKeyActions`,
  `PKeyColumns`, `PKeyGrid`; `PKeySection`, `PKeyMono`, `PKeyStrong` and `PKeyQrTile` join the type
  variations). Gate, boot and sign-in screens lead with the product's icon and name; **behaviour
  change:** the Pinned K no longer heads the branded gate and boot screens (UI-KITS.md §1.2). The
  branded theme draws its own switch, check box and chevron icons; banners float as cards; QR
  codes sit on a rounded white tile. `ui_theme` is now layered over the kit's neutral structure
  (your items win), so a partial theme keeps the kit's spacing.
- **Fixed:** offline activation opened from the activation panel showed no request code until
  re-rendered; it now renders with the SDK it is given. A layout switch could leave a container
  unsorted after a resize (the engine drops a re-sort asked for mid-sort); views now verify their
  sort for a few frames after each layout pass.
- **Tests:** the `ui_matrix` suite (its own `run_tests.sh` step) and `tools/ui_matrix/ui_matrix.gd` (PNGs).

The SDK parity pass (`notes/SDK-PARITY-PASS.md` §5.6).

- **Desktop keyring store** (SP-27). On macOS, Windows and Linux the token is kept in the OS
  keyring by default (`PKeyKeyringStore`): the login keychain, through the new macOS build of
  `PolarisKeyApple`; Credential Manager, through `pkey_win.dll`; the Secret Service, through
  `secret-tool`. The names are `pkey:<product>` and `device-token`, as in the Python and Kotlin
  SDKs. Writes are verified, and a file-store token is migrated into the keyring. A write that
  falls back to the 0600 file is surfaced as `store_error` and `keyring-error`. **Behaviour
  change:** without the native piece, desktop `store_status()` is now
  `{backend: file, degraded: {reason: keyring-unavailable}}`, where it used to be plain
  `{backend: file}`. `PKEY_DESKTOP_KEYRING=0` keeps the file store.
- **Behaviour change: `license.is_entitled(name)` answers `false` whenever the gate is not
  usable** (S-19 G11). A revoked, expired or blocked licence no longer unlocks a grant its last
  verified document still lists. `get_entitlements()` still reads the raw values.
- **Typed activation refusals.** A 403 other than `fingerprint_required` and the device limit is
  `refused` with the server's code, and the copy covers `registration_closed`,
  `attestation_required`, `managed_by_admin`, `not_entitled`, pack, commerce and mint refusals.
- **Attest and retry.** Edge-mint, gated downloads and pack objects, and the commerce claim
  attest once on a 403 `attestation_required` and retry once (`PKeyOptions.auto_attest`).
- **`update.feed_url(kind, opts)`** (`update.feeds`): the appcast, WinSparkle, Velopack
  (releases file or feed directory), App Installer and zsync feed URLs from discovery's
  templates, with the channel-alias rewrite and a typed `unsupported (product)` when the product
  publishes no template.
- **Settings persist by default** in `user://pkey_settings.cfg` (`PKeyOptions.settings_path`).
- **`config.set_value()`, `clear()`, `clear_all()` and `setting(key)`** (`config.local`): device-local
  writes through the persisted store, checked against the catalog type and refused
  `managed_by_admin` for an enforced or hidden key, one `config_changed` per write.
- **`identity.current()`, `identity.sign_out()`**, a persisted `set_channel()` that update
  checks, decide and the dev menu read, `crash_tags()` and `PolarisKey.distribution`. No
  portal URLs are built client-side (owner decision Q6): the activation panel's **Manage
  devices** waits for the server-supplied `manageUrl` (PX-W8) and stays hidden until then.
- **Commerce one-calls:** `purchase(flag)`, `restore()`, `claim_play()` and `claim_steam()`,
  returning a typed `PKeyPurchaseResult`. On an App Store outlet a purchase that answered
  `pending` (Ask to Buy, a slow payment) is claimed when StoreKit delivers it through
  `transaction_updated`, then synced (`app_store_update_claimed`).
- **Setup dock tools:** Generate config (`pkey sdk --lang godot --write`, release keys included),
  Generate catalog mirror (`pkey mirror --lang gdscript`), and `pkey_packs/*` added to every
  export preset. The dock shows the web CORS step (`web.origins`).
- **Web: clearing site data can consume a seat**, now documented. Reusing the old token on
  re-entry of the key (SP-G16) is deferred: `license/token` needs the old bearer and device id,
  which the clear removes, so it waits for a server-side rebind by key.
- **Minimal sample project** in `examples/minimal` (boot, gate, config, settings, commerce),
  compiled against the SDK by the test runner.
- **Fixed:** the direct-APK download awaited its fetch through a conditional expression, which
  Godot refuses at run time.

## 0.1.0

The first published version. Requires Godot 4.4 or later (4.6 or later recommended). Tested on
4.4.1, 4.5.2, 4.6.3 and 4.7.2.

- **Core, in pure GDScript.** Ed25519, SHA-512 and the 13-step compact-JWS verify (the engine has
  neither primitive), strict JSON pre-validation, the pinned trust manifest, the clock floor, the
  verified offline cache, bundle import and `sync()`, behind the `PolarisKey` autoload. Passes
  the same conformance corpus as the Node, React, Python and Swift SDKs, in the editor and on an
  exported release template.
- **Services.** `PolarisKey.license` (activation, enrolment, deactivation, entitlements),
  `config` (managed config with the shared precedence, the `PKEY_CONFIG_*` environment layer,
  secrets, edge-mint, `config_changed`), `devices` (fingerprint, keyless registration, the
  roster), `identity` (device-code sign-in with a QR code), `update` (the signed channel feed and
  release record, the update decision, acting on it per outlet, the sidecar-PCK swap and the boot
  guard) and `release` (changelog, install and download URLs). `PolarisKey.supports(feature)`
  answers what works on this platform, with a reason.
- **Boot and UI kit.** `await PolarisKey.boot()` runs the shared boot stage machine with the
  drop-in `PKeyBoot` scene; the gate, activation, sign-in, offline, settings, status-banner,
  update-prompt, entitlement-badge and dev-menu scenes are themeable, translatable and
  gamepad-navigable, and centre themselves from a phone in portrait to 4K. Their default look is
  neutral (your game's theme and font, no Polaris Key branding); `ui_branding = "polaris-key"`
  opts into the Polaris Key design system (dark or light, Rubik under the OFL, the Pinned K), and
  `ui_powered_by` adds the "Powered by Polaris Key" badge (off by default).
- **Packs.** `PolarisKey.update.packs` installs `godot.pck` and `files.tree` releases (deltas
  through the engine's own decoder on 4.6+, chunk sync, revocations, content-key delegation),
  checks every pack's directory before it is committed or mounted, and mounts packs at a boot.
- **Editor.** The setup dock writes `res://polaris_key.tres` and checks the pinned keys against
  the live trust manifest; the export plugin stamps every export (`res://.polaris_key/build.json`
  and the `pkey_*` feature tags) with CI overrides through `PKEY_BUILD_*`.
- **Native plugins, optional.** `PKeyApple` (iOS) and `PKeyAndroid` facades answer a typed
  "unsupported" without their native halves, so the addon runs everywhere without them; the
  native builds are not part of this zip.
- **Brand.** The setup dock's tab carries the Polaris Key glyph (Godot 4.6+), and
  `addons/polaris_key/brand/` holds the "Powered by Polaris Key" credit screens and badges for a
  game's credits.

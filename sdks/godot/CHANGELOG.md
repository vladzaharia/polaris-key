# Changelog

All notable changes to the Polaris Key Godot addon (`addons/polaris_key`). Before 1.0 a minor
version may change the API. The addon is published only to Polaris Key's Godot feed (`pkg.plrs.im`),
never the public Asset Library or Asset Store, at the server's version, in lockstep with every other
SDK: `.github/workflows/publish-sdks.yml` stamps `plugin.cfg`'s `version` and `PolarisKey.SDK_VERSION`
(also sent as `X-PKey-SDK-Version`) from git. The committed values are placeholders. See
`CONTRIBUTING.md`, "Releasing".

## Unreleased

- **Cloud Sync settings (U-21).** `PolarisKey.cloud_sync` (`PKeyCloudSync`: `status()`, `flush()`) and the `cloudSync` event; `config.set_value` and `clear` route through Cloud Sync's machine while a person is signed in, and `config.setting(key).sync()` answers `local`, `pending` or `synced`. `PKeyOptions.cloud_sync_encryption` (`e2e` by default, or `server`) and `cloud_sync_aliases` are app code's choices. The journal is sealed (a native sealer, else the engine-encrypted file keyed from the device id, else not written) and saved before a quit, a pause or a close request. The sign-out runs flush, machine sign-out, key ring forget and purge, and stops when the ring cannot forget its root. A served name holding a `\u0000` escape is refused; a value keeps the U+FFFD replacement. `sync.settings`, `config.sync` and `sync.scenarios` are implemented; `sync.e2e` follows.
- **Cloud Sync screens (U-42.5).** `PKeyUnlockSync` (the recovery code with Paste and Enter, or Start over behind a warning that arms after a beat, Cancel first in focus), `PKeyRecoveryCode` (8 groups of 4 drawn whole, Copy code, Done only after "I've saved my recovery code", never dismissable before), `PKeyRingChange` (the device that changed the key, Use recovery code, That was me only with a served ring) and the `locked` and `ring-changed` states of `PKeyCloudSyncStatus`, from ui-core's `cloudSync` rows (`ui/model/cloud_sync.gd`; `suite_ui_core` runs the family). `PKeyCloudSyncController` runs `recover`, `reset`, `accept_ring_change` and `set_recovery_code` on `PolarisKey.keyring` unless the game sets `host_handles`; following the sync client's state is the host binding and not built yet. `PKeyUiView.two_pane_fits()` is the shared two-column rule.
- **Native sealers for the device key store (CC-26.7).** Where a native lane is present, `PKeyDeviceKeyStore` keeps making keys and signing in GDScript and seals the record under a platform key in place of the engine-encrypted file: the Apple Keychain (an AES-256-GCM key, `AfterFirstUnlockThisDeviceOnly`, not synchronizable, bound to the product; the login keychain on macOS) through PolarisKeyPlatform's `dk_seal`/`dk_open`/`dk_destroy`, the Android Keystore through `:platform`'s `KeystoreSealer` (`ks_seal`/`ks_open`/`ks_destroy`, alias `pkey:<product>:devicekeys`), and Windows DPAPI (user scope, no UI, the product as entropy; `PKeyWinDpapiNative` in `pkey_win.dll`). `protection()` is then `keychain-sealed`, `keystore-sealed` or `dpapi-sealed`, `hardware_backed()` is true for the first two and `best_effort()` is false; `persistence()` stays `durable`. A sealed record that cannot open is `device-keys-unreadable` and is never replaced (only `wipe()` resets it, and destroys the platform key); a Keychain, Keystore or DPAPI fault that may pass is `device-keys-store-fault`; a sealed record whose lane is missing is `unsupported`. Linux has no sealer and keeps the CC-26.6 file. The Apple key is a Keychain-held AES key, not Secure Enclave-bound. `hardware_backed()` is true only for the iOS data-protection keychain and an Android key that reports secure hardware. A record written before a native lane loaded (CC-26.6 records were never released) becomes unreadable once the lane appears, and only `wipe()` resets it. A product that is not a lower-case slug is refused with `invalid-options`. A store given no sealer picks the platform's when its lane is present, unless `PKEY_DESKTOP_KEYRING=0`.
- **Device key store and the `pkey-proof/1` signer (CC-26.6).** `PKeyDeviceKeyStore` holds the device's Ed25519 signing key and X25519 agreement key in pure GDScript (`PKeyCurve25519`: the ref10 Montgomery ladder and a mask-select fixed-base signature, about 5 ms and 10 ms in a release template on a desktop CPU), in `user://pkey/<product>/` through the engine's encrypted `FileAccess` (a passphrase from `OS.get_unique_id()` and a per-install salt: it keeps the keys out of a copied folder, not out of code running as you). Every member answers a `PKeyResult`; `device-keys-unreadable` is never replaced (only `wipe()` resets it), `unsupported` is never reported for a bad record, `device-keys-store-fault` never reads as "no keys", and `ensure`/`rotate`/`wipe` hold a process mutex and a lock directory. `dh()` refuses low-order peers and an all-zero result; a memory-only store (`PKeyDeviceKeyStore.memory_only()`, or a web `user://` that does not persist) refuses to register unless `allow_ephemeral`. On mobile and consoles it is best effort (`best_effort()`); the native lane (CC-26.7) replaces it. `PKeyDeviceKeys.sign_device_proof` signs every purpose and re-verifies with `PKeyDeviceProof.verify`; `PolarisKey.devices.register_keys(store)` sends `PUT /devices/keys`. `core.devicekeys` is implemented.
- **UI matrix v7 (UKV7).** The kit's models follow `UI_MATRIX_VERSION` 7: `NearbyApproval` (entry, ask, approved, not-nearby; hidden with Identity off), the SignIn auto steps (confirm, link-offer, link-done, link-conflict, nearby-prompt, nearby-wait, nearby-done) and key-refused, `Activate/key-entry-limit` and `Activate/license-owned` in place of the `rejected` rows, and the `start-sign-in` action; the signed-in line reads `signin.return.signedInTier`. New scenes `PKeyNearbyApproval` and `PKeySignInStep` draw them from the models (the host owns the protocol and what a tap does). `PKeyActivationPanel` draws the two key refusals as a focused step (Sign in, Add it in Polaris Locker or a QR on a pad-only device, Use a different key).
- **Licence choice (I-10b.6).** `sign_in.start({channel = "redirect", license_choice = "app"})` asks the app to show the licence choice (when discovery names the choice endpoints); `complete()` then settles `license_choice` (grant, choices) with nothing stored. `PolarisKey.identity.choice.licenses / devices / complete / cancel` finish it: only discovery's endpoints, no bearer, refusals as `PKeyChoiceResult` values (`retry_after_seconds`, `manage_url`, `sign_in_url`, `key_entries`, the fresh `view`), `keep` gives `attachable`, and the grant never appears in an error. `choice.primitives()` are the Callables the sign-in form drives. `identity.choice` is implemented.
- **Redirect sign-in and request hints (I-10b.5).** `sign_in.start({channel = "redirect", redirect_uri, scope, login_hint, name_hint, purpose})` builds the S256 authorize URL from discovery (`session.authorize_url`) for a browser the host opens; `session.complete(callback_url)` checks the redirect URI, `state` and `iss` before anything is sent, then redeems the code at discovery's `token` endpoint (form body, the product's origin only). Single use; a refusal is an `error` outcome under the Worker's own code and never wipes the token; `access_denied` is `cancelled`. Loopback, scheme and claimed-HTTPS redirects stay with I-15, the licence choice with I-10b.6. `identity.redirect.web` and `identity.signin.hints` are implemented.
- **`identity.sign_in.start()` and `PKeySignInSession` (I-10b.4).** `PolarisKey.identity.sign_in.start({device_name, confirm_identity, browser})` returns a `PKeySignInSession` (the code, the links, `wait()`, the `outcome` signal, `cancel()`, `reopen()`, `accept()`); `wait()` returns a typed `PKeySignInOutcome` (`signed_in`, `choose`, `cancelled`, `expired`, `denied`, `device-mismatch`, `rate-limited`, `service-unavailable`, `error`). A start the Worker answers 404 is `service-unavailable`. `PolarisKey.event("identity", {kind, subject, previous})` reports `signedIn`, `signedOut` and `subjectChanged`. Removed, with no alias: `begin_sign_in`, `request_sign_in`, `poll_sign_in`, `wait_for_sign_in`, `sign_in_with_browser`, `accept_sign_in`, `cancel`, `is_signing_in`, `signed_in_identity` and the `sign_in_pending`, `sign_in_confirm` and `sign_in_finished` signals; `PKeySignInPrompt` is `PKeySignInSession` and `PKeySignInResult` is `PKeySignInOutcome` (kind `ok` is `signed_in`, `timeout` is `expired`). Migrating: `var s := await identity.begin_sign_in()` becomes `var s := await identity.sign_in.start()` and the `sign_in_finished` result is `await s.wait()`. See https://key.plrs.im/docs/reference/api-names/.
- **`identity.attach(confirm)` (I-10b.3).** `PolarisKey.identity.attach(false)` previews the device's own licence (detail `kind: "confirm"`, nothing written); `attach(true)` adds it to the signed-in account, stores the rotated token and answers `{kind: "ok", subject, attached}` (sync after, as after `activate_with_key`). A Worker refusal (`account_required`, `license_owned`, `license_email_bound`, `unauthorized`, `not_found`) is a failure with that `code` and `detail {kind: "refused", status}`; token, cache and identity stay. Device-code sign-in with `confirm_identity` now emits `sign_in_confirm` only when the poll's `confirm` is `attachable`; with nothing to attach the SDK answers the server's hold with no, and a plain `ready` never asks.
- **Account calls (I-10b.2).** `PolarisKey.identity.subject()` (the pairwise subject signed in on the device, kept across restarts), `sign_out()` (runs the pre-sign-out hooks, POSTs the product's published `signout`, drops the token only when the server says `released: true`) and `open_account()` (opens the published `accountPortal`), over the Identity fragment of discovery (`PKeyDiscovery.identity_from`). A product that publishes none answers `service-unavailable` with `detail.kind == "unavailable"` and nothing is sent; `sign_out()` then keeps its old `license.deactivate()` path. The wiring `identity.attach(core, host)` is `bind(core, host)`, which frees `attach` for the licence-attach verb. There is no alias.
- **Options renamed (SP-35b).** `PKeyOptions.product` is `product_slug` and `pinned_trust_keys` is `pinned_keys`, in the Resource, `res://polaris_key.tres`, the setup dock and `pkey sdk --lang godot --write`. There is no alias. Migrating: a `polaris_key.tres` that still holds either old name makes `configure` fail with `invalid-options` (the message names the new fields, never a value), the editor warns when it loads one, and an export logs an error (it does not abort). Open the setup dock (it pre-fills the old values; tick the pins confirmation, then Save), or run `pkey sdk --lang godot --write` (it drops the old lines). A new `.tres` read by an older addon fails `configure` with "product must be a lower-case slug". See https://key.plrs.im/docs/reference/api-names/.
- **Entitlements have a namespace (SP-35b).** `PolarisKey.entitlements.has(name)`, `.value(name)` (new) and `.all()` replace `PolarisKey.license.is_entitled` and `license.get_entitlements`. `has` and `value` answer false and null unless the licence gate is usable; `all()` reads the verified document's values ungated, as `get_entitlements` did. `entitlements` exists before `configure` (false, null, `{}`). `PKeyCommerce.attach` and `PKeyEntitlementBadge.granted` take the `PKeyEntitlements` instead of the licence. There is no alias. Migrating: `PolarisKey.license.is_entitled(x)` becomes `PolarisKey.entitlements.has(x)`; `PolarisKey.license.get_entitlements()` becomes `PolarisKey.entitlements.all()`. See https://key.plrs.im/docs/reference/api-names/.
- **`PolarisKey.event(kind, data)` (SP-35b).** One signal for what changed, the Godot form of the `events` stream: kinds `license`, `config`, `updateAvailable`, `packs` and `store` (`PKeyConstants.EventKind`), `data` a snake_case Dictionary as in Swift's `PolarisKeyEvent`. Raised beside `state_changed`, `config.config_changed`, `update.update_available`, the pack progress and `store_error`, which stay; nothing is raised before `configure()`. New with it: `config.config_changes` and `packs.pack_phase`.
- **Device, binding and install renamed (SP-35b).** `PolarisKey.devices.get_current_device()` is `PolarisKey.current_device()`, `PolarisKey.commerce.get_binding()` is `binding()` and `PolarisKey.update.apply(check)` is `install(check)`. There are no aliases. Migrating: rename the three calls; the outlet adapters' own `apply` is unchanged. See https://key.plrs.im/docs/reference/api-names/.
- **`config.get_source` is `get_config_source` (SP-35b).** The `get` verb now precedes the noun, as in the other SDKs. There is no alias. Migrating: rename the call. See https://key.plrs.im/docs/reference/api-names/.

- **Three more standalone scenes (UK-11b).** `PKeyCloudSyncStatus` (synced, syncing, offline, conflict with **Review**, error, signed out with **Sign in to sync**; never implies universal backup), `PKeyAbout` (product, version, Privacy and Get help on https pages, Open-source licenses, **Copy diagnostics** of the text your game chose to share) and `PKeyReleaseNotes` (the changelog, newest first, notes drawn as text; loading, empty, error with **Try again**). Same shape as `PKeyPaywall` and `PKeyDeviceLimit`: catalog words in the running locale, signals for what the game does.

- **Two standalone scenes (UK-11b).** `PKeyPaywall` (the Paywall model's states: offers, loading, purchasing, restore, purchased, not available; **Upgrade to <tier>** through your store plugin's `purchase_requested`, or **Buy in your browser** on an https page; Redeem and Restore where you connect them) and `PKeyDeviceLimit` (the DeviceLimit model's states: replace the least recently used other device, browser mode with a QR code on a TV, busy, removed, failed). Both read their words from the catalog in the running locale, honour `PKeyUiCopy.overrides`, and never remove a device or sell anything themselves: you answer `replace_requested`, `purchase_requested` and the other signals.

- **Game look, part 2 (UK-11b).** The input hint is a bar of glyph and bare-verb pairs (`PKeyHintBar`; the one new catalog key is `part.hint.select`, in nine locales, beside "Activate", Back, and each screen's own Cancel or Later): "[A] Select [B] Cancel" on the sign-in dialog, "[A] Select [B] Later" on the update modal, "[Enter] Activate" on the key field. It is one footer at the bottom right of the title-safe area, outside the panel (the panel's last row on a phone), reads the catalog in the running locale, follows a remapped `ui_accept` or `ui_cancel` (keycaps from the bound keys), leaves out a button with no glyph and shows for a keyboard or pad, never touch. A dialog's entry now fades the whole view but scales only its card (the scrim never shrinks; a phone's sheet does not scale). A new screen of a dialog crossfades the card's inner content (never the card, a page or the art). Every dialog over the game (settings, sign-in, offline activation, the update modal, the new Paywall and DeviceLimit) fades out before `closed` or `dismissed` fires, once however often B is pressed; all off under reduced motion. The toast keeps 5 % of the width and of the height from the screen's edges. Pads other than device 0 now answer the kit's A and B. A held direction plays `focus`; the offline dialog's rejected response and the account tab's sync error play `error`. A multi-line field's ring (Godot before 4.6) is clipped to its scroll area and follows the dialog's fade.

- **Game look, part 1 (UK-11b).** A dialog's card over the dimmed game is glass: the raised surface at 94 % (dark) or 96 % (light) with a light edge and a soft shadow, until the blur ships; the light scrim is 35 %. It stays fully opaque on a phone's sheet, under reduced transparency, on the web, under `gl_compatibility` and in the neutral look. The focus ring glows (`FOCUS_GLOW`), and on Godot before 4.6 a multi-line field's ring is drawn by the kit (the engine clips it). A dialog fades in from 98 % scale after it is first drawn, and a pressed button settles to 98 %; neither moves under reduced motion, and neither depends on `Engine.time_scale`. `ui_brand_scheme` takes `system` and follows the OS (re-checked on focus and on open; the kit never takes your system-theme callback; dark where the OS cannot say). Sound: `PolarisKey.ui_sound(event)` and `ui_sound_hook` get `open`, `close`, `focus` (navigation only), `confirm`, `back` and `error`; `ui_haptics` (off by default) vibrates a handheld and rumbles the pad last used. `PKeyInputGlyphs` draws the confirm or back control of the last device from the buttons bound to `ui_accept` and `ui_cancel` (Xbox, PlayStation and Nintendo families); the key field's hint carries it. Tests and CI can force the presentation path with `PKEY_UI_REDUCE_TRANSPARENCY=0|1`; `run_tests.sh` runs the matrix on both with `PKEY_UI_MATRIX_PATHS=both`. Fixed: on 4.7.2 a button's icon counted in its minimum width but not in the fit, so `sign_in` overflowed a 390 px screen on the scrim path.

- **Kit screens match the shared states.** Version too new keeps Try again as its one action. The offline-activation screen is a numbered two-step form (send the request, then load the response) in every state but done, with the request QR where it fits, labelled for screen readers, and no product line; a rejected response adds its error, and done has a title and a Done button. An expired license offers Renew and Use another license, and never Try again or Reconnect; the Godot gate takes `renew_url` (an https page; Renew opens it, then re-reads the license) or a `renew_requested` handler, and offers Use another license alone without either. The TV QR on the device-limit screen is labelled as the device management page. The offline dialog numbers its steps and shows the request QR on phones.
  Migrating: pass the https offers URL to get the paywall's Buy in your browser button (without it the not-available paywall has no button).

- **Device-code sign-in tells a refusal from a failure.** A poll answering `error` with `reason: "access_denied"` (a person pressed Deny, Not you? or Cancel) ends as `sign-in-denied`; a bare `error` (the sign-in failed after approval) now ends as `sign-in-failed`, and the sign-in handoff has a `failed` state. Migration: check `sign-in-failed` as well as `sign-in-denied`. Builds already shipped ignore `reason` and behave as before.
- **Five components the kit lacked.** Every other GUI kit had them (UI-KITS.md §4.1, §4.3):
  `PKeyDeviceList` (Devices: this license's devices as 64 px rows with a form-factor glyph, a "This
  Mac" tag only where the runtime knows which device it is, Rename in place and Remove with an inline
  confirm; the server lets a device rename and sign out only itself, so a roster read from the SDK
  edits this device only, and a game that manages the others sets `host_handles` and answers
  `rename_requested` / `remove_requested`), `PKeyLicenseChoice` (LicenseChoice: rows with origin and
  term, a seat meter and its count, "On this device" and "All devices in use" tags, **Use this license
  and continue** as the one primary; keep, create and a first license are rows of their own),
  `PKeyAccountTab` (AccountAndLicense: grouped rows for the tier, who is signed in, Devices with its
  meter, Updates, Managed settings and Sign out in danger text in a group of its own; also the first
  section of `PKeySettingsPanel` with `account_tab = true`), `PKeyToast` (one line and its consequence,
  at most two actions, a visible 6 s timer, errors that stay, no focus taken from the game; `toast_anchor`
  and the `pkey_toast_focus` input action reach it) and `PKeyUpdateProgress` (a counted bar: "38 of 91 MB
  · 1 minute left", queued, paused, failed and done; `PKeyProgressBlock` draws the same bar inside a
  toast). New keys: `devices_*`, `choice_*`, `replace_*`, `account_*`, `status_*`, `sync_*`, `toast_*`,
  `progress_*`, `when_*`, `platform_*`, `form_factor_*`, `this_device_*`, `seat_*`, `dismiss`,
  `manage`, `copied`, `loading`, `update_check_now`, `update_downloading_of`. The unused
  `devices_last_seen`, `devices_sign_out`, `devices_unsupported`, `devices_manage_online`,
  `devices_refresh`, `account_signed_in_as`, `account_signed_out`, `account_deactivate`,
  `account_sign_out_confirm`, `account_manage` and `account_signed_out_done` keys are gone, and
  `devices_title` reads "Your devices", `devices_empty` "No devices are using this license yet.", and
  `devices_remove_confirm` "Remove %s? It signs out of {product}.", as the catalog does.

- **The kit follows UI-KITS.md.** Copy: the English template strings that the kit catalog words
  differently now read as it does ("Update now" and "Later" for the update prompt, "Update" for the
  gate's fix, "Offline · 3 days left", "Code expires in 2:05", the Welcome lede "Sign in or use a
  license key to continue.", "{product} needs … of new content"); a game's Translation or `copy`
  override keyed by an old string moves to the new one. New keys: `status_update`,
  `channel_not_entitled_title`, `banner_last_day`, `banner_reconnect`, `banner_dismiss`,
  `settings_managed`, `settings_search`, `sign_in_code_title`, `sign_in_go_to`, `sign_in_scan_tv`.
  Behaviour: the device-code view is titled "Sign in with a code", counts down in a determinate ring
  (`PKeyCountdownRing`) and puts the address after the code; Welcome's extras (Continue free, Activate
  offline, Restore purchases) are one row of links under a lede; a refusal's title leads the end pane,
  not the product pane, and a channel the license lacks has its own title; the grace banner says "last
  day", offers Reconnect and Dismiss (dismissed for the session; `PKeyStatusBanner.reconnect_requested`,
  `dismissed`); the update modal is titled "<Product> <version>" with the icon alone above it; rows
  a policy locks form "Managed settings" last, a list over 12 rows has a search field, and a failed
  load has Try again; the gate shows nothing for the first 250 ms of its license check, then the
  identity, a label and the shimmer. The product header's name is weight 500.

- **US spelling and shorter kit copy.** The English template strings `Sign-in was cancelled.`, `The
purchase was cancelled.` and `Last seen %s` read `Sign-in was canceled.`, `The purchase was
canceled.` and `Last used %s`; `Your license doesn't include this release channel.` drops
  "release", and the expired line no longer repeats its title. A game's own Translation keyed by the
  old English string must move its key to the new one (the shipped `locale/*.po` files are keyed by
  catalog id and follow on their own). The activation panel shows a refusal of a well-formed key
  (license disabled, expired, rate limited…) as a neutral line with no error stroke on the field;
  an unknown key and a failed check keep the error style (UI-KITS DL6, DL7).

- **One config file: `res://polaris_key.tres`.** `pkey sdk --lang godot --write` now sets `product`,
  `base_url`, `pinned_trust_keys`, `pinned_release_keys` and `expected_services` in it (creating it
  when absent, keeping every other property) instead of writing `polaris_key_config.gd`, and the dock's
  **Generate config** lists the fields it changed. `polaris_key_config.gd` is no longer read: delete
  it (the dock offers to) and drop any `preload("res://polaris_key_config.gd").options()`; `await
PolarisKey.boot()` reads the `.tres`.

- **Powered by Polaris Locker (LK-16).** `ui_powered_by` draws the Locker line (micro mark at 16 px and
  the phrase) at the foot of the settings scene, never the gate or boot. `ui_powered_by_style`
  (`"line"` default, `"badge"`) is the one option; `"badge"` applies to a `PKeyPoweredBy` node with
  `allow_badge = true` that you place on a credits or about scene (320 × 104, where 320 px are free).
  `PKeyUiTheme.powered_by_style` replaces `powered_by_mode`; `powered_by_size()` takes no layout. The
  Key badges (`powered-by-compact-*`) are no longer shipped, and `brand/powered-by-credit-*.svg` (1920 × 1080
  credit screens) became `brand/powered-by-badge-*.svg`, the 320 × 104 Locker badge: a size change.

- **Client backend (`core.backend`, SP-59).** `PolarisKey.backend.headers()` (raw lines for
  `HTTPRequest`; set `max_redirects = 0`), `headers_for(url)` and `request()` send `X-PKey-License` and
  `X-PKey-Device` to the app's own backend, only to `PKeyOptions.backend_origins`; `request()` checks
  every redirect hop before it is sent. Pre-sync, one forced retry at least 10 s apart, typed
  `not_entitled` and `sign_in_required`. `PKeyTransport.request` takes a per-call
  `follow_redirects: false`.

Hostile-input fixes.

- **A `blocked` hint outside the block vocabulary reads as the strictest block at the gate.** The
  gate returns the hint's reason as the status, and `ok`, `grace` and `not-applicable` are usable,
  so an unsigned `{"reason": "ok"}` that reached `PKeyGate.license_state` would have licensed the
  client. The cache reload already dropped such a hint and a 403 body already read as the stricter
  block; the gate now coerces too, so the rule holds at the decision point whoever hands it the
  hint. `PKeyGate` exports `STRICTEST_BLOCK_REASON` (`version-too-old`), `is_block_reason()` and
  `coerce_block_reason()`. A 403 body takes the first reason that is inside `BLOCK_REASONS` (the
  nested `error.reason`, then the top-level one) rather than the first non-empty one, and falls back
  to `channel-not-entitled` for `channel_not_allowed` and `version-too-old` otherwise.
- **A raised payload cap needs a `typ`.** `PKeyJws.verify`, `verify_async` and `prepare` refuse a
  `max_payload_bytes` above 65 536 when no `typ` is named, rather than verifying at the raised cap
  with no type demanded. Offline bundles name both, so nothing changes for them.

Local-trust fixes, the product's presentation, and the UI kit's headless layer.

- **The UI kit's headless layer (`addons/polaris_key/ui/model/`).** One view model per kit
  component (the gate, boot, status screen, grace banner and toasts; Welcome, Activate and offline
  activation; the sign-in form, its hand-off and the license choice; the device limit and devices;
  the update prompt, progress and release notes; account, settings, paywall, entitlement gate,
  Cloud Sync status, About and the channel picker), each a pure function of one input Dictionary
  that answers the state, the catalog copy keys, the actions and the design decisions (the one
  primary, the tone, where an error sits, what takes focus, which links and QR codes may show).
  `models.gd`'s `view_of(component, input)` is the entry point; `sign_in_session.gd` is the sign-in
  form's state machine over the SDK's sign-in primitives; `theme.gd` resolves the product's
  identity and accent; `copy_format.gd` formats the catalog's messages (plurals and the form-factor
  select) from the generated `.po` tables in the launch locales. A game that draws its own screens
  gets the same states and copy as the drop-in. The new `ui_core` suite runs every row of
  `ui-matrix.json` (all ten families) through them.
- **The activation form on a phone.** On a phone's screen the gate's and the activation panel's
  form docks to the bottom of the page, the primary on top, under the product and a one-line lede
  at the top (it used to float in the middle of an empty page). Activate goes under the key field
  on a phone, and wherever the field beside it could not hold its placeholder; a placeholder the
  field cannot hold even then is left out, never cut.
- **The license key field is visible and private.** It is drawn in clear and typed on an
  on-screen keyboard that neither corrects nor learns it (the password keyboard type).
- **A title never breaks a word, and a button never widens the screen.** A title too narrow for
  its longest word (German on a 375 pt phone) steps its type down, never under the body size,
  until the word fits; a button label wider than the screen wraps at its words.
- **Three weights.** The Polaris Key look draws headings, sections and the user code at 600 and
  the primary button at 500, from the bundled variable Rubik (`rubik_600.tres`,
  `rubik_500.tres`); Rubik Bold (700) is no longer used for them.
- **`ui_reduce_motion` and `ui_reduce_transparency`** (`auto`, `on`, `off`; DL16). `auto` follows
  the system's setting where the engine reports it (Godot 4.5+). Reduced motion holds the loading
  shimmer still; reduced transparency puts a dialog over the game on the opaque page instead of
  the scrim.
- **`PKeySettingsPanel.open(parent)`** shows the settings over the game in one line, with Close
  (and Escape or a pad's B), gives the focus back and frees itself; `closable` and the `closed`
  signal are the parts. A panel a game's own menu holds has no Close. The minimal example uses it
  instead of wrapping the panel in an AcceptDialog.

- **Signed-in user (`license.signedinuser`).** `PolarisKey.license.get_license_user()` returns `{subject}` from the verified licence document's `profile.user`, or null when it is absent or malformed (a key-activated device is null).

- **Product presentation (`core.presentation`).** `PolarisKey.presentation()` returns the
  product's name, developer, accents and icon from discovery ({} for none);
  `PolarisKey.presentation_icon(px, scale)` fetches one icon size without credentials or
  redirects, verifies its SHA-256 and the image header (16 MP at most) before decoding PNG, JPEG or
  WebP, and caches it under `user://polaris_key/presentation/`. The kit's name, icon and accent
  default to it after `ui_product_name`, `ui_product_icon` and `ui_accent`; `accentDark` applies
  in the dark scheme (`PKeyUiTheme.presentation_accent_dark`). Product names are drawn
  bidi-isolated in the header and the settings "Set by" line.
- **`PKeyTransport.follow_redirects`.** `false` hands a 3xx back as its status, with no second
  request.

- **Pin two keys, and a pinned key can be revoked.** A trust manifest signed by one pinned key that
  lists another pinned key as `revoked` (with its exact bytes) removes that pin on the install for
  good; a manifest that revokes its own signer is refused. The revoking manifest is stored in the
  cache's `pinRevocations` slice, in the same write as the manifest, re-verified at every start,
  and kept through a bundle import, a deactivation and a device-id re-binding. When the served
  manifest is signed by a key the app does not pin, `sync()` asks for it again with
  `?signer=<kid>` for each pinned key (at most four requests).
- **Only `active`, `staged` and `retired` keys are trusted.** A manifest key with any other
  `status` (absent, unknown, a different case) is skipped; a `publicKey` that is not canonical
  base64url is skipped too.
- **Non-canonical base64url is refused.** A JWS segment or a trust key spelled with unused bits set
  no longer decodes; `PKeyB64Url.is_canonical()` is the check.
- **Breaking: an imported bundle is kept as `bundle`, and an install that activated from one
  imports it again after upgrading.** The `importedBundle` marker is no longer read or written.
  A bundle activates the install only while the cached bundle re-verifies and carries the cached
  licence document byte for byte. Importing the same bundle again changes nothing; a bundle whose
  documents are not newer than the cached ones of their type is refused (`inner-doc-rejected`),
  and a bundle needs a fresh mint once its 30-day window has passed. `PKeyCache.imported_bundle`
  is replaced by `PKeyCache.bundle`.
- **Revocation and a build block end offline use at once.** A hard 401 deletes the document it
  answered for, and its ETag, in the same cache write that records it; a 403 build block deletes
  the licence document. The token stays, so the gate reports `revoked` or the block. The
  `blocked` and `lastSyncUnauthorized` hints are display-only: clearing one gives
  `needs-activation`, never a usable document.
- **Discovery can switch the licence gate on, never off.** The gate follows the build's
  `expected_services` (default: licence and config) or a discovery document loaded this session
  that enables licensing. A product that does not license must pass `expected_services` without
  `license` (`PKeyCore.license_gate_enabled()`). Which sub-clients exist still follows discovery.
- **Breaking: `PKeyVerify.verify_*` requires `last_accepted_issued_at`.** Pass an explicit `null`
  for "no floor"; a call that omits the key is refused.
- **A desktop device whose stored id differs from its platform anchor re-activates once.** The
  file and keyring stores re-derive the id from MachineGuid, IOPlatformUUID or the machine-id at
  every start; a stored id that disagrees is discarded with the token and the grant cache (the
  feed and release-record slices stay). `ioreg` and `reg.exe` run by absolute path.
- Licence, config and trust-manifest verification on the network path use the effective clock.
- **`PKEY_DESKTOP_KEYRING=0` is honoured only in debug builds**; a shipped build ignores it. On
  Linux the Secret Service tool is run as `/usr/bin/secret-tool`, never found through `PATH`.
- **Second review fixes.** The persistent gate carries the kit's theme over the game. Dialogs opened
  from the boot's gate (Sign in, Activate offline, "Is this you?") take the focus and give it back.
  The settings panel shows "Loading settings…" instead of raw keys while the live schema loads, names
  an uncategorised group "General", takes the focus from the game when its first rows arrive, and its
  list fills the room the screen leaves it. "Check again" says "Checking…", "No update yet." or
  "Couldn't check."; a store build with no way to activate says "Get {product} from {store} to
  play." (with Restore purchases where it works). The product header grows with a large title and
  is not drawn for this repository's own project name. A `boot()` during a retry or READY's
  background installs joins the run. Copy: "Connecting…", the blocked-update line, the
  verify-failure line.

- **Drop-in fixes.** **Behaviour change:** `await PolarisKey.boot()` resolves at READY, through any
  number of stops and retries (a stop keeps its card with Try again on screen); pass
  `resolve_on_stop: true` for the old first-stop result. `boot()` is re-entrant (a second call while
  one runs joins it; after READY it starts a new boot with a fresh gate), `persistent_gate: true`
  leaves a gate over the session (`PolarisKey.boot_gate`) that covers the game again when the licence
  is revoked, expired or signed out, and `confirm_identity: true` makes a sign-in stop at "Is this
  you?" before handing back. `PKeyUiView.sdk` is a setter that hands the SDK to the views nested in
  the view and renders again (a gate built before the SDK was known shows its dialogs' content). The
  status banner has an expired state. Every control of a kit screen has an accessible name (Godot
  4.5+). One update prompt at a time: a `PKeyUpdatePrompt` the game places replaces the kept one, and
  a locked answer with nothing to open or install offers Check again. An activation (or sign-in) whose
  license document does not verify (an unpinned signer, a clock two days off) is no longer reported as
  "Activated.": it reads "This device couldn't verify the license it was given…" and logs a
  `push_error` naming the pins and the clock; `PKeyUiCopy.for_result` is empty on ok and reads an
  activation result with the panel's own words; network and timeout copy name the product. Key entry
  follows the outlet's effective capabilities (commerce `store-iap`, which now includes the Microsoft
  Store). The settings panel fetches the product's live schema once it opens. The drop-in names the
  device by the computer's own name where the OS has one. Two reference cycles that Godot reported as
  leaks at exit are gone (the `exit_leaks` suite runs a probe game and requires a clean exit).

- **Review fixes: settings on a short landscape screen.** The settings list opens with the focus in
  view on a phone held sideways (it used to open scrolled to its last row, the Volume slider out
  of view): the head scrolls with the list when no rail is shown and it would leave the rows a few
  control heights, the list reveals the focused control once the layout settles (also the advanced
  switch, and the control itself when a stacked row is taller than the list), and the first focus
  is the first editable row, else the selected rail item. A locked value, the advanced switch and a
  stepper's gaps line up with the other rows; the native look's settings fit 375 pt. A scene
  anchored across the screen keeps a game's deliberate offsets when it carries the
  `pkey_keep_offsets` meta (documented). A view the game re-parents keeps the control that opened
  it. The matrix gains 2532×1170@3, 1334×750@2 and 750×1334@2, and settings opened the way a game
  opens them.

- **Second review round.** The gate-hosted device limit takes the focus (a view nested in another
  asks the outermost view for it); the sign-in user code fits its width on one line (never under the
  title's size; at most a break at its hyphen); a full-screen view's offsets are the kit's (a
  game's `set_anchors_and_offsets_preset()` no longer leaves it wider or shorter than the screen);
  the update modal and the settings fit a phone's safe area and width laid out fresh at the size
  (the settings rail gives way to one column when it does not fit); scroll areas follow the focus
  once the layout settles; the settings slider draws a focus ring in every look; the settings
  column ends on one right edge, the rail's other sections have lighter borders and its heading is
  not said twice; settings freed by the game gives the focus back; the offline request QR shows on
  a pad-only device that is flagged mobile. The `ui_matrix` suite lays every screen out fresh at
  every size as well as resized, and checks tight cases by focusing the primary and requiring it
  inside the visible scroll area.

- **Review round on the drop-in screens.** A pad's A and B work under Godot's default input map
  (the kit adds `JOY_BUTTON_A` and `JOY_BUTTON_B` to `ui_accept` and `ui_cancel` when they have no
  joypad binding); a dialog opened over a focused game control takes the focus and gives it back;
  number settings answer the D-pad and the stick and keep their focus (an unbounded one steps with
  left and right); the gate's device-limit view takes the whole card and keeps the product header;
  focus neighbours are wired after the layout moves nodes; **behaviour change:** a QR code shows
  only on a pad-only device and for the offline request code (never on a desktop, tablet or phone);
  phone dialogs sit on an opaque bottom sheet; a tablet gets a centred column; the product name is
  no longer repeated as header and title; a busy button keeps its label and shows an indicator.

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
- **Fix round (review of the responsive screens).** The Polaris Key look is the default
  (`ui_branding` `polaris-key`; `none` is the game-theme look), with ink as the primary colour
  unless the product has an accent, a 3 px focus ring and the kit's lock, cloud-off and warning
  glyphs. A banner is a card with a glyph in every look. A phone's portrait screen is full-bleed
  with its actions docked at the bottom, also inside the gate; gamepad focus starts inside the
  screen (ui_down on a cold screen lands on its primary action) and survives a layout change;
  number settings are a slider (or spin box) that left and right change, with pointer-only minus
  and plus buttons; a screen too short for its content squeezes in steps (smaller QR, actions
  into a column, secondary lines dropped) before it scrolls. **Behaviour change:** a QR code never
  shows on a phone (the old "Use another device" button is gone); tablets, desktops and TVs keep
  it. Host fonts of 28 and 36 px, and 18-20 px type on a 360 px tall canvas, are tight cases: the
  primary action stays reachable through the card's scroll fallback.
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

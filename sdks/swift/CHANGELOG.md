# Changelog

All notable changes to the Polaris Key Swift SDK. Versions follow the monorepo's lockstep `v*`
tags; before 1.0 a minor version may change the API, and a changed API ships as the only API (no
deprecated aliases).

## Unreleased

- **Cloud Sync: `client.cloudSync` and synced config (U-07).** `client.cloudSync.status()`, `flush()`, `newRecoveryCode()` and `recoveryCode`, the `cloudSync` case of `client.events` (`change`, `rejected`, `signedOut`, `unsyncedData`, `signInOffered`, `purgeFailed`), and `config.set`, `clear` and `setting(key).sync()` routed through the Cloud Sync machine while a person is signed in. Settings sync in the mode app code names (`CloudSyncOptions(encryption:)`, default `.e2e`); a person change never talks to the server, and sign-out flushes, forgets the key ring, then purges the saved data (a ring that cannot forget stops the sign-out and keeps the data). Cloud Sync is off on Linux. `sync.settings`, `config.sync` and `sync.scenarios` are implemented; `sync.e2e` stays planned until the corpus row X-1.1 lands, and the `cloudsync-*` transcripts are required in `TranscriptTests`.

- **Cloud Connect: `client.cloudConnect` (CC-11.2 to CC-11.16).** `start()`, `stop()`, `peers()`, `devices()`, `open(_:)` and `onChannel(_:)` find the account's other devices over Bonjour (Network.framework) and the relay (`URLSessionWebSocketTask`), run the Noise handshake and hand back a `ConnectSession`. The `connect.noise`, `connect.protocol`, `connect.lan`, `connect.relay` and `connect.app` parity rows are implemented; `connect.links` and `connect.transfer` stay planned. Apps add `NSLocalNetworkUsageDescription` and an `NSBonjourServices` entry for `_pkeypeer._tcp` to their `Info.plist`, and a sandboxed macOS app needs `com.apple.security.network.client` and `com.apple.security.network.server`. A browse-only LAN service re-checks at the epoch boundary, the browse index drops its discovery key on stop, the relay outbox closes the session over its own share, the cached identity is dropped in both services when it changes, and a link closes a pipe whose writer is stuck.

- **Automatic sign-in: `identity.autoSignIn()` (I-44.1 to I-44.6).** `client.identity.autoSignIn(AutoSignInOptions(provider:prompt:))` runs the ladder (stored sign-in, then the platform provider silently, then with `prompt: .optional` its one sheet) and answers `AutoSignInResult` (`.signedIn`, `.confirm`, `.choose`, `.needsSignIn(linkHandle:reason:)`, `.deviceLimit(manageUrl:view:)`, `.unavailable(code:)`); only cancelling the task throws. `identity.exchangeNonce(kind:)` and `identity.exchange(kind:subjectToken:nonce:)` are the primitive under it. `PlatformIdentityProvider` is the provider seam (`client.identity.installPlatformIdentity(_:)`); `AppleSignInProvider` (Sign in with Apple, no silent rung) is installed by `PolarisKeyClient`. `identity.signOut()` keeps the ladder's silent rungs off until the person signs in again, and a revoked Apple credential signs the device out at the next launch. The SwiftUI gate runs the ladder once at launch and its Sign in with Apple row opens the sheet then the exchange; `.polarisKeyGate(client, autoSignIn: false)` and `.polarisKey(client, autoSignIn: false)` opt out. Needs the `com.apple.developer.applesignin` entitlement and a product that sets `identity.platformSignIn.apple`.

- **Licence choice in the app: `identity.choice` and `LicenseChoiceModel` (I-10b.12).** `SignInOptions(licenseChoice: .app)` asks for `license_choice=app` (sent only when discovery lists the four choice routes; otherwise the card chooses) and `session.complete(callbackUrl:)` settles `.chooseLicense(PendingSignIn)` when a choice is due. `client.identity.choice.licenses(grant:)`, `devices(grant:licenseId:)`, `complete(grant:choice:)` (`.license(id:replaceDeviceId:)`, `.keep`, `.create`, `.key(_:)`; the device token is stored like a sign-in's) and `cancel(grant:)` throw a typed `ChoiceError` (`invalid_grant`, `license_choice_required` and `device_limit` with a fresh `view`, `not_found`, `rate_limited` with `retryAfterSeconds`) or `UnsupportedError` when a route is not published. `LicenseChoiceModel` in `PolarisKeyUICore` (`@Observable`) turns a grant into the LicenseChoice screen's `KitInputs`.

- **Redirect sign-in on `identity.signIn.start` (I-10b.11).** `SignInOptions(channel: .redirect, redirectUri:)` (with `scope`, `loginHint`, `nameHint`, `purpose`) builds the S256 authorize URL from discovery for a browser your app opens (`session.authorizeUrl`, `reopen()`); `session.complete(callbackUrl:)` checks the redirect URI, `state` and `iss` before sending anything, redeems the code at the token endpoint and returns `SignInOutcome` (`.signedIn(SignInReady)` with `scope` and `licenseId`, or `.cancelled` for `access_denied`). A refusal is a `SignInError` under the Worker's code (`invalid_grant`, `rate_limited` with `retryAfterSeconds`, ...) and never wipes the token. The session is single use. `IdentityRedirect` exposes the pure core (PKCE, URL, callback checks, form, answer). Loopback and scheme redirects are I-15's.

- **Breaking: `identity.signIn.start` (I-10b.10).** `client.identity.signIn.start(SignInOptions(deviceName:browser:))` returns a `SignInSession` (`userCode`, `verificationUri`, `verificationUriComplete`, `expiresAt`, `reopen()`, `cancel()`, `wait()`); `wait()` settles to `SignInOutcome` (`.signedIn`, `.choose`, `.expired`, `.cancelled`) or throws the typed `SignInError` (`sign-in-denied`, `sign-in-failed`). `client.events` gains `identity` (`signedIn`, `signedOut`, `subjectChanged`). Removed with no aliases: `identity.beginSignIn`, `pollSignIn`, `waitForSignIn`, `acceptSignIn`, `signInWithBrowser` and `client.signInWithBrowser`; `SignInResult` is internal. Migrating: `let prompt = try await identity.beginSignIn(); try await identity.waitForSignIn(prompt)` becomes `let session = try await identity.signIn.start(); try await session.wait()`; `signInWithBrowser(browser:)` becomes `signIn.start(SignInOptions(browser:))` then `wait()`. The gate model drives the same session.

- **Account calls on `client.identity` (I-10b.9).** `subject()`, `signOut()`, `openAccount(opener:)`, `attach(confirm:)` and `onBeforeSignOut(_:)`, read from discovery's Identity fragment (`ProductDiscoveryDocument.identity`); an endpoint the product does not name answers the typed `UnsupportedError`. `signOut()` now asks the Worker (`POST identity/signout`) and returns `SignOutResult(released:)`: on `released: true` the credential is wiped and `license` is emitted, otherwise the token stays. It no longer releases a seat through `deactivate()`; `client.deactivate()` still does. A product that does not run Identity answers `service-unavailable`.

- **Breaking: one gate (SP-52b.2).** `.polarisKey(client)` now draws the kit's `PolarisKeyGate`, the same screens as `.polarisKeyGate(client)`, and keeps its model in the environment and its sync when the scene becomes active. The 0.8 gate family is removed, with no aliases: `PolarisGate`, `PolarisLoginView`, `PolarisGateModel`, `PolarisSignIn`, `PolarisSignInModel`, `PolarisOfflineActivation`, `GateOptions`, `PolarisManagePresentation`, `PolarisKitLayout` and `PolarisKitStyle`. `PolarisKeyModel(returnURL:)`, `PolarisKeyModel.returnURL` and `PolarisKeyModel.offeredManageURL` are gone too (the kit builds the Replace a device link itself). Apps link less code: the 0.8 views no longer ship.
  Migrating: `.polarisKey(client, options: GateOptions(showsKeyEntry:offersOfflineActivation:))` becomes `options: KitGateOptions(keyEntry:offlineActivation:)` (add `import PolarisKeyUICore`); `offersFreeTier` stays a parameter of `.polarisKey`. `PolarisGate(model:...) { }` and `PolarisLoginView` become `PolarisKeyGate(client) { }`. `GateOptions.returnURL`, `renewURL` and `blockedAction` have no counterpart: the kit's Replace and Renew actions come from the product and `KitGateHandlers`. `PolarisTheme` maps `branding` (to the kit preset) and `accent`; its `palette`, `typography`, `copy`, `logo` and `accentOn` are ignored, so set `.polarisKeyTheme(PolarisKeyTheme(colors:typography:copy:product:))` instead. `PolarisKeyModel.offeredManageURL` has no replacement.

- **`PolarisKeyUpdateUI`: the SwiftUI Sparkle user driver and the Mac update window (UK-08.6).** `PolarisSparkleUserDriver(client:options:)` is an `SPUUserDriver` that draws Sparkle's flow in one utility window (permission ask, found, download with real bytes or an indeterminate bar, extracting, ready, up to date, and an error callout with Try Again). Pass it as `PolarisSparkle.start(client:userDriver:)`. It answers a Sparkle reply only from a control the person pressed or the window's close button, each reply once; the feed, the signature check and the install stay Sparkle's. macOS only; `UpdateWindowView(model:)` draws the same screens for a host that places its own window (`Options.presentsWindow: false`). `PolarisSparkle` also gains `PolarisSparkleUpdaterAware`, which a driver adopts to receive its updater. Attaching the driver sets `PolarisKeyUpdateHook.present`, so the Mac Settings pane's and the app menu's "Check for Updates…" (UK-08.4) open this window when the module is linked.

- **`PolarisSparkle.start(client:channel:bundle:userDriver:)` takes your own Sparkle user driver (UK-08.5).** Pass an `SPUUserDriver` and the updater is an `SPUUpdater` on it; without one it is the standard controller as before. Only the UI changes: the feed, headers, channels, journal events, the `SUPublicEDKey` assertion and Sparkle's signature check and install are the same. Source break (the API is unreleased): `PolarisSparkle.controller` is now `SPUStandardUpdaterController?` (`nil` with a `userDriver`) and the new `updater: SPUUpdater` is set on both paths. Migrating: `sparkle.controller.updater` becomes `sparkle.updater`; `sparkle.controller.checkForUpdates(nil)` becomes `sparkle.checkForUpdates()`.

- **Device-code sign-in tells a refusal from a failure.** A poll answering `error` with `reason: "access_denied"` (a person pressed Deny, Not you? or Cancel) ends as `sign-in-denied`; a bare `error` (the sign-in failed after approval) now ends as `sign-in-failed`, and the sign-in handoff has a `failed` state. Migration: check `sign-in-failed` as well as `sign-in-denied`. Builds already shipped ignore `reason` and behave as before.
- **Breaking: Powered by Polaris Locker.** `PolarisPoweredByBadge` draws the Locker `powered-by` badge
  (320 × 104 points minimum); its `Layout` and `Treatment` options and `PolarisPoweredByBadge.size(layout:width:)`
  are gone (`size(width:)` replaces it). `PolarisPoweredBy` and `PolarisTheme(poweredBy:)` are removed (the legacy
  gate never draws the attribution; the kit theme's `poweredBy` is the opt-in). New: `PolarisPoweredByAttribution`, `PolarisPoweredByStyle`.
  The legacy gate no longer draws the attribution, and the Key "Powered by" PNGs are no longer bundled.

- **`events` is the stream; getters take `get` (SP-35b).** `PolarisKeyClient.changes` is removed (`events` is the one stream). Renamed: `syncState()` is `getSyncState()`, `startRefreshLoop(onChange:)` is `startRefresh(onChange:)`, `LicenseClient.profile()` is `getProfile()`, `licenseId()` is `getLicenseId()`, `licenseUser()` is `getLicenseUser()`, `ReleaseClient.installURL()`/`downloadURL(...)` are `installUrl()`/`downloadUrl(...)`, and `UpdateClient.buildURL(...)` is `buildUrl(...)`. Core's top-level `licenseUser(_:)` helpers stay. No aliases.
  Migrating: `client.changes` becomes `client.events`; rename each call to the new spelling, e.g. `await client.license.profile()` becomes `await client.license.getProfile()`.

- **Activation is `license.activateWithKey` (SP-35b).** `LicenseClient.activate(key:)` is renamed `activateWithKey(_:)`, and the `PolarisKeyClient.activate(key:)` facade is removed. No aliases.
  Migrating: `client.activate(key: k)` and `client.license.activate(key: k)` become `client.license.activateWithKey(k)`.

- **Entitlements are a namespace (SP-35b).** `client.entitlements` has `has(_:)`, `value(_:)` and `all()`. `has` and `value` answer false and nil whenever the licence gate is not usable (S-19 G11); `all()` reads the held document. `license.isEntitled`, `license.entitlementValue`, `license.entitlements()` and `client.isEnabled(flag:)` are removed. No aliases.
  Migrating: `client.license.isEntitled(n)` and `client.isEnabled(flag: n)` become `client.entitlements.has(n)`; `license.entitlementValue(n)` becomes `entitlements.value(n)`; `license.entitlements()` becomes `entitlements.all()`.

- **The setting handle is async properties (SP-35b).** `client.config.setting(key)` exposes `value` (nil when no layer has one, source `fallback`), `source`, `locked` and the new `visibility` (`SettingVisibility`: `editable`, `readonly` for `enforced`, `hidden`) as `async` properties, and `on(_:)` subscribes. `value(default:)`, `source()`, `isLocked()` and `onChange(_:)` are removed. No aliases.
  Migrating: `await setting.value(default: d)` becomes `await setting.value ?? d` (or `config.get(k, default: d)`); `await setting.source()` becomes `await setting.source`; `await setting.isLocked()` becomes `await setting.locked`; `setting.onChange { ... }` becomes `setting.on { ... }`.

- **Config reads are `get`, `getConfigSource` and `getSecret` (SP-35b).** `client.config.get(_:default:)`, `client.config.getConfigSource(_:)` and `client.config.getSecret(_:)` replace `config(_:default:)`, `configSource(_:)` and `secret(_:)`; the `PolarisKeyClient.config(_:default:)` shortcut is removed. No aliases.
  Migrating: `client.config(k, default: d)` and `client.config.config(k, default: d)` become `client.config.get(k, default: d)`; `configSource(k)` becomes `getConfigSource(k)`; `secret(k)` becomes `getSecret(k)`.

- **Kit screens match the shared states.** Version too new keeps Try again as its one action. The offline-activation screen is a numbered two-step form (send the request, then load the response) in every state but done, with the request QR where it fits, labelled for screen readers, and no product line; a rejected response adds its error, and done has a title and a Done button. An expired license offers Use another license, and Renew only when you set `GateOptions.renewURL`; it never offers Try again or Reconnect. The TV QR on the device-limit screen is labelled as the device management page. SwiftUI draws the numbered steps and the request QR.
  Migrating: pass an https `url` in `KitOffers` to get Buy in your browser on the paywall, and `renewURL` on `GateOptions` to get Renew (superseded by the one-gate change above).

- **Client backend (`core.backend`, SP-59).** `client.backend.data(for:)` and `headers()` send
  `X-PKey-License` and `X-PKey-Device` to the app's own backend, only to `backendOrigins` (exact origin, https
  or loopback http), checked before the request and on every redirect hop before it is sent
  (`backend-origin-not-allowed`). A document near its expiry is synced first, `license_stale` and
  `license_invalid` force one sync (at least 10 s apart) and one retry, `not_entitled` and
  `sign_in_required` throw a typed `PolarisError`.

Hostile-input fixes.

- **A poisoned `blocked` hint drops the hint, not the cache.** A cache record whose `blocked.reason` is outside `BlockReason` now loads without the hint; it used to discard the whole record. `BlockReason` is `CaseIterable`.
- **`JSONValue.intValue` no longer traps.** A JSON number outside `Int` (`1e30`, an infinity) reads as nil instead of crashing the process; a fractional number is still nil.
- **A bundle's import window runs at the effective clock.** `importBundle` checks the 30-day window at `max(system clock, floor)`, so winding the clock back no longer reopens a lapsed window.
- **A cached document stamped far ahead of the system clock reloads.** `CoreContext` no longer refuses a cached licence or config document stamped more than `MAX_GRACE_SECONDS` past the system clock, so a device with a dead clock keeps its licence and the floor takes the newest artifact, as in the other SDKs.

Gate and SDK correctness.

- **Signed-in user (`license.signedinuser`).** `licenseUser(_:)`, `LicenseClient.licenseUser()` and `DocProfile.user` read the pairwise subject from a verified licence document's `profile.user`; a malformed or absent member is nil.
- **Product presentation (`core.presentation`).** `client.presentation`,
  `client.presentationIcon(points:scale:)` and `client.presentationSource` (the `PresentationSource`
  seam in PolarisKeyCore) expose discovery's name, developer, accents and an icon verified by
  SHA-256, cached by hash with `presentation.json` for cold starts. The SwiftUI kits default their
  name, icon and accent to it when the theme sets none. `CoreOptions.presentationIconFetcher`
  replaces the icon fetcher.

- **A blocking gate has a way out.** An expired licence offers Renew or manage (with
  `GateOptions.renewURL`), Try again, Use a different key and Sign in; a revoked one offers Use a
  different key and Sign in; the explanation is worded for the controls it has. Use a different
  key shows the activation form in place and Cancel goes back. `GateOptions.blockedAction` adds
  the host's own action.
- **Behaviour change on iOS:** a gate built directly with `PolarisGate(model:...)` no longer offers
  "Activate offline" by default (its default is now `GateOptions.defaultOffersOfflineActivation`,
  false on iOS). To keep it, pass `offersOfflineActivation: true` or
  `options: GateOptions(offersOfflineActivation: true)`.
- **`.polarisKey(client, theme:, options: GateOptions)`** carries key entry, offline activation
  (off on iOS), the free tier, the return URL for Replace a device and a renewal page.
  `PolarisKeyModel` takes the return URL, which the device-limit link now carries.
- **No activation card before the first read.** The gate draws only its ground until
  `PolarisKeyModel.hasLoaded`.
- **The accent you pass goes through `PolarisAccent.resolve`**, so the fill, its label and the accent
  text clear 4.5:1 in both schemes. A repeated identical refusal is announced again.
- **Sign-in shows who signed in** (Signed in as, Continue, Not you?) before the sheet closes.
- **Removed:** the "or" divider and `PolarisCopy.orDividerLabel`. Mac quiet links take the resolved
  accent, not the system link blue.
- **`ActivationResult` redacts its device token** in `description`, `debugDescription` and `dump`.
  `StoreError` and update refusals are `LocalizedError`s that say what to do (`-34018` names the
  missing keychain entitlement); an update-not-configured error no longer reads as licensing copy.
  `JSONValue` prints as JSON.
- **`client.update` names refused pins** (`invalid-options`) instead of reporting them missing, and
  `client.license.deactivate()` emits the `license` event like `client.deactivate()`.
- **The browser sheet** (`WebAuthenticationSignInBrowser`) takes its presentation anchor on the main
  actor when it opens, and `signInWithBrowser()` throws when the sheet cannot be shown.

Trust custody.

- **A bundle-activated install re-imports after upgrading.** The cache keeps the imported bundle
  itself (`bundle`) instead of an unsigned marker; the old marker is not read. The bundle is
  re-verified at every start and activates only while it carries the cached licence document.
- **A bundle past its 30-day import window needs a fresh mint to import,** but an imported one
  keeps activating on reload. An import must be strictly newer than the documents already held,
  and importing the same bytes again changes nothing.
- **Pin two keys.** A manifest signed by one pinned key can revoke another pinned key; the
  revocation is kept as the signed manifest and re-checked at every start. A manifest cannot
  revoke its own signer.
- **A refused default manifest is retried with `?signer=<kid>`** for each usable pinned key (at
  most `MAX_TRUST_SIGNER_ATTEMPTS`).
- **Manifest keys with a status other than `active`, `staged` or `retired` are skipped.**
- **Non-canonical base64url is refused** in signatures, headers, payloads and trust-set keys.

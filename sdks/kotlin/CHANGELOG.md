# Changelog

All notable changes to the Polaris Key Kotlin SDK. Versions follow the monorepo's lockstep `v*`
tags; before 1.0 a minor version may change the API, and a changed API ships as the only API (no
deprecated aliases).

## Unreleased

- **Synced-file primitives (U-23.K1).** `SyncCdc` (the `fastcdc-2016-nc1` chunker, streaming), `SyncChunks` (chunk ids and `pkey-sync-chunk/1` objects, both codecs; a codec 1 object needs the caller's `ZstdDecode`), `SyncZstdFrame` (the content size a frame declares, read before any decode) and `SyncManifest` (`pkey-sync-chunks/1`) in `:core`, proven by the `cdcCases`, `cdcEditCases`, `deltaCases`, `chunkCases` and `manifestCases` vector sections on the JCA and Tink runs.

- **Synced-file primitives II (U-23.K2).** `SyncFileStream` (`pkey-sync-file/1`: the header, segment sizes, the streaming `Sealer` and `Opener`, `sealFile` / `openFile`, the ranged `openRange` over a `Stored` reader that reads only the segments in range, and `Reassembly` for the manifest's size and SHA-256) and `SyncTransferPlan` (`single`, `multipart`, `chunks` and `too_large`, with `partRange`) in `:core`, proven by the `fileStreamCases` and `transferPlanCases` vector sections on the JCA and Tink passes. `:core` still links no zstd.

- **Host codec: record values (U-23.K3).** `HostCodec` seals and opens records with a scalar value (saves are `revision` records): `set` seals the value under its collection with `k = id`, `set` and `delete` send `blind("record", collection, id)`, and a pulled record, conflict copy or tombstone opens only when the `k` inside the envelope re-blinds to the id on the wire (`openPull(recordKeys = …)` maps a tombstone's blinded id back), so a Worker cannot place a sealed value under another record. A `merge` or `union` mutation is refused with `invalid-options` and a sealed `fields` or `elements` change reads as `invalid`. `:conformance`'s `SyncVectorsTest` runs the `envelopeCases` record rows on the JCA and Tink backends.

- **Cloud Sync settings (U-07).** `client.cloudSync` answers `status()`, `flush()` and `newRecoveryCode()` (plus `recoveryCode.generate()`, `statusFuture` and `flushFuture`), and `client.events` carries `PolarisEvent.CloudSync`. `config.set`, `clear` and `setting(k)` go through the sync machine while a person is signed in; `setting(k).sync()` answers `local`, `pending` or `synced` and `ConfigChange.origin` names where a change came from. `PolarisKeyClientOptions.cloudSync` carries the mode (default end-to-end), the compiled catalog and the renames; the Worker never sets them. Sign-out flushes (bounded) while the root is held, forgets the ring (a failure stops the sign-out), then purges; a person change never sends under the new token. The state file is `cloud-sync.json` in the store's state directory (`noBackupFilesDir` on Android), and `PolarisKeyLifecycle` flushes when the last activity stops. The parity manifest claims `sync.settings`, `config.sync` and `sync.scenarios`; `sync.e2e` stays planned.

- **`config.setting(key)` is the setting handle (U-07.K8).** It returns a `ConfigSetting` with `value`, `source`, `locked`, `visibility`, `set`, `clear`, `on` (a `ConfigSubscription`) and `flow: StateFlow<JsonElement?>`; the reads are the last resolution, kept current by every `set`, `clear` and new document. `setting(k)` no longer is the `StateFlow`; `rememberPolarisSetting` reads `.flow`. No aliases.
  Migrating: a `setting(k)` collector becomes `setting(k).flow`; `setting(k).value` is unchanged.
- **Cloud Connect (CC-12.16).** `client.cloudConnect` finds a person's other devices and opens an encrypted channel to them: `start()`, `stop()`, `peers`, `devices()`, `open(deviceId)` and `onChannel`, with Java forms on `PolarisKeyFutures`. It uses the relay (ticket, WebSocket, quotas, pacing) and, off Android, the LAN (bounded mDNS, TCP channels), over `pkey-peer/1` and Noise_XX_25519_AESGCM_SHA256 on JCA or Tink. A link whose pipe drops reports `connection_lost`; a peer's own CLOSE reports its code. The parity manifest now claims `connect.noise`, `connect.protocol`, `connect.relay` and `connect.app`. `connect.lan` stays planned (CC-12b): on Android LAN reports off with reason `unsupported` and the relay still works. `connect.links` and `connect.transfer` stay planned.

- **Automatic sign-in, rungs 1 to 4 (I-45).** `identity.autoSignIn(AutoSignInOptions)` answers an `AutoSignInResult` (`SignedIn`, `Confirm`, `Choose`, `NeedsSignIn`, `DeviceLimit`, `Unavailable`) and never throws. Rung 1 is the stored session; rungs 3 and 4 run a `PlatformIdentityProvider` (`installPlatformIdentity`) over a Worker nonce and `identity.exchange`; rung 4 needs `AutoSignInPrompt.OPTIONAL`. `:android`'s `PlatformSignIn(...).asProvider()` is the Google provider (Credential Manager, `play` flavor; `direct` answers unavailable). `signOut()` sets a persisted flag that stops rungs 3 and 4 until the person signs in again. `PolarisKeyGate` runs it at boot; `autoSignIn = false` opts out. The JVM desktop has no provider. `PolarisKeyFutures.autoSignIn` is the Java form.

- `identity.signIn.start(SignInOptions)` returns a `SignInSession` (`wait()`, `wait(once = true)`, `cancel()`, `reopen()`; `PolarisKeyFutures.signInStart` and `signInWait`); a refusal is a typed `SignInError`; the subject is stored on sign-in. `beginSignIn`, `pollSignIn` and `waitForSignIn` are removed.

- **`identity.attach(confirm)` (I-10b.16).** `IdentityClient.attach(confirm)` (and `PolarisKeyFutures.attach`) previews the device's licence (`false`, nothing written) or adds it to the signed-in account (`true`: the token is rotated and stored, `AttachResult.Ok(subject, attached)`). A Worker refusal (`account_required`, `license_owned`, `license_email_bound`, `unauthorized`, `not_found`) is `AttachResult.Refused(code, status)` and keeps the token; a product with no `attach` endpoint answers `Unavailable`.
- **The account on the device: `identity.subject()`, `signOut()` and `openAccount()` (I-10b.15).** Each uses only the endpoint discovery's identity fragment publishes (`ProductDiscoveryDocument.identity`) and answers `Unavailable` otherwise. `signOut()` runs the `onBeforeSignOut` hooks (Cloud Sync's flush registers there) before it signs out, forgets the stored subject, and drops the token only when the server releases the seat. `PolarisEvent.Identity(subject)` follows a subject change; `BootResult.subject` carries the stored subject; `PolarisKeyClientOptions.accountOpener` is how `openAccount()` opens the portal.
- **Getters take `get`, `startRefresh` starts the refresh, and `attestSupport` answers `Support` (SP-35b).** `PolarisKeyClient.syncState()` is `getSyncState()`, `startRefreshLoop()` is `startRefresh()`, and `LicenseClient.profile()`, `licenseId()` and `licenseUser()` are `getProfile()`, `getLicenseId()` and `getLicenseUser()`. `devices.attestUnavailable(): Unsupported?` is replaced by `devices.attestSupport(): Support` (`Support.Supported` or `Support.Unavailable(unsupported)`), the shape `supports(devices.attest)` answers. The top-level `licenseUser(doc)` is unchanged. No aliases.
  Migrating: `client.syncState()` becomes `client.getSyncState()`; `client.startRefreshLoop()` becomes `client.startRefresh()`; `license.profile()`, `licenseId()`, `licenseUser()` become `getProfile()`, `getLicenseId()`, `getLicenseUser()`; `devices.attestUnavailable()` becomes `devices.attestSupport()`, and `attestUnavailable() == null` becomes `attestSupport().isSupported` (the reason is `(attestSupport() as Support.Unavailable).unsupported`).
- **`licenseChanges` is removed; the licence stream is `events` (SP-35b).** `PolarisKeyClient.licenseChanges` (a `SharedFlow<LicenseState>`) is gone. `events: SharedFlow<PolarisEvent>` carries a `PolarisEvent.License(state)` on each licence transition, emitted only when the state changes. `:ui` and ui-core read `events`. No aliases.
  Migrating: `client.licenseChanges` becomes `client.events.filterIsInstance<PolarisEvent.License>().map { it.state }`; for the present value use `client.licenseState`.
- **Activation is `license.activateWithKey` (SP-35b).** `LicenseClient.activate(key)` is renamed `activateWithKey(key)`, the `PolarisKeyClient.activate(key)` facade is removed, and `PolarisKeyFutures.activate` is now `activateWithKey`. The kit's own `PolarisGateActions.activate` is unchanged. No aliases.
  Migrating: `client.activate(k)` and `client.license.activate(k)` become `client.license.activateWithKey(k)`; `futures.activate(k)` becomes `futures.activateWithKey(k)`.

- **Entitlement reads are the `entitlements` namespace (SP-35b).** `client.entitlements.has(name)`, `client.entitlements.value(name)` and `client.entitlements.all()` replace `license.isEntitled`, `license.entitlementValue` and `license.entitlements()`; `PolarisKeyFutures.isEntitled` is now `hasEntitlement`. `has` and `value` answer false/null while the gate is not usable; `all()` is the ungated read of the held document. No aliases. `PolarisServer.isEntitled` (`:server`) is unchanged.
  Migrating: `client.license.isEntitled(n)` becomes `client.entitlements.has(n)`; `license.entitlementValue(n)` becomes `entitlements.value(n)`; `license.entitlements()` becomes `entitlements.all()`; `futures.isEntitled(n)` becomes `futures.hasEntitlement(n)`.

- **Config reads are `get`, `getConfigSource` and `getSecret` (SP-35b).** `client.config.get(key, default)`, `client.config.getConfigSource(key)` and `client.config.getSecret(key)` replace `config(key, default)`, `configSource(key)` and `secret(key)`; the `PolarisKeyClient.config(key, default)` shortcut is removed, and `PolarisKeyFutures.config` is now `getConfig`. No aliases.
  Migrating: `client.config(k, d)` and `client.config.config(k, d)` become `client.config.get(k, d)`; `configSource(k)` becomes `getConfigSource(k)`; `secret(k)` becomes `getSecret(k)`; `futures.config(k, d)` becomes `futures.getConfig(k, d)`.

- **Kit screens match the shared states.** Version too new keeps Try again as its one action. The offline-activation screen is a numbered two-step form (send the request, then load the response) in every state but done, with the request QR where it fits, labelled for screen readers, and no product line; a rejected response adds its error, and done has a title and a Done button. An expired license offers Use another license, and Renew only when you pass `onRenew` to `PolarisGate` or `PolarisGateScreen`; it never offers Try again or Reconnect. The TV QR on the device-limit screen is labelled as the device management page. Compose draws the numbered steps and the request QR.
  Migrating: pass an https `offers.url` in the kit's offers input to get Buy in your browser on the paywall, and `onRenew` to get Renew.
- **Compose UI kit: the Polaris look is the default, and the spec's remaining parts are drawn**
  (`:ui`, UI-KITS.md §1.1, §1.4, §1.5, §4.1, §4.3, DL9). `PolarisTheme` now defaults to
  `PolarisBranding.PolarisKey`; the native preset (everything from your `MaterialTheme`) is the
  opt-in. **Migration:** to keep the previous look, pass `PolarisTheme(branding = PolarisBranding.None)`
  wherever you call `PolarisTheme` without a `branding`; nothing else changes. New: typed settings
  controls (a slider with its range and markers for a bounded number, a field otherwise, a select
  for an enum, a text field, each with Reset to default); device rows with a glyph per form factor
  and "<platform> · last used <when>" (`DeviceInfo` gained `platform` and `lastSeenAt`, carried from
  the roster's existing fields, no wire change); the styled `PolarisLicenseChoice`,
  `PolarisPaywall`, `PolarisReleaseNotes`, `PolarisEntitlementGate`, `PolarisCloudSyncStatus` and
  `PolarisAbout` (with `KitRowData` and `redactDiagnostics` in `:ui-core`); the gate places the
  "Signed in as <name> · <Tier> license" and "Copied" toasts (`PolarisToastSpec`,
  `PolarisToastHost`); the switch's light knob; predictive back from API 34 (the host sets
  `android:enableOnBackInvokedCallback="true"`); and on a TV the update prompt focuses Later and
  ignores input for 250 ms.

- **Device-code sign-in tells a refusal from a failure.** A poll answering `error` with `reason: "access_denied"` (a person pressed Deny, Not you? or Cancel) ends as `sign-in-denied`; a bare `error` (the sign-in failed after approval) now ends as `sign-in-failed`, and the sign-in handoff has a `failed` state. Migration: check `sign-in-failed` as well as `sign-in-denied`. Builds already shipped ignore `reason` and behave as before.
- **Compose UI kit follows UI-KITS.md** (`:ui`). Welcome keeps the key field behind "Use a license
  key" with Sign in the one primary and "by <Developer>" under the title (`PolarisTheme(developer =
…)` or the presentation's `developerName`); a paired secondary is tonal and the primary's width;
  resolvable refusals (revoked, expired, version, channel) are neutral callouts and a too-old version
  offers Update (`PolarisGate(onUpdate = …)`); the device-limit step is "Replace a device" with the
  count, the neutral seat meter and "Open in browser ↗"; Devices rename and remove inline (no stock
  dialog); the grace banner shows the days left and the deadline and dismisses for the session; the
  update banner has Later and no X, the update prompt is a bottom sheet below 560 dp and counts the
  download; Settings groups rows under "From <Developer>" and "Managed settings" with a switch for a
  boolean and "Reset to default"; no service accent on any product screen; `PolarisToast` (new); the
  generic `PolarisKitScreen` leaves out lines with an unfilled argument and heads every screen with
  the product. English defaults follow the catalog (`PolarisCopyCatalogTest`); `PolarisCopy` lost
  `graceBody`, `deviceRenameTitle`, `settingsLicense` and `settingsValues` and gained `useKey`,
  `byDeveloper`, `back`, `openInBrowser`, `deviceLimitBrowser`, `updateRestartWhenReady` and
  `updateDownloading`.

- **Client backend (`core.backend`, SP-59).** `client.backend.install(OkHttpClient.Builder())` sends
  `X-PKey-License` and `X-PKey-Device` to the app's own backend, only to `backendOrigins`. The
  network half checks every hop's origin before it is sent (OkHttp keeps custom headers across a
  redirect, so an application interceptor alone is not enough: `interceptor()` without
  `networkInterceptor()` sends no licence and throws `not-configured`). Pre-sync, one forced retry at
  least 10 s apart, typed `not_entitled` and `sign_in_required`; `headers()` is raw.

- **Spring Boot starter (`:spring-boot-starter`, SP-61).** `im.plrs.key:polaris-key-spring-boot-starter`
  has the Ktor plugin's shape on Spring Security 6: auto-configuration of a `PolarisServer` from
  `polaris-key.*` properties (a startup failure report names the property to fix), `http.polarisKey()`
  (a filter and an `AuthenticationProvider` for steps 1 to 5), per-route `AuthorizationManager`s
  `PolarisKey.license()/entitlement()/tier()/signIn()/all()` for step 6, an `AuthenticationEntryPoint`
  and `AccessDeniedHandler` that answer the localized problem body (only for requests a gate refused),
  `polaris-key.errors=throw` into `@ControllerAdvice`, `PolarisKeyRefusalHandler` and
  `HttpServletResponse.respondProblem` for a custom status, the CORS preflight pass, `private`
  Cache-Control on a granted response, and `PolarisKeyTestConfiguration` with MockMvc helpers over
  `PolarisTestKit`. It replays `backend-matrix.json`'s verdict rows through Spring Security.
- **Server drop-ins: the Node pass, in Kotlin** (`:server`, `:server-ktor`). Bad configuration fails at startup
  with the fix: `PolarisProduct` throws `IllegalArgumentException` for an empty slug or pin set, a pin that
  is not 43 base64url characters and a base URL that is not https (it used to fail silently inside the
  background refresh), naming `pkey sdk --lang kotlin --write`. A failed trust fetch reaches
  `debug` with its reason and "keeping the last verified keys and the pins" (a 404 says "check baseUrl and
  the product slug"). Tiers and valued entitlements: `Require.entitlement/tier/signIn` and, in Ktor,
  `requireTier(...) { }` and `requireAll(...) { }`. `call.requirePolarisLicense()` is the non-null
  license and throws on an ungated route. A CORS preflight passes every gate (`preflight =
PreflightMode.Gate` turns that off). Cache-Control `private` is set when the response is sent, so
  streamed responses keep it. `call.respondProblem(problem, status)` and `BackendProblem.refusal` for a
  custom refusal such as 402; the default statuses stay 401 and 403. `PolarisProduct`, `onRefusal` and the
  existing gates are unchanged. New in `im.plrs.key.server.testing`: `PolarisTestKit` (throwaway key, clock,
  `signedHeaders`, `headersFor(refusal)`, a fake trust service with `addKey`, `offline` and `calls`) and
  `useTestKit(kit)` for `polarisKey { }`.

- **Server drop-ins (`server.license`, `server.signin`, SP-57).** `im.plrs.key:polaris-key-server`
  (`:server`) decides a request to a product backend from the app's signed licence document,
  offline (WIRE-CONTRACT-V4 §14): `backendVerdict` (the six steps), `backendProblem` (the
  `application/problem+json` body, the `PKey-License` challenge and the eight copy locales, copied
  into the JAR from `conformance/parity`), and `PolarisServer` (the 900 s trust refresh, the
  unknown-`kid` fetch at most once a minute, the verified-document cache). It replays
  `backend-matrix.json` on the JCA and with Tink forced. `im.plrs.key:polaris-key-server-ktor`
  (`:server-ktor`) is the Ktor plugin: `polarisKey { }`, `requireLicense`, `requireEntitlement`,
  `requireSignIn`, `onRefusal` and `errors = ErrorMode.Throw`. Nothing logs the header, the JWS or
  the holder.
- **Product presentation** (`core.presentation`, HA-13): `ProductDiscoveryDocument.presentation`,
  `client.presentation()`, `client.presentationIcon(px, scale)` and `client.presentationSource`
  (`im.plrs.key.core.PresentationSource`); the icon verified by SHA-256 and cached by hash.
  `PolarisTheme(presentation = …)` defaults the logo to the verified icon and, branded, the accent
  to the product's. `PolarisRequest.followRedirects` (default true) lets a request see a 3xx.
- **`polaris-key-ui-core` (UK-09).** A Compose-free JVM artifact (`:ui-core`) holds the UI kit's
  state holders, so a desktop or headless integration runs them without Compose or AndroidX:
  `PolarisGateState`, `PolarisSignInState`, `PolarisDevicesState`, `PolarisBootState`,
  `PolarisPackProgressState`, `PolarisSettingsState` and `PolarisUpdateState` with their UI values
  moved there from `polaris-key-ui` (same package; `:ui` re-exports it with `api`). **Breaking:** a
  holder no longer produces user-facing text. `PolarisSettingsUi.error` and `PolarisUpdateUi.error`
  are typed (`PolarisSettingsFailure`, `PolarisUpdateFailure`) and each renderer maps them to catalog
  copy; `PolarisSettingsUi.failed` is `PolarisSettingsUi.loadFailure`; `PolarisSettingsActions.set`
  and `reset` have no default body; `PolarisUpdateState.install` and `follow` take no `PolarisCopy`.
  The presentation core runs `conformance/corpus/v2/ui-matrix.json`: `KitStates.resolve` answers the
  state, the catalog copy lines and the actions of every UI-KITS component,
  `KitIdentity` resolves the product identity and theme, and `KitCopy` formats the generated
  launch-locale catalog (`kit-copy.json`, from `packages/brand/kit-copy`).
- **State is scoped to its control plane** (`core.store`, SP-41). A client whose `baseUrl` is not
  `https://key.plrs.im` (a local `pkey dev` Worker, a staging Worker) keeps its token, device id,
  cache, installers and pack root under `<product>@<host>[_<port>]` (`storeNamespace`,
  `CoreContext.storageNamespace`), its keyring service as `pkey:<product>@<host>` and, on Android,
  its Keystore alias and store directory under the same name, so it never reads or overwrites
  production's; production names are unchanged. `PolarisKeyDesktop.dataDirectory`, `store`, `slots`
  and `bootGuard` take that control plane's `baseUrl` (default: production; `client` reads it from its
  options), so a payload staged for a local control plane is never applied by production's launch.
  **Breaking: an explicit `DesktopOptions.dataDirectory` is production's directory, and every other
  control plane nests `<dataDirectory>/<product>@<host>` beneath it.** A host that ran a local
  control plane out of its explicit directory starts fresh in the nested one (a new local token,
  device id and cache); nothing moves, and production's files stay where they are.

Hostile-input fixes.

- **A `blocked` hint outside the block vocabulary cannot unlock the gate.** The gate returns the
  hint's reason as the status, and `ok`, `grace` and `not-applicable` are usable. `BlockReason` is a
  closed enum of the three 403 reasons, so the gate cannot be handed another, and the two places that
  decode a reason from unsigned JSON already refuse a non-member: a 403 body reads as the first reason
  inside the vocabulary (the nested `error.reason`, then the top-level one), else
  `channel-not-entitled` for `channel_not_allowed` and `version-too-old`; a cache record whose
  `blocked.reason` is not a member loads without the hint and keeps the record. No behaviour changes:
  the five new `gate-matrix.json` rows and `BlockedHintVocabularyTest` now pin it.
- **A raised payload cap needs a `typ`.** `JwsVerifier.verify` already refuses a `maxPayloadBytes`
  above 65 536 when no `typ` is named, rather than downgrading the cap; the
  `bundle-payload-raised-cap-without-typ` vector (`callSiteOmitsTyp`) and the two new trust-kid
  vectors run in `:conformance`.

Key-custody and offline-bundle fixes (wire contract v4). Each **breaking** line names what to change.

- **Signed-in user (`license.signedinuser`).** `licenseUser(...)`, `LicenseClient.licenseUser()` and `DocProfile.user` read the pairwise subject from a verified licence document's `profile.user`; a malformed or absent member is null.

- **Pin two keys.** A verified manifest signed by one usable pinned key can revoke another pinned
  key; the revocation is permanent on that install, kept as the signed manifest in the cache's
  `pinRevocations` and re-verified on every load. A manifest that revokes its own signer is refused.
  A product that pins a single key cannot rotate it away.
- **Manifest key statuses outside `active`, `staged` and `retired` are skipped** (exact,
  case-sensitive); a key whose `publicKey` is not canonical base64url is skipped.
- **Non-canonical base64url is refused** in all three JWS segments and in every trust-set key.
- **A rotated product's trust refresh retries `?signer=<kid>`** for each usable pin (ascending kid
  order, at most `MAX_TRUST_SIGNER_ATTEMPTS`) when the default manifest is signed by a key the app
  does not pin.
- **Breaking: a bundle-activated install re-imports after upgrading.** The cache keeps the imported
  bundle's own signed JWS (`bundle`); the old `importedBundle` marker is not read. Activation is
  re-derived on every start from that bundle and the cached licence document.
- **Breaking: an offline bundle past its 30-day import window needs a fresh mint to import**; one
  already imported keeps activating. Each inner document must be newer than the cached one of its
  type, and a byte-identical re-import of the installed bundle succeeds without a write.
- **Breaking: `CoreContext.importBundle` / `PolarisKeyClient.importBundle` return
  `ImportBundleResult`** (the bundle id and the documents that landed); `BundleOptions` takes the
  per-type `floors` and the `profile`; `verifyTrustManifest` takes `tombstones`.
- A hard 401 or a 403 build block deletes the document it answered for, so `licenseInfo()` is null
  after a revocation.

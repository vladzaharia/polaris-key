> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# E2 - Android distribution and update surfaces for Polaris Key (Godot 4 game "Diceroll", gg.vlad.diceroll)

Research date: 2026-09-29. Web research only; no repo modified.

## 0. Method, confidence, and caveats

- Sources are Google/Android/F-Droid/Godot/Obtainium primary docs wherever possible (fetched in this session), with secondary
  press where the primary was unavailable. Page "last updated" dates are given when the page showed them.
- The WebSearch budget (200 calls) ran out near the end. Some items therefore stay "unverified"; they are listed in section 9.
- Many page reads were condensed by a small summarising model. Where a claim came from a source-code read (Obtainium,
  fdroidserver) or a dense doc, I flag it "(via summary)" - spot-check before building on it.
- Tags: (inference) = my reasoning, not stated by a source. (unverified) = from memory/experience, not confirmed here.
- Facts that change fast and are date-sensitive: Android developer verification, Play fees/external-offers programs,
  Play Billing Library minimums, target-API deadlines. Re-check them before committing dates in code or docs.

Key headline findings (details below):

1. Play can be automated almost end-to-end from a Worker (service-account JWT with WebCrypto, edits/tracks/rollout APIs),
   but there is NO review-status webhook, RTDN is billing-only, and the first release of a brand-new app still has to be
   bootstrapped by hand in Play Console.
2. Sideloading is NOT blocked on 2026-09-30 for direct downloads / F-Droid / Obtainium: Google's own FAQ (updated
   2026-07-15) says the 30 Sep 2026 enforcement applies only to listed "participating stores" in BR/ID/SG/TH; direct sideloads
   and other stores are affected in the global 2027 phase. You should still register `gg.vlad.diceroll` + every signing key.
3. Obtainium can track a stable Polaris Key URL as a "Direct APK Link", but version detection is disabled for that source
   (it pseudo-versions by partial-APK-hash or ETag). The best Polaris-Key-native Obtainium sources are an HTML page with
   version-bearing links, or (best) a self-hosted F-Droid-format repo, which Obtainium reads via index-v2.json.
4. F-Droid main repo is not a fit while the CC0 assets stay out of the public source; a self-hosted F-Droid repo is cheap
   and the format is fully documented (entry.jar signed with JAR/v1 scheme via apksigner, index-v2.json, diffs).
5. Post-install content: only data-only PCKs should be downloaded outside Play. Scripts/native/dex must ship in the AAB or
   arrive via Play itself (Play Asset Delivery). Godot 4 auto-creates only an install-time asset pack; fast-follow/on-demand
   need a custom Gradle + Kotlin plugin. Asset packs cannot update without an app update.
6. Paid content in the Play build must go through Play Billing except under the US/EEA/UK external-offer/alt-billing programs
   (fees apply); the license server should therefore act as a verifier/mirror of Play purchases in the Play channel.

---

## A. Google Play

### A1. Google Play Developer API (androidpublisher v3)

Base URL: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/...`
Scope: `https://www.googleapis.com/auth/androidpublisher`.

**Edits workflow** (docs: https://developers.google.com/android-publisher/edits)

1. `POST .../edits` (edits.insert) - a new edit starts as a copy of the app's current deployed state.
2. Upload artifacts: `edits.bundles.upload` (AAB). Media upload endpoint:
   `POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{pkg}/edits/{editId}/bundles`
   (docs recommend a 2 minute client timeout; `ackBundleInstallationWarning` is deprecated; `deviceTierConfigId` optional).
   https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload
3. Assign to a track: `edits.tracks.update` / `patch` with a Release.
4. Optional: `edits.listings` (store listing text per language), `edits.images`, `edits.deobfuscationfiles.upload`
   (Proguard maps or native debug symbols), `edits.testers` (Google Groups only - email lists are not supported by the API),
   `edits.validate`.
5. `POST .../edits/{editId}:commit`. Query params: `changesNotSentForReview` (hold changes out of review until you submit
   them in Console) and `changesInReviewBehavior` = `CANCEL_IN_REVIEW_AND_SUBMIT` or `ERROR_IF_IN_REVIEW` (returns 400 and
   keeps the edit). https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit

- Constraints (docs): one open edit per user; creating a new edit invalidates the previous one; Console changes or another
  user's commit invalidate all open edits; changes can take hours to propagate after commit. Edit expiry is not documented.

**Tracks** (https://developers.google.com/android-publisher/tracks, https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks)

- Track ids: `production`, `beta` (open testing), `alpha` (closed testing), an internal-testing track (the docs list `qa` in
  their form-factor examples - confirm the exact id via `edits.tracks.list`; tools such as fastlane use `internal`), custom
  closed tracks by name, and form-factor prefixed tracks (`wear:production`, `android_xr:qa`...).
- Release fields: `name`, `versionCodes[]` (must include codes to keep from previous releases), `status`, `userFraction`,
  `releaseNotes[]` (`{language: BCP-47, text}`), `countryTargeting` (`countries[]` CLDR codes + `includeRestOfWorld`; only
  allowed on `inProgress` releases in the production track), `inAppUpdatePriority` (0-5, default 0, cannot be changed after
  rollout).
- Status enum: `draft` (created via API, deploy later in Console; not served), `inProgress` (served to `userFraction`,
  0 < f < 1, only settable when `inProgress` or `halted`), `halted` (stops serving; users who already have it keep it),
  `completed` (100%). Halting a `completed` release rolls back to the previously completed release (via summary of the
  tracks page).
- Staged rollout via API: PATCH the production track with `{"releases":[{"versionCodes":["99"],"userFraction":0.05,
"status":"inProgress"}]}`, later raise `userFraction`, finish with `status: "completed"`; halt with `status: "halted"`,
  resume by setting `inProgress` again. Example payloads are on the tracks page.
- Reading state: `edits.tracks.list` / `edits.tracks.get` inside an edit. Because a fresh edit mirrors the live deployed state,
  create-list-delete an edit to read "what is live per track". There is NO documented endpoint or webhook for "in review /
  approved / rejected". (inference) Poll a fresh edit until your versionCode appears in the target track.
- Other useful endpoints: `internalappsharingartifacts.uploadbundle` (returns `downloadUrl`, `certificateFingerprint`,
  `sha256` - a natural fit for a `pr-N` preview channel for testers registered for internal app sharing)
  https://developers.google.com/android-publisher/api-ref/rest/v3/internalappsharingartifacts/uploadbundle ;
  `generatedapks` (list/download APKs generated from a bundle and signed with the app signing key)
  https://developers.google.com/android-publisher/api-ref/rest/v3/generatedapks.
- Bootstrapping: the first build for a new app must be uploaded manually in Play Console before tools like fastlane supply
  work; apps still in draft state are commonly limited to draft releases (secondary: fastlane docs
  https://docs.fastlane.tools/actions/supply/ ; (unverified) the draft-only rule is not in the official page I read).
- Account gates that affect automation: personal accounts created after 2023-11-13 must run a closed test with >=12 testers
  opted in for 14 continuous days before production access (secondary:
  https://www.testerscommunity.com/blog/google-play-closed-testing-requirements-2026 ); organization accounts are exempt.
  Play App Signing is required for AABs.

**Auth: service account + JWT, from a Worker**

- Play Console: create a service account in Google Cloud, invite its email under Users and permissions, grant release
  permissions; you no longer need to link the developer account to a Cloud project.
  https://developers.google.com/android-publisher/getting_started
- OAuth2 service account flow: JWT header `{"alg":"RS256","typ":"JWT"}`, claims `iss` (SA email), `scope`, `aud`
  = `https://oauth2.googleapis.com/token`, `iat`, `exp` (max 1 h after `iat`); POST to `https://oauth2.googleapis.com/token`
  with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT>`; access token typically valid 3600 s and
  reusable until expiry. https://developers.google.com/identity/protocols/oauth2/service-account
- Cloudflare Workers WebCrypto supports RSASSA-PKCS1-v1_5 sign/importKey with `pkcs8` keys, so a Worker can mint the JWT:
  strip PEM armor from `private_key`, base64-decode to DER, `crypto.subtle.importKey('pkcs8', der,
{name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign'])`, `sign`, base64url. Existing helpers: `workers-jwt`
  (has a GCP service-account helper), `jwt-subtle`. https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
  Cache the access token (KV/DO/Cache) for ~50 min. Keep the SA JSON as a Worker secret, scope the SA to release rights on
  this one app.
- Large uploads: Workers cap inbound request bodies by plan (100 MB Free/Pro, 200 MB Business, up to 5 GB Enterprise) and
  128 MB isolate memory; outbound `fetch` streaming from R2 avoids buffering, and HTTP wall time is not capped while the
  client is connected, CPU time is (30 s default, up to 5 min paid). https://developers.cloudflare.com/workers/platform/limits/
  (inference) Simplest and most robust: let CI (which already holds the AAB) do `bundles.upload` and the initial
  `tracks.update`, and let the Worker do the light control-plane work (promote, raise/halt rollout, read state).

**Quotas**: the current quota page (updated 2026-04-29) states 3,000 queries/minute per bucket, with "Publishing, Monetization,
and Reply to Reviews APIs" as one bucket; no daily quota is listed. https://developers.google.com/android-publisher/quotas

**Real-time developer notifications (RTDN)**: Cloud Pub/Sub topic, Play publishes as
`google-play-developer-notifications@system.gserviceaccount.com`. Notification types are purchase-related only:
SubscriptionNotification, OneTimeProductNotification (PURCHASED/CANCELED), VoidedPurchaseNotification,
PendingRefundReviewNotification, TestNotification. There are NO app publishing / review / release-status notifications.
https://developer.android.com/google/play/billing/rtdn-reference ,
https://developer.android.com/google/play/billing/getting-ready

- A Pub/Sub push subscription POSTs JSON `{message:{data(base64), messageId, ...}, subscription}` to an HTTPS endpoint and
  needs a 2xx (102/200/201/202/204) to ack; with authentication enabled Pub/Sub sends a Google-signed JWT in the
  Authorization header. https://docs.cloud.google.com/pubsub/docs/push A Worker can receive this directly (verify the OIDC JWT
  against Google's public certs, check `aud` and the push service account email; (unverified) exact claim list).
- Review status: no webhook found. Release health can instead be automated with the Play Developer Reporting API (crash
  rate, ANR rate...) https://developers.google.com/play/developer/reporting - e.g. auto-halt a rollout on regression
  (inference; metric-set names not verified).

### A2. In-app updates and checking for updates

**Play In-App Updates** (https://developer.android.com/guide/playcore/in-app-updates ,
https://developer.android.com/guide/playcore/in-app-updates/kotlin-java)

- Library `com.google.android.play:app-update:2.1.0` (+ `-ktx`). `AppUpdateManagerFactory.create(ctx).appUpdateInfo` ->
  `updateAvailability()`, `isUpdateTypeAllowed(FLEXIBLE|IMMEDIATE)`, `clientVersionStalenessDays()` (days since the update
  became available on the device's Play), `updatePriority()` (0-5, set per release via the Publishing API
  `inAppUpdatePriority`), `startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(type).build())`.
- FLEXIBLE = background download, app keeps running, you call `completeUpdate()` when `InstallStatus.DOWNLOADED`
  (register an `InstallStateUpdatedListener` for progress); IMMEDIATE = full-screen blocking flow handled by Play.
- Requirements: Play Store on device, app installed from Play, Android 5.0+ (API 21); NOT compatible with APK expansion
  (.obb) files; availability is per-device (staged rollout aware), so a server-known "latest" may not yet be installable.
- Test with internal app sharing.

**Godot 4**

- Plugin system v2: Gradle-built AAR + `GodotPlugin` subclass registered by
  `<meta-data android:name="org.godotengine.plugin.v2.<Name>" android:value="<class>"/>`; methods annotated `@UsedByGodot`;
  signals via `getPluginSignals()`/`emitSignal()`; GDScript gets it via `Engine.get_singleton("<Name>")`; needs Godot 4.2+
  and Gradle (custom) builds; packaged via `EditorExportPlugin`. https://docs.godotengine.org/en/stable/tutorials/platform/android/android_plugin.html
- Existing community plugins (small, single-maintainer): `dcryptoniun/Godot-Android-InAppUpdate` (MIT, Godot 4.5+, methods
  `checkUpdateAvailable/startFlexibleUpdate/startImmediateUpdate/completeFlexibleUpdate`, signals `update_info_received`
  (availability, versionCode, staleness, priority) / `update_status_changed` / `update_check_failed` / `update_flow_result`)
  https://github.com/dcryptoniun/Godot-Android-InAppUpdate ; `icecube092/GodotInAppUpdate` (MIT, Godot 4.6)
  https://github.com/icecube092/GodotInAppUpdate ; in-app review: `godot-mobile-plugins/godot-inapp-review`,
  `cengiz-pz/godot-android-inapp-review-plugin`, forum thread
  https://forum.godotengine.org/t/google-play-in-app-reviews-plugin-for-godot-4-2/39018 . Google's Godot page lists Play
  Asset Delivery, Play Games Services, Billing, Integrity, In-App Updates and In-App Reviews as supported services:
  https://developer.android.com/games/engines/godot/godot-export
- Godot 4.4+ also has `JavaClassWrapper` (reflection bridge, Android only, with `create_proxy()` /
  `create_sam_callback()`), and 4.7 adds GDScript implementing Java interfaces
  (https://docs.godotengine.org/en/stable/classes/class_javaclasswrapper.html , https://godotengine.org/releases/4.7/ ).
  That makes simple pure-GDScript Android calls possible, but Play Core's activity-result flow, BroadcastReceivers and
  manifest entries still argue for a Kotlin plugin (inference).

**Checking for a newer Play version without Play Core**: Google offers no public "latest version on Play" API. Options
(secondary: https://b4x.com/android/forum/threads/check-app-version.20586 ): (1) scrape the Play web page (brittle, against ToS
spirit); (2) your own backend that stores the latest version - the recommended approach. For Polaris Key: have CI / the Play
adapter record per-channel Play state (`versionCode`, `status`, `userFraction`, `inAppUpdatePriority`) and expose it on the
update-check feed with `minSupportedVersionCode`; in the game, if the installer is Play (`getInstallSourceInfo` /
`getInstallerPackageName` - (unverified) API detail), call Play In-App Updates; else use the Polaris Key feed to self-update
or link to the download page. Treat the server's "latest" as advisory because of staged rollouts.

### A3. Play Asset Delivery (PAD), Play Feature Delivery, and Godot 4

**PAD modes** (https://developer.android.com/guide/playcore/asset-delivery)

- install-time: delivered with the install as split APKs, available at launch, counts toward listed app size, needs about 2x
  pack size free disk during install; updated automatically with the base app.
- fast-follow: starts downloading right after install begins (user need not open the app), not part of listed app size.
- on-demand: requested while the app runs.
- Updates: only install-time packs update with the base app automatically; fast-follow/on-demand packs are patched as part of
  an app update (multi-step: patch downloaded, app updated, old packs invalidated, patch applied to internal storage).
  There is no way to update an asset pack independently of an app-bundle release (so no content hotfix without a new AAB).
- Size limits (https://support.google.com/googleplay/android-developer/answer/9859372, compressed download size): base module
  500 MB, each feature module 500 MB, each asset pack 1.5 GB, cumulative modules + install-time packs 4 GB, cumulative
  fast-follow + on-demand packs 30 GB, total 34 GB. Apps > 1 GB must have minSdk >= 21. PAD replaces OBB expansion files.
- Texture compression format (TCF) targeting: directory suffix `#tcf_astc`, `#tcf_etc2`, `#tcf_s3tc`... with suffix stripping
  enabled in the bundle config; a default (unsuffixed) directory is mandatory; download limits apply per format; ETC2 is the
  recommended default (>95% devices), ASTC >80%; S3TC/DXT1 is needed for Play Games on PC.
  https://developer.android.com/guide/app-bundle/asset-delivery/texture-compression
- Device targeting (beta per page): `#group_<name>` directory suffixes keyed on RAM, device model, system features or SoC;
  first matching group in the XML wins; you cannot prevent the default variant being delivered.
  https://developer.android.com/guide/playcore/asset-delivery/device-targeting
- Runtime API: `AssetPackManager.getInstance(ctx)` (`com.google.android.play:asset-delivery:2.3.0`), `getPackLocation(name)`
  (null if not ready; `assetsPath()`/`path()` are absolute filesystem paths for fast-follow/on-demand once COMPLETED),
  `fetch(names)`, `getPackStates`, `registerListener` (statuses PENDING, DOWNLOADING, TRANSFERRING, COMPLETED, FAILED,
  WAITING_FOR_WIFI, REQUIRES_USER_CONFIRMATION), `showConfirmationDialog` (large >200 MB cellular downloads),
  `requestRemovePack`, `cancel`. Install-time packs are read through `AssetManager`.
  https://developer.android.com/guide/playcore/asset-delivery/integrate-java
- Local testing: `bundletool build-apks --local-testing`; fast-follow behaves like on-demand when sideloaded; updates and
  network-error paths are not testable locally; use internal app sharing for realistic tests.
  https://developer.android.com/guide/playcore/asset-delivery/test

**Godot status**

- Godot exports an install-time asset pack automatically when the export format is AAB (PR godotengine/godot#52526, 3.x,
  Sept 2021; a forum report confirms Godot 4.2.2 shipped a 700 MB game this way in July 2024). The PR states it supports a
  "single install-time asset pack" and NOT dynamically downloaded packs.
  https://github.com/godotengine/godot/pull/52526 ,
  https://forum.godotengine.org/t/is-play-asset-delivery-supported-in-godot-4-2/55900
  Master's Android `build.gradle` still declares `assetPacks = [":assetPackInstallTime"]` (via summary of
  https://raw.githubusercontent.com/godotengine/godot/master/platform/android/java/app/build.gradle ).
- Fast-follow / on-demand: not supported by the engine. A community plugin exists (`Arivval/Godot-Play-Asset-Delivery`,
  Apache-2.0, 116 commits, 9 stars; README not readable in my fetch - Godot version and API unknown, likely 3.x era)
  https://github.com/Arivval/Godot-Play-Asset-Delivery . Treat as reference only.
- Play Feature Delivery (dynamic feature modules for code/native libs): no Godot support; Godot's runtime expects its native
  libs in the base module. Not recommended.
- Godot 4 caveats for loading packs: `ProjectSettings.load_resource_pack(path, replace_files)`; load early (autoload `_init`)
  or preloaded resources will not be overridden; issue #96298 (2024-08-29, closed "not planned") documents DirAccess not
  listing pack contents and inability to override preloaded resources. https://github.com/godotengine/godot/issues/96298 ,
  https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html
- Wrapper design (inference): a Kotlin v2 plugin "PolarisPlayAssets" that (1) adds an asset-pack Gradle module
  (`:assetPackFastFollow`, `com.android.asset-pack`, `deliveryType fast-follow`/`on-demand`) via the custom build template
  and an `EditorExportPlugin` that patches `settings.gradle`/`build.gradle`, (2) exposes `fetch(pack)`, `get_states()`,
  `get_pack_path(pack)` and signals `pack_state_changed(name, status, bytes_downloaded, total)`, and (3) GDScript calls
  `ProjectSettings.load_resource_pack(path + "/dlc_x.pck")` on COMPLETED. Absolute-path loading from `/data/...` should work
  through Godot's normal file access, but I did not verify that (unverified). Because PAD is Google Play delivery, even
  script-carrying packs stay inside the Play policy (see A4) - (inference, policy-sensitive; Play scans AABs and asset packs
  may not get the same scrutiny, so avoid `.so`/dex in packs).

### A4. Play policy

**Device and Network Abuse** (exact text, https://support.google.com/googleplay/android-developer/answer/9888379):

> "An app distributed via Google Play may not modify, replace, or update itself using any method other than Google Play's update mechanism. Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to code that runs in a virtual machine or an interpreter where either provides indirect access to Android APIs (such as JavaScript in a webview or browser). Apps or third-party code, like SDKs, with interpreted languages (JavaScript, Python, Lua, etc.) loaded at run time (for example, not packaged with the app) must not allow potential violations of Google Play policies."

Implications for the Play build of a Godot game:

- Self-update outside Play: prohibited. `REQUEST_INSTALL_PACKAGES` is restricted to apps whose core functionality is browsing,
  attachment-carrying communication, file management/sharing, enterprise device management, backup/restore, device migration;
  needs the Permissions Declaration Form; enforceable since 2022-07-11.
  https://support.google.com/googleplay/android-developer/answer/12085295 => a game must not carry the permission in the
  Play flavor. Ship a separate "direct/sideload" export preset with the permission and installer code.
- Downloaded data-only PCKs (scenes/resources referencing textures, meshes, audio, shaders): no executable code by Play's
  definition => the safe path. Verify SHA-256 / signature (Polaris Key signed manifest) before `load_resource_pack`.
- Downloaded PCKs containing GDScript: arguable under the interpreter exception (GDScript runs in Godot's VM), but (a) the
  last sentence makes you responsible for what runtime-loaded interpreted code can do, and (b) Godot 4.4+ `JavaClassWrapper`
  gives GDScript reflective access to arbitrary Java APIs, which undercuts the "indirect access" argument (inference). I
  found no documented Play enforcement case about Godot PCKs (searches inconclusive). Conservative rule: no downloaded
  scripts in the Play flavor; keep all logic in the AAB or deliver script-carrying content only through PAD.
- GDExtension `.so`, dex, AARs, JARs in any downloaded pack: prohibited on Play.
- Outside Play (sideload/F-Droid-style repo builds) none of this policy applies; the same signed-manifest verification is
  still advisable.

**Payments policy** (https://support.google.com/googleplay/android-developer/answer/10281818): Google Play Billing is
required for digital items (virtual currencies, extra lives, add-on items, characters), subscriptions, app functionality or
content (e.g. ad-free version, features not in the free version). Exceptions: physical goods/services, bills, peer-to-peer
tips with no digital content, 1:1 live services, gift cards/loyalty points. Regional programs listed on that page: India/South
Korea alternative billing (fee reduced 4 points), EEA external offers/alt billing under the DMA, US court-ordered programs.
Implication: paid DLC/packs unlocked from a license server in the Play build must be purchased via Play Billing; a
website-purchased license key redeemed in-app looks like steering to another payment method unless it falls under a program.

**2025-2026 changes** (dates from Google pages; secondary press in brackets - re-verify before quoting):

- US: after the Ninth Circuit upheld the Epic v. Google injunction (2025-09-12), Google's US policy page says it will not
  require Play Billing in apps on Play or prohibit other in-app payment methods or communicating about them; effective
  2025-10-29; external content links and alternative billing programs opened 2025-12-09; transaction reporting and fee
  payment for those programs are scheduled from 2026-10-01; a settlement with Epic was entered 2026-03-04 with revised terms
  pending court approval. https://support.google.com/googleplay/android-developer/answer/15582165
- Global: "Expanded billing choice and lower fees on Google Play" (2026-06-24): from 2026-06-30 (US, EEA, UK first) the
  service fee is separated from the billing fee: service fee 10% on the first $1M/yr (and 10% on auto-renewing subscriptions)
  regardless of billing route; a 5% billing fee applies only when using Play Billing (US/UK/EEA); alternative billing and
  external web links are allowed alongside Play Billing; new "Games Level Up" and "Apps Experience" programs available
  2026-09-30. https://android-developers.googleblog.com/2026/06/play-expanded-billing.html [secondary: rollout timeline to
  Australia Sept 2026, Japan/Korea Dec 2026, rest of world 2027 - https://www.coda.co/blog/epic-v-google-policy-update-2026/ ;
  fee tiers beyond $1M differ between secondary sources].
- EEA: external offers program updated 2025-08-19 under the DMA (link out for offers/app downloads, warning screen, fees
  reported at 5-17% by press). [secondary: https://appcharge.com/blog/external-payments-arrive-on-android-in-europe ]
- Play Billing Library (https://developer.android.com/google/play/billing/release-notes, via summary): 8.0.0 (2025-06-30)
  multiple purchase options/offers for one-time products, auto reconnection, removals of `querySkuDetailsAsync` etc.; 8.1.0
  (2025-11-06); 8.2.0 (2025-12-09) external content links/offers APIs; 8.3.0 (2025-12-23) external payments; 9.0.0
  (2026-05-19); 9.1.0 (2026-06-18) Billing Choice APIs. PBL 7 must be migrated by 2026-08-31 (extension to 2026-11-01).
- Target API: from 2026-08-31 new apps and updates must target Android 16 / API 36 (extension to 2026-11-01); existing apps
  must target API 35+ to stay visible to new users on newer OS versions.
  https://support.google.com/googleplay/android-developer/answer/11926878 Godot 4.7 (released 2026-06-24) defaults to target
  SDK 36. https://forum.godotengine.org/t/how-to-target-latest-android-sdk/142631
- 16 KB page size: the Android doc I fetched now says apps targeting Android 15+ must support 16 KB pages on 64-bit devices
  and updates are blocked from 2027-02-01 (this differs from earlier Nov-2025/May-2026 dates in my memory - verify).
  https://developer.android.com/guide/practices/page-sizes

### A5. Play Integrity API (brief)

- Verdicts: `appIntegrity.appRecognitionVerdict` (`PLAY_RECOGNIZED`, `UNRECOGNIZED_VERSION`, `UNEVALUATED`),
  `accountDetails.appLicensingVerdict` (`LICENSED`, `UNLICENSED`, `UNEVALUATED`), `deviceIntegrity.deviceRecognitionVerdict`
  (`MEETS_DEVICE_INTEGRITY`; opt-in `MEETS_BASIC_INTEGRITY`, `MEETS_STRONG_INTEGRITY`, `MEETS_VIRTUAL_INTEGRITY`), opt-in
  `environmentDetails` (`appAccessRiskVerdict`, `playProtectVerdict`), `recentDeviceActivity`, `deviceAttributes`,
  `deviceRecall` (beta). Non-Play installs get `UNRECOGNIZED_VERSION` / `UNLICENSED`.
  https://developer.android.com/google/play/integrity/verdicts , https://developer.android.com/google/play/integrity/overview
- Standard requests (~100-300 ms after a warm-up, bind with `requestHash`, recommended for frequent checks) vs classic
  requests (seconds, bind with server `nonce`, for rare high-value actions); do not cache verdicts.
- Setup: enable the API in a Cloud project, link it in Play Console (app must be on Play to link/raise quota); default quota
  10,000 token requests/day and 10,000 server decryptions/day (per app, shared by classic+standard); Google-managed decryption
  (server calls Google) or self-managed keys (decrypt locally). Kotlin lib `com.google.android.play:integrity:1.6.0`.
  https://developer.android.com/google/play/integrity/setup
- Godot: no maintained plugin found (a forum thread about crashes when hand-rolling one:
  https://godotengine.org/qa/129870/crashes-without-error-when-trying-implement-play-integrity ) - write a small Kotlin v2 plugin.
- Use for Polaris Key: mint device tokens only after an integrity check whose `requestHash` = SHA-256(server challenge ||
  device key thumbprint); store verdict summary + timestamp with the token. For sideload/F-Droid channels use a different
  attestation path (inference: Android Keystore key attestation with a server challenge, chain verified against Google roots;
  (unverified) not researched here) or accept lower assurance.

---

## B. Sideloading

### B1. Android developer verification (status at 2026-09-29)

Announced 2025-08-25; concessions Nov 2025 (limited-distribution accounts, "advanced flow"). Official pages:
https://developer.android.com/developer-verification , https://developer.android.com/developer-verification/guides ,
FAQ https://developer.android.com/developer-verification/guides/faq , blog
https://android-developers.googleblog.com/2026/06/android-developer-verification.html (2026-06-18).

- Timeline (Google): June 2026 system service rollout on most devices; July 2026 Developer ID Status API global + Console API
  and limited-distribution early access; August 2026 limited-distribution accounts, Android Developer Console API and the
  advanced flow global; **2026-09-30 regional enforcement in Brazil, Indonesia, Singapore, Thailand**; 2027+ global rollout on
  certified Android 7+ devices.
- What "enforcement" covers on 2026-09-30: the FAQ (updated 2026-07-15) says the deadline applies only to the specific
  participating stores (Google Play, HONOR App Market, OPPO App Market, Galaxy Store, Palm Store, V-Appstore, GetApps);
  other stores and direct sideloads "won't apply to your app yet"; users' install experience won't change in September;
  prepare for 2027. Press summaries that say "an unregistered app will not install through the normal path" (e.g.
  https://thehackernews.com/2026/06/google-sets-sept-30-deadline-for.html ) describe the eventual state / store-installs; trust
  the FAQ for the September scope. (Secondary, Wikipedia: third-party stores like F-Droid excluded from initial enforcement.)
- Registration steps (Full Distribution): sign up for an Android Developer Console (ADC) account, verify identity (individual
  or organization; organizations verify their website through Search Console), register package names by proving ownership
  with an APK signed by the private key; $25 fee (waived for Limited Distribution) (FAQ dated 2026-03-25). Play Console users
  can manage everything there; Play App Signing apps are claimed automatically; ADC supports multiple signing keys per
  package; losing the signing key means you cannot register the package.
- Account types: Full Distribution (any channel), Limited Distribution (students/hobbyists, up to 20 devices, no ID/fee),
  and "sideloading unregistered apps" (users only).
- Advanced flow for unverified apps: one-time setup with developer mode, restart, re-authentication and a mandatory 24-hour
  wait; ADB installs are unchanged and skip the wait. Unregistered apps can only be installed or updated with the advanced
  flow enabled or via ADB; otherwise updates fail (FAQ 2026-03-25).
- Automation: **Android Developer Console API** (REST; OAuth 2.0 web-server flow only with scope
  `https://www.googleapis.com/auth/androiddeveloperconsole` - service accounts, workload identity and API keys are not
  supported) with `CreateAndroidPackage`, `ListAndroidPackages`, `GetAndroidPackageRegistrationPolicy`,
  `CreateAndroidPackageKey`, `ListAndroidPackageKeys`, `VerifyAndroidPackageKeyOwnership` (returns a `verificationToken` to
  embed as `adi-registration.properties` in a signed APK), `JustifyAndroidPackageKeyRegistration`, `ListDeveloperAccounts`;
  states DRAFT/IN_REVIEW/REGISTERED etc.; quotas undocumented (via summary of
  https://developer.android.com/developer-verification/guides/developer-console-api ). The **Android Developer ID Status API**
  checks whether a package is registered. Both support OAuth delegation so third-party platforms (stores) can act for the
  developer. => Polaris Key can offer "register this product's package + keys with Android" using a stored user refresh
  token (a per-maintainer OAuth grant, not a service account) and can poll registration state.
- F-Droid: ~85% of its catalogue is built from source and signed with F-Droid's key; it calls the requirement existential and
  signed an open letter (2026-02-24, EFF/FSFE etc.) https://f-droid.org/2026/02/24/open-letter-opposing-developer-verification.html
  (via search result). On 2026-09-18 F-Droid described hosting upstream developer-signed packages alongside its own signed
  versions (examples: Conversations, Shattered Pixel Dungeon, Taler Wallet). F-Droid 2.0 (Kotlin/Compose rewrite) shipped
  2026-09-24. https://f-droid.org/en/news/ , https://pinggy.io/blog/f_droid_2_0_android_developer_verification/ (secondary).
- Impact on Diceroll: register `gg.vlad.diceroll` in ADC (or Play Console) with EVERY key that will sign a shipping APK
  (Play app signing key auto-claimed; your sideload/F-Droid-repo key must be added and proven). Self-hosted APK downloads and
  Obtainium are not blocked on 2026-09-30 but will be from 2027 for unregistered packages/keys.
- Signing-key strategy (inference): a Play App Signing key differs from the upload key, so a Play-installed app and a
  sideloaded APK signed with another key cannot update each other. If cross-channel upgrades matter, enrol your own long-lived
  key in Play App Signing (PEPK upload flow) and sign sideload/F-Droid-repo APKs with the same key; otherwise expect
  signature-mismatch errors. https://developer.android.com/studio/publish/app-signing

### B2. Self-updating a sideloaded APK

Platform facts:

- `PackageInstaller` session flow: `createSession(SessionParams(MODE_FULL_INSTALL))`, `openWrite` the APK, `commit(IntentSender)`;
  the result is delivered to a receiver: `STATUS_PENDING_USER_ACTION` carries an intent to launch for the confirmation UI.
- The app needs `REQUEST_INSTALL_PACKAGES` and the user must allow "install unknown apps" for it (so: not in the Play flavor).
- Android 12+ (API 31) `SessionParams.setRequireUserAction(USER_ACTION_NOT_REQUIRED)`: no confirmation if the installer opts
  in, declares `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, is the installer of record of the existing app or is updating itself,
  and the app being installed targets a recent enough API (29+ on Android 12, 30 on 13, 31 on 14, 33 on 15, 34 on 16). Where
  update-ownership enforcement is on, the installer must be the update owner. (Sources: https://www.xda-developers.com/android-12-alternative-app-stores-update-apps-background/
  and a search-result summary of the API docs for the target-API table; the Android 12 features page confirms the API exists
  https://developer.android.com/about/versions/12/features ; direct javadoc could not be fetched.) Obtainium's wiki adds that
  its silent installs need Android 12+ and a recent target API, and that failed background installs are not notified.
  https://wiki.obtainium.imranr.dev/app_tracking/
- Android 14 update ownership: `SessionParams.setRequestUpdateOwnership(true)` (normal permission `ENFORCE_UPDATE_OWNERSHIP`)
  claims responsibility for future updates at first install; any other installer, even with `INSTALL_PACKAGES`, then needs
  explicit user approval, and approving loses ownership. Ownership can only be established at initial install.
  https://developer.android.com/about/versions/14/features , https://source.android.com/docs/setup/create/app-ownership ,
  https://www.xda-developers.com/android-14-new-apis-app-stores/
- Android 14 also adds `requestUserPreapproval()` (approve before downloading) and `commitSessionAfterInstallConstraintsAreMet()`
  with `InstallConstraints` (update at less disruptive times) - useful for a game (only apply when not in a match).
- Self-update kills the process; treat it as "apply next launch / when backgrounded".

Godot: needs a Kotlin plugin (session I/O, receiver, `FileProvider`-free), plus manifest additions
(`REQUEST_INSTALL_PACKAGES`, `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, `ENFORCE_UPDATE_OWNERSHIP`, receiver) supplied by an
`EditorExportPlugin` only for the direct-download preset. Pure GDScript via `JavaClassWrapper` could make the calls but the
`IntentSender`/BroadcastReceiver piece is awkward without a Java class (inference).
Recommended flow (server + plugin): feed says `{versionCode, sha256, size, url, signerCertSha256, minSdk, priority}` ->
plugin downloads to app-private storage with Range/resume -> verifies SHA-256 and that the archive's signing cert equals the
installed cert (`getPackageArchiveInfo(..., GET_SIGNING_CERTIFICATES)`) and versionCode is higher -> session install.
If the app was installed by Obtainium or Play, self-update may prompt (installer/ownership rules above).

### B3. Obtainium

Sources: https://wiki.obtainium.imranr.dev/sources/ , https://github.com/ImranR98/Obtainium , https://wiki.obtainium.imranr.dev/deep_links/ ,
https://wiki.obtainium.imranr.dev/app_tracking/

- Source types: GitHub, GitLab, Forgejo/Codeberg (custom Forgejo hosts supported via overridden hosts), F-Droid, third-party
  F-Droid repos, IzzyOnDroid, SourceHut, APKPure, Aptoide, Uptodown, itch.io, Galaxy Store, SourceForge, Jenkins, APKMirror
  (track-only) and others, plus two fallbacks: **Direct APK Link** and **HTML** (any page with APK links).
- General per-app settings: track-only, version detection on/off, "Filter APKs by regular expression" (`apkFilterRegEx`,
  `invertAPKFilter` in code), automatic CPU-architecture filtering, custom name, exempt from background updates, skip
  notifications.
- GitHub source (via summary of `lib/app_sources/github.dart`): uses `api.github.com/repos/{owner}/{repo}/releases?per_page=100`;
  version = `tag_name` (or release title if `releaseTitleAsVersion`); asset URL = `browser_download_url`; settings
  `includePrereleases`, `fallbackToOlderReleases`, `filterReleaseTitlesByRegEx`, `filterReleaseNotesByRegEx`, `verifyLatestTag`,
  `sortMethodChoice`, `useLatestAssetDateAsReleaseDate`, `releaseTitleAsVersion`, `minUpdateAge`, personal access token to
  raise rate limits, `GHReqPrefix` proxy prefix. => A Polaris Key GitHub-Releases-backed product is already "Obtainium-native":
  stable = latest non-prerelease, beta = `includePrereleases:true`.
- Version detection rule: Obtainium compares the OS-reported version and the source version; both must conform to the same
  "standard" format (e.g. x.y.z) after stripping prefixes/suffixes such as `v` and `-beta`, otherwise version detection is
  disabled for that app; options "Use Version Code as OS Version" and "Release Date as Version".
- **Direct APK Link** (via summary of `direct_apk_link.dart`/`html.dart`): version detection is disabled; it pseudo-versions
  with `partialAPKHash` (default) or `ETag`; the package id is not known up front (a SHA-256-derived temporary id is used until
  the APK is fetched, (via summary)); custom request headers are supported through the HTML implementation.
- **HTML source**: custom APK link filter regex, sort/reverse, `versionExtractionRegEx` + `matchGroupToUse`,
  `versionExtractWholePage`, pseudo-versioning (partial APK hash / link hash / ETag), intermediate link filter.
- **F-Droid third-party repo source** (via summary of `fdroidrepo.dart`): needs repo URL + app id/name and the "F-Droid Third
  Party Repo" override; tries `index-v2.json` (also under `/repo/` and `/fdroid/repo/`) then falls back to `index.xml` (NOT
  index-v1.json); "Try selecting suggested version code" (default) uses `marketVersionCode` (v1/xml) or, for v2, filters out
  versions marked with non-stable `releaseChannels`; alternative "auto-select highest version code"; no signature
  verification in Obtainium itself (Android verifies the APK signature on install).
- Deep links (https://wiki.obtainium.imranr.dev/deep_links/): `obtainium://add/<url>` or `obtainium://add?url=<url>` (open Add
  App pre-filled), `obtainium://app/<url-encoded JSON>` (add one app with full config), `obtainium://apps/<url-encoded JSON
array>`, `obtainium://refresh[?id=<app id>]`. Fallback redirect for contexts where custom schemes are not clickable:
  `https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/<encoded json>`. Minimal config JSON:
  `{"id":"com.example.app","url":"https://github.com/example/app","author":"example","name":"Example App"}`; app-specific
  settings go in `additionalSettings`, a JSON string, e.g. `"additionalSettings":"{\"includePrereleases\":true}"` (from a
  crowdsourced example: `{"id":"dev.patrickgold.florisboard.beta","url":"https://github.com/florisboard/florisboard","author":"florisboard","name":"FlorisBoard Beta","additionalSettings":"{\"includePrereleases\":true}"}`).
  Badge: host `assets/graphics/badge_obtainium.png` yourself (~161x48). The key for choosing a non-default source
  (`overrideSource`) exists in the app JSON (unverified - export a real config from Obtainium to copy exact strings).
- AppVerifier ("Verified Apps"): recommended companion that verifies an APK's signing-certificate SHA-256 against the
  developer's published value; the README links https://github.com/privacyguides/verified-apps-android . Publish your signing
  cert SHA-256 (all keys) on the product page and in machine-readable form.

**Would `https://key.plrs.im/<product>/release/dl/latest/<name>-arm64.apk` work?** Yes as a Direct APK Link, with caveats:

- No semantic version detection: an "update" is any change to the partial-APK hash or ETag. Return a strong `ETag`
  (content SHA-256), `Content-Length`, `Accept-Ranges`, `Content-Type: application/vnd.android.package-archive`, and make the
  redirect chain (if any) short. Redirect-following behaviour was not verified.
- The installed app is still matched by package id from the APK; the user sees an update whenever bytes change.
- Better: (1) an HTML page (`/<product>/release/latest`) listing `<a href=".../diceroll-1.4.2-arm64.apk">` so
  `versionExtractionRegEx` yields real versions; or (2) the F-Droid-format repo (section C2) so Obtainium gets versionName/
  versionCode, arch-aware selection and beta filtering via `releaseChannels`; or (3) point Obtainium at the GitHub repo.
- Per-channel: each channel gets its own URL/page/repo (`.../stable/...`, `.../beta/...`); since Obtainium keys apps by
  package id, users pick ONE entry per device. Generate a distinct "Add to Obtainium" link per channel. `pr-N` channels
  are best left as manual/ADB installs.
- Gated/paid downloads: the HTML/direct sources allow custom request headers, so a token-bearing link is conceivable, but I
  did not verify the exact JSON key names.

---

## C. F-Droid

### C1. Main repo (f-droid.org)

- Policy (https://f-droid.org/docs/Inclusion_Policy/): everything must be FLOSS; F-Droid builds from publicly accessible
  source and verifies the binary matches; non-functional assets (art, fonts) may use less restrictive licenses but must
  allow redistribution and have valid licenses or be public domain; no proprietary tracking/ads/Google Play Services
  dependencies (offer a flavour); no third-party IP infringement; no downloading extra executable binaries without opt-in.
- Anti-Features (https://f-droid.org/docs/Anti-Features/): `NonFreeAssets` = "apps that contain and make use of Non-Free
  assets. The most common case is apps using artwork - images, sounds, music, etc."; also `NonFreeNet`, `NonFreeDep`,
  `NonFreeAdd`, `Tracking`, `KnownVuln`, `NoSourceSince`, `DisabledAlgorithm`. Anti-features label but do not exclude (except
  ads-only cases).
- Answer for Diceroll: CC0 is a public-domain dedication, so the assets are freely redistributable in principle and would not
  even need `NonFreeAssets`. The blocker is different: F-Droid must build from public source, so the 3D assets have to be in
  (or fetchable into) the public build inputs. If you keep them out of the public repo "by choice", the main repo cannot
  carry the full game. Options: publish a FOSS flavour with placeholder/procedural assets, or don't use main F-Droid.
  (inference from the policy text; the policy has no explicit "assets missing from source" clause.)
- Reproducible/developer-signed: `Binaries:` metadata points at your APK; F-Droid rebuilds, copies your signature with
  `apksigcopier` and publishes your signed APK only if the rebuild matches; `AllowedAPKSigningKeys` pins keys. Requires
  deterministic builds. https://f-droid.org/docs/Reproducible_Builds/ , https://f-droid.org/docs/Build_Metadata_Reference/
- Godot games: F-Droid builds the engine from source. Ball2Box (Godot 3.5.x/3.6, AGPL-3.0) is the documented recipe: fetch a
  Godot commit via `srclibs`, `scons` for armv7 + arm64v8 with LLVM, `gradle generateGodotTemplates` in
  `platform/android/java`, create editor settings/debug keystore, then `godot_server --export Android`; NDK r23c;
  auto-update from tags. https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata/com.simondalvai.ball2box.yml ,
  https://simondalvai.org/blog/godot-fdroid-publish/ (2023-04-22). I found no Godot 4.x game recipe in this session
  (unverified whether one exists).
- Lag: F-Droid's build cycle runs once a day and "it may take a few days" to reach the repo
  https://f-droid.org/docs/FAQ_-_App_Developers/ ; the client offers the `CurrentVersionCode` ("suggested version"); other
  versions appear only when "unstable updates" is enabled in the client.
- Recommendation: skip main F-Droid for Diceroll now; offer a self-hosted repo (C2). (IzzyOnDroid appears in Obtainium's
  source list; its inclusion rules were not researched.)

### C2. Self-hosted F-Droid-compatible repo

Formats (https://f-droid.org/en/docs/All_our_APIs/, code: https://gitlab.com/fdroid/fdroidserver/-/raw/master/fdroidserver/index.py ,
https://gitlab.com/fdroid/fdroidserver/-/raw/master/fdroidserver/signindex.py , MR
https://gitlab.com/fdroid/fdroidserver/-/merge_requests/1134 ):

- **Index v2** files under `<repo>/`: `entry.jar` (signed), `entry.json` (plain copy), `entry.json.asc` (GPG, used by f-droid.org),
  `index-v2.json`, `diff/<oldTimestamp>.json` (fdroidserver keeps the 10 newest diffs), `icons/`, APKs.
- `entry.json` fields: `timestamp`, `version`, `maxAge`, `index` `{name, sha256, size, numPackages}` and `diffs` keyed by the
  old repo timestamp with the same descriptor objects. Clients verify the entry signature, then fetch `index-v2.json` (or a
  diff when they hold an older timestamp) and check its SHA-256.
- `index-v2.json`: `repo` `{name, description, icon (localized), address, timestamp, mirrors, antiFeatures, categories,
releaseChannels}`; `packages.<applicationId>` = `{metadata:{name, summary, description, icon, categories, ...},
versions:{<sha256 of APK>:{added, file:{name, sha256, size}, manifest:{versionName, versionCode, usesSdk{min,target},
nativecode, features, signer{sha256[]}, usesPermission...}, antiFeatures, releaseChannels, whatsNew}}}`.
- **Signing**: `entry.jar` is a ZIP containing `entry.json`, signed with the JAR (v1) scheme by the repo key. fdroidserver
  creates the ZIP then runs `apksigner sign --min-sdk-version 23 --v1-signing-enabled true --v2-signing-enabled false
--v3-signing-enabled false --v4-signing-enabled false --ks <keystore> --ks-key-alias <repo_keyalias> entry.jar` with no
  explicit algorithm so apksigner picks SDK-23-compatible defaults (SHA-256 digests) (MR #1134). The legacy v1 index
  (`index-v1.jar` containing `index-v1.json`) and `index.jar` (old `index.xml`) are jarsigner-style signed JARs, historically
  SHA1withRSA for old-device compatibility ("verify the JAR signature, then extract index-v1.json" per the API doc). The repo
  key is typically RSA; the client pins its SHA-256 certificate fingerprint.
- **Without fdroidserver**: I found no maintained alternative generator (search inconclusive). The formats are documented and
  small; the only non-trivial piece is JAR signing. Options: (a) CI generates `index-v2.json` + `entry.json` in TypeScript,
  zips `entry.json`, signs with `apksigner` (JDK + build-tools) from a secret key - matches F-Droid's advice that repo keys
  should not live on a public server (https://f-droid.org/en/docs/Setup_an_F-Droid_App_Repo/ ); publish static files to R2 /
  Worker assets; (b) a Worker builds a JAR (STORE zip + `META-INF/MANIFEST.MF` + `.SF` + PKCS#7 `.RSA` block) using WebCrypto
  RSASSA-PKCS1-v1_5/SHA-256 - doable but hand-rolled CMS/DER; only worthwhile if the key may live in the Worker (inference).
  Recommended: (a), regenerated on each release event; the Worker only serves.
- **Repo URL + fingerprint**: `https://key.plrs.im/<product>/fdroid/repo?fingerprint=<SHA-256 of the repo signing cert>`;
  the client splits the fingerprint out of the query string when the URL is pasted/opened; the F-Droid client manifest
  registers the `fdroidrepos://` scheme and `fdroid.link` https links
  (https://gitlab.com/fdroid/fdroidclient/-/raw/master/app/src/main/AndroidManifest.xml , via summary), so offer
  `fdroidrepos://key.plrs.im/<product>/fdroid/repo?fingerprint=...` plus a QR of the same. Reported quirk: pasting
  `https://...?fingerprint=` links can duplicate the scheme (https://gitlab.com/fdroid/fdroidclient/-/issues/2523).
- **Clients**: F-Droid (2.0 shipped 2026-09-24 with auto-updates on by default), Neo Store (1.1.0 added Index-V2 and mirror
  support per APKMirror changelog; Droid-ify is a related but separate project - unverified detail), Obtainium (reads
  index-v2.json via "F-Droid Third Party Repo"). Client polling interval is not documented in what I read (unverified).
- **Per-channel**: index v2 has `releaseChannels` at repo and per-version level. F-Droid clients treat versions above the
  suggested version (`CurrentVersionCode`) as "unstable" (opt-in setting); Obtainium filters non-stable channel versions.
  Practical layout: one repo per channel (`/fdroid/stable/repo`, `/fdroid/beta/repo` where beta includes stable builds) so
  every client behaves predictably, and additionally tag beta versions with `releaseChannels: ["Beta"]`.
  Keep `versionCode` strictly monotonic across all channels and use one repo signing key per product (rotating it forces users
  to re-add the repo).
- APK versionCode: F-Droid convention for per-ABI APKs is to bake the ABI into low digits; if you ship one universal or
  arm64-only APK it does not matter (unverified convention).

---

## D. Per-surface summary (what a release/update server provides, automates; what the game needs; policy)

| Surface                                    | Server must PROVIDE                                                                                                                                                     | Server can AUTOMATE                                                                                                                                                                                                                                                    | Game/SDK side                                                                                                                                                                             | Policy limits on content packs / paid DLC                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Play production                            | Update-check feed with Play state (versionCode, rollout fraction, priority, minSupported); signed pack manifest; Play-purchase-verification endpoint; entitlement store | Service-account JWT; upload (CI) / promote / staged rollout raise / halt / resume; per-language notes; state polling; auto-halt via Reporting API; RTDN push endpoint (Pub/Sub JWT) -> refunds/voids; ack purchases <=3 days; Developer Console/ID Status registration | Kotlin v2 plugins: In-App Updates, Billing (godot-google-play-billing, Godot 4.2+), Integrity, optionally PAD, Play Games v2, In-App Review; GDScript wrapper; installer-source detection | Self-update forbidden; no downloaded dex/.so; downloaded scripts risky; digital content must use Play Billing (US/EEA/UK programs allow alt billing/external links with fees, reporting from 2026-10-01 for US programs) |
| Play testing tracks (internal/closed/open) | Same feed with per-track state; tester-group management                                                                                                                 | `tracks.update` on `internal`/`alpha`/`beta`/custom; `edits.testers` (Google Groups); internal app sharing links for `pr-N`                                                                                                                                            | Same as production; can mark build as "beta" via build/feature tag                                                                                                                        | Same as production; new personal accounts need 12 testers x 14 days before production                                                                                                                                    |
| Direct APK (Polaris gateway)               | Signed feed (versionCode, sha256, size, url, signer cert SHA-256, minSdk); APK hosting with ETag/Range; cert fingerprint page; `assetlinks.json`                        | Index GitHub Releases per channel; issue signed short-lived download URLs; register package + key with ADC                                                                                                                                                             | Direct-flavor Kotlin plugin: PackageInstaller sessions, update ownership, preapproval, gentle-update constraints; verify sha256 + signer                                                  | No Play restrictions; data or code packs allowed if signed and verified; you handle payments/licensing (own license server)                                                                                              |
| Obtainium                                  | Stable page/URLs; ideally HTML index or F-Droid-format repo; deep-link generator; cert fingerprints for AppVerifier                                                     | Generate `obtainium://app/...` configs per channel; keep ETag/hash stable                                                                                                                                                                                              | Nothing required (Obtainium installs); game may still self-update but ownership/installer rules apply                                                                                     | As direct APK; Obtainium's silent updates need Android 12+ and recent target API                                                                                                                                         |
| Self-hosted F-Droid repo                   | `entry.jar`, `entry.json`, `index-v2.json`, diffs, APKs, icons; repo fingerprint; deep link/QR                                                                          | CI regenerates + signs on each release; per-channel repos; publish `whatsNew` from release notes                                                                                                                                                                       | Same as direct APK (no F-Droid-specific code)                                                                                                                                             | As direct APK; no F-Droid inclusion rules apply to your own repo                                                                                                                                                         |
| F-Droid main                               | Public source + fdroiddata build recipe (Godot built from source)                                                                                                       | Tag-driven `UpdateCheckMode`/`AutoUpdateMode`; nothing in Polaris Key                                                                                                                                                                                                  | FOSS flavour without proprietary deps; no self-update code                                                                                                                                | Must be buildable from public source; NonFreeAssets etc. labelled; delay of days; not viable while assets stay private                                                                                                   |

---

## E. Deep dive (scope addition): "latest" Android/Play technology and how Polaris Key + Godot SDK should use it

E0. Godot baseline: Godot 4.7 (2026-06-24; 4.7.2 2026-08-18) defaults to target SDK 36; Android plugin v2 (AAR/Gradle, 4.2+);
`JavaClassWrapper` with proxies/SAM callbacks; standalone Android export "GABE"; AAB export needs the custom Gradle build.
https://godotengine.org/releases/4.7/ , https://docs.godotengine.org/en/stable/classes/class_javaclasswrapper.html

E1. **Play Asset Delivery in full** - see A3 for modes/limits/TCF/device targeting/updates. Additions:

- Server (Polaris Key) should: (1) record which pack names/versions are inside each AAB (a pack manifest emitted by CI: name,
  delivery type, size, sha256 of the PCK inside), (2) expose per-pack metadata to the game through the signed config so the
  game knows expected hashes, (3) for non-Play channels, host the same content as data-only PCKs (see below) so the game's
  content layer is channel-agnostic ("content source = play_pad | polaris_cdn").
- Godot SDK should: abstract `ContentPack.ensure(name)` -> `play_pad` backend (Kotlin plugin over `AssetPackManager`, handle
  REQUIRES_USER_CONFIRMATION/WAITING_FOR_WIFI, then `load_resource_pack` on the absolute path) or `polaris_cdn` backend (HTTPS
  download of a signed PCK into `user://`, verify, load). Store downloaded packs in `user://` (app data survives Android 15
  archiving; cache dirs do not).
- Because asset packs can't change without a new AAB, use PAD for the big, rarely changing base content (3D asset library) and
  Polaris-hosted data PCKs for hot content in non-Play channels; on Play only use PAD (or data-only downloads) to stay inside
  policy.
- Play Feature Delivery: not viable for Godot (see A3).

E2. **In-app updates with priority via the Publishing API** - set `inAppUpdatePriority` (0-5) on the release when Polaris Key
promotes a build (immutable after rollout). Server maps Polaris release metadata (`critical: true`, `minSupported`) ->
priority 4-5 (IMMEDIATE) vs 0-2 (FLEXIBLE); feed exposes the same to non-Play channels so the SDK applies one policy. Client:
`clientVersionStalenessDays` >= N triggers flexible flow. https://developer.android.com/guide/playcore/in-app-updates/kotlin-java

E3. **Play Integrity (standard vs classic)** - see A5. Server: challenge endpoint, decode call, verdict policy table per
product (enforce/log-only), token binding via `requestHash`; short device-token TTL. Client: Kotlin plugin, `prepare` on app
start (standard), classic only for license redemption/purchase-critical actions.

E4. **Play Billing Library 8/9 for paid packs + server verification + RTDN**

- Client: `godot-google-play-billing` (Godot 4.2+; `query_product_details`, `purchase`, `acknowledge_purchase`,
  `consume_purchase`) https://github.com/godotengine/godot-google-play-billing ; its bundled PBL version is not stated in the
  docs I read - PBL 8+ is required for new apps/updates from 2026-08-31 (release notes), so check the plugin's build.gradle
  and be ready to fork. One-time products in PBL 8 support multiple purchase options/offers and pre-orders.
- Server verification: send `purchaseToken` to Polaris Key; call `purchases.products:get` (one-time) /
  `purchases.subscriptionsv2:get`; use `purchaseToken` as the primary key; check `purchaseState == PURCHASED` (not PENDING);
  match `obfuscatedAccountId`/`obfuscatedProfileId` to the Polaris account; acknowledge server-side within 3 days
  (`purchases.products:acknowledge`) or Google auto-refunds; consume consumables via `purchases.products:consume`; revoke on
  refund with `orders:refund`; clawbacks via the Voided Purchases API. https://developer.android.com/google/play/billing/security
- RTDN: Pub/Sub topic + push subscription -> Worker endpoint (`/play/rtdn`), verify the OIDC JWT, base64-decode
  `message.data`, then ALWAYS call the Developer API for the authoritative state (RTDN only signals change). A Worker can host
  the push endpoint directly (no bridge needed), and can alternatively pull via REST. https://docs.cloud.google.com/pubsub/docs/push
- Entitlement model: Play purchase => Polaris entitlement (`source: play`, token hash, order id) => signed capability
  in the device token; refund/void => revoke + push a config update; same entitlement table serves direct-channel licenses.
- External offers/alternative billing (US/EEA/UK, 2026): PBL 8.2 (external content links/offers APIs), 8.3 (external payments:
  `enableBillingProgram`, `DeveloperBillingOptionParams`), 9.1 (Billing Choice APIs); fees and reporting duties apply (A4).
  If the product wants to sell packs on its own site while on Play, Polaris Key would need to create external transaction
  tokens and report transactions to Google (`createBillingProgramReportingDetailsAsync`) - a non-trivial feature; not
  recommended for v1 (inference).

E5. **Play Games Services v2 / Play Games on PC**

- Godot plugins: `godot-sdk-integrations/godot-play-game-services` (Godot 4.3+, PGS v21, achievements/leaderboards/snapshots),
  `Iakobs/godot-play-game-services` (Godot 4.2+, PGS v19 / "Play Games Services v2"). https://github.com/godot-sdk-integrations/godot-play-game-services
  Server-side auth codes (`requestServerSideAccess`) are the standard way to bind a PGS player to your backend
  (unverified for these plugins). Polaris Key can treat PGS player id as an optional identity provider.
- Play Games on PC: requires x86-64 build for full certification, GLES <=3.2 or Vulkan <=1.1, keyboard+mouse playability, no
  unsupported Google APIs, S3TC/DXT1 textures (TCF doc). https://developer.android.com/games/playgames/start (secondary
  snippet). No Godot-specific guidance found (unverified feasibility).

E6. **Credential Manager + passkeys for identity**

- Jetpack Credential Manager unifies passwords, passkeys, Sign in with Google (and digital credentials). Passkeys need the
  relying-party server to host `https://<rp-domain>/.well-known/assetlinks.json` with
  `delegate_permission/common.get_login_creds` listing the app's package and signing-cert SHA-256s: debug, release AND the Play
  app signing key. https://developer.android.com/identity/sign-in/credential-manager , https://developer.android.com/identity/sign-in/passkeys
- Godot: a community plugin exists for Google sign-in via Credential Manager (`NiqueWrld/GodotGoogleSignIn`, MIT, Godot 4.2+,
  returns an ID token) https://godotengine.org/asset-library/asset/4578 ; no passkey plugin found (unverified).
- Polaris Key should: serve `assetlinks.json` for `key.plrs.im` (or the RP domain) generated from registered package +
  cert fingerprints per product (same data needed for developer verification and AppVerifier); implement WebAuthn RP endpoints
  (Workers can do it) if passkey identity is wanted; verify Google ID tokens server-side.
- (inference) Also use the same `assetlinks.json` with `delegate_permission/common.handle_all_urls` for Android App Links
  from web download/redeem pages into the game.

E7. **Android 14/15/16 package-installer changes** - update ownership + preapproval + install constraints (B2). Android 15 app
archiving: apps published as AABs on Play can be archived (APK and cached files removed, user data preserved, launcher entry
kept); `PackageInstaller.requestArchive` needs `REQUEST_DELETE_PACKAGES`; unarchive is requested from the installer; Play
automatic archiving is a developer opt-in that adds an "archived APK" to the bundle output.
https://developer.android.com/about/versions/15/features , secondary https://androidauthority.com/android-15-app-archiving-3410645
Implications: keep license tokens/downloaded packs in `user://` not caches; treat unarchive as cold start with silent token
refresh; don't store install-time-only secrets in the APK; expect Play to re-download install-time asset packs on unarchive
(behaviour for fast-follow/on-demand packs not documented in what I read - unverified).

E8. **Baseline profiles** - improve ART-compiled Java/Kotlin start-up ~30% (needs AGP 8+, profileinstaller); Godot's hot paths
are native/GDScript, so gains apply mainly to the Godot Java activity and your plugins (inference, doc-based rationale).
Low priority. https://developer.android.com/topic/performance/baselineprofiles/overview

E9. **Developer verification rollout status** - B1. Polaris Key features: Developer Console API integration (OAuth), ID Status
polling, per-product "verification status" panel, key inventory (Play signing key, upload key, sideload key, repo key) with
SHA-256s.

E10. **2026 external offers / alternative billing** - A4/E4.

For each item, summary of server vs SDK responsibilities:

| Tech                                | Polaris Key server                                                                                                      | Godot SDK / plugin                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PAD                                 | pack manifest + hashes; content-source policy; mirror packs as data PCKs for non-Play                                   | Kotlin `AssetPackManager` wrapper; gradle asset-pack modules; `load_resource_pack`   |
| In-app updates + priority           | set `inAppUpdatePriority` on promote; expose min/critical in feed                                                       | Kotlin wrapper (or adopt dcryptoniun/icecube plugins); policy: flexible vs immediate |
| Play Integrity                      | challenge/decode/verdict policy, quota mgmt (10k/day), token binding                                                    | Kotlin wrapper (standard warm-up + classic)                                          |
| Billing 8/9                         | purchase verification, ack/consume, RTDN receiver, voids polling, entitlement mapping, external-offer reporting (later) | godot-google-play-billing (check PBL version) + GDScript entitlement client          |
| PGS v2                              | optional identity link via server auth code                                                                             | godot-play-game-services                                                             |
| Credential Manager/passkeys         | assetlinks.json, WebAuthn RP, ID-token verification                                                                     | Kotlin Credential Manager wrapper (existing Google sign-in plugin)                   |
| PackageInstaller / update ownership | signed APK feed with cert fingerprints                                                                                  | Kotlin installer plugin (direct flavor only)                                         |
| App archiving                       | none special; short-lived tokens re-issue                                                                               | keep state in `user://`, silent revalidate                                           |
| Baseline profiles                   | none                                                                                                                    | optional Gradle config                                                               |
| Developer verification              | ADC OAuth integration, status polling, key inventory                                                                    | none                                                                                 |

---

## F. Suggested Polaris Key shape (inference, for the design team)

1. Model an "Android target" per product with adapters: `play` (track + rollout controller), `direct` (gateway + signed feed),
   `fdroid-repo` (generated static repo), `obtainium` (link generator + HTML index). Channels map: stable -> Play production
   - direct stable + repo stable; beta -> Play open/closed track + direct beta + repo beta; pr-N -> internal app sharing (or
     direct APK only).
2. Canonical `versionCode` allocated by Polaris (monotonic across all channels/targets) and recorded per artifact with
   `signerCertSha256` and `sha256`.
3. Play adapter: Worker-minted SA token; CI does `bundles.upload`+`tracks.update(draft or inProgress)`; Worker cron reads
   state (fresh edit -> tracks.list) and drives rollout (0.05 -> 0.2 -> 0.5 -> 1.0), halting on Reporting API regressions;
   commit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`; manual bootstrap for the first release.
4. Sideload adapter: feed + gateway (ETag/Range), Obtainium link, F-Droid repo (CI-signed), `assetlinks.json`, cert
   fingerprints, ADC registration integration.
5. Content: signed manifest (Polaris JWS) listing packs {name, sha256, size, kind: data|pad, minVersion}; SDK enforces
   "no scripts/native from network on Play flavor".
6. Entitlements: Play purchase verification + RTDN; Polaris license for direct channel; single entitlement table.

## G. Open / unverified items (spot-check before building)

- Exact internal-testing track id in the Publishing API (`internal` vs `qa`) - confirm with `edits.tracks.list`.
- Draft-app limitation for first release (commonly reported; not in the docs I read); review-status API absence (no endpoint
  found; not exhaustively proven).
- Play Integrity decode endpoint path/scope and self-managed decryption details; Pub/Sub JWT claim checks.
- Direct APK Link ETag/partial-hash mechanics, redirect handling, `overrideSource` JSON strings, custom-header JSON keys.
- F-Droid client sync interval; Neo Store vs Droid-ify lineage; whether any Godot 4.x game recipe exists in fdroiddata.
- Godot: absolute-path `load_resource_pack` from PAD directories; Arivval plugin's Godot version/API; behaviour of fast-follow
  packs under Android 15 archiving; whether godot-google-play-billing already bundles PBL 8+/9.
- Play policy grey zone: downloaded GDScript-only PCKs (no documented enforcement case found).
- Date-sensitive: developer-verification scope on 2026-09-30, US program fee dates (2026-10-01), PBL/target-API/16 KB deadlines.

## H. Source list (grouped)

Play publishing/quota/auth: https://developers.google.com/android-publisher/edits ; /tracks ; /getting*started ; /quotas ;
/api-ref/rest/v3/edits.tracks ; /api-ref/rest/v3/edits/commit ; /api-ref/rest/v3/edits.bundles/upload ;
/api-ref/rest/v3/edits.tracks/get ; /api-ref/rest/v3/edits.testers ; /api-ref/rest/v3/internalappsharingartifacts/uploadbundle ;
/api-ref/rest/v3/generatedapks ; https://developers.google.com/identity/protocols/oauth2/service-account ;
https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ ; https://developers.cloudflare.com/workers/platform/limits/ ;
https://developers.google.com/play/developer/reporting ; https://developer.android.com/google/play/billing/rtdn-reference ;
https://developer.android.com/google/play/billing/getting-ready ; https://developer.android.com/google/play/billing/security ;
https://developer.android.com/google/play/billing/release-notes ; https://docs.cloud.google.com/pubsub/docs/push
In-app updates/PAD/Integrity: https://developer.android.com/guide/playcore/in-app-updates ; /in-app-updates/kotlin-java ;
/guide/playcore/asset-delivery ; /asset-delivery/integrate-java ; /asset-delivery/test ; /asset-delivery/device-targeting ;
https://developer.android.com/guide/app-bundle/asset-delivery/texture-compression ;
https://support.google.com/googleplay/android-developer/answer/9859372 ;
https://developer.android.com/google/play/integrity/overview ; /verdicts ; /setup
Policy: https://support.google.com/googleplay/android-developer/answer/9888379 ; /12085295 ; /10281818 ; /15582165 ; /11926878 ;
https://android-developers.googleblog.com/2026/06/play-expanded-billing.html ; https://www.coda.co/blog/epic-v-google-policy-update-2026/ ;
https://appcharge.com/blog/external-payments-arrive-on-android-in-europe
Godot: https://docs.godotengine.org/en/stable/tutorials/platform/android/android_plugin.html ;
https://docs.godotengine.org/en/stable/classes/class_javaclasswrapper.html ; https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html ;
https://docs.godotengine.org/en/stable/tutorials/platform/android/android_in_app_purchases.html ; https://godotengine.org/releases/4.7/ ;
https://developer.android.com/games/engines/godot/godot-export ; https://github.com/godotengine/godot/pull/52526 ;
https://forum.godotengine.org/t/is-play-asset-delivery-supported-in-godot-4-2/55900 ; https://github.com/godotengine/godot/issues/96298 ;
https://github.com/Arivval/Godot-Play-Asset-Delivery ; https://github.com/dcryptoniun/Godot-Android-InAppUpdate ;
https://github.com/icecube092/GodotInAppUpdate ; https://github.com/godotengine/godot-google-play-billing ;
https://github.com/godot-sdk-integrations/godot-play-game-services ; https://godotengine.org/asset-library/asset/4578
Developer verification/installer: https://developer.android.com/developer-verification ; /guides ; /guides/faq ;
/guides/developer-console-api ; https://android-developers.googleblog.com/2026/06/android-developer-verification.html ;
https://support.google.com/android-developer-console/answer/16561738 ; https://www.androidauthority.com/android-sideloading-changes-timeline-3679204/ ;
https://thehackernews.com/2026/06/google-sets-sept-30-deadline-for.html ; https://en.wikipedia.org/wiki/Keep_Android_Open ;
https://developer.android.com/about/versions/12/features ; /14/features ; /15/features ;
https://source.android.com/docs/setup/create/app-ownership ; https://www.xda-developers.com/android-12-alternative-app-stores-update-apps-background/ ;
https://www.xda-developers.com/android-14-new-apis-app-stores/ ; https://developer.android.com/studio/publish/app-signing ;
https://developer.android.com/identity/sign-in/credential-manager ; /passkeys ; https://developer.android.com/guide/practices/page-sizes ;
https://developer.android.com/topic/performance/baselineprofiles/overview
Obtainium: https://github.com/ImranR98/Obtainium ; https://wiki.obtainium.imranr.dev/ (sources, deep_links, app_tracking) ;
raw source: https://raw.githubusercontent.com/ImranR98/Obtainium/main/lib/app_sources/{github,html,direct_apk_link,fdroidrepo,codeberg}.dart
F-Droid: https://f-droid.org/docs/Inclusion_Policy/ ; /Anti-Features/ ; /Reproducible_Builds/ ; /Build_Metadata_Reference/ ;
/FAQ*-\_App_Developers/ ; https://f-droid.org/en/docs/All_our_APIs/ ; /Setup_an_F-Droid_App_Repo/ ; /Security_Model/ ;
https://gitlab.com/fdroid/fdroidserver/-/raw/master/fdroidserver/index.py ; /signindex.py ; MR 1134 ;
https://gitlab.com/fdroid/fdroidclient/-/raw/master/app/src/main/AndroidManifest.xml ; https://f-droid.org/en/news/ ;
https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata/com.simondalvai.ball2box.yml ; https://simondalvai.org/blog/godot-fdroid-publish/ ;
https://pinggy.io/blog/f_droid_2_0_android_developer_verification/

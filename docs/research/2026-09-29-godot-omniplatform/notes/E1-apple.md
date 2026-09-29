> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# E1 - Apple distribution and update surfaces: research report for Polaris Key

Research date: 2026-09-29. No repository was modified. Everything below was fetched during this session; where a claim rests on a secondary source, a forum post, or my own inference, it is labelled.

Confidence labels used throughout:

- [APPLE] read directly from Apple developer documentation or App Store Connect Help (Apple's docs JSON endpoints `developer.apple.com/tutorials/data/documentation/...json` were used because the HTML pages are JS-rendered).
- [VENDOR] read from the AltStore/SideStore/Sparkle/Godot project's own docs.
- [FORUM] Apple Developer Forums post or other community report (dated).
- [SECONDARY] news/blog/summary; treat as needing verification.
- [INFERENCE] my reasoning, not a documented fact.

Caveat on tooling: WebFetch summarised some pages through a small model. Anything quoted in double quotes below came from text I extracted myself (curl + parsing) unless marked otherwise. Web search budget was exhausted before the end of the task, so a few follow-ups (Japan/Brazil marketplace specifics, Godot extension-target support) are flagged as open.

---

## 0. Headline findings (read this first)

1. App Store Connect now has real webhooks (API 4.0, WWDC25). 12 event types, HMAC-SHA256 signed, up to 10 webhooks per app. Polaris Key can be event-driven for build upload, app-version state, external TestFlight state, TestFlight feedback, Apple-hosted asset-pack state and EU marketplace package events. There is NO webhook for phased-release state changes, review-submission state (other than the resulting app-version state) or internal TestFlight build state; poll those.
2. Apple-hosted Managed Background Assets (iOS/iPadOS/macOS/tvOS/visionOS 26+) is the first-class Apple path for game content packs: 200 GB and 200 packs per app included, uploaded and versioned independently of app builds through a documented App Store Connect API, testable in TestFlight, reviewed by App Review, with webhooks for every state. It only works for TestFlight and App Store installs (Apple-hosted). On-Demand Resources is deprecated at OS 27 ("Use Background Assets instead"). iOS 27 adds localized asset packs.
3. The `.pck` question: the guideline text (2.5.2) forbids downloading code that "introduces or changes features or functionality", and the license agreement (DPLA 3.3.1(B)) permits downloaded interpreted code only if it does not change the app's primary purpose, bypass security features, or create a storefront. Data-only packs are safe; scripts in downloaded packs are a documented gray area. Routing packs through Apple-hosted Background Assets means Apple reviews each pack version, which is the safest posture.
4. Paid packs on iOS must be In-App Purchase (3.1.1); license keys are explicitly banned as an unlock mechanism. Content acquired elsewhere (e.g. a Polaris license from a Mac direct purchase) may be honoured on iOS only if the same items are also purchasable via IAP in the iOS app (3.1.3(b)).
5. Sparkle: the server should NOT hold the EdDSA private key (Sparkle's own guidance). CI signs; Polaris renders/serves. Sparkle 2.9 "signed feeds" (SURequireSignedFeed) conflict with dynamically rendered appcasts unless CI pre-signs each rendered feed. No existing Godot-Sparkle integration was found.
6. AltStore source format (current, v2 with `versions[]`), SideStore compatibility quirk confirmed (SideStore issue #735, top-level `downloadURL`), and there is no documented authentication mechanism for private sources (only Patreon gating), so per-user secret URLs are the only option.
7. Alternative distribution is bigger than "EU only" now: alternative marketplaces exist in the EU, Japan (iOS 26.2+) and Brazil (iOS 26.5+) per the DPLA, AltStore PAL serves all three. The EU moves to unified terms on 2026-10-01 (DPLA update 2026-08-18): Core Technology Fee is replaced by a 5% Core Technology Commission; marketplace and Web Distribution eligibility broadens and no EU legal entity is needed.
8. First-party channel detection exists: MarketplaceKit `AppDistributor.current` (iOS 17.4+) returns `appStore`, `testFlight`, `marketplace(_:)`, `web` or `other`. That is the right primitive for the Godot iOS plugin; do not use the deprecated receipt-URL trick.

---

## A. iOS / iPadOS: App Store and TestFlight

### A1. App Store Connect API from a server (Cloudflare Worker)

Base URL: `https://api.appstoreconnect.apple.com/` (REST/JSON:API). API version history: 4.0 (WWDC25, webhooks), 4.1 (build uploads, more webhooks), 4.2, 4.3, 4.4, 4.5 (latest listed). [APPLE] https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-release-notes

#### Authentication (JWT)

Source: https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests [APPLE]

- Header: `alg: ES256` (mandatory), `kid` = the key ID of the .p8 you sign with, `typ: JWT`.
- Team key payload: `iss` = Issuer ID (UUID from Users and Access > Integrations), `iat`, `exp`, `aud: "appstoreconnect-v1"`, optional `scope` array (e.g. `["GET /v1/apps?filter[platform]=IOS"]`; query-param order is irrelevant; `limit`, `cursor`, `sort` are ignored when matching scope).
- Individual key payload: NO `iss`; instead `sub: "user"`; the rest is the same.
- Lifetime: `exp - iat` must be <= 20 minutes for almost everything. Exception: tokens with a scope containing only GET requests can live up to 6 months, but only for these resources: build-actions, build-runs, git-references, issues, macos-versions, products, providers, power-and-performance-metrics-and-logs, pull-requests, repositories, test-results, workflows, xcode-versions (i.e. Xcode Cloud / performance; NOT builds, apps, TestFlight, appStoreVersions). Apple suggests 2 minutes for one-off calls and reusing a token until expiry.
- Transport: `Authorization: Bearer <jwt>`.
- Team vs individual keys (https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api): team keys need an Admin to create, have a role (Admin, App Manager, Developer, ...), can access all apps. Individual keys inherit one user's access and "aren't able to use Provisioning endpoints, access sales-and-finance, or notaryTool". The private key can be downloaded only once. Use a team key for Polaris Key; give it the minimum role that covers TestFlight + App Store version management (App Manager) and use a separate Developer-role key for CI uploads if you want blast-radius isolation.
- Worker note [INFERENCE]: the .p8 is PKCS#8 EC P-256; WebCrypto `importKey('pkcs8', ..., {name:'ECDSA', namedCurve:'P-256'})` and `sign({name:'ECDSA', hash:'SHA-256'})` returns raw r||s (IEEE P1363), which is exactly the JWS ES256 signature form, so no DER conversion is needed.

#### Rate limits

Source: https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits [APPLE]

- Every response carries `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:500;` (example values; "Actual limits can vary").
- Limit applies per API key, over a rolling hour. Exceeding it returns HTTP 429 with error code `RATE_LIMIT_EXCEEDED`. Apple says to throttle polling and queue retries.
- Design implication: with webhooks doing the heavy lifting, poll budgets (3500/h/key at the documented example) are ample for a handful of apps; still read the header and back off.

#### What a server can do (resources and endpoints)

All [APPLE] from `developer.apple.com/documentation/appstoreconnectapi/...`.

| Need                                      | Resource / call                                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List builds and processing state          | `GET /v1/builds` (filter by app, version, preReleaseVersion)                                                                                                                      | `Build.attributes.processingState` in `PROCESSING, FAILED, INVALID, VALID`; also `version` (build number), `uploadedDate`, `expired`, `expirationDate`, `minOsVersion`, `usesNonExemptEncryption`, `buildAudienceType`.                                                                                                                  |
| Upload a build via API                    | `buildUploads` + `buildUploadFiles` (API 4.1)                                                                                                                                     | `BuildUploadState`: `AWAITING_UPLOAD, PROCESSING, FAILED, COMPLETE`. Xcode and Transporter remain alternatives. Webhook `BUILD_UPLOAD_STATE_UPDATED` fires when processing finishes.                                                                                                                                                     |
| TestFlight build state                    | `GET /v1/builds/{id}/buildBetaDetail`                                                                                                                                             | `internalBuildState` (PROCESSING, PROCESSING_EXCEPTION, MISSING_EXPORT_COMPLIANCE, READY_FOR_BETA_TESTING, IN_BETA_TESTING, EXPIRED, IN_EXPORT_COMPLIANCE_REVIEW) and `externalBuildState` (adds READY_FOR_BETA_SUBMISSION, WAITING_FOR_BETA_REVIEW, IN_BETA_REVIEW, BETA_REJECTED, BETA_APPROVED, NOT_APPLICABLE); `autoNotifyEnabled`. |
| Submit build for external beta review     | `POST /v1/betaAppReviewSubmissions`                                                                                                                                               | `BetaReviewState`: WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, APPROVED. Validates encryption declaration and beta review details.                                                                                                                                                                                                          |
| Beta groups                               | `betaGroups` (create/update/delete)                                                                                                                                               | Attributes: `isInternalGroup`, `name`, `publicLinkEnabled`, `publicLink`, `publicLinkId`, `publicLinkLimit`, `publicLinkLimitEnabled`, `feedbackEnabled`, `hasAccessToAllBuilds`, `iosBuildsAvailableForAppleSiliconMac`, `iosBuildsAvailableForAppleVision`. Public link stats: `GET /v1/betaGroups/{id}/metrics/publicLinkUsages`.     |
| Add build to a group                      | `POST /v1/betaGroups/{id}/relationships/builds` or `POST /v1/builds/{id}/relationships/betaGroups`                                                                                | Individual tester assignment also exists (`.../individualTesters`).                                                                                                                                                                                                                                                                      |
| Testers                                   | `betaTesters` create/delete, add/remove groups, builds, apps                                                                                                                      | Testers joining via public link "may not have an email address".                                                                                                                                                                                                                                                                         |
| "What to Test"                            | `betaBuildLocalizations` (`locale`, `whatsNew`)                                                                                                                                   | Per build, per locale. `POST /v1/buildBetaNotifications` manually notifies testers.                                                                                                                                                                                                                                                      |
| Store release notes / metadata            | `appStoreVersionLocalizations`                                                                                                                                                    | Attributes: `description, keywords, locale, marketingUrl, promotionalText, supportUrl, whatsNew`. Promotional text is editable any time; others only in editable states. Guideline 2.3.12 requires meaningful What's New text for significant changes.                                                                                   |
| App Store versions and states             | `appStoreVersions`                                                                                                                                                                | Attributes: `platform`, `appStoreState`, `appVersionState`, `versionString`, `releaseType` (`MANUAL, AFTER_APPROVAL, SCHEDULED`), `earliestReleaseDate`, `downloadable`, `reviewType` (`APP_STORE, NOTARIZATION`), `copyright`.                                                                                                          |
| Submit for App Review                     | `POST /v1/reviewSubmissions` then `POST /v1/reviewSubmissionItems` (add the appStoreVersion) then `PATCH /v1/reviewSubmissions/{id}` with `submitted: true` (or `canceled: true`) | `ReviewSubmission.state`: READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES, CANCELING, COMPLETING, COMPLETE. `platform` no longer required on create (4.1). The old `appStoreVersionSubmissions` create was REMOVED in 4.0.                                                                                            |
| Release a version held for manual release | `POST /v1/appStoreVersionReleaseRequests`                                                                                                                                         | For versions in `PENDING_DEVELOPER_RELEASE`.                                                                                                                                                                                                                                                                                             |
| Phased release                            | `POST /v1/appStoreVersionPhasedReleases` (enable; not available for an app's first version), `PATCH .../{id}` with `phasedReleaseState`, `DELETE` to cancel                       | `PhasedReleaseState`: `INACTIVE, ACTIVE, PAUSED, COMPLETE`. Read-only fields: `currentDayNumber`, `startDate`, `totalPauseDuration`. Pause = PATCH to PAUSED, resume = ACTIVE, release to everyone = COMPLETE.                                                                                                                           |

State enumerations [APPLE]:

- `AppStoreVersionState` (legacy names, still returned as `appStoreState`): ACCEPTED, DEVELOPER_REMOVED_FROM_SALE, DEVELOPER_REJECTED, IN_REVIEW, INVALID_BINARY, METADATA_REJECTED, PENDING_APPLE_RELEASE, PENDING_CONTRACT, PENDING_DEVELOPER_RELEASE, PREPARE_FOR_SUBMISSION, PREORDER_READY_FOR_SALE, PROCESSING_FOR_APP_STORE, READY_FOR_REVIEW, READY_FOR_SALE, REJECTED, REMOVED_FROM_SALE, WAITING_FOR_EXPORT_COMPLIANCE, WAITING_FOR_REVIEW, REPLACED_WITH_NEW_VERSION, NOT_APPLICABLE.
- `AppVersionState` (newer, returned as `appVersionState`, and used in webhooks): ACCEPTED, DEVELOPER_REJECTED, IN_REVIEW, INVALID_BINARY, METADATA_REJECTED, PENDING_APPLE_RELEASE, PENDING_DEVELOPER_RELEASE, PREPARE_FOR_SUBMISSION, PROCESSING_FOR_DISTRIBUTION, READY_FOR_DISTRIBUTION, READY_FOR_REVIEW, REJECTED, REPLACED_WITH_NEW_VERSION, WAITING_FOR_EXPORT_COMPLIANCE, WAITING_FOR_REVIEW. Note `READY_FOR_SALE` (legacy) corresponds to `READY_FOR_DISTRIBUTION` (new); Polaris should map both.

Phased release behaviour (App Store Connect Help, https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases, via search result summary [APPLE/SECONDARY]): 7-day schedule 1%, 2%, 5%, 10%, 20%, 50%, 100% of users with automatic updates on; can be paused up to 30 days with no limit on the number of pauses; anyone can still manually download a phased-release version from the App Store at any time. Apple's PhasedReleaseState doc adds: applies to macOS and iOS devices with automatic updates enabled.

#### Webhooks (yes, they exist)

Sources: https://developer.apple.com/documentation/appstoreconnectapi/webhook-notifications, .../configuring-webhook-notifications, .../webhook-events, .../webhookeventtype, App Store Connect Help "Manage webhooks", API release notes 4.0/4.1/4.2. [APPLE]

- Announced WWDC25 (session 324 "Automate your development process with the App Store Connect API"); shipped in API 4.0. 4.1 added build-upload and build-beta-detail events and three background-asset events; 4.2 added alternative-distribution events.
- Configure: UI (Users and Access > Integrations > Webhooks) or API `POST /v1/webhooks` with `{enabled, eventTypes[], name, secret, url}` and relationship `app`. `PATCH /v1/webhooks/{id}` updates enabled/name/url/secret/eventTypes; you cannot change the app. Limits: one app per webhook, up to 10 webhooks per app. Roles: Account Holder, Admin, App Manager.
- Test: `POST /v1/webhookPings`. History: `GET /v1/webhooks/{id}/deliveries` (states incl. SUCCEEDED; fields createdDate, sentDate, request.url, response.httpStatusCode/body, `redelivery`); re-send: `POST /v1/webhookDeliveries`. UI shows only the last 20 deliveries over the last week; a delivery can be resent once (the resent record can be resent again).
- Signature: header `x-apple-signature: hmacsha256=<hex>` where hex = HMAC-SHA256(secret, raw request body). Verify with a constant-time compare on the exact raw bytes (Worker: read `request.arrayBuffer()` before parsing JSON).
- Payload envelope: `{"data":{"type":"<camelCaseEvent>","id":"<uuid>","version":1,"attributes":{...,"timestamp":"..."},"relationships":{"instance":{"data":{"type":"appStoreVersions","id":"..."}}}}}`. Payloads are deliberately thin: fetch the resource by id afterwards. Background-asset and marketplace events differ slightly (background-asset events put `type/id/links` directly under `relationships.instance` with no `data` wrapper).

Event types (`WebhookEventType`, exactly 12):

1. `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED` (attrs `newValue`, `oldValue` as AppVersionState, `timestamp`; instance = appStoreVersions id)
2. `BUILD_UPLOAD_STATE_UPDATED` (attr `newState` e.g. COMPLETE; instance = buildUploads id)
3. `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED` (`newExternalBuildState`, `oldExternalBuildState`; instance = buildBetaDetails id)
4. `BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED`
5. `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED`
6. `BACKGROUND_ASSET_VERSION_STATE_UPDATED` (PROCESSING -> FAILED on import-validation failure; email also sent)
7. `BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED` (import validation succeeded)
8. `BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED` (e.g. IN_REVIEW -> REJECTED, PROCESSING_FOR_TESTING -> READY_FOR_TESTING)
9. `BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED` (e.g. -> REJECTED, PROCESSING_FOR_DISTRIBUTION -> READY_FOR_DISTRIBUTION)
10. `ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED` (marketplace apps)
11. `ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED`
12. `ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED`

Gaps (no event exists): phased-release state/day changes; review-submission state; internal TestFlight build state; build `processingState` transitions other than via BUILD_UPLOAD_STATE_UPDATED; beta-review state for an individual build other than the external-build-state event; IAP/subscription events (those come from App Store Server Notifications V2, see section F). Poll those, reading `X-Rate-Limit`.

Design [INFERENCE]: one Worker route per app (`/hooks/asc/:app`), verify HMAC, dedupe on `data.id`, store the raw event in D1/Queue, then fetch the resource with the ASC API and update the release/channel state. Treat the webhook as a hint and the API GET as truth, since payloads are thin and delivery is at-least-once with manual redelivery.

### A2. "Is a newer version on the App Store?" and TestFlight updates

iTunes Search/Lookup API

- Official docs (archived, 2017-09-19 revision): lookups documented by `id`, `amgArtistId`, `upc`, `isbn`, etc. `bundleId` is NOT in the official Lookup Examples page; `?bundleId=...&country=xx` works in practice but is undocumented. [APPLE] https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html
- Rate/caching guidance in the same docs: "The Search API is limited to approximately 20 calls per minute (subject to change)... Large websites should set up caching logic for the search and lookup requests." Country param: two-letter code, default US. [APPLE] https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html
- Lag/staleness: Apple Developer Forums report the lookup returning the old version after release: Feb 2025 (3+ hours after release, no reply) https://developer.apple.com/forums/thread/775313; Mar 2023 (inconsistent, caching per device/edge, `.reloadRevalidatingCacheData` "sometimes" helps) https://developer.apple.com/forums/thread/725780; and another thread on wrong version / JSON errors https://developer.apple.com/forums/thread/760977. Community consensus (search-result summary) is "up to ~24 hours", varying by storefront/CDN node. [FORUM/SECONDARY]. No Apple statement guarantees freshness.
- Official alternative: I found none. StoreKit has no "is there a newer version" API. The recommended pattern is your own version endpoint. [INFERENCE from absence]
- Interaction with phased release [INFERENCE from Apple's phased-release docs]: during a phased release the new version is visible on the product page and downloadable manually by anyone while only a percentage of auto-updates go out. A lookup-based "update available" prompt would therefore pull users ahead of Apple's phase. Polaris' own `/version` JSON (with a `minimum`, `recommended` and `latest` per channel) should be authoritative, driven by the ASC webhook (`READY_FOR_DISTRIBUTION`) and phased-release polling.

TestFlight

- The TestFlight app installs and updates builds; testers can accept updates automatically; a build "becomes unavailable for testers after 90 days"; external groups up to 10,000 testers, internal up to 100 ASC users; first build in an external group needs beta review; public links can be limited by criteria. TestFlight is also available for macOS. [APPLE] https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- Guideline 2.2: TestFlight builds "cannot be distributed to testers in exchange for compensation of any kind"; "Significant updates to your beta build should be submitted to TestFlight App Review before being distributed". So a paid "beta channel" is not allowed on TestFlight. [APPLE] guidelines, last updated June 8, 2026.

Detecting the install source in-app (for the Godot iOS plugin)

- Best first-party option: MarketplaceKit `AppDistributor.current` (async throws), iOS/iPadOS 17.4+. Cases: `appStore`, `testFlight`, `marketplace(_ bundleID: String)`, `web`, `other` (enterprise/education programs). Apple: "check the current source at each launch — not just at the first launch". [APPLE] https://developer.apple.com/documentation/marketplacekit/appdistributor . Apple's own doc for this enum tells alternative-marketplace apps to use BackgroundAssets for large downloads and to avoid StoreKit IAP, Game Center etc. Behaviour for development/sideloaded (re-signed) installs is not documented; expect `other` or an error [INFERENCE].
- StoreKit 2 `AppTransaction.shared`: `environment` is `.production`, `.sandbox` or `.xcode`. [APPLE] https://developer.apple.com/documentation/storekit/appstore/environment . Community reports that TestFlight builds return `.sandbox` (and `originalAppVersion` "1.0"): May 2023 thread https://developer.apple.com/forums/thread/729695 [FORUM; unanswered]. Apple's doc confirms "In the sandbox testing environment, the originalAppVersion value is always `1.0`".
- Legacy: `Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"` is true for both TestFlight and debug builds; and it is now deprecated (iOS 18 deprecation of `bundleReceiptURL`-style access; the July 2025 forum post https://developer.apple.com/forums/thread/791170 notes AppTransaction does not fully replace it) [FORUM]. Older thread https://developer.apple.com/forums/thread/704156.
- Extra heuristics [INFERENCE / community, not verified here]: App Store and TestFlight installs have no `embedded.mobileprovision`; development, ad hoc and AltStore/SideStore installs do; AltStore rewrites the bundle identifier on install (append of team-id suffix) so the running bundle id may differ from `gg.vlad.diceroll`.

### A3. App Review Guidelines relevant to downloaded content (text of June 8, 2026 revision)

Source: https://developer.apple.com/app-store/review/guidelines/ ("Last Updated: June 8, 2026"). Exact text copied from the page. [APPLE]

2.5.2: "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps. Educational apps designed to teach, develop, or allow students to test executable code may, in limited circumstances, download code provided that such code is not used for other purposes. Such apps must make the source code provided by the app completely viewable and editable by the user."

4.2.3: "(i) Your app should work on its own without requiring installation of another app to function. (ii) If your app needs to download additional resources in order to function on initial launch, disclose the size of the download and prompt users before doing so."

4.7 (title "Mini apps, mini games, streaming games, chatbots, plug-ins, and game emulators"): "Apps may offer certain software that is not embedded in the binary, specifically HTML5 and JavaScript mini apps and mini games, streaming games, chatbots, and plug-ins. Additionally, retro game console and PC emulator apps can offer to download games. You are responsible for all such software offered in your app, including ensuring that such software complies with these Guidelines and all applicable laws..." Sub-rules 4.7.1 to 4.7.5 (privacy, content filtering/reporting/blocking, must follow 3.1 for digital goods; no exposing native APIs to the software without permission; no sharing data/permissions without consent; an index of software with universal links; age-rating gating). 4.7 is for third-party "software offered in your app" (mini games) and is not the route for a game shipping its own first-party content packs. Do not classify Diceroll's own DLC as a 4.7 "mini game" store.

3.1.1 (In-App Purchase): "If you want to unlock features or functionality within your app, (by way of example: subscriptions, in-game currencies, game levels, access to premium content, or unlocking a full version), you must use in-app purchase. Apps may not use their own mechanisms to unlock content or functionality, such as license keys, augmented reality markers, QR codes, cryptocurrencies and cryptocurrency wallets, etc." Also: "Apps distributed via the Mac App Store may host plug-ins or extensions that are enabled with mechanisms other than the App Store."

3.1.1(a): "Developers may apply for entitlements to provide a link in their app to a website the developer owns or maintains responsibility for in order to purchase digital content or services. These entitlements are not required for developers to include buttons, external links, or other calls to action in their United States storefront apps." (Outside the US and the entitlement regions, no calls to action to other purchase methods.)

3.1.3(b) Multiplatform Services: "Apps that operate across multiple platforms may allow users to access content, subscriptions, or features they have acquired in your app on other platforms or your web site, including consumable items in multi-platform games, provided those items are also available as in-app purchases within the app." This is the clause that governs a Polaris license entitlement (bought on Mac direct/web) unlocking a pack on iOS: allowed only if the same item is also an IAP on iOS.

2.3.1(a): "Don't include any hidden, dormant, or undocumented features in your app... All new features, functionality, and product changes must be described with specificity in the Notes for Review." (Relevant to any pack that flips features remotely.)

2.4.5 (Mac App Store) [APPLE]: "(iv) They may not download or install standalone apps, kexts, additional code, or resources to add functionality or significantly change the app from what we see during the review process." "(vi) They may not present a license screen at launch, require license keys, or implement their own copy protection." "(vii) They must use the Mac App Store to distribute updates; other update mechanisms are not allowed." (This is why Sparkle and Polaris license keys cannot ship in the Mac App Store build.)

4.8: a third-party/social login requires an equivalent privacy-preserving login option, but "Another login service is not required if: Your app exclusively uses your company's own account setup and sign-in systems." 5.1.1(v): "If your app supports account creation, you must also offer account deletion within the app."

Developer Program License Agreement 3.3.1(B) "Executable Code" (page fetched 2026-09-29): "Except as set forth in the next paragraph, an Application may not download or install executable code. Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application by providing features or functionality that are inconsistent with the intended and advertised purpose of the Application (b) does not bypass signing, sandbox, or other security features of the OS; and (c) for Applications distributed on the App Store, does not create a store or storefront for other Applications." [APPLE] https://developer.apple.com/support/terms/apple-developer-program-license-agreement/

Notarization Review Guidelines (alternative distribution; a subset of App Review) list under Security: "They cannot download executable code, read outside of the container, or direct users to lower the security on their system or device." [APPLE] https://developer.apple.com/support/dma-and-apps-in-the-european-union/

Analysis for Godot packs [INFERENCE grounded in the above]:

- Data-only `.pck` (textures, audio, levels expressed as scenes/resources, JSON) is not "code". Godot scenes/resources can embed scripts, and a `.pck` can contain `.gd` files (Godot docs: "PCK files can contain scripts"). https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html
- GDScript is interpreted code. DPLA 3.3.1(B) allows it if it stays within the app's advertised purpose, does not bypass OS security and is not a storefront. Guideline 2.5.2's "introduces or changes features or functionality" is the stricter reading App Review may apply. Safest policy: ship all GDScript in the signed app bundle; packs carry content only; use Godot patch PCKs only for content; keep any script-bearing content minimal, consistent with the store description, and mention it in Notes for Review.
- Routing packs through Apple-hosted Background Assets gives Apple review of the pack version itself (App Review statuses "Waiting for Review / In Review / Rejected / Ready for Distribution"), which is the strongest compliance signal available for iOS.
- 4.2.3(ii): initial-launch downloads must disclose size and prompt. Background Assets `essential` packs contribute to the App Store install progress and the product page shows an "Up to" size, so that satisfies the spirit; for gateway-hosted packs on iOS, prompt before large downloads.
- Downloaded packs written to Application Support/Caches are "data outside the designated container area" only if written outside the sandbox container; inside the container it is fine.

### A4. Background Assets and On-Demand Resources

See section E (deep dive). Short answer: Apple-hosted managed asset packs are GA on OS 26 for TestFlight/App Store apps; ODR is deprecated at 27.0.

### A5. EU DMA, Japan, Brazil: alternative distribution

Sources: https://developer.apple.com/support/dma-and-apps-in-the-european-union/ , .../alternative-app-marketplace-in-the-eu/ , .../web-distribution-eu/ , DPLA Attachment text (Japan/Brazil), ASC Help. [APPLE]

What changed (as of 2026-09-29)

- DPLA updated 2026-08-18; new unified EU terms take effect 2026-10-01 (or the day the Account Holder agrees, whichever is later). "The Core Technology Fee ... will be replaced by the Core Technology Commission, a simple 5% commission on digital transactions in apps distributed outside the App Store. The new terms also eliminate the Initial Acquisition Fee and Store Services Fee." The old Alternative Terms Addendum is being superseded by Attachment 14 of the DPLA.
- Business terms in the EU table (from the same page): App Store IAP commission 26% (15% for Small Business Program etc. and subscriptions after year one); alternative payment processing inside the app 20% (10% reduced); "store services commission" for out-of-app offers with an actionable link 15% (10% reduced), only on sales within 7 days of link tap; Core Technology Commission 5% on sales of paid apps and digital goods/services in marketplaces, apps distributed through marketplaces, and Web Distribution apps (including links out with a 7-day attribution window). Developers must choose their payment options and keep them 12 months. Taxes are the developer's responsibility for alternative payments; transactions must be reported to Apple (monthly, within 15 days of month end for alternative-payment reporting).
- Alternative marketplaces beyond the EU: the DPLA attachment for "Alternative App Marketplace (Japan, Brazil)" states the Japan entitlement profile "is compatible only with devices in Japan on iOS 26.2, or later" and Brazil "only with devices in Brazil on iOS 26.5 or later"; Apple's marketplace page says "If my marketplace is approved in another region, such as Japan or Brazil, you are still required to submit a separate request to operate in the EU." AltStore says AltStore PAL is "available for users in the EU, Japan, and Brazil" (https://faq.altstore.io/developers/distribute-with-altstore-pal.md) and MacRumors reported AltStore in Japan on 2025-12-18 (https://www.macrumors.com/2025/12/18/altstore-japan-launch/) [SECONDARY]. I could not fetch Apple's Japan/Brazil business-terms pages (URLs returned 404) so their commission rates are UNVERIFIED here.

Notarization for iOS (required for every alternative channel)

- "Notarization for iOS and iPadOS apps is a baseline review... focused on platform policies for security and privacy and to maintain device integrity." Select the notarization review type in App Store Connect ("Review Type" = Notarization; `appStoreVersions.reviewType` `NOTARIZATION`). Checks: Accuracy, Functionality, Safety, Security, Privacy. "Apple encrypts and signs all iOS and iPadOS apps intended for alternative distribution".
- Output is an Alternative Distribution Package (ADP): `manifest.json`, a `signature` file, and one or more `.ipa` variants (structure as reported by AltStore's docs and a 2024 walkthrough https://dev.to/temer/how-we-distribute-an-ios-app-outside-the-app-store-a-practical-altstore-pal-walkthrough-33li [SECONDARY]). ASC API: `GET /v1/appStoreVersions/{id}/alternativeDistributionPackage`, `alternativeDistributionPackages/{id}/versions`, `.../variants`, `.../deltas`, `alternativeDistributionKeys`, `alternativeDistributionDomains`; the package attribute `sourceFileChecksum` (API 4.2) lets marketplaces verify builds.

Developer path to be listed on a third-party marketplace such as AltStore PAL

1. Account Holder agrees to the updated DPLA; enable alternative distribution for the app in App Store Connect (Apple: "Developers distributing apps in the EU can enable alternative marketplace distribution in App Store Connect"). No EU establishment is required (AltStore: "You do not need to be located in or have a business in the EU, Japan, or Brazil").
2. Copy your Developer ID (App Store Connect > Edit Profile) and register it with the marketplace: for AltStore, `POST https://api.altstore.io/register` with `{developerID, email}` returns `{token, expiration}`; enter the token in App Store Connect > Users and Access > Integrations > Marketplace; select which apps are eligible; opt in to Apple notifying the marketplace of new ADPs (needs the marketplace to be approved for notarization and to support notifications, else send the ADP manually). https://developer.apple.com/help/app-store-connect/managing-alternative-distribution/manage-distribution-on-an-alternative-app-marketplace
3. Submit the build with review type Notarization (skippable if you also ship on the App Store: "Your apps will be automatically notarized when approved for the App Store").
4. AltStore processes the ADP (automatic if notifications on; manual `POST https://api.altstore.io/adps {adpID}`; status `GET https://api.altstore.io/adps/{adpID}`), then you download the ADP and host it unmodified ("DO NOT modify the manifest.json in any way (e.g prettifying)"; preserve directory hierarchy; hashes must not change). `assetURLs` in a version entry lets you host individual ADP files elsewhere, "This allows you to host ADPs using GitHub Releases!".
5. Publish a source JSON with `marketplaceID` (the app's Apple ID) and `downloadURL` = the ADP `manifest.json` (or ADP root). Requires AltStore PAL 2.2+. Optional discoverability via `fediUsername` + `POST https://api.altstore.io/federate`. Fees: AltStore takes 0%; Apple's Core Technology Commission applies. https://faq.altstore.io/developers/fees.md

- The marketplace itself, not the developer, must meet the marketplace-operator criteria.

Can Polaris Key be (or host) a marketplace?

- Being a marketplace operator: requires the Alternative App Marketplace entitlement (organization enrolment; primary purpose = discovery/distribution of other developers' notarized apps; publish terms and data policies; IP-dispute process; fraud monitoring; MarketplaceKit app + website + server), plus one eligibility route. From 2026-10-01 the eligibility list is: D&B financial-stability score ("Low Risk"/"Below Average Risk" under the existing wording), publicly traded, VC funding from listed firms, financial audit, government/education/nonprofit fee waiver, USD 1,000,000 standby letter of credit, or one million first annual installs. From 2026-10-01 no EU legal entity is needed. That is not realistic for a single-game vendor and is out of scope for the platform.
- Hosting a self-run "source" for AltStore PAL is fine and realistic: a source is just JSON plus ADP hosting for your own apps (Polaris gateway/R2 can host ADP files and the source). Web Distribution (your own site) is a different, gated program: iOS 17.5+, the domain registered in App Store Connect, "Only offer apps from your developer account", same eligibility list, 5% CTC, install verification token via `alternativeDistributionKeys`; Apple says a new API to start website-app downloads from inside your own app arrives fall 2026.

---

## B. AltStore / SideStore sideloading

### B1. Source JSON schema (current)

Source: https://faq.altstore.io/developers/make-a-source.md (fetched raw markdown) [VENDOR]. The docs do not list a source-level `identifier` or `sourceURL`; older/legacy sources include them and extra keys are ignored by AltStore [INFERENCE], so including them is harmless.

Source object
| key | type | required | notes |
|---|---|---|---|
| name | string | yes | |
| subtitle | string | no | one sentence |
| description | string | no | |
| iconURL | string | no | defaults to first app's iconURL |
| headerURL | string | no | 3:2 recommended; defaults to iconURL |
| website | string | no | |
| fediUsername | string | no | needed for discoverability; cannot be changed later |
| patreonURL | string | no | enables Patreon-gated apps |
| tintColor | string | no | hex |
| nsfw | boolean | yes (docs list it without "optional") | must be accurate if opted into discovery |
| featuredApps | string[] | no | ordered bundle identifiers; only first five shown |
| apps | App[] | yes | |
| news | News[] | no | |

App object: `name`, `bundleIdentifier` (case-sensitive; must equal CFBundleIdentifier; unique per source), `marketplaceID` (Apple ID of the notarized app; required for PAL, optional/not needed for Classic), `developerName`, `subtitle`, `localizedDescription`, `iconURL`, `tintColor`, `category` (`developer, entertainment, games, lifestyle, other, photo-video, social, utilities`; default other), `screenshots`, `versions[]`, `appPermissions`, `patreon`.

Screenshots: array of URL strings (only valid for 9:19.5 portrait iPhone) or objects `{imageURL, width?, height?}` (default assumed 393x852 pt; iPad requires explicit width/height); or a per-device object `{"iphone":[...], "ipad":[...]}` (the "new format per device").

Version object: `version` (CFBundleShortVersionString, case-sensitive), `buildVersion` (CFBundleVersion), `marketingVersion` (optional display string), `date` (ISO 8601), `localizedDescription` (what's new), `downloadURL` (Classic: URL of the .ipa; PAL: URL of ADP `manifest.json` or ADP root), `size` (bytes), `minOSVersion`, `maxOSVersion` (inclusive, rarely used), `assetURLs` (dictionary for overriding ADP file locations). AltStore 1.6/2.0 release notes also mention a `sha256` parameter for .ipa verification and JSON5 support [VENDOR release notes]; `sha256` is not in the current make-a-source page, so treat as optional/legacy.

appPermissions: `entitlements` (string[], all entitlements of the app and its extensions except `com.app.developer.team-identifier` and `application-identifier`) and `privacy` (dictionary of Info.plist `*UsageDescription` key to text). "AltStore requires that sources list all entitlements and privacy permissions for every app. These will be checked against the downloaded .ipa, and AltStore will refuse to install any app whose permissions do not match." => Polaris must derive these from the actual .ipa at ingest, not from hand-authored config.

News item: `title`, `identifier` (unique in source), `caption`, `date`, `tintColor`, `imageURL` (3:2), `notify` (true = push notification at the next background check), `url`, `appID` (bundle id of associated app).

Patreon object: `pledge`, `currency`, `benefit`, `tiers` (mutually inclusive conditions).

### B2. Updates and notifications

Source: https://faq.altstore.io/developers/updating-apps.md [VENDOR]

- AltStore compares the FIRST compatible entry in `versions[]` with the installed version; it "does not use dates to determine if there's a newer version"; each entry must differ in `version` or `buildVersion`. Order matters: newest first. `minOSVersion`/`maxOSVersion` hide incompatible updates and fall back to the newest compatible version for old devices.
- "Once uploaded, the update is immediately made live", so avoid long CDN caching of the source; add a staging source for verification.
- Background refresh: AltStore Classic refreshes/checks in the background with AltServer or, with Background Refresh, wakes periodically (https://faq.altstore.io/altstore-classic/your-altstore ). News `notify:true` is the push mechanism. PAL: updates are handled by the marketplace; PAL itself updates automatically within about 24 hours.
- SideStore: "Does SideStore support OTA updates? Yep! Just click the update button when it appears!" and refreshes apps in the background to keep the 7-day period from expiring (https://docs.sidestore.io/docs/faq).

### B3. Free Apple ID limits

- 7-day signing expiry; refreshes needed. AltStore Classic: "Apps installed with AltStore expire after 7 days"; three active apps ("Apple restricts users to three simultaneously active sideloaded apps"); "You can only register up to 10 App IDs at a time, but each App ID expires after one week"; every app extension consumes an App ID (https://faq.altstore.io/altstore-classic/app-ids). SideStore FAQ: free account "can only install 3 apps (including itself)" and "only 10 different apps may be installed in a week (Referred to as App IDs)".
- Implication [INFERENCE]: the sideload IPA should not carry a Background Assets extension, widget or other extension targets (each costs an App ID and a capability the free account cannot grant). Keep a separate lean sideload build variant.
- AltStore Classic vs PAL table (https://faq.altstore.io/altstore-pal-v.-altstore-classic.md): Classic: worldwide, any .ipa, apps expire after 7 days, 3-app limit, limited capabilities, no JIT; PAL: EU/Japan/Brazil, notarized apps, no expiry, no app limit, full capabilities.

### B4. SideStore compatibility

- SideStore docs: "SideStore is fully compatible with AltStore Sources"; add via `sidestore://source?url=[source url]`; install an IPA via `sidestore://install?url=[download url]`; "if a user tries to use a sidestore:// link without SideStore already installed, it will crash" (use a landing page). https://docs.sidestore.io/docs/advanced/app-sources , https://docs.sidestore.io/docs/advanced/url-schema [VENDOR]
- Quirk 1 (top-level downloadURL): SideStore issue #735 opened 2024-11-06 against 0.5.8: sources with a `versions[]` array and no app-level `downloadURL` fail with "The data couldn't be read because it isn't in the correct format. E downloadURL:String or downloadURLs:[[Platform:URL]] key required." AltStore derives it from the latest version; SideStore "unconditionally requires" it. Status: closed, milestone 0.6.0; SideStore 0.6.2 (2025-07-01) "Integrates AltStore 2.0 changes". https://github.com/SideStore/SideStore/issues/735 (fetched) and releases page [VENDOR/FORUM]. Safe rule: emit BOTH the `versions[]` array AND legacy app-level fields `version`, `versionDate`, `versionDescription`, `downloadURL`, `size` (copy of newest entry) for every app. [INFERENCE for the legacy field names, standard in pre-2.0 sources]
- Quirk 2 (notarized-source detection): SideStore's docs warn to "remove the autogenerated-by-default marketplaceID and Build fields, otherwise SideStore will believe it to be a notarized source and prevent your source being added". So the SideStore/Classic source must omit `marketplaceID` (and PAL ADP-style entries). => Polaris must emit distinct source documents for Classic/SideStore vs PAL (per-channel and per-flavour).
- Release state (Sept 2026): SideStore 0.6.4 (2026-09-09 to 2026-09-15 per GitHub) is marked "DO NOT USE, sign-in broken" because of Apple server-side changes; 0.7.0-alpha (2026-09-15) fixes "503 during sign-in". [VENDOR release page, fetched twice; treat as volatile]. AltStore Classic/AltServer also depend on these Apple sign-in endpoints, so sideloading is inherently fragile and should be a best-effort channel.

### B5. Deep links

- AltStore Classic: `altstore://source?url=<encoded source URL>` (used throughout AltStore's own Trusted Sources page, https://faq.altstore.io/altstore-classic/trusted-sources.md). AltStore PAL: `altstore-pal://source?url=...` (PAL 2.1 added the scheme; StikDebug example in the AltStore docs); other schemes `altstore://search?q=...`, `altstore://viewApp?bundleID=...` (+ `altstore-pal://` equivalents, PAL 2.1.1). Web deep link (works for both): `https://altstore.io/source/<host/path/to/source.json>` optionally `?app=<bundleID>` and `&version=<x>`. https://faq.altstore.io/developers/download-on-altstore-badge.md . SideStore: `sidestore://source?url=`, `sidestore://install?url=`.

### B6. Private / authenticated sources, headers, CORS

- I found NO documented mechanism for authenticated sources (no custom headers, no bearer tokens). The only gating feature is the Patreon integration (`patreon` object; AltStore authenticates the user with Patreon before download; ADP/IPA attached to a Patreon post). https://faq.altstore.io/developers/patreon-integration [VENDOR]
- Therefore a per-user source can only be a secret URL, e.g. `https://dl.example.com/s/<token>/altstore.json`, with `downloadURL` pointing at the gateway with the same long-lived revocable token (a short-lived signed URL may expire before the user taps Install because AltStore installs from the last fetched source) [INFERENCE].
- No CORS or special headers are documented for sources; AltStore is a native client so CORS is irrelevant for it. Serve `Content-Type: application/json`, HTTPS, short cache TTL. Add `Access-Control-Allow-Origin: *` only for web tools (AltSource Browser, explore.alt.store crawler) [INFERENCE]. For PAL ADP hosting: `.ipa` as `application/octet-stream`; the extensionless `signature` file must be served verbatim (2024 walkthrough) [SECONDARY].

---

## C. macOS

### C1. Sparkle 2 appcast features

Sources: https://sparkle-project.org/documentation/publishing/ , /delta-updates/ , /package-updates/ , /sandboxing/ , /documentation/ (all fetched). [VENDOR]
Current release: Sparkle 2.10.0 (2026-09-14; requires macOS 12+; CocoaPods dropped); 2.9.x line (2.9.0 introduced markdown release notes, signed feeds, `hardwareRequirements`, `minimumUpdateVersion`); 2.8 changed UI and dropped interactive GUI package updates; 2.7 added delta format v4 and Apple Archive (.aar) support. (https://github.com/sparkle-project/Sparkle/releases.atom and https://sparkle-project.org/documentation/upgrading/)

Item elements (Sparkle namespace `http://www.andymatuschak.org/xml-namespaces/sparkle`)

- `<enclosure url= sparkle:edSignature="..." length="..." type="application/octet-stream" [sparkle:installationType="package"]/>`: `sparkle:edSignature` is the EdDSA (ed25519) signature (base64) of the archive; `length` is the byte size. Archives may be dmg, zip, tar.\*, aar (2.7+, needs SUVerifyUpdateBeforeExtraction), or flat pkg/mpkg.
- `<sparkle:version>` = CFBundleVersion (machine, must increase); `<sparkle:shortVersionString>` = CFBundleShortVersionString (display). Recommended as top-level item children rather than enclosure attributes.
- `<sparkle:channel>beta</sparkle:channel>`: default channel is always visible; extra channels only if the app returns them from `allowedChannelsForUpdater:`. "An updater cannot exclude itself from the default channel." Channels "are not intended to be used for parallel releases". Requires Sparkle 2 clients (June 27, 2021+).
- `<sparkle:minimumSystemVersion>12.0.0</...>` (three-part), `<sparkle:maximumSystemVersion>`.
- `<sparkle:hardwareRequirements>arm64</...>` (Sparkle 2.9+): Apple-silicon-only update.
- `<sparkle:minimumAutoupdateVersion>2.0</...>`: lowest version that may auto-update without UI (major/paid upgrades); `<sparkle:ignoreSkippedUpgradesBelowVersion>` (2.1+); `<sparkle:minimumUpdateVersion>` (2.9+, the minimum installed bundle version allowed to see the update; safe only when all users are on 2.9+).
- `<sparkle:criticalUpdate/>` (optionally `sparkle:version="1.2.4"` = last critical version); critical updates cannot be skipped and bypass phasing.
- `<sparkle:informationalUpdate>` (with optional `<sparkle:version>` or `<sparkle:belowVersion>` children): shows a link instead of installing; or omit `<enclosure>`.
- `<sparkle:phasedRolloutInterval>86400</...>` (seconds between groups) plus `<pubDate>`; Sparkle hardcodes 7 groups (random group id in `SUUpdateGroupIdentifier`, never transmitted); not applied to critical updates or manual checks.
- `<sparkle:deltas>` containing `<enclosure ... sparkle:deltaFrom="1.5" .../>` per old version; optional `sparkle:deltaFromSparkleExecutableSize` and `sparkle:deltaFromSparkleLocales` (2.3+); delta format 4 needs Sparkle 2.7; failing deltas fall back to the full archive; `generate_appcast` creates and signs them (needs the old .app bundles available). BinaryDelta rejects ACLs and code-signature xattrs.
- Release notes: `<sparkle:releaseNotesLink [xml:lang]>` (URL, optionally signed with `sparkle:edSignature`+`sparkle:length` if SURequireSignedFeed), `<sparkle:fullReleaseNotesLink>`, embedded `<description>` (HTML; `sparkle:format="plain-text"` 2.4+; `"markdown"` 2.9+ on macOS 12+).
- `sparkle:os` attribute on enclosures exists for WinSparkle/NetSparkle mixed feeds but Sparkle "recommend[s] using separate appcast feeds for macOS and Windows".
- Installer packages: flat `.pkg`/`.mpkg` can be served directly; downsides: always needs authorisation, no deltas, no key-rotation fallback, not supported by `generate_appcast`; use only for special installs.
- Custom elements via your own XML namespace (`propertiesDictionary`).

Signing and key custody

- `generate_keys` creates the ed25519 key pair in the login Keychain and prints `SUPublicEDKey`; export/import with `-x` / `-f`. `sign_update <archive>` prints `sparkle:edSignature="..." length="..."`. `generate_appcast <folder>` signs, creates deltas and (with SURequireSignedFeed) signs the feed and release notes. Sparkle's own guidance: "Please ensure your signing keys are kept safe and cannot be stolen if your web server is compromised. One way to ensure this for example is not having your signing keys accessible from the machine that is hosting your product." So the Polaris Worker/gateway must not hold the private key; CI (a macOS runner, or Linux with the key injected) signs each archive and hands Polaris the `edSignature` and `length` (e.g. as a sidecar `*.sparkle.json` release asset). Common CI practice is `sign_update --ed-key-file <file or ->` reading the key from a secret (seen in third-party CI write-ups; the option is not on the docs pages I fetched) [SECONDARY].
- Signed feeds (2.9+) [VENDOR]: `SURequireSignedFeed` + `SUVerifyUpdateBeforeExtraction`; "with a signed feed, an attacker that compromises an app's update server will not be able to inform and trick existing users to update from another location". Cost: any change to the feed needs re-signing, so a dynamic Worker-rendered appcast can only be used if CI pre-renders and signs every variant (per channel/per country) or you skip signed feeds. Recommendation [INFERENCE]: keep feed signing off initially (archive signatures still protect the payload), or render feeds in CI and store them in R2.
- Key rotation: with Developer ID signing plus an EdDSA key you can rotate one of them per update; with `SUVerifyUpdateBeforeExtraction` EdDSA rotation needs a Developer-ID-signed dmg.

### C2. Embedding Sparkle in a non-Cocoa app (Godot macOS)

- A Godot macOS export is a standard Universal 2 `.app` (x86_64+arm64) that can be zipped or made into a DMG; signing and notarization are built into the exporter (Xcode codesign/notarytool with Apple ID or ASC API key on macOS; `rcodesign` on Linux/Windows; env vars like `GODOT_MACOS_NOTARIZATION_API_UUID`, `GODOT_MACOS_CODESIGN_CERTIFICATE_FILE`). Hardened runtime entitlements listed: Allow JIT, Disable Library Validation (for GDExtensions), etc. The Godot docs say nothing about Sparkle or auto-update. https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_macos.html [VENDOR]
- Existing integrations: none found. A GitHub repository search for Godot+Sparkle returned zero results (unauthenticated search, may be incomplete) and the Godot Asset Library filter "sparkle" returned only an unrelated "Sparkle Lite" game-feel plugin. [SECONDARY]. Treat as build-it-yourself.
- Practical designs [INFERENCE]:
  1. Native GDExtension (or tiny dylib) that links `Sparkle.framework` and, on the main thread after `NSApplication` is running, creates `SPUStandardUpdaterController(startingUpdater: true, updaterDelegate:..., userDriverDelegate:...)`; exposes `check_for_updates()`, `set_channel()`, automatic-check toggle and update-state signals to GDScript. Godot's macOS host is already a Cocoa app with a main run loop, so the standard UI works. Info.plist needs `SUFeedURL`, `SUPublicEDKey` (and `SUEnableAutomaticChecks` etc.): add via post-export plist editing.
  2. Zero-code alternative: a small separate helper app/launch agent that only runs Sparkle (also fine because Sparkle updates the main bundle by path), triggered by the game via `OS.execute`. Less integrated UI, but avoids GDExtension linkage/signing complexity.
  3. Do not implement Sparkle's protocol in GDScript: the installer/relaunch/authorization pieces are the hard part.
- Signing/notarization implications: Sparkle's helpers (Autoupdate, Updater.app, Installer.xpc, optional Downloader.xpc) must be signed inside-out with the same Developer ID and hardened runtime, no `--deep`; Xcode's Archive/Export does this, a custom Godot pipeline must replicate it (Sparkle docs give the exact `codesign -f -s ... -o runtime` sequence). Use Developer ID + notarization ("Notarize and code sign the application via Apple's Developer ID program"). If the app is not sandboxed, XPC services are not needed and may be removed; sandboxed apps need `SUEnableInstallerLauncherService`, the mach-lookup temporary exception, and (only without network-client entitlement) the Downloader service. Sparkle 1 does not support sandboxed apps. https://sparkle-project.org/documentation/sandboxing/
- Recommended pipeline [INFERENCE]: export macOS unsigned/ad-hoc from Godot, then in CI: inject Sparkle.framework and Info.plist keys, sign nested code inside-out, sign the app, package DMG, notarize, staple, sign_update the DMG/zip, upload to release, hand the signature to Polaris.
- Mac App Store alternative: sandbox required; per guideline 2.4.5(vii) "They must use the Mac App Store to distribute updates; other update mechanisms are not allowed" (so no Sparkle) and 2.4.5(vi) no license keys; DLC via IAP; Apple-hosted Background Assets is available on macOS 26+. WWDC26 note: Mac App Store universal purchases no longer need Intel support, macOS 13+ minimum. https://developer.apple.com/wwdc26/guides/app-store/ [APPLE]
- Updating the .app bundle vs a `.pck` in Application Support: replacing the whole bundle (Sparkle) keeps the signature valid because the new bundle is fully signed and notarized; modifying files inside an installed signed .app (e.g. dropping a new `.pck` into `Contents/Resources`) invalidates the code-signature seal and Gatekeeper would flag/quarantine it [INFERENCE from how code-signing seals work]. A downloaded `.pck` under `~/Library/Application Support/<app>/` is outside the bundle, so the signature stays valid; Godot loads it with `ProjectSettings.load_resource_pack()`. Godot 4.4+ patch PCKs (Export > Patching) carry only changed resources and load in layers (each layer adds load time). Load packs as early as possible (autoload `_init`). https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html. On the Mac App Store, 2.4.5(iv) restricts this.

### C3. Notarization with notarytool and ASC API keys

Sources: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution , .../customizing-the-notarization-workflow , https://developer.apple.com/documentation/notaryapi/submitting-software-for-notarization-over-the-web [APPLE]

- `notarytool` replaced `altool` (altool notarization stopped 2023-11-01). `xcrun notarytool submit <zip|dmg|pkg> --keychain-profile <name> --wait [--webhook <url>]`; credentials via Apple ID + app-specific password + team ID stored with `notarytool store-credentials`, or App Store Connect API key credentials. Apple's Notary REST API accepts the SAME key/JWT as the ASC API ("Use the same key to sign tokens for the notary service that you use for the App Store Connect API"), so it needs a Team key (individual keys cannot use notaryTool). Endpoints under `https://appstoreconnect.apple.com/notary/v2/submissions`: POST (returns temporary S3 credentials valid 12 hours; you upload to S3 yourself), GET status, GET logs, list previous submissions (100). Optional `notifications: [{channel:"webhook", target:url}]` for completion callbacks (verify its signature). This avoids a macOS dependency, so a Linux runner (or, awkwardly, a Worker with an S3 client) can notarize [INFERENCE for the Worker part].
- Requirements: Developer ID Application certificate, hardened runtime, secure timestamp, no `get-task-allow`, SDK >= 10.9, valid entitlements. Notarize dmg, zip, flat pkg (not raw .app). Typical time under 5 minutes, 98% under 15 minutes.
- Staple with `xcrun stapler staple` on app, dmg or pkg; you cannot staple a zip, so staple the contents and re-zip. `stapler` needs CloudKit network access. Gatekeeper finds tickets online even without stapling. Sparkle-updated apps should be notarized and Developer ID signed.

---

## D. Per-surface summary: what Polaris Key provides, automates, what the game SDK needs, policy limits

Legend: PROVIDE = feeds/files/APIs the release server must serve; AUTOMATE = what it can drive via Apple/vendor APIs; SDK = game-side needs; POLICY = constraints on content packs and paid DLC.

### D1. App Store (iOS/iPadOS)

- PROVIDE: `/version` JSON per channel (latest, recommended, minimum) driven by ASC state; deep link/App Store URL (`https://apps.apple.com/app/id<AppleID>`); a content manifest for packs that Polaris hosts (only for non-Apple-hosted packs); localized release notes source of truth; entitlement/verification endpoint for App Store transactions.
- AUTOMATE (ASC API team key, webhooks): upload/track builds (`buildUploads`, `builds`), set What's New (`appStoreVersionLocalizations`), create version, attach build, `reviewSubmissions` submit, `releaseType`, release from `PENDING_DEVELOPER_RELEASE`, phased release enable/pause/resume/complete, Apple-hosted asset pack upload and submission, react to webhooks (`APP_STORE_VERSION_APP_VERSION_STATE_UPDATED`, `BUILD_UPLOAD_STATE_UPDATED`, `BACKGROUND_ASSET_*`). Poll phased-release state.
- SDK: native Swift/ObjC iOS plugin (xcframework + .gdip, `Engine.get_singleton`) for `AppDistributor`/`AppTransaction`, StoreKit 2, Background Assets, App Attest; pure GDScript for HTTP checks to `/version`, pack management via `ProjectSettings.load_resource_pack`, UI. Existing community StoreKit 2 Godot plugins prove the pattern (e.g. https://github.com/hrk4649/godot_ios_plugin_iap v0.4.0 for Godot 4.7 on 2026-06-21, https://github.com/atlasapplications/godot-store-kit, godot-iap/OpenIAP) [SECONDARY].
- POLICY: 2.5.2, DPLA 3.3.1(B), 3.1.1 (IAP for paid packs; no license keys), 3.1.3(b) (cross-platform entitlements need IAP parity), 4.2.3(ii) (download size prompt), 2.3.12 (What's New), account deletion 5.1.1(v).

### D2. TestFlight

- PROVIDE: channel `testflight` in `/version`; public join link (`betaGroups.publicLink`) surfaced by Polaris; feedback triage feed.
- AUTOMATE: `buildBetaDetail` state, `betaAppReviewSubmissions`, group assignment, `betaBuildLocalizations.whatsNew`, tester CRUD, public link enable/limit, `buildBetaNotifications`; webhooks `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED`, `BETA_FEEDBACK_*`, `BACKGROUND_ASSET_*_BETA_*`. Builds expire after 90 days so Polaris should schedule re-uploads/warnings.
- SDK: detect with `AppDistributor.current == .testFlight` (iOS 17.4+); StoreKit environment is sandbox (test purchases free, `originalAppVersion` = "1.0") so entitlement logic must not treat TestFlight as a paid install; App Attest works in TestFlight but uses the appropriate environment.
- POLICY: no compensation for TestFlight access (2.2); pack changes are reviewed for external testers.

### D3. AltStore / SideStore (Classic)

- PROVIDE: source JSON per channel/flavour (Classic/SideStore variant without `marketplaceID`, with both `versions[]` and legacy top-level fields), IPA hosting through the gateway (R2) with correct `size`, `appPermissions` derived from the IPA, deep links (`altstore://source?url=`, `sidestore://source?url=`, `https://altstore.io/source/...`), optional per-user secret URLs, news items for release announcements.
- AUTOMATE: regenerate source on each GitHub Release/prerelease (pr-N channel = separate source or `versions[]` entry with `buildVersion`), compute size and sha256, validate that entitlements/privacy match the IPA before publishing (AltStore will refuse otherwise).
- SDK: no App Store APIs available (no StoreKit purchases, no App Attest); channel detection by absence (`AppDistributor` `other`/error, `embedded.mobileprovision` present, bundle id rewritten); update check via Polaris `/version` because AltStore cannot be driven by the app; in-app "update available" opens an `altstore://` / `sidestore://` deep link. Avoid app extensions in the sideload build (App ID quota).
- POLICY: none from Apple's App Review (not an Apple channel), but signing is Apple-ID-bound: 7-day expiry, 3 apps, 10 App IDs per week for free accounts. Paid content: Polaris license + own commerce (no IAP available); do not offer that path inside the App Store build.

### D4. AltStore PAL / EU (and Japan/Brazil) marketplaces

- PROVIDE: PAL source JSON with `marketplaceID`; hosted ADP (manifest.json, signature, ipa variants) preserved byte-for-byte on R2/gateway with correct MIME types; `assetURLs` if needed; a landing page with `altstore-pal://` link.
- AUTOMATE: ASC alternative-distribution endpoints (ADP ID, versions/variants), notarization review type on submission, AltStore REST (`/register`, `/adps`, `/federate`), webhooks for ADP creation/territory availability (if Polaris acts as the developer-side listener for its own tooling).
- SDK: `AppDistributor.current == .marketplace(bundleID)`; no Apple IAP and no Game Center there (per Apple's doc for this enum); commerce via own processor plus CTC reporting; Background Assets is supported for marketplace apps (Apple's AppDistributor doc names BackgroundAssets for large downloads) [APPLE].
- POLICY: notarization guidelines (no downloading executable code); CTC 5% on digital goods; reporting obligations; EU/JP/BR storefront devices only (iOS 17.4+ EU; 26.2+ JP; 26.5+ BR).

### D5. Mac direct (Developer ID + Sparkle)

- PROVIDE: Sparkle appcast(s) (channels via `sparkle:channel` or per-channel feed URLs; `minimumSystemVersion`, `hardwareRequirements`, `minimumAutoupdateVersion` mapped from Polaris license/major-version rules, `phasedRolloutInterval` from rollout config, `criticalUpdate`, `informationalUpdate`, release notes link/embedded markdown), download gateway for dmg/zip/deltas with signature+length; `/version` JSON.
- AUTOMATE: CI does export, sign, notarize (`notarytool` / Notary API with ASC key), staple, `sign_update`/`generate_appcast`, upload; Polaris ingests signature+length sidecar, renders the appcast dynamically (or serves CI-rendered feed). Optionally track notarization via the Notary webhook.
- SDK: native Sparkle integration (GDExtension/dylib or helper app) + Info.plist keys; Polaris license check via HTTP (pure GDScript OK).
- POLICY: none from App Review; Developer ID requirements; Sparkle keys must stay off the hosting box.

### D6. Mac App Store

- PROVIDE: `/version` metadata for display only; no update feed; pack manifest only if using non-App-Store hosting for non-code data (restricted by 2.4.5(iv)).
- AUTOMATE: same ASC API as iOS for macOS platform versions (reviewSubmissions, phased release applies to macOS with auto-updates), TestFlight for Mac, Apple-hosted Background Assets on macOS 26+.
- SDK: sandboxed export, StoreKit 2/`AppTransaction`, no Sparkle, no license-key UI.
- POLICY: 2.4.5(iv), (vi), (vii); IAP for unlocks (3.1.1); universal purchase possible with iOS.

---

## E. DEEP DIVE (scope addition): Apple Background Assets as of OS 26 and 27

Primary sources: https://developer.apple.com/documentation/backgroundassets (and subpages: creating-managed-asset-packs, downloading-apple-hosted-asset-packs, testing-asset-packs-locally, reducing-download-and-storage-demands-with-localized-asset-packs, configuring-an-unmanaged-background-assets-project), https://developer.apple.com/documentation/appstoreconnectapi/managing-apple-hosted-background-assets , App Store Connect Help pages (overview, upload, statuses, size limits), WWDC25 session 325 and WWDC26 session 378. [APPLE]

### E1. Concepts and availability

- Three modes: (1) Managed + Apple-hosted (`StoreDownloaderExtension`, `BAUsesAppleHosting=YES`); (2) Managed + self-hosted (`ManagedDownloaderExtension`, "self-hosted asset packs"); (3) Unmanaged/self-hosted (classic 2022/2023 model: `BADownloaderExtension`, `BAManifestURL`, `BADownloadManager`, `BAURLDownload`). Managed asset pack types (`AssetPack`, `AssetPackManager`, `AssetPackManifest`, `ManagedDownloaderExtension`) are "introduced at 26.0" on iOS, iPadOS, Mac Catalyst, macOS, tvOS, visionOS. Apple-hosted: "available for apps on TestFlight or the App Store that use the Managed Background Assets features on all platforms except watchOS"; hosts "up to 200GB of compressed assets".
- Apple's overview: "With Managed Background Assets, the system automatically manages downloads, updates, and compression". Apps "targeting iOS 26 ... macOS 26 ... and later can use Managed Background Assets". Assets are made with `xcrun ba-package` from Xcode or "the Managed Background Assets Developer Tools for Linux" (ASC Help), so pack building can run on Linux CI. (WWDC25/26 summaries also claim Windows tools; the Linux tools are the one confirmed in Apple's ASC Help.) https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs
- Entry points fire on App Store installs/updates and periodically: the `backgroundassets-debug` man page: "Most Background Assets extension entry-points fire based on App Store installation, update, or system events"; "In production, the App Store gives the user the ability to disable Background Assets when the app hasn't been launched". So install-time (essential/prefetch) behaviour is an App Store/TestFlight feature. Whether Developer-ID Mac apps or sideloaded iOS apps get install/update triggers is NOT documented (the debug man page only says it works with an attached device); AppDistributor's doc does say marketplace apps should use Background Assets. Treat Developer ID and AltStore builds as "no system-managed BA; use plain URLSession/gateway".
- macOS caveat: bug where Apple-hosted packs failed on macOS because development URL overrides were rejected; "resolved in macOS 26.4 Tahoe beta 3" (Mar 2026). https://developer.apple.com/forums/thread/807154 [FORUM]. Apple-hosted packs were initially limited to TestFlight internal testers in July 2025 (https://developer.apple.com/forums/thread/793565) and are generally available now [FORUM].

### E2. Asset pack creation, manifest and tools

- `xcrun ba-package template -o Manifest.json` generates a manifest template. Keys: `assetPackID`; `downloadPolicy` (object with one of `essential`, `prefetch`, `onDemand`; for essential/prefetch, `installationEventTypes` = `firstInstallation` and/or `subsequentUpdate`; `onDemand` = `{}`); `fileSelectors` (`file` or `directory` entries, paths relative to the directory where you run the tool); `platforms`. From Xcode 27: `language` (BCP-47) for localized packs. Archive: `xcrun ba-package Manifest.json -o Tutorial.aar`. Apple: "You can also include CPU and GPU executables in an asset pack, but not macOS executables."
- Policies: `essential` (downloaded as part of the install; counts toward install progress in App Store/TestFlight/Home Screen), `prefetch` (starts during install, may continue afterwards), `onDemand` (only when the app asks).
- Namespace: "The system automatically merges all of your asset packs into a shared namespace, effectively reconstructing your asset root folder"; a path collision across packs is "undefined" as to which file wins => keep unique paths per pack.
- Local testing: `xcrun ba-serve --host <host> Tutorial.aar Other.aar` (HTTPS mock server; needs a cert whose name is the host/IP; on devices set Settings > Developer > Development Overrides > Background Assets Testing > URL Override; on macOS `xcrun ba-serve url-override <baseURL>`). Forum: a bug required port 443 for overrides on iOS 26.0 beta. https://developer.apple.com/forums/thread/793565 [FORUM]. Xcode 27: StoreKit configuration + mock server auto-starts (WWDC26 378 summary, [APPLE via summary]).

### E3. Info.plist keys and entitlements

Managed (both hosting modes): add a Background Download extension target ("Apple-Hosted, Managed" or self-hosted variant), give app and extension the same App Group capability, then in the app's Info.plist:

- `BAAppGroupID` (string, shared group id)
- `BAHasManagedAssetPacks` = YES (system auto-manages)
- `BAUsesAppleHosting` = YES only for Apple hosting ("For apps that use Apple-Hosted Background Assets, omit all other Background Assets information property list keys").
  Self-hosted (unmanaged; also referenced for self-hosted managed): `BAManifestURL` (the URL the system downloads before launching the extension; "The format and content of the manifest file is your responsibility"; required), `BAInitialDownloadRestrictions` (dictionary; required) with `BADownloadAllowance` (bytes, non-essential downloads combined, use compressed sizes), `BADownloadDomainAllowList` (DNS names, wildcards like `*.example.com`), `BAEssentialDownloadAllowance`; plus `BAEssentialMaxInstallSize` and `BAMaxInstallSize` (uncompressed on-disk sizes, "The App Store uses this key to show the size of your app on the product page"). macOS apps also need the App Sandbox capability on app and extension. WWDC22 note: the initial-download restrictions are only enforced for the first install ("only enforced after first app install"; later launches are not restricted). [APPLE + WWDC22 via summary]
- HTTPS is required for all Background Assets downloads.
- Extension runs in a special sandbox (WWDC23).

### E4. Runtime API (Swift; Objective-C mirrors via `BAAssetPackManager`)

[APPLE] `AssetPackManager` is an actor (`.shared`).

- Discover: `assetPack(withID:)`, `allAssetPacks`, `manifest` (`AssetPackManifest`), `localizedAssetPacks(for:)` (iOS 27), `resolvedLanguage` (read/write), `reconcilePreferredLanguages()`.
- Download/ensure: `ensureLocalAvailability(of:requireLatestVersion:)` (single) and `ensureLocalAvailability(of:requireLatestVersions:)` (batch; throws `LocalAvailabilityError` with `successes`/`failures`), `statusUpdates`/`statusUpdates(forAssetPackWithID:)` (async stream: began/paused/downloading(progress)/finished/failed; cancel via `Progress`), `checkForUpdates()` -> `(updatingIDs, removedIDs)` (fetches latest server info, updates outdated packs, removes obsolete ones), `remove(assetPackWithID:)` ("the system won't automatically remove your asset packs while your app is installed"), `status(...)`, `assetPackIsAvailableLocally(withID:)`, `localSize(ofAssetPackWithID:calculationMethod:)`, `localVersion(ofAssetPackWithID:) -> Int`.
- Read: `contents(at:searchingInAssetPackWithID:options:)` (memory-mapped `Data` by default), `descriptor(for:)` (you must close the FD), `url(for: FilePath)` (works for directories too; "Don't persist the returned URL beyond the lifetime of the current process"; slower; not on the main thread).
- Extension: `shouldDownload(_:)` hook (optionally filter by compatibility); omit to use defaults. "Not doing so [adopting the matching extension protocol] is a programmer error."

### E5. Uploading, versioning, review and TestFlight (server-side automation)

Endpoints (ASC API, roles ADMIN, APP_MANAGER or DEVELOPER): [APPLE] https://developer.apple.com/documentation/appstoreconnectapi/managing-apple-hosted-background-assets

1. `POST /v1/backgroundAssets` `{assetPackIdentifier, app relationship}` -> asset pack UUID.
2. `POST /v1/backgroundAssetVersions` (relationship to the asset) -> auto-incremented version number.
3. `POST /v1/backgroundAssetUploadFiles` `{assetType: "ASSET", fileName: "Tutorial.aar", fileSize}` (optionally first `assetType: "MANIFEST"` with `Manifest.json` to validate the manifest); response has `PUT` upload operations (multipart URLs); 4. upload the parts; 5. `PATCH /v1/backgroundAssetUploadFiles/{id}` `{uploaded: true}` to commit. Optional checksums (`Checksums`, composite/sequential, added 4.1). (WWDC25 summary shows `assetType: BUNDLE`; Apple's doc says ASSET/MANIFEST; use the doc.)

- Processing yields an internal beta release ("Ready for testing"); external testers: `POST /v1/betaAppReviewSubmissions` (beta asset-pack review) or the UI; store: `POST /v1/reviewSubmissions` (asset pack alone, with other asset packs, or with the app build). States: `BackgroundAssetVersionState`, `...InternalBetaRelease`, `...ExternalBetaReleaseState` (READY_FOR_TESTING, REJECTED...), `...AppStoreReleaseState` (READY_FOR_DISTRIBUTION, REJECTED...); reading endpoints under `/v1/backgroundAssetVersionAppStoreReleases/{id}` etc.; API 4.2 added `stateDetails` for import errors/warnings; 4.3 added `usedBytes`; 4.4 added multi-locale filter `filter[versions.locale]`.
- Webhooks: the four `BACKGROUND_ASSET_VERSION_*` events above (each with thin payload; fetch the instance).
- UI/other tools: Transporter, `iTMSTransporter` (macOS/Windows/Linux), `xcrun altool --upload-asset-pack` (`altool` remains for asset packs). Processing emails; stuck in Processing > 24 h => contact Apple. Statuses: TestFlight (Awaiting Upload, Processing, Failed, Ready for Internal Testing, Ready to Submit, Waiting for Review, In Review, Rejected, Ready for External Testing, Superseded) and App Store (Prepare for Submission, Ready for Review, Waiting for Review, In Review, Accepted, Rejected, Processing for Distribution, Ready for Distribution, Superseded).
- Versioning semantics (critical): asset packs update independently of app versions: "You can also update additional content without creating a new app version". One active beta version and one App Store version per asset pack (API doc). "When you upload the new app build ... it continues to work with the asset pack versions that are live for external TestFlight and the App Store". When a new pack version goes live on the App Store, ALL installed app versions switch to it (per WWDC25 summary: "Must ensure new asset pack is compatible with older app versions"), so Polaris must model pack-to-app compatibility: bump the pack ID (e.g. `content-v2`) for breaking changes, or keep old app versions functional, and use the extension's `shouldDownload(_:)` for compatibility gating. Submit a build and its new pack version together to keep them paired.
- Limits [APPLE ASC Help "Apple-hosted asset pack size limits"]: 200 GB asset-pack total per app (for each pack Apple takes the MAX size over all eligible versions, then sums; e.g. pack A v1=4GB v2=2GB + pack B 1GB = 5GB total), 200 asset packs per app, shared across platforms; email/banner at 80%; free space by archiving packs (removes all versions incl. live ones). Max build sizes: iOS/iPadOS/tvOS/visionOS 4 GB uncompressed app, 500 MB executable (`__TEXT` total); macOS 200 GB. https://developer.apple.com/help/app-store-connect/reference/app-uploads/maximum-build-file-sizes . Product page shows an "Up to" size including non-localized essential packs plus the largest single language's essential localized packs.
- TestFlight testing: internal testers automatic; external requires submitting the pack version to asset-pack review; local testing with `ba-serve` before upload.

### E6. iOS/macOS 27 (WWDC26, June 2026; GA fall 2026)

- Localized asset packs: manifest `language` (ISO-639 with optional script/region subtags; no variant subtags), `AssetPackManifest.localizedAssetPacks`, `resolvedLanguage`, `reconcilePreferredLanguages()`, "as localized for" accessors; the system selects the best-matching language pack and falls back to the primary language; `backgroundassets-debug --app-language-change` simulates language changes (OS 27+). Devices on earlier OS "won't receive localized asset packs". Testing available now in Xcode/TestFlight; general availability "this fall". https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs ; https://developer.apple.com/wwdc26/guides/app-store/
- On-Demand Resources deprecated: `NSBundleResourceRequest` `deprecatedAt: 27.0`, message "Use Background Assets instead." (Apple docs JSON). Apple also introduced a Steam Asset Converter (`xcrun ba-package convert ... .vdf`) and Unity plug-ins (Apple's `unityplugins` repo) exposing Background Assets and StoreKit as C# APIs (session 378 "Unlock in-game content with StoreKit and Background Assets"). The session's pattern: fetch products -> purchase -> verify -> check `Transaction.currentEntitlements` -> `ensureLocalAvailability` of the pack -> `finish()`. There is no Apple-supplied Godot equivalent, which is the gap the Polaris plugin fills.

### E7. Self-hosting on Polaris/R2 (what is documented vs not)

- Documented: unmanaged self-hosting (system downloads your manifest from `BAManifestURL` before launch; extension returns `BAURLDownload` requests; downloads honor `BADownloadDomainAllowList`; the app can also schedule downloads itself through `BADownloadManager` with any `URLRequest`, e.g. headers). Domain must be in the allow list; HTTPS only.
- Partially documented: managed self-hosting: `ManagedDownloaderExtension` + `AssetPackManifest.init(contentsOf:appGroupID:)` (JSON manifest decoding) + `allDownloads(for:)`; the WWDC25 talk explicitly defers self-hosting to docs. I could not find a public spec for the server-side protocol or manifest schema expected for managed self-hosted packs (beyond the `.aar` from `ba-package` and the `ba-serve` mock server). Treat "managed self-hosted with Polaris as origin" as a follow-up requiring reading Xcode 26/27 docs and reverse-engineering `ba-serve` traffic; do not build on it blindly.
- Design options with R2 [INFERENCE]: (a) Apple-hosted for App Store/TestFlight builds (preferred); (b) unmanaged BA extension pointing `BAManifestURL` at a public Polaris manifest and asset URLs on `dl.<domain>` for base/essential public content, and app-scheduled `BAURLDownload`s carrying a Polaris-issued token/signed URL for entitled packs (the extension cannot easily hold user auth; the manifest fetch has no per-user auth); (c) plain `URLSession` from the Godot plugin for macOS Developer ID and sideloaded/AltStore builds. R2 supports Range requests, which resumable system downloads rely on. Integrity: hash and signature in a Polaris manifest verified in the plugin before `load_resource_pack`.

### E8. How the Godot game consumes packs

[INFERENCE, plausible design; components verified individually]

1. Plugin (Swift; iOS xcframework + `.gdip`; macOS 26+ GDExtension or Godot-module-free dylib) exposes: `ba_list_packs()`, `ba_ensure_pack(id)`, signals `pack_progress(id, fraction)`, `pack_ready(id, absolute_path_or_dir)`, `pack_failed(id, reason)`, `ba_remove_pack(id)`, `ba_local_version(id)`, `ba_check_updates()`.
2. On each launch resolve the path fresh with `AssetPackManager.shared.url(for: "packs/diceroll-content.pck")` (do not persist the URL) off the main thread, and return `url.path` to GDScript; GDScript calls `ProjectSettings.load_resource_pack(path, true)` in an autoload `_init()` before loading dependent scenes. Patch PCKs are loaded after the base pack, layered.
3. Keep executable logic out of packs (section A3). Prefer one `.pck` per pack ID with unique path prefixes; use `onDemand` for paid DLC and gate `ba_ensure_pack` behind a verified StoreKit entitlement or Polaris entitlement.
4. Integration gap (needs verification): Background Assets needs a separate Background Download EXTENSION target plus App Groups on both targets. Godot's iOS export generates an Xcode project; the Godot docs and the plugin docs (`.gdip` supports libraries, frameworks, plist keys, capabilities, linker flags, copy files) do not describe adding app extension targets, and a search of godot-proposals found no proposal for it. Expect a CI post-export step that patches the exported `.xcodeproj` (xcodegen, Tuist, Ruby `xcodeproj`) to add the extension target (the ExtensionKit "Background Download" extension point that Xcode's template configures), its Info.plist, entitlements, and provisioning for two App IDs plus the app group (I did not verify the exact plist keys the Xcode template writes; generate a throwaway Xcode project from the template and copy its target as the source of truth). This is the biggest engineering risk for the first-class path.
5. Godot 4.7 is current (docs at 4.7; Godot iOS plugin for IAP v0.4.0 targets 4.7).

---

## F. Other current Apple technology (scope addition)

### F1. App Store Server API + Server Notifications V2 + signed transactions

Sources: https://developer.apple.com/documentation/appstoreserverapi , .../generating-json-web-tokens-for-api-requests , .../identifying-rate-limits , .../app-store-server-api-changelog (latest entry 1.22, 2026-09-28), https://developer.apple.com/documentation/appstoreservernotifications [APPLE]

- Auth: a separate key from the ASC API key (Apple: "Users and Access, then select the Keys tab"; it is the In-App Purchase key type, not the team ASC API key), JWT ES256, header `kid`, payload `iss` (issuer id), `iat`, `exp` (max 60 minutes; new token per request recommended), `aud: appstoreconnect-v1`, `bid` (bundle id). Domain: `https://api.storekit.apple.com` (recommended since 2026/05/05; old `api.storekit.itunes.apple.com` still works), sandbox `https://api.storekit-sandbox.apple.com`. Rate limits: per app, per endpoint; the table lists 50 requests/second for the transaction/notification endpoints, enforced hourly. TLS 1.2+.
- Endpoints relevant to Polaris: Get-Transaction-Info, Get-Transaction-History, Get-All-Subscription-Statuses, Get-Refund-History, Send-Consumption-Information (1.19), Finish-Transaction (1.20), Set-App-Account-Token (1.16), Look-Up-Order-ID, Get-Notification-History (180 days; 30 in sandbox), Request-a-Test-Notification / Get-Test-Notification-Status, Get-App-Transaction-Info (added 1.17, 2025-10-16).
- Notifications V2: POST to your HTTPS URL (production and sandbox URLs configurable; allow-list `17.0.0.0/8`); respond 200-206 on success, 50x/40x to retry; payload is a signed JWS (`signedPayload`) whose x5c chain must be validated to Apple's root. Types (23): CONSUMPTION_REQUEST, DID_CHANGE_RENEWAL_PREF, DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW, DID_RENEW, EXPIRED, EXTERNAL_PURCHASE_TOKEN, GRACE_PERIOD_EXPIRED, METADATA_UPDATE, MIGRATION, OFFER_REDEEMED, ONE_TIME_CHARGE, PRICE_CHANGE, PRICE_INCREASE, REFUND, REFUND_DECLINED, REFUND_REVERSED, RENEWAL_EXTENDED, RENEWAL_EXTENSION, RESCIND_CONSENT, REVOKE, SUBSCRIBED, TEST. For non-consumable DLC the ones that matter: ONE_TIME_CHARGE, REFUND, REVOKE, REFUND_REVERSED, CONSUMPTION_REQUEST (consumables).
- Library: Apple's open-source App Store Server Library in Swift, Java, Python and Node ("verifyAndDecodeTransaction", "verifyAndDecodeAppTransaction", "verifyAndDecodeRenewalInfo"); none is Workers-native, so plan a WebCrypto port or run verification in a small Node service [INFERENCE].
- Entitlement mapping: set `appAccountToken` (UUID) at purchase to tie a transaction to a Polaris user; `Set-App-Account-Token` fixes purchases made outside the app.

### F2. AppTransaction for license migration (paid-up-front to free/IAP)

- `AppTransaction` (StoreKit 2) / JWS via `Get-App-Transaction-Info`: `appAppleId, appTransactionId, bundleId, originalApplicationVersion, originalPlatform, originalPurchaseDate, preorderDate, receiptCreationDate, receiptType (environment), storeType (1.22)`, deviceVerification. `originalAppVersion` = CFBundleVersion on iOS-family, CFBundleShortVersionString on macOS. `appTransactionID` is globally unique per Apple Account and app (per family member with Family Sharing), stable across redownloads/refunds/storefront changes; back-deployed before iOS 18.4/macOS 15.4.
- Apple's pattern for business-model changes ("Supporting business model changes by using the app transaction"): compare `originalAppVersion` to a constant marking the version where the model changed and grant legacy premium features, then also iterate `Transaction.currentEntitlements` for IAPs. Sandbox/TestFlight always report `originalAppVersion` = "1.0", so do not trust it there. [APPLE] https://developer.apple.com/documentation/storekit/supporting-business-model-changes-by-using-the-app-transaction
- Polaris use: at first launch of a build with entitlement service enabled, the plugin obtains and verifies the app transaction (server side via the library or the endpoint), grants the legacy "owner" entitlement in Polaris keyed by `appTransactionId`, and stores it; Mac direct/Steam purchases get Polaris licenses by other means.

### F3. StoreKit 2 for paid content packs

- iOS: unlock via IAP (3.1.1); StoreKit 2 (`Product`, `Transaction.currentEntitlements`, `Transaction.updates`, `AppTransaction`), verified locally by the framework and re-verified by Polaris through the Server API or notifications. Apple Unity plug-in shows the exact flow to mirror in a Godot plugin. Advanced Commerce API (https://developer.apple.com/documentation/advancedcommerceapi) is for "exceptionally large catalogs of custom one-time purchases, subscriptions" and requires application; not needed for a small DLC set.
- Refunds/revocation: subscribe to Notifications V2 REFUND/REVOKE; remove server entitlement and let the client re-check `currentEntitlements` on launch.
- Cross-platform: 3.1.3(b) parity rule above. EU: alternative payment methods permitted on the App Store with commissions 20%/10% and 12-month commitment; marketplaces/Web Distribution: CTC 5%.
- US storefront: guideline 3.1.1(a) states the link-out entitlements are "not required" for US storefront apps. Litigation status [SECONDARY, verify before relying]: after the April 2025 contempt order, the Ninth Circuit (2025-12-11, https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple) upheld the contempt finding but held a total ban on commissions "overbroad and punitive" and remanded so Apple may charge a cost-based commission for link-outs; later reports (Courthouse News, tech-insider) say the Supreme Court declined an emergency stay in May 2026, that zero commission continues pending remand, and that Apple filed its merits brief on 2026-09-14. So a US web-checkout link for Polaris licenses is currently permitted with no Apple commission but legal risk remains.

### F4. Identity: Sign in with Apple, passkeys

- Sign in with Apple REST: token endpoint `POST https://appleid.apple.com/auth/token` with `client_id`, `client_secret` (an ES256 JWT you sign), `code`/`refresh_token`, `grant_type`; returns `id_token`, access and refresh tokens. https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens [APPLE]. (Public keys for verifying `id_token` at appleid.apple.com/auth/keys and the token-revocation endpoint are standard but were not re-verified in this session.)
- Guideline consequences: if Polaris accounts are the only login, 4.8 does not require SIWA; if you add Google/other social login you must offer an equivalent privacy-preserving option (SIWA); apps with account creation must offer in-app account deletion (5.1.1(v)) and, if SIWA is used, revoke tokens on delete [last part: standard requirement, not re-verified here].
- Passkeys (AuthenticationServices/WebAuthn) are a platform feature for the Polaris web console/iOS app; they need Associated Domains and a native plugin in Godot; low priority for the game SDK; the console can use WebAuthn independent of Apple.

### F5. App Attest (device integrity) to bind a Polaris device token

- `DCAppAttestService` (iOS 14+, macOS 11+, tvOS 15+, visionOS, watchOS 9+): generate a hardware-backed key per user per device, attest it (server supplies a one-time challenge >= 16 bytes; app sends SHA-256 client-data hash), server verifies the attestation object (RP ID = hash of App ID i.e. team prefix + bundle id; `counter`; `aaguid` distinguishing development vs production environment; Apple attestation chain), stores the key id + public key, then later verifies assertions (signed requests) for sensitive calls such as license activation or premium content download. "The keys ... don't survive app reinstallation, device migration, or restoration of a device from a backup" so re-attest. Requires the App ID registered with Apple and the `com.apple.developer.devicecheck.appattest-environment` entitlement. https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity and .../validating-apps-that-connect-to-your-server [APPLE]
- Sideloaded builds (AltStore/SideStore re-sign with a different team and bundle id) would not attest against your App ID [INFERENCE]; apply weaker trust for that channel. Store challenges with TTL in a Durable Object/KV.

### F6. Game Center / Apple Games app

- Apple's WWDC26 App Store guide highlights the Apple Games app (in-game offers, featured sales via In-App Events, new badges; US first). Game Center provides leaderboards/achievements; API 4.2+ supports versioned achievements/leaderboards submitted for review independently. Not needed for licensing; optional discovery/social surface. Note Apple's AppDistributor doc says Game Center is unavailable for apps only on alternative marketplaces. https://developer.apple.com/wwdc26/guides/app-store/

### F7. CI: Xcode Cloud vs GitHub Actions

- Xcode Cloud: 25 compute hours/month included with the Developer Program, tiers at US$49.99 (100 h), US$99.99 (250 h), US$399.99 (1000 h); unused hours do not roll over; Xcode 15+. https://developer.apple.com/xcode-cloud/get-started/ [APPLE]. It builds Xcode projects/workflows; running Godot editor export as a pre-step is possible via custom scripts but I did not verify this [unverified]. ASC API exposes Xcode Cloud resources (`ciWorkflows`, build runs) and those GET-only scoped tokens can be long-lived (see JWT section).
- GitHub Actions hosted macOS runners: `macos-26` (arm64) and `macos-26-intel`, `macos-15`, `macos-15-intel`, `macos-14`, and an `xcode-27` runner in public preview per GitHub docs (https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Recommended: keep GitHub Actions (existing pipeline; Godot toolchain; Linux for `ba-package`, PCK export, ASC API uploads via `iTMSTransporter`/API) and use a macOS runner only for xcodebuild archive/export, signing, notarization, stapling.

### F8. notarytool and EU Web Distribution/marketplaces

Covered in C3 and A5.

---

## G. Implications for Polaris Key and the Godot SDK (synthesis)

Server (Cloudflare Worker) responsibilities [INFERENCE from the above]

1. Apple integration module: ASC API client (ES256 JWT via WebCrypto, token cache <= 20 min, `X-Rate-Limit` handling), webhook receiver (`x-apple-signature`), channel bridge mapping Apple states to Polaris channels: `appstore` (READY_FOR_DISTRIBUTION), `appstore-phased` (phasedReleaseState + currentDayNumber, polled), `testflight` (external build state), `testflight-internal` (poll), `content:<packId>` (background asset states), plus polling reconciliation.
2. Feeds: `/version` JSON (add `store` block with App Store URL, min/recommended/latest per channel, phased-release day), AltStore/SideStore sources (two flavours + PAL), Sparkle appcasts (channels, phased rollout, min OS, arm64, auto-update floor for paid majors), pack manifests for gateway-hosted packs.
3. Files/gateway: IPA, DMG/zip/delta, ADP (byte-exact), pack `.pck`/`.aar` (if not Apple-hosted) on R2 with Range support; per-user secret source URLs; entitlement-checked signed URLs for paid packs.
4. Entitlements: App Store Server Notifications V2 receiver + App Store Server API client (JWS verification), `appAccountToken` mapping, `appTransactionId` legacy-owner migration; App Attest challenge/verify endpoints; Polaris license for non-Apple channels.
5. CI contract: CI signs (Sparkle EdDSA, notarization via `notarytool` or Notary API, codesign), uploads (ASC builds via API/Transporter, asset packs via API), and posts metadata/signatures to Polaris; Polaris never holds Sparkle's private key or Developer ID certs.

Godot SDK

- Pure GDScript: `/version` polling, update UI, pack download/verify for non-Apple channels, `load_resource_pack`, Polaris license/activation over HTTPS, source deep-link generation for AltStore/SideStore.
- Native plugins: iOS (Swift, xcframework + .gdip): `AppDistributor`, StoreKit 2 (`Product`, entitlements, `AppTransaction`), Background Assets wrapper, App Attest, optional TestFlight/environment heuristic; macOS (GDExtension/dylib): Sparkle wrapper, channel selection, StoreKit/BA for MAS build.
- Build variants: App Store/TestFlight (BA extension + StoreKit + attest), sideload IPA (lean, no extensions, gateway downloads), macOS Developer ID (Sparkle), macOS MAS (sandbox, no Sparkle).

Open questions / things I could not verify

1. Public spec for managed self-hosted asset-pack servers (manifest schema/protocol); whether Background Assets install-time triggers work for Developer ID Mac apps or sideloaded iOS apps.
2. Godot iOS export support for adding an app-extension target; likely needs post-export project patching.
3. Japan and Brazil marketplace commission rates and requirements (Apple pages not fetched).
4. AltStore behaviour for signed-URL expiry and any header-based auth (undocumented).
5. Current status of SCOTUS/Epic proceedings (secondary sources only).
6. Whether Sparkle's `sign_update`/`generate_appcast` `--ed-key-file` flags (with `-` for stdin) are current (widely used in CI write-ups, not on the docs pages fetched).
7. `AppTransaction.environment` for TestFlight (community says `.sandbox`; Apple has no explicit statement in the pages fetched).

---

## Source list (URLs fetched or cited)

Apple, App Store Connect API

- https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
- https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api
- https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits
- https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-release-notes (4.0 to 4.5 pages)
- https://developer.apple.com/documentation/appstoreconnectapi/webhook-notifications
- https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications
- https://developer.apple.com/documentation/appstoreconnectapi/webhook-events
- https://developer.apple.com/documentation/appstoreconnectapi/webhookeventtype
- https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks
- https://developer.apple.com/documentation/appstoreconnectapi/builds , /build-uploads , /beta-groups , /beta-testers , /beta-build-localizations , /beta-app-review-submissions , /build-beta-notifications , /app-store-versions , /app-store-version-localizations , /review-submissions , /review-submission-items , /app-store-version-release-requests , /app-store-version-phased-releases
- https://developer.apple.com/documentation/appstoreconnectapi/background-assets , /managing-apple-hosted-background-assets
- https://developer.apple.com/documentation/appstoreconnectapi/alternative-distribution-packages , /alternative-distribution-keys , /alternative-distribution-domains
- https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases
- https://developer.apple.com/wwdc25/ session 324: https://developer.apple.com/videos/play/wwdc2025/324/
  Apple, TestFlight and Background Assets
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- https://developer.apple.com/documentation/backgroundassets and /creating-managed-asset-packs , /downloading-apple-hosted-asset-packs , /testing-asset-packs-locally , /configuring-an-unmanaged-background-assets-project , /reducing-download-and-storage-demands-with-localized-asset-packs , /assetpackmanager , /manageddownloaderextension , /assetpackmanifest
- https://developer.apple.com/documentation/bundleresources/information-property-list/baappgroupid , /bahasmanagedassetpacks , /bausesapplehosting , /bamanifesturl , /bainitialdownloadrestrictions , /baessentialmaxinstallsize , /bamaxinstallsize
- https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs , /upload-apple-hosted-asset-packs ; https://developer.apple.com/help/app-store-connect/reference/app-uploads/apple-hosted-asset-pack-size-limits , /apple-hosted-asset-pack-statuses , /maximum-build-file-sizes
- https://developer.apple.com/videos/play/wwdc2025/325/ ; https://developer.apple.com/videos/play/wwdc2026/378/ ; https://developer.apple.com/wwdc26/guides/app-store/
- https://keith.github.io/xcode-man-pages/backgroundassets-debug.1.html ; https://developer.apple.com/documentation/foundation/nsbundleresourcerequest
- Forums: https://developer.apple.com/forums/thread/807154 , /793565 , /805140
  Apple, policy
- https://developer.apple.com/app-store/review/guidelines/ (Last Updated June 8, 2026)
- https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
- https://developer.apple.com/support/dma-and-apps-in-the-european-union/ , /alternative-app-marketplace-in-the-eu/ , /web-distribution-eu/ , /alt-distribution-ux-in-the-eu/
- https://developer.apple.com/help/app-store-connect/managing-alternative-distribution/manage-distribution-on-an-alternative-app-marketplace
- https://developer.apple.com/documentation/marketplacekit/appdistributor
  Apple, StoreKit/Server/other
- https://developer.apple.com/documentation/appstoreserverapi (+ /generating-json-web-tokens-for-api-requests, /identifying-rate-limits, /get-app-transaction-info, /app-store-server-api-changelog, /simplifying-your-implementation-by-using-the-app-store-server-library)
- https://developer.apple.com/documentation/appstoreservernotifications (+ /enabling-app-store-server-notifications, /notificationtype)
- https://developer.apple.com/documentation/storekit/apptransaction (+ /environment, /originalappversion, /apptransactionid), /supporting-business-model-changes-by-using-the-app-transaction, https://developer.apple.com/documentation/storekit/appstore/environment
- https://developer.apple.com/documentation/advancedcommerceapi
- https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity , /validating-apps-that-connect-to-your-server
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution , /customizing-the-notarization-workflow ; https://developer.apple.com/documentation/notaryapi and /submitting-software-for-notarization-over-the-web
- https://developer.apple.com/xcode-cloud/get-started/
- https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html , /Searching.html
- Forums: https://developer.apple.com/forums/thread/775313 , /725780 , /760977 , /729695 , /791170 , /704156
  AltStore / SideStore
- https://faq.altstore.io/developers/make-a-source.md , /updating-apps.md , /distribute-with-altstore-pal.md , /distribute-with-altstore-classic.md , /rest-api.md , /fees.md , /download-on-altstore-badge.md , /patreon-integration ; https://faq.altstore.io/altstore-classic/app-ids.md , /trusted-sources.md , /your-altstore ; https://faq.altstore.io/altstore-pal-v.-altstore-classic.md ; https://faq.altstore.io/llms-full.txt
- https://docs.sidestore.io/docs/advanced/app-sources , /url-schema , /faq ; https://github.com/SideStore/SideStore/issues/735 ; https://github.com/SideStore/SideStore/releases
- https://www.macrumors.com/2025/12/18/altstore-japan-launch/ ; https://dev.to/temer/how-we-distribute-an-ios-app-outside-the-app-store-a-practical-altstore-pal-walkthrough-33li
  Sparkle
- https://sparkle-project.org/documentation/ , /publishing/ , /delta-updates/ , /package-updates/ , /sandboxing/ , /upgrading/ ; https://github.com/sparkle-project/Sparkle/releases.atom
  Godot
- https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html , /exporting_for_ios.html , /exporting_for_macos.html , https://docs.godotengine.org/en/stable/tutorials/platform/ios/ios_plugin.html
- https://github.com/hrk4649/godot_ios_plugin_iap , https://github.com/atlasapplications/godot-store-kit (via search result summary)
  Other
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple ; Courthouse News and tech-insider articles (secondary; not individually fetched)
- https://www.theswift.dev/posts/migrate-on-demand-resources-to-localized-managed-background-assets/ (June 17, 2026; secondary)

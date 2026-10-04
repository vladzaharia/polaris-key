> Research note for [Godot on Polaris Key](../README.md), 2026-10-04. Spike S-14, commissioned
> by the lead for **A-17** (app provisioning and distribution through the App Store Connect API)
> on the owner's direction of 2026-10-04: "Do any API things yourself in the actual app to make it
> as seamless as possible to create new apps and distribute them. You have an admin key; it
> should be able to do pretty much anything." Like S-13, it has no program brief: A-17 sits in
> the admin namespace beside A-11 to A-16, so the breakdown in §10 proposes `A-17a…` ids there.
> Research and design only. No product code changed, and **nothing was created, modified or
> deleted in the owner's Apple account**: every live call was a `GET`, and the enum lists came
> from invalid filter values that the API rejects with a 400. File references are to the tree at
> `6473153c` (`W/` = `packages/worker/`, `A/` = `packages/admin/src/`) and, for A-16, to the
> uncommitted work in its worktree on 2026-10-04.

# S-14: provisioning and distributing apps through the App Store Connect API

Evidence tags, as in the other notes:

- **[V]**: primary source read raw: Apple's published App Store Connect OpenAPI document
  (version 4.5, file dated 2026-09-22, SHA-256 `1e8ef250…6927b2`), Apple's documentation pages
  (fetched as their JSON on 2026-10-04), and this repo's code;
- **[M]**: measured here against the live API with the owner's team key, read-only;
- **[S]**: secondary or summary (Apple help pages paraphrased from memory, community tooling);
- **[U]**: unverified: needs a write in the owner's account (§11 lists each);
- **[I]**: inference or recommendation.

## 1. Question

The owner wants Polaris Key itself to create and ship App Store apps with as few trips to App
Store Connect as possible. A-16 (in progress) adds a platform-wide team connection: it lists
every app the team key sees, assigns an app to a product by setting the per-product pin, and
holds the team's In-App Purchase key and Team ID. This spike answers:

1. What does the App Store Connect API allow, and what stays portal-only? It covers app records,
   bundle ids and capabilities, profiles and certificates, the App Store Server Notifications URL,
   in-app purchases, TestFlight, App Store versions and review, Background Assets, users and
   keys, and rate limits, idempotency and failure modes.
2. What console flows does that support? A **New app** wizard (Platform → Store connections), a
   **Distribute** flow (a product's Distribution section), and IAP creation from P6-01's commerce
   mappings.
3. How does each write stay platform-admin, audited with before and after, idempotent and
   pin-bounded, within rules 6 and 10?
4. What does the threat model gain, and which operations must never be reachable?
5. What is the work-package breakdown, and what must the owner decide?

## 2. Short answer

- **Almost everything after the app record is API-possible.** The only blocking gap is that
  **`POST /v1/apps` does not exist**: the spec's `/v1/apps` has `GET` only and `/v1/apps/{id}`
  has `GET, PATCH`, with no `DELETE` [V]. Apple's documentation page for creating an app does not
  exist either (404) [V]. The wizard registers the bundle id and capabilities through the API,
  hands the operator a deep link with the exact values to paste, then **polls
  `GET /v1/apps?filter[bundleId]=…` until the app appears** and carries on by itself [I].
- **The ASN URL can be set per app through the API.** `AppUpdateRequest` accepts
  `subscriptionStatusUrl`, `subscriptionStatusUrlVersion` (`V1`/`V2`), and the same two for
  sandbox [V]. A live read returns all four attributes, null today, on each of the team's 3 apps
  [M]. The wizard writes P6-01's own endpoint
  (`https://key.plrs.im/<product>/distribution/hooks/app-store`, `V2`, both environments). It then
  proves delivery with the App Store Server API's **Request a Test Notification**, using the
  team's IAP key [V]. Whether a `PATCH` is accepted is **[U]**; the fallback is a deep link to App
  Information with the URL ready to copy.
- **Bundle ids and capabilities are API-possible, with two gaps.**
  - **App Attest is not in the documented `CapabilityType` enum.** The live API already returns
    types the spec lacks (`DEVICE_DISCOVERY_PAIRING`, `MUSIC_KIT`) [M], so the enum is
    incomplete, but App Attest is **[U]**. Xcode's App Attest capability only writes an
    entitlement [V], so App Attest probably needs nothing on the App ID. A-17h verifies this.
  - **App Groups and iCloud** can be switched on, but their group and container identifiers have
    no API resource. Assigning them is portal-only [V][M].
- **Capability ids are deterministic:** `<bundleIdResourceId>_<CAPABILITY_TYPE>` [M]. That makes
  "enable" idempotent through read-before-write.
- **IAPs are fully API-possible, except the first submission.** That covers create, version and
  localizations, price schedule, availability, and submission through `reviewSubmissions` [V].
  Apple's guide says the **first** IAP must be submitted with an app binary through the website;
  later IAPs go through the API [V]. P6-01 grants non-consumables only, so A-17 creates only
  `NON_CONSUMABLE` [I].
- **TestFlight and App Store release are fully API-possible:**
  - beta groups, testers, adding a build to groups, beta localizations and export compliance;
  - beta review (`POST /v1/betaAppReviewSubmissions`);
  - version create and patch, setting the build, localizations (`whatsNew`) and release type
    (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`);
  - phased release, submission (`reviewSubmissions` → items → `submitted: true`), cancellation,
    and manual release [V].

  A new **build-upload API** (`/v1/buildUploads`, `/v1/buildUploadFiles`) is live: the team's
  latest uploads show per-upload warnings [M].

- **Portal-only, with no API at all** [V], by absence from the 973 paths:
  - creating the app record;
  - creating or downloading **API keys**;
  - **App Privacy** details;
  - agreements, tax and banking;
  - App Group and iCloud container identifiers.
- **The dangerous operations are all API-reachable with the owner's Admin key.** The API can:
  - invite and delete users and change their roles (`/v1/users`, `/v1/userInvitations`);
  - create and revoke certificates, including `DEVELOPER_ID_APPLICATION(_G2)`;
  - delete bundle ids, profiles and capabilities;
  - change prices.

  Apple's own guide says an Admin key "can do things like create new users and delete users". A
  team key reaches every app whatever its role [V].

- **Recommended scope:** a code-level **allow-list** of `(method, path template, attributes)`
  checked before a token is minted. No generic proxy. Never: users, invitations, certificates,
  profile or bundle-id deletes, capability deletes, devices, merchant and pass ids, `apps.bundleId`
  edits, or IAP and subscription deletes. Approved by the owner on 2026-10-04, together with
  the **existing Admin key** in the Worker. The gate is therefore the only barrier, and its CI
  classification of every spec write is mandatory (§12).
- **Budget: 3,600 requests per rolling hour, per key** [M] (`user-hour-lim:3600`; Apple's docs
  give 3,500 as an example [V]). Every product that falls back to the team key shares this one
  bucket with the P5-02 poller. A-17a adds a shared budget meter.
- **No idempotency keys in the API** (no occurrence in the spec) [V]. Every write gets a Polaris
  Key operation ledger plus a natural-key read-before-write (§7.3).

## 3. Method

1. Read `AGENTS.md` (rules 5, 6 and 10), ADMIN.md §2.3, §5.2, §6.4 and §7, S-13 (the house style
   and the A-namespace), and the existing ASC code:
   - P5-02's connector (`W/src/services/distribution/connectors/asc/{client,controls,setup,poll,apply,map}.ts`);
   - P5-01's custody (`W/src/core/outletCredentials.ts`);
   - P6-01's commerce bridge (`W/src/services/distribution/commerce/{apple,index}.ts`,
     `W/migrations/0052_commerce.sql`);
   - the admin authorization model (`W/src/admin/authz.ts`);
   - the threat model's A11 and connector sections;
   - A-16's uncommitted migration `0055_platform_store_connections.sql` and
     `core/platformCredentials.ts` in `pk-wt/A-16`.
2. Downloaded Apple's OpenAPI document [V]:

   ```sh
   curl -sSLo spec.zip https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
   unzip spec.zip   # openapi.oas.json, 7,228,462 bytes, info.version 4.5
   node S-14-asc-provisioning/scan-spec.mjs openapi.oas.json
   ```

   It enumerates methods per path, the attributes and relationships of every relevant
   `*CreateRequest` and `*UpdateRequest`, the enums, the list filters usable as natural keys, and
   whether an idempotency mechanism or 409/422 responses exist.

3. Fetched Apple's documentation pages as JSON
   (`https://developer.apple.com/tutorials/data/documentation/<path>.json`) on 2026-10-04 [V]:
   - _Identifying rate limits_;
   - _Creating API keys for App Store Connect API_;
   - _Modify an app_ (`patch-v1-apps-_id_`);
   - _Managing In-App Purchases_;
   - _Review submissions_;
   - _Build uploads_;
   - _Background assets_;
   - `CapabilityType`;
   - _Create a bundle ID capability_;
   - _Enabling App Store Server Notifications_;
   - _Request a Test Notification_;
   - _Establishing your app's integrity_;
   - the `com.apple.developer.devicecheck.appattest-environment` entitlement.

   `post-v1-apps` returned 404.

4. Live probes with `S-14-asc-provisioning/probe.mjs` (GET-only by construction), Node 22.13.1,
   macOS, from Canada, 2026-10-04 01:2x local time. 38 requests in total; the remaining budget went
   from 3,595 to 3,559. Latency was 128–722 ms, median about 190 ms [M]:

   ```sh
   node probe.mjs apps '/v1/apps?fields[apps]=name,bundleId,sku,subscriptionStatusUrl,subscriptionStatusUrlVersion,subscriptionStatusUrlForSandbox,subscriptionStatusUrlVersionForSandbox'
   node probe.mjs caps '/v1/bundleIds?limit=50&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType,settings'
   node probe.mjs badPlatform '/v1/bundleIds?filter[platform]=BOGUS'      # → 400 with the live enum
   # … certificates, profiles, betaGroups, builds, appStoreVersions, reviewSubmissions,
   #   inAppPurchasesV2, subscriptionGroups, webhooks, backgroundAssets, users (roles only),
   #   userInvitations, territories, buildUploads, appInfos, appAvailabilityV2, appPriceSchedule,
   #   betaAppReviewDetail, betaAppLocalizations, and seven more invalid-filter enum probes
   ```

   Bodies stayed in a git-ignored `out/`. The note reports counts and shapes only: no app names,
   no user or tester data, no key ids.

## 4. Capability table

**API** means a documented endpoint does it. **Portal** means no endpoint exists, so the console
gives a deep link plus the values to paste. Deep-link URL shapes are not documented by Apple and
are **[I]**; A-17f keeps them in one constant table so a broken link is a one-line fix.

| Area                     | Operation                                                                        | Status                     | Evidence                                                                                                                                                                                                               | A-17 exposes?                                                    |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| App record               | Create                                                                           | **Portal**                 | `/v1/apps`: `GET` only; no doc page [V]                                                                                                                                                                                | Deep link + auto-detect by `filter[bundleId]`                    |
| App record               | Delete                                                                           | **Portal**                 | no `DELETE /v1/apps/{id}` [V]                                                                                                                                                                                          | Never                                                            |
| App record               | Edit `bundleId`, `primaryLocale`, `contentRightsDeclaration`, `accessibilityUrl` | API                        | `AppUpdateRequest` [V]                                                                                                                                                                                                 | `bundleId` **never**; the others no (not needed)                 |
| ASN URL                  | Set production and sandbox URL and version                                       | API **[U]**                | `AppUpdateRequest.subscriptionStatusUrl*`, enum `V1,V2` [V]; attributes readable, null on all 3 apps [M]                                                                                                               | Yes, only these four attributes                                  |
| ASN URL                  | Prove delivery                                                                   | API (App Store Server API) | `POST /inApps/v1/notifications/test`, then the status call [V]                                                                                                                                                         | Yes (IAP key)                                                    |
| Bundle id                | List, find by identifier, register                                               | API                        | `GET/POST /v1/bundleIds`, `filter[identifier]` [V]; 46 ids, platforms `UNIVERSAL` 30, `IOS` 13, `SERVICES` 2, `MAC_OS` 1 [M]; create enum `IOS, MAC_OS, UNIVERSAL` [V][M]                                              | Yes                                                              |
| Bundle id                | Rename / delete                                                                  | API                        | `PATCH/DELETE /v1/bundleIds/{id}` [V]                                                                                                                                                                                  | **Never**                                                        |
| Capabilities             | Enable, with settings                                                            | API                        | `POST /v1/bundleIdCapabilities` [V]; id = `<bundleIdResourceId>_<TYPE>` [M]                                                                                                                                            | Yes                                                              |
| Capabilities             | Disable                                                                          | API                        | `DELETE /v1/bundleIdCapabilities/{id}` [V]                                                                                                                                                                             | **Never** (portal)                                               |
| Capabilities             | In-App Purchase                                                                  | API                        | on 41 of 46 ids [M]                                                                                                                                                                                                    | Yes (usually already on)                                         |
| Capabilities             | Push, Sign in with Apple, Game Center, Associated Domains                        | API                        | enum [V]; `PUSH_NOTIFICATIONS`, `APPLE_ID_AUTH` (with a `settings` consent option), `ASSOCIATED_DOMAINS` seen live [M]                                                                                                 | Yes                                                              |
| Capabilities             | App Groups, iCloud: switch on                                                    | API                        | `APP_GROUPS` (settings null), `ICLOUD` (`ICLOUD_VERSION`) [M]                                                                                                                                                          | Yes                                                              |
| Capabilities             | App Group / iCloud container ids and assignment                                  | **Portal**                 | no resource in 973 paths [V]                                                                                                                                                                                           | Deep link                                                        |
| Capabilities             | App Attest                                                                       | **[U]**                    | not in `CapabilityType` [V]; live list wider than the spec [M]; the entitlement is set in the app target [V]                                                                                                           | Nothing on the App ID unless A-17h finds one                     |
| Push keys (APNs `.p8`)   | Create                                                                           | **Portal**                 | no keys resource [V]                                                                                                                                                                                                   | Out of scope                                                     |
| Certificates             | List                                                                             | API                        | 6 certs, 5 types [M]; 18-value enum incl. `DEVELOPER_ID_APPLICATION_G2` [V][M]                                                                                                                                         | Read-only (expiry warnings)                                      |
| Certificates             | Create (CSR) / revoke                                                            | API                        | `POST /v1/certificates`, `DELETE /v1/certificates/{id}` [V]                                                                                                                                                            | **Never**                                                        |
| Profiles                 | List / create / delete                                                           | API                        | `GET/POST /v1/profiles`, `DELETE /{id}`; 14 profile types [V][M]                                                                                                                                                       | Read-only; create is a later option (§8.3); delete never         |
| Devices                  | Register / enable                                                                | API                        | `/v1/devices` [V]                                                                                                                                                                                                      | **Never**                                                        |
| TestFlight               | Beta groups: create, edit, public link, delete                                   | API                        | `BetaGroupCreateRequest` (`isInternalGroup`, `hasAccessToAllBuilds`, public link fields) [V]; 2 internal groups on the probed app [M]                                                                                  | Create + edit; delete never                                      |
| TestFlight               | Testers: invite, add/remove from groups                                          | API                        | `POST /v1/betaTesters` (email), `…/relationships/betaTesters` [V]                                                                                                                                                      | Add only; remove from a group yes; delete tester never           |
| TestFlight               | Add a build to groups                                                            | API                        | `POST /v1/betaGroups/{id}/relationships/builds` [V]                                                                                                                                                                    | Yes                                                              |
| TestFlight               | What-to-test notes                                                               | API                        | `betaBuildLocalizations` (`whatsNew`, `locale`) [V]                                                                                                                                                                    | Yes                                                              |
| TestFlight               | Beta app review details and localizations                                        | API                        | `betaAppReviewDetails` (incl. `demoAccountPassword`), `betaAppLocalizations` [V][M]                                                                                                                                    | Read for preflight; edit no (deep link); password never relayed  |
| TestFlight               | Submit for beta review                                                           | API                        | `POST /v1/betaAppReviewSubmissions` (build) [V]; states `WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, APPROVED` [M]                                                                                                        | Yes                                                              |
| Builds                   | Processing state, expiry, audience                                               | API                        | `processingState` `PROCESSING, FAILED, INVALID, VALID` [V][M]; `expired`, `buildAudienceType` [M]                                                                                                                      | Read                                                             |
| Builds                   | Export compliance                                                                | API                        | `BuildUpdateRequest.usesNonExemptEncryption`, `appEncryptionDeclarations` [V]                                                                                                                                          | Set the boolean only                                             |
| Builds                   | Expire a build                                                                   | API                        | `BuildUpdateRequest.expired` [V]                                                                                                                                                                                       | No (portal)                                                      |
| Builds                   | Upload (no Transporter)                                                          | API                        | `/v1/buildUploads`, `/v1/buildUploadFiles`, event `BUILD_UPLOAD_STATE_UPDATED` [V]; 3 uploads read, `state: COMPLETE` with warnings [M]                                                                                | Read state; uploads stay in CI (P5-04)                           |
| App Store                | Create a version; set build, release type, earliest date                         | API                        | `AppStoreVersionCreateRequest` / `UpdateRequest` (`releaseType`, `earliestReleaseDate`, `build`) [V]; probed version `PREPARE_FOR_SUBMISSION`, `AFTER_APPROVAL` [M]                                                    | Yes                                                              |
| App Store                | Version localizations (`whatsNew`, description, keywords, URLs)                  | API                        | `appStoreVersionLocalizations` [V]                                                                                                                                                                                     | `whatsNew` and `promotionalText` only                            |
| App Store                | Screenshots, previews                                                            | API                        | `appScreenshotSets`, `appScreenshots` (reserve, PUT, commit) [V]                                                                                                                                                       | No (v1); preflight reads presence                                |
| App Store                | Age rating, review contact, EULA, categories                                     | API                        | `ageRatingDeclarations`, `appStoreReviewDetails`, `endUserLicenseAgreements`, `appInfos` [V]                                                                                                                           | Preflight read; edits via deep link                              |
| App Store                | Pricing and availability                                                         | API                        | `POST /v1/appPriceSchedules`, `POST /v2/appAvailabilities` [V]; a new app has no availability yet (404) [M]                                                                                                            | Wizard default: free, all territories (175 [M])                  |
| App Store                | **App Privacy** labels                                                           | **Portal**                 | no resource [V]                                                                                                                                                                                                        | Deep link + "confirmed" tick                                     |
| App Store                | Submit for review                                                                | API                        | `reviewSubmissions` → `reviewSubmissionItems` → `PATCH submitted: true`; `platform` no longer required [V]; states `READY_FOR_REVIEW … COMPLETE` [M]                                                                   | Yes                                                              |
| App Store                | Cancel a submission                                                              | API                        | `ReviewSubmissionUpdateRequest.canceled` [V]                                                                                                                                                                           | Yes                                                              |
| App Store                | Phased release: create / pause / resume / complete                               | API                        | `appStoreVersionPhasedReleases`; P5-02 has pause, resume, complete (`controls.ts`) [V]                                                                                                                                 | Add create                                                       |
| App Store                | Manual release                                                                   | API                        | `POST /v1/appStoreVersionReleaseRequests`; P5-02 has it [V]                                                                                                                                                            | Existing                                                         |
| IAP                      | Create (`CONSUMABLE`, `NON_CONSUMABLE`, `NON_RENEWING_SUBSCRIPTION`)             | API                        | `POST /v2/inAppPurchases` [V][M]                                                                                                                                                                                       | `NON_CONSUMABLE` only                                            |
| IAP                      | Version + localizations                                                          | API                        | `POST /v1/inAppPurchaseVersions`, `POST /v2/inAppPurchaseLocalizations`; v1 localizations deprecated in 4.4.1 [V]                                                                                                      | Yes (v2 path)                                                    |
| IAP                      | Price                                                                            | API                        | `GET /v2/inAppPurchases/{id}/pricePoints`, `POST /v1/inAppPurchasePriceSchedules`; "once a price increase goes into effect, your change can't be reverted" [V]                                                         | Initial price yes; changes typed-confirm                         |
| IAP                      | Availability                                                                     | API                        | `/v1/inAppPurchaseAvailabilities` [V]                                                                                                                                                                                  | Yes (all territories)                                            |
| IAP                      | Review screenshot                                                                | API                        | reserve → PUT → commit [V]                                                                                                                                                                                             | Later (v1: deep link)                                            |
| IAP                      | Submit the **first** IAP                                                         | **Portal**                 | "Submit your first In-App Purchase together with an app binary submission through appstoreconnect.apple.com" [V]                                                                                                       | Deep link                                                        |
| IAP                      | Submit later IAPs                                                                | API                        | `reviewSubmissionItems.inAppPurchaseVersion`; `inAppPurchaseSubmissions` deprecated in 4.4.1 [V]                                                                                                                       | Yes, inside Distribute                                           |
| IAP                      | Delete                                                                           | API                        | `DELETE /v2/inAppPurchases/{id}` [V]                                                                                                                                                                                   | **Never**: product ids cannot be reused [S]                      |
| Subscriptions            | Groups, subscriptions, prices, submission                                        | API                        | `subscriptionGroups`, `subscriptions`, `subscriptionPrices`, `subscriptionVersions` [V]                                                                                                                                | No: P6-01 does not grant subscriptions                           |
| ASC webhooks             | Register / ping                                                                  | API                        | `POST /v1/webhooks`, 12 event types [V]; P5-02 control [V]                                                                                                                                                             | Existing; the wizard calls it                                    |
| Background Assets        | Create pack, version, upload files, release states, submit                       | API                        | `backgroundAssets`, `backgroundAssetVersions`, `backgroundAssetUploadFiles`, three release resources, `reviewSubmissionItems.backgroundAssetVersion`, four webhook events [V]; roles Admin, App Manager, Developer [V] | Add BA versions to Distribute's submission; uploads stay P5-08   |
| Users                    | List, invite, change roles, delete                                               | API                        | `/v1/users` `GET, PATCH, DELETE`, `/v1/userInvitations` `GET, POST, DELETE`; 13 roles [V][M]                                                                                                                           | **Never** (not even read: personal data)                         |
| API keys                 | Create, revoke, download                                                         | **Portal**                 | no resource; keys are generated under Users and Access → Integrations [V]                                                                                                                                              | Deep link in the connection page                                 |
| Agreements, tax, banking | Accept / edit                                                                    | **Portal**                 | no resource [V]                                                                                                                                                                                                        | Deep link; preflight says paid IAPs need the Paid Apps agreement |
| Merchant / Pass Type ids | CRUD                                                                             | API                        | `/v1/merchantIds`, `/v1/passTypeIds` [V]                                                                                                                                                                               | **Never**                                                        |

## 5. Facts that shape the design

### 5.1 The app record gap, and how the wizard closes it

There is no create-app endpoint in the 4.5 spec [V]. Third-party tooling creates apps through
the private web session of an Apple ID with two-factor authentication [S]. Polaris Key must
**not** do that: it would mean holding a person's Apple ID credentials, and it is not a supported
interface [I].

Instead, the wizard runs these steps:

1. Register the bundle id through the API, so it appears in App Store Connect's **New App**
   dropdown.
2. Show the four values to type (name, primary language, bundle id and SKU), each with a copy
   button, and a deep link to `https://appstoreconnect.apple.com/apps` [I].
3. Poll `GET /v1/apps?filter[bundleId]=<id>` every 10 s while the page is open, for up to
   15 minutes, plus an "I've created it" button that polls once. A miss costs one request and
   returns `[]` [M].
4. On a hit, continue without further input: pin, ASN URL, TestFlight group.

The polling cost is at most 90 requests per wizard run, against a 3,600-per-hour budget [I].

### 5.2 Capabilities

- **The capability id is a function of its inputs.** On every bundle id read, each capability
  id is the bundle id's resource id plus `_` plus its type (`…_IN_APP_PURCHASE`,
  `…_PUSH_NOTIFICATIONS`) [M]. "Enable X" is `GET /v1/bundleIds/{id}/bundleIdCapabilities`,
  then `POST` only for the types that are missing. A retry after an ambiguous failure re-reads
  first.
- **The spec's enum is a floor, not a ceiling.** The live API returns `DEVICE_DISCOVERY_PAIRING`
  and `MUSIC_KIT`, neither of which is in the 28-value `CapabilityType` [M][V]. A-17b keeps its
  own allow-list of the types the wizard offers. It does not validate against the spec's enum.
- **App Attest.** The App Attest entitlement doc says to "add the App Attest capability to your
  app target", which writes `com.apple.developer.devicecheck.appattest-environment`. It mentions
  no App ID step [V]. Integrity checking needs only "an App ID that you register" [V]. P6-02
  needs only the Team ID and the bundle id, and both come from A-16 and this wizard. The wizard
  therefore shows App Attest as "entitlement in the Godot export preset; no portal step". A-17h
  confirms that a build carrying the entitlement signs with an App Store profile for an App ID
  with no extra capability. **[U]**
- **App Groups and iCloud.** Switching them on works through the API. The `group.…` and
  `iCloud.…` identifiers, and assigning them to the App ID, have no resource [V]. Their capability
  `settings` read back as null or as a version option only [M]. The wizard switches them on and
  links to the portal's identifier page [I].

### 5.3 The ASN URL

`App` carries the four `subscriptionStatusUrl*` attributes and `AppUpdateRequest` accepts all
four [V]. Apple's _Modify an app_ page lists bundle id, primary locale, price schedule and
availability in its abstract, and does not mention them [V]. The schema is the stronger evidence;
the write itself is **[U]**. Apple requires TLS 1.2 or later and a port of 443 or ≥ 1024, and its
senders use `17.0.0.0/8` [V]. `key.plrs.im` already serves P6-01's hook. After the write, the
wizard does the following:

1. calls `POST https://api.storekit-sandbox.apple.com/inApps/v1/notifications/test` with the IAP
   key (A-16's `app-store.in-app-purchase-key`, pinned to the bundle id);
2. calls `GET …/notifications/test/{testNotificationToken}`;
3. shows P6-01's stored `TEST` row as the proof.

Apple sends `TEST` in V2 format whatever version is configured [V]. A 404
`ServerNotificationURLNotFoundError` means the write did not take [V].

### 5.4 Submissions

- **A version is submitted through a review submission, not on its own.** The flow is:
  1. `POST /v1/reviewSubmissions` (app);
  2. `POST /v1/reviewSubmissionItems` for each item: the version, later IAP versions, Background
     Asset versions, custom product pages or in-app events;
  3. `PATCH submitted: true` [V].
- **Re-use the open submission.** Apple keeps one open submission per platform. Distribute
  reads `filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES` first [V][M][I].
- **The first IAP cannot ride this path.** It is portal-only, so Distribute can submit the app's
  first version while the first IAP waits for the portal. The preflight says so before the
  operator starts.
- **Beta review is separate:** `POST /v1/betaAppReviewSubmissions` (build) [V]. Internal groups
  need no review.
- **Export compliance blocks both reviews.** A build without `usesNonExemptEncryption` (or
  `ITSAppUsesNonExemptEncryption` in its Info.plist) waits in `WAITING_FOR_EXPORT_COMPLIANCE`
  [V][S]. Distribute asks for it once and `PATCH`es the build. The probed builds already carry
  `false` [M].

### 5.5 Rate limit, errors, consistency

- **One budget per key.** `X-Rate-Limit: user-hour-lim:3600;user-hour-rem:…` on every response,
  over a rolling hour [M][V]. When it runs out, the API answers 429 `RATE_LIMIT_EXCEEDED` [V].
  P5-02's client already parses the header and backs off (`client.ts`) [V].
  - With A-16, every product that falls back to the team key **shares that one budget**.
  - So do the 15-minute P5-02 poller, A-16's app listing and these flows.
- **Every `POST` and `PATCH` in the spec declares 409 and 422** (336 operations each) [V]. That
  is Apple's answer to state conflicts: a duplicate bundle identifier, a version in the wrong
  state, or a second open submission [S]. P5-02 relays them as 409 `store_refused` with Apple's
  status and none of its body (`controls.ts`) [V]. A-17 keeps that rule, and adds only Apple's
  `errors[].code` (for example `ENTITY_ERROR.ATTRIBUTE.INVALID`). It is an enum-like token,
  never free text [I].
- **No idempotency mechanism.** The word does not occur in the spec [V]. A `POST` that times out
  may or may not have created the resource (§7.3).
- **Long-running states.** Apple processes a build in minutes. Reviews take hours to days. A
  freshly created app or bundle id can lag in list endpoints; one `bundleIds/{id}/app` read
  returned 404 for an id whose app exists [M]. The flows treat every step as **resumable**, and
  poll or use the P5-02 webhook rather than waiting inline [I].

## 6. Where the code lives (rules 6 and 10)

There are two scopes, and they map onto the existing layers.

| Scope                                                                                                                          | Needs a pin?                                                          | Lives in                                                                                                                                                                                                                                                    | Route prefix (narrative-only admin API)                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Team**: bundle ids, capabilities, find app by bundle id, certificate expiry read                                             | No: no app exists yet                                                 | `W/src/core/ascProvisioning.ts` beside A-16's `core/platformCredentials.ts`, using A-16's team ASC client; handlers in `W/src/admin/handlers/platformStore*.ts`                                                                                             | `/manage/api/platform/store-connections/app-store/{bundle-ids,apps/lookup}`     |
| **Product**: ASN URL, beta groups and testers, Distribute, IAP push, availability default                                      | **Yes**: the product's pin (own `asc-api-key` or A-16's team-key pin) | Distribution: `W/src/services/distribution/connectors/asc/` (a new `provision.ts` and `distribute.ts` beside `controls.ts`, which already proves ownership before each write) and `…/commerce/appleCatalog.ts` for IAPs; one dispatcher entry in `admin.ts` | `/manage/api/products/<slug>/distribution/connectors/asc/<op>` (as P5-02 today) |
| **Shared substrate**: the write gate, operation ledger, budget meter, before-and-after audit, ASC client (moved there by A-16) | n/a                                                                   | `W/src/core/asc/` (`client.ts`, `writeGate.ts`, `ledger.ts`, `budget.ts`)                                                                                                                                                                                   | none                                                                            |

- **No service imports another.** Distribution reads the ASC client and the gate from Core
  (`../../../../core/asc/…`), which `boundaries.test.ts` allows [V]. Commerce mappings are
  already Distribution's (`dist_store_products`) [V], so IAP creation stays inside one service.
- **Rule 10 does not bite.** `adminApi` is narrative-only (`routeCoverage.test.ts`), so the new
  admin routes need a worker test, an audit row and a `D/admin/*` narrative update, but no
  OpenAPI entry [V]. No public wire route changes: no corpus, transcript or `PROTOCOL_VERSION`
  work, and **no plan mode**.
- **Credentials.** A-16 has `core/outletTokens.ts` mint the ASC token from the product's own
  credential first, and from the team key only through `openPlatformCredential` with the pin
  match checked inside custody [V, A-16 worktree]. A-17 adds no credential and no reader.

## 7. Write discipline

### 7.1 Authorization

- **One privilege level exists.** `W/src/admin/authz.ts` states "Per-product admin does not
  exist and is not planned", and `canAdminProduct` is `isPlatformAdmin` [V].
- **Every A-17 write is platform-admin.** Team-scope routes check `isPlatformAdmin`;
  product-scope routes check `canAdminProduct`, so a future product-admin gate drops in at one
  call site [I].
- The session, CSRF and admin rate-limit gates already run on `/manage/api/*` (P5-02's header
  comment) [V].
- **Confirmation levels** follow ADMIN.md §5.2. Typed confirmation (the app name) is required
  for:
  - submit for App Store review;
  - release;
  - an IAP price change;
  - enabling a capability on a bundle id that another product's app uses.

  Everything else uses a plain confirm.

### 7.2 Pin-bounded

These are P5-02's rules, generalised into the gate [V]:

1. **The app id never comes from the request.** A product-scope handler resolves the pinned
   `appleId` server-side, either from the setup (`setup.ts`) or from A-16's pin. Every `app`
   relationship in a create body is filled from it.
2. **Ownership is proven before any write to an existing object.** The handler re-reads the
   object with `include=app` (or walks `version → app`, `build → app`, `betaGroup → app`,
   `inAppPurchase → app`) and requires the pinned id, as `proveVersion` does today.
3. **The bundle id is pinned too.** The IAP key's pin is the bundle id (A-16). The ASN test call
   uses it, and the ASN `PATCH` target is the pinned app.
4. **A team-scope write cannot name a product's app.** It touches only bundle ids and
   capabilities. Enabling a capability on a bundle id whose app another product holds is refused
   unless confirmed with the holder's name shown (A-16's `platformPinHolder`).

### 7.3 Idempotent

Every write handler follows the same steps:

1. **Operation key.** The console sends `Idempotency-Key: <uuid>` per user intent. The server
   derives `op_id = sha256(product|op|natural-key|key)`.
2. **Ledger.** A Core table `asc_operations`:
   - columns `op_id`, `scope`, `product`, `op`, `natural_key`, `state` (`pending`, `done`,
     `failed`, `ambiguous`), `request_hash`, `result_ids_json`, `actor`, `created_at`,
     `finished_at`;
   - a replay with the same `op_id` returns the stored result without calling Apple;
   - a different body under the same key is a 409.
3. **Natural-key read before write.** Apple's list filters make every create checkable [V]:

   | Create                      | Natural key and pre-read                                                |
   | --------------------------- | ----------------------------------------------------------------------- |
   | bundle id                   | `GET /v1/bundleIds?filter[identifier]=`                                 |
   | capability                  | the deterministic id, from `bundleIdCapabilities`                       |
   | app (detect)                | `GET /v1/apps?filter[bundleId]=`                                        |
   | beta group                  | name, within `GET /v1/apps/{id}/betaGroups` (no filter: list and match) |
   | beta tester                 | `GET /v1/betaTesters?filter[email]=&filter[apps]=`                      |
   | build in a group            | `GET /v1/builds?filter[betaGroups]=`                                    |
   | beta review                 | `GET /v1/betaAppReviewSubmissions?filter[build]=`                       |
   | version                     | `filter[versionString]` + `filter[platform]`                            |
   | localization                | locale, within the version                                              |
   | review submission           | the open one, `filter[state]`                                           |
   | IAP                         | `filter[productId]`                                                     |
   | IAP version, price schedule | read from the IAP                                                       |
   | ASN URL                     | read the four attributes; skip if equal                                 |
   | phased release              | `include=appStoreVersionPhasedRelease`                                  |

4. **Ambiguous outcome.** On a timeout or 5xx after a `POST`, the row becomes `ambiguous`. The
   next attempt re-reads the natural key before sending anything [I].
5. **Multi-step flows are sequences of idempotent steps.** The wizard and Distribute store their
   progress as the ledger rows of their steps, so a closed tab or a 429 resumes where it
   stopped [I].

### 7.4 Audited, with before and after

- **One audit row per write.** It goes to the product's `audit` for product scope
  (`distribution.asc.<op>`), and to the platform trail (S-13's A-12, `platform.asc.<op>`) for
  team scope. A team write that later binds to a product (the pin) writes to both.
- **Before and after are Apple's own reads.** `before` is the pre-read from §7.3 and `after` is
  the re-read after the write, as P5-02 already re-reads [V]. Both are projected through a
  per-type allow-list of fields.
- **Personal data and secrets are never stored.** That means:
  - `betaAppReviewDetails.demoAccountPassword` and the contact fields;
  - tester emails, stored as a salted hash plus a count;
  - webhook secrets;
  - user records.
- **No request body or Apple error body goes into the row.** It stores the status, Apple's
  `errors[].code` and the ledger `op_id`.

### 7.5 The write gate (deny by default)

`core/asc/writeGate.ts` holds a table of allowed `(method, path template, allowed attribute
keys, allowed relationship types)` entries. `AscClient.request` consults it **before the token
thunk is called**. Anything not in the table throws `AscWriteDenied`: no token is minted and no
request is sent. A test walks the spec's write operations and asserts that each one is
explicitly either allowed or denied, so a spec update that adds an endpoint fails CI until it is
classified. This mirrors the schema-parity mutation table.

**Denied, permanently:**

- `/v1/users*` (`PATCH`, `DELETE`; and `GET`, because it is personal data);
- `/v1/userInvitations*`;
- `/v1/certificates` `POST`, `PATCH`, `DELETE`;
- `/v1/profiles/{id}` `DELETE`;
- `/v1/bundleIds/{id}` `PATCH`, `DELETE`;
- `/v1/bundleIdCapabilities/{id}` `PATCH`, `DELETE`;
- `/v1/devices*`;
- `/v1/merchantIds*` and `/v1/passTypeIds*`;
- `/v1/apps/{id}` `PATCH` with any attribute other than the four `subscriptionStatusUrl*`;
- `/v2/inAppPurchases/{id}` `DELETE`;
- `/v1/subscription*` writes;
- `/v1/betaTesters/{id}` `DELETE`;
- `/v1/betaGroups/{id}` `DELETE`;
- `/v1/builds/{id}` `PATCH` `expired`;
- `/v1/appPriceSchedules` once a schedule exists;
- `/v1/endUserLicenseAgreements*`;
- every `alternativeDistribution*`, `gameCenter*`, `analyticsReport*` and `ciProducts` write.

**Allowed** (the A-17 surface):

- `POST /v1/bundleIds`;
- `POST /v1/bundleIdCapabilities` (types from the wizard's list);
- `PATCH /v1/apps/{id}` (the four ASN attributes);
- `POST /v2/appAvailabilities` and `POST /v1/appPriceSchedules`, only when none exists;
- `POST`/`PATCH /v1/betaGroups` (not `isInternalGroup` changes after creation);
- `POST /v1/betaTesters`;
- `POST`/`DELETE …/relationships/{builds,betaTesters}`;
- `POST`/`PATCH /v1/betaBuildLocalizations`;
- `PATCH /v1/builds/{id}` (`usesNonExemptEncryption`);
- `POST /v1/betaAppReviewSubmissions`;
- `POST`/`PATCH /v1/appStoreVersions` and `PATCH …/relationships/build`;
- `POST`/`PATCH /v1/appStoreVersionLocalizations` (`whatsNew`, `promotionalText`);
- `POST /v1/appStoreVersionPhasedReleases` and P5-02's existing `PATCH`;
- `POST /v1/reviewSubmissions`, `POST /v1/reviewSubmissionItems`, and `PATCH
/v1/reviewSubmissions/{id}` (`submitted`, `canceled`);
- `POST /v1/appStoreVersionReleaseRequests`;
- `POST /v2/inAppPurchases` (`NON_CONSUMABLE`);
- `POST /v1/inAppPurchaseVersions` and `POST`/`PATCH /v2/inAppPurchaseLocalizations`;
- `POST /v1/inAppPurchasePriceSchedules` and `POST /v1/inAppPurchaseAvailabilities`;
- P5-02's existing `POST /v1/webhooks` and `POST /v1/webhookPings`.

## 8. Console design

ADMIN.md templates: T6 (flow) for the wizard and Distribute, T2/T3 for the lists. Everything
degrades to read-only, with an explanation, when no team key is connected or the product has no
pin.

### 8.1 Platform → Store connections → App Store → **New app** (T6, platform admin)

A-16 owns the page (connection status, app list, assign). A-17f adds the **New app** button and
this flow. Each step shows Apple's answer after it runs (re-read), never the request's intent.

1. **Product and identity.**
   - Choose an existing product without an App Store pin, or "register a new product first"
     (link). Apps are not products (rule 4): the wizard attaches an app _to_ a product.
   - Name, primary language, platform (`IOS`, `MAC_OS`, `UNIVERSAL` [V]) and SKU.
   - Bundle id, prefilled from a platform setting "bundle id prefix" (an A-13 platform setting)
     plus the product slug. This is data, not code (rule 5).
2. **Bundle id.**
   - `filter[identifier]` first. If the id exists, show it, plus any app and the product that
     holds it.
   - Otherwise, **Register** (`POST /v1/bundleIds`).
3. **Capabilities.**
   - Checkboxes, pre-ticked from the product's services:
     - Commerce on: In-App Purchase;
     - Identity trust with App Attest: an "entitlement only" note (§5.2);
     - Push, Sign in with Apple, Game Center, Associated Domains: opt-in.
   - App Groups and iCloud: switch on, then a deep link to assign the identifiers.
   - Already-enabled capabilities show as done.
4. **App record (portal).** The copy card and deep link from §5.1, with live polling. When the
   app appears, the step turns green and the flow continues.
5. **Assign.** A-16's `setPlatformPin` for the `appleId` and the IAP-key pin for the bundle id,
   both platform-admin and audited.
6. **Server notifications.**
   - Shows the exact URL `https://key.plrs.im/<slug>/distribution/hooks/app-store`.
   - **Set** writes the URL to production and sandbox as V2. Then **Send test** runs the §5.3
     test and shows the `TEST` delivery.
   - Fallback when the `PATCH` is refused: a deep link to App Information, the URL with a copy
     button, and **Send test** to confirm.
7. **App Store Connect webhook.** P5-02's existing register control (it stores the secret first
   through Core).
8. **TestFlight.**
   - Create an internal group (`isInternalGroup: true`, `hasAccessToAllBuilds: true`) named from a
     platform setting.
   - Optionally create an external group.
   - Optionally add testers by email. Emails are sent to Apple once and not kept (§7.4).
9. **Availability and price.** Default: free, all 175 territories (`POST /v2/appAvailabilities`,
   `POST /v1/appPriceSchedules`). Skipped if they already exist.
10. **Portal checklist.** Each item is a link with a done tick stored per product. Ticks are
    operator assertions, never verified:
    - App Privacy;
    - agreements, tax and banking (needed for paid IAPs);
    - App Group and iCloud identifiers if ticked;
    - App Information (category, age rating, which A-17d's preflight reads);
    - screenshots.

The app list (A-16) also gains a **Set up** action on an existing, assigned app. It runs steps 3
and 6 to 9 only.

### 8.2 Product → Distribution → App Store → **Distribute** (T6, platform admin, pin required)

Next to P5-02's state panel. It is resumable: progress is the ledger (§7.3).

1. **Pick a build.**
   - Builds of the pinned app (`filter[app]`, `expired=false`, newest first), each with its
     `processingState` and its `buildUploads` warnings [M].
   - Each build links to the matching Polaris Key release by version, when the release record
     names one.
   - A build in `PROCESSING` shows a spinner fed by the `BUILD_UPLOAD_STATE_UPDATED` webhook or
     the poller.
2. **Export compliance.** Shown only if `usesNonExemptEncryption` is null: a yes or no, then
   `PATCH`.
3. **Release notes.**
   - Per locale, from the release record's notes when present.
   - They go to TestFlight's `whatsNew` (`betaBuildLocalizations`) and the App Store version's
     `whatsNew`, both editable inline.
4. **TestFlight.**
   - Tick groups. Internal groups get the build at once; external groups need beta review.
   - A preflight reads `betaAppReviewDetail` and `betaAppLocalizations` presence (never the
     password) and deep-links if they are missing.
   - Then `POST /v1/betaAppReviewSubmissions`.
5. **App Store version.**
   - Reuse the version in `PREPARE_FOR_SUBMISSION` for that platform and version string, or
     create one.
   - Set the build.
   - Release: **after approval**, **manual** (then P5-02's existing Release button), or
     **scheduled** (date).
   - **Phased release** toggle: create `appStoreVersionPhasedReleases`. The existing pause,
     resume and complete controls manage it afterwards.
6. **Preflight.** A checklist that reads what the API exposes:
   - screenshot sets present;
   - age rating answered;
   - review contact present;
   - price and availability present;
   - IAP versions ready (included automatically);
   - any first IAP flagged "portal";
   - App Privacy as an unverified tick from §8.1.
7. **Submit for review.**
   - Typed confirm, then: the open review submission or a new one, items for the version plus
     ready IAP and Background Asset versions, then `submitted: true`.
   - The state then follows P5-02's existing poller and webhook (`poll.ts` already reads review
     submissions) [V].
   - **Cancel submission** stays available while the submission is `WAITING_FOR_REVIEW`.

### 8.3 Product → Distribution → Commerce → **App Store products** (T2)

- **One row per `dist_store_products` row with `store = 'app-store'`.** It shows the mapping
  (product id, flag, deliverable) next to Apple's state, read by `filter[productId]`: missing,
  `MISSING_METADATA`, `READY_TO_SUBMIT`, `WAITING_FOR_REVIEW`, `APPROVED`.
- **Create in App Store** (one row or all missing rows) runs these steps:
  1. `POST /v2/inAppPurchases` (`NON_CONSUMABLE`, the mapping's product id, a reference name, an
     optional review note);
  2. an IAP version, then a localization per chosen locale (display name, description);
  3. price: a price-point picker filtered to the base territory, then
     `inAppPurchasePriceSchedules`;
  4. availability in all territories.

  The review screenshot is a deep link in v1.

- **Submission.** Ready IAPs are picked up by Distribute's submission. The first IAP of an app
  shows "submit with your next app version in App Store Connect".
- **Price changes** on an approved IAP need a typed confirm and show Apple's irreversibility
  warning [V].
- **Rule 5 holds.** Store product ids and prices are rows and operator input, never code.
- **A later option, not in A-17:** creating an App Store distribution profile for CI
  (`POST /v1/profiles`) needs existing certificate ids. It is API-possible and lower-risk than
  certificate creation. It stays out until CI signing needs it, because the current CI path signs
  with its own material (P5-04) [I].

## 9. Security and threat-model additions

Proposed for `docs/security/THREAT-MODEL.md`, landing in A-17a. The text is not edited here.

1. **§2 assets: split A11.** The platform team ASC key (A-16's `app-store.api-key`) is **worth
   more than A3** when its role is Admin:
   - it can invite a new Admin to the Apple team (persistent takeover that outlives key
     revocation);
   - it can create certificates, including Developer ID: signing code as the owner is
     **[U]** for a key, but the type is in the create enum [V][M];
   - it can revoke certificates (breaks shipped signing);
   - it can delete bundle ids;
   - it can change prices.

   It also reaches **every** app of the team [V]. Proposed row: **A11b, team store key**, sealed
   under A1 with its own AAD (`_platform`, A-16) [V]. Loss: everything A11 lists, for every app,
   plus team membership and signing identity, because the role in use is Admin (owner
   decision 1). Rating: **above A3**. The only control between a compromised Worker or console
   session and those powers is the write gate, so a change to its table is a review trigger
   (item 5) and its spec-classification test is a required CI check.

2. **§3 trust boundaries: new outbound actions.** The Worker gains write calls to
   `api.appstoreconnect.apple.com` (fixed host, P5-02's SSRF rules [V]) and test-notification
   calls to `api.storekit(-sandbox).apple.com` (P6-01's hosts [V]).
3. **Controls to list:**
   - (a) the write gate with deny-by-default and the spec-classification test (§7.5);
   - (b) no generic proxy route: each operation is a named handler;
   - (c) the pin and ownership proof on every product-scope write (§7.2);
   - (d) typed confirmation for submit, release, price change and shared-bundle capability;
   - (e) the operation ledger and before-and-after audit, with secrets and personal data
     redacted (§7.4);
   - (f) the budget meter, so one product cannot starve every other product's poller (§5.5);
   - (g) **recommended:** a separate App Manager team key for the Worker. Apple's guide names
     creating and deleting users as an Admin-key power [V], and Apple's Program Roles table
     limits user management to Account Holder and Admin [S]. Whether App Manager can register bundle ids and capabilities
     without the portal-only "Access to Certificates, Identifiers & Profiles" permission is
     **[U]**.
4. **§7 attack tree: "stolen admin session → Apple account".** The gate keeps a stolen console
   session within A-17's surface:
   - it can submit, release, add testers, create IAPs, and point the ASN URL at Polaris Key only.
     The URL is fixed server-side as `key.plrs.im/<slug>/…`, never request input;
   - it cannot add users, mint certificates or delete anything.
5. **§9 review triggers.** Add: "a change to `core/asc/writeGate.ts`'s allow table" and "a new
   ASC spec version".

## 10. Work packages

All are pkey-implementer. **None is plan-mode**: none touches `shared-protocol`, `shared-jws`,
`client-core`, a signed document, `PROTOCOL_VERSION` or the corpus, and
`gen:transcripts -- --check` must stay green. Admin routes are narrative-only (rule 10 via
`NARRATIVE_ONLY`); each needs a worker test, an audit row and a `D/admin/*` narrative.

| ID        | Title                                                                                                                                                                                                                                                                                                                                                                                                          | Deps                                                         | Size | Flags                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------- |
| **A-17a** | **ASC write substrate.** `core/asc/{client,writeGate,ledger,budget}.ts` (client moved by A-16 or here); the allow and deny table with the spec-classification test over a pinned copy of the 4.5 spec's write operations; the `asc_operations` migration and TABLE_OWNERS; the budget meter from `X-Rate-Limit`; before-and-after projection with redaction; THREAT-MODEL edits (§9)                           | A-16 (team client, resolver, pins); A-12 (platform audit)    | M    | migration; threat-model edit; gate CI test mandatory (Admin key, decision 1) |
| **A-17b** | **Team provisioning API.** Bundle id find and register; capability list and enable (the wizard's type list); app lookup by bundle id; certificate and profile expiry read; `platform/store-connections/app-store/…` handlers; platform-trail audit                                                                                                                                                             | A-17a                                                        | S    | —                                                                            |
| **A-17c** | **Product app setup API.** ASN URL set (four attributes) and the test-notification round trip; internal and external beta group create; tester add (no storage); availability and free price defaults; per-product portal checklist ticks                                                                                                                                                                      | A-17a; A-16 pins; P6-01                                      | S    | —                                                                            |
| **A-17d** | **Distribute API.** Builds list with upload state; export compliance; beta and App Store localizations; build to groups; beta review submit; version create and reuse, build, release type, phased release create; preflight read; review submission create, items, submit, cancel; extends `connectors/asc/` beside `controls.ts`                                                                             | A-17a; P5-02                                                 | M    | —                                                                            |
| **A-17e** | **IAP from commerce mappings.** `commerce/appleCatalog.ts`: status by `filter[productId]`; non-consumable create, version, localizations, price-point lookup and schedule, availability; price change with typed confirm; IAP and Background Asset versions offered to A-17d's submission                                                                                                                      | A-17a; A-17d; P6-01                                          | M    | —                                                                            |
| **A-17f** | **Console: New app wizard** (T6) in A-16's Store connections page, plus **Set up** on assigned apps; the deep-link constant table; polling; resumable progress from the ledger                                                                                                                                                                                                                                 | ADMIN.md chunk 3; A-16's page; A-17b; A-17c                  | M    | docs help-link drift gate                                                    |
| **A-17g** | **Console: Distribute flow** (T6) in the product's Distribution App Store panel, and **App Store products** (T2) in Commerce                                                                                                                                                                                                                                                                                   | chunk 3; chunk 9 (Distribution area) preferred; A-17d; A-17e | M    | docs help-link drift gate                                                    |
| **A-17h** | **Live verification** in the owner's account. Owner-approved writes on a throwaway bundle id (`<prefix>.pkey-probe`) and an existing test app: (1) the ASN `PATCH`; (2) App Manager key sufficiency for bundle id and capability; (3) whether App Attest needs anything on the App ID; (4) Apple's error codes for a duplicate bundle id and a second open submission. Results fold into a dated addendum here | A-17a; owner decision 3                                      | S    | human input: owner approval and, if decision 1 = (a), the App Manager key    |

**Ordering:**

- A-17a starts once A-16 merges (it reuses A-16's client and pins) and A-12 exists.
- A-17b, A-17c and A-17d run in parallel after A-17a; A-17e follows A-17d.
- A-17h runs as soon as A-17a's gate exists, and before A-17c's ASN step is finalised.
- A-17f and A-17g join the admin area chunks after chunk 3. A-17g goes after chunk 9 if both are
  live, because they share the Distribution files.

**Coordination:**

- A-17a adds a migration; it takes its number in merge order after A-16's `0055`.
- A-17a moving `client.ts` into Core changes the imports in P5-02's connector files only.

Proposed ADMIN.md amendment, not edited here: §2.3 gains "Store connections → New app (T6)"
under the Platform section (S-13's 4P-1), and §6.4 gains the Distribute flow and Commerce's
App Store products table.

## 11. Limits of this spike

A-17h was approved by the owner on 2026-10-04 but not executed from this session (§12), so
every item below is still open.

- **[U] The ASN `PATCH`.** Proven by schema and read, not by a write (A-17h).
- **[U] App Attest on the App ID.** Whether it needs anything there (A-17h).
- **[U] What an App Manager key can do.** Bundle id and capability creation, and the ASN URL
  `PATCH`; and whether any key role can create a Developer ID certificate (A-17h; the threat model
  assumes yes until shown otherwise).
- **[U] Apple's 409/422 codes for each conflict.** The spec declares 409 and 422 on every write,
  but the codes were not observed, because observing them needs a write.
- **Not measured: the 429 behaviour.** It was not provoked; only the header was read.
- **Coverage.** The probes covered one app in depth (the one with recent builds) and the team's
  bundle ids, certificates and profiles. The other apps were read only through `/v1/apps`.
- **Hearsay.** The claims that IAP product ids cannot be reused, and that a third-party tool
  creates apps through the web session, are [S], not checked against a primary source today.
- **Deep links.** None of the deep-link URL shapes is documented by Apple.

## 12. Owner decisions (three)

**Decided 2026-10-04:**

1. **Key: the existing Admin team key.** The owner declined a separate App Manager key, so
   A-17a's deny-by-default write gate (§7.5) is the **only** barrier between a console session
   and user management, certificate creation and revocation, and deletes. As a result:
   - the gate's CI test that classifies every write operation in the spec as allowed or denied
     is **mandatory**, not optional;
   - a spec version bump fails CI until every new write is classified;
   - the threat-model proposal (§9) rates **A11b above A3**, at the level of team membership and
     signing identity, because Admin is the role in use;
   - §9 item 3(g) and the App Manager clauses in §11 no longer apply.
2. **Write surface:** approved as listed in §7.5.
3. **A-17h live writes:** approved by the owner. **They were not run in this session:** the
   session's permission policy refused writes to the external Apple account, and an approval
   relayed by an agent is not the user's own consent. Every [U] item in §11 stays open until
   the owner runs A-17h, or grants the permission and asks for it again. The steps planned
   were:
   - register a throwaway bundle id (`im.plrs.key.pkeyprobe.<date>`) and enable
     `IN_APP_PURCHASE` and `PUSH_NOTIFICATIONS` on it, each create repeated once to record
     Apple's duplicate-conflict codes;
   - one invalid capability type (`APP_ATTEST` and a nonsense value) to record the error shape
     and whether App Attest exists;
   - after checking that the app has no IAPs or subscriptions, set the ASN URL on one app
     (`https://key.plrs.im/pkey-probe/distribution/hooks/app-store`, `V2`), re-read it, and
     restore the previous null values, re-reading again. A no-op `PATCH` of the current nulls
     goes first, to prove the restore path.

The options as originally proposed:

1. **Which key the Worker holds.**
   - **Recommended: (a)** mint a second **team key with the App Manager role** for the Worker
     (A-16's `app-store.api-key`). Keep the Admin key offline for the portal and emergencies.
     This removes user management structurally, not only through code. A-17h confirms that App
     Manager covers bundle ids and capabilities; if it does not, fall back to (b) for those calls
     only.
   - **(b)** use the existing Admin key, with A-17a's deny-list as the only barrier.
2. **The write surface.**
   - **Recommended:** approve §7.5 as A-17's surface:
     - app records through a deep link and auto-detection (no web-session automation);
     - IAPs limited to non-consumables (matching P6-01);
     - no certificate, profile, user, device or delete operations;
     - typed confirmation for submit, release and price change.
   - **Alternatively:** widen to subscriptions now (needs a commerce-bridge extension first), or
     narrow to TestFlight-only for v1.
3. **Live verification writes.**
   - **Recommended:** approve A-17h's writes in the owner's account:
     - register one throwaway bundle id and enable two capabilities on it;
     - set and then clear the ASN URL on one existing test app;
     - attempt one duplicate bundle id registration.

     The throwaway bundle id is removed by hand in the portal afterwards, because the product
     never deletes.

   - **Alternatively:** ship with the [U] items behind their documented fallbacks (a deep link
     for the ASN URL, no App Attest step) and verify in production use.

## 13. Sources

- **Apple, primary:**
  - App Store Connect API OpenAPI specification 4.5, read 2026-10-04 [V]:
    `https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip`
    (`openapi.oas.json`, file dated 2026-09-22, 973 paths, SHA-256
    `1e8ef250d6a41bab0f5670b669abf3f06298ef129c8455ba258149fda86927b2`).
  - Apple developer documentation, read 2026-10-04 as `…/tutorials/data/documentation/<path>.json`
    [V]:
    - `appstoreconnectapi/identifying-rate-limits`;
    - `appstoreconnectapi/creating-api-keys-for-app-store-connect-api`;
    - `appstoreconnectapi/patch-v1-apps-_id_`;
    - `appstoreconnectapi/managing-in-app-purchases`;
    - `appstoreconnectapi/review-submissions`;
    - `appstoreconnectapi/build-uploads`;
    - `appstoreconnectapi/background-assets`;
    - `appstoreconnectapi/capabilitytype`;
    - `appstoreconnectapi/post-v1-bundleidcapabilities`;
    - `appstoreconnectapi/apps`;
    - `appstoreservernotifications/enabling-app-store-server-notifications`;
    - `appstoreserverapi/request-a-test-notification`;
    - `devicecheck/establishing-your-app-s-integrity`;
    - `bundleresources/entitlements/com.apple.developer.devicecheck.appattest-environment`;
    - `appstoreconnectapi/post-v1-apps` → 404.
  - Live App Store Connect API, read-only, 2026-10-04 [M]: 38 `GET`s with the owner's team key
    (Admin role), from `S-14-asc-provisioning/probe.mjs`; `X-Rate-Limit` `user-hour-lim:3600`.
- **Repo** [V], at `6473153c`:
  - `AGENTS.md` (rules 4, 5, 6, 10);
  - `docs/design/ADMIN.md` §5.2, §7.3;
  - `docs/security/THREAT-MODEL.md` §2 (A11), the outlet-credential and P5-02 sections;
  - `W/src/admin/authz.ts`;
  - `W/src/core/outletCredentials.ts`;
  - `W/src/services/distribution/connectors/asc/{client,controls,poll,apply,map}.ts`;
  - `W/src/services/distribution/commerce/{apple,index}.ts`;
  - `W/migrations/0052_commerce.sql`;
  - `W/openapi/polaris-key.v3.yaml` (`/{product}/distribution/hooks/app-store`);
  - `docs/research/2026-09-29-godot-omniplatform/notes/S-13-platform-settings.md`.
- **A-16, uncommitted** in `pk-wt/A-16` on 2026-10-04 [V]:
  `W/migrations/0055_platform_store_connections.sql`, `W/src/core/platformCredentials.ts`.
- **Secondary** [S]: App Store Connect Help on IAP product-id reuse and on export compliance; the
  community practice of creating app records through an Apple ID web session.

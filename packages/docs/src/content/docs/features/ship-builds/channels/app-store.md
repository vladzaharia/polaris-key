---
sidebar:
  order: 5
title: "App Store Connect connector"
description: "How Distribution follows a product's App Store and TestFlight state from App Store Connect — signed webhooks, a 15-minute poller, phased release mirrored as a rollout, Background Asset states — and the operator controls: phased release, releasing a held version, the TestFlight public link, registering the webhook."
---

For a product that ships on the App Store or TestFlight, Distribution can follow the store's own
state instead of waiting for CI to report it. The **App Store Connect connector** reads the
App Store Connect API with the product's API key and keeps three things current:

- **availability and submissions** of each release on the `app-store` and `testflight` outlets
  (see [Availability, submissions and keys](/docs/services/distribution/availability/)), written
  with `source: asc`;
- the **phased release** of an App Store version, mirrored as an outlet rollout (see
  [Rollouts and halts](/docs/services/distribution/rollouts/#store-rollouts));
- the states of **Background Asset** versions (Apple-hosted asset packs), kept as connector
  objects until a pack release claims them.

It never uploads a build or an asset pack, and it never submits anything for review on its own.
Builds stay with CI and Apple's tools; the only files it uploads are the listing's screenshots, when
you push them ([Pushing the listing](#pushing-the-listing)). Its setup controls can also prepare a new app: server notifications,
TestFlight groups and testers, and the free price and availability defaults (see
[Setting up the app](#setting-up-the-app)).

## Setting it up

The connector runs for a product when all of these hold:

1. **Distribution is on**, and `.pkey/distribution` declares an `app-store` or `testflight`
   outlet whose identity carries the app's App Store Connect id (`appleId`, digits) and bundle id:

   ```yaml
   outlets:
     app-store:
       appleId: "1234567890"
       bundleId: gg.acme.dice
     testflight:
       appleId: "1234567890"
       bundleId: gg.acme.dice
   ```

2. An **`asc-api-key` outlet credential** is stored in Distribution → Outlet credentials: a **team** API key with
   the **App Manager** role (not Admin), as key id, issuer id and the `.p8` file, **pinned** to
   this product's app — its App Store Connect app id, the same digits as the `appleId` above (see
   [Pinning the app](#pinning-the-app)). See
   [Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). A credential bound to
   one of the Apple outlets (`outletId`) is preferred over an unbound one.

3. For webhooks, an **`asc-webhook-secret` outlet credential**. Let the Worker generate it — it is
   stored sealed and never shown to anyone:

   ```http
   PUT /manage/api/products/<slug>/outlet-credentials/asc-webhook
   {"kind": "asc-webhook-secret", "outletId": "app-store", "generate": true}
   ```

   then **register the webhook** (below). The Worker opens the secret once and hands it to Apple.
   You can also create the webhook yourself in App Store Connect (Users and Access →
   Integrations → Webhooks) and store the secret you chose there.

Without the API key, without an Apple outlet, or with a key that is not pinned to the outlet's
app, the connector does not run for the product: the poller skips it, every control is refused,
and the webhook route answers not-found, exactly as it does with Distribution off.
`GET …/distribution/connectors/asc` says why in `inert` (`no_outlet`, `no_api_key`,
`pin_missing` or `pin_mismatch`, with a sentence on what to do).

**The platform's team key.** A product with no `asc-api-key` of its own falls back to the platform's
team-level credential for this store, only for the app a platform admin assigned to the product
(the same `pin_missing` / `pin_mismatch` reasons, with `credentialSource: "platform"`). A key of
the product's own always wins. See [Store connections](/docs/admin/store-connections/).

## Pinning the app

An App Store Connect API key is a team key: it can read, and its controls can change, every app in
the team. The app the connector works on is named by the `appleId` in `.pkey/distribution`, and
every resync takes that from the repo. Without a pin, whoever can push that file could point your
key — and the `release` and `phased-release/complete` controls, which cannot be undone — at
another app the key can see.

So the key carries a **pin** that only a platform admin sets: the app id it may be used for in
this product. The connector runs only while the manifest's `appleId` equals the pin.

- **Set it with the key.** Distribution → Outlet credentials asks for the app id with the key. Over the API, send it
  as `pin`:

  ```http
  PUT /manage/api/products/<slug>/outlet-credentials/asc
  {"kind": "asc-api-key", "value": {"keyId": "…", "issuerId": "…", "p8": "…"}, "pin": "1234567890"}
  ```

- **Re-pin without the key.** The pin icon on the credential's row, or a `PUT` with the pin and no
  value: `{"kind": "asc-api-key", "pin": "1234567890"}`. The key itself, its cached tokens and its
  health are untouched. Rotating the key without a `pin` keeps the old one.
- **Every change is audited** as `outlet_credential.pin`, with the old and the new app id.
- **A key stored without a pin does nothing** (`pin_missing`); so does a key stored before pins
  existed. Pin it before you expect the connector to run.

If the manifest's `appleId` changes — a new app, a typo, or someone pointing the product at
another app — the connector stops (`pin_mismatch`): no reads, no mirroring, no webhook, every
control refused with `credential_pin_mismatch`. It stays stopped until the manifest names the
pinned app again, or until you **check that the new app really is this product's** and re-pin.
The pin is checked on the key the connector chooses (a key bound to an Apple outlet before an
unbound one); another key's pin never stands in for it.

## What it reads

**Webhooks.** App Store Connect sends a signed notification to
`POST /<product>/distribution/hooks/asc` when one of its 12 webhook events happens. The connector
checks `x-apple-signature` (HMAC-SHA256 of the body with the webhook secret), ignores a delivery
it has already seen, and answers at once. It then **re-reads the object from the API** and writes
what the API says — the notification itself is only a hint.

| Event                                                                                                | What the connector does                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED`                                                        | availability and submission of the release on `app-store`                  |
| `BUILD_UPLOAD_STATE_UPDATED`                                                                         | build processing; availability on `testflight`                             |
| `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED`                                                     | availability on `testflight`                                               |
| `BACKGROUND_ASSET_VERSION_STATE_UPDATED` and the three `BACKGROUND_ASSET_VERSION_*_RELEASE_*` events | the asset-pack version's state (unresolved until a pack release claims it) |
| `BETA_FEEDBACK_*` (2), `ALTERNATIVE_DISTRIBUTION_*` (3)                                              | stored as received; no state change                                        |

An event type this build does not know is answered `204` and stored as ignored. Stored events
(at most 16 KiB of each body) are kept for 30 days; the nightly maintenance sweep deletes older
ones for every product, including a deleted product or one with Distribution turned off.

**The poller.** Every 15 minutes it reads what no webhook covers: the app's App Store versions
with their **phased release**, open **review submissions**, and the newest **builds** with their
TestFlight state (internal testing has no webhook). It also re-reads Background Asset objects a
webhook reported, until they stop changing, and retries any notification from the last 24 hours
whose follow-up read failed. A notification the Worker refused (for example during a flood of
forged requests, which shares the webhook's rate limit) is not retried by Apple: versions, builds
and phased release still catch up on the next poll, but a Background Asset version first named by
that notification waits for its next event — or resend it from the webhook's delivery history in
App Store Connect. It reads the `X-Rate-Limit` header Apple sends with
every answer (a per-key hourly budget): below 20 % left it reads only versions and phased
release, below 5 % it waits for the next tick.

## How store states map

The connector uses Distribution's own vocabulary and keeps Apple's state beside it
(`detail.ascState`).

| App Store version state                              | availability | submission                  |
| ---------------------------------------------------- | ------------ | --------------------------- |
| `PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`         | `pending`    | `prepared`                  |
| `WAITING_FOR_REVIEW`                                 | `in-review`  | `submitted`                 |
| `IN_REVIEW`                                          | `in-review`  | `in-review`                 |
| `PENDING_DEVELOPER_RELEASE` (approved, held for you) | `approved`   | `pending-developer-release` |
| `ACCEPTED`, `PENDING_APPLE_RELEASE`                  | `approved`   | `approved`                  |
| `READY_FOR_DISTRIBUTION` (legacy `READY_FOR_SALE`)   | `live`       | `released`                  |
| `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`    | `rejected`   | `rejected`                  |
| `REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE`     | `removed`    | unchanged                   |

Only objects of the outlet's own app are read into Distribution. The API key can usually see
every app in the team, so before anything is written the connector asks Apple which app the
object belongs to, and drops it when the answer is another app or none (the event shows as
`ignored`). For a Background Asset that means one extra read each of its version and asset.

"The outlet's app" is the `appleId` in `.pkey/distribution`, and it is only ever the app the key
is pinned to: a manifest naming any other app stops the connector ([Pinning the
app](#pinning-the-app)). One API key per team, and one product per team where you can, still
narrows what a key could reach if it were stolen.

An App Store version belongs to the release whose version equals its version string (a leading
`v` is ignored). A TestFlight build belongs to the release build whose `buildNumber` equals
Apple's build number (`CFBundleVersion`) on the same platform, or to the whole release when none
does. TestFlight usually holds several builds of one version, so the whole release reads the
state of its **newest** such build; older ones are kept as connector objects. On the
`testflight` outlet a build any tester can install reads `live`; an expired build reads `removed`.

One app record can carry several platforms (a Universal Purchase app with iOS and macOS versions
of the same version string), but a release has one state per outlet. **iOS speaks for the
release** when the app has iOS versions or builds; the macOS (or other platform's) version is kept
as a connector object that claims no release. A Mac-only app's macOS versions speak, since it has
no iOS ones.

**Background Assets** map the same way (for example an App Store release
`READY_FOR_DISTRIBUTION` is `live`, `SUPERSEDED` is `removed`), but they belong to asset packs,
not app releases. Until a pack release claims an asset pack, its states are kept as
**unresolved** connector objects — visible in the console, never written as availability.

## Phased release

Apple releases a phased version to users with automatic updates on over seven days: 1, 2, 5,
10, 20, 50 and 100 %. The connector mirrors it as the release's rollout on the `app-store` outlet
— `ACTIVE` as `active`, `PAUSED` as `paused`, `COMPLETE` as `complete` — at the basis points of
Apple's current day (day 3 is 500). The row is marked `mirrored` and refuses direct edits; change
it with the controls below. Only the current version's phased release is mirrored: a version
Apple has replaced or removed (typically with its phased release `COMPLETE`) is history, and an
older release never takes the row from a newer one.

The mirror informs the feed and the console. It is **not** an access control: anyone can download
a phased version from the App Store by hand at any time, and a phase can be paused for up to 30
days.

## Controls

In the console API, under `/manage/api/products/<slug>/distribution/connectors/asc/`:

| `POST`                    | Body                       | Sends to App Store Connect                                        |
| ------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `phased-release/pause`    | `{ releaseId }`            | `PATCH /v1/appStoreVersionPhasedReleases/{id}` → `PAUSED`         |
| `phased-release/resume`   | `{ releaseId }`            | the same → `ACTIVE`                                               |
| `phased-release/complete` | `{ releaseId, confirm }`   | the same → `COMPLETE` (everyone, now)                             |
| `release`                 | `{ releaseId, confirm }`   | `POST /v1/appStoreVersionReleaseRequests` (a held version only)   |
| `testflight/public-link`  | `{ betaGroupId, enabled }` | `PATCH /v1/betaGroups/{id}` `publicLinkEnabled`                   |
| `webhook`                 | `{}`                       | `POST /v1/webhooks` (all 12 events), then `POST /v1/webhookPings` |

**Releasing is typed.** `release` and `phased-release/complete` cannot be undone, and both put the
version in front of every user, so `confirm` must be the app's name exactly as App Store Connect
shows it (the control reads it from Apple before sending). Without it the answer is 422
`confirmation_required`; with a different name, 422 `confirmation_mismatch`. Nothing is sent
either way. Pausing and resuming a phased release are not typed.

**Only on the pinned app.** The controls act on the app whose `appleId` the setup shows in
`GET …/distribution/connectors/asc`, which is always the app the key is pinned to. While the key
is not pinned, or the manifest names another app, every control answers 409 with reason
`credential_pin_missing` or `credential_pin_mismatch` and sends nothing to Apple.

Before sending anything, a version control re-reads the release's App Store version and checks
that Apple still says it belongs to the outlet's app (and, for `release`, that it is held now):
otherwise the answer is `unknown_version` and nothing is sent. A version stored while the outlet
named another app is never acted on. Each control is audited as `distribution.asc.<control>` with
your identity, and re-reads the object afterwards, so the answer is what Apple now says. If Apple refuses — an invalid phase
change, a version that is not held — the answer is `store_refused` with Apple's HTTP status.
`GET …/distribution/connectors` (or `…/connectors/asc`) shows the setup (credential ids only) or
why there is none (`inert`: the manifest's app id, the chosen key and the app it is pinned to),
the objects the connector tracks, unresolved ones flagged, and the latest webhook deliveries.

## Setting up the app

The `setup/…` controls do the API side of a new app's setup on the product's pinned app: server
notifications, TestFlight groups and testers, and the free price and availability defaults. The
**New app** wizard in Platform → Store connections drives them; they work on their own too. Each one
that writes needs an `Idempotency-Key` header, a UUID per intent: retrying with the same key
answers the stored result (`outcome: "replayed"`) instead of writing twice, and a different body
under a used key is 409 `idempotency_conflict`. Without the header the answer is 428
`idempotency_key_required`, and nothing is sent.

| `POST`                            | Body                                             | What it does                                                                                                |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `setup/notifications-url`         | `{}`                                             | Sets the App Store Server Notifications URL (production and sandbox, Version 2), then reads it back         |
| `setup/notifications-url/verify`  | `{}`                                             | Reads the URL Apple has for each environment (no key needed)                                                |
| `setup/notifications-test`        | `{ environment }`                                | Asks Apple to send a test notification (`"sandbox"` or `"production"`); answers a `testNotificationToken`   |
| `setup/notifications-test/status` | `{ environment, testNotificationToken, since? }` | Apple's delivery attempts, and whether the hook stored a `TEST` notification since `since`                  |
| `setup/beta-group`                | `{ name, kind }`                                 | Creates a TestFlight group: `internal` (all builds) or `external`. A group with that name is reused         |
| `setup/beta-testers`              | `{ betaGroupId, emails }`                        | Adds up to 25 testers to one of the app's groups: invites a new address, links a tester the app already has |
| `setup/availability`              | `{}`                                             | Makes the app available in every territory and in new ones, only if it has no availability yet              |
| `setup/price`                     | `{ baseTerritory? }`                             | Sets the app's price to free (base territory `USA` by default), only if it has no price yet                 |
| `setup/checklist`                 | `{ item, done }`                                 | Ticks or unticks a portal-only step (no Apple call, no key needed)                                          |

**The notification URL needs the portal.** The URL is always this product's own hook,
`https://<this host>/<slug>/distribution/hooks/app-store`; nothing in the request can change it.
App Store Connect accepts the API change but, in our live check, did not keep it. So the control
reads the app back after the write: when Apple did not keep the URL, the answer has
`persisted: false` and a `fallback` with a link to App Information and the URL to paste. Paste it
as both the Production and the Sandbox Server URL, choose Version 2 and save. Then check it with
`setup/notifications-url/verify` and prove delivery with a test notification. The test uses the
In-App Purchase key pinned to the app's bundle id (the product's own `app-store-server-key`, or the
platform's). If no URL is configured for that environment, the answer is 409
`notification_url_missing`. The proof is the `TEST` notification the hook stores.

**Testers' addresses are not kept.** They are sent to Apple once. Polaris Key stores only a keyed
digest in the operation record, and neither the answer nor the activity log names an address.
`results` gives one outcome per address, in the request's order after duplicates are removed:
`written`, `existing` (already in the group), `replayed`, or `failed` with Apple's status and code.

**Defaults never overwrite.** If the app already has availability or a price, the control leaves
it alone (`outcome: "existing"`). Changing a price is a separate, typed action.

**Portal checklist.** These steps have no API: App Privacy (`app_privacy`), agreements, tax and
banking (`agreements`), App Group and iCloud identifiers (`capability_identifiers`), App
Information (`app_information`) and screenshots (`screenshots`). A tick is your own statement, and
nobody checks it. `GET …/distribution/connectors/asc` shows the checklist under `provisioning`,
with a link for each step, together with the newest setup operations and their state.

**Before the repo names the app.** The wizard runs before `.pkey/distribution` declares an Apple
outlet. Until then, the app assigned to the product in Platform → Store connections is the app the
setup controls act on. This needs the platform team key and no `asc-api-key` of the product's own.
Once the manifest names an app, the manifest's app must be the pinned one, as for every other
control.

## Distribute

The Distribute flow takes a build of the pinned app through TestFlight and App Review from the
console API, under the same `/manage/api/products/<slug>/distribution/connectors/asc/` prefix.
Uploading the build stays in CI; everything after the upload is here. In the console it is the
**Distribution → App Store** page ([App Store: Distribute](/docs/admin/app-store/)).

| `GET`                                 | Answers                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distribute/builds[?limit=]`          | the app's unexpired builds, newest first: build number, version, processing state, export compliance, TestFlight states, the upload's state with Apple's warning and error codes                                                                                                                            |
| `distribute/beta-groups`              | the app's TestFlight groups, internal or external                                                                                                                                                                                                                                                           |
| `distribute/versions[?platform=]`     | the app's App Store versions (state, whether still editable, build, release type, phased release) and its live review submissions                                                                                                                                                                           |
| `distribute/preflight?versionId=<id>` | a readiness checklist: build, export compliance, screenshots per locale, age rating, App Review contact, price, availability, beta review details, App Privacy (portal-only), and the [shared listing](/docs/admin/storefront-listing/)'s App Store fit (advisory; `&releaseId=` adds that release's notes) |

| `POST`                              | Body                                                                                                                                                                                                                                                               | Sends to App Store Connect                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `distribute/export-compliance`      | `{ buildId, usesNonExemptEncryption }`                                                                                                                                                                                                                             | `PATCH /v1/builds/{id}` (an unanswered build only)                                               |
| `distribute/beta-localization`      | `{ buildId, locale, whatsNew }`                                                                                                                                                                                                                                    | TestFlight's What to Test: `POST` or `PATCH /v1/betaBuildLocalizations`                          |
| `distribute/testflight/groups`      | `{ buildId, betaGroupIds }`                                                                                                                                                                                                                                        | `POST /v1/betaGroups/{id}/relationships/builds` per group not yet holding the build              |
| `distribute/testflight/beta-review` | `{ buildId }`                                                                                                                                                                                                                                                      | `POST /v1/betaAppReviewSubmissions` (external groups see the build after review)                 |
| `distribute/version`                | `{ platform, versionString }`                                                                                                                                                                                                                                      | reuses the editable version with that string, or `POST /v1/appStoreVersions`                     |
| `distribute/version/build`          | `{ versionId, buildId }`                                                                                                                                                                                                                                           | `PATCH /v1/appStoreVersions/{id}/relationships/build`                                            |
| `distribute/version/release-type`   | `{ versionId, releaseType, earliestReleaseDate? }`                                                                                                                                                                                                                 | `PATCH /v1/appStoreVersions/{id}`: `MANUAL`, `AFTER_APPROVAL` or `SCHEDULED` (a future date)     |
| `distribute/version/phased-release` | `{ versionId }`                                                                                                                                                                                                                                                    | `POST /v1/appStoreVersionPhasedReleases`; the phased-release controls above manage it later      |
| `distribute/version-localization`   | `{ versionId, locale, whatsNew?, promotionalText?, releaseId? }`: with `releaseId`, what is left out defaults from the [shared listing](/docs/admin/storefront-listing/) (the release's store notes, the locale's promotional text), refused if over Apple's limit | `POST` or `PATCH /v1/appStoreVersionLocalizations` (release notes only)                          |
| `distribute/submit`                 | `{ versionId, confirm, inAppPurchaseVersionIds?, backgroundAssetVersionIds? }`                                                                                                                                                                                     | the open review submission or a new one, the version and any given items, then `submitted: true` |
| `distribute/submission/cancel`      | `{ submissionId }`                                                                                                                                                                                                                                                 | `PATCH /v1/reviewSubmissions/{id}` `canceled: true`                                              |

**Each write needs an `Idempotency-Key` header**, a fresh UUID per thing you mean to do; without
one the answer is 428 `idempotency_key_required`. Sending the same request again with the same key
answers what happened the first time without calling Apple (`outcome: "replayed"`); the same key
with a different body is 409 `idempotency_conflict`. Before any write the handler looks the object
up the way Apple allows (the version by its string, the build in the group, the open submission),
and when Apple already has it nothing is sent (`outcome: "existing"`). If Apple fails part-way, or a
request times out, send the same request with the same key: it re-reads first and carries on from
the step that did not finish. `submit` runs three such steps and answers each one's outcome.

**Submitting is typed.** `confirm` must be the app's name exactly as App Store Connect shows it,
compared by the Worker before anything is opened; otherwise 422 `confirmation_required` or
`confirmation_mismatch`. Cancelling a submission is not typed.

**Only the pinned app's objects.** A build, group, version or submission named in a request is
re-read from Apple first and must belong to the pinned app (`unknown_build`,
`unknown_beta_group`, `unknown_version`, `unknown_submission`); a groups request that names one
foreign group sends nothing at all. A shipped version is never reused or edited
(`version_not_editable`), a build must be `VALID` and unexpired before it goes to testers or a
version (`build_not_ready`, `build_expired`), and a version needs a build before it is submitted
(`no_build`). When Apple refuses, the answer is `store_refused` with Apple's status and its error
code (`appleCode`, such as `ENTITY_ERROR.ATTRIBUTE.INVALID`), never its message. Each write is
audited as `distribution.asc.<step>` with Apple's state before and after kept on the operation.

## Pushing the listing

The [shared listing](/docs/admin/storefront-listing/) reaches App Store Connect from the console
API, under the same prefix, with the same `Idempotency-Key`, pinned-app and audit rules as
Distribute. Both writes are a plain confirmation.

| `POST`                | Body                                                                             | Sends to App Store Connect                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing/text`        | `{ versionId, locale }`                                                          | the listing's App Store fit in that locale: description, keywords, marketing and support URLs and promotional text into the version's localization; name, subtitle and privacy policy URL into the editable app information's |
| `listing/screenshots` | `{ versionId, locale, sizeClass }` (`phone-portrait`, `tablet`, `desktop-16x10`) | the stored App Store screenshots of that size class into the localization's iPhone 6.9″, iPad 13″ or Mac screenshot set: reserve, upload, commit                                                                              |

**The text is the listing's, unchanged.** Keywords are packed the listing's way (whole keywords,
comma-joined, within 100 bytes; the ones left out come back as `warnings`). A value over one of
Apple's limits refuses the whole push with `listing_does_not_fit` and the fields, and nothing is
sent: edit the listing, never the push. What's New is not part of it: it is the release's, set by
`distribute/version-localization`. The name, subtitle and privacy policy URL need app information
App Store Connect still lets you edit, which exists while a version is being prepared
(`app_info_not_editable` otherwise). Each localization is one step: an existing one in that locale is
updated, a missing one is created, and one that already says the same is left (`existing`).

**Screenshots come from the blob store**, as `pkey listing assets` stored them
(`app-store:screenshot:<class>:<n>`, in order, the locale's own if it has any, else the ones for
every locale). Each is PNG or JPEG without alpha, at most 32 MiB, and a set holds at most 10. The
version needs a localization in that locale first (`localization_missing`: push the text first). A
screenshot the set already holds (same checksum) is not uploaded again. **Nothing is ever deleted
or reordered**: screenshots the set holds that the listing does not are left in place and counted
in `otherScreenshots`, and `manage` links to the version in App Store Connect to remove or reorder
them by hand.

The preflight reads presence only: it never returns the App Review contact, the demo account or its
password. It cannot check App Privacy, which has no API. When the product maps App Store products
and none of the app's in-app purchases has passed review yet, it adds a `firstInAppPurchase` line
(see below).

## In-app purchases

The App Store rows of the [commerce bridge](/docs/services/distribution/commerce/)'s product map
can be created in App Store Connect from the console (**Distribution → Commerce**,
[App Store products](/docs/admin/app-store/#app-store-products-in-commerce)) or its API, under the
same prefix, as
**non-consumable** in-app purchases of the pinned app. Only a mapped product id can be created,
priced or made available (`unmapped_product`): what exists at Apple follows your map.

| `GET`                                             | Answers                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iap/products`                                    | each App Store mapping (product id, flag, deliverable) beside Apple's state: `missing`, `MISSING_METADATA`, `READY_TO_SUBMIT`, `WAITING_FOR_REVIEW`, `APPROVED`…; a type mismatch is flagged |
| `iap/price-points?productId=<id>&territory=<USA>` | the price points Apple offers for that purchase in one territory, cheapest first, and its current price                                                                                      |
| `distribute/submission-items[?platform=]`         | the in-app purchase versions and Background Asset versions that can join the next App Review submission                                                                                      |

| `POST`             | Body                                                                        | Sends to App Store Connect                                                                                       |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `iap/create`       | `{ productId, referenceName, reviewNote?, familySharable?, localizations }` | `POST /v2/inAppPurchases` (`NON_CONSUMABLE`), a version, then `POST /v2/inAppPurchaseLocalizations` per locale   |
| `iap/localization` | `{ productId, locale, name, description? }`                                 | `POST` or `PATCH /v2/inAppPurchaseLocalizations` on the purchase's editable version                              |
| `iap/price`        | `{ productId, baseTerritory, pricePointId` or `customerPrice, confirm? }`   | `POST /v1/inAppPurchasePriceSchedules`: one price in the base territory, effective now; Apple derives the others |
| `iap/availability` | `{ productId, confirm }`                                                    | `POST /v1/inAppPurchaseAvailabilities`: every territory, and new ones (only while none is set)                   |

`localizations` lists one to ten `{ locale, name, description? }` (display name up to 35
characters, description up to 55). The same `Idempotency-Key` rules as Distribute apply: an
existing purchase, version, locale, price or availability is found first and left alone. A mapped
id that already exists as a consumable or subscription is refused (`iap_type_mismatch`); Apple does
not let a product id change type or be reused.

**A price change is typed.** The first price needs no confirmation. Once the purchase has a price,
any other price needs `confirm` set to the app's name exactly as App Store Connect shows it
(otherwise 422 `confirmation_required` or `confirmation_mismatch`, nothing sent), because once a
price increase takes effect it cannot be reverted. Setting the same price again sends nothing.

**Availability is typed.** Every `iap/availability` request needs `confirm` set to the app's name,
checked the same way: availability decides where the purchase is sold, and a write with no
territories would take it off sale everywhere.

**Submitting.** Pass the ids from `distribute/submission-items` to `distribute/submit` as
`inAppPurchaseVersionIds` and `backgroundAssetVersionIds`. Each is re-read and must be the pinned
app's (an in-app purchase version through its purchase and your map; a Background Asset version
through its asset), ready (`iap_not_ready`, `background_asset_not_ready`) and, for an asset, built
for the submission's platform, before the submission is opened; one foreign id
(`unknown_iap_version`, `unknown_background_asset_version`) sends nothing. Apple requires an
app's **first** in-app purchase to be submitted with an app version in App Store Connect itself:
until one of the app's purchases has passed review, `submission-items` offers none and `submit`
refuses them (409 `first_iap_portal`). The review screenshot is added in App Store Connect too.

## Security

- The webhook secret is per product and checked in constant time; a missing or malformed
  signature is refused before the secret is even opened, and deliveries are rate-limited per
  product before it is.
- The connector calls only `https://api.appstoreconnect.apple.com/`; nothing in a notification
  can redirect it.
- The API key never leaves custody: the connector uses short-lived tokens minted from it, every
  open of the key is in the activity log, and errors record an HTTP status, never a response.
- Which app the key reads and the controls act on is the app you pinned it to. The repo's
  `.pkey/distribution` must name the same app, or the connector stops; it can never choose
  another one.
- Every request goes through a deny-by-default write gate: only the writes these controls and the
  App Store provisioning flows need are allowed, each with its exact body. Nothing can delete,
  touch users, certificates, devices or profiles, or read user records, whatever role the key has.
  A refused request answers 409 `write_denied` and sends nothing.
- An App Manager key can change metadata, TestFlight and release timing, but it cannot sign a
  build. Keep a separate Developer-role key for CI uploads if you want the two apart.

The full analysis is in the threat model (`docs/security/THREAT-MODEL.md`, "Store connectors").

## App Store: Distribute and App Store products

Two console pages drive a product's App Store app through the
[App Store Connect connector](/docs/services/distribution/app-store-connect/): **Distribution →
App Store** takes a build to TestFlight and the App Store, and **Distribution → Commerce** creates
the In-App Purchases the [commerce bridge](/docs/services/distribution/commerce/) maps to licence
flags. Both act only on the app the product is pinned to, and both are for platform admins.

Every change is one named request to App Store Connect, confirmed before it is sent, and what the
page shows afterwards is App Store Connect's own answer. Each confirmation carries a retry key: if
a step fails halfway or the connection drops, confirming again resumes from what already
happened instead of repeating it.

When the product has no usable App Store Connect connector (no key, no pin, or an outlet that
names no app) both pages say why and link to **Outlet credentials**.

## The App Store page

The page has the **Distribute** flow on the left and, on the right, what App Store Connect has now:
the app's newest versions with their state, and its open review submissions. The step, the build
and the version are kept in the URL, so a refresh or a shared link opens the same place, and an
earlier step that is not finished yet comes first.

1. **Build.** The app's builds that have not expired, newest first, with their processing state,
   when they were uploaded, App Store Connect's upload warnings and errors, and the Polaris Key
   release each one is linked to. A build that is still processing cannot be chosen; the list is
   checked every 10 seconds while one is, and **Check now** checks at once.
2. **Export compliance.** Shown as a question only when the build has no answer yet. App Store
   Connect holds the build for TestFlight and App Review until it has one, and an answer cannot be
   changed through the API afterwards.
3. **Release notes.** One set of notes per locale (up to 4,000 characters each). **Save to
   TestFlight** sets TestFlight's What to Test for the build; the Version step sends the same notes
   to the App Store version's What's New. The notes are kept in the browser tab while you work.
4. **TestFlight.** The build's internal and external testing states, and the app's TestFlight
   groups to tick. Internal groups get the build at once; external groups get it after beta review,
   which **Submit for beta review** requests. Beta review needs the app's Test Information, linked
   from the step.
5. **Version.** Choose the platform and version number: an editable version with that number is
   reused, otherwise App Store Connect creates one. Then attach the build, apply the release notes,
   choose when the approved version is released (after approval, manually, or scheduled for a date
   and time, on the hour) and, optionally, a phased release.
6. **Preflight.** What App Store Connect's API shows about readiness: the build, export
   compliance, screenshots per locale, the age rating, the App Review contact, price, availability
   and, for external testing, the beta review details. App Privacy and an app's first In-App
   Purchase are App Store Connect steps the API cannot check; each line that is not ready links to
   the page in App Store Connect that fixes it.
7. **Submit.** The version goes to App Review together with the In-App Purchases and Background
   Assets that are ready (each can be unticked). Submitting needs the app's name typed exactly as
   App Store Connect shows it; Polaris Key checks it against App Store Connect before anything is
   sent.

Beside each version, **Release…** releases an approved version that waits for a manual release,
and a phased release can be paused, resumed or released to everyone. A review submission that is
with App Review or has unresolved issues can be cancelled. Releasing and releasing to everyone are
typed the same way as submitting, because App Store Connect cannot take a release back. These
controls need the version's build to be linked to a Polaris Key release (the release matching its
version number).

## App Store products in Commerce

One row per App Store product id in the commerce map, with the flag it grants and the deliverable,
beside the product's state in App Store Connect: **Not created**, or App Store Connect's own state
(missing metadata, ready to submit, waiting for review, approved…). A product id that exists in
App Store Connect as another type of purchase is flagged; resolve it there, since a product id can
neither change type nor be reused.

The row actions:

- **Create in App Store…** (a product id that is not created yet): a non-consumable In-App
  Purchase with a reference name, one display name and description per locale (up to ten; 35 and 55
  characters), an optional note for App Review and Family Sharing.
- **Add or edit a locale…**: one locale's display name and description.
- **Set price…**: a price from the list App Store Connect offers in the base territory, effective
  at once; Apple derives every other territory. The first price is a plain confirmation. Changing
  an existing price needs the app's name typed, because once a price increase takes effect it
  cannot be reverted.
- **Make available everywhere…**: every territory, and new ones as Apple adds them, written only
  while the purchase has no availability. It always needs the app's name typed: availability
  decides where the purchase is sold.

Ready purchases go to App Review with the next version from the App Store page. An app's **first**
In-App Purchase is the exception: App Store Connect requires it to be submitted there, with an app
version, and both pages say so until one of the app's purchases has been approved. The review
screenshot is added in App Store Connect too.

## Audit

Every change appears in the product's **Activity** as `distribution.asc.<operation>`, and the
operation's record keeps App Store Connect's state before and after it. Tester emails, contact
details and the demo account are never stored.

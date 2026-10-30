---
title: "Distribute on the App Store"
description: "Send a build to TestFlight and the App Store, push the store listing, manage in-app purchases, and read the App Store channel page of a product."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 6.5
---

This page continues [App Store](/docs/features/ship-builds/channels/app-store/): it assumes the App Store Connect credential and the pinned app are set up there.

## Distribute

The Distribute flow takes a build of the pinned app through TestFlight and App Review from the
console API, under the same `/manage/api/products/<slug>/distribution/connectors/asc/` prefix.
Uploading the build stays in CI; everything after the upload is here. In the console it is the
**Ship builds → Channel setup → App Store → Releases** tab (the Distribute flow; [App Store: Distribute](/docs/features/ship-builds/channels/app-store/)).

| `GET`                                 | Answers                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distribute/builds[?limit=]`          | the app's unexpired builds, newest first: build number, version, processing state, export compliance, TestFlight states, the upload's state with Apple's warning and error codes                                                                                                                                             |
| `distribute/beta-groups`              | the app's TestFlight groups, internal or external                                                                                                                                                                                                                                                                            |
| `distribute/versions[?platform=]`     | the app's App Store versions (state, whether still editable, build, release type, phased release) and its live review submissions                                                                                                                                                                                            |
| `distribute/preflight?versionId=<id>` | a readiness checklist: build, export compliance, screenshots per locale, age rating, App Review contact, price, availability, beta review details, App Privacy (portal-only), and the [shared listing](/docs/features/ship-builds/channels/polaris-key/)'s App Store fit (advisory; `&releaseId=` adds that release's notes) |

| `POST`                              | Body                                                                                                                                                                                                                                                                                | Sends to App Store Connect                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `distribute/export-compliance`      | `{ buildId, usesNonExemptEncryption }`                                                                                                                                                                                                                                              | `/v1/builds/{id}` (PATCH) (an unanswered build only)                                             |
| `distribute/beta-localization`      | `{ buildId, locale, whatsNew }`                                                                                                                                                                                                                                                     | TestFlight's What to Test: `POST` or `/v1/betaBuildLocalizations` (PATCH)                        |
| `distribute/testflight/groups`      | `{ buildId, betaGroupIds }`                                                                                                                                                                                                                                                         | `/v1/betaGroups/{id}/relationships/builds` (POST) per group not yet holding the build            |
| `distribute/testflight/beta-review` | `{ buildId }`                                                                                                                                                                                                                                                                       | `/v1/betaAppReviewSubmissions` (POST) (external groups see the build after review)               |
| `distribute/version`                | `{ platform, versionString }`                                                                                                                                                                                                                                                       | reuses the editable version with that string, or `/v1/appStoreVersions` (POST)                   |
| `distribute/version/build`          | `{ versionId, buildId }`                                                                                                                                                                                                                                                            | `/v1/appStoreVersions/{id}/relationships/build` (PATCH)                                          |
| `distribute/version/release-type`   | `{ versionId, releaseType, earliestReleaseDate? }`                                                                                                                                                                                                                                  | `/v1/appStoreVersions/{id}` (PATCH): `MANUAL`, `AFTER_APPROVAL` or `SCHEDULED` (a future date)   |
| `distribute/version/phased-release` | `{ versionId }`                                                                                                                                                                                                                                                                     | `/v1/appStoreVersionPhasedReleases` (POST); the phased-release controls above manage it later    |
| `distribute/version-localization`   | `{ versionId, locale, whatsNew?, promotionalText?, releaseId? }`: with `releaseId`, what is left out defaults from the [shared listing](/docs/features/ship-builds/channels/polaris-key/) (the release's store notes, the locale's promotional text), refused if over Apple's limit | `POST` or `/v1/appStoreVersionLocalizations` (PATCH) (release notes only)                        |
| `distribute/submit`                 | `{ versionId, confirm, inAppPurchaseVersionIds?, backgroundAssetVersionIds? }`                                                                                                                                                                                                      | the open review submission or a new one, the version and any given items, then `submitted: true` |
| `distribute/submission/cancel`      | `{ submissionId }`                                                                                                                                                                                                                                                                  | `/v1/reviewSubmissions/{id}` (PATCH) `canceled: true`                                            |

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
`confirmation_mismatch`. Canceling a submission is not typed.

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

The [shared listing](/docs/features/ship-builds/channels/polaris-key/) reaches App Store Connect from the console
API, under the same prefix, with the same `Idempotency-Key`, pinned-app and audit rules as
Distribute. Both writes are a plain confirmation.

| `POST`                | Body                                                                             | Sends to App Store Connect                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing/text`        | `{ versionId, locale }`                                                          | the listing's App Store fit in that locale: description, keywords, marketing and support URLs and promotional text into the version's localization; name, subtitle and privacy policy URL into the editable app information's |
| `listing/screenshots` | `{ versionId, locale, sizeClass }` (`phone-portrait`, `tablet`, `desktop-16x10`) | the stored App Store screenshots of that size class into the localization's iPhone 6.9″, iPad 13″ or Mac screenshot set: reserve, upload, commit                                                                              |

**The text is the listing's, unchanged.** Keywords are packed the listing's way (whole keywords,
comma-joined, within 100 bytes; the ones left out come back as `warnings`). A value over one of
Apple's limits refuses the whole push with `listing_does_not_fit` and the fields, and nothing is
sent: edit the listing, never the push. The version's release notes are not part of it: they are the release's, set by
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

The App Store rows of the [commerce bridge](/docs/features/commerce/)'s product map
can be created in App Store Connect from the console (**Commerce → In-app purchases**,
[App Store products](/docs/features/ship-builds/channels/app-store/#app-store-products-in-commerce)) or its API, under the
same prefix, as
**non-consumable** in-app purchases of the pinned app. Only a mapped product id can be created,
priced or made available (`unmapped_product`): what exists at Apple follows your map.

| `GET`                                             | Answers                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iap/products`                                    | each App Store mapping (product id, flag, deliverable) beside Apple's state: `missing`, `MISSING_METADATA`, `READY_TO_SUBMIT`, `WAITING_FOR_REVIEW`, `APPROVED`…; a type mismatch is flagged |
| `iap/price-points?productId=<id>&territory=<USA>` | the price points Apple offers for that purchase in one territory, cheapest first, and its current price                                                                                      |
| `distribute/submission-items[?platform=]`         | the in-app purchase versions and Background Asset versions that can join the next App Review submission                                                                                      |

| `POST`             | Body                                                                        | Sends to App Store Connect                                                                                         |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `iap/create`       | `{ productId, referenceName, reviewNote?, familySharable?, localizations }` | `/v2/inAppPurchases` (POST) (`NON_CONSUMABLE`), a version, then `/v2/inAppPurchaseLocalizations` (POST) per locale |
| `iap/localization` | `{ productId, locale, name, description? }`                                 | `POST` or `/v2/inAppPurchaseLocalizations` (PATCH) on the purchase's editable version                              |
| `iap/price`        | `{ productId, baseTerritory, pricePointId` or `customerPrice, confirm? }`   | `/v1/inAppPurchasePriceSchedules` (POST): one price in the base territory, effective now; Apple derives the others |
| `iap/availability` | `{ productId, confirm }`                                                    | `/v1/inAppPurchaseAvailabilities` (POST): every territory, and new ones (only while none is set)                   |

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

## App Store: Distribute and App Store products

Two console areas drive a product's App Store app through the
[App Store Connect connector](/docs/features/ship-builds/channels/app-store/): **Ship builds → Channel setup → App Store → Releases**
takes a build to TestFlight and the App Store, and **Commerce → In-app purchases** creates
the In-App Purchases the [commerce bridge](/docs/features/commerce/) maps to license
flags. Both act only on the app the product is pinned to, and both are for platform admins.

Every change is one named request to App Store Connect, confirmed before it is sent, and what the
page shows afterwards is App Store Connect's own answer. Each confirmation carries a retry key: if
a step fails halfway or the connection drops, confirming again resumes from what already
happened instead of repeating it.

When the product has no usable App Store Connect connector (no key, no pin, or a channel that
names no app) the Releases tab and Setup say why and point to the channel's **Setup** tab.

## The Releases tab

On **Ship builds → Channel setup → App Store → Releases**, the tab has the **Distribute** flow on the left and, on the right, what App Store Connect has now:
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
   to the App Store version's release notes. The notes are kept in the browser tab while you work.
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
with App Review or has unresolved issues can be canceled. Releasing and releasing to everyone are
typed the same way as submitting, because App Store Connect cannot take a release back. These
controls need the version's build to be linked to a Polaris Key release (the release matching its
version number).

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

It never uploads a build or an asset pack, and it never submits anything for review. Those stay
with CI and Apple's tools.

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

2. An **`asc-api-key` outlet credential** is stored on the Secrets tab: a **team** API key with
   the **App Manager** role (not Admin), as key id, issuer id and the `.p8` file. See
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

Without the API key, or without an Apple outlet, the connector does not exist for the product:
the poller skips it and the webhook route answers not-found, exactly as it does with
Distribution off.

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

"The outlet's app" is the `appleId` in `.pkey/distribution`, and every resync takes it from the
repo. So whoever can push that file decides which app your API key reads for this product and
which app the controls below act on. If one team key serves several products, a repo writer of
one product can point it at another app in the team. The connector does not catch that, because
the other app's objects really do belong to the `appleId` it was given. Until the credential can
pin the expected app, protect yourself:

- prefer **one API key per team**, and one product per team where you can, so the key sees only
  the apps this product should touch;
- review any change to an outlet's `appleId` in `.pkey/distribution` like a change to the key
  itself;
- check the `appleId` that `GET …/distribution/connectors/asc` shows before you press a control.

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
| `phased-release/complete` | `{ releaseId }`            | the same → `COMPLETE` (everyone, now)                             |
| `release`                 | `{ releaseId }`            | `POST /v1/appStoreVersionReleaseRequests` (a held version only)   |
| `testflight/public-link`  | `{ betaGroupId, enabled }` | `PATCH /v1/betaGroups/{id}` `publicLinkEnabled`                   |
| `webhook`                 | `{}`                       | `POST /v1/webhooks` (all 12 events), then `POST /v1/webhookPings` |

**Check the app first.** The controls act on the app whose `appleId` the setup shows in
`GET …/distribution/connectors/asc`, and that id comes from the repo's `.pkey/distribution`, not
from you. Confirm it is this product's app before pressing `release` or `phased-release/*`: on
another app's held version, either one releases that app's version, and that cannot be undone.

Before sending anything, a version control re-reads the release's App Store version and checks
that Apple still says it belongs to the outlet's app (and, for `release`, that it is held now):
otherwise the answer is `unknown_version` and nothing is sent. A version stored while the outlet
named another app is never acted on. Each control is audited as `distribution.asc.<control>` with
your identity, and re-reads the object afterwards, so the answer is what Apple now says. If Apple refuses — an invalid phase
change, a version that is not held — the answer is `store_refused` with Apple's HTTP status.
`GET …/distribution/connectors` (or `…/connectors/asc`) shows the setup (credential ids only),
the objects the connector tracks, unresolved ones flagged, and the latest webhook deliveries.

## Security

- The webhook secret is per product and checked in constant time; a missing or malformed
  signature is refused before the secret is even opened, and deliveries are rate-limited per
  product before it is.
- The connector calls only `https://api.appstoreconnect.apple.com/`; nothing in a notification
  can redirect it.
- The API key never leaves custody: the connector uses short-lived tokens minted from it, every
  open of the key is in the activity log, and errors record an HTTP status, never a response.
- Which app the key reads and the controls act on is the `appleId` in `.pkey/distribution`, so
  the repo chooses it. Use one key per team and check the app before a control (above).
- An App Manager key can change metadata, TestFlight and release timing, but it cannot sign a
  build. Keep a separate Developer-role key for CI uploads if you want the two apart.

The full analysis is in the threat model (`docs/security/THREAT-MODEL.md`, "Store connectors").

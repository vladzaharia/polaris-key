---
sidebar:
  order: 7
title: "Microsoft Store connector"
description: "How Distribution follows a product's Microsoft Store submissions — the submission API read on the 15-minute connector cron, submission status and certification outcomes, package flights mapped to channels, gradual package rollouts mirrored as outlet rollouts — and what the read-only connector never does."
---

For a product that ships on the Microsoft Store, Distribution can follow the Store instead of
waiting for CI to report it. The **Microsoft Store connector** reads the Microsoft Store
submission API with the product's Partner Center app and keeps three things current:

- the **submission** of each release on your `ms-store` outlet — committed, in certification,
  certified, published, or rejected with the reasons — with when it was submitted and reviewed
  (see [Availability, submissions and keys](/docs/services/distribution/availability/)), written
  with `source: ms-store`;
- **availability** of each release's MSIX builds on the outlet;
- each submission's **gradual package rollout**, mirrored as an outlet rollout (see
  [Rollouts and halts](/docs/services/distribution/rollouts/#store-rollouts)).

**It only reads.** It never creates, updates, commits or deletes a submission, never edits a
listing, and never changes a rollout (increase, halt or finalise). Publishing stays with CI —
the `msstore` CLI or Microsoft's GitHub Action — and with Partner Center. The Store sends no
webhooks, so the connector reads on the connector cron, every 15 minutes. Certification can take
up to three business days; the submission's `submittedAt` and `reviewedAt` let the console show
how long it has been in certification.

## Setting it up

The connector runs for a product when all of these hold:

1. **Distribution is on**, and `.pkey/distribution` declares an `ms-store` outlet whose identity
   carries the app's **Store ID** (`productId`, 12 characters, from Partner Center → Product
   identity), and, if you use package flights, a **flight map** — your channel on the left, the
   flight's Partner Center name (or its flight id) on the right:

   ```yaml
   outlets:
     ms-store:
       productId: 9NBLGGH4R315
       packageFamilyName: Acme.Dice_ng6try80pwt52
       flights:
         beta: Beta testers
   ```

   The non-flighted submission — what everyone gets from the Store — is always the `stable`
   channel. A flight Partner Center lists that your map does not name is shown as **unmapped**,
   recorded once in the activity log (`distribution.connector.flight_unmapped`), and otherwise
   ignored: the connector does not read its submissions.

2. An **`ms-partner-center` outlet credential** is stored in Distribution → Outlet credentials — the Entra ID app's
   tenant id, client id, client secret and seller id — **pinned** to this product's app: the same
   Store ID as the `productId` above (see [Pinning the app](#pinning-the-app)). See
   [Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). A credential bound to
   the `ms-store` outlet (`outletId`) is preferred over an unbound one.

3. **The first submission is made by hand** in Partner Center, including the age-ratings
   questionnaire. Microsoft's API cannot create an app or its first submission.

Without the credential, without an `ms-store` outlet, or with a credential that is not pinned to
the outlet's Store ID, the connector does not run for the product: the poller skips it before
any request. `GET …/distribution/connectors/ms-store` says why in `inert` (`no_outlet`,
`no_credential`, `pin_missing` or `pin_mismatch`, with a sentence on what to do).

**The platform's team key.** A product with no `ms-partner-center` credential of its own falls back to the platform's
team-level credential for this store, only for the app a platform admin assigned to the product
(the same `pin_missing` / `pin_mismatch` reasons, with `credentialSource: "platform"`). A key of
the product's own always wins. See [Store connections](/docs/admin/store-connections/).

### The Partner Center app

Microsoft's submission API authenticates an **Entra ID (Azure AD) application** that you add to
your Partner Center account:

1. In Partner Center → **Account settings** → **User management** → **Microsoft Entra
   applications**, add (or create) an application for Polaris Key. Use a **dedicated** one.
2. Give it the **Manager** role — the role Microsoft's submission API requires — and nothing
   wider. Partner Center has no per-app scope for this role, which is why the credential is
   pinned to one app.
3. On the application's page, copy the **Tenant ID** and **Client ID**, then **Add new key** and
   copy the key: that is the client secret. You will not see it again. The **Seller ID** is in
   Partner Center's account settings, with your organization's legal info.
4. Store all four as the `ms-partner-center` credential, with the pin.

To rotate, add a new key in Partner Center, store it under the same credential id (the cached
token drops with the old value), then remove the old key.

## Pinning the app

A Partner Center application with the Manager role can read every app of your seller account.
The app the connector reads is named by the `productId` in `.pkey/distribution`, and every
resync takes that from the repo. Without a pin, whoever can push that file could point your
credential at another app of the account and copy its submissions into this product.

So the credential carries a **pin** that only a platform admin sets: the Store ID it may be used
for in this product. The connector runs only while the manifest's `productId` equals the pin.

- **Set it with the credential.** Distribution → Outlet credentials asks for the Store ID with the other fields.
  Over the API, send it as `pin`:

  ```http
  PUT /manage/api/products/<slug>/outlet-credentials/partner-center
  {"kind": "ms-partner-center", "value": {"tenantId": "…", "clientId": "…", "clientSecret": "…", "sellerId": "…"}, "pin": "9NBLGGH4R315"}
  ```

- **Re-pin without the secret.** The pin icon on the credential's row, or a `PUT` with the pin
  and no value: `{"kind": "ms-partner-center", "pin": "9NBLGGH4R315"}`.
- **Every change is audited** as `outlet_credential.pin`, with the old and the new Store ID.
- **A credential stored without a pin does nothing** (`pin_missing`).

If the manifest's `productId` changes, the connector stops (`pin_mismatch`) until the manifest
names the pinned app again, or until you **check that the new Store ID really is this product's
app** and re-pin.

## What it reads

Every tick sends only these GETs, to `https://manage.devcenter.microsoft.com`, plus the
fallback submission of a published one whose gradual rollout is partial:

```http
GET /v1.0/my/applications/{productId}
GET /v1.0/my/applications/{productId}/submissions/{pending and last published}
GET /v1.0/my/applications/{productId}/listflights
GET /v1.0/my/applications/{productId}/flights/{flightId}/submissions/{pending and last published}
```

The last line runs only for the flights your map names. A read that fails (a 5xx, rate limiting
after the retries) **writes nothing**: the next tick reads again.

Two limits come from Microsoft:

- **Mandatory app updates and Store-managed consumable add-ons.** The submission API answers 409
  for such an app. The connector shows it as **not readable** (`readable: false`) and skips it —
  not an error. Report its state from CI instead.
- **Pricing Version 2.** For an app on the newer pricing model the API returns an unknown price
  tier. The connector never reads pricing, so status, packages, rollouts and flights read
  normally.

## How the Store maps

A submission carries one or more **packages**, each with a 4-part version (`1.2.3.0`). Each one
is matched to the release build whose build number is that version, on platform `windows` with
an MSIX format (`msix`, `msixbundle`, `msixupload`, or the `appx` forms). Give each Windows build
its `buildNumber` in your release descriptor. A package marked for deletion is ignored.

| Store status          | Submission                  | Availability |
| --------------------- | --------------------------- | ------------ |
| `PendingCommit`       | `prepared`                  | `pending`    |
| `CommitStarted`       | `submitted`                 | `processing` |
| `PreProcessing`       | `submitted`                 | `processing` |
| `Certification`       | `in-review`                 | `in-review`  |
| `Release`             | `approved`                  | `approved`   |
| `PendingPublication`  | `pending-developer-release` | `approved`   |
| `Publishing`          | `approved`                  | `approved`   |
| `Published`           | `released`                  | `live`       |
| `CommitFailed`        | `rejected`                  | `rejected`   |
| `PreProcessingFailed` | `rejected`                  | `rejected`   |
| `CertificationFailed` | `rejected`                  | `rejected`   |
| `ReleaseFailed`       | `approved`, `failed`        | `approved`   |
| `PublishFailed`       | `approved`, `failed`        | `approved`   |
| `Canceled`            | `cancelled`                 | `removed`    |

A rejected submission keeps Microsoft's `errors` (code and details) and the dates of its
certification reports in its detail, and its `reviewedAt` is the newest report's date. A release
or publish failure comes after certification passed, so it stays `approved` and is flagged
`failed: true` with the errors. A status Microsoft adds later reads as nothing until the connector
knows it — never as `live`.

The release of a submission is that of its highest matched package version. When a release has
more than one submission in flight, the non-flighted one speaks before a flight's, and a newer
one before an older. A build in several submissions takes the most-served availability; a build
the connector reported before that no submission carries any more becomes `removed`.

### Gradual rollouts

A published submission's gradual package rollout is mirrored on each of its (outlet, channel):

| `packageRolloutStatus`            | Outlet rollout                               | The new submission's builds | The fallback submission's builds |
| --------------------------------- | -------------------------------------------- | --------------------------- | -------------------------------- |
| `PackageRolloutInProgress`        | `active`, at the percentage (25 % = 2500 bp) | `live`                      | `live`                           |
| `PackageRolloutStopped`           | `halted`                                     | `approved`                  | `live`                           |
| `PackageRolloutNotStarted`        | none                                         | `approved`                  | `live`                           |
| `PackageRolloutComplete`, or none | `complete` (10000 basis points)              | `live`                      | not read (`removed`)             |

While a rollout is partial, every customer it does not reach gets the **fallback submission**
(`fallbackSubmissionId`, normally the previously published one). The connector reads it too and
keeps its builds `live` beside the new submission's, as the Google Play connector keeps the
previous completed release live beside a staged or halted one. The fallback never mirrors a
rollout and never changes its release's submission row. Once the rollout completes, the fallback
is no longer read, and its builds become `removed` unless the new submission carries them.

The row is marked `mirrored` and refuses direct edits; change the rollout with CI or in Partner
Center. Gradual rollout applies to MSIX packages only, and **halting it never rolls installed
users back** — new customers get the fallback submission. The mirror informs the feed and the
console; it is not an access control.

## Security

- The connector calls only `login.microsoftonline.com` (for its token) and
  `manage.devcenter.microsoft.com`, for the one Store ID your outlet names and your pin allows,
  and only with GET; nothing in a response (a `resourceLocation`, a `@nextLink`) can redirect it.
- The client secret never leaves custody: the connector uses one-hour Entra tokens minted from
  it and cached sealed, every open of the secret is in the activity log, and errors record an
  HTTP status, never a response. A submission's upload URL (`fileUploadUrl`, a writable storage
  link) is never stored.
- With the Manager role, a stolen secret could publish to any app of your seller account. Keep
  the application dedicated to Polaris Key and rotate its key if it may have leaked.

The full analysis is in the threat model (`docs/security/THREAT-MODEL.md`, "Store connectors:
Microsoft Store").

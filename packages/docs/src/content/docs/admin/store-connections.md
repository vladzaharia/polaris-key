---
title: "Store connections"
description: "The platform's team-level store credentials (App Store Connect, In-App Purchase, Google Play, Microsoft Store, Steam), the shared store settings, the apps list, and assigning an app to a product."
sidebar:
  order: 13
---

A **store connection** is one credential per store held by the _platform_, not by a product: the
App Store Connect team API key, the team In-App Purchase key, the Google Play developer account's
service account, the seller's Partner Center app and the Steam group's publisher key. It exists so
you can see every app the team key reaches, assign an app to a product from that list instead of
typing its id, and let a product with no store key of its own use the team key — for its own app
only.

The console page arrives with the Platform section; until then everything here is the admin API
under `/manage/api/platform/store-connections`, platform admins only (anyone else gets 403).

## Credentials and where they come from

| Store           | Slot                  | Kind (same shape as the outlet credential) | Worker secret                     | A product's pin names |
| --------------- | --------------------- | ------------------------------------------ | --------------------------------- | --------------------- |
| App Store       | `api-key` (primary)   | `asc-api-key`                              | `PLATFORM_ASC_API_KEY`            | the app's Apple ID    |
| App Store       | `in-app-purchase-key` | `app-store-server-key`                     | `PLATFORM_APP_STORE_SERVER_KEY`   | the bundle id         |
| Google Play     | `service-account`     | `google-service-account`                   | `PLATFORM_GOOGLE_SERVICE_ACCOUNT` | the package name      |
| Microsoft Store | `partner-center`      | `ms-partner-center`                        | `PLATFORM_MS_PARTNER_CENTER`      | the Store ID          |
| Steam           | `publisher-key`       | `steam-publisher-key`                      | `PLATFORM_STEAM_PUBLISHER_KEY`    | the game's app id     |

Each slot has two sources, and the first one present wins:

1. **The console credential** — `PUT /manage/api/platform/store-connections/<store>` (the primary
   slot) or `…/<store>/credentials/<slot>` with `{"value": …}`. It is validated exactly like the
   outlet credential of that kind (a `.p8` must be a P-256 key, a Google key must name Google's
   token endpoint; a Google key file may be pasted as the JSON text), sealed under the platform
   KEK, and answered with its metadata only. `DELETE` clears it.
2. **The Worker secret** — the same JSON, set with `wrangler secret put` (see DEPLOYMENT.md §4).
   Use it to bootstrap; prefer the console credential afterwards.

`GET /manage/api/platform/store-connections` lists every store: each slot's `configured`, the
`source` in use (`console` or `secret`), its metadata (key id, issuer id, client email, tenant,
client and seller ids), the console row's health (`lastUsedAt`, `lastOkAt`, `lastError`), whether
the Worker secret is present and valid, the store's settings, and which product holds which app.
No response ever carries a key.

## Settings shared by every product

| Setting                              | Source                                 | Feeds                                                                                     |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `app-store` / `teamId`               | console, else `PLATFORM_APPLE_TEAM_ID` | App Attest: the default when a trust policy gives no `appAttest.teamId`                   |
| `google-play` / `pushAudience`       | console                                | Google Play RTDN: the default when a product's commerce settings omit `play.pushAudience` |
| `google-play` / `pushServiceAccount` | console                                | the same for `play.pushServiceAccount`                                                    |
| `google-play` / `cloudProjectNumber` | console                                | Play Integrity: the default when a trust policy gives no `cloudProjectNumber`             |
| `steam` / `appIds`                   | console                                | apps added to the Steam list (comma-separated app ids)                                    |

Set one with `PUT …/<store>/settings/<key>` and `{"value": "…"}`; `DELETE` clears it. A product's
own explicit value always wins over the platform default.

## The apps list

`GET …/<store>/apps` lists every app the store's primary credential can see, with the store's
own status, and the product each app is assigned to (`assignedProduct`, `assignedVia`:
`platform` or `own-credential`). The list is cached for a minute; add `?refresh=1` to read the
store again.

- **App Store** — every app of the team, its newest App Store versions with the review and
  release state (`WAITING_FOR_REVIEW`, `PENDING_DEVELOPER_RELEASE`, `READY_FOR_DISTRIBUTION`, …),
  its newest TestFlight versions, and the phased release of a live or pending version.
- **Google Play** — every app the service account may access, with each track's releases (status,
  rollout fraction, version codes) for the first ten apps; an app the account cannot edit shows
  its error instead.
- **Microsoft Store** — every app of the seller, its last published and pending submissions, and
  the pending submission's status.
- **Steam** — the apps the publisher key may query, plus the operator-entered `steam/appIds`. A
  key without the listing permission still shows the operator-entered apps (`listed: false`).

## Assigning an app to a product

`PUT …/<store>/apps/<appId>/product` with `{"product": "<slug>"}` gives the product its **pin**
on the store's team credential — the one app that product may use the team key for. For the App
Store it also pins the In-App Purchase key to the app's bundle id. If the product holds keys of
its own, they are re-pinned to the same app through the usual audited pin path, so the assignment
means the same thing whichever key is used.

The assignment is refused with **409 `app_assigned_elsewhere`** while another product holds the
app, whether by its platform pin or by its own credential's pin; release it first with `DELETE
…/<store>/apps/<appId>/product`. An app the team key cannot see is a 404. Deleting a product
releases its apps.

Check that the app really is the product's before assigning it: the team key reaches every app of
the team, and the assignment is what decides which one a product's connector acts on.

## How a product uses the team key

A product's store connector (App Store Connect, Google Play, Microsoft Store) and its commerce
bridge (App Store, Google Play, Steam) use the product's **own** credential whenever it has one.
Only a product with no credential of that kind falls back to the team key, and only when its pin
equals the app the product's manifest or commerce settings name. Otherwise the connector is inert
with the same reasons as for its own keys, and the connector status says `credentialSource:
"platform"`:

- `pin_missing` — no app is assigned to the product: assign it here.
- `pin_mismatch` — the manifest names a different app than the one assigned: fix the manifest, or
  assign the manifest's app after checking it.

An own credential that is unpinned or pinned elsewhere never falls through to the team key.

## Audit

Every key a product's connector opens is a `platform_credential.use` row in that product's
[activity](/docs/admin/activity/); an assignment is an `outlet_credential.pin` row there too.
Credential and setting changes, assignments and the team-wide opens behind the apps list are
recorded in the platform audit trail with the admin who made them.

See also [Secrets & keys](/docs/admin/secrets-and-keys/) for a product's own outlet credentials
and their pins, and [the KEK keyring](/docs/admin/kek/): the re-seal sweep includes the console
store credentials.

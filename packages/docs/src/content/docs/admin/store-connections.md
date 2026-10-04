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

In the console it is **Platform → Store connections**. The same data is the admin API under
`/manage/api/platform/store-connections`. Both are for platform admins only (anyone else gets 403).

## The console page

Pick a store from the tiles at the top (App Store, Google Play, Microsoft Store, Steam). The
choice is kept in the URL (`?store=google-play`), so a link opens the same store. Each tile shows
the state of the store's primary credential and how many apps are assigned.

- **Credentials.** One row per slot (the App Store has two: the App Store Connect API key, which
  lists the apps, and the In-App Purchase key). Each row shows whether the credential is present,
  where it comes from (stored in the console, or a Worker secret by name), the account it belongs
  to (issuer ID, key ID, service account email, seller, tenant and client IDs) and, for a console
  credential, when it last worked and was last used. When the store refused the last check, its
  status line is shown (`Partner Center token: HTTP 401`). The page never shows a key, and has no
  field to enter one.
  - **Working**: the store accepted the console credential at its last use.
  - **Present, not checked**: present but not checked yet. A Worker secret records no check
    history; Re-check lists the apps live and shows any error the store returns.
  - **Last check failed**: the store refused it; the status line says how.
  - **Secret invalid**: the Worker secret is set but its JSON did not pass the validator (a wrong
    field name, a PEM that lost its line breaks).
  - **Not set**: no credential in either source.
- **Account.** The store's shared settings (the Apple Developer Team ID, Play's push identity and
  project number, Steam's operator-entered app ids), with the source of each value.
- **Apps.** Every app the team credential can see, with its identifiers, the store's own status
  and the product that holds it ("through the product's own key" when a product's own credential
  pins it). Search and the assignment filter are kept in the URL. **Re-check** reads the store
  again instead of the one-minute cache (`?refresh=1`), and refreshes the credential's health.
  For Google Play, **Show track status** is off by default: it adds `?tracks=1`, which opens and
  deletes a short edit per app (see below).
- **Assign to product…** (an app's row menu) asks you to choose a product and confirm (a caution
  confirmation: the change is reversible and changes what that product's connectors act on). The
  confirmation lists what will be pinned, including the bundle ID for the In-App Purchase key.
  Afterwards a result panel lists every pin set, any pin released, the product's own keys
  re-pinned, and the own keys left alone because their account could not be told from their
  metadata. Check those and re-pin them on the product's Keys & secrets page. An app held through
  a product's own key can only be assigned to that product.
- **Release from …** (the row menu of an assigned app) asks for the same caution confirmation.
  The product's connectors that used the team credential stop with `pin_missing` until an app is
  assigned again. Keys the product holds of its own keep their pins.

When an assignment is refused, the dialog stays open and says why in plain words:

- **Another product already holds this app** (`app_assigned_elsewhere`): an app belongs to one
  product at a time, through the team credential or through a key of its own. Release it from
  that product, or re-pin that product's own key, and then assign it.
- **The product's own key belongs to another account** (`own_credential_other_account`): the
  product holds a key of its own from a different store account than the team credential.
  Assigning would point the two keys at different accounts. Re-pin or delete that key on the
  product, and then assign again.

### Adding a credential

A store with no team credential shows how to add one. Add it as a Worker secret through the
**Sync Worker secrets** workflow, so the key never passes through a terminal, a chat or the
console. From the machine that holds the key file:

```sh
gh secret set PLATFORM_ASC_API_KEY --env production < key.json   # the secret name of the slot
gh workflow run sync-worker-secrets.yml -f target=prod
```

The secret names and JSON shapes are in [Deploy](/docs/admin/deploy/) (DEPLOYMENT.md §4). After
the workflow runs, the store's tile and credential row show the credential as present. Re-check
then lists its apps.

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
own explicit value always wins over the platform default. For the trust policy, the block still
turns the check on: `"appAttest": {"environment": "production"}` (no `teamId`) enables App Attest
with the platform Team ID, and `"playIntegrity": {}` enables Play Integrity with the platform
project number. A product on the platform's Play service account (no
`google-service-account` of its own, its package assigned here) also gets its Play Integrity
decode token through that account.

## The apps list

`GET …/<store>/apps` lists every app the store's primary credential can see, with the store's
own status, and the product each app is assigned to (`assignedProduct`, `assignedVia`:
`platform` or `own-credential`). The list is cached for a minute; add `?refresh=1` to read the
store again.

- **App Store** — every app of the team, its newest App Store versions with the review and
  release state (`WAITING_FOR_REVIEW`, `PENDING_DEVELOPER_RELEASE`, `READY_FOR_DISTRIBUTION`, …),
  its newest TestFlight versions, and the phased release of a live or pending version.
- **Google Play** — every app the service account may access. Track status (each track's
  releases: status, rollout fraction, version codes, for the first ten apps) only with
  `?tracks=1`, because reading it opens and deletes a short edit per app; an app the account
  cannot edit shows its error instead. Assignment never reads tracks.
- **Microsoft Store** — every app of the seller, its last published and pending submissions, and
  the pending submission's status.
- **Steam** — the apps the publisher key may query, plus the operator-entered `steam/appIds`. A
  key without the listing permission still shows the operator-entered apps (`listed: false`).

## Assigning an app to a product

`PUT …/<store>/apps/<appId>/product` with `{"product": "<slug>"}` gives the product its **pin**
on the store's team credential — the one app that product may use the team key for. For the App
Store it also pins the In-App Purchase key to the app's bundle id. If the product holds keys of
its own, they are re-pinned to the same app through the usual audited pin path, so the assignment
means the same thing whichever key is used — but only keys of the same store account as the team
key (App Store: the same issuer id; Microsoft Store: the same seller id). A key of another account
refuses the whole assignment (**409 `own_credential_other_account`**, naming the keys); a key whose
account cannot be told from its metadata (a Google service account with another email, a Steam
key) is left as it is and listed in `ownCredentialsSkipped`. The assignment is written as one
batch: every pin, re-pin and audit row, or none.

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

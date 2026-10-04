---
sidebar:
  order: 9
title: "Commerce bridge"
description: "Store purchases on the App Store, Google Play and Steam become licence flags per deliverable: the store-product map, the purchase binding, verification with each store, refunds and revocations, and what to set up in each store."
---

A player who buys a store product you mapped to a licence flag — say the product that unlocks
Diceroll's supporter skins, flag `extras.diceSkins` — gets that flag on their Polaris licence, for
**every release** of the deliverable, and loses it on a refund or revocation. The device only
forwards what its store handed it; the Worker verifies every purchase with the store itself.

Supported: one-time, non-consumable purchases on the **App Store**, **Google Play** and **Steam**
(DLC). Not supported: subscriptions, consumables, the Microsoft Store, external offers or
alternative billing.

## How it works

1. **Bind before buying.** The game calls `PolarisKey.commerce.get_binding()`
   (`GET /<product>/distribution/commerce/binding`, device token) and gets the licence's
   **binding** — a random UUID, not the licence id and not personal data — plus the store products
   on sale. It hands the binding to the store with the purchase: Apple's `appAccountToken`, Play's
   `obfuscatedAccountId`, or the identity of a Steam web-API ticket. A device without a licence
   is told `not_entitled` / `no_license`; the game enrols first. The bridge never creates a
   licence.
2. **Claim.** After the store says the purchase went through, the game calls
   `PolarisKey.commerce.claim(store, payload)` (`POST …/commerce/claim`) with the StoreKit JWS,
   the Play purchase token, or a Steam ticket. The Worker verifies it with the store, checks that
   the store's own record names **the caller's** binding, and grants the mapped flag through the
   License service. Then the game syncs: the next licence document carries the flag. On the App
   Store the game finishes the transaction only after the claim answered ok.
3. **Store notifications** keep the flag honest afterwards: an App Store refund or revocation,
   a voided Play purchase, or a Steam ownership re-check removes it.

The flag lands in the licence document **after** the licence's profiles and **before** the
licence's own overrides, so an operator override of the same flag always wins. Gated delivery
reads it like any licence flag.

A transaction bound to one licence never grants another: a claim with another licence's binding
is refused (`binding_mismatch`), a purchase already recorded for a licence cannot be claimed by
any other (`bound_elsewhere`), and a purchase made without a binding is refused (`unbound`).

### The App Store's cross-store rule

App Store guideline 3.1.3(b) lets content bought elsewhere unlock in an iOS or macOS App Store
build only if the same content is also sold there as an in-app purchase. The licence document
stays the same on every outlet; the Godot SDK applies the rule: on an `app-store` or `testflight`
outlet, `PolarisKey.commerce.hidden_here(flag)` is true for a flag you sell on Play or Steam but
not on the App Store, and `is_unlocked(flag)` combines it with the licence. Map an App Store
product to the same flag to unlock it there. A flag you grant without selling it (a profile, an
override) is never hidden.

## Commerce needs License

The bridge writes licence flags, so it runs only while the **License** service is on. With License
off, the commerce routes answer not-found and the console refuses commerce settings and product
mappings (`409`, `commerce_requires_license`).

## Setting it up

Everything is operator-owned: no `.pkey/` manifest field reaches it, so a repo push cannot decide
what a payment unlocks or whose purchases are believed. As a platform admin:

1. **Store the store's credential** in Distribution → Outlet credentials ([Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials)),
   pinned to the app: an `app-store-server-key` pinned to the bundle id, a
   `google-service-account` pinned to the package name (the Google Play connector's), a
   `steam-publisher-key` pinned to the game's app id.
2. **Set the commerce settings**, one block per store you sell on:

   ```http
   PUT /manage/api/products/<slug>/distribution/commerce/settings
   {
     "appStore": { "bundleId": "gg.vlad.diceroll", "appAppleId": 1234567890 },
     "play": {
       "packageName": "gg.vlad.diceroll",
       "pushAudience": "https://key.plrs.im/diceroll/distribution/hooks/play-rtdn",
       "pushServiceAccount": "rtdn-push@my-project.iam.gserviceaccount.com"
     },
     "steam": { "appId": "480" }
   }
   ```

   **Set `appAppleId`** (the app's numeric Apple ID, App Store Connect → App Information):
   Production notifications for any other Apple ID are then ignored, which closes the case of a
   notification URL shared between two apps with the same bundle id across teams. It is optional
   only because sandbox notifications do not carry it.

   A store runs only when its block is present **and** an active credential is pinned to the
   same app. `acceptSandbox` (App Store) and `acceptTestPurchases` (Play) default to `false`: a
   production product refuses sandbox transactions and licence-tester purchases. Turn them on
   only on a staging product. StoreKit Testing (`Xcode`) transactions are always refused.

3. **Map each store product** to a flag and a deliverable (`app`, or a pack the Release service
   knows):

   ```http
   PUT /manage/api/products/<slug>/distribution/commerce/products
   { "store": "app-store", "productId": "gg.vlad.diceroll.skins", "flag": "extras.diceSkins", "deliverable": "app" }
   ```

   `productId` is the App Store product id, the Play product id, or the Steam DLC's app id.
   `DELETE …/commerce/products/<store>/<productId>` removes a mapping; flags already granted stay
   until a refund revokes them.

4. **Point each store's notifications at the Worker** (below).

`GET …/distribution/commerce` shows the settings, whether each store is set up (and why not), the
product map, recent purchases (hashed keys only) and recent notifications.

## App Store

**Verification.** A StoreKit 2 transaction and every App Store Server Notification are JWS signed
by Apple. The Worker checks the certificate chain in the header: three certificates ending at
Apple Root CA - G3 (pinned in code), Apple's marker extensions on the intermediate and the leaf,
every signature and validity period, then the JWS signature. It then re-reads the transaction
from the **App Store Server API** with your In-App Purchase key, and Apple's copy decides: the
bundle id, the environment, that it is a non-consumable owned by the purchaser (not a Family
Sharing copy), the `appAccountToken`, and whether it was refunded or revoked.

**Notifications.** `ONE_TIME_CHARGE` grants, `REFUND` and `REVOKE` revoke, `REFUND_REVERSED`
grants again; `TEST` and every other type is stored. A notification for another app, or a
sandbox notification on a production product, is acknowledged and ignored. If Apple's API is
down the hook answers `503` and Apple redelivers.

**What you set up in App Store Connect:**

- the in-app purchases themselves (non-consumable), in a cleared agreements/tax/banking state;
- **App Information → App Store Server Notifications**: Production Server URL
  `https://key.plrs.im/<product>/distribution/hooks/app-store`, **Version 2** (set the Sandbox
  URL to a staging product's hook, or leave it empty);
- an **In-App Purchase key** (Users and Access → Integrations → In-App Purchase) — stored as the
  `app-store-server-key`, pinned to the bundle id. This is not the App Store Connect API key the
  [App Store Connect connector](/docs/services/distribution/app-store-connect/) uses;
- a **Sandbox Apple Account** to test with (on a staging product with `acceptSandbox`).

## Google Play

**Verification.** Every decision comes from `purchases.products.get` through the
[Google Play connector](/docs/services/distribution/google-play/)'s client and its pinned service
account: only a purchase in state **PURCHASED** grants (a **PENDING** purchase is recorded and
grants nothing until it completes), a licence-tester purchase only where you accept test
purchases, and `obfuscatedExternalAccountId` must be the caller's binding. A granted purchase is
**acknowledged once** — right away, or on the next connector tick if that failed — well inside
Google's three-day limit.

**Notifications.** Real-time developer notifications arrive over a Pub/Sub **push**
subscription. The Worker requires Google's OIDC token on every push: signed by Google, for your
audience, from your push service account, with a verified email. A purchase notification is
re-read from the API; a voided-purchase notification revokes. As a backstop the connector tick
polls the **Voided Purchases** API once a day.

**What you set up:**

- the in-app products (one-time products) in Play Console;
- the service account the Google Play connector uses, with the **View financial data** and
  **Manage orders and subscriptions** permissions for the app (needed to read and acknowledge
  purchases);
- a **Pub/Sub topic**, with `google-play-developer-notifications@system.gserviceaccount.com`
  granted **Pub/Sub Publisher** on it, named in Play Console → Monetization setup → Real-time
  developer notifications;
- a **push subscription** on that topic to
  `https://key.plrs.im/<product>/distribution/hooks/play-rtdn`, with **authentication enabled**: a
  service account (its email goes in `pushServiceAccount`) and an audience (it goes in
  `pushAudience`; the endpoint URL is a good choice);
- **licence testers** to test with (on a staging product with `acceptTestPurchases`).

## Steam

**Verification.** The game creates a web-API ticket with
`Steam.getAuthTicketForWebApi(bindingId)` (GodotSteam) and claims with
`{ticket, dlcAppId}`. The Worker calls `ISteamUserAuth/AuthenticateUserTicket` with your
publisher key and the binding as the ticket's identity — so a ticket made for another licence
fails — then `ISteamUser/CheckAppOwnership` for the DLC. The account must own the DLC outright: a permanent licence (not Family Sharing, a free weekend or the PC Café programme), held by the account itself, not self-cancelled and not a timed trial. Steam does not push refunds, so
every active Steam grant is re-checked **weekly** on the connector tick (and on every claim): a
refunded DLC loses its flag within a week.

**What you set up in Steamworks:**

- the DLC (each one is its own app id);
- a **Web API publisher key** (Users & Permissions → Manage Groups → a group that can see only
  this game → Web API key) — stored as the `steam-publisher-key`, pinned to the game's app id;
- a test account that owns the DLC (and one that does not).

## Device checklist

Once the store accounts exist, check one real sandbox purchase per store end to end: the
purchase grants the flag (the next licence document carries it) and a refund removes it.

## Reference

- Routes: `GET /<product>/distribution/commerce/binding`,
  `POST /<product>/distribution/commerce/claim`, `POST /<product>/distribution/hooks/app-store`,
  `POST /<product>/distribution/hooks/play-rtdn` — see the [route table](/docs/reference/routes/).
- Tables: `dist_store_products`, `dist_purchase_bindings`, `dist_purchases` (Distribution) and
  `license_store_grants` (License) — see the [data model](/docs/reference/data-model/).
- Security: the threat model's commerce section (`docs/security/THREAT-MODEL.md`).

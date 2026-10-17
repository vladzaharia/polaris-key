> Research note for [Godot on Polaris Key](../README.md), 2026-10-09, revised 2026-10-16. Spike
> CM-27 ([brief](../program/wp/CM-27-spike-store-purchase-parity-microsoft.md)), filed by the DX
> consolidation plan in Track H. A working paper kept for its evidence and sources; the README
> synthesis is the cross-checked position.

# CM-27: Store purchase parity (Microsoft Store, itch.io, consumables)

Desk research only. Vendor documentation was read raw and the repository was read at `origin/main`
`e5ec19e53`. No accounts, no purchases, no credentials, and no call to a vendor API that needs one.
Tags: [V] primary source read raw, [M] measured, [S] summary or search-engine digest, [I] inference,
[U] unknown, needs a live check by someone with an account.

This revision replaces the 2026-10-09 draft. Every vendor page was fetched again on 2026-10-16 (local
time; the fetch log reads 2026-10-17 UTC), and the repository's store adapters and native bridges
were read. Six of the draft's claims were wrong against the code or the current documentation; they
are listed under "Corrections".

## Question

How do the Microsoft Store (desktop, with Xbox noted), itch.io and the consumable/durable split on the
App Store, Google Play, Steam, the Microsoft Store, itch.io and Epic map onto Polaris Key's offers,
SKUs, add-ons and single purchase ledger (CM-20), including refunds and revocation? What should CM-28
build, and which Microsoft Store and itch.io follow-ups does the graph need?

## Short answer

1. **Microsoft Store: parity is reachable on the server, behind four human gates.** Purchases of the
   app, durables and store-managed consumables can be verified with the Collections API. That needs an
   Entra app, a Store ID key minted on the client and `publisherQuery` (v9) [V]. Refunds arrive as push
   events only through a **Clawback queue that Microsoft sets up on request (1–2 weeks)** [V]. The other
   refund APIs are deprecated for refund detection or must not be polled on a schedule [V]. Store
   policy 10.8.1(a) requires a game to sell digital goods through Microsoft's in-app purchase API [V].
   Microsoft names "commerce" as an MSIX capability, so a Godot game needs an MSIX build [V]. The Godot
   SDK already ships a Windows `StoreContext` bridge (P5-07). It covers updates only today, so purchase
   is an additive set of operations on it [V: repo].
2. **itch.io: ownership of the game, verified with the player's own itch.io sign-in, with no developer
   secret in the Worker.** The current API documents an OAuth authorization-code flow with PKCE and no
   client secret. `GET /games/{id}/ownership` accepts only an OAuth-application token, and `profile:owned`
   lists the player's keys with a `purchase_id` [V]. This keeps S-15's rule that the unscoped itch.io key
   lives only in CI. itch.io has no in-app purchases or consumables, and documents no refund signal or
   rate limit [V by absence]. The signed outlet capabilities already give `itch` builds
   `commerce: "own"`. Add-ons and consumables on itch.io builds therefore belong to Polaris Key checkout
   when it ships, not to itch.io projects [V: repo, I].
3. **Consumables work the same way on every store that has them: Polaris Key's ledger holds the balance.**
   The App Store, Google Play and the Microsoft Store all let the server confirm a consumable, credit it
   once per store transaction and drain the store side. That fits CM-20 D1
   (`offer.quantity × store quantity`) and LX-42's `grants.quantity` [V, I]. Steam consumables are a
   separate product
   (`ISteamMicroTxn`, or the Inventory Service) that CM-20 §11 already rules out. Epic has consumable
   entitlements with a redeem call and a clawback query, but there is no Epic channel yet [V].
4. **Partial-refund fields are now documented for both mobile stores.** On the App Store, `revocationType`
   is `REFUND_FULL` or `REFUND_PRORATED`, with `revocationPercentage` in milliunits. On Google Play,
   `refundableQuantity` and the voided list's `voidedQuantity` cover the same case. This closes CM-20 §12's
   unverified item [V].
5. **Recommendation.** Keep CM-28 to App Store and Google Play consumables, with four extra acceptance
   criteria. Register three follow-ups: Microsoft Store commerce in the Worker, the Godot `StoreContext`
   purchase operations, and itch.io ownership through a player sign-in. Defer Steam microtransactions
   and Epic. Details are under "Recommendation"; the proposed graph rows are under "Work-package briefs
   that change".

## Corrections to the 2026-10-09 draft

| Draft said                                                        | Fact                                                                                                                                                                                                                                                                                                                              | Evidence        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `ms-store` and `itch` need no table rebuild, because of CM-20 D2  | D2 covers only the new `dist_offer_skus`. `dist_purchases.store` (`0052_commerce.sql:52`) and `license_store_grants.store` (`:71`) are table CHECKs, so widening them means a table rebuild; CM-20 §11 already says so. `grants.source` is a trigger and costs nothing to widen (`0105_a_licensing_core.sql:72-80`)               | [V: repo]       |
| itch.io: store the developer's account-wide API key in the Worker | S-15 decided that the unscoped itch.io key lives only in CI (`notes/S-15-storefront-provisioning.md:147-148`), and the adapter says so (`core/storefront/stores/itch.ts:19-20`). The player-OAuth path below needs no developer secret                                                                                            | [V: repo, docs] |
| itch.io: a player JWT cannot read ownership (2020 GitHub issue)   | The current docs add `game:view:ownership` (`GET /games/{id}/ownership`, OAuth-application tokens only) and `profile:owned` (`/profile/owned-keys` with `purchase_id`). OAuth now uses an authorization-code flow with PKCE, no client secret and non-expiring tokens. A key handed over by the itch.io app has only `profile:me` | [V]             |
| Microsoft add-on SKUs can be created by API ("declared (A-18f)")  | The adapter declares `iap` **unsupported**: "add-ons wait for a commerce extension" (`core/storefront/stores/microsoftStore.ts:81-85`). An add-on is a copy-card step                                                                                                                                                             | [V: repo]       |
| No Godot native bridge for Store commerce exists                  | `sdks/godot/native/windows/storecontext/pkey_storecontext.cpp` (P5-07) already runs `StoreContext` on an MTA worker thread with `IInitializeWithWindow`, and reads package identity. It does updates only, so purchase operations are additive                                                                                    | [V: repo]       |
| Microsoft consume needs a **deterministic** `trackingId`          | Microsoft requires a retry with the **same** `trackingId`, user, product and quantity. A random id written to the pending row before the call is enough; determinism is not required                                                                                                                                              | [V]             |

## Method

Environment: macOS (Darwin 27.0, arm64), `curl` 8.x, `python3 -I` for HTML-to-text, Node 26 for the
graph script. No credentials and no account. Commands (outputs went to a scratch directory and were
not committed):

```sh
# Apple: the DocC JSON behind the client-rendered pages
curl -sS -o <out>.json "https://developer.apple.com/tutorials/data/documentation/appstoreserverapi/get-transaction-history.json"
#   ... also send-consumption-information, consumptionrequest, jwstransactiondecodedpayload,
#   revocationtype, revocationpercentage, type, and appstoreservernotifications/notificationtype
# Google Play: the Developer API discovery document (revision 20261015)
curl -sS -o disc.json "https://androidpublisher.googleapis.com/\$discovery/rest?version=v3"
# itch.io: the raw pages
curl -sS -L -o <out>.html "https://itch.io/docs/api/serverside"   # and api/oauth,
#   itch/integrating/manifest-actions.html, creators/payments
# Epic: the Next.js page data (the text sits in __NEXT_DATA__ compiledSource)
curl -sS -L -o <out>.html "https://dev.epicgames.com/docs/web-api-ref/ecom-web-apis"
```

Microsoft Learn pages were read through a page fetch that returned each page's own Markdown and front
matter, including `ms.date` and `updated_at`, so they are tagged [V]. The repository was read at the file
and line references given. No experiment code applies; nothing in `prototype/` touches store commerce.

## Results

### 1. What the repository has today (the code is the fact)

| Area                          | Where                                                                                                                        | Fact                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store vocabulary              | `packages/worker/src/core/licensing/storeGrants.ts:37`                                                                       | `STORES = ["app-store", "play", "steam"]`                                                                                                                                                                                                                                                         |
| Ledger CHECKs                 | `migrations/0052_commerce.sql:31,52,71`; `0105_l_licensing_commerce.sql:14`; `0105_a_licensing_core.sql:114`                 | `dist_store_products`, `dist_purchases`, `license_store_grants` and `dist_store_product_entitlements` each CHECK the same three stores. `device_store_identities` CHECKs `store = 'steam'`. `grants.source` is a replaceable trigger (`0105_a:72-80`)                                             |
| Apple                         | `services/distribution/commerce/apple.ts:254`                                                                                | `if (tx.type !== "Non-Consumable") reject("unsupported_type")`. The host is already `api.storekit.apple.com` (`:60`)                                                                                                                                                                              |
| Play                          | `commerce/play.ts:1-25, 401-470`                                                                                             | `purchases.products.get` (v3) and `:acknowledge`. Only `purchaseState` 0 grants, and `obfuscatedExternalAccountId` must be a licence binding. No `:consume` call yet                                                                                                                              |
| Periodic work                 | `commerce/recheck.ts:1-17, 46-50`                                                                                            | Play acknowledgement retries inside 3 days, a daily Play voided poll (30-day lookback), a weekly App Store re-read and a weekly Steam ownership re-check                                                                                                                                          |
| Outlet capability on the wire | `packages/shared-protocol/src/distribution.ts:86-90`                                                                         | `"ms-store": STORE` (`commerce: "store-iap"`), `steam` → `commerce: "steam"`, `itch: PLATFORM_OWN` (`commerce: "own"`)                                                                                                                                                                            |
| Microsoft Store adapter       | `core/storefront/stores/microsoftStore.ts:81-85`                                                                             | `iap` unsupported: the gate denies creating or submitting an add-on                                                                                                                                                                                                                               |
| Microsoft Entra token client  | `services/distribution/connectors/msstore/token.ts:1-35, 68-80, 251-257`                                                     | Client-credentials tokens from one Entra application for two audiences (`manage.devcenter.microsoft.com`, `api.store.microsoft.com/.default`), each in its own sealed cache slot, with the host fixed to `login.microsoftonline.com`. A third audience (`onestore.microsoft.com`) fits this shape |
| itch.io adapter               | `core/storefront/stores/itch.ts:19-20, 36-38, 53-55`                                                                         | No Worker credential ("the unscoped butler key, which lives in CI"); `iap` unsupported; `status` is read in CI                                                                                                                                                                                    |
| Godot Windows bridge          | `sdks/godot/native/windows/storecontext/pkey_storecontext.cpp:1-22, 76-79`; `addons/polaris_key/native/pkey_storecontext.gd` | `package_identity()` and `request_async(op, hwnd, silent)`, where `op` is `updates`, `can_silently_download` or `download_and_install`. HRESULTs `0x803F6101`/`0x803F6107` map to "not a Store install"                                                                                           |
| Godot commerce service        | `sdks/godot/addons/polaris_key/services/commerce.gd:1-80`                                                                    | `purchase(flag)` routes App Store outlets through `PKeyApple`, Steam through GodotSteam; Play answers "unsupported" until a billing helper ships (`claim_play()` meanwhile). No `ms-store` or `itch` route. `hidden_here()` applies App Store 3.1.3(b) only                                       |
| Commerce mockup               | `docs/design/mockups/screens/commerce/commerce.storefronts.json`                                                             | itch.io's Purchases and Refunds read "Not checked". The Microsoft Store row exists                                                                                                                                                                                                                |

### 2. Microsoft Store

**2.1 Client (Windows) [V]**

- `Windows.Services.Store.StoreContext` is the API to use. The older `Windows.ApplicationModel.Store`
  "is not supported in Windows desktop applications that use the Desktop Bridge". Store-managed
  consumables and subscriptions need the newer namespace.
- "In-app purchase functionality is not currently supported in elevated applications."
- A desktop app must call `IInitializeWithWindow::Initialize(hwnd)` on the `StoreContext`, or it "will
  return inaccurate data or errors". The P5-07 bridge already does this.
- "The Windows.Services.Store namespace does not provide an API you can use to obtain a transaction
  receipt". Verification is therefore server-side, through the Collections API.
- There is no simulator. The app must be published (it can be hidden) and installed from the Store once;
  without that association, calls fail with `0x803F6107`.
- The MSI/EXE package FAQ lists "Support for advanced capabilities like flighting and commerce" as MSIX
  benefits (page updated 2026-08-24). An MSI/EXE submission has no Store commerce path. [S: Microsoft Q&A
  answers (2023) say the same; no official page says it outright.]
- **Policy 10.8.1 (Store Policies 7.20, 2026-09-14):** games "are required to use the Microsoft Store
  in-product purchase APIs for the purchase of digital goods and services". Non-game PC products "may
  either use a secure third-party purchase API or the Microsoft Store in-product purchase API". The wire's
  `ms-store → commerce: "store-iap"` is therefore right for games, and stricter than necessary for
  non-game apps, which is acceptable because "nothing widens them". A product bound to the Microsoft API
  "must not direct users to a purchase mechanism other than" it, "but may enable users to consume
  previously purchased digital content". So, unlike App Store 3.1.3(b), a flag bought on another store
  may unlock on an `ms-store` build: the Godot SDK's `hidden_here()` stays Apple-only, and a Store build
  shows no Polaris Key checkout link [I].

**2.2 Server [V]** (Collections v8 and v9, consume, purchase; GDK pages dated 2026-03-31 to 2026-07-15)

| Step                | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity            | An Entra "Web app / API" registration with a client secret. The tenant needs a Global administrator. The application id goes into Partner Center → the app (and each bundle) → Services → **Product collections and purchases**. If that configuration is not published, "calls can succeed but return no results"                                                                                                                                                            |
| Tokens              | Client credentials, valid 60 minutes. `https://onestore.microsoft.com` is used on every call and must stay inside the service ("could make your service vulnerable to replay attacks"). `…/b2b/keys/create/collections` and `…/b2b/keys/create/purchase` are **sent to the client** as the `serviceTicket`                                                                                                                                                                    |
| User key            | `StoreContext.GetCustomerCollectionsIdAsync(serviceTicket, publisherUserId)` (or `GetCustomerPurchaseIdAsync`) returns a Store ID key: an RS256 JWT, valid 30 days, renewable. It is "the only way to create" one, and it carries `publisherUserId` as the `…/claims/key/userId` claim                                                                                                                                                                                        |
| Query               | **`publisherQuery` (v9) is recommended** ("In most cases, use publisherQuery"). `b2bLicensePreview` (v8) remains for LegacyProductIds. v8 limit: "100 query requests within a five-minute window for the same user", then 429. "Your service shouldn't regularly poll". Results cover direct ownership only, never shared entitlements. `quantity` for `Consumable` is "the remaining balance". `status` `Revoked` "most commonly indicates that the user requested a refund" |
| Product types       | `Game`, `Application`, `Durable`, `Consumable` (store-managed, balance kept by Microsoft, repurchasable), `UnmanagedConsumable` (developer-managed, must be fulfilled before repurchase), `Pass` (store-managed subscription)                                                                                                                                                                                                                                                 |
| Consume             | `POST collections.mp.microsoft.com/v8.0/collections/consume`; "there's no v9 URI equivalent", and v9 query plus v8 consume work together. A retry with the same `TrackingId`, user, `productId` and quantity "doesn't consume a second time" and returns the balance. `includeOrderIds: true` returns `orderTransactions` (`orderId`, `orderLineItemId`, `quantityConsumed`)                                                                                                  |
| Recommended ledger  | Key `[OrderID]:[LineItemID]:[ProductID]:[TrackingId]`, plus your own user id ("Clawback events don't provide userIds") and a status that can be reversed. Set it up "before Clawback queue onboarding"                                                                                                                                                                                                                                                                        |
| Recommended economy | Each currency tier is "a separate store-managed consumable that grants quantity `1` per purchase", and the service credits the in-game value. That is exactly an offer with `quantity` = the value and a store quantity of 1                                                                                                                                                                                                                                                  |
| Sandbox             | Developer-managed consumes in a development sandbox work only with XSTS tokens. Store-managed consumables have no such limit. Use `Consumable`, not `UnmanagedConsumable`                                                                                                                                                                                                                                                                                                     |

**2.3 Refunds [V]** ("Managing refunds and chargebacks from your service", edited 2026-06-15)

- The **Clawback event service** writes to an Azure Storage Queue "within seconds". "Microsoft covers the
  hosting costs". To get one, "contact your Developer Partner Manager or Microsoft contact" with the Entra
  client id, an optional region and the product types. "It can take 1-2 weeks for your queue setup to be
  deployed." Consumables and store-managed subscriptions are on by default; games, durables and bundles
  "you must specifically request" (an October 2025 update).
- Access: `purchase.mp.microsoft.com/v8.0/b2b/clawback/sastoken` with Entra credentials returns a SAS
  URI, then the Azure Queue REST calls Peek, Get (which hides a message for 30 seconds) and Delete (with
  `popreceipt`). The responses are **XML** `QueueMessagesList`. A Worker cron can do this with `fetch`
  [I].
- Event states, and the trap: `Returned` means money back and the entitlement removed (for a consumable,
  it was not yet fulfilled). `Revoked` means money back and the removal **failed** (for a consumable, it
  was already fulfilled), so the service must reconcile. `Refunded` means money back and **the customer
  keeps the item**: "No reconciliation", but "keep track … to flag possible fraudulent behavior".
  `ChargebackReversal` means the item is restored, so reverse the earlier action. A `/Purchase/Chargeback`
  source reports `Revoked` or `Returned`.
- Bundles generate one event per consumable they contain. A bundle's line item is not exposed by the
  query APIs, so match it on `OrderID` + bundle `ProductID`.
- Testing a return in a development sandbox means emailing the Developer Partner Manager a return
  request; the Xbox support team confirms "within three business days".
- `purchase.mp.microsoft.com/v8.0/b2b/orders/query` "is deprecated for refund detection". It still lists a
  user's **consumable** orders for 90 days, with `Purchased`, `Revoked` and `Refunded` line states and
  the `shortOrderId` support uses. It needs a **purchase**-audience Store ID key.
- [U] Whether a Windows-only publisher outside ID@Xbox has a "Developer Partner Manager or Microsoft
  contact" who will set up a queue. The pages are in the GDK docs (public, but grouped under Xbox game
  development). This is the decisive human question for refund parity.

**2.4 Credentials and threat notes [I]**

- The Collections API needs no Partner Center role, only the client id on the product's page. The platform
  `microsoft-store.partner-center` application is a Manager that can rewrite every product's listings
  (S-15 rates it A11). **Use a separate Entra application for commerce**, so that a leak of the commerce
  secret cannot touch listings. One application per seller account can serve every product (the client
  id is entered per product). The Clawback queue is keyed on that same client id.
- A new device route mints the `serviceTicket` (the `b2b/keys/create/collections` token) for a device
  that holds a licence binding. The token is meant for the client and lets its holder create Store ID
  keys for its own Microsoft account under our client id. It does not unlock the `onestore` audience.
  Give it its own THREAT-MODEL row, a rate limit and a short cache.
- PK reads the `userId` claim from a Store ID key only after Microsoft has accepted the key in a query.
  Microsoft publishes no key for verifying Store ID keys locally.

**2.5 Xbox (GDK)**

The server APIs are the same; Xbox adds XSTS (X-token) authentication and the content-sharing rules
[V]. Godot has no first-party Xbox export, so an Xbox build means a licensed console port and ID@Xbox
onboarding [I, not researched]. Out of scope for every near-term package.

### 3. itch.io

**What exists [V]** (`itch.io/docs/api/serverside`, `/docs/api/oauth`,
`/docs/itch/integrating/manifest-actions.html`, `/docs/creators/payments`, fetched 2026-10-16)

- **OAuth.** The authorization endpoint is `https://itch.io/user/oauth` and the token endpoint
  `https://api.itch.io/oauth/token`. "There is no client secret. PKCE is required for every client,
  including server-side web applications." "The token doesn't expire and there is no refresh token"; it
  can be revoked with `POST https://api.itch.io/oauth/revoke`. Native games should open "the user's
  system browser", not an embedded web view.
- **Ownership.** `GET /games/GAME_ID/ownership` (scope `game:view:ownership`) returns `{owns, game_id}`.
  "The endpoint only works with tokens issued to an OAuth application, and only for games that the
  application's creator can edit. API keys from your user settings are rejected." `owns` is true for a
  download key or a bundle that includes the game.
- **Owned keys.** `GET /profile/owned-keys` (scope `profile:owned`) takes `game_ids` (up to 50) and
  returns keys with `id`, `game_id` and `purchase_id`, newest first. "A user can own more than one key
  for the same game."
- **The developer-key routes.** `/games/{id}/download_keys` and `/games/{id}/purchases` need
  `game:view:purchases`. That scope is **not in the OAuth scope list**, so it means the unscoped key from
  the developer's settings ("unscoped — they have access to all endpoints"). PK excludes that key by
  S-15's decision. `purchase_type` is `game`, `bundle` or `sub_product`; only `complete` purchases appear.
- **The itch.io app.** The manifest `scope` value "profile:me" is "the only valid scope for now". The
  app sets `ITCHIO_API_KEY` and `ITCHIO_API_KEY_EXPIRES_AT`. That gives the player's user id only, which
  is not enough to check ownership without the developer key.
- **No in-app purchases and no consumables.** An "add-on" is another project or a page reward
  (`claimed-rewards`, physical-style questions). [V by absence: no webhook, no refund event and no rate
  limit appear in the pages read.]
- **Refunds.** "itch.io will refund payments on your behalf when necessary". Payouts wait at least 7
  days "for … refunds, chargebacks" to settle. In collected-by-itch mode, itch.io is liable for
  chargebacks.
- [U] Whether `owns` turns false and the key disappears from `owned-keys` after a refund. Only a live
  refund on a test project answers this.

**What this means [I].** Each product registers one itch.io OAuth application under the developer's
itch.io account, with Polaris Key's callback (or I-15's loopback) as the redirect. PK stores only the
public client id. A player signs in once (code + PKCE); PK checks `ownership` and reads `owned-keys`
for the `purchase_id` (the ledger key), then grants the tier through the app-purchase path (CM-25). The
token does not expire, so PK can store it sealed and run a weekly re-check on CM-24's ownership engine,
like Steam. This fits I-14's exchange kinds (Steam ticket, Game Center, Play Games, EOS Connect), so it
adds no new mechanism.

### 4. Consumables, store by store

| Store           | Consumable type                                        | Quantity                                                                                            | Server confirm and drain                                                                                                                                                                                   | Refund signal                                                                                                                                                                                                             | Partial refund                                                                       |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| App Store [V]   | `type: "Consumable"`                                   | `quantity` ("number of products or seats")                                                          | No server consume; the client calls `finish()`. Get Transaction History returns "all … product types … in any state, including … refunded or revoked, and … that the app has or hasn't marked as finished" | `REFUND` (consumables included), `REFUND_REVERSED`, `REFUND_DECLINED`. `CONSUMPTION_REQUEST` for any type; answer within **12 hours** with `PUT /inApps/v2/transactions/consumption/{id}`, and only with customer consent | `revocationType` `REFUND_PRORATED` + `revocationPercentage` (milliunits)             |
| Google Play [V] | one-time product, consumed                             | `quantity` (multi-quantity, consumables only); v2: `productLineItem[].productOfferDetails.quantity` | `POST …/purchases/products/{id}/tokens/{t}:consume`; consume "fulfill[s] the acknowledgement requirement". Not consumed or acknowledged within 3 days → refunded and revoked. No v2 consume                | RTDN `voidedPurchaseNotification`; `voidedpurchases.list` (30 days). `voidedReason` 0 Other … 5 Fraud, 6 Friendly_fraud, 7 Chargeback, 8 Unacknowledged_purchase; `voidedSource` 0 User, 1 Developer, 2 Google            | `refundableQuantity`; `voidedQuantity` with `includeQuantityBasedPartialRefund=true` |
| Microsoft [V]   | `Consumable` (store-managed) or `UnmanagedConsumable`  | balance; advice: 1 per purchase                                                                     | v8 `consume` with `trackingId`, `includeOrderIds`                                                                                                                                                          | Clawback queue (on request); `orders/query` for consumables (deprecated for refunds)                                                                                                                                      | n/a (one line item = one quantity under the advised setup)                           |
| Steam [V]       | none as DLC; `ISteamMicroTxn` or the Inventory Service | n/a                                                                                                 | The game's server runs `InitTxn` / `FinalizeTxn`                                                                                                                                                           | MicroTxn `GetReport`                                                                                                                                                                                                      | full refunds only                                                                    |
| itch.io [V]     | none                                                   | n/a                                                                                                 | n/a                                                                                                                                                                                                        | none documented                                                                                                                                                                                                           | n/a                                                                                  |
| Epic (EOS) [V]  | entitlement with `consumable: true`, `useCount`        | `useCount` / `originalUseCount`                                                                     | `PUT /epic/ecom/v3/identities/{id}/entitlements/redeem`                                                                                                                                                    | `GET /epic/ecom/v3/namespace/{ns}/entitlements/clawbacks?clawbackDate=…`: `REFUND`, `CHARGEBACK`, `FRAUD`, **with** `accountId`                                                                                           | not documented                                                                       |

**The ledger rule [I, on the facts above].** Polaris Key holds the balance. The store-side balance is
drained as soon as PK has recorded the purchase, and the credit happens once per store transaction:

- **App Store and Google Play (CM-28).** Verify, record `pending`, credit (LX-42 `grants.quantity` =
  `offer.quantity × store quantity`), then drain: the SDK calls `finish()` on Apple; on Play the Worker
  calls `:consume`, retried by the existing acknowledgement tick (`recheck.ts`), which already enforces
  the 3-day window. Then mark the row `active`. A Play consume that fails for 3 days is refunded by
  Google, and the voided poll reverses the credit.
- **Microsoft (CM-30).** The order key only arrives in the consume response, so the order of steps is
  reversed. Write a `pending` row with a fresh `trackingId`, call consume with `includeOrderIds`, write
  one ledger row per `orderTransactions` entry with the key
  `orderId:orderLineItemId:productId:trackingId`, credit, then mark them `active`. A crash between the
  steps retries with the stored `trackingId`.
- **Refunds.** `revokePurchase` takes back what that purchase granted, never taking the balance below
  zero (CM-20 §2.3), and records the uncollectable remainder ("refunded; 14 of 20 already spent") in
  `detail_json`. A partial refund takes back `refunded quantity × offer.quantity`, or
  `revocationPercentage` of the grant on the App Store.
- **Reconcile by key and ledger state, never by event name.** Microsoft's `Refunded` keeps the item.

### 5. Epic Online Services, as an outline only [V]

Ecom Web API v3 and v4 at `api.epicgames.dev`, with the Ecom feature enabled on a client policy (needed
for EOS SDK 1.16.4 and later). Ownership is `GET /epic/ecom/v3/platforms/EPIC/identities/{id}/ownership`
or an **ownership verification token**: a JWT whose public keys are at
`ecommerceintegration-public-service-ecomprod02.ol.epicgames.com/…/publickeys/{kid}`. Epic recommends
the token for third-party services "to avoid granting them access to a user's data". Entitlements are at
`/epic/ecom/v4/identities/{id}/entitlements`, with `consumable` and `useCount`. The clawback query takes
a namespace and a date and returns the account id, unlike Microsoft. There is no Epic outlet kind (S-15
Q8: "wait"), so there is no package now. The draft's claim that querying durables through the
entitlements call returns `EOS_InvalidRequest` (SDK 1.17.1.3) stays [S].

### 6. How it maps onto Polaris Key's model (CM-20)

| PK concept                     | Microsoft Store                                                                                                                  | itch.io                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `store` value                  | `ms-store` (the outlet kind already exists)                                                                                      | `itch`                                                                                                       |
| SKU `store_product_id`         | add-on Store ID (12 characters, e.g. `9NBLGGH42CFD`); `@app` = the app's own Store ID, taken from the pin                        | `@app` only = the project's `game_id`, taken from the outlet identity                                        |
| Offer target                   | `tier:` through `@app` or `Durable`; `addon:` through `Durable` or `Consumable`                                                  | `tier:` through `@app`. Add-ons and consumables: Polaris Key checkout on `commerce: "own"` builds (deferred) |
| `quantity`                     | `offer.quantity × 1` (store quantity 1 as advised)                                                                               | 1                                                                                                            |
| Purchase key (idempotency)     | durable or app: `transactionId:productId` [I: bundles share an `orderId`]; consumable: `orderId:lineItemId:productId:trackingId` | the `purchase_id` from `owned-keys`, else the key `id` (claimed keys have no purchase)                       |
| Binding                        | `publisherUserId` = the licence binding, read back from the key's `userId` claim                                                 | the itch.io user id from `/profile` on the player's token                                                    |
| `refunded`                     | Clawback `Returned` or `Revoked`; query `status: Revoked`                                                                        | [U] `owns: false` on re-check                                                                                |
| Chargeback                     | Clawback source `/Purchase/Chargeback`                                                                                           | none observable                                                                                              |
| Reversal (back to `active`)    | `ChargebackReversal`                                                                                                             | `owns: true` again                                                                                           |
| No state change, timeline note | `Refunded` ("customer keeps the item")                                                                                           | n/a                                                                                                          |
| Restore                        | by Microsoft account on any device: mint a key again and query                                                                   | by itch.io sign-in on any device                                                                             |
| Console SKU creation           | copy card (adapter `iap` unsupported)                                                                                            | n/a                                                                                                          |

## Recommendation

**Split by store and share the consumable core. Microsoft and itch.io build on the mechanisms the graph
already names (P0-27's commerce facet, P0-28's credential store, CM-24's ownership engine, I-14's
exchange kinds and CM-25's app-purchase source), never beside them.**

1. **CM-28: keep the scope (App Store and Google Play consumables) and sharpen the acceptance criteria.**
   - Play's server `:consume` is retried on the existing acknowledgement tick inside the 3-day window.
   - Partial refunds: Play's `refundableQuantity` and `voidedQuantity`, and the App Store's
     `REFUND_PRORATED` with `revocationPercentage`.
   - The uncollectable remainder is recorded when a refund exceeds the balance.
   - A store-neutral consume interface (`drain(purchase)`) on P0-27's commerce facet, so CM-30 plugs in.
   - Answering Apple's `CONSUMPTION_REQUEST` stays **out**: it needs the customer's consent and a
     12-hour responder.
2. **CM-30 (new), Microsoft Store commerce in the Worker** (plan mode, `sec`, `mig`). It covers:
   - a commerce Entra credential, separate from the Partner Center Manager application;
   - the `serviceTicket` device route;
   - `publisherQuery` verification of `@app`, `Durable` and `Consumable`;
   - v8 consume as in §4;
   - the Clawback queue consumer on the connector cron, with the event table in §2.3;
   - `ms-store` in the vocabularies.

   It needs one rebuild that turns the `store` CHECKs on `dist_purchases` and `license_store_grants`
   into triggers (the `0105_a` precedent), so that `itch` (and `epic`, later) never rebuild again. Until
   a queue exists, refund parity reads "on-demand only": a re-query at claim and at launch, and
   `orders/query` for consumables.

3. **CM-31 (new), the Godot Windows Store purchase operations** (`native` lane). Add `collections_id`
   (with the `serviceTicket` and the binding), `purchase` (`RequestPurchaseAsync`) and `app_license` to
   the existing `PKeyStoreContextNative.request_async`, and the matching calls to the GDScript facade.
   Add an `ms-store` route to `PKeyCommerce.purchase()` and `restore()`, with
   `claim("ms-store", {storeIdKey, productId})`, and an MSIX build path to the export docs. Electron,
   under the React SDK, is later.
4. **CM-32 (new), itch.io ownership through a player sign-in.** Add an `itch` exchange kind (OAuth code +
   PKCE) on I-14's framework, an itch backend for CM-24's ownership engine with a sealed token and a
   weekly re-check, and an `@app` SKU for itch through CM-25. It stores no developer secret. Its parity
   row reads "Refund sync: re-check, not push". Add-ons and consumables on itch builds wait for Polaris
   Key checkout.
5. **No package for Steam consumables or Epic.** CM-20 §11 already rules out Steam microtransactions, and
   S-15 Q8 says wait on Epic. The §5 outline is the starting point when an Epic channel is chosen.
6. **Do not claim Microsoft refund parity until a real seller account has a Clawback queue.** If
   Microsoft will not set one up for a Windows-only publisher, the parity cell stays "on-demand only".

### Parity table (target after CM-28, CM-30, CM-31 and CM-32)

| Capability              | App Store                   | Google Play                                                    | Steam                               | Microsoft Store                           | itch.io                    | Epic                   |
| ----------------------- | --------------------------- | -------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- | -------------------------- | ---------------------- |
| Verify base app         | CM-25                       | CM-25                                                          | CM-25                               | CM-30                                     | CM-32                      | later                  |
| Verify durable / add-on | done                        | done                                                           | DLC (done)                          | CM-30                                     | n/a (Polaris Key checkout) | later                  |
| Verify consumable       | CM-28                       | CM-28                                                          | n/a (ruled out)                     | CM-30                                     | n/a                        | later                  |
| Client purchase (Godot) | `PKeyApple.purchase` (done) | `claim_play()` from the game's billing plugin (helper pending) | GodotSteam overlay (done)           | CM-31                                     | the itch.io page           | later                  |
| Quantity                | `quantity`                  | `quantity`, multi-quantity                                     | n/a                                 | 1 per purchase (advised)                  | 1                          | `useCount`             |
| Idempotency key         | `transactionId`             | `purchaseToken`                                                | `steamId:dlcAppId` (`steam.ts:272`) | `orderId:lineItemId:productId:trackingId` | `purchase_id`              | entitlement id         |
| Store-side drain        | client `finish()`           | server `:consume` within 3 days                                | n/a                                 | server `consume` + `trackingId`           | n/a                        | `entitlements/redeem`  |
| Refund push             | notifications               | RTDN                                                           | none                                | Clawback queue (Microsoft sets it up)     | none                       | none (clawback query)  |
| Refund backstop         | weekly re-read (done)       | daily voided list (done)                                       | weekly re-check (done)              | on-demand re-query                        | weekly re-check            | clawback query by date |
| Partial refund          | `revocationPercentage`      | `voidedQuantity`                                               | full only                           | n/a                                       | n/a                        | n/a                    |
| "Refunded, keeps item"  | n/a                         | n/a                                                            | n/a                                 | `Refunded` event                          | n/a                        | n/a                    |
| Restore by account      | device once                 | device once                                                    | linked Steam (CM-24)                | Microsoft account                         | itch.io sign-in            | Epic account           |
| Console SKU creation    | API                         | API                                                            | copy card                           | copy card                                 | n/a                        | later                  |

## Work-package briefs that change

**Applied in this branch:**

- [CM-27](../program/wp/CM-27-spike-store-purchase-parity-microsoft.md): outcome and the brief's scope
  correction (the download-key lookup needs the unscoped key, which S-15 excludes).
- [CM-28](../program/wp/CM-28-consumables-quantity-grants-from-store.md): a "CM-27 spike findings"
  section with the four acceptance criteria above, and `CONSUMPTION_REQUEST` out of scope.

**Proposed for the lead (graph and decision records):**

| Change                                                                                    | Proposed row                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register **CM-30** Microsoft Store commerce: verification, consume and the Clawback queue | phase CM, Track H, lane `worker`, `pkey-implementer`, 1.2–1.8 weeks, deps `CM-28`, `CM-22`, `CM-29`, `P0-27`, `P0-28`; plan mode yes; gates `plan-mode`, `threat-model`; human inputs: a Partner Center app with add-ons, a commerce Entra application, a Clawback queue request to Microsoft, sandbox return tests through Microsoft |
| Register **CM-31** Godot Windows Store purchase operations                                | phase CM, lane `native`, 0.6–0.9 weeks, deps `CM-30`, `LX-20`; plan mode no; human input: a hidden Store listing and a Windows test machine (`sdks/godot/native/README.md` owner step 6)                                                                                                                                              |
| Register **CM-32** itch.io ownership through a player sign-in                             | phase CM, lane `worker`, 0.6–1.0 weeks, deps `I-14`, `CM-24`, `CM-25`, `P0-28`; plan mode yes (new exchange kind and route); gate `threat-model`; human input: an itch.io test project with a paid page, one buyer account, and one refund to settle the [U]                                                                          |
| P0-51                                                                                     | add CM-30, CM-31 and CM-32 only if Microsoft Store and itch.io sales are 1.0 scope; otherwise list them as post-1.0 in the readiness review                                                                                                                                                                                           |
| CM-20 plan D9 table                                                                       | add the Microsoft rows: `Returned`/`Revoked` → full refund; `/Purchase/Chargeback` → chargeback; `ChargebackReversal` → reversal; `Refunded` → unchanged with `detail.refundKept`; itch `owns: false` → revocation                                                                                                                    |
| CM-20 plan §11 and §12                                                                    | §11: the store CHECK rebuild belongs to CM-30, converting to triggers. §12: the App Store and Play partial-refund fields are verified (this note §4)                                                                                                                                                                                  |
| Commerce audit §5.7                                                                       | replace the `[U]` cells with the target table above; Microsoft "Create SKU by API" is a copy card, not "declared"                                                                                                                                                                                                                     |
| P0-27 brief                                                                               | name the commerce facet's `drain()` and the `ms-store` / `itch` commerce rows as its consumers                                                                                                                                                                                                                                        |
| P0-28 brief                                                                               | add the credential kind `microsoft-store.commerce` (tenant, client id, secret), separate from `microsoft-store.partner-center`                                                                                                                                                                                                        |
| I-14 brief                                                                                | add the `itch` exchange kind (OAuth code + PKCE, client id only) as a CM-32 dependency                                                                                                                                                                                                                                                |

## What needs human accounts or keys

| Item                                                                                                                               | Needed for                                          | Who                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| A Partner Center account and an MSIX app (hidden is fine) with one durable and one store-managed consumable add-on                 | Store IDs; any live Microsoft check                 | Owner                     |
| An Entra tenant (Global administrator), a commerce application with a client secret, its id on "Product collections and purchases" | Collections, consume, the SAS token                 | Owner                     |
| A request to Microsoft for a Clawback queue, including durables and games (1–2 weeks)                                              | Refund push                                         | Owner; Microsoft decides  |
| A Windows test machine with the Store-installed build and a test Microsoft account; sandbox returns through Microsoft              | Store ID key, purchase, consume and the refund path | Owner                     |
| An itch.io project with a paid page, an OAuth application on the developer account, a second buyer account, one refund             | `ownership` / `owned-keys` behaviour after a refund | Owner                     |
| App Store and Google Play consumable products and sandbox or licence testers                                                       | CM-28 live checks                                   | Owner (A-18k-style steps) |

## Open items [U]

- Microsoft: whether a Windows-only publisher gets a Clawback queue; the Clawback queue's retention; the
  v9 `publisherQuery` field list (not read in full); whether a Godot MSIX built by the export pipeline
  passes Store commerce certification.
- itch.io: `owns` and `owned-keys` after a refund; rate limits; whether a revoked key disappears from
  `owned-keys`.
- Epic: the `EOS_InvalidRequest` durable change (still [S]).
- Xbox: the Godot console path (not researched).

## Sources

All fetched 2026-10-16 (local time). Each Microsoft page's own `ms.date` or edit date is given.

- [V] Microsoft, Manage product entitlements from a service (updated 2025-07-24): https://learn.microsoft.com/en-us/windows/uwp/monetize/view-and-grant-products-from-a-service
- [V] Microsoft, In-app purchases and trials (updated 2025-11-27): https://learn.microsoft.com/en-us/windows/uwp/monetize/in-app-purchases-and-trials
- [V] Microsoft, b2bLicensePreview (Collections v8) (edited 2026-07-15): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-query-for-products
- [V] Microsoft, Query user entitlements from your services (v8 vs v9) (edited 2026-07-15): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/xstore-query-user-entitlements
- [V] Microsoft, Manage products from your services (edited 2026-06-15): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/service-to-service-nav
- [V] Microsoft, Managing consumable products from your service (edited 2026-06-15): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/xstore-managing-consumables-and-refunds
- [V] Microsoft, Managing refunds and chargebacks from your service (edited 2026-06-15): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/xstore-managing-refunds-and-chargebacks
- [V] Microsoft, orders/query (Clawback v1, deprecated for refunds) (edited 2026-03-23): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-clawbackv1
- [V] Microsoft Store Policies 7.20, §10.8 (2026-09-14): https://learn.microsoft.com/en-us/windows/apps/publish/store-policies
- [V] Microsoft, App package requirements for MSI/EXE app (updated 2026-08-24): https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements
- [V] Microsoft, Choose a distribution path (2026-10-07): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path
- [S] Microsoft Q&A on MSI/EXE commerce (2023), via search digest: https://learn.microsoft.com/en-us/answers/questions/1071450/how-do-i-create-an-add-on-to-allow-an-in-app-purch
- [V] itch.io server-side API: https://itch.io/docs/api/serverside ; OAuth: https://itch.io/docs/api/oauth ; manifest actions: https://itch.io/docs/itch/integrating/manifest-actions.html ; payments: https://itch.io/docs/creators/payments
- [V] Apple, DocC JSON under `https://developer.apple.com/tutorials/data/documentation/`: `appstoreserverapi/get-transaction-history`, `send-consumption-information` (API 1.19), `consumptionrequest`, `jwstransactiondecodedpayload`, `revocationtype`, `revocationpercentage`, `type`, `appstoreservernotifications/notificationtype`
- [V] Google Play Developer API discovery document, revision 20261015: https://androidpublisher.googleapis.com/$discovery/rest?version=v3 ; Play Billing integration guide (updated 2026-10-15): https://developer.android.com/google/play/billing/integrate
- [V] Epic, Ecom Web APIs: https://dev.epicgames.com/docs/web-api-ref/ecom-web-apis ; Ecom interface: https://dev.epicgames.com/docs/epic-games-store/services/ecom/ecom-overview
- [V] Steam (from the 2026-10-09 run, not refetched): https://partner.steamgames.com/doc/features/microtransactions , https://partner.steamgames.com/doc/webapi/ISteamMicroTxn
- Repo: `docs/research/2026-10-07-dx-consolidation/audits/commerce.md` §2, §5.7, §5.9;
  `program/plans/CM-20.md` D1–D3, D9, §11, §12; `notes/S-15-storefront-provisioning.md` §2, §4.4; the
  files named in Results §1.

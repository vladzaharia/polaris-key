> Research note for [Godot on Polaris Key](../README.md), 2026-10-09.
> A working paper kept for its evidence and sources; the README synthesis is the cross-checked position.

# CM-27: Store purchase parity (Microsoft Store, itch.io, consumables)

Run 2026-10-09 (all fetch dates below are that day). Desk research only: public documentation read, no
purchases, no accounts, no credentials, no product code changed. Nothing here was called against a live
service. Tags: [V] primary source read raw, [M] measured, [S] summary or search-engine digest, [I] inference,
[U] unknown, needs a live check.

## Question

How do the Microsoft Store (desktop and Xbox), itch.io and the consumable / durable split on Steam, Apple,
Google Play, the Microsoft Store and itch.io map onto Polaris Key's offers, tiers, add-ons and one purchase
ledger, including refund and revocation, and what must CM-28 and the follow-ups build?

## Short answer

1. **Microsoft Store can reach parity, with two human gates.** A server can verify base-app, durable and
   consumable purchases (Entra ID app + Partner Center link + a per-user Store ID key minted by the client). It
   can detect refunds only reliably through the **Clawback queue, which Microsoft must set up for the
   publisher** [V]. Polling the collection API on a schedule is explicitly discouraged [V]. The Windows client
   needs MSIX package identity and a native bridge from Godot [V for MSIX, I for the bridge].
2. **itch.io can verify ownership of a game, never an in-app purchase.** It has no in-app purchases and no
   consumables [V, by absence in the docs read]. A server lookup by download key, user id or email works with the
   developer's account-wide API key [V]. Refunds have no documented API signal [V: docs silent]; revocation
   shows only as an invalid key on re-lookup [S]. Rate limits are undocumented [V].
3. **Consumables are one shape on every store that has them, and PK's own ledger should be the balance.**
   Apple, Play and Microsoft all let the server drain the store-side balance to zero and credit the PK ledger.
   That fits CM-20's `offer.quantity x store quantity` rule and LX-42's counted entitlement. Steam has no
   consumable DLC; its consumables are a different product (MicroTxn or Inventory Service) that needs a game
   server in the loop.
4. **Refund vocabularies disagree.** Microsoft's `Refunded` event means the payment went back **and the
   customer kept the item**; that must not map to PK's `refunded` state [V]. Reconcile consumables by order key,
   not by event name.
5. **Recommendation:** CM-28 stays Apple + Play consumables on the shared ledger path. Microsoft Store becomes
   its own follow-up package (verification, Clawback consumer, then consumables), itch.io a smaller one (base
   app and separate-project add-ons, no consumables), Steam consumables and EOS later. Details and proposed
   brief edits are in "Recommendation".

## Method

- Read the DX-consolidation audit (`docs/research/2026-10-07-dx-consolidation/audits/commerce.md` §2.1, §2.3,
  §5.7, §5.9), the CM-20 plan (`program/plans/CM-20.md` D1, D2, D9, §7) and the commerce mockups
  (`docs/design/mockups/screens/commerce/commerce.{purchase,purchases,offer,storefronts,restore}.json`).
- Fetched the Microsoft, Apple, Google, Steam, itch.io and Epic documentation named in "Sources". Apple's
  documentation pages render client-side, so the DocC JSON behind them was fetched with
  `curl https://developer.apple.com/tutorials/data/documentation/<path>.json` and its text extracted [V].
  Microsoft, Google, Steam and itch.io pages were read through a page-to-markdown fetch whose extractor
  answered a prompt [V for the quoted page text, S where a digest is marked].
- Reused no experiment code; nothing in `prototype/` applies.

## Results

### 1. Microsoft Store: desktop

**Client side [V]**

- Add-on types: durable, developer-managed consumable, store-managed consumable, subscription. Store-managed
  consumables need `Windows.Services.Store`, not the older `Windows.ApplicationModel.Store`.
- "In-app purchase functionality is not currently supported in elevated applications."
- Desktop apps must hand `StoreContext` a window handle (`InitializeWithWindow`) or it "will return inaccurate
  data or errors".
- Testing needs the app published to the Store (can be hidden) and installed once; there is no simulator for
  `Windows.Services.Store`.
- Unpackaged EXE/MSI apps cannot use Store in-app purchases or add-ons [S: Microsoft's distribution-path
  comparison; sparse-package behaviour [U]]. Godot's Windows export is a plain `.exe`, so a Store build means
  an MSIX wrapper, and a native bridge (WinRT or GDK) because Godot has no built-in Store commerce API [I].

**Server side [V]** (`https://learn.microsoft.com/en-us/windows/uwp/monetize/view-and-grant-products-from-a-service`,
`.../query-for-products`, `.../report-consumable-products-as-fulfilled`)

| Step          | Fact                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity      | An Entra ID tenant, a "Web app / API" registration with a client secret, and the application id entered in Partner Center under Services > Product collections and purchases. Global administrator on the tenant is required                                                                                                                                                              |
| Tokens        | Client-credentials tokens, 60 min life. Audience `https://onestore.microsoft.com` for every call; plus `https://onestore.microsoft.com/b2b/keys/create/collections` for collection calls (and `.../create/purchase` for grant/subscription calls)                                                                                                                                         |
| User key      | The client calls `StoreContext.GetCustomerCollectionsIdAsync(serviceTicket, publisherUserId)`; returns a "Microsoft Store ID key" JWT, valid 30 days, renewable. It is the only way to make one. `publisherUserId` is embedded as the `userId` claim, so PK can bind it to its own account id                                                                                             |
| Query (v6)    | `POST https://collections.mp.microsoft.com/v6.0/collections/query`. `productTypes`: `Application`, `Durable`, `Game`, `UnmanagedConsumable`. Page max 100. Item `quantity` "will always be 1" in v6. `status`: `Active`, `Expired`, `Revoked`, `Banned`. "Your service should not regularly poll for all users on a schedule."                                                            |
| Query (v8/v9) | `POST .../v8.0/collections/b2bLicensePreview` adds `Consumable` (store-managed) and `Pass`; there `quantity` for a consumable is the **remaining balance**; `Revoked` "most commonly indicates that the user requested a refund". Limit **100 query requests per 5-minute window per user**, then HTTP 429. v9 `publisherQuery` is the newer API (Game Pass status) [S, not read in full] |
| Consume       | `POST .../collections/consume` (v6 and v8). Idempotent on `trackingId`: a retry with the same tracking id, user, product and quantity "doesn't consume a second time" and returns success with the current balance. `includeOrderIds: true` (v8) returns `orderTransactions` with `orderId`, `orderLineItemId`, `quantityConsumed`                                                        |
| Sandbox       | Developer-managed consumes in a dev sandbox work only with XSTS-token auth, not Entra / Store ID [V]                                                                                                                                                                                                                                                                                      |

**Refund and revocation [V]** (GDK page "Managing refunds and chargebacks from your service", edited 2026-06-15)

- The **Clawback event service** puts a message in an Azure Storage Queue "within seconds" of a refund, return
  or chargeback. Microsoft "covers the hosting costs" but **the publisher must ask their Developer Partner
  Manager or Microsoft contact to have the queue set up**, giving the Entra application id and optionally a
  region. Consumables and store-managed subscriptions are on by default; durables, games and bundles must be
  requested (October 2025 update).
- Access: `GET https://purchase.mp.microsoft.com/v8.0/b2b/clawback/sastoken` with Entra credentials returns an
  SAS URI; then plain Azure Queue REST (peek, get, delete). A `get` hides a message for 30 seconds. A Worker
  `fetch` can do this on a cron [I].
- Event: `id`, `time`, and `data` (ClawbackEventContractV2) with `orderId`, `lineItemId`, `productId`,
  `productType`, `skuId`, `purchasedDate`, `eventDate`, `sandboxId`, `eventState`, optional `recurrenceData`.
  Source is `/Purchase/Refund` or `/Purchase/Chargeback`. **There is no user id in the event**, so the ledger
  must keep the order key against the account.
- `eventState` meanings (the trap):

| `eventState`         | Meaning                                                                                        | PK action                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Returned`           | Money back, entitlement removed. For a consumable: it had not been fulfilled from your service | Reverse any grant PK recorded for this order key (normally none)                         |
| `Revoked`            | Money back, removal **failed**. For a consumable: it was already consumed                      | Find the grant by `orderId + lineItemId + productId`, take the value back, floor at zero |
| `Refunded`           | Money back, **customer keeps the item** (goodwill or pre-empting a chargeback)                 | No revocation. Log and watch the account for repeats                                     |
| `ChargebackReversal` | Earlier chargeback appealed and won; item restored                                             | Undo the earlier revocation                                                              |

- Store-managed vs developer-managed behave the same in the reconcile table. Bundles generate one event per
  consumable inside them. The ledger key Microsoft recommends is `OrderID:LineItemID:ProductID:TrackingId`.
- `purchase.mp.microsoft.com/v8.0/b2b/orders/query` remains for purchases in the last 90 days (adds a
  ShortOrderID useful for support) [V].
- Customers refund through account.microsoft.com orders; automatic approval "depends on criteria such as
  elapsed time since purchase and play time" [V].

### 2. Microsoft Store: Xbox (GDK)

- Console and PC GDK titles use `XStore*` APIs (`XStoreQueryAddOnLicensesAsync`,
  `XStoreReportConsumableFulfillmentAsync(storeProductId, quantity, trackingId)`, `XStoreProductKind`:
  `Consumable` store-managed, `UnmanagedConsumable` developer-managed) [S: search digest of the GDK reference;
  consumable and refund pages read raw [V]].
- The **server APIs are the same** collections/purchase/clawback services. Xbox adds X-token (XSTS) auth beside
  Entra + Store ID key, and the product-sharing model: consumables are single-user and never shared; durables
  must follow the content-sharing policy and a service query returns only directly owned items [V].
- Microsoft's recommended consumable design [V]: "3 to 6 or more" tiers, **each tier its own store-managed
  product granting quantity 1**, the service translating to in-game currency, balance kept on the publisher's
  service. This matches PK's offer model exactly (`offer.quantity` supplies the amount).
- Godot has no first-party Xbox export, so an Xbox store build is a third-party port plus ID@Xbox onboarding
  [I; not verified in this spike]. Treat Xbox as the same server path as desktop and out of scope for any
  near-term package.

### 3. itch.io

**What exists [V]** (`https://itch.io/docs/api/serverside`, `.../oauth`, `.../creators/payments`,
`.../creators/access-control`)

- Server API at `https://api.itch.io`, bearer token. **API keys are long-lived and, for your own account,
  unscoped: "can access all endpoints"**. JWTs are short-lived and scoped.
- `GET /games/GAME_ID/download_keys` takes one of `download_key`, `user_id`, `email`; returns key id, created_at,
  downloads count and owner. Invalid or revoked keys: "invalid download key". Email must be verified by you
  first; `user_id` is harder to spoof.
- `GET /games/GAME_ID/purchases` takes `email` or `user_id`; fields `id, email, created_at, source, currency,
price, sale_rate, quantity, status, purchase_type, game_id, donation`. Only completed purchases; claimed keys
  have no purchase record; bundles return an array of `game_id`. The docs do not define `status` values.
- OAuth scopes: `profile:me`, `profile:owned` (lists games the user purchased or claimed), `game:view:ownership`
  (does the user own a game, **only for games owned by the OAuth application's creator**), others. A 2020
  GitHub issue records that a player's JWT cannot read purchases (`game:view:purchases` invalid) and the key
  route needs the developer's own key; no staff answer on that page [V, dated, may be stale].
- A game launched from the itch app can request a short-lived JWT through its manifest [V from the OAuth/API
  page; exact environment variable names not read, [U]].
- **No rate limits, throttling or abuse policy in the docs read.** No webhook or event feed for purchases or
  refunds appears in the API reference read [V by absence].
- Refunds: itch refunds "on the seller's behalf when necessary". Collected-by-itch mode: itch is merchant of
  record, refunds deduct from payouts, itch bears chargebacks. Direct mode: the seller refunds through their
  PayPal/Stripe account and carries chargebacks. Revenue is payable 7 days after purchase to let refunds settle
  [V]. Creators can issue refunds from the dashboard, staff-approved [S: forum posts, may be outdated].
- Everything on itch is **project access**, not in-app items. There is no consumable and no purchase API for
  in-game items; an "add-on" is a separate project (own `game_id`) the buyer owns, or a bundle [I].

### 4. Consumable vs durable, store by store

| Store           | Durable                                         | Consumable                                                                                                                                                                                                                                                        | Server fact for consumables                                                                                                                                                                                                                                                                 | Refund signal                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple           | Non-Consumable (verified today, `apple.ts:239`) | Consumable; `quantity` field "number of products or seats purchased" [V]                                                                                                                                                                                          | History endpoint returns "all in-app purchase product types ... in any state, including refunded or revoked, and that the app has or hasn't marked as finished", 20 per page, filterable by product type and `revoked` [V]. No server consume call: the client finishes the transaction [I] | `ONE_TIME_CHARGE` (consumable, non-consumable, non-renewing); `REFUND` (consumable too); `REFUND_REVERSED`; `REVOKE` is Family Sharing; `CONSUMPTION_REQUEST` = customer asked to refund a consumable, send consumption data back [V] |
| Google Play     | One-time, acknowledge                           | One-time, consume; **multi-quantity** from Billing Library 4.0, consumables only, read `quantity` [V]                                                                                                                                                             | `consume` and `acknowledge` on the server; do it within **3 days** or the purchase is refunded automatically [V]; `consumptionState`, `refundableQuantity` [V]                                                                                                                              | Voided Purchases: `startTime` no older than 30 days; `includeQuantityBasedPartialRefund=true` adds `voidedQuantity`; `voidedReason` and `voidedSource` codes are not defined on the page read [V/U]                                   |
| Steam           | DLC ownership (`CheckAppOwnership`)             | **No consumable DLC.** Separate products: `ISteamMicroTxn` (`InitTxn`, `FinalizeTxn`, `QueryTxn`, `RefundTxn` full-amount only, `GetReport` at least daily, max 50,000 rows, publisher key) or the Inventory Service (item definitions, server-granted items) [V] | Game server must start the transaction; PK would act as the game's server [I]                                                                                                                                                                                                               | MicroTxn `GetReport`; refunds trigger automatic claw-back of funds and items on fraud [V]                                                                                                                                             |
| Microsoft       | `Durable`, `Game`, `Application`                | `Consumable` (store-managed, balance) or `UnmanagedConsumable` (must be fulfilled before repurchase)                                                                                                                                                              | Section 1                                                                                                                                                                                                                                                                                   | Query `Revoked`; Clawback queue                                                                                                                                                                                                       |
| itch.io         | Project ownership by download key / purchase    | none                                                                                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                         | none documented                                                                                                                                                                                                                       |
| Epic (EOS Ecom) | `QueryOwnership` / ownership token              | `QueryEntitlements` + `RedeemEntitlements`; durables through the entitlements call now return `EOS_InvalidRequest` (SDK 1.17.1.3, Aug 2025)                                                                                                                       | Server REST for ownership and entitlements; token-based client verification                                                                                                                                                                                                                 | `findEntitlementClawbacks` client-policy action exists [S]                                                                                                                                                                            |

### 5. How it maps onto PK's model

PK facts used: offers defined once as `{id, label, target (tier|addon), billing, quantity, state}`; SKUs in
`dist_offer_skus` with a trigger-checked store vocabulary and `@app` for the app purchase; one ledger
`dist_purchases` with states `pending active refunded revoked charged_back`; one `revokePurchase(ctx, ref,
cause)`; a refunded base purchase ends the licence; partial refunds never revoke (CM-20 D1, D2, D3, D9; audit
§5.9).

| PK concept                      | Microsoft Store                                                                                | itch.io                                                                   | Consumable on Apple / Play                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `store` value                   | `ms-store` (trigger vocabulary, no table rebuild thanks to D2)                                 | `itch`                                                                    | `app-store`, `play`                                                    |
| SKU `store_product_id`          | Store ID (12 chars, e.g. `9NBLGGH42CFD`) of the add-on; `@app` = the app's own Store ID        | the project's `game_id`; `@app` = the product's own page                  | product id                                                             |
| Offer `target`                  | `tier:` via the app/`Game`, `addon:` via a `Durable` or `Consumable`                           | `tier:` via the app project; an add-on is another project                 | `addon:` whose entitlement kind is consumable (LX-42)                  |
| `quantity`                      | offer.quantity x store quantity; Microsoft advises store quantity 1                            | 1                                                                         | offer.quantity x `quantity` field (Apple) / `Purchase.quantity` (Play) |
| Purchase identity (idempotency) | `orderId:lineItemId:productId` (+ our `trackingId`)                                            | download-key id, or purchase id                                           | Apple `transactionId`; Play `purchaseToken` / `orderId`                |
| Account binding                 | `publisherUserId` claim in the Store ID key (PK's account id)                                  | `user_id` from the itch app JWT or OAuth; email only after PK verifies it | Apple `appAccountToken`; Play `obfuscatedExternalAccountId`            |
| `pending`                       | consume with our deterministic `trackingId` is in flight                                       | n/a                                                                       | verified, not yet consumed                                             |
| `refunded`                      | Clawback `Returned`, `Revoked`; query `Revoked`                                                | key no longer valid on re-lookup [U]                                      | Apple `REFUND`; Play voided                                            |
| `charged_back`                  | Clawback source `/Purchase/Chargeback`                                                         | none observable                                                           | Apple/Play per their feed                                              |
| Active again                    | Clawback `ChargebackReversal`                                                                  | n/a                                                                       | Apple `REFUND_REVERSED`                                                |
| No state change, timeline note  | Clawback `Refunded` (customer keeps the item)                                                  | n/a                                                                       | Apple `REFUND_DECLINED`                                                |
| Restore                         | `GetCustomerCollectionsIdAsync` again, then query (works on any device with the Store account) | re-lookup with the itch identity                                          | Apple/Play: device once, not by account (audit §5.7)                   |

**Consumable ledger rule (recommended).** PK is the balance. Every store-side consumable is drained to zero as
soon as PK has recorded it, and the credit to the counted entitlement happens once per purchase key:

- Apple / Play: verify, record `pending`, credit (LX-42 `grantAddOn` with quantity), then finish / consume
  (Play must be done inside 3 days, so the Worker retry queue is a correctness requirement, not a nicety),
  then `active`.
- Microsoft: record `pending` with a **deterministic** `trackingId` derived from the purchase (a retry then
  returns success with the balance rather than consuming twice), call consume with `includeOrderIds`, read
  `orderTransactions`, credit, then `active`. The order differs from Apple/Play because the order key only
  arrives in the consume response [V]; the pending row is what makes it safe.
- A refund calls `revokePurchase` with the quantity granted by that purchase. The balance never drops below
  zero (CM-20 §2.3). Record the **uncollectable remainder** on the ledger row so support can see "refunded,
  14 of 20 coins already spent" [I]. This needs one ledger column or `detail_json` field, decided in CM-28's
  plan.
- Reconcile by order key and ledger state, not by Microsoft's event names: act whenever the ledger holds an
  active grant for that key and the event is `Returned` or `Revoked`. Because PK drains immediately, the
  normal event for a spent consumable is `Revoked`; `Returned` only occurs if PK granted but the consume had
  not yet happened [I].

**Refund detection cost per store.** Apple and Play and Microsoft all push (notifications, RTDN, Clawback
queue); Play and Steam keep a poll as a backstop. Microsoft's query API must not be polled on a schedule, so
without the Clawback queue only on-demand re-verification (at claim or app launch) is available, which is
weaker than the Steam weekly re-check the audit already flags (P12). The queue is therefore a prerequisite for
claiming refund parity.

### 6. Console surfaces affected

- **Storefronts** (`commerce.storefronts`): Microsoft Store and itch.io rows already exist. Microsoft's state
  needs "Clawback queue: not set up" as a visible degraded state (a human step), separate from "connected".
- **Offers** (`commerce.offer`): SKU chips per store. Microsoft: create-by-API is declared (A-18f) but the Store
  ID is only known after Partner Center review, so a copy card is needed for the first SKU [I]. itch: copy
  card only.
- **Purchases / drawer** (`commerce.purchases`, `commerce.purchase`): needs the order key shown for Microsoft
  (support uses ShortOrderID from `orders/query`), the "Refunded, access kept" timeline entry, and the
  remainder-on-refund line for consumables. Open in Partner Center for refunds (stores keep their own refund
  UI, as for Apple and Play).
- **Restore** (`commerce.restore`): Microsoft restore works by account (no device-once limit), itch restore
  needs the itch identity.

## Recommendation

**Split by store, share the consumable core.**

1. **CM-28 (keep, narrow):** Apple and Play consumables on the shared ledger path: type `Consumable`,
   quantity multiplier, grant-then-consume with the Play 3-day deadline, `voidedQuantity` partial refunds
   (closes the `[I]` in CM-20 §Unverified partial-refund fields for Play), Apple `CONSUMPTION_REQUEST` answer
   from the ledger (optional), remainder-on-refund. Microsoft consumables are **not** in CM-28; CM-28 builds
   the store-neutral interface so the Microsoft package plugs in.
2. **New follow-up, Microsoft Store commerce (proposed id `CM-30`, to be registered by the lead):** Entra
   credential kind and its console field (blocked on a human), Store ID key endpoint (`serviceTicket` mint +
   key bind to `publisherUserId`), verification for `@app`, `Durable`, then `Consumable`; Clawback queue
   consumer on the Worker cron, with the event table above; `ms-store` in the store vocabulary; on-demand
   re-verification fallback. Depends on CM-28 and CM-22. Native client bridge belongs to the Godot SDK
   packages, not here.
3. **New follow-up, itch.io (proposed id `CM-31`):** `itch` in the vocabulary; verify base app and
   separate-project add-ons by `user_id`; developer API key stored as a product secret with an explicit
   warning that it is account-wide; re-lookup recheck on the Steam model. No consumables, no refund promise
   beyond "detected on next re-check". Parity row reads "Refund sync: re-check, not push".
4. **Steam consumables and EOS:** defer. Steam needs PK to run `InitTxn` as the game's server, which is a
   different product (CM-24's Steam ownership engine is read-only). EOS needs its own spike if an Epic
   channel is chosen; the facts above are only an outline.
5. **Do not claim Microsoft refund parity until a Clawback queue exists** for a real publisher. Until then the
   parity table cell reads "on-demand only".

### Parity table (target after CM-28 and the two follow-ups)

| Capability              | App Store         | Google Play                     | Steam                    | Microsoft Store                    | itch.io                      | Epic (EOS)           |
| ----------------------- | ----------------- | ------------------------------- | ------------------------ | ---------------------------------- | ---------------------------- | -------------------- |
| Verify base app         | CM-25             | CM-25                           | CM-25                    | CM-30                              | CM-31                        | later                |
| Verify durable / add-on | done              | done                            | DLC                      | CM-30                              | CM-31 (separate project)     | later                |
| Verify consumable       | CM-28             | CM-28                           | n/a (MicroTxn, deferred) | CM-30                              | n/a (none exist)             | later                |
| Quantity in purchase    | `quantity`        | `quantity` (multi-quantity)     | n/a                      | 1 per product (advised)            | 1                            | n/a                  |
| Idempotency key         | `transactionId`   | `purchaseToken`                 | order id                 | `orderId:lineItemId:productId`     | key / purchase id            | entitlement id       |
| Store-side consume      | client `finish`   | server `consume`, within 3 days | n/a                      | server `consume` + `trackingId`    | n/a                          | `RedeemEntitlements` |
| Refund push             | notifications     | RTDN                            | none                     | Clawback queue (Microsoft sets up) | none                         | clawback action [S]  |
| Refund poll backstop    | history endpoint  | Voided list (30 days)           | ownership re-check       | on-demand only                     | key re-lookup                | n/a                  |
| Partial refund          | fields unverified | `voidedQuantity`                | full only                | n/a                                | n/a                          | n/a                  |
| "Paid, keeps item"      | n/a               | n/a                             | n/a                      | `Refunded` event                   | n/a                          | n/a                  |
| Account lookup          | device once       | device once                     | linked Steam             | Store ID key (account)             | itch `user_id` (JWT / OAuth) | EOS account          |
| Console SKU creation    | API               | API                             | copy card                | declared (A-18f) / copy card       | copy card                    | later                |

## Work-package briefs that change

Proposed edits (not applied; the briefs and decision records are the lead's):

- **CM-28** (`program/wp/CM-28-consumables-quantity-grants-from-store.md`): scope text to "Apple and Play
  consumables on the shared ledger path plus a store-neutral consume interface". Add acceptance: Play consume
  inside the 3-day window with retry, `voidedQuantity` reversal, remainder recorded on refund. Move Microsoft
  out.
- **Register CM-30 (Microsoft Store commerce) and CM-31 (itch.io commerce)** in Track H of `tracks.md`, both
  after CM-28 and CM-22, with the human inputs listed below.
- **CM-20 plan**: no change to D1 to D3 or D9; note that `ms-store` and `itch` need no table rebuild
  (confirms D2). Resolve the Play `voidedQuantity` unverified item once CM-28 lands.
- **Audit §5.7 parity table**: replace `[U]` cells with the values in the table above; add the row
  "Paid, keeps item".
- **A-18f** (Microsoft Store storefront connector): note the Store ID only exists after Partner Center
  review, so SKU creation is a copy-card step at first.
- **Godot SDK / native bridge packages**: Microsoft Store commerce on the client needs a native bridge from
  Godot (WinRT `StoreContext`, or GDK `XStore`) and an MSIX build path. No such package is evidenced; flag to
  the lead.

## What needs human accounts or keys

| Item                                                                                                                                                                | Needed for                                                                                          | Who                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Microsoft Partner Center developer account, a published app (can be hidden) with at least one add-on                                                                | Any live Microsoft check; Store IDs                                                                 | Owner                                      |
| Entra ID tenant, Web app / API registration, client secret, Global Administrator consent; application id entered under Services > Product collections and purchases | Collection API calls                                                                                | Owner                                      |
| Request to the Microsoft Developer Partner Manager or contact for a **Clawback queue** (and for durables/games/bundles events)                                      | Refund push                                                                                         | Owner (Microsoft decides)                  |
| Windows machine with the Store-installed test build and a test Microsoft account                                                                                    | Store ID key, consume, refund path                                                                  | Owner                                      |
| itch.io creator account, a project with a paid or pay-what-you-want page, a second buyer account, the account API key                                               | Live download-key and purchases lookups; what `status` reads after a refund; rate-limit observation | Owner                                      |
| Apple and Google consumable products and sandbox testers                                                                                                            | CM-28 live checks                                                                                   | Owner (existing A-17k / A-18k style steps) |
| Steam publisher key with Microtransaction permission                                                                                                                | Only if Steam consumables are pursued                                                               | Owner                                      |

## Open items [U]

- itch.io: `status` values after a refund; whether a refunded purchase's key stops resolving; the real rate
  limit; whether the itch app injects a JWT with the scopes PK needs.
- Microsoft: exact Clawback queue retention; v9 `publisherQuery` field list; whether a sparse package with
  external location gets Store commerce.
- Play: `voidedReason` / `voidedSource` code tables; `productsv2` field differences (not read).
- Apple: the response time window for `CONSUMPTION_REQUEST`; rate limits of the history endpoint.
- Xbox: Godot console path (not researched).

## Sources

All fetched 2026-10-09. Microsoft pages carry their own `updated_at` (GDK pages 2026-06/07).

- [V] Manage product entitlements from a service: https://learn.microsoft.com/en-us/windows/uwp/monetize/view-and-grant-products-from-a-service
- [V] Query for products (v6): https://learn.microsoft.com/en-us/windows/uwp/monetize/query-for-products
- [V] Report consumable products as fulfilled: https://learn.microsoft.com/en-us/windows/uwp/monetize/report-consumable-products-as-fulfilled
- [V] Enable consumable add-on purchases: https://learn.microsoft.com/en-us/windows/uwp/monetize/enable-consumable-add-on-purchases
- [V] In-app purchases and trials: https://learn.microsoft.com/en-us/windows/uwp/monetize/in-app-purchases-and-trials
- [V] b2bLicensePreview (Collections v8): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-query-for-products
- [V] Managing consumable products from your service: https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/xstore-managing-consumables-and-refunds
- [V] Managing refunds and chargebacks from your service (Clawback): https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/xstore-managing-refunds-and-chargebacks
- [V] Consumable-based ecosystems: https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/fundamentals/xstore-consumable-based-ecosystems
- [S] GDK XStore reference, choosing a product type, EXE/MSI vs MSIX comparison: https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/system/xstore/functions/xstorereportconsumablefulfillmentasync , https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path
- [V] itch.io server-side API: https://itch.io/docs/api/serverside ; OAuth: https://itch.io/docs/api/oauth ; payments: https://itch.io/docs/creators/payments ; access control: https://itch.io/docs/creators/access-control ; overview: https://itch.io/docs/api/overview
- [V] itch.io ownership-check issue (2020): https://github.com/itchio/itch.io/issues/1121
- [S] itch.io refund forum threads (search digest): https://itch.io/t/129454/refunds
- [V] Apple, via DocC JSON: App Store Server API Get Transaction History (`/documentation/appstoreserverapi/get-transaction-history`), notificationType (`/documentation/appstoreservernotifications/notificationtype`), JWSTransactionDecodedPayload, Send Consumption Information
- [V] Google Play Billing integrate: https://developer.android.com/google/play/billing/integrate ; voided purchases: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list ; products resource: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
- [V] Steam microtransactions: https://partner.steamgames.com/doc/features/microtransactions ; ISteamMicroTxn: https://partner.steamgames.com/doc/webapi/ISteamMicroTxn ; inventory: https://partner.steamgames.com/doc/features/inventory
- [S] Epic Online Services Ecom (search digest): https://dev.epicgames.com/docs/epic-games-store/services/ecom/ecom-quick-start , https://dev.epicgames.com/docs/web-api-ref/ecom-web-apis
- Repo: `docs/research/2026-10-07-dx-consolidation/audits/commerce.md`, `docs/research/2026-09-29-godot-omniplatform/program/plans/CM-20.md`, `docs/design/mockups/screens/commerce/`

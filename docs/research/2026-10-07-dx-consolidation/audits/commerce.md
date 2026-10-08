# Audit: Commerce (storefronts, payments, purchase-to-licence, refunds, parity)

Domain auditor's report for the 2026-10-07 developer and administrator experience consolidation
([owner brief](../owner-brief.md)). Read-only audit of the tree at `/Users/vlad/Repos/pk-wt/dx-plan`
(v0.8.31 plus batch 5), the in-flight LX-08 branch (`/Users/vlad/Repos/pk-wt/LX-08`,
`wp/LX-08-licensing-expand`, in review), and the program backlog, specs and notes.

Path shorthands: `W/` = `packages/worker/src/`, `M/` = `packages/worker/migrations/`,
`A/` = `packages/admin/src/`, `N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`,
`P/` = `docs/research/2026-09-29-godot-omniplatform/program/`, `D/` = `docs/design/`.

---

## 1. Summary

**State.** Commerce today is two separate systems with no shared vocabulary:

1. **Store commerce** (P6-01, shipped). App Store, Google Play and Steam purchases are verified
   server-side and turned into licence flags. The engineering is solid: Apple chain pinning,
   fetch-latest, Play's OIDC push check, idempotent grants, refund sync through notifications and
   polls. The administration is not. **Every setup step is an admin API call with a JSON body**
   (`packages/docs/src/content/docs/services/distribution/commerce.md` "Setting it up"). The
   console's only Commerce page (`A/console/areas/distribution/CommercePage.tsx`) is App Store
   in-app purchases. It dead-ends on "No App Store products are mapped" with no way to map one
   (`CommercePage.tsx:311`). Play and Steam commerce, store purchases, refunds and the
   commerce settings have no console surface at all. The same store identity is typed three times:
   the outlet in `.pkey/distribution`, the credential pin, and the commerce settings block
   (`W/services/distribution/commerce/settings.ts:31-55`). The bridge stays silently off when
   they disagree (`A/console/areas/distribution/CredentialsPage.tsx:185,206`).
2. **Polaris Key commerce** (S-22, 19 deferred `CM-*` packages). It is designed in detail but not
   built. It brings a second copy of "what does a purchase grant": `dist_offers` and `grants_json`
   in S-22 §7.1, next to LX-01's store mapping (`grants_kind`, `base_tier_id`,
   `dist_store_product_entitlements`, created by LX-08). It also brings a second ledger
   (`dist_orders` next to `dist_purchases`), a subscriptions table that covers Stripe only,
   26 new `commerce.*` settings (S-22 §7.13) and five console homes for one concept (A-17g, ST-12,
   LX-14, CM-12, UX-57).

The Polaris Key storefront (S-21, PS-01 to PS-06 merged) works well for free paths. It adds a
3-setting visibility matrix (`listed` × `audience` × `offerPaths`) and leaves three separate
implementations of Steam ownership (the commerce claim, I-14's sign-in hook, PS-07's portal path).

**The single most important change.** Adopt one commerce model across every storefront, decided
in **LX-11's plan** (plan mode, not started) before CM-04 builds a parallel one:

- **Offer**: what a product sells, defined once.
- **SKU**: the offer's id on each storefront (App Store product id, Play product id, Steam DLC,
  Stripe price, or `app` for buying the app itself).
- **Purchase**: one ledger row per verified transaction from any storefront.
- **Subscription**: one ledger row per renewing purchase from any storefront.

Each storefront becomes the selling half of its channel's page. Its identity comes from the
channel's app assignment, and it activates by itself once the team credential covers it. The
owner then gets parity ("create this add-on everywhere"), one purchases and refunds view, one
subscriptions view, automatic activation, and about 35 commerce settings cut to about 6.

---

## 2. Current state (with file references)

### 2.1 Store commerce bridge (P6-01, done)

| Piece                 | Where                                                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device routes         | `GET /<p>/distribution/commerce/binding`, `POST …/commerce/claim` (`W/services/distribution/commerce/index.ts:1-30, 120-137`)                                                                                                                       | Hidden unless set up: not-found when License is off or the store is not configured (`index.ts:133`). The bridge **never creates a licence** (`index.ts:20-23`): a device with no licence gets `403 not_entitled/no_license` |
| Store hooks           | `POST …/hooks/app-store` (ASSN V2), `POST …/hooks/play-rtdn` (Pub/Sub push)                                                                                                                                                                         | Inline processing with a 503 on a transient failure so the store redelivers; dedupe on `dist_connector_events` and the purchase key hash                                                                                    |
| Verification          | `commerce/apple.ts`, `play.ts`, `steam.ts`, `core/x509.ts`                                                                                                                                                                                          | Apple: **non-consumables only** (`apple.ts:239`), Family Sharing refused. Play: one-time products only. Steam: DLC ownership only (`CheckAppOwnership`)                                                                     |
| Refund sync           | Apple REFUND/REVOKE notifications; Play voided RTDN and a **daily** Voided Purchases poll; Steam **weekly** ownership re-check (`commerce/recheck.ts:1-15`, `STEAM_RECHECK_SECONDS` at `recheck.ts:34`)                                             | Steam refunds take up to 7 days to land, even inside Steam's 14-day refund window                                                                                                                                           |
| State                 | `M/0052_commerce.sql`: `dist_store_products` (store product → one `flag` + `deliverable_id`), `dist_purchase_bindings`, `dist_purchases` (store CHECK `app-store, play, steam`), `license_store_grants`; `M/0073_dist_purchase_binding_aliases.sql` | "First licence wins" (`commerce/state.ts:10-20`); the grant goes through Core's `applyStoreGrant`                                                                                                                           |
| Settings              | `dist_connector_settings[commerce]` (`commerce/settings.ts:1-55`): `appStore {bundleId, appAppleId, acceptSandbox}`, `play {packageName, pushAudience, pushServiceAccount, acceptTestPurchases}`, `steam {appId}`                                   | Operator-only, never manifest. Registry key `distribution.commerce` (`A/console/settings.generated.ts:1210`). **API-only**                                                                                                  |
| Admin API             | `GET …/distribution/commerce`, `PUT …/settings`, `PUT …/products`, `DELETE …/products/<store>/<id>` (`commerce/admin.ts:1-25, 183-246`)                                                                                                             | The mapping write checks the flag's **shape** only (`isFlag`, `admin.ts:204`), never that the catalog declares it. A typo maps to nothing                                                                                   |
| Credential resolution | `appStoreCredential` / `playCredential` / `steamCredential` (`apple.ts:261-279`, `play.ts:299-321`, `steam.ts:94-114`)                                                                                                                              | The product's own key pinned to the identity, else the platform team key whose pin equals the identity (`W/core/platformCredentials.ts:1-45`)                                                                               |
| SDKs                  | `commerce.receipt` is **implemented in all six SDKs** (each SDK's `parity.json`)                                                                                                                                                                    | Swift `purchase(productID:)` and `restore()`; Kotlin `PolarisPlayBilling`; Godot `hidden_here()` (App Store 3.1.3(b)); React SP-16; Node and Python `claim*` helpers                                                        |
| Wire                  | `OutletCapabilities.commerce: "own" \| "store-iap" \| "steam" \| "none"` per outlet kind (`packages/shared-protocol/src/distribution.ts:41-100`)                                                                                                    | Already on the wire. This is exactly the server-side signal S-22 D25 needs ("store builds never sell through Polaris Key")                                                                                                  |

### 2.2 LX-08 (in review) and the licensing rework

`/Users/vlad/Repos/pk-wt/LX-08`, migrations `0105_a`–`0105_m`:

- `grants` with source vocabulary by trigger. It already includes **`polaris-key`**
  (`0105_a_licensing_core.sql:74`), with states `active past_due revoked refunded suppressed`.
- `device_store_identities` with `CHECK (store = 'steam')` (`0105_a:114`).
- `0105_j`/`0105_k`: `dist_store_products.grants_kind` (`addon|base|seats`) and `base_tier_id`.
- `0105_l_licensing_commerce.sql`: `dist_store_product_entitlements` (many keys per store
  product), `dist_holder_bindings` (account or licence holder), `dist_binding_aliases`. This
  second alias table sits beside 0073's `dist_purchase_binding_aliases`.
- No `dist_commerce_settings` table. `restorePolicy` and `transferCooldownDays` go into the
  commerce connector settings (`P/plans/LX-01.md` §8 Q5). LX-11's graph title still names the
  dropped table (`P/workpackages.json` LX-11).

### 2.3 Storefront adapter layer (A-18, done) and channels

- `W/core/storefront/adapter.ts:68-91`: `STOREFRONT_OPS` mixes **channel** operations
  (`uploadBuild`, `submit`, `release`, `rollout`, listing) with **commerce** operations
  (`pricing`, `iap`, `notificationsUrl`). `TYPED_OPS` includes `pricing` (`adapter.ts:111-117`).
- `W/services/distribution/storefronts/plan.ts:56-72`: A-18j's setup plan runs `pricing` and
  `iap` as "store" phase steps of the distribution flow.
- Per-store commerce support:
  - App Store: `pricing` and `iap` through the API (A-17e).
  - Play: `pricing` and `iap` through the API (A-18e runtime, `connectors/play/storefront.ts:1110-1260`).
  - Microsoft Store: `iap` declared, but **purchases are never verified**. S-15 says "add-ons
    wait for a commerce extension" (`N/S-15-storefront-provisioning.md:332`).
  - Steam: `pricing` and `iap` `unsupported` (never-list).
  - itch: link only.
  - `polaris-key`: `unsupported` ("obtained without payment").

### 2.4 Platform store connections (A-16, UX-69)

- `M/0055_platform_store_connections.sql`: `platform_credentials`, `platform_credential_pins`,
  `platform_store_settings`.
- Assigning an app to a product pins the team credential and, for the App Store, **also pins the
  In-App Purchase key to the app's bundle id** (`W/admin/handlers/platformStoreConnections.ts:34-38`).
  The commerce settings block is not written, so the operator still has to `PUT` the same bundle id
  through the API before purchases verify.
- Play RTDN push identity: the platform defaults `google-play.pushAudience` and
  `pushServiceAccount` (`commerce/play.ts:323-345`), with per-product overrides in the commerce
  block.
- Console: `A/console/pages/platformStores.tsx` (1,789 lines). Connect is checked on paste (UX-69).

### 2.5 Polaris Key storefront (S-21; PS-01 to PS-06 merged, PS-05 and PS-06 still `in-review` in the graph)

- Obtain-path engine: `W/services/identity/portal/store/obtain.ts:1-60`. Order
  `store_owned, group, product_idp, email_domain, auto_issue, open`. Only `group`, `auto_issue` and
  `open` are built. Listing modes are at `obtain.ts:37-46`.
- Settings (`A/console/settings.generated.ts`): `storefront.polarisKey.enabled` (platform kill
  switch, line 208), `.listed` (`auto|listed|unlisted`, 483), `.audience` (`eligible|everyone`,
  critical, 501), `.offerPaths` (subset of path kinds, 519), `.groupLabels` (537). That is **three
  interacting knobs for one question**: who sees this product in Discover.
- Console: `A/console/areas/storefronts/PolarisKeyPanel.tsx` (963 lines) has Readiness, Listing,
  Ways to add (one switch per path), Group labels, a persona preview and 28-day analytics.
- Portal: `A/portal/pages/DiscoverPage.tsx`, `StorefrontPage.tsx` (`#/discover/:product`) and
  link-only tiles ("Get it on Steam").
- Steam ownership: three planned or shipped implementations.
  - P6-01's claim (DLC, device ticket, `commerce/steam.ts`).
  - I-14's "optional Steam `CheckAppOwnership` grants through a Core hook" at sign-in
    (`P/wp/I-14-game-verifiers.md`).
  - PS-07's `store_owned` path through `delivery().storeOwnership()` (`P/wp/PS-07-store-owned-path.md`).

### 2.6 Console pages that expose commerce today

The Distribution sidebar has 11 items (`A/console/nav.ts:548-669`). Five of them touch commerce:

| Console page                                                            | File                                                           | Commerce content                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution → **Commerce** `distribution/commerce`                     | `areas/distribution/CommercePage.tsx` (804 lines)              | App Store IAPs beside `app-store` mappings: create IAP, locale, price, availability. **Apple only, no mapping editor**                                                     |
| Distribution → **App Store** `distribution/app-store`                   | `areas/distribution/AppStorePage.tsx` (1,830)                  | Distribute flow; links to Commerce (`:1822`)                                                                                                                               |
| Distribution → **Storefronts** `distribution/storefronts[/polaris-key]` | `areas/storefronts/StorefrontsPage.tsx`, `PolarisKeyPanel.tsx` | A-18j tiles plus the 7-step "Add to storefronts" flow (pricing and iap steps); the Polaris Key panel                                                                       |
| Distribution → **Outlet credentials** `distribution/credentials`        | `areas/distribution/CredentialsPage.tsx`                       | `app-store-server-key`, `steam-publisher-key`, `google-service-account`, each with a pin; the help text warns that commerce stays off unless the settings name the same id |
| Distribution → **Outlets & feeds**                                      | `areas/distribution/OutletsPage.tsx`                           | The `commerce` capability narrowing per outlet                                                                                                                             |
| Platform → **Store connections**                                        | `pages/platformStores.tsx`                                     | Team keys including the IAP key; RTDN push settings; app assignment                                                                                                        |
| Platform → **Settings**                                                 | `pages/platformSettings.tsx`                                   | `storefront.polarisKey.enabled`                                                                                                                                            |
| _(none)_                                                                | admin API only                                                 | Commerce settings, Play and Steam mappings, purchases, notifications, refunds                                                                                              |

The portal has Library license cards with purchase source (PX-W6: "Bought on Steam"), Discover
and the storefront page. There is **no** purchases or subscriptions view.

### 2.7 Planned work touching this domain

- **CM-01 to CM-19**: optional and deferred, about 14–22 weeks.
- **PS-05b, PS-07, PS-08, PS-09, PS-11**: todo.
- **LX-11**: commerce rework, plan mode, todo.
- **LX-12**: refund states.
- **LX-14**: console mappings and restore policy.
- **LX-20**: commerce clients. Its "Why", "Only Godot can bind and claim today", is stale.
- **LX-23**: store subscriptions, _optional_.
- **LX-25**: redeem and gift codes, optional.
- **ST-12**: commerce settings and mapping editor.
- **ST-13**: listing in the hub.
- **ST-27**: commerce alerts.
- **I-14**: Steam ownership at sign-in.
- **UK-25**: StoreKit paywall.
- **A-18k**: live verification, blocked.
- **Outside the graph**: SETUP.md Wave 5, including UX-52/53 (catalogue and read model),
  UX-54 (page shell), UX-57 (storefront status pages with a **Commerce** tab, `D/SETUP.md:956`)
  and UX-68 (setup runner).

---

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                         | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | **Store commerce cannot be set up from the console.** Settings, Play and Steam mappings, purchases and refunds are API-only; the one page dead-ends                                                                              | Docs "Setting it up" = `PUT` with JSON; `CommercePage.tsx:311` "No App Store products are mapped" with no mapping control; S-18 §2.2 row `N/S-18…:278`                                                                                                           | high   |
| P2  | **Two models for "what a purchase grants" are about to be built**: LX-11's store mapping (`grants_kind`, `base_tier_id`, `dist_store_product_entitlements`) and S-22's `dist_offers.grants_json` (CM-04)                         | `LX-08 0105_j/k/l`; `N/S-22…:431-441`. Both describe base, add-on, seats and bundle grants. Without a merge, parity across storefronts ("one add-on, sold everywhere") needs a third layer                                                                       | high   |
| P3  | **The same store identity is typed three times and silently disagrees**: outlet identity, credential pin, `commerce.appStore.bundleId` / `play.packageName` / `steam.appId`                                                      | `commerce/settings.ts:31-55`; `apple.ts:274-278` requires pin == settings bundleId; `CredentialsPage.tsx:185,206` "stays off unless its settings name the same bundle id"; assignment pins but does not configure commerce (`platformStoreConnections.ts:34-38`) | high   |
| P4  | **No purchases, refunds or subscriptions view anywhere** (console or portal). An operator cannot answer "did this customer's refund revoke their DLC?"                                                                           | `commerce/admin.ts` `recentPurchases` is API-only; no console caller; no portal purchases section; CM-11 and CM-12 deferred                                                                                                                                      | high   |
| P5  | **Store purchases never mint a product licence.** A paid-upfront app (App Store paid app, Steam base game, Play paid app) gives no licence; "bind before buying" needs a licence first                                           | `index.ts:20-23` "the bridge never creates a licence"; LX-01's `grants_kind: base` covers IAP unlocks only; AppTransaction, Play `appLicensingVerdict` (recorded by `W/core/playIntegrity.ts:20`) and Steam base-app ownership are unused                        | high   |
| P6  | **Subscriptions are unsupported from stores and optional in the plan**, although the owner says they "will generally come from storefronts"                                                                                      | `apple.ts:239` non-consumable only; LX-23 `optional: true`; S-22's `dist_subscriptions` covers Stripe only                                                                                                                                                       | high   |
| P7  | **Settings explosion planned.** S-22 adds 26 `commerce.*` keys (23 product, 3 platform) beside 8 per-store fields, LX-11's `restorePolicy` and `transferCooldownDays`, and 5 `storefront.polarisKey.*` keys                      | `N/S-22…:730-769`; `settings.generated.ts:208-560`. Most are per-offer facts or fixed policy (proration mode, buffer hours, withdrawal waiver, dunning mail owner)                                                                                               | high   |
| P8  | **Five packages own the same console surface**: A-17g (Commerce page), ST-12 (commerce settings and mapping editor), LX-14 (mappings and restore policy), CM-12 (Product → Commerce), UX-57 (storefront Commerce tab)            | `P/wp/ST-12…` "Coordinate the Commerce page with A-17g"; LX-14 scope; CM-12 scope; `D/SETUP.md:956`                                                                                                                                                              | high   |
| P9  | **Naming collides with the owner's model.** SETUP.md D1 calls every delivery place a "storefront", while the owner separates distribution **channels** from commerce **storefronts**. "Channel" is also the release-channel word | `D/SETUP.md:93` (D1); owner brief "Distribution Channels … Commerce Storefront … the two concepts should be separated"                                                                                                                                           | medium |
| P10 | **Steam ownership is implemented three times** (claim, I-14 sign-in hook, PS-07 portal path), each with its own budget and cache                                                                                                 | §2.5                                                                                                                                                                                                                                                             | medium |
| P11 | **Refunds take two paths with different rules**: `revokeRecordedPurchase` for stores, CM-06 for Stripe; dispute and partial-refund rules exist only for Stripe                                                                   | `commerce/state.ts:481-548`; `N/S-22…:553-568`                                                                                                                                                                                                                   | medium |
| P12 | **Steam refunds lag up to 7 days**                                                                                                                                                                                               | `recheck.ts:34` `STEAM_RECHECK_SECONDS = 7d`                                                                                                                                                                                                                     | medium |
| P13 | **Three ways to say "test purchases"**: `appStore.acceptSandbox`, `play.acceptTestPurchases`, S-22 `commerce.mode` (Stripe), plus "use a separate staging product"                                                               | `settings.ts:16-19`; `N/S-22…:740`                                                                                                                                                                                                                               | medium |
| P14 | **The Discover visibility matrix**: `listed` (3) × `audience` (2) × `offerPaths` (a subset of 6) with ordering rules                                                                                                             | `obtain.ts:37-46`; `PolarisKeyPanel.tsx:1-17`                                                                                                                                                                                                                    | medium |
| P15 | **Microsoft Store and itch.io purchases are not verified at all**; consumables are unsupported on every store                                                                                                                    | `0052` CHECK (`app-store, play, steam`); `N/S-15…:332`; `apple.ts:239`                                                                                                                                                                                           | medium |
| P16 | **"Link your account" provisions nothing server-side.** Only Steam can be looked up by account; Apple and Google sign-in links say nothing about App Store or Play purchases                                                     | Store API facts (App Store Server API and Play Developer API address purchases by transaction or token, not by account) [I]; I-06 Steam sign-in done, PS-07 todo                                                                                                 | medium |
| P17 | **Two binding-alias tables** (`dist_purchase_binding_aliases` 0073 and `dist_binding_aliases` 0105_l)                                                                                                                            | `M/0073…`; LX-08 `0105_l`                                                                                                                                                                                                                                        | low    |
| P18 | **The mapping requires a `deliverable`** that is derivable from the catalog and gating                                                                                                                                           | `commerce/admin.ts:214-230`; only echoed to the claimant (`state.ts:475`)                                                                                                                                                                                        | low    |
| P19 | **Backlog staleness**: PS-05 and PS-06 merged but `in-review`; LX-11's title names `dist_commerce_settings`; LX-20's "Why" is wrong; EXPERIENCE.md §159 (5 Distribution items) disagrees with SETUP.md §2.2 (4 items)            | git log `464c6780d`, `0226e2824`; `P/wp/LX-20…`; `D/EXPERIENCE.md:159`, `D/SETUP.md:581-588`                                                                                                                                                                     | low    |

---

## 4. Owner brief: item-by-item stance

| #   | Owner item                                                                                                          | Stance | Rationale and design response                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Commerce = storefronts: payments, transactions, licence and entitlement grants                                      | adopt  | Concept set in §5.1: Storefront, Offer, SKU, Purchase, Subscription; grants via S-19's single writer                                                                                                                                                                                                                                                                                                                                                                  |
| O2  | Step-by-step instructions for unconfigured storefronts                                                              | adopt  | One storefront wizard skeleton (Connect, Notifications, Products) in SETUP.md's pattern, human steps only (§7); most steps become **Polaris Key does this** because the channel's app assignment already holds the credential                                                                                                                                                                                                                                         |
| O3  | Well laid-out information for configured storefronts                                                                | adopt  | The storefront half of each channel page (Sales tab), plus **Commerce → Purchases** and **Offers** (§5.4)                                                                                                                                                                                                                                                                                                                                                             |
| O4  | Settings, both global and per storefront                                                                            | adapt  | Global is Platform → Store connections (team keys, Stripe platform account) plus two platform keys. Per storefront is an "Advanced" fold on the Sales tab (restore policy). **Push back on a settings matrix**: about 35 keys become about 6 (§6)                                                                                                                                                                                                                     |
| O5  | Parity across storefronts                                                                                           | adopt  | One offer with a SKU per storefront: "Create on every storefront" where an API exists (A-17e Apple, A-18e Play, Stripe), copy cards where none does (Steam DLC, itch). One purchase ledger and one subscription ledger. Honest limits are named in the UI (§5.7)                                                                                                                                                                                                      |
| O6  | Standardise setup while exposing store-specific configuration                                                       | adopt  | The catalogue declaration (UX-52) gains a `storefront` part: verification credential slot, notification kind, SKU kind, wizard `human`/`auto` lists. Store-specific rows come from it, never from page code                                                                                                                                                                                                                                                           |
| O7  | The Polaris Key storefront needs Stripe credentials "optionally, if we want to charge"                              | adopt  | Free listing works today (PS). Paid uses S-22's Connect direct charges (D1, G1–G6 approved 2026-10-06). **Ask the owner for "commerce: go" on a reduced v1** (§9). The brief asks for Polaris Key subscriptions, which only CM delivers                                                                                                                                                                                                                               |
| O8  | App Store has specific required fields                                                                              | adapt  | Most "specific fields" are identity that is already known. Bundle id and Apple ID are **derived from the assigned app** (P3). Only genuinely store-specific inputs remain: the RTDN service account for Play, and the ASSN URL paste when Apple does not persist the PATCH (A-17h)                                                                                                                                                                                    |
| O9  | Third-party purchase plus linked account means automatic licence and sub-licence provisioning                       | adapt  | (a) A signed-in device's purchases are held by the **account** (LX-11 holder bindings). (b) SDKs run a purchase **sync** on sign-in and launch (restore sweep, LX-20). (c) **Steam** links sync server-side (CM-24). (d) **App purchases mint the product licence** (CM-25). **Push back** on server-side provisioning from an Apple or Google sign-in link: neither store can be queried by account, so the device must present a transaction once; the copy says so |
| O10 | Keep in sync; a refund removes the licence                                                                          | adopt  | One `revokePurchase` path for every source (CM-22) under LX-12's states. A refunded base purchase ends the licence (`ended_reason = refunded`). Steam re-checks daily inside the 14-day window. Partial refunds never revoke; chargebacks revoke at once                                                                                                                                                                                                              |
| O11 | Subscriptions mostly from storefronts; the licensing behind them works with Commerce off                            | adopt  | **LX-23 becomes required** and owns one subscription ledger for every source. Term models (renewable, perpetual fallback) are License features (licensing domain). Commerce only **drives** them. An admin and developer "renew until" API lets a product bill elsewhere with no Commerce (cross-domain)                                                                                                                                                              |
| O12 | Channel and storefront are separate concepts, but share one central page; show the wizard for whichever side is off | adapt  | One page per channel with a **Sales** tab when the channel can sell. Each half renders data or its wizard independently, so Steam DLC verification works without Polaris Key publishing builds to Steam, and the reverse. A cross-store **Commerce** sidebar group holds what is not per store (Offers, Purchases)                                                                                                                                                    |
| O13 | If a channel's setup also sets up the storefront, activate it automatically                                         | adopt  | Assigning the app pins the team IAP key, Play service account or Steam publisher key, which makes the storefront `ready` with no settings write (CM-21). Only notifications and product mappings remain, and those come as suggestions                                                                                                                                                                                                                                |
| O14 | Gate channels and storefronts by application type                                                                   | adopt  | Storefront scope is channel scope (`productPlatforms`, UX-53). A macOS app never sees a Play storefront                                                                                                                                                                                                                                                                                                                                                               |
| O15 | Store pages contain as much data as the enabled sources provide                                                     | adopt  | Degradation matrix in §5.6                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| O16 | Licence models: lifetime, expiry, version, renewable, renewable plus perpetual (JetBrains), per-major               | defer  | Owned by the licensing audit. Commerce's contract: an offer references a **tier**, and the tier carries the term model, so a store subscription lapsing triggers the same perpetual-fallback code as a manual expiry                                                                                                                                                                                                                                                  |
| O17 | IAPs bought several times; redemption status (in-game currency)                                                     | adapt  | Needs licensing's quantity and redemption model. Commerce adds consumable verification (Apple consumables, Play `consume`) in CM-28, after the CM-27 spike. Today only non-consumables verify (`apple.ts:239`)                                                                                                                                                                                                                                                        |
| O18 | Entitlements include platform things (update channels, cloud sync)                                                  | defer  | Licensing domain. Offers can grant any declared entitlement with no special case                                                                                                                                                                                                                                                                                                                                                                                      |
| O19 | Customers see a store link for store channels                                                                       | adopt  | Already in PS-05 link tiles and PORTAL G2. With SKUs, the storefront page adds "Also on App Store · Steam"                                                                                                                                                                                                                                                                                                                                                            |
| O20 | RBAC: a group can be given access to an app's storefront settings                                                   | adopt  | Commerce declares capabilities for ST-21 and RBAC: `commerce.read`, `commerce.write` (offers, mappings), `commerce.refund`, `commerce.merchant` (product owner only, CM-T6)                                                                                                                                                                                                                                                                                           |
| O21 | "Subscription licences available even if Commerce is not active"                                                    | adopt  | "Commerce active" is a **fact** (some storefront `ready` or `selling`), not a service. **Push back on making Commerce a seventh service**: `tools/services.json` generates every SDK's constants (`gen:services`), an all-language event that buys nothing. Commerce stays a Distribution sub-capability, like `packageFeeds` (`nav.ts` `requires`)                                                                                                                   |

---

## 5. Target design

### 5.1 Vocabulary: fewer, stronger concepts

| Concept                    | Definition                                                                                                                                                                                        | Replaces                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Channel** (distribution) | Where builds reach customers (Polaris Key, App Store, Play, Steam, Homebrew…). Distribution audit's domain                                                                                        | SETUP.md's delivery-side "storefront"; "outlet" in UI                                                                                             |
| **Storefront** (commerce)  | The selling half of a channel: App Store, Google Play, Steam, Microsoft Store, itch.io, Polaris Key. It has a connection (shared with its channel), purchase verification, notifications and SKUs | "commerce settings" blocks; "commerce bridge" in UI                                                                                               |
| **Offer**                  | What a product sells, defined once: `base` (a tier), `addon` (entitlements), `seats`, `consumable` (a quantity of a counted entitlement), with `billing: one_time \| subscription`                | `dist_store_products.flag`, `grants_kind`, `base_tier_id`, `dist_store_product_entitlements`, S-22 `dist_offers.grants_json`, obtain-path "offer" |
| **SKU**                    | One offer's id on one storefront: App Store product id, Play product id, Steam DLC app id, Microsoft add-on id, Stripe price (per currency), or **`app`** (buying the app itself)                 | `dist_store_products` rows                                                                                                                        |
| **Purchase**               | One verified transaction from any storefront: holder, offer, SKU, state (`pending active refunded revoked charged_back`), what it granted, `order_ref`                                            | `dist_purchases` (stores) and S-22 `dist_orders` presented separately                                                                             |
| **Subscription**           | One renewing purchase from any storefront: status mirrored from the store or provider, period end, the licence or grant it keeps alive                                                            | S-22 `dist_subscriptions` (Stripe only) plus LX-23's store mapping onto grant columns                                                             |

Everything still lands as S-19 **grants** through `core/grants.ts` (LX-08). Nothing in this list
touches a signed document.

**Naming decision for the lead (cross-domain).** In the UI, the delivery place is a **Channel**
(the owner's word) and the selling half is its **Storefront**. Release streams (stable, beta, dev)
must then be named distinctly in UI copy, for example "release channel" or "track". The
distribution and release auditors own that choice. If the lead keeps SETUP.md's "storefront" for
delivery places, the selling half should be labelled **Sales** everywhere, never "Commerce" on one
page and "Storefront" on another.

### 5.2 Data model (decided in LX-11's plan, CM-20)

Expand-only, one bare `ADD COLUMN` per file (R11-04), and nothing dropped before LX-16:

```sql
-- Distribution-owned
dist_offers (product, id, kind CHECK-by-trigger base|addon|seats|consumable, label,
             tier_id NULL, quantity NULL, billing one_time|subscription, interval NULL,
             trial_days NULL, limit_per_holder one|unlimited, state draft|on_sale|retired,
             created_at, modified_at, PK (product, id))
dist_offer_entitlements (product, offer_id, key, value_json, PK (product, offer_id, key))
ALTER TABLE dist_store_products ADD COLUMN offer_id TEXT;   -- the SKU row points at its offer
dist_subscriptions (product, id, source app-store|play|polaris-key, holder, offer_id,
                    provider_ref_hash, status, current_period_end, cancel_at_period_end,
                    license_id NULL, grant_id NULL, ...)      -- LX-23 creates it; CM-08 adds Stripe
```

- **Backfill.** One offer per **distinct entitlement set** across the existing mappings. The
  Apple product `skins`, the Play product `skins` and Steam DLC `1234567`, all mapped to
  `extras.diceSkins`, become **one** offer "Dice skins" with three SKUs. That is the parity view,
  produced from data that already exists.
- `dist_store_products.flag`, `deliverable_id`, `grants_kind`, `base_tier_id` and LX-08's
  `dist_store_product_entitlements` stay dual-written until LX-16, then go dead.
- **Polaris Key prices** (`dist_offer_prices`, CM-04) are SKUs of the Polaris Key storefront.
- **Purchase ledger.** `dist_purchases.store` has a CHECK constraint, so widening it to
  `polaris-key`, `ms-store` or `itch` means a D1 table rebuild. Recommendation: CM-22 defines one
  **read model** (`purchases` across `dist_purchases` and CM's `dist_orders`) and one
  `revokePurchase`. The CHECK moves to a trigger vocabulary in LX-16's contract step, where
  rebuilds are already planned.
- **One alias path.** LX-11 reads `dist_binding_aliases` first, then
  `dist_purchase_binding_aliases`. The latter retires at LX-16.

### 5.3 Storefront connection, identity derivation and automatic activation (CM-21)

**Identity is derived, never typed.**

| Store       | Derived from                                                                                                     | Verification credential                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| App Store   | The assigned app (platform pin `app-store.api-key` → Apple ID; bundle id read from ASC; `appAppleId` = Apple ID) | Team IAP key, pinned at assignment (already done), or the product's own `app-store-server-key` |
| Google Play | The assigned package (pin)                                                                                       | Team service account (pin), or the product's own                                               |
| Steam       | The assigned app id (pin) or the `steam` outlet                                                                  | Team publisher key (pin), or the product's own                                                 |
| Polaris Key | Always (built in)                                                                                                | Free paths: none. Paid: a connected merchant (CM-03)                                           |

The `distribution.commerce` block keeps only optional overrides (the per-store `restorePolicy`).
`bundleId`, `appAppleId`, `packageName` and `appId` are read from the pin. A stored value that
disagrees becomes an **attention** item ("Commerce settings name `com.old.app`; the assigned app
is `com.acme.app` · Use the assigned app"), never a silent off.

**Storefront state machine**, computed per (product, store) in the storefronts read model (UX-53
extension), facts only (SETUP D14):

```text
unavailable  (platform not in scope; absent from every list)
not_connected  → no verification credential covers the app
ready          → credential pinned; License on; nothing mapped yet       ← assignment lands here
selling        → ≥ 1 on-sale offer has a SKU here AND notifications verified (or, for Steam, recheck armed)
attention      → notifications failing · unmapped purchase seen · credential failing · identity mismatch
```

**Automatic activation.** When a platform admin assigns an app (A-16) and the team holds the
verification key, the storefront goes `not_connected` → `ready` in the same batch, with no second
credential and no settings `PUT`. The remaining steps, with what Polaris Key does for each:

| Step                        | Polaris Key does this                                                                                                                                                                           | Needs you                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Store notifications (Apple) | `setup/notifications-url` PATCH, verify, test notification (A-17h, `connectors/asc/provision.ts:6-40`)                                                                                          | Paste the URL only when Apple did not persist it (copy card, verifier ticks itself)        |
| Store notifications (Play)  | Fill the push audience with the hook URL by default; verify on the first RTDN test                                                                                                              | Create the topic and push subscription in Play Console and GCP (link step, verifier)       |
| Steam                       | Arm the age-based ownership re-check; no notifications exist                                                                                                                                    | Nothing                                                                                    |
| Products                    | **Import** the store's products (ASC `inAppPurchasesV2` read, Play `oneTimeProducts.list`, Steam `appdetails.dlc`) and **suggest** offers by id and name against catalog entitlements and tiers | Confirm the suggestions. Money decisions stay operator-confirmed (S-22 D7, never manifest) |
| Test                        | Watch for the first verified (sandbox) purchase, the "It works" moment                                                                                                                          | Make one sandbox purchase                                                                  |

### 5.4 Console information architecture

```text
Product sidebar
  Distribution
    Channels ▸ Polaris Key · App Store · Google Play · Steam · …  (in-scope, set-up)  + Add a channel
    Rollouts · Health · Packages                                                     (distribution audit)
  Commerce            (shown while License is on; NavRequirement "commerce", like packageFeeds)
    Offers            catalogue: offer rows × storefront SKU chips (✓ com.acme.skins · ✓ DLC 1234 · Play: Create)
    Purchases         every storefront's purchases; Subscriptions as a view; refund and revocation events
Platform sidebar
  Store connections   team keys (+ "Payments: Stripe" when CM goes), app assignment, RTDN defaults
```

**Channel page, Sales tab** (UX-57's "Commerce" tab, renamed and widened):

- **Header line**: storefront state; "Selling 3 offers · 41 purchases in 28 days · 1 refund"; test
  purchases on or off.
- **Status**: the connection (credential source, pin, last check, Re-check, Replace key), the
  notifications health (last event, failures) and the restore policy (Advanced).
- **Products**: this store's SKUs with their offer, store state (App Store "Ready to submit",
  Play "Active") and actions. Create IAP, locale, price and availability (today's
  `CommercePage.tsx` dialogs, moved here). Price changes stay typed (`TYPED_OPS`).
- **Purchases**: the Purchases view filtered to this store.
- **When the storefront is not set up**: the wizard (§5.3), whatever the channel's state. When
  the channel is not set up but the storefront is (Steam DLC verified, builds shipped elsewhere),
  the Status, Releases and Listing tabs show the channel wizard and the Sales tab shows data. This
  is the owner's "show information from both sides" rule.

**Commerce → Offers**: one editor for kind, tier or entitlements (catalog-validated: undeclared
keys refused), billing, trial, limit and state. One action per storefront: **Create on App
Store** (A-17e), **Create on Google Play** (A-18e `one_time_product.upsert`), Stripe (CM-04), and
copy cards for Steam DLC and itch (no API). A 3.1.3(b) warning appears when an offer is sold
outside the App Store but has no App Store SKU while the product ships iOS (S-22 §7.11).

**Commerce → Purchases**: search by holder email, licence, store reference hash or order. The
detail shows the timeline (claimed, verified, notification, refund), what it granted, and the
holder. Actions:

- **Re-verify with store**;
- **Revoke grant** (L2, reason);
- **Refund** (Polaris Key only, CM-06; stores get **Open in App Store Connect / Play Console**);
- **Move grant** (LX-14's action, linked).

The Subscriptions view lists status, renews or ends on, the store, and **Manage** (deep link).

**Retired:**

- Distribution → Commerce, redirected to `distribution/channels/app-store?tab=sales` (or
  `commerce/offers`) through `LEGACY_REDIRECTS`.
- Distribution → Outlet credentials, per SETUP D23.
- The API-only setup path. The routes stay; the docs lead with the console.

### 5.5 Portal

- **Account → Purchases** (CM-26): every purchase and subscription across storefronts and
  developers, with source ("App Store", "Steam", "Polaris Key"), date, state (refunded shown, never
  hidden) and **Manage subscription** deep links (App Store subscriptions page, Play subscription
  link, or Stripe portal once CM-11 exists). This works with Polaris Key checkout off. CM-11 adds
  invoices, cancel and resume to the same page rather than a separate "Billing" section.
- **Product page**: the add-ons held, each with its source, and "Restore purchases" help for store
  builds.
- **Storefront page**: a Buy button when a Polaris Key price exists (CM-04, folding CM-16), and
  "Also on App Store · Steam" from SKUs and channel listing URLs. No store prices are shown: Steam
  has no price API and Apple price points are per territory. That limit is stated honestly.

### 5.6 Graceful degradation matrix

| Enabled                                   | Channel side shows         | Storefront (Sales) side shows                                                                    |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| Channel only (ASC API key, no IAP key)    | Builds, review, TestFlight | Wizard: "Sell on the App Store", one step if the team IAP key exists (assign), else Connect      |
| Storefront only (IAP key, no ASC API key) | Channel wizard             | Purchases, refunds, SKUs (from mappings; store state "unknown without App Store Connect access") |
| Both                                      | Everything                 | Everything, plus SKU store state from ASC                                                        |
| License off                               | Channel as today           | Sales tab absent; Commerce group absent; one line "Turn on License to sell" on the channel page  |
| Platform `commerce.platform.enabled` off  | unchanged                  | Polaris Key paid paths hidden; store verification **keeps running** (customers already paid)     |

### 5.7 Parity: what each storefront can do (shown in the Offers SKU chips)

| Capability                     | App Store              | Google Play               | Steam                            | Microsoft Store    | itch.io   | Polaris Key      |
| ------------------------------ | ---------------------- | ------------------------- | -------------------------------- | ------------------ | --------- | ---------------- |
| Verify one-time purchase       | ✓ (P6-01)              | ✓                         | ✓ DLC                            | ✗ → CM-27          | ✗ → CM-27 | CM-05            |
| Verify the app purchase (base) | AppTransaction → CM-25 | licensing verdict → CM-25 | base app ownership → CM-25       | [U] CM-27          | [U] CM-27 | n/a              |
| Create SKU by API              | ✓ A-17e                | ✓ A-18e                   | ✗ (copy card)                    | ✓ declared (A-18f) | ✗ link    | CM-04            |
| Set price by API               | ✓ typed                | ✓ typed                   | ✗ never-list                     | ✓ typed            | ✗ link    | CM-04            |
| Refund sync                    | notifications          | RTDN + daily poll         | ownership re-check (daily ≤14 d) | [U]                | [U]       | webhooks (CM-06) |
| Subscriptions                  | LX-23                  | LX-23                     | n/a                              | [U]                | n/a       | CM-08            |
| Consumables                    | CM-28                  | CM-28                     | n/a (inventory service)          | [U]                | n/a       | later            |
| Server lookup by account       | ✗ (device once)        | ✗ (device once)           | ✓ linked Steam (CM-24)           | [U]                | [U] OAuth | ✓ ledger         |

### 5.8 SDK surface (all six SDKs)

- `commerce.offers()` lists the offers for this build. On a store build, each has its store SKU;
  on `direct` and web builds, its Polaris Key price (once CM ships).
- `commerce.purchase(offerId)` routes by outlet: store billing on a store build (existing
  bridge), Polaris Key checkout hand-off on `direct` and web (CM-15). **One call in app code for
  every store.**
- `commerce.sync()` runs on sign-in and on launch, throttled. It sweeps
  `Transaction.currentEntitlements` / `queryPurchasesAsync` / the Steam ticket and claims anything
  unclaimed. This is the automatic provisioning of O9.
- `commerce.manageSubscriptions()` deep-links to the right store.
- **Wire, plan mode, one event**: the binding response gains an additive `offers[]` (`{id, kind,
label, sku?: {store, productId}, price?}`). This merges CM-14's W2 with the store offers, so the
  SDKs move once. `PROTOCOL_VERSION` stays 4; no signed document changes.
- The `transferred` restore result (LX-20) and the `app` claim kind (CM-25) are additive request
  and response members in the same plan. W1 and W3 (`checkout`, `store_billing_required`) stay
  with CM-14. W3 is derived from the already-signed `OutletCapabilities.commerce`.

### 5.9 Refunds, disputes and revocation (one path)

`revokePurchase(purchase, reason, {grace})` in Distribution writes LX-12's states through
`core/grants.ts`:

- full refund: grant `refunded` with `grace_until = licensing.refundGraceHours`; a base licence
  is disabled with `ended_reason = refunded`;
- partial refund: no revocation;
- chargeback or lost dispute: immediate, no grace;
- `order_ref`: bundle and gift codes revoke together.

Every source calls it: Apple REFUND/REVOKE, Play voided, Steam non-owner, Stripe
`charge.refunded` and disputes. A flag stays held while another active grant gives it (S-19).
Emails ("Your access to X has ended") and the developer webhook `purchase.refunded` fire from
this one function. That is why CM-13 merges into CM-06 and CM-08.

---

## 6. Surface-area reduction

| Area                       | Today or planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Target                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console pages              | Distribution → Commerce, App Store (IAP part), Outlet credentials (commerce kinds), API-only setup; planned: ST-12 editor, LX-14 mappings, CM-12 area, UX-57 tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Channel page **Sales** tab, **Commerce → Offers**, **Commerce → Purchases**. One build (CM-23)                                                                                                                                                                        |
| Per-store identity fields  | 8 (`bundleId`, `appAppleId`, `acceptSandbox`, `packageName`, `pushAudience`, `pushServiceAccount`, `acceptTestPurchases`, `steam.appId`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **0 typed**: derived from the pin. `pushAudience` defaults to the hook URL                                                                                                                                                                                            |
| Test-purchase switches     | `acceptSandbox`, `acceptTestPurchases`, `commerce.mode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `commerce.acceptTestPurchases` (product, critical). Stripe live or test is a fact of the connected merchant (`livemode`)                                                                                                                                              |
| S-22 `commerce.*` keys     | 26 (23 product + 3 platform)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **4**: `commerce.acceptTestPurchases`, `commerce.pricesIncludeTax`, `commerce.platform.enabled`, `commerce.platform.applicationFeeBps`, plus the merchant connection (a connection, not a setting) and the reused `licensing.refundGraceHours` and `dunningGraceDays` |
| Dropped S-22 keys          | `enabled` (fact), `mode` (merchant), `tax.mode` (always automatic when the merchant has Stripe Tax), `tax.defaultCode` (from product kind; per-offer override), `currencies.default` (merchant), `adaptivePricing` (v2), `checkout.allowPromotionCodes` (on iff a coupon exists), `withdrawalWaiver` (fixed `eu`, G4), `invoices.oneTime` (always), `addons.requireBase` (an add-on offer's definition), `allowMultipleBase` (offer `limit_per_holder`), `upgrades.oneTimePricing` (offer price, difference by default), `upgrades.proration` (fixed), `upgrades.eligibleSources` (fixed rule D14), `trials.requirePaymentMethod` (offer), `subscriptions.renewalBufferHours` (constant 24 h), `refunds.partialRevokes` (never), `disputes.onOpen` (keep), `gifting.enabled` (offer `giftable`), `gifting.refundRevokesRedeemed` (always), `emails.dunning` (Stripe's), `platform.merchantCountries` (Stripe enforces) | —                                                                                                                                                                                                                                                                     |
| Restore policy             | `restorePolicy` × 3 stores + `transferCooldownDays`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One per-store value, in Advanced, with store defaults (`follow-account`, or `first-device-only`); cooldown dropped                                                                                                                                                    |
| Discover visibility        | `listed` (3) × `audience` (2) × `offerPaths` (subset of 6) + `groupLabels`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **`storefront.polarisKey.visibility`: `unlisted \| eligible \| everyone`** (PS-12). Ways to add follow their sources (auto-issue, group map, open delivery, linked store). Group labels move onto the group-mapping row. Platform kill switch kept                    |
| Grant definitions          | Store mapping (flag, entitlements, grants_kind, base_tier) **and** S-22 offers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Offer** (one model)                                                                                                                                                                                                                                                 |
| Ledgers                    | `dist_purchases` + `dist_orders` + `dist_subscriptions` (Stripe) + store-subscription grant columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One purchases read model + one subscriptions table                                                                                                                                                                                                                    |
| Steam ownership code paths | 3 (claim, I-14 hook, PS-07)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 1 engine (CM-24)                                                                                                                                                                                                                                                      |
| Credential homes           | Platform → Store connections, Outlet credentials, commerce settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2: team (Store connections) and product override (channel Setup tab)                                                                                                                                                                                                  |
| Alias tables               | 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1 read path; 0073's retired at LX-16                                                                                                                                                                                                                                  |
| Mapping fields             | `deliverable` required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Derived from gating; not asked                                                                                                                                                                                                                                        |
| Work packages              | 19 CM + LX-11/14/20/23 + ST-12 + PS-07/09 + A-17g page + UX-57 tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | CM-13 and CM-16 merged; PS-07 into CM-24; PS-09 into licensing's auto-mint policy; commerce slices of ST-12, LX-14 and CM-12 into CM-23                                                                                                                               |

Net: about 35 commerce and storefront settings become 6 keys plus one connection. Five console
homes become one area. Two grant models become one.

---

## 7. Automation and onboarding

1. **Assignment activates the storefront** (CM-21). Assigning the app in Platform → Store
   connections already pins the IAP key (`platformStoreConnections.ts:34-38`). Make that the whole
   "connect" step.
2. **Notifications set themselves** where a store API exists: Apple ASSN PATCH, verify and test
   (A-17h code exists); the Play push audience is defaulted. A failed automation turns into its
   human step with copy cards (SETUP §2.8.1 rule).
3. **Import and suggest products.** Read the store's products and propose offers by matching
   product ids and names against catalog entitlements and tiers. One confirm creates the offers
   and SKUs.
4. **Create everywhere.** From an offer, create the App Store IAP (A-17e), the Play one-time
   product (A-18e), the Stripe product and price (CM-04). Steam DLC and itch get copy cards with
   deep links. Prices: one base price, converted with each store's tools (Apple price points, Play
   `convertRegionPrices`), with the typed confirmation kept.
5. **SDK sync on sign-in** (LX-20) and **Steam linked-account sync** (CM-24) remove "Restore
   purchases" from the happy path.
6. **App purchase gives a licence** (CM-25). A paid store build activates with no key and no
   account.
7. **Verification moment.** The first verified sandbox purchase ticks the wizard's last step and
   feeds the Products "Integration" section's done state (products audit). The Integration section
   gains a **Commerce** card: per-store snippets (Swift `purchase(offerId)`, Kotlin, Godot, Node
   Steam claim) generated from the product's offers and SKUs, so a pasted snippet names real ids.
8. **Attention and alerts** (UX-12, ST-27):
   - "Store notifications failing for 24 h";
   - "Purchase of an unmapped product" (a store product sold with no offer: money taken, nothing
     granted; danger);
   - "Identity mismatch";
   - "Refunds above usual".
9. **Mapping validation**: an undeclared entitlement is refused with "Declare `extras.diceSkins` in
   the catalog first · Open catalog".

---

## 8. Migration, data and risk

| Item                                                | Plan                                                                                                                                                                                                  | Risk                                                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Derived identity (CM-21)                            | Read the pin first, then the stored block as a fallback for one release. Mismatches become attention items and are never auto-fixed. Stop writing identity fields from the console                    | A product whose stored bundle id differs from its pin stops verifying if we flip at once, so we don't: mismatch means attention, and the stored value wins until an operator confirms "Use the assigned app" |
| Test-purchase unification                           | Backfill `commerce.acceptTestPurchases = true` only where every configured store accepted test purchases. Otherwise keep a transitional per-store override and list the product in a migration report | **Security widening**: a union would let Play tester purchases unlock where only Apple sandbox was accepted. Treat as THREAT-MODEL row; L2 confirm                                                           |
| Offers backfill (LX-11)                             | Deterministic offer ids from the entitlement set (`off_m_<hash>`), one per distinct set; `dist_store_products.offer_id` filled; replayable `INSERT OR IGNORE`; dual-write until LX-16                 | Grouping two store products that grant the same flag but are commercially different. Grouping is a **suggestion** the operator can split, never a merge of purchases                                         |
| LX-08 in review                                     | Merge as is. Its `dist_store_product_entitlements`, `grants_kind` and `base_tier_id` are the transitional store under offers                                                                          | None if LX-11's plan adopts offers. High churn if CM-04 builds `dist_offers` separately later                                                                                                                |
| `dist_purchases.store` CHECK                        | Read model now; trigger vocabulary at LX-16's rebuild                                                                                                                                                 | A D1 table rebuild on a hot table: rehearse on scratch SQLite (R11)                                                                                                                                          |
| Wire (`offers[]`, `app` claim, `transferred`)       | One plan (CM-20) → contract → transcripts (`gen:transcripts`) → constants → six SDKs. Additive only; `PROTOCOL_VERSION` 4, `corpusVersion` 2                                                          | All-SDK event: keep it to one plan; the Godot `hidden_here` logic still needs other stores' SKUs, so **do not filter** the binding response by outlet                                                        |
| Settings removal                                    | ST-03 registry rows removed; `settings-coverage` and docs `gen:check` updated; S-22's dropped keys are never added                                                                                    | None (they do not exist yet)                                                                                                                                                                                 |
| `storefront.polarisKey` visibility collapse (PS-12) | `unlisted` → `unlisted`; `auto` and `listed` (with or without `offerPaths`) → `eligible`; `audience everyone` → `everyone`. Report products whose `offerPaths` excluded a path that is now offered    | `auto` → `eligible` newly lists `open` and `store_owned` products to eligible people. That is the owner's S-21 intent, but it is a visible change: show it in the report                                     |
| Steam re-check cadence                              | Daily for purchases under 14 days old, weekly after                                                                                                                                                   | Steam Web API budget [U]; age-based keeps volume close to today's                                                                                                                                            |
| URL redirects                                       | `distribution/commerce` and `distribution/credentials` go through `LEGACY_REDIRECTS` (`A/console/routes.ts`)                                                                                          | Docs links gate (`docsLinks.test.ts`)                                                                                                                                                                        |
| CM deferral                                         | Store-commerce packages (CM-20 to CM-28) are **required, not deferred**. Polaris Key checkout stays deferred until the owner's go                                                                     | The validator refuses a non-deferred package depending on a deferred one: none of CM-20 to CM-28 depends on CM-01 to CM-19                                                                                   |
| Operator-only money rule                            | Kept: offers, SKUs and prices are never manifest fields (S-22 D7, LX-01 §3.1). Entitlement **definitions** may be catalog data (licensing audit)                                                      | None                                                                                                                                                                                                         |

---

## 9. Backlog changes

| id     | action  | target              | note                                                                                                                                                                                                                                                                                                    |
| ------ | ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LX-11  | edit    | CM-20 plan          | Its plan is written as CM-20 (`planRef`). It adopts Offer and SKU (`dist_offers`, `dist_offer_entitlements`, `dist_store_products.offer_id`), the `app` SKU kind, one alias read path, and restore policy as one per-store value without cooldown. Fix the title (no `dist_commerce_settings`)          |
| LX-12  | keep    |                     | Its states are the target of the one `revokePurchase`                                                                                                                                                                                                                                                   |
| LX-14  | edit    | CM-23               | Commerce mappings and restore-policy editors move to CM-23. LX-14 keeps the licence Entitlements and Grants tabs, comp, trial, suppress, move and the report                                                                                                                                            |
| LX-20  | edit    |                     | Replace the stale "Why" (all six SDKs implement `commerce.receipt`). Scope: holder bindings, the `transferred` restore result, automatic `commerce.sync()` on sign-in and launch, `purchase(offerId)` once CM-20's wire lands                                                                           |
| LX-23  | edit    |                     | **Required** (drop `optional`). Owns the unified `dist_subscriptions` for store sources (Apple auto-renewables, Play subscriptions) and the dunning machinery. Its plan joins CM-20's wire plan                                                                                                         |
| LX-25  | keep    |                     | Optional; CM-10 stays dependent                                                                                                                                                                                                                                                                         |
| ST-12  | edit    | CM-23               | Drop "commerce settings and store-product mapping". Keep the trust policy, auto-issue and store-credential editors. Remove `table:dist_store_products` and `column:dist_store_products.source` from its PENDING list (CM-23 registers them)                                                             |
| ST-27  | edit    |                     | Name the commerce alert kinds: notifications failing, unmapped purchase, identity mismatch, refund spike                                                                                                                                                                                                |
| I-14   | edit    | CM-24               | Remove "optional Steam `CheckAppOwnership` grants through a Core hook". Ownership is CM-24's single engine, which I-14's Steam link triggers                                                                                                                                                            |
| A-18k  | edit    |                     | Add commerce live checks: ASSN set, verify and test round trip; Play RTDN test; group-scoped Steam key `CheckAppOwnership`; MS Store collections read [U]                                                                                                                                               |
| PS-05  | keep    |                     | Merged on main (`464c6780d`). Set `done`                                                                                                                                                                                                                                                                |
| PS-06  | keep    |                     | Merged (`0226e2824`). Set `done`. The panel re-homes into the channel page shell later (UX-54)                                                                                                                                                                                                          |
| PS-05b | keep    |                     |                                                                                                                                                                                                                                                                                                         |
| PS-07  | merge   | CM-24               | `store_owned` becomes one trigger of the linked-account ownership engine                                                                                                                                                                                                                                |
| PS-08  | keep    |                     | Optional                                                                                                                                                                                                                                                                                                |
| PS-09  | merge   | licensing auto-mint | `email_domain` is a third auto-mint rule. It belongs in the licensing audit's one mint policy (everyone, groups, email domains, none). The storefront reads the same policy                                                                                                                             |
| PS-11  | edit    |                     | Also retire the `listed` and `offerPaths` readers after PS-12; docs use the Offer and Storefront vocabulary                                                                                                                                                                                             |
| CM-01  | edit    |                     | Reduced plan: takes CM-20's model as given (offers, ledger read model, subscriptions table). Settings are the 4 keys of §6. W2 already decided in CM-20; plans W1, W3 and the Stripe tables only. **Ask the owner for "commerce: go"** on v1 = CM-01 to CM-06, CM-08, CM-11, CM-12, CM-14, CM-15, CM-17 |
| CM-02  | keep    |                     |                                                                                                                                                                                                                                                                                                         |
| CM-03  | edit    |                     | Stripe as a Platform → Store connections card plus the merchant on the Polaris Key storefront's Sales tab. Drop the `commerce.enabled`, `commerce.mode` and `merchantCountries` keys (facts or Stripe-enforced)                                                                                         |
| CM-04  | edit    |                     | Shrinks to Polaris Key **prices** (SKUs) and the Stripe Product and Price sync on LX-11's offers. Absorbs CM-16's priced obtain paths. Coupon tables only if CM-09 is kept                                                                                                                              |
| CM-05  | keep    |                     | Fulfilment writes purchases visible in CM-22's read model                                                                                                                                                                                                                                               |
| CM-06  | edit    |                     | Stripe refunds and disputes call CM-22's `revokePurchase`. Drops the `partialRevokes` and `disputes.onOpen` settings. Absorbs CM-13's refund and ended emails                                                                                                                                           |
| CM-07  | keep    |                     | After v1                                                                                                                                                                                                                                                                                                |
| CM-08  | edit    |                     | Adds Stripe as a source on LX-23's subscription ledger. Absorbs CM-13's renewal and dunning emails. Drops `renewalBufferHours`, `trials.requirePaymentMethod` and `upgrades.proration` (constants or offer fields)                                                                                      |
| CM-09  | reorder |                     | Coupons after CM-17 (post-v1)                                                                                                                                                                                                                                                                           |
| CM-10  | reorder |                     | Gifting after CM-17 (needs optional LX-25)                                                                                                                                                                                                                                                              |
| CM-11  | edit    | CM-26               | Builds on Account → Purchases (CM-26): adds Polaris Key orders, invoices and cancel or resume. No separate "Billing" section                                                                                                                                                                            |
| CM-12  | edit    | CM-23               | The store-commerce console is CM-23 (required now). CM-12 keeps merchant status, Polaris Key prices, Stripe refund and re-fulfil, revenue, and the platform webhook health                                                                                                                              |
| CM-13  | merge   | CM-06               | Emails ride with the events: refund and ended in CM-06, renewal and dunning in CM-08, fulfilment in CM-05                                                                                                                                                                                               |
| CM-14  | edit    | CM-20               | W2 (`offers[]`) moves into CM-20's single wire plan (store and Polaris Key offers together). W4 is already in LX-08's trigger and LX-18's enum. CM-14 keeps W1 and W3                                                                                                                                   |
| CM-15  | edit    |                     | `purchase(offerId)` and `offers()` land with LX-20 for stores. CM-15 adds only the Polaris Key checkout hand-off and `manageBilling()`                                                                                                                                                                  |
| CM-16  | merge   | CM-04               | Priced paths on Discover and the storefront page go to CM-04 (engine) and CM-11 (page)                                                                                                                                                                                                                  |
| CM-17  | keep    |                     |                                                                                                                                                                                                                                                                                                         |
| CM-18  | keep    |                     | Deferred (G6)                                                                                                                                                                                                                                                                                           |
| CM-19  | keep    |                     | Deferred (G5)                                                                                                                                                                                                                                                                                           |
| UK-25  | edit    |                     | The StoreKit paywall maps products through offers (`offers()`), not raw product ids                                                                                                                                                                                                                     |
| UX-52  | edit    |                     | (EXPERIENCE Wave 5) The catalogue entry gains a `storefront` part: verification credential slot, notification kind, SKU kind, the human and auto lists for the Sales wizard                                                                                                                             |
| UX-53  | edit    |                     | The read model computes the storefront state machine (§5.3) beside the channel state                                                                                                                                                                                                                    |
| UX-57  | edit    | CM-23               | Its "Commerce" tab is CM-23's **Sales** tab. UX-57 keeps Status, Releases, Listing and Setup                                                                                                                                                                                                            |

---

## 10. New work packages

| proposedId | title                                                                                                              | scope                                                                                                                                                                                                                                                                                                                                                                           | deps                                     | plan mode | weeks   |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------- | ------- |
| CM-20      | Commerce consolidation plan: Offer, SKU, Purchase, Subscription; derived identity; one wire event                  | `plans/CM-20.md` (also LX-11's plan): vocabulary, exact DDL (§5.2), offers backfill, purchases read model, `revokePurchase` contract, settings collapse (§6), storefront state machine, console IA, migration report rules, and the additive wire (`offers[]`, `app` claim kind, `transferred`) with transcripts and SDK order. THREAT-MODEL deltas (test-purchase unification) | LX-08, LX-01                             | yes       | 0.6–0.9 |
| CM-21      | Storefront connection: derived store identity, automatic activation, notifications setup, one test-purchase switch | Read identity from pins; attention on mismatch; the state machine in the storefronts read model; assignment makes `ready`; ASSN set, verify and test, and the RTDN verifier as wizard rows; `commerce.acceptTestPurchases` with migration report; push-audience default                                                                                                         | CM-20, A-18j                             | no        | 0.8–1.2 |
| CM-22      | Purchases ledger and one revocation path                                                                           | The read model over `dist_purchases` (and later `dist_orders`); `revokePurchase` for every source; admin reads `GET …/commerce/purchases[/<id>]`; re-verify action; developer webhook `purchase.refunded`; Steam age-based re-check (daily under 14 days)                                                                                                                       | LX-11, LX-12                             | no        | 0.8–1.2 |
| CM-23      | Console commerce: Offers, Purchases and the channel Sales tab                                                      | Commerce sidebar group (NavRequirement `commerce`); Offers editor with SKU chips, import and suggest, create on App Store or Play, catalog validation, 3.1.3(b) warning; Purchases and Subscriptions views; the Sales tab with the storefront wizard; today's IAP dialogs moved; retire Distribution → Commerce with redirects; ADMIN.md amendment                              | CM-21, CM-22, LX-11, UX-54               | no        | 1.4–2.0 |
| CM-24      | Linked-account purchase sync (Steam): one ownership engine                                                         | `delivery().storeOwnership()` backs PS-07's `store_owned` path, I-14's sign-in trigger and a scheduled sync for linked Steam ids, under one cache and budget; grants via LX-11's store-identity holder; base app and DLC                                                                                                                                                        | LX-11, I-06                              | no        | 0.7–1.1 |
| CM-25      | App purchase as a licence source                                                                                   | SKU kind `app`: App Store AppTransaction JWS (the existing x509 chain), Play `appLicensingVerdict` (recorded by P6-02), Steam base app ownership. Mints the base licence on the holder (account, or store identity); a first run on a store build needs no key; refund ends the licence. Widen `device_store_identities` stores                                                 | CM-20, LX-11, LX-10                      | yes       | 1.0–1.5 |
| CM-26      | Portal Account → Purchases across storefronts                                                                      | Every purchase and subscription with source, state and Manage deep links (App Store, Play; Stripe later via CM-11); refunded shown; PORTAL.md amendment; works with Polaris Key checkout off                                                                                                                                                                                    | CM-22, LX-15                             | no        | 0.6–0.9 |
| CM-27      | Spike: store purchase parity (Microsoft Store, itch.io, consumables)                                               | Research only, every fact tagged: Microsoft Store collections and purchase API with Entra; itch.io download-key and owned-keys lookups; Apple consumable history and Play `consume`; EOS ecom. Decides CM-28's scope and the MS and itch follow-ups                                                                                                                             | none                                     | no        | 0.3–0.5 |
| CM-28      | Consumables and quantity grants from store purchases                                                               | Verify consumable transactions (Apple, Play), grant quantities on licensing's counted entitlements with redemption state, idempotent per transaction, refunds reduce the quantity; SDK finish and consume after the claim                                                                                                                                                       | CM-27, CM-22, licensing quantity package | yes       | 0.8–1.2 |
| PS-12      | Discover visibility: one setting                                                                                   | `storefront.polarisKey.visibility` (`unlisted \| eligible \| everyone`) replaces `listed`, `audience` and `offerPaths`; group labels move to the group-mapping rows; backfill and report; PolarisKeyPanel simplified                                                                                                                                                            | PS-06                                    | no        | 0.3–0.5 |

**Sequencing.**

1. Now: quick wins, CM-27, and CM-20 once LX-08 merges.
2. Then LX-09 and LX-10, LX-11 (executing CM-20), LX-12, CM-21 (parallel to LX-11).
3. Then CM-22, LX-23, CM-24.
4. Then CM-23 (with UX-54/57), CM-25, CM-26, PS-12.
5. Then CM-28.
6. Polaris Key checkout (CM-01 onward) after the owner's go, on top of the shared model.

---

## 11. Quick wins

1. **Validate mappings against the catalog**: `commerce/admin.ts:204` refuses (or warns on) a
   `flag` the catalog does not declare. This removes silent no-op mappings.
2. **Fix the Commerce page dead end**: `CommercePage.tsx:307-315`'s empty state gets an inline
   "Map a product" form (store, product id, flag) on the existing `PUT …/commerce/products` until
   CM-23 lands.
3. **Show why a store is off**: the admin view already computes `setupOf` reasons
   (`commerce/admin.ts:55-80`). Render them as a read-only "Selling on the App Store" card on the
   App Store page and the Credentials page instead of the warning in help text.
4. **Steam refund latency**: change `STEAM_RECHECK_SECONDS` (`recheck.ts:34`) to age-based, daily
   for purchases under 14 days.
5. **Default the Play push audience** to the hook URL when neither the product nor the platform
   sets one (`commerce/play.ts:325-345`). The docs already recommend that value.
6. **Make `deliverable` optional** in the mapping UI and API docs (it already defaults to `app`,
   `admin.ts:214`).
7. **Backlog hygiene**:
   - PS-05 and PS-06 → `done`;
   - LX-11 title without `dist_commerce_settings`;
   - LX-20 "Why" corrected;
   - reconcile EXPERIENCE.md §159 with SETUP.md §2.2.
8. **Docs**: lead `services/distribution/commerce.md` with the console path once (2) and (3) land,
   and add the 3.1.3(b) rule to the Offers copy.

---

## 12. Cross-domain dependencies

| Domain                    | Dependency or conflict                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Distribution and channels | The "Channel" vs "Storefront" UI naming, and the collision with release channels (§5.1). The channel page shell (UX-54, UX-57) hosts the Sales tab. The catalogue declaration (UX-52) gains a storefront part. Scope (`productPlatforms`) gates storefronts. SETUP D1 and D23 amendments                                                   |
| Licensing (S-19, LX)      | Offers reference tiers and add-on (sub-licence) definitions. LX-11's plan is CM-20. Quantity and redemption for consumables (CM-28). Term models and perpetual fallback driven by subscriptions. A "renew until" admin and developer API so subscription licences work with Commerce off. The auto-mint policy absorbs PS-09. LX-12 states |
| Identity (S-16, I)        | Steam link (I-06) triggers CM-24; I-14 loses its ownership hook; account merges move purchases and bindings (LX-13); `device_store_identities` widened (CM-25); Apple and Google sign-in links do not imply store purchases (copy)                                                                                                         |
| Settings (S-18, ST)       | Registry rows for the 4 commerce keys and PS-12's visibility; ST-12's scope cut; the ST-08 hub area `commerce`; ST-21 capabilities `commerce.read/write/refund/merchant`; settings-coverage PENDING moves                                                                                                                                  |
| Admin and RBAC            | The Commerce sidebar group; Platform → Store connections gains Payments (Stripe); the owner's "a group gives access to an app's storefront settings" maps to the commerce capabilities; Platform vs Product sidebar switching                                                                                                              |
| Portal                    | Account → Purchases (CM-26) replaces a separate Billing section; license-source labels (PX-W6); the storefront page Buy and "Also on" links                                                                                                                                                                                                |
| Products and onboarding   | The Integration section's Commerce card and its "first verified purchase" done signal; the new-product wizard's platforms set storefront scope                                                                                                                                                                                             |
| SDKs and UI kits          | One wire plan (CM-20): `offers[]`, the `app` claim, `transferred`. `purchase(offerId)` and `sync()` in six SDKs (LX-20, CM-15). UK-25 paywall on offers. Godot `hidden_here` needs every store's SKUs, so binding responses must not be filtered by outlet                                                                                 |
| Security                  | THREAT-MODEL commerce section: test-purchase unification (a widening), derived identity (pin as source of truth), offers backfill, app-purchase licences (new grant source path), purchases read access (PII: holder email in console search)                                                                                              |
| Release                   | Version-bound licences (perpetual fallback) need the last version released while a subscription was active                                                                                                                                                                                                                                 |
| Notifications and alerts  | ST-27 destinations and UX-12 attention kinds for commerce                                                                                                                                                                                                                                                                                  |

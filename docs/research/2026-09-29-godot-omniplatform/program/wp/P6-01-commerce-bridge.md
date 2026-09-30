# P6-01 Commerce bridge: store purchases become licence entitlements per deliverable

| Field       | Value                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                                                                                                                                                                                   |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                                                                                                                       |
| Depends on  | [P5-02](P5-02-asc-connector.md), [P5-03](P5-03-play-connector.md)                                                                                                                                                                                                                                                                        |
| Unblocks    | [D-05](D-05-diceroll-after-p6.md)                                                                                                                                                                                                                                                                                                        |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                       |
| Plan mode   | no (the licence document's shape does not change; stop and escalate if it would)                                                                                                                                                                                                                                                         |
| Gates       | threat model; rule 10 (hook and claim routes: OpenAPI, `routeCoverage`, routes page); D1 migrations + `TABLE_OWNERS`; `test:workerd` (the X.509 code must run in workerd); `parity.json`                                                                                                                                                 |
| Human input | App Store Server Notifications V2 URL set in App Store Connect, and an In-App Purchase key (not the ASC API key); Play RTDN: a Pub/Sub topic and an authenticated push subscription to the hook (push service-account email, audience); a Steam Web API publisher key; the store products themselves; sandbox or test accounts per store |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                |

## Goal

A player who buys a store product mapped to a licence `flag` (for example the product that unlocks
`diceroll.supporter.skins`, entitlement `extras.diceSkins`) in the App Store, Google Play or Steam
gets that flag on their Polaris licence, for every release of the deliverable, and loses it on
refund or revocation. Every purchase is verified server-side with the store; the device only
forwards what the store handed it. The Godot SDK can fetch the purchase binding and claim a
purchase.

## Why

- Store builds must sell digital unlocks through the store: App Store 3.1.1, Play Payments, Steam
  DLC and microtransactions ([§3.10](../../README.md#310-commerce-and-entitlements),
  [§0.4](../../README.md#04-findings-that-should-change-plans-now) item 6).
- Packs can name a licence `flag` that distribution enforces at delivery (README §3.7,
  "Entitlements"); entitlements are per deliverable, not per version, and the bridge maps a store
  product to the deliverable ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 9).
- Decision 8 in [§11](../../README.md#11-decisions-needed): the bridge comes after content.

## Read first

- `AGENTS.md`; P5-01 (`openOutletCredential`, `signJwtEs256`), P5-02 and P5-03 hand-offs (the Play
  client is reused here).
- [S-07](S-07-policy-recheck.md) rows 8, 9 and 15 (Play fee programmes, Billing Library, Steam
  commerce), if it has run.
- notes/E1 §F1–§F3 (App Store Server API, Notifications V2, the 23 types, `x5c` chains,
  `appAccountToken`), notes/E2 §E4 (server verification, acknowledgement within 3 days, RTDN over
  Pub/Sub push with an OIDC JWT), notes/E3 §B3 (Steam DLC and ownership).
- `packages/worker/src/core/payload.ts:111-141` (`resolveMergedPayload` layer order),
  `src/core/entitledAccess.ts`, `src/core/registry.ts:100-134` (descriptor hooks;
  `authorizeRegistration` is the precedent), `src/repo.ts:61-84` (`LicenseRow`, `origin`).
- `src/services/identity/oidc.ts:1040-1045` (`jose` `createRemoteJWKSet` + `jwtVerify`; `jose` is
  already a Worker dependency).
- [PARITY §5.7](../../PARITY.md#57-ui-and-commerce) (`commerce.receipt`).

## Scope

**In:**

- **Where it lives** (proposed; confirm in the PR): store-facing code in
  `services/distribution/commerce/`, because the store credentials and connectors are
  distribution's; the effect on licences through a new Core-declared descriptor hook,
  `applyStoreGrant`, implemented by License, on the `authorizeRegistration` pattern. Add the
  coherence rule "commerce needs License enabled".
- **Tables** (all in `TABLE_OWNERS`; `dist_store_products` is operator-owned and set through
  distribution's admin API; `license_store_grants` is owned by License):

  ```sql
  dist_store_products(product, store, store_product_id, deliverable_id, flag, source)
  dist_purchase_bindings(product, binding_id, license_id)
  dist_purchases(product, store, purchase_key_hash, store_product_id, license_id, state,
                 environment, first_seen, last_verified, detail_json)
  license_store_grants(product, license_id, flag, store, purchase_key_hash, state,
                       granted_at, revoked_at)
  ```

- **Grant layer:** `resolveMergedPayload` adds active store grants after the licence profiles and
  before `license.overrides_json`, so an operator's override still wins. Flags already exist in the
  signed licence document, so its shape and `PROTOCOL_VERSION` do not change.
- **Routes** (names proposed, rule 10):
  - `GET /{product}/distribution/commerce/binding` (device token): the licence's opaque binding
    UUID, used as Apple `appAccountToken` and Play `obfuscatedAccountId`;
  - `POST /{product}/distribution/commerce/claim` (device token), with one of
    `{store: "app-store", signedTransaction}`, `{store: "play", productId, purchaseToken}` or
    `{store: "steam", ticket, dlcAppId}`;
  - `POST /{product}/distribution/hooks/app-store` (Notifications V2);
  - `POST /{product}/distribution/hooks/play-rtdn` (Pub/Sub push).
- **Apple:** verify `signedPayload` and `signedTransactionInfo` (ES256 JWS) with their `x5c` chain
  to a pinned Apple Root CA - G3, Apple's leaf and intermediate OIDs, `bundleId` and environment;
  act on `ONE_TIME_CHARGE`, `REFUND`, `REVOKE`, `REFUND_REVERSED`, `TEST`; store the rest raw.
  Confirm a claimed transaction with the App Store Server API (`https://api.storekit.apple.com`,
  sandbox `https://api.storekit-sandbox.apple.com`) using a new outlet-credential kind
  `app-store-server-key` (ES256, `iss`, `aud: "appstoreconnect-v1"`, `bid`, ≤ 60 min).
- **Play:** verify the push JWT (Google JWKS, issuer `https://accounts.google.com`, the configured
  audience, `email` equal to the push service account, `email_verified`), decode `message.data`,
  then always read `purchases.products.get` through P5-03's client: grant only `PURCHASED`, never
  `PENDING`; match `obfuscatedExternalAccountId` to a binding; acknowledge once, within 3 days;
  revoke on `voidedPurchaseNotification`, with a daily Voided Purchases poll as a backstop.
- **Steam:** `ISteamUserAuth/AuthenticateUserTicket` then `ISteamUser/CheckAppOwnership` for the
  DLC app, with a new kind `steam-publisher-key`; re-check on each claim and weekly (Steam does not
  push refunds).
- **Shared X.509 chain verifier** in `src/core/x509.ts` (P6-02 needs it too; whichever lands first
  writes it).
- **Godot SDK:** `PolarisKey.commerce.get_binding()` and
  `PolarisKey.commerce.claim(store, payload)`, taking P5-05's StoreKit JWS,
  `godot-google-play-billing`'s purchase token, or GodotSteam's web-API ticket; the Godot
  `parity.json` row `commerce.receipt` → `implemented`.
- Threat model and operator docs (store product mapping, notification setup per store).

**Out** (and where it belongs instead):

- Microsoft Store add-ons and in-product purchases (policy 10.8.1): no work package owns them.
- Subscriptions and consumables; external offers and alternative billing reporting (notes/E2 §E4
  advises against it for v1).
- `commerce.receipt` in the Node, Python, Swift and React SDKs: left `planned`; no work package owns
  them yet.
- A console view for store products and purchases (admin API only here).
- Paid-to-free migration with `AppTransaction.originalAppVersion` (optional, not owned).

## Design notes

- **Bind before buying.** The binding UUID is not the licence id and is not PII. A transaction bound
  to one licence's binding can never grant another licence; a claim whose binding does not match
  the caller's licence is refused.
- **Devices without a licence.** The claim needs a licence to grant to. If the device has none, it
  answers a typed error and the SDK enrols (auto-issue) first; the bridge never creates licences
  itself.
- **Cross-store rule.** App Store 3.1.3(b): a grant bought elsewhere unlocks on an Apple outlet only
  if the same flag is also sold as an Apple in-app purchase. Enforce it at distribution's gated
  delivery for the requesting outlet, and document that the licence document stays
  outlet-agnostic (the SDK's outlet adapter hides store-foreign unlocks where the outlet's
  `commerce` capability is `store-iap`).
- **Notifications are hints; the store API is truth**, exactly as for the ASC connector. Dedupe on
  `notificationUUID` and on the purchase key hash; reject sandbox transactions in production.
- **No Workers-native App Store Server Library** exists (notes/E1 §F1). Port its checks; any
  X.509 or CBOR dependency must pass `test:workerd`, which forbids runtime code generation.
- **What can be built before a human supplies anything:** everything, against a test certificate
  chain generated in the tests (pinned root overridable in tests only), recorded Play responses, a
  fake Pub/Sub JWT issuer and a fake Steam API. One real sandbox purchase per store is a device
  checklist item once the accounts exist.

## Steps

1. Migrations, `TABLE_OWNERS`, the `applyStoreGrant` hook and the grant layer, with tests that a
   grant appears in the next licence document and an override still wins.
2. Binding and claim routes; OpenAPI and `routeCoverage`; routes page regenerated.
3. `core/x509.ts`; Apple verification, the Notifications hook and the Server API client.
4. Play hook and verification through P5-03's client; acknowledgement; voided purchases.
5. Steam claim and re-check.
6. Godot `commerce` sub-client and `parity.json`; threat model; operator docs.
7. Device checklist (human): one sandbox purchase per store grants and a refund revokes.

## Acceptance criteria

- [ ] Worker tests cover, per store: a valid purchase grants the mapped flag; a refund, revoke or
      void removes it; a replayed notification changes nothing; a wrong `bundleId`, a sandbox
      transaction in production, a broken chain or a wrong OID is rejected; a Play `PENDING`
      purchase does not grant; acknowledgement is sent exactly once; a Steam non-owner gets nothing.
- [ ] A claim carrying another licence's binding is refused.
- [ ] The next licence document for the buyer carries the flag; an operator override of the same
      flag wins over the store grant.
- [ ] OpenAPI and `routeCoverage` include the four routes; the routes and data-model pages are
      regenerated and `gen:check` passes.
- [ ] The threat model covers forged notifications, replay, cross-licence claims and sandbox leaks.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- commerce routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- Store grants as licence flags, visible to `entitledAccess` and to distribution's gated delivery;
  the `applyStoreGrant` hook; `core/x509.ts` for P6-02.
- `PolarisKey.commerce` in Godot, which D-05 uses for Diceroll's paid packs.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-01 done`.

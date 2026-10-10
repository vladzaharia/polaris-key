# Audit: entitlements, sub-licences, quantities, subscriptions and version-bounded licences

> DX consolidation audit, 2026-10-07. Domain: entitlements (how they are declared, set, combined and
> delivered), sub-licences (IAPs, DLC, feature packs), quantities and in-app redemption, platform
> entitlements (update channels, Cloud Sync, feature enablement), subscriptions (Polaris Key and
> third-party stores), expiry, renewal, perpetual fallback and version-bounded licences.
>
> **Tree read:** `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5). **In-flight branches
> read:** `wp/LX-08-licensing-expand` (`/Users/vlad/Repos/pk-wt/LX-08`, in review, migrations
> `0105_a`–`0105_m`), `wp/HA-12-presentation-discovery`, `wp/UK-13-python-terminal`,
> `wp/UK-14-node-terminal` (the last three do not touch this domain beyond rendering entitlement
> rows). **Sources:** the owner brief, `notes/S-19-licensing-model.md`, `plans/LX-01.md`,
> `notes/S-22-polaris-key-commerce.md`, `plans/U-01.md`, `plans/I-24.md`, briefs LX-01…LX-31, CM-01…CM-19,
> UK-25, I-24a/b, D-05; `docs/design/{ADMIN,PORTAL,SETUP,EXPERIENCE}.md`;
> `docs/security/WIRE-CONTRACT-V4.md`; the Worker, admin console, portal and shared packages. Paths
> below are relative to the tree unless they name the LX-08 branch. `W/` = `packages/worker/src/`,
> `P/` = `docs/research/2026-09-29-godot-omniplatform/program/`, `N/` =
> `docs/research/2026-09-29-godot-omniplatform/notes/`.
>
> Nothing in this audit changes the signed documents unless it says **WIRE** in bold. Every **WIRE**
> item is routed into one plan-mode event (the "licensing train", §Target design T11).

---

## Summary

The licensing program already fixed the hardest question. S-19's model OC (a licence is an access
contract, a grant is one reason to hold entitlements, one anchor licence per device, entitlements
combined over the device's contributors) is sound. LX-08 (in review) adds the storage, and LX-09
adds the resolver. That model is the right base for everything the owner asks for. We keep it.

Three gaps remain, and the owner's brief lands on all three:

1. **There is no definition of "what someone gets".** A tier gets its entitlements only through a
   **config profile**. A store purchase gets them from `dist_store_products.flag`, and soon from
   `dist_store_product_entitlements`. A sign-in claim gets them from `provisioning_config`. A
   checkout offer gets them from `dist_offers.grants_json`, and a redeem code from LX-25's own model.
   A comp gets them from whatever keys the operator types. The owner's "sub-licence" (IAP, DLC,
   feature pack) has no object of its own. Every source redefines it.
2. **A licence has no term model.** It has one `expires_at`, and past it the licence is dead
   everywhere (`W/core/devices.ts:196-203`). Subscriptions, renewals, dunning and the JetBrains
   perpetual fallback exist only as deferred commerce packages (LX-23, CM-08). The portal already
   promises fallback semantics the Worker does not implement: "Updates included: Until …" and "To
   get newer versions, renew…" (`packages/admin/src/portal/components/product/LicenseCard.tsx:154-158,178`).
3. **Version-bounded licences break under the planned combine rule.** LX-01 §2.3 combines
   `app.minVersion`/`app.maxVersion` across licences as the "widest window". A person holding a 1.x
   lifetime licence and a 3.x licence would get [1.0, ∞), which includes 2.x. Anchor choice also
   ignores the running build.

**The single most important change:** make **tiers and add-ons the only two templates of what
someone gets**. A tier yields a licence, an add-on yields a grant, and each has a term. Route every
source through them: store, checkout, code, comp, sign-in claim, Discover and auto-issue. One new
term field, `onExpiry: stop | keepVersion`, plus a source-neutral Core `subscriptions` table gives
three things: subscriptions without commerce, JetBrains-style perpetual fallback, and "1.x forever,
2.x subscription, 3.x expiry plus perpetual". None of these needs a signed-document change, because
`app.maxVersion` is already an enforced entitlement that every gate honours
(`docs/security/WIRE-CONTRACT-V4.md:103,648`).

The audit also cuts the licensing surface:

- Licensing settings drop from 7 to 3.
- The per-flag `combine` and `entitlementKind` fields become a single `kind`, with 3 values.
- The licence kinds `base` and `addon` become `base` only.
- The three console places that show what a licence includes become one.
- The four planned all-SDK wire events become two trains.

---

## Current state (with file references)

### 1. How a device's entitlements are computed today

- **The layer cake** is in `W/core/payload.ts:153-196` (`resolveMergedPayload`):
  1. catalog defaults (config only; flags are skipped, `:79-95`);
  2. the tier's profile (`:168-171`);
  3. the licence's profiles, in order (`:175-178`);
  4. the store-grant layer (`:183`, `W/core/storeGrants.ts:95-119`: every active flag
     `{state:"default", value:true}`);
  5. the licence overrides (`:184-188`);
  6. the account overrides (U-03, config and secrets only, `:193`);
  7. the device overrides (`:195`).

  On the LX-08 branch an `oidc` grant layer follows the licence overrides
  (`LX-08:W/core/grants.ts`, header "WHY THE OIDC LAYER SITS AFTER THE LICENCE OVERRIDES").

- **Policy injection** happens after the merge (`W/core/entitlements.ts:182-234`,
  `injectAdminPolicy`). It writes `license.tier` and `license.tierLabel`; `channels` as the union of
  the tier and licence columns; `deviceLimit` as the licence's own limit, else the tier's (LX-14a);
  and `app.minVersion` and `app.maxVersion`. All of these are `enforced`.
- **The version window is an intersection of tier and licence, not a widening.** Every caller
  passes `tighterMin`/`tighterMax` (`W/core/authz.ts:150`, `W/core/entitledAccess.ts:184,373,414`,
  `W/core/syncAccess.ts:77`). A licence can narrow its tier's window but never widen it.
  `packages/shared-manifest/src/reservedNames.ts:65,70` documents the opposite ("the lower of …",
  "the higher of …"), and so does S-19 §4.2. Both are wrong.
- **Usability is binary.** `licenseUsable` is false when the licence is disabled or past
  `expires_at` (`W/core/devices.ts:196-203`). The document route then answers 401
  (`W/services/license/document.ts:113`). The `entitled` delivery checks and the portal downloads
  refuse the same way (`W/core/entitledAccess.ts:213-231`,
  `W/services/identity/portal/api.ts:397-421`).
- **The envelope `expiresAt` is a one-hour document TTL**, not the licence term
  (`W/core/documents.ts`, `buildLicenseDoc`). Offline grace is clamped to the licence expiry by
  LX-07 (`W/core/graceClamp.ts:112-124`; in review).
- **The build gate is server-side.** The server answers `403 version_blocked`/`channel_not_allowed`
  on `/license/document` from `X-PKey-Version` and `X-PKey-Channel`
  (`docs/security/WIRE-CONTRACT-V4.md:648`). The `entitled` feed and download gates filter by the
  same window.

### 2. Where entitlements are declared and set today

| #   | Place                                                                            | What it holds                                                                                                                            | Where                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Catalog `kind: "flag"` entries (`.pkey/schema`)                                  | the declaration: key, JSON schema, `userGrant`, `grantLabel`                                                                             | `packages/shared-catalog/src/types.ts:9,36-75`                                                                                                            |
| 2   | Reserved system keys                                                             | `channels`, `deviceLimit`, `app.minVersion`, `app.maxVersion`, `license.tier`, `license.tierLabel`; prefixes `license.`, `app.`, `pkey.` | `packages/shared-manifest/src/reservedNames.ts:47-80`; I-24a adds `license.maxUsers` and `license.devicesPerUser`                                         |
| 3   | Tier columns                                                                     | channels, version window, device limit, expiry days; no entitlement values                                                               | `0001_init.sql`, `0002_channels.sql:9-11`; console `packages/admin/src/console/pages/license/TierForm.tsx:26-35`                                          |
| 4   | **Config profiles** (`profiles.payload_json.entitlements`)                       | the **only** way a tier carries feature entitlements (through `tiers.profile_id`); licence profile stacks too                            | `W/core/payload.ts:168-178`; ADMIN.md §6.6.3                                                                                                              |
| 5   | Licence overrides (`licenses.overrides_json.entitlements`)                       | per-licence entitlement overrides (S-17 D20 kept them on the licence)                                                                    | console tab **"Config overrides"** (`LicenseRecord.tsx:387`, `LicenseConfig.tsx` header: since U-03 it edits entitlements only)                           |
| 6   | Device overrides                                                                 | support overrides                                                                                                                        | `W/core/payload.ts:195`                                                                                                                                   |
| 7   | Store grants                                                                     | `license_store_grants (flag, store, purchase_key_hash)`; a store product maps to **one** flag                                            | `0052_commerce.sql`; `W/core/storeGrants.ts`; `W/services/distribution/commerce/admin.ts:1-25`                                                            |
| 8   | OIDC provisioning                                                                | claim → entitlement key/value (or a secret); group → tier                                                                                | `provisioning_config`; `products/djdl/product.json` (`provisioning`, `oidc.groupRoleMap`)                                                                 |
| 9   | Planned: LX-08 store-product entitlements, S-22 offers, LX-25 codes, LX-13 comps | a store product → N keys; an offer → `{tierId}` or `{entitlements:[…]}` or `{deviceLimit}`; a code → grant; a comp → keys                | `LX-08:packages/worker/migrations/0105_l_licensing_commerce.sql`; `N/S-22-polaris-key-commerce.md:420-430` (`dist_offers.grants_json`); `P/wp/LX-25-*.md` |
| 10  | Cloud Sync limits                                                                | `cloudSync.limits.byTier` (a second tier map) and `.byEntitlement` (an indirection to developer flags)                                   | `P/plans/U-01.md:323`; settings `cloudSync.limits.*` in `packages/admin/src/console/settings.generated.ts`                                                |
| 11  | Deliverable access                                                               | `dist_access.entitlement` names one flag that gates a deliverable                                                                        | `0038_distribution_rollouts_access.sql`                                                                                                                   |

### 3. Store grants and commerce

- The P6-01 bridge (`W/services/distribution/commerce/`) binds before buying, claims and verifies
  with the store's API. It grants **non-consumables only; consumables and subscriptions are out of
  scope** (`commerce/apple.ts:21`). The Play path acknowledges a purchase within three days
  (`commerce/play.ts`). The Steam path re-checks ownership weekly (`commerce/steam.ts`).
- Mappings are operator-only, never manifest (`commerce/settings.ts:1-20`). "Commerce needs
  License": a write is refused while License is off (`commerce/admin.ts:20-24`).
- Distribution → Commerce in the console lists App Store products and creates non-consumable IAPs
  from mappings (A-17e and A-17g, `packages/admin/src/console/areas/distribution/CommercePage.tsx:1-20`).
- **On the LX-08 branch:**
  - five Core tables (`grants`, `grant_entitlements`, `device_store_identities`, `holder_versions`,
    `entitlement_events`) plus three Distribution tables (`0105_a`, `0105_l`);
  - licence `kind`, `ended_reason`, `superseded_by`, `source` and `external_ref_hash`;
  - tier `rank` and `policy_offline_grace_days`;
  - `dist_store_products.grants_kind` and `base_tier_id`;
  - dual-write of store grants, and provisioned keys moved into `grt_oidc_<licence>`.

  Grant sources are `app-store play steam polaris-key comp trial bundle redeem oidc`, and states
  are `active past_due revoked refunded suppressed` (`0105_a_licensing_core.sql`, triggers).
  `holder_versions.holder_kind` is `CHECK IN ('account','license','store')` (`0105_a:123`).

### 4. Terms, versions and channels today

- **Expiry:**
  - `licenses.expires_at` is set at creation from `tiers.policy_expiry_days`. NULL means lifetime.
  - No renewal source exists, and no state besides `active`/`disabled`. LX-08 adds `ended_reason`.
- **Version windows:**
  - Tier and licence `min_version`/`max_version` (`0002_channels.sql`) become the enforced
    `app.*` entitlements.
  - The portal already renders "Covers versions" (`LicenseCard.tsx`, `coversVersions`) and
    "Updates ended at 1.8" for a window that ends before the newest release
    (`W/services/identity/portal/downloads.ts:82`, `packages/admin/src/portal/model/library.ts:575-602`;
    `docs/design/PORTAL.md:1223,1243`).
- **No perpetual fallback.** S-19 §7.6 (`N/S-19-licensing-model.md:800`) and S-22 §7.6
  (`N/S-22-…:612`) both defer it "as a grant that sets `app.maxVersion` on lapse". That cannot work
  under their own rules:
  - the licence is unusable after expiry, so no grant on it is ever read;
  - S-19's combine table widens `app.maxVersion` across contributors, so a grant could never narrow
    it.
- **Channels:**
  - `stable` is always granted. Tier and licence channels are unioned
    (`W/core/entitlements.ts:115-118,204-210`).
  - The ChannelPicker shows manual channels in the tier and licence forms.
- **Portal copy reads expiry as "updates end":**
  - "Updates included: Until 3 Mar 2027" (`LicenseCard.tsx:154-158,184`).
  - On expiry: "…To get newer versions, renew with <developer>" (`:178`).
  - The Worker refuses the licence outright at expiry. **The UI promises JetBrains semantics that
    the backend does not have.**

### 5. Licensing settings that exist (LX-06)

| Key                                                      | Values                                        | Behaviour shipped?                                                                |
| -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `licensing.entitlementModel` (`licensingSettings.ts:70`) | `legacy` \| `combined` (derived default)      | no (LX-09); `services/identity/passthrough/anchor.ts` returns `legacy` until then |
| `licensing.entitlementHolder` (`:98`)                    | `device` \| `owner`                           | no (LX-09)                                                                        |
| `licensing.clampGraceToExpiry` (`:121`)                  | bool                                          | yes (LX-07)                                                                       |
| `licensing.anchorPolicy` (`:145`)                        | `rank-first` \| `most-free-seats` \| `oldest` | no (LX-10)                                                                        |
| `licensing.reanchor` (`:166`)                            | `never` \| `onActivation`                     | no (LX-10, LX-21)                                                                 |
| `licensing.refundGraceHours` (`:188`)                    | 0–168                                         | no (LX-12)                                                                        |
| `licensing.dunningGraceDays` (`:214`)                    | 0–30                                          | no; hidden (LX-23)                                                                |
| `identity.oidc.syncTierOnSignIn`                         | `off` \| `upgradeOnly`                        | LX-08 branch                                                                      |
| `licensing.reservedNames` (platform)                     | `warn` \| `error`                             | yes (LX-05)                                                                       |

License → Settings (`packages/admin/src/console/pages/license/LicenseSettingsPage.tsx:1-10`) shows
six of these. Its own header says that, apart from the grace clamp, they "take effect as each part
of the licensing model arrives". So five visible controls do nothing today. The manifest's
`licensing:` block accepts all of them (`packages/shared-manifest/schemas/v1/product.schema.json`,
`licensing.properties`).

### 6. Console surfaces

- **License** (`packages/admin/src/console/pages/license.tsx`) has Licenses, the licence record,
  Tiers, the tier record, Enrollment, Settings and Batches.
- **Licence record tabs** today are Overview, Keys, Devices and **Config overrides**
  (`LicenseRecord.tsx:359-395`).
  - EXPERIENCE.md O1 plans Status · Entitlements · Grants · Keys · Config · Activity
    (`docs/design/EXPERIENCE.md:452`).
  - That gives three places for "what this licence includes": Entitlements, Grants, and Config
    (which edits entitlement overrides).
- **Tier form** fields are id, label, profile, `policyExpiryDays`, `policyDeviceLimit`, channels
  and min/max version (`TierForm.tsx:26-35`). There are no entitlements. A tier's features have to
  be authored in a config profile, under Config → Profiles.
- **Config → Catalog** (ADMIN.md §6.6) mixes `config`, `secret` and `flag` in one table. The
  catalog editor has no `combine` or `entitlementKind` yet (LX-14 adds them).
- **Distribution → Commerce** shows the App Store mappings (non-consumable).

### 7. Portal surfaces

- The LicenseCard shows a tier pill, a device count, "Updates included", "Covers versions",
  "Activated", "License source", offline days, channels, the key, and **Included**. Included lists
  the `userGrant` flags from the resolved document (`W/services/identity/portal/entitlements.ts`,
  LX-04).
- PORTAL.md §5.3 statuses run Suspended, Expired ("Updates ended at 1.8"), Device limit, Key not
  activated, Expires soon, Offline grace ended, From signing in, Active. The §1 note already uses
  "Lifetime", "Renews 3 Mar" and "Expires 24 Dec" (`docs/design/PORTAL.md:67`). The Worker has no
  "renews" concept.
- Purchase source: PX-W6 shows "the store's name only".

### 8. SDK surface

- All six SDKs have `isEntitled(name)` (true iff the value is boolean `true`), `getEntitlements`,
  `entitledChannels` and `getLicenseId` (S-19 §4.4).
- No SDK can say why, until when, from which store, whether a licence lapsed, or how many units are
  held.
- Only Godot can bind and claim store purchases (G17).
- LX-17 (done) proved that all six SDKs tolerate a `licenseId` change on a plain refresh
  (`P/wp/LX-17-sdk-licenseid-audit.md`, "Result").

### 9. What the planned program fixes, and what it leaves

| Planned                                        | Fixes                                                        | Leaves                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| LX-08/09 grants and resolver                   | holder roaming, refunds per grant, purchases not cancellable | definitions per source (§2 rows 7–9); a 7-value `combine` × 4-value `entitlementKind` per flag    |
| LX-10 anchor (`rank-first`, choice at sign-in) | which licence a signed-in device runs on                     | version-blind: a 2.x build can anchor on a 1.x-only licence                                       |
| LX-12 lifecycle                                | refund, chargeback, `ended_reason`                           | no term model                                                                                     |
| LX-18/19 wire                                  | `isEntitled` after 401, reasons, per-entry expiry            | three more all-SDK events still queued (I-24a/b, LX-25, CM-14/15)                                 |
| LX-23 (phase D, optional) and CM-08 (deferred) | store and Stripe subscriptions                               | **nothing without commerce**; `dist_subscriptions` is commerce-owned (`N/S-22-…:464`)             |
| LX-24, LX-25 (phase D)                         | per-seat features, codes                                     | codes define their own targets; `addon` licences                                                  |
| S-19 §10.2                                     | n/a                                                          | consumables and quantities "reserved, not designed" (`N/S-19-…:1204`); perpetual fallback "defer" |

---

## Problems (ranked)

1. **HIGH: The portal promises perpetual fallback; the Worker ends the licence.**
   - Evidence: `LicenseCard.tsx:154-158,178,184` ("Updates included: Until …", "To get newer
     versions, renew"), set against `W/core/devices.ts:196-203` and
     `W/services/license/document.ts:113` (401 at expiry, so the app stops working).
   - Every time-limited licence today gives the customer the wrong mental model.
2. **HIGH: No term model. Subscriptions exist only behind commerce, and they are deferred.**
   - LX-23 is phase D and optional. CM-08 carries `deferred` and owns `dist_subscriptions`. The
     store bridge refuses subscriptions (`commerce/apple.ts:21`).
   - A developer billing through their own system has no "renews" concept, no dunning and no lapse
     behaviour. The owner wants subscriptions "even if Commerce is not active".
3. **HIGH: Sub-licences have no definition; each source redefines what a purchase gives.**
   - The sources are `dist_store_products.flag`, `dist_store_product_entitlements` (LX-08),
     `provisioning_config.entitlement_key`, `dist_offers.grants_json` (S-22), LX-25 codes and comps.
   - Diceroll's supporter skins (`P/wp/D-05-diceroll-after-p6.md:24-25`) would be mapped once for
     the App Store, again for Play, and again for a Polaris Key offer.
4. **HIGH: Tier entitlements live in config profiles.**
   - A tier can grant a feature only by attaching a config profile whose payload carries
     `entitlements` (`W/core/payload.ts:168-178`; `TierForm.tsx` has no entitlement field).
   - A licence's entitlement overrides sit in a tab named **Config overrides**
     (`LicenseRecord.tsx:387`). This is the owner's "co-mingled with Config".
5. **HIGH: Version-bounded models break under the planned combine and anchor rules.**
   - The LX-01 §2.3 table (`P/plans/LX-01.md:194`) takes the "widest window" across contributing
     licences. Holding 1.x lifetime plus 3.x gives [1.0, ∞), so 2.x leaks.
   - The anchor order (`P/plans/LX-01.md` §2.4) ignores the running build.
6. **MEDIUM: The licensing settings surface is larger than the behaviour behind it.**
   - Seven `licensing.*` keys plus `syncTierOnSignIn` and `reservedNames`. Five of the six visible
     ones do nothing yet (`LicenseSettingsPage.tsx:1-10`).
   - `entitlementHolder: owner`, `anchorPolicy` and `reanchor` are made moot by owner decisions:
     the person picks a licence at sign-in (I-04 2026-10-05), and bound licences need sign-in
     (owner brief).
7. **MEDIUM: Combine machinery is over-general.**
   - `combine ∈ {any, all, max, min, sum, union, anchor}` × `entitlementKind ∈ {feature, ownership,
policy, quota}` per flag (`P/plans/LX-01.md:240-241`).
   - Quantities need one rule, which `deviceLimit` already follows: the base from the licence, plus
     add-ons summed. U-01 meanwhile requires `combine: max` for sync limits (rule 8b), which loses
     a bought "+10 GB" pack.
8. **MEDIUM: No quantities or consumables.**
   - Grants have no quantity. `quota` is reserved and undesigned. Commerce handles non-consumables
     only (`commerce/apple.ts:21`; A-17e).
   - The owner's "bought multiple times" and "redemption status (in-game currency)" have no home.
9. **MEDIUM: Platform entitlements are scattered.**
   - Channels, versions and devices are tier columns. Cloud Sync limits live in `cloudSync.limits.byTier`
     (a second tier map) and `.byEntitlement` (`P/plans/U-01.md:323`). I-24 adds `license.*` keys.
   - Nothing says which service provides which key or hides it when that service is off.
10. **MEDIUM: Four separate all-language licensing wire events are queued.**
    - They are I-24a/b (`profile.user`, two policy keys, three codes), LX-18/19 (expiry, reasons,
      grants), LX-25 (a redeem route plus parity) and CM-14/15 (checkout).
    - Each one regenerates the corpus and ports six SDKs and their kits.
11. **MEDIUM: The resolver cache key misses template edits.**
    - S-19 §7.3.5 keys the effective set by the contributors' `holder_versions` only
      (`N/S-19-…:635-645`). A tier, profile, catalog or (future) add-on edit changes every holder's
      set without bumping a version.
    - LX-08's `holder_kind` CHECK (`0105_a:123`) cannot hold a product-scope version without a
      table rebuild.
12. **LOW: Drift and vocabulary.**
    - The rule text in `reservedNames.ts:65,70` contradicts the code (tighter, not wider), and so
      does S-19 §4.2.
    - `data-model.mdx:64` omits the tier columns from `0002_channels.sql:9-11`. The generator
      misses `ALTER TABLE tiers    ADD` with aligned spaces.
    - Overloaded words:
      - "grant": grants, store grants, `account_product_grants`, and the former download grant;
      - "claim": store claim, Discover claim, claim/migrate;
      - "redeem": codes;
      - "add-on": S-19's `addon` licence kind, S-22's offer kind and the owner's sub-licence.
    - The glossary calls a tier "a named plan" (`packages/docs/src/content/docs/start/concepts.md:192`)
      against rule 4's "Tier, not plan".

---

## Owner brief: item-by-item stance

| #   | Owner item                                                                                                                | Stance    | Reason and what we do                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | "Entitlements explicitly associated with a particular license and user"                                                   | **adopt** | Model OC already does this: a licence's slice and its licence-held grants, plus account-held grants for "user". Tiers gain their own `entitlements`, and licence overrides stay on the licence (S-17 D20).                                                                                                                                                                                                                                                                               |
| E2  | "Previously co-mingled with Config": split them                                                                           | **adapt** | Split the **values**: profiles become config-only, tiers carry entitlements, and the licence's "Config overrides" tab becomes **Entitlements**. Keep the **declaration** as catalog `kind: "flag"` on the wire. Renaming the kind or moving it to another file changes `/<p>/schema`, which every SDK parses (Swift's `enum ConfigKind {config, secret, flag}`, `packages/cli/src/mirrors.ts:294`): an all-SDK event with no user benefit. The UI and docs say "entitlement" everywhere. |
| E3  | Sub-licences (IAPs, DLC, feature packs) with their own entitlements that propagate up                                     | **adapt** | Model them as an **add-on** (a definition) plus a **grant** (an instance), not as a second licence. Propagation is the resolver's combine. Drop S-19's `addon` licence kind (never written; LX-01 Q8). A keyed add-on is a redeem code for an add-on (LX-25).                                                                                                                                                                                                                            |
| E4  | Multiple of the same entitlement (IAP bought several times)                                                               | **adopt** | Add a `quantity` entitlement kind and `grants.quantity`. The effective value is the licence's base value plus the sum over add-on grants.                                                                                                                                                                                                                                                                                                                                                |
| E5  | Redemption status in-app (in-game currency IAPs)                                                                          | **adapt** | A `consumable` kind with a consumption ledger and an online `consume` call. That is delivery-once, refund reversal and status in console and portal. **Push back on a currency wallet**: balances and spending are game economy, server-authoritative and cheat-sensitive. A developer backend or a Cloud Sync `ownerRead` collection (U-16) holds the wallet.                                                                                                                           |
| E6  | Platform-level entitlements (update channels, cloud sync, feature enablement)                                             | **adopt** | A platform entitlement registry that extends `reservedNames.ts` with the providing service, type and combine rule. It is shown in the tier editor only while that service is on. Add `sync.storageBytes` and `sync.saveSlots`; they replace `cloudSync.limits.byTier/byEntitlement` (cross-domain).                                                                                                                                                                                      |
| E7  | Tiers: a config profile they cannot override, entitlements, licensing details                                             | **adopt** | Tier = `configProfile` + `entitlements` + access (devices, offline days, channels, versions) + term (`policyExpiryDays`, `onExpiry`). A tier holds no config values of its own.                                                                                                                                                                                                                                                                                                          |
| E8  | Config flow: user > license > config profile > defaults                                                                   | **defer** | Belongs to the config domain. Note: U-03 (done) retired **licence-level config overrides** in favour of the account override, so "license" in this chain no longer exists for config. Entitlements are never in this chain.                                                                                                                                                                                                                                                              |
| E9  | Licensing metadata: license > tier > defaults                                                                             | **adopt** | Applies to devices (LX-14a already), offline days, term and **versions**. Today versions intersect tier and licence; they become "licence replaces tier" in `combined` mode, listed in the holder report. **Channels stay additive** (tier ∪ licence, `stable` always): access only ever widens, which matches the owner's "beta/dev added to a tier".                                                                                                                                   |
| E10 | Subscriptions inside Polaris Key and in third-party stores                                                                | **adopt** | Split LX-23: **LX-23a** is the source-neutral core (term, subscriptions table, manual and external sources, dunning, lapse) and is **not optional**. **LX-23b** adds Apple auto-renewables and Play subscriptions. CM-08 writes through LX-23a.                                                                                                                                                                                                                                          |
| E11 | A licence can be lifetime / fixed expiry / a specific version / renewable / renewable + perpetual downloads / more        | **adopt** | One field each: lifetime = no expiry; fixed = `policyExpiryDays`; a specific version = a version window (with a major-line helper "1.x"); renewable = an attached subscription; renewable + perpetual = `onExpiry: keepVersion`. Also: trial → paid (supersede), fixed term + fallback, per-major lines, seat subscriptions (quantity → seats). Concurrent-use stays out (S-19 D24).                                                                                                     |
| E12 | "Configurable by the product's owners"                                                                                    | **adopt** | Presets in the licensing quick start pick the model. Tier fields override the preset, and licence fields override the tier. There are no per-product mode switches.                                                                                                                                                                                                                                                                                                                      |
| E13 | JetBrains perpetual fallback                                                                                              | **adopt** | `onExpiry: keepVersion`. At lapse the Worker freezes `fallback_version`: the newest stable release published while the licence was active, read through Core's `releaseCatalog` hook, else the highest `devices.app_version` the licence reported. The licence stays usable with `app.maxVersion` capped. The signed document is unchanged. JetBrains' "12 consecutive months" rule is deferred until asked.                                                                             |
| E14 | "1.x forever, 2.x subscription, 3.x expiry plus perpetual"                                                                | **adopt** | One tier per major line: v1 lifetime with versions 1.x; v2 subscription with 2.x; v3 a 365-day term with `keepVersion` and 3.x. Two fixes are needed: the version window is **anchor-only** (not widest), and **the anchor is chosen to cover the running build** (`X-PKey-Version`). A device upgrading from 1.x to 2.x moves to the 2.x licence on refresh.                                                                                                                            |
| E15 | A store purchase on a linked account provisions licences and entitlements; a refund removes them                          | **adopt** | Already designed (LX-11 holder bindings and restore policy; LX-12 refund states). Mappings now target **a tier or an add-on**.                                                                                                                                                                                                                                                                                                                                                           |
| E16 | "Subscriptions will generally come from storefronts, but the licensing system behind them must work when Commerce is off" | **adopt** | A Core `subscriptions` table with sources `manual`, `external`, `app-store`, `play` and `polaris-key`, and an admin API for a developer's own billing (start, renew, cancel).                                                                                                                                                                                                                                                                                                            |
| E17 | Reduce configuration surface area                                                                                         | **adopt** | Remove four licensing settings, the `combine` field, the `ownership` and `quota` kinds, the `addon` licence kind, and the four sets of definition columns (§Surface-area reduction).                                                                                                                                                                                                                                                                                                     |
| E18 | Degrade gracefully by service                                                                                             | **adopt** | See the matrix in T12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E19 | Portal: OIDC licence source reads "Automatic Grant"                                                                       | **adapt** | The portal domain owns the copy. From this domain: `oidc` grants (provisioned add-ons) get the same source label.                                                                                                                                                                                                                                                                                                                                                                        |

---

## Target design

### T1. Two templates, tiers and add-ons, and two instances, licences and grants

```
          template                instance               holder
  tier   ──────────▶  licence  (seats, term, versions)  account | floating
  add-on ──────────▶  grant    (keys, quantity, term)   account | licence | store identity
```

- **A tier** answers "what does a base licence give". It has:
  - `rank`;
  - `configProfile` (config only);
  - **`entitlements`** (new);
  - access: `policyDeviceLimit`, `policyOfflineGraceDays`, channels, versions;
  - term: `policyExpiryDays` and **`onExpiry`** (new).
- **An add-on** (new; the owner's "sub-licence") answers "what does this IAP, DLC or pack give". It
  has `id`, `label`, `description` and `entitlements` (feature and quantity keys). An add-on that
  carries a consumable key gives `units` of that key instead. An add-on that carries `deviceLimit`
  is a **seat pack** and is always licence-held (S-19 §7.2).
- **Declared in the manifest**, beside `licensing.tiers[]`: `licensing.addons[]` in
  `.pkey/product`, with rule 9 entries. The console can claim the declaration (S-18 model). Products
  are data (rule 5). What an add-on contains is reviewable product data.
- **Who may unlock it stays operator-only.** The sources that point at a target are:
  - store mappings: store product → tier or add-on;
  - checkout offers;
  - redeem codes;
  - OIDC group → tier, and claim → add-on;
  - comps;
  - Discover and auto-issue → tier.

  The rule "a repo push must never decide which purchases unlock a flag"
  (`commerce/settings.ts:1-7`) is unchanged.

- **Live templates.** Editing a tier already changes every licence on it. Editing an add-on changes
  every grant of it the same way: a grant stores `addon_id`, and the resolver reads the add-on's
  current keys.
  - `grant_entitlements` remains the store for **add-on-less** grants: legacy store grants, `oidc`
    grants from raw provisioning, and comps of raw keys.
  - Removing a key from an add-on that has active holders is an L2 change, with the holder count
    shown and an audit entry.
- **One issuance path.** `core/issuance.ts` exposes `grantTo(holder, target, source, opts)`.
  - Target `{tier}` mints a licence (today's `issueFromPath` branch, moved down from
    `W/services/identity/portal/discover.ts:564`).
  - Target `{addon}` writes a grant through `core/grants.ts` (LX-08).
  - Commerce reaches it through the existing single-provider Core hook (S-22 D32), and so do
    comps, codes, store claims, OIDC and Discover.

### T2. Where entitlement values live, and their precedence

For one licence (the "slice", S-19 §7.3.2 step 2), lowest first:

1. catalog default (for entitlements: "absent"; flags carry no default into documents, LX-04);
2. **tier `entitlements`** (new; replaces the tier profile's entitlement bucket);
3. **licence entitlement overrides** (`overrides_json.entitlements`; licence profile entitlement
   buckets are folded in by the LX-34 migration, below).

Then:

- grants (licence-held, account-held and store-held) combine with the slices by kind (T3);
- policy keys come from the anchor (devices, versions) or are a union (channels);
- device overrides apply last, as a support tool (audited), unchanged.

Profiles become **config-only**. After a warning window, the manifest validator refuses `flag` keys
in a profile payload (a rule 9 row), and the console's profile editor hides flags.

### T3. Entitlement kinds and the one combine rule

The catalog `flag` entry gains **one** optional field, `kind` (rule 9; served at `/<p>/schema` as an
extra member, which every SDK's decoder ignores). It replaces LX-01's `combine` plus
`entitlementKind` pair, neither of which has shipped yet:

| `kind` (on a flag)   | Value                  | Combine across contributors                                                | In the signed doc? |
| -------------------- | ---------------------- | -------------------------------------------------------------------------- | ------------------ |
| `feature` (default)  | boolean or any JSON    | booleans: any; string arrays: union; other: the anchor's                   | yes                |
| `quantity`           | integer ≥ 0            | **max over licence slices + Σ over grants of (value × `grants.quantity`)** | yes                |
| `consumable`         | integer units          | never combined; a ledger (T8)                                              | **no**             |
| _(policy, internal)_ | reserved platform keys | fixed per key (T4)                                                         | yes                |

- A paid grant is never cancelled by a slice (S-19 decision 6), unchanged.
- `ownership` merges into `feature`. The portal's "You own X" vs "Includes X" wording comes from
  whether the key is the target of a `dist_access.entitlement`, which is derivable.
- `quota` is replaced by `quantity` and `consumable`.
- U-01's rule `cloud_sync_entitlement_not_max` becomes "is a `quantity`".

### T4. Platform entitlements

`packages/shared-manifest/src/reservedNames.ts` becomes the **platform entitlement registry**. Each
row is `{key, type, kind, rule, service, settableOn: [tier, licence, addon]}`:

| Key                                          | Service         | Rule                                                                              | Settable on                       |
| -------------------------------------------- | --------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| `channels`                                   | Release         | union; `stable` always                                                            | tier, licence, add-on             |
| `app.minVersion`, `app.maxVersion`           | License         | **anchor only** (licence > tier), then the term clamp (T5)                        | tier, licence                     |
| `deviceLimit`                                | License         | anchor only: licence > tier > product default, + Σ seat-pack grants on the anchor | tier, licence, add-on (seat pack) |
| `license.tier`, `license.tierLabel`          | License         | the highest-rank contributing licence; ties go to the anchor                      | derived                           |
| `license.maxUsers`, `license.devicesPerUser` | Identity (I-24) | anchor only                                                                       | tier, licence                     |
| `sync.storageBytes`, `sync.saveSlots`        | Cloud Sync      | `quantity`                                                                        | tier, licence, add-on             |

The tier editor and the add-on editor show a platform key only while its service is enabled. The
values persist when a service is turned off and apply again when it comes back. Fix the
`reservedNames.ts:65,70` rule text now (quick win).

### T5. Terms: lifetime, fixed, renewing, and `onExpiry`

- **Term length** is unchanged: `policyExpiryDays` on the tier (null = lifetime) and `expires_at`
  on the licence.
- **Renewing** is not a tier mode. A licence (or grant) renews **iff it has an active
  `subscriptions` row** (T6). The source moves `expires_at`.
- **`onExpiry: stop | keepVersion`** is the single new field: `tiers.on_expiry`, with a per-licence
  override in `licenses.on_expiry`. Default is `stop` (today's behaviour).
  - `stop`: past `expires_at`, the licence ends (today).
  - `keepVersion` (perpetual fallback), past `expires_at`:
    - the licence is **lapsed**: usable, with `app.maxVersion` = `min(window max, fallback_version)`;
    - `channels` narrow to `stable`;
    - every other entitlement stays. A service that should end with the term is sold as an
      **add-on subscription**, whose grant has its own `expires_at`. That gives zero extra knobs.
- **`fallback_version`** is frozen once, server-side, at the first read or scheduled tick after the
  lapse. It is:
  1. the newest **stable** release published at or before `expires_at` and inside the window, read
     through Core's `releaseCatalog` hook (`W/core/hooks.ts:70`, `:1332-1345`);
  2. else (Release off) the highest `devices.app_version` the licence's devices reported while
     active;
  3. else the licence lapses as `stop`. The tier editor warns about this when `keepVersion` is
     chosen on a product without Release.

  It is audited and emitted on `entitlement_events`. It is never taken from a client.

- **`licenseState(row, tier, now)`** replaces the boolean `licenseUsable` and returns
  `{state: active | grace (dunning) | lapsed | ended | disabled, usable, reason}`. Each gate decides
  per state:
  - version-aware gates (the document, `entitled` release, pack and feed checks, portal downloads)
    accept `lapsed` with the cap;
  - non-version gates (registry tokens, Cloud Sync writes) treat `lapsed` as usable;
  - the table is fixed in LX-23a's plan.
- **The grace clamp** (LX-07) clamps to `expires_at` only when the licence ends there. For
  `keepVersion`, `graceClampFor` returns null.
- **Why there is no wire change.** The device already enforces `app.maxVersion` as an enforced
  entitlement, the server already answers `version_blocked` above it, and the portal already shows
  "Updates ended at 2.3" from a window that ends before the newest release
  (`W/services/identity/portal/downloads.ts:82`). The new optional `term` member (T11) only lets
  the SDK _explain_ the lapse.

### T6. Subscriptions without commerce

A Core-owned table, written only through `core/subscriptions.ts`, rule 6:

```sql
-- 00XX_subscriptions.sql (TABLE_OWNERS: core)
CREATE TABLE IF NOT EXISTS subscriptions (
  product              TEXT NOT NULL REFERENCES products(slug),
  id                   TEXT NOT NULL,                 -- sub_<26 base32>
  license_id           TEXT NULL,                     -- keeps a base licence alive
  grant_id             TEXT NULL,                     -- or an add-on grant
  source               TEXT NOT NULL,                 -- manual | external | app-store | play | polaris-key (trigger vocabulary)
  external_ref_hash    TEXT NULL,                     -- originalTransactionId / purchase token / provider sub id, hashed
  status               TEXT NOT NULL,                 -- trialing | active | past_due | canceled | ended (trigger vocabulary)
  period               TEXT NULL,                     -- P1M | P1Y, display only
  current_period_end   INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, modified_by TEXT NOT NULL,
  PRIMARY KEY (product, id),
  CHECK ((license_id IS NOT NULL) + (grant_id IS NOT NULL) = 1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_ref
  ON subscriptions(product, source, external_ref_hash) WHERE external_ref_hash IS NOT NULL;
```

- **Every renewal is one batch:**
  - set `subscriptions.current_period_end`;
  - set `expires_at = period end + 24 h` on the licence or grant (a constant buffer, so S-22's
    `commerce.subscriptions.renewalBufferHours` setting is not needed);
  - bump `holder_versions`;
  - append to `entitlement_events`.
- **Dunning.** On `past_due`, the grant state is `past_due` and `grace_until` = period end +
  `licensing.dunningGraceDays` (LX-01 §2.5). The licence's `expires_at` moves to the same instant.
- **Cancel** sets `cancel_at_period_end`. The term ends at `expires_at`, and the lapse follows
  `onExpiry`. Resubscribing reuses the licence (S-22 D16).
- **Sources:**
  - `manual`: the operator's **Renew…** in the console, which extends by the period;
  - `external`: a developer's own billing calls the admin API, documented with a copy-paste sample;
  - `app-store` and `play`: LX-23b, from store notifications;
  - `polaris-key`: CM-08. Its `dist_subscriptions` shrinks to the provider references (merchant,
    offer, provider subscription id) keyed by `subscriptions.id`.
- **Admin API** (rule 10):
  - `POST /manage/api/products/{p}/licenses/{id}/subscription` (start);
  - `POST …/subscriptions/{sid}/renew {periodEnd}`;
  - `POST …/subscriptions/{sid}/cancel {atPeriodEnd}`;
  - `GET …/subscriptions?status=`.
  - The `subjects/{s}/entitlements` route (LX-13) gains `term`.

### T7. Version-bounded licences

- **Major-line windows.** The tier and licence editors accept "1.x" as a helper. It is stored as
  `min_version = 1.0.0`, `max_version = 1.999999.999999` (an inclusive semver every SDK comparator
  orders correctly: any 2.x prerelease is greater), and displayed as "1.x".
  - Manifest: `licensing.tiers[].maxVersion: "1.x"` is normalized at ingest (rule 9 row).
  - LX-18's corpus appends one gate-matrix case with six-digit components to prove every SDK's
    comparator.
- **The window is anchor-only.** It is not combined across licences, because versions are a term of
  the contract, like seats. This amends LX-01 §2.3 before LX-09 builds it.
- **Version-aware anchor.** The preselection order (LX-10) becomes:
  1. covers the running build (`X-PKey-Version`);
  2. then `rank`, no expiry, latest expiry, oldest activation, `id`.
- **Version-aware re-anchor** (merged with LX-21). On a document request whose build falls outside
  the anchor's window, the resolver moves the device when the holder has another usable licence
  that covers the build and has a free seat. The move is audited and seat-checked, and safe per
  LX-17. Otherwise the answer is today's `403 version_blocked` with `allowedRange` (plus LX-18's
  reason and `manageUrl`).
- **Following a supersession is automatic.** When the anchor is `superseded_by` a licence of the
  same holder (an upgrade, or trial → paid), the next refresh moves the device. The
  `licensing.reanchor` setting goes.
- **New major release detection** (automation). When Release publishes the first `X.0.0` above a
  tier's `max_version`, Licenses shows a callout: "2.0.0 is your first 2.x release. Customers on
  Pro (1.x) won't get it." It offers three actions:
  - **Start a 2.x tier…**: clone the tier with versions 2.x; optionally set an upgrade offer when
    Commerce is on;
  - **Extend Pro to 2.x**;
  - **Dismiss**.

### T8. Sub-licences, quantities and consumables

- **Add-on grants** (T1) are the sub-licences. A licence's Entitlements tab lists them under it
  ("Supporter skins · App Store"), which is the owner's "propagate up". The resolver does the
  combining.
- **Quantities.** `grants.quantity` (Play multi-quantity, a multi-unit offer line) multiplies a
  `quantity` key's value. Example: "+1 save slot" bought 3 times gives `sync.saveSlots` = tier 5 + 3.
- **Consumables** (LX-36, optional but designed now):
  - Data: `grant_consumptions(product, grant_id, id, units, request_hash UNIQUE, device_id, subject,
by device|backend|admin, consumed_at, reversed_at)`.
  - Remaining units = add-on `units` × `grants.quantity` − Σ consumed.
  - A consumption is one conditional `INSERT … SELECT … WHERE remaining ≥ units` in a single batch,
    idempotent by `requestId`.
  - **WIRE** (in the LX-18 train; a new route, not a signed document):
    `GET /<p>/license/consumables` → `{items:[{grantId, addon, key, units, remaining, source,
grantedAt, state: available|reversed}]}` and `POST /<p>/license/consumables/consume {grantId,
units, requestId}` → `{remaining}`. New codes `insufficient_units` and `consumable_not_found` go
    into `conformance/parity/errors.json` first.
  - **Refunds after consumption** mark the consumption `reversed`. The item comes back with
    `state: reversed` so the game can claw back, and the game decides how.
  - **Developer backend:** `GET …/subjects/{s}/consumables` and `POST …/consumables/{grantId}/consume`,
    for games with their own economy server.
  - **Stores:**
    - Play consumables are `consume`d by the Worker right after the grant row commits, so the
      player can buy again (Play's rule); a recheck retries a failed consume.
    - Apple consumables are claimed like non-consumables, and the SDK finishes the transaction
      after the claim.
    - Steam microtransactions are out of scope.
  - **No wallet** (owner item E5).

### T9. Holder rules (simplified)

- The holder is always the **account signed in on the device** (`entitlementHolder: device`). The
  `owner` value is removed:
  - the owner's "bound licences need sign-in" means an owned licence's purchases reach a device only
    where the owner signs in;
  - Identity-off products create licence-held grants (PX-W17);
  - `owner` only reopened T1 (a shared key leaks every purchase).
- `combined` is **the** model. `legacy` survives only as a migration state, shown as a one-time
  "Switch to the new entitlement model" card with the holder report. LX-16 deletes it once djdl and
  `polaris-key` have switched. The only live products are djdl and the system product; diceroll is
  dogfood.

### T10. Console and portal

**Console:**

- **License** nav: Licenses · Tiers · **Add-ons** · **Entitlements** · Settings.
  - **Entitlements** shows the flag declarations with kind, the tiers and add-ons that grant each,
    the read-only platform keys, and **Edit in catalog**. It also shows a tier × entitlement matrix.
  - **Config → Catalog** shows `config` and `secret` only, with a "3 entitlements: see License →
    Entitlements" link. It stays one editor and one file.
- **Tier record** has one form with sections:
  - Basics (label, rank);
  - Term ("Lifetime / 365 days", and "When it ends: Stop working / Keep the last version");
  - Access (devices, offline days, channels, versions with the "1.x" helper);
  - Includes (feature checkboxes, quantity numbers, and platform keys while their service is on);
  - Config profile (while Config is on);
  - Used by.

  It replaces both the config-profile route to tier entitlements and S-19's "rank, offline days"
  additions.

- **Add-on record:**
  - label and includes, or units;
  - **Sold as**: read-only links to store mappings, offers and code batches;
  - holders count;
  - actions **Comp to…**, **Create codes…** (LX-25) and **Create the in-app purchase…** (A-17e,
    while App Store Connect is connected).
- **Licence record tabs:** Status · **Entitlements** · Keys · Devices · Activity. The
  **Entitlements** tab holds:
  - the effective set, per device, with source chips;
  - **Add-ons and grants**, with comp, extend, suppress, revoke and move;
  - **Overrides**, the entitlement override editor that leaves the "Config overrides" tab;
  - **Subscription**, when renewing: source, status, renews or ends, **Renew…** for manual.

  This is one tab instead of LX-14's Entitlements plus Grants plus EXPERIENCE O1's Config. The
  account's config overrides live on the user record (U-03).

- **Licences list** facets add **Renewing**, **Past due** and **Updates ended**.
  **Preview at a date…** on the licence and tier records shows the effective set and term at a
  future instant, so an operator can test a fallback or a lapse without waiting.

**Portal (LX-15):**

- **Term line:**
  - "Lifetime";
  - "Renews 3 Mar · App Store";
  - "Ends 3 Mar";
  - "Updates ended at 2.3 · keeps working" (lapsed, `keepVersion`);
  - "Ended 3 Mar" (`stop`).

  The "renew to get newer versions" copy appears **only** for `keepVersion`. A `stop` licence gets
  "Renew with <developer> to keep using it".

- **Add-ons** list with source badges, and for consumables "500 gems · delivered".
- Downloads keep the last covered version for a lapsed licence. The existing `recommended.latest =
false` path already does this once `licenseState` allows `lapsed`.

### T11. SDK and wire: the licensing train (**WIRE**, plan mode)

One plan (LX-18) and one SDK wave (LX-19) carry every licensing wire change.

- **`PROTOCOL_VERSION` stays 4** and `corpusVersion` stays 2, under the P4-13, P4-19, P4-29 and
  LX-01 precedent: optional members outside the claims, which older SDKs ignore.
- The steps run in this order: contract → `shared-protocol` and client-core → `errors.json` /
  `enums.json` / `features.json` → `pnpm gen corpus`, `gen constants`, `gen transcripts` (Swift and
  Godot mirrors) → Node, React (client-core), Python, Swift, Kotlin, Godot → kits through UK-03's
  ui-core view models.

| Member or route                                                                                                | From                     | Notes                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `entitlements[k].expiresAt`                                                                                    | LX-18                    | unchanged                                                                             |
| `term {endsAt?, renews?, onExpiry?, fallbackVersion?, state?}`                                                 | **new**                  | replaces S-19's `licenseExpiresAt`                                                    |
| `grants[] {source, addon?, label?, keys[], quantity?, expiresAt?, trial?, shared?}` (≤ 32)                     | LX-18 + `addon`          | no licence ids except the anchor, no refs, no account ids (S-19 T5)                   |
| 401 `reason` (`no_license expired revoked refunded chargeback superseded`)                                     | LX-18, LX-01 Q6          |                                                                                       |
| `not_entitled` reasons (`no_base_licence device_limit` + `manageUrl`)                                          | LX-18, PX-W8             |                                                                                       |
| `profile.user`, `license.maxUsers`, `license.devicesPerUser`, `account_required`, `device_limit` `scope: user` | **I-24a's wire half**    | merged in; I-24a keeps its server, console and portal work                            |
| `POST /<p>/license/redeem {code}`                                                                              | **LX-25's device route** | only if in-app redemption is kept; codes also enter through the portal Activate modal |
| `GET/POST /<p>/license/consumables…`                                                                           | **LX-36**                | an optional appended step; not on the critical path                                   |
| enum `polaris-key` grant source                                                                                | CM-14 W4                 | lands here, so CM-14 has three items left                                             |

**SDK API (LX-19):**

- `isEntitled` is gated on usability and expiry (S-19 decision 14; a migration guide ships with it).
- `entitlement(name)` → `{active, value, expiresAt?, sources[]}`.
- `term()`.
- `grants()`.
- `consumables()` / `consume(grantId, units)` (with LX-36).

The kits render a term line and an add-ons list from UK-03's shared view model, so the Swift,
Compose, Godot, Qt, terminal (UK-13/14) and web kits do not each implement them. Commerce client
parity (LX-20) and checkout (CM-14/15) stay the **commerce train**.

### T12. Graceful degradation

| Service off                     | Effect in this domain                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License                         | No tiers, add-ons, grants or subscriptions. Config documents still work (D-08). Store mappings are refused (today).                                     |
| Identity                        | No account-held grants. Add-ons are licence-held (PX-W17). Subscriptions and consumables are licence-held. The portal's purchase list is absent.        |
| Commerce (Polaris Key checkout) | Subscriptions still work through `manual`, `external` and store sources. Add-ons are still comp-able and redeemable by code.                            |
| Distribution's store bridge     | No store mappings. Add-ons and subscriptions still work. The add-on record hides **Sold as** store rows and shows the store setup wizard link.          |
| Release                         | `keepVersion` falls back to `devices.app_version`, and the tier editor says so. Channel controls are hidden. Version windows still apply (server gate). |
| Update                          | Channels are still delivered for downloads.                                                                                                             |
| Cloud Sync                      | `sync.*` keys are hidden in editors and kept in data.                                                                                                   |
| Config                          | The tier's config profile field is hidden. Entitlements are unaffected (they never needed Config once they leave profiles).                             |

### T13. Worked examples

1. **Diceroll supporter skins** (D-05).
   - The add-on `supporter-skins {extras.diceSkins: true}`.
   - App Store `diceroll.supporter.skins` → add-on, and Play → the same add-on, as two mapping rows
     with no keys repeated. A Polaris Key offer → the same add-on.
   - `isEntitled("extras.diceSkins")` is unchanged.
2. **JetBrains model.**
   - Tier `pro`: `policyExpiryDays: 365`, `onExpiry: keepVersion`.
   - Sold as a yearly subscription (App Store or Stripe) or renewed by hand. Lapse on 3 Mar 2027,
     when the newest stable release is 2.3.1: the licence works on ≤ 2.3.1 forever, the portal says
     "Updates ended at 2.3.1 · keeps working", and resubscribing lifts the cap.
3. **"1.x forever, 2.x subscription, 3.x 1-year plus perpetual".**
   - Tiers `v1` (lifetime, 1.x), `v2` (renewing, 2.x, `stop`), `v3` (365 days, 3.x, `keepVersion`).
   - A person holding v1 and v3 runs 1.4 on a v1 anchor. Updating to 3.0, the device re-anchors to
     v3 on refresh. 2.x is never covered.
4. **Gem packs.** The add-on `gems-500 {consumable: gems, units: 500}`. A Play purchase of quantity
   2 gives a grant with `quantity` 2. The game calls `consume(grant, 1000)`, the console shows "1000
   of 1000 delivered", and a refund after delivery shows `reversed`.
5. **Developer's own billing** (Commerce off).
   - The backend calls `POST …/licenses/lic_1/subscription {source:"external", period:"P1M",
periodEnd}` and, each month, `…/renew`.
   - The portal says "Renews 3 Mar". A missed renewal lapses per `onExpiry`, and the dunning grace
     applies.

---

## Surface-area reduction

| Removed or merged                                                                                                                                                                     | Replaced by                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `licensing.entitlementHolder` (owner mode)                                                                                                                                            | always the signed-in account                                       |
| `licensing.anchorPolicy` (3 values)                                                                                                                                                   | one fixed preselection order (T7)                                  |
| `licensing.reanchor` (3 values)                                                                                                                                                       | explicit choice + automatic follow (supersession, version)         |
| `licensing.entitlementModel` as a permanent setting                                                                                                                                   | a one-time migration card; `legacy` deleted in LX-16               |
| `licensing.reservedNames` platform switch (after LX-05b)                                                                                                                              | always `error`                                                     |
| `commerce.subscriptions.renewalBufferHours` (S-22)                                                                                                                                    | a 24 h constant                                                    |
| Catalog `combine` (7 values) + `entitlementKind` (4 values)                                                                                                                           | one `kind` (`feature`, `quantity`, `consumable`)                   |
| Licence `kind = 'addon'` (LX-08 column)                                                                                                                                               | add-on grants; the column stays `base` (dead)                      |
| `dist_store_products.flag`, `.grants_kind`, `.base_tier_id`, `dist_store_product_entitlements`, `dist_offers.grants_json`, `provisioning_config.entitlement_key/value`, raw-key comps | one `target: tier:<id> \| addon:<id>`                              |
| Entitlement buckets in config profiles, and licence profile stacks for entitlements                                                                                                   | `tiers.entitlements`; licence overrides                            |
| `cloudSync.limits.byTier` and `.byEntitlement` (cross-domain)                                                                                                                         | `sync.*` platform entitlements on tiers and add-ons                |
| Licence tabs Entitlements + Grants + Config overrides                                                                                                                                 | one **Entitlements** tab                                           |
| `dist_subscriptions` lifecycle columns (S-22)                                                                                                                                         | Core `subscriptions`; commerce keeps provider references only      |
| Four all-SDK licensing wire events (I-24a/b, LX-18/19, LX-25, consumables)                                                                                                            | one licensing train (CM-14/15 and LX-20 remain the commerce train) |
| S-19 "perpetual fallback as a grant setting `app.maxVersion`" (non-working)                                                                                                           | `onExpiry: keepVersion`                                            |

Net: licensing settings go from **7 → 3**. Visible: refund grace, dunning grace (each shown only
when a purchase or subscription source exists) and the grace clamp (advanced). Definition
locations go from **6 → 2** (tiers, add-ons).

---

## Automation and onboarding

1. **"Choose how you sell it"** as the first step of the Licensing quick start (SETUP.md UX-63,
   `docs/design/SETUP.md:433,1638`). Each preset creates tiers with term, versions and includes
   preset, shows the portal card a customer will see, and shows the SDK snippet:
   - Free + Pro (today's default);
   - One-time purchase;
   - Subscription;
   - Subscription with perpetual fallback;
   - Pay per major version;
   - Trial then paid.
2. **The Integration section** (the products domain) gets per-model code samples that use the
   product's **real** keys: `isEntitled("extras.diceSkins")`; a `term()` banner ("Updates ended at
   2.3: renew for 3.x"); and the consumables loop `consumables() → consume()`. They are generated
   beside the `pkey sdk` samples.
3. **Store import → add-ons.** When an App Store, Play or Steam connector lists in-app products or
   DLC (A-17, A-18e, I-14), offer "Create add-ons for these 3 purchases", with keys suggested from
   the product ids and the mapping rows created at once.
   - Creating an add-on while a store is connected offers **Create the in-app purchase** (A-17e,
     now including consumables).
   - **Also sell on Google Play** reuses the add-on.
4. **New major release** detection and the one-click "Start a 2.x tier" (T7).
5. **Lapse automation.** A scheduled tick:
   - freezes `fallback_version`;
   - emails the customer through I-18 ("Your updates ended at 2.3; 2.3 keeps working");
   - writes `entitlement_events` for the developer backend.

   Manual subscriptions due within 7 days raise a console attention item.

6. **Preview at a date…** (T10). It is the onboarding test for any term model: no waiting a year
   to see a fallback.
7. **Platform keys appear by themselves.** Turning Cloud Sync on adds "Cloud storage" and "Save
   slots" rows to every tier's Includes, with defaults, with no catalog edit.
8. **Guards:**
   - catalog publish refuses removing a key that a tier or add-on references (it already
     cross-checks profiles, ADMIN.md §6.6.2);
   - removing a key from an add-on with holders is L2;
   - choosing `keepVersion` with Release off warns.
9. **The holder report becomes a migration card** ("12 devices would change, 3 widen; review and
   switch"), not a settings radio.

---

## Migration, data and risk

**Order** (each step deployable alone, expand → switch → contract):

1. LX-08 (merge, with the `holder_kind` CHECK amended to allow `product`, a one-word change before
   merge).
2. LX-32 (cut settings, before LX-09 and LX-10 implement them).
3. LX-09 (`combined` with `device` holder, the anchor-only window, `kind` rules, a product-scope
   cache version).
4. LX-33 (add-ons and `core/issuance.ts`).
5. LX-34 (tier entitlements, profiles config-only).
6. LX-10 + LX-35 (anchor and re-anchor).
7. LX-12.
8. LX-23a (term and subscriptions core).
9. LX-11 (store mappings with targets).
10. LX-23b (store subscriptions).
11. The LX-18/LX-19 train.
12. LX-36 (consumables, optional).
13. LX-16 (contract).

**Data:**

- **Profile entitlements → tiers and licence overrides (LX-34)** are exact by construction, run
  only for products already on `combined`. Within a slice, write
  `tiers.entitlements_json = tierProfile.entitlements` and, for each licence,
  `overrides.entitlements = mergeMap(licenceProfiles…, overrides)`. That reproduces the slice merge
  key by key, `updatedAt` included. A property test diffs every licence's slice before and after.
  djdl declares no profiles, so it is a no-op there.
- **Store mappings → targets (LX-11 / LX-33).**
  - Synthesize one add-on per distinct key set of `dist_store_products.flag` and
    `dist_store_product_entitlements` (`auto-<store>-<id>`, labelled from the store product's
    display name when the connector knows it).
  - Write `target`, and backfill `grants.addon_id` for store grants.
  - The old columns stay dead until LX-16.
- **`provisioning_config` entitlement rows** keep working as raw-key `oidc` grants. The console
  offers "Turn into an add-on" (identity domain decides the canonical form).
- **Terms:** `on_expiry` NULL = `stop` = today, so no backfill is needed.
- **Subscriptions:** none exist. CM-08 and LX-23b write new rows.
- **Settings:** the removed keys get rule 9 deprecation warnings in the manifest for one window,
  `NOT_A_SETTING` entries, and console rows deleted (ST-06's `gen settings --check`).
- **`holder_versions`:** template edits (tier, profile, add-on, catalog publish) bump `('product',
<slug>)`, and the cache key includes it. This avoids S-19 §7.3.5's stale-cache gap (T10 of S-19).

**Risks and mitigations:**

| Risk                                                                            | Mitigation                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `licenseState` touches every gate; a lapsed licence passes a gate it should not | LX-23a is plan mode, with a per-gate table and tests per gate (document, `entitled` release/pack/feed, registry token, Cloud Sync write, portal download)                      |
| Fallback version wrong (prerelease, retracted release, other channels)          | stable only, published ≤ `expires_at`, inside the window, frozen once and audited; an operator can correct it (L2)                                                             |
| Version re-anchor moves seats unexpectedly                                      | only when the build is outside the anchor and a covering licence has a free seat; audited; LX-17 proved SDK tolerance                                                          |
| Add-on live edits retroactively change paid entitlements                        | L2 plus holder count plus audit; removal of keys with active holders needs a typed confirmation                                                                                |
| Consumable double-spend or replay                                               | unique `request_hash`; a conditional insert in one batch; device token plus trust policy; THREAT-MODEL rows (LX-22)                                                            |
| Play consume ordering                                                           | consume only after the grant commits; recheck retries; never consume before verification                                                                                       |
| The train delays the `isEntitled` fixes (G10/G11)                               | the LX-18 plan fixes all member shapes up front; LX-36 routes are an optional appended step; I-24a's wire half and LX-25's route join only if ready, else the next minor train |
| External renewal API abuse                                                      | admin API token scoped to the product; rate-limited; audited; `external_ref_hash` uniqueness                                                                                   |
| Owner `combined` switch widens access (S-19 T2)                                 | the holder report as a migration card; versions become anchor-only, which removes S-19's widest-window widening                                                                |

---

## Backlog changes

| id                              | action | target         | note                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LX-05b                          | keep   |                | Also remove the `licensing.reservedNames` setting once the value is `error` (a switch with one value is noise).                                                                                                                                                                                                                                             |
| LX-07                           | keep   |                | In review. LX-23a later makes `graceClampFor` return null for `keepVersion` licences.                                                                                                                                                                                                                                                                       |
| LX-08                           | edit   |                | Before merge: `holder_versions.holder_kind` CHECK adds `'product'` (template version for the cache). No other change; `licenses.kind` stays but nothing ever writes `addon`.                                                                                                                                                                                |
| LX-09                           | edit   |                | Implement `combined` with the `device` holder only (no `owner`). `app.*` is **anchor-only** (licence > tier, not widest). One `kind` field (`feature`, `quantity`, `consumable`) instead of `combine` + `entitlementKind`. Quantity = max slices + Σ grants. Cache key includes the product template version. `legacy` is a migration state, not a setting. |
| LX-10                           | edit   |                | Fixed preselection order with "covers the running build" first. Drop `most-free-seats` and `oldest`.                                                                                                                                                                                                                                                        |
| LX-11                           | edit   | LX-33          | Plan mode. Mappings target `tier:` or `addon:` (replaces `grants_kind`, `base_tier_id`, `dist_store_product_entitlements`). Restore policy unchanged. Consumable store products are refused until LX-36. Depends on LX-33.                                                                                                                                  |
| LX-12                           | keep   |                | Grant and licence lifecycle; LX-23a adds `onExpiry` and lapse on top.                                                                                                                                                                                                                                                                                       |
| LX-13                           | edit   |                | Grants API takes `addonId` (or raw keys for a comp). `subjects/{s}/entitlements` returns `term`. Subscription routes move to LX-23a, consumable routes to LX-36.                                                                                                                                                                                            |
| LX-14                           | edit   | LX-34          | One **Entitlements** tab (effective set with sources, add-ons and grants with actions, the entitlement override editor that replaces the "Config overrides" tab, the subscription panel). Tier editor, add-on pages and the catalog fields move to LX-33/LX-34. Licensing report becomes the migration card (LX-32).                                        |
| LX-15                           | edit   |                | Portal term line (Renews / Ends / Updates ended · keeps working / Ended), add-ons with source badges, and consumable delivery status when LX-36 lands; the renew copy only for `keepVersion`.                                                                                                                                                               |
| LX-16                           | edit   |                | Contract also deletes the `legacy` resolver path and `licensing.entitlementModel`, and retires the mapping columns replaced by `target` and `dist_store_product_entitlements`.                                                                                                                                                                              |
| LX-18                           | edit   |                | Plan mode; becomes the **licensing train**: adds the `term` member (replaces `licenseExpiresAt`), `grants[].addon/label/quantity`, I-24a's wire half, LX-25's device route, and LX-36's routes as an optional appended step. Gains deps on LX-23a (term semantics) and LX-33 (add-on ids).                                                                  |
| LX-19                           | edit   |                | Absorbs I-24b and the SDK parts of LX-25/LX-36. Adds `term()`. Targets UK-03 ui-core view models instead of "four UI kits", so every kit (including UK-13/UK-14 terminals) inherits.                                                                                                                                                                        |
| LX-20                           | keep   |                | Commerce train; after LX-11.                                                                                                                                                                                                                                                                                                                                |
| LX-21                           | merge  | LX-35          | Becomes part of automatic re-anchor (supersession, version) plus "Run this device on"; no `reanchor` setting.                                                                                                                                                                                                                                               |
| LX-22                           | edit   |                | Glossary: add-on, term, lapsed / "keeps the last version", consumable, quantity. THREAT-MODEL: consumable replay, fallback freeze, external renewal API. Fix `concepts.md:192` "named plan".                                                                                                                                                                |
| LX-23                           | split  | LX-23a, LX-23b | LX-23a: terms and subscriptions core (not optional). LX-23b: Apple auto-renewables and Play subscriptions on it.                                                                                                                                                                                                                                            |
| LX-24                           | defer  |                | Per-seat features: not in the owner's brief; after I-24a ships and a product asks.                                                                                                                                                                                                                                                                          |
| LX-25                           | edit   | LX-33          | Codes target `tier:` or `addon:` (a base code mints a licence, an add-on code a grant). Never `addon` licences. The device route rides the LX-18 train. Depends on LX-33.                                                                                                                                                                                   |
| LX-06                           | edit   | LX-32          | Done. The follow-up removal of three settings is LX-32.                                                                                                                                                                                                                                                                                                     |
| I-24a                           | edit   | LX-18          | Keeps the Worker, console and portal. Its contract, corpus and client-core rows join the LX-18 plan.                                                                                                                                                                                                                                                        |
| I-24b                           | merge  | LX-19          | One SDK wave.                                                                                                                                                                                                                                                                                                                                               |
| CM-01                           | edit   |                | Deferred plan text: subscriptions are Core `subscriptions` (LX-23a). `dist_subscriptions` keeps only provider references. `dist_offers` targets `tier:` / `addon:`; a consumable offer carries a quantity. W4 lands in LX-18. `renewalBufferHours` becomes a constant.                                                                                      |
| CM-04                           | edit   |                | Offers reference a tier or add-on; no inline `grants_json` entitlements.                                                                                                                                                                                                                                                                                    |
| CM-08                           | edit   | LX-23a         | Depends on LX-23a (not LX-23). Writes renewals through `core/subscriptions.ts`.                                                                                                                                                                                                                                                                             |
| CM-14                           | edit   |                | W4 (`polaris-key` enum) moves into LX-18. Keeps W1–W3. Still deferred.                                                                                                                                                                                                                                                                                      |
| CM-15                           | edit   |                | `purchase()` of a consumable add-on hands off to `consume` after fulfilment (with LX-36). Still deferred.                                                                                                                                                                                                                                                   |
| UK-25                           | edit   | LX-23b         | Subscription products need LX-23b. Before that, scope to non-consumable add-ons. Entitlement mapping by add-on id.                                                                                                                                                                                                                                          |
| I-14                            | edit   |                | Steam DLC app ids map to add-ons (LX-33), not raw flags.                                                                                                                                                                                                                                                                                                    |
| PS-07                           | keep   |                | `store_owned` reads the mapping target.                                                                                                                                                                                                                                                                                                                     |
| U-04 / U-06 (cloud sync limits) | edit   | LX-34          | Cross-domain: `sync.*` platform entitlements replace `cloudSync.limits.byTier` / `byEntitlement` (the Cloud Sync auditor owns the decision).                                                                                                                                                                                                                |

---

## New work packages

| id         | title                                                                                              | deps                 | plan mode | scope                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LX-32**  | Licensing settings reduction                                                                       | LX-06                | no        | Remove `licensing.entitlementHolder`, `anchorPolicy` and `reanchor` from the registry, manifest (rule 9 deprecation warnings) and console. Turn `entitlementModel` into a migration card driven by the holder report. Show `refundGraceHours` and `dunningGraceDays` only when a purchase or subscription source exists. Move `clampGraceToExpiry` to advanced. `gen settings --check`.                                                                            |
| **LX-33**  | Add-on definitions and one issuance path                                                           | LX-08                | **yes**   | `licensing.addons[]` (rule 9; claimable). `addons` table (License-owned). `grants.addon_id`. Resolver reads add-on keys live. `core/issuance.ts` `grantTo(holder, target, source)` (moves `issueFromPath`'s tier branch down). Console Add-ons collection and record (Sold as, Comp to…, holders). Product-scope cache version bump on edits. OpenAPI and `routeCoverage`.                                                                                         |
| **LX-34**  | Tier entitlements, config-only profiles and the Entitlements overview                              | LX-09                | no        | `tiers.entitlements_json` plus manifest `licensing.tiers[].entitlements` (rule 9). Exact migration of profile entitlement buckets for `combined` products. Validator warning, then refusal, of flags in profiles. One `kind` field in the catalog (rule 9, mutation table). Platform entitlement registry (`reservedNames.ts` → service-aware rows, `sync.*`). Tier record v2 sections. License → Entitlements page.                                               |
| **LX-23a** | Terms and subscriptions core: `onExpiry`, perpetual fallback, `licenseState`, Core `subscriptions` | LX-09, LX-12         | **yes**   | `tiers/licenses.on_expiry`, `licenses.fallback_version`, the lapse tick and freeze through `releaseCatalog` (`devices.app_version` fallback). `licenseState` replaces `licenseUsable` with a per-gate table. Core `subscriptions` with `manual`/`external` sources, renew, cancel and dunning (unhides `dunningGraceDays`). Admin API (rule 10). Console subscription panel, Renew…, Preview at a date…. Portal term data. Lapse emails (I-18). THREAT-MODEL rows. |
| **LX-23b** | Store subscriptions: Apple auto-renewables and Play subscriptions                                  | LX-23a, LX-11        | **yes**   | App Store Server Notifications (SUBSCRIBED, DID_RENEW, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED, EXPIRED, REFUND) and Play `subscriptionsv2` states mapped onto `subscriptions`. Base mapping → licence, add-on mapping → grant. Billing grace → `past_due`. Restore. Transcripts. A-17e creates auto-renewable products from add-on and tier mappings.                                                                                                             |
| **LX-35**  | Version-bounded licensing and automatic re-anchor                                                  | LX-10, LX-23a        | no        | Absorbs LX-21. Major-line windows ("1.x" helper in the console and manifest, normalized). Version-aware preselection. Re-anchor on refresh when the build leaves the anchor (covering licence, free seat) and when the anchor is superseded. Portal "Run this device on" (rule 10). "First release of a new major" callout through the `releaseCatalog` hook with **Start a 2.x tier…**.                                                                           |
| **LX-36**  | Quantities and consumables                                                                         | LX-33, LX-11, LX-18  | **yes**   | `grants.quantity`. `grant_consumptions` ledger. Consume, reverse and acknowledge semantics. Device routes (in the LX-18 train) and developer-backend routes. Play consume and Apple consumable claims. A-17e consumable IAP type. Console and portal delivery status. `errors.json` codes. Parity rows. THREAT-MODEL (replay, refund after consume). Optional: dispatch on the owner's go.                                                                         |
| **LX-37**  | Licensing model presets, examples and onboarding                                                   | LX-34, LX-23a, LX-35 | no        | The "Choose how you sell it" step in the Licensing quick start (6 presets). Portal preview per preset. Per-model code samples with the product's real keys in the Integration section. Store-import → add-ons offer. Manual-renewal attention items. Docs pages (`/docs/services/license/model/` terms, add-ons, fallback).                                                                                                                                        |

---

## Quick wins

1. **Fix the portal promise now.** In `LicenseCard.tsx:154-158,178`, a licence with `onExpiry`
   absent (all of them today) should read "Access until 3 Mar" / "Ended 3 Mar", and the expired
   copy should be "Renew with <developer> to keep using it". "Updates included" and "renew to get
   newer versions" return with LX-23a's `keepVersion`. PORTAL.md §5.3 should be amended to match.
2. **Hide the settings that do nothing.** On License → Settings, mark `entitlementHolder`,
   `anchorPolicy` and `reanchor` (and `entitlementModel` until LX-09) as pending, as
   `dunningGraceDays` already is. They are slated for removal in LX-32.
3. **Rename the licence tab** "Config overrides" → **"Entitlements"** (`LicenseRecord.tsx:387`).
   Since U-03 it edits entitlement overrides only. Collapse LX-14's planned Entitlements and Grants
   tabs into it.
4. **Amend LX-08 before merge:** `holder_versions` CHECK allows `'product'`
   (`0105_a_licensing_core.sql:123`). It is one word now, versus a table rebuild later.
5. **Amend the LX-09 and LX-10 briefs before dispatch:**
   - anchor-only version window;
   - one `kind` field instead of `combine` + `entitlementKind`;
   - no `owner` holder;
   - version-aware preselection.

   All of these are still `todo`, so the cost is zero now.

6. **Fix the rule text** in `packages/shared-manifest/src/reservedNames.ts:65,70` ("the higher of
   the tier's and the license's minimum", "the lower of … maximum": the code intersects,
   `W/core/authz.ts:150`). Correct S-19 §4.2 with a dated note.
7. **Fix the data-model generator** (docs domain). `data-model.mdx:64` omits `tiers.channels_json`,
   `min_version` and `max_version` because `0002_channels.sql:9-11` aligns `ALTER TABLE tiers    ADD`
   with extra spaces.
8. **Glossary:** "tier — a named plan" → "a named licence template" (`concepts.md:192`; rule 4 says
   "Tier, not plan").
9. **UK-25 brief:** scope to non-consumables until LX-23b; otherwise its `SubscriptionStoreView`
   has no server side.

---

## Cross-domain dependencies

- **Config:**
  - Profiles become config-only (LX-34).
  - Licence profile stacks (`license_profiles`) have no entitlement role left. Since U-03 moved
    licence config overrides to the account, the config domain should decide whether licence-level
    profile stacks survive at all.
  - The owner's "user > license > config profile > defaults" conflicts with U-03 (no licence-level
    config any more).
  - The catalog editor and page show `config`/`secret`, with entitlements linked to License →
    Entitlements.
- **Identity / sign-in / auto-mint:**
  - `entitlementHolder: device` only (T9) depends on the owner's "bound licences need sign-in"
    (D24's `identity.keyEntryRefusals`, today default off; S-24 H11). The identity domain decides
    the default.
  - OIDC claim → add-on and group → tier (highest rank) are the provisioning targets.
  - Auto-mint and Discover choose a **tier**.
  - "Automatic Grant" copy for `oidc` sources.
- **Licences and holders (S-24, LX-26…LX-31):**
  - The New License wizard's Limits step gains "When it ends" (`onExpiry`) and, for manual
    subscriptions, "Renews every …".
  - The licence record tab set changes (one Entitlements tab).
- **Commerce and storefronts (S-21, S-22, P6-01):**
  - Mappings and offers target tiers and add-ons.
  - Core `subscriptions` underpins CM-08 and LX-23b.
  - Consumable store support (Play consume).
  - "Commerce off ⇒ subscriptions still work" is satisfied here.
  - The store setup wizards create add-ons from imported IAPs.
- **Release, Distribution and Update:**
  - `releaseCatalog` supplies the fallback version and new-major detection.
  - The owner's preconfigured `stable`/`beta`/`dev` channels feed the tier editor's channel
    picker.
  - Portal downloads for lapsed licences.
- **Cloud Sync:**
  - `sync.storageBytes` / `sync.saveSlots` as platform `quantity` keys replace
    `cloudSync.limits.byTier` and `.byEntitlement`.
  - `requiresFlag` reads the resolver (U-01, already planned).
  - The developer-backend wallet for consumables (U-16 `ownerRead` collections).
- **Settings (ST-\*):**
  - LX-32 removes registry rows (`gen settings`, `NOT_A_SETTING`).
  - `visibleWhen` "purchase source exists".
  - Product-scope settings remain claimable.
- **Wire, conformance and SDKs:**
  - The LX-18 train merges I-24a's wire half, LX-25's route and LX-36's routes. All of this is
    plan mode, under the `PROTOCOL_VERSION` 4 precedent, with an appended corpus.
  - LX-19 targets UK-03 ui-core, so the UK-13/UK-14 terminal kits and the native kits inherit the
    term and add-on views.
- **Products and onboarding:** licensing presets in the product wizard and quick start (UX-63);
  per-model integration code samples.
- **Portal:** the LicenseCard term line, the add-on list, the "Automatic Grant" label, and the
  PORTAL.md §5.3 status additions (Renewing, Past due, Updates ended).
- **Docs:** the data-model generator spacing bug; glossary entries; the `reservedNames` rule text.

# Audit: licensing core — binding, floating, account association, automatic licences, tiers and the metadata chain

> DX consolidation audit, 2026-10-07. Domain: `services/license/*`, Core's licence, device and
> entitlement code, account association and claim (Identity accounts and portal), auto-issue and
> OIDC group minting (`oidc.ts` `activateFromIdentity`, `autoIssue`, `groupRoleMap`), Discover
> self-mint (PS-03, PS-04), device auto-attach, tiers and licence policy, and the LX program
> (LX-05b to LX-16, LX-27, LX-29 to LX-31; LX-18 to LX-25 are shared with the
> entitlements-and-subscriptions audit). Read-only: no product code was changed.
>
> Tree: `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5). In-flight branches read:
> `wp/LX-08-licensing-expand` (in review), `wp/HA-12-presentation-discovery`,
> `wp/UK-13-python-terminal`, `wp/UK-14-node-terminal` (fix round). Paths below are relative to the
> repository root; `W/` = `packages/worker/src/`, `A/` = `packages/admin/src/`, `M/` =
> `packages/worker/migrations/`, `P/` = `docs/research/2026-09-29-godot-omniplatform/program/`,
> `N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`. "Licence" in prose, `license` in
> identifiers and UI copy (AGENTS.md rule 4).

## Summary

The licence itself is in good shape: one row per access contract, keys stored only as peppered
hashes, seats claimed atomically by the database, floating and assigned holders derived rather than
stored (LX-26), bulk floating keys (LX-28), a per-licence device limit (LX-14a) and an offline grace
clamp (LX-07, in review). What is not in good shape is everything **around** the licence:

1. **The rules for who gets a licence automatically are spread over six stores and three
   services.** They have different owners (manifest only, claimable, portal toggle), and the
   console cannot edit the two that matter most: `autoIssue` has no editor, and `groupRoleMap` is
   manifest-only. The console even sends operators to an Enrollment page that has no auto-issue
   control.
2. **Automatic licences are keyed by an OIDC subject, not by the account.** `activateFromIdentity`
   writes `licenses.sub` and never `account_id`, and a portal sweep attaches the licence later.
   Discover can self-mint only for accounts that hold a link at the **platform** IdP. Since I-17
   that IdP is becoming operator-only, so new customers effectively cannot self-mint. The owner's
   "mint for everyone, and see it in the portal" does not work end to end today.
3. **The licensing metadata chain has a different rule for every field.** Device limit is licence,
   then tier, then entitlement, then product. Channels are a union. The version window is an
   intersection. Expiry is copied once at creation. Offline days skip the tier. The fingerprint
   mode is tier-only and invisible in the console. The config profile is a tier profile plus an
   ordered per-licence profile stack. The chain is computed in four places: three Worker routes
   plus a client-side copy in the console.
4. **The LX program adds configuration surface instead of removing it.** LX-06 shipped seven
   per-product `licensing.*` settings. Only one does anything, and the console shows the other six
   with "they take effect as each part ships". The OC model in flight (LX-08: 13 migrations and
   about 3,900 lines; then LX-09 to LX-16) builds three grant-holder kinds, a permanent
   legacy/combined mode switch, anchor policies and re-anchor modes. That is for a product estate
   whose only in-repo licensed product is `djdl`.

**The single most important change** is to replace the six automatic-licence stores with **one
Access policy** (`license.access`), evaluated by **one issuance function** that writes the
account (`account_id`) directly. That function would serve product sign-in, the login card and
passthrough, Discover and email-domain rules. The policy has three modes: refuse, everyone, or
rules by group, email domain or claim, each rule naming a tier. That one change delivers the
owner's Automatic Minting section and fixes Discover for every account. It also deletes five
settings and two console dead-ends, and it is not a wire change.

The rest of the target follows the owner's direction. Each rule below is listed with what it
replaces:

- **One rule for the metadata chain:** `licence > tier > product` for every field, computed by one
  resolver.
- **Tiers that are what they say:** a rank, a config profile, entitlements and licence terms.
- **Bound licences need sign-in on Identity products:** the existing `license_owned` refusal
  becomes on by default once the SDK UIs ship.
- **Sub-licences are grants held by the licence:** the account-held and store-identity holders and
  the cross-licence "combined" mode are deferred.
- **Seven licensing settings are retired.**

## 1. Current state (with file references)

### 1.1 Data model

| Object                                     | What it holds                                                                                                                                                                                                                                                                          | Source                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `licenses`                                 | `status` (active/disabled), `sub`, `name`, `email`, `groups_json`, `tier_id`, `activated_at`, `expires_at`, `max_offline_days`, `overrides_json`, `channels_json`, `min_version`, `max_version`, `origin` (admin/oidc/enroll), `enroll_hwid`, `account_id`, `device_limit`, `batch_id` | `M/0001_init.sql:64-82`, `M/0011`, `M/0068_b`, `M/0084`, `M/0095_b`; `W/repo.ts:81-116` |
| `idx_licenses_sub` UNIQUE `(product, sub)` | at most one OIDC-subject licence per product                                                                                                                                                                                                                                           | `M/0001:82`, `M/0012`                                                                   |
| `tiers`                                    | `label`, `profile_id`, `policy_expiry_days`, `policy_device_limit`, `channels_json`, `min_version`, `max_version`, `policy_fingerprint`, `source`                                                                                                                                      | `M/0001:51-61`; `W/repo.ts:193-210`                                                     |
| `profiles`, `license_profiles`             | managed-payload baselines (config, secrets **and** entitlements in one JSON); an **ordered stack** of profiles per licence                                                                                                                                                             | `M/0001:39-48`, `M/0004`                                                                |
| `keys_index`                               | many keys per licence, hashes only                                                                                                                                                                                                                                                     | `M/0001:85-96`                                                                          |
| `license_auto_attach_blocks`               | "never auto-attach this licence to this account again" (LX-26, D19)                                                                                                                                                                                                                    | `M/0092`                                                                                |
| `license_batches`                          | bulk floating keys (LX-28)                                                                                                                                                                                                                                                             | `M/0095_a`                                                                              |
| `license_key_entries`                      | key-entry counter for licences in no account on Identity products (PX-W9)                                                                                                                                                                                                              | `M/0100`                                                                                |
| `license_relinks`                          | relink, Make floating and Reassign, with a 72-hour undo (I-12, LX-30)                                                                                                                                                                                                                  | `M/0082`, `M/0104`                                                                      |
| `license_refusals`                         | refused activations, kept 30 days (UX-15)                                                                                                                                                                                                                                              | `M/0074`                                                                                |
| `account_overrides`                        | per-account config and secret layer that replaced licence config overrides (U-03)                                                                                                                                                                                                      | `M/0103`                                                                                |
| `oidc_config.group_role_map_json`          | `{group: {role, tier?}}`; `role` is never read by the licensing code                                                                                                                                                                                                                   | `M/0001:130`; `W/services/identity/oidc.ts:782-829`                                     |
| `provisioning_config`                      | an OIDC claim gives an entitlement key or a secret URL                                                                                                                                                                                                                                 | `M/0001:134-143`                                                                        |
| `products.*`                               | `default_device_limit`, `default_max_offline_days`, `fingerprint_policy_json`, `auto_issue_json` + `auto_issue_source`, `admin_group`                                                                                                                                                  | `M/0001`, `M/0011`                                                                      |
| `portal_product_settings`                  | `auto_link_enabled`, `claim_by_key`, `key_reissue_enabled`, `discover_enabled`, `store_listed`/`audience`/`offer_paths`/`group_labels`                                                                                                                                                 | `W/services/identity/portal/repo.ts:62-69`                                              |
| `portal_license_links`                     | legacy owner links, now only deleted (contract after I-17)                                                                                                                                                                                                                             | `W/services/identity/accounts/legacy.ts`                                                |
| **LX-08 (in review)**                      | 13 migrations `0105_a`–`0105_m`: `grants`, `grant_entitlements`, `device_store_identities`, `holder_versions`, `entitlement_events`, `licenses.kind/ended_reason/superseded_by/source/external_ref_hash`, `tiers.rank/policy_offline_grace_days`, `dist_*` columns and tables          | `wp/LX-08-licensing-expand`; `W/core/grants.ts` (845 lines)                             |

### 1.2 Binding: who owns a licence

Three ownership facts live side by side:

- **`licenses.account_id`** (I-05). It is the real owner pointer, written only through
  `W/core/accountSubjects.ts`, and NULL means floating.
- **`licenses.sub`**, the OIDC subject. `activateFromIdentity` writes it, and it is the key for
  idempotent re-sign-in (`getLicenseBySub`, `W/repo.ts:894-903`). Auto-minted licences have
  `sub` and **no** `account_id` (`W/services/identity/oidc.ts:1266-1284`).
- **`licenses.email`.** It turns a licence into "assigned, waiting" until an account verifies that
  address (LX-26, `W/core/licenseHolders.ts:1-74`).

The holder is derived (S-24 D1): **floating** means no account and no email; **assigned** means an
account, or an email that is still waiting. The `sub` → account join happens later, in the portal's
link sweep (`syncAccountLicenseLinks`, `W/services/identity/portal/repo.ts:556-583`). The sweep
runs on portal requests (`portal/api.ts:583,708,1487`), and only for products on the **platform**
issuer with auto-link on (`AUTO_LINK_ENABLED_SQL`, `portal/repo.ts:374-388`). A custom-issuer
product's `sub` licences never join an account.

Every licence the console created before the New License wizard carries an email, because
`validateHolder` required name and email (`A/console/pages/license/CreateLicenseDialog.tsx:95-101`).
So almost every existing licence is "assigned" (in an account or waiting).

### 1.3 How licences come into existence

| #   | Path                                                                                                                                                              | Code                                                                      | Keyed by                               | Key minted         | Device bound             | Joins an account                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | ------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| 1   | Console or API, single                                                                                                                                            | `W/services/license/admin/licenses.ts:300-410`                            | id                                     | yes, returned once | no                       | at creation when an account already verified the email (`associateLicenseHolder`) |
| 2   | Console or API, batch (≤ 500 floating)                                                                                                                            | `W/services/license/batches.ts`, `admin/batches.ts`                       | id + `batch_id`                        | yes, returned once | no                       | never (floating)                                                                  |
| 3   | Anonymous enroll (`autoIssue.mode` `anonymous`/`both`)                                                                                                            | `W/services/license/enroll.ts:60-140`                                     | `enroll_hwid` (unique)                 | no                 | yes                      | at claim/migrate on a later sign-in                                               |
| 4   | Product OIDC sign-in (`/<p>/identity/auth/*`)                                                                                                                     | `oidc.ts` `activateFromIdentity:1091-1287`, policy `identityTier:782-829` | `sub` (unique)                         | no                 | yes (`authorizeAndMint`) | later, by the portal sweep, platform issuer only                                  |
| 5   | I-26 chooser on that sign-in (platform product, account holds licences)                                                                                           | `W/services/identity/licenseChoice.ts`                                    | existing licence                       | n/a                | yes                      | already in the account                                                            |
| 6   | Discover "Add to library"                                                                                                                                         | `W/services/identity/portal/discover.ts:470-560` → `activateFromIdentity` | the account's **platform-IdP subject** | no                 | no (next sign-in)        | by `sub`, through the sweep                                                       |
| 7   | Claim or migrate of an enrolled licence on sign-in                                                                                                                | `oidc.ts:1145-1257`, `W/core/licenseMerge.ts`                             | existing row                           | no                 | moves devices            | as path 4                                                                         |
| —   | Planned: store base mapping (LX-11), checkout (CM-05), redeem (LX-25), card and passthrough (I-08), store-owned, product-IdP and email-domain paths (PS-07/08/09) | —                                                                         | —                                      | —                  | —                        | —                                                                                 |

Discover's identity paths need `discoverIdentity` (`W/services/identity/portal/store/obtain.ts:326-363`),
which reads the account's `account_links` row at the `PLATFORM_OIDC_*` issuer. The module header
says so directly: "an account with no platform identity (one that has only ever used an email link)
gets no identity path" (`discover.ts:41-48`). I-17 moves end users off that IdP
(`W/services/identity/accounts/platformMigration.ts:1-50`, modes `claim` → `operators-only`). New
customers who sign in with email, a passkey, Google, Apple or Steam therefore never get a group or
auto-issue offer on Discover.

### 1.4 The automatic-licence policy: where each part lives

| Part                                                | Storage / registry key                                                                                                            | Owner service       | Authority                                            | Console surface                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who gets a licence with no group; anonymous devices | `products.auto_issue_json`, `license.autoIssue` `{enabled, tierId, mode, rateLimitPerHour}`                                       | License             | claimable (`W/services/license/settings.ts:103-124`) | **none.** `PATCH …/license/policy` exists (`W/services/license/admin/policy.ts`), but `EnrollmentPage.tsx` edits fingerprint and probes only; ST-12 plans an editor |
| Group → tier                                        | `oidc_config.group_role_map_json`, inside `identity.oidc`                                                                         | Identity            | **manifest only**                                    | read-only table on Identity → Sign-in (`A/console/pages/identity/SignIn.tsx:224-335`), with an unused **Role** column                                               |
| Upgrade an existing licence on sign-in              | `identity.oidc.syncTierOnSignIn` (`off` / `upgradeOnly`)                                                                          | Identity            | claimable row                                        | Identity → Sign-in → Tier sync                                                                                                                                      |
| Claim → entitlement or secret                       | `provisioning_config`, `identity.provisioning`                                                                                    | Identity            | manifest                                             | none                                                                                                                                                                |
| Show on Discover                                    | `discover_enabled`, `storefront.polarisKey.{listed,audience,offerPaths,groupLabels}`                                              | Identity / portal   | toggles and registry                                 | Identity → Portal → Discover; Storefronts → Polaris Key → Ways to add and Group labels (`A/console/areas/storefronts/PolarisKeyPanel.tsx:482-530`)                  |
| Email domains                                       | `autoIssue.emailDomains` (PS-09, todo)                                                                                            | —                   | manifest                                             | —                                                                                                                                                                   |
| Key entry on floating licences                      | `identity.keyEntry.limit` (product) plus a platform ceiling, and the platform switch `identity.keyEntryRefusals` (off by default) | Identity / platform | claimable / operator                                 | Identity settings; platform settings                                                                                                                                |

Two dead ends in the console:

- Identity → Sign-in says "A signed-in account in no mapped group gets the auto-issue default
  tier" and links to **"Auto-issue in Enrollment"** (`SignIn.tsx:340-348`). The Enrollment page
  has no auto-issue control.
- The Polaris Key storefront's empty state says "Map an IdP group or turn on auto-issue for
  signed-in people in the product's sign-in" (`PolarisKeyPanel.tsx:498`). The console can do
  neither.

### 1.5 Tiers and the licensing metadata chain today

| Field          | On the licence                            | On the tier                                                                            | Product default                        | Rule today                                                                                              | Code                                                                                             |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Expiry         | `expires_at` (a date)                     | `policy_expiry_days` (a duration)                                                      | none                                   | **copied once** at create or re-tier (`tierExpiresAt`)                                                  | `W/core/authz.ts:231-236`; `admin/licenses.ts:313-319`                                           |
| Device limit   | `device_limit` (LX-14a)                   | `policy_device_limit`                                                                  | `default_device_limit`                 | licence > tier > **a `deviceLimit` entitlement from a profile, store grant or override** > product      | `W/core/authz.ts:257-290`; `W/core/entitlements.ts:218-221`                                      |
| Offline days   | `max_offline_days`                        | **none** (LX-08 adds `policy_offline_grace_days`; nothing reads it)                    | `default_max_offline_days`             | licence > product, repeated in three routes                                                             | `W/services/license/document.ts:136`, `identity/browserSession.ts:302`, `config/document.ts:144` |
| Channels       | `channels_json`                           | `channels_json`                                                                        | `stable`                               | **union** of tier and licence, replacing any profile or override value                                  | `W/core/entitlements.ts:207-216`                                                                 |
| Version window | `min_version`, `max_version`              | same                                                                                   | `compat_min`, `compat_max`             | **intersection**: the tighter value wins in both directions (`tighterMin`/`tighterMax`, `authz.ts:150`) | `W/core/entitlements.ts:223-235`                                                                 |
| Fingerprint    | —                                         | `policy_fingerprint` (**manifest only**: not in the tier API or the console tier form) | `fingerprint_policy_json`              | tier > product                                                                                          | `W/core/authz.ts:304-316`; `W/services/license/admin/tiers.ts`                                   |
| Config profile | `license_profiles` (an ordered **stack**) | `profile_id`                                                                           | catalog defaults                       | tier profile → each licence profile → …                                                                 | `W/core/payload.ts:160-185`                                                                      |
| Entitlements   | `overrides_json.entitlements`             | none of its own: whatever its **profile's** `entitlements` bucket holds                | catalog flag default (the portal only) | merged layers, then `injectAdminPolicy`                                                                 | `W/core/payload.ts:1-30,160-195`                                                                 |

The console repeats the chain on the client in `effectivePolicy`
(`A/console/pages/license/shared.tsx:247-360`). It already disagrees with the Worker: it prints
"Unlimited" for a limit ≤ 0 (`shared.tsx:283`), which the Worker refuses since R11-02
(`W/core/authz.ts:431`). The setting description for `license.defaults.maxOfflineDays` says
"when neither its tier nor the licence sets a window" (`W/services/license/settings.ts:59`), but a
tier cannot set one.

### 1.6 The licensing-model settings (LX-06)

`W/services/license/licensingSettings.ts` registers seven claimable product settings:
`entitlementModel` (`:70`, with a default derived from the product's creation date,
`COMBINED_ENTITLEMENT_MODEL_SINCE` at `:66`), `entitlementHolder` (`:98`), `clampGraceToExpiry`
(`:121`), `anchorPolicy` (`:145`), `reanchor` (`:166`), `refundGraceHours` (`:188`) and
`dunningGraceDays` (`:214`, hidden). Only `clampGraceToExpiry` changes behaviour today (LX-07).
The console page shows the other five and says "The other settings take effect as each part of
the licensing model ships; until then devices keep today's behaviour"
(`A/console/pages/license/LicenseSettingsPage.tsx:100-104`). The passthrough hard-codes `legacy`
whatever the setting says (`W/services/identity/passthrough/anchor.ts:35-45`).

### 1.7 Four ways to rank an account's licences

- **The I-26 chooser:** no expiry first, then the latest expiry, then the oldest
  (`W/services/identity/licenseChoice.ts`).
- **The portal Library:** `STATUS_RANK` (`W/services/identity/portal/library.ts:91-97`).
- **The passthrough consent line:** the portal order (`passthrough/anchor.ts:66-100`).
- **LX-10's planned ranking:** `rankAnchorCandidates` (`tiers.rank` first,
  `P/plans/LX-01.md` §2.4), which PX-14's `LicenseChoiceStep` will also read.

These four can disagree about which licence comes "first".

### 1.8 Console and portal surfaces

- **Console, License section:** Licenses (list, record, holder dialogs), Tiers, Enrollment,
  Settings and Batches (`A/console/pages/license.tsx`). The licence record's Terms form holds tier,
  expiry, offline days, channels, versions and an **ordered profile picker**
  (`A/console/pages/license/LicenseTerms.tsx:40-60`).
- **Console, related pages:** Identity → Sign-in (the group table, read-only, and tier sync).
  Identity → Portal (claim by key, key reissue, Discover). Storefronts → Polaris Key (ways to add,
  group labels, persona preview, PS-06).
- **Portal:** Library, product page, Licence card with "License source"
  ("From signing in", `A/portal/model/library.ts:296`), Activate license, Remove from library and
  Discover.

### 1.9 In flight

- **LX-07** (grace clamp; in review).
- **LX-08** (in review): the grants expand, dual-write, `oidc` grant move, highest-rank group
  choice and `syncTierOnSignIn` upgradeOnly.
- **LX-30** (holder surfaces; in review).
- **UK-13 and UK-14** (terminal kits). Their activation flows render key-only and signed-in
  AccountAndLicense, `license_owned` and `key_entry_limit` (`packages/sdk-node/src/cli/models.ts`
  on `wp/UK-14-node-terminal`), so the refusal semantics below already have kit copy.
- **HA-12** (presentation in discovery). It does not touch licensing.

## 2. Problems (ranked)

| #   | Problem                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                             | Impact |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | **Automatic licences are keyed by OIDC subject, not account; Discover self-mint dies with the platform IdP**   | `oidc.ts:1266-1284` writes `sub`, no `account_id`; the sweep attaches later and only on the platform issuer (`portal/repo.ts:556-583`); Discover needs a platform-IdP link (`store/obtain.ts:326-363`, `discover.ts:41-48`); I-17 makes that IdP operator-only (`platformMigration.ts:1-50`)                         | high   |
| P2  | **The automatic-licence policy is split over six stores with mixed authority, and the console cannot edit it** | §1.4; no auto-issue editor; `groupRoleMap` manifest-only; dead link at `SignIn.tsx:340-348`; impossible instruction at `PolarisKeyPanel.tsx:498`; PS-09 adds a seventh (`autoIssue.emailDomains`)                                                                                                                    | high   |
| P3  | **Settings that do nothing are shown, and the program keeps adding knobs**                                     | five of seven `licensing.*` settings have no effect (`LicenseSettingsPage.tsx:100-104`); `entitlementModel` has a date-derived default (`licensingSettings.ts:66`); the plan adds `anchorPolicy`, `reanchor`, `entitlementHolder`, `refundGraceHours`, `dunningGraceDays`                                            | high   |
| P4  | **The metadata chain has a different rule per field and four implementations**                                 | §1.5: union, intersection, snapshot, an entitlement-sourced device limit, no tier offline days; the console copy `shared.tsx:247-360` already disagrees (`:283`); offline fallback in three routes                                                                                                                   | high   |
| P5  | **Bound licences do not require sign-in**                                                                      | `identity.keyEntryRefusals` is a platform switch, default off (`W/core/settings/platform.ts:256-279`), so a licence in an account still activates new devices by key (S-24 H11); the owner's model says bound means sign in                                                                                          | medium |
| P6  | **The OC model in flight is much bigger than the product needs**                                               | LX-08: 13 migrations, `core/grants.ts` 845 lines, three holder kinds, `holder_versions`, `device_store_identities`; LX-09: permanent `legacy`/`combined` modes, contributors, holder report; one licensed in-repo product (`products/djdl/product.json`)                                                             | medium |
| P7  | **Tiers mix config and entitlements and hide fields**                                                          | tier entitlements live in the tier **profile's** `entitlements` bucket (`W/core/payload.ts`); `policy_fingerprint` is invisible in the API and console; no rank; no offline days; the group map's `role` is unused for licences (`oidc.ts:782-829`)                                                                  | medium |
| P8  | **The per-licence profile stack is an extra config layer**                                                     | `license_profiles` (`M/0004`) with an ordered picker (`LicenseTerms.tsx`), and LX-29 still plans "profiles in order"; the owner's model is tier → one profile                                                                                                                                                        | medium |
| P9  | **Four licence rankings**                                                                                      | §1.7                                                                                                                                                                                                                                                                                                                 | medium |
| P10 | **Three ownership pointers**                                                                                   | `sub`, `account_id`, `portal_license_links` (§1.2); `idx_licenses_sub` is still unique                                                                                                                                                                                                                               | medium |
| P11 | **The key-entry limit is a second seat concept with three knobs**                                              | `W/core/keyEntries.ts:1-33`; `identity.keyEntry.limit` (`W/services/identity/settings.ts:77`), its platform ceiling (`W/core/settings/platform.ts:281`) and the switch                                                                                                                                               | low    |
| P12 | **Provenance has several vocabularies**                                                                        | `origin` admin/oidc/enroll; portal kinds developer/sign_in/free/store (`W/services/license/provenance.ts:43-48`); S-24 D21 strings; LX-08 adds `source`, `kind`, `superseded_by`; batch licences stay `origin = admin`                                                                                               | low    |
| P13 | **Copy and description drift**                                                                                 | "From signing in" where the owner asks for "Automatic grant" (`A/portal/model/library.ts:296`); the offline description (`settings.ts:59`); ADMIN.md §6.5.2 "Blank uses the tier or product default"; the glossary says "license — a grant of entitlements" (`packages/docs/src/content/docs/start/concepts.md:182`) | low    |
| P14 | **Console RBAC is mixed into licensing**                                                                       | `groupRoleMap.role` (`admins: {role: "admin"}` in `products/djdl/product.json:38-46`) mints a tier-less licence for admins, and `products.admin_group` sits beside it                                                                                                                                                | low    |

## 3. Owner brief: item-by-item stance

| #   | Brief item                                                                                                   | Stance                 | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Licences cleaned up and simplified; too many layers and too much comingling                                  | adopt                  | This audit removes nine settings, one config layer (the licence profile stack), two ownership pointers, three of the four rankings and three of the four chain implementations (§5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B2  | Console-created licences are either bound to an account or free-floating                                     | adopt                  | Built (S-24, LX-26, LX-28, LX-30). The wizard (LX-29) keeps the two cards: **Someone specific** and **Anyone with the key**. "Floating" is the console word; customers never see it (S-24 D5).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B3  | Bound licences need to sign in to the account to use the licence                                             | adapt                  | On **Identity products**, a licence **in an account** refuses its key on a new device with the existing `license_owned` + `signInUrl` (I-09). It becomes the default once the SDK UIs that render it ship (I-10a/b, UK-42/43), and the `identity.keyEntryRefusals` switch is then deleted. Devices already activated keep running (S-24 D22). A licence still **waiting** on its email accepts the key until the email is verified, because that is how a buyer with a key gets started. **Without Identity**, binding is portal-only (Library, downloads, recovery) and the key stays the device credential: graceful degradation, not a dead end. |
| B4  | Floating licences work as-is or can be added to an account; they may stay floating                           | adopt                  | Built: key activation, the portal's Activate license, "Add your name and email" in the kits (UK-42/43). "Continue without an account" stays first-class (S-24 D13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B5  | Account association: an existing account automatically receives the licence and sees it in the portal        | adopt + fix            | True for console-created licences (LX-26 association at creation and on email verification). **Not true for automatic licences**: they are keyed by `sub` and attached lazily, platform issuer only (P1). LX-36 writes `account_id` at mint.                                                                                                                                                                                                                                                                                                                                                                                                        |
| B6  | Association gives a central view of apps, cloud saves and anything else account-bound                        | adopt                  | One "What being in an account gives you" list, used by the console, portal and kits (S-24 §5.8): Library, downloads, recovery by any sign-in method, freeing and replacing devices yourself, Cloud Sync (on signed-in devices), the account config layer (U-03) and feed tokens (cross-domain). The kits' recommendation already lists only what the product really has (S-24 D14).                                                                                                                                                                                                                                                                 |
| B7  | Automatic minting: everyone / by OIDC groups / reject                                                        | adopt (consolidate)    | One **Access policy** (`license.access`, §4.4): `everyone: <tier>` (or absent to refuse) plus `rules[]` by group, email domain or claim, each naming a tier. The highest tier rank wins. It replaces six stores (P2).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B8  | Configure the licence everyone gets and per-group mappings                                                   | adopt                  | The `everyone` tier and each rule's tier, editable in the console (LX-35b) and in `.pkey/product` (`access:`); claimable like every setting (S-18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B9  | A licence minted at login attaches the device automatically; no key is generated; an admin can add one later | adopt                  | Already true for product sign-in (`activateFromIdentity` mints no key; `authorizeAndMint` binds). The card and passthrough (I-08) must use the same issuance function (LX-36). An admin mints a key from the record's Keys tab (`W/services/license/admin/keys.ts`).                                                                                                                                                                                                                                                                                                                                                                                |
| B10 | The first two modes also show the app on Discover for self-mint, identical to minting at use time            | adopt + fix            | Discover already uses the sign-in policy function (THREAT-MODEL "Discover grants nothing a sign-in would not"), but only for platform-IdP accounts (P1). Under LX-36 Discover mints through the same account-keyed function for **every** account. Discover visibility is one switch on the Access policy (`discover`). The per-kind `offerPaths` toggles go away for identity rules (cross-domain: storefront audit).                                                                                                                                                                                                                              |
| B11 | Heavily clean up tiers: config profile (not overridable at tier level), entitlements, licensing details      | adopt                  | A tier is: label, rank (its place in the list), optional config profile (config only), **its own entitlements**, and licence terms (term, device limit, offline days, channels, version window, fingerprint mode). LX-34.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B12 | Config flow: user (if set) > licence > config profile > defaults                                             | adapt (cross-domain)   | U-03 (done; migration `0103`) deliberately removed licence-level config values (owner decisions 3 and 4, 2026-10-04). Recommendation: keep that. Read "licence" in this chain as **the licence's choice of profile**: a licence may point at a different profile than its tier (Advanced), never hold config values itself. The per-account layer is "user". The config audit owns the final word.                                                                                                                                                                                                                                                  |
| B13 | Licensing metadata: licence > tier > defaults                                                                | adopt                  | One rule for every field, one resolver (LX-32). Channels and the version window move from union and intersection to override, with a migration that writes today's effective values so no device changes (LX-33). Expiry stays a date computed from the tier's duration at create or re-tier (a duration cannot "inherit" into a date), shown with its source.                                                                                                                                                                                                                                                                                      |
| B14 | Realistically a tier gets a profile and is not overridden at tier level                                      | adopt                  | A tier has no config values; its profile is a pointer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B15 | Portal: an OIDC-granted licence's "License source" reads "Automatic Grant"                                   | adopt                  | Quick win: `origin = oidc` and Discover claims read "Automatic grant" (sentence case, rule 4); the record shows which rule granted it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B16 | Sub-licences (IAPs, DLC, feature packs) with their own entitlements that propagate to the licence            | adopt / adapt (shared) | Sub-licences are **grants held by the licence** (LX-08's `grants`/`grant_entitlements`). This **pushes back** on S-19's account-held and store-identity holders and on cross-licence "combined" resolution for now (§4.8). Quantity and redemption belong to the entitlements audit.                                                                                                                                                                                                                                                                                                                                                                |
| B17 | Subscriptions available even with Commerce off                                                               | defer (shared)         | The term model (lifetime, fixed, version-bound, renewable, renewable with perpetual fallback) belongs to the subscriptions audit. This design leaves room for it: the tier's `term` is one field in the chain, and the licence keeps one `expires_at` plus a renewal source.                                                                                                                                                                                                                                                                                                                                                                        |
| B18 | Identity: link an existing licence or have one minted at sign-in; replace devices when full                  | adopt (identity audit) | Licence choice at sign-in (I-04 §A–§G, PX-14), with the auto-mint branch through LX-36.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B19 | Accounts are not required; a floating licence is valid                                                       | adopt                  | Unchanged; the console and kits say what floating does not get (B6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B20 | RBAC: an OIDC group gives console access to an app                                                           | adapt (RBAC audit)     | Remove `role` from the licence group map; console roles and `admin_group` move to RBAC. A group can grant a tier (licensing) and a role (RBAC), but through two separate rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 4. Target design

### 4.1 Vocabulary

| Word (UI)                                                | Meaning                                                                                                                              | Replaces                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **license**                                              | An access contract for one product: tier, terms, keys, devices, sub-licences. Optionally in an account.                              | "a grant of entitlements" (`concepts.md:182`)                             |
| **In an account** / **Waiting for ada@…** / **Floating** | The holder, derived (S-24 D1). "Bound" in the owner's brief means in an account (or waiting).                                        | "unowned licence" (S-19), "assigned" (kept as the internal `holder.kind`) |
| **tier**                                                 | A named plan: rank, profile, entitlements, terms.                                                                                    | —                                                                         |
| **sub-license**                                          | A grant held by a licence: one reason for some entitlements (a DLC, an IAP, a comp, a claim), with its own source, state and expiry. | "store grant", "grant holder", "contributor", "anchor" (internal only)    |
| **Automatic license** / **Access**                       | A licence minted by the Access policy at sign-in, on Discover or for an anonymous device. Its source reads "Automatic grant".        | "auto-issue", "oidcDefault", "groupRoleMap", "obtain path" (internal)     |

### 4.2 One licence row, one owner pointer

- `licenses.account_id` is the **only** owner pointer. New writes never set `sub` on
  platform-issuer products. `sub` remains only as a historical column on custom-issuer licences
  until the product-IdP work (I-22) maps them. `portal_license_links` is retired at contract
  (LX-16b).
- The holder stays derived (`licenseHolder`): floating, waiting or in an account. No new column.
- **Provenance is one column.** `origin` is admin, oidc (shown as "Automatic grant"), enroll or
  store. One copy table renders it in the console, portal and kits. `batch_id`, `source` and
  `external_ref_hash` are idempotency and grouping facts, not a second vocabulary.

### 4.3 Bound and floating: the rules

| State           | Identity on                                                                                                                                                             | Identity off                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Floating        | The key activates any device up to the device limit. The key-entry counter keeps running, with its limit a fixed platform default (Advanced, §5).                       | The key activates any device up to the device limit.                 |
| Waiting (email) | The key activates. The first verification of that email (any sign-in method) puts the licence in the account (LX-26).                                                   | The same; the licence joins the Library at verification.             |
| In an account   | **New devices sign in** (`license_owned` with `signInUrl`, default on after I-10a/b and UK-42/43). Existing devices keep running. Sign-in binds through licence choice. | The key activates; the account gets Library, downloads and recovery. |

**Delivery for "Someone specific" (LX-27, amended).** On Identity products the default is
**Email an invitation**: "Your <Product> license is ready. Sign in with ada@example.com." The email
carries a sign-in link and no key, because the key would not activate a device once the licence is
in an account. **Also create a key** is an option, for offline bundles and products without
Identity. On Identity-off products the email carries the key, as today.

### 4.4 The Access policy (`license.access`)

One claimable registry setting with one manifest block (`.pkey/product` → `access:`), owned by
License and read by Identity through Core (rule 6):

```jsonc
"access": {
  // Tier for any signed-in person no rule covers. Omit = refuse them ("You don't have access").
  "everyone": "free",
  // Every rule a person matches is a candidate; the highest tiers.rank wins (LX-08's rank).
  "rules": [
    { "group": "studio-pro", "tier": "pro", "label": "Included with Studio" },  // replaces groupRoleMap + groupLabels
    { "emailDomain": "example.edu", "tier": "edu" },                           // replaces PS-09 autoIssue.emailDomains
    { "claim": "vpnAccess", "grants": { "polarisVpn": true } }                // replaces provisioning entitlement hooks: a sub-license, not a tier
  ],
  "upgradeOnSignIn": false,   // replaces identity.oidc.syncTierOnSignIn (upgradeOnly)
  "devices": null,            // tier for anonymous keyless devices (replaces autoIssue mode anonymous|both); rate limit becomes a platform constant
  "discover": true            // offer on Discover to people a rule (or `everyone`) covers; replaces discover_enabled for licensed products
}
```

**Evaluation.** One pure function, `accessFor(policy, identity, tiers)`, returns
`{tier, rule, grants} | refuse`. It is used by every caller: product sign-in, the card and
passthrough, the LicenseChoiceStep's "Create" row, the Discover listing and claim, the persona
preview (PS-06) and edge-mint's `mintIsPublic`. It replaces `identityTier` (`oidc.ts:782-829`),
`identityIssuePolicy` (`:996-1030`) and the PS-09 branch.

**Security.**

- **Groups are bound to the issuer that asserted them.** A rule's groups count only from the
  product's own sign-in provider or a platform-configured SSO connection, and are read from
  `account_links.groups_json` on that link. They never come from a tenant IdP of another product
  (the R5-02 lesson).
- **Email-domain rules use verified emails only** (S-24 §7.2).
- **No enumeration.** Discover keeps its one hidden verdict.
- **Edge-mint approvals compare the policy structurally**, as they compare the group map today
  (`W/core/identityTrust.ts:74`, `W/core/edgeMintApproval.ts:187`).

**Console (LX-35b).** License → **Access** is one page:

- **Who gets a license automatically:** three radio cards, Nobody (they need a key or a license
  from you), Everyone who signs in → [tier], Only people these rules cover. The rule rows hold
  group, domain or claim, tier and label.
- **Anonymous devices.**
- **Show on Discover.**
- **Who can see this?**, the persona preview reused from PS-06.

Identity → Sign-in keeps provider settings only and links here. The Polaris Key storefront's
"Ways to add" becomes a read-only summary with a link.

### 4.5 One issuance function

`issueAutomaticLicense(ctx, {product, accountId, via, device?})`, in Identity (which owns
accounts), writing through Core:

1. **Re-check.** Re-evaluates `accessFor`, and returns the account's existing usable licence for
   the product if one exists (the I-26 rule).
2. **Insert.** Inserts with `account_id`, `origin = 'oidc'`, the rule's tier and
   `expires_at = tierExpiresAt`. It uses `INSERT … SELECT … WHERE NOT EXISTS`, so concurrent
   sign-ins converge. Historic duplicates make a unique index unsafe; the I-26 incident shows they
   exist.
3. **Claim grants.** Writes claim-rule grants as the licence's `oidc` grant (LX-08's
   `grt_oidc_<id>`).
4. **Audit.** Writes `license.create` with `via: <rule>`.
5. **Bind.** Binds `device` when a device asked (sign-in), and never mints a key.

Callers:

- **The legacy product-OIDC sign-in.** It resolves the account through the I-17 link, and keeps
  today's `sub` path only while `PLATFORM_OIDC_MIGRATION=off`.
- **The card and passthrough (I-08).**
- **Discover.** Every account, platform link or not.
- **The LicenseChoiceStep's** "Create a new free license".
- **Later:** store base claims (LX-11) and checkout (CM-05), with their own `via`.
- **Not this function:** anonymous `enroll` stays per machine (`enroll_hwid`) and keeps its
  claim/migrate on sign-in (`oidc.ts:1145-1257`).

### 4.6 Tiers

```text
tier {
  id, label,
  rank,                      // its position in the Tiers list (drag to reorder); LX-08's column
  profile?: profileId,       // config and secrets only; Config off → hidden, tier still works
  entitlements: {key: value} // what the tier grants (moved out of the profile's entitlements bucket)
  term: { expiryDays | null } // subscription term types extend this (subscriptions audit)
  deviceLimit?, offlineDays?, channels?, versions? {min,max}, fingerprintMode?
}
```

- **The Tiers list** is ordered by rank (top = best). The tier drawer has four groups: Basics,
  Config profile, Entitlements, License terms. The fingerprint mode becomes visible and editable
  (it is manifest-only today).
- **The manifest** `licensing.tiers[]` gains `entitlements` and `fingerprintMode` (rule 9) and
  keeps `profileId`, `policyExpiryDays`, `policyDeviceLimit`, `rank` and `policyOfflineGraceDays`
  (LX-08).
- **No `role`, no tier-level config values, no per-licence profile stack.** A licence may name one
  `profile` that replaces its tier's profile (Advanced, rare). `license_profiles` is read-only from
  LX-34 and dropped at LX-16b.

### 4.7 The metadata chain: one resolver

`resolveLicenseTerms(product, tier, licence) → Terms` lives in `W/core/licenseTerms.ts`. Each
field is `{value, source: "license" | "tier" | "product" | "default"}`, and every field follows
**licence > tier > product**:

| Field            | Licence                                                                                           | Tier                        | Product / default               |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| expiry           | `expires_at` (a date; computed from the tier's term at create or re-tier, then the licence's own) | `term.expiryDays`           | none (perpetual)                |
| device limit     | `device_limit`                                                                                    | `policy_device_limit`       | `default_device_limit`          |
| offline days     | `max_offline_days`                                                                                | `policy_offline_grace_days` | `default_max_offline_days`      |
| channels         | `channels_json` **replaces**                                                                      | `channels_json`             | `["stable"]`                    |
| version window   | `min`/`max` **replace**                                                                           | `min`/`max`                 | `compat_min`/`compat_max` bound |
| fingerprint mode | —                                                                                                 | `policy_fingerprint`        | product policy                  |
| config profile   | `profile_id` (Advanced)                                                                           | `profile_id`                | none                            |

Seat-pack sub-licences add to the device limit (LX-14's **Add seats…**). A `deviceLimit` value in
a profile or override is no longer a source. Every reader calls the resolver:

- the documents (offline days, in three routes today);
- `authorizeDevice` (device limit, fingerprint);
- `injectAdminPolicy` (channels, version window, device limit, tier labels);
- the portal seat meter;
- the consent line;
- licence reads, which return `terms` with sources, so the console's `effectivePolicy`
  (`shared.tsx:247-360`) is deleted.

### 4.8 Entitlement composition, trimmed (the LX-09 scope)

A device's entitlements:

1. the tier's entitlements;
2. the licence's entitlement overrides (S-17 D20 kept);
3. the licence's active sub-licences, combined by JSON type (booleans OR, numbers max,
   string arrays union; a sub-licence is never cancelled by a tier or licence value, S-19
   decision 6);
4. device overrides (a support tool);
5. the policy keys from `resolveLicenseTerms`.

There are no account-held grants, no store-identity holders, no `entitlementHolder`, and no union
across a person's licences. At sign-in the person picks the licence the device runs on (I-04
§A), which is how JetBrains-style multi-licence accounts work too.

- **The legacy/combined change is a one-time switch, not a setting.** A byte-identity property
  test proves the new composition on fixtures. One diff report (a script, like
  `scripts/grace-clamp-report.ts`) runs on a production copy, the lead reads it, and the switch
  is one deploy.
- **The `legacy` path survives only as the test oracle until LX-16.**
- **Caching keys on the licence's version** (one holder kind). It is added only if LX-09's
  measurement needs it.

The LX-08 schema keeps `account_id` and `store_identity_hash` holder columns, so account-wide
purchases can come back later as one more contributor.

### 4.9 Licence choice and re-homing (the LX-10 scope)

- **One ranking:** `rankLicenses(account, product)` in Core: rank desc, no expiry first, latest
  expiry, oldest, then id. The chooser, Library, consent line and LicenseChoiceStep all use it.
- **No `anchorPolicy` and no `reanchor` setting.** The person's pick binds.
- **Re-homing on refresh is automatic and fixed:** only when the device's licence became
  unusable (expired, revoked, refunded) and the same signed-in account holds another usable
  licence with a free seat. LX-17 proved every SDK tolerates a `licenseId` change on refresh. This
  absorbs LX-21's useful half; the portal's "Run this device on" becomes a portal device action
  (portal audit).
- **Enrolled-licence supersede** and sub-licence moves on attach stay (licence-held grants move
  licence to licence).

### 4.10 Console information architecture (License section)

| Before                                                                         | After                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Licenses · Tiers · Enrollment · Settings · Batches (hidden)                    | **Licenses** · **Tiers** · **Access**                                                                                                            |
| Enrollment = registration read-out + fingerprint + probes                      | Access → **Defaults** (device limit, offline days, fingerprint mode, probes collapsed) and **Advanced** (registration read-out, key-entry limit) |
| Settings = seven licensing-model rows                                          | gone (§5)                                                                                                                                        |
| Identity → Sign-in group table and tier sync                                   | Access → Who gets a license automatically                                                                                                        |
| Identity → Portal: claim by key, key reissue                                   | Access → **Keys** (licence policies; cross-domain with the portal audit)                                                                         |
| Storefronts → Polaris Key: ways to add, group labels                           | read-only summary with a link to Access                                                                                                          |
| Licence record Terms: tier, expiry, offline, channels, versions, profile stack | Terms shows each field **inherited** with its source; "Override for this license" per field; profile is a single Advanced pick                   |

### 4.11 Graceful degradation

| Service off | Licensing behaviour                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | No device sign-in. Keys are the device credential. "In an account" means Library, downloads and recovery. Access shows Anonymous devices and Defaults only; Discover shows `open` only. |
| Config      | Tier profile hidden. Tier entitlements and terms work (they now live on the tier, not in a Config profile).                                                                             |
| Commerce    | Licences, tiers, sub-licences (comps, Add seats) and renewal by an operator still work (B17).                                                                                           |
| Portal      | Association still happens, and the email invitation says so. The Library is hidden.                                                                                                     |
| License     | No licences. Config-only devices (D-08). Discover `open` path.                                                                                                                          |

### 4.12 Wire impact

**None.** No signed-document shape, discovery member, error code or `PROTOCOL_VERSION` change:

- `license_owned`, `signInUrl` and `key_entry_limit` already exist (I-09, PX-W9).
- LX-33 is value-preserving by construction (byte-identity test).
- LX-36's device-visible difference is which licence a sign-in lands on, recorded as transcripts
  (`signin-anchor.json`, I-09's refusal transcripts become the default path).
- The manifest changes (`access:`, tier `entitlements`, `fingerprintMode`, deprecations) are rule
  9 drift-gate work, not plan-mode wire work.

## 5. Surface-area reduction

| Removed or merged                                                                                                                                                                                                                      | Into                                                                                                | WP            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| `licensing.entitlementModel`, `licensing.entitlementHolder`, `licensing.anchorPolicy`, `licensing.reanchor`                                                                                                                            | fixed rules (§4.8, §4.9)                                                                            | LX-38         |
| `licensing.clampGraceToExpiry`                                                                                                                                                                                                         | always on (G9 is a security gap; perpetual licences are unaffected)                                 | LX-38         |
| `licensing.refundGraceHours`, `licensing.dunningGraceDays`                                                                                                                                                                             | fixed: refunds revoke at once; dunning follows the store's own grace (S-18 "refund always revokes") | LX-38, LX-12  |
| License → Settings page; License → Enrollment page                                                                                                                                                                                     | License → Access                                                                                    | LX-35b        |
| `license.autoIssue`, `identity.oidc.groupRoleMap` (tier half), `identity.oidc.syncTierOnSignIn`, `storefront.polarisKey.groupLabels`, PS-09 `autoIssue.emailDomains`, provisioning **entitlement** hooks, `autoIssue.rateLimitPerHour` | `license.access` (one setting, one manifest block)                                                  | LX-35         |
| `groupRoleMap.role`, `products.admin_group` in licensing                                                                                                                                                                               | RBAC                                                                                                | RBAC audit    |
| `identity.keyEntryRefusals` platform switch                                                                                                                                                                                            | always on for licences in an account                                                                | LX-37         |
| per-product `identity.keyEntry.limit`                                                                                                                                                                                                  | platform default under Access → Advanced                                                            | LX-35b        |
| `license_profiles` ordered stack                                                                                                                                                                                                       | optional single `licenses.profile_id`                                                               | LX-34, LX-16b |
| Tier entitlements inside the profile's `entitlements` bucket                                                                                                                                                                           | `tiers.entitlements_json`                                                                           | LX-34         |
| The `deviceLimit` entitlement as a device-limit source                                                                                                                                                                                 | seat-pack sub-licences only                                                                         | LX-33         |
| Four chain implementations (three routes + console `effectivePolicy`)                                                                                                                                                                  | `resolveLicenseTerms`                                                                               | LX-32         |
| Four licence rankings                                                                                                                                                                                                                  | `rankLicenses`                                                                                      | LX-10         |
| `licenses.sub` as an owner key; `portal_license_links`                                                                                                                                                                                 | `licenses.account_id`                                                                               | LX-36, LX-16b |
| Account-held and store-identity grant holders, `holder_versions` multi-holder cache, the holder report page, catalog `combine`/`entitlementKind` editors                                                                               | deferred; defaults by JSON type; a one-off script                                                   | LX-09, LX-14  |
| LX-21 `reanchor: onRefresh` setting                                                                                                                                                                                                    | the fixed re-home rule                                                                              | LX-10         |
| "Apply to a licence" (portal)                                                                                                                                                                                                          | not needed: sub-licences always land on a licence                                                   | LX-15         |
| Wizard "profiles in order"                                                                                                                                                                                                             | gone                                                                                                | LX-29         |

**Net: nine product settings and one platform switch removed, two console pages merged into one,
one config layer and two ownership pointers retired, and three duplicate implementations
deleted.**

## 6. Automation and onboarding

1. **The Licensing quick start** (SETUP.md §4.2, UX-63) becomes three steps:
   - Confirm **Free** and **Pro** (preset terms; editable; rank set by order).
   - **Who gets a license automatically?** (the Access radio cards; on Identity products only).
   - **Create a test license**, which is a floating licence whose key Connect your app reads.
     It replaces "ST-12's auto-issue editor (skipped until it lands)".
2. **Empty and broken states that explain themselves:**
   - A product with Identity on, `access.everyone` absent and no rules: "People who sign in to
     <Product> are refused until you give them a license" with **Let everyone in on Free** and
     **Add a rule**.
   - A rule naming a deleted tier is a readiness error.
   - A group rule on a product whose sign-in asserts no groups: "Your sign-in provider doesn't
     send groups."
3. **Automatic, no operator step:**
   - **Association.** An email-verified account receives its licences at creation and at
     verification (built); automatic licences are written straight to the account (LX-36). A
     one-off job attaches existing `sub` licences.
   - **Device attach.** Auto-minted at sign-in → the device binds (built for product sign-in;
     LX-36 for the card).
   - **Re-homing.** A device whose licence ended moves to the person's other usable licence
     (§4.9).
   - **Supersede.** An attached free enrolled licence is superseded by a paid one, and its
     sub-licences move with it (LX-10).
   - **The grace clamp** is always on.
   - **The legacy → new composition switch** is one deploy, not an operator setting.
4. **Integration section (LX-39, with the products audit).** A Licensing tab with per-SDK
   snippets: activate by key, sign in, `isEntitled`, and the device-limit and `license_owned`
   refusals. It also offers a test licence and a "first activation seen" check (the
   `license_refusals` and device rows already exist) that feeds the "integration done" banner.
5. **The New License wizard (LX-29):**
   - Limits shows every field as **inherited** with its source from the resolver; "Override"
     opens a field.
   - Delivery for Someone specific defaults to the invitation email (§4.3).
   - Done offers **Try it** (EXPERIENCE §0.7).
6. **CLI (optional, later).** `pkey license create --tier free --floating` for CI test licences,
   with the key printed once. It reuses the admin API; no new route.

## 7. Migration, data and risk

| #   | Change                                   | Data step                                                                                                                                                                                                                                                                                                                                                                                                               | Risk and mitigation                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Access policy (LX-35)                    | Build `license.access` per product from `auto_issue_json` + `group_role_map_json` (tier half) + `syncTierOnSignIn` row + `store_group_labels_json` + provisioning entitlement hooks. Source rule: claimed if any input was console-claimed, else manifest. Manifest aliases (`autoIssue`, `oidc.groupRoleMap`, `oidc.syncTierOnSignIn`, `provisioning[].entitlementKey`) are read with a `deprecated_spelling` warning. | **Edge-mint approvals** compare the group map and auto-issue (`edgeMintApproval.ts:99,187`; THREAT-MODEL §6 property 1). Compare the new policy structurally and map old approvals without widening; otherwise every approved recipe goes `pending`. Rule 9 mutation table, `gen:settings --check`, docs `gen:check`.                                                                                   |
| M2  | Account-keyed automatic licences (LX-36) | One-off job: run the existing `syncAccountLicenseLinks` rule over every account with a platform link (first attach only, auto-attach blocks honoured). New writes set `account_id`; `sub` is written only while `PLATFORM_OIDC_MIGRATION=off`.                                                                                                                                                                          | It depends on I-17's `claim` mode for platform products. Historic duplicates (I-26) are reported, not indexed. Discover opens to all accounts: rate buckets unchanged, and THREAT-MODEL Discover rows reworded ("for the account", not "for the platform subject").                                                                                                                                     |
| M3  | Metadata chain (LX-32, LX-33)            | Value-preserving rewrite. Where tier and licence both set channels → write the union to the licence. Where both set versions → write the intersection. Where the device limit comes from an entitlement → write it to `licenses.device_limit`. **Do not touch `modified_at`** (it is the policy entries' `updatedAt`).                                                                                                  | Byte-identity property test over fixtures plus a live snapshot (the LX-09 pattern). A report of every rewritten licence. No SDK change.                                                                                                                                                                                                                                                                 |
| M4  | Tier cleanup (LX-34)                     | Copy each tier profile's `entitlements` bucket into `tiers.entitlements_json` (rendered at the same merge position, so documents are identical). Fold `license_profiles` entitlements into licence entitlement overrides, and keep the first profile as `licenses.profile_id`.                                                                                                                                          | Folding moves those keys after store grants. A report lists every licence where a store grant and a licence-profile key collide (expected: none; `djdl` has no profiles). The config audit must agree that profiles become config-and-secrets only.                                                                                                                                                     |
| M5  | Bound means sign-in (LX-37)              | None. Flip `identity.keyEntryRefusals` on after I-10a/b and UK-42/43 ship; delete the switch at LX-16b.                                                                                                                                                                                                                                                                                                                 | Almost every existing licence carries an email (`CreateLicenseDialog.tsx:95-101`), but the rule keys on `account_id`, not the email. **Waiting** licences keep working by key; licences already in an account refuse new key devices, which is D24 as approved. First run a per-product count of in-account licences activated by key in the last 90 days. Old SDKs show a generic error until updated. |
| M6  | Retire settings (LX-38)                  | Delete the seven `licensing.*` `product_settings` rows. Manifest fields warn (`deprecated_setting`) and are ignored.                                                                                                                                                                                                                                                                                                    | Check that no product claimed `entitlementHolder: owner` or `clampGraceToExpiry: false` (report). LX-07's affected-licence report is read before the clamp becomes unconditional.                                                                                                                                                                                                                       |
| M7  | Trimmed LX-09                            | None beyond LX-08's rows. A one-time switch after the diff report.                                                                                                                                                                                                                                                                                                                                                      | If account-wide purchases are wanted later, LX-08's holder columns already exist: add a contributor and a plan. Keep the S-19 notes as the design reference.                                                                                                                                                                                                                                            |
| M8  | LX-08 in review                          | None. Merge as is.                                                                                                                                                                                                                                                                                                                                                                                                      | Re-opening a 3.9k-line review costs more than dead columns. The scope note says nothing writes `kind = 'addon'`, `device_store_identities` or `holder_versions` until a plan needs them.                                                                                                                                                                                                                |
| M9  | Contract (LX-16b)                        | After one release: stop reading `group_role_map_json` (tier half), `auto_issue_json` and `license_profiles`; drop `portal_license_links` after I-17's sunset. Leave `sub` dead (it is indexed).                                                                                                                                                                                                                         | Each drop is a separate migration with a rollback script (the I-05 precedent). `TABLE_OWNERS` + docs `gen:check`.                                                                                                                                                                                                                                                                                       |

**Rollout order.** Quick wins → LX-32 → LX-35 + LX-35b → LX-36 → LX-33 → LX-34 → LX-38 → LX-37
(gated on the SDK UIs) → LX-16b. LX-08 merges first; trimmed LX-09 and LX-10 run in parallel with
LX-35.

## 8. Backlog changes

| id     | action      | target        | note                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LX-05b | keep        | —             | The reserved-names error phase and the tier `maxOfflineDays` alias error are still right; the window is the lead's call.                                                                                                                                                                                                                                |
| LX-06  | keep (done) | LX-38         | Its seven settings are retired by LX-38; the registry plumbing stays.                                                                                                                                                                                                                                                                                   |
| LX-07  | keep        | LX-38         | Ship as built (in review). LX-38 removes the opt-out after the affected-licence report is read.                                                                                                                                                                                                                                                         |
| LX-08  | keep        | —             | Merge as is (in review). Add a scope note: no writer for `kind = 'addon'`, `device_store_identities`, `holder_versions`, account- or store-held grants until a plan needs them.                                                                                                                                                                         |
| LX-09  | edit        | —             | Single-holder resolver (§4.8): tier entitlements → licence overrides → licence-held sub-licences → device overrides → terms. A one-time switch proven by the byte-identity test and a diff-report **script**. No `entitlementModel`/`entitlementHolder` reads, no holder-report page, caching by licence version only if measured. About half the size. |
| LX-10  | edit        | —             | One `rankLicenses` for chooser, Library, consent and LicenseChoiceStep. No `anchorPolicy`/`reanchor`. A fixed re-home rule on refresh when the licence became unusable (absorbs LX-21). Enrolled-licence supersede and sub-licence moves stay.                                                                                                          |
| LX-21  | merge       | LX-10         | Shared with the entitlements audit. The setting goes; the useful behaviour is LX-10's fixed rule; "Run this device on" becomes a portal device action.                                                                                                                                                                                                  |
| LX-11  | edit        | —             | Shared with the commerce audit. Purchases bind to the account's licence (or the device's licence when nobody is signed in); Steam ownership is a re-verified licence-held sub-licence, not a store-identity holder; restore policy per store stays operator-only.                                                                                       |
| LX-12  | edit        | —             | Keep `ended_reason` and the sub-licence states; drop the `refundGraceHours` setting (refunds revoke at once; chargebacks too) and leave dunning to LX-23 with the store's own grace.                                                                                                                                                                    |
| LX-13  | edit        | —             | Keep the admin sub-licence API, `GET …/subjects/<s>/entitlements` and the `entitlement_events` pull feed. Drop account-held grant merge re-keying: licences already move in the merge batch.                                                                                                                                                            |
| LX-14  | edit        | LX-34         | The licence record gets **Entitlements** (effective, with sources) and **Sub-licenses** tabs, comp, trial, suppress and **Add seats…**. Drop the holder-report page and the catalog `combine`/`entitlementKind` editors. Tier rank moves to LX-34 (list order). Commerce mappings belong to the commerce WPs.                                           |
| LX-14a | keep (done) | —             | Its device limit becomes the licence row of the chain (LX-32).                                                                                                                                                                                                                                                                                          |
| LX-15  | edit        | —             | "What you own" per licence with sources; "Automatic grant" source copy; drop "Apply to a licence"; downloads through the trimmed resolver.                                                                                                                                                                                                              |
| LX-16  | split       | LX-16, LX-16b | LX-16 stays the grants contract (dual-write off, `license_store_grants` dropped after zero drift). **LX-16b** retires the licensing surface: `sub` as an owner key, `portal_license_links`, `license_profiles`, `auto_issue_json`/`group_role_map_json` reads, the `licensing.*` rows, `identity.keyEntryRefusals`.                                     |
| LX-27  | edit        | LX-37         | Keep `deviceLimit` on create. For Someone specific on Identity products, delivery defaults to an **invitation** email (sign-in link, no key); "Also create a key" is optional. `send-key` becomes `send-invite` on Identity products and keeps minting a new key with Identity off.                                                                     |
| LX-29  | edit        | —             | Steps unchanged in number. Limits shows inherited values and sources from `resolveLicenseTerms` with per-field Override. Remove "profiles in order" (one Advanced profile pick). Delivery per LX-27 as amended. Copy: "They sign in with this email to use it" on Identity products.                                                                    |
| LX-30  | keep        | —             | In review; already the holder surface of this design.                                                                                                                                                                                                                                                                                                   |
| LX-31  | edit        | —             | Add the Access policy and automatic-licence docs and two e2e paths: an automatic licence via sign-in and via Discover (an email-only account), and an invitation-delivered licence. Glossary: "in an account (bound)", "sub-license", "automatic license".                                                                                              |
| ST-12  | edit        | LX-35b        | Cross-domain. The "auto-issue editor" is replaced by the Access page; ST-12 keeps device trust, commerce and store-credential editors.                                                                                                                                                                                                                  |
| PS-09  | merge       | LX-35         | The email-domain path is an Access rule; no separate `autoIssue.emailDomains`.                                                                                                                                                                                                                                                                          |

## 9. New work packages

| Proposed id | Title                                        | Scope                                                                                                                                                                                                                                                                                                                                                                                                            | Deps                                    | Plan mode |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------- |
| LX-32       | One licence-terms resolver                   | `W/core/licenseTerms.ts` `resolveLicenseTerms` with sources, behaviour-preserving (today's rules). Switch `license/document.ts:136`, `identity/browserSession.ts:302`, `config/document.ts:144`, `licenseDeviceLimitInfo`, `tierFingerprintMode`, `injectAdminPolicy`, the portal seat meter and the consent line. Licence reads return `terms`. Delete the console `effectivePolicy` copy. Byte-identity tests. | LX-08                                   | no        |
| LX-33       | Licence > tier > product for every field     | Channels and the version window become override; the `deviceLimit` entitlement stops being a source (seat packs add); tier offline days are read. Value-preserving data migration and report (§7 M3); the console Terms form shows inherited values with Override.                                                                                                                                               | LX-32                                   | no        |
| LX-34       | Tier cleanup                                 | `tiers.entitlements_json`; rank as list order (drag); fingerprint mode in the API and console; tier drawer in four groups; manifest `licensing.tiers[].entitlements` and `fingerprintMode` (rule 9); single optional `licenses.profile_id`; `license_profiles` read-only; migration M4.                                                                                                                          | LX-32, LX-08                            | no        |
| LX-35       | Access policy (`license.access`)             | One claimable setting and manifest block (§4.4) replacing `autoIssue`, the group map's tier half, `syncTierOnSignIn`, group labels, PS-09 and provisioning entitlement hooks. `accessFor()` used by sign-in, Discover, persona preview and `mintIsPublic`. Issuer-bound groups. Edge-mint approval mapping. Migration M1. THREAT-MODEL rows.                                                                     | LX-08                                   | yes       |
| LX-35b      | Console License → Access                     | The Access page (automatic licences, anonymous devices, Discover, Defaults, Keys, Advanced, persona preview); remove the Enrollment and Settings pages; Identity → Sign-in loses its group table; the Polaris Key "Ways to add" becomes a summary; Licensing quick start step "Who gets a license automatically?"; readiness errors.                                                                             | LX-35, LX-38                            | no        |
| LX-36       | Account-keyed automatic licences             | `issueAutomaticLicense` (§4.5) for product sign-in, card and passthrough (hook for I-08), Discover (all accounts), LicenseChoiceStep "Create"; no `sub` on platform products under I-17 `claim`; one-off attach job; transcripts; THREAT-MODEL Discover rows.                                                                                                                                                    | LX-35, I-17                             | yes       |
| LX-37       | Licences in an account need sign-in          | Make `license_owned` on new key devices the default for Identity products; remove `identity.keyEntryRefusals`; data report (M5); invitation copy in kits; docs.                                                                                                                                                                                                                                                  | I-09, I-10a, I-10b, UK-42, UK-43, LX-27 | no        |
| LX-38       | Retire the licensing-model settings          | Remove seven `licensing.*` registry entries (clamp always on); manifest deprecation (rule 9); delete `LicenseSettingsPage`, `COMBINED_ENTITLEMENT_MODEL_SINCE` and `entitlementModelFor`; reports first (M6); `gen:settings --check`.                                                                                                                                                                            | LX-07, LX-09                            | no        |
| LX-39       | Licensing in the product Integration section | Per-SDK snippets (key activation, sign-in, `isEntitled`, refusals); "create a test license"; the "first activation seen" signal for the integration-done banner. Built inside the products audit's Integration section.                                                                                                                                                                                          | LX-29, products-audit Integration WP    | no        |

## 10. Quick wins

1. **Fix the dead link.** "Auto-issue in Enrollment" (`A/console/pages/identity/SignIn.tsx:340-348`)
   goes to a page with no auto-issue control. Link to the manifest docs until LX-35b.
2. **Fix the Polaris Key storefront's empty state** (`PolarisKeyPanel.tsx:498`). Tell the
   operator to declare `autoIssue` or `oidc.groupRoleMap` in `.pkey/product` and resync, instead
   of an action the console cannot do.
3. **Hide the five no-effect settings.** Mark `licensing.entitlementModel`, `entitlementHolder`,
   `anchorPolicy`, `reanchor` and `refundGraceHours` `pending` (as `dunningGraceDays` already is,
   `licensingSettings.ts:236-239`), so License → Settings shows only the grace clamp.
4. **"From signing in" → "Automatic grant"** for licences minted by sign-in or Discover
   (`A/portal/model/library.ts:296`, `LicenseCard.tsx`, the copy keys). This is the owner's
   request.
5. **Fix the offline description** (`W/services/license/settings.ts:59`, "neither its tier nor the
   licence sets a window") and ADMIN.md §6.5.2 ("Blank uses the tier or product default"). Until a
   tier field is read, it is the licence or the product.
6. **Console `effectivePolicy` prints "Unlimited" for ≤ 0** (`shared.tsx:283`); the Worker refuses
   that value. Show the number.
7. **Show the tier's fingerprint mode** read-only in the tier form, with a `SourceBadge`. Today it
   is an invisible manifest field (`W/repo.ts:205`).
8. **Drop the "Role" column** from the Sign-in group table, or label it "Not used for licenses"
   (`SignIn.tsx:300-335`).
9. **Glossary** (`concepts.md:182`): "license — an access contract for one product …"; "grant"
   now means a sub-licence.

## 11. Cross-domain dependencies

- **Identity:**
  - the card and passthrough (I-08) must call `issueAutomaticLicense` (LX-36);
  - groups are stored per link and issuer-bound (`account_links.groups_json`);
  - I-17's `claim` mode is a prerequisite for account-keyed minting on platform products;
  - the LicenseChoiceStep (PX-14) reads `rankLicenses`;
  - the SDK `license_owned` UIs (I-10a/b) gate LX-37.
- **Entitlements and subscriptions (LX-18 to LX-25):**
  - sub-licences are licence-held grants;
  - no account-held or store-identity holders and no cross-licence combining for now;
  - quantity and redemption, term types (lifetime, fixed, version-bound, renewable, perpetual
    fallback) on the tier's `term`;
  - refund and dunning defaults fixed;
  - LX-18's `grants` member keeps `{source, keys, expiresAt}`.
- **Config:**
  - the brief's "user > license > profile > defaults" conflicts with U-03's removal of licence
    config values; the recommendation is to keep U-03 and read "license" as the licence's profile
    pick;
  - profiles become config and secrets only (tier entitlements move to the tier);
  - `license_profiles` is retired.
- **Commerce and storefronts:**
  - Discover listing (`listed`, `audience`, `offerPaths`, `groupLabels`) versus the Access policy's
    `discover` switch and rule labels;
  - PS-07 (store ownership) and PS-08 (product IdP) as Access rule kinds or store-driven
    sub-licences;
  - LX-11 bindings target a licence;
  - CM-05 fulfilment calls the issuance function with `via: checkout`.
- **RBAC:** `groupRoleMap.role` and `products.admin_group` move out of licensing.
- **Portal:**
  - the "Automatic grant" source;
  - the License card layout items from the brief (type pill, the "0 out of 5 devices" removal);
  - "Run this device on" as a device action;
  - `claimByKey` and `keyReissueEnabled` move to Access → Keys.
- **Products and onboarding:** the product wizard's licensing step (tiers plus Access), the
  Integration section's Licensing tab (LX-39), and "integration done" from the first activation.
- **Release and update:** channels live on tiers (`stable` by default; `beta`/`dev` added per
  tier), following the chain.
- **Settings (S-18):** registry removals and additions, `gen:settings --check`, manifest
  deprecations, and the claimable authority rule for `license.access`.
- **Security:**
  - THREAT-MODEL rows for Discover (account instead of platform subject), D24's default and the
    Access policy (issuer-bound groups, verified-email domains);
  - edge-mint approval inputs (§6 property 1).
- **SDK kits in flight (UK-13, UK-14):** they already render `license_owned` and
  `key_entry_limit`. LX-37 changes the defaults, not the codes. Invitation copy is a follow-up
  copy key.

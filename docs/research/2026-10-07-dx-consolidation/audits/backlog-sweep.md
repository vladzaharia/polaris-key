# Backlog sweep: every open work package against the 2026-10-07 direction

Auditor: backlog sweep (breadth). Tree read: `/Users/vlad/Repos/pk-wt/dx-plan` at `38d3acc68`
(v0.8.31 plus batch 5), plus the in-flight branches `wp/LX-08-licensing-expand` (`885aef7b1`),
`wp/HA-12-presentation-discovery` (`ac6eb242a`), `wp/UK-13-python-terminal` (`2c9c14ad9`),
`wp/UK-14-node-terminal` (`bbb4a2190`, fix round) and `fix/ux-polish-1007` (no commits yet).
Inputs: the owner brief (`docs/research/2026-10-07-dx-consolidation/owner-brief.md`), all 199 open
briefs in `program/wp/`, `program/workpackages.json`, `program/README.md`, the specs in
`docs/design/` (SETUP, FLOWS, EXPERIENCE, UI-KITS, PORTAL) and the notes S-16 to S-24.

Paths below are relative to the repository root. `P/` = `docs/research/2026-09-29-godot-omniplatform/program/`,
`N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`, `W/` = `packages/worker/src/`,
`A/` = `packages/admin/src/`, `M/` = `packages/worker/migrations/`.

---

## 1. Summary

The backlog holds **199 open work packages** (179 `todo`, 18 `in-review`, 2 `blocked`), about
**201 to 294 engineer-weeks**. Read against the owner brief, it has four structural problems:

1. **The owner's headline asks are designed but not in the graph.** The product wizard, the
   in-app Integration section, the storefront wizards, the setup automation and the
   context-switching console are specified in `docs/design/SETUP.md` §1 to §5 and §8.2 and in
   `docs/design/FLOWS.md` §3 (packages UX-50 to UX-76). About 50 `UX-*` packages live only in
   those spec tables, so `node check.mjs --ready` never offers them. The code shows none of it:
   there is no `A/ui/wizard/`, no `setup_state` table, and the SDK quick start says it is
   "Interim until UX-60's `renderSdkSetup` and UX-61's Connect your app replace it"
   (`A/console/pages/core/sdkQuickStart.ts:15`).
2. **The licensing backlog adds the layers the owner wants removed.** LX-09, LX-10, LX-21 and
   LX-24 add modes and knobs (`licensing.entitlementModel`, `entitlementHolder`, `anchorPolicy`
   with three values, `reanchor` with three values; `packages/shared-manifest/src/index.ts:223-241`).
   Entitlements stay inside the config catalog (`flag` kind, `packages/shared-catalog/src/types.ts:9,34-35`),
   and LX-14 adds `combine` and `entitlementKind` there. Subscriptions exist only as an optional
   store package (LX-23) and a deferred checkout package (CM-08), so "subscriptions without
   Commerce" has no home.
3. **Access control has no package.** The Worker has one privilege level
   (`W/admin/authz.ts:1-11`), the per-product `core.adminGroup` setting is stored but never read
   (`W/admin/handlers/me.ts:37-42`), operators sign in through a separate Pocket ID client (I-03,
   I-17), and the only RBAC work is ST-21 (a gate on settings writes) and ST-22 (optional).
4. **Effort sits where the brief does not.** UI kits are 39 packages and 71 to 102 weeks (35 % of
   what is open), and their should tier puts React Native on the computed critical path
   (`node check.mjs --critical`: SP-00 → UK-02b → UK-03 → UK-04 → UK-05 → UK-20). Six-SDK passes
   and wire events are fragmented (PX-W9b, UK-44 and I-10a/b are three passes over the same
   activation surface; PX-W18 and I-08 are two events on the same route).

**The single most important change:** turn the sweep into graph edits plus two new phases. Phase
**DX** imports SETUP/FLOWS's wizard, Integration, storefront and automation packages as ten graph
nodes (DX-01 to DX-10). Phase **AC** delivers RBAC and console sign-in on Polaris Key accounts
(AC-01 to AC-04). Four new LX packages re-cut licensing around the owner's model: entitlements
leave the config catalog, one licence-terms model works with Commerce off, one access policy
replaces three auto-issue knobs, and consumables ride the one licensing wire event.

The verdicts: 18 stamp `done` (already merged), 66 keep, 40 edit, 20 merge into another package, 3
split, 14 move after the consolidation waves, 35 parked (optional or demand-driven), 3 dropped
(U-17, ST-15, LX-21), and 23 new packages. Active effort goes from about 201–294 to about
165–239 engineer-weeks. The front of the queue is the owner's DX work, not UI kits.

---

## 2. Current state (with file references)

### 2.1 The backlog's shape

| Phase | Open | Todo | In review | Blocked | Optional | Weeks (min–max) |
| ----- | ---: | ---: | --------: | ------: | -------: | --------------: |
| I (Identity)            | 17 | 16 | 1  | 0 | 3  | 18.6–26.3 |
| U (Cloud Sync)          | 25 | 25 | 0  | 0 | 3  | 20.4–28.9 |
| PX (portal)             | 17 | 12 | 5  | 0 | 0  | 6.4–12.2 |
| ST (settings)           | 19 | 19 | 0  | 0 | 1  | 13.4–18.8 |
| LX (licensing)          | 23 | 21 | 2  | 0 | 3  | 14.7–21.1 |
| SP (SDK parity)         | 12 | 6  | 6  | 0 | 0  | 9.6–15.4 |
| HA (hosted assets)      | 8  | 7  | 1  | 0 | 2  | 4.0–6.2 |
| UK (UI kits)            | 39 | 39 | 0  | 0 | 9  | 70.8–101.5 |
| PS (storefront)         | 7  | 5  | 2  | 0 | 2  | 4.6–7.0 |
| CM (commerce, deferred) | 19 | 19 | 0  | 0 | 19 | 15.6–22.4 |
| P1, P6, F, A, MO, X, D  | 13 | 9  | 2  | 2 | 4  | 23.3–33.8 |
| **Total**               | **199** | **179** | **18** | **2** | **44** | **201.4–293.5** |

**Status drift.** Every one of the 18 `in-review` packages is already merged on this tree: P1-12
(`25e6209ce`), F-10 (`52b52c6f3`), I-18 (`3e57ef5a8`), PX-W3 (via `551a31e37`), PX-13
(`acb923675`), PX-20 (`d12e46cd2`), PX-24 (`490c27997`), LX-07 (`884e5780e`), LX-30 (`5786044f1`),
SP-00 (`c515bf0e8`), SP-12 (`7228e0c45`), SP-17 (`b141fa858`), SP-20 (`297c369aa`), SP-22
(`93d25e485`), SP-23 (`084693d4f`), HA-10 (`a999c0c67`), PS-05 (`464c6780d`), PS-06
(`0226e2824`). Four packages marked `todo` are in flight: LX-08 is in review on its branch
(migrations `0105_a..m`, down script, 63 files), HA-12 is in a lead round, UK-13 has its design
sign-off and UK-14 is in a fix round. The owner's "minor changes" are being built on
`fix/ux-polish-1007` with no graph node (`/Users/vlad/Repos/pk-wt/_lead/active`).

**The shadow backlog.** `docs/design/EXPERIENCE.md` §13.3, `SETUP.md` §8.2 and `FLOWS.md` (UX-72 to
UX-81) define about 80 `UX-*` packages outside `workpackages.json`. Landed: wave 0 (UX-01, 03, 04,
05, 06a, 08, 15 in `191543162`), `integ/ux-1a-ha` (UX-10, 20, 22, 31, 34 in `043e99291`), UX-23,
UX-29, UX-59, UX-69 (`5de711169`), UX-72, UX-77, UX-78 and UX-79. Not built and not in the graph:
UX-02, 06b, 07, 08b, 09, 11 to 14, 21, 25 to 27, 30, 33, 35 to 37, 40 to 49, and every Wave 5
package except UX-59 and UX-69 (UX-50 to UX-58, UX-60 to UX-68, UX-70, UX-71), plus UX-73 to
UX-76 and UX-80. That list contains most of the brief's "Products" and "Distribution" sections.

### 2.2 What the console offers today

- **48 pages** in the nav model (`A/console/nav.ts`, `page:` entries at lines 255–859): Core 8,
  License 5, Config 4, Release 6, Distribution **11** (matrix, rollouts, outlets, storefronts,
  listing, app-store, commerce, access, package-feeds, health, credentials), Update 1, Identity 2,
  Cloud Sync 1, Platform 6, global 4.
- **One sidebar** draws product sections and the Platform group together; only the active section
  stays open (`A/console/shell/Sidebar.tsx`, `useNavCollapse`). There is no Platform/Product context
  switch.
- **Product creation** is UX-20's one-screen form with a welcome header
  (`A/console/pages/global/ProductNew.tsx`, `A/console/pages/core/Welcome.tsx`); UX-72's create
  probes landed, but the New Product wizard (UX-73 to UX-76) did not.
- **Integration help** is the Overview's SDK quick start (`A/console/pages/core/Overview.tsx:1293`,
  `sdkQuickStart.ts`), which its own header calls interim. There is no per-service quick start, no
  handshake detection and nothing to dismiss.
- **The wizard primitives are missing**: `A/ui/` has `Stepper.tsx`, `RadioCards.tsx` and
  `OneTimeSecretPanel.tsx`, but no `wizard/` directory, and no migration creates `setup_state`.

### 2.3 Access control

- `W/admin/authz.ts:1-11`: "There is exactly ONE privilege level: PLATFORM admin… Per-product admin
  does not exist and is not planned." `isPlatformAdmin`, `canAdminProduct` and `hasAnyAdminGrant`
  are the same predicate (`authz.ts:19-44`).
- `core.adminGroup` is a registry key, manifest-only (`W/admin/handlers/products.ts:296-301`), and
  never enforced (`W/admin/handlers/me.ts:37-42`: "The old `p.admin_group` … arm was unreachable
  dead code").
- Operators sign in through their own Pocket ID client (I-03), and I-17 made Pocket ID
  operator-only. Customers sign in with the Polaris Key account.

### 2.4 Licensing and config shapes the backlog builds on

- Licensing settings (`packages/shared-manifest/src/index.ts:223-241`, registered in
  `W/services/license/licensingSettings.ts:70-214`): `licensing.entitlementModel` (legacy |
  combined), `entitlementHolder` (device | owner), `clampGraceToExpiry`, `anchorPolicy`
  (rank-first | most-free-seats | oldest), `reanchor` (never | onActivation, `onRefresh` reserved
  for LX-21), `refundGraceHours`, `dunningGraceDays`, plus `licensing.reservedNames`.
- Who gets a licence at sign-in is spread over three shapes: `autoIssue {enabled, tierId, mode:
  anonymous | oidcDefault | both, rateLimitPerHour}` (`index.ts:288-294`), `oidc.groupRoleMap`
  and `oidc.syncTierOnSignIn` (`index.ts:201-214`). PS-09 would add `autoIssue.emailDomains`.
- Tiers carry `profileId`, expiry, device limit, fingerprint policy, `channels`, `minVersion` and
  `maxVersion` (`index.ts:296-307`). A licence also carries an **ordered profile stack**
  (`M/0004_license_profiles.sql`).
- The config catalog has three kinds, `config | secret | flag` (`packages/shared-catalog/src/types.ts:9`);
  a `flag`'s value "lives in the entitlements map" (`types.ts:34-35`). Visibility is
  `ManagementState = default | enforced | hidden` (`types.ts:14`), secrets have a `delivery`
  (`clientScoped`, `serverOnly`, `edgeMint`), and U-04 added the `user` block (sync scope and
  conflict rule, `types.ts:62-84`). The catalog is served unsigned at `/<p>/config/schema`
  (`W/services/config/schema.ts:7-23`).
- The version window already exists as entitlements: `app.minVersion`/`app.maxVersion` intersect
  the product's compat range (`W/core/entitlements.ts:119-131`), and `channels` defaults to
  `["stable"]` (`entitlements.ts:109-113`). The built-in channels are `stable` and `beta`
  (`packages/shared-manifest/src/index.ts:1149`).
- In flight: LX-08 adds `grants`, `grant_entitlements`, `device_store_identities`,
  `holder_versions`, `dist_holder_bindings`, `dist_binding_aliases`, `dist_commerce_settings` and
  new licence and tier columns (`P/wp/LX-08-licensing-expand.md`; branch migrations `0105_a..m`).

### 2.5 Feeds, release and identity facts the sweep relies on

- Registry tokens are per product: `PRIMARY KEY (product, token_id)`, bound to `owner` or a
  `license` (`M/0067_registry_tokens.sql`). There is no account-wide token.
- Feed retention already exists: `release.packages.prunePrereleases` prunes `X-main.N` and
  `X.devN` once `X` ships on stable, always on for the system product and opt-in for tenants
  (`W/services/release/packages/prune.ts:1-50`, `W/services/release/settings.ts:103-116`).
- F-10's brief puts "publishing to any public registry (owner decision)" out of scope
  (`P/wp/F-10-sdks-onto-feeds.md`, Scope Out).
- SDKs already send `X-PKey-SDK` and `X-PKey-SDK-Version` on every call
  (`docs/security/WIRE-CONTRACT-V4.md:649,740`), so "an SDK was seen" needs no wire change.
- There is no email-domain → IdP routing anywhere in `W/` or `SIGN-IN.md`. The account has
  `display_name` and an avatar (`M/0079_account_links_profile.sql`, `M/0093_account_avatars.sql`)
  but no screen name or birth date. Terms acceptances exist (`M/0091_account_terms_acceptances.sql`).
- Services are seven toggles in a chain (`tools/services.json`: license, config, release,
  distribution ← release, update ← distribution, identity, sync ← config + identity). Commerce is
  not a service: it lives under Distribution (`distribution.commerce`).
- The settings registry holds 72 keys today (`key: "…"` across `W/`); S-18's plan adds more
  (ST-15, ST-16, ST-27).

---

## 3. Problems (ranked)

| # | Problem | Evidence | Impact |
| - | ------- | -------- | ------ |
| 1 | The owner's onboarding asks (product wizard, Integration section with in-app samples, handshake-gated dismiss, storefront wizards, setup automation, context sidebars) exist only as `UX-*` rows in spec tables, outside the graph | SETUP.md §8.2 (UX-50 to UX-71), FLOWS.md UX-73 to UX-76; no `A/ui/wizard/`, no `setup_state`; `sdkQuickStart.ts:15` "Interim until UX-60…UX-61" | high |
| 2 | Licensing keeps adding modes and knobs while the owner asks for "cleaned up and simplified" | `index.ts:223-241` (seven licensing settings, three of them multi-mode); LX-09 `legacy`/`combined`; LX-10 three anchor policies; LX-21 a third reanchor mode; LX-24 per-seat features | high |
| 3 | Entitlements are still declared in the config catalog, and LX-14 deepens it | `types.ts:9,34-35` (`flag` kind); LX-14 Scope "catalog `combine` and `entitlementKind`"; tiers get flags through profiles; `license_profiles` stack | high |
| 4 | No RBAC and no console-on-accounts package; the one gate is all-or-nothing and `core.adminGroup` is dead config | `authz.ts:1-11`, `me.ts:37-42`; ST-21 settings-only, ST-22 optional; I-03/I-17 keep operators on Pocket ID | high |
| 5 | Subscriptions and licence terms depend on Commerce; no version-scoped or perpetual-fallback term | LX-23 optional and store-only; CM-08 deferred; LX-12 is grant states only; `app.maxVersion` (`entitlements.ts:119-131`) is the only version tool | high |
| 6 | Six-SDK passes and wire events are fragmented over the same surfaces | PX-W9b, I-10a/b and UK-44 all edit SDK activation and sign-in; PX-W18 and I-08 both change the identity request/authorize route; LX-18 and a future consumables change would be two corpus events | high |
| 7 | UI-kit should tier competes with the brief's admin focus and sets the computed critical path | 39 UK packages, 70.8–101.5 weeks; `check.mjs --critical` runs through UK-20 (React Native) | medium |
| 8 | Duplicate packages across PX, I and U draw the same portal surfaces | I-11 vs PX-02/04/06/08/13/16/17/22 and PS-04/05; U-12, PX-W11 and PX-18 (portal Cloud Sync); I-19 and PX-19 (docs); PX-W19 and PX-25 (one feature split Worker/UI) | medium |
| 9 | Cloud Sync scope exceeds the ask: a third data model (collections) and optional extras, each split into halves | U-09, U-22, U-23, U-11c, U-15c, U-24b (collections), U-14, U-16, U-17; U-11a/b/c, U-15a/b/c, U-24a/b | medium |
| 10 | The settings program adds configuration surface | ST-15 promotes about seven hard-coded policies to settings; ST-16 enforce/delegate per entry and a fan-out matrix; ST-23 environment promote | medium |
| 11 | Feeds: per-product tokens, no upstream publish, SDKs visible to everyone | `M/0067_registry_tokens.sql` `PRIMARY KEY (product, token_id)`; F-10 Out "publishing to any public registry" | medium |
| 12 | Identity gaps against the brief: no email-domain SSO routing, no screen name or birth date, store sign-in not tied to the store channel, consent is all-or-nothing | grep of `W/` and SIGN-IN.md finds no domain routing; `M/0079`, `M/0093`; I-13/I-14 briefs add methods with separate setup | medium |
| 13 | Vocabulary collisions the owner's text exposes: "channel" means release channel in the code, "distribution channel" in the brief, and "outlet"/"storefront" in the specs; "grant" vs the owner's "sub-licence" | SETUP.md §2.1 D1 ("A storefront is any place a customer gets the app"); S-19 §7.1; owner brief "Distribution Channels", "sub-licenses" | medium |
| 14 | Status drift hides real progress: 18 merged packages still `in-review`, four in-flight packages `todo`, owner fixes with no node | §2.1 above | low |
| 15 | Commerce is 19 packages for one deferred feature, with its console as a separate area | CM-01 to CM-19; CM-12 "Product → Commerce" vs SETUP §2.1's storefront page | low (deferred) |

---

## 4. Owner brief: item-by-item stance

| Brief item | Stance | Where | Reason |
| ---------- | ------ | ----- | ------ |
| Consolidate similar features | adopt | 20 merges below; DX, AC phases | Same surfaces drawn by several packages (§3 rows 6, 8) |
| Flexibility "to an extent" | adapt | LX-09, LX-10, ST-16 edits | Keep choices that change outcomes for customers (terms, access policy, visibility); remove choices that tune internals (anchor policy, entitlement holder, reanchor, clamp opt-out) |
| Reduce configuration surface | adopt | §6 | Retire about 10 settings, drop ST-15, trim ST-16, park collections |
| Onboarding: wizards, example code, auto-configuration | adopt | DX-02 to DX-07 | Specified in SETUP/FLOWS; only the graph is missing |
| Automate when credentials exist (storefront on the spot) | adopt | DX-07, CM-01 edit, I-13/I-14 edits | The setup runner (UX-68 design) performs `auto` actions after one consent |
| Graceful degradation (subscriptions without Commerce; pages show whatever is on) | adopt | LX-33, DX-06 | Terms live in Licensing; storefront page renders each side only when on |
| Product wizard | adopt | DX-03 | FLOWS.md §3 New Product wizard, with UX-72's probes already merged |
| Integration section with in-app samples per service | adopt | DX-04 | SETUP.md §3 and §4; `renderSdkSetup` replaces two snippet generators |
| Dismiss the section after an end-to-end handshake, by user choice | adapt | DX-04 | Offer "Hide integration" once an SDK sighting (headers already sent) and a successful document fetch are seen; never auto-hide; re-openable, per product, for later platforms |
| Licences: clean up layers and co-mingling | adopt | LX-09, LX-10, LX-14 edits; LX-21 drop; LX-24 parked | §3 rows 2, 3 |
| Bound vs floating; bound must sign in | adapt | I-09 edit (S-24's two states already built: LX-26, LX-28, LX-30) | Make `license_owned` on by default for Identity-on products; a product without Identity has no sign-in, so its keys keep working there |
| A licence created for an existing account appears automatically | already built | LX-26 (S-24 D3) | `syncAccountLicenseLinks` at creation and at first verification |
| Auto-mint: everyone / by OIDC group / reject; per-group mapping | adopt | LX-34 | One policy replaces `autoIssue.mode`, `groupRoleMap`, `syncTierOnSignIn` and PS-09 |
| Auto-minted licence attaches the device, mints no key; admin adds one later | adopt | LX-34 | Make it the rule of the policy, and test it |
| Discover self-mint identical to use-time mint | already built, keep | PS-03/PS-04 `issueFromPath`, PX-W10 | LX-34 makes both read the same policy |
| Entitlements on licence and user, out of Config | adopt | LX-32 (plan mode, target: no wire change) | §3 row 3 |
| Sub-licences (IAP, DLC, feature packs) propagating up | adopt, renamed | LX-08 grants as "add-ons"; LX-14 Add-ons tab; DX-01 vocabulary | LX-08 already builds the storage; the UI word should be the owner's concept |
| Multiple of one entitlement and redemption status (currency) | adopt | LX-35, riding LX-18/LX-19 | One wire event, not a second all-SDK pass; not Cloud Sync collections |
| Platform entitlements (update channels, Cloud Sync) | already built | `channels`, `app.maxVersion` (LX-05 reserved names), `cloudSync.limits.byEntitlement` | Keep |
| Tiers = config profile (not overridable at tier) + entitlements + licensing details | adopt | LX-32, LX-14 tier editor | Retire licence profile stacks (`M/0004`) |
| Config flow user > licence > profile > defaults; licensing licence > tier > defaults | adopt (verify) | U-03 (account layer, done) + licence overrides | Server-side composition already matches; the config auditor confirms precedence |
| Subscriptions: lifetime, expiry, version, renewable, renewable + perpetual (JetBrains) | adopt | LX-33 | Server-only: at lapse pin `app.maxVersion` to the last version released while active (`entitlements.ts:119-131`) |
| 1.x forever, 2.x subscription, 3.x expiry + perpetual | adapt | LX-33 | One licence or add-on per major with a version-scoped term; no new concept |
| Config types: regular, secret, edge-minted | adapt | LX-32, config auditor | `flag` leaves; `secret.delivery: edgeMint` is "edge-minted"; keep `serverOnly` delivery (needed by edge minting) |
| Visibility: changeable / read-only / invisible | already built | `ManagementState` (`types.ts:14`) | Rename in UI copy only (DX-01); no schema change |
| Every config entry syncable | keep | U-05, U-06, U-07, U-20, U-21 | The `user` block per entry (U-04) is the convention |
| Cloud Sync: config, assets and session state, conflict handling | keep | U-10, U-13, U-25, U-08 (narrowed) | Saves are the "assets and session state" |
| Cloud Sync via existing conventions, no duplicated logic | adopt | park U-09 family; drop U-17 | Collections are a third data model |
| Content types incl. SHA-256 and MD5 hashes | adapt | done (P2-03, F-03) | SHA-256 everywhere; push back on MD5 for verification (broken); show it only where a store requires it |
| OS/arch-restricted content; hide channels the product cannot use | adopt | DX-06 (UX-53 scope), PX-09 edit | `productPlatforms` from builds and `intendedPlatforms` |
| Channel list (Steam, App Store, TestFlight, Play, itch, winget, Homebrew, feeds…) | already built | A-18a to A-18m, PS-01, F-04 to F-31 | Adapters exist; the UX does not |
| Push to centralised feeds as well | adopt | F-34 | CI-plane, keeping "Polaris Key never uploads on behalf of CI" (P/README.md §7) |
| Channels and storefronts separate concepts, one page when both are on | adapt | DX-01, DX-06 | Model stays two concepts (outlet; commerce); UI is one page per storefront showing whichever side is on, the wizard for the other |
| Unconfigured → step-by-step; configured → status | adopt | DX-06, DX-07 | SETUP.md §2.6 to §2.9 |
| A channel that sets up its storefront activates both | adopt | DX-07 | "Don't make the user do this twice" |
| Gate channels and storefronts by app type | adopt | DX-06 | |
| Automate distribution, incl. new releases to channels | adapt | DX-07 now; DX-08 for production stores | Testing tracks, PR and feed storefronts automate today's design; automatic production submission needs its own security decision (SETUP.md §8.4) |
| Customers see what each channel needs (downloads, store link, brew/winget/feed steps), all applicable ones | adopt | PX-09 edit | PORTAL.md and PX-09 have no package-manager instructions today |
| Sidebar entry per channel, combined page | adapt | DX-05, DX-06 | Sub-entries only for live or relevant storefronts under Storefronts, so the sidebar does not grow by 17 |
| Manage an application and its versions in a feed | already built | F-11, F-12 | |
| Feeds protected by a licensed token; account tokens; SDKs hidden from customers | adopt | F-33 (after AC-02) | Today tokens are per product |
| Feed sign-in instructions | already built, extend | PX-11, F-12; PX-09 edit | |
| Clean up `-main.N` builds | already built | `prune.ts`, `release.packages.prunePrereleases` | Always on for the platform's own feeds; tenants opt in |
| Built-in auto-update (Sparkle etc.) | already built | P3-09, P5-07, UK-08, SP-15 | |
| stable, beta, dev pre-configured; beta/dev via tier; promote/demote | adapt | P2-08 | `dev` is missing from `BUILT_IN_CHANNELS`; channel policy and entitlement gating exist |
| Non-application artifacts, Background Assets | already built | P4, P5-05, P5-08 | SP-28 to SP-30 parked until demanded |
| Channel parity, one source of truth | adopt | DX-08 publish everywhere; A-18b listing model (done) | |
| Commerce: wizards, settings, parity | adopt (deferred) | CM-01, CM-12 edits; DX-06 | Commerce renders inside the storefront page |
| Polaris Key storefront with optional Stripe | keep deferred | CM re-plan | Owner's go still gates |
| Store purchase on a linked account provisions and refunds revoke | keep | LX-11, LX-33 (absorbs LX-12), PS-07 | |
| Multiple SSO providers with email domains | adopt | I-27 | Missing today |
| App's own SSO provider | adopt | I-22 + I-27 | Exchange for apps with tokens; card connection for redirect sign-in |
| OIDC, magic link, another device, passkeys | already built / keep | I-06, I-07, I-16, PX-W14; PX-15 | |
| Accounts tied to email, auto-link | already built | LX-26 | |
| Profile prefill from OIDC, user fills the rest, terms | already built / extend | PX-W15, PX-W16, PX-22, PX-21; I-28 | |
| Magic link always available | already built | I-07 | An invariant in I-27 |
| Add more sign-in methods in the portal | keep | PX-13 (merged), PX-15, PX-W19 (+PX-25) | |
| Store account systems always available when distributed there | adapt | I-13, I-14 edits | Derived from declared outlets, not a separate toggle |
| Apps choose their sign-in methods | already built | PX-12 per-product providers | |
| Link an existing licence or mint at sign-in | keep | I-09, LX-10, LX-34 | |
| Replace a device when no slot is free | already built | portal, UX-41 inline replace; kits via I-10a/b | |
| Consent to share only some data | adopt | I-08, PX-14 edits | Per-scope toggles |
| Accounts not required | already built | S-24 floating licences | |
| Sign in across portal, web, games, TV, CLI, TUI | keep | I-08, I-15, UK-13, UK-14, UK-27 | |
| Screen name and birth date; all fields overridable | adopt | I-28 | Missing today |
| Console accounts in the same account system, permissions on the account | adopt | AC-03 | Reverses I-03/I-17's split; owner decision to record |
| Semi-federated OIDC IdP | keep, later | I-20, I-21, I-22 | After AC-03 so operator and customer identity are one first |
| Access tokens per user for feeds | adopt | F-33 | |
| Platform settings expanded, common first | adopt | ST-09 edit | |
| Platform vs Product sidebar by context | adopt | DX-05 | |
| RBAC: console, apps, platform settings, per-feature, OIDC mappings | adopt | AC-01, AC-02, AC-04 | |
| Superadmin, Platform Admin, `<Product>` Admin, Console Access, sum of roles, "contact an admin" page | adopt | AC-01 | No custom role builder in v1 |
| Portal minor fixes (six items) | adopt | DX-10 (`fix/ux-polish-1007`) | The tier pill reverses UX-03's "tier as text": the owner's newer word wins |
| Simplified product card, mobile pips | adopt | DX-10 | Check against `c2f5486ce` ("Console product card, step 1") |
| Code-quality audits | defer to the code-quality auditor | | Out of this domain |
| Go through all todo work and add what is missing | adopt | this document | |

---

## 5. Target design

**One graph, no shadow backlog.** Every package that will be built is a node in
`workpackages.json`. The `UX-*` rows that survive become DX nodes and their spec tables link to
them; superseded rows are closed in the specs. Optional and demand-driven packages are parked
(`optional: true`, marked deferred), so `node check.mjs --ready` offers only the direction's work.

**Two new phases.**

- **DX: developer and administrator experience.** DX-01 fixes the vocabulary first (one word each
  for update channel, storefront and its outlet, add-on, floating and bound, and the three config
  visibilities), docs only. DX-02 builds the wizard kit and `setup_state`; every later wizard
  (LX-29, DX-03, DX-04, DX-06, DX-07) uses it. DX-03 is the New Product wizard. DX-04 is the
  Integration section with in-app samples per SDK and service, and the handshake-gated "Hide
  integration". DX-05 switches the sidebar by context and reduces Distribution to four items with
  storefront sub-entries. DX-06 and DX-07 are the storefront catalogue, pages, wizards and setup
  runner. DX-08 adds publish-everywhere with an auto-publish policy behind a security plan. DX-09
  is the GitHub write path and Publish from CI. DX-10 registers the owner's minor fixes.
- **AC: access control.** AC-01 plans roles, mappings and console sign-in on accounts (security
  review, no device wire). AC-02 enforces `can()` on every admin route and absorbs ST-21 and ST-22.
  AC-03 moves operators to the Polaris Key account. AC-04 adds Members and Roles pages.

**Licensing re-cut around four concepts.** A **licence** is floating or bound and has a **term**
(LX-33: lifetime, fixed, version-scoped, renewable, renewable with perpetual fallback; renewal from
any source). **Add-ons** (LX-08's grants) carry entitlements and a quantity (LX-35) and propagate
to the licence. A **tier** is one config profile plus entitlements plus licensing defaults (LX-32,
LX-14). The **access policy** decides who gets which tier at sign-in (LX-34). LX-09 and LX-10 keep
one resolver and one anchor rule; the setting knobs go (ST-25). LX-18 and LX-19 remain the one
licensing wire event and the one six-SDK pass, now including consumables.

**One six-SDK pass per surface, one wire event per domain.** Identity and activation ship once
(I-10a/b absorb PX-W9b and UK-44); the identity request route changes once (I-08 absorbs PX-W18);
licensing changes once (LX-18 with LX-35); commerce once (CM-14). Corpus-lane occupancy (P/README.md
§5: one corpus-touching package at a time) drops accordingly.

**Cloud Sync is config plus saves.** Settings (U-05, U-06, U-07, U-20, U-21) and saves (U-10,
U-13, U-25) with one console Data tab, one docs package, one privacy package and one portal
section. Collections and the optional extras are parked; consumables are entitlements.

**Waves.**

| Wave | Contents | Why first |
| ---- | -------- | --------- |
| 0 (days, docs only) | Stamp 18 merged packages done; set LX-08, HA-12, UK-13, UK-14 to their real status; park 35; merge the paired briefs; register DX-10; DX-01 | Truth before dispatch |
| 1 | DX-02, AC-01 (plan), LX-32 (plan), LX-33, P2-08, ST-05, ST-07; land LX-08, HA-12, UK-13, UK-14 | Foundations other DX/AC/LX work builds on |
| 2 | DX-03, DX-04, DX-06, ST-08, ST-09, AC-02, LX-34, LX-09, LX-10, LX-27, LX-29 | The owner's headline UX |
| 3 | DX-05, DX-07, DX-09, AC-03, AC-04, F-33, F-34, LX-11, LX-13, LX-14, LX-15, I-27, I-28, PX-09 | Automation, access, licensing surfaces |
| 4 (corpus lane, serial) | I-08 → I-09 → I-10a/I-10b → LX-18/LX-19 → CM-14 (if the owner says go) | One wire event per domain |
| 5 | Cloud Sync settings and saves (U-05 → U-19 → SDKs → U-11a, U-12, U-15a, PX-18); DX-08 after its plan | Needs I-08 and AC |
| 6 | I-20 → I-21, I-22; Commerce on the owner's go; UK should tier | After the platform is consolidated |

UK must tier continues in its own lane throughout (UK-02b, UK-03 to UK-12, UK-41 to UK-43); it
touches `packages/brand`, `sdks/*` and the kit packages, not the console.

---

## 6. Surface-area reduction

**Settings retired or never created** (each through ST-25's deprecate → hide → validator warn →
error → drop path, as LX-05b does for reserved names):

- `licensing.entitlementHolder` (fixed `device`), `licensing.anchorPolicy` (fixed `rank-first`),
  `licensing.reanchor` (fixed `onActivation`; LX-21's `onRefresh` never added),
  `licensing.clampGraceToExpiry` (clamp always on), and `licensing.entitlementModel` once djdl has
  read its report and moved (LX-16).
- `license.autoIssue.mode`, `identity.oidc.groupRoleMap` (as a licensing input) and
  `identity.oidc.syncTierOnSignIn` fold into one `licensing.accessPolicy` (LX-34); PS-09's
  `autoIssue.emailDomains` is never created.
- `licensing.refundGraceHours` and `licensing.dunningGraceDays` become fields of the term model
  (LX-33), not two top-level settings.
- `core.adminGroup` (stored, never enforced) becomes an AC role mapping.
- ST-15's seven new policy settings (seat dormancy, blob GC keep-N, feed depths, registry-token
  caps, portal presentation, session shortening, retention) are not created; ST-16 loses its
  per-entry enforce/delegate switch and the fan-out matrix.
- `identity.keyEntry.*` stays but stays off by default; `license_owned` (bound licences need sign-in)
  becomes behaviour, not a knob, for Identity-on products.

**Concepts merged or retired:**

- Entitlement declarations leave the config catalog (`flag` kind) for one Licensing-owned catalog;
  config keeps config, secret and minted (LX-32).
- Licence profile stacks (`license_profiles`, ordered) give way to one profile per tier plus
  licence-level overrides (LX-32; LX-29 drops "profiles in order").
- Grants are presented as **add-ons** (the owner's sub-licences); trials and comps are a term and an
  add-on, not separate actions (LX-14).
- Cloud Sync is settings plus saves; collections, live pokes, the developer backend API, receipts,
  the end-to-end value type and public collections are parked or dropped (9 packages).
- React keeps one browser mode (bearer with I-08's web redirect) if cookie mode is retired instead of
  signed (SP-10 parked).
- One Tauri path (UK-21 absorbs X-02); one Electron host (UK-06 wraps SP-31).

**Console surfaces:**

- Distribution sidebar from 11 items to 4 (Storefronts with live sub-entries, Rollouts, Health,
  Packages; SETUP.md §2.2), via DX-05 and DX-06.
- One storefront page holds channel and commerce (App Store, Commerce, Outlets, Credentials and
  Listing become tabs); CM-12 renders there rather than adding a Commerce area.
- Platform and Product sidebars instead of one mixed tree (DX-05); one settings hub per product
  (ST-08) and one Platform settings area ordered by frequency (ST-09).
- The Overview's interim snippet generator and the CLI's `sdkSnippet()` are replaced by one
  `renderSdkSetup` (DX-04, UX-60).

**Backlog:** 199 open packages become 146 active (123 surviving plus 23 new), with 35 parked and 18
closed as done. The paired halves (U-11a/b, U-15a/b, U-12/U-24a, PX-W19/PX-25, PX-W11/PX-18,
I-19/PX-19, CM pairs) become single packages.

---

## 7. Automation and onboarding

- **New product:** DX-03 creates a product with services through the chain rule, planned
  platforms, a starter tier, presentation and the release trust policy in one batch, or copies an
  existing product once (ST-23's copy-from-product). Ready moment hands off to Integration.
- **Integration:** DX-04's Connect your app writes the config file per SDK from one generator,
  creates a test licence automatically, waits for an SDK sighting (from the `X-PKey-SDK` headers
  every SDK already sends) and a successful document fetch, then offers "Hide integration". Each
  service the product turns on adds its own quick start with example code (License, Config,
  Release, Identity, Cloud Sync, Storefronts). The section stays reachable from the sidebar for the
  next platform.
- **Storefronts:** DX-06 shows only storefronts the product's builds (or declared platforms) can
  reach. DX-07's runner performs every automatable action after one Set up consent, and re-runs on
  fact changes (a new build platform, a new credential). When platform or product credentials
  already exist, the storefront activates on confirmation; enabling a channel that implies a
  storefront activates both. A-18k's live answers decide which rows are automatic.
- **Releases:** testing tracks and PR/feed storefronts receive every release automatically (UX-68
  design); production store submission becomes automatic only under DX-08's per-storefront policy
  and security review. DX-09 opens the setup pull request (workflow, outlet blocks) and creates the
  release environment and ruleset when the GitHub App has the optional permissions; One command
  otherwise.
- **Sign-in:** store sign-in methods turn on with the store channel (I-13, I-14). The access policy
  (LX-34) answers "who gets a licence" in one place, auto-attaches the device and mints no key.
- **Commerce (when the owner says go):** connecting a merchant turns on the paid path of the
  Polaris Key storefront (CM-01, CM-02).
- **Dogfooding:** D-02 adopts Diceroll through DX-03 and DX-04 instead of `pkey init` plus a
  platform-admin registration, so the onboarding has a real acceptance test.

---

## 8. Migration, data and risk

- **Graph edits first, code second.** Wave 0 is `check.mjs --set`, brief edits, `--sync-briefs`,
  `--write-index`, prettier and `node check.mjs` (P/README.md §8). No running agent's scope changes
  mid-flight: UK-14's fix round, the `fix/ux-polish-1007` build and integration batch 5 finish as
  briefed; edits apply after hand-off.
- **LX-08 lands as built.** Its migrations (`0105_a..m`) are additive with a down script. Objects
  the simplified model never reads (store-identity holders, holder bindings if LX-11 does not use
  them) stay dormant and LX-16's contract step drops them. Dropping LX-08 now would waste a
  reviewed branch and gain nothing.
- **Setting retirement** follows the ST-19 deprecated-spelling path: registry entry hidden, the
  manifest validator warns for two minor releases or 60 days (decision 15's window), then errors;
  ST-25 drops the rows. The two real products (`djdl`, `polaris-key`) are checked by LX-22's
  verification run.
- **Entitlements out of the config catalog (LX-32)** is plan mode only because SDK catalog
  consumers and transcripts read `/<p>/config/schema`. Target: signed documents and the schema body
  unchanged; resync moves `flag` entries into the licensing catalog, the schema endpoint keeps
  serving them for compatibility, typed mirrors keep emitting them. If any SDK change turns out to be
  needed, it rides LX-18/LX-19.
- **Licence terms (LX-33)** stay server-only: lapse handling sets `expires_at` and pins
  `app.maxVersion`; downloads are filtered through the existing version window. Existing licences
  default to their current behaviour (fixed expiry or lifetime).
- **RBAC (AC-01 to AC-03)** is the riskiest change. Mitigations: every current
  `PLATFORM_ADMIN_GROUP` member becomes Superadmin; one release in shadow mode (decisions logged, not
  enforced); a deploy-var break-glass; console sign-in on accounts runs beside Pocket ID for one
  release, linking operators by verified email, with Pocket ID kept as a mapped connection.
  Security review before merge.
- **Account feed tokens (F-33)** are additive; per-product `pkeyr_` tokens keep working. Hiding the
  SDK feeds from non-developers breaks anonymous installs: SETUP.md D17's install lines and
  adopters' CI need a token first. Ship tokens in Connect your app and give a notice period before
  gating.
- **Vocabulary (DX-01)** changes UI words, not identifiers: `outlet`, `grant`, `ManagementState`
  and `channel` stay in code and on the wire; rule 4's glossary maps them.
- **Fewer wire events** (I-08 with PX-W18; LX-18 with LX-35) lengthen each plan but cut corpus-lane
  occupancy. Each remains plan mode and names its corpus regeneration and SDK list.
- **Parked briefs rot.** Mark each `parked 2026-10-07` with the condition that revives it, and
  re-read it against the code before dispatch.
- **Decisions this sweep reverses** must be recorded as owner decisions, not slipped in: I-03/I-17
  (operators off Pocket ID), F-10's "feeds only" (F-34), D17/D24's `license_owned` default (I-09),
  S-19 decision 10 (LX-21), S-18 D7 (ST-15), SDK-PARITY-PASS Q1 (SP-10), and UX-03's "tier as text"
  (DX-10's tier pill).

---

## 9. Backlog changes

Every open package, grouped by phase. "Stamp done" packages are merged on this tree; "parked"
means optional or demand-driven and excluded from `--ready`; "after the DX/AC/LX waves" means kept
but moved behind waves 1 to 3.

### 9.1 Verdicts per phase

| phase | open | stamp done | keep | edit | merge | split | reorder (later) | parked | drop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P6 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| F | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| A | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| I | 17 | 1 | 1 | 9 | 0 | 0 | 2 | 4 | 0 |
| U | 25 | 0 | 9 | 3 | 3 | 1 | 0 | 8 | 1 |
| PX | 17 | 4 | 3 | 5 | 5 | 0 | 0 | 0 | 0 |
| ST | 19 | 0 | 8 | 5 | 3 | 2 | 0 | 0 | 1 |
| LX | 23 | 2 | 10 | 8 | 1 | 0 | 0 | 1 | 1 |
| SP | 12 | 6 | 2 | 0 | 0 | 0 | 0 | 4 | 0 |
| HA | 8 | 1 | 5 | 0 | 0 | 0 | 0 | 2 | 0 |
| UK | 39 | 0 | 15 | 2 | 1 | 0 | 12 | 9 | 0 |
| MO | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| PS | 7 | 2 | 3 | 0 | 1 | 0 | 0 | 1 | 0 |
| CM | 19 | 0 | 4 | 7 | 5 | 0 | 0 | 3 | 0 |
| X | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| D | 5 | 0 | 4 | 1 | 0 | 0 | 0 | 0 | 0 |
| **all** | 199 | 18 | 66 | 40 | 20 | 3 | 14 | 35 | 3 |

Effort: the 18 stamped packages are about 11–17 weeks of merged work; parking and dropping removes
about 43–64 weeks from the active queue; merges save an estimated 30 % of the merged packages'
overhead; the 23 new packages add about 21–31 weeks. Active total: about **165–239 engineer-weeks**,
down from 201–294, with the owner's DX work at the front.

**Duplicates and obsolete packages, named.**

- Duplicates: I-11 vs PX-02/04/06/08/13/16/17/22 and PS-04/05; U-12, PX-W11 and PX-18; I-19 and
  PX-19; PX-W9b, UK-44 and I-10a/b; PX-W18 and I-08; PX-W19 and PX-25; SP-31 and UK-06; X-02 and
  UK-21; ST-21, ST-22 and the missing RBAC; ST-13 and the storefront Listing tab; ST-12's editors
  and DX-07/LX-34; LX-12, LX-23 and CM-08 (terms); ST-23's copy-from-product and the New Product
  wizard; ST-27 and UX-37; CM-02/CM-03, CM-04/CM-09, CM-05/CM-06, CM-07/CM-08, CM-11/CM-16.
- Obsolete under the new direction: LX-21 (third reanchor mode), U-17 (three unasked concepts),
  ST-15 (more knobs); parked as not asked: I-23, I-24a/b, I-25, LX-24, U-09 family, U-14, U-16,
  SP-10, SP-28 to SP-30, HA-16, HA-17, UK-31 to UK-39, CM-10, CM-18, CM-19, PS-08, F-32, X-01, P6-04.

### 9.2 Every open package

#### Phase P1: Godot SDK core

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| P1-12 | in-review | keep | done | Merged (25e6209ce); stamp done. Asset Store and Asset Library uploads stay human steps in HANDOFF.md. |

#### Phase P6: Commerce, ops, web

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| P6-04 | blocked | reorder | parked (optional) | Hosted web builds are the storefront catalogue's 'Web' family (SETUP §2.1). Keep blocked on DNS; not part of the consolidation. |

#### Phase F: Package feeds (pkg.plrs.im)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| F-10 | in-review | keep | done | Merged (52b52c6f3); stamp done. Its Out item 'publishing to any public registry' is superseded for adopters by F-34; SDK-feed visibility moves to F-33. |
| F-32 | todo | reorder | parked with X-01 | NuGet feed only matters if the C# SDK goes ahead. |

#### Phase A: Admin: store provisioning (App Store Connect and every storefront)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| A-18k | blocked | keep |  | Blocked on owner credentials. Its [U] answers decide which storefront rows DX-07's setup runner may automate; schedule it before DX-07. |

#### Phase I: Identity: one Polaris Key account, then per-app identity (S-16)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| I-08 | todo | edit | I-08 (absorbs PX-W18) | Absorb PX-W18's loginHint/nameHint/purpose (same pushed request and authorize route, same transcripts: one wire event, not two). Add per-scope consent on Continue to <App> (profile, email, Cloud Sync each deselectable) per the owner's partial-consent ask. |
| I-09 | todo | edit |  | Keep attach and license_owned. Make license_owned the owner's 'a bound licence needs sign-in' rule, on by default for Identity-on products (today platform default off, D17/D24); key-entry limit stays opt-in. Identity-off products keep key fallback. |
| I-10a | todo | edit | I-10a (absorbs PX-W9b and UK-44 Node/React/Python) | One SDK identity/activation wave instead of three: key-entry outcome (PX-W9b) and sign-in hints (UK-44) ship with identity v2. |
| I-10b | todo | edit | I-10b (absorbs PX-W9b and UK-44 Swift/Kotlin/Godot) | Same merge as I-10a for the native toolchains. |
| I-11 | todo | edit | I-11 narrowed: account data lifecycle | Library, Discover, Activate, Profile and Sign-in methods already shipped (PX-02/04/06/08/13/16/17/22, PS-04/05). Keep only per-product and full export/deletion, connected apps (list, revoke), support code and the one Core revocation hook. |
| I-13 | todo | edit |  | Store sign-in (Apple, Google) turns on automatically when the product ships on that store (declared outlets), never a second toggle (owner: store account systems ALWAYS available). |
| I-14 | todo | edit |  | Same auto-enable rule for Steam, Game Center, Play Games, EOS; Steam ownership lands as LX-11 add-ons. |
| I-15 | todo | keep |  | Native redirect is the CLI/desktop half of 'sign in across experiences'. |
| I-18 | in-review | keep | done | Merged (3e57ef5a8); stamp done. Owner DNS and Apple relay registration stay in HANDOFF.md. |
| I-19 | todo | edit | I-19 (absorbs PX-19) | One identity and portal docs package; rewrite after DX-01's vocabulary decision. |
| I-20 | todo | edit |  | Plan layer 2 after AC-01: include product custom SSO as a login-card connection (I-27) and the consent model, so 'Sign in with <Product>' and BYO-auth share one connection concept. Reorder after the DX/AC waves. |
| I-21 | todo | reorder | after I-20 and AC-03 | Owner wants a semi-federated IdP; keep, but after console-on-accounts so operator and customer identity are one system first. |
| I-22 | todo | reorder | after I-20 | Owner's 'apps with their own account system'; keep. |
| I-23 | todo | reorder | parked | Per-app profiles are not an owner ask; partial consent lives in I-08's grants. |
| I-24a | todo | reorder | parked (optional) | Named-user seats add licence policy keys and a corpus event; no owner ask. Park with LX-24. |
| I-24b | todo | reorder | parked (optional) | Parked with I-24a. |
| I-25 | todo | reorder | parked (optional) | Console-platform backend assertion; no product needs it yet. |

#### Phase U: Cloud Sync (S-17)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| U-05 | todo | keep |  | Settings MVP backend; owner: every config entry syncable. |
| U-19 | todo | keep |  | Security review before any production deploy. |
| U-06 | todo | keep |  |  |
| U-20 | todo | keep |  | Needs SP-31's bridge v4 on desktop. |
| U-07 | todo | keep |  |  |
| U-21 | todo | keep |  |  |
| U-12 | todo | split | U-12 (privacy: settings + saves, absorbs U-24a) and PX-18 (portal section) | The portal Cloud Sync section is drawn three times (U-12, PX-W11, PX-18); keep the privacy cascade here, move the section to PX-18. |
| U-11a | todo | edit | U-11a (absorbs U-11b) | One console Data tab (settings and saves) on I-12's Users page. |
| U-15a | todo | edit | U-15a (absorbs U-15b) | One Cloud Sync docs package (settings and saves). |
| U-08 | todo | edit |  | Narrow to settings first-sign-in and saves; the collections branch is parked with U-09. |
| U-10 | todo | keep |  | Saves are the owner's 'assets and session state needed to rehydrate a session'. |
| U-13 | todo | keep |  |  |
| U-25 | todo | keep |  |  |
| U-11b | todo | merge | U-11a |  |
| U-15b | todo | merge | U-15a |  |
| U-24a | todo | merge | U-12 |  |
| U-09 | todo | reorder | parked | Collections are a third data model (CAS records, OR-sets, wildcard collections, access classes). The owner asks for config + assets + conflicts using existing conventions; in-game currency goes to LX-35. Park until a product needs records. |
| U-22 | todo | reorder | parked with U-09 |  |
| U-23 | todo | reorder | parked with U-09 |  |
| U-11c | todo | reorder | parked with U-09 |  |
| U-15c | todo | reorder | parked with U-09 |  |
| U-24b | todo | reorder | parked with U-09 |  |
| U-14 | todo | reorder | parked (optional) | Live pokes; pull stays the source of truth. |
| U-16 | todo | reorder | parked (optional) | Needs collections and I-21. |
| U-17 | todo | drop |  | Receipts keyring, end-to-end value type and public collections: three new concepts with no owner ask. |

#### Phase PX: Customer portal (docs/design/PORTAL.md)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| PX-W3 | in-review | keep | done | Merged (via SP-09 551a31e37); stamp done. DOWNLOAD_TICKET_KEY per environment stays a human input. |
| PX-W9b | todo | merge | I-10a / I-10b | Same six-SDK activation surface as identity v2. |
| PX-W11 | todo | merge | PX-18 | One portal Cloud Sync package: routes and CloudSyncCard. |
| PX-W13b | todo | keep |  | Two operator-only governance settings; small. |
| PX-09 | todo | edit |  | Show every applicable channel per platform: downloads (Polaris Key), store links, and step-by-step install for package-manager storefronts (brew, winget, scoop, Flathub, Snap) and for package feeds with sign-in; read DX-06's catalogue so the portal and console agree. |
| PX-12 | todo | keep |  | Login card v2; fold EXPERIENCE's UX-40 (AuthCard in ui/auth) into it rather than a second package. |
| PX-13 | in-review | keep | done | Merged (acb923675); stamp done. |
| PX-14 | todo | edit |  | Per-scope consent toggles on AppConsent (owner: share only some data); fold UX-41's passthrough steps. |
| PX-15 | todo | keep |  | Add methods, link accounts, approve a device: owner's 'associate more sign-in methods' and 'sign in via another device'. |
| PX-18 | todo | edit | PX-18 (absorbs PX-W11 and U-12's portal section) |  |
| PX-19 | todo | merge | I-19 |  |
| PX-20 | in-review | keep | done | Merged (d12e46cd2) as a rolling quality bar; stamp done and treat the suite as a standing gate rather than an open package. |
| PX-21 | todo | edit |  | Email gate UI; add screen name and birth date to ProfileImport when I-28 lands. |
| PX-W18 | todo | merge | I-08 |  |
| PX-W19 | todo | edit | PX-W19 (absorbs PX-25) | Worker and UI of the same three account actions in one package. |
| PX-24 | in-review | keep | done | Merged (490c27997); stamp done. |
| PX-25 | todo | merge | PX-W19 |  |

#### Phase ST: Settings architecture (S-18)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| ST-05 | todo | keep |  | One generic settings API: the substrate AC-02's can() and every editor need. |
| ST-07 | todo | keep |  |  |
| ST-08 | todo | edit |  | The hub becomes the product sidebar's Settings entry (DX-05): areas only for services the product runs, commonly changed first; web-origins editor reused by DX-04. |
| ST-09 | todo | edit |  | Platform settings ordered by how often they change (General, Access and roles, Email, Store connections, Product defaults); the read-only constants inventory goes to the docs, the policies matrix waits for a second tenant. |
| ST-10 | todo | keep |  | Cheap on ST-06's index; the antidote to deep settings trees. |
| ST-11 | todo | keep |  | Moves SQL-only settings into the one registry (consolidation). |
| ST-12 | todo | split | device trust policy stays; auto-issue editor -> LX-34; store credentials, commerce and store-product mapping -> DX-07 | Each editor lives where the task happens instead of a generic API-only sweep. |
| ST-13 | todo | merge | DX-06 | The Listing editor is a tab of each storefront page; the hub hosts the same component. |
| ST-14 | todo | keep |  | One branding store, portal area visible with Identity off. |
| ST-15 | todo | drop |  | Pushback: promotes about seven hard-coded policies (seat dormancy, blob GC keep-N, feed depths, token caps, sessions, retention) into settings, the opposite of the owner's 'reduce configuration'. Promote one only when a product asks. |
| ST-16 | todo | edit |  | Keep live platform defaults with L2 confirm (licence defaults, Cloud Sync ceilings); drop enforce/delegate per entry and the fan-out matrix. |
| ST-27 | todo | keep | ST-27 (absorbs UX-37) | Alert destinations; EXPERIENCE's UX-37 alerts-from-attention rides the same destinations. |
| ST-17 | todo | keep |  | Resync dry-run and drift view keep the manifest/console model honest. |
| ST-18 | todo | edit |  | Keep promote-to-repo patch, pkey settings diff\|export, validate --against and settings:read; defer import. |
| ST-21 | todo | merge | AC-02 | A capability gate on settings writes only is a subset of RBAC. |
| ST-22 | todo | merge | AC-02 | Owner asks for full RBAC (Superadmin, Platform Admin, <Product> Admin, Console Access); no longer optional. |
| ST-23 | todo | split | copy-from-product -> DX-03; environment promote -> parked | 'Start from an existing product' belongs in the New Product wizard. |
| ST-24 | todo | keep |  | Small. |
| ST-25 | todo | edit |  | Also retire the dead core.adminGroup (after AC-02), licensing.clampGraceToExpiry, licensing.entitlementHolder, licensing.anchorPolicy and licensing.reanchor (after the LX-09/LX-10 edits), and autoIssue.mode/groupRoleMap/syncTierOnSignIn (after LX-34). |

#### Phase LX: Licensing model: licences, grants, entitlements (S-19)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| LX-05b | todo | keep |  | Scheduled flip; tiny. |
| LX-07 | in-review | keep | done | Merged (884e5780e); stamp done. Follow-up in ST-25: clamp always on, no per-product opt-out. |
| LX-08 | todo | keep |  | In review on its branch (migrations 0105_a..m, down script). Land it: expand-only and reversible. Grants become the storage of add-ons (owner's sub-licences); holder kinds nobody uses stay dormant and LX-16 drops them. |
| LX-09 | todo | edit |  | One model: anchor licence + its add-ons + the signed-in account's add-ons. 'legacy' survives only as a per-product migration mode with the report and is removed by LX-16; drop licensing.entitlementHolder (fixed 'device'). |
| LX-10 | todo | edit |  | Fix rank-first; drop the most-free-seats and oldest alternatives and the licensing.anchorPolicy setting. |
| LX-11 | todo | edit |  | Store purchase -> add-on (or base licence) mappings with fixed per-store restore defaults; expose dist_commerce_settings only where a store forces a choice; console home is DX-06's storefront page. |
| LX-12 | todo | merge | LX-33 | Grant expiry, refund and chargeback states are part of the one licence-terms model. |
| LX-13 | todo | keep |  | Developer backend grants API and webhook: the provider-neutral path that makes subscriptions work without Commerce. |
| LX-14 | todo | edit |  | Licence record gains Entitlements and Add-ons tabs; tier editor = config profile + entitlements + licensing defaults; comp = add-on, trial = term. Drop catalog combine/entitlementKind (entitlements leave the config catalog, LX-32) and move-grant (I-12 relink covers it). |
| LX-15 | todo | keep |  | What you own with sources; adopt the owner's 'Automatic grant' source wording. |
| LX-16 | todo | keep |  | Contract step; also drops LX-08 objects that the simplified model never reads. |
| LX-18 | todo | edit | LX-18 (absorbs LX-35's wire members) | One plan-mode licensing wire event carrying expiry, reasons and consumable quantity, not two all-SDK events. |
| LX-19 | todo | edit | LX-19 (absorbs LX-35's SDK API) | entitlement(key).quantity and redeem() ship with isEntitled/expiry in the same six-SDK pass. |
| LX-20 | todo | keep |  |  |
| LX-21 | todo | drop |  | reanchor: onRefresh adds a third re-anchoring mode; rank-first at activation plus attach/relink covers the cases. |
| LX-22 | todo | keep |  | Glossary follows DX-01 (add-on, floating, bound). |
| LX-23 | todo | edit |  | Apple auto-renewables and Play subscriptions become renewal sources of LX-33's term model; provider-neutral dunning moves to LX-33. No longer optional: the owner asks for subscriptions. |
| LX-24 | todo | reorder | parked with I-24a | Per-seat features; no owner ask. |
| LX-25 | todo | keep |  | Optional; redeem codes back add-on keys and CM gifting. |
| LX-27 | todo | keep |  |  |
| LX-29 | todo | edit |  | Build on DX-02's wizard kit (shared Stepper/drawer host); drop 'profiles in order' from More options (LX-32 retires profile stacks). |
| LX-30 | in-review | keep | done | Merged (5786044f1); stamp done. |
| LX-31 | todo | keep |  |  |

#### Phase SP: SDK parity pass (notes/SDK-PARITY-PASS.md)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| SP-00 | in-review | keep | done | Merged (c515bf0e8); stamp done. |
| SP-10 | todo | reorder | parked | Pushback: a plan-mode wire event to keep a second browser mode. Prefer bearer mode plus I-08's web redirect as the one browser mode and retire cookie mode; revisit only if a first-party app needs cookies. |
| SP-12 | in-review | keep | done | Merged (7228e0c45); stamp done. |
| SP-15 | todo | keep |  |  |
| SP-17 | in-review | keep | done | Merged (b141fa858); stamp done. |
| SP-20 | in-review | keep | done | Merged (297c369aa); stamp done. |
| SP-22 | in-review | keep | done | Merged (93d25e485); stamp done. |
| SP-23 | in-review | keep | done | Merged (084693d4f); stamp done. |
| SP-28 | todo | reorder | parked (demand-driven) | Steam depot transport for non-Godot desktop SDKs; no such product yet. |
| SP-29 | todo | reorder | parked (demand-driven) | MSIX/Flatpak pack transports. |
| SP-30 | todo | reorder | parked (demand-driven) |  |
| SP-31 | todo | keep |  | The Electron host's bridge v4; UK-06 wraps it, U-20 needs it. |

#### Phase HA: Hosted assets: Polaris Key hosts every file it serves (S-20)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| HA-09 | todo | keep |  | Fixes private-repo 404s. |
| HA-10 | in-review | keep | done | Merged (a999c0c67); stamp done. |
| HA-12 | todo | keep |  | In flight (lead round on its branch); additive discovery member. |
| HA-13 | todo | keep |  |  |
| HA-14 | todo | keep |  |  |
| HA-15 | todo | keep |  |  |
| HA-16 | todo | reorder | parked (optional) | What's New formatting is handled by fix/ux-polish-1007 (DX-10). |
| HA-17 | todo | reorder | parked (optional) |  |

#### Phase UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| UK-02b | todo | keep |  |  |
| UK-03 | todo | keep |  |  |
| UK-04 | todo | keep |  |  |
| UK-05 | todo | keep |  |  |
| UK-06 | todo | edit |  | Wrap SP-31's v4 host (deps += SP-31); the brief still says bridge v3 and a hand-written replacement. |
| UK-07 | todo | keep |  |  |
| UK-08 | todo | keep |  |  |
| UK-09 | todo | keep |  |  |
| UK-10 | todo | keep |  |  |
| UK-11 | todo | keep |  |  |
| UK-12 | todo | keep |  |  |
| UK-13 | todo | keep |  | In flight (design sign-off recorded on its branch); set in-review. |
| UK-14 | todo | keep |  | In flight (fix round); set in-review. |
| UK-17 | todo | reorder | after the DX/AC/LX waves | Should tier; owner keeps 'all major frameworks' but the brief's focus is admin DX. |
| UK-18 | todo | reorder | after the DX/AC/LX waves |  |
| UK-19 | todo | reorder | after the DX/AC/LX waves |  |
| UK-20 | todo | reorder | after the DX/AC/LX waves | Today on the computed critical path (4-6 wk) only because should-tier work is unparked. |
| UK-21 | todo | edit | UK-21 (absorbs X-02); after the DX/AC/LX waves | One Tauri path: sidecar bridge first, the native Rust plugin as an optional depth. |
| UK-22 | todo | reorder | after the DX/AC/LX waves |  |
| UK-23 | todo | reorder | after the DX/AC/LX waves |  |
| UK-24 | todo | reorder | after the DX/AC/LX waves |  |
| UK-25 | todo | reorder | after LX-33 and LX-23 | A StoreKit paywall needs the subscription term model. |
| UK-26 | todo | reorder | after the DX/AC/LX waves |  |
| UK-27 | todo | reorder | after the DX/AC/LX waves |  |
| UK-28 | todo | reorder | after the DX/AC/LX waves |  |
| UK-29 | todo | reorder | after the DX/AC/LX waves |  |
| UK-31 | todo | reorder | parked (could) |  |
| UK-32 | todo | reorder | parked (could) |  |
| UK-33 | todo | reorder | parked (could) |  |
| UK-34 | todo | reorder | parked (could) |  |
| UK-35 | todo | reorder | parked (could) |  |
| UK-36 | todo | reorder | parked (could) |  |
| UK-37 | todo | reorder | parked (could) |  |
| UK-38 | todo | reorder | parked (could) |  |
| UK-39 | todo | reorder | parked (could) |  |
| UK-41 | todo | keep |  |  |
| UK-42 | todo | keep |  | Owner's floating/bound activation in the web kits. |
| UK-43 | todo | keep |  |  |
| UK-44 | todo | merge | I-10a / I-10b |  |

#### Phase MO: Motion system for the portal and console (notes/S-23)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| MO-13 | todo | keep |  | Close-out. |

#### Phase PS: Polaris Key storefront: the Library as a distribution channel (S-21)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| PS-05 | in-review | keep | done | Merged (464c6780d); stamp done. |
| PS-05b | todo | keep |  |  |
| PS-06 | in-review | keep | done | Merged (0226e2824); stamp done. Follow-up: the panel moves into DX-06's Polaris Key storefront page (SETUP §8.3). |
| PS-07 | todo | keep |  | Owner: purchases in a third-party store reach the linked account automatically. |
| PS-08 | todo | reorder | parked with I-22 |  |
| PS-09 | todo | merge | LX-34 | An email-domain rule is one branch of the single access policy. |
| PS-11 | todo | keep |  | Also lands DX-01's storefront vocabulary in the docs. |

#### Phase CM: Polaris Key commerce (S-22): deferred until the owner's go

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| CM-01 | todo | edit |  | Re-plan on the new model: offers sell licences and add-ons; subscriptions ride LX-33's terms; a connected merchant auto-activates the paid path of the Polaris Key storefront; console home is DX-06's storefront page. |
| CM-02 | todo | edit | CM-02 (absorbs CM-03) | Provider abstraction and the merchant connection are one Store connection. |
| CM-03 | todo | merge | CM-02 |  |
| CM-04 | todo | edit | CM-04 (absorbs CM-09) | Offers, prices and coupons, including redemption at checkout. |
| CM-05 | todo | edit | CM-05 (absorbs CM-06) | One fulfil and reverse state machine (checkout, refunds, disputes). |
| CM-06 | todo | merge | CM-05 |  |
| CM-07 | todo | merge | CM-08 | One-time and subscription tier changes share pricing and reversal rules. |
| CM-08 | todo | edit | CM-08 (absorbs CM-07) | On LX-33's term model. |
| CM-09 | todo | merge | CM-04 |  |
| CM-10 | todo | reorder | parked (could) | Gifting. |
| CM-11 | todo | edit | CM-11 (absorbs CM-16) | Portal billing and prices on Discover/product page in one portal package. |
| CM-12 | todo | edit |  | Becomes tabs (Merchant, Offers, Orders, Subscriptions) of DX-06's Polaris Key storefront page plus a platform merchants view, not a separate Commerce area. |
| CM-13 | todo | keep |  |  |
| CM-14 | todo | keep |  | Plan-mode wire; if timing allows ride the same corpus event as LX-18. |
| CM-15 | todo | keep |  |  |
| CM-16 | todo | merge | CM-11 |  |
| CM-17 | todo | keep |  |  |
| CM-18 | todo | reorder | parked (owner G6) |  |
| CM-19 | todo | reorder | parked (owner G5) |  |

#### Phase X: Optional SDKs

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| X-01 | todo | reorder | parked (optional) |  |
| X-02 | todo | merge | UK-21 | One Tauri package. |

#### Phase D: Diceroll adoption (vladzaharia/diceroll)

| id | status today | action | target | note |
| --- | --- | --- | --- | --- |
| D-01 | todo | keep |  | External repo; no Polaris Key change. |
| D-02 | todo | edit |  | Dogfood the new onboarding: create Diceroll with DX-03's wizard and DX-04's Connect your app instead of pkey init plus a platform-admin registration; declare the supporter entitlement in licensing (LX-32) and use the access policy (LX-34) instead of autoIssue.mode. |
| D-03 | todo | keep |  |  |
| D-04 | todo | keep |  |  |
| D-05 | todo | keep |  | Paid packs map to LX-11 add-ons. |

---

## 10. New work packages

Two new phases (**DX**: developer and administrator experience consolidation; **AC**: access control
and console accounts) plus additions to LX, F, I and P2. Ids take the next free number in each
existing phase (P/README.md §8). Estimates are first cuts for the lead to re-size.

| proposed id | title | scope | deps | plan mode |
| --- | --- | --- | --- | --- |
| DX-01 | Vocabulary decision: distribution channel, storefront, outlet, update channel; add-on (sub-licence) vs grant; floating vs bound; config types and visibility names | Docs only (AGENTS.md rule 4 glossary): one word per concept before any UI copy changes; maps UI words to identifiers that stay (outlet, grant, managementState) so no wire or schema rename is needed. | none | no |
| DX-02 | Wizard kit and setup state (SETUP.md UX-50 + UX-51) | `ui/wizard/*` (page and drawer hosts, Stepper, PrereqList, SnippetStep, DeepLinkStep, WaitingFor, AutoList, SecretField) and the `setup_state` table with `GET/PUT …/setup`, consent and audit. Every later wizard (LX-29, DX-03/04/06/07) builds on it. Folds UX-80's wizard motion. | none | no |
| DX-03 | New Product wizard with defaults (UX-73 to UX-76, ST-23's copy-from-product) | Create with services through the chain rule, planned platforms, starter tier, presentation and release trust policy in one batch; "Start from an existing product" copies settings once; the ready moment hands off to the Integration section; retires `Welcome.tsx`. | DX-02 | no |
| DX-04 | Integration section: Connect your app, per-service quick starts, dismiss after a verified handshake (UX-60, UX-61, UX-63, UX-64, UX-65, UX-21) | `renderSdkSetup` goldens per SDK (replaces Overview's `snippet()` and the CLI's `sdkSnippet()`); Connect your app with SDK sightings (server-only, from `X-PKey-SDK` headers); test licence auto-created; quick starts per enabled service with example code; "Hide integration" offered once a sighting plus a successful document fetch is observed, per product, remembered in `setup_state`, re-openable from the sidebar. | DX-02, DX-03 | no |
| DX-05 | Context sidebars and console IA | Platform sidebar vs Product sidebar switched by route context; Distribution reduced to Storefronts (sub-entries for live or relevant storefronts), Rollouts, Health, Packages; Integration entry; settings hub links (ST-08); UX-09, UX-13, UX-14, UX-26 and UX-66's sweeps; `LEGACY_REDIRECTS` for moved pages. | DX-01, ST-08 | no |
| DX-06 | Storefront catalogue, platform scope and one page per storefront (UX-52, UX-53, UX-54, UX-57, ST-13) | Catalogue entries beside each adapter; `productPlatforms` scope (no macOS storefront without a macOS build or declared platform); one page per storefront combining channel status and commerce where both are on, the wizard where one side is off; PS-06's panel and CM-12's tabs live here. | DX-01, DX-02 | no |
| DX-07 | Storefront wizards and the setup runner (UX-55, UX-56, UX-68; ST-12's store editors) | Human steps only; the runner performs every automatable action after one Set up consent and on fact changes; existing platform or product credentials activate a storefront on confirmation; a channel that implies its storefront activates both; `pkey storefront add` and `pkey storefronts sync`. | DX-06, A-18k | no |
| DX-08 | Publish everywhere and an auto-publish policy (UX-58 + SETUP.md §8.4 decision) | One dialog publishing a release to every live storefront with prepared submissions; a per-storefront "send new stable releases automatically" policy: who may arm it, audit, halt; security review. | DX-07 | yes (security plan) |
| DX-09 | GitHub write path and Publish from CI (UX-70, UX-71, UX-62) | Setup pull request (outlet blocks, workflow), release environment and `v*` ruleset, trusted-publisher policy with the recommended scope, CI installation-token exchange; One-command fallback without the App's optional permissions (owner action: DEPLOYMENT.md permissions). | DX-02 | no |
| DX-10 | Owner's minor console and portal fixes (`fix/ux-polish-1007`) | Register the in-flight branch: What's New formatted and summarised, device count as a pill, "Automatic grant" licence source, tier pill top-right of License Details, no "0 out of 5 devices", simplified product card with service icons and phone pips. | none | no |
| AC-01 | Plan: RBAC and console sign-in on Polaris Key accounts | Roles (Superadmin, Platform Admin, `<Product>` Admin, Console Access, feature-scoped grants such as Storefront settings), sum of roles, OIDC group and claim mappings, the no-access page, migration from `PLATFORM_ADMIN_GROUP` and the dead `core.adminGroup`, break-glass, threat-model rows. No device wire. | none | yes (security plan) |
| AC-02 | RBAC enforcement: `can()` on every admin route and settings write (absorbs ST-21, ST-22) | Role and assignment tables, mapping evaluator, shadow mode for one release, audit, `useCan` (hide or disable with a reason), "Ask an administrator" page; OpenAPI and `routeCoverage`. | AC-01, ST-05 | no |
| AC-03 | Console sign-in on the Polaris Key account | Operators are accounts; Pocket ID becomes one mapped OIDC connection; one identity for console and portal; UX-02's session states and UX-42's card. | AC-01, AC-02 | no |
| AC-04 | Members and roles in the console | Platform and per-product Members pages, invitations by email, role changes with step-up and audit. | AC-02 | no |
| LX-32 | Entitlements leave the config catalog; tiers own profile + entitlements + licensing defaults | A Licensing-owned entitlements catalog (manifest block and console page); config keeps config, secret and minted; tiers hold one profile (not overridable at the tier), entitlements and licensing defaults; `license_profiles` stacks retired for licence-level overrides. Target: signed documents and the schema body unchanged. | LX-08, ST-05 | yes |
| LX-33 | Licence terms: lifetime, fixed expiry, version-scoped, renewable, renewable with perpetual fallback (absorbs LX-12 and LX-23's dunning) | One term model on licences and add-ons; renewals from any source (admin, LX-13 API, store, checkout) so subscriptions work with Commerce off; perpetual fallback pins `app.maxVersion` to the last version released while active and limits downloads to it. Server-only. | LX-08, LX-13 | no |
| LX-34 | Access policy on sign-in (absorbs ST-12's auto-issue editor and PS-09) | One setting and one editor: everyone gets tier X; mapped by OIDC group, claim or email domain; or nobody (refuse). Auto-minted licences attach the device and mint no key (an admin can add one later); Discover uses the same policy. Replaces `autoIssue.mode`, `groupRoleMap` and `syncTierOnSignIn`. | ST-05, LX-08 | no |
| LX-35 | Consumable entitlements: quantity and redemption | Add-ons carry a quantity (bought N times); an idempotent redemption ledger and route; SDK `entitlement(key).quantity` and `redeem()`. Rides LX-18/LX-19's one wire event. | LX-32, LX-33 | yes |
| F-33 | Account access tokens and per-account package visibility | One token per account (customer or operator) across every feed and product it holds, plus CI tokens; packuments and indexes filtered to what the account may install; Polaris Key SDK packages visible to developer roles only; per-product `registry_tokens` keep working. | AC-02 | no |
| F-34 | Upstream publish to public registries (CI-plane) | `pkey release publish` and the Action push the same package to npmjs, PyPI and others with trusted publishing; the Polaris Key record stays the source of truth; the console shows upstream status. | F-10 | no |
| I-27 | SSO connections by email domain; a product's own IdP as a login-card method | Platform enterprise OIDC connections, each with several verified email domains, routed from the identifier-first card; a product's own IdP as a card connection (replacing the legacy `oidc.provider: custom` path); magic link always available. | none | no (security review) |
| I-28 | Profile: screen name and birth date | Screen name chosen from linked providers or typed; birth date from OIDC where present, overridable, shared only by consent; an age-gate flag reserved for later. | none | no |
| P2-08 | `dev` as a built-in update channel; tier gating defaults | `BUILT_IN_CHANNELS` becomes stable, beta, dev (`packages/shared-manifest/src/index.ts:1149`); new tiers grant stable only; promote and demote wording on the release record. Check against P0-04's channel vocabulary first. | none | no |

### 10.1 The shadow backlog, mapped

Every `UX-*` package that is neither landed nor superseded, and where it goes:

| UX id | Name | Goes to |
| ----- | ---- | ------- |
| UX-02 | Console session states | AC-03 |
| UX-06b | Entity search | parked (ST-10 covers settings search) |
| UX-07 | License record Status tab | LX-14 |
| UX-08b | Devices on this version | parked |
| UX-09, UX-13, UX-14, UX-26, UX-66 | Copy sweep, chrome, page anatomy, IA moves, empty states | DX-05 |
| UX-11, UX-45, UX-46 | Pill and copy sweeps, Library copy, product page | DX-10 and DX-01 |
| UX-12, UX-37 | Attention model, alerts | ST-27 (destinations); the attention read waits |
| UX-21 | Launch path | DX-04 |
| UX-25, UX-27, UX-36, UX-49 | Person drawer, server activity search, bulk licence actions, portal on the shared kit | parked |
| UX-30, UX-67 | Platform Status, Platform ready | ST-09 |
| UX-33 | Packages producer side | DX-06 (Packages item) and F-33 |
| UX-35, UX-44, UX-47, UX-48 | Moments, email, activation Done, account | closed (MO-11, I-07/I-18, PX-17/UK-42, PX-13/PX-22) |
| UX-40, UX-41, UX-43 | AuthCard, passthrough steps, Worker twin | PX-12, PX-14, I-08 |
| UX-42 | Console sign-in | AC-03 |
| UX-50, UX-51, UX-80 | Wizard kit, setup state, flow motion | DX-02 |
| UX-52, UX-53, UX-54, UX-57 | Catalogue, read model, shell, status pages | DX-06 |
| UX-55, UX-56, UX-68 | Wizard steps, outlet block generator, setup runner | DX-07 |
| UX-58 | Publish everywhere | DX-08 |
| UX-60, UX-61, UX-63, UX-64, UX-65 | SDK generator, Connect your app, quick starts, sign-in wizard | DX-04 |
| UX-62, UX-70, UX-71 | Publish from CI, GitHub write path, CI token exchange | DX-09 |
| UX-73, UX-74, UX-75, UX-76 | New Product wizard | DX-03 |

---

## 11. Quick wins

1. **Stamp the 18 merged `in-review` packages done** (`check.mjs --set <id> done`), moving their
   remaining human steps (P1-12 store uploads, PX-W3's `DOWNLOAD_TICKET_KEY`, I-18's DNS and Apple
   relay) into HANDOFF.md.
2. **Set the in-flight packages' real status:** LX-08 `in-review`, HA-12 `in-progress`, UK-13
   `in-review`, UK-14 `in-progress`.
3. **Park the 35 optional or demand-driven packages** (`optional: true`, deferred) so `--ready`
   and `--critical` stop routing through UK-20 and the could tier.
4. **Merge the paired briefs** (U-11a/b, U-15a/b, U-12/U-24a, PX-W19/PX-25, PX-W11/PX-18,
   I-19/PX-19, the CM pairs, PX-W9b and UK-44 into I-10a/b, PX-W18 into I-08): docs only, one PR.
5. **Register `fix/ux-polish-1007` as DX-10** so the owner's six portal fixes and the product card
   are tracked and reviewed like any package.
6. **Label `core.adminGroup` as not enforced** in its registry description and console read-out
   until AC-02 (`W/admin/handlers/products.ts:296-301` stores it; nothing reads it).
7. **Hide `licensing.anchorPolicy`, `licensing.entitlementHolder` and `licensing.reanchor`** from
   console editing (keep their defaults) pending ST-25's removal.
8. **Add UK-06's missing dependency on SP-31**, so the Electron kit does not write a second bridge.
9. **Ask the owner for A-18k's credentials now**; DX-07's automation depends on its answers.
10. **Add §10.1's mapping to `P/README.md` §9** and a "→ DX-nn" column to SETUP.md §8.2, so nobody
    dispatches a `UX-*` row by its old id.

---

## 12. Cross-domain dependencies

- **Licensing auditor:** the exact shape of LX-32 to LX-35, the simplified LX-09/LX-10, add-on
  naming over LX-08's `grants`, and whether `legacy` mode can be removed once djdl reads its report.
- **Config auditor:** catalog kinds after `flag` leaves (config, secret, minted), the server-side
  precedence user > licence > profile > default (U-03's account layer plus licence overrides), and
  retiring `license_profiles` stacks.
- **Identity auditor:** I-09's default flip (bound licences need sign-in), I-27's domain routing,
  AC-03 reversing I-03/I-17, I-28, consent scopes in I-08/PX-14.
- **Release and distribution auditor:** DX-06 to DX-09, P2-08 (`dev` channel), the vocabulary in
  DX-01, and whether Update should fold into Distribution's toggle (`tools/services.json` chain
  release ← distribution ← update) to cut one service switch.
- **Commerce auditor:** the CM merges, LX-33 owning terms and dunning, whether Commerce becomes its
  own service slug instead of living under Distribution, and CM-12 inside the storefront page.
- **Feeds auditor:** F-33 and F-34; conflict between gating SDK feeds and SETUP.md D17's anonymous
  install lines in Connect your app (developers and CI need tokens first).
- **Console IA auditor:** DX-05's sidebars, ST-08/ST-09 ordering, AC-04's pages, the 48-page nav
  (`A/console/nav.ts`).
- **Portal auditor:** PX-09's package-manager instructions, PX-18's merged scope, DX-10's tier pill
  reversing UX-03.
- **Cloud Sync auditor:** parking collections; consumables in Licensing (LX-35) rather than
  `server`-class collections.
- **SDK and UI-kit auditor:** the merged SDK waves (I-10a/b), UK should-tier ordering, SP-10's
  cookie-mode retirement, UK-06 on SP-31.
- **Security:** AC-01, DX-08, F-33 and I-27 each need a review and THREAT-MODEL rows before merge.
- **Code-quality auditor:** the duplicate generators (`Overview.tsx` `snippet()` and the CLI's
  `sdkSnippet()`), `CreateLicenseDialog` vs LX-29's wizard, and the dead authz scaffolding.

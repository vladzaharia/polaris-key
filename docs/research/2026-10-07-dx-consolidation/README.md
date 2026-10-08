# Polaris Key DX consolidation: the plan (2026-10-07)

**What this is.** The consolidation plan for the developer and administrator side of Polaris Key,
answering the owner's brief ([`owner-brief.md`](owner-brief.md)). Fifteen audits read the whole
product (v0.8.31 plus batch 5, and the batch-6 branches LX-08, HA-12, UK-13, UK-14 and
`fix/ux-polish-1007`, all since merged into `integ/batch-6`); [`integration.md`](integration.md)
settled their disagreements, and three critiques (coverage, feasibility, simplicity) were applied
(§11). This file is what the owner reads. Where this file and `integration.md` differ in detail,
`integration.md` is the decision record.

| File                                           | For                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `README.md` (this file)                        | the target, what gets simpler, the order, the owner's six open decisions                    |
| [`tracks.md`](tracks.md)                       | each track's goal, packages in order, dependencies and exit criteria                        |
| [`backlog-changes.json`](backlog-changes.json) | the graph edits: all 199 open packages, 140 new ones and every `UX-*` row, machine-readable |
| [`integration.md`](integration.md)             | the decision record (concept model, 58 conflict resolutions, glossary)                      |
| [`audits/`](audits/)                           | the evidence, with file and line references                                                 |

**In one paragraph.** Polaris Key keeps its seven services and its wire, but the console stops
showing them as seven switches and six setup surfaces. A product becomes **five features**
(Licensing, Managed config, Ship builds, Sign-in, Cloud Sync) created by a two-or-three-step
wizard that lands on one **Integration** page with code generated for that product and a
per-platform **Verified** tick read from the SDK headers every SDK already sends. A licence is
**in an account, waiting or floating**; every licence has a **tier**, its template; **add-ons**
are its sub-licences; one **access policy** decides who gets one automatically; one resolver gives
its **limits** (licence > tier > platform default) and one **duration** model gives lifetime,
fixed, trial, version-scoped, renewing and "keeps the last version" licences, with or without
Commerce. Every person is an **account**, operators included, and the console runs on the owner's
**four summed roles**. A **channel** is where builds go and a **storefront** is the same
channel's selling side, on one page, shown only when the product can use it. The code is
consolidated first (one route table, one data layer, one wizard kit, one generator registry, one
data-migration runner), so features stop adding copies, and every schema contract takes two
releases so a deploy never breaks the Worker still serving.

---

## 1. Principles, and how they were applied

| Owner principle              | How the plan applies it                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consolidate similar features | 7 service switches → 5 features; 6 setup surfaces → 1 Integration page; 11 Distribution nav items → 5 plus one entry per relevant channel; 4 snippet generators → 1; 3 licence-minting knobs → 1 access policy; 4 credential stores → 1; 3 product access pages → 1; 35 open packages merged, split or dropped into others                                                                                                                   |
| Flexibility, to an extent    | Keep choices that change what a customer gets (limits, duration, access policy, visibility, channels, offers). Remove choices that tune internals (anchor policy, entitlement holder, re-anchor mode, clamp opt-out, refund grace, upgrade-on-sign-in, registration policy)                                                                                                                                                                  |
| Reduce configuration surface | Licensing settings 7 → 1; the product layer of licence defaults → 0 (tiers carry them); 26 planned commerce settings → 4; three test-purchase switches → 1; Discover listing settings 3 → 1; the four per-product portal sign-in toggles → 0; planned Cloud Sync limits 4 → 2 settings plus one entitlement; no new table or route for setup choices; ST-15's seven policy settings never created. The full added-vs-removed ledger is in §3 |
| Excellent onboarding         | One wizard kit (ST-39); New Product wizard (ST-43); Integration page with generated snippets per feature and SDK (ST-41, SP-33a); channel wizards with human steps only (A-23); examples built in CI (SP-36); one start path in the docs (SP-37)                                                                                                                                                                                             |
| Automate what can be         | One-batch product create; feeds provision themselves; a channel whose credentials are already held enables in one confirmation; channel and storefront activate together; testing tracks get every release; store identities derived, never typed; feed cleanup on by default; trials convert to their tier; sign-in for in-account licences switches on per product when its SDKs are ready                                                 |
| Degrade gracefully           | Every feature has a defined "off" behaviour (`integration.md` §1.4): subscriptions work with Commerce off; a channel page shows whatever each source provides; email off turns invites into copyable links; a missing pack transport falls back to the CDN; store channels without verified credentials show human steps                                                                                                                     |

Five further rules the plan imposes on itself:

- **No wire change unless unavoidable.** `PROTOCOL_VERSION` stays 4. Three wire trains remain
  (identity, licensing-and-commerce, update resolver) plus two contract-text slots, all additive
  with the corpus appended (§9). The channels predicate is never changed.
- **Code quality first.** The shared mechanisms land before the feature tracks need them, so no
  feature package builds a second copy (`tracks.md` rule 4).
- **Contracts take two releases.** Release N stops every read and write; release N+1 drops the
  table after a production check; value changes run through one data-migration runner (P0-49)
  with a dry run and a report (`tracks.md` rule 5).
- **Windows are days, not releases.** The project ships several releases a day, so every
  deprecation or safety window is stated in days and ends on a production fact (`tracks.md`
  rule 6).
- **Identifiers stay.** UI words change (outlet → Channel, grant → Add-on, update channel →
  Release track, ManagementState → Editable/Read-only/Hidden); stored and wire identifiers do not.

---

## 2. The target, area by area

### 2.1 Products and onboarding

- **A product** is one registry row: its signing key, a **Presentation** (name, icon, accent —
  the one source for the sign-in header, consent, emails, portal, kits and Discover), its
  enabled services, its recorded setup choices (`core.setup`, one audited setting) and its
  members' roles.
- **Five features** over the seven unchanged service slugs: **Licensing**; **Managed config**;
  **Ship builds** (release and distribution, with In-app updates on by default); **Sign-in**;
  **Cloud Sync** (turns on config and identity with it). Each feature's row holds its own
  switches (Package feeds, Customer portal, Polaris Key storefront visibility, Minted tokens) and
  shows its facts as status (Commerce is a fact: a storefront is ready). Raw slugs are read-only
  under Advanced and the registration policy is always derived. Discovery and the SDK constants
  are byte-identical (ST-38).
- **Creating a product** takes two or three steps: pick a repository (checked) or type a name,
  say what it is for (the same five features, platforms, a Free tier), Create. One database batch
  makes the key, a Default config profile, catalog v1, the Free tier, the services, the release
  trust policy and the planned platforms, then lands on Integration (ST-42, ST-43).
- **Integration** is one page and one Overview card. For each enabled feature it shows what the
  console still needs, a snippet generated for this product and SDK, and **Verified** per
  platform. Verified means an SDK was seen getting a 2xx from that feature's routes (from the
  `X-PKey-SDK` headers every SDK already sends; no wire change), once the feature's console
  prerequisites are met; only a first package publish from CI and the updater's first check
  (Wired), which send no SDK header, are separate facts. **Hide Integration** unlocks at the first
  Verified feature, is the operator's recorded choice, and never happens on its own: the one-time
  backfill from `devices.sdk_name` marks mature products Verified so the choice is offered at once,
  and hides nothing (ST-40, ST-41).
- **Developers** start from one file, `polaris-key.json`, read by `fromConfig()` then `boot()`
  in every SDK (SP-32a, SP-32b). The one snippet generator lands first on the names SDKs ship
  today (SP-33a), so the Integration page does not wait for the SDK API work; SP-33b moves it to
  `polaris-key.json` and feeds `pkey sdk add`, the Godot dock and the docs.
- **Console shell.** One Home (cards or table, attention from one server read, Platform ready)
  replaces Home plus Products; the product card stays the name/slug header plus enabled-service
  icons, pips on phones (ST-36, kept by ST-44). The sidebar switches between a Platform context
  and a Product context (ST-45).

### 2.2 Licences

- **Three holder states**: **in an account**, **waiting** (assigned to an email not yet
  verified) or **floating** (no holder; its key activates devices). `licenses.account_id` is the
  only owner pointer; `portal_license_links` retires (I-28) and `licenses.sub` stops being an
  owner key after I-32's sunset of custom issuers.
- **A licence in an account needs sign-in** on products with Sign-in on, by default: LX-39 turns
  it on product by product once every SDK version seen on that product supports the sign-in path
  (from ST-40's sightings, with a report first), and LX-31 makes it the default for new products
  once the rebuilt kits ship. Floating keys work as today; accounts are never required.
- **Tier** = a licence template, and **every licence has one** (tierless licences move onto a
  Default tier seeded from today's product defaults): list order, at most one config profile,
  entitlements, **limits** (devices, offline days, channels, versions, fingerprint mode) and a
  **duration**.
- **Limits resolve licence > tier > platform default**, exactly the brief's chain, through one
  resolver that reports where each value came from; the product layer and `license.defaults.*`
  go (LX-32, LX-33). Channels are a base set (licence, else tier, else stable) that add-ons can
  only add to. "dev includes beta" is applied by the editors when they store a choice; grants are
  matched as stored on the wire. The version window comes only from the licence the device runs
  on.
- **Automatic licences.** One setting, `license.access`: Nobody, Everyone → a tier, or rules
  (an IdP group, a verified email domain or a claim → a tier or an add-on), plus an Anonymous
  devices tier. One evaluator serves sign-in, the sign-in card, Discover, the storefront and
  minted tokens (LX-36); it lives on the product's one **Access** page (P2-10). Automatic licences
  belong to the account, mint no key, bind the device at once, are unique per account and product
  even under concurrent sign-ins, and upgrade on later sign-ins with no setting; an admin can add a
  key later; Discover self-mint is the same function for every account (LX-38).
- **Choosing among a person's licences** is one `rankLicenses()` (the one covering the running
  build first); a device moves only when its licence stopped covering it (LX-10).
- **Settings**: from seven to one (`license.dunningGraceDays`, shown only when a subscription
  exists) (LX-40).

### 2.3 Entitlements, durations and subscriptions

- **Entitlements move from Config to Licensing** (LX-34): a catalog with kinds **feature**,
  **quantity** and **consumable**, plus **platform entitlements** (`channels`,
  `app.minVersion`/`maxVersion`, `deviceLimit`, `license.tier`, `pkey.cloudSync.bytes`), each
  shown only while its service is on. Devices still receive them as `/config/schema` `flag` rows,
  so no SDK changes.
- **A device's entitlements** come from one licence: tier entitlements → licence overrides →
  its add-ons (features any-of, quantities summed) → platform keys. No device layer, no merging
  across a person's licences (LX-09 trimmed).
- **Add-ons are the sub-licences** (IAPs, DLC, feature packs, seat packs, consumables): a
  template with entitlements or units, held by a licence, from a store purchase, checkout, code,
  access rule or comp (LX-35). Every grant references an add-on; a one-off comp is a licence
  entitlement override. **Consumables** carry a quantity and a redemption ledger and are a
  required member of the licensing wire train (LX-18, LX-42, CM-28), so in-game currency works.
- **A duration** says how long a licence runs: lifetime, fixed, **trial** (a fixed duration that
  converts to a tier at its end, e.g. 14 days of Pro, then Free), version-scoped (with a "1.x"
  helper), renewing, or renewing with **keeps the last version** (the JetBrains model: after lapse
  the licence runs the last version released while it was active). One **Core subscriptions**
  table serves every source (manual, external, App Store, Play, Polaris Key) with states
  trialing, active, past due, canceled and expired, and an admin renew API, so subscriptions work
  with Commerce off (LX-41). LX-23 adds Apple and Play, including their free trials and
  introductory offers, and is now required.
- The owner's examples all fit: a one-year licence with that year's updates forever (fixed
  duration + keeps the last version); 1.x forever, 2.x by subscription, 3.x fixed with fallback
  (one licence per major line, each with its own duration; the console offers "Start a 2.x
  tier…" when a new major ships, LX-43).

### 2.4 Managed config and Cloud Sync

- **Three entry types**: **Setting**, **Secret** (write-only in the console, read-only in the
  app) and **Minted token** (its recipe lives on the catalog entry; the value is never stored)
  (U-30, U-31).
- **In-app visibility** applies to settings: **Editable**, **Read-only**, **Hidden**. Pushback:
  not every type × visibility. A user-editable secret contradicts "write-only"; listing a secret
  read-only would change the wire; a minted token is always code-only. Nine cells become five.
- **One chain on the server**: catalog defaults → Default profile → tier profile → licence
  overrides → account overrides; on the device, unchanged: a lock wins, then the person's own
  choice (synced), then environment, then the remote default. This is the owner's "user >
  licence > profile > defaults". It needs **cancelling U-03's pending licence-override run**
  (owner decision 1); its machinery (about 3,000 lines, 2 tables) is deleted over two releases
  (U-27, U-27b, U-28).
- **One effective-config read** returns every value with where it came from, so the console
  never re-merges (U-29; it also fixes today's lock bug).
- **Cloud Sync** has two stores: **synced settings** on the config API SDKs already ship
  (`config.set`/`setting(key)`/`onConfigChange`; every Editable setting syncs by default) and one
  **records store with files**, where **saves** are a template. The first SDK surface is saves
  only. One conflict vocabulary. The quota is the `pkey.cloudSync.bytes` entitlement alone (a
  default, tiers override), with one ceiling and a writes-paused switch (U-01b, U-05, U-09, U-10,
  U-22, U-23).

### 2.5 Release and distribution

- **A distribution channel** is a place builds reach customers: one entry in
  `tools/channels.json` (platforms, formats, deliverable kinds, what the customer does, verbs,
  setup steps, an optional storefront side), generated into the Worker, console, portal and CLI
  (A-19). "Outlet" stays the code word only.
- **Scope**: the console, portal and CLI show only channels that fit what the product builds or
  plans to build, by OS and CPU architecture. A Windows-only product never sees an Apple channel;
  an arm64-only build offers no x64 download or installer (A-20, A-26).
- **States**: one four-state vocabulary per side: **Not set up** (with "one click" when
  credentials are already held at platform or product level, so one confirmation turns the
  channel on: Homebrew, for example), **Ready**, **Live**, **Attention**. Unavailable channels are
  hidden and "not using" is a recorded choice. Store identities (bundle id, package name, Steam
  app id) are derived from the platform pin, never typed twice (A-28, A-23, A-33).
- **One page per channel**, tabs Status, Releases, Listing, **Sales**, Setup. The Sales tab shows
  only when the storefront side is set up, otherwise its wizard; each side shows whatever its
  own source provides (A-22).
- **Setup**: wizards list human steps only; the setup runner performs everything automatable
  after one consent and re-runs when facts change (A-23). Non-store channels automate now; each
  store's rows stay human steps until A-18k's live verification of that store's credentials.
- **Publishing**: one Publish dialog for every live channel; testing tracks (TestFlight groups,
  Play tracks, Steam branches) get every release through the channel's track map; production
  store submission is one typed click. Halt everywhere includes the stores (A-24).
- **Customers** get one model of what to do per channel: download, store link, install source,
  package-manager steps, package-feed setup, all applicable ones per platform (A-26, PX-09).
- **Listing** has one source, inheriting from Presentation (A-27). Each release publishes
  `SHA256SUMS`; MD5 is refused (A-30).

### 2.6 Packages, release tracks, updates and packs

- **Packages**: a declared package gets a Polaris Key feed automatically, **Customers** by
  default; access is Public or Customers, with today's Entitled feeds migrated onto each
  deliverable so nobody gains access (F-34). One **personal token** (`pkeyp_`) per person reads
  every package they may install across products; a token is either packages-only or admin,
  never both; the portal shows one combined setup; `pkey feeds setup --write` mints its own
  packages-only token and configures every package manager (F-33, F-37). Service tokens are
  `pkeyci_`. Our SDKs stay installable by exact name but are listed only to console members
  (owner decision 3).
- **Public registries** (npmjs, PyPI first) through CI trusted publishing: no secret held by
  Polaris Key, stable and beta only, per-package approval (F-35).
- **Cleanup**: today's rule (prereleases at or below a version are pruned when it ships on
  stable) turns on by default for every product and covers `dev`, after a dry-run notice; no new
  setting (F-36).
- **Release tracks** (the UI word for update channels): `stable`, `beta` and `dev` built in, plus
  custom; a release can be promoted and **demoted** (a per-track yank); store testing tracks map
  from them by default (P2-08, P2-09).
- **Access**: one product page answers who gets what: automatic licences, anonymous devices,
  Discover visibility, and the gates on downloads, update checks, packs and package feeds, in one
  vocabulary (Public, Signed in, Customers, Holds an entitlement) (P2-10).
- **Updates page**: updater setup only for the platforms you ship (Sparkle, WinSparkle, Velopack,
  App Installer, zsync, Play in-app updates, Godot), with a **Wired** tick from real update checks
  (P2-11). One update resolver replaces the GitHub-resolved second one (P2-12).
- **Packs**: transports `auto` (Background Assets on Apple, depots on Steam, the CDN elsewhere);
  the entitlement gate is approved once from the manifest (P4-33, P4-34).

### 2.7 Commerce

- **A fact, not a service.** The Commerce group (one Storefronts overview, Offers,
  Purchases) appears when Licensing is on and a storefront can connect. No new service slug: that
  would be an all-SDK wire event.
- **A storefront** is the selling side of a channel (App Store, Google Play, Steam, Microsoft
  Store, itch.io, Polaris Key). It activates with its channel when one credential serves both
  (A-33); its row in the Storefronts overview opens the same channel page on Sales.
- **An offer** is defined once (it sells a tier or an add-on, one-time or subscription, a
  quantity); each storefront has a **SKU** for it, including `app` for the paid app itself.
- **Prices and territories**: one base price converted with each store's own tools (Apple price
  points, Play `convertRegionPrices`) under a typed confirmation, and territory availability per
  SKU; Steam and itch.io get copy cards with deep links (no price API); the storefront page shows
  no store prices (CM-23).
- **One purchase ledger and one revocation path**: a full refund or chargeback revokes at once;
  a store purchase on a linked account lands on that account's licence, issued automatically if
  needed; Steam ownership is re-verified (CM-22, CM-24). Subscriptions are listed on the licence
  and linked from Purchases.
- **Settings**: 26 planned keys become 4; three test-purchase switches become one.
- **Polaris Key paid checkout (Stripe)** is owner decision 5.

### 2.8 Identity

- **One account per person**, operators included: sign-in methods, a profile (**screen name**,
  picture, an optional birth date that apps never receive; age checks wait until a product gates
  content), Library, consents and personal tokens.
- **Connections**: an upstream OIDC provider configured once, at platform or product scope, with
  DNS-verified email domains (several per connection, optionally enforced), an audience and a
  claim map. The email you type routes you to your organisation's SSO. Pocket ID becomes one
  seeded connection; Google, Apple and Steam are built in (I-30). One Platform → Connections page
  holds sign-in providers, SSO, email and, once P0-28 lands, store connections (I-31). A product's
  own account system is a **product connection** (I-32).
- **Email code and passkeys are always available** (except where an organisation enforces its
  SSO for its domain); the per-product toggles retire only once enforcement exists, so a product
  that wants SSO-only keeps it (I-29); store sign-in turns on with the store channel.
- **One authorization server per product**: I-08's `authorize`/`token` take an OAuth 2.1 shape
  now, and "Sign in with <Product>" (I-21) extends the same endpoints later.
- **Consent** can be granted in part, and changed or revoked under Connected apps (I-34). New
  accounts finish through one step: screen name, picture, birth date if offered, terms (I-33,
  PX-21).

### 2.9 RBAC and administration

- **Operators are accounts with console membership.** The owner's four built-in roles, which
  add up: **Superadmin**, **Platform admin**, **Product admin** (per product or all products,
  optionally narrowed to areas: a storefront manager is a Product admin narrowed to Ship builds
  and Commerce) and **Console access**. Areas are stable ids declared on every admin route
  (Licensing, Managed config, Ship builds, Sign-in, Cloud Sync, Commerce, Core, Keys, Settings,
  Members), so moving a page in the sidebar never changes anyone's access; a drift gate enforces
  it. No deny rules and no custom roles in v1; Product editor and viewer roles wait until a
  product asks. Membership is one table of role bindings; an invite is a binding on an email.
- **SSO rules** map an IdP group, a verified domain or a claim to a role; they are one platform
  setting in the same rule format and editor as `license.access`. A domain rule matches only an
  email vouched by a DNS-verified, enforced connection (ST-32, after I-30).
  `PLATFORM_ADMIN_GROUP` maps to Superadmin as a root rule that cannot be removed, so today's
  operators need no setup and nobody can lock everyone out. The console needs a strong method: a
  passkey, or an allowlisted SSO connection for operators; an email code alone is refused, and a
  method added mid-session counts only after step-up (ST-28..ST-32). Break-glass `ADMIN_OIDC_*`
  stays at least 30 days and goes only after 14 days unused with two Superadmins on passkeys.
- **Every admin route** is declared in one deny-by-default table checked by `can()`, the docs
  gate included; a member without access sees a page naming who can grant it, never a dead end
  (ST-29, ST-31).
- **The CLI** uses `pkey login` and a role-bounded admin token; `PKEY_ADMIN_COOKIE` retires after
  30 days unused (ST-34).
- **Platform settings** are ordered by how often they change (Recently changed, Platform ready,
  Product defaults, Sign-in, Storefront and hosting, Email and alerts, Licensing, Jobs, Advanced)
  and render every registered key (ST-09). Disabling a service platform-wide is deferred (§7).

### 2.10 SDK and UI-kit developer experience

- One config file and one start call in six SDKs (SP-32a, SP-32b), with `doctor()` explaining
  what is missing.
- **One name per concept**, recorded in `conformance/parity/api.json` with generated surface tests
  in every SDK; renames only where SDKs disagree today, with deprecated aliases in 0.9 kept for a
  published window (SP-35). The public-API work runs as one serial lane: SP-35 → SP-34 → SP-32a →
  SP-32b → SP-39, before the next six-SDK waves.
- One snippet generator (SP-33a, SP-33b), one examples tree built in CI around one example product
  (SP-36), one start path in the docs (SP-37), one copy pipeline (SP-39). React's cookie mode is
  deprecated and removed after its window (SP-40, owner decision 7).
- **UI kits**: the must tier ships as packages (elements, React, Electron inside
  `@polaris-key/node/electron`, SwiftUI iOS and macOS, Compose Android and Desktop, Godot, Qt
  Quick, two terminals). Vue, Svelte, Angular, Solid, htmx, Tauri, UIKit, AppKit and Android
  Views become recipes (UK-31 and the native kits). React Native, visionOS, tvOS, watchOS,
  widgets and Godot C# are parked until a product ships on them (owner decision 6).

### 2.11 Code quality

Built first, because every feature track depends on it (Track B):

- **Worker**: layering with a transitive boundary test (lead-run codemod in a short window, no
  lingering shims); one admin route table with `can()`; table ownership with one audit writer;
  descriptor contributions instead of side-effect registries; the issuance engine extracted from
  the 3,258-line `identity/oidc.ts`; one notification substrate; one OIDC client; one sealed
  credential store; one adapter per store; one update resolver; one data-migration runner with
  dry run, report and apply (P0-49); faster tests.
- **Console and portal**: one data layer and error class, one router core, the portal on the copy
  catalog, one component inventory, one AuthCard (the Worker's HTML twin included), one wizard
  kit, one settings engine, a page budget.
- **Tools and SDKs**: one generator registry (`pnpm gen --check`), CI scoped from one file, the
  corpus generator split by family, a `pkey` command registry, lint baselines, `client-core`
  holding the neutral TypeScript once (owner decision 8).
- **Duplicates removed**: about 24 base64url, 20 `sha256Hex` and 3 PKCE copies; 4 snippet
  generators; 3 JavaScript headless layers; 13 worker shims; 3 authorization predicates; 6 OIDC
  client code sites; 2 routers; 2 data layers; about 9 store label tables; 13 generator families
  with 5 freshness styles.

---

## 3. What gets simpler

**Settings removed or never created**

- Licensing: `entitlementModel` (a one-time switch the lead runs, no console card),
  `entitlementHolder`, `anchorPolicy`, `reanchor`, `clampGraceToExpiry` (always on),
  `refundGraceHours` (refunds revoke), `reservedNames`. Seven become one.
- Licence defaults: `license.defaults.deviceLimit` and `maxOfflineDays`, `products.default_*`
  reads and the manifest `defaultDeviceLimit`/`defaultMaxOfflineDays` (tiers carry them).
- Automatic licences: `license.autoIssue`, the group map's tier half and its unread `role`,
  `identity.oidc.syncTierOnSignIn`, provisioning entitlement hooks, PS-09's planned
  `emailDomains` and any `upgradeOnSignIn` knob → `license.access`.
- Discover: `storefront.polarisKey.listed`, `audience`, `offerPaths`, `groupLabels` →
  `storefront.polarisKey.visibility`.
- Identity: the four per-product portal sign-in toggles and `releases_enabled`;
  `identity.keyEntryRefusals`; `core.adminGroup`, `products.admin_group` and manifest
  `product.adminGroup` (stored, never enforced: `W/admin/authz.ts:1-11`,
  `W/admin/handlers/me.ts:37-42`); the registration policy as a choice.
- Config: `config.edgeMint.recipes`, catalog `secret: true`, `delivery: serverOnly`,
  `ui.scopes: device`, `userGrant`/`grantLabel`.
- Cloud Sync (planned): `cloudSync.limits.byTier`, `byEntitlement`, `cloudSync.unlicensed`,
  `cloudSync.writes` → the `pkey.cloudSync.bytes` entitlement plus `cloudSync.ceiling.bytes` and
  `writesPaused`.
- Commerce: typed store identities (`bundleId`, `appAppleId`, `packageName`, `steam.appId`),
  three test-purchase switches, 26 planned `commerce.*` keys (→ 4), restore policy ×3 plus
  `transferCooldownDays`, `renewalBufferHours`.
- Release and feeds: `release.betaBranch`, `release.channelWorkflow`, feed Upstream,
  `retainUntaggedDays`, the hide-yanked knob; `packageFeeds` becomes an off switch; no per-channel
  ephemeral flag, retention setting or "send to testers" switch.
- Never created: ST-15's seven policy settings, ST-16's enforce/delegate matrix,
  `core.integration.hidden` as its own key, `identity.native`, `identity.minimumAge`, an editable
  console policy page.

**Concepts and layers removed**: config and entitlement device layers; licence profile stacks;
profile entitlement buckets; the product layer of licence defaults; tierless licences; the U-03
override migration; legacy `portal_*` account tables; `licenses.sub` as an owner; account-held and
store-held grants and add-on-less grants (LX-08's dormant objects); the never-written licence
kind `addon`; per-store mapping rows that each redefine a grant; the manifest `dist_listing`
blob; a separate `@polaris-key/electron`; framework kit packages; the word "capability" in the UI.

**Console pages removed or merged**: Products (→ Home); Overview checklist, Trust & SDK panel
and Welcome (→ Integration card); Distribution's Matrix, Outlets & feeds, Storefronts grid,
Listing, App Store, Commerce and Outlet credentials (→ channel pages and the Commerce group);
License → Enrollment, License → Settings and Distribution → Access (→ the product Access page);
Identity → Portal and Sign-in (→ App sign-in); Platform → Store connections (→ Platform →
Connections); Config → Edge mint (→ Catalog); Platform → Override migration.

**Added versus removed** (the ledger the simplicity critique asked for; "planned" means designed
but never built):

| Kind              | Added                                                                                                                                                                                                                                                            | Removed or never created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables            | 10: `sdk_sightings`, `console_role_bindings`, `identity_connections`, `identity_connection_domains`, `account_tokens`, `subscriptions`, `addons`, `grant_consumptions`, the one sealed credential store, P0-49's job table                                       | 16 dropped (two-release): `override_migration`, `override_migration_report`, 4 `portal_*`, `license_profiles`, `holder_versions`, `device_store_identities`, `grant_entitlements`, `license_store_grants`, `dist_store_product_entitlements`, 3 old credential stores, `dist_listing`. 9 planned, never created: `setup_choices`, `setup_state`, `console_members`, `console_access_rules`, `console_invites`, `console_requests`, `release_channel_moves`, `dist_offer_entitlements`, `dist_subscriptions` |
| Registry settings | 7 new: `license.access`, `storefront.polarisKey.visibility`, `distribution.intendedPlatforms`, `core.setup`, `console.access`, `identity.claims`, the platform terms version. Planned areas cut down: 4 `commerce.*` (of 26), 2 Cloud Sync (of 4 plus a quota)   | About 28 existing keys removed (licensing 7 → 1, `license.autoIssue`, the group map, `syncTierOnSignIn`, 4 Discover keys, `keyEntryRefusals`, `core.adminGroup`, 2 `license.defaults.*`, `config.edgeMint.recipes`, 2 `release.*`, 4 typed store identities, 3 test-purchase switches → 1); 4 portal toggle columns and `releases_enabled` unread                                                                                                                                                           |
| Console pages     | Integration; product Access; Platform → Members and Product → Settings → Members; Platform → Connections; License → Entitlements and Add-ons; one page per channel; Commerce's Storefronts overview, Offers, Purchases; Updates (renamed)                        | 19 pages or nav items retired or merged (the list above)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Manifest fields   | `licensing.entitlements[]`, `licensing.addons[]`, `licensing.access`, `identity.{methods, connections, claims, terms, keyEntry, redirectPaths}`, tier `entitlements`/`fingerprintMode`/`onExpiry`, the catalog `mint` block, the short `.pkey/distribution` form | Deprecated with validator warnings: `product.adminGroup`, `dist_listing`, `defaultDeviceLimit`, `defaultMaxOfflineDays`, `oidc.*`, `groupRoleMap`, `autoIssue.mode`, provisioning entitlements, `secret: true`, `delivery: serverOnly`, `ui.scopes: device`, `userGrant`, `grantLabel`, `edgeMint[]`, a declared registration policy. `modules` is kept (no `services` rename)                                                                                                                              |

**Planned work that will not be built**: a second authorization server, I-22's product-IdP
kinds, I-23, SP-10's signed browser-session document, a `commerce` service slug, automatic
production store submission (DX-08), console access requests as a workflow (ST-33), a test
sign-in mode, the SDK verbs `setConfig`/`clearConfig`/`settingState`, four constructor dialects,
Cloud Sync `onAttach` and three extra conflict vocabularies, MD5.

---

## 4. What gets automated

| Automation                                                                                            | What triggers it                                                                            | Package             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| A product's key, Default profile, catalog v1, Free tier, services, trust policy and planned platforms | Create in the wizard                                                                        | ST-42               |
| Verified per feature and platform                                                                     | SDK headers already sent on every call; a first CI package publish; the first updater check | ST-40, P2-11        |
| Package feeds                                                                                         | A package deliverable declared in the manifest                                              | F-34                |
| Feed cleanup of `dev`/`main` builds                                                                   | The next stable release (dry run first)                                                     | F-36                |
| A channel turns on                                                                                    | One confirmation, when credentials exist at platform or product level                       | A-33                |
| A storefront activates with its channel                                                               | One credential serves both                                                                  | A-33                |
| Store identities                                                                                      | Derived from the platform pin                                                               | A-28                |
| Re-running setup                                                                                      | A new build platform or a new credential                                                    | A-23                |
| Every release to testers                                                                              | The channel's track map (testing tracks, CI, PR and feed channels)                          | A-23, A-24          |
| CI publish steps                                                                                      | `channels: auto` in the Action                                                              | A-25                |
| Pack transports                                                                                       | `transports.packs: auto`                                                                    | P4-33               |
| Store sign-in methods                                                                                 | Shipping on that store                                                                      | I-13, I-14          |
| Licence on sign-in or Discover, device bound, no key                                                  | `license.access` grants one                                                                 | LX-38               |
| An automatic licence upgrades                                                                         | A later sign-in that matches a better rule                                                  | LX-36               |
| A trial converts to its tier                                                                          | The trial's end                                                                             | LX-41               |
| Sign-in required for in-account licences                                                              | Every SDK version seen on the product supports it (report first)                            | LX-39               |
| Store purchase → licence or add-on; refund → revoke                                                   | Store notifications on a linked account                                                     | LX-11, CM-22, CM-24 |
| Store notifications set up and verified                                                               | Storefront wizard                                                                           | CM-21               |
| Console access for today's operators                                                                  | `PLATFORM_ADMIN_GROUP` root rule                                                            | ST-30               |
| Updater "Wired" status                                                                                | First update check from a shipped build                                                     | P2-11               |

Not automated, on purpose: production store submission (store review cannot be undone; one typed
click), hiding Integration (the operator's choice; the backfill only marks Verified),
public-registry publishing (irreversible; per-package approval), and one-time data migrations (the
lead runs each through P0-49's dry run and report).

---

## 5. Tracks and order

Eleven tracks run in parallel lanes. Full detail, package tables and exit criteria are in
[`tracks.md`](tracks.md). Weeks are engineer-weeks for required packages; with 60–90 merges a day
they are relative sizes, and the real limits are the serial lanes, plan approvals, owner steps and
two-release contract pairs.

| Track                                      | Starts                   | Packages | Weeks     | Goal                                                                                |
| ------------------------------------------ | ------------------------ | -------- | --------- | ----------------------------------------------------------------------------------- |
| **A.** Ground truth, decisions, quick wins | week 0                   | 5        | 2.4–4.1   | true graph, six owner answers, U-03 flags untouched, quick wins                     |
| **B.** Foundations (code quality)          | as batch 6 lands         | 35       | 30.6–43.9 | one of each shared mechanism; behaviour-preserving                                  |
| **C.** Products, onboarding, Integration   | wave 7                   | 15       | 13.3–18.8 | wizard, Integration page, Verified, one Home, sidebar contexts                      |
| **D.** Administration and access control   | week 0 plan, wave 7      | 16       | 12.6–17.8 | operators on accounts, four roles, SSO rules, ordered settings                      |
| **J.** SDK and UI-kit consolidation        | week 0 plans             | 26       | 43–61.1   | `polaris-key.json`, `api.json`, must-tier kits, recipes                             |
| **K.** Corpus lane (serial)                | as batch 6 lands (P0-44) | 15       | 11–15.7   | the three wire trains and two contract-text slots, once each                        |
| **E.** Licensing model                     | as batch 6 lands (LX-32) | 27       | 19.6–28   | holder states, tiers, add-ons, access policy, durations, subscriptions              |
| **F.** Identity                            | week 0 plan, wave 7      | 23       | 19.1–28.8 | connections, product connections, profile v2, consent                               |
| **G.** Managed config and Cloud Sync       | week 0 plan, wave 7      | 22       | 18.1–25.6 | three types, one chain, synced settings, saves                                      |
| **H.** Channels, storefronts, commerce     | wave 7                   | 40       | 23.1–34.5 | one catalogue, channel page, auto-activation, offers, one ledger                    |
| **I.** Packages, updates and packs         | wave 7                   | 17       | 14.2–21.3 | personal tokens, self-provisioning feeds, release tracks, Access page, Updates page |

**Week 0** (as batch 6 lands on main). Track A in full; the plans dispatched in parallel so no
builder waits (ST-28 RBAC, I-27 identity, U-01b Cloud Sync, CM-20 commerce, LX-41 durations,
SP-35 API registry, P2-12 update resolver, UK-02b UI fixtures); P0-15, P0-42, P0-36, P0-45, ST-38,
HA-13, HA-14 and the small independent rows (LX-32, LX-12, U-30, A-30, P2-08, SP-31); the
console window (P0-31 → P0-39); P0-44 in the corpus lane.
**Worker window.** P0-17 as soon as P0-15 merges.
**Wave 7.** After the windows: P0-16, P0-18, P0-19, P0-20, P0-21, P0-22, P0-29, ST-05a, P0-32,
P0-34, P0-35, ST-39, P0-38, P0-43; A-19, ST-42, ST-44, SP-33a, SP-35, I-30, I-33, F-33, I-28,
UK-03, UK-07, UK-09, UK-11, UK-12; I-09 in the corpus lane.
**Wave 8a** (every dependency in week 0 or wave 7). ST-29, ST-05b, ST-07, P0-49, ST-40, P0-24,
P0-26, A-20, A-28, P0-27, A-25, F-34, F-37, P2-09, I-29, SP-34, LX-27; I-08 in the corpus lane.
**Wave 8b** (needs wave 8a). LX-33, U-27, ST-30, ST-41, ST-43, ST-08, ST-09, P0-25, P0-28,
CM-21, A-22, A-26, P2-11, P4-33, LX-29, SP-32a, UK-04; I-10a and I-10b. After 8b the lead dispatches from
`check.mjs --ready` each batch (A-21, A-23 and A-24 come next, behind A-22).

**Longest chains** (upper estimates; lanes modelled: the corpus lane serial for corpus-changing
packages, the SDK public-API lane serial; plan approvals and owner steps not modelled; week 0 =
batch 6 on main): the Integration page is about 6.6 weeks out (P0-15 → P0-17 → P0-19 → ST-40 →
ST-41); one-click channels about 8.1 (A-33); the licensing SDK wave about 12.3–12.7 (LX-19,
LX-20); store commerce in the console about 14.5 (P0-15 → P0-17 → P0-18 → P0-49 → LX-33 → LX-34 →
LX-09 → LX-10 → LX-11 → CM-22 → CM-23); the whole plan about 16 weeks, on the must-tier UI kits
(UK-02b → UK-03 → UK-04 → UK-05 → UK-06 → UK-41).

---

## 6. What changes in the backlog

All 199 open packages appear once in `backlog-changes.json`; 140 new packages are added, and
every `UX-*` row in the design specs is mapped in its `uxRows` (77 rows: a graph id, a build, a
parked revive condition or "dropped").

| Action           | Count   | Highlights                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| keep             | 34      | 22 stamped **done** where main has not already: the 18 merged earlier (7 of them already done on main, `2eb10597c`) and batch 6's LX-08, HA-12, UK-13 and UK-14                                                                                                                                                                                                                                 |
| edit             | 90      | I-08 OAuth-shaped and after I-09; LX-09 trimmed by half; LX-10 one ranking; LX-16 widened and two-release; LX-23 **required**; I-11 narrowed to data lifecycle; U-06/07/20/21 on the shipped `config.*` names; ST-12 device trust only; ST-14 three keys; ST-16 no longer waits for Cloud Sync; ST-25 widened; UK-31 required as the one recipes package; 74 edited packages get clearer titles |
| merge            | 28      | PX-W9b and UK-44 → I-10a/b (one six-SDK pass); PX-W18 → I-08; I-22 → I-32; PS-07 → CM-24; PS-09 → LX-36; ST-21 → ST-29; ST-22 → ST-31; ST-24 → P0-18; ST-13 → A-27; U-13/U-25 → U-22/U-23; U-11b/c → U-11a; LX-21 → LX-10; CM pairs. Multi-target merges and splits use arrays                                                                                                                  |
| split            | 2       | ST-05 → ST-05a/ST-05b; UK-22 → UK-04 (Tailwind preset) and UK-31 (recipe)                                                                                                                                                                                                                                                                                                                       |
| drop             | 5       | ST-15 (adds settings), U-17 (three unasked concepts), U-15c, UK-36, UK-37                                                                                                                                                                                                                                                                                                                       |
| reorder (parked) | 40      | SP-10 (owner decision 7); I-23, I-24a/b, I-25, LX-24; U-14, U-16; SP-28..30; 18 kit packages (owner decision 6); HA-16/17; ST-18, ST-23; X-01, F-32, P6-04, PS-08; CM-10, CM-18, CM-19                                                                                                                                                                                                          |
| **new**          | **140** | 137 required, 2 optional (P2-14, SP-38), ST-36 registered as done: the shadow `UX-*` rows become graph nodes, plus code quality (with the P0-49 runner), the five two-release drop packages (U-27b, I-28b, LX-16b, P0-28b, A-27b), RBAC, licensing, identity, config, channels, packages and SDK packages                                                                                       |

**Effort.** Before: 135 required open packages, about 139–201 engineer-weeks, plus about 50
unbuilt `UX-*` rows that lived only in spec tables, unestimated and invisible to `--ready`.
After: 228 required packages, about 207–300 engineer-weeks, of which the new packages are about
112–162. Parking removes 40 packages (about 57–82 weeks) from the active queue; merges, splits
and drops close 35 more (about 22–33 weeks). UI kits go from 39 open packages (71–102 weeks) to
15 active (34–48), with UK-13 and UK-14 done. Polaris Key checkout (10 packages, 10–15 weeks)
stays deferred on owner decision 5. The queue grows because the owner's headline asks
(onboarding, Integration, RBAC, channel pages, subscriptions, entitlements in Licensing, SSO by
domain) were not in the graph, and the code-quality track (31–44 weeks) is new; in exchange,
every later six-SDK wave and feature lands on one mechanism instead of a copy.

**Id note.** `integration.md` uses working ids (OB, AC, IX, CFG, FX, UC, CP, DC, SDX, CQW, CQF,
CQT). New packages must fit `check.mjs`'s `ID_RE`, so they take the next free number in an
existing phase: P0 (code quality and quick wins), ST (access control and console shell), LX, I,
U, F, P2 (release tracks), P4 (packs), A (channels), CM, PS, SP. A `b` suffix marks a release-N+1
contract step or a second slice (U-27b, I-28b, LX-16b, P0-28b, A-27b; SP-32b, SP-33b). The
crosswalk is at the end of `tracks.md`, and each new entry in the JSON carries its working id as
`alias`.

**Plan-mode packages** (approval before code): new ones are P0-26, P0-28, ST-28, LX-39, LX-41,
LX-42, I-27, I-32, U-01b, P2-08, P2-12, P2-14, A-31, CM-20, CM-25, CM-28, SP-32a, SP-34 and
SP-35; existing ones still open are I-08, I-09, I-10a/b, I-13, I-15, I-20, I-21; U-05 to U-23
(Cloud Sync, executing U-01's plan as amended by U-01b); LX-11, LX-18, LX-19, LX-23, LX-25; HA-13,
HA-14; UK-02b; and the deferred CM-01 and CM-14.

---

## 7. Every owner-brief item, with its stance

Stance: **adopt** (as asked), **adapt** (the goal, a different shape), **pushback** (not
recommended, with the reason), **defer** (later, with the condition).

### General concepts

| Brief item                                                                             | Stance | Why, and where                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Consolidate similar features                                                           | adopt  | Five features, one Integration page, one channel page, one token, one access policy, one Access page (§1)                              |
| Flexibility, to an extent                                                              | adapt  | Keep outcome choices (limits, duration, access, visibility, offers); drop internal tuning knobs (LX-40, ST-38)                         |
| Reduce configuration surface                                                           | adopt  | Licensing 7 → 1, commerce 26 → 4, four portal toggles → 0; the ledger in §3 counts what is added too                                   |
| Wizards, instructions, example code, auto-configuration                                | adopt  | ST-39 kit, ST-43, ST-41, SP-33a generator, SP-36 examples, A-23 channel wizards                                                        |
| Automate when credentials exist; enable a storefront on the spot                       | adopt  | "One click" plus one confirmation; channel and storefront activate together (A-33); store rows wait for A-18k's verification per store |
| Graceful degradation (subscriptions without Commerce; pages show what each source has) | adopt  | Core subscriptions (LX-41); the channel page renders each side independently (A-22)                                                    |

### Products

| Brief item                                                        | Stance | Why, and where                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Easy to add; core plus optional features                          | adapt  | Five features over the unchanged service slugs, each with its own switches; no new slug, so no SDK churn (ST-38)                                                                                                                       |
| Step-by-step product wizard                                       | adopt  | Two or three steps, one batch, lands on Integration (ST-42, ST-43)                                                                                                                                                                     |
| In-app Integration section with per-service instructions and code | adopt  | One page, generated snippets per feature and SDK (ST-40, ST-41, SP-33a)                                                                                                                                                                |
| Dismiss after an end-to-end handshake, as a user choice           | adapt  | Unlocks at the first Verified feature (an SDK 2xx, a CI publish or an updater check), keeps per-platform progress, recorded in `core.setup`, never hidden automatically (the backfill only marks Verified), re-openable (ST-40, ST-41) |

### Licences

| Brief item                                                                | Stance | Why, and where                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean up layers and co-mingling                                           | adopt  | One limits resolver, one composition, one access policy, one issuance module; device layer, profile stacks and the product defaults layer gone                                           |
| Created bound or free-floating                                            | adopt  | Already built (LX-26/LX-28/LX-30); named in an account / waiting / floating                                                                                                              |
| Bound licences need sign-in                                               | adopt  | Per product once every SDK version seen on it supports sign-in, with a report first (LX-39); the default for new products after the rebuilt kits (LX-31); Sign-in-off products keep keys |
| Floating can stay floating or be associated                               | adopt  | Already built; accounts never required                                                                                                                                                   |
| A licence for an existing account appears in its portal                   | adopt  | Already built (email → account at creation and first verification)                                                                                                                       |
| Account association brings a central view and cloud saves                 | adopt  | The Library (built, PX-\*) and the Cloud Sync principal are account-based (U-05, U-09, U-22, U-23)                                                                                       |
| Auto-mint for everyone / by OIDC group / reject                           | adopt  | `license.access`, widened with verified email domains and claims, targeting a tier or an add-on (LX-36)                                                                                  |
| Configure the licence everyone gets and per-group mappings                | adopt  | Same setting; rules with labels and a persona preview on the product Access page (P2-10)                                                                                                 |
| Auto-minted licence binds the device, mints no key; admin can add one     | adopt  | LX-38, unique per account and product                                                                                                                                                    |
| Discover self-mint identical to use-time mint                             | adopt  | One evaluator, one issuance function, open to every account (LX-38)                                                                                                                      |
| Entitlements on the licence and user, out of Config                       | adapt  | Licensing owns them per licence; devices still read `flag` rows (no wire change). Not account-held: a person picks a licence, which avoids cross-licence merging (LX-34, LX-09)          |
| Sub-licences (IAP, DLC, packs) whose entitlements propagate up            | adopt  | Add-ons held by the licence; every grant references one (LX-35)                                                                                                                          |
| Multiples of one entitlement and redemption status (currency)             | adopt  | Quantity and consumable kinds with a consumption ledger, a required member of the licensing wire train (LX-18, LX-42, CM-28)                                                             |
| Platform entitlements (update channels, cloud sync)                       | adopt  | Platform entitlement registry including `channels` and `pkey.cloudSync.bytes` (LX-34)                                                                                                    |
| Tiers carry a non-overridable profile, entitlements and licensing details | adopt  | LX-34, LX-44, U-28; every licence has a tier (LX-33)                                                                                                                                     |
| Config flow user > licence > profile > defaults                           | adopt  | Five server layers; needs U-03's run cancelled (owner decision 1; U-27, U-28)                                                                                                            |
| Licensing metadata licence > tier > defaults                              | adopt  | Exactly that chain: one resolver with sources, the product layer removed; add-ons only add channels; version window from the running licence (LX-32, LX-33)                              |

### Subscriptions

| Brief item                                                                              | Stance | Why, and where                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscriptions in Polaris Key and third-party stores                                     | adopt  | Core subscriptions for every source; App Store and Play required (LX-41, LX-23); Polaris Key checkout is owner decision 5                                                                                                                                                                                               |
| Lifetime, fixed expiry, specific version, renewable, renewable with perpetual downloads | adopt  | One duration model with `onExpiry: keepVersion` and a "1.x" helper (LX-41, LX-43)                                                                                                                                                                                                                                       |
| "Whatever else you think of"; models configurable by the product's owners               | adopt  | **Trials** (a fixed duration converting to a tier; Core subscriptions status `trialing`; Apple and Play free trials and intro offers mapped in LX-23); presets for each model (LX-43). Also considered: dunning grace (kept as the one licensing setting, LX-41); consumables (LX-42); named-user seats (parked, I-24a) |
| JetBrains perpetual fallback                                                            | adopt  | `keepVersion` freezes the last version released while active (LX-41)                                                                                                                                                                                                                                                    |
| One-year licence, upgrades for the year, last version forever                           | adopt  | A fixed duration with keeps-the-last-version (LX-41)                                                                                                                                                                                                                                                                    |
| 1.x forever, 2.x subscription, 3.x expiry with perpetual                                | adapt  | One licence per major line, each with its own duration, instead of one licence whose rules change by version; a new-major callout offers the next tier (LX-43)                                                                                                                                                          |

### Managed config and Cloud Sync

| Brief item                                                  | Stance   | Why, and where                                                                                                                                                                       |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mostly a verification layer                                 | adopt    | Found and fixed: a dead device layer, a console merge bug, duplicate secret markers (U-27..U-30)                                                                                     |
| Three types: regular, secret, edge-minted                   | adopt    | Setting, Secret, Minted token; the recipe lives on the entry (U-30, U-31)                                                                                                            |
| Three visibility levels for each type                       | pushback | Visibility applies to settings: a user-editable secret contradicts write-only, a read-only secret listing would change the wire, a minted token is code-only. Nine cells become five |
| Secrets such as API keys delivered securely                 | adopt    | Already true; the console steers third-party keys to short-lived minted tokens (U-31)                                                                                                |
| All config entries syncable                                 | adapt    | Every Editable setting syncs by default; locked settings, secrets and minted tokens are server-authoritative, so there is nothing to sync (U-30, U-05)                               |
| Sync all config, managed and unmanaged                      | adopt    | Synced settings plus open settings within a budget (U-05)                                                                                                                            |
| Sync assets and session state to rehydrate                  | adapt    | One records store with files; saves are the v1 SDK surface; other collections when a first adopter needs one (U-09, U-10, U-22, U-23)                                                |
| Conflict handling                                           | adopt    | One conflict vocabulary for settings and records (U-08)                                                                                                                              |
| Anything else worth syncing                                 | defer    | Live pokes, server-authoritative and public collections, end-to-end encryption: parked until asked (U-14, U-16; U-17 dropped)                                                        |
| SDK access through existing conventions, no duplicate logic | adopt    | `config.set`/`setting(key)`/`onConfigChange` gain sync; no parallel `setConfig` API (U-06, U-07, U-20, U-21)                                                                         |

### Release, distribution channels, feeds, updates, packs

| Brief item                                                                                         | Stance         | Why, and where                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple content types (apps, packs, packages, hashes)                                             | adopt          | Built; `SHA256SUMS` per release (A-30)                                                                                                                                                                                                              |
| SHA-256 and MD5 hashes                                                                             | pushback (MD5) | MD5 is broken for verification; SHA-256 everywhere, MD5 only where a registry protocol already carries it (A-30)                                                                                                                                    |
| OS- and arch-specific content; no macOS channels without a macOS build                             | adopt          | Channels scoped by OS and CPU architecture of what the product builds or plans to (A-20, A-26)                                                                                                                                                      |
| The channel list (Polaris Key, Steam, App Store, TestFlight, Play, itch, WinGet, Homebrew, feeds…) | adapt          | Adapters exist; one catalogue (A-19). TestFlight is the App Store channel's testing track, not a separate channel                                                                                                                                   |
| NuGet                                                                                              | defer          | WinGet is a channel (A-19, A-26); NuGet is a package-feed ecosystem: F-32 is parked and revives when X-01 goes ahead or a product declares a `nuget` package deliverable                                                                            |
| Channels and storefronts as separate concepts                                                      | adopt          | A storefront is a channel's selling side: separate data and tab, one page (A-22, A-28)                                                                                                                                                              |
| Not set up → steps; set up → status and what is published                                          | adopt          | Channel page and wizard (A-22, A-23)                                                                                                                                                                                                                |
| A channel that also sets up its storefront activates both                                          | adopt          | One credential activates both (A-33)                                                                                                                                                                                                                |
| Gate channels and storefronts by app type                                                          | adopt          | A-20                                                                                                                                                                                                                                                |
| Automate distribution; enable on the spot after confirmation; send new releases automatically      | adapt          | Setup automated after one confirmation (A-23, A-33); testing, CI, PR and feed channels get every release by their track map. Production store submission stays one typed click because store review cannot be undone (A-24; DX-08 not built)        |
| Step-by-step instructions where not automatable                                                    | adopt          | Wizards list human steps only (A-23)                                                                                                                                                                                                                |
| Customers see what each channel needs, every applicable one                                        | adopt          | One customer-action model for portal, download page and SDKs (A-26, PX-09)                                                                                                                                                                          |
| A sidebar entry per relevant channel; one page combining both sides                                | adapt          | Distribution → Channels has one entry per relevant channel; Commerce → Storefronts is one overview whose rows open the same channel page on Sales, so "clicking either one" lands on one page without a second sidebar entry per store (A-21, A-22) |
| Manage an application and its versions in a feed                                                   | adopt          | Built; producer onboarding added (F-34)                                                                                                                                                                                                             |
| Push to centralized registries too                                                                 | adopt          | CI-plane trusted publishing, stable and beta only, per-package approval (F-35)                                                                                                                                                                      |
| Feeds protected by a licensed token                                                                | adapt          | Authentication exists; new feeds default to Customers; existing public feeds are not silently flipped (F-34)                                                                                                                                        |
| Account tokens for every feed and the packages that account has                                    | adopt          | One `pkeyp_` token across products (F-33). Pushback on a single cross-product feed URL: per-owner URLs are the dependency-confusion defence; one combined setup instead                                                                             |
| Customers don't see our SDKs; developers' tokens do                                                | adapt          | Hidden from customer listings, still installable by exact name so installs and CI don't break (owner decision 3)                                                                                                                                    |
| Feed sign-in instructions                                                                          | adopt          | `pkey feeds setup --write` and the portal's combined setup (F-37, F-33)                                                                                                                                                                             |
| Clean up `-main.N` builds at the next full version                                                 | adopt          | Done for our feeds; the same rule turns on by default for every product and covers `dev` (F-36)                                                                                                                                                     |
| Built-in automatic updates (Sparkle etc.)                                                          | adopt          | Tools exist; the Updates page sets them up per shipped platform with a Wired check (P2-11)                                                                                                                                                          |
| stable, beta, dev pre-configured; app-defined channels                                             | adopt          | Release tracks (P2-08)                                                                                                                                                                                                                              |
| beta and dev granted by tier; stable by default                                                    | adopt          | Tier channels, stable always granted; choosing dev also grants beta (stored at write time, LX-33, P2-08)                                                                                                                                            |
| A release on chosen feeds, promoted and demoted                                                    | adopt          | Demote is a per-track yank (P2-09)                                                                                                                                                                                                                  |
| Non-application artifacts with Background Assets etc.                                              | adopt          | Transports `auto`, gate approved once (P4-33, P4-34); MSIX and Flatpak deferred until declared (SP-29, SP-30)                                                                                                                                       |
| Channel parity and one source of truth (deprecate, rollouts)                                       | adopt          | One Publish dialog and verb facade, one listing truth, default track maps (A-24, A-27, P2-08)                                                                                                                                                       |

### Commerce

| Brief item                                                                                   | Stance | Why, and where                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commerce owns storefronts, payments, transactions, grants                                    | adapt  | A Commerce group (Storefronts overview, Offers, Purchases) shown when a storefront can connect. Pushback on a commerce service: a new slug is an all-SDK wire event for no customer gain (A-21, CM-23)                                                        |
| Prices and regional availability                                                             | adapt  | One base price converted with each store's tools (Apple price points, Play `convertRegionPrices`) under a typed confirmation; territory availability per SKU; Steam and itch.io get copy cards (no price API); no store prices on the storefront page (CM-23) |
| Steps for unconfigured storefronts; clear status; global and per-storefront settings; parity | adopt  | Storefront wizard, Sales tab, 4 settings, parity spike (CM-21, CM-23, CM-27)                                                                                                                                                                                  |
| Standardise setup, expose store-specific fields; Stripe for Polaris Key                      | adopt  | Catalogue facets (A-19, P0-27); Stripe on owner decision 5 (CM-02)                                                                                                                                                                                            |
| Third-party purchase on a linked account provisions licences and add-ons; refunds revoke     | adopt  | LX-11, CM-22 (one `revokePurchase`), CM-24                                                                                                                                                                                                                    |
| Subscriptions from storefronts; licensing works with Commerce off                            | adopt  | LX-41, LX-23                                                                                                                                                                                                                                                  |

### Identity

| Brief item                                                                        | Stance       | Why, and where                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Several SSO providers, each with several email domains                            | adopt        | Connections with DNS-verified domains and routing (I-30)                                                                                        |
| Apps can bring their own SSO provider                                             | adopt        | Product connections (I-32)                                                                                                                      |
| OIDC, magic link, another device, passkeys                                        | adopt        | Built                                                                                                                                           |
| Accounts tied to email; licences auto-link                                        | adopt        | Built                                                                                                                                           |
| Prefill the profile from OIDC; the user completes it                              | adopt        | FinishStep (I-33, PX-21)                                                                                                                        |
| Magic email sign-in always available                                              | adapt        | Always, except for addresses in a domain whose organisation enforces SSO (I-30); the per-product toggles retire after enforcement exists (I-29) |
| Add more sign-in methods in the portal                                            | adopt        | Built (PX-13, PX-15, PX-W19)                                                                                                                    |
| Store account systems always available when distributed there                     | adopt        | Store sign-in derived from the channel, no separate toggle (I-13, I-14)                                                                         |
| Apps choose their sign-in methods otherwise                                       | adapt        | Email and passkeys always on; products choose providers and connections; four per-product toggles retire (I-29)                                 |
| Link an existing licence or mint one at sign-in                                   | adopt        | I-09 attach, LX-38                                                                                                                              |
| Replace a device when no slot is free                                             | adopt        | Built; kits via I-10a/b                                                                                                                         |
| Consent to share only some data                                                   | adopt        | Granular consent and Connected apps (I-34)                                                                                                      |
| Accounts not required                                                             | adopt        | Floating licences                                                                                                                               |
| Sign in across portal, web, games, phones, TVs, CLI, TUI                          | adapt        | OAuth-shaped I-08, native redirect I-15, device code in every SDK (TVs included), terminal kits; the TV kits are parked (UK-27, UK-35)          |
| Profile from OIDC with overridable fields and per-source suggestions; screen name | adopt        | I-33                                                                                                                                            |
| Birth date for future mature-content gating                                       | adapt        | Stored optionally and never sent to apps; age checks are built when a product gates content (I-33)                                              |
| Accept terms and privacy before continuing                                        | adopt        | Platform terms recorded for every new account (I-33)                                                                                            |
| Console accounts in the same account system with permissions                      | adopt        | Decided under the brief (§8, D2): ST-28, ST-30, ST-31                                                                                           |
| A semi-federated OIDC IdP for partners                                            | adopt, later | One authorization server per product: OAuth-shaped now (I-08), full "Sign in with <Product>" later (I-21)                                       |
| Personal access tokens for feeds; developers also get SDKs                        | adopt        | F-33; a separate admin-scope token for the CLI (ST-34)                                                                                          |

### Administration and RBAC

| Brief item                                                                                                         | Stance | Why, and where                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform settings expanded, common first                                                                           | adopt  | ST-09                                                                                                                                                                                                                                                                                    |
| Platform vs Product sidebar by context                                                                             | adopt  | ST-45                                                                                                                                                                                                                                                                                    |
| RBAC for console access, apps and platform settings; restrict features per product or platform-wide; OIDC mappings | adapt  | Product admin bindings narrowed to areas (stable ids on routes); SSO rules map groups, DNS-verified domains and claims (ST-28, ST-31, ST-32). Disabling a service platform-wide is deferred: revive as one platform policy row in ST-16 when a deployment needs a service off everywhere |
| Superadmin, Platform Admin, {Product} Admin, Console Access; sum of roles; "ask an admin" page                     | adopt  | Exactly these four, summed; NoAccessPage names who can grant access (ST-29, ST-31). Product editor and viewer roles wait until a product asks                                                                                                                                            |
| Administrators subject to RBAC                                                                                     | adopt  | Nothing bypasses `can()`; the root rule maps `PLATFORM_ADMIN_GROUP` to Superadmin so nobody is locked out (ST-29, ST-30, ST-32)                                                                                                                                                          |
| Rival GitHub-class RBAC                                                                                            | adapt  | Built-in roles, scopes and areas now; no custom roles or deny rules in v1 (simpler, safer)                                                                                                                                                                                               |

### Minor changes

| Brief item                                     | Stance | Why, and where                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal: What's New formatted and summarised    | adopt  | Built in ST-36 (`fix/ux-polish-1007`, merged into `integ/batch-6`)                                                                                                                                                                                                                       |
| Portal: device count as a pill                 | adopt  | Built in ST-36 (`fix/ux-polish-1007`)                                                                                                                                                                                                                                                    |
| Portal: product sidebar reorganised            | adopt  | Built in ST-36 (`fix/ux-polish-1007`)                                                                                                                                                                                                                                                    |
| Portal: "Automatic Grant" licence source       | adapt  | Built verbatim in ST-36 (`fix/ux-polish-1007`); P0-36 moves it to the copy catalog in sentence case ("Automatic grant", the house rule in ADMIN.md:898 and PORTAL.md:1264) and updates ST-36's e2e assertions; LX-38 writes one origin for every automatic path so LX-15 labels them all |
| Portal: tier pill top-right of License Details | adopt  | Built in ST-36 (`fix/ux-polish-1007`); supersedes UX-03's "tier as text"                                                                                                                                                                                                                 |
| Portal: remove "0 out of 5 devices"            | adopt  | Built in ST-36 (`fix/ux-polish-1007`)                                                                                                                                                                                                                                                    |
| Console: simplified product card; phone pips   | adopt  | Built in ST-36 (`fix/ux-polish-1007`); ST-44 keeps it as is (an acceptance line)                                                                                                                                                                                                         |
| Remove unneeded layers and abstractions        | adopt  | §3                                                                                                                                                                                                                                                                                       |
| Code-quality audits                            | adopt  | Track B                                                                                                                                                                                                                                                                                  |
| Go through all in-flight and todo work         | adopt  | `backlog-changes.json`: all 199 open packages and every `UX-*` row                                                                                                                                                                                                                       |

---

## 8. Owner decisions

Six questions need the owner because each reverses a recorded owner decision or commits money,
external accounts or a repository rule. Everything else is decided under the lead's program
authority and recorded in `integration.md`. The numbers are kept stable; 2 and 4 are decided
under the brief.

| #   | Question                                                                                                                                                                                                                                                                          | Recommendation                                                                                                                                                                                                                                                                                  | If the answer is no                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Cancel U-03's pending licence-override run** and keep licence config overrides as chain layer 4? Reverses S-17 decisions 3 and 4. Answer before anyone sets the run's two production prerequisite flags; until then nothing runs by itself and a notice can still be withdrawn. | **Cancel.** The brief puts "license" in the config chain, and floating licences would otherwise lose per-licence config. Delete the machinery over two releases (U-27, U-27b); provisioned secrets go to the account layer.                                                                     | The run proceeds after its notice; licences lose config overrides; U-27 shrinks to deleting the machinery after the 90-day report; U-28 materialises profile stacks into account overrides for licences that have an owner. LX-34 is unaffected. |
| 3   | **Who can see and install our SDK packages**, and do our SDKs publish to npmjs and PyPI? The second reverses F-10's "feeds only".                                                                                                                                                 | **Installable anonymously by exact name, unlisted for customers**; console members' tokens list them. Our SDKs stay feeds-only for now; claim the npm org without packages. Public-registry publish (F-35) is offered to adopters.                                                              | If gated: SP-38 must ship in the same release or installs break. If published to npmjs/PyPI: F-35 runs for the system product too.                                                                                                               |
| 5   | **Polaris Key paid checkout: go for a reduced v1?** CM-01..19 are deferred today.                                                                                                                                                                                                 | **Build store commerce now** (CM-20..CM-28, required). **Go** for reduced checkout v1 (CM-01, 02, 04, 05, 08, 11, 12, 14, 15, 17, re-planned on CM-20, 4 settings instead of 26) after CM-23 lands.                                                                                             | Polaris Key stays a free storefront; subscriptions run through stores and the manual and external sources.                                                                                                                                       |
| 6   | **UI kits: framework packages become recipes?** Partly revises 2026-10-04's "all major frameworks".                                                                                                                                                                               | **Yes.** Must tier as packages; Vue, Svelte, Angular, Solid, htmx, Tauri, UIKit, AppKit and Android Views as recipes, revived as packages when an adopter ships on one; React Native, visionOS, tvOS, watchOS, widgets and Godot C# parked. Active kit effort drops from 71–102 to 34–48 weeks. | The should tier returns after the consolidation waves, off the critical path.                                                                                                                                                                    |
| 7   | **Park SP-10 and retire cookie-mode browser sessions** for bearer mode plus I-08's web redirect? Reverses the 2026-10-05 W10 decision.                                                                                                                                            | **Yes.** It avoids a signed document across six SDKs; SP-40 deprecates cookie mode after I-08 and I-10a and removes it after a 30-day window with no cookie-mode sessions.                                                                                                                      | SP-10 runs as a fourth wire train after W-LX; SP-40 is dropped.                                                                                                                                                                                  |
| 8   | **Narrow the client-core plan-mode rule** (CLAUDE.md, AGENTS.md) to its wire modules?                                                                                                                                                                                             | **Yes.** SP-34 moves the neutral modules once under plan mode, proven by unchanged transcripts and corpus; after that they are normal code and the Node/React duplicates go.                                                                                                                    | SP-34 still runs once under plan mode; every later change to those modules stays plan mode.                                                                                                                                                      |

**Owner decisions (delegated to Claude, 2026-10-07).** The owner delegated every program question
to the lead on 2026-10-05 ("until I say otherwise"), so all six are answered with the
recommendation. Each stays open to the owner's veto; a veto takes the "If the answer is no" column.

- **1: cancel the U-03 run.** Checked read-only on production at 2026-10-07 19:05 PDT: the
  `override_migration` table has no row, so no notice was ever started. The owner-steps item for
  the run is withdrawn.
- **3: SDKs installable anonymously by exact name, unlisted for customers; feeds-only.** This
  matches the standing rule that nothing is published to public registries. Claiming the npm org
  stays an optional owner step.
- **5: build store commerce now (CM-20..CM-28).** Polaris Key's own checkout keeps the owner's
  existing gate: it stays deferred until the owner says "commerce: go" (owner steps §8, G1–G6).
  When that happens, the reduced v1 (CM-01, 02, 04, 05, 08, 11, 12, 14, 15, 17, with 4 settings) is
  re-planned on CM-20 and built after CM-23.
- **6: framework kits become recipes.** This partly reverses the owner's 2026-10-04 "all major
  frameworks", so it is the one to look at first. Nothing is deleted: recipes stay documented and
  a framework package returns when an adopter ships on it.
- **7: park SP-10; retire cookie-mode sessions after I-08 and I-10a** (SP-40, 30 days with none
  in production).
- **8: narrow the client-core plan-mode rule after SP-34** proves the move with unchanged
  transcripts and corpus. CLAUDE.md and AGENTS.md change in SP-34, not before.

**Decided under the brief, with the security details flagged for review:**

- **D2, operators become Polaris Key accounts under RBAC, Pocket ID seeded as a connection** (the
  brief: "Console/Management accounts go through the same accounts system"). For the owner's
  review: break-glass `ADMIN_OIDC_*` kept at least 30 days and removed only after 14 days unused
  with two Superadmins on passkeys; the strong-method rule (a passkey or an allowlisted operator
  SSO connection; never an email code alone; a method added mid-session counts after step-up);
  console domain rules only through DNS-verified, enforced connections; the end-user Pocket ID
  sunset only after Pocket ID runs as a connection and djdl's group mapping lives in
  `license.access`.
- **D4, a first automatic licence skips the licence-choice step and binds the device** (the
  brief: "If a license is automatically minted at login time, the device attachment should be
  automatic"), when the account has no licence for the product and the access policy grants one;
  otherwise the person picks, with `rankLicenses()` preselecting.

**Also decided under the brief and recorded, not asked:** licences in an account need sign-in by
default (LX-39, LX-31); consumables and redemption status in the licensing train (LX-42); trials
as a duration (LX-41); "Automatic grant" in sentence case; the tier pill in License Details; new
tenant feeds default to Customers; feed cleanup on by default after a dry run; no new service
slug; the vocabulary in `integration.md` §2; Home merged with Products; MD5 refused; no automatic
production store submission.

**Owner steps** (actions, tracked in `~/Downloads/polaris-key-owner-steps.md`): create the npm
org `polaris-key`; supply A-18k's store credentials; grant the GitHub App's optional write
permissions (A-32); set `PLATFORM_OIDC_MIGRATION=claim` in production before LX-38; run the
settings backfill so P0-24 can delete it.

---

## 9. Wire posture

`PROTOCOL_VERSION` stays 4. Every wire event is additive with the corpus appended, plan mode,
and serial in the corpus lane (Track K):

| Train                  | Members                                                                                                                                                                                                     | SDK follow-up                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| HA-12 (done, batch 6)  | `core.presentation` in discovery                                                                                                                                                                            | HA-13, HA-14                        |
| W-ID                   | I-27's plan; I-09; I-08 OAuth-shaped (absorbs PX-W18). No signed shape changes; redirect transcripts re-recorded. Tail: LX-39's contract text and the key-entry-refusals transcript                         | I-10a, I-10b (absorb PX-W9b, UK-44) |
| W-SYNC (contract text) | U-01b's §13 text and appended `sync-scenarios.json`, then U-05's `sync-*` transcripts                                                                                                                       | via U-06/07/20/21                   |
| W-LX                   | LX-18: the duration member `term` (trials, keeps the last version), add-on grants, consumables (LX-42), refusal reasons, CM-20's `offers[]`, the `app` claim kind, `transferred`, W4; optional LX-25, P2-14 | LX-19 + LX-20, one wave             |
| W-UP                   | P2-12, one update resolver; transcripts byte-identical, no corpus file changes                                                                                                                              | none                                |
| Contract text only     | P2-08 (dev listed as built in; the predicate unchanged)                                                                                                                                                     | none                                |

Avoided on purpose: a `commerce` service slug; removing `flag` rows from `/config/schema`;
SP-10's W10 document; I-24a's licensing members; new outlet kinds; a changed channels predicate
("dev includes beta" is stored by the editors); an SDK-reported "integration verified" flag
(Integration uses existing headers and server facts).

## 10. Main risks

- **The U-03 run starting before decision 1** would make the licence-override loss
  irreversible. Mitigation: nobody sets the two prerequisite flags; a read-only check confirms no
  notice started; a notice can still be withdrawn before the run.
- **A deploy breaking the Worker still serving.** `deploy.yml` applies migrations first.
  Mitigation: every contract takes two releases, every migration is replay-safe with a down
  script, and value changes run through P0-49's dry run and report.
- **Console sign-in on accounts** (ST-30) is the riskiest change. Mitigation: the root rule, a
  defined strong-method rule, break-glass for at least 30 days with production exit facts, the
  docs gate on `can()` before any non-admin session exists, security review before merge.
- **Main moves under long tracks.** Mitigation: two short lead windows as early as possible, no
  branch in flight across a codemod, one merge of `main` per builder, the lead's integration
  batches.
- **Parked briefs rot.** Each carries "parked 2026-10-07" and a revive condition; re-read against
  the code before reviving.
- **Effort.** The required queue is about 207–300 engineer-weeks across 228 packages; tracks run
  in parallel lanes, and the longest chain, lanes modelled, is about 16 weeks (the kits), with
  store commerce at about 14.5.

---

## 11. Critique log

Three critiques (coverage, feasibility, simplicity) were applied on 2026-10-07. Every blocking
and major finding was applied; minor ones were applied except where noted.

**Changed.**

- **Contracts and data** (feasibility, blocking): the two-release rule (`tracks.md` rule 5) with
  five drop packages (U-27b, I-28b, LX-16b, P0-28b, A-27b); U-27 now removes `payload.ts:125`'s
  read; LX-16 gains U-28, LX-36, LX-38, LX-40 and PS-12 as dependencies, drops only standalone
  tables, leaves `licenses`/`grants` columns dormant and hands `licenses.sub` to I-32; a new
  data-migration runner P0-49 that LX-33, LX-34, LX-35, LX-36, LX-38, LX-39, U-27, U-28, PS-12,
  CM-21, P0-28 and P2-12 use; LX-08's catch-up, dual-write, `grt_oidc_*` grants and down script
  each have a named successor and a rollback ladder (P0-24); LX-38 adds a unique index for
  automatic licences.
- **Wire** (feasibility, blocking): "dev includes beta" moved from the resolver and P2-08's
  contract text to write time in the editors; the channels predicate is unchanged. LX-39 is plan
  mode with a corpus-lane slot; W-SYNC added to Track K.
- **Security** (feasibility): ST-29 puts `docs.ts` on `can()` and confines `sessionFromRequest()`
  to the dispatcher before ST-30; ST-28 defines the strong-method rule; ST-30 covers the seeded
  Pocket ID IdP and passkeys, and operator SSO routing plus console domain rules move to ST-32
  after I-30; F-37 mints its own packages-only token and token scopes are exclusive; I-29 waits
  for I-30's enforce; F-34 migrates Entitled feeds onto deliverables; RBAC areas are stable ids on
  routes with a drift gate; windows are days with production exit facts (`tracks.md` rule 6).
- **Sequencing** (feasibility): W-ID is I-27 → I-09 → I-08 → I-10a/b, with I-09 in wave 7 and the
  `identity.keyEntry` shape in I-27; batch-6 file overlaps fixed by two early windows (below);
  waves corrected (UK-02b's plan in week 0; P0-36 and P0-45 in week 0, P0-38 in wave 7, A-25 in wave 8a;
  ST-09 in wave 8b now that F-34 no longer waits for it; wave 8 split into 8a and 8b, then
  `--ready`); the serial SDK lane SP-35 → SP-34 → SP-32a → SP-32b → SP-39;
  SP-33 split so the Integration page waits only on SP-33a; ST-42 owns the Default profile and
  `intendedPlatforms`; ST-43 needs P0-26; A-23 split into A-23 (runner) and A-33 (one click on
  P0-28) with A-18k a per-store gate, not a dependency; Halt everywhere's store halts moved to
  A-24; SP-40 retires cookie mode; I-30 and LX-41 re-estimated; P0-48 no longer repeats P0-16 and
  P0-29; ST-16 and F-34 lost needless dependencies; critical paths reported with the lanes
  modelled.
- **Coverage**: Integration is never hidden automatically (the backfill only marks Verified);
  consumables are a required W-LX member and out of decision 5; trials added (LX-41, LX-18, LX-23,
  LX-43); `uxRows` maps all 77 `UX-*` rows, each target names what it absorbs, UX-43 is in P0-38,
  UX-12's attention read is in ST-44 (a gap: ST-47 deletes the payload Home's attention derives
  from), parked UX rows are listed; new §7 rows for trials and other models, prices and
  territories, NuGet, platform-wide restriction (deferred), TVs (adapt); package ids on every row;
  architecture cases in A-20 and A-26; "Automatic Grant" marked adapt with P0-36 updating ST-36's
  assertions; ST-44 keeps ST-36's card and marks ADMIN.md's A-8 dropped; P0-47 depends on ST-36;
  merge and split targets are arrays; phases A and P2 retitled; statuses taken from main and
  `integ/batch-6`; decisions 2 and 4 decided under the brief (six open questions); LX-39 flips per
  product from sightings.
- **Simplicity**: `setup_choices` replaced by the `core.setup` setting; Verified is the sightings
  bit (domain facts only for CI publish and updater Wired); RBAC on one table with `console.access`
  as a setting, ST-33 not built, and the owner's four roles; one product Access page (LX-37 folded
  into P2-10; RBAC pages renamed Members; the tier group renamed Limits); glossary collisions
  removed (Limits, Duration, Release track, Sign-in surface; "terms" only for legal terms; no
  "Capability"); every licence has a tier and the product defaults layer goes; every grant
  references an add-on; one-time switches are lead-run P0-49 jobs (no cards, notices or fallback
  flags); ST-46 no longer renames `modules`; I-31 has no Policies page and becomes Platform →
  Connections; an added-versus-removed ledger (§3); `releases_enabled` retires in I-29; F-36 reuses
  today's prune rule; demote is a per-track yank; the registration policy is always derived;
  `cloudSync.quota` and `upgradeOnSignIn` dropped; the testers switch dropped; subscriptions listed
  on the licence; one Storefronts overview and a four-state vocabulary; I-36's test sign-in
  dropped; service tokens are `pkeyci_`; birth date stored, age booleans deferred.

**Applied differently, or not applied, and why.**

- **The batch-6 window** (feasibility): the fix asked for the worker "now" items to land before
  P0-17. Instead P0-17 runs right after P0-15 and the other worker items depend on it. Both keep
  every branch off a codemod; this order is about 0.9 weeks shorter on every chain behind P0-17.
- **LX-08's dormant objects** (simplicity): LX-08 had already merged reviewed in batch 6, so its
  review round was gone. P0-20 deletes the dead holder code early; the standalone tables drop at
  LX-16b; the dormant columns in `grants` and `licenses` stay, because dropping them needs a table
  rebuild that `migrations/0017` warns against and the `grants` holder CHECK forbids.
- **Deprecated aliases only on SDK, CLI and Action** (simplicity): manifest fields keep rule-9
  validator warnings, because manifests live in adopters' repositories; no console cards, notices
  or per-product flags remain.
- **Approvals and owner steps as graph nodes** (feasibility): not applied. `check.mjs` has no node
  kind for them; plan-mode packages carry their own approval, the one blocking owner step (A-18k)
  is already a node, and the rest are in the owner-steps checklist. The critical paths now model
  the lanes instead.
- **The corpus lane model** (feasibility): the critique's simulation put every SDK wave in the
  lane (LX-19 at week 14.7). The plan defines the lane as "while a package changes the corpus", so
  replay-only SDK waves follow their train by dependency; with that rule LX-19 lands about week
  12.3 and the lane is not the bottleneck.
- **One Storefronts overview** (simplicity) rather than one sidebar entry per storefront: the
  owner's "clicking either one" still lands on one page, through the overview's rows.
- **"Automatic Grant" casing** (coverage): kept the house sentence-case rule rather than the
  owner's literal casing, now marked adapt and with ST-36's assertions updated in P0-36.
- **Product editor and viewer roles** (simplicity): deferred as a parked idea, not dropped.

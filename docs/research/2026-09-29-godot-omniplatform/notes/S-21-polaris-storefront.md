> Research note for [Godot on Polaris Key](../README.md), 2026-10-05. Spike S-21 was commissioned
> by the lead after the owner asked on 2026-10-05: "We should have the ability to list (maybe as
> part of the distribution hub) the ability to list the application in our internal library,
> regardless of openness status. We should intelligently offer the option (ie. if OIDC-based
> licenses are available and the user is signed in to OIDC, then have it listed and available to
> add). Basically, open it up so that if the user were to get a copy of the app and can use it (ie.
> free use, available to their account, etc) then it can appear. So that way, our internal
> storefront becomes its own distribution channel." The owner followed up the same day: "We won't
> do this _yet_ but let's build out our storefront in such a way that we can add a commerce module
> (ie. Stripe) to charge directly from within. This also includes the ability to upgrade licenses,
> as well as subscriptions. We should consider ourselves a full-fledged distribution and release
> channel. So, `direct` really becomes `Polaris Key`. This second part (full commerce) should be
> its own plan."
>
> - **No program brief.** S-21 has none. §9 adds a `PS-` work-package namespace.
> - **What changed in the repo.** This is research and design. No product code changed and nothing
>   was deployed. The only code added is a reference eligibility engine under
>   [`prototype/polaris-storefront/`](../prototype/polaris-storefront/).
> - **External calls.** None.
> - **File references.** They are to the tree at `0f9170cdb`:
>   - `W/` = `packages/worker/src/`
>   - `M/` = `packages/worker/migrations/`
>   - `A/` = `packages/admin/src/`
>   - `SP/` = `packages/shared-protocol/src/`
>   - `N/` = `docs/research/2026-09-29-godot-omniplatform/notes/`
>   - `P/` = `docs/research/2026-09-29-godot-omniplatform/program/`
> - **In-flight work read.** PX-16 (the Discover page) on branch `wp/PX-16-discover-page`
>   (`df21ce4b3`, in review). SIGN-IN.md on branch `design/sign-in` (`247ca28ce`).

# S-21: the Polaris Key Library as a distribution channel

> **Owner decisions (delegated to Claude, 2026-10-05). These govern the note.** Where any section
> below says otherwise, these win. The owner delegated every decision to the lead. The lead told
> this spike to decide each question itself, on its own recommendation. Each decision below is
> the recommendation in §10.2. The `PS-*` packages are registered in
> [`program/workpackages.json`](../program/workpackages.json) as `todo`. No package is plan mode:
> nothing here changes the device wire (§7).
>
> 1. **A first-party storefront called "Polaris Key".** It is one more `StorefrontAdapter`
>    (`id: "polaris-key"`) in the A-18 registry, so it appears in the distribution hub next to the
>    App Store, Play, Microsoft Store, itch.io and Snap, with the same tile, capability strip,
>    listing editor, fit report and readiness checklist. Its operations run against Polaris Key's
>    own tables, so they get a new `Support` mode, `first-party`: no credential, no gate, no vendor
>    call (§6.1).
> 2. **Listing is the operator's choice; visibility is the person's eligibility.** A product is
>    shown to a signed-in person only when it is listed **and** that person can obtain and use it
>    now, or when the operator explicitly chose audience `everyone`. Listing is independent of every
>    access mode (`dist_access`, registry access, licensed downloads). There is no product-level
>    "public, unlisted, private" field in the code today [V], so "regardless of openness" means
>    regardless of those access modes (§4.5).
> 3. **Three listing states: `auto`, `listed`, `unlisted`. Default `auto`.** `auto` keeps today's
>    Discover exactly: a product appears when sign-in auto-issue or a mapped IdP group would give it
>    to the person. `listed` adds every other obtain path (open products, store ownership, the
>    product's own IdP, email domains). `unlisted` hides it everywhere in the portal while every
>    policy keeps working. The setting `storefront.polarisKey.listed` supersedes the planned
>    `identity.discover.listed` (S-18 D22) and the `discover_enabled` column (0071), which is
>    backfilled to `unlisted` where it is 0.
> 4. **The eligibility engine is "obtain paths", evaluated dry.** Each path is one reason the
>    person could add the product now: `group`, `auto_issue`, `open`, then `store_owned`,
>    `product_idp` and `email_domain` as their dependencies land. The engine extends Discover's
>    dry-run evaluation (`previewIdentityIssue`) and never writes. It lives in the identity service
>    beside Discover and reads other services only through single-provider descriptor hooks (rule
>    6).
> 5. **No enumeration.** Unknown, unlisted, ineligible and withdrawn products answer identically
>    (`409 not_eligible` on a claim, `404 not_found` on the storefront product page), and only
>    eligible products are counted or listed. Audience `everyone` is the one deliberate exception,
>    set by an operator with a level-2 confirmation.
> 6. **Add to library creates what the path implies, through the paths that exist.** Identity
>    paths mint the licence through `activateFromIdentity`, the auto-issue path, as Discover does
>    today. A store-owned path goes through the commerce bridge's holder binding (LX-11). An open
>    product writes a `library_entries` row and no licence. Add never binds a device and never
>    mints a second licence for a product the account already holds.
> 7. **Devices follow SIGN-IN.md's licence choice.** The added licence is one more row in
>    `LicenseChoiceStep` when a device next signs in or activates. The rank-first rule only
>    preselects.
> 8. **First release: obtainable without payment.** Priced offers, checkout, upgrades and
>    subscriptions are designed in **S-22**, a separate plan. This note fixes only the seams S-22
>    plugs into (§6.10).
> 9. **`direct` is shown as "Polaris Key"; the identifier stays `direct`.** The outlet kind and the
>    implicit outlet id `direct` are inside signed feeds, the corpus, six SDKs, an Android flavour
>    and Maven artifact names. Renaming the id buys nothing a label does not, and costs a
>    protocol-wide migration. Every display label becomes "Polaris Key" (PS-10). The planned
>    S-19 grant source `direct`, which no code writes yet, becomes `polaris-key` before LX-08
>    creates the vocabulary.
> 10. **Group labels.** An IdP group shows as an operator-set label ("Included with Aperture
>     Seven"). Without one, the copy falls back to "For members of <group>".
> 11. **Eligibility preview uses personas, never real accounts.** The console's "Who can see
>     this?" simulates a person (signed in with the platform IdP, in groups X, with a verified
>     email at domain Y, owning Steam app Z). It never looks up a real person.
> 12. **Analytics are daily aggregates.** Impressions, adds and first activations per product, day
>     and path kind. Nothing is stored per person beyond a two-day dedupe table of keyed hashes.

Evidence tags: **[V]** read in the code or in a spec at the cited path; **[M]** measured here;
**[S]** a summary of another note; **[I]** inference; **[U]** unverified.

## 1. Question

Can the customer portal's Library and Discover become a first-party distribution channel that an
operator lists a product on from the distribution hub, independent of how open the product is,
and that shows the product to exactly the signed-in people who could obtain and use it? What gets
created when they add it, how does it relate to licences, grants and devices, what does the
console need, and where does commerce attach later?

## 2. Short answer

Yes, and most of the machinery exists.

- **Discover is already a dry-run eligibility evaluator** (PX-W10, done) [V]. It lists products
  whose auto-issue policy or IdP group map would give the person a licence, and its claim mints
  through the same path as sign-in. It covers two of the owner's cases: free with an account, and
  OIDC group membership through the platform IdP.
- **The storefront layer is built for this shape** (A-18a, A-18b, done) [V]. A store is one
  declaration and one registry line. The console renders capabilities from declarations, so a
  first-party store needs no store-specific console code. A-18j, the console flow, has not started.
- **The gaps are:**
  1. An operator listing control. Today there is only an opt-out (`discover_enabled`).
  2. Obtain paths beyond auto-issue: products with nothing to licence, store ownership, the
     product's own IdP, verified email domains.
  3. A storefront product page for a product the person does not hold yet.
  4. A library entry for products that need no licence.
  5. The hub tile, listing panel, readiness, preview and analytics in the console.
  6. Labels: `direct` becomes "Polaris Key".
- **Nothing changes on the device wire.** The portal API grows additively. Eleven `PS-` packages
  cover it, about 8–12 engineer-weeks; three are ready now.

## 3. Method

1. Read the Discover code (`W/services/identity/portal/discover.ts`, `portal/repo.ts`,
   `portal/api.ts`, `services/identity/oidc.ts`), migration `M/0071_portal_discover.sql`, the
   library view (`portal/library.ts`) and the dedupe fix merged in `c3841de59` [V].
2. Read the storefront layer: `W/core/adapters/contract.ts`, `W/core/storefront/{adapter,gate,
listingModel,listingProfiles,projection}.ts`, `stores/*.ts`, the listing service
   `W/services/distribution/listing/`, migrations 0063, 0065 and 0069, and the console's
   distribution area and Store connections page [V].
3. Read the notes and plans this depends on: S-15, S-16, S-18, S-19, S-20, `P/plans/LX-01.md`,
   `P/plans/I-04.md` (licence choice at sign-in), PORTAL.md §3.1, §4.12–4.16, §10.2 G24–G25,
   EXPERIENCE.md, SIGN-IN.md (branch), THREAT-MODEL "Discover" and "Storefront adapters" [V][S].
4. Inventoried every use of `direct` as an outlet, channel or source across the protocol, the
   corpus, the SDKs, the Worker, the console and the docs [V].
5. Ran the Discover suite on this tree, and wrote and ran a reference eligibility engine with a
   self-test table [M] (§5).

## 4. What exists

### 4.1 Discover (PX-W10, done) [V]

- **Routes.** `GET /api/discover` (`handleDiscover`) and `POST /api/discover/<p>/claim`
  (`handleDiscoverClaim`), behind the portal session; the claim needs the CSRF header.
- **Candidates.** `listDiscoverCandidates` (`portal/repo.ts:1172`) keeps products that are active,
  `portal_enabled = 1`, `discover_enabled = 1`, `oidc_config.provider = 'platform'` and pass
  `AUTO_LINK_ENABLED_SQL`. Products the account holds (`listHeldProducts`) are skipped before any
  evaluation (the dedupe fix, `00a467613`).
- **Evaluation.** `discoverIdentity` builds an `OidcIdentity` from the account's platform-IdP link
  and `account_links.groups_json` (the `groups` claim as of the last portal sign-in).
  `previewIdentityIssue` runs `identityTier` dry: the first mapped group wins, else
  `autoIssue.mode` `oidcDefault|both` gives the default tier. An account with no platform-IdP link
  (magic link only) is offered nothing.
- **Result.** `{product, reason, terms}` with `DiscoverReason = "free_with_account" |
"group:<g>"` and `DiscoverTerms = {tier, tierLabel, deviceLimit, expiresAt, expiryDays}`.
- **Claim.** Rate limit `portalClaimKey` (10 a minute, shared with the key preview and key claim),
  re-evaluation, idempotency through `idx_licenses_sub`, `activateFromIdentity`, `linkLicense`,
  two audit rows with `source: discover`.
- **No leak.** A non-candidate slug and a withdrawn offer both answer `409 not_eligible`.
- **Portal UI.** On main, `A/portal/pages/DiscoverPage.tsx` is a stub. PX-16 (in review) adds
  `DiscoverTile`, `DiscoverTeaser` and `model/discover.ts` (`reasonCopy`: `free_with_account` →
  "Free with a Polaris Key account", `group:X` → "For members of X", any other code → "Offered to
  your account by its developer").

### 4.2 The storefront layer (A-18a, A-18b, done; A-18j to do) [V]

- **Contract.** `W/core/adapters/contract.ts`: `Support` is one of `api` (worker plane, with gate
  rules), `ci`, `pr`, `deep-link` or `unsupported` with a reason. `Capabilities<Op> = {ops, rate,
limits}`.
- **Storefronts.** `W/core/storefront/adapter.ts`: `StorefrontId = "app-store" | "google-play" |
"microsoft-store" | "itch" | "snap"`; 19 ops (`connect` … `status`); `READ_OPS`, `TYPED_OPS`;
  `StorefrontAdapter` adds `label`, `outletKinds`, `credential`, `gate`, `never`, `ci`, `listing`,
  `confirmation` and `audit`. `STOREFRONT_ADAPTERS` is the registry; `conformance.test.ts` enforces
  the contract on every entry.
- **Listing model.** `dist_listings`, `dist_listing_locales`, `dist_listing_assets`,
  `dist_listing_release_notes`, `dist_listing_overrides` (0065), `provenance_json` (0069), the root
  manifest listing `dist_listing` (0063). Per-store limits in `listingProfiles.ts`
  (`LISTING_STORES`), projection and fit report in `projection.ts`.
- **Readiness.** No per-store prerequisite code exists yet; S-15 §8.1 step 2 specifies it as a
  checklist computed by the adapters.
- **Console.** No Storefronts or Listing page yet. `A/console/pages/platformStores.tsx` hard-codes
  `STORES = ["app-store","google-play","microsoft-store","steam"]`.

### 4.3 Licensing and identity [S]

- **S-19 (OC model).** Licence, grant, grant holder (account, licence or store identity),
  entitlement kinds, contributors, combine rules. Planned grant sources: `app-store | play | steam
| direct | comp | trial | bundle | redeem | oidc` (`P/plans/LX-01.md:352`, approved). Trials are a
  `trial` tier or a grant with `trial = 1`; sign-in never renews either (LX-02, done). Upgrades:
  in-place tier change, or a new licence with `superseded_by`. Subscriptions and dunning are
  LX-23; redeem and gift codes LX-25.
- **Provenance today.** `PurchaseSourceKind = "store" | "developer" | "sign_in" | "free"`
  (`W/core/hooks.ts:1227-1240`).
- **S-16.** One platform-level account, always on; Identity is a per-product service; pairwise
  subjects per (account, product) in `account_product_subjects`; the account id never leaves the
  Worker.
- **Licence choice at sign-in** (owner, 2026-10-05; `P/plans/I-04.md`). Every sign-in that binds a
  device shows `LicenseChoiceStep`; rank-first only preselects; "Create a new free license" is
  offered only when every row is full and never preselected; **Replace a device** is inline.
  I-26 applies the same rule to the legacy in-app sign-in.

### 4.4 Auto-issue and group rules [V]

- `.pkey/product` `autoIssue {enabled, tierId, mode: anonymous|oidcDefault|both,
rateLimitPerHour}`; `oidc.groupRoleMap` group → `{role, tier?}`; `oidc.provider platform|custom`.
- Stored in `products.auto_issue_json` and `oidc_config.group_role_map_json`. Registry entry
  `license.autoIssue` (`W/services/license/settings.ts:104`).
- `identityTier` (`oidc.ts:729`) is the one policy function for sign-in and Discover.
- The in-repo fixture `djdl` maps the platform groups `members` → tier `standard` and `admins` →
  role only. A member therefore sees djdl in Discover today with the reason "For members of
  members", which is why group labels are needed (D10).

### 4.5 "Openness" in the code [V]

There is no product-level public, unlisted or private field. The nearest controls:

- `dist_access.mode ∈ ('public','authenticated','licensed','entitled')` per deliverable (0038).
  It gates delivery, not catalogue visibility.
- The registry's `access_mode` (0058_d), with the same four values.
- `portal_product_settings`: `portal_enabled`, `oidc_enabled`, `auto_link_enabled`,
  `license_key_claim_enabled`, `claim_by_key`, `discover_enabled` …
- `products.status`, `deleted_at`, `system`.

### 4.6 `direct` [V]

`direct` is an **outlet kind** (`SP/distribution.ts:9`, first of 17) and the **implicit outlet id**
when `.pkey/distribution` declares none (`IMPLICIT_OUTLET_ID`). It means "installed from the
developer's own download, not a third-party store". Package-manager installs are `direct` with a
subkind (`homebrew`, `scoop`, `appimage`, `npm` …).

- **Signed data:** feed documents key `targets[].outlets` by outlet id and carry `kind: "direct"`
  (`conformance/corpus/v2/cases.json`, `update-matrix.json`, transcripts and their Swift and Godot
  mirrors). Outlet kinds are open-ended on the wire, so an unknown kind never matches
  (WIRE-CONTRACT-V4.md §8).
- **SDKs:** generated `OutletKind.direct` in all six, and hand-written detection in each
  (`client-core/src/outlet.ts`, Python `detection.py`, Swift `OutletDetection.swift`, Kotlin
  `Outlet.kt`, Godot `outlet.gd`). Kotlin's Android build flavour is named `direct`, and so are
  the Maven artifacts `polaris-key-{platform,godot,android}-direct`.
- **Labels:** the console's `OUTLET_KIND_LABELS.direct = "Direct download"`
  (`A/lib/labels.ts:98`) and the download page's "Direct download" (`W/services/distribution/
page/render.ts:296`). There is no "Direct" purchase badge; admin-issued licences read "Bought
  from <developer>".
- **Not an outlet:** Obtainium's `source: "direct"` (a config discriminator) is unrelated.
- **Not in code:** S-19's planned grant source `direct` and portal badge "Direct" exist only in the
  note and the approved LX-01 plan.

## 5. Results of the measurements [M]

Environment: macOS (Darwin 27.0.0), Apple silicon, Node 22 via `mise exec node@22`, pnpm 10.33.2,
vitest 4.1.11, tree `0f9170cdb`.

1. **The Discover suite is green on this tree.**

   ```sh
   mise exec node@22 -- pnpm install --frozen-lockfile && mise exec node@22 -- pnpm build
   mise exec node@22 -- pnpm --filter @polaris-key/worker exec vitest run test/portalDiscover.test.ts
   ```

   21 tests passed in 9.71 s. That suite, including the dry-run test against a database that refuses
   every write, is the regression baseline PS-03 must keep byte-identical for the `auto` mode.

2. **The reference engine's acceptance table passes.**

   ```sh
   cd docs/research/2026-09-29-godot-omniplatform/prototype/polaris-storefront
   mise exec node@22 -- node obtain.mjs --self-test
   ```

   All seven checks pass:

   | Check                                                          | Result                                            |
   | -------------------------------------------------------------- | ------------------------------------------------- |
   | Magic-link-only account                                        | sees only `open-util` and the `everyone` teaser   |
   | Platform-IdP member (group, Steam owner, product link, domain) | sees 8 of 11 products                             |
   | Same member holding two of them                                | sees 6: held products never appear                |
   | Claim on unknown, unlisted and ineligible-private slugs        | identical `{"status":409,"code":"not_eligible"}`  |
   | Group and auto-issue both apply                                | the group path comes first, with the group's tier |
   | Claim on an open product                                       | creates a `library_entry`, not a licence          |
   | Audience `everyone`, no path                                   | cannot be claimed (link only)                     |

   PS-03's unit test ports this table.

Nothing else here is measurable without building it. Store ownership (Steam `ISteamUser/
CheckAppOwnership` budgets) is left [U] for PS-07.

## 6. Design

### 6.1 The `polaris-key` storefront adapter (PS-01)

**Vocabulary (rule 4).** _Polaris Key storefront_: the customer portal's Discover and Library,
seen as a store an operator lists a product on. _Listing_ (existing): the product's store-facing
text and art. _Obtain path_: one reason a signed-in person can add a product now. _Library entry_:
a product in someone's library without a licence. Discover keeps its name in the portal; the
console calls the store "Polaris Key".

**Declaration.** `W/core/storefront/stores/polarisKey.ts`:

```ts
export const POLARIS_KEY_ADAPTER: StorefrontAdapter = {
  id: "polaris-key",
  label: "Polaris Key",
  outletKinds: ["direct"], // shown as "Polaris Key" (D9)
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: { delete: [], users: [], signingKeys: [], payments: [], ciTokens: [] },
  ci: null,
  listing: POLARIS_KEY_LISTING_PROFILE,
  confirmation: { phrase: "app-name", label: "Polaris Key" },
  audit: { action: "polaris-key", projection: FIRST_PARTY_PROJECTION },
};
```

**The new `Support` mode.** `{mode: "first-party", plane: "worker", handler: string}`. The
operation runs against Polaris Key's own tables. The conformance suite gains a branch: a
first-party op is declared only by an adapter with `credential: null` and `gate: null`, sends no
HTTP request (the test runs it with `fetch` replaced by a thrower), and writes an audit row. The
console renders it as "Built in".

| Op                                       | Support                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `connect`, `listApps`, `identifiers`     | `first-party` (always connected; the product is the app)                          |
| `createApp`                              | `unsupported`: "Every Polaris Key product already has a storefront page"          |
| `readListing`                            | `first-party` (the listing model plus `overrides` for `polaris-key`)              |
| `writeListingText`, `writeListingAssets` | `first-party` (the shared listing model, HA-06 uploads)                           |
| `category`                               | `first-party`                                                                     |
| `contentRating`, `privacyDeclarations`   | `unsupported`: "The Polaris Key storefront shows the developer's own policy link" |
| `pricing`, `iap`                         | `unsupported`: "Listed products are obtained without payment" (S-22 changes it)   |
| `testers`                                | `unsupported`: "Who can add a product is decided by its obtain paths"             |
| `uploadBuild`                            | `unsupported`: "Builds come from the product's releases"                          |
| `notificationsUrl`                       | `unsupported`                                                                     |
| `submit`                                 | `first-party`: **List** (plain confirm for `auto`/`listed`; L2 for `everyone`)    |
| `release`                                | `unsupported`: "A published release is live on Polaris Key at once"               |
| `rollout`                                | `unsupported`: "Rollouts are set per outlet in Distribution"                      |
| `status`                                 | `first-party` (listing state, readiness, offers visible today)                    |

The unsupported reasons state what applies, in the ADMIN.md §5.8 voice, never "coming soon" (the
owner's console rule).

**Listing profile.** `polaris-key` joins `LISTING_STORES` with: name ≤ 60, short description
≤ 140 (the tile line), description ≤ 4,000 (plain text with paragraphs, rendered escaped), icon
(the `presentation.icon` slot, HA-04), header 16:9 (the PX cover), screenshots 0–8, per-locale.
The fit report needs no new code.

**Readiness checklist** (computed by the adapter, S-15 §8.1 step 2):

1. The portal is on for the product (`portal_enabled`).
2. A name, an icon and a short description in the default locale (fit report green or amber).
3. At least one obtain path is configured (§6.3), or the audience is `everyone`.
4. **Get it** does something on at least one platform: a release download, a store link from
   `stores[]`, or the developer's website.
5. When a path issues a licence: the tier it issues exists and has a device limit.

### 6.2 Listing state and settings (PS-02)

S-18 registry entries in the core slice (`W/core/settings/core.ts`). Every product can list,
whether or not it has the distribution service.

| Key                                 | Scope    | Value                             | Default    | Ownership | Confirm |
| ----------------------------------- | -------- | --------------------------------- | ---------- | --------- | ------- |
| `storefront.polarisKey.enabled`     | platform | switch                            | on         | operator  | L2      |
| `storefront.polarisKey.listed`      | product  | enum `auto \| listed \| unlisted` | `auto`     | operator  | L1      |
| `storefront.polarisKey.audience`    | product  | enum `eligible \| everyone`       | `eligible` | operator  | L2      |
| `storefront.polarisKey.offerPaths`  | product  | list of path kinds                | all        | operator  | L1      |
| `storefront.polarisKey.groupLabels` | product  | json `{<group>: <label ≤ 40>}`    | `{}`       | claimable | L0      |

- **Storage.** Columns on `portal_product_settings` (where `discover_enabled` lives):
  `store_listed`, `store_audience`, `store_offer_paths_json`, `store_group_labels_json`.
  Expand-only migration; backfill `store_listed = 'unlisted'` where `discover_enabled = 0`.
  `discover_enabled` stays read for one release (dual-read), then PS-11 drops its readers.
- **Why `auto` is the default.** It reproduces today's Discover exactly, so nothing appears or
  disappears on deploy. Today an auto-issue policy already counts as the developer's statement
  that the account may have the product (0071's comment).
- **Why operator-only for listing.** A manifest must not be able to publish a product to the
  storefront behind the operator's back (S-18 D22's reasoning). Group labels are presentation, so
  they are claimable (`.pkey/product` may carry `storefront.groupLabels` later; out of scope).
- **`identity.discover.listed`** (S-18 D22) is never built; its row in S-18 §8 maps to
  `storefront.polarisKey.listed`.

### 6.3 The eligibility engine: obtain paths (PS-03)

**Question it answers:** for this account, this product, now, without writing anything: can the
person add it, by which paths, and with what terms?

```ts
type ObtainPathKind =
  | "group" // platform-IdP group map (today)
  | "auto_issue" // sign-in auto-issue, `oidcDefault | both` (today: free_with_account)
  | "open" // nothing to licence (PS-03)
  | "store_owned" // a linked store identity owns it: Steam first (PS-07)
  | "product_idp" // the product's own IdP, via a verified product-scoped link (PS-08)
  | "email_domain"; // a verified email at a listed domain (PS-09)

interface ObtainPath {
  kind: ObtainPathKind;
  detail: string | null; // group, store, IdP label or domain; never an account id
  terms: DiscoverTerms | null; // null for `open`
  action: "add" | "link"; // S-22 adds "buy" and "upgrade"
  reason: string; // the DiscoverReason code (`group:<g>`, `free_with_account`, `open`, …)
}
```

**Evaluation order** (the first path is the tile's main reason; all are shown on the product
page): `store_owned`, `group`, `product_idp`, `email_domain`, `auto_issue`, `open`. Ownership
first because it is the strongest claim; `open` last because it grants nothing.

**Contributions, within rule 6.** The engine lives in `W/services/identity/portal/store/obtain.ts`,
beside Discover, which it replaces internally.

- `group`, `auto_issue`, `product_idp` and `email_domain` are identity's own policy
  (`identityTier`), in the same service.
- `open` asks two questions:
  1. Is the licence service off for the product? (`ProductPublic.services`)
  2. Are all the product's deliverables in `dist_access` mode `public` or `authenticated`? This is
     a new method on Distribution's single-provider `delivery()` hook, `openAccess()`. `null` (the
     distribution service is off) means "no downloads to open", so the path is absent unless the
     licence service is off and the product has a website.
- `store_owned` uses a new `delivery().storeOwnership(identities)` method backed by the commerce
  bridge (PS-07).

Core's hook model allows one provider per hook (`hookProvider`, `W/core/hooks.ts`), and these
methods each have exactly one provider, so no multi-provider hook is introduced.

**Listing modes.**

- `unlisted`: no path is offered.
- `auto`: only `group` and `auto_issue` paths make the product visible. This is today's Discover,
  byte-identical.
- `listed`: every path in `offerPaths` counts.
- `audience: everyone` additionally shows a listed product that has no path to every signed-in
  account, with `action: "link"` to its store pages (`stores[]`) or website, never Add.

**Candidates.** Active, `portal_enabled`, not deleted, `storefront.polarisKey.enabled`, and not
held (`listHeldProducts` plus `library_entries`). The platform-issuer and auto-link predicate
(`AUTO_LINK_ENABLED_SQL`) stays on the identity paths, unchanged: it is the R5-01/R5-02 control
against tenant-controlled issuers.

**Guarantees** (each a test):

1. Dry run: the listing writes nothing (the existing refusing-database test, extended).
2. Parity with sign-in: every identity path is `identityTier` itself, so the storefront grants
   nothing a product sign-in would not (THREAT-MODEL "Discover grants nothing a sign-in would
   not").
3. No enumeration: the prototype's identical-answer table.
4. Cost: one candidate query plus at most one policy evaluation per listed candidate. Store
   ownership is cached per (account, store, app) for 10 minutes and budgeted (PS-07).

**Trials and codes.** A trial is an `auto_issue` or `group` path whose tier has `expiryDays`; the
copy says "Free trial · 14 days". Sign-in never renews it (LX-02), and a held product never
reappears, so there are no endless trials. Redeem codes (LX-25) are not a listing path: a code is
proof the person brings. The portal's Activate modal takes keys today, and LX-25 adds codes to the
same entry point.

**Operator-issued licences and invitations.** These already reach the Library without the
storefront: email auto-link (`syncAccountLicenseLinks`) on auto-link products, the key claim, and
LX-13's admin grants to an account. The storefront does not list them again, because a held
product is Library, not Discover.

### 6.4 Add to library (PS-04)

`POST /api/discover/<p>/claim` gains an optional body `{path?: ObtainPathKind}`. Without it, the
server uses the first path. The server always re-evaluates. A path that is no longer offered gets
`409 not_eligible`.

| Path                          | What is created                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group`, `auto_issue`         | Today's claim: `activateFromIdentity` mints the base licence on the identity's subject, owned by the account (`licenses.account_id`); `origin = 'oidc'`. Under S-19 combined mode, a group mapping that grants keys also writes the `oidc` grant (LX-08). |
| `product_idp`, `email_domain` | The same mint, with the product's own identity link (I-22) or the account's verified email as the evidence; audit `source: discover; path: <kind>`.                                                                                                       |
| `store_owned`                 | The commerce bridge's binding for the store identity (LX-11 holder binding): a `steam` grant on the store-identity holder plus the base mapping's licence owned by the account, exactly as a device-side Steam claim would create.                        |
| `open`                        | A `library_entries` row `(account_id, product, added_at, via='open')`. No licence and no device. The Library shows it with "Free to use" and Get it.                                                                                                      |

**Rules that hold for every path:**

- **One per product.** Idempotent per (account, product). An account that already holds a usable
  licence never gets a second one (the I-26 rule). The claim answers the existing licence.
- **No device binding.** Devices bind at their next sign-in or activation through SIGN-IN.md's
  `LicenseChoiceStep`, where the added licence is a row (preselected by rank-first, never forced).
  Seat limits apply there, with **Replace a device**.
- **Audit and rate limit** as today (`portalClaimKey`, `portal.discover.claim`, `license.create`
  with `source: discover`).
- **Remove from library** applies only to `library_entries`. A licence leaves the Library only by
  the existing detach, unchanged.

**`library_entries`** (new, owned by identity):

```sql
CREATE TABLE IF NOT EXISTS library_entries (
  account_id TEXT NOT NULL,
  product    TEXT NOT NULL,
  via        TEXT NOT NULL CHECK (via IN ('open')),  -- S-22 may add none: purchases create licences
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, product)
);
```

`libraryView` unions licences and entries; an entry is dropped from the view when the account
later holds a licence for the product. Account deletion (S-16 D25) deletes entries.

### 6.5 The portal: Discover and the storefront page (PS-05)

- **Discover tiles** (PX-16's `DiscoverTile`). The reason line uses the first path; a second path
  shows as "+1 more way" on the product page. The copy:

  | Path           | Reason line                                                                          |
  | -------------- | ------------------------------------------------------------------------------------ |
  | `auto_issue`   | "Free with a Polaris Key account" (or "Free trial · 14 days" when the tier expires)  |
  | `group`        | "Included with <label>" when an operator label exists, else "For members of <group>" |
  | `product_idp`  | "Included with your <IdP label> account"                                             |
  | `email_domain` | "For everyone with a <domain> email"                                                 |
  | `store_owned`  | "You own it on Steam"                                                                |
  | `open`         | "Free to use"                                                                        |
  | (link only)    | No reason line; the action is "Get it on <store>"                                    |

  PORTAL.md's rule stands: every offer shows why (owner Q-6).

- **Storefront product page** `#/discover/:product`. The listing (description, screenshots from
  the media host, platforms), every path with its terms, and **Add to library**. It is served by
  `GET /api/discover/<p>`, which answers `404 not_found` for anything not visible to this person.
  After Add, it redirects to `#/p/:product`.
- **Library.** An open product's tile has no licence card and no seat meter. Its page shows Get it
  and the listing.
- **Footnote change.** "Only products you can add for free appear here" stays true for the first
  release. S-22 replaces it when priced offers exist.

### 6.6 The console (PS-06)

- **Hub tile.** A-18j renders tiles from `STOREFRONT_ADAPTERS`, so the Polaris Key tile appears
  once PS-01 registers it. Its capability strip comes from the declaration. Its state is always
  "Connected"; the Store connections page does not list it (there is no credential to set).
- **Listing editor.** A-18j's Listing (T3) with `polaris-key` in the store switcher: overrides in
  `dist_listing_overrides(store = 'polaris-key')`; the fit report from the profile.
- **Polaris Key panel** (in the product's Storefronts area, T4 layout, controls right-aligned):
  - Listing: Automatic / Listed / Not listed, with one line under each saying who sees it.
  - Audience: "People who can add it" / "Everyone signed in", the second behind a typed
    confirmation (D5).
  - Ways to add: one switch per path kind available to the product (`offerPaths`); a path whose
    policy is not configured is absent, not disabled.
  - Group labels: one row per mapped group in `groupRoleMap`.
- **Readiness checklist** (§6.1) as the adapter's prerequisites step.
- **"Who can see this?"** A list of the active paths in plain language ("Everyone with a Polaris
  Key account", "Members of `members` at the Polaris Key sign-in", "Steam owners who linked
  Steam"). It has a **persona simulator**: the operator picks IdP groups, an email domain, a
  linked store and "holds it already", and sees the tile exactly as that person would. The
  simulator runs the same engine against a synthetic account in memory. It never reads a real
  account (D11), so a product operator learns nothing about any person.
- **Analytics card** (D12). Last 28 days: impressions, adds, first activations within 7 days of an
  add, and the rate, per path kind. Source: `storefront_daily(product, day, path_kind,
impressions, adds, activations)`. Impressions are deduplicated per account per day through
  `storefront_seen(product, day, account_key)`, where `account_key = HMAC(daily salt, account_id)`
  and rows older than two days are deleted. An activation counts when a device first binds to a
  licence whose audit `source` is `discover`.

### 6.7 Settings, wire and API impact

- **Device wire:** none. No signed document, discovery field, header or corpus file changes.
  `PROTOCOL_VERSION` stays 4.
- **Portal API** (rule 10: OpenAPI and `routeCoverage`):
  - `GET /api/discover`: additive fields per offer: `paths[]`, `cta`, `shortDescription`.
    `reason` and `offer` keep their meaning (the first path), so PX-16 works unchanged.
  - `GET /api/discover/<p>`: new; the storefront product page.
  - `POST /api/discover/<p>/claim`: optional `{path}`.
  - `DELETE /api/library/<p>`: new; removes a library entry only.
  - `GET /api/library`: gains entries with `kind: "entry"`.
- **Admin API** (narrative-only routes): `GET /manage/api/products/<p>/storefronts/polaris-key`
  (state, readiness, paths), `POST …/preview` (persona), `GET …/analytics`. Settings writes go
  through ST-05's generic API once it exists; until then, a bespoke `PUT` aliased by ST-05.

### 6.8 `direct` becomes "Polaris Key" (PS-10)

**Decision: keep the identifier `direct`; change every label.** Reasons:

1. `direct` is inside signed feed documents and the conformance corpus. Renaming it is a wire
   change: a new kind beside `direct` would never match an old SDK's stamp, because outlet kinds
   are open-ended and an unknown kind never matches. So both would have to be served for years.
2. Six SDKs, the Godot export plugin, an Android build flavour and three Maven artifact names
   carry it. A rename would touch every one, for no change in behaviour.
3. The meaning is already right: "installed from the developer's own download". That download is
   served by Polaris Key (`dl.plrs.im`, the download page, the Scoop and Homebrew feeds).

**What changes (PS-10, not plan mode):**

- `A/lib/labels.ts` `OUTLET_KIND_LABELS.direct = "Polaris Key"`. Subkinds read "Polaris Key · via
  Homebrew".
- The download page heading reads "Download from Polaris Key", not "Direct download".
- The console's distribution matrix, outlets, rollouts, update health and compatibility views get
  the new label through the label table. A test asserts that no user-facing string says "Direct
  download".
- Docs: `start/concepts.md` defines "the Polaris Key outlet (id `direct`)"; the distribution,
  feeds, rollouts, availability and update-health pages say "the Polaris Key outlet (`direct`)".
  SDK READMEs say the same. `docs/security/WIRE-CONTRACT-V4.md` §8 adds one sentence: "`direct`
  is presented as Polaris Key" (a prose change, not a contract change).
- **S-19 grant source.** `direct` → `polaris-key` in the grant-source vocabulary before LX-08
  creates it. The plan's trigger vocabulary is replaceable by design (`P/plans/LX-01.md:351`).
  Portal badge "Polaris Key". An LX-08 brief amendment records it.
- **Provenance.** `PurchaseSourceKind` keeps `developer` for operator-issued licences ("From
  <developer>"). S-22 adds `polaris-key` ("Bought on Polaris Key").

**Not changed:** the outlet id and kind `direct`, generated constants, the corpus, the Android
flavour, Maven artifact names, the Godot `outlets/direct.gd` adapter and Obtainium's
`source: "direct"`.

### 6.9 Threat-model deltas (PS-11 writes them)

| #   | Threat                                                                                          | Control                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Enumeration** of private or unlisted products through listing, page, claim or counts (T1, T3) | Only visible products are listed or counted; page `404` and claim `409` are identical for unknown, unlisted and ineligible; claim rate limit before lookup; test |
| S2  | **Free-path escalation**: a path grants what sign-in would not                                  | Identity paths are `identityTier` itself; `open` grants no licence; `store_owned` reuses LX-11's binding verification                                            |
| S3  | **Stale group membership** yields offers after removal at the IdP                               | Existing residual (groups as of the last portal sign-in); a claim re-evaluates; revocation acts on the licence                                                   |
| S4  | **Unverified email** used for `email_domain`                                                    | Only verified emails (the email gate, PX-W15) count; plus-addressing does not change the domain; the rule also gates sign-in, so there is no new capability      |
| S5  | **Cross-tenant identity**: a tenant-controlled issuer offers or collides                        | `product_idp` needs a product-scoped verified link (I-22); the platform-issuer and auto-link predicate stays on platform paths                                   |
| S6  | **Operator probing a person** through the preview                                               | Personas only; no account lookup endpoint                                                                                                                        |
| S7  | **Accidental exposure** through audience `everyone`                                             | Operator-only, typed confirmation (L2), audited; the readiness step names it                                                                                     |
| S8  | **Analytics as tracking**                                                                       | Daily aggregates; keyed hashes with a daily salt kept two days; no per-person rows exposed                                                                       |
| S9  | **First-party adapter reaching a vendor**                                                       | `first-party` ops require `credential: null` and `gate: null`; the conformance branch runs them with `fetch` replaced by a thrower                               |
| S10 | **Listing text injection**                                                                      | Rendered escaped in portal and console (A-18 control g)                                                                                                          |
| S11 | **Steam ownership oracle**: probing whether a Steam id owns an app                              | Only the account's own linked Steam id; result cached; budgeted; no route takes a Steam id                                                                       |

### 6.10 Seams for the commerce module (S-22)

S-22 designs commerce (payment providers, checkout, tax, receipts, refunds, upgrades,
subscriptions). The first release stays free; it leaves these seams for S-22 to plug into:

1. **`ObtainPath.action`.** It is `"add" | "link"` today; S-22 adds `"buy"` and `"upgrade"`. The
   portal's tile and page render the action from the server, so a priced path needs no new tile.
2. **Offers keyed by path.** A priced offer is an obtain path with `action: "buy"` and a `price`
   (`{amount, currency, period?}`), contributed by the commerce module through the same engine.
   So eligibility (who may buy) and visibility stay one function.
3. **One issuance function.** PS-04 routes every path through `issueFromPath(path, account)`. A
   completed checkout calls it with the provider's verified event, so free and paid adds create
   the same licence and grant shapes.
4. **Grant source `polaris-key`** (§6.8), with `external_ref_hash` (the provider's order id hash)
   and `order_ref` for refunds (S-19 §7.6).
5. **Lifecycle.** Upgrades: a new licence with `superseded_by` (S-19 §7.6). Subscriptions:
   `grants.expires_at` or `licenses.expires_at`, `state = 'past_due'`, `dunningGraceDays`
   (LX-12, LX-23). S-22 maps provider events onto these; it adds no lifecycle states.
6. **A payment-provider interface beside the storefront adapter.** For the console, a provider is
   one more connection (Platform → Store connections, a `PLATFORM_CREDENTIALS` slot). The
   `polaris-key` adapter's `pricing` and `iap` ops flip from `unsupported` to `first-party` when a
   provider is connected, so the hub and the readiness checklist need no new shape. The interface
   itself (checkout session, webhook verification, event parsing, customer portal link) is S-22's.
7. **Upgrade paths need `tiers.rank`** (LX-08). The storefront product page reserves the
   "Upgrade" action for held products, rendered only when the engine returns an `upgrade` path. No
   placeholder is shown before then.
8. **The footnote and the counts.** The Discover count stays "offers you can add now". S-22
   decides whether buyable products count.
9. **Analytics** gain revenue columns in S-22, not here.

## 7. Wire and plan-mode impact

- **No device-wire change.** No signed document, discovery member, header, error code or corpus
  file changes. No `PROTOCOL_VERSION` change.
- **No plan-mode package.** The `direct` rename keeps every identifier (D9). If the owner ever
  wants the id itself renamed, that is a plan-mode package of its own: wire contract §8 →
  `OUTLET_KINDS` (`SP/distribution.ts`) → `conformance/parity/enums.json` →
  `tools/sign-corpus.ts` and `pnpm gen:corpus` (cases, update and outlet matrices, mirrors) →
  `pnpm gen:transcripts` → `pnpm gen:constants` → detection in client-core, Node, React, Python,
  Swift, Kotlin (and the Android flavour) and Godot (and the export plugin), with a dual-kind
  period in feeds.
- **Rule 10:** the portal and admin routes in §6.7.
- **Rule 9:** PS-09 adds `autoIssue.emailDomains` to `.pkey/product` (mutation-table entry).
- **Rule 6:** the engine stays in identity; two new methods on Distribution's `delivery()` hook.

## 8. Interactions with other plans

- **PX-W10, PX-16.** The engine replaces `discoverOffers` internally with identical `auto`
  results. PX-16 lands first; PS-05 extends it.
- **A-18j.** Renders the Polaris Key tile from the registry. A-18j's hard-coded Store connections
  list should not gain `polaris-key`: there is nothing to connect.
- **ST-13** hosts the Listing editor in the settings hub; the Polaris Key panel moves with it.
- **S-18 D22.** Superseded by `storefront.polarisKey.listed` (D3).
- **HA-04, HA-07.** The storefront page uses `presentation.icon`, header and screenshots from the
  media host when they exist, and today's `/media/` proxy otherwise. No hard dependency.
- **I-26, I-08, PX-14.** The added licence appears in `LicenseChoiceStep`; Add never mints a second
  licence.
- **LX-08.** Grant source `polaris-key`, not `direct` (amendment in this branch).
- **LX-11, I-06.** Prerequisites of `store_owned` (PS-07).
- **I-22.** Prerequisite of `product_idp` (PS-08).
- **LX-25.** Codes enter through the Activate modal, not the storefront.
- **LX-23, S-22.** Commerce and subscriptions plug into §6.10.

## 9. Work packages (`PS-`)

| ID    | Title (short)                                                                                                                    | Deps                       | Role             | Plan mode | Est. (wk) |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- | --------- | --------- |
| PS-01 | `polaris-key` storefront adapter: `first-party` Support mode, declaration, listing profile, conformance branch                   | A-18a, A-18b               | pkey-implementer | no        | 0.5–0.8   |
| PS-02 | Listing state: `storefront.polarisKey.*` settings, storage, `discover_enabled` backfill                                          | ST-03                      | pkey-implementer | no        | 0.4–0.6   |
| PS-03 | Obtain-path engine: dry-run evaluation, `open` path, listing modes, Discover rebuilt on it                                       | PS-02                      | pkey-implementer | no        | 1–1.5     |
| PS-04 | Portal API: storefront page, claim by path, `library_entries`, daily analytics                                                   | PS-03                      | pkey-implementer | no        | 1–1.5     |
| PS-05 | Portal UI: multi-path tiles, storefront product page, open products in the Library                                               | PS-04, PX-16               | pkey-implementer | no        | 0.8–1.2   |
| PS-06 | Console: Polaris Key tile and panel, readiness, "Who can see this?", analytics card                                              | A-18j, PS-01, PS-02, PS-04 | pkey-implementer | no        | 1.5–2     |
| PS-07 | `store_owned` path: Steam ownership through the linked Steam sign-in                                                             | PS-03, LX-11, I-06         | pkey-implementer | no        | 0.6–1     |
| PS-08 | _Optional:_ `product_idp` path for products with their own IdP                                                                   | PS-03, I-22                | pkey-implementer | no        | 0.4–0.6   |
| PS-09 | _Optional:_ `email_domain` path: `autoIssue.emailDomains` for sign-in and the storefront                                         | PS-03                      | pkey-implementer | no        | 0.5–0.8   |
| PS-10 | `direct` shown as "Polaris Key": labels, docs, glossary, grant-source vocabulary                                                 | none                       | pkey-implementer | no        | 0.3–0.5   |
| PS-11 | Storefront close-out: docs, glossary, THREAT-MODEL S1–S11, ADMIN.md and PORTAL.md amendments, `discover_enabled` readers retired | PS-05, PS-06               | pkey-implementer | no        | 0.4–0.6   |

- **Ready now:** PS-01, PS-02 and PS-10. Their dependencies (A-18a, A-18b, ST-03) are done.
- **Next:** PS-03 once PS-02 is done; PS-04 after it.
- **The critical path** to "listed products appear to everyone who can add them" is PS-02 → PS-03
  → PS-04 → PS-05 (with PX-16), about 3.3–4.8 engineer-weeks. The console (PS-06) waits on A-18j.

## 10. Risks and owner questions

### 10.1 Risks

- **Scope creep into commerce.** Mitigated by §6.10: the first release has no price, no checkout
  and no "coming soon" copy.
- **`listed` surfaces products operators did not expect** (open products with public downloads).
  Mitigated by the `auto` default, which changes nothing on deploy, and by the persona preview.
- **Store-ownership budgets** (Steam Web API) are [U] until PS-07 measures them. Mitigated by the
  cache and by evaluating only listed candidates.
- **Group label drift.** A renamed IdP group loses its label. The panel lists unlabelled mapped
  groups.

### 10.2 Owner questions: all decided (delegated to Claude, 2026-10-05)

Each question shows the recommendation (adopted) in bold and the alternative considered.

1. **Q1. Where does the storefront live in the console?** **As an adapter in the A-18 registry,
   shown in the distribution hub (D1).** The alternative, a portal setting in the settings hub, was
   rejected: the owner asked for a distribution channel beside the other stores.
2. **Q2. Who decides visibility?** **The operator lists; eligibility decides who sees it (D2).**
   The alternative, listing visible to every signed-in account, would leak private products.
3. **Q3. Default for existing products.** **`auto`, which reproduces today's Discover (D3).** The
   alternatives were `unlisted` (removes offers people see today) and `listed` (surfaces products
   nobody chose to show).
4. **Q4. Which paths in the first release?** **`group`, `auto_issue` and `open` (PS-03);
   `store_owned` (PS-07) when LX-11 and I-06 land; `product_idp` and `email_domain` optional
   (D4).**
5. **Q5. Where does the engine live?** **In the identity service beside Discover, with
   single-provider hook methods (D4).** The alternative, a multi-provider Core hook, would add a
   new composition rule for one feature.
6. **Q6. What does Add create for a product that needs no licence?** **A `library_entries` row
   (D6).** The alternatives were a zero-tier licence (pollutes seats and documents) or nothing (the
   Library would not show it).
7. **Q7. Does Add bind a device?** **No. Devices choose at sign-in (D7).**
8. **Q8. Audience `everyone`.** **Allowed, operator-only, typed confirmation, link-only actions
   (D5).** It is the one deliberate visibility exception.
9. **Q9. Paid listings.** **Out of the first release; seams fixed here, design in S-22 (D8).**
10. **Q10. `direct` rename.** **Labels only; keep the id; rename the planned grant source to
    `polaris-key` (D9).** The alternative, migrating the outlet id, is spelled out in §7 as a
    plan-mode package nobody needs yet.
11. **Q11. Group copy.** **Operator labels, with "For members of <group>" as the fallback
    (D10).**
12. **Q12. Preview.** **Personas, never a real account (D11).** The alternative, "check an email
    address", would let any product operator test whether a person has an account.
13. **Q13. Analytics granularity.** **Daily aggregates per path kind (D12).** Per-person funnels
    were rejected on privacy grounds.
14. **Q14. Redeem codes as a path?** **No. Codes enter through Activate (LX-25).** A code is
    evidence the person brings, not a reason to list a product.
15. **Q15. Remove from library.** **Entries only; licences keep the existing detach.**

## 11. Brief changes

- **New:** `P/wp/PS-01…PS-11` briefs, registered in `workpackages.json` under the new `PS`
  phase. The `check.mjs` and schema id patterns now accept `PS-`.
- **A-18j:** S-21 note: the Polaris Key tile comes from the registry; Store connections does not
  list it. **Edited in this branch.**
- **PX-16:** S-21 note: keep `reason` and `offer` as the first path, so PS-05 extends the tile.
  **Edited in this branch.**
- **LX-08:** S-21 amendment: grant source `polaris-key` replaces `direct` in the vocabulary.
  **Edited in this branch.**
- **LX-23, LX-25:** S-21 notes: commerce seams (§6.10) and codes through Activate. **Edited in
  this branch.**
- **Proposed for the report** (not edited here): README §11 gains a decision row "Polaris Key is
  a first-party distribution and release channel: the Library is a storefront; `direct` is shown
  as Polaris Key" (S-21 D1, D9). S-18 §8's `identity.discover.listed` row points at
  `storefront.polarisKey.listed`. PORTAL.md §4.16's "Who sees what" gains the listing modes;
  PS-11 amends it.

## 12. Sources

- **Code** [V]: the files cited inline, at `0f9170cdb`. PX-16 at `wp/PX-16-discover-page`
  `df21ce4b3`. SIGN-IN.md at `design/sign-in` `247ca28ce`.
- **Notes and plans** [S]: S-15 §6, §7, §8; S-16 §5; S-18 §7.3 D22, §8; S-19 §7.1–§7.7, §9,
  §10.3; S-20 §6; `P/plans/LX-01.md`; `P/plans/I-04.md`.
- **Design** [V]: `docs/design/PORTAL.md` §3.1, §4.12–4.16, §10.2; `docs/design/EXPERIENCE.md`;
  `docs/security/THREAT-MODEL.md` "Discover" and "Storefront adapters";
  `docs/security/WIRE-CONTRACT-V4.md` §8.
- **Measurements** [M]: §5; the prototype at `prototype/polaris-storefront/obtain.mjs`.

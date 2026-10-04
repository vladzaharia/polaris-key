> Research note for [Godot on Polaris Key](../README.md), 2026-10-04. Spike S-15, commissioned by

> **Owner decisions (2026-10-04), all as recommended:** (1) widen the App Store gate so the full Apple listing (text and screenshots) is pushed from the shared model (A-18m goes ahead); (2) listing assets — and only listing assets — may be pushed from the Worker out of the blob store, amending README decision 7 (binaries stay in CI); (3) A-17a's ledger is renamed to `store_operations` before it merges (lead sequences it); (4) the Play service account gains "Manage store presence" and "Manage testing tracks and edit tester lists", never Admin, data safety stays in the Console; (5) Steam's public-branch release is a deep link until A-18k verifies the key, then typed confirmation; (6) no deleting Play images in v1; (7) fine-grained GitHub tokens for our own tap and bucket, classic `public_repo` for winget only if needed, CI secrets only; (8) Epic waits for a product that ships there. Owner architecture requirement: one modular adapter layer shared in shape with the FeedAdapter contract (§6).
> the lead on the owner's direction of 2026-10-04: "Provisioning on all storefronts should be easy
> to do. Use assets that are already available, etc." It extends S-14 (App Store Connect) to every
> other storefront. The owner added a requirement the same day, relayed by the lead: the system must
> be modular, built on a common layer that abstracts each store's responsibilities and
> capabilities, so that adding a storefront is easy, and the feeds system must follow the same
> pattern. Like S-14, it has no program brief. The breakdown in §11 proposes `A-18a…` ids in the
> admin namespace, beside A-17.
> Research and design only. No product code changed, and **no call was made against any store
> account**: no Play, Partner Center, Steamworks, itch.io, Snap or GitHub credential exists in this
> session. The only network reads were public documentation and Google's public discovery
> document. File references are to the tree at `47da77b9` (`W/` = `packages/worker/`,
> `A/` = `packages/admin/src/`, `M/` = `packages/shared-manifest/`). A-17a is cited from its branch
> `wp/A-17a-asc-write-gate` at `f1fbdb94`, which is not yet merged.

# S-15: easy provisioning on every storefront, through one adapter layer

Evidence tags, as in S-14:

- **[V]**: primary source read raw: vendor documentation fetched on 2026-10-04, Google's
  androidpublisher v3 discovery document, and this repo's code;
- **[M]**: measured here. The only measurement is the discovery-document scan in §3, which reads a
  public document, not an account;
- **[S]**: secondary or summary: search-result excerpts, community tooling, memory;
- **[U]**: unverified: needs a call in the owner's account (§12 lists each);
- **[I]**: inference or recommendation.

## 1. Question

S-14 designed the App Store half. A-17a to A-17e are being built from it now: the write gate,
bundle ids, product setup, Distribute and IAP. This spike answers the same questions for every
other storefront, and asks what they share:

1. **Per storefront.** For Google Play, the Microsoft Store and Steam, which take credentials (A-16),
   and for the outlets that take none (itch.io, Epic, Flathub, Snap, winget, Homebrew and Scoop,
   AltStore, F-Droid and Obtainium, App Installer):
   - what can be created or configured by API or CLI;
   - what is UI-only and needs a deep link plus polling;
   - the rate limits and the review flow;
   - the minimal-permission credential;
   - what must never be automated.
2. **One shared listing model**, entered once or not at all:
   - which fields and assets it holds, per locale;
   - where each already exists (manifests, release notes, the brand kit, the Godot project, A-17's
     App Store reads, Play's listing reads);
   - each store's limits, what can be derived safely, and what must be made by a person;
   - how Apple (A-17d) consumes it.
3. **The provisioning UX.** One "Add to storefronts" flow per product. It reuses A-17a's
   deny-by-default gate and ledger for every store, and keeps the owner's rules: never delete, never
   manage users or payments, typed confirmation for submit, release and price changes.
4. **The common layer** (owner requirement, 2026-10-04). A `StorefrontAdapter` contract with
   per-adapter capability declarations; a store-agnostic gate, ledger, confirmations, listing
   model, polling, deep links, audit and rate budgets; an adapter conformance suite; and a contract
   shaped like the feeds system's `FeedAdapter`.
5. **The work packages**: dependencies on A-16, A-17a and F-11; what generalises A-17a instead of
   duplicating it; what A-17d, A-17f and A-17g must change.

## 2. Short answer

- **No storefront lets an API create the app itself.** Every store needs one human bootstrap, and
  most need a second for the rating questionnaire:

  - Play: create the app in the Console. The Edits API works only on "an _existing_ app (that has at
    least one APK uploaded)" [V].
  - Microsoft Store: reserve the name and make the first submission, "including answering the age
    ratings questionnaire", in Partner Center [V].
  - Steam: pay the $100 fee and create the app in Steamworks [V].
  - itch.io: create the game page by hand. The server-side API is read-only [V].
  - Flathub: the first submission is a pull request that volunteers review [V].
  - Snap: `snapcraft register` [V].

  The flow therefore treats "create the app" as a **deep-link step with a verifier**: it shows the
  values to paste and polls a read until the app appears. This is S-14 §5.1's pattern, used for
  every store [I].

- **After the bootstrap, most of a listing can be written by API, but not on every store:**

  | Store           | Listing writable by API                                                                                                          | UI-only                                                                                                                                  |
  | --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | Google Play     | Per-language title, short and full description, video; contact details; icon, feature graphic and screenshots; data safety (CSV) | Category and tags; content rating; target audience, ads, app access and privacy policy declarations; RTDN topic; Play Integrity link     |
  | Microsoft Store | Per-language listing text, images and trailers; category; price tier (classic API)                                               | Name reservation; first submission and IARC rating; privacy, website and support URLs for MSIX (the API fields are "obsolete … ignored") |
  | Steam           | Nothing                                                                                                                          | The whole store page, assets, DLC, achievements and pricing. The Web API only reads, checks ownership and sets a build live on a branch  |
  | itch.io         | Nothing                                                                                                                          | The game page. Builds go up with `butler push`                                                                                           |
  | Epic            | No public listing API found [S]                                                                                                  | The store page (Developer Portal). Binaries go up with BuildPatchTool                                                                    |
  | Snap            | Summary, description and icon (`snapcraft upload-metadata`)                                                                      | Title, screenshots, banner and video (dashboard)                                                                                         |
  | Flathub         | Everything, through the app's own MetaInfo XML in its manifest repo                                                              | Nothing after acceptance. Each change is a PR                                                                                            |
  | winget          | Everything, through manifest YAML in a PR                                                                                        | Nothing, but every version is moderator-reviewed                                                                                         |
  | Homebrew, Scoop | Everything, in an own tap or bucket                                                                                              | Nothing                                                                                                                                  |

- **Three planes, not one.** Each step runs on exactly one of them:

  - the **Worker**, for HTTPS APIs the Worker already talks to: ASC, Play, Partner Center and the
    Steam Web API;
  - **CI**, for vendor CLIs that upload binaries: steamcmd, butler, BuildPatchTool, snapcraft and
    msstore. The program README keeps binary uploads out of the Worker ("uploads never", decision 7)
    [V];
  - **pull requests** to package repositories: winget-pkgs, Flathub, an own Homebrew tap or Scoop
    bucket.

  An adapter declares, per operation, which plane runs it: `api`, `ci`, `pr`, `deep-link` or
  `unsupported`. The console renders that declaration; it does not hard-code store knowledge [I].

- **The common layer generalises A-17a; it does not copy it.** A-17a's parts sort as follows
  (A-17a at `f1fbdb94`) [V][I]:

  - **Already store-neutral apart from names:** the ledger (`asc_operations`) and the
    `performAscWrite` step shape.
  - **Store-specific, but the pattern carries over:** the gate table, its body matcher (JSON:API)
    and its spec pin.
  - **Tied to Apple's header:** the budget.

  A-18a moves the engine to `core/storefront/` and makes A-17a's ASC table the first adapter's rule
  set, with no change to the ASC surface. **A-17a is not merged yet, so renaming its table to
  `store_operations`, with a `store` column, costs one line now and a table rebuild later**
  (decision 3).

- **Play has a hazard the design must close first: one open edit per user.** "Each user may have
  only a single edit open at a time. If you create a new edit, any existing edit you may have open
  is invalidated" [V]. P5-03's poller already opens and deletes an edit on every tick for every
  pinned app (`connectors/play/poll.ts`) [V]. It would silently kill any provisioning edit in
  progress. A per-package edit lease, shared by the poller, the controls and provisioning, is a
  prerequisite of the Play adapter [I].

- **Review state is readable on every keyed store, so submit-then-poll works:**

  - Play: `applications.tracks.releases.list` returns `releaseLifecycleState`, including
    `IN_REVIEW`, `NOT_APPROVED` and `APPROVED_NOT_PUBLISHED` [V].
  - Microsoft Store: the submission status moves through `Certification`, `Release`, `Published`
    and their failure states, with certification report URLs [V].
  - Apple: S-14 §5.4.
  - Steam: nothing to poll. Store and build reviews are UI-driven and take 3–5 business days [V].

- **The minimal credentials are narrower than the owner's setup guide, except on Microsoft:**

  - Play: the service account needs **"Manage store presence"** for listings and IAP, **"Manage
    testing tracks and edit tester lists"** for testers, and the two release permissions. It never
    needs Admin (`CAN_MANAGE_PERMISSIONS`). The guide's two financial permissions stay for P6-01
    [V].
  - Microsoft: both submission APIs document only the **Manager** role [V]. Whether Developer is
    enough is [U].
  - Steam: the group-scoped publisher key for the Web API; a build account limited to "Edit App
    Metadata" and "Publish App Changes To Steam" [V].
  - Snap: a scoped, expiring `snapcraft export-login` (`--snaps`, `--channels`,
    `--acls package_push,package_release`, `--expires`) [V].
  - itch.io: no scoping at all. Keys from user settings "are unscoped — they have access to all
    endpoints" [V]. So the butler key lives only in CI.

- **The never-list is reachable by API on Play.** The discovery document has 12 `DELETE`s and full
  `users` and `grants` resources (the Permissions API); it also has `appsigning.rotateAppSigningKey`,
  `orders.refund` and `purchases.subscriptionsv2.revoke` [M][V]. Like ASC, Play gets a deny-by-default
  gate classified against a pinned discovery document (revision `20261001`). Partner Center's API
  has no user management, but it has 5 `DELETE`s, including deleting an add-on [V]. Steam's Web API
  has nothing dangerous except `SetAppBuildLive` on the public branch, which is a release [V].

- **One shared listing model, about 70 % derivable from what exists.** The model:

  - one row-stored listing per product, with per-locale text, canonical content descriptors,
    URLs, brand colours and asset slots;
  - per-store overrides;
  - one projection per adapter, which reports "too long" and never truncates silently.

  The sources (§7.2):

  - name, version, bundle id, copyright, developer name, category hint and master icon come from
    the Godot project and its export presets [V];
  - the release notes are in `release_metadata.notes` [V];
  - the subtitle, description, icon, header and screenshots are in `.pkey/distribution` `listing`
    [V];
  - App Store text, keywords, URLs, screenshots and age-rating answers can be imported through
    A-17's reads [V];
  - the Play listing and images can be imported through a read-only edit [V].

  **Screenshots and trailers must be made by a person** [V]. So must the logo-free key art, if the
  generated Steam capsules, Play feature graphic and Microsoft hero art are to look intentional.
  Every icon size can be derived from one 1024² master [V].

- **Recommendation.** Build A-18a, the storefront substrate generalising A-17a, and A-18b, the
  listing model, first. Then Play and Microsoft adapters on the Worker plane, Steam as a
  deep-link-heavy adapter, CI-plane adapters for itch.io and Snap, PR-plane generators for winget,
  Flathub and the tap or bucket, and one console flow (§11). Fold A-17f's New app wizard into that
  flow as the Apple adapter's plan, rather than building it twice.

## 3. Method

1. Read `AGENTS.md`, S-14 in full, the owner's storefront setup guide (2026-10-04), and the code:
   - A-16 (`W/src/admin/handlers/platformStoreConnections.ts`, `W/src/core/platformCredentials.ts`,
     `W/src/core/platformStoreSettings.ts`, `W/migrations/0055_platform_store_connections.sql`,
     `W/src/services/distribution/connectors/{platformApps,platformFallback}.ts`);
   - the P5-02, P5-03 and P5-04 connectors (`connectors/{asc,play,msstore}/`);
   - P6-01 commerce (`commerce/{apple,play,steam}.ts`, `W/migrations/0052_commerce.sql`);
   - the outlet kinds, transports and feeds (`packages/shared-protocol/src/distribution.ts`,
     `M/src/distribution.ts`, `distribution/{matrix,outlets}.ts`, `distribution/feeds/`,
     `distribution/page/model.ts`);
   - P5-08's transports (`packages/cli/src/transport*.ts`);
   - the manifest schemas (`M/schemas/v1/*.schema.json`) and `pkey init`
     (`packages/cli/src/manifest.ts`);
   - release notes storage (`W/migrations/0007_backend_contracts.sql`,
     `services/release/descriptor.ts`);
   - `packages/brand` (kit README, `BUILD-INFO.json`, generators);
   - the Godot export plugin (`sdks/godot/addons/polaris_key/export/export_plugin.gd`,
     `core/build_stamp.gd`);
   - the console's Store connections page (`A/console/pages/platformStores.tsx`);
   - the package-feeds renderer contract (`distribution/registry/materialise.ts`, `plans/F-01.md`
     §6.8 and §6.9);
   - A-17a's branch (`core/asc/{writeGate,writeGateDenied,ledger,budget,audit,client}.ts`,
     `migrations/0059_asc_operations.sql`).
2. Read vendor documentation on 2026-10-04 [V]. Exa was unavailable (server not found), so pages
   were fetched with WebFetch, WebSearch and curl. Epic's developer pages render only with
   JavaScript, so every Epic statement is from search excerpts and tagged [S]. The URLs are in §14.
3. Scanned Google's discovery document for androidpublisher v3. It is public; no account was used
   [M]:

   ```sh
   curl -sSo play-discovery.json 'https://androidpublisher.googleapis.com/$discovery/rest?version=v3'
   mise exec node@22 -- node S-15-storefront-provisioning/scan-play-discovery.mjs play-discovery.json
   # revision 20261001, sha256 bcbce36e…53ad51cf, 1 OAuth scope (androidpublisher)
   # 145 methods: GET 45, POST 71, PATCH 11, DELETE 12, PUT 6
   ```

   The document was not committed. The script is in `S-15-storefront-provisioning/`. The scan ran on
   2026-10-04 at 14:31 UTC on macOS, with Node 22 through mise.

4. Nothing was measured against an account. Every statement about what a credential can actually do
   is therefore [V] from documentation, or [U]. A-18k (§11) is the live check, as A-17h was for
   S-14.

## 4. Per-store capabilities

**Mode** is how Polaris Key performs the step:

- `api`: the Worker calls an HTTPS API through the gate;
- `ci`: the publish action runs a vendor CLI;
- `pr`: CI opens a pull request;
- `link`: a deep link plus a verifier read, or an operator tick when nothing can be read;
- `never`: Polaris Key does not perform it.

None of the deep-link URL shapes is documented by its vendor [I]. They live in one constant table
(A-18a).

### 4.1 Google Play (Worker plane)

| Area        | Operation                                                                                                              | Mode                         | Evidence                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App         | Create; first upload                                                                                                   | `link`                       | "you will have to upload at least one APK through the Play Console before you can use this API" [V]; no create method among 145 [M]                                                                                  |
| App         | Detect that it exists                                                                                                  | `api` (read)                 | Reporting API `apps:search`, already A-16's lister (`connectors/play/platform.ts:91`) [V]                                                                                                                            |
| App         | Unpublish, delete                                                                                                      | `never`                      | The API "cannot … change an app's state from 'published' to 'unpublished'" [V]; no delete method [M]                                                                                                                 |
| Edits       | insert, validate, commit, delete                                                                                       | `api`                        | One open edit per user; any commit or Console change "invalidates" all other edits [V]. `expiryTimeSeconds` exists, but no duration is documented [V]                                                                |
| Listing     | Contact email, phone, website, default language                                                                        | `api`                        | `edits.details` [V]                                                                                                                                                                                                  |
| Listing     | Per-language title, short and full description, YouTube video                                                          | `api`                        | `edits.listings` `patch` and `update` [V]; `delete` and `deleteall` exist [M]                                                                                                                                        |
| Listing     | Icon, feature graphic, screenshots (phone, 7", 10", TV, Wear), TV banner                                               | `api`                        | `edits.images.upload`, 15 MiB cap, `imageType` enum of 8 [V]. New optional `aiGeneratedState` parameter [V]                                                                                                          |
| Listing     | Category, tags                                                                                                         | `link`                       | No field in `AppDetails` or `Listing` [V]; set "in Play Console" [V]                                                                                                                                                 |
| App content | Content rating (IARC)                                                                                                  | `link`                       | "you must fill out a rating questionnaire on the Play Console" [V]                                                                                                                                                   |
| App content | Target audience, ads, app access, privacy policy, news, other declarations                                             | `link`                       | Listed under App content; none in the API [V]                                                                                                                                                                        |
| App content | Data safety                                                                                                            | `api`, write-only            | `applications.dataSafety` takes the CSV; there is no read [V]. Needs "Manage policy declarations" [V]                                                                                                                |
| Tracks      | Releases: version codes, status, `userFraction`, release notes per language, country targeting, in-app update priority | `api`                        | `edits.tracks` [V]. P5-03 already patches rollout fields (`connectors/play/controls.ts`) [V]                                                                                                                         |
| Tracks      | Create a closed-testing track                                                                                          | `api`                        | `edits.tracks.create`: "the only supported value is closedTesting" [V]                                                                                                                                               |
| Testers     | Google Groups on a track                                                                                               | `api`                        | `edits.testers`: "email lists are not supported by this resource" [V]                                                                                                                                                |
| Testers     | Email lists (internal ≤ 100; closed ≤ 200 lists × 2,000)                                                               | `link`                       | UI only [V]                                                                                                                                                                                                          |
| Testers     | New personal account: 12 testers opted in for 14 days before production                                                | `link` + preflight           | [V]. The flow must surface it before promising production                                                                                                                                                            |
| Bundles     | Upload an AAB                                                                                                          | `ci`                         | `edits.bundles.upload` exists (50 GiB transport cap) [M], but uploads stay in CI (P5-03 brief, out of scope) [V]                                                                                                     |
| Review      | State                                                                                                                  | `api` (read)                 | `tracks.releases.list` → `releaseLifecycleState` ∈ `DRAFT, NOT_SENT_FOR_REVIEW, IN_REVIEW, APPROVED_NOT_PUBLISHED, NOT_APPROVED, PUBLISHED` [V]                                                                      |
| Review      | Submit                                                                                                                 | `api`, typed                 | `edits.commit`, with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (P5-03 already sends it) and optional `changesNotSentForReview` [V]                                                                                |
| Review      | Managed publishing: publish approved changes                                                                           | `link`                       | Turned on and published from the Console [V]. No publish method in the document [M]                                                                                                                                  |
| Commerce    | One-time products                                                                                                      | `api`                        | `monetization.onetimeproducts.patch` with `allowMissing` "will be created" [V]. Needs one release that carries the Billing Library first [V]. `inappproducts` is legacy, not formally deprecated [V]                 |
| Commerce    | Prices                                                                                                                 | `api`, typed                 | `convertRegionPrices`, then the product's prices [V]                                                                                                                                                                 |
| Commerce    | RTDN topic                                                                                                             | `link`                       | Set in "Monetize > Monetization setup" [V]. The Pub/Sub side needs `roles/pubsub.admin` (or editor plus securityAdmin) to create the topic and bind Google's publisher [V]. The owner's guide does this by hand once |
| Integrity   | Link the Cloud project                                                                                                 | `link`                       | "Click the **Link Cloud project** button" [V]                                                                                                                                                                        |
| **Never**   | `users.*`, `grants.*`                                                                                                  | `never`                      | The Permissions API: create, patch and delete Console users and per-app grants [V][M]                                                                                                                                |
| **Never**   | `appsigning.enrollApp`, `appsigning.rotateAppSigningKey`, `apprecovery.*`                                              | `never`                      | Irreversible signing or remote-recovery actions [M][I]                                                                                                                                                               |
| **Never**   | `orders.refund`, `purchases.*.cancel`, `subscriptionsv2.revoke`, `externaltransactions.*`                              | `never`                      | Payment actions. P6-01 reads purchases and acknowledges them; it never refunds [V]                                                                                                                                   |
| **Never**   | All 12 `DELETE`s, including `edits.images.deleteall`, `edits.listings.deleteall` and the product deletes               | `never`                      | Owner rule. Replacing a screenshot set means `upload` then `delete` of the old image ids; see §8.4                                                                                                                   |
| **Never**   | `appstoreappsreview.*`, `systemapks.*`, `internalappsharingartifacts.*`, `reviews.reply`                               | `never` (not on the surface) | Not needed [I]                                                                                                                                                                                                       |

**Limits.**

- **Quota:** 3,000 queries per minute per bucket. Publishing is one bucket. The page states no daily
  quota [V].
- **No rate header.** The budget counts locally [I].
- **Sizes:** the base module of an AAB may be 500 MB compressed [V]; an image upload may be
  15 MiB [M].
- **One OAuth scope** (`androidpublisher`). Console permissions are therefore the only vendor-side
  control [M][V].

**Minimal credential** [V]: a service account invited in Play Console, with app-level permissions
only:

| Need                               | Console permission                                               | API enum                                       |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Status (P5-03)                     | View app information (read-only)                                 | `CAN_VIEW_NON_FINANCIAL_DATA`                  |
| Listing, images, one-time products | Manage store presence                                            | `CAN_MANAGE_PUBLIC_LISTING`                    |
| Testing releases                   | Release apps to testing tracks                                   | `CAN_MANAGE_TRACK_APKS`                        |
| Testers and closed tracks          | Manage testing tracks and edit tester lists                      | `CAN_MANAGE_TRACK_USERS`                       |
| Production (P5-03 controls)        | Release to production, exclude devices, and use Play App Signing | `CAN_MANAGE_PUBLIC_APKS`                       |
| Purchases and voids (P6-01)        | View financial data; Manage orders and subscriptions             | `CAN_VIEW_FINANCIAL_DATA`, `CAN_MANAGE_ORDERS` |
| Data safety by API (not proposed)  | Manage policy declarations                                       | `CAN_MANAGE_APP_CONTENT`                       |
| **Never grant**                    | Admin                                                            | `CAN_MANAGE_PERMISSIONS(_GLOBAL)`              |

The owner's guide grants the release and financial permissions but not "Manage store presence" or
"Manage testing tracks". Those two are the additions (decision 4). "Manage store presence" also
covers "pricing, in-app products, and pricing templates" [V], so the gate, not the permission,
keeps price changes behind typed confirmation.

### 4.2 Microsoft Store (Worker plane)

Two APIs, chosen by package type [V]:

- **Classic** (`manage.devcenter.microsoft.com/v1.0/my/`): MSIX and APPX packages, add-ons and
  flights. P5-04 reads it today, GET-only (`connectors/msstore/client.ts`) [V].
- **MSI/EXE** (`api.store.microsoft.com/submission/v1/product/{id}/`): metadata in modules
  (`listings`, `properties`, `availability`). The package is **a URL, not an upload**: `packageUrl`,
  with an example of `https://www.contoso.com/downloads/1.1/setup.exe` [V]. A Godot Windows export
  is an EXE, so the release's own `dl.plrs.im` artifact URL can be the package, with no upload at
  all [I]. **[U]**: whether Microsoft accepts a URL that redirects to a signed R2 link.

| Area       | Operation                                                                                                                        | Mode                         | Evidence                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App        | Reserve the name; first submission with the IARC questionnaire                                                                   | `link`                       | "You cannot use the Microsoft Store submission API to create an app" and the first submission must be made in Partner Center, "including answering the age ratings questionnaire" [V] (both APIs, and the msstore CLI)                |
| App        | Detect                                                                                                                           | `api` (read)                 | `GET applications`, already A-16's lister [V]                                                                                                                                                                                         |
| App        | Delete                                                                                                                           | `never`                      | Owner-only, UI-only: "the ability to delete apps" belongs to the account owner [V]                                                                                                                                                    |
| Submission | Create (a copy of the last published one), update, commit, status                                                                | `api`; commit typed          | `POST …/submissions`, `PUT`, `POST …/commit`, `GET …/status` [V]. Status enum from `PendingCommit` to `Published`, with failure states and `certificationReports` [V]                                                                 |
| Submission | One pending at a time                                                                                                            | constraint                   | The resource has a single `pendingApplicationSubmission` [V]. The MSI/EXE `submit` "fails … if an active submission exists" [V]                                                                                                       |
| Submission | **Never edit an API-created submission in the UI**                                                                               | constraint                   | Doing so means "you will no longer be able to change or commit that submission by using the API … you must delete the submission" [V]. The flow warns, and offers only a deep link afterwards (deleting is denied)                    |
| Listing    | Per-language description, short description, features (20 × 200), release notes, keywords, copyright, title choice, developed by | `api`                        | Classic `baseListing` [V]; MSI/EXE `listings` module [V]                                                                                                                                                                              |
| Listing    | Images (screenshots per family, store logos, promotional art), trailers (≤ 15)                                                   | `api`                        | Classic: one ZIP to the submission's SAS `fileUploadUrl` [V]. MSI/EXE: `listings/assets/create` returns SAS URLs, then `commit`, which "will effectively overwrite the entire set" of that type and language [V]                      |
| Listing    | Privacy policy, website and support URLs                                                                                         | MSIX: `link`; MSI/EXE: `api` | Classic fields "obsolete … If you set this value, it will be ignored" [V]; MSI/EXE `properties` module [V]                                                                                                                            |
| Listing    | Category                                                                                                                         | `api`                        | Classic `applicationCategory` (`BooksAndReference_EReader`) [V]; MSI/EXE `properties.category` and `subcategory` [V]                                                                                                                  |
| Pricing    | Price tier, market prices, trial                                                                                                 | `api`, typed                 | Classic `pricing.priceId` [V]. Not on Pricing Version 2, which returns an unknown tier [V]. MSI/EXE sets only a model (FREE, PAID, …) [V]                                                                                             |
| Rollout    | Gradual rollout: percentage, halt, finalize                                                                                      | `api`; finalize typed        | `…/packagerollout`, `updatepackagerolloutpercentage`, `haltpackagerollout`, `finalizepackagerollout` [V]                                                                                                                              |
| Flights    | Create a flight, flight submissions                                                                                              | `api`                        | `POST applications/{id}/flights` [V]                                                                                                                                                                                                  |
| Add-ons    | Create (Durable, Consumable), submit                                                                                             | `api`                        | `POST inappproducts` "creates an add-on without any submissions" [V]. P6-01 has no Microsoft row (`dist_store_products` CHECK has `app-store`, `play`, `steam`) [V], so add-ons wait for a commerce extension                         |
| Package    | Upload an MSIX                                                                                                                   | `ci`                         | Into the classic ZIP or with `msstore publish` [V]. **Caution:** `msstore publish` "deletes the pending draft … discarding any metadata changes already staged" [V], so CI must not run it when the Worker has staged listing changes |
| Package    | MSI/EXE by URL                                                                                                                   | `api`                        | `PUT packages`, then `POST packages/commit` [V]                                                                                                                                                                                       |
| **Never**  | All 5 `DELETE`s: submission, add-on, add-on submission, flight, flight submission                                                | `never`                      | Owner rule [V][I]                                                                                                                                                                                                                     |
| **Never**  | Partner Center users, payout, tax                                                                                                | n/a (no API)                 | UI-only; Manager "can't change tax and payout settings" [V]                                                                                                                                                                           |

**Limits.**

- **Rate:** the classic API documents no limit. The MSI/EXE API documents only a `Retry-After`
  header "due to rate limiting" [V]. The budget honours `Retry-After` and otherwise
  self-throttles [I].
- **Certification:** "can take up to three business days" [V].
- **Packages:** 25 GB [V].
- **Name reservation:** held for 3 months [V].

**Credential.** The guide's Entra application with the **Manager** role. Both docs say "Make sure
you assign this application the Manager role" [V]. A Manager user can manage Partner Center users,
but only in the UI; no Store API manages users, so the application's token cannot [V]. The two APIs
need different tokens from the same application:

- classic: `resource=https://manage.devcenter.microsoft.com`, which P5-04 has;
- MSI/EXE: `scope=https://api.store.microsoft.com/.default` plus `X-Seller-Account-Id`.

The seller id is already in the guide's hand-over [V].

### 4.3 Steam (Worker plane for reads and branch moves; CI for depots; the rest is UI)

| Area       | Operation                                                               | Mode                     | Evidence                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App        | Pay the fee and create the app                                          | `link`                   | "$100.00 fee for each product"; a 30-day wait between paying and release [V]. Only Admins can buy app credits [V]                                                                       |
| App        | Detect                                                                  | `api` (read)             | `ISteamApps/GetPartnerAppListForWebAPIKey`, already A-16's lister (`commerce/steam.ts`) [V]                                                                                             |
| Store page | Text, capsules, screenshots, trailers, tags, pricing, DLC, achievements | `link`                   | Of 33 interfaces, none edits a store page; `IStoreService` has only `GetAppList` [V]                                                                                                    |
| Store page | Review                                                                  | `link` + operator tick   | "typically takes 3-5 business days"; submit "at least 7 business days" ahead [V]. A Coming Soon page must be up "for at least two weeks" [V]                                            |
| Builds     | Upload depots                                                           | `ci`                     | P5-08 generates `app_build_<app>.vdf` and depot VDFs (`packages/cli/src/transportSteam.ts`) [V]                                                                                         |
| Builds     | List builds and branches                                                | `api` (read)             | `ISteamApps/GetAppBuilds`, `GetAppBetas` (publisher key) [V]                                                                                                                            |
| Builds     | Set a build live on a named branch                                      | `api` or `ci`            | Web API `SetAppBuildLive` "Makes a build live on a specified branch" [V]; steamcmd `setlive` [V]                                                                                        |
| Builds     | Set a build live on the default (public) branch                         | **decision 5**           | steamcmd: "the 'default' branch can not be set live automatically" [V]. The Web API takes `betakey=public` with a required `steamid` [V]. Whether the group-scoped key may do it is [U] |
| Review     | Build review                                                            | `link`                   | Same timing as the store page; once approved, "there is no need to go through review again" [V]                                                                                         |
| **Never**  | Users and permissions, app credits, pricing, branch or depot deletion   | `never` (UI only anyway) | [V][S]                                                                                                                                                                                  |

**Limits.**

- **Calls:** 100,000 Web API calls per day per key [V].
- **Failures:** "Requests generating 403 status codes … will incur strict rate limits for the
  connecting IP" [V]. That IP is the Worker's shared egress, so the budget must stop on the first
  403 [I].

**Credentials** [V]:

- the publisher Web API key, created on a Steamworks group that holds only the chosen apps (the
  owner's guide does this). It must be used from a server, on `partner.steam-api.com`;
- a separate build account with only "Edit App Metadata" and "Publish App Changes To Steam",
  Steam Guard on, and `config.vdf` cached in CI.

**What Polaris Key can still do for Steam's store page.** Generate the complete asset set at
Steam's exact sizes from the listing model (§7.4) as a downloadable pack. Pre-fill a copy card of
the text fields. Keep a per-app checklist with operator ticks: fee paid, Coming Soon live, store
review passed, build review passed. Poll `GetAppBuilds` and `GetAppBetas` to confirm that the
branch the operator set is live [I].

### 4.4 Outlets without keys in Polaris Key

| Outlet                                      | Bootstrap (human)                                                                        | Build or metadata path                                                                                                                                                                                                                           | Review                                                                                           | Minimal credential                                                                                                                                                  | Verifier the flow can poll                                                                         | Never                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **itch.io**                                 | Create the game page [V]                                                                 | `ci`: `butler push <dir> user/game:<channel>`. Channels named `windows`, `linux`, `mac`, `android` tag platforms; a new channel adds a file to the page [V]. Page text and art: `link`                                                           | None for uploads [S]                                                                             | `BUTLER_API_KEY`, **unscoped** [V]. CI only                                                                                                                         | Server-side `/wharf/latest` for a channel's version [V] (needs the same unscoped key, so CI-side)  | Collections delete; any page edit by automation |
| **Epic Games Store**                        | Onboarding: $100 per product, publisher 18 or older [S]                                  | `ci`: BuildPatchTool `-mode=UploadBinary` with its own client id and secret [S]. Labelling to Live is "not currently supported" through BPT for self-service publishers; use the Developer Portal [S]. Store page: `link` [S]                    | Portal [S]                                                                                       | BPT client secret through `-ClientSecretEnvVar` [S]                                                                                                                 | None found [S]                                                                                     | `DeleteBinary`, `UnlabelBinary` [S]             |
| **Flathub**                                 | First submission: a PR to `flathub/flathub` against `new-pr`, reviewed by volunteers [V] | `pr` to `flathub/<app-id>`: "Updates never need submission review" [V]. Flathub's external-data checker opens update PRs from `x-checker-data` [V], which Polaris Key already serves (`/flathub/<ch>.json`, `feeds/render.ts`) [V]               | First PR only. `automerge-flathubbot-prs` needs an exception [V]                                 | A GitHub account with 2FA, invited to the app repo [V]                                                                                                              | Public GitHub API: the repo and merged PRs [I]                                                     | Closing the app                                 |
| **Snap Store**                              | `snapcraft register <name>` [V]                                                          | `ci`: `snapcraft upload --release=<channels>` [V]. `snapcraft upload-metadata` updates "summary, description, icon" [V]. Title, screenshots and banner: dashboard (`link`) [V][S]                                                                | Automatic, except classic confinement, which needs one forum request and a human review [S]      | `snapcraft export-login --snaps --channels --acls package_push,package_release --expires` [V]. Not `package_manage` (collaborators) or `package_upload` (wider) [V] | `snapcraft status` in CI [S]                                                                       | `close`; collaborator ACLs                      |
| **winget**                                  | None; the first PR is moderated like every other [V]                                     | `pr` to `microsoft/winget-pkgs`, schema **1.12.0** [V], via `wingetcreate update --submit` or Komac [V]. The installer URL must be HTTPS, direct, from "the ISV's release location" [V]                                                          | Every PR: automated validation, then "manually reviewed by a moderator" [V]                      | A GitHub token with `public_repo` [V]. Whether a fine-grained token can open a PR on `microsoft/winget-pkgs` is [U]                                                 | Public GitHub API: PR state and labels such as `Validation-Domain` and `Needs-Author-Feedback` [V] | —                                               |
| **Homebrew** (own tap)                      | Create a `homebrew-<name>` repo [V]                                                      | `pr` or direct commit of a cask (`version`, `sha256`, `url`, `name`, `desc`, `homepage`, `app`, `livecheck`, `auto_updates`) [V]. No generator exists yet; `direct.homebrewCask` is only an identity field (`page/model.ts`) [V]                 | None in an own tap [V]. `homebrew/cask` itself has notability rules and needs notarized apps [V] | A fine-grained token with `contents:write` on the tap repo only [I]                                                                                                 | The raw cask file [I]                                                                              | Pushing to `homebrew/cask` without the owner    |
| **Scoop** (own bucket)                      | Create the bucket repo [S]                                                               | Polaris Key already serves `/scoop/<ch>.json` [V]. A `pr` or commit of the manifest with `checkver` and `autoupdate` [V]                                                                                                                         | None [S]                                                                                         | As Homebrew [I]                                                                                                                                                     | The raw manifest [I]                                                                               | —                                               |
| **AltStore / AltStore PAL**                 | PAL: register as a developer, plus Apple notarization [S]                                | Polaris Key serves the source JSON (`/altstore[-pal]/<ch>/source.json`) [V]. The listing fields (`name`, `subtitle`, `localizedDescription`, `iconURL`, `tintColor`, `screenshots`) come from the model [V]                                      | Apple notarization for PAL [S]                                                                   | None                                                                                                                                                                | Our own feed                                                                                       | —                                               |
| **F-Droid repo / Obtainium**                | None                                                                                     | Polaris Key relays the CI-signed repo and serves Obtainium JSON [V]. The fastlane layout (`title.txt` 50, `short_description.txt` 80, `full_description.txt` 4000, `changelogs/<versionCode>.txt` 500, `images/…`) maps one-to-one onto Play [V] | None. The main F-Droid repo is FLOSS-only, so closed Godot games are ineligible [V]              | None                                                                                                                                                                | Our own feed                                                                                       | —                                               |
| **Windows App Installer** (sideloaded MSIX) | Windows signing (guide §5)                                                               | Polaris Key serves `app.appinstaller` (`services/update/updaterFeeds.ts`) [V]                                                                                                                                                                    | None                                                                                             | The signing identity in CI                                                                                                                                          | Our own feed                                                                                       | —                                               |

**Epic is not an outlet kind.** `OUTLET_KINDS` has 17 values and Epic, Homebrew and Scoop are not
among them (`packages/shared-protocol/src/distribution.ts:9-27`) [V]. A new outlet kind is a
shared-protocol change, which means plan mode, the corpus and every SDK (`CLAUDE.md`). So **"adding
a storefront" must not require a new outlet kind** wherever an existing one fits. Adapter ids are
Worker-internal and map to one or more outlet kinds (§6.1). Epic as a kind waits for a product that
ships there (decision 8) [I].

## 5. Facts that shape the design

### 5.1 Every store's bootstrap is human, so the bootstrap is a first-class step

| Store           | Human bootstrap                                                      | Verifier read (budgeted)                                                                              |
| --------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App Store       | Create the app record (S-14 §5.1)                                    | `GET /v1/apps?filter[bundleId]=` [V]                                                                  |
| Google Play     | Create the app; first AAB; content rating; target audience; category | Reporting `apps:search` lists the package [V]; a read-only edit opens (proves "at least one APK") [I] |
| Microsoft Store | Reserve the name; first submission with IARC                         | `GET applications` lists it; `lastPublishedApplicationSubmission` is set [V]                          |
| Steam           | Fee; create the app; Coming Soon page; reviews                       | `GetPartnerAppListForWebAPIKey` lists the app id [V]; reviews are operator ticks                      |
| itch.io         | Create the page                                                      | CI's first `butler push` succeeds [I]                                                                 |
| Flathub         | First PR accepted                                                    | `github.com/flathub/<id>` exists [I]                                                                  |
| Snap            | `snapcraft register`                                                 | CI `snapcraft status` [S]                                                                             |
| winget          | None                                                                 | n/a                                                                                                   |

Where nothing can be read, the step is an **operator assertion**: a tick stored per product, shown
as unverified, as in S-14 §8.1 step 10.

### 5.2 Ratings: answer once, submit per store

- **IARC is shared by Play and Microsoft**, among others: Epic, Nintendo, PlayStation, Meta. "In
  most cases the IARC certification code … can be used when submitting it to a new storefront" [V].
  Microsoft lets you "provide us with your rating ID" [V]. Whether Play's form imports an existing
  certificate is [U].
- **Apple and Steam run their own questionnaires.** Apple's `ageRatingDeclarations` has 11 booleans
  and 13 frequency answers [V]. Steam has a Content Survey with general, mature and generative-AI
  sections [V].
- **All of these submissions are UI-only, except Apple's**, which the API can write [V].

The model therefore stores **canonical content descriptors** (violence, sexual content, gambling,
user-generated content, chat, ads, loot boxes and so on, each with a frequency) plus the
**IARC certificate id** once issued. The flow pre-fills Apple's declaration from the descriptors
(behind a gate decision, §10), and shows the answers to copy into the Play, Microsoft and Steam
questionnaires [I].

### 5.3 Play's edit is a shared, invalidating lock

- The only Play write path is an edit [V]. A service account may hold one open edit [V].
- P5-03 opens an edit on every poll tick and every control, then deletes or commits it
  (`connectors/play/{poll,controls}.ts`) [V].
- A-16's `?tracks=1` listing does the same for up to 10 apps (`connectors/play/platform.ts:61`) [V].
- A provisioning run that uploads 20 images inside one edit would be invalidated by the next poll
  tick [I].

**Required:** a per-package **edit lease**: a Durable Object, or a KV lock with a TTL. Every Play
caller acquires it. Polls skip a tick while provisioning holds it. A long upload renews it. The
Play adapter's conformance test simulates a poll racing a provisioning edit [I].

### 5.4 Uploading listing assets is not uploading builds

The program README's decision 7, "Read-only state first, controls second, uploads never", and the
rule that "vendor CLIs do the store uploads, not the Worker" [V] were written about binaries.
Listing images are small:

- Play caps them at 15 MiB [M];
- Microsoft at 50 MB per screenshot [V];
- Apple uses reserve, PUT and commit [V].

They live in the blob store (P2-01) once derived. Pushing them from the Worker keeps the whole
listing on one plane, under one gate and one ledger. Pushing them from CI would split one listing
across two credentials. **Recommended:** the Worker pushes listing assets from R2; binaries stay in
CI (decision 2) [I].

### 5.5 Release notes: one source, three lengths

`release_metadata.notes` is one string per release, usually GitHub markdown, with no locale
(`W/migrations/0007_backend_contracts.sql:46-60`, `descriptor.ts:739`) [V]. The stores' limits
differ by an order of magnitude [V]:

- Play and F-Droid: 500;
- Microsoft: 1,500;
- Apple: 4,000;
- winget: 10,000.

So the model holds **per-release, per-locale store notes**:

- they default to the release notes stripped of markdown (`release/changelog.ts` already does this
  [V]);
- a sentence-boundary cut fitted to 500 is proposed when the text is longer, and shown for edit,
  never sent unseen [I];
- they are stored in Distribution, not in the signed descriptor, so no manifest or wire change is
  needed [I].

### 5.6 Apple screenshots do not fit Play as they are

Computed from the [V] specifications [I]:

- **iPhone 6.9″ is too tall for Play.** 1320×2868 has a ratio of 2.17, over Play's "can't be more
  than twice" rule, so it needs a pad or crop to ≤ 2:1.
- **iPad 13″ fits.** 2064×2752 (1.33) suits Play's tablet slot, with the ≥ 1,080 px side satisfied.
- **Mac 16:10 needs a crop for Steam.** 2880×1800 meets Microsoft's ≥ 1366×768, but Steam wants
  16:9 at ≥ 1920×1080, so it needs a centre crop to 2880×1620.

"Import screenshots from the App Store" (§7.2) must therefore run every image through the target
store's fit check, and propose a crop that the operator accepts per image. A crop can cut UI, so it
is never silent.

## 6. The common layer

### 6.1 One contract for storefronts and feeds

The package feeds already have a plug-in contract:
`interface RegistryRenderer { ecosystem; render(pkg, ctx); routes }`, one directory per ecosystem,
registered in a `RENDERERS` map (`distribution/registry/{materialise,index}.ts`) [V]. F-01's console
already answers `unsupported_by_ecosystem` where a protocol lacks a state (`plans/F-01.md` §6.9) [V].
That is a capability declaration in all but name.

The proposal makes both families instances of one base, in a new Core module `core/adapters/`. It
lives in Core because both Distribution sub-areas consume it, and `boundaries.test.ts` allows
service → core [V]. This is the load-bearing part, sketched [I]:

```ts
// core/adapters/contract.ts: shared by StorefrontAdapter and FeedAdapter
export type Plane = "worker" | "ci" | "pr";

/** How an adapter performs one operation. The console renders this; it never hard-codes a store. */
export type Support =
  | { mode: "api"; plane: "worker"; rules: readonly string[] } // ids of gate allow rules
  | { mode: "ci"; plane: "ci"; tool: string; commands: readonly string[] } // CI command allow-list
  | { mode: "pr"; plane: "pr"; repo: string }
  | {
      mode: "deep-link";
      link: string; // id in the deep-link table
      verify:
        { read: string; every: number; until: number } | "operator-assertion";
    }
  | { mode: "unsupported"; reason: string }; // the F-01 `unsupported_by_ecosystem` case

export interface RateSpec {
  kind: "header" | "per-minute" | "per-day" | "retry-after" | "none";
  limit?: number; // 3600/h ASC, 3000/min Play, 100000/day Steam
  stopOn403?: boolean; // Steam: 403s rate-limit the Worker's IP
}

export interface Capabilities<Op extends string> {
  readonly ops: Readonly<Record<Op, Support>>;
  readonly rate: RateSpec;
  readonly limits: Readonly<Record<string, number>>; // max open submissions, image bytes, …
}

/** The vendor contract a gate is classified against (ASC OpenAPI, Play discovery, …). */
export interface SpecPin {
  title: string;
  version: string;
  sha256: string;
}

export interface Adapter<Id extends string, Op extends string> {
  readonly id: Id;
  readonly capabilities: Capabilities<Op>;
  readonly specPin?: SpecPin; // absent for CI- or PR-only adapters
}
```

```ts
// core/storefront/adapter.ts
export type StorefrontOp =
  | "connect"
  | "listApps"
  | "createApp"
  | "readListing"
  | "writeListingText"
  | "writeListingAssets"
  | "category"
  | "contentRating"
  | "privacyDeclarations"
  | "pricing"
  | "iap"
  | "testers"
  | "uploadBuild"
  | "notificationsUrl"
  | "submit"
  | "release"
  | "rollout"
  | "status";

export interface StorefrontAdapter extends Adapter<StorefrontId, StorefrontOp> {
  readonly outletKinds: readonly OutletKind[]; // Play → play, play-testing; never a new wire kind
  readonly credential: PlatformCredentialId | null; // A-16 slot; null for keyless outlets
  readonly gate: GateRuleSet | null; // Worker-plane rules (§6.2); null if no Worker plane
  readonly listing: ListingProfile; // per-store field limits and image slots (§7.3)
  readonly deepLinks: Readonly<Record<string, DeepLinkTemplate>>;

  connect(ctx: AdapterCtx): Promise<ConnectionHealth>; // A-16's credential check
  listApps(ctx: AdapterCtx): Promise<PlatformAppsListing>; // A-16's lister, moved behind the adapter
  readListing(ctx: PinnedCtx, locales?: string[]): Promise<ListingSnapshot>; // import (§7.2)
  plan(ctx: PinnedCtx, listing: ResolvedListing): Promise<ProvisionPlan>; // ordered steps, each with a Support
  runStep(ctx: PinnedCtx, step: PlanStep): Promise<StepOutcome>; // only through performStoreWrite (§6.3)
  status(ctx: PinnedCtx): Promise<StoreStatus>; // review, rollout, live versions
}
```

```ts
// services/distribution/registry/: the FeedAdapter is today's RegistryRenderer plus the same base
export type FeedOp =
  "render" | "serve" | "auth" | "yank" | "unyank" | "deprecate" | "setup";
export interface FeedAdapter extends Adapter<RegistryEcosystem, FeedOp> {
  render(
    pkg: RegistryPackage,
    ctx: RenderContext,
  ): readonly RenderedObject[] | Promise<readonly RenderedObject[]>;
  readonly routes: readonly RegistryRoute[];
}
```

The shared shape gives three things:

1. **The console renders capabilities the same way** for a storefront tile and a feed tile: a
   badge per operation (API, CI, PR, link, unsupported).
2. **One conformance harness** (§6.6) runs over every adapter of either family.
3. **Adding a storefront or a feed is one directory plus one registry line**, and it adds no
   console code. The only exception is a store that needs a new wire outlet kind (§4.4).

Storefront adapters live per plane. Worker-plane code sits in
`services/distribution/connectors/<store>/`, beside the existing poll and controls. CI-plane
command plans sit in `packages/cli/src/storefronts/<store>.ts`. Both import the same declaration
from a shared, dependency-free module (`packages/shared-protocol` is the wrong home because it is
wire; a new internal package or a generated JSON is the choice for A-18a) [I].

### 6.2 The store-agnostic gate

A-17a's gate is deny-by-default and consulted before the token thunk. Its rules are
`(method, path template, type, attributes, relationships, included, confirm, check, why)`, its
context is `{typedConfirmation, initial, hookOrigin}`, and a test classifies every write in a
pinned spec (`core/asc/writeGate.ts:1-33, 55-93`) [V]. A-18a splits it into three parts [I]:

| Part                                      | Store-neutral?         | Home                                                     |
| ----------------------------------------- | ---------------------- | -------------------------------------------------------- |
| Engine                                    | Yes                    | `core/storefront/gate.ts`                                |
| Body matcher                              | No: one per wire style | `core/storefront/match/{jsonapi,json,form,multipart}.ts` |
| Rule table, deny classification, spec pin | No: one per adapter    | `core/storefront/rules/<store>.ts`                       |

The engine covers:

- method and path-template match;
- the confirmation levels `plain`, `typed`, `initial` and `typed-or-initial`;
- the fixed deny reasons and the no-token-before-pass rule;
- the "no `DELETE` rule may exist" assertion;
- the hook-origin rule for callback URLs.

The body matchers:

- `jsonapi` for ASC, which is A-17a's matcher as it stands;
- `json` for Play and Microsoft: allowed top-level and nested keys;
- `form` for the Steam Web API: allowed parameters and values, such as `betakey ≠ public` unless
  typed;
- `multipart` and `blob` for uploads: content type and size cap.

Each adapter's rule table carries its own spec pin and deny classification:

- `rules/appStore.ts`: A-17a's `ASC_WRITE_ALLOW`, moved unchanged;
- `rules/googlePlay.ts`: classified against the discovery document, revision `20261001`, SHA-256
  `bcbce36e…`;
- `rules/microsoftStore.ts`: no machine-readable spec exists, so a hand-written operation list
  from the two reference pages, pinned by fetch date and checked by a docs-drift review trigger;
- `rules/steam.ts`: the `ISteamApps` methods used.

The CI plane gets the same idea as a **command allow-list** in the publish action, for example:

- steamcmd `+run_app_build` with `setlive` only on a named branch;
- butler `push` only;
- snapcraft `upload --release` only to channels in the outlet's identity;
- BuildPatchTool `UploadBinary` only;
- msstore never `publish` while a Worker-staged draft exists.

The conformance suite checks these too [I].

**The A-17a surface does not move.** Its rule table, deny list and spec pin keep their contents and
tests; only their imports change. A change to any rule table remains a THREAT-MODEL §9 review
trigger, now worded for `core/storefront/rules/*` [I].

### 6.3 Ledger, audit and budgets

- **Ledger.** `asc_operations` (`0059`, unmerged) becomes `store_operations`. It gains a `store`
  column, renames `apple_status` and `apple_code` to `vendor_status` and `vendor_code`, and adds
  `plane` (`worker`, `ci`, `pr`, `deep-link`). For a `ci` or `pr` step, the row is written by the
  publish action's report-back (P2-06's ingest) rather than by a Worker request [I].
  `op_id = sha256(store|scope|product|op|natural_key|idempotency_key)`.
  `performAscWrite(AscWriteStep{key, request, find, satisfied, write, reread, resultIds, summary})`
  (`core/asc/ledger.ts:251-300`) [V] is already the generic shape: it becomes `performStoreWrite`.
- **Natural keys per store** keep every create checkable before it is sent [V][I]:

  | Store     | Create                 | Natural key and pre-read                                                                                     |
  | --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
  | Play      | listing for a language | `edits.listings.get`                                                                                         |
  | Play      | image                  | SHA-1 of the bytes. `images.list` returns each image's `sha1` and `sha256` [S]; skip if present              |
  | Play      | closed track           | `tracks.list`, by name                                                                                       |
  | Play      | one-time product       | `onetimeproducts.get`, by product id                                                                         |
  | Microsoft | submission             | `pendingApplicationSubmission`: reuse it if it was created by us (its id is in the ledger)                   |
  | Microsoft | add-on                 | `GET inappproducts`, by `productId`                                                                          |
  | Steam     | branch live            | `GetAppBetas`: the branch already shows that build id                                                        |
  | PR plane  | manifest version       | An open or merged PR for `(package, version)`; winget allows "only one pull request per package version" [V] |

- **Audit.** A-17a's `audit.ts` projection (an allow-list of fields per resource type) becomes keyed
  by `(store, resource type)`. Before and after are each vendor's own reads. The redactions are
  unchanged, plus Play tester groups (store a count) and Microsoft certification report URLs (they
  carry tokens [I]).
- **Budget.** A-17a's meter parses ASC's `X-Rate-Limit` (`core/asc/budget.ts`) [V]. The generic
  budget takes the adapter's `RateSpec`:

  - a header (ASC);
  - a sliding per-minute counter (Play, 3,000 per bucket);
  - a per-day counter (Steam, 100,000), with a hard stop on any 403;
  - `Retry-After` (Microsoft);
  - for GitHub on the PR plane, the token's own `X-RateLimit-*` headers, held CI-side.

  The `poll`, `background` and `operator` spend classes, and their tiers, stay as A-17a defined
  them [V].

### 6.4 Typed confirmations

A-17a's rule is that a rule with `confirm: "typed"` refuses a request without
`typedConfirmation: true`, so a handler that forgets to compare cannot send [V]. The generic layer
makes the **phrase** an adapter property: the app's name as the store reports it (Apple's app name,
Play's default-language title, Microsoft's primary name, Steam's app name). Typed confirmation is
required for:

- submit for review (`reviewSubmissions` submitted, Play `edits.commit` whose tracks include
  production or a release status change, Microsoft submission `commit`);
- release (Apple release request, Play `completed` or a production `userFraction` of 1.0,
  Microsoft `finalizepackagerollout`, Steam `SetAppBuildLive` on the public branch);
- any price change (Apple price schedules after the initial one, Play one-time product prices,
  Microsoft `pricing`).

The initial set of a price on a new product stays `initial`, as A-17a defines it [V].

### 6.5 Deep links and polling

- **One table.** `core/storefront/deeplinks.ts` holds `{id, store, template, params, verify}`, for
  example `play.app-content`, `play.monetization-setup`, `msstore.properties`,
  `steam.store-page`, `steam.app-admin`. Only Play documents one deep-link form:
  `https://play.google.com/console/developers/app/protect-with-play` [V]. Every other shape is [I],
  so a broken link is a one-line fix with a test that renders every template.
- **Polling runs while the page is open,** as in S-14 §5.1: every 10 s, for up to 15 minutes, plus
  a "Check now" button. A step that is still pending survives a closed tab as a `pending` ledger
  row; the store's own poller (P5-02, P5-03 or P5-04) or the next visit re-checks it [I].

### 6.6 The adapter conformance suite

`test/storefront/conformance.test.ts` runs once per registered adapter, against the adapter's fake
vendor (P5-02, P5-03 and P5-04 already build on fakes [V]). It asserts [I]:

1. **Classification.** Every write in the pinned spec is either allowed by a rule or denied with a
   reason. This generalises A-17a's `ascWriteGate.test.ts`. For Play it walks the discovery
   document; for Microsoft and Steam, the hand-written operation list.
2. **The never-list is unreachable.** No rule allows a `DELETE`, a user or permission path, a
   signing-key path or a refund. Each adapter's `never` list is asserted against its gate, and
   against its CI command allow-list.
3. **Declarations agree with the gate.** Every op declared `api` has at least one allow rule. Every
   allow rule is referenced by an op. Every `deep-link` op has a deep-link entry and either a
   verifier read the gate allows or `operator-assertion`.
4. **Idempotency.** Running every plan step twice yields one vendor write. A timeout after a send
   leaves an `ambiguous` row, and the retry re-reads the natural key before sending.
5. **No token before a pass.** A refused request mints no token: the fake token endpoint counts
   zero.
6. **Typed confirmation.** Submit, release and price steps refuse without it.
7. **Listing projection.** Every field the adapter's `ListingProfile` declares is checked against
   the store's limits. An over-limit value yields a validation issue, never a silent truncation.
8. **Budget.** A depleted budget stops background spend and keeps operator spend, per A-17a's
   tiers.
9. **Redaction.** Audit rows never contain a secret, a tester address or a vendor error body.
10. **Play only: the edit lease.** A poll tick during a provisioning edit neither invalidates it
    nor runs.

A `FeedAdapter` runs items 3 and 7 (capabilities versus routes; render limits). The other items do
not apply because feeds make no vendor writes.

## 7. The shared listing model

### 7.1 Shape

All of it lives in Distribution tables, operator-owned, audited, with `source = 'admin' | 'import'`.
It is **not** a new manifest. `.pkey/distribution` `listing` stays as one import source [I].

- **`dist_listings`** (one per product):
  - `defaultLocale`, `name` (≤ 30), `developerName`;
  - `category` (a canonical id mapped per store);
  - `contentDescriptors` (JSON, §5.2) and `iarcCertificateId`;
  - `urls` (`website`, `support`, `privacy`, `marketing`, `eula`), `contactEmail`, `copyright`;
  - `tint` and `tintDark` (Flathub needs both; AltStore uses `tint`).
- **`dist_listing_locales`** (`product`, `locale`):
  - `name?`;
  - `subtitle` (≤ 30);
  - `shortDescription` (≤ 78, the Snap limit, which fits Play's 80);
  - `description` (≤ 4,000, the Apple and Play limit);
  - `keywords[]`, `features[]` (Microsoft, ≤ 20 × 200), `promotionalText` (Apple, ≤ 170).
- **`dist_listing_assets`** (`product`, `slot`, `locale?`, `blob`, `sha256`, `width`, `height`,
  `alpha`, `derivedFrom?`, `textAllowed`):
  - the slots are `icon-master`, `icon-adaptive-{fg,bg,mono}`, `wordmark`, `key-art`,
    `key-art-portrait`, `screenshot:<class>` (`phone-portrait`, `tablet`, `desktop-16x9`,
    `desktop-16x10`, `tv`, `wear`, `xr`), `trailer-master` and `youtube-url`;
  - plus every derived per-store slot (§7.4).
- **`dist_listing_release_notes`** (`product`, `release`, `locale`, `text`, `short`): `short` is
  ≤ 500, for Play and F-Droid (§5.5).
- **`dist_listing_overrides`** (`product`, `store`, `locale?`, `field`, `value`): a per-store
  replacement for any field. An example is a Steam short description longer than 78.

### 7.2 Where each field already exists

| Field                | Existing sources, in default precedence                                                                                                                                                                                            | Automatic?                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Name                 | ASC `appInfoLocalizations.name` (A-17 read) [V]; Play `listings.title` (read-only edit) [V]; Godot `application/config/name` and `name_localized` [V]; `.pkey/distribution` `listing.name` [V]; `.pkey/product` `product.name` [V] | Yes                                       |
| Subtitle             | ASC `subtitle` [V]; `listing.subtitle` [V]                                                                                                                                                                                         | Yes if present                            |
| Short description    | Play `shortDescription` [V]; Microsoft `shortDescription` (last published submission) [V]                                                                                                                                          | Yes if present                            |
| Description          | ASC `description` [V]; Play `fullDescription` [V]; Microsoft `description` [V]; `listing.description` (≤ 4,000) [V]. Godot `application/config/description` is only a Project Manager tooltip [V]: never used                      | Yes if present                            |
| Keywords             | ASC `keywords` (100 bytes) [V]; Microsoft `keywords` [V]                                                                                                                                                                           | Yes if present                            |
| URLs, contact        | ASC `supportUrl`, `marketingUrl`, `privacyPolicyUrl` [V]; Play `details.contactWebsite` and `contactEmail` [V]; `listing.website` [V]                                                                                              | Yes if present                            |
| Category             | ASC `appInfos` primary category [V]; Microsoft `applicationCategory` [V]; Godot Android `package/app_category` and macOS `application/app_category` [V]; `listing.category` [V]                                                    | Mapped; operator confirms                 |
| Developer name       | `listing.developerName` [V]; Godot Windows `application/company_name` [V]                                                                                                                                                          | Yes                                       |
| Copyright            | Godot macOS and Windows `application/copyright` [V]                                                                                                                                                                                | Yes                                       |
| Content descriptors  | ASC `ageRatingDeclarations` (read) [V]                                                                                                                                                                                             | Yes from Apple; otherwise a one-time form |
| Release notes        | `release_metadata.notes` [V]; ASC `whatsNew`; Play `releaseNotes`                                                                                                                                                                  | Yes (§5.5)                                |
| Version, bundle id   | Release descriptor `builds[].metadata` from the IPA or APK [V]; Godot presets `application/bundle_identifier` and `package/unique_name` [V]                                                                                        | Yes, already used                         |
| Icon master          | Godot `icons/app_store_1024x1024`, falling back to `application/config/icon` [V]; `listing.iconUrl` [V]; for Polaris Key's own apps, the brand kit's `05-app-icons` 1024 [V]                                                       | Yes                                       |
| Adaptive icon layers | Godot Android `launcher_icons/adaptive_{foreground,background,monochrome}_432x432` [V]                                                                                                                                             | Yes if set                                |
| Key art, wordmark    | `listing.headerUrl` [V]; for Polaris Key's own apps, the brand kit's lockups and `07-social` [V]                                                                                                                                   | Rarely: usually human                     |
| Screenshots          | ASC screenshot sets (read) [V]; Play `images.list` (read) [V]; `listing.screenshots` (≤ 16) [V]                                                                                                                                    | Import, then a fit check (§5.6)           |
| Brand colours        | `listing.tintColor` [V]                                                                                                                                                                                                            | Light only; dark is derived and confirmed |
| Trailer              | None                                                                                                                                                                                                                               | Human                                     |

Five things follow from the inventory [V][I]:

- **The brand kit is Polaris Key's own brand** (`packages/brand/package.json`), not a per-product
  kit. Two parts are reusable:
  - its **generator code**: `sharp`-based, it already emits an Apple app-icon set, Android mipmaps
    with adaptive XML, `.ico` and `.icns` from one master (`kit/05-app-icons`);
  - its **assets**, for Polaris Key's own products only.
- **The Godot export plugin already reads presets**, but only for build stamping
  (`export_plugin.gd`, `build_stamp.gd`) [V]. The CLI, not the plugin, reads the project for
  listing import, so that no editor is needed in CI.
- **Imports from the stores reuse existing credentials:**
  - ASC through A-17's client and A-17a's gate, whose reads are free except personal data [V];
  - Play through a read-only edit under the lease (§5.3);
  - Microsoft through P5-04's GET-only client. Note that P5-04 deliberately does not read
    listings today (`connectors/msstore/map.ts:355`) [V]. Reading them is a small extension.
- **Precedence is "the store that is live wins".** If an App Store listing exists, its text is the
  default for every other store, because it has already passed a review. The operator can change
  the precedence per field [I].
- **AltStore and Obtainium feeds read the model** instead of `.pkey/distribution` `listing` once
  A-18b lands. The manifest's `listing` becomes an import source and an override, so a product
  that only ships to those feeds keeps working unchanged [I].

### 7.3 Per-store projection and limits

The text limits [V] (Microsoft keywords are 7 × 40 with at most 21 words in the Partner Center
docs, and 7 × 30 in the MSI/EXE API reference: validate to 30):

| Model field      | Apple                                  | Play                   | Microsoft                     | Steam                              | Flathub                   | Snap        | winget                          | F-Droid |
| ---------------- | -------------------------------------- | ---------------------- | ----------------------------- | ---------------------------------- | ------------------------- | ----------- | ------------------------------- | ------- |
| name             | 30                                     | 30                     | a reserved name, chosen       | UI                                 | < 20, ideally ≤ 15 (warn) | title 40    | PackageName 256                 | 50      |
| subtitle         | 30                                     | —                      | —                             | —                                  | summary ≤ 35              | —           | —                               | —       |
| shortDescription | —                                      | 80                     | 1,000 (270 shown)             | "a few hundred", plain (copy card) | —                         | summary 78  | ShortDescription 256            | 80      |
| description      | 4,000, plain                           | 4,000                  | 10,000, plain                 | UI (copy card)                     | MetaInfo markup           | description | 10,000                          | 4,000   |
| keywords         | 100 bytes, comma-joined                | —                      | 7 × 30, ≤ 21 words            | UI tags                            | `<keywords>`              | —           | Tags ≤ 16 × 40                  | —       |
| features         | —                                      | —                      | 20 × 200                      | —                                  | —                         | —           | —                               | —       |
| promotionalText  | 170                                    | —                      | —                             | —                                  | —                         | —           | —                               | —       |
| release notes    | 4,000 (`whatsNew`)                     | 500                    | 1,500                         | —                                  | `<releases>`              | —           | 10,000                          | 500     |
| URLs             | support (required), marketing, privacy | contact website, email | MSIX: UI; MSI/EXE: properties | UI                                 | `<url>`                   | —           | PublisherSupportUrl, PrivacyUrl | —       |

Each adapter's `ListingProfile` encodes its column. The projection returns a payload, or issues of
the form `{field, locale, limit, actual}`. Keyword packing is per store: Apple joins with commas
under 100 bytes; Microsoft picks at most 7 terms within 21 words; winget takes at most 16 tags. The
console shows a **fit report**: one row per store, one cell per field, green, amber (warn, as with
Flathub's name) or red (blocks that store) [I].

### 7.4 Assets: derive, compose or require

| Asset                                           | Store specification [V]                                                                                                                                                                                    | Method                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Play icon                                       | 512×512, 32-bit PNG with alpha, ≤ 1 MB, full square (Play applies a 30 % radius and shadow)                                                                                                                | **Derive** from the master                                                                                   |
| Microsoft app tile                              | 300×300 PNG (optional; the package icon otherwise)                                                                                                                                                         | **Derive**                                                                                                   |
| Steam community and shortcut icons              | 184×184 JPG; 256×256 `.ico` or `.png`                                                                                                                                                                      | **Derive**                                                                                                   |
| Flathub, Snap, winget, F-Droid icons            | ≥ 256 PNG or SVG; ≤ 512 at 1:1; 16–256 PNG or ICO; 512 PNG                                                                                                                                                 | **Derive**                                                                                                   |
| Apple icon                                      | In the build (Icon Composer or asset catalog); "upload the build". No listing upload                                                                                                                       | **Not a listing asset.** The Godot preset already carries it                                                 |
| Android adaptive icon                           | 3 layers at 432×432, 66 dp safe zone                                                                                                                                                                       | **Derive only if** the master's mark sits inside the central ~61 %; otherwise human                          |
| Play feature graphic, F-Droid `featureGraphic`  | 1024×500, JPEG or 24-bit PNG, no alpha                                                                                                                                                                     | **Compose**: key art plus wordmark                                                                           |
| Steam header, main, vertical and small capsules | 920×430, 1232×706, 748×896, 462×174. Only "game artwork, the game name, and any official subtitle"; no review scores, awards or discount text                                                              | **Compose**: key art plus wordmark (small: "logo should nearly fill")                                        |
| Steam library capsule, header, hero, logo       | 600×900; 920×430; 3840×1240 with "no text", safe area 860×380; logo 1280 wide or 720 tall, transparent                                                                                                     | **Compose**; the hero is **key art only**; the logo is the wordmark export                                   |
| Steam page background                           | 1438×810, optional                                                                                                                                                                                         | **Compose**: blurred key art (or omit: Steam generates one)                                                  |
| Microsoft super hero                            | 1920×1080 or 3840×2160; "must not include the product's title or other text"                                                                                                                               | **Compose**: key art only                                                                                    |
| Microsoft poster (2:3) and box art (1:1), games | 720×1080 or 1440×2160; 1080×1080 or 2160×2160; title required in the top two thirds                                                                                                                        | **Compose**: key art plus wordmark                                                                           |
| itch.io cover                                   | 315:250, ≥ 315×250, 630×500 recommended                                                                                                                                                                    | **Compose**                                                                                                  |
| Snap banner                                     | 3:1, ≥ 720×240, 1920×640 recommended                                                                                                                                                                       | **Compose** (dashboard upload: `link`)                                                                       |
| Flathub banner                                  | Generated by Flathub from the two brand colours and the icon                                                                                                                                               | **Nothing to make**: ship `tint` and `tintDark`                                                              |
| Screenshots, every store                        | Apple 6.9″ and 13″ iPad and Mac 16:10, no alpha; Play ≥ 2 (≥ 4 at ≥ 1,080 px to be featured), ≤ 2:1; Microsoft ≥ 1366×768; Steam ≥ 5 at ≥ 1920×1080, gameplay only; Flathub window-only ≤ 1000×700 logical | **Human.** Then fit and crop per store, accepted per image (§5.6)                                            |
| Trailers                                        | Apple previews 15–30 s at device sizes, ≤ 500 MB; Play a YouTube URL; Microsoft 1920×1080 MP4 or MOV with a thumbnail; Steam ≤ 1080p                                                                       | **Human**: one 1080p master feeds Microsoft and Steam and goes to YouTube for Play; Apple needs its own cuts |

Composition follows from these specifications [I]:

- **A composite needs layers.** One pre-composited image cannot serve both a "no text" slot (Steam
  hero, Microsoft super hero) and a "title required" slot (capsules, poster). The model therefore
  stores **key art without the logo** and the **wordmark** separately, and every slot carries
  `textAllowed: none | title | free`.
- **Templates are deterministic layouts:** crop to the slot's ratio around a focal point the
  operator sets once, then place the wordmark by rule. Each output is previewed and accepted. It is
  never pushed unseen.
- **The derivation runs in the CLI** (`pkey listing assets`, Node with `sharp`, reusing the brand
  kit's generator), not in the Worker, which has no image library. The outputs are uploaded to the
  blob store with their SHA-256. Running it in the browser was rejected: results must be
  reproducible in CI.
- **Play's `aiGeneratedState` parameter** is set to `NotAiGenerated` for template outputs [V].

**Unavoidably human:**

- screenshots per size class;
- key art and wordmark (a product without them gets icon-only fallbacks, and the fit report marks
  the Steam, Microsoft and feature-graphic slots red);
- trailers;
- the rating questionnaires on Play, Microsoft and Steam (UI-only);
- Apple App Privacy and Play data safety answers, which are legal declarations.

### 7.5 How Apple consumes the model

| Consumer | Today (S-14, A-17a)                                                                                                                                                                                                  | With the model                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-17d    | `whatsNew` per locale "from the release record's notes when present" (S-14 §8.2 step 3); the gate allows `appStoreVersionLocalizations` `locale`, `whatsNew` and `promotionalText` only (`writeGate.ts:449-465`) [V] | Reads `dist_listing_release_notes` (§5.5) and `promotionalText` from the model. No gate change. The preflight adds the model's Apple fit report                                                                                                                                                                       |
| A-17d+   | Description, keywords, URLs, name, subtitle and screenshots are denied (`writeGateDenied.ts`: `listingOutsideSurface`, `uploads`) [V]                                                                                | **Decision 1:** widen to `appStoreVersionLocalizations` `description`, `keywords`, `marketingUrl`, `supportUrl`; `appInfoLocalizations` `name`, `subtitle`, `privacyPolicyUrl`; `appScreenshotSets` and `appScreenshots` (reserve, PUT, commit). A new WP (A-18m), a rule-table change, a THREAT-MODEL review trigger |
| A-17e    | IAP localizations typed per mapping                                                                                                                                                                                  | The display name and description default from the model's locales                                                                                                                                                                                                                                                     |
| A-17f    | New app wizard: name, primary language, SKU and bundle id typed into a copy card                                                                                                                                     | The copy card is filled from the model. The wizard becomes the Apple adapter's `plan()` inside the generic flow (§8)                                                                                                                                                                                                  |
| A-17g    | Distribute's release-notes step                                                                                                                                                                                      | The same per-locale notes as every store, edited once                                                                                                                                                                                                                                                                 |
| Import   | —                                                                                                                                                                                                                    | `readListing` for Apple: `appInfoLocalizations`, `appStoreVersionLocalizations`, `ageRatingDeclarations`, screenshot sets. All are reads, which A-17a's gate allows                                                                                                                                                   |

## 8. The provisioning UX

### 8.1 Product → Distribution → Storefronts → **Add to storefronts** (T6, platform admin)

The flow is one T6 wizard for every store (ADMIN.md T6: stepper, `?step=`, review step, unsaved
guard [V]). Its progress is the ledger, so it resumes anywhere. It degrades to read-only, with an
explanation, when a store has no connection.

1. **Choose storefronts.**
   - One tile per adapter, showing A-16's connection state and a capability strip rendered from the
     adapter's declaration (API, CI, PR, links). For example, Steam reads "store page: links only".
   - Tiles for stores already live for this product show their status instead.
2. **Prerequisites,** per store, as a checklist computed by the adapters:
   - the connection is healthy (A-16 `connect`);
   - the permissions are sufficient, from a read-only probe. For Play, opening and deleting an edit
     under the lease proves app access, but nothing proves "Manage store presence" short of a
     write, so the step shows it as [U] until the first write;
   - the app is pinned (A-16), or a bootstrap step is queued;
   - account-level facts, as operator ticks: Steam fee paid and 30 days elapsed; Play's 12-tester
     rule for new personal accounts; Microsoft's name reserved; the Snap name registered.
3. **Listing.**
   - The shared model with its **fit report** (§7.3).
   - **Import** buttons: "From App Store", "From Google Play", "From Microsoft Store", "From the
     Godot project" (the CLI uploads what it read), and "From `.pkey/distribution`". Each shows a
     field-by-field diff before applying.
   - Per-store overrides inline.
4. **Assets.**
   - The slot board: derived (green), composed (preview, accept), and human-required (red, with
     the exact sizes per store).
   - Screenshot import with the per-image crop proposals from §5.6.
5. **Plan.**
   - Per store, the ordered steps, each with its mode badge. For Play: create the app (link) →
     detect (poll) → content rating, target audience and category (links) → listing text (API) →
     images (API) → closed track and testers (API) → release notes (API) → submit (API, typed).
   - The review step lists every external write, as T6 requires.
6. **Run.**
   - API steps run through `performStoreWrite`.
   - Link steps show a copy card with the values from the model, the link, and a live verifier.
   - CI steps show "waiting for the next publish run", with the publish action's command line.
   - PR steps show the PR, once CI opens it, and its review labels.
   - Every step's result is the vendor's re-read, never the request's intent (S-14 §8.1).
7. **Submit and release.** Per store, typed confirmation (§6.4). Afterwards, the state follows the
   existing pollers (P5-02, P5-03, P5-04) and the Steam build read.

The Store connections page (A-16) keeps its per-store app list. Its **Set up** action on an
assigned app opens this flow, pre-scoped to that store.

### 8.2 The listing editor (T3, product)

The listing editor lives at Product → Distribution → **Listing** and edits the model outside the
flow. It shows a locale switcher, the fit report, the slot board, per-release notes, and a "Push
listing" action per store. A push is a plan of `writeListingText` and `writeListingAssets` steps
only: plain confirm, no review submission. Play commits with `changesNotSentForReview` when the
operator picks "stage only" [V]; Microsoft keeps the pending submission uncommitted [I].

### 8.3 What the operator still does by hand

Per store, once:

- **App Store:** create the app record; App Privacy (S-14).
- **Play:** create the app; the first AAB; content rating; target audience; ads, app access and
  privacy policy declarations; category; data safety (decision 4); the RTDN topic; the Play
  Integrity link.
- **Microsoft:** reserve the name; the first submission and IARC; for MSIX, the Properties URLs.
- **Steam:** the fee; the whole store page from the generated pack and copy card; reviews; the
  default-branch release (decision 5).
- **itch.io:** create the page; page art from the generated pack.
- **Snap:** register the name; the title, screenshots and banner.
- **Flathub:** the first PR.

Everything else is filled from the model and pushed, or generated, by Polaris Key.

### 8.4 Replacing assets without deleting

The owner's rule forbids every `DELETE`, but Play replaces an image set only by deleting the old
ids, and Microsoft's MSI/EXE `commit` overwrites a whole type [V]. The options, per store [I]:

- **Microsoft:** a commit that replaces the set is an update, not a deletion of a resource, so it
  is allowed, with a plain confirm.
- **Play:** `edits.images.delete` of a single image **that this ledger uploaded and has replaced
  in the same edit** is the one candidate exception. It is reversible until commit, because the
  edit is discarded on abort. Recommended: **keep it denied** in v1. The flow uploads new images,
  then shows a deep link to remove the old ones. Decision 6 asks whether to allow that exact case.

## 9. Security and threat-model additions

These are proposed for `docs/security/THREAT-MODEL.md`, landing in A-18a. The text is not edited
here.

1. **§2 assets:** the A-16 team credentials besides ASC. Each is worth less than A11b (ASC Admin)
   if its vendor permissions follow §4, and the gate is the backstop where they do not:
   - **Play service account:** with "Manage store presence" it can change prices and products and
     replace listings for every app it is granted [V]. Rate it at A11. The gate limits prices to
     typed confirmation, denies `users` and `grants`, and the Console grant must never be Admin.
   - **Microsoft Entra application (Manager):** it can rewrite listings, price tiers and rollouts
     for every product in the seller account [V]. Rate it at A11.
   - **Steam publisher key (group-scoped):** read-only plus `SetAppBuildLive`, plus ownership
     checks [V]. Rate it below A11.
2. **New CI secrets:**

   - the butler key, unscoped [V]. A leak can push builds to every game of the account;
   - the Snap export-login, scoped and expiring [V];
   - the BuildPatchTool client secret [S];
   - GitHub tokens for the PR plane;
   - the Steam build account's `config.vdf` (already in the guide).

   Each lives in its own GitHub environment, with required reviewers for production channels [I].

3. **Controls:**
   - (a) one deny-by-default gate engine, with a per-adapter rule table classified against a pinned
     vendor spec in CI;
   - (b) a CI command allow-list in the publish action;
   - (c) the conformance suite as a required check;
   - (d) typed confirmation for submit, release and price changes on every store;
   - (e) the Play edit lease;
   - (f) every callback URL fixed server-side to the Worker's origin (A-17a's `hookOrigin` rule,
     generalised);
   - (g) imported listing text treated as data: rendered escaped in the console, never as HTML.
4. **§9 review triggers:** a change to any `core/storefront/rules/*` table; a new adapter; a new
   vendor spec pin; a change to the CI command allow-list.

## 10. Recommendation

1. **Build the substrate before any new adapter** (A-18a). Rename A-17a's ledger now, while it is
   unmerged (decision 3). Do not fork A-17a's gate per store.
2. **Land the listing model (A-18b) and its sources (A-18c, A-18d) next.** They pay off even before
   any new store, because A-17d's release notes and A-17f's copy card read them.
3. **Write the Play adapter first** among the new stores (A-18e). It has the richest API, the
   owner's guide already provisions its credential, and its edit lease also fixes a latent race in
   P5-03.
4. **Then Microsoft (A-18f).** Prefer the MSI/EXE API for Godot's EXE exports, because the package
   is a URL.
5. **Steam (A-18g) is mostly a generated asset pack, a copy card and a checklist.** That is honest:
   Steam has no listing API.
6. **Run itch.io and Snap on the CI plane (A-18h),** and winget, the own tap and bucket, and Flathub
   on the PR plane (A-18i). They are cheap once the adapter contract exists.
7. **Build one console flow (A-18j)** and fold A-17f's New app wizard into it, unless A-17f has
   already started.

## 11. Work packages

All are pkey-implementer except A-18k, which needs human input:

- **None is plan-mode.** None touches `shared-protocol`, `shared-jws`, `client-core`, a signed
  document, `PROTOCOL_VERSION` or the corpus. Epic as a new outlet kind is excluded (decision 8).
- **Admin routes are narrative-only** (rule 10 via `NARRATIVE_ONLY`). Each needs a worker test, an
  audit row and a `D/admin/*` narrative update.
- **Console pages** carry the docs help-link drift gate.
- **Migrations** take their numbers in merge order after A-17a's `0059` and update `TABLE_OWNERS`.

| ID        | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Deps                                                                                                   | Size | Gates and flags                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------- |
| **A-18a** | **Adapter contract and storefront substrate.** `core/adapters/contract.ts` (`Adapter`, `Capabilities`, `Support`, `RateSpec`, `SpecPin`), shared with feeds; `core/storefront/{adapter,gate,ledger,budget,audit,confirm,deeplinks}.ts`, generalised from A-17a's `core/asc/*`, with the ASC rules moved unchanged to `rules/appStore.ts` and the Apple adapter registered; `store_operations` (the rename of `asc_operations`, or a rebuild migration if A-17a merged first); the conformance harness (§6.6) running over the Apple adapter; THREAT-MODEL edits (§9). No new store | A-17a (merged, or folded in); A-16                                                                     | M    | migration and TABLE_OWNERS; threat-model edit; conformance suite and spec classification required in CI |
| **A-18b** | **Listing model.** The five `dist_listing*` tables; validators; per-store `ListingProfile` projection with the fit report; per-locale release notes with the 500-character short form; import from `.pkey/distribution` `listing`; AltStore and Obtainium renderers read the model (falling back to the manifest); admin API (narrative)                                                                                                                                                                                                                                           | A-18a                                                                                                  | M    | migration; feeds golden files unchanged for manifest-only products                                      |
| **A-18c** | **Listing import.** `readListing` for Apple (A-17 client and gate), Play (read-only edit under the lease from A-18e, or a direct edit until then), Microsoft (P5-04 client extended to read the last published listing); CLI `pkey listing import --godot <project>` reads `project.godot` and `export_presets.cfg` (name, localized names, version, bundle ids, category hints, copyright, company, icon paths) and uploads to A-18b; precedence rules and the diff view's API                                                                                                    | A-18b; A-17 client                                                                                     | M    | CLI docs drift gate                                                                                     |
| **A-18d** | **Asset derivation.** CLI `pkey listing assets`: `sharp` pipeline reusing the brand kit's generator; icon derivation for every store; template composition of feature graphic, Steam capsules and library set, Microsoft hero, poster and box art, itch cover and Snap banner from key art plus wordmark with `textAllowed` per slot; screenshot fit and crop proposals; uploads to the blob store                                                                                                                                                                                 | A-18b; P2-01                                                                                           | M    | golden-image tests (pixel hashes)                                                                       |
| **A-18e** | **Play adapter.** Per-package edit lease shared with P5-03's poll, controls and A-16's `?tracks=1`; gate rules classified against the pinned discovery document (revision `20261001`); `details`, `listings`, `images` upload, closed-track create, Google Group testers, release notes on tracks, one-time products from `dist_store_products` (store `play`), commit with typed confirmation when production is touched; deep links and verifiers for app create, content rating, target audience, category, RTDN and Integrity                                                  | A-18a; A-18b; A-16; P5-03                                                                              | L    | conformance (incl. the lease race); spec classification                                                 |
| **A-18f** | **Microsoft Store adapter.** A write client (P5-04 stays GET-only for polling); MSI/EXE API (metadata modules, package by URL, assets create and commit, submit) and classic API (submission create, update, ZIP to SAS, commit; flights; rollout update, halt and finalize); category and price tier; typed confirmation on commit, finalize and pricing; the "never edit in the UI" warning; deep links for name reservation, first submission and MSIX properties                                                                                                               | A-18a; A-18b; A-16; P5-04                                                                              | L    | conformance; hand-written operation list pinned by date                                                 |
| **A-18g** | **Steam adapter.** Reads (`GetAppBuilds`, `GetAppBetas`, the partner app list); `SetAppBuildLive` on named branches (public branch per decision 5); budget with stop on 403; the store-page copy card, the generated asset pack download (A-18d), and the checklist (fee, 30 days, Coming Soon, store and build review)                                                                                                                                                                                                                                                            | A-18a; A-18d; A-16                                                                                     | S    | conformance                                                                                             |
| **A-18h** | **CI-plane adapters.** Publish action command allow-list; itch.io (`butler push` from outlet identity, `--userversion`, report-back to the ledger); Snap (`upload --release` to identity channels, `upload-metadata` from the model, scoped export-login); report-back of CI steps into `store_operations` through P2-06's ingest                                                                                                                                                                                                                                                  | A-18a; A-18b; P2-06                                                                                    | M    | conformance over CI command plans; CLI docs drift gate                                                  |
| **A-18i** | **PR-plane generators.** winget manifests (schema 1.12.0, multi-file, locale files from the model); Homebrew cask (own tap); Scoop (existing feed) committed to the own bucket; Flathub MetaInfo XML (name, summary, description, screenshots, `releases` from notes, OARS from content descriptors, `developer` id, `branding` colours) plus a manifest skeleton for the first, human PR; CI opens PRs with scoped tokens; verifiers via the public GitHub API                                                                                                                    | A-18a; A-18b; A-18h (allow-list)                                                                       | M    | generator golden files; winget schema validation in CI                                                  |
| **A-18j** | **Console.** "Add to storefronts" (T6) per product, the Listing editor (T3), and **Set up** from A-16's app list; capability strips rendered from declarations; the fit report; the slot board; deep-link copy cards; live verifiers; resumable from the ledger. Shares capability badge components with F-11                                                                                                                                                                                                                                                                      | ADMIN.md chunk 3; A-18a; A-18b; A-16's page; F-11 (shared components, whichever lands first owns them) | L    | docs help-link drift gate; narrative docs                                                               |
| **A-18k** | **Live verification** once the credentials exist (owner-approved, read-mostly, as A-17h was): Play "Manage store presence" sufficiency, edit expiry and the per-minute quota header behaviour; Microsoft Developer versus Manager role, `Retry-After` values, and a `packageUrl` that redirects; Steam group key and `SetAppBuildLive`, public versus named branch; winget fine-grained token; IARC certificate import on Play. Results go into a dated addendum here                                                                                                              | A-18a; credentials (guide §2–4); owner approval                                                        | S    | human input                                                                                             |
| **A-18m** | **Apple listing push** (only if decision 1 is yes). Widen the Apple rule table to listing text and screenshot sets (reserve, PUT, commit), with the projection from A-18b                                                                                                                                                                                                                                                                                                                                                                                                          | A-18a; A-18b; A-18d; A-17d                                                                             | M    | rule-table change: THREAT-MODEL review trigger                                                          |

**Changes to the A-17 packages:**

- **A-17a**, in flight:

  - if still unmerged, rename `asc_operations` to `store_operations` with a `store` column, and
    `apple_status` and `apple_code` to `vendor_status` and `vendor_code` (decision 3). Nothing else
    changes;
  - if it has merged, A-18a carries a rebuild migration.

  The gate's table and tests are moved, not rewritten.

- **A-17b, A-17c, A-17e:** no change to their scope. They call `performStoreWrite` once A-18a lands,
  which is an import change.
- **A-17d:** the release notes per locale come from `dist_listing_release_notes` (A-18b), not from
  the release record directly, and the preflight shows the Apple fit report. If A-17d lands first,
  A-18b retrofits that one read.
- **A-17f:** the New app wizard becomes the Apple adapter's `plan()` inside A-18j's flow, and its
  deep-link table moves to `core/storefront/deeplinks.ts`. **If A-17f has not started, merge it into
  A-18j.** If it has, A-18j wraps it.
- **A-17g:** Distribute's release-notes step edits the shared per-locale notes. App Store products
  default their localizations from the model.

**F-11:**

- F-11 is the package-feeds console, todo, depending on F-03 [V]. It does not block A-18.
- Shaping matters, per the owner's requirement:
  - its per-ecosystem pages should render the `FeedAdapter` capabilities from A-18a's contract
    (`unsupported_by_ecosystem` becomes a declared `unsupported`);
  - its badge and tile components should be the same ones A-18j uses.
- **Proposed brief edit to F-11 (not made here):** add "render capabilities from
  `core/adapters/contract.ts`" to its scope, and depend on A-18a's contract file only, which is
  small. Alternatively, A-18a lands the contract first.

**Ordering:**

- A-18a after A-17a.
- A-18b next.
- Then A-18c, A-18d and A-18e in parallel.
- A-18f after A-18e (shared patterns).
- A-18g, A-18h and A-18i in parallel after A-18b.
- A-18j after chunk 3 and A-18b, growing as adapters land.
- A-18k as soon as credentials exist.

**Proposed ADMIN.md amendment** (not edited here): §2.3 Distribution gains "Storefronts (Add to
storefronts, T6)" and "Listing (T3)". The Platform → Store connections row gains "Set up".

**Proposed README amendment** (not edited here): decision 7 gains "listing assets may be pushed by
the Worker from the blob store; binaries never" (decision 2).

**Proposed change to the owner's storefront setup guide** (not edited here; it is the owner's
file): §2 step 5 adds "Manage store presence" and "Manage testing tracks and edit tester lists".
§7 adds the Snap scoped export-login, a fine-grained GitHub token for the own tap and bucket, and
the butler key as a CI-only secret.

## 12. Limits of this spike

- **No account calls.** Every capability is from documentation. These items are **[U]** (A-18k):
  - which Play permission each write actually needs, and the edit expiry;
  - Microsoft's real rate limits and whether a Developer role suffices;
  - whether Microsoft fetches a `packageUrl` that redirects;
  - Steam's group key on `SetAppBuildLive`, public branch;
  - IARC certificate import on Play;
  - whether a fine-grained GitHub token can open a winget PR.
- **Epic is [S] throughout.** Its pages need a browser; no store-listing API was confirmed absent
  from a primary source.
- **Deep links.** Only one Play deep link is documented. All other link shapes are guesses until a
  person clicks them.
- **The Play image `sha1` and `sha256` fields** are [S]. If absent, the natural key for an image
  falls back to the ledger's own record of what it uploaded.
- **Flathub and prebuilt binaries.** Flathub takes prebuilt binaries via `extra-data`, or "by
  exception" [V]. Whether a closed-source Godot game is accepted was not checked.
- **Asset templates are untested.** The composition rules come from the specifications. No template
  was rendered in this spike.
- **Hearsay [S]:** Snap's `SNAPCRAFT_STORE_CREDENTIALS` variable; `butler status`; old Homebrew
  notability numbers; the Snap 256 KB icon cap.

## 13. Owner decisions

1. **Apple listing push.** Widen A-17a's surface to App Store listing text (description, keywords,
   marketing and support URLs, name, subtitle, privacy URL) and screenshot sets, so that the shared
   model reaches Apple too (A-18m)?
   - **Recommended:** yes, plain confirm for text and screenshots, after A-18b.
   - Alternatively: keep Apple at `whatsNew` and `promotionalText`, and give a deep link plus a copy
     card for the rest.
2. **Listing assets from the Worker.** Allow the Worker to push listing images and screenshots from
   the blob store to Play, Microsoft (and Apple if decision 1), amending README decision 7 for
   listing assets only? Binaries stay in CI.
   - **Recommended:** yes.
3. **Rename A-17a's ledger before it merges.** `asc_operations` becomes `store_operations`, with
   `store`, `vendor_status` and `vendor_code`.
   - **Recommended:** yes. It is one migration file now, against a rebuild later. The lead can
     sequence it with A-17a's reviewer.
4. **Play credential scope.** Add "Manage store presence" and "Manage testing tracks and edit
   tester lists" to the service account, and never Admin. Leave data safety in the Console (no
   "Manage policy declarations")?
   - **Recommended:** yes to both. Data safety is a legal declaration, like Apple's App Privacy.
5. **Steam default-branch release.** Let Polaris Key set a build live on Steam's public branch
   through the Web API, with typed confirmation, or keep it a deep link to App Admin?
   - **Recommended:** a deep link until A-18k shows that the group key may do it; then typed
     confirmation.
6. **Replacing Play screenshots.** Allow exactly one delete: a Play image that the same edit has
   just replaced, before commit?
   - **Recommended:** no for v1. Upload the new images, then give a deep link to remove the old ones.
7. **GitHub tokens for the PR plane.** A fine-grained token limited to the own tap and bucket repos,
   plus, for winget, a classic `public_repo` token only if A-18k shows that a fine-grained one
   cannot open the PR.
   - **Recommended:** yes. Both live as CI environment secrets, never in the Worker.
8. **Epic.** Add `epic` as an outlet kind (a plan-mode wire change) now, or wait for a product that
   ships there?
   - **Recommended:** wait. Until then, Epic is a CI-only BuildPatchTool step with a portal deep
     link.

## 14. Sources

**Google** (read 2026-10-04) [V]:

- androidpublisher v3 discovery document, revision `20261001`, SHA-256
  `bcbce36ef2e6174e18a8ea8fd269b0ef36bf97f13b824970098ae25a53ad51cf`:
  `https://androidpublisher.googleapis.com/$discovery/rest?version=v3` [M].
- Developer docs under `https://developers.google.com/android-publisher/`:
  - `edits` (one open edit; invalidation; existing app only);
  - `api-ref/rest/v3/edits/commit` (`changesInReviewBehavior`, `changesNotSentForReview`);
  - `api-ref/rest/v3/applications.tracks.releases/list` (`releaseLifecycleState`);
  - `api-ref/rest/v3/applications/dataSafety`;
  - `api-ref/rest/v3/edits.testers`;
  - `api-ref/rest/v3/monetization.onetimeproducts`;
  - `api-ref/rest/v3/users`;
  - `api-ref/rest/v3/AppImageType`;
  - `quotas`;
  - `getting_started`;
  - `app-store-review`.
- Play Console Help, `https://support.google.com/googleplay/android-developer/answer/<id>`:
  - `9859152` (create app; text limits; category);
  - `1078870` and `9866151` (graphic assets);
  - `9859348` (release notes);
  - `9898843` (content rating);
  - `9859455` (app content);
  - `9844686` (permissions);
  - `9845334` (testers);
  - `14151465` (12 testers, 14 days);
  - `9543912` and `9859654` (managed publishing);
  - `10787469` (data safety CSV);
  - `9859751` (publishing status).
- Android developer docs:
  - `https://developer.android.com/google/play/billing/getting-ready` (RTDN; Billing Library first);
  - `https://developer.android.com/google/play/billing/release-notes`;
  - `https://developer.android.com/google/play/integrity/setup`;
  - `https://developer.android.com/google/play/developer-api`;
  - `https://developer.android.com/guide/app-bundle/faq`;
  - `https://developer.android.com/distribute/google-play/resources/icon-design-specifications`.
- Google Cloud: `https://docs.cloud.google.com/iam/docs/roles-permissions/pubsub`.

**Microsoft** (read 2026-10-04) [V]:

- Classic API, under `https://learn.microsoft.com/en-us/windows/uwp/monetize/`:
  - `create-and-manage-submissions-using-windows-store-services`;
  - `manage-app-submissions`;
  - `create-an-app-submission`;
  - `get-app-data`;
  - `manage-flights` and `manage-flight-submissions`;
  - `manage-add-ons`, `create-an-add-on` and `manage-add-on-submissions`.
- Publishing docs, under `https://learn.microsoft.com/en-us/windows/apps/publish/`:
  - `store-submission-api` (MSI/EXE);
  - `msstore-dev-cli/overview` and `msstore-dev-cli/commands`;
  - `partner-center/assign-roles-to-account-users`;
  - `partner-center/overview-of-roles-and-permissions-for-account-users`;
  - `partner-center/manage-azure-ad-applications-in-partner-center`;
  - `partner-center/manage-users-in-partner-center`;
  - `publish-your-app/msix/{app-package-requirements,app-certification-process,reserve-your-apps-name,age-ratings,screenshots-and-images,add-and-edit-store-listing-info,add-additional-information,schedule-pricing-changes}`.
- Games listing: `https://learn.microsoft.com/en-us/gaming/game-publishing/concepts/store-listing`.
- winget:
  - `https://learn.microsoft.com/en-us/windows/package-manager/package/{manifest,repository}`;
  - `https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/defaultLocale.md`;
  - `https://github.com/microsoft/winget-create`.
- msstore CLI source: `https://github.com/microsoft/msstore-cli`.

**Valve** (read 2026-10-04) [V], under `https://partner.steamgames.com/doc/`:

- `webapi_overview`, `webapi`, `webapi/ISteamApps`, `webapi/IStoreService`, `webapi/ISteamUser`;
- `sdk/uploading`;
- `store/assets`, `store/assets/standard`, `store/assets/libraryassets`, `store/assets/rules`;
- `store/review_process`, `store/coming_soon`, `store/page/description`, `store/trailer`;
- `gettingstarted/appfee`, `gettingstarted/contentsurvey`.

Also `https://partner.steamgames.com/steamdirect` and `https://steamcommunity.com/dev/apiterms`.

**Apple** (read 2026-10-04) [V], in addition to S-14's sources:

- App Store Connect Help, under `https://developer.apple.com/help/app-store-connect/`:
  - `reference/app-information/{platform-version-information,app-information,screenshot-specifications,app-preview-specifications,age-ratings-values-and-definitions}`;
  - `manage-app-information/add-an-app-icon`.
- The `appInfoLocalizations`, `appStoreVersionLocalizations`, `ageRatingDeclarations` and
  `ScreenshotDisplayType` documentation as JSON.
- The HIG app-icons JSON.

**Other outlets** (read 2026-10-04) [V] unless marked:

- itch.io: `https://itch.io/docs/butler/{pushing,login}.html`, `https://itch.io/docs/api/serverside`,
  `https://itch.io/docs/creators/{getting-started,design}`.
- Flathub: `https://docs.flathub.org/docs/for-app-authors/{submission,requirements,metainfo-guidelines,metainfo-guidelines/quality-guidelines,verification}`;
  `https://github.com/flathub-infra/flatpak-external-data-checker`.
- Snap:
  - `https://ubuntu.com/docs/snapcraft/stable/reference/commands/{register,upload,export-login,upload-metadata}`;
  - `https://dashboard.snapcraft.io/docs/reference/v1/macaroon.html`;
  - `https://raw.githubusercontent.com/canonical/snapcraft/main/schema/snapcraft.json`;
  - `https://forum.snapcraft.io/t/store-listing-and-branding/16397` [S].
- Homebrew: `https://docs.brew.sh/{How-to-Create-and-Maintain-a-Tap,Acceptable-Casks,Cask-Cookbook}`.
- Scoop: `https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests`.
- AltStore: `https://faq.altstore.io/developers/make-a-source`.
- F-Droid: `https://f-droid.org/docs/{All_About_Descriptions_Graphics_and_Screenshots,Inclusion_Policy}/`.
- Obtainium: `https://github.com/ImranR98/Obtainium`.
- IARC: `https://globalratings.com/{storefronts,faq}/`.
- Godot: the 4.x class reference for `ProjectSettings` and the Android, iOS, macOS and Windows
  export platforms.
- Epic, from search excerpts only [S]:
  - `https://dev.epicgames.com/docs/epic-games-store/publishing-tools/uploading-binaries/bpt-instructions-170`;
  - `…/get-started/get-started-steps/onboarding`;
  - `…/sales-and-marketing/marketing/storefront-media-guide`.

**Repo** [V], at `47da77b9` unless noted:

- `AGENTS.md`; `CLAUDE.md` (plan-mode triggers);
- the program `README.md` (decision 7; vendor CLIs);
- `docs/design/ADMIN.md` (T6; Platform section);
- notes S-06, S-10, S-11, S-12 and S-14;
- `plans/F-01.md` §6.8 and §6.9;
- wp briefs P5-03, P5-04, P5-08 and F-11;
- A-16: `W/src/admin/handlers/platformStoreConnections.ts`, `W/src/core/platformCredentials.ts`,
  `W/src/core/platformStoreSettings.ts`, `W/migrations/0055_platform_store_connections.sql`;
- connectors: `W/src/services/distribution/connectors/{platformApps,platformFallback}.ts`,
  `connectors/asc/*`, `connectors/play/*`, `connectors/msstore/*`;
- commerce: `W/src/services/distribution/commerce/{apple,play,steam}.ts`,
  `W/migrations/0052_commerce.sql`;
- distribution: `W/src/services/distribution/{matrix,outlets}.ts`, `feeds/*`, `page/model.ts`,
  `registry/{materialise,index}.ts`;
- release: `W/migrations/0007_backend_contracts.sql`, `W/src/services/release/{descriptor,changelog}.ts`;
- protocol and manifests: `packages/shared-protocol/src/distribution.ts`,
  `M/src/distribution.ts`, `M/schemas/v1/*.schema.json`;
- CLI: `packages/cli/src/{manifest,transport,transportSteam,transportPlayPad,transportAppleBa}.ts`;
- brand: `packages/brand` (kit README, `BUILD-INFO.json`);
- Godot: `sdks/godot/addons/polaris_key/export/export_plugin.gd`, `core/build_stamp.gd`;
- console: `A/console/pages/platformStores.tsx`;
- A-17a, branch `wp/A-17a-asc-write-gate` at `f1fbdb94`:
  `W/src/core/asc/{writeGate,writeGateDenied,ledger,budget,audit,client}.ts`,
  `W/migrations/0059_asc_operations.sql`.

**Owner:** the storefront setup guide (last updated 2026-10-04), not in the repo.

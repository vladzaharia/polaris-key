# Audit: products, services, onboarding and the in-app Integration section

_DX consolidation, 2026-10-07. Tree read: `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5,
HEAD `38d3acc68`). In-flight branches read where they touch this domain: HA-12
(`/Users/vlad/Repos/pk-wt/HA-12`), LX-08 (`/Users/vlad/Repos/pk-wt/LX-08`), UK-14
(`/Users/vlad/Repos/pk-wt/UK-14`). Owner brief:
`docs/research/2026-10-07-dx-consolidation/owner-brief.md` (General Concepts, Products,
Administration sidebar, Minor Changes console card)._

---

## Summary

The product model is sound and small: one `products` row, a KEK-sealed signing key, one
`services_json` column that every surface projects (`packages/worker/src/core/services.ts`), and
seven opt-in services declared once in `tools/services.json`. **Onboarding is the weak part, and it
is weak because it is over-designed and under-built at the same time.**

- **Built:** UX-20's one-screen create (`console/pages/global/ProductNew.tsx`), then Overview with
  a sessionStorage Welcome banner, a "Setup" checklist built on a legacy six-module model
  (`admin/lib/shape.ts:548-608`), and a 550 px "Trust & SDK" panel (`Overview.tsx:1226`) whose
  generator says it is "Interim until UX-60's `renderSdkSetup` and UX-61's Connect your app replace
  it" (`sdkQuickStart.ts:15`). Nothing tells an operator that an app has ever reached Polaris Key.
- **Designed, not built:** SETUP.md (1,767 lines), FLOWS.md (664) and EXPERIENCE.md §13 describe
  **five overlapping setup surfaces** for one product: a launch path on Overview (UX-21), a
  Connect-your-app wizard page (UX-61), per-service quick-start drawers (UX-63, UX-64, UX-65), an
  empty-state sweep (UX-66) and a post-create "ready" hero with a burst animation (UX-75), on a
  wizard kit (UX-50) and a generic wizard-state table (UX-51). Of the 32 packages in Waves 5 and 6,
  six are merged (UX-59, UX-69, UX-72, UX-77, UX-78, UX-79). None of the rest is a node in the
  program graph (`program/README.md:338`): onboarding has a second, untracked backlog.

The owner's brief asks for exactly two things in this area: **a step-by-step product wizard** and
**one Integration section** with per-service instructions and code samples, hideable once a real
end-to-end exchange has happened. The designs already contain the right parts (SDK sightings as the
"it works" signal, D28; one shared snippet generator, D15; create-with-defaults, F6 to F13). The
single most important change is to **collapse the five designed setup surfaces into one
Worker-computed integration model and one per-product Integration page** (plus a compact Overview
card), fed by one snippet generator shared by the console, the CLI, the Godot dock and the docs
site, with the "hide this section" choice unlocked by the first verified SDK exchange. That deletes
roughly a dozen planned packages, two setup data models and three duplicate snippet generators, and
needs no wire change.

Alongside it: group the seven service switches into five features (Release, Distribution and
Update become one "Ship builds" switch, slugs unchanged on the wire), pull the scattered
sub-capability switches into the service table, revert the Home product card to name, slug and a
row of service icons (dropping `GET /manage/api/summary`), make the Platform and Product sidebars
explicit contexts (most of it already exists), and fold the surviving onboarding packages into the
program as a new phase **OB**.

---

## Current state (with file references)

### 1. The product model

| Concern     | Where                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row         | `products` (`worker/migrations/0001_init.sql:10` plus 14 `ALTER`s)                                                          | 26 columns: identity (`slug`, `name`, `system`), signing (`signing_kid`, `signing_pub`), licence defaults (`default_max_offline_days`, `default_device_limit`), `compat_min/max` (+`compat_source`), `admin_group`, `branding_json`, `release_source` (`manual`/`github`), `services_json` (+`services_source`), `fingerprint_policy_json` (+`_source`), `auto_issue_json` (+`_source`), `web_origins_json`, `trust_policy_json` (+`_source`), `status`/`deleted_at` (soft delete, `admin/repo.ts:83`). HA-12 adds `presentation_json` (`HA-12: core/products.ts +74`). |
| Loader      | `worker/src/core/products.ts:118-191`                                                                                       | `loadProduct` unseals the key under the KEK; `loadProductPublic` skips the unseal for byte routes. Both fail closed when there is no active key.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Settings    | `worker/src/core/settings/core.ts` (16 product-scope keys: nine `core.*`, four `storefront.polarisKey.*`, three `assets.*`) | `core.name`, `core.adminGroup`, `core.web.origins`, `core.manifest.authoritative`, `core.services`, `core.registration`, `core.secrets` (pending ST-08), `core.presentation` (pending HA-12), `core.trustPolicy`                                                                                                                                                                                                                                                                                                                                                        |
| Dead fields | `products.branding_json` (written `null` at `admin/handlers/products.ts:602`, read nowhere); `products.admin_group`         | `core.adminGroup` is described as "the identity-provider group named by the manifest as this product's administrators" (`core/settings/core.ts:65-80`, marked `securityWidening`), but `admin/authz.ts:1-44` states there is exactly one privilege level and **no code reads `admin_group` for authorization**. It is a stored, audited, claim-tracked knob with no effect.                                                                                                                                                                                             |

### 2. Services and enablement

- **Declaration:** `tools/services.json` (7 rows: `license`, `config`, `release`, `distribution`,
  `update`, `identity`, `sync`; `defaultEnabled` for license and config; `requires` edges
  release ← distribution ← update and config, identity ← sync). `pnpm gen:services` writes every
  language's constants (`tools/gen-services.ts`).
- **Authority:** `services_json` parsed strictly and fail-safe by `parseServices`
  (`core/services.ts:144-184`), with unknown well-formed slugs carried through for rollback safety;
  coherence codes from `validateServices` (`core/services.ts:278-326`); registration policy rides
  the same blob and is derived when undeclared (`resolveRegistration`, `:220-228`).
- **Operator writes:** `GET|PATCH …/services` and `POST …/services/revert`
  (`core/servicesAdmin.ts:75-263`), partial patch, `?dryRun=1` with the signed-in devices count
  (PX-W17), the edge-mint approval sweep, then `applyServiceTransitions`.
- **Console:** Core → Services (`console/pages/core/Services.tsx`): one switch per slug with UX-22's
  chain rule, a four-option registration RadioCards (`:66-90`: Derived, Open, Requires identity,
  Requires license), and a **Package feeds** switch on a separate API (`:643-710`, F-11's
  `dist_registry_owners`).
- **Sub-capabilities live elsewhere:** Package feeds (Services page, its own route), the Polaris Key
  storefront (`storefront.polarisKey.enabled`, platform setting), the customer portal
  (`portal_product_settings.portal_enabled`, Identity → Portal), edge mint (implied by declared
  recipes plus approvals), commerce (`distribution.commerce`), hosted assets
  (`assets.hosting.enabled`, platform). Five places, five idioms.
- **Vocabulary split:** the manifest key is still `modules` (`shared-manifest/schemas/v1/product.schema.json:48`),
  `pkey init` takes `--modules` (`cli/src/index.ts:1687`), the docs say "The six service slugs"
  (`docs/src/content/docs/build/onboarding.md:36`, Cloud Sync missing), and every other surface
  says "services".

### 3. Product creation

| Path         | Where                                                                                                                                               | What it writes                                                                                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual       | `POST /manage/api/products` → `manualCreate` (`admin/handlers/products.ts:516-652`)                                                                 | product row, signing key (sealed), empty catalog v1, in one batch. Still accepts `compatMin/compatMax` (`:597-598`) although the window moved to `release.compatWindow`. `services_json` NULL → defaults (license + config).                                                                                            |
| Repository   | `POST …/link-repo` (`:178-262`), `?dryRun=1` (UX-72, W23), `manifestDigest` pin                                                                     | everything `registerFromManifest` writes (`services/release/linkRepo.ts`), then the product view.                                                                                                                                                                                                                       |
| Probes       | `GET …/slug-check` (W24, before the platform-admin gate, `:155-167`), `GET /manage/api/github/repositories` (W22, `admin/handlers/github.ts`)       | Built by UX-72; **no console page uses W22 yet**.                                                                                                                                                                                                                                                                       |
| Console      | `console/pages/global/ProductNew.tsx` (UX-20)                                                                                                       | One form: "Start from" Nothing / A GitHub repository, Name, Slug (checked live), **Advanced: license defaults** (`:593-640`). Lands on Overview with `storeWelcome` (`:355-360`). Its own header comment admits the GitHub path has no repository picker or check before Link (`:236-238`), although W22/W23 now exist. |
| CLI          | `pkey init [--product] [--name] [--modules …]` (`cli/src/index.ts:1687`), `pkey validate`, `pkey doctor`, `pkey trust`, `pkey sdk --lang … --write` | UK-14 (in a fix round) rewrites `cli/src/index.ts` (+1,008 lines changed) and adds `help.ts` and `terminal.ts`.                                                                                                                                                                                                         |
| Godot editor | `sdks/godot/addons/polaris_key/editor/setup_dock.gd`                                                                                                | Writes `res://polaris_key.tres` from pasted pins **and** runs `pkey sdk --lang godot --write` into `res://polaris_key_config.gd` (`setup_tools.gd:91`): two config artifacts for one engine.                                                                                                                            |

### 4. After create: Overview

`console/pages/core/Overview.tsx` (1,396 lines) stacks, top to bottom:

1. A header whose primary action is Create license / Publish catalog / Enable services
   (`:189-203`).
2. The one-time **Welcome** (`core/Welcome.tsx`, sessionStorage, "<Name> is ready" with the key).
3. **Moments** (MO-11: first catalog, first release, first store, launched).
4. **Attention** list (client-derived from `setup.nextActions`, `pages/global/attention.ts`).
5. One **tile per enabled service**.
6. The **Setup checklist** (`useChecklist`, `:629-745`): signing key, required secrets, catalog
   published, first licence, release source, edge-mint approvals. It never asks whether an app has
   integrated.
7. **Trust & SDK** (`TrustPanel`, `:1226-1348`): signing key, JWKS URL, an SDK chooser, install
   snippets from `renderFeedSetup` and an init snippet from `sdkQuickStart.ts`.
8. Recent activity.

The Worker's projection behind it is `productView` (`admin/lib/shape.ts:217-310`), which emits
`setup`, `modules` **and** an `onboarding` object carrying the same `setup` and `modules` again
plus legacy URLs (`:277-296`); `productSetupView` (`:402-…`) computes six legacy "modules"
(`signing`, `oidc`, `release`, `portal`, `manifestSync`, `edgeMint`) that do not line up with the
seven services. `GET /manage/api/products` runs that whole projection, about ten queries, **for
every product** (`admin/handlers/products.ts:268`).

### 5. Home, the product card and Products

- **Home** (`console/pages/global/Home.tsx`): attention list, three stat tiles (Products, Need
  attention, **Linked to a repository**, `:267-288`), and the six most recently changed products as
  **B · Ledger** cards (`ProductCard`, `:406-562`): logo, name, slug, one row per service with a
  per-service fact from `GET /manage/api/summary` (`admin/handlers/summary.ts`,
  `admin/lib/summary.ts`, 137 lines, four grouped queries) and per-row issue pills, a "+n more"
  glyph strip past four services, and a "Synced/Changed" footer. Built 2026-10-06 from
  `docs/design/console-product-card/` (direction B chosen over A · Rail and C · Spectrum).
- **Products** (`console/pages/global/Products.tsx`): the full registry as a table with Services
  glyphs, and a **"Setup complete / Needs attention"** facet (`:52-60`) that calls a product with no
  open attention item "Setup complete", the exact mislabel SETUP D21 flagged.
- **Product switcher** (`shell/ProductSwitcher.tsx`) already draws **service dots** per product
  (`shell/bits.tsx:36` `ServiceDots`).

### 6. Shell: Platform vs Product

`shell/Sidebar.tsx:96-160`: Home and Products always first; **off a product** the Platform group
follows (Settings, Deployment, Operations, Store connections, Package feeds, Override migration,
`nav.ts:750-818`); **inside a product** Platform is hidden (owner, 2026-10-04) and the product's
sections follow. So the owner's "switch sidebars by context" is about 80% built; what is missing is
an explicit context control and a lean product sidebar. A product running every service shows
**35 nav items** (Core 8, License 4, Config 3, Release 5, Distribution 11, Update 1, Identity 2,
Cloud Sync 1; counted from `console/nav.ts`). "Override migration" (U-03's one-time move) is a
permanent Platform item.

### 7. In-app help vs the docs site

- The docs site (`packages/docs`, Astro Starlight) is served at `/docs` **behind the platform-admin
  session** (`worker/src/docs.ts:1-25`; AGENTS.md rule 11). A product developer who is not a
  console operator cannot read `build/quickstart/*` at all.
- The console links help through two tables gated against the built slug manifest
  (`console/nav.ts` per-page `docs`, `lib/docsLinks.ts`).
- Code shown to developers comes from **three generators that disagree in shape**: the console's
  `sdkQuickStart.ts` (312 lines), the CLI's `sdkConfig.ts` (568 lines, discovery-based, with
  release-key fingerprints) and the Godot dock (`.tres` writer). The docs quickstarts
  (`build/quickstart/node.md` etc.) are hand-written and use `pkey sdk --lang node --write`.

### 8. The designed-but-unbuilt onboarding layer

| Package                           | What                                                                                                                 | State                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| UX-20, UX-22, UX-23               | One-screen create, service chain rule, guided Releases empty state                                                   | merged                        |
| UX-59                             | SDK quick start from `pkg.plrs.im`                                                                                   | merged (the "interim" panel)  |
| UX-72                             | Create probes W22, W23, W24                                                                                          | merged; unused by the console |
| UX-69                             | Live store-key check                                                                                                 | merged                        |
| UX-21                             | Launch path + Worker `setup` model                                                                                   | todo (XL)                     |
| UX-50, UX-51                      | Wizard kit, `setup_state` table and routes                                                                           | todo (L, M)                   |
| UX-60, UX-61                      | `renderSdkSetup`, Connect your app page with SDK sightings (W15, W7)                                                 | todo (M, L)                   |
| UX-63, UX-64, UX-65, UX-66, UX-67 | Licence/Config quick starts, signing/update/access setup, customer sign-in wizard, empty-state sweep, Platform ready | todo                          |
| UX-73 to UX-76, UX-80, UX-81      | Create with defaults, New Product wizard, ready hero, presentation in create, flow motion, flow lint                 | todo                          |
| UX-12, UX-35                      | Attention model, moments                                                                                             | todo / delivered by MO-11     |

These live only in EXPERIENCE.md §13.3, SETUP.md §8.2 and FLOWS.md §4.2; `workpackages.json` has
no UX ids except as dependency notes.

### 9. Program phases A, F, P1, P6, X

Almost all done. Open items that touch onboarding: **P1-12** (Godot docs page and publish,
in review), **F-10** (our SDKs onto the feeds, in review; every install snippet depends on it),
**X-01/X-02** (optional C#/.NET and Tauri SDKs, todo; each would add a column to every snippet),
**F-32** (NuGet feed, coupled to X-01). P6-04 (blocked) and A-18k (blocked) are not onboarding.

---

## Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                              | Impact | Evidence                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **Nothing confirms an integration works.** No surface records that an SDK ever reached the product; the checklist completes without an app ever existing; Devices' empty state says "Point an SDK at this product" with only a docs link.                                            | high   | `Overview.tsx:629-745`; `Devices.tsx:277-282`; SETUP D28, SDK F7                                                  |
| 2   | **Five overlapping setup surfaces designed, none built**, in a backlog the program does not track. Building them as specified means ~20 packages, two new tables (`setup_state`, `sdk_sightings`), a launch path and a wizard page that both list the same steps.                    | high   | EXPERIENCE §13.3 Waves 5–6; SETUP §4.2, §5; FLOWS §4.2; `program/README.md:338`                                   |
| 3   | **Three snippet generators**, plus hand-written docs quickstarts, plus two Godot config artifacts. They differ in file names, pins and release keys; the console's is self-declared interim.                                                                                         | high   | `sdkQuickStart.ts:15`; `cli/src/sdkConfig.ts`; `setup_dock.gd`, `setup_tools.gd:91`; `docs/build/quickstart/*.md` |
| 4   | **The developer docs are unreachable for developers.** `/docs` admits only platform-admin sessions; the only in-app SDK help is the Overview panel.                                                                                                                                  | high   | `worker/src/docs.ts:1-25`; AGENTS rule 11                                                                         |
| 5   | **Two setup models**: legacy six "modules" (`productSetupView`) and the seven services; `productView` ships `setup` and `modules` twice (`onboarding`).                                                                                                                              | medium | `admin/lib/shape.ts:277-296, 548-608`                                                                             |
| 6   | **Product create is a dead end on the GitHub path and asks the wrong question on the manual path.** No repository picker or pre-check although W22/W23 exist; no "what is it for"; asks licence defaults (offline grace, device limit) that tiers and platform defaults already own. | medium | `ProductNew.tsx:236-238, 593-640`; FLOWS §3.1                                                                     |
| 7   | **Seven service switches for five decisions.** Release, Distribution and Update are a strict chain that an operator almost always wants together; the registration policy is a four-way choice on the same page although "Derived" is right for nearly every product.                | medium | `tools/services.json`; `core/services.ts:278-326`; `Services.tsx:66-90`                                           |
| 8   | **Sub-capabilities are scattered** across five pages and APIs (package feeds, Polaris Key storefront, portal, edge mint, commerce).                                                                                                                                                  | medium | §2 above                                                                                                          |
| 9   | **The Home card carries facts the owner does not want** and a dedicated read (`GET /manage/api/summary`) to fill them.                                                                                                                                                               | medium | `Home.tsx:339-562`; `admin/handlers/summary.ts`; owner brief Minor Changes                                        |
| 10  | **Product nav is 35 items deep** for a full product; Core alone has 8 (Services, Presentation and Keys & secrets are settings, not destinations).                                                                                                                                    | medium | `console/nav.ts`                                                                                                  |
| 11  | **Dead configuration**: `core.adminGroup` (audited, claimable-looking, does nothing), `products.branding_json` (never read).                                                                                                                                                         | medium | `core/settings/core.ts:65-80`; `admin/authz.ts`; `admin/handlers/products.ts:602`                                 |
| 12  | **`GET /manage/api/products` runs the full setup projection per row** (about ten queries each) only so Home can derive attention client-side.                                                                                                                                        | low    | `admin/handlers/products.ts:268`; `pages/global/attention.ts`                                                     |
| 13  | **Vocabulary drift**: manifest `modules` vs "services"; docs "six service slugs"; "Setup complete" facet.                                                                                                                                                                            | low    | `product.schema.json:48`; `onboarding.md:36`; `Products.tsx:52-60`                                                |
| 14  | **A one-time migration page is permanent nav** (Override migration).                                                                                                                                                                                                                 | low    | `nav.ts:807-818`                                                                                                  |
| 15  | **Manual create accepts fields it no longer owns** (`compatMin/compatMax`).                                                                                                                                                                                                          | low    | `admin/handlers/products.ts:597-598`                                                                              |

---

## Owner brief: item-by-item stance

| #   | Brief item                                                                                                                                 | Stance                                                                                                                 | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Similar features and services should be consolidated                                                                                       | **adopt**                                                                                                              | Five setup surfaces become one Integration model and page; three snippet generators become one; seven switches become five features; sub-capabilities move into the service table.                                                                                                                                                                                                                                                                                                                                                                                     |
| G2  | Flexibility in configuration, to an extent                                                                                                 | **adapt**                                                                                                              | The manifest keeps explicit per-slug control (experts, CI, rollback safety); the console shows grouped switches with an Advanced disclosure for the per-slug view. No slug merges on the wire.                                                                                                                                                                                                                                                                                                                                                                         |
| G3  | Reduce configuration surface area                                                                                                          | **adopt**                                                                                                              | See "Surface-area reduction": registration policy behind Advanced, licence defaults out of create, `adminGroup` and `branding_json` retired, the summary read deleted.                                                                                                                                                                                                                                                                                                                                                                                                 |
| G4  | Excellent onboarding: wizards, example code, auto-configuration                                                                            | **adopt**                                                                                                              | New Product wizard (trimmed UX-74), Integration page with generated code per SDK and per service, `pkey sdk add` and `pkey init` one-command paths, platform-aware defaults.                                                                                                                                                                                                                                                                                                                                                                                           |
| G5  | Automate whatever can be automated (enable a storefront if credentials exist)                                                              | **adopt**                                                                                                              | Create mints the key, creates the Free tier, trusts the release workflow, reserves the Polaris Key storefront, applies services from goals; Integration creates the test licence and adds `localhost` web origins on request. Storefront auto-enable belongs to the distribution and commerce audits; Integration links to it.                                                                                                                                                                                                                                         |
| G6  | Degrade gracefully when a service is off                                                                                                   | **adopt**                                                                                                              | Integration shows only enabled services' cards; the service-off page is one data-driven state from `tools/services.json`; a product with no app-facing service shows no SDK section at all.                                                                                                                                                                                                                                                                                                                                                                            |
| P1  | Products easy to add and administer                                                                                                        | **adopt**                                                                                                              | Wizard plus a 6-item Core nav (Overview, Integration, Devices, Users, Activity, Settings).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P2  | Core features plus optionally enabled features; "the current set can be made better"                                                       | **adapt**                                                                                                              | Present five features (Licensing, Remote config, Ship builds, Sign-in, Cloud Sync) over the seven unchanged slugs; capabilities nest under them. **Push back** on adding new slugs (for example a `commerce` service): a new slug is a five-language, ~45-file event that changes discovery (A3 §5.3); a capability row in the service table gets the console benefit with no wire change.                                                                                                                                                                             |
| P3  | Step-by-step wizard to add a product                                                                                                       | **adopt**                                                                                                              | FLOWS §3's shape, trimmed: Start (repository picker or scratch) → Check (dry run) or Name → What it's for (goals → services, platforms, Free tier) → Create → Integration. Defer the motion choreography, accent swatches, the setup pull request and "Ask a platform admin" (needs RBAC).                                                                                                                                                                                                                                                                             |
| P4  | After creating, an "Integration" section with per-service instructions and code samples                                                    | **adopt**                                                                                                              | One page `#/p/<slug>/integration` plus an Overview card. It absorbs Connect your app (UX-61), the launch path (UX-21) and the per-service quick starts (UX-63/64/65).                                                                                                                                                                                                                                                                                                                                                                                                  |
| P5  | Documentation in-app and easy to understand                                                                                                | **adopt, with a constraint**                                                                                           | The in-app content is rendered by the same generator the docs site uses, so the two cannot drift. The docs site stays the reference (and gated, rule 11); the Integration page must be self-sufficient for integrating.                                                                                                                                                                                                                                                                                                                                                |
| P6  | A banner or button to dismiss the whole section, exposed after an end-to-end handshake and data exchange; user choice (multiple platforms) | **adapt**                                                                                                              | Define the handshake concretely from server-observable facts, with no wire change: an **SDK sighting** (request carrying the SDK headers) **plus a 2xx on that service's document route** from the same SDK. Unlock "Hide Integration" after the **first** verified exchange, not after every service, and show progress per service and per platform so the person decides. Hidden is per product, audited, and reversible from Overview's menu and ⌘K. Products whose only service needs no app code (download page only) verify by their own fact (first download). |
| A1  | Switch between the Platform sidebar and the Product sidebar by context                                                                     | **adopt**                                                                                                              | Mostly built (`Sidebar.tsx:136-160`). Make it explicit: a context header at the sidebar top (Platform, or the product's logo and name with the switcher); Home and Products belong to the Platform context; the product context is Overview, Integration, its services and Settings.                                                                                                                                                                                                                                                                                   |
| A2  | Platform settings expanded, commonly changed first                                                                                         | **defer** to the administration / platform-settings audit (ST-09). This audit only fixes the nav shell they render in. |
| M1  | Revert to a simpler product card: name/slug header, a row of icons for enabled services, no other details                                  | **adopt**                                                                                                              | Remove the per-service facts, the "+n more" strip and the footer; delete `GET /manage/api/summary`. **Adapt** one detail: keep the logo (the owner's 2026-10-06 request) and a tone dot on a service icon that has an issue; the words stay in Home's attention list above the cards.                                                                                                                                                                                                                                                                                  |
| M2  | On mobile, product name and a coloured pip per enabled service                                                                             | **adopt**                                                                                                              | Reuse `ServiceDots` (`shell/bits.tsx:36`), already used by the switcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| X1  | Code quality: no duplicated code, consistency, modularity                                                                                  | **adopt (domain slice)**                                                                                               | One snippet generator; one setup model; drop the duplicate `onboarding` payload; one Godot config artifact; delete the summary slice.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| X2  | "Go through the entirety of the todo work and consolidate"                                                                                 | **adopt**                                                                                                              | The UX setup packages fold into a new program phase OB (13 packages replacing about 20).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Target design

### T1. The product model: Core plus five features over seven slugs

- **Core (always on, no switch):** registry fields, signing key, devices, users, activity,
  presentation, settings, **Integration**.
- **Features** (console and wizard vocabulary), each mapping to slugs in `tools/services.json`:

  | Feature       | Slugs                               | Capabilities nested under it (each a row in the service table, written through `writeSetting`)                                                                                           |
  | ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Licensing     | `license`                           | (licensing model settings stay on License pages; registration policy under Advanced)                                                                                                     |
  | Remote config | `config`                            | Secrets delivery / edge mint (read-only: on when recipes are declared and approved)                                                                                                      |
  | Ship builds   | `release`, `distribution`, `update` | Update feed (on by default with the group; the one per-slug switch most experts touch), Package feeds, Polaris Key storefront, Commerce (until the commerce audit settles its own shape) |
  | Sign-in       | `identity`                          | Customer portal                                                                                                                                                                          |
  | Cloud Sync    | `sync`                              | (none)                                                                                                                                                                                   |

- **Mechanics:** `tools/services.json` gains `console.group` (`"ship"` on the three release slugs)
  and a `capabilities[]` list per service (`id`, `label`, `summary`, `settingKey`, `default`).
  `gen:services` emits them only into the console's `services.generated.ts`, so SDK constants do
  not churn. The Services area renders five rows; turning on Ship builds turns on all three slugs
  (an extension of UX-22's chain rule); Advanced shows the per-slug switches and the registration
  policy (default "Derived").
- **Unchanged:** `services_json`, `validateServices` codes, discovery's `services` map, the
  manifest's per-slug semantics. A manifest that enables `release` alone still means release alone.
- **Retired:** `core.adminGroup` (unless the RBAC audit adopts it as the OIDC group for the
  "{Product} Admin" role; it must not stay as a knob that does nothing), `products.branding_json`.

### T2. One integration model in the Worker

`GET /manage/api/products/<slug>/integration` returns, per **enabled** service in canonical order:

```jsonc
{
  "hidden": null, // or { "at": 1760000000, "by": "Ada" }
  "unlocked": true, // the first verified exchange has happened
  "platforms": { "planned": ["macos", "ios"], "seen": ["macos"] },
  "sdk": {
    "sightings": [
      {
        "sdk": "swift",
        "version": "2.1.0",
        "platform": "macos",
        "arch": "arm64",
        "firstSeen": 0,
        "lastSeen": 0,
      },
    ],
  },
  "services": [
    {
      "service": "license",
      "prerequisites": [
        { "id": "tiers", "state": "done" },
        { "id": "test-license", "state": "todo" },
      ],
      "verified": {
        "state": "done",
        "by": "first-activation",
        "at": 0,
        "platform": "macos",
      },
    },
    {
      "service": "config",
      "prerequisites": [{ "id": "catalog-published", "state": "todo" }],
      "verified": { "state": "waiting" },
    },
  ],
}
```

- **Facts, not flags** (SETUP D14): every state is computed from existing data (tiers, licences,
  activations, catalog versions, releases, the CI publisher policy, portal sign-ins, Cloud Sync
  writes, first downloads) plus one new Core table.
- **`sdk_sightings`** (SETUP W15, extended with the service): `(product, sdk_name, sdk_version,
platform, arch, service, first_seen, last_seen, last_ok_at)`, written from the router for any
  public product request carrying the SDK headers the SDKs already send (`core/devices.ts:763-771`
  parses them today for devices), `service` being the route namespace (`core` for discovery and
  devices). At most one write per key per five minutes per isolate, upserting `last_seen` (and
  `last_ok_at` on a 2xx), off the response path through `waitUntil`, fail-open. No IP, no device
  id, no licence. 90-day prune in the existing cron. Read by the integration model and by
  `GET …/sdk-sightings` (W7) only if a second consumer appears.
- **Verified exchange** for a service = a sighting for that service with `last_ok_at` set, or the
  service's own domain fact where one is stronger (first activation, first portal sign-in, first
  Cloud Sync write, first download for Ship builds). **Unlocked** = any service verified.
- **Hidden** is a product setting `core.integration.hidden` (operator-owned, L0, audited, no
  manifest path) holding `{ at, by }`, so it rides the registry's audit and history for free
  instead of a new `setup_state` table.
- **Attention stays separate** (SETUP D21): broken things (missing secret, unapproved recipe,
  failed resync) remain attention items (UX-12); integration progress is never an attention item.
- `productSetupView`'s legacy `modules` and `nextActions`, and `productView`'s `onboarding` object,
  are deleted once the console reads this model.

### T3. The Integration page

`#/p/<slug>/integration`, Core nav item **Integration** (icon `Plug`, already imported in
`nav.ts`), shown until hidden, always reachable from ⌘K ("Integration guide") and Overview's menu.

1. **Header:** "Your app: Swift (macOS, iOS) · Change", preselected from the planned platforms and
   any sightings; only SDKs that fit the platforms are in the main row (SETUP §3.2).
2. **Add the SDK** (always first): two tabs. **One command** (default): `pkey sdk add swift
--product tonebox --expect <kid>@sha256:<fp>,…` run through the feed-routed `npx` (D17, D30).
   **By hand**: registry line, install line, the config file (Copy, Download) and the one-call boot
   snippet (SP-12/SP-20's `ui.boot` shape where the SDK has it). Pins come from the authenticated
   admin API, active plus staged signing keys and release keys (D16). The row at the foot waits for
   the first sighting: "Swift SDK 2.1.0 reached Polaris Key from macOS arm64, 12 s ago".
3. **One card per enabled feature**, canonical order. Each card has three parts:
   - **In the console** (prerequisite rows with status and a link to where the thing is done:
     "Publish catalog v1 · To do · Catalog →", "Set up publishing from CI · To do", "Create a test
     licence" as an inline L0 action that shows the key once);
   - **In your app** (the generated snippet for the chosen SDK: activate or gate, read a config
     value, check for updates, sign in, read and write a user setting; Ship builds shows the
     download page link and the storefronts entry instead of code when nothing app-side is
     needed);
   - **Verified** (the fact from T2, per platform).
4. **Done state:** once unlocked, a quiet line "Integration verified on macOS. iOS not seen yet."
   with **Hide Integration** (owner P6). Hiding removes the nav item and the Overview card; the
   page stays reachable.
5. **Off services** do not appear; an "Add a feature" row at the end links to the Services area.

The page uses the minimal wizard kit (T4) for its step rows and waiting rows, but it is a guide,
not a modal wizard: every card is visible and can be done in any order.

### T4. The New Product wizard

FLOWS §3, trimmed to what the owner asked for. Page-hosted at `#/products/new`:

| Step (for you)      | From a repository                                                                                                                                             | From scratch                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · Where it starts | Repository picker over W22 (paste still accepted); rows marked Has `.pkey/`, Already a product (opens it), No `.pkey/` yet (shows `pkey init` as one command) | "From scratch" card                                                                                                                                          |
| 2 · Check / Name it | W23 dry run: the product as it will be, problems by file and path, Create disabled until clean; a push re-check button                                        | Name, slug derived and checked (W24)                                                                                                                         |
| 3 · What it's for   | (read from the manifest; platforms confirmable)                                                                                                               | Goal cards → features (Licensing and Ship builds preselected, D20/F6), platform chips (`distribution.intendedPlatforms`), "Start with a free tier" switch on |
| ✦ Create            | One batch: product, key, catalog, services, Free tier, release-workflow trust policy when `release.yml` exists (F9, F13)                                      | Same, without the trust policy                                                                                                                               |

Create lands on **Integration**, not on an Overview hero. MO-11's existing "Product created"
moment plays there once. Dropped from FLOWS: the licence-defaults disclosure, accent swatches
(UX-76), the shared-element transition and burst (UX-75, UX-80), the `pkey/setup` pull request
(UX-70), "Ask a platform admin" (needs RBAC). The kit is a minimal `ui/wizard/` (page host, step,
`AutoList`, `WaitingFor`) over the existing `ui/Stepper.tsx`; the drawer host and the repo-change
step stay with the distribution audit's storefront wizards.

### T5. Overview, Home, the card and Products

- **Overview:** header (primary "Continue integration" until hidden, then the first enabled
  service's main action), attention, the **Integration card** (one line per feature with its
  state, "2 of 4 verified · Continue"), service tiles, recent activity. The Trust & SDK panel, the
  Setup checklist and the Welcome banner go; the signing key lives on Keys & secrets.
- **Home:** attention list, Platform ready for platform admins (UX-67, administration audit),
  product cards. Drop the "Linked to a repository" tile; keep Products and Need attention only if
  the administration audit wants counters (the attention list already says it).
- **Card (owner M1, M2):** header with logo, name (the card's one link) and slug; one row of
  service glyphs, each a link to that service's home, with a tone dot when it has an issue; no
  facts, no footer. Phone: name plus `ServiceDots`. Delete `useSummary`, `AdminSummary`,
  `ProductSummary`, `ledgerRows`, `serviceFact`, the summary handler and lib, its OpenAPI entry and
  its `routeCoverage` row.
- **Products table:** the "Setup" facet becomes **Integration** (Verified, In progress, Hidden)
  plus the existing attention facet; "Setup complete" disappears everywhere (D21).

### T6. Sidebar contexts

- **Platform context** (off any product): context header "Platform"; Home, Products, then the
  Platform pages (the administration audit orders them; Users and access from RBAC lands here).
  One-time pages (Override migration) render only while they have something to do (a `requires`
  feature flag on the nav row).
- **Product context:** context header with the product logo, name and the switcher (moved from
  the top bar into the sidebar head; "All products" and "Platform" are its first rows); then
  **Overview, Integration (until hidden), Devices, Users, Activity**, the enabled services'
  sections, and **Settings** last. Services, Presentation and Keys & secrets become areas of the
  ST-08 settings hub (Core nav 8 → 6 including Integration).

### T7. In-app docs and the docs site

- **One generator:** `@polaris-key/manifest` gains `renderSdkSetup(lang, ctx)` (UX-60) and
  `renderServiceSnippet(service, lang, ctx)`, with goldens in
  `packages/shared-manifest/test/fixtures/sdk-setup/` and each SDK's CI parsing its golden. Callers:
  the Integration page, `pkey sdk add` and `pkey sdk --lang`, the Godot dock (which then writes
  **one** artifact), and the docs site.
- **Docs render through it too:** the docs package adds `@polaris-key/manifest` as a dependency
  and an Astro component `<SdkSnippet lang service />` that calls the generator with a fixture
  context at build time. The quickstart pages stop hand-copying code, so no new generated-file
  family and no drift gate are needed.
- **The gate:** the site stays behind the console session (rule 11). When RBAC lands, the gate
  should admit any console role for `build/`, `services/` and `users/`, keeping `admin/` and
  `contribute/` for platform admins. That is the administration/RBAC audit's call and a security
  review item; this audit only needs the Integration page to be self-sufficient meanwhile.

### T8. What does not change

No signed document, `shared-protocol` type, `client-core`, corpus file or `PROTOCOL_VERSION`
changes anywhere in this design. Sightings read headers the SDKs already send; the integration
model, the hidden setting, create defaults and the service-table fields are admin routes,
settings and console UI. Gates that do apply: rule 3 (`gen:services`, `gen:settings`, action
bundle after the manifest rename), rule 9 (the `services` manifest spelling's mutation-table
entry), rule 10 (the integration route added, the summary route removed), the data-model
reference and `TABLE_OWNERS` for `sdk_sightings`, the THREAT-MODEL and PRIVACY data inventory.
**No package here is plan-mode.**

---

## Surface-area reduction

| Removed or merged      | From → to                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup surfaces         | Launch path (UX-21) + Connect your app (UX-61) + Licence/Config quick starts (UX-63) + signing/update/access setup (UX-64) + customer sign-in wizard (UX-65) + ready hero (UX-75) + today's checklist, Trust & SDK panel and Welcome banner → **one Integration page + one Overview card** |
| Setup data models      | `productSetupView.modules` (6 legacy modules) + `nextActions` + `onboarding` duplicate + the planned `setup_state` table and routes (UX-51) → **one integration read + one setting**                                                                                                       |
| Snippet generators     | console `sdkQuickStart.ts` + CLI `sdkConfig.ts` rendering + Godot `.tres` writer + hand-written docs quickstarts → **one generator** in `@polaris-key/manifest`                                                                                                                            |
| Godot config artifacts | `polaris_key.tres` + `polaris_key_config.gd` → **one**                                                                                                                                                                                                                                     |
| Service switches shown | 7 slug switches + registration (4 options) + Package feeds switch → **5 feature switches**; per-slug and registration under Advanced                                                                                                                                                       |
| Sub-capability homes   | Services page, Identity → Portal, Platform settings, edge-mint approvals, distribution settings → **nested rows of the service table** (display; their storage keys stay)                                                                                                                  |
| Create fields          | Licence defaults (offline grace, device limit), `compatMin/compatMax` on the API → **removed** (tiers and platform defaults own them; the window is `release.compatWindow`)                                                                                                                |
| Settings               | `core.adminGroup` (no effect) → removed or handed to RBAC; `products.branding_json` (never read) → dropped (ST-25)                                                                                                                                                                         |
| Routes                 | `GET /manage/api/summary` → **deleted**; `GET …/integration` added                                                                                                                                                                                                                         |
| Home                   | 3 stat tiles → at most 2 (or none); ledger card with facts → icon-row card                                                                                                                                                                                                                 |
| Product nav (Core)     | 8 items → 6 (Services, Presentation, Keys & secrets into the settings hub; Integration added, hideable)                                                                                                                                                                                    |
| Platform nav           | Override migration hidden when idle                                                                                                                                                                                                                                                        |
| Packages               | ~20 planned UX packages in this domain → **13 OB packages**, several of them S                                                                                                                                                                                                             |
| Backlogs               | EXPERIENCE/SETUP/FLOWS package tables + `workpackages.json` → **one backlog** (phase OB)                                                                                                                                                                                                   |
| Vocabulary             | manifest `modules` / `--modules` / "six services" / "Setup complete" → `services` / `--services` / seven services / "Integration verified"                                                                                                                                                 |

---

## Automation and onboarding

**What Polaris Key does without being asked**

- At create: mints and activates the signing key (D29); imports `.pkey/schema` as catalog v1;
  applies services from the manifest or the goals; creates the **Free tier** when Licensing is on
  and no tier exists (F6); trusts `.github/workflows/release.yml` on `v*` tags when the file exists
  (F9); reserves the Polaris Key storefront (`dl.plrs.im/<slug>`, S-21 defaults); records planned
  platforms (from the artifact map, the chips, or later W21 detection).
- On Integration: picks the SDK from platforms and sightings; reads pins from the admin API; offers
  the **test licence** as one L0 click (shown once, `OneTimeSecretPanel`); offers "Add
  `http://localhost:5173`" to web origins for web SDKs (ST-08's editor inline); completes every row
  from facts, so work done elsewhere (a tier made on Tiers, a catalog published from CI) ticks
  itself.
- For a linked repository: every push re-reads `.pkey/` (existing), so manifest problems shown in
  the wizard clear themselves on the next push.

**What stays a person's step** (SETUP D32): pushing `.pkey/` (or running `pkey init`), running the
app once, publishing the catalog (it reaches devices), pushing the first release tag, typed store
confirmations.

**Wizards and example code**

- New Product: 2 steps for you from a repository, 3 from scratch.
- Integration: one command, then run the app; per-feature snippets for every SDK in the generator.
- CLI twins (after UK-14): `pkey init` asks goals and platforms with the UK-14 prompt kit and writes
  `services`; `pkey sdk add <lang> --expect …` installs from `pkg.plrs.im`, writes the one config
  file and prints the boot snippet.

**Graceful degradation**

- A feature that is off has no Integration card, no nav section and one data-driven "Turn on"
  state (summary and capabilities from `tools/services.json`) if deep-linked.
- Identity with the platform provider needs no configuration, so the Sign-in card is all app-side
  unless the operator chooses their own issuer.
- No GitHub App installed: the wizard's repository card becomes "Install the Polaris Key app" with
  a waiting row; From scratch stays available.
- Sightings unavailable (a write failed, an old SDK without headers): Integration falls back to the
  domain facts (activations, sign-ins, downloads); nothing blocks.

---

## Migration, data and risk

| Change                                                       | Data                                                                                                                                                                           | Risk and mitigation                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk_sightings` table                                        | New Core table, migration `00XX_sdk_sightings.sql` (lead numbers it)                                                                                                           | Hot-path write: isolate-local dedupe, `waitUntil`, fail-open, bounded key space. Privacy: no IP, device id or licence; PRIVACY.md and THREAT-MODEL data inventory rows; 90-day prune. Data-model regen and `TABLE_OWNERS.core`.                                       |
| `core.integration.hidden`                                    | New registry key (product, operator-owned)                                                                                                                                     | `gen:settings` regen; `settings-coverage` test. Existing products start not hidden: a one-time backfill hides Integration for products that already have devices with an `sdk_name` (`devices.sdk_name`), so long-running products do not suddenly grow a setup page. |
| Service table `group` and `capabilities`                     | `tools/services.json`                                                                                                                                                          | `gen:services --check`; the SDK generators must ignore the new fields (verify output is byte-identical for the five SDK languages).                                                                                                                                   |
| Ship builds as one switch                                    | Console behaviour only                                                                                                                                                         | A product that runs Release without Distribution keeps it (Advanced shows the split); the switch turns all three on only when flipped. No `services_json` migration.                                                                                                  |
| Manifest `services` key                                      | Validator, JSON Schema, mutation-table entry (rule 9), `deprecated_spelling` warning for `modules` (ST-19's mechanism), action bundle rebuild (rule 3), `pkey init --services` | Both spellings accepted indefinitely; resync behaviour unchanged. Sequence after UK-14 (CLI `index.ts`).                                                                                                                                                              |
| Remove `GET /manage/api/summary`                             | Route, handler, lib, OpenAPI, `routeCoverage`                                                                                                                                  | Console-only consumer (`console/data/hooks.ts:49-57`). Layout-lint baselines and Home e2e fixtures re-recorded.                                                                                                                                                       |
| Drop `onboarding` and duplicate `modules` from `productView` | Admin API payload                                                                                                                                                              | Console-only consumers (`lib/products.ts:88-104`) move first. The admin API is session-only, so no external client depends on it.                                                                                                                                     |
| `core.adminGroup`                                            | Column, registry entry, manifest field                                                                                                                                         | Do not delete until the RBAC audit decides; until then mark it "no effect" in its description and hide it for manual products. If RBAC adopts it, it becomes the input of the "{Product} Admin" role mapping.                                                         |
| `products.branding_json`                                     | Column                                                                                                                                                                         | Dead; ST-25 drops the writes; the column can stay (SQLite) or be dropped with the next table rebuild.                                                                                                                                                                 |
| Create with defaults                                         | One batch grows (services, tier, trust policy)                                                                                                                                 | Keep F13's all-or-nothing batch; sequence after LX-08 (tier model, `core/registry.ts`) and HA-12 (`linkRepo.ts`, `resync.ts`, `core/products.ts`).                                                                                                                    |
| Sidebar contexts                                             | Shell only                                                                                                                                                                     | e2e and layout baselines; docsLinks unaffected unless pages rename; palette registry keeps routes.                                                                                                                                                                    |
| Wire                                                         | None                                                                                                                                                                           | If any package finds it needs an SDK-reported "verified" flag, it stops and goes through plan mode; the design deliberately uses 2xx on document routes plus domain facts instead.                                                                                    |

---

## Backlog changes

| id                         | action | target                                 | note                                                                                                                                                                    |
| -------------------------- | ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-21                      | merge  | OB-02, OB-04                           | The launch path becomes the Integration page's console-prerequisite rows and the Overview card; the Worker `setup` model becomes OB-02's integration read.              |
| UX-50                      | split  | OB-05                                  | Page host, step, `AutoList`, `WaitingFor` now; drawer host, `RepoChangeStep` and deep-link steps go to the distribution audit's storefront wizards.                     |
| UX-51                      | drop   | OB-02                                  | Product onboarding needs one hidden setting, not a wizard-state table; drafts stay in URL and sessionStorage. Storefront wizard state is the distribution audit's call. |
| UX-60                      | merge  | OB-03                                  | Expanded with `renderServiceSnippet` and the docs `<SdkSnippet>` component.                                                                                             |
| UX-61                      | merge  | OB-04                                  | Connect your app becomes the Integration page's first section.                                                                                                          |
| UX-63                      | merge  | OB-04, LX-29                           | Licence and Config quick starts become prerequisite rows; creating a licence is LX-29's New License wizard.                                                             |
| UX-64                      | split  | OB-04, release and distribution audits | Signing-key setup dropped (D29: never a step); Update feed scoping to the release audit; Access recommendation to the distribution audit.                               |
| UX-65                      | merge  | OB-04                                  | The Sign-in card; the editors stay in ST-12 and ST-14.                                                                                                                  |
| UX-66                      | edit   | OB-01                                  | The sweep stays; the service-off state becomes one data-driven component from the service table.                                                                        |
| UX-67                      | keep   | administration audit                   | Platform ready, on Home for platform admins.                                                                                                                            |
| UX-73                      | edit   | OB-06                                  | Drop the accent and the hero facts; keep services, planned platforms, Free tier, trust policy, one batch.                                                               |
| UX-74                      | edit   | OB-07                                  | Drop the setup pull request path, Ask a platform admin (until RBAC), motion; land on Integration.                                                                       |
| UX-75                      | drop   | OB-07                                  | No ready hero; MO-11's existing moment plays on Integration.                                                                                                            |
| UX-76                      | defer  | portal/presentation audit              | Accent and icon in create wait for one presentation store (HA-12, ST-14, ST-25).                                                                                        |
| UX-80                      | defer  | after OB-07                            | Flow motion once the wizard ships and is stable.                                                                                                                        |
| UX-81                      | keep   | —                                      | The flow lint covers New Product and Integration.                                                                                                                       |
| UX-12                      | keep   | —                                      | The attention model is the "broken" half that Integration deliberately is not; prerequisite for removing client-side `attentionFor`.                                    |
| UX-35                      | drop   | MO-11                                  | Delivered by MO-11.                                                                                                                                                     |
| UX-62                      | keep   | release audit                          | Linked from the Ship builds card.                                                                                                                                       |
| UX-70                      | defer  | —                                      | Onboarding uses One command until the GitHub write path exists.                                                                                                         |
| UX-53                      | edit   | OB-06                                  | `distribution.intendedPlatforms` (W5) lands with whichever of UX-53 and OB-06 merges first.                                                                             |
| P1-12                      | edit   | OB-03                                  | The Godot docs page and dock use the shared generator; one config artifact. Do not block the in-review branch: follow up in OB-11.                                      |
| F-10                       | keep   | —                                      | Prerequisite of OB-03 (lockstep install versions on `pkg.plrs.im`).                                                                                                     |
| X-01                       | defer  | —                                      | Any new SDK must add OB-03 goldens and an Integration column in the same package; F-32 stays coupled.                                                                   |
| X-02                       | defer  | —                                      | Same acceptance criterion as X-01.                                                                                                                                      |
| ST-08                      | edit   | OB-09                                  | The hub hosts Services, Presentation and Keys & secrets as areas so Core nav can shrink.                                                                                |
| ST-25                      | edit   | —                                      | Also retire `products.branding_json` writes and the `onboarding` payload alias if OB-11 has not.                                                                        |
| ST-22                      | edit   | RBAC audit                             | Decide `core.adminGroup`: role-mapping input or delete.                                                                                                                 |
| HA-12                      | keep   | —                                      | In flight (plan mode, wire). OB-06 rebases after it.                                                                                                                    |
| UK-14                      | keep   | —                                      | In a fix round: do not widen. OB-10 and OB-12 wait for its `cli/src/index.ts` rewrite.                                                                                  |
| LX-08                      | keep   | —                                      | In flight. OB-06 rebases after it (`core/registry.ts`).                                                                                                                 |
| UX-20, UX-22, UX-59, UX-72 | keep   | —                                      | Merged; OB-07 reuses `slugFromName`, `suggestSlug`, `repoOf`, `manifestSlugRefusal`, W22–W24.                                                                           |

---

## New work packages

| Id    | Title                                          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Deps                                                                                    | Plan mode | Size |
| ----- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------- | ---- |
| OB-01 | Service table: feature groups and capabilities | `tools/services.json` gains `console.group` and `capabilities[]`; `gen:services` emits them to the console only (SDK outputs byte-identical); the Services area renders five feature rows with nested capability switches written through `writeSetting`, per-slug switches and the registration policy under Advanced; Ship builds turns release, distribution and update on together; one data-driven service-off state for every service page (UX-66's component). | none (UX-22 merged); ST-05 optional                                                     | no        | M    |
| OB-02 | Integration facts and SDK sightings            | `sdk_sightings` (migration `00XX`), the router write (headers, service namespace, 2xx), the 90-day prune, `GET /manage/api/products/<slug>/integration`, the `core.integration.hidden` setting with its one-time backfill, OpenAPI and `routeCoverage`, data-model regen, THREAT-MODEL and PRIVACY rows.                                                                                                                                                              | OB-01 (feature grouping in the response)                                                | no        | L    |
| OB-03 | One snippet generator                          | `renderSdkSetup` and `renderServiceSnippet` in `@polaris-key/manifest` with goldens and per-SDK parse checks; console, `pkey sdk`, the Godot dock and the docs site's `<SdkSnippet>` all call it; quickstart pages rewritten onto the component; `sdkQuickStart.ts`'s init generator and the CLI's own rendering deleted.                                                                                                                                             | F-10; UK-14 merged; SP-12 and SP-20 (one-call boot shape)                               | no        | M–L  |
| OB-04 | Integration page and Overview card             | `console/pages/core/Integration.tsx`, nav and routes, palette entries; SDK picker; Add the SDK; per-feature cards (prerequisites, snippet, verification); inline test licence; Hide Integration after unlock; Overview's Integration card replacing TrustPanel, the checklist and Welcome; Devices' empty state links here.                                                                                                                                           | OB-02, OB-03, OB-05                                                                     | no        | L    |
| OB-05 | Minimal wizard kit                             | `ui/wizard/` page host, step, `AutoList`, `WaitingFor` over `ui/Stepper.tsx`; flow-lint fixtures.                                                                                                                                                                                                                                                                                                                                                                     | UX-10 (merged)                                                                          | no        | M    |
| OB-06 | Create with defaults                           | `POST /manage/api/products` and `…/link-repo` accept `services` (or goals), `intendedPlatforms`, `starterTier`, `trustReleaseWorkflow`; one batch; drop `compatMin/compatMax` from manual create; OpenAPI.                                                                                                                                                                                                                                                            | OB-01; LX-08 and HA-12 merged                                                           | no        | M    |
| OB-07 | New Product wizard                             | Rebuild `ProductNew.tsx` on OB-05: repository picker (W22), Check (W23) with problems and re-check, Name (W24), What it's for (goals, platforms, Free tier), Create, land on Integration with the "Product created" moment moved there from `Welcome.tsx` (MO-11's `Celebration`, once per product); licence defaults removed; Home, Products and ⌘K open its cards.                                                                                                  | OB-05, OB-06                                                                            | no        | L    |
| OB-08 | Simple product card and Home                   | Icon-row card with issue dots, phone `ServiceDots`; delete `GET /manage/api/summary` and its handler, lib, types, hooks, OpenAPI and `routeCoverage` rows; drop the "Linked to a repository" tile; Products facet relabelled.                                                                                                                                                                                                                                         | none                                                                                    | no        | S–M  |
| OB-09 | Platform and Product sidebar contexts          | Context header with the switcher in the sidebar; Platform context (Home, Products, Platform pages); product context (Overview, Integration, Devices, Users, Activity, services, Settings); `requires` flag hides idle one-time pages; Services, Presentation and Keys & secrets reached through the ST-08 hub.                                                                                                                                                        | ST-08 for the hub moves (nav can ship first); RBAC audit for Users and access placement | no        | M    |
| OB-10 | Services vocabulary and docs drift             | Manifest `services` key with `modules` as a deprecated spelling (validator, schema, mutation-table entry, action bundle), `pkey init --services`, docs fixes (`onboarding.md:36` and the services pages), glossary entries: Integration, SDK sighting, feature.                                                                                                                                                                                                       | UK-14 merged                                                                            | no        | S–M  |
| OB-11 | Legacy setup retirement                        | Remove `productView`'s `onboarding` and duplicate `modules`, `productSetupView`'s legacy modules and `nextActions` once UX-12 and OB-04 cover them; a slim list projection for `GET /manage/api/products`; delete `Welcome.tsx`, `TrustPanel`, `sdkQuickStart.ts`'s init half; one Godot config artifact; `products.branding_json` writes.                                                                                                                            | OB-02, OB-03, OB-04, UX-12                                                              | no        | M    |
| OB-12 | CLI twins: `pkey init` and `pkey sdk add`      | Interactive `pkey init` (goals, platforms → `services`) with UK-14's prompt kit; `pkey sdk add <lang> --expect …` (D30) installs from `pkg.plrs.im`, writes the one config file and prints the boot snippet.                                                                                                                                                                                                                                                          | UK-14, OB-03, OB-10                                                                     | no        | M    |
| OB-13 | Fold onboarding into the program               | Add phase OB to `workpackages.json` with briefs; mark merged, dropped and deferred UX rows in EXPERIENCE §13.3, SETUP §8.2 and FLOWS §4.2; pointer blocks at the top of SETUP §3–§5 and FLOWS §3 to this audit.                                                                                                                                                                                                                                                       | none                                                                                    | no        | S    |

---

## Quick wins

1. Fix `docs/src/content/docs/build/onboarding.md:36` ("The six service slugs", Cloud Sync
   missing).
2. Relabel the Products "Setup complete" facet (`Products.tsx:52-60`) to "No issues" until OB-02.
3. Devices' empty state (`Devices.tsx:277-282`): add a link to Overview's SDK quick start
   (`#sdk-quick-start`) beside the docs link.
4. Drop Home's "Linked to a repository" tile (`Home.tsx:283-287`).
5. Hide "Override migration" from Platform nav when the U-03 run is done and its 90-day report has
   lapsed (`nav.ts:807-818`, a `requires` flag).
6. Remove the "Advanced: license defaults" disclosure from `ProductNew.tsx:593-640`; tiers and
   platform defaults own those values.
7. Stop accepting `compatMin/compatMax` in manual create (`admin/handlers/products.ts:597-598`).
8. Mark `core.adminGroup` "has no effect today" in its registry description and hide the field for
   manual products until the RBAC audit decides.
9. Delete `productView`'s `onboarding` object after pointing `lib/products.ts:88-104` at `setup`
   and `modules` directly.
10. Revert the Home card to the icon row (OB-08 is small enough to be a quick win on its own).

---

## Cross-domain dependencies

- **Licensing audit:** the Free tier at create (OB-06) must use the cleaned-up tier model (tier
  → config profile, entitlements, limits); the Licensing card's snippet branches on the
  auto-mint mode (mint for everyone, by OIDC group, or reject), which decides between "activate
  a key" and "sign in"; LX-29 owns licence creation; registration policy may be subsumed by the
  auto-mint settings.
- **Release and distribution audits:** `distribution.intendedPlatforms` (W5) is shared with UX-53
  and gates storefronts by platform; the Ship builds card links Publish from CI (UX-62) and the
  storefront catalogue; the wizard kit's drawer host and storefront wizard state (UX-50 remainder,
  UX-51) are theirs; storefront auto-enable from existing credentials is theirs.
- **Commerce audit:** whether Commerce is a capability under Ship builds or something else; this
  audit recommends no new service slug.
- **Identity audit:** the Sign-in card's snippet (sign-in methods, device flow for CLI and TV);
  the customer portal capability; ST-14's single presentation and branding store.
- **Administration / RBAC audit:** the docs gate (rule 11) should admit product roles to `build/`,
  `services/` and `users/`; `core.adminGroup` repurposed or deleted; Users and access in the
  Platform context; Platform ready (UX-67); "Create product" as a permission and "Ask a platform
  admin" in the wizard; Platform settings ordering (ST-09).
- **Settings architecture (ST):** ST-08's hub must host Services, Presentation and Keys & secrets
  for OB-09; ST-05's generic write API simplifies OB-01's capability switches; ST-25 retires
  `products.branding_json`.
- **Presentation / portal audit:** three presentation stores (`products.branding_json`,
  `portal_product_settings.branding_json`, HA-12's `products.presentation_json`) should become one
  before accent-in-create (UX-76) is revisited.
- **SDK and UI-kit audits:** OB-03's goldens must match each SDK's public API (one-call boot from
  SP-12/SP-20, the kits' config input per SETUP D18); X-01/X-02 inherit the snippet obligation;
  UK-14 owns the CLI prompt kit OB-12 uses.
- **Cloud Sync audit:** the Cloud Sync card's verification fact (first write) depends on U-05's
  routes.

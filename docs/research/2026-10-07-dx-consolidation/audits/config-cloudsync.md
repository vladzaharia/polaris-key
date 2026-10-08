# Audit: Managed config (types, visibility, chain) and Cloud Sync

_DX consolidation, 2026-10-07. Tree read: `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5),
with the in-flight LX-08 branch (`/Users/vlad/Repos/pk-wt/LX-08`), UK-13, UK-14 and HA-12 checked for
overlap. Paths below are repo-relative. Line numbers are at that tree._

## 1. Summary

Config's core holds up under verification: one signed document (`pkey-config+jws`), a catalog
validator that interprets rather than compiles, a three-state management model
(`default | enforced | hidden`) that already is the owner's three visibility levels, and a client
resolution order pinned by the corpus. The friction is in the layers around that core.

- **The merge chain has 8 layers, and the brief wants 4.** Today it runs catalog defaults → tier
  profile → licence profiles (an ordered list) → store grants → licence overrides → OIDC grant
  (LX-08) → account overrides → device overrides. One layer is dead: nothing writes device
  overrides. Two layers are entitlements only. The licence layer is half-retired: a 3,037-line
  migration machine is built to retire it, and the brief's chain
  (`user > license > config profile > defaults`) now wants it kept.
- **Products with no licence have no place to put a product-wide secret.** The catalog default
  layer skips every kind but `config`. Profiles reach a device only through a tier. So a
  config-only product (D-08) cannot deliver a secret to every device.
- **A key is declared a secret in two different ways.** One is `kind: "secret"`; the other is
  `"secret": true`, a separate flag the skill tells authors to set as well. A minted token is
  declared twice: the catalog's `delivery: "edgeMint"` (which nothing reads) and a recipe in a
  different manifest file. The docs disagree on which file that is.
- **Entitlements are mixed into Config.** Flags are a catalog kind, profiles carry an
  `entitlements` bucket, and licensing policy (`channels`, `deviceLimit`, `license.tier`) is
  injected as if it were an entitlement.
- **The console re-implements the server merge in the browser, and gets it wrong.**
  `LicenseConfig.tsx` does not apply `merge.ts`'s lock rule the same way, so it shows the wrong
  inherited value whenever a higher layer sets a `default`-state value over a lower layer's lock.
- **Cloud Sync is mostly unbuilt.** What exists is the service descriptor, a settings slice of
  five pending entries, the catalog vocabulary, the scenario corpus and the reference state
  machine. No routes and no Durable Object exist yet. That makes now the cheapest moment to
  simplify its design:
  - three stores (settings, collections, saves);
  - four conflict vocabularies (15 values);
  - four sync scopes, three access classes and four `onAttach` modes;
  - nine limit settings;
  - 25 remaining work packages, several of which duplicate each other (U-12, PX-W11 and PX-18
    all build the same portal section).

**Recommended direction.** Make the chain five layers and make it the contract:

    catalog defaults → Default profile → tier profile → licence overrides → account overrides

Then cancel U-03's pending licence-override migration run, delete its machinery, and split
entitlements out to Licensing. For Cloud Sync, two stores are enough:

- **settings:** every editable config key, plus undeclared keys within limits, through the
  existing `config.set` / `config.setting` API;
- **records:** any record may carry a file, and saves become a template of records.

Cloud Sync then needs one conflict vocabulary, and its quota becomes an entitlement. These
changes need one plan amendment (U-01b) before U-05 starts.

**The single most important change:** cancel the U-03 run before its 30-day notice starts. The
run is irreversible: it drops the config and secret overrides of every floating licence, and of
OIDC licences that have no account. The new brief's chain no longer wants it.

## 2. Current state (with file references)

### 2.1 The catalog (`.pkey/schema`, `product_schema`, `GET /<p>/config/schema`)

- **Entry shape.** `packages/shared-catalog/src/types.ts:36-66` defines 20 top-level fields:
  - `key`, `kind` (`config | secret | flag`), `category`, `label`, `description`, `schema`;
  - `examples`, `default`, `secret?: boolean` (`:45`), `delivery` (`:49`), `managementDefault`
    (`:51`);
  - `userGrant` and `grantLabel` (`:53-54`, both entitlement presentation);
  - `ui` (10 hints, including `scopes: profile | license | device | user` at `:24`);
  - `dependsOn`, `appliesTo`, `accessor`, `deprecated`, `since`;
  - `user` (`:65`): `sync: user | platform | device | local`, `conflict: lastWrite | max | min | merge`,
    and `listed`.
- **Catalog-level `cloudSync` block** (`types.ts:97-158`):
  - collections, each with `access: owner | ownerRead | server`,
    `conflict: revision | lastWrite | merge | union` and
    `onAttach: keepCloud | keepLocal | merge | prompt`;
  - `open`;
  - saves, with `conflict: prompt | mostRecent | longestPlaytime | highestProgress`,
    `requiresFlag`, metadata, thumbnail and format;
  - migrations.
- **Validation.** `packages/shared-catalog/src/catalog.ts:51-144` interprets fragments (workerd
  forbids `Function`) and fails closed. The manifest validator
  (`packages/shared-manifest/src/index.ts:5291-5340`) allows `managementDefault` on `config`
  only and `delivery` on `secret` only. U-04 added Cloud Sync rules 1–11.
- **The only real product** (`products/djdl/catalog.json`) has 28 entries:
  - 17 `config`;
  - 6 `secret`, every one also marked `"secret": true`, and none declaring `delivery`;
  - 5 `flag`, four of which are licensing policy dressed as entitlements: `channels`,
    `app.minVersion`, `app.maxVersion` and `deviceLimit`.

  The product's edge-mint recipe `applemusic` (`products/djdl/product.json`, `edgeMint`) has
  **no** catalog entry at all.

### 2.2 Types, delivery and visibility as they exist

| Owner's term        | Today                                                                                                                                                                                                                                     | Where                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Regular config      | `kind: "config"`, in the document's `config` map                                                                                                                                                                                          | `packages/shared-protocol/src/config.ts:11-16`                                                                          |
| Secret              | `kind: "secret"` (`secrets` map, `getSecret`, never listed), **or** `kind: "config"` + `secret: true` (`config` map, redacted only in admin)                                                                                              | `packages/worker/src/admin/lib/managedSecrets.ts:36-39`, `packages/admin/src/schema/entry.ts:124`                       |
| Secret, server only | `delivery: "serverOnly"`: pruned before signing. **Nothing in the Worker consumes it** (the prune in `core/payload.ts:224-228` is its only reference)                                                                                     | `packages/worker/src/core/payload.ts:228`                                                                               |
| Edge-minted         | `delivery: "edgeMint"` on a secret entry: a "cue" no SDK reads. The real declaration is a recipe in `.pkey/product` `edgeMint[]` (or `.pkey/release`, or legacy), plus a product secret with usage `edge-mint`, plus an operator approval | `packages/worker/src/services/config/mint.ts:1-28`, `shared-manifest/src/index.ts:2287-2291`, SDK `mintToken(recipeId)` |
| Visible, changeable | `state: "default"`                                                                                                                                                                                                                        | `packages/shared-protocol/src/core.ts:103-121`                                                                          |
| Visible, read-only  | `state: "enforced"`                                                                                                                                                                                                                       | same                                                                                                                    |
| Invisible           | `state: "hidden"` (enforced, and not listed)                                                                                                                                                                                              | same; WIRE-CONTRACT-V4 §2.2.1 rule 4                                                                                    |

Management state is per value on every stored layer. The catalog's `managementDefault` seeds
it. The lock rule (`packages/worker/src/merge.ts:31-41`): a lower `enforced`/`hidden` entry is
never displaced by a higher layer's `default`-state entry, and its **value** is kept.

### 2.3 The merge chain (Core, `packages/worker/src/core/payload.ts:153-197`)

| #   | Layer                         | Buckets                                       | Source                                                                         | Notes                                                                                                                                                             |
| --- | ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Catalog defaults              | config only                                   | `catalogDefaultPayload` (`:76-102`)                                            | Secrets and flags never get a default, so a product-wide **secret** has no home on a licence-less product                                                         |
| 2   | Tier profile                  | config, secrets, entitlements                 | `tiers.profile_id` (`:166-172`)                                                | Requires a licence                                                                                                                                                |
| 3   | Licence profiles (ordered)    | config, secrets, entitlements                 | `license_profiles` (`:174-179`)                                                | Edited in `CreateLicenseDialog.tsx` and `LicenseTerms.tsx`                                                                                                        |
| 4   | Store grants                  | entitlements                                  | `storeGrantLayer` (`:183`)                                                     | Licensing                                                                                                                                                         |
| 5   | Licence overrides             | config, secrets (until the run), entitlements | `licenseOverrideLayer` (`:111-131`)                                            | Config and secrets stop being read once `licenseConfigOverridesRetired`                                                                                           |
| 5b  | OIDC grant (LX-08, in flight) | entitlements                                  | `oidcGrantLayer` (LX-08 `core/payload.ts`)                                     | Licensing                                                                                                                                                         |
| 6   | Account overrides (U-03)      | config, secrets                               | `accountOverrideLayer`, `overrideSubject` = signed-in subject ?? licence owner | `packages/worker/src/core/accountOverrides.ts:1-33`                                                                                                               |
| 7   | Device overrides              | all                                           | `devices.overrides_json` (`:195`)                                              | **No writer anywhere.** Only carried forward on re-register (`core/devices.ts:427, 577`), and not in the KEK re-seal sweep (`admin/handlers/products.ts:718-723`) |

After the merge:

- **License** injects its policy as entitlements (`core/entitlements.ts:182-221`: `license.tier`,
  `license.tierLabel`, `channels`, `deviceLimit`).
- **Config** prunes the payload against the catalog (`payload.ts:212-239`) and signs it
  (`services/config/document.ts:105-191`).

### 2.4 The licence-override migration (U-03, done; run pending)

- **What is built:**
  - `packages/worker/src/core/overrideMigration.ts`, 1,387 lines: the state machine
    (prerequisite flags → 30-day notice → run → freeze → 90-day report → nightly sweep);
  - `admin/handlers/overrideMigration.ts`, 352 lines: seven platform routes;
  - `packages/admin/src/console/pages/platformOverrideMigration.tsx`, 1,183 lines;
  - `license/OverrideMigrationNotice.tsx` (76 lines) and `data/overrideMigration.ts` (39 lines);
  - the licence page's four phase banners (`license/LicenseConfig.tsx:23-37`, `:200-260`);
  - tables `override_migration` and `override_migration_report`
    (`migrations/0103_account_overrides.sql:49`, `:84`);
  - RUNBOOK §"Licence override migration (U-03)" (`docs/RUNBOOK.md:1463`).
- **Current state.** Until the run, both layers are read (the expand phase), in the order
  `licence → account`. That is already the brief's `user > license`.
- **What the run would do.** It drops the config and secret overrides of every unowned
  licence, and collapses owned licences' per-licence values into one account value
  (S-17 §5.12 steps 2–3).
- **Provisioned secrets.** The OIDC provisioning writer switches its target from the licence to
  the account "from the run's start" (`core/accountOverrides.ts:309-373`).

### 2.5 Profiles

- A profile is a `ManagedPayload` with `config`, `secrets` and `entitlements`
  (`services/config/admin/profiles.ts:1-14`; docs `services/config/profiles.md`).
- **Authoring.** `.pkey/product` root `profiles`, or `licensing.profiles`
  (`shared-manifest/src/index.ts:1597-1598`). The settings registry records the second as the
  path (`services/config/settings.ts:52`).
- **Reach.** A profile reaches a device only through a tier, or through a licence's ordered list.
  SETUP.md §4.2 (UX-63) plans a "Default" profile created at the first catalog publish, but only
  as a tier baseline: a config-only product still could not use it.

### 2.6 Client resolution and SDK APIs

- **Contract.** `enforced | hidden > local > env > remote default > fallback`
  (WIRE-CONTRACT-V4 §2.2.1 [C], pinned by `config-matrix.json`;
  `packages/client-core/src/config.ts:1-12`, `:271-319`).
- **`config.local` exists in all six SDKs** (parity row `config.local`, SP-13, SP-18, SP-24):
  - Node: `config.set`, `clear`, `setting(key)`, `onConfigChange`
    (`packages/sdk-node/src/config/client.ts:226-290`), persisted to `local-config.json`;
  - Python: `set`, `clear`, `setting`, `on_change`
    (`sdks/python/src/polaris_key/config/client.py:148-197`);
  - Swift: `LocalConfigStore`;
  - Kotlin: `ConfigLocalTest`;
  - Godot: `PKeyConfigFileStore`.

  The parity note says these names were chosen "so U-06 and U-20 add sync state under the same
  API" (`conformance/parity/features.json`, `config.local`).

- **Secrets and mint.** Secrets come from `getSecret(key)`; browsers never receive them (`config.secret` is
  `allowedNa` on web and the desktop bridge). Minting is `mintToken(recipeId)`, keyed by recipe
  id rather than catalog key (`packages/sdk-node/src/config/mint.ts`). The terminal kits (UK-14)
  expose `config list|get|set|reset`, `secret <key>` and `mint <recipeId>`.

### 2.7 Cloud Sync

- **Built:**
  - the service row `sync` (`tools/services.json`: default off, `requires: [config, identity]`);
  - the descriptor, which answers no routes (`packages/worker/src/services/sync/index.ts:27-45`);
  - a settings slice of five entries, all `pending: U-05` (`services/sync/settings.ts:31-158`):
    `cloudSync.limits`, `.limits.byTier`, `.limits.byEntitlement`, `.unlicensed` and `.writes`
    (`requireLicense`, `minTrust`);
  - the vocabularies, ceilings and defaults (`packages/shared-catalog/src/cloudSync.ts:17-174`);
  - the console's read-only Cloud Sync → Data page (`packages/admin/src/console/pages/sync/SyncData.tsx`);
  - catalog form controls for the `user` block (`config/CatalogEntryForm.tsx:48-62`, `:790-840`);
  - the reference state machine (`packages/client-core/src/cloud-sync.ts`, 1,347 lines);
  - the scenario corpus (`conformance/corpus/v2/sync-scenarios.json`, `syncScenariosVersion: 1`,
    35 scenarios; none uses the `device` scope or `onAttach`);
  - the principal (U-02, `resolveSyncPrincipal`) and the subject-store registry guard
    (`core/subjectHooks.ts:18-60`).
- **Planned** (`program/plans/U-01.md`, approved 2026-10-05):
  - one SQLite Durable Object per `(product, subject)`;
  - push and pull under `/<p>/sync`, with HLC and last-write-wins for settings, CAS, OR-set and
    per-field merge for records, and saves as R2 blobs with revisions;
  - `403 account_required` for devices with no principal;
  - quotas from `limits`, `byTier`, `byEntitlement` and `unlicensed`;
  - three per-product ceilings and a platform `writesPaused`.
- **Backlog.** 25 U packages are open, about 20–29 engineer-weeks, plus PX-W11 and PX-18 for
  the portal and ST-16 for the ceilings.

### 2.8 Console and portal surfaces

- **Config section** (`packages/admin/src/console/nav.ts:411-461`):
  - Catalog: `CatalogPage.tsx` (698 lines), `CatalogEditorPage.tsx` (952) and
    `CatalogEntryForm.tsx` (920), with a "Grant to the user" flag control at `:499`;
  - Profiles: `ProfilesPage.tsx`, `ProfilePage.tsx`, `profileActions.tsx`;
  - Edge mint: `EdgeMintPage.tsx`, 796 lines.
- **Elsewhere in the console:**
  - signing keys for minting live in Core → Keys & secrets (`core/KeysSecrets.tsx`);
  - a licence's config values are on its Config tab (`license/LicenseConfig.tsx`);
  - a person's values are on Users → record → account overrides (`core/accountOverrides.tsx`);
  - Platform → Override migration.
- **Cloud Sync section**: one page, Data (`nav.ts:720-737`).
- **Portal**: the product page's Cloud Sync section is specified in PORTAL.md §4.20 and
  reserved by I-11. **Three packages** build it: U-12, PX-W11 and PX-18. Each of their briefs
  defers ownership to "whichever lands first".

## 3. Problems (ranked)

1. **The brief's chain conflicts with an irreversible pending migration (high).**
   - The brief says `user > license > config profile > defaults` and wants licences to "still
     override things".
   - U-03 built a run that permanently removes licence-level config and secrets, dropping
     floating licences' values outright: `core/overrideMigration.ts:22-35`, step 3 of S-17 §5.12.
   - Its U-03 commit records the extra cost to OIDC licences with no account.
   - It is about 3,000 lines of code and two tables, for a result the brief no longer wants.
   - Once run, the data is gone.
2. **Cloud Sync's design carries far more surface than the brief asks for (high).**
   - Three stores, four conflict vocabularies (15 values), four sync scopes, three access
     classes plus one reserved, and four `onAttach` modes (`shared-catalog/src/cloudSync.ts:17-62`).
   - Nine limit and access settings (`services/sync/settings.ts`; U-01 §3).
   - 25 open packages.
   - All of it is still unbuilt, so cutting it now costs a plan amendment rather than a rewrite.
3. **A licence-less product cannot deliver a product-wide secret or value (high).**
   - `catalogDefaultPayload` keeps only `kind: config` (`core/payload.ts:91`), and profiles need
     a tier (`:166-179`).
   - The Config docs still promise that "a product that runs Config without License gets all of
     this" (`packages/docs/src/content/docs/services/config/index.md:19`).
4. **Entitlements are mixed into Config at four points (high, shared with Licensing):**
   - catalog `flag` kind plus `userGrant` / `grantLabel` (`types.ts:9`, `:53-54`; console
     "Grant to the user");
   - each profile's `entitlements` bucket;
   - licensing policy injected as entitlements (`core/entitlements.ts:200-221`);
   - LX-14's plan to add `combine` and `entitlementKind` to Config's catalog entry form
     (EXPERIENCE.md:766).
5. **The console's merge disagrees with the server (high, correctness).**
   - `resolveInherited` (`console/pages/license/LicenseConfig.tsx:102-130`) keeps the **higher**
     layer's value under a lower lock.
   - `mergeMap` (`packages/worker/src/merge.ts:31-41`) keeps the **lower** locked entry's value.
   - So when a profile enforces `run.concurrency = 6` and a licence profile sets `default 3`, the
     console shows "3 (Enforced)" while devices receive 6. The console's copy of the merge also
     omits store grants and the OIDC grant, and cannot see account overrides.
6. **The device override layer is dead (medium).**
   - It is merged last (`payload.ts:195`) but has no writer, no console and no route.
   - It is not in the KEK re-seal list (`admin/handlers/products.ts:718-723`), so any sealed
     secret ever stored there would silently break after a KEK rotation.
7. **Edge-minted secrets are declared twice, and one declaration is dead (medium).**
   - `delivery: "edgeMint"` has no consumer: the SDKs mint by recipe id, and djdl's only recipe
     has no catalog entry.
   - The recipe can live in three manifest locations (`shared-manifest/src/index.ts:2287-2291`).
     ADMIN.md §6.6.4 and the edge-mint docs (`edge-mint.md:36`) say `.pkey/release`, while
     products use `.pkey/product`.
   - Setup takes four steps across three console pages: recipe, product secret with
     `edge-mint` usage, approval, catalog entry.
   - The recipe set is a separate setting (`config.edgeMint.recipes`, `services/config/settings.ts:59-79`).
8. **A secret is marked in two places, and one delivery mode is dead (medium).**
   - `kind: "secret"` plus `secret: true` (`types.ts:45`); the skill tells authors to set both
     (`.claude/skills/adding-a-catalog-entry/SKILL.md`).
   - `kind: config, secret: true` is a third, half-secret state: redacted in admin, but delivered
     in the `config` map where `getConfig` and settings lists can read it.
   - `delivery: "serverOnly"` has no consumer.
9. **The Cloud Sync SDK briefs would add duplicate APIs (medium).**
   - U-06, U-20, U-07 and U-21 promise `setConfig`, `clearConfig`, `settingState` and `onChange`
     (U-01 §5; U-06 title).
   - They claim "both SDKs today take a fixed table with no setter"
     (`wp/U-06-sdk-settings-node-python.md:27`).
   - But `config.set`, `config.clear`, `config.setting` and `onConfigChange` already ship in all
     six SDKs, and the parity note reserves them for sync.
10. **Three packages own one portal section, and their briefs contradict each other (medium).**
    - U-12, PX-W11 and PX-18 each claim the Cloud Sync section.
    - PX-W11 says Cloud Sync "depends on the account and the license, not on Identity"
      (`wp/PX-W11-cloud-sync-api.md:21`), contradicting U-01 §0, PORTAL.md:272 and
      `services/sync/index.ts`.
11. **Privacy is split from the stores that hold the data (medium).**
    - U-10 and U-09 send export and deletion of saves and records to U-24a and U-24b.
    - That leaves a window where a person's data exists but is neither exported nor deleted.
    - U-02's registry guard (`core/subjectHooks.ts:46-60`) already requires every DO-backed store
      to export and delete.
12. **Licences can attach an ordered list of profiles (medium).** This is a fourth way to shape
    one licence's config, next to its tier, its overrides and its account. The brief wants one
    profile per tier.
13. **Cloud Sync access policy duplicates other systems (medium).**
    - `writes.minTrust` duplicates the Core device-trust policy that already gates edge-mint and
      gated delivery (THREAT-MODEL:5051).
    - `byTier`, `byEntitlement` and `unlicensed` duplicate what entitlements express.
    - `ownerRead`/`server` collections and `inc` overlap the brief's consumable IAPs with
      redemption status, which are Licensing.
14. **Small docs and spec drift (low):**
    - "Config is one of the six opt-in services" (`services/config/index.md:8`); there are seven;
    - profiles are authored under `licensing.profiles`;
    - the console's "Data" page name clashes with the Users → Data tab (U-11a);
    - the catalog `ui.scopes` still offers `device`.
15. **The `device` sync scope has no use (low).** It stores per-device values on the server, but a
    reinstall gets a new device id and cannot recover them, so it fails the brief's "restore the
    session from any instance". The corpus never uses it.
16. **Live pokes, the developer backend API, receipts, end-to-end encryption and public
    collections (U-14, U-16, U-17) sit in the U graph (low).** They are marked optional but still
    shape U-09's access classes.

## 4. Owner brief: item-by-item stance

| #   | Brief item                                                                                       | Stance                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Configuration is mostly good as is … mostly a verification layer"                               | **Adopt**                    | The signed document, the validator and the states are sound. Verification found the concrete gaps in §3 (dead layer, duplicate markers, a dead annotation, the licence-less secret gap, the console merge bug). Each fix is small and none changes the wire                                                                                                                                                                                 |
| 2   | Three types: regular, secret, edge-minted                                                        | **Adapt**                    | They map to `config`, `secret` and secret with `delivery: edgeMint`. Make "Minted token" first-class in the console and docs by putting the recipe _inside_ its catalog entry. Keep the served JSON's `kind` values, so `enums.json` and the SDK constants don't change (§5.4)                                                                                                                                                              |
| 3   | Secret: write-only management, read-only runtime                                                 | **Adopt**                    | Already true (redacted admin reads; `getSecret`). Add the missing product-wide home, the Default profile (§5.2). Retire `kind: config` + `secret: true` and the unconsumed `serverOnly`                                                                                                                                                                                                                                                     |
| 4   | Edge-minted: no management, read-only runtime                                                    | **Adapt**                    | The _value_ is unmanaged, but the recipe, its signing key and its approval are managed (P0-12 must stay). One declaration in the catalog, one drawer in the console, and a console-created recipe approved on save                                                                                                                                                                                                                          |
| 5   | Each type × three visibility levels                                                              | **Adapt / push back**        | Visibility is real for **settings** (`default`, `enforced`, `hidden`), relabelled in the console as Editable, Read-only and Hidden. Push back on the 3×3 matrix: a user-changeable secret contradicts item 3 (a user's own credential is a password-widget setting); listing a secret read-only would change WIRE-CONTRACT §2.2.1 rule 4 (a corpus change) for no gain; a minted token is always a code-only value. 9 cells become 5 (§5.1) |
| 6   | "Secrets delivered securely to users such as API keys"                                           | **Adopt, with a caveat**     | A secret rides the signed document into a `0600` cache and never reaches browsers. For third-party API keys the secure default is a minted short-lived token, so console copy and the catalog template steer there                                                                                                                                                                                                                          |
| 7   | "All config entries should be syncable using Cloud Sync"                                         | **Adopt (adapted)**          | Every _editable_ setting becomes a synced user setting by default; the `user` block becomes optional fine-tuning. Locked settings, secrets and minted tokens are server-authoritative and already the same on every instance, so there is nothing to sync                                                                                                                                                                                   |
| 8   | Tiers associate a config profile they cannot override                                            | **Adopt**                    | A tier carries `profileId` only (true today). Tier entitlements move to Licensing. Licences lose their profile lists (§5.2)                                                                                                                                                                                                                                                                                                                 |
| 9   | Config chain `user > license > config profile > defaults`                                        | **Adopt, precisely**         | Five server layers: catalog defaults → Default profile → tier profile → licence overrides → account overrides. Under them, the client order is lock > the person's own choice > env > remote default. **Cancel U-03's run**, keep licence config overrides, delete the migration machinery, drop the dead device layer (§5.2)                                                                                                               |
| 10  | Licensing metadata `license > tier > defaults`                                                   | **Defer to Licensing**       | Not Config's; the cross-domain dependency is noted in §12                                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | Entitlements split out of Config                                                                 | **Adopt**                    | Flags, `userGrant`, profile entitlements and the policy-as-entitlement injection leave Config. Licensing owns the declarations and the resolver (CFG-06 with LX-09 and LX-14). The served catalog keeps flag rows read-only for one deprecation window so the kits don't break                                                                                                                                                              |
| 12  | Cloud Sync: "all config entries, managed and unmanaged"                                          | **Adopt**                    | Declared settings, plus **open settings** (undeclared keys a developer `config.set`s) within the 256-key / 64 KiB budget. Operator-managed per-person values already roam through the account layer                                                                                                                                                                                                                                         |
| 13  | Cloud Sync: "assets, session state, etc. needed to rehydrate a session"                          | **Adapt**                    | One records store in which any record may carry a **file**. Saves become a template (a `saves` collection) and session state a `session` collection template. Developer content packs stay with Release                                                                                                                                                                                                                                     |
| 14  | Conflict handling                                                                                | **Adopt, simplified**        | One vocabulary for settings and records: `lastWrite`, `max`, `min`, `merge`, `union`, `revision`. `revision` surfaces a conflict to the app or kit. `onAttach` is dropped, because the first sign-in is an ordinary sync with original clocks and versions                                                                                                                                                                                  |
| 15  | "Anything else important to sync"                                                                | **Adapt**                    | Add per-device last-sync state (the portal needs it) and a product description line. Defer live pokes, server-authoritative and public collections, end-to-end encryption and the developer backend (U-14, U-16, U-17)                                                                                                                                                                                                                      |
| 16  | SDK access to Cloud Sync "using existing conventions like managed configs … not duplicate logic" | **Adopt, strongly**          | Settings go through the shipped `config.set`, `config.setting` and `onConfigChange`, gaining `syncState`. Records go through `cloudSync.collection(name)` handles shaped like `setting()` handles. Drop the U-06 family's `setConfig`/`clearConfig` names                                                                                                                                                                                   |
| 17  | Entitlements include feature enablement "like cloud sync"                                        | **Adopt**                    | The Cloud Sync quota becomes the reserved entitlement `pkey.cloudSync.bytes` (`combine: max`, inside LX-05's reserved `pkey.*` prefix), with a two-number product default. This replaces `byTier`, `byEntitlement`, `unlicensed` and `writes.requireLicense`                                                                                                                                                                                |
| 18  | Floating licences are valid with no account services                                             | **Adopt**                    | With the run cancelled, a floating licence keeps per-licence config. It gets no account layer and no Cloud Sync. Consistent                                                                                                                                                                                                                                                                                                                 |
| 19  | Consent to share data, Cloud Sync included                                                       | **Adopt (Identity owns it)** | The Cloud Sync consent line is the sign-in confirm step's (PORTAL.md:891); Cloud Sync needs no new consent mechanism                                                                                                                                                                                                                                                                                                                        |
| 20  | General: reduce the configuration surface, onboarding wizards, automation, graceful degradation  | **Adopt**                    | See §6, §7 and §5.7                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —   | Should Cloud Sync fold into Config as a feature? (implied by the brief's heading)                | **Push back**                | Records and files are not config, and the service has its own cost and quota model, console section and kill switch. Keep the service, keep `requires: [config, identity]`, and keep the console's turn-on chain (UX-22) that enables both with one switch                                                                                                                                                                                  |

## 5. Target design

### 5.1 Config types and visibility

| Type (console)   | Catalog JSON (unchanged on the wire)                                   | Runtime read                                     | In-app visibility                                                                                                                                        | Managed by                                                                  | Syncs?                                |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| **Setting**      | `kind: "config"`                                                       | `config.get` / `config.setting(key)`             | **Editable** (`default`), **Read-only** (`enforced`) or **Hidden** (`hidden`): the catalog's `managementDefault` sets the default and any layer may lock | Catalog default and every chain layer                                       | Editable ones: yes, by default (§5.5) |
| **Secret**       | `kind: "secret"` (`delivery` omitted, meaning `clientScoped`)          | `getSecret(key)`; never on web                   | Always hidden from settings lists; the app may show what it likes                                                                                        | Write-only, in the Default profile, a tier profile, a licence or an account | No: server-authoritative              |
| **Minted token** | `kind: "secret"`, `delivery: "edgeMint"`, **`mint: {…}`** (the recipe) | `mintToken(key)` (CFG-08 adds `getSecret` sugar) | Always hidden                                                                                                                                            | Recipe in the catalog, signing key, approval                                | No                                    |

**Retired:**

- `secret: true`: a warning, then ignored on `kind: secret`. On `kind: config` it warns
  "use kind secret", and `pkey migrate` converts the entry, accepting the SDK read change.
- `delivery: "serverOnly"`: a warning while nothing consumes it. Worker-consumed secrets live
  in product secrets (Keys & secrets).
- `ui.scopes: device`.
- `userGrant` and `grantLabel`: these move to Licensing.

No `ConfigKind` is added or removed in the served JSON. `conformance/parity/enums.json`,
`gen:constants` and every SDK stay untouched.

### 5.2 The config chain (the contract)

**Server merge**, Core's `resolveMergedPayload`, for `config` and `secrets` only. Entitlements
move to Licensing's resolver.

| #   | Layer                 | Who writes it                                          | Applies to                                                                                           | Notes                                                                                                                                                                                                                   |
| --- | --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Catalog defaults**  | the repo (`.pkey/schema`) or a console catalog edit    | every device                                                                                         | `config` kind only (a repo never holds secrets)                                                                                                                                                                         |
| 2   | **Default profile**   | the console, or `.pkey/product` `profiles[id=default]` | every device, licence-less included                                                                  | **New as a layer.** Reserved id `default`, created with the product. This is the product-wide home for secrets and values, and it closes problem 3. Empty for existing products, so their documents stay byte-identical |
| 3   | **Tier profile**      | the tier's `profileId`                                 | devices whose licence is on that tier                                                                | Exactly one profile per tier. Licence profile lists are removed                                                                                                                                                         |
| 4   | **Licence overrides** | the console (License → record → Config)                | every device of that licence, floating ones included                                                 | **Stays** (cancel the U-03 run). Holds `config` and `secrets` only; entitlement overrides are Licensing's                                                                                                               |
| 5   | **Account overrides** | the console (Users → record), OIDC provisioning        | devices signed in to the account; key-entry devices of licences the account owns (U-03's owner line) | As built. Provisioned secrets always land here (an identity's claims are per person)                                                                                                                                    |

Device overrides are removed from the merge. The column stays unread and is dropped by a later
contract migration once production holds no non-null rows.

**Client resolution** (WIRE-CONTRACT-V4 §2.2.1, unchanged):

1. **A lock wins.** The value of the highest layer that set the key with `enforced` or
   `hidden`, applying `merge.ts`'s rule that a higher `default` never displaces a lower lock.
2. Otherwise, **the person's own choice**: the `local` slot, now persisted and, with Cloud Sync,
   synced.
3. Otherwise, the **environment** (desktop hosts).
4. Otherwise, the **highest server layer's default value**.
5. Otherwise, the **fallback**.

Both readings of the brief's "user (if set)" hold:

- an operator's per-person value (layer 5) beats licence and profile;
- the person's own choice beats every unlocked server value.

**The console never re-derives this.** CFG-03 adds one admin read that returns each key's
effective value, its state, the layer it came from and, when it applies, the layer that locks
it. The License Config tab, the Users Data tab (U-11a), a profile's Used-by tab and the catalog
key drawer all render it. The browser copy in `LicenseConfig.tsx`, and its bug, are deleted.

### 5.3 Entitlements leave Config (with Licensing)

- **Catalog.** `flag` entries are authored in Licensing's declarations, at the location the
  Licensing audit decides. During the deprecation window `/config/schema` keeps serving them
  read-only, because the Godot `pkey_entitlement_badge.gd:40-47` and Swift
  `LocalConfig.swift:107` read `userGrant`.
- **Profiles.** A profile holds `config` and `secrets` only. CFG-06's migration moves today's
  profile `entitlements` onto the tiers that use the profile, and licence-attached ones into
  licence entitlement overrides.
- **Console.** The Config editors stop listing flags, as `accountOverrideCatalog` already does
  (`packages/admin/src/console/pages/core/accountOverrides.tsx:47-54`). LX-14's `combine` and `entitlementKind` go to Licensing's
  editor, not `CatalogEntryForm.tsx`.
- **Cloud Sync.** `requiresFlag` becomes `requires: <entitlement>`.

### 5.4 Minted tokens carry their recipe

**Catalog form:**

```jsonc
{
  "key": "applemusic.token",
  "kind": "secret",
  "delivery": "edgeMint",
  "category": "Integrations",
  "label": "Apple Music developer token",
  "description": "",
  "schema": { "type": "string" },
  "mint": {
    "id": "applemusic",
    "alg": "ES256",
    "signingKeySecret": "EDGE_MINT__DJDL__APPLEMUSIC",
    "kid": "KEYID00000",
    "claims": { "iss": "TEAM000000" },
    "ttlSeconds": 3600,
  },
}
```

- **Ingest.** Ingest writes `edge_mint_config` from catalog entries. The table and the approval
  rule stay unchanged (`core/edgeMintApproval.ts`), so every P0-12 property holds. `edgeMint[]`
  in `.pkey/product` and `.pkey/release` is still read for one deprecation window, then
  converted by `pkey migrate`. The `config.edgeMint.recipes` setting folds into `config.catalog`.
- **Console.** Minted rows in Catalog show:
  - an approval pill (Approved / Needs approval / Changed since approval);
  - **Approve…**, the existing diff drawer;
  - **Set signing key…**, which creates the product secret with usage `edge-mint` itself.

  The Edge mint nav item and its 796-line page are retired.

- **Approval.** A recipe the operator creates or edits _in the console_ is approved on save,
  under step-up. The approval exists to stop repository writers, and an operator acting in the
  console is the approval. A repository-authored recipe still waits for approval.
- **Discovery.** It keeps `mint.available` only. Recipe ids are never published.

### 5.5 Cloud Sync, consolidated (U-01b amends U-01)

**Two stores on one principal**, the account × product as its pairwise subject. Sign-in is
required, unchanged.

1. **Settings.**
   - **Which keys sync.** Every catalog `config` key that a person can change, meaning no layer
     locks it. The `user` block becomes optional:
     - `sync: user` (default) or `platform` or `local`; `device` is removed;
     - `conflict: lastWrite` (default), `max`, `min` or `merge`;
     - `listed` (default true; false for app state such as window geometry).
   - **Open settings.** Undeclared keys are accepted within the per-person budget: 256 keys,
     8 KiB per value, 64 KiB in total. They are schema-less and last-write-wins.
     `cloudSync.settings.open` defaults to true.
   - **Unchanged:** the HLC, push rules 1–8 and first-sign-in upload with original clocks.
2. **Records**, in declared collections.
   - **Declaration:** `{name, label, conflict, schema?, maxRecords?, files?: {maxBytes, keepRevisions}, requires?}`.
   - **Any record may carry one file**, uploaded and stored in R2 the way U-01 §2.7 describes
     for saves (begin, `PUT`, finalize, sha256, per-principal data key, revisions, GC alarm).
   - **Saves are a template:** a `saves` collection with `files` and a metadata schema
     (`playtime`, `progress`, `chapter`, `thumbnail`). Their policies map onto the shared
     vocabulary:
     - `prompt` → `revision`;
     - `mostRecent` → `lastWrite`;
     - `longestPlaytime` → `max` on `playtime`;
     - `highestProgress` → `max` on `progress`.
   - **Session state is a template too:** a `session` collection.
   - **Access is `owner` only at launch.** The console may write on a person's behalf (support).
     `ownerRead`, `server` and `public` are deferred with U-16 and U-17. Server-authoritative
     currency is Licensing's consumable entitlements, not records.

**One conflict vocabulary**, `lastWrite | max | min | merge | union | revision`:

- Settings use the first four. Records use all six; `max` and `min` may name a metadata field.
- `revision` raises `cloudSync.onConflict` with both sides and metadata; the kits' conflict
  prompt is U-08's prompt, generalised.
- The first sign-in is an ordinary sync. `onAttach` is removed, and the pull's `empty: true`
  lets an SDK upload silently.

**Quota as an entitlement:**

- `cloudSync.quota = {licensed, unlicensed}` (product, claimable). The defaults are 256 MiB and
  1 MiB; 0 means no Cloud Sync for people without a licence.
- A person's quota is `max(product default, entitlement pkey.cloudSync.bytes)`, clamped to the
  platform ceiling. Tiers and IAP grants raise it through Licensing.
- With License off, everyone counts as licensed.
- Sub-limits are platform constants: settings as above, a 64 KiB record, 1 GiB per file.
- `writes.minTrust` becomes a row of Core's device-trust policy, beside edge-mint and gated
  delivery.
- The operator side has one per-product ceiling (`cloudSync.ceiling.bytes`, ST-16) and the
  platform `cloudSync.writesPaused`. The user-count and pushes-per-second ceilings are fixed
  constants until a product needs them raised.

**SDK API.** It reuses `config.local`, and the scenario corpus is extended append-only:

```ts
const volume = client.config.setting<number>("audio.volume"); // existing handle
volume.get(0.8); await volume.set(0.6); volume.on(c => …);
volume.syncState;                     // NEW: "local" | "pending" | "synced" | "conflict"
await client.config.set("ui.lastTab", "library");   // undeclared key: open setting, synced
const saves = client.cloudSync.collection("saves");  // NEW namespace, same handle shape
await saves.file("slot-1").write(bytes, { playtime: 5400, progress: 0.42 });
client.cloudSync.onConflict(c => c.keep("cloud"));    // only for `revision` collections
client.cloudSync.status();             // { state, lastSyncAt, usedBytes, quotaBytes }
```

Python, Swift, Kotlin and GDScript get the same names in their own idioms, through
`gen:constants`.

**Portal and discovery.** Discovery gains `services.sync.description` and per-collection
`label`, so the portal's "what it keeps in step, in the developer's words" and "one row per data
class" (PORTAL.md:878-892) render from data.

### 5.6 Console and portal

- **Config**, Catalog · Profiles:
  - Catalog lists settings, secrets and minted tokens with their visibility, approval and
    sync columns.
  - Profiles shows **Default** pinned first, labelled "applies to everyone".
  - Licence and Users records host the same `ManagedPayloadEditor` over the CFG-03 effective
    view.
  - Platform → Override migration is removed.
- **Cloud Sync**, one page, **Cloud Sync**, which replaces "Data". It shows:
  - setup state;
  - what syncs, read from the catalog;
  - usage, read from the directory;
  - the two quota numbers;
  - quick-start code.

  The per-person view stays on Users → record → **Data** (U-11a and U-11b): one table per key,
  with the operator's account value, the person's synced value and the effective value, then
  records and files.

- **Portal.** One package (PX-18, which absorbs PX-W11) builds the product page's Cloud Sync
  section. U-12 keeps the Worker-side export and deletion cascade.

### 5.7 Graceful degradation

| Off        | Config                                                                                                                    | Cloud Sync                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| License    | Catalog → Default profile → account overrides (D-08 works fully, secrets included)                                        | Quota `licensed` for everyone; `requires` collections need an account-held grant or are refused |
| Identity   | The account layer still reaches key-entry devices of owned licences (owner line)                                          | Cannot be on (the console turns Identity on with it); SDK `status().state = "off"`              |
| Config     | SDK: `config.get` falls back; `config.set` persists locally unvalidated (today's behaviour); secrets and mint unavailable | Cannot be on (turned on with it)                                                                |
| Cloud Sync | Unaffected                                                                                                                | `config.set` persists locally; kits hide sync UI; the portal shows nothing (PORTAL.md:890)      |
| Commerce   | Unaffected                                                                                                                | Quota raises from tier entitlements still work; IAP raises need Commerce                        |

## 6. Surface-area reduction

- **Merge layers:** 8 become 5.
  - Removed: device overrides (dead), licence profile lists, and three entitlement-only layers
    that move to Licensing's resolver (store grant, OIDC grant, entitlement overrides).
  - Added: the Default profile.
- **Catalog entry fields.** The 20 top-level fields drop `secret` and `userGrant`/`grantLabel`
  (to Licensing); `delivery` keeps one live non-default value (`edgeMint`). `user` becomes
  optional, with 3 sync scopes instead of 4. `ui.scopes` loses `device`.
- **Secret markers:** 3 ways of being a secret (`kind`, `secret: true`, config + `secret: true`)
  become 1. Secret delivery modes go from 3 to 2 in use.
- **Edge mint:** declarations in 4 places (recipe, catalog annotation, product secret, approval)
  across 3 console pages become 1 catalog entry plus a drawer. Recipe locations go from 3 to 1,
  and the setting `config.edgeMint.recipes` is removed.
- **The override migration is deleted:**
  - about 1,739 Worker lines and 1,298 console lines;
  - 7 platform routes (rule 10), the tables `override_migration` and
    `override_migration_report`;
  - a RUNBOOK section, the licence page's four phase banners, `OverrideMigrationNotice` and the
    Platform nav entry.
- **The console's duplicate merge is deleted** (`LicenseConfig.tsx` `resolveInherited` and its
  layer fetches).
- **Cloud Sync vocabularies:** 4 enums with 15 values become 1 enum with 6. Sync scopes go from
  4 to 3, access classes from 3 (plus 1 reserved) to 1 implicit class, and `onAttach` modes
  from 4 to 0.
- **Cloud Sync stores:** 3 become 2 (settings, and records with files), and the `cloudSync.saves`
  block becomes a template.
- **Cloud Sync settings:** 5 product settings and 3 ceilings plus 1 platform switch become 1
  product setting (`cloudSync.quota`), 1 ceiling, 1 switch and 1 reserved entitlement.
  `minTrust` moves into the trust policy.
- **SDK API:** a second settings API (`setConfig`, `clearConfig`, `settingState`, `onChange`) is
  never built. Separate saves and collections clients become one `collection()` handle family.
- **Work packages:** 25 open U packages become 15, plus 3 deferred. PX-W11 merges into PX-18.
  Docs halves (U-15b, U-15c) and privacy halves (U-24a, U-24b) dissolve into the packages that
  build each feature. In total, about 6–9 engineer-weeks leave the near-term plan.
- **Console nav:** Config goes from 3 items to 2 (Edge mint folds into Catalog), and Cloud Sync
  "Data" is renamed to avoid clashing with Users → Data.

## 7. Automation and onboarding

1. **Product creation does the Config bootstrap.** It creates the Default profile and an empty,
   published catalog v1, so:
   - Profiles, secrets and the Integration snippets work immediately;
   - "Publish a catalog first" (PRF-5) disappears;
   - SETUP §4.2's Config quick start shrinks to "pick a template or add a key".
2. **Catalog templates by product goal** (the UX-21 goal cards):
   - Game: audio, graphics, controls, language, with the `saves` and `session` collections;
   - Desktop app: theme, language, updates, telemetry opt-in;
   - CLI: output and defaults;
   - Integrations: a minted-token template for Apple MusicKit, and a generic ES256/RS256/EdDSA
     JWT template.

   Each template entry is a real catalog entry, and the editor shows the diff before publish.

3. **Integration panel content** (the Products domain owns the panel). One snippet source,
   rendered for all six SDKs plus the terminal kits:
   - read a setting;
   - let people change a setting (it syncs);
   - read a secret;
   - get a minted token;
   - show sync status;
   - save a file to the cloud.

   The done signals are facts the Worker already sees: the first `GET /config/document` after a
   catalog publish (EXPERIENCE.md:736's moment), and the first `/sync` push.

4. **Minted-token wizard.** In one drawer: Template → paste the key (sealed straight into product
   secrets with usage `edge-mint`) → claims fields → **Save and approve** (step-up). That
   replaces four steps across three pages.
5. **Turning on Cloud Sync is one switch.** The console's chain rule (Services.tsx, UX-22)
   already turns on Config and Identity with it. The confirm copy should also say "Sign-in with
   Polaris Key and email links will be on", and the Cloud Sync page shows the quick start right
   after.
6. **"What the app sees" preview.** CFG-03's endpoint powers a "Preview as…" picker (licence,
   person or tier) on Catalog and Profiles, so an operator can check a lock or override before
   publishing.
7. **`pkey migrate`** rewrites old manifests:
   - drops `secret: true`;
   - moves `edgeMint[]` into catalog entries (creating the entry djdl lacks);
   - moves `licensing.profiles` to `profiles`;
   - moves `flag` entries to Licensing's location, with CFG-06.

   The `authoring-pkey-manifests` and `adding-a-catalog-entry` skills are updated in the same
   change.

8. **Validator nudges** (rule 9 warnings first):
   - an edgeMint entry with no recipe, and a recipe with no entry;
   - `secret: true`;
   - `serverOnly`;
   - a `user` block on a key locked at catalog level (now a no-op rather than an error).

## 8. Migration, data and risk

- **CFG-01, cancel the U-03 run.**
  - Before anything else, the lead reads `GET /manage/api/platform/override-migration` in
    production. If a notice was started, **withdraw it** (`DELETE …/notice` exists). If the run
    already happened, stop and re-plan: the dropped values are only in the 90-day report.
  - Nothing has been read differently yet: the expand phase reads both layers, so documents are
    byte-identical before and after CFG-01.
  - The table drops are a lead-numbered `00XX_drop_override_migration.sql` with `DROP TABLE IF
EXISTS`, the `TABLE_OWNERS` update and the `licenseDelete` statement removed
    (`services/config/index.ts:36-43`).
  - The OIDC provisioning writer moves to the account layer unconditionally. A sign-in after
    deploy rewrites each identity's declared keys there. A one-off backfill copies the provisioned
    secrets already on licences to their owners' account rows (sealed values copied as-is, same
    AAD), then removes them from the licence. Checked by a test that the effective documents are
    unchanged.
  - **Risk:** this reverses an owner decision of 2026-10-04 (S-17 decisions 3 and 4). The brief
    of 2026-10-07 is newer and asks for the licence layer. The owner must confirm.
- **CFG-02, the Default profile and no licence profile lists.**
  - The Default profile is created empty for every product, so documents are byte-identical.
  - Licence profile lists are converted, in a lead-numbered migration plus a resumable script,
    into the licence's override column at the same precedence:
    - licence profiles sat above the tier profile and below the licence overrides, so their
      values merge _under_ existing override values;
    - `updatedAt` is kept, so ETags hold.
  - A report lists every licence whose profile link became copied values, because later edits to
    that profile no longer reach it.
  - Production check first: `SELECT COUNT(*) FROM license_profiles`.
  - **LX-09 seam:** LX-09's `legacy` byte-identity snapshot must be taken after CFG-02, and its
    `combined` slices drop "licence profiles".
- **Device overrides.** Stop reading them, after a production check:
  `SELECT COUNT(*) FROM devices WHERE overrides_json IS NOT NULL AND overrides_json NOT IN ('', '{}')`.
  Expected 0. Any rows found move into licence overrides with a report. The column is dropped
  later.
- **CFG-04 and CFG-05 are manifest-only and console-only.** The served catalog keeps `kind` and
  `delivery` values, so the SDKs are unaffected. Recipe ingest from the catalog runs through the
  existing approval-invalidation path, so a resync that changes a recipe still deletes its
  approval (`invalidateWidenedEdgeMintApprovals`). New tests:
  - a console-saved recipe is approved under step-up and binds every `MINT_RECIPE_FIELDS` column;
  - a repository-authored one is not approved.
- **CFG-06 (entitlements out).** This is plan mode: the served catalog's flag rows and the
  profile shape change. Licensing owns the order relative to LX-09, LX-14 and LX-16.
  Byte-identity of license documents in `legacy` mode is the gate.
- **U-01b (Cloud Sync amendment).** This is plan mode and lands before U-05 starts.
  - The signed corpus is untouched.
  - `sync-scenarios.json` gains append-only scenarios (an open setting; a default user setting
    with no `user` block; a `max`-on-metadata file conflict), so `syncScenariosVersion` stays 1
    unless an existing expectation changes.
  - U-04's validator rules change, under the rule-9 parity table:
    - rule 2 (user block on a catalog-locked key) becomes a warning;
    - rule 9 (`onAttach`) is removed;
    - rule 8b becomes the `pkey.cloudSync.bytes` reserved key;
    - `cloud_sync_unknown_flag` becomes `…_unknown_entitlement`.
  - The `user.sync: device` value is refused with a pointer to `local`. The corpus uses none.
- **Security.** Unchanged:
  - T5: nothing in `gate.ts`, `store.ts` or `verify.ts` imports `cloud-sync`;
  - P0-12: the approval binds the recipe and the trust basis;
  - secrets never reach browsers;
  - the account layer never widens Cloud Sync.

  Open settings are new device-writable data. They are bounded by the 256-key / 64 KiB budget,
  are never signed, and are never read by the server. Add a THREAT-MODEL row in U-05, and U-19
  reviews it.

- **Reversibility.** Every step except the table drops is a code revert. The drops come after one
  release with the code removed, and the report data is exported first.

## 9. Backlog changes

| id     | action | target           | note                                                                                                                                                                                                                                                                                                            |
| ------ | ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-03   | keep   | —                | Done. The layer stays; the run and its machinery are reversed by CFG-01                                                                                                                                                                                                                                         |
| U-04   | keep   | —                | Done. Its validator rules are amended by U-01b and CFG-04                                                                                                                                                                                                                                                       |
| U-18   | keep   | —                | Done. The corpus is extended append-only by U-01b                                                                                                                                                                                                                                                               |
| U-05   | edit   | —                | Implements U-01b: settings plus open settings, quota from `cloudSync.quota` and `pkey.cloudSync.bytes` (anchor fallback until LX-09), one ceiling and `writesPaused`, no `byTier`/`byEntitlement`/`unlicensed`/`writes`, `minTrust` through the trust policy. The settings slice is rewritten. Depends on U-01b |
| U-19   | keep   | —                | Scope note: covers open settings and files on records (U-10)                                                                                                                                                                                                                                                    |
| U-06   | edit   | —                | API is `config.set/clear/setting/onConfigChange` plus `setting.syncState`, `cloudSync.status/flush`. Remove `setConfig`/`clearConfig`/`settingState`/`onChange`. Fix the "no setter" claim. Its SDK reference docs land in the package                                                                          |
| U-20   | edit   | —                | Same as U-06 for React (web and desktop bridge v4 carry the existing names)                                                                                                                                                                                                                                     |
| U-07   | edit   | —                | Same as U-06 for Swift and Kotlin                                                                                                                                                                                                                                                                               |
| U-21   | edit   | —                | Same as U-06 for Godot (`config.set` over `PKeyUserSettingsStore`)                                                                                                                                                                                                                                              |
| U-12   | edit   | —                | Worker privacy only: export and delete cascade for settings, account overrides and the directory, and the export zip format later stores append to. The portal section moves to PX-18                                                                                                                           |
| U-11a  | edit   | —                | Users → Data: one per-key table (account override, synced choice, effective) from CFG-03's endpoint, quota meter, audit and step-up. Depends on CFG-03                                                                                                                                                          |
| U-15a  | edit   | U-15             | Renamed U-15: Cloud Sync concepts, the quick start and Integration snippets (with CFG-07). Feature guides land in their feature packages                                                                                                                                                                        |
| U-15b  | drop   | U-10, U-23       | The saves guide is written by the files packages; Steam Cloud coexistence goes to U-23's Godot docs                                                                                                                                                                                                             |
| U-15c  | drop   | U-09, U-22       | The collections guide is written by the records packages                                                                                                                                                                                                                                                        |
| U-08   | merge  | U-09, U-22, U-23 | Server side (`empty`, parking in the account-merge hook) to U-09; `onConflict` and the kit conflict prompt to U-22 and U-23. `onAttach` is gone                                                                                                                                                                 |
| U-09   | edit   | —                | Records backend: `owner` access only, the shared conflict vocabulary, `requires: <entitlement>`, `maxRecords`, account-merge parking from U-08, export and delete hooks from U-24b. `ownerRead`/`server` deferred. Depends on U-01b                                                                             |
| U-10   | edit   | —                | Retitled "Files on records": begin, upload and finalize keyed by `(collection, id)`, revisions, GC, per-principal keys, R2 prefix delete, files in exports (from U-24a). Depends on U-09                                                                                                                        |
| U-13   | merge  | U-22             | The saves SDK becomes the files and `saves` template half of the records SDK (Node, React, Python) plus React's conflict view                                                                                                                                                                                   |
| U-25   | merge  | U-23             | Same for Swift, Kotlin and Godot (Godot first), `formatVersion` and `saveCompat` included                                                                                                                                                                                                                       |
| U-22   | edit   | —                | Records and files SDK, Node, React, Python: `cloudSync.collection()`, `file()`, `onConflict`, the conflict prompt (from U-08). Larger: about 1.4–1.9 weeks                                                                                                                                                      |
| U-23   | edit   | —                | Records and files SDK, Swift, Kotlin, Godot, with the kits' conflict views. Larger: about 1.6–2.2 weeks                                                                                                                                                                                                         |
| U-11b  | edit   | —                | Console Data tab: records and files browser, history and restore (absorbs U-11c)                                                                                                                                                                                                                                |
| U-11c  | merge  | U-11b            | One browser for one store                                                                                                                                                                                                                                                                                       |
| U-24a  | drop   | U-10, U-12       | Shredding and prefix delete to U-10, zip to U-12. Residency deferred as a separate optional item, if ever asked for                                                                                                                                                                                             |
| U-24b  | drop   | U-09             | Records export and delete land with the store (the registry guard requires them anyway)                                                                                                                                                                                                                         |
| U-14   | defer  | —                | Pull on foreground, online and visibility covers "rehydrate from any instance"; revisit after launch                                                                                                                                                                                                            |
| U-16   | defer  | —                | No `ownerRead`/`server` collections at launch                                                                                                                                                                                                                                                                   |
| U-17   | defer  | —                | Receipts, end-to-end encryption and public collections: no current consumer                                                                                                                                                                                                                                     |
| PX-W11 | merge  | PX-18            | One package for the portal section's API and UI. Its "not on Identity" note is wrong                                                                                                                                                                                                                            |
| PX-18  | edit   | —                | Portal Cloud Sync section, API and card. Depends on U-05 and U-12. Renders `services.sync.description` and collection labels                                                                                                                                                                                    |
| ST-16  | edit   | —                | Cloud Sync rows shrink to `cloudSync.ceiling.bytes` and `cloudSync.writesPaused`                                                                                                                                                                                                                                |
| LX-14  | edit   | —                | (Licensing) `combine` and `entitlementKind` belong in Licensing's entitlement editor, not `CatalogEntryForm.tsx`                                                                                                                                                                                                |
| LX-09  | edit   | —                | (Licensing) No "licence profiles" slices (CFG-02). Take the legacy snapshot after CFG-01 and CFG-02. Profile entitlements come from tiers (CFG-06)                                                                                                                                                              |
| I-11   | keep   | —                | Its reserved Cloud Sync section is filled by PX-18                                                                                                                                                                                                                                                              |

## 10. New work packages

| proposed id | title                                                                                                           | deps                 | plan mode | scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-01b       | Cloud Sync plan amendment: two stores, one conflict vocabulary, quota as an entitlement, the `config.local` API | — (before U-05)      | yes       | Amend `plans/U-01.md`: §5.5 here (settings by default, open settings, scopes `user`/`platform`/`local`, records with files, saves and session templates, owner-only access, the shared vocabulary, no `onAttach`, `cloudSync.quota` + `pkey.cloudSync.bytes`, `minTrust` to the trust policy, one ceiling, SDK names, `description` and `label` in discovery, export and delete with each store). WIRE-CONTRACT-V4 §13 text, `errors.json` deltas, append-only scenarios, validator rule table, brief changes for U-05 to U-25 and PX-18. About 0.4–0.6 weeks |
| CFG-01      | Keep the licence config layer; retire the override-migration machinery                                          | —                    | no        | `payload.ts` always reads licence config and secrets. Remove the freeze from `PUT …/licenses/<id>/overrides`. Delete the `overrideMigration.ts` state, run, report and sweep, the 7 platform routes (OpenAPI and `routeCoverage`), the console page and nav entry, `OverrideMigrationNotice`, the `LicenseConfig` phase banners and `data/overrideMigration.ts`. Provisioning writes the account layer, with a one-off backfill. Drop the two tables (`00XX`). RUNBOOK, THREAT-MODEL U-03 rows, glossary and docs. About 0.6–0.9 weeks                        |
| CFG-02      | One config chain: the Default profile, one profile per tier, no device layer                                    | CFG-01               | no        | Reserved profile `default`, created with each product and backfilled empty; it is the base layer for every device, licence-less included. Remove licence profile lists (migration and report; UI in `CreateLicenseDialog` and `LicenseTerms`). Stop reading `devices.overrides_json`. Docs (`profiles.md`, `concepts.md`, `management-states.md`); the SETUP §4.2 copy. The LX-09 seam test. About 0.8–1.1 weeks                                                                                                                                              |
| CFG-03      | Effective config with provenance (one admin read; the console stops re-merging)                                 | CFG-02               | no        | `GET /manage/api/products/<p>/config/effective?license=&subject=&tier=`: per key, the value (secrets show `configured`), state, source layer and locking layer, computed by Core's `resolveMergedPayload`. Replace `resolveInherited` in `LicenseConfig.tsx` (fixing the lock bug), feed U-11a, profile Used-by and the catalog key drawer, and the "Preview as…" picker. Rule 10. About 0.5–0.7 weeks                                                                                                                                                        |
| CFG-04      | Catalog types and visibility in one vocabulary                                                                  | —                    | no        | Validator: `secret: true` (warn, drop on ingest), `serverOnly` (warn), `user` on locked keys (warn), edgeMint without a recipe (warn), `licensing.profiles` alias (warn). Console form: Type (Setting, Secret, Minted token), In the app (Editable, Read-only, Hidden), and a reduced Syncs control. The `pkey migrate` rewrites. Docs (`catalog.md`, `management-states.md`), both skills, the generated `config-entry` reference. Rule 9 and `bundle:action`. About 0.6–0.8 weeks                                                                           |
| CFG-05      | Minted tokens carry their recipe                                                                                | CFG-04               | no        | Catalog `mint` block; ingest of `edge_mint_config` from the catalog; legacy `edgeMint[]` read, then migrated; `config.edgeMint.recipes` folded into `config.catalog`; Edge mint page folded into Catalog (approval pill, Approve drawer, Set signing key); console-saved recipes approved under step-up; THREAT-MODEL A5 and the P0-12 rows re-verified; docs `edge-mint.md` and ADMIN.md §6.6.4. About 0.9–1.2 weeks                                                                                                                                         |
| CFG-06      | Entitlement declarations and values leave Config (with Licensing)                                               | LX-09, LX-14         | yes       | Owned by Licensing. Flags authored in Licensing's declarations; profiles hold `config` and `secrets` only (profile entitlements migrate to tiers, licence-attached ones to licence entitlement overrides); Config editors drop flags; `/config/schema` serves flag rows read-only for one deprecation window (Godot badge, Swift decode); Cloud Sync `requires` names entitlements; `injectAdminPolicy` fields become Licensing's own. About 1–1.4 weeks                                                                                                      |
| CFG-07      | Config and Cloud Sync onboarding: templates, quick starts, Integration snippets                                 | CFG-04, CFG-05, U-06 | no        | The product-create bootstrap (Default profile, catalog v1); catalog templates by goal (game, desktop, CLI, integrations); a single snippet source for six SDKs and the terminal kits (setting, synced setting, secret, minted token, sync status, file); done signals (first document after publish, first push); the Cloud Sync page rebuilt as Setup and Usage, replacing the read-only Data page; the minted-token wizard. About 0.8–1.1 weeks                                                                                                             |
| CFG-08      | (Optional, later) SDKs read minted tokens by catalog key                                                        | CFG-05               | yes       | `getSecret(key)` / `config.secret(key)` resolves a minted entry through `mintToken` with the existing in-memory cache, in six SDKs; parity `config.mint` note; terminal kits' `secret <key>` covers minted keys. About 0.8–1.1 weeks                                                                                                                                                                                                                                                                                                                          |

## 11. Quick wins

1. **Fix the console lock bug now** (`LicenseConfig.tsx:118-125`): under a lower lock, keep
   `current.value` and `current.source`. It is a one-line change with a unit test against
   `merge.test.ts`'s case. CFG-03 later deletes the function.
2. **Do not start the override-migration notice.** This is an owner and lead decision today. It
   costs nothing and keeps CFG-01 cheap.
3. **Correct the stale briefs:**
   - U-06, U-20, U-07 and U-21 use the `config.local` names;
   - PX-W11's "not on Identity" is wrong;
   - U-10 and U-09 own their own export and delete;
   - U-12, PX-W11 and PX-18 get one owner.
4. **Mark U-14, U-16 and U-17 `deferred`** in `workpackages.json`, so nobody plans around
   `ownerRead`/`server`.
5. **Docs:**
   - "six opt-in services" becomes seven (`services/config/index.md:8`);
   - the edge-mint docs and ADMIN.md §6.6.4 say recipes live in `.pkey/product`;
   - `concepts.md` says profiles are Config's.
6. **The `adding-a-catalog-entry` skill** stops telling authors to set `"secret": true`, and says
   minted tokens are `delivery: "edgeMint"` plus a recipe.
7. **Add a validator warning** for a recipe with no catalog entry, and for an edgeMint entry
   with no recipe. djdl's `applemusic` would show it.
8. **Rename the console page** Cloud Sync → "Data" to "Cloud Sync", to avoid the clash with
   Users → Data.

## 12. Cross-domain dependencies

- **Licensing.**
  - Entitlements split out (CFG-06), shared with LX-09, LX-14 and LX-16.
  - `injectAdminPolicy`'s `channels`, `deviceLimit` and `license.tier` stop being Config-shaped.
  - Tiers own entitlements, not their profile's.
  - LX-09 drops licence-profile slices, and its legacy snapshot comes after CFG-01 and CFG-02.
  - The reserved `pkey.cloudSync.bytes` entitlement fits LX-05's `pkey.*` prefix.
  - Consumable IAPs with redemption state are Licensing's, not Cloud Sync records.
  - The licence page's Config tab and Terms lose profile lists.
  - The licence-override migration is cancelled. The Licensing audit must not also plan to
    remove licence config.
- **Identity.**
  - Cloud Sync stays sign-in-only (`devices.subject`).
  - Consent at sign-in names Cloud Sync.
  - OIDC provisioning writes account overrides (CFG-01).
  - Account merge hooks: account overrides as built; Cloud Sync parking in U-09.
  - The console turn-on chain enables Identity with Cloud Sync.
- **Products and onboarding.**
  - The Integration section hosts CFG-07's snippets.
  - Its "handshake complete" signal can include the first config document fetched and the first
    sync push.
  - Product creation creates the Default profile and catalog v1.
- **Settings (S-18 / ST-\*).**
  - The `config.*` slice loses `config.edgeMint.recipes`.
  - The `cloudSync.*` slice becomes `cloudSync.quota`, `cloudSync.settings.open`, the ceiling and
    `writesPaused` (ST-16).
  - The ST-08 hub's Config and Cloud Sync areas.
  - ST-21's capability gate covers account and licence override edits and recipe approval.
- **Device trust.** `cloudSync.writes.minTrust` becomes a row of the Core trust policy.
- **Portal.** PX-18 is the single owner of the product page's Cloud Sync section (PORTAL.md
  §4.20). LX-15's "what you own" has no Config dependency.
- **UI kits.**
  - The Settings component (UK-13 and UK-14 terminal kits included) shows `syncState`.
  - `CloudSyncStatus`.
  - One conflict prompt, which replaces the separate MergePrompt and SaveConflict.
  - Terminal `mint <recipeId>` also accepts a key after CFG-08.
- **Release and content.** "Assets to rehydrate a session" means user files on records.
  Developer content packs stay with Release and packs.
- **RBAC.** Who may edit licence and account overrides, approve recipes, and read a person's
  synced data (step-up) must map onto the new roles.
- **Privacy.** Export and delete land with each store. `PRIVACY.md` and the THREAT-MODEL rows are
  updated by U-05, U-09, U-10 and CFG-01.

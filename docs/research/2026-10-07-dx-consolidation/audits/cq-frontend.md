# Code-quality audit: admin console, customer portal and the shared UI layer

**Domain.** `packages/admin` (the console at `/manage`, the customer portal at `/`, `src/ui/`
including `src/ui/motion/` and `src/motion.css`), `packages/brand`, `packages/ui-qa`.
**Tree read.** `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5), 2026-10-07, read-only.
In-flight branches checked: LX-08 (touches only `console/pages/platform.tsx` and
`console/settings.generated.ts` in this domain), HA-12 (`console/settings.generated.ts` only),
UK-13 (`ui-qa/rules/*`, `ui-qa/src/report.ts`), UK-14 (`brand/kit-copy/*.json`).
**Proposed WP prefix.** `CQF-` (code quality, frontend), so it does not collide with other audits.

All paths below are relative to `packages/admin/src/` unless they start with `packages/`, `docs/`
or `tools/`.

---

## Summary

The console on its own is well built. It has one nav table (`console/nav.ts`), one query-key
module (`console/data/queries.ts`), one declared mutation→invalidation table with a test that
rejects direct writes (`console/data/mutations.ts:283`, `test/mutations.test.ts`), page templates,
a tested destructive-action policy (`lib/actions.ts`), a generated service table
(`services.generated.ts` from `tools/services.json`) and wide accessibility coverage: axe runs in 61
unit test files and in the e2e suites.

The problem is that the portal grew up as a **second application with its own version of almost
every cross-cutting piece**, and that the console's own redesign **stopped before its cleanup
chunk**. Today the codebase has:

- **two of everything**: two hash routers (`console/router.tsx` with `console/routes.ts`, and
  `portal/router.ts`), two fetch transports and error classes (`api.ts:4154` `ApiError` and
  `portal/api.ts:920` `PortalApiError`), two data-layer conventions (a declared mutation table in
  the console against hand-placed `invalidateQueries` in `portal/data.ts`), two command palettes,
  two error renderers, two state screens, two product marks, two format modules, two settings-row
  engines, six platform-label maps, seven store-label maps and three ecosystem-label maps;
- **migrations that never finished**: ADMIN.md chunk 11 ("Delete … `context.tsx` and
  `LegacyPage`", `docs/design/ADMIN.md:2636`) has no work package, so `context.tsx` (the
  "TEMPORARY ADAPTER", whose `useResource` now has zero callers), `console/shell/LegacyPage.tsx`
  (a MutationObserver that promotes an `h2` to `h1` on **every** product page,
  `console/shell/AppShell.tsx:521`) and the token-alias layer (`styles.css:80`) are all still
  shipped. The shared component inventory in `docs/design/EXPERIENCE.md:869` (§3) is about 40%
  delivered. About 50 `UX-*` packages in EXPERIENCE.md §13.3 are not in `workpackages.json`;
- **one copy source declared but never wired**: SIGN-IN.md decision D-41
  (`docs/design/SIGN-IN.md:1870`) says the portal reads `packages/brand/kit-copy`. It does not. At
  least 41 catalog strings are retyped verbatim in `portal/`. 24 refusal codes that core copy already
  words are worded again by hand. One code-entry error string is copied three times
  (`portal/pages/SignInPage.tsx:463`, `portal/components/account/StepUp.tsx:417`,
  `portal/components/account/SignInMethods.tsx:820`);
- **hand-mirrored types and dead compatibility code**: 322 interfaces in `api.ts` and about 100 in
  `portal/api.ts` re-declare the Worker's admin and portal responses with no shared source. About
  45 branches handle "an older Worker", although the SPA ships inside the same Worker version
  (`packages/worker/wrangler.toml:25` `[assets]`);
- **no wizard kit**, while the owner brief turns nearly every setup into a wizard. SETUP.md
  designs one (`ui/wizard/`, UX-50, `docs/design/SETUP.md:280`), but it was never built. Today
  each multi-step flow is bespoke (`AppStorePage.tsx` at 1830 lines, `StorefrontsPage.tsx`,
  `CreateLicenseDialog.tsx`, `ActivateDialog.tsx`, `SignInMethods.tsx`). LX-29 is about to add
  another one;
- **no settings engine**: `confirmLevel` and `formatSettingValue` are implemented twice
  (`console/pages/platformSettings.tsx:93,111` and
  `console/components/ProductSettingsSection.tsx:54,69`), and about 15 pages each implement
  "manifest-owned, claim, Revert" themselves;
- **a layering leak into the customer bundle**: the portal entry pulls the whole 5,673-line
  console API client through `ui/toast.tsx:5` → `lib/errorCopy.ts:8` → `api.ts`. That ships every
  `/manage/api` route path to customers.

**The single most important change:** finish the shared layer before the owner-brief wave lands.
That means one data layer, one copy source, one wizard kit and one settings engine, sequenced
**ahead of** LX-29, PX-12/14/15/21, ST-07 to ST-09 and CM-11/12/16, so those packages build on it.
Today each of them would add a third or fourth version.

---

## Current state (with file references)

### Size and shape

| Area                                                                   | Lines           | Files    | Notes                                                                              |
| ---------------------------------------------------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------- |
| `console/`                                                             | 69,524          | 172      | 48 nav pages in 8 product sections plus Platform (`console/nav.ts`)                |
| `portal/`                                                              | 20,638          | 84       | 10 pages, 30 flat components plus `product/`, `account/`, `signin/`, pure `model/` |
| `ui/` (incl. `motion/`, `charts/`, `data-table/`)                      | 12,612          | 84       | the shared kit                                                                     |
| `lib/`                                                                 | 2,762           | 17       | format, status, labels, errorCopy, actions, highlight…                             |
| root (`api.ts` 5,673, `ManagedPayloadEditor.tsx` 926, `context.tsx` …) | 6,942           | 6        |                                                                                    |
| `kit/` (dev gallery `#/__kit`)                                         | 3,249           | 13       | dev only                                                                           |
| `styles.css` and `motion.css`                                          | 1,324           | 2        |                                                                                    |
| tests: `test/` / `e2e/`                                                | 57,589 / 18,878 | 121 / 29 |                                                                                    |
| `packages/brand` (src and scripts) / `packages/ui-qa`                  | 11,792 / 2,679  |          |                                                                                    |

Module graph from the two entries (static imports, type-only excluded): the portal reaches 124
modules (31.8k lines) and the console 283 (92.7k). They share 40 modules (11.2k lines). One of the
modules the portal reaches is `api.ts`, via `ui/toast.tsx:5` → `lib/errorCopy.ts:8`.

### Entry points and providers

- Console: `main.tsx` → `App.tsx`. `QueryClientProvider` uses the **module singleton**
  `console/data/queryClient.ts:31`. The singleton exists for the legacy `useResource` adapter
  (`queryClient.ts:4-9`), which now has no callers. Even so, 120 call sites in 40 files pass
  `queryClient` explicitly (`useQuery({...}, queryClient)`).
- Portal: `portal/main.tsx` → `portal/App.tsx` with `createPortalQueryClient()` (`portal/data.ts:83`),
  provider-scoped. This is the right pattern.
- `context.tsx`: `useResource` (no callers), `useAdmin` (one caller, `console/shell/CommandPalette.tsx:5`),
  `useProductServices` (one caller, `console/areas/distribution/AccessPage.tsx:37`), `invalidate`
  (three calls in `CatalogEditorPage.tsx:777` and `EdgeMintPage.tsx:466,537`), `resetCache` (tests).

### Data layer

- **Console reads.** `qk` in `console/data/queries.ts` has a good prefix scheme. Readers are split
  across three conventions: area `data.ts` modules (`console/areas/distribution/data.ts`,
  `areas/feeds/data.ts`, `areas/storefronts/data.ts`, `pages/config/data.ts`,
  `pages/release/data.ts`, `pages/sync/data.ts`), hooks inside component files
  (`pages/license/shared.tsx:41`), and inline `useQuery` in pages. That is 61 `queryFn` sites in
  page or component files against 50 in data modules, across 36 files. The same hook is redeclared
  for the same key: `useCatalog` (`areas/distribution/data.ts:237`, `pages/config/data.ts:29`),
  `useProfiles` (`pages/license/shared.tsx:41`, `pages/config/data.ts:79`) and `useDeliverables`
  (`areas/distribution/data.ts:217`, `pages/release/data.ts:70`). A TypeScript-AST test
  (`test/queryKeyShapes.test.ts`) exists only to stop two readers of one key from storing
  different shapes. Binding key and fetcher structurally would make it unnecessary.
- **Console writes.** `mutate(method, …args)` plus `MUTATIONS` (`console/data/mutations.ts`), with
  a test that fails any write made outside it. This is excellent and should become the pattern for
  both apps.
- **Portal reads and writes.** `portal/data.ts` defines its own `qk` (`:47`) **and** an alias table
  `portalKeys` (`:65`) for the same keys. It has 16 `useMutation` hooks with hand-placed
  invalidations (`:281-290`, `:456-468`, `:470-484`, `:562-575`, `:638-645`). Writes are also made
  directly from components (`portalApi.*` in `account/SignInMethods.tsx:623,774,806,1048-1050`,
  `account/StepUp.tsx:119-163,354-381`, `pages/SignInPage.tsx:329,523,554`), with ad hoc cache
  calls (`StepUp.tsx:374` invalidates **everything**). No test polices any of this. This is the
  CC-1 to CC-4 bug class the console fixed in chunk 2. One plausible instance: `useClaimKey`
  (`portal/data.ts:456`) refreshes licenses, releases, library and discover but not the claimed
  product's view or downloads.
- **Transport.** `api.ts:4190` `send()` has CSRF `X-PKey-CSRF`, a 401 redirect to `/manage/login`,
  and a nested-or-flat error-body parser. `portal/api.ts:949` `call()` has CSRF
  `X-PKey-Portal-CSRF`, classifies network errors as status 0 and parses only flat bodies. There
  are two error classes with different fields (`fields`, `errors`, `reason` against `triesLeft`,
  `retryAfter`, `reason`).
- **Types.** `api.ts` holds 322 exported interfaces and types plus a 203-method `rawApi` object
  literal (`api.ts:4288-5673`). `portal/api.ts` adds about 100 more and wire normalisers
  (`libraryFromWire :251`, `legacyPath :622` "A Worker before PS-04", `offerFromWire`). The Worker
  exports none of these shapes (`packages/worker/src/admin/` has no DTO module), so drift is caught
  only by fixtures. Fixtures are typed against the same hand-written mirrors, so they drift with
  them.

### Routing

- Console: `console/router.tsx` (hash store, blockers, View Transitions, `overlayShown()` via CSS
  classes at `:96`, `data-vt-shared`) plus `console/routes.ts` (parse, typed builders, query
  codecs, `LEGACY_REDIRECTS` at `:81` for pre-redesign tab paths). Route focus and the
  "{title}, page loaded" announcement are in `console/shell/AppShell.tsx:107-150`.
- Portal: `portal/router.ts` (799 lines) reimplements the same responsibilities: a hash store,
  redirects, `setParams` with a custom `ROUTE_EVENT`, View Transitions, overlay detection **by ARIA
  role** (`:407` `OVERLAY_ROLES`), a shared element via `data-vt-source`, scroll restoration, and
  `focusPageHeading` with a 600-frame retry loop. It focuses the heading but makes no route
  announcement, which differs from the console.
- `ui/useUnsavedChangesGuard.tsx:2` imports `console/router.js`. The shared kit depends on the
  console's router.
- `console/nav.ts`: 58 `ready: true` flags and one `ready: false` with a `host` (`:865`, the
  Platform root redirect). The "not built yet" scaffolding is now vestigial.

### Copy

- Console copy is local English. `lib/errorCopy.ts` (709 lines) words `ApiError`;
  `SERVICE_ERROR_MESSAGES` and `RELEASE_POLICY_ERROR_MESSAGES` live in `api.ts` and
  `lib/releasePolicyMessages.ts`. The retry label is "Retry" (`ui/ErrorState.tsx:10`).
- Portal copy is hard-coded English in components, with `// signin.<key>` comments as placeholders
  for the switch to the catalog (`portal/pages/SignInPage.tsx` has 18). The catalog exists
  (`packages/brand/kit-copy/en.json`, 478 messages, 9 locales, typed `KitCopyKey` and
  `loadKitCopy` in `packages/brand/src/generated/kit-copy/index.ts`, exported as
  `@polaris-key/brand/kit-copy`). Its only consumer outside brand is the docs site
  (`packages/docs/src/lib/kitCopy.ts`). The portal's error voice uses "Try again" (matching
  `common.tryAgain`), while the console uses "Retry".
- Wording drift already exists. The portal says "Too many tries. Wait a minute, then try again."
  (`SignInPage.tsx:476`). Core copy `rate_limited` says "Too many attempts. Wait a moment and try
  again."

### Components (duplicates found)

| Concept              | Console / ui                                                                                                                                               | Portal                                                                                                                     | Note                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Command palette      | `console/shell/CommandPalette.tsx` + `shell/palette/*` (cmdk)                                                                                              | `portal/components/JumpPalette.tsx` (cmdk, own recents at `:19-41`)                                                        | EXPERIENCE §3 says one `ui/` palette                                                      |
| Recents in storage   | `console/shell/palette/recents.tsx`, `console/shell/ProductSwitcher.tsx`                                                                                   | `JumpPalette.tsx` `readRecent` / `pushRecent`                                                                              | three implementations                                                                     |
| Error state          | `ui/ErrorState.tsx` + `lib/errorCopy.ts`                                                                                                                   | `portal/components/States.tsx` `ErrorPanel` + `portal/errors.ts` `portalErrorCopy`                                         | different icon, retry label and copy model                                                |
| Boot / star screen   | `console/shell/StatePages.tsx:215` `BootScreen`                                                                                                            | `States.tsx` `StarScreen`                                                                                                  | EXPERIENCE §3 says one `ui/BootScreen`                                                    |
| Section card         | `ui/Section.tsx` (used in **3** files), `console/templates/Settings.tsx`                                                                                   | `portal/components/product/Card.tsx` `SectionCard` (14 files)                                                              | plus about 50 hand-rolled `rounded-* border bg-surface-raised` cards in 40 files          |
| Product mark         | `ui/ProductLogo.tsx` (brand `resolveAccent`, sizes 24/32/40)                                                                                               | `portal/components/ProductIcon.tsx` (sizes 20 to 112) + `ProductArt.tsx` with 8 hard-coded hex `TINTS` (`:18`)             | two colour models: `tintColor` (legacy `branding_json`) and `presentation.accent` (HA-12) |
| Avatar / initials    | `console/shell/UserMenu.tsx:60` inline initials, `ui/Timeline.tsx:136` `initialsOf`                                                                        | `portal/components/Avatar.tsx:5` `initialsOf`                                                                              | three implementations                                                                     |
| Account menu / theme | `console/shell/UserMenu.tsx` + `ThemeMenu.tsx`                                                                                                             | `portal/components/AccountMenu.tsx`, `pages/AccountPage.tsx:205` appearance rows                                           | EXPERIENCE §3 says one `AccountMenu`                                                      |
| Registry tokens      | `console/areas/feeds/RegistryTokens.tsx` (893)                                                                                                             | `portal/components/product/PackageAccessCard.tsx` (568)                                                                    | both list tokens, mint once and revoke; `TOKEN_ENV` defined twice                         |
| Release notes        | none                                                                                                                                                       | `portal/components/product/WhatsNew.tsx` + `portal/model/product.ts:662` `noteBlocks` (drops headings, emphasis and links) | the owner wants them formatted and summarised                                             |
| Code entry           | none                                                                                                                                                       | `SignInPage.tsx`, `StepUp.tsx`, `SignInMethods.tsx` (three copies of `codeErrorText`)                                      | PX-12 plans a `CodeEntry`                                                                 |
| Device glyph / name  | `console/components/DeviceTable.tsx`, `DeviceDrawer.tsx`                                                                                                   | `DevicesCard.tsx` and `pages/FreeDevicePage.tsx` (both define `deviceName` and `DeviceGlyph`)                              |                                                                                           |
| Platform glyphs      | `console/pages/release/shared.tsx` `PlatformGlyphs`                                                                                                        | `portal/components/Glyphs.tsx` `PlatformGlyphs`                                                                            |                                                                                           |
| Check / health rows  | `console/components/CheckRow.tsx`, `pages/release/RepoSync.tsx:168` `CheckRow`, `platformOperations.tsx` `HealthPill`, Overview `ChecklistPanel`           | none                                                                                                                       | SETUP.md's `PrereqList` / `SetupRow` is the one concept                                   |
| Media query hook     | `ui/data-table/DataTable.tsx:80` `useMediaQuery` (imported by `console/shell/UserMenu.tsx`), `ui/toast.tsx:76`, `components/theme.tsx`, `AppShell.tsx:240` | `PortalShell.tsx:199`, `pages/LibraryPage.tsx:333`                                                                         | six implementations                                                                       |
| First-load stagger   | `console/templates/Dashboard.tsx:175` `useFirstLoad`                                                                                                       | `portal/stagger.ts:21` `useFirstLoad`                                                                                      | same name, two implementations                                                            |
| Shadowed primitives  | `platformOperations.tsx:343` local `Skeleton`; `pages/release/CompatibilityPage.tsx:305` local `CellDrawer` beside `areas/distribution/CellDrawer.tsx`     | none                                                                                                                       | name collisions                                                                           |

### Vocabularies (label maps)

- **Platforms (6):** `lib/labels.ts:144`, `portal/model/product.ts:236`,
  `portal/model/library.ts:1088`, `portal/pages/DownloadFlowPage.tsx:35`,
  `portal/components/Glyphs.tsx:120`, `console/pages/license/EnrollmentPage.tsx:389`. A seventh
  helper, `lib/buildLabels.ts`, is dead. The shared `buildLabel` in `@polaris-key/manifest` is
  already used by `console/areas/distribution/AppStorePage.tsx`.
- **Stores (7), with two id spellings per store:** `lib/labels.ts:105` (`google-play` and `play`),
  `console/areas/distribution/format.ts:80` (`play`, `ms-store`),
  `console/areas/storefronts/data.ts:109`, `console/pages/platformStores.tsx:114` and `:806`
  (`google-play`, `microsoft-store`), `console/pages/platformOperations.tsx:338`,
  `portal/model/library.ts:315`, `console/pages/core/UserRecord.tsx:79`. The Worker itself uses
  both spellings (`packages/worker/src/core/platformCredentials.ts` against
  `core/storefront/listingModel.ts`).
- **Ecosystems (3):** `console/areas/feeds/model.ts:61`, `portal/model/packageAccess.ts:19`,
  `lib/labels.ts:120`.
- **Shared-package constants redefined:** `SYSTEM_PRODUCT_SLUG` at
  `console/areas/feeds/model.ts:41`, already in `packages/shared-manifest/src/packages.ts:67` and
  imported from there by `console/pages/core/sdkQuickStart.ts`. `TOKEN_ENV` at
  `portal/model/packageAccess.ts:17` and `console/areas/feeds/model.ts:176`.
- **Licence status and origin (2 models):** `lib/status.ts:156` `licenseState` plus `STATUS`;
  `portal/model/library.ts:426` `licenseStatus`, `:296` `FROM_SIGNING_IN` and `:403`
  `shortOrigin`.

### Settings

- Platform: `console/pages/platformSettings.tsx` (2,089 lines, 22 components) has its own row
  family (`SwitchSettingRow`, `ChoiceSettingRow`, `IntegerSettingRow`, `SettingSource`,
  `RevertButton`, `ConflictNote`, `useSettingWrites` with a `CANCELLED` symbol).
- Product: `console/components/ProductSettingsSection.tsx` (366 lines) on
  `console/templates/Settings.tsx` `SettingsRow`.
- Bespoke manifest-owned, claim and Revert forms: `areas/update/FeedPage.tsx`,
  `pages/core/Settings.tsx`, `areas/distribution/AccessPage.tsx`,
  `pages/license/EnrollmentPage.tsx`, `pages/identity/Portal.tsx`,
  `areas/feeds/FeedSettings.tsx` (1,081), `pages/release/PolicyDialog.tsx`, `ChannelLanes.tsx`,
  `areas/distribution/OutletsPage.tsx`, `pages/core/Presentation.tsx`, `pages/core/KeysCi.tsx`,
  `pages/config/CatalogPage.tsx`, `pages/release/PackGateForm.tsx`, `components/RevertClaimDialog.tsx`.
- `console/settings.generated.ts` (1,607 lines, the ⌘K settings index) is generated and kept
  fresh but imported by nothing. Its consumer is ST-10.

### Flows and wizards

- `ui/Stepper.tsx` is used by `AppStorePage.tsx` and `StorefrontsPage.tsx` only. Step machines are
  hand-rolled in `AppStorePage.tsx` (`DISTRIBUTE_STEPS`), `StorefrontsPage.tsx` (`FLOW_STEPS`,
  `StepCard.tsx`, `StepDialog.tsx`), `CreateLicenseDialog.tsx` (718),
  `portal/components/ActivateDialog.tsx` (922), `portal/components/account/SignInMethods.tsx`
  (1,137), `portal/pages/SignInPage.tsx` (759), `console/pages/global/ProductNew.tsx` (749) and
  `console/pages/core/Overview.tsx` `useChecklist` / `ChecklistPanel` (`:629`, `:747`).
- Snippet generation is shared correctly: `renderFeedSetup` comes from `@polaris-key/manifest`.
  `console/pages/core/sdkQuickStart.ts` is marked "Interim until UX-60's `renderSdkSetup` and
  UX-61's Connect your app".

### Pages over budget

43 files are over 700 lines. Selected:

| File                                             | Lines | Components | Queries | Writes | Read                                                  |
| ------------------------------------------------ | ----- | ---------- | ------- | ------ | ----------------------------------------------------- |
| `console/pages/platformSettings.tsx`             | 2,089 | 22         | 4       | 4      | a whole settings engine inside one page               |
| `console/areas/distribution/AppStorePage.tsx`    | 1,830 | 12         | 0       | 0      | the App Store Distribute flow as one file             |
| `console/pages/platformStores.tsx`               | 1,789 | 14         | 2       | 4      | store connections, apps and credential checks         |
| `ui/data-table/DataTable.tsx`                    | 1,454 | 4          | —       | —      | also exports `useMediaQuery`                          |
| `console/pages/core/Overview.tsx`                | 1,396 | 17         | **15**  | 0      | one list read per tile; `GET /summary` already exists |
| `console/pages/release/ReleaseRecord.tsx`        | 1,237 | 10         | 0       | 0      |                                                       |
| `console/pages/platformOperations.tsx`           | 1,216 | 13         | 1       | 0      | shadows `Skeleton`                                    |
| `console/pages/platformOverrideMigration.tsx`    | 1,183 | 11         | 1       | 5      | a one-off migration UI                                |
| `console/areas/distribution/CredentialsPage.tsx` | 1,146 | 5          | 0       | 3      | 17 `useState`                                         |
| `portal/components/account/SignInMethods.tsx`    | 1,137 | 7          | 0       | 0      | 18 `useState`, direct API writes                      |

Folder conventions are mixed. Product sections live in both `console/pages/<section>/` and
`console/areas/<area>/`. Platform pages sit loose in `console/pages/platform*.tsx` (5 files, about
7,000 lines). "Feed" is overloaded: `console/areas/update/FeedPage.tsx` is the update appcast and
`console/areas/feeds/FeedPage.tsx` is a package feed.

### Styling, tokens and motion

- Tokens come only from `@polaris-key/brand` (`styles.css:20-22`), which is good. The pre-brand
  alias layer (`styles.css:80-117`) has about 20 remaining uses (`bg-popover`, `border-input`,
  `bg-background`, `text-foreground`, `font-medium` and `font-semibold`, mostly in
  `console/shell/*`). It is policed by `test/tokenAliases.test.ts`.
- There are 31 arbitrary type sizes (`text-[0.9375rem]` ×12, `text-[1.75rem]` ×6,
  `text-[1.875rem]` ×5…), which EXPERIENCE §3 says to remove. Hex literals appear outside tokens in
  `portal/components/ProductArt.tsx:19-26`, `portal/components/ProductIcon.tsx:105`
  (`text-[#f4f1ff]`) and `portal/pages/AccountPage.tsx:281-282` (theme swatches). The Google
  colours in `portal/components/Glyphs.tsx:27-39` are legitimate brand marks.
- Motion: `motion.css` (912 lines) is entirely on tokens. `test/motionLint.test.ts` blocks
  `transition-all`, arbitrary durations and `animate-pulse`. `portal/components/signin/LoginCard.tsx:141`
  reimplements `tokenMs` (`ui/motion/reducedMotion.ts`).
- Three Vite source-patching plugins exist for CSP (`vite.config.ts` `sonnerNoInlineCss`,
  `styleModAdoptedSheets`, `radixSelectNoInlineStyle`). They fail the build when upstream changes,
  which is correct, but they are a standing upgrade cost.

### Accessibility

This is a strength, but the implementations are duplicated. The console has route focus plus a
live announcement (`AppShell.tsx:107`). The portal has heading focus without an announcement
(`portal/router.ts:429`). `LegacyPage` patches heading levels at runtime. Overlay detection exists
twice with different selectors, which affects when focus moves. There are no clickable
non-interactive elements outside composite widgets, and only three found inside them
(`ui/JsonViewer.tsx:269`, `ui/data-table/DataTable.tsx:749,1243`), each with keyboard handling.

### Tests and policy checks

- **Fixtures.** 21 test files build their own product fixtures. There are four unit harnesses
  (`test/consoleHarness.tsx`, `configHarness.tsx`, `releaseHarness.tsx`, `portalHarness.tsx`) plus
  `coreTestUtils.tsx`, and separate e2e fixture worlds (`e2e/portalFixtures.ts` 2,010,
  `e2e/layoutData.ts` 1,760, `e2e/portalStates.ts` 1,149, `e2e/coreFixtures.ts` 620). The kit
  gallery (`kit/stories/*`) has a third set.
- **Motion.** Motion tests total about 10,100 lines: 5,298 in unit jsdom tests (where nothing
  animates) and 4,810 in e2e.
- **Policy tests act as lint.** `motionLint`, `tokenAliases`, `queryKeyShapes`, `mutations`,
  `serviceTable` and `labels` are source-scanning tests. The repo has no linter
  (`AGENTS.md:238`), so the 35 `eslint-disable` comments in `src/` are inert. Most are
  `react-hooks/exhaustive-deps` (`ManagedPayloadEditor.tsx:364,400,426`, `ui/form.tsx:192`…), so
  stale-closure bugs in hooks are unchecked. No boundary test keeps `ui/` and `lib/` app-neutral
  or keeps the console and portal from importing each other. The `ui/` → console-router and
  `lib/` → `api.ts` leaks show this is needed.

### Dead or vestigial code (verified unused)

- Modules never imported: `portal/format.ts`, `lib/buildLabels.ts`. (`console/settings.generated.ts`
  is pending ST-10, not dead.)
- Dead exports: `lib/products.ts` (`modulesOf`, `setupStateOf`, `onboardingOf`, `nextActionsOf`,
  `trimmedOrUndefined`, `intOrUndefined`, `parseSchemaField`, `errorMessage`; only 3 of its 11
  exports are used), `lib/labels.ts` (`SOURCE_LABELS`, `FINGERPRINT_MODE_LABELS`,
  `CHANNEL_LABELS`, `CHANNEL_DESCRIPTIONS`), `lib/format.ts` `zoneName`, `console/routes.ts`
  `QUERY_KEYS`, `areas/feeds/model.ts` `REGISTRY_USERNAME`, `pages/license/holders.tsx`
  `moveVerb`, and `context.tsx` `useResource`.
- Re-export shims: `console/components/PageHeader.tsx`, a 9-line re-export with 56 importers;
  `console/shell/bits.tsx` re-exporting `Kbd` and `LiveRegion`; `console/shell/CommandPalette.tsx`
  re-exporting palette helpers.
- About 45 "older Worker" or "Worker before PX-W…/PS-04" branches. Some are speculative fields the
  Worker never sends: `PortalCapabilities.auth.oidcName`, `.providers` and `.product`
  (`portal/api.ts:27-39`), and `PortalKey.last4` (`:106`). `grep` of `packages/worker/src` finds
  no producer for any of them.

### brand and ui-qa

- `packages/brand` is well factored: generated tokens for every language, `kit-copy` with typed
  keys, the accent resolver and marks. Its gaps in this domain are only about consumers. The admin
  portal uses neither `kit-copy` nor the accent resolver; the console uses only `resolveAccent`
  (`ui/ProductLogo.tsx:2`).
- `packages/ui-qa` covers the SDK UI kits and HTML boards only (`packages/ui-qa/src/config.ts`
  `BOARDS`, `BASELINE_DIRS`). The portal's hosted sign-in card is the reference rendering of the
  `signin.*` states, yet it is not a ui-qa target. `rules/strings.debt.json` (1,760 lines) is the
  ratchet for kit string debt.

### Specs and backlog

- Specs overlap and supersede one another. ADMIN.md (2,780 lines) is partly superseded by
  EXPERIENCE.md §14 (`docs/design/EXPERIENCE.md:1645`, a 25-row supersession table). PORTAL.md is
  amended by EXPERIENCE and SIGN-IN. Code comments still cite ADMIN.md 177 times,
  `notes/S-*` 241 times and WP ids about 800 times, so many comments point at superseded sections.
- **There are two backlogs.** EXPERIENCE.md §13.3 (`:1423`) and SETUP.md / FLOWS.md define
  UX-01 to UX-81. The git log shows only UX-01, 03, 04, 05, 06a, 08, 10, 15, 20, 22, 23, 29, 31,
  34, 59, 69, 72, 77, 78 and 79 as built. The rest, including UX-40 (`AuthCard`), UX-49 (portal on
  the shared kit), UX-50 (wizard kit), UX-51 (setup state), UX-60 and UX-61 (SDK setup) and UX-81
  (flow lint), are not nodes in `workpackages.json`. So no lead dispatches them, and no WP that
  needs them can depend on them. LX-29's brief, for example, uses `AutoList` and a segmented
  stepper but depends only on LX-27, LX-28 and MO-02.

---

## Problems (ranked)

| #   | Problem                                                                                                                        | Evidence                                                                                                                                                                                                                        | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | No wizard kit or setup-state model, while the owner brief multiplies wizards                                                   | SETUP.md §1 / §1.14 (UX-50, UX-51) unbuilt; 8 bespoke step machines (above); LX-29, CM-12, Integration, channel and storefront setup and New Product are all queued                                                             | high   |
| 2   | The portal does not read the copy catalog (D-41 unimplemented); copy drifts from kits and core copy                            | 41 catalog strings retyped in `portal/`; 24 core-copy refusal codes worded again; `codeErrorText` ×3; "Try again" against "Retry"; drift on `rate_limited`; PX-12/14/15/21 will add the largest share of `signin.*` strings yet | high   |
| 3   | Two data layers; the portal reintroduces undeclared invalidation and direct writes                                             | `portal/data.ts` `qk` plus `portalKeys`; 16 hand-invalidating mutations; direct `portalApi` writes in 3 components; `StepUp.tsx:374` blanket invalidate; no policy test                                                         | high   |
| 4   | Hand-mirrored API types with no shared source, plus dead compatibility code for an atomically deployed SPA                     | 322 + ~100 interfaces; ~45 older-Worker branches; speculative never-sent fields (`oidcName`, `providers`, `product`, `last4`); `wrangler.toml:25` serves the SPA from the same version                                          | high   |
| 5   | Two settings engines and about 15 bespoke manifest-owned forms                                                                 | `platformSettings.tsx:93,111` and `ProductSettingsSection.tsx:54,69` duplicated; claim and Revert logic re-implemented per page                                                                                                 | high   |
| 6   | The unfinished chunk-11 cleanup is untracked and costs runtime work on every page                                              | `context.tsx` "TEMPORARY"; `LegacyPage` MutationObserver around every product page; alias layer; `ready`/`host`; `PageHeader` shim (56 importers); module-singleton `QueryClient` with 120 explicit references                  | medium |
| 7   | Layering leaks: the shared kit depends on the console, and the customer bundle carries the console API                         | `ui/toast.tsx:5` → `lib/errorCopy.ts:8` → `api.ts`; `ui/useUnsavedChangesGuard.tsx:2` → `console/router`; `ui/form.tsx:31` → `api.ts` `ApiError`                                                                                | medium |
| 8   | Duplicated vocabularies with conflicting ids (platforms, stores, ecosystems, licence status and origin)                        | 6 + 7 + 3 maps; `play` and `google-play`, `ms-store` and `microsoft-store`; `SYSTEM_PRODUCT_SLUG` and `TOKEN_ENV` redefined. The owner's "gate channels by platform" and "combined channel/storefront page" need one vocabulary | medium |
| 9   | Two hash routers with diverging a11y and motion behaviour                                                                      | `console/router.tsx` + `routes.ts` against `portal/router.ts`; class-based against role-based overlay detection; announcement only in the console                                                                               | medium |
| 10  | The EXPERIENCE §3 shared inventory is about 40% delivered                                                                      | Palette, `AccountMenu`, `BootScreen`, `ErrorState`, `Section`, `AuthCard`, `KeyField`, product mark and `AttentionList` each still have two implementations; `ui/Section` has 3 users against about 50 hand-rolled cards        | medium |
| 11  | Two backlogs; open UX packages are invisible to the program graph                                                              | About 50 UX ids open and not in `workpackages.json`; WP deps cannot name them (LX-29 against UX-50; PX-12 against UX-40)                                                                                                        | medium |
| 12  | Oversized, mixed-responsibility page files and two folder conventions                                                          | 43 files over 700 lines; `Overview.tsx` makes 15 list reads for tile counts; `pages/` against `areas/`; loose `platform*.tsx`                                                                                                   | medium |
| 13  | Tests duplicate fixtures across three worlds and over-test motion in jsdom; there is no linter, so hook-deps bugs go unchecked | 21 private product builders; 3 fixture worlds; about 10.1k motion test lines; 35 inert `eslint-disable` comments                                                                                                                | medium |
| 14  | Product colour has two models, and the portal hard-codes its tints                                                             | `ProductArt.tsx:18` `TINTS` plus `tintColor` from `branding_json` (retired by ST-25) against `presentation.accent` (HA-12, in flight) plus `resolveAccent`                                                                      | low    |
| 15  | Dead modules and exports                                                                                                       | See the list above (about 25 symbols, 2 modules)                                                                                                                                                                                | low    |
| 16  | Specs supersede one another, and comments cite superseded sections                                                             | EXPERIENCE §14 table; 177 ADMIN.md citations                                                                                                                                                                                    | low    |
| 17  | "Feed" overloaded in code (update appcast, package feed, storefront feed)                                                      | Two `FeedPage` components; the glossary (`packages/docs/src/content/docs/start/concepts.md:452`) has to disambiguate                                                                                                            | low    |
| 18  | Arbitrary type sizes and non-token hex values                                                                                  | 31 `text-[…]` sizes; `ProductIcon.tsx:105`, `AccountPage.tsx:281`                                                                                                                                                               | low    |

---

## Owner brief: item-by-item stance

The stances below concern what the frontend code must provide. The product decisions themselves
belong to the other domain audits.

| Brief item                                                                                     | Stance | Frontend consequence and reason                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| "Similar features and services should be consolidated"                                         | adopt  | Applies directly to code: one router core, one data layer, one copy source, one settings engine, one wizard kit, one component per concept (EXPERIENCE §3 completed).                                                                                                                                                                                                                                                                                       |
| "Reduce the configuration surface area"                                                        | adopt  | One registry-driven settings engine (ST-07) replaces about 15 bespoke forms. Nav `requires` declares visibility as data, so no page carries its own conditionals.                                                                                                                                                                                                                                                                                           |
| "Excellent onboarding: wizards, instructions, example code, automatic configuration"           | adapt  | Build the SETUP.md wizard kit first, **trimmed**: ship `Wizard` (page or drawer), `Stepper`, five step kinds (Choose, Form, Snippet, Wait, Done), `PrereqList` and `AutoList`. Add `DeepLinkStep`, `RepoChangeStep` and `ConfirmStep` only when their first consumer needs them. Nine step kinds plus five auxiliaries up front is more kit than the first three wizards need. Step state comes from the Worker's facts (UX-51), never from `localStorage`. |
| "Automate whatever can be"                                                                     | adopt  | The wizard kit's `AutoList` is the one place automated work is shown. The runner is the Worker's job (UX-68; another domain).                                                                                                                                                                                                                                                                                                                               |
| "Graceful degradation when a service is off"                                                   | adopt  | Generalise `nav.ts` `requires` from pages to panels. A composite page (channel + storefront) assembles panels that each declare `requires: service                                                                                                                                                                                                                                                                                                          | feature | capability`. A panel whose side is off renders that side's wizard entry or nothing, never an error. |
| Product wizard plus an in-app "Integration" section, dismissible after an end-to-end handshake | adapt  | One `IntegrationPanel` replaces Overview's `ChecklistPanel` (`Overview.tsx:747`), `sdkQuickStart.ts`, `Welcome.tsx` and `FirstReleasePanel.tsx`, built on the wizard kit's `SnippetStep` and `WaitingFor` over `renderSdkSetup` (UX-60). "Dismissed" is per-product setup state on the Worker, not browser storage, so it follows the operator across devices. Showing the dismiss only after a verified SDK sighting is a Worker fact (UX-61).             |
| Licences simplified; bound against floating; automatic grants                                  | adopt  | One licence vocabulary module (status, origin, tier label, device text) shared by console and portal, replacing `lib/status.ts:156` and `portal/model/library.ts:426`. LX-14, LX-15 and LX-29 depend on it.                                                                                                                                                                                                                                                 |
| Entitlements, sub-licences, IAP multiplicity                                                   | defer  | Product shape belongs to the licensing domain. Frontend requirement: the LX-14 tabs are built on `PageTabs`/`TabPanel` and `DataTable`, not bespoke.                                                                                                                                                                                                                                                                                                        |
| Tiers tied to config profiles; config layering                                                 | adopt  | `ManagedPayloadEditor.tsx` already serves three layers (profile, licence, account). Move it to `console/sections/config/components/` and keep one editor for every layer.                                                                                                                                                                                                                                                                                   |
| Subscriptions in the licensing model                                                           | defer  | Licensing and commerce domains decide. CM-11 and CM-12 must use the shared settings engine and wizard kit (backlog edits below).                                                                                                                                                                                                                                                                                                                            |
| Config types and visibility levels                                                             | defer  | Config domain. Frontend note: `CatalogEntryForm.tsx` (920) should derive its fields from a kinds table, so a fourth type is data, not branches.                                                                                                                                                                                                                                                                                                             |
| Release UI reflects OS and architecture; hide channels and storefronts with no matching build  | adopt  | One platform vocabulary (on `@polaris-key/manifest` `buildLabel`) and the `ScopeChips` component (SETUP §1.14). Delete the six platform maps.                                                                                                                                                                                                                                                                                                               |
| One sidebar entry per relevant distribution channel; a combined channel and storefront page    | adopt  | `nav.ts` gains **derived items**: a section can list items computed from product facts (the storefront catalogue, UX-52/53) instead of a static array. One `StorePage` shell with panels from Distribution and Commerce; each panel declares `requires`. Store ids, labels, platforms and roles come from one generated registry (`tools/stores.json` → `stores.generated.ts`), as services already do.                                                     |
| Feeds behind per-account tokens; developers see SDK packages                                   | adopt  | One `TokenList`, `TokenCreateDialog` and `TokenSetup` (snippets from `renderFeedSetup`) in `ui/`, used by console Feeds and the portal Account page, replacing `RegistryTokens.tsx` and `PackageAccessCard.tsx`.                                                                                                                                                                                                                                            |
| Identity: one sign-in system across experiences                                                | adopt  | `AuthCard` in `ui/auth/` (UX-40), reading `signin.*` from the catalog (D-41). PX-12, 14, 15 and 21 and the console sign-in (UX-42) build on it. One `CodeEntry` replaces three.                                                                                                                                                                                                                                                                             |
| Console accounts through the same account system; RBAC                                         | adapt  | The frontend contract is one `can(capability, scope)` read from `/me`. Nav items and panels declare `requires: { capability }`, and one `NoAccessPage` covers both "Console access only" and a deep link without rights. No page checks roles. The role model itself belongs to the RBAC domain (ST-21, ST-22).                                                                                                                                             |
| Platform settings laid out intelligently; Platform against Product sidebar                     | adopt  | ST-09 replaces `platformSettings.tsx` wholesale on the shared engine. The sidebar switches modes from `nav.ts` (`PLATFORM_GROUP` already exists) instead of drawing both trees.                                                                                                                                                                                                                                                                             |
| Portal: What's New formatted and summarised                                                    | adopt  | A shared `ReleaseNotes` renderer: a safe Markdown subset (headings, lists, emphasis, code, links with `rel="noopener"`; no HTML) with a `summary` mode (first section or first N items, then **Show full notes**). It replaces `noteBlocks` (`portal/model/product.ts:662`). Generated summaries are out of scope.                                                                                                                                          |
| Portal: device count as a pill in the product sidebar                                          | adopt  | `portal/components/product/SectionNav.tsx` renders `labels` as text ("Devices 2"). Render a count badge instead.                                                                                                                                                                                                                                                                                                                                            |
| Portal: product sidebar layout while scrolling                                                 | adopt  | In `SectionNav.tsx` the TOC is `sticky top-24` while the page header and section `scroll-mt-36` differ (`product/Card.tsx`). Align them with one scroll-offset token.                                                                                                                                                                                                                                                                                       |
| Portal: OIDC licence source reads "Automatic Grant"                                            | adapt  | Change it **in the catalog** (`signin.choice.origin.signIn`, today "From signing in"), so the portal and every kit move together. Use sentence case per the copy rules: "Automatic grant". This reverses an earlier wording decision (SIGN-IN D-53: "origin shown as plain words"), so record it as an owner decision.                                                                                                                                      |
| Portal: licence-type pill top-right of License Details                                         | adopt  | `portal/components/product/LicenseCard.tsx:168`: move the tier `StatusPill` into the `SectionCard` `aside`.                                                                                                                                                                                                                                                                                                                                                 |
| Portal: remove "0 out of 5 devices" from License Details                                       | adopt  | `LicenseCard.tsx:148` (`licenseCountLine` and `showsDeviceCount` in `portal/model/product.ts:628,640`).                                                                                                                                                                                                                                                                                                                                                     |
| Console: simpler product card (name and slug header, a row of service icons)                   | adopt  | `console/pages/global/Home.tsx:420` `ProductCard` drops the ledger rows. On phones, name plus `ServiceDots` (`console/shell/bits.tsx`, already built). This also removes `GET /manage/api/summary` (`packages/worker/src/admin/handlers/summary.ts`, `admin/lib/summary.ts`), `useSummary`, `qk.summary` and the 14 `summary()` invalidations in `mutations.ts`. Keep attention pills in the header.                                                        |
| "Run code quality audits: duplication, smells, consistency, extensibility"                     | adopt  | This document. The CQF WPs below.                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## Target design

### 1. Layers and boundaries (one package, enforced)

```text
packages/admin/src/
  lib/        pure TS: http, copy (t()), format, storage, vocab/* (platforms, stores, ecosystems,
              channels, license), errors (ErrorCopy interface), router-core
  ui/         React kit: every EXPERIENCE §3 component, ui/auth/, ui/wizard/, ui/settings/,
              ui/motion/, data-table/, charts/; app-neutral: no console/ or portal/ imports,
              copy via props or t()
  console/    app: shell/, nav.ts, routes.ts, data/ (queryOptions + MUTATIONS),
              sections/<core|license|config|release|distribution|update|identity|sync|platform|global>/
                pages/  components/  model/  data.ts
  portal/     app: shell, routes, data/ (queryOptions + MUTATIONS), pages/, components/, model/
```

A `test/boundaries.test.ts`, modelled on `packages/worker/test/boundaries.test.ts`, enforces this:
`lib/` imports nothing local but `lib/`; `ui/` imports only `lib/` and `ui/`; `console/` and
`portal/` never import each other; no module reachable from `portal/main.tsx` imports
`console/**` or `api.ts`. **Pushback on a separate workspace package** (`@polaris-key/web-kit`):
the console and portal are its only consumers, and a package adds build and exports configuration
for no reuse. The boundary test gives the same guarantee without it.

### 2. One data layer for both apps

- **Transport.** `lib/http.ts` provides `createClient({ base, csrfHeader, onUnauthorized })`
  returning `call`, `callText` and `send`, with one `HttpError(status, code, { fields, errors,
reason, triesLeft, retryAfter, message })`. It parses both the nested and the flat error shapes,
  and status 0 means a network failure in both apps. The console sets
  `onUnauthorized: redirect | in-place` (UX-02); the portal re-checks the session.
- **Clients.** `console/api/<service>.ts` and `portal/api/<area>.ts` split the two monoliths along
  the Worker's own service grouping. `AdminApi` is the composed type, so the `MUTATIONS` mapped type
  keeps working.
- **Types from the Worker.** Response shapes become type-only exports
  (`packages/worker/src/admin/dto/*.ts` and `services/identity/portal/dto.ts`, exposed as
  `@polaris-key/worker/dto` with `types` only). The admin imports them with `import type`, so the
  build never pulls in Worker runtime code. Migrate area by area; each area deletes its mirrors and
  its "older Worker" branches together. This is not a wire change: the admin API is narrative-only
  (`docs/design/ADMIN.md:2676`), and SDKs and the corpus are untouched.
- **Reads.** `queryOptions` factories bind key and fetcher once (`q.license.list(slug)`,
  `q.catalog(slug)`). Pages call `useQuery(q.catalog(slug))`. The `qk` prefix scheme stays as the
  factories' keys. The duplicated hooks and `test/queryKeyShapes.test.ts` go: two shapes per key
  become impossible by construction.
- **Writes.** The portal adopts the console's pattern: `portal/data/mutations.ts` with
  `PORTAL_MUTATIONS` (`label`, `invalidates`, `why`), a `useWrite(method)` hook wrapping
  `useMutation`, and the same "no direct write" test. Sign-in, step-up and methods writes go
  through it.
- **Client.** Provider-scoped in both apps. `queryClient.ts`'s singleton, the 120 explicit
  `queryClient` arguments, `context.tsx` and `AdminProvider` all go. `useAdmin()` becomes
  `useMe()`.

### 3. One router core

`lib/router-core.ts` holds the hash store (`useSyncExternalStore`), redirect application, query
parameters (`get`/`set` with codecs, replace-not-push), blockers, and View Transition dispatch
with **one** overlay detector (role-based plus the sonner selector). `ui/` exports `focusRoute()`
with heading focus **and** the "{page} loaded" announcement for both apps. The route tables stay
per app (`console/routes.ts`, `portal/routes.ts`). The shared-element hooks (`data-vt-shared` and
`data-vt-source`) become one attribute. `ui/useUnsavedChangesGuard.tsx` depends on the core, not
on the console router.

### 4. Vocabularies as data

- `tools/stores.json` → `pnpm gen:stores` → `packages/admin/src/stores.generated.ts` and
  `packages/worker/src/core/stores.generated.ts`. Each row has an id, aliases (`play` ↔
  `google-play`, `ms-store` ↔ `microsoft-store`), a label, a glyph key, platforms, roles
  (`outlet`, `storefront`, `signInProvider`, `purchaseSource`) and a `--check` mode. No wire id
  changes: aliases only normalise display. This mirrors `tools/services.json` exactly.
- `lib/vocab/platforms.ts` sits over `@polaris-key/manifest` `buildLabel` (one table, one glyph
  set: `PlatformGlyphs` moves to `ui/`).
- `lib/vocab/ecosystems.ts` reuses `SYSTEM_PRODUCT_SLUG` from manifest and holds `TOKEN_ENV` once.
- `lib/vocab/license.ts` holds status, origin, tier label and device text for both apps. The origin
  words come from the catalog.
- Licence-key format (`portal/model/key.ts` `KEY_PATTERN`, `checkKey`, `maskKey`) moves to
  `@polaris-key/manifest`, beside the other shared format helpers, so UK-03's `KeyField` and the
  portal agree. Putting it in `shared-protocol` or `client-core` instead would be a plan-mode
  change; manifest is not.

### 5. One copy source for customer-facing text

`lib/copy.ts` exposes `t(key: KitCopyKey, args?)` over `@polaris-key/brand/kit-copy` (English
bundled; other locales lazy through `loadKitCopy`) with an ICU-subset formatter (plural, select,
arguments). Reuse UK-03's formatter if it lands first, otherwise ship it in brand and let UK-03
import it. The portal and `ui/auth` use `t()` exclusively for customer strings. Refusal codes
resolve through `core.<code>.title/message` (already inside the generated table), so
`portal/errors.ts` shrinks to the routing of codes to actions. The console stays local English for
operator copy, but `ErrorState` takes an `ErrorCopy` resolver, so each app supplies its voice and
the component is one. ui-qa gains a `portal` board fed by `e2e/portalStates.ts`. That runs the
string lint over the hosted card, the reference rendering of `signin.*`.

### 6. The shared component inventory, finished

Complete EXPERIENCE.md §3 (`docs/design/EXPERIENCE.md:869`) with these additions:

- `ProductMark`: one component, sizes 20 to 112, from `presentation.icon` and
  `presentation.accent` through `resolveAccent`, with a neutral monogram fallback. It replaces
  `ui/ProductLogo`, `portal/ProductIcon` and the `ProductArt` tint field. Header art stays
  `ProductArt` on the same accent.
- `ReleaseNotes`: as described in the owner-brief table above.
- `TokenList`, `TokenCreateDialog` and `TokenSetup`: as described in the owner-brief table above.
- `CodeEntry`: in `ui/auth`.
- `CheckRow` / `PrereqList`: one row model shared by the wizard kit, release health, resync plans
  and operations health.
- Utilities: `useMediaQuery`, `useFirstLoad`, `recents` and `lib/storage.ts` (the console's
  `readPref`/`writePref` and `PREF_KEYS`, used everywhere).
- `Section`: the only card. A codemod replaces `SectionCard` and the hand-rolled card class
  strings, and a test then rejects new ones.
- The type scale is `display`, `title`, `section` and `row` only. The 31 arbitrary sizes go, and a
  lint test rejects `text-[` sizes outside `ui/`.

### 7. Wizard kit and setup state

`ui/wizard/` holds `Wizard` (`host="page" | "drawer"`, URL-synced `?step=`, unsaved guard, focus
and announcements per FLOWS.md), `Stepper` (replacing `ui/Stepper.tsx`), `ChoiceStep`, `FormStep`
(on `useAdminForm`), `SnippetStep`, `WaitingFor`, `DoneStep`, `PrereqList` and `AutoList`. The
Worker side is UX-51's per-subject setup read (`GET …/setup?wizard=`), whose step states are
computed from facts. The first adopters prove the kit:

1. `StorefrontsPage` `FLOW_STEPS`, migrated as the proof;
2. LX-29 New License, in a drawer;
3. the Integration panel;
4. New Product (UX-74).

`AppStorePage`'s Distribute flow becomes panels of the App Store `StorePage` plus `ConfirmStep`
when that kind is added.

### 8. Settings: one engine

ST-07's `SettingsRow` v2 becomes `ui/settings/`. Rows render from the registry definition (kind,
confirm level, ownership, critical, secret) plus the effective value and source. One
`useSettingWrite(key, scope)` handles `expectedVersion`, the confirm gate, conflicts and Revert.
Platform scope and product scope are the same component. The bespoke forms listed under Current
state migrate in ST-08 and ST-09, and `ProductSettingsSection.tsx` and `platformSettings.tsx`'s
row family are deleted.

### 9. Pages: templates and budget

Every page is one of the templates: Collection, Record (routed `PageTabs` plus `TabPanel`), Settings
(the engine), Dashboard, or a wizard host. Pure logic lives in `model/`, as the portal already does
well. A size test fails page files over 600 lines, with an allow-list that may only shrink.
Overview reads one per-product overview, the same facts `GET /summary` computes, instead of 15
list reads. Platform pages move under `console/sections/platform/`.

### 10. Nav as the single declaration

Delete `ready` and `host`, and delete the console's `LEGACY_REDIRECTS`: the console is
operator-only and pre-1.0. Keep the portal's email-link redirects (`/activate?key=`), because they
are in sent mail. `requires` becomes `service | feature | capability`. Sections may have derived
items (store pages). The sidebar mode is Platform or Product.

### 11. Tests and lint

- `test/fixtures/` holds typed builders over the Worker DTO types (`aProduct()`, `aLicense()`,
  `aDevice()`…) plus named scenarios (the PORTAL.md cast). Unit tests, e2e and the kit gallery all
  use them.
- One fetch router (`route(method, path, handler)`) serves both harnesses.
- Motion is verified by `motionLint` and the e2e motion suites. Unit jsdom motion tests keep only
  logic, such as `navigationTransition` and the reduced-motion gate.
- Add **oxlint**: zero-config, one binary, run from `pnpm lint` for `packages/admin` and
  `packages/brand`, with `react-hooks/*`, `jsx-a11y/*` and the TypeScript correctness rules. The
  inert `eslint-disable` comments become real or go. Keep the source-scanning policy tests; they
  encode project rules no linter has.

### 12. Specs

The living docs are PORTAL.md and ADMIN.md (current-state, rewritten from the EXPERIENCE, SETUP,
FLOWS and SIGN-IN amendments). EXPERIENCE.md §14 and the superseded sections are deleted. New
code comments cite behaviour and living sections, not WP ids or `notes/S-*`.

---

## Surface-area reduction

| Removed or merged                                                                                                                                                                                 | Replaced by                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `context.tsx` (`useResource`, `useAdmin`, `AdminProvider`, `invalidate`, `resetCache`)                                                                                                            | `useMe()`, `useQueryClient()`, test `renderWithClient`           |
| `console/shell/LegacyPage.tsx` (runtime `h2`→`h1` promotion)                                                                                                                                      | `PageHeader` everywhere (already true; delete the wrapper)       |
| `console/components/PageHeader.tsx` shim (56 importers), `shell/bits.tsx` re-exports, `CommandPalette.tsx` re-exports                                                                             | direct `ui/` imports (codemod)                                   |
| Module-singleton `QueryClient` and 120 explicit `queryClient` arguments                                                                                                                           | provider-scoped client                                           |
| `nav.ts` `ready` and `host` (59 flags); console `LEGACY_REDIRECTS`                                                                                                                                | nothing                                                          |
| Token alias layer (`styles.css:80-117`) and its test                                                                                                                                              | brand utilities directly (about 20 call sites)                   |
| Two routers                                                                                                                                                                                       | `lib/router-core.ts` plus two route tables                       |
| Two transports and two error classes; two error renderers (`ErrorPanel`, `ErrorState`)                                                                                                            | `lib/http.ts` `HttpError`; `ui/ErrorState` with a voice resolver |
| `portal/data.ts` `qk` plus `portalKeys` (duplicate key tables); 16 hand-invalidating mutations; direct component writes                                                                           | `q.*` factories; `PORTAL_MUTATIONS`                              |
| Duplicate hooks (`useCatalog`, `useProfiles`, `useDeliverables`…) and `test/queryKeyShapes.test.ts`                                                                                               | `queryOptions` factories                                         |
| 322 + about 100 hand-mirrored interfaces; about 45 older-Worker branches; speculative never-sent fields                                                                                           | Worker DTO types (type-only)                                     |
| 6 platform, 7 store, 3 ecosystem label maps; `SYSTEM_PRODUCT_SLUG` and `TOKEN_ENV` copies; `lib/buildLabels.ts`; `portal/format.ts`                                                               | `lib/vocab/*`, `stores.generated.ts`, manifest                   |
| Two licence status and origin models                                                                                                                                                              | `lib/vocab/license.ts` plus catalog words                        |
| Two palettes, three recents, three initials, six media-query hooks, two `useFirstLoad`, two `BootScreen`s, `SectionCard` plus about 50 hand-rolled cards, two product marks plus hard-coded tints | single `ui/` components                                          |
| `RegistryTokens.tsx` plus `PackageAccessCard.tsx` token halves                                                                                                                                    | `ui/TokenList` family                                            |
| Three `codeErrorText` and code-entry flows                                                                                                                                                        | `ui/auth/CodeEntry` plus catalog keys                            |
| Two settings-row engines plus about 15 bespoke manifest-owned forms                                                                                                                               | `ui/settings` engine (ST-07 to ST-09)                            |
| Eight bespoke step machines                                                                                                                                                                       | `ui/wizard`                                                      |
| `GET /manage/api/summary`, `useSummary`, `qk.summary`, 14 invalidations (if the owner's simpler card is adopted)                                                                                  | the card reads `products` only                                   |
| `console/pages/*` against `console/areas/*`; loose `platform*.tsx`                                                                                                                                | `console/sections/<section>/`                                    |
| Three fixture worlds; 21 private product builders; about 5k lines of jsdom motion tests                                                                                                           | `test/fixtures/` builders and scenarios; e2e motion plus lint    |
| Dead exports (about 25) listed above                                                                                                                                                              | nothing                                                          |
| EXPERIENCE §13.3 as a second backlog                                                                                                                                                              | rows in `workpackages.json` (or dropped)                         |

---

## Automation and onboarding

- **Wizard kit first.** Every onboarding surface the owner asks for is the same few components,
  so building `ui/wizard` once (CQF-09) is the automation and onboarding lever for the whole
  frontend: the product wizard, Integration, per-channel and per-storefront setup, licensing and
  sign-in quick starts. Each later wizard is only its step content.
- **Snippets are generated, never typed.** Continue the `renderFeedSetup` pattern. UX-60's
  `renderSdkSetup` in `@polaris-key/manifest` is the only source of SDK setup code in the console,
  the docs and the CLI. `SnippetStep` renders it with live values (slug, pins, feed origin). The
  interim `console/pages/core/sdkQuickStart.ts` is deleted when UX-60 lands.
- **Setup state is a Worker fact.** The Integration dismiss, step completion and "handshake seen"
  come from the setup read (UX-51, UX-61's SDK sightings), not `localStorage`. The panel appears
  or disappears for every operator consistently.
- **Generated vocabularies.** `stores.json` makes "which channels does this product's build list
  allow" a pure function the sidebar, wizards and portal all call. This automates the owner's
  "only show relevant channels".
- **Catalog-driven copy.** One string change updates the portal, the Worker card and every kit
  (for example "Automatic grant"), and the ui-qa string lint catches drift automatically.
- **Developer onboarding to this codebase.** The boundary test, the size budget, oxlint and one
  pattern per concern (`q.*` reads, `MUTATIONS` writes, `ui/settings` rows, `ui/wizard` flows)
  make the right way the only way. Add a one-page `packages/docs/src/content/docs/contribute/console.md`
  "How to add a page, a setting, a wizard, a write" (folded into CQF-13).

---

## Migration, data and risk

- **No wire changes.** Nothing here touches signed documents, `client-core`, `shared-jws`,
  `PROTOCOL_VERSION` or the corpus. Two places could become plan-mode if done differently:
  1. moving the licence-key format to `shared-protocol` or `client-core`. Use
     `@polaris-key/manifest` instead.
  2. having `gen:stores` emit SDK constants. Keep it to TypeScript (admin, worker, cli) unless an
     SDK needs it.
- **Worker touches** (not wire):
  - type-only DTO modules (CQF-03);
  - the `setup_state` table and routes (CQF-09, UX-51; migration named `00XX_setup_state.sql`,
    with the number assigned by the lead);
  - `stores.generated.ts` (CQF-05);
  - deleting `GET /manage/api/summary` (CQF-12, if adopted). This needs the narrative admin docs
    updated and `packages/worker/test/adminSummary.test.ts` removed.
- **In-flight collisions.** LX-08 and HA-12 touch only `console/pages/platform.tsx` and
  `console/settings.generated.ts`: no conflict with CQF-01 to CQF-08. PS-05, PS-06, LX-30, PX-13,
  PX-20 and PX-24 are in review and touch the portal and console. Land them first, then run the
  **mechanical** changes (CQF-01 deletions and codemods, the CQF-10 folder move) as one agent in
  one window, so other branches rebase once. The folder move is pure `git mv` plus import
  rewriting. Do it immediately after a batch merge and before the next dispatch.
- **Sequencing against feature WPs** (also in the backlog table):
  - CQF-06 (copy) and CQF-08 (`AuthCard`) before PX-12, 14, 15, 21 and 25;
  - CQF-09 (wizard) before LX-29, CM-12 and UX-74;
  - CQF-05 (vocab) before LX-14, LX-15 and the storefront and channel UI;
  - ST-07 before any new settings page.
    Otherwise each feature WP adds another copy to remove later.
- **Bundle and security.** CQF-02 removes `api.ts` (every `/manage/api` path) from the customer
  bundle. Verify with a build-graph assertion in the boundary test: no module reachable from
  `portal/main.tsx` imports `console/**` or `api.ts`.
- **Copy changes are visible.** Adopting the catalog fixes drift (for example the `rate_limited`
  wording), so some portal strings change. Update `e2e/portalStates.ts` text expectations and the
  portal baselines (`scripts/portal-baselines.sh`) in the same PR. Translations come for free but
  stay behind English-only until a locale switch is decided; do not ship partial locales.
- **Type migration risk.** Moving to Worker DTO types will surface real drift as type errors.
  Treat each as a bug (fixture or UI), not as a reason to widen a type. Go area by area so no PR is
  a big-bang change.
- **Test churn.** Fixture consolidation touches many files. Do it per area together with the DTO
  migration (CQF-03 and CQF-11 can pair), and never as a separate global rewrite.
- **CSP plugins.** Unchanged by this work. Keep them, and add Radix and sonner upgrades to the
  dependency-bump checklist.
- **Version skew.** The only legitimate reason for older-Worker branches would be a gradual
  deployment serving old assets against a new API. Cover it with **one** guard instead of per-field
  branches: the SPA compares its build tag with `/platform/version` (A-11) on focus and offers a
  reload.

---

## Backlog changes

| id                                                                                    | action  | target                | note                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-07                                                                                 | edit    | —                     | `SettingsRow` v2 is **the** engine in `ui/settings/` for both scopes. Delete the duplicated `confirmLevel`/`formatSettingValue` (`platformSettings.tsx:93,111`, `ProductSettingsSection.tsx:54,69`). Ship `useSettingWrite` with conflict and Revert handling.                                |
| ST-08                                                                                 | edit    | —                     | Migrate the bespoke manifest-owned forms (`areas/update/FeedPage.tsx`, `pages/core/Settings.tsx`, `areas/distribution/AccessPage.tsx`, `pages/license/EnrollmentPage.tsx`, `pages/identity/Portal.tsx`, `areas/feeds/FeedSettings.tsx`) onto the engine. Delete `ProductSettingsSection.tsx`. |
| ST-09                                                                                 | edit    | —                     | Replace `platformSettings.tsx` (2,089 lines) wholesale. CQF-10 does **not** split that file separately.                                                                                                                                                                                       |
| ST-10                                                                                 | keep    | —                     | The only consumer of `console/settings.generated.ts`, which is unimported until then.                                                                                                                                                                                                         |
| ST-21                                                                                 | edit    | —                     | `useCan` lands as `nav.ts` `requires.capability` plus one `NoAccessPage` in the shell. No per-page role checks.                                                                                                                                                                               |
| LX-29                                                                                 | edit    | CQF-09                | Add dep CQF-09. The New License drawer is built on `ui/wizard` (drawer host, `AutoList`), not as a fourth bespoke stepper.                                                                                                                                                                    |
| LX-14                                                                                 | edit    | CQF-05                | Add dep CQF-05 (licence vocabulary). Entitlements and Grants tabs on `PageTabs`/`TabPanel` plus `DataTable`.                                                                                                                                                                                  |
| LX-15                                                                                 | edit    | CQF-05, CQF-06        | Add deps. Origins from the catalog (the owner's "Automatic grant").                                                                                                                                                                                                                           |
| PX-12                                                                                 | edit    | CQF-06, CQF-08        | Add deps. `MethodStack`, `CodeEntry`, `ProviderRow` and `UsualMethodHint` land in `ui/auth/` and read `signin.*`.                                                                                                                                                                             |
| PX-14, PX-15, PX-21                                                                   | edit    | CQF-08                | Add dep CQF-08. Build as `AuthCard` steps.                                                                                                                                                                                                                                                    |
| PX-25                                                                                 | edit    | CQF-06                | Add dep. New account strings go into the catalog.                                                                                                                                                                                                                                             |
| PX-09                                                                                 | edit    | CQF-05, CQF-07        | Use the shared platform vocabulary, `ScopeChips` and `ReleaseNotes`.                                                                                                                                                                                                                          |
| PX-18                                                                                 | edit    | —                     | One Cloud Sync card component shared with the U-11a Data tab (`Section`, `DataTable`).                                                                                                                                                                                                        |
| U-11a                                                                                 | edit    | —                     | Build on the ST-07 engine for the settings half. Share the Cloud Sync components with PX-18.                                                                                                                                                                                                  |
| CM-11, CM-12, CM-16                                                                   | edit    | CQF-05, CQF-09, ST-07 | Merchant and offer setup on the wizard kit; settings on the engine; store identities from `stores.generated.ts`.                                                                                                                                                                              |
| MO-13                                                                                 | edit    | CQF-10                | Trim: drop "commit real-app strips" (repo artefacts that go stale on every UI change). The `pk-vt-tabpanel` follow-up becomes "adopt `TabPanel` on every record" inside CQF-10. Keep the contributor docs page and the 30-second poll QA.                                                     |
| UK-02b                                                                                | edit    | —                     | Add the portal's hosted card as a consumer of the `signin-form` fixtures (`e2e/portalStates.ts` reads them).                                                                                                                                                                                  |
| UK-03                                                                                 | edit    | CQF-06                | The ICU-subset formatter is a framework-free module the portal imports. If CQF-06 lands first it ships in brand and UK-03 reuses it.                                                                                                                                                          |
| HA-13                                                                                 | edit    | CQF-07                | The portal's `ProductMark` and `ProductArt` read `presentation.accent` through `resolveAccent`. Delete `TINTS` (`ProductArt.tsx:18`).                                                                                                                                                         |
| ST-25                                                                                 | edit    | —                     | Includes deleting the portal's `branding_json` `tintColor` read (`portal/model/library.ts:183` `readPresentation`).                                                                                                                                                                           |
| I-11                                                                                  | edit    | —                     | Re-scope to the unbuilt residue. Library, Discover, the Activate modal, the product page and account settings were delivered by PX-02 to PX-24. What remains: the support code on the product page, per-product export and deletion, and the Core revocation hook.                            |
| PX-20                                                                                 | keep    | —                     | In review. After it merges, its fixtures move into CQF-11's shared builders.                                                                                                                                                                                                                  |
| PS-05, PS-06, LX-30, PX-13, PX-24                                                     | keep    | —                     | In review. Merge before CQF-01 and CQF-10 run.                                                                                                                                                                                                                                                |
| UX-40, UX-49                                                                          | merge   | CQF-08, CQF-07        | Not in `workpackages.json`. Fold into the CQF WPs.                                                                                                                                                                                                                                            |
| UX-50, UX-51                                                                          | merge   | CQF-09                | Not in `workpackages.json`. Fold in; trim the step kinds (see Target design §7).                                                                                                                                                                                                              |
| UX-11, UX-13, UX-14                                                                   | merge   | CQF-07, CQF-10        | Pill and copy sweep, chrome and page anatomy are component-consolidation work.                                                                                                                                                                                                                |
| UX-81                                                                                 | merge   | CQF-11                | Flow lint joins the test and lint consolidation.                                                                                                                                                                                                                                              |
| UX-02, 06b, 07, 12, 21, 26, 27, 30, 33, 35–37, 41–48, 52–58, 60–68, 70, 71, 73–76, 80 | reorder | (domain audits)       | Register each as a `workpackages.json` row, or drop it, in the consolidation plan. Today they cannot be dependencies. CQF-13 does the bookkeeping; the domain audits decide content.                                                                                                          |
| PX-19                                                                                 | keep    | —                     | Portal docs. CQF-13 supplies the living-spec rewrite they link to.                                                                                                                                                                                                                            |

---

## New work packages

| Proposed id | Title                                                   | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                    | Deps                                                             | Plan mode | Size     |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------- | -------- |
| CQF-01      | Finish the shared-layer cleanup (ADMIN chunk 11)        | Delete `context.tsx`, `LegacyPage`, the `PageHeader` and `bits` shims (codemod 56 importers), `nav.ts` `ready`/`host`, console `LEGACY_REDIRECTS`, dead modules and exports (list above), the token-alias layer (about 20 sites) and the 31 arbitrary type sizes. Make the `QueryClient` provider-scoped. Add `test/boundaries.test.ts` (ui/lib neutral; console and portal isolated; portal graph free of `console/**` and `api.ts`).   | in-review console and portal WPs merged                          | no        | 0.5–0.8w |
| CQF-02      | One data layer for both apps                            | `lib/http.ts` and `HttpError`. Split `api.ts` and `portal/api.ts` per service. Decouple `lib/errorCopy` from `api.ts` (drops `api.ts` from the portal bundle). `queryOptions` factories for every read. `PORTAL_MUTATIONS` plus `useWrite` plus a no-direct-write test. Delete the duplicate hooks and `queryKeyShapes.test.ts`. One `ErrorState` with a voice resolver; delete `ErrorPanel`. Remove the older-Worker branches per area. | CQF-01                                                           | no        | 1.2–1.6w |
| CQF-03      | Worker-owned DTO types for the admin and portal APIs    | Type-only `packages/worker/src/admin/dto/*` and `services/identity/portal/dto.ts` exported as `@polaris-key/worker/dto`. Migrate the admin mirrors area by area. Delete speculative never-sent fields (or file Worker gaps for them).                                                                                                                                                                                                    | CQF-02                                                           | no        | 1.5–2w   |
| CQF-04      | Shared hash-router core                                 | `lib/router-core.ts` (store, redirects, params, blockers, View Transitions, one overlay detector) plus `focusRoute` with announcement. Both apps keep their route tables. `useUnsavedChangesGuard` on the core.                                                                                                                                                                                                                          | CQF-01                                                           | no        | 0.6–0.9w |
| CQF-05      | Vocabularies as data, and the stores registry           | `tools/stores.json` → `gen:stores` (admin and worker, `--check` in the gate). `lib/vocab/{platforms,ecosystems,channels,license}.ts`. Licence-key format to `@polaris-key/manifest`. Delete the 6, 7 and 3 maps and the constant copies.                                                                                                                                                                                                 | CQF-01                                                           | no        | 0.7–1w   |
| CQF-06      | The portal on the copy catalog (D-41)                   | `lib/copy.ts` `t()` over `@polaris-key/brand/kit-copy` with an ICU-subset formatter. Replace the 41 verbatim strings, the `// signin.*` placeholders and the 24 refusal-code wordings (via `core.*`). Origin word "Automatic grant" (catalog). ui-qa `portal` board over `e2e/portalStates.ts`.                                                                                                                                          | CQF-01                                                           | no        | 0.8–1.2w |
| CQF-07      | Complete the shared component inventory (EXPERIENCE §3) | One `CommandPalette`, `AccountMenu`/`Avatar`, `BootScreen`, `Section` (codemod `SectionCard` and the hand-rolled cards, then a lint test), `ProductMark` (accent via `resolveAccent`), `TokenList` family, `ReleaseNotes`, `CheckRow`/`PrereqList`, `useMediaQuery`/`useFirstLoad`/recents/`lib/storage`, `PlatformGlyphs` to `ui/`, `KeyField`/`KeyMask` to `ui/`.                                                                      | CQF-04, CQF-05                                                   | no        | 1.5–2w   |
| CQF-08      | `AuthCard` in `ui/auth/` (UX-40)                        | Promote `LoginCard`, `ProviderRow`, `Glyphs` and `KeyField`. One `CodeEntry` used by `SignInPage`, `StepUp` and `SignInMethods`. Step slots per SIGN-IN.md §8. `t()` only.                                                                                                                                                                                                                                                               | CQF-06                                                           | no        | 0.8–1.1w |
| CQF-09      | Wizard kit and setup state (UX-50 trimmed, UX-51)       | `ui/wizard` (`Wizard` page and drawer host, `Stepper`, `ChoiceStep`, `FormStep`, `SnippetStep`, `WaitingFor`, `DoneStep`, `PrereqList`, `AutoList`). Worker `setup_state` (migration `00XX`) and `GET/PUT …/setup` with fact-computed step states. Migrate `StorefrontsPage`'s flow as the proof. Delete `ui/Stepper.tsx`'s old API.                                                                                                     | CQF-01, CQF-02                                                   | no        | 1.5–2w   |
| CQF-10      | Console sections restructure and page budget            | `console/sections/<section>/{pages,components,model,data.ts}` (`git mv` plus an import codemod, in one window). Split `AppStorePage`, `platformStores`, `Overview` (one overview read), `ReleaseRecord`, `platformOperations`, `CredentialsPage` and `OutletsPage` under a 600-line budget test (shrinking allow-list). `TabPanel` on every record (MO-13 follow-up). Rename the update `FeedPage` to `UpdateChannelsPage`.              | CQF-02; ST-09 owns `platformSettings`                            | no        | 1–1.5w   |
| CQF-11      | Test and lint consolidation                             | `test/fixtures/` typed builders and scenarios (unit, e2e and kit gallery). One fetch router for both harnesses. Trim the jsdom motion tests that e2e covers. Add oxlint (react-hooks, jsx-a11y, TS correctness) to `pnpm lint` for admin and brand. Flow lint (UX-81).                                                                                                                                                                   | CQF-03                                                           | no        | 1–1.4w   |
| CQF-12      | Owner UI quick wins (portal and console card)           | Portal: `ReleaseNotes` in What's New with summary and expand; device count badge in `SectionNav`; tier pill to the `LicenseCard` header; remove the count line; align the sticky offsets. Console: the simple product card (header plus service-icon row; phone: name plus `ServiceDots`); delete `GET /summary`, `useSummary`, `qk.summary` and the 14 invalidations.                                                                   | none (`ReleaseNotes` can start here and move to `ui/` in CQF-07) | no        | 0.4–0.6w |
| CQF-13      | Living specs and backlog registration                   | Rewrite ADMIN.md and PORTAL.md as current-state docs from the EXPERIENCE, SETUP, FLOWS and SIGN-IN amendments; delete superseded sections and the EXPERIENCE §14 table. Register or drop every open UX id in `workpackages.json`. Contributor page "add a page, a setting, a wizard, a write".                                                                                                                                           | none                                                             | no        | 0.4–0.6w |

Ordering: CQF-12 and CQF-13 can start at once. Then CQF-01. Then CQF-02, CQF-04, CQF-05 and
CQF-06 in parallel (disjoint files: data and api, router, vocab, portal copy). Then CQF-03,
CQF-07, CQF-08 and CQF-09. Then CQF-10 and CQF-11.

---

## Quick wins

Each is under a day and independent:

1. Delete `portal/format.ts`, `lib/buildLabels.ts` and the dead exports in `lib/products.ts`,
   `lib/labels.ts`, `lib/format.ts` (`zoneName`), `routes.ts` (`QUERY_KEYS`),
   `areas/feeds/model.ts` (`REGISTRY_USERNAME`) and `license/holders.tsx` (`moveVerb`).
2. Import `SYSTEM_PRODUCT_SLUG` from `@polaris-key/manifest` in `console/areas/feeds/model.ts:41`.
   Define `TOKEN_ENV` once.
3. Codemod `console/components/PageHeader.js` → `ui/PageHeader.js` (56 files) and delete the shim.
   Do the same for the `bits.tsx` re-exports.
4. Replace `context.tsx` usage at its five sites (`AccessPage.tsx:37` → `useProduct`,
   `CommandPalette.tsx:5` → `useMe`, `CatalogEditorPage.tsx:777` and `EdgeMintPage.tsx:466,537` →
   `useQueryClient().invalidateQueries`). Delete the module and `LegacyPage`.
5. Break the portal → console-API leak: `ui/toast.tsx` takes a pre-worded title, or a resolver
   passed by the app, instead of importing `lib/errorCopy`.
6. Merge the three `codeErrorText` copies into `portal/model/code.ts` with the catalog keys in
   comments, ready for CQF-06.
7. `portal/components/signin/LoginCard.tsx:141`: use `tokenMs` from `ui/motion`.
8. Owner portal fixes: `LicenseCard.tsx:168` tier pill to `aside`; drop the count line at `:148`;
   `SectionNav.tsx` count badge.
9. Owner console card: trim `Home.tsx:420` `ProductCard` to header plus service-icon row; on
   phones, `ServiceDots`.
10. Remove the speculative never-sent fields from `PortalCapabilities` (`portal/api.ts:27-39`) and
    the branches that read them, or file the Worker gap if the UI is wanted.
11. Delete the duplicate hooks `useCatalog`, `useProfiles` and `useDeliverables` (keep one each).
12. Rename `console/areas/update/FeedPage.tsx` → `UpdateChannelsPage.tsx`.

---

## Cross-domain dependencies

- **Identity and sign-in:**
  - The `AuthCard` (CQF-08) and catalog adoption (CQF-06) are the frontend half of D-41.
  - The Worker twin `renderAuthCard()` (UX-43) must read the same catalog.
  - The "Automatic grant" wording reverses SIGN-IN D-53's origin wording and needs an owner
    decision record.
- **RBAC:** the console needs `/me` to carry capabilities, so the frontend can implement
  `requires.capability` and `NoAccessPage` (ST-21, ST-22 and the RBAC audit). Console accounts on
  the shared account system change `Me` (`api.ts:61`).
- **Distribution and commerce:**
  - `tools/stores.json` must be agreed with the Worker's two store-id spellings (`play` against
    `google-play`, `ms-store` against `microsoft-store`), owned by the distribution and commerce
    audits. CQF-05 only normalises display.
  - The combined channel and storefront page needs the storefront catalogue read model (UX-52 and
    UX-53).
- **Products and onboarding:** the Integration panel and New Product wizard need UX-60
  (`renderSdkSetup` in manifest), UX-61 (SDK sightings) and the setup state (CQF-09, UX-51).
- **Settings:** the ST-05 generic settings API is a prerequisite for the single engine (ST-07).
  ST-25 retires `branding_json`, which the portal still reads for tints.
- **Licensing:** LX-14, LX-15 and LX-29 depend on CQF-05 and CQF-09. LX-08 (in flight) touches
  only `console/pages/platform.tsx` and `settings.generated.ts`, so there is no conflict.
- **Hosted assets:** HA-12 (in flight) puts `presentation.accent` into discovery and the registry
  rows. HA-13 and CQF-07's `ProductMark` consume it.
- **UI kits:** UK-03 (the ICU formatter, `KeyField` view model) and UK-02b (the `signin-form`
  fixtures) should share code and fixtures with the portal. UK-14 (in flight) edits
  `brand/kit-copy/*.json`; CQF-06's catalog edits rebase after it.
- **Worker code-quality audit:** the type-only DTO modules (CQF-03) and the deletion of
  `GET /summary` (CQF-12) are Worker changes. Coordinate so the Worker audit does not reshape the
  same handlers in parallel.
- **Docs:** CQF-13's living ADMIN.md and PORTAL.md feed PX-19 and the docs-site admin pages, whose
  links are checked by `packages/worker/test/docsLinks.test.ts` against `nav.ts`.

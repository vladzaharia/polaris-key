# A-18j Console: Add to storefronts flow, Listing editor and Set up from Store connections

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                           |
| Size        | 2–3 engineer-weeks                                                                                                                                   |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [F-11](F-11-console-feeds.md)                                           |
| Unblocks    | [ST-13](ST-13-listing-in-hub.md)                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                   |
| Gates       | docs help-link drift gate; console CSP parity (`adminCspParity`, the CSP e2e); rule 10 (narrative-only admin routes); THREAT-MODEL (admin mutations) |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Goal

One console flow provisions a product onto any storefront. Product → Distribution → Storefronts →
**Add to storefronts** (T6) chooses stores, checks prerequisites, edits the listing, accepts
assets, shows the plan and runs it, resumably from the ledger. Product → Distribution → **Listing**
(T3) edits the model outside the flow and pushes listings per store. A-16's Store connections page
gains **Set up** on assigned apps, which opens the flow pre-scoped to that store. Every
capability shown is rendered from adapter declarations, for storefronts and feeds alike.

## Why

The owner asked for provisioning on every storefront to be easy
([S-15 §8](../../notes/S-15-storefront-provisioning.md#8-the-provisioning-ux)). The adapters
declare what each store allows; one flow renders those declarations, so a new adapter needs no
console code.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§8**, §6.1 (capabilities the
  console renders), §6.4, §6.5, §7.3, §11 (A-18j, the A-17f change, the F-11 note, the ADMIN.md
  amendment).
- `docs/design/ADMIN.md`: §2.3 (Platform section, the no-"coming soon" rule), T3, T4, T6, §5.1,
  §5.2, §5.8 (copy), §5.10.
- The shared kit: `packages/admin/src/ui/*` (`Stepper`, `StatusPill`, `SaveBar`, `DataTable`,
  `CopyButton`, `Callout`, `ConfirmDialog`, `DiffViewer`, `EmptyState`, `Timeline`),
  `packages/admin/src/console/{components,templates}/`, and F-11's feeds area
  (`console/areas/feeds/`).
- A-16's page (`console/pages/platformStores.tsx`); the A-17f brief.

## Scope

**In:**

- **Add to storefronts** (T6, platform admin): the seven steps of S-15 §8.1 (choose storefronts,
  prerequisites, listing with imports and diff, assets slot board with crop acceptance, plan,
  run, submit and release). `?step=`, review step listing every external write, unsaved guard;
  progress is the ledger, so it resumes anywhere; read-only with an explanation when a store has
  no connection.
- **Listing** (T3, product): locale switcher, fit report, slot board, per-release notes, and "Push
  listing" per store (plain confirm; Play "stage only"; Microsoft keeps the pending submission
  uncommitted).
- **Set up** on A-16's Store connections app list.
- **Capability strips and badges** rendered from `Support` declarations (API, CI, PR, link,
  unsupported). One badge and tile component, **shared with F-11's feed pages**, which are switched
  to it here (F-11 has landed, so this package owns the shared component).
- Deep-link copy cards with values from the model and live verifiers (every 10 s for up to 15
  minutes while open, plus Check now).
- **Typed confirmation dialogs** for submit, release and price changes, with the store-reported
  app name as the phrase.
- **A-17f:** if A-17f has not started, absorb it: the New app wizard becomes the Apple adapter's
  `plan()` inside this flow, and the lead marks A-17f `dropped`. If it has started, wrap it.
- Admin routes the flow needs that A-18a and A-18b do not already serve (narrative-only), with
  audit rows.
- `docs/design/ADMIN.md` amendment: §2.3 Distribution gains "Storefronts (Add to storefronts, T6)"
  and "Listing (T3)"; the Platform → Store connections row gains "Set up". Admin narrative docs
  pages and help links in both tables.

**Out:**

- Any adapter logic (→ A-18e–i, A-18m). The listing model's API (→ A-18b).

## Design notes

**Reuse the console's shared components.** Build from the kit (`packages/admin/src/ui/*`) and the
console templates; add a component only when no kit component fits, and put it in the kit, not in
the area. The capability badge is one component used by storefront tiles and feed tiles.

**The owner's console rules:**

- **No "coming soon" copy** and no implementation-status copy anywhere ("Available when…",
  "Not built yet"). A store or step that is not possible states what applies and why, in the
  ADMIN.md §5.8 voice, or is absent. A step whose adapter has not landed is not shown.
- **CSP-safe.** No inline scripts or styles, no `style` attributes that need `unsafe-inline`, no
  remote assets; overlays use the kit's CSP-safe scroll lock. `adminCspParity` and the CSP e2e
  cover every new page, drawer and dialog.
- **Settings controls are right-aligned:** T4's two-column layout, label and help on the left,
  control on the right at ≥ 1024 px, stacking below.
- **No redundant subtitles.** A page or section header does not restate its title or the
  breadcrumb in a subtitle; a description appears only when it adds information.

**Other constraints:**

- Every step's result is the vendor's re-read, never the request's intent.
- No delete control anywhere (owner rule). Replacing Play images shows a deep link to remove the
  old ones (decision 6).
- Imported listing text renders escaped, never as HTML.
- A pending step survives a closed tab as a `pending` ledger row.

## Corrections from the code (recorded by the implementer)

- **Adapters on main at hand-off:** App Store (A-17), Google Play (A-18e), Microsoft Store (A-18f),
  itch.io and Snap (A-18h, CI plane). Steam (A-18g) and the PR plane (A-18i) had not landed: they
  appear by registering, with no console change.
- **A-17f was dropped before it started**, so it is absorbed: the New app wizard is the App Store
  flow runtime (`services/distribution/storefronts/appStore.ts`) on A-17b's and A-17c's routes.
- **Flow runtimes, not adapter logic.** A-18e and A-18f shipped their writes as functions with no
  routes; the flow binds a subset (Play: listing text, accepted images, testers, typed send for
  review; Microsoft: staged listing, typed commit). Unbound `api` steps are absent per the owner's
  rule; Play release and rollout stay on P5-03's Rollouts page.
- **Crop acceptance needed storage.** A-18d registers outputs but recorded no acceptance, so this
  package adds migration `0072_dist_listing_asset_acceptance` (`accepted_sha256`, `_at`, `_by` on
  `dist_listing_assets`) and the slot board routes; pushes send accepted assets only.
- **Store connections' Set up** needs to know which stores have an adapter: the connections list
  gains `storefront: boolean`.
- **The slot board's media host (S-20 note).** The brief says the board renders from HA-02's media
  host and uploads through HA-06. HA-02 was still todo, and neither HA-02 nor HA-06 is a
  dependency, so the board previews through its own `storefronts/slots/image` route (magic-byte
  typed, `nosniff`) and adds no upload path of its own. Whoever lands HA-06 or ST-13 switches the
  preview to the media host.
- **Older Play images (decision 6).** A-18e's `playUploadImage` counts the older images and names
  the `google-play.main-store-listing` row. The image step and the listing push return them as a
  `followUp` (`{count, text, url, missing}`). The admin route renders the link from the product's
  facts, just as it does for a deep-linked step. The console shows the count and the link on the
  step card and in the Push tab. No Play deep link renders a URL yet: the facts carry no Play
  Console `developerId`, and `appId` is the package name, not the Console's numeric id. Until that
  changes, the note names the missing ids.

## Acceptance criteria

- [x] The flow, the Listing editor and Set up work against fakes for every adapter that has
      landed; a new adapter registered in a test appears with no console change.
- [x] F-11's feed pages and the storefront tiles render capabilities through the same component.
- [x] Submit, release and price steps require the typed phrase; there is no delete control.
- [x] No "coming soon" or implementation-status copy (reviewer greps the new strings); no
      redundant subtitles; settings controls right-aligned per T4.
- [x] `adminCspParity`, the CSP e2e and `check:links` pass; ADMIN.md amended; the green gate passes
      (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## S-20 note (2026-10-05)

The slot board renders each asset from S-20's media host, built in
[HA-02](HA-02-media-host.md). Each slot's upload uses
[HA-06](HA-06-upload-paths.md)'s `POST /admin/products/:p/assets/:slot`, which writes
`dist_listing_assets` rows with `source = 'admin'`. Do not add a second upload path
([notes/S-20 §6.3](../../notes/S-20-hosted-assets.md#63-ingest-one-path-three-ways-in)).

## Hand-off

Later adapters add tiles by registering; nothing here changes. A-18m's Apple listing push appears
as Apple's "Push listing" once it lands.

The role agent sets `--set A-18j in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18j done`.

# ST-08 Product settings hub: Services, Presentation, Keys & secrets, Members

| Field       | Value                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 2: experience)                                                                                                                                                                                                              |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                                                            |
| Depends on  | [ST-07](ST-07-settings-row-v2.md)                                                                                                                                                                                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-11a](U-11a-console-data-settings.md), [ST-10](ST-10-settings-search.md), [ST-12](ST-12-api-only-settings.md), [ST-14](ST-14-portal-settings.md), [ST-17](ST-17-resync-dry-run.md), [ST-45](ST-45-platform-product-sidebar-contexts.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                                |
| Gates       | console CSP parity; docsLinks                                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                         |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** call `applyServiceTransitions`, and show the dry-run count in the confirm.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> The product hub hosts Services (ST-38), Presentation, Keys & secrets and Members (ST-31) so Core nav shrinks; migrates the bespoke manifest-owned forms (FeedPage, Core Settings, EnrollmentPage, Identity Portal, FeedSettings) onto the engine; Distribution -> Access is rebuilt as the product Access page by P2-10, not here; drops the Admin group row.

- Title: was "Console product settings hub (`#/p/<slug>/settings/<area>`): All settings table, web-origins editor, Page moved entries, phone layout".

## Goal

Each product has one settings hub at `#/p/<slug>/settings/<area>` with an All settings table, a web-origins editor, Page moved entries for the old pages and a phone layout.

## Why

Product settings are spread over service pages today ([S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) defines the hub.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-08.
- `docs/design/ADMIN.md` §5.2, §5.10, §6.9.

## Scope

**In:**

- Hub routes and areas; All settings table; web-origins editor; Page moved entries for the old pages from the route ledger (ST-49), no redirects or aliases.

**Out** (and where it belongs instead):

- Search (→ ST-10); listing (→ ST-13); portal area (→ ST-14).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 5 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:product_keys` (`core.keys`)
- `table:product_secrets` (`core.secrets`: ST-19b registered this entry, pending on ST-08, with
  names only and storage `none`. Extend it with the `product_secrets` adapter and its readers,
  and drop its `pending`; do not register it again)
- `table:release_channel_floors` (`release.channelFloors`)
- `table:release_pack_floors` (`release.channelFloors`, packs)
- `column:release_pack_floors.source`

## Design notes

- U-11a's Cloud Sync section and I-12's sign-in settings land in the hub, so ST-08 precedes them.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Routes: `#/p/<slug>/settings/{features,presentation,keys,members}` (four tabs). The old pages (services, presentation, keys, license/settings, license/enrollment, identity/portal, update/feed settings) get Page moved entries from the route ledger (ST-49), never a redirect or an alias (B16, ADMIN §2.5). This replaces 'legacy redirects with a Moved to Settings banner for one release' everywhere in this brief. (admin-4-10)
- Keys & secrets tab: signing keys, secrets, CI publishing, content keys read-only ('CI delegates and revokes these'). Outlet credentials leave for Platform → Connections (store team keys) and the channel page's Setup tab. Mockups to build against: products.settings-presentation (with a live light and dark preview) and products.settings-keys (by exposure). (admin-4-10)
- [ ] Old deep links open a Page moved page naming the new home (e2e), with no redirect. (admin-4-10)

## Steps

1. Routes and Page moved entries.
2. Areas and table.
3. e2e and CSP parity.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `admin.product-members`, `products.features`, `products.settings-keys`, `products.settings-presentation`.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 5 lower, and `settings-coverage.test.ts` passes.
- [ ] Old deep links open a Page moved page naming the new home, with no redirect (e2e). **Blocked: 3 of 7 pages done.** `services`, `presentation` and `keys` (with its `secrets` alias) are done and covered by `core.e2e.test.ts`. `license/settings`, `license/enrollment`, `identity/portal` and `update/feed` are working editors whose replacement homes are not built, so they stay live; their owners and dependencies are under "Criterion 2: blocked migrations". The criterion is not met today. Whether ST-08 goes to review with it carved out to those owners is the lead's call.
- [ ] Console CSP parity passes.
- [ ] The hub renders at phone width.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-10, ST-12, ST-13, ST-14, ST-17 and U-11a build into the hub.

The role agent sets `--set ST-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-08 done`.

## Builder notes (2026-10-11)

- Page moved entries exist for `services`, `presentation` and `keys` (and `secrets`), with an e2e
  (`core.e2e.test.ts`). The other four pages the Brand transition section names stay **live**:
  `license/settings`, `license/enrollment`, `identity/portal` and `update/feed` are working editors
  and their ledger homes do not exist. Turning them into Page moved now would delete working
  editors and name pages that are not built. `route.test.ts` pins them as live. Criterion 2 is
  blocked on them: see "Criterion 2: blocked migrations".
- The All settings table sends each key to the page whose control edits it, by key and not by area
  (`sections/core/model/settingHomes.ts`, pinned by `settingHomes.test.ts` and
  `settingsAll.test.tsx`). A key the console has no control for names the `.pkey/` file or the admin
  API instead and links nowhere: `release.binaryName`, `release.summaryMarker` and `license.autoIssue`
  are manifest-only, `core.trustPolicy` is API-only. The four live editors stay linked from their
  own keys.
- `ScrollTable` is now `relative`: an `sr-only` span inside a table cell is absolutely positioned and
  otherwise escaped the scroll region, widening `main#content` by 132 px at 390 px on All settings.

## Criterion 2: blocked migrations (2026-10-11)

An old page stays a live editor until its replacement exists. The package that builds the
replacement then adds that route's row to `MOVED_TABS` (ST-49's `ROUTE_LEDGER` once it lands) and an
assertion to the Page moved e2e in `core.e2e.test.ts`, and deletes the page's line in
`route.test.ts`. ST-49's own criterion accepts "live content or a Page moved page" for an old URL.
The ledger homes quoted below are `docs/design/ADMIN.md` §2.8.

- **`license/settings`** (License → Settings). Live: the six `licensing.*` rows, of which
  `clampGraceToExpiry` is the one in effect. Ledger home: "Features › Licensing nested settings
  (LX-06)". That home is not built, and LX-06 is not its owner: LX-06 is `done` and built License →
  Settings itself. No package builds a Features-nested licensing panel (ST-38's Features rows are
  switches: Package feeds, Customer portal, Polaris Key storefront visibility, Minted tokens).
  Packages that act on this page: **LX-40** (todo; waits on LX-09, LX-10 and LX-05b) retires six of
  its settings and deletes `LicenseSettingsPage`; **P2-10** (todo) lists License → Settings among the
  routes that redirect to the product Access page. See prerequisite 1.
- **`license/enrollment`** (License → Enrollment). Live: the fingerprint mode (`license.fingerprint`),
  the registration read-out and the probes table. It has no auto-issue control: `license.autoIssue`
  is manifest-only in the console. Ledger home: "split: registration derived on Features;
  fingerprint mode in tier limits; probes and device trust ST-12; automatic access Licenses ›
  Access". Per part: registration derived on Features is **ST-38** (todo, no dependencies);
  fingerprint mode in tier limits is **LX-34** (todo: tier API and manifest `fingerprintMode`), then
  **LX-44** (todo: the tier record shows it); the device trust policy editor is **ST-12** (todo;
  depends on ST-08 and ST-09); automatic access, the home of auto-issue, is **P2-10** (todo; waits on
  ST-07, F-34, LX-36 and ST-39, none done), whose automatic-licences section is `license.access`
  (editor defined by LX-36). ST-12's own Consolidation note says it "keeps the device trust policy
  editor only" and that the auto-issue editor goes to P2-10, so ST-12 owns neither auto-issue nor
  probes. See prerequisite 2.
- **`identity/portal`** (Identity → Portal). Live: availability, sign-in methods, modules,
  `identity.keyEntry.claimByKey`, Discover and automatic linking (`PATCH …/identity/portal`); branding
  is read-only. Ledger home: "Sign-in › App sign-in (I-29) and the Customer portal switch on
  Features". **I-29** (todo; waits on ST-38 and I-30, which is in review) merges Identity → Portal and
  Identity → Sign-in into App sign-in; the Customer portal switch row on Features is **ST-38**'s.
  **ST-14** (todo; depends on ST-08 and I-29) registers only `portal.enabled`, `keyReissue` and
  `identity.keyEntry.claimByKey` as rows, so it is not the switch's owner.
- **`update/feed`** (Update → Feed). Live: metadata access (`update.metadataAccess`), the
  compatibility window (`release.compatWindow`), the artifact policy (`update.operatorPolicy`) and
  the feed endpoints (`PATCH …/update/settings`). Ledger home: "Ship builds › Updates (P2-11)".
  **P2-11** (todo; waits on A-20, and P2-08 is done) builds the Updates page. **P2-10** turns the
  access sections on the feed and Update pages read-only, with a link to Access.

Prerequisites no package owns; the lead assigns or drops each:

1. A home for the one `licensing.*` setting that outlives LX-40, `license.dunningGraceDays`. LX-41b
   removes its `pending` and shows it only while a subscription source exists, and names no page;
   LX-40 deletes the page it would sit on. Until this is assigned, the ledger's "Features › Licensing
   nested settings" has no builder.
2. The fingerprint probes table (read-only, fed by the manifest, with Resync). The ledger credits
   ST-12, whose brief keeps the device trust editor only.
3. Which plan wins for License → Settings and License → Enrollment: ADMIN.md §2.8 (Features nested
   settings; Licenses › Access) or P2-10 (the product Access page for both). ST-49 has to pick one
   when it writes `ROUTE_LEDGER`.

No dependency edge is added to ST-08. ST-12, ST-14 and ST-45 depend on ST-08, and ST-49 on ST-45, so
an edge from ST-08 to any of them is a cycle; that is also why ST-08 cannot wait for the ledger and
uses P0-31's `MOVED_TABS`. ST-38, I-29, P2-10, P2-11, LX-34, LX-40 and LX-44 do not depend on ST-08,
but making ST-08 wait for them (all are todo) would hold the three finished tabs behind them.

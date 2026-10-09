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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
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

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 5 lower, and `settings-coverage.test.ts` passes.
- [ ] Old deep links open a Page moved page naming the new home, with no redirect (e2e).
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

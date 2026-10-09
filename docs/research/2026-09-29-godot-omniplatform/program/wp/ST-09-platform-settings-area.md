# ST-09 Platform settings ordered by use

| Field       | Value                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 2: experience)                                                                                                                                                                            |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                            |
| Depends on  | [ST-07](ST-07-settings-row-v2.md), [ST-02](ST-02-platform-inventory.md)                                                                                                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-31](I-31-platform-connections-setup-wizards.md), [ST-11](ST-11-sql-only-settings.md), [ST-12](ST-12-api-only-settings.md), [ST-16](ST-16-platform-defaults.md), [ST-27](ST-27-alert-destinations.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                              |
| Gates       | console CSP parity; docsLinks                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Platform settings ordered by use: Recently changed, Platform ready, Product defaults, Sign-in, Storefront and hosting, Email and alerts, Licensing, Jobs, Advanced. Rendered from the registry (no area silently dropped); replaces platformSettings.tsx (2,089 lines); feeds policy is the kill switch and size ceiling only; constants inventory goes to the docs. Absorbs UX-30 (Platform Status). Wave 7.

- Title: was "Console Platform settings area: Limits generated from code, Product defaults, Product policies matrix, feeds policy move".
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-30.

## Goal

The console has a Platform settings area with Limits generated from code, a Product defaults section, a Product policies matrix and the feeds policy moved into it.

## Why

Platform-wide values are scattered or invisible ([S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) specifies the area.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-09.

## Scope

**In:**

- Platform area routes; Limits page from ST-02's inventory (about 40 constants, read-only, D15); Product defaults; policies matrix; feeds policy move.

**Out** (and where it belongs instead):

- Live-inheritance fan-out (→ ST-16); SQL-only settings (→ ST-11).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 5 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:dist_registry_policy` (`feeds.<eco>` policy)
- `table:dist_registry_feeds` (`distribution.feeds.<eco>`)
- `env:EMAIL_SENDER_ADDRESS` (`email.sender`)
- `env:PORTAL_EMAIL_FROM`: older spelling of `email.sender`
- `env:EMAIL_APPLE_RELAY` (`email.appleRelay`)

## Design notes

- Limits are generated from code, never hand-maintained.

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

- Keep the mockup: Platform ready first (compact banner while incomplete), then the settings rail; 'Recently changed' sits last, and the header's History button is the only way to full history. Amend the rbac-admin decision record §5.6 by reference. The header search field and History share one baseline; on phone no lone search icon floats. (admin-4-15)

## Steps

1. Area and pages.
2. e2e and CSP parity.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `admin.platform-activity-event`, `admin.platform-activity`, `admin.platform-settings`, `admin.platform-status`.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 5 lower, and `settings-coverage.test.ts` passes.
- [ ] Limits match the inventory (test).
- [ ] Console CSP parity passes.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/platform/settings`; `operate/console/tour` regenerated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-11, ST-12, ST-16 and ST-27 add sections here.

The role agent sets `--set ST-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-09 done`.

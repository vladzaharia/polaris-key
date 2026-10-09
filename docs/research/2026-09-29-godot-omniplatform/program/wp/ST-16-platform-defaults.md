# ST-16 Live platform defaults with fan-out confirm (trimmed)

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)            |
| Size        | 0.6–0.85 engineer-weeks                                                       |
| Depends on  | [ST-09](ST-09-platform-settings-area.md), [ST-04](ST-04-settings-resolver.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                        |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | THREAT-MODEL; console CSP parity                                              |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the three Cloud Sync ceiling entries.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keep live platform defaults with the fan-out count and L2 confirm; drop enforce/delegate per entry and the products-policies matrix. No longer waits for U-05: U-05 registers its own Cloud Sync rows (cloudSync.ceiling.bytes and writesPaused). Platform-wide service restriction (owner brief 'restrict features ... platform-wide') stays deferred; revive here as one platform policy row when a deployment needs to switch a service off for every product.

- Title: was "Platform defaults and policies: live inheritance with fan-out preview and L2 confirm (D5), enforce or delegate, clamped-value display; licence defaults, key-entry maximum, Cloud Sync ceilings".
- Depends on: removed U-05.
- UX rows that name this package: UX-28 (dropped: merged into ST-07 (pre-save diff) and ST-16 (fan-out confirm)).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: only `cloudSync.ceiling.bytes` and `writesPaused`.

## Goal

Platform defaults and policies apply to product settings: platform values inherit live with a fan-out preview and an L2 confirm, entries offer enforce or delegate where they allow a lock, and clamped values are displayed. Covers licence defaults, the key-entry maximum and the Cloud Sync ceilings.

## Why

The owner accepted live inheritance ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 2: live inheritance with a fan-out preview and an L2 confirm). [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance) defines cascade, policy and clamps.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance), [S-18 §5.4](../../notes/S-18-settings-architecture.md#54-s-17--u-01-cloud-sync), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-16.

## Scope

**In:**

- `inherits`, enforce/delegate, fan-out counts, L2 on propagation, per-product audit rows with `origin = 'platform'`, "Clamped by Platform" display.
- Licence defaults, key-entry max, Cloud Sync ceilings (after U-05).

**Out** (and where it belongs instead):

- "Copy settings from product" one-time template (→ ST-23).

## Design notes

- Policy bounds sit on the permissive side only; a platform write never rewrites product rows, it clamps them.

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

## Steps

1. Resolver tests on bound direction.
2. UI and fan-out preview.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 6 mockup item(s):** `admin.platform-settings`, `config.cloud-sync-paused`, `config.cloud-sync-product-role`, `config.cloud-sync`, `config.pause-writes`, `config.storage-default`.

## Acceptance criteria

- [ ] A platform change shows the affected product count and needs L2 (e2e).
- [ ] Clamped values display both set and effective (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set ST-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-16 done`.

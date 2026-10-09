# U-12 Cloud Sync privacy cascade (Worker)

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                              |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                     |
| Depends on  | [U-03](U-03-account-overrides.md), [U-05](U-05-cloud-sync-do.md), [I-11](I-11-portal-library.md), [I-12](I-12-console-users.md)            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-18](PX-18-cloud-sync-section.md)                                                               |
| Role        | `pkey-implementer`                                                                                                                         |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                   |
| Gates       | privacy docs; THREAT-MODEL; console CSP parity; rule 10 (OpenAPI + `routeCoverage`); deletion test after a simulated restore; portal suite |
| Human input | none                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Worker privacy cascade only (settings, account overrides, directory) and the export zip format later stores append to. The portal section moves to PX-18; files and records exports land with U-10 and U-09.

- Title: was "Privacy (settings half) and the portal Cloud Sync section: settings and account overrides in I-11's and I-12's exports, delete cascade on account and per-product deletion, tombstone re-apply after restore, the product-page section".

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: one quota number per tier, shown read-only with a link to Tiers, plus the ceiling and the pause state. Labels are read server-side.

## Goal

Settings and account overrides are covered by export and deletion from day one, and the portal's product page shows a Cloud Sync section for products with the service on: usage, last sync per device, export of that product's data, and "remove my data from this product".

## Why

Settings and account overrides are personal data from the MVP on ([S-17 §5.9](../../notes/S-17-user-data-sync.md#59-privacy)). The Library's product page reserves the section (I-11).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-17 §5.9](../../notes/S-17-user-data-sync.md#59-privacy), [S-17 §5.15](../../notes/S-17-user-data-sync.md#515-how-it-composes) (portal), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-12; [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy).
- I-11's product page and export code; I-12's per-subject export.

## Scope

**In:** export entries in I-11's per-product and full exports and in I-12's per-subject export; delete cascade (DO `deleteAll`, `account_overrides`, directory) on account deletion and per-product deletion through I-05's registry; tombstone re-apply after a restore; the portal section.

**Out** (and where it belongs instead):

- Saves and records (→ U-24a, U-24b).

## Design notes

- Cloud Sync appears only on product pages of products with the service on, which now implies Identity on (owner, 2026-10-04, final answers).
- The section lists the signed-in devices that reach this product's data; "remove device" is I-11's ordinary device control.
- Dormant-account deletion (S-16 D23, accepted: no sign-in and no licence for 36 months, after an email warning) runs the same delete cascade.
- Controller-requested deletion and operator-authored account overrides follow S-16 D27 ([S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions), accepted 2026-10-04 pending a legal review of the DPA wording).

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

1. Export entries. 2. Delete cascade and restore test. 3. Portal section.

## Acceptance criteria

- [ ] Account and per-product deletion remove settings and account overrides, and stay removed after a simulated restore (test).
- [ ] Exports include both (test).
- [ ] The section shows only for products with Cloud Sync on (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal sync privacy
```

## Hand-off

- U-24a and U-24b extend the cascade to saves and records.

The role agent sets `--set U-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-12 done`.

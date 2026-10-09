# ST-45 Platform and Product sidebar contexts

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)          |
| Size        | 0.6–0.9 engineer-weeks                                                                                             |
| Depends on  | [ST-08](ST-08-product-settings-hub.md), [ST-29](ST-29-admin-route-table-can-usecan.md)                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-48](ST-48-console-shell-v2.md), [ST-49](ST-49-console-route-ledger.md) |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | `console-csp-parity`                                                                                               |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-09** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-09, UX-13, UX-14, UX-26.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: filtering through `useCan`.

## Goal

Platform and Product sidebar contexts, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-09** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, for **OB-09**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- Context header with a switcher; Platform context (Home, Members, Connections, Settings, Packages, Status, Activity); Product context (Overview, Integration, Access, Devices, Users, Activity, the five features, Settings hub); requires flags hide idle one-time pages; permission filtering through useCan; Override migration out of the nav; absorbs the UX-09, UX-13, UX-14 and UX-26 sweeps. Areas are not tied to this nav (ST-28).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-09**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

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

- Sidebar (B3, B4): no 'WORKSPACE' label; the context switcher is a 72 px bordered card; group labels are neutral text with a 3 px accent bar and no icon; items 40 px. Selected item = subtle accent fill plus a 3 px solid inset marker, never a solid accent pill; count badges keep their status colour; the marker is tested at 3:1 and is never the only cue. (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)
- The nav list scrolls between a pinned context header and a pinned foot (Settings, Collapse); test at 1440x900 and 1280x720 with Licensing open and five feature groups. The header uses the generated trimmed lockup (UK-57). No duplicate service emblem. (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)
- A feature with exactly one page (Cloud Sync) is one nav row: the group label is the link, chevron hidden, accent bar kept (B5). (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)
- Phone nav drawer: opening moves focus to the first item; main and footer are inert while open; Tab wraps inside; Escape closes and focuses the toggle; the toggle's name switches Open/Close navigation with `aria-expanded`; resizing past the desktop breakpoint closes it. (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)
- Admin-3 structure note: the current dx-mockups ids are the structure (commerce._, identity._); the guide boards supply chrome only. The canvas, masthead and tab chrome are ST-48. (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)
- [ ] Console baselines in both themes; axe clean; the phone-drawer keyboard test passes. (admin-1-15, brand-06, site-17, admin-3-18, admin-2-31)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Platform pages never appear in the product sidebar
- [ ] Nav items hidden by permission, never dead-ended
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/platform/settings`; `operate/console/tour` regenerated.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-45 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-45 done`.

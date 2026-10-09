# LX-14 Licence record: Status, Entitlements, Keys, Devices, Activity

| Field       | Value                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                        |
| Size        | 0.7–1 engineer-weeks                                                                                                                                                                                                                |
| Depends on  | [LX-06](LX-06-licensing-settings.md), [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [LX-11](LX-11-commerce-rework.md), [LX-12](LX-12-licence-lifecycle.md), [LX-14a](LX-14a-per-license-device-limit.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-12](CM-12-console-commerce.md)                                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                  |
| Gates       | console CSP parity; docsLinks                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                           |

## S-24 amendment (2026-10-06)

The licences list's **Holder** column and filter, the **Batch** filter and the holder actions on the record (Assign, Send a new key, Reassign, Make floating) are [LX-30](LX-30-console-holder-surfaces.md)'s, and creation is [LX-29](LX-29-new-license-wizard.md)'s wizard; this package's Entitlements and Grants tabs sit beside them ([S-24](../../notes/S-24-licence-holders.md) §8.8).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Licence record only: Status, Entitlements (effective with sources, add-ons with actions, the override editor replacing the 'Config overrides' tab), Keys, Devices, Activity; a comp is a comp add-on or a licence entitlement override, a trial is a duration (LX-41). The tier half goes to LX-44, commerce mappings to CM-23; no catalog combine/entitlementKind editors. Absorbs UX-07 (Status tab) and UX-24 (Add seats... as a seat-pack comp).

- Title: was "Console licensing: Entitlements and Grants tabs, comp, trial, suppress and move actions, tier rank, catalog `combine` and `entitlementKind`, commerce mappings and restore policy, licensing report".
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-07.
- UX rows that name this package: UX-24 (dropped: merged into LX-14 (Add seats... is a seat-pack comp)).

## Goal

The console shows and manages the licensing model: Entitlements and Grants tabs on the licence record, comp, trial, suppress, move-grant and move-device actions, tier rank, catalog `combine` and `entitlementKind`, commerce mappings and restore policy, and the licensing (holder) report.

## Why

[S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface) specifies the console surface; ADMIN.md needs the matching amendment.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-14.
- `docs/design/ADMIN.md` §6.5.2, §6.5.3.

## Scope

**In:**

- Tabs, actions, editors, report page; ADMIN.md amendment (remove "stored, not enforced").
- **Add seats…**, the temporary per-licence raise (owner, 2026-10-05; SIGN-IN.md D-53): see the
  section below. The permanent per-licence limit is LX-14a's.

**Out** (and where it belongs instead):

- Portal (→ LX-15).

## Add seats (owner, 2026-10-05)

The owner decided that sign-in (OIDC) licences stay device-limited and that "an
administrator can change the numbers as needed" (SIGN-IN.md D-53). The permanent per-licence limit
(**Device limit…**, `licenses.device_limit`, a licence limit beating the tier, the effective limit
and its source in the console) ships first in [LX-14a](LX-14a-per-license-device-limit.md). This
package adds the temporary raise on top of it:

- **Add seats…** comps a licence-held seat-pack grant with an optional expiry (EXPERIENCE.md O1
  item 5). The Effective policy row reads "Device limit 4 · 3 set on this license + 1 comp until
  4 Nov" (or "3 from Pro + 1 comp…"), extending LX-14a's source line.

## Design notes

- Build in S-18's hub where it exists (ST-08); reuse ST-12's mapping editor.

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

- Record masthead (B4): the holder line is the masthead's identity line; the tier control is a select-shaped button (no accent-tinted edge or hairline, B6); route tabs are underline tabs. Keep the kit's xs (28 px) outline row actions in Limits rows so the values stay the focal point. Long holder or organisation names clamp the h1 to two lines. (admin-1-21)
- Motion: expand a limit override in place; the record header stays anchored across tabs (MO-04); a successful change settles into the affected row (MO-09 highlight). (admin-1-21)

## Steps

1. Tabs.
2. Actions.
3. Editors and report.

## Acceptance criteria

- [ ] Each action writes an audited change (tests).
- [ ] **Add seats…** comps an audited seat-pack grant and the Effective policy row shows it (tests).
- [ ] Console CSP parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set LX-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-14 done`.

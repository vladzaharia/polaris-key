# LX-29 New License wizard on the wizard kit

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                                                                                                  |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                |
| Depends on  | [LX-27](LX-27-create-limit-delivery.md), [LX-28](LX-28-bulk-floating-keys.md), [MO-02](MO-02-motion-layer.md), [ST-39](ST-39-wizard-kit.md), [LX-32](LX-32-one-resolver-licence-limits-duration.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-31](LX-31-holders-closeout.md)                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                  |
| Gates       | console CSP parity; docsLinks; console e2e in both themes at 1440 and 390                                                                                                                           |
| Human input | none                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> On ST-39's drawer host; Limits shows inherited values with sources (LX-32) and per-field Override; no 'profiles in order'; delivery per LX-27.

- Title: was "Console New License wizard: a five-step drawer (Product and tier, Who it's for, Limits, Delivery, Review) replacing `CreateLicenseDialog`, single and batch, Done with the key shown once or a CSV, S-23 motion".
- Depends on: added ST-39 and LX-32.

## Goal

**New license** opens a five-step drawer (Product and tier, Who it's for, Limits, Delivery, Review)
that creates one assigned licence, one floating licence or a labelled batch of floating keys, ends
with the key shown once or a CSV, and replaces `CreateLicenseDialog` everywhere it is opened.

## Why

The owner asked to modernise the New License flow and to issue floating and assigned licences
([S-24](../../notes/S-24-licence-holders.md) R1). Today's dialog requires a name and an email, has no
device limit, count or delivery, and fails FLOWS.md §2 (C-17: focus, announcements, "Next",
Escape drops the draft).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §8 (D8–D11), §5.7; frames 70–75b in
  [`docs/design/licenses/`](../../../../design/licenses/).
- [SETUP.md](../../../../design/SETUP.md) §1 (wizard anatomy, drawer host, step kinds, `AutoList`);
  [FLOWS.md](../../../../design/FLOWS.md) §2 (C1–C18) and §3.8 (motion);
  [ADMIN.md](../../../../design/ADMIN.md) §6.5.1 (amended); EXPERIENCE.md §0.7 (first-licence moment).
- `packages/admin/src/console/pages/license/CreateLicenseDialog.tsx`, `LicensesPage.tsx`,
  `shell/palette/actions.tsx:120-128`, `api.ts` (`createLicense`), `data/mutations.ts`.

## Scope

**In:**

- The drawer (`?setup=new-license&step=tier|holder|limits|delivery|review`), 600 px, segmented
  stepper, full-height sheet on phones; draft in the URL and `sessionStorage`; the unsaved guard
  "Discard this license?".
- **Product and tier**: product fixed inside a product (combobox from Home or the palette); tier
  radio cards by rank with each summary; **New tier…**; no tiers → the Licensing quick start.
- **Who it's for**: **Someone specific** (Recommended; email required, name optional; the
  conditional line that never reveals whether an account exists, D4; the auto-link-off line) and
  **Anyone with the key** (count 1–500, batch label when more than one).
- **Limits**: devices (tier's or set, LX-27), expiry, offline days, **More options** (channels,
  versions, profiles in order), and the effective-policy aside with sources.
- **Delivery**: Email the key and show it once (default for assigned), Email the key, Show it once;
  floating: Show it once or Download a CSV, with the one-line reason; the email preview card.
- **Review**: summary rows with **Change**, the `AutoList` in the future tense, the action-named
  primary ("Create license", "Create and email license", "Create 50 keys").
- **Done** in place: `OneTimeSecretPanel` ("Shown once. Copy it now.") with the delivery result and
  **Try again**; for a batch, **Download CSV** (the primary; columns `key,license_id,product,tier,
device_limit,expires_at,batch`) and **Copy all**, with a guard until one of them is used; **Open
  license**, **Open batch**, **Create another**, and **Try it** for the product's first licence.
- Entry points: page header **New license** (and `n`), the palette ("New license…"), the launch
  path's **First license**, the Licenses empty state. Remove `CreateLicenseDialog`.
- Motion per S-23 (step travel, height morph, `AutoList` check draw, one check on Done; the
  product's first licence keeps the one-shot celebration), instant under reduced motion.
- Focus: the step heading on each step, announcements of step changes and results (C13); Escape
  returns focus to the opener.

**Out:**

- Worker routes (→ LX-26, LX-27, LX-28). Holder column, record actions, batch page (→ LX-30).
- Bulk assigned licences (later).

## Design notes

- Copy in plain words (S-24 §8.6): never "holder", "claim", "redeem" or "seat" in UI strings.
- Build on UX-50's `ui/wizard` if merged; otherwise on the drawer and segmented stepper of the setup
  mockups, adopting `ui/wizard` when it lands. MO-02's layer provides the motion.
- The CSV is built in the browser from the one response; nothing is fetched again.

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

## Steps

1. Drawer shell, routing and draft; the five steps with validation.
2. Review, create calls (single and batch), Done panels and CSV.
3. Entry points, removal of the dialog, motion, e2e and screenshots.

## Acceptance criteria

- [ ] All three outcomes (assigned with email, single floating, batch) work end to end against the
      Worker (e2e), in both themes at 1440 and 390, with zero layout-lint findings.
- [ ] No step reveals whether an email has an account (review of copy and network answers).
- [ ] Focus lands on each step heading, step changes are announced, Escape asks before discarding.
- [ ] The batch drawer cannot close before the CSV is downloaded or copied.
- [ ] Console CSP parity and docsLinks pass; the green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Hand-off

LX-31 documents the wizard and runs the cross-surface e2e. FLOWS.md C-17 becomes current.

The role agent sets `--set LX-29 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-29
done`.

# LX-31 Licence holders and automatic licences close-out

| Field       | Value                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                                                                                                                                                                         |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                                     |
| Depends on  | [LX-29](LX-29-new-license-wizard.md), [LX-30](LX-30-console-holder-surfaces.md), [PX-23](PX-23-portal-floating-keys.md), [UK-42](UK-42-activation-holders-web.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md), [UK-43](UK-43-activation-holders-native.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                                                         |
| Gates       | docsLinks; generated docs; THREAT-MODEL; console and portal e2e                                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                  |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **Document LX-26's audit actions** ([LX-26](LX-26-licence-holders-worker.md)).
  `packages/docs/src/content/docs/admin/activity.md` lists the licence actions (`license.create` to
  `license.disable`, `license.enroll`) but none of LX-26's. Add `license.holder.assign` (the
  product's console trail: a floating licence given an email). Name the two that live in the account's own
  history (`portal_audit`) rather than the console trail, and say so: `account.license.attach`
  (every attach, now including the automatic ones by `email` or `oidc`) and
  `account.license.auto_attach_block` (a removal or reassignment keeps the licence from
  re-attaching to that account).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Glossary (in an account, waiting, floating, add-on, automatic grant), access-policy docs, and e2e paths: an automatic licence via sign-in and via Discover for an email-only account, and an invitation-delivered licence. Also flips the license_owned default on for new products once the rebuilt native kits ship (UK-43); per-product flips are LX-39's.

- Title: was "Licence holders close-out: glossary (floating, assigned), the New License and bulk-keys docs pages, THREAT-MODEL T-H1–T-H5, and one e2e path from the console wizard through a kit activation to the portal".
- Depends on: added LX-39 and UK-43.

## Goal

The glossary, the docs site and the threat model describe floating and assigned licences, the New
License wizard and bulk keys as built, and one end-to-end test proves the whole path: create in the
console, activate without an account in a kit, add a name and email, and see it in the portal.

## Why

[S-24](../../notes/S-24-licence-holders.md) changes vocabulary (AGENTS.md rule 4: the glossary
wins) and adds threat rows T-H1–T-H5 (§7.5). The packages are split across the console, the portal
and the kits, so only an end-to-end path shows they agree.

## Read first

- AGENTS.md (rules 4 and 11, docs conventions).
- [S-24](../../notes/S-24-licence-holders.md) §5, §7.5, §8, §9, §10.
- `packages/docs/src/content/docs/start/concepts.md`, `services/license/*`, `users/portal.md`,
  `docs/security/THREAT-MODEL.md`.

## Scope

**In:**

- Glossary: **floating licence** ("a licence in no account: whoever has the key uses it; not
  concurrent use") and **assigned licence** ("a licence with a holder: in an account, or waiting for
  its email"); retire "unowned licence" (S-19 §7.1) in favour of floating.
- Docs pages: issuing a licence (the wizard, holders, delivery), bulk keys (batches, the CSV,
  Disable unused), and the customer side (activating without an account, adding it to an account).
- THREAT-MODEL T-H1–T-H5.
- E2E: console wizard → key → kit (React reference app) activation without an account → Add your
  name and email (card, test email code) → portal Library shows the licence with "Key ending …" and
  the device.

**Out:** feature code (owned by the packages it depends on).

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

1. Glossary and docs pages; console help links in the two tables if a slug changes.
2. THREAT-MODEL rows.
3. The e2e path.

## Acceptance criteria

- [ ] The glossary defines floating and assigned; no page says "unowned".
- [ ] The docs build and `check:links` pass.
- [ ] The e2e path passes in CI.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Closes S-24's program slice.

The role agent sets `--set LX-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-31
done`.

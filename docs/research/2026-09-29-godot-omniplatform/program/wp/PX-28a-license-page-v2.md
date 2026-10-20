# PX-28a License page v2 on today's data (split of PX-28)

| Field       | Value                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (Locker UX waves)                                                                 |
| Size        | 0.3–0.5 engineer-weeks                                                                                                        |
| Depends on  | [LK-06](LK-06-locker-shell-portal-card.md), [P0-36](P0-36-portal-on-copy-catalog.md), [MK-L2](MK-L2-locker-portal-mockups.md) |
| Unblocks    | [PX-28b](PX-28b-license-duration-addons.md)                                                                                   |
| Role        | `pkey-implementer`                                                                                                            |
| Plan mode   | no                                                                                                                            |
| Gates       | portal-e2e; ui-snapshots                                                                                                      |
| Human input | none                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                     |

## Goal

The License page shows the term timeline, one downloads table and Renew only in the License card, on the data the portal API already returns. The remainder is [PX-28b](PX-28b-license-duration-addons.md).

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package. (section 2, row 'License page v2').
- PORTAL.md §4.4; mockups `portal.license`, `portal.license-lapsed` (Locker re-skin from MK-L2); section change portal-07.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Owns `product/LicenseCard.tsx` plus a new timeline file. Uses `expiresAt` and the covered-version field already in `portal/api.ts` and `model/product.ts`, and the SHA-256 already in the download data. **Hidden until their packages land:** the duration, subscription and add-ons lines (PX-28b), the channel picker (P2-13 / A-26). No new route, field or migration.

**Out** (and where it belongs instead):

- Duration, subscription, add-ons and Automatic grant (→ PX-28b).
- Channel picker (→ P2-13).

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

## Acceptance criteria

- [ ] `pkey-ux-reviewer` passes the built screens in BUILT mode (a real browser, dark and light, 390 and 1440 px), against the matching Locker mockup.
- [ ] The scoped green gate passes (AGENTS.md); the header's gates hold.

## Hand-off

The role agent sets `--set PX-28a in-review` when it hands off; the lead sets done after review. Branch from integ/next after the packages in Depends on have merged. Do not start while LK-06 or P0-36 is unmerged.

## Built (PX-28a, 2026-10-20)

- `LicenseTerm.tsx` (new): the term as words plus a neutral-ink timeline (start, today, end); lifetime is the word alone; ended reads "Ended <date>". Renew is one outlined link in `LicenseCard.tsx`, only for an ended or ending license and only when the developer left a link (support, then website); never disabled, never primary.
- `GetItPanel.tsx`: one downloads table (the device's build first and tinted, SHA-256, Download), install sources under it. The old recommended box and the "All platforms" groups are gone.
- Copy: `license.*` and `getIt.*` keys in the catalog, nine locales (`license` and `getIt` added as shared namespaces in `packages/brand/scripts/kit-copy.ts`); `portal/copy/getIt.ts` keeps its exports and reads the catalog. `pnpm gen brand` run.
- Brief corrections: the card title is now "License" (mockup), so the region name changed from "<Product> license"; "Licensed to <email>" and the device-less "Access" and "Activated" facts are replaced by the term (Activated only shows with no chart).
- Not done (PX-28b): duration, add-ons, subscriptions, "Keeps the last version" line, channel picker.

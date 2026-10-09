# PX-33 Optional: requesting product's cover beside the sign-in card

| Field       | Value                                               |
| ----------- | --------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (could) |
| Size        | 0.2–0.4 engineer-weeks                              |
| Depends on  | [PX-14](PX-14-passthrough-header.md)                |
| Unblocks    | none                                                |
| Role        | `pkey-implementer`                                  |
| Plan mode   | no (no wire change)                                 |
| Gates       | portal-e2e, ui-snapshots                            |
| Human input | Owner asks for it (portal Q3 = yes)                 |
| Repo        | `vladzaharia/polaris-key`                           |

> **Parked.** Optional and `deferred`, so `--ready` and `--critical` skip it. parked 2026-10-09: only if the owner asks for the app-context cover beside the sign-in card (B12).

## Goal

For app sign-in at 1180 px and wider and 700 px tall and taller, the requesting product's own cover sits beside the 456 px card as a decorative panel (`alt=""`).

## Why

B12 keeps sign-in free of art beside the card; this is the one optional exception.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B12.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Never on portal-direct sign-in, phones or short screens; never tilted, animated or under the pointer; never personalised before authentication.
- The card is unchanged and the authorization decision is never inside the art.

**Out** (and where it belongs instead):

- Nothing beyond the scope above.

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B12 (program/BRAND-TRANSITION.md); section change portal-22. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `hosted:app-header-passport`.

## Acceptance criteria

- [ ] CSP unchanged (`img-src 'self'`); e2e at 1440, 1180 and 1024; UX review in BUILT mode.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set PX-33 in-review` when it hands off; after review the lead adds the last commit `--set PX-33 done`.

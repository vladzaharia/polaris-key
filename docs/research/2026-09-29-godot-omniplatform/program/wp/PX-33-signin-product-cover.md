# PX-33 Optional: requesting product's cover beside the sign-in card

| Field       | Value                                               |
| ----------- | --------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (could) |
| Size        | 0.2–0.4 engineer-weeks                              |
| Depends on  | [PX-14a](PX-14a-card-header-licence-consent.md)     |
| Unblocks    | none                                                |
| Role        | `pkey-implementer`                                  |
| Plan mode   | no (no wire change)                                 |
| Gates       | portal-e2e, ui-snapshots                            |
| Human input | Owner asks for it (portal Q3 = yes)                 |
| Repo        | `vladzaharia/polaris-key`                           |

> **Parked.** Optional and `deferred`, so `--ready` and `--critical` skip it. parked 2026-10-09: only if the owner asks for the app-context cover beside the sign-in card (B12).

## Goal

For app sign-in in a landscape window, the app request (or product context) header becomes the product passport: a 17.5 rem neutral start pane beside the form pane, with the requesting product's optional art on top (`alt=""`).

> **Corrected 2026-10-20 (lead decision, owner asked for every mockup).** Un-parked. `docs/design/SIGN-IN.md` "Layout: the product passport" wins over the text above: landscape is a width of at least 60 rem (960 CSS px) AND a width to height ratio of at least 1.2 (not 1180 px by 700 px), the card is about 46 rem (not 456 px beside), and the art `<img>` is the pane's first item at 16:10, at most 40 % of the pane. The code is the fact: the Worker's hosted pages already had a passport (I-38a) with a generated gradient fill and a 72 px icon; this package brought both to the spec. Art is served as `ClientRecord.artUrl` (optional, same-origin `/media/<product>/header?v=`) on the portal and from the image host through `cspImageOrigin()` on the Worker's pages; no CSP was widened.

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

- [x] CSP unchanged (the portal's `img-src` already names the image host; the hosted pages use `cspImageOrigin()`); e2e at 1440x900, 1180x800, 1024x768 (passport), 960x700 (boundary), 959x700, 1000x900, 834x1194 and 390x844 (stacked), zero violations.
- [ ] UX review in BUILT mode (the lead runs it).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set PX-33 in-review` when it hands off; after review the lead adds the last commit `--set PX-33 done`.

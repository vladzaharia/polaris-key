# I-38 Hosted passport and Worker CSP image origin

| Field       | Value                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                        |
| Size        | 0.4–0.8 engineer-weeks                                                                    |
| Depends on  | [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [I-37](I-37-device-code-explicit-confirm.md) |
| Unblocks    | none                                                                                      |
| Role        | `pkey-implementer`                                                                        |
| Plan mode   | no (no wire change)                                                                       |
| Gates       | ui-snapshots, console-csp-parity                                                          |
| Human input | none                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                 |

## Goal

Worker-rendered sign-in pages show the passport (product icon or art) and the neutral DL6 callouts, with `brandedHtmlCsp` allowing the image host exactly as the app policy does.

## Why

The Worker's branded pages allow `img-src 'self' data:` only, so product art from the image host would not load. Widening it needs the same one-origin guard the app policy uses.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B8.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- `brandedHtmlCsp` gains the image origin through the same `cspImageOrigin()` guard (one bare https origin, else unchanged), with a header test; `frame-ancestors 'none'` stays.
- Passport: a neutral SUNKEN identity pane in both themes; two panes only in landscape at 960 px and wider, never portrait; developer and device on separate lines; no eyebrow; full-width trust-receipt footer; art is an `<img>` (same origin), no inline style or script.
- All refusals (device limit, all-full, email mismatch, key-entry limit) use the DL6 neutral callout with the fix as the one primary and no disabled-primary dead end; amber only for 'unsynced changes' on sign-out.
- Key on-ramp and Done header use ' · ' (no 'wants you to sign in'); consent Allow and Deny equal size with scopes listed first; provider button fills only from the Apple, Google and Steam allowed sets; the sign-in star field stays.
- Static 'Expires at 14:32' instead of a ticking countdown; forms POST to self; QR (if any) inline SVG.

**Out** (and where it belongs instead):

- The portal React card (→ PX-14).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B8 (program/BRAND-TRANSITION.md); section changes auth-01, auth-08, auth-14. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

- [ ] Header test for the widened `img-src`; no inline style or script on Worker pages.
- [ ] Snapshots in both themes at 1440, 1024, 390 and 360.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set I-38 in-review` when it hands off; after review the lead adds the last commit `--set I-38 done`.

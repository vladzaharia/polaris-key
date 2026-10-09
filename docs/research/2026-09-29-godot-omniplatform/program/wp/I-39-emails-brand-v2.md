# I-39 Transactional emails on brand v2: ink action button, neutral callouts, lockup, HTML snapshots for every template

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (UX coverage (2026-10-09)) |
| Size        | 0.6–1 engineer-weeks                                                                          |
| Depends on  | [UK-58](UK-58-brand-expression-tokens.md), [I-38](I-38-hosted-passport-worker-csp.md)         |
| Unblocks    | none                                                                                          |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no (no wire change)                                                                           |
| Gates       | `email-snapshots`, `ui-snapshots`                                                             |
| Human input | none                                                                                          |
| Repo        | vladzaharia/polaris-key                                                                       |

## Goal

Every email the Worker sends (sign-in and confirm codes, magic link, about 19 notices, download link) uses the ink action button, neutral callouts and the centred lockup of SIGN-IN.md 3.15, and every template has an HTML snapshot.

## Why

Emails still use the violet accent button. Only the subject and text of each notice is snapshotted; the HTML of two templates is, and the sign-in and magic-link emails have behavioural tests only.

## Read first

- AGENTS.md and the relevant skill.
- `program/ux-coverage.md` (the item list this package closes) and `program/ux-waves.md` (where it sits in the schedule).
- Brand transition decisions `program/BRAND-TRANSITION.md` (B-numbers) and the design docs the work touches.

## Scope

**In:**

- renderEmail shell in packages/worker/src/services/identity/portal/email.ts and notices.ts on the brand v2 tokens (UK-58), light and dark where the client honours it.
- HTML snapshots for sendSignInEmail (sign-in and confirm) and every notice template.
- A rendered-email review set (desktop and phone width) for pkey-ux-reviewer.

**Out** (and where it belongs instead):

- Worker pages (I-37, I-38).

## Screens and items this package closes

- `hosted:email-shell`
- `hosted:email-snapshot-tests`
- `hosted:email-signin-code`
- `hosted:email-magic-link`
- `hosted:email-notices-security`
- `hosted:email-notices-license`
- `hosted:email-download-link`

## UX gate

New package from the UX coverage pass (2026-10-09). A built screen is done only when `pkey-ux-reviewer` passes it in BUILT mode and the pass is recorded: `node check.mjs --ux-review I-39 pass "<evidence>"`. No wire change; do not derive APIs, entitlements or permissions from any mockup.

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

- [ ] No accent-filled button remains in any email.
- [ ] Every template has an HTML snapshot and the snapshots are reviewed by pkey-ux-reviewer.
- [ ] The green gate passes (AGENTS.md), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set I-39 in-review` when it hands off; after review, and after the UX review is recorded, the lead adds the last commit `--set I-39 done`.

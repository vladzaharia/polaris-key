# PX-31b Account Packages section and Connected apps with disconnect (split of PX-31)

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (Locker UX waves)                                                                              |
| Size        | 0.2–0.3 engineer-weeks                                                                                                                     |
| Depends on  | [PX-31a](PX-31a-account-v3-shell.md), [I-34](I-34-granular-consent-connected-apps.md), [F-33](F-33-personal-tokens-pkeyp-packages-read.md) |
| Unblocks    | none                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                         |
| Plan mode   | no                                                                                                                                         |
| Gates       | portal-e2e; ui-snapshots                                                                                                                   |
| Human input | none                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Goal

The Account page gains the Packages section and Connected apps with disconnect. The rest of the original PX-31 ([PX-31a](PX-31a-account-v3-shell.md)).

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package. (section 4 row 'Consent toggles…; Account → Connected apps').
- PORTAL.md §4.6; `identity.connected-apps`, `identity.disconnect`, portal-12; section change portal-18.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Packages when F-33 has merged; Connected apps and disconnect over I-34's API.

**Out** (and where it belongs instead):

- Everything PX-31a ships.

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

The role agent sets `--set PX-31b in-review` when it hands off; the lead sets done after review. Waits for F-33 and I-34.

# I-38a Hosted Worker sign-in pages on the Locker identity (I-38 widened)

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (Locker UX waves)                                                                              |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                            |
| Depends on  | [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [LK-04](LK-04-cross-host-sign-in.md), [LK-07](LK-07-worker-pages-and-mail.md), [MK-L1](MK-L1-locker-auth-mockups.md) |
| Unblocks    | none                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                |
| Gates       | ui-snapshots; console-csp-parity; workerd                                                                                                                         |
| Human input | none                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

Every Worker-rendered sign-in page is on the Locker identity and `renderAuthCard()`: the `/device` and `/tv` entry and states, the explicit "Sign in on <device>?" confirm, DL6 refusals, magic-link and identity-off cards, the passport and the CSP `img-src` image origin. Widens [I-38](I-38-hosted-passport-worker-csp.md) with the Worker-page half of PX-14 and auth-12.

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package. (section 1, rows 'Device code', 'Sign in on <device>?', 'Refusal cards', 'Magic-link landing', 'Hosted passport').
- SIGN-IN.md §3.13, §4.2, §4.12; BRAND-TRANSITION.md B8; [I-38](I-38-hosted-passport-worker-csp.md) and the Worker-page half of [PX-14](PX-14-passthrough-header.md); sections auth-01, auth-08, auth-12, auth-14.

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

Owns `brandHtml.ts` and `productOidc/pages.ts` after LK-07 and LK-04 merge. Presentation only: the device confirm step is UI (the fail-closed marker is I-37, P4), the one-origin guard for the CSP `img-src` is as the app policy, and a static expiry. DL6 neutral callout, the fix as the one primary, no disabled dead end. Code and QR side by side in landscape. **The I-37 dependency is dropped.**

**Out** (and where it belongs instead):

- The fail-closed device-code marker (→ I-37).
- The card steps in the SPA (→ PX-14a).

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

- [ ] `pkey-ux-reviewer` passes the built screens in BUILT mode (a real browser, dark and light, 390 and 1440 px), against the matching Locker mockup. The pages are Worker-rendered: review them in the running Worker.
- [ ] `pnpm --filter @polaris-key/worker test adminCspParity` and the UI snapshots pass.
- [ ] The scoped green gate passes (AGENTS.md); the header's gates hold.

## Hand-off

The role agent sets `--set I-38a in-review` when it hands off; the lead sets done after review. Branch from integ/next after the packages in Depends on have merged.

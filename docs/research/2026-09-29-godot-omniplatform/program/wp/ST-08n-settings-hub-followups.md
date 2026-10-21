# ST-08n Product settings hub follow-ups

| Field       | Value                                  |
| ----------- | -------------------------------------- |
| Phase       | ST                                     |
| Size        | 0.5–0.8 engineer-weeks                 |
| Depends on  | [ST-08](ST-08-product-settings-hub.md) |
| Unblocks    | none                                   |
| Role        | `pkey-implementer`                     |
| Plan mode   | no                                     |
| Gates       | `console-csp-parity`, `docs-links`     |
| Human input | none                                   |
| Repo        | vladzaharia/polaris-key                |

## Goal

Close the follow-ups from ST-08's re-check (evidence: `_mockups/review/ST-08/rebuild/`) and its open notes. Parallel builders: ST-45 (sidebar), ST-10 (Cmd-K settings search); keep shell edits minimal.

## Scope

**In**

Majors

- [ ] 1. Phone tab strip: 12 px gap below `sm`; edge mask while it can scroll; active tab scrolled into view on mount.
- [ ] 2. Presentation: Listing rows and Other slots in the left column beside the sticky preview; below `xl` the three miniatures side by side, or the preview capped near 24rem.
- [ ] 3. At 390 with 200 % text the header "All settings" link must not overflow (wrap actions under the h1 below `sm`, or icon-only with its accessible name).

Minors

- [ ] Content keys: list active delegations read-only (`useDelegations`), gated on Release.
- [ ] Off feature's rows: one locked style, "Turns on with <feature>"; rows stay visible but disabled (Review recipe, Locker listing).
- [ ] Polaris Locker sub-switch shows off while Sign-in is off.
- [ ] Members: Role column beside Member; tab count counts product admins only.
- [ ] Folded rows: `aria-labelledby="<button-id> <title-id>"`.
- [ ] Copy: missing OIDC secret names what breaks (`console/lib/shape.ts` `requireSecret` label); callouts promising "Copy the details" get a Copy button; upload failures say "The current copy keeps serving" plus accepted formats on a 415.
- [ ] Quota full: Upload and Replace disabled.
- [ ] Locker turn-off asks to confirm.
- [ ] All settings: Edit-in deep links land on the row; retire the "Outlet capabilities", "Outlets" and "Services" rows the registry lint records as debt and shrink the debt.
- [ ] View-only member gets locked Presentation, Keys and General controls too.
- [ ] ST-11's console editor for `deltas.lazy.*` and `email.dailyCap`.

**Out**: sidebar (ST-45), settings search (ST-10), new wire or migrations.

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

- [ ] Every In item above ticked.
- [ ] Console layout e2e (via heavy.sh), axe and keyboard pass at the committed matrix.
- [ ] Real-browser self-look, dark and light, 390 and 1440.

## Verify

Scoped admin tests, `pnpm typecheck`, the console layout e2e through heavy.sh, then the lead gate once.

```
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-08n done
```

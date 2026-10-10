# PX-14 Passthrough card header and scoped consent

| Field       | Value                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                                                                                                                     |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                                                                         |
| Depends on  | [PX-12](PX-12-login-card-v2.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-08](I-08-app-passthrough.md), [I-15](I-15-native-redirect.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [I-37](I-37-device-code-explicit-confirm.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-33](PX-33-signin-product-cover.md)                                                                                                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                             |
| Plan mode   | no; builds the card for the approved [`plans/I-27.md`](../plans/I-27.md) (2026-10-08) §2.2 and §2.4, [`plans/I-04.md`](../plans/I-04.md) §G, [`plans/PX-W13.md`](../plans/PX-W13.md) and [`plans/UK-02b.md`](../plans/UK-02b.md) §5 item 7                                     |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                      |

## Goal

App sign-ins show "<App> wants you to sign in" in the card header (app and device variants) through every step, from data alone. The card lets the person choose a licence or replace a device, asks consent with a toggle per optional item, and returns them to the app, across the broker, native redirect, web redirect and device code. A product with Identity off gets the `identity_disabled` card. Every screen adapts to its window.

## Why

Passthrough is how apps use the one account ([PORTAL.md §4.7](../../../../design/PORTAL.md#47-app-sign-in-the-card-header)). The owner approved the design on 2026-10-04.

Sources: [PORTAL.md](../../../../design/PORTAL.md) §4.7–§4.9 and §11.3; [SIGN-IN.md](../../../../design/SIGN-IN.md) §2.4, §3.6–§3.18, §4.16 (copy from §5.2, `signin.*`); [`plans/I-27.md`](../plans/I-27.md) §2.2 and §2.4; [`plans/I-04.md`](../plans/I-04.md) §F and §G; [`plans/PX-W13.md`](../plans/PX-W13.md); [`plans/PX-W17.md`](../plans/PX-W17.md); [`plans/UK-02b.md`](../plans/UK-02b.md) §5 item 7; the owner's 2026-10-08 direction on responsive screens.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- [PORTAL.md](../../../../design/PORTAL.md) in full once, then §3.3, §4.7, §4.8, §4.9, §11.3 and §11.4; the matching mockups in `docs/design/portal/`.
- [SIGN-IN.md](../../../../design/SIGN-IN.md) §3.6–§3.18 and §4.16; the prototype in `docs/design/sign-in/prototype/`.
- `wp/I-08-app-passthrough.md`, `wp/I-15-native-redirect.md`; `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- **`CardHeader`** `app` and `device` variants, data only, from the `request` handle (`SignInRequestView`): the product-hero header from Core presentation (HA-12) with the muted brand row, and the neutral frame when `nameVerified` is `false`.
- **LicenseChoiceStep** from I-08's `LicenseChoiceView`, replacing I-26's page: each row shows the tier pill, "{used} of {limit} devices" (seat rows hide the counter in the mixed rule), "{origin} · {term}" with the origin in plain words ("From signing in", "Steam key ending 3WPLDA"), and the expiry; one row preselected; full rows are not radios, read "No free devices" and offer **Replace a device** inline (`ReplaceView`, one confirm naming the device) and **Free a device** only where Replace is not offered. The view's other cases render too: **Keep the license this device uses**, **Create a new free license**, and "You don't have <Product> yet" (linking `/activate?product=…&return=/signin?request=…`).
- **The first automatic licence (I-27 §2.2, D4).** With no candidate and a policy that grants one, the card skips LicenseChoiceStep; ConsentStep is always shown, its licence line reads "New: <Tier> license, created when you continue", and its primary button is the explicit Continue.
- **ConsentStep (`AppConsent`)** from `AppConsentView`: the chosen licence with **Change**; a toggle per optional item inside the requested scope (I-34's `identity.claims`), and Continue posts the granted subset. With no consent due, the primary button reads **Use this license and continue**. In app mode (I-04 §G.3) LicenseChoiceStep is skipped, Consent reads `signin.consent.licenseInApp` with no **Change**, and the desktop return is `signin.return.chooseInApp`.
- **KeyStep** confirms with PX-17's `ConfirmStep` (`primaryLabel` **Add and use on this device**, `signin.key.addAndUse`); in the card the confirm binds the device, and a full added licence offers **Replace a device** inline.
- **New accounts** go through FinishStep (I-27 §2.4: email, screen name, picture, birth date only when a source offered one, terms); its UI is PX-21's, hosted in this card.
- **ReturnStep** variants (SIGN-IN.md §3.10); the `/tv` entry; the `identity_disabled` card, from the `error=identity_disabled` query parameter and the API code.
- **The integrated web flow** (SIGN-IN.md §4.16): one card at one address; key entry, the choice, Replace (a step that replaces the list), Consent and the return are steps of it, each a history entry restored from the server flow record. The device-code page answers `303 /signin?request=rq_…`.
- **Returns.** PX-10 accepts `license=` and the same-origin return `/signin?request=rq_…`; `for=` stays the device label. `FreeDevicePage.tsx` accepts `cardReturn` as the Activate dialog does.
- **`Avatar`** with `picture={account.avatarUrl}` in the consent person row and the device-code done row, never before authentication.
- **Motion** (SIGN-IN.md §3.18): morph, shared element, enter and exit by direction of travel, stagger, expand, success and skeleton on the `--pk-*` tokens; View Transitions with the Web Animations fallback; instant under reduced motion; CSP-safe.
- **Responsive and spacing.** The card and the Worker-rendered device pages (`/activate`, `/device`, `/tv` and the card steps they open) adapt to their window: landscape layouts in a landscape window (the code and QR side by side), stacked in portrait, one spacing rhythm, tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1.
- **The LicenseChoice rows of `ui-matrix.json`** run against `portal/model` in an admin unit test (UK-02b §5 item 7). The card gets no parity manifest row.

**Out** (and where it belongs instead):

- The choice API, grants and routes (→ I-08); FinishStep's API (→ I-33) and its screens (→ PX-21); layer 2 per-product issuer consent (→ I-21).

## Design notes

- Consent is shown on the first sign-in to each app and whenever what it gets changes, for every app (owner decision Q-7).
- New copy uses the owner's licence vocabulary: the tier pill and "{used} of {limit} devices" on every row; no "Account-wide" label.
- Accessibility (SIGN-IN.md §3.14): full and blocked rows are not radios, Replace stays in Tab order, focus moves to each step's h1.
- **Dependency ids.** PORTAL.md §10.3 and §11 cite the first revision of phase I; the graph maps them onto the re-cut S-16 ids (README §8, phase PX).

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

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- DeviceConfirm (B9, I-37): when neither the license-choice nor the consent step shows, render the code panel, person row with Not you?, h1 'Sign in on <device>?', primary 'Sign in on <device>' (focused, no auto-advance) and secondary Deny. (auth-12, auth-13, auth-17, portal-09)
- Device-code entry (/tv, /device, Worker brandHtml): the code is the dominant task with one labelled mono field that fits 320 px; show a valid-format sample; trust line 'Only use a code from your own product, not one somebody sent you.'; name the product (icon, name, device label) ONLY after the code resolves or when `verification_uri_complete` prefilled it; specific copy for expired and invalid codes; script-free (form POST with origin and CSRF check, the code escaped on re-render). (auth-12, auth-13, auth-17, portal-09)
- Consent (B8): scopes listed before both actions, required ones plain and optional ones as toggles (I-34); 'Continue only if you started this connection. <Product> never gets your sign-in credentials.'; Allow (solid) and Deny (outlined) at EQUAL width and height, stacking full-width on phones with Allow last; no decorative panel copy; `frame-ancestors 'none'`. (auth-12, auth-13, auth-17, portal-09)
- Return rules: 'Return to <App>' and 'Open your library' hrefs are built by the server only (a same-origin path matching `/^\/(?![\/\\])/` or the client's registered scheme), never from a query value echoed into the page; `returnTo` and request handles are never shown as text or put in an editable field; the passport shows only the registered origin (globe and host) for web apps, never the `redirect_uri`; a mismatched redirect renders the error card and never redirects. (auth-12, auth-13, auth-17, portal-09)
- Passport per B8 (neutral sunken pane, two panes only landscape 960 px and wider, no eyebrow); the Worker twin and CSP image origin are I-38. Any product image on a Worker page is an `<img>` on the same-origin icon path or the image origin allowed through the shared `cspImageOrigin()` guard, with a THREAT-MODEL note. DL6 states; forced-colours render of radios, meters, focus and the passport; 400% reflow; custom product accent on light and dark; 44 px targets. (auth-12, auth-13, auth-17, portal-09)

## Steps

1. Re-read the PORTAL.md and SIGN-IN.md sections above and the mockups; verify this brief against the code and record any correction here.
2. Build the steps in small commits prefixed `PX-14:`.
3. Add the tests named below; run the green gate and the header's gates; `--set PX-14 in-review`.

## Acceptance criteria

- [ ] e2e: the header persists through every step, and a spoofed name never renders (reserved-name test).
- [ ] Products with Identity off render the `identity_disabled` card (test).
- [ ] D4: with no candidate, LicenseChoiceStep is skipped and Consent shows the new-licence line (e2e).
- [ ] A declined optional item is not posted in `granted` (test).
- [ ] The LicenseChoice rows of `ui-matrix.json` pass against `portal/model` (admin unit test).
- [ ] Every screen this package touches renders at every size in UI-KITS.md §7.1, with no horizontal page scroll at 360 px (§8).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] `pkey-ux-reviewer` passes the built card in a real browser, both themes.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

PX-19 documents app branding data; PX-21 builds FinishStep's screens in this card.

The role agent sets `--set PX-14 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-14 done`.

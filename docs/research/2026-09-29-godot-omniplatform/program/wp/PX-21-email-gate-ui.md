# PX-21 FinishStep: email gate, profile and terms for every new account

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                                           |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                               |
| Depends on  | [PX-12](PX-12-login-card-v2.md), [PX-W15](PX-W15-email-gate.md), [PX-W16](PX-W16-profile-avatars.md), [I-33](I-33-profile-v2-screen-name-birth-date.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                   |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components             |
| Human input | none                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                            |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Profile copy comes from `reason`** ([PX-W16](PX-W16-profile-avatars.md)). PX-W16's profile
  routes (`GET`/`PATCH /api/me/profile`, `POST /api/me/profile/picture`) refuse with the registered
  codes `bad_request`, `not_found` and `body_too_large` plus a `reason` that names the case
  (`invalid_name`, `unknown_source`, `no_name`, `no_picture`, `unknown_upload`, `too_large`,
  `unsupported_type`, `unreadable_image`), not with eight new codes. `ProfileImport` picks its
  refusal copy by `reason`, never by the code alone. The gate's own routes (`card/gate.ts`) answer no
  `reason` today; a gate refusal that needs one adds it the same way.
- **The platform `/callback` join offer** ([PX-W15](PX-W15-email-gate.md)). The platform-OIDC
  callback still answers a `join_offer` with a 409 page (`signInRefusal` in `portal/auth.ts`)
  instead of the gate's join step (SIGN-IN.md D-34). PX-W15 left it until the portal can render that
  step, which this package builds. Routing the callback into the gate moves with this package or
  with I-17 (recorded in both); whichever does it says so in its hand-off, and the other drops it.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Becomes FinishStep: the email gate and RegisterStep merged for every new account, with screen-name chips, picture, conditional birth date, Polaris Key terms and privacy, and product terms.

- Title: was "Email gate UI: `EmailGate` with `ProfileImport` in the login card, all §4.29 variants, plain and under the app header, join hand-off".
- Depends on: added I-33 and P0-38.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the D4 flow and ConsentStep's toggles; FinishStep per §2.4.

## Goal

The login card's `/signin/confirm-email` step renders `EmailGate` with `ProfileImport` in every §4.29 variant (verified, code, Steam empty, terms), plain and under the app header, with the `email_in_use` join hand-off and no skip path.

## Why

Required before the first provider sign-in ships ([PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.29](../../../../design/PORTAL.md#429-confirm-your-email-first-provider-sign-in), [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `EmailGate`, `ProfileImport`, every variant, app-header persistence, join hand-off.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- Ships in the same release as PX-12's providers (§11.4).

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Primary actions are neutral ink in the portal card, hosted sign-in and console card (B2); provider row fills come only from the Apple, Google and Steam allowed sets, never the host tint (B8). PX-21: FinishStep sits inside the passport with no provider strip; the primary stays disabled until both terms are ticked, with the reason line. ST-30: the console card has no app context, so no passport. (auth-17)
- [ ] Forced-colours render, 400% zoom (320 CSS px, no sideways scroll), 200% text, a custom product accent on light and dark, and 44 px customer targets. (auth-17)

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-21:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-21 in-review`.

## Acceptance criteria

- [ ] e2e per variant; the app header persists; no skip path exists.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

none.

The role agent sets `--set PX-21 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-21 done`.

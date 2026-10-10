# P0-38 AuthCard in ui/auth (UX-40)

| Field       | Value                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                  |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                 |
| Depends on  | [P0-36](P0-36-portal-on-copy-catalog.md)                                                                                                                                                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-38](I-38-hosted-passport-worker-csp.md), [PX-12](PX-12-login-card-v2.md), [PX-14](PX-14-passthrough-header.md), [PX-15](PX-15-after-sign-in.md), [PX-21](PX-21-email-gate-ui.md), [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                                                     |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-08** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-40, UX-43.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: after a copy edit, regenerate `ui-matrix.json` with `pnpm gen corpus` without holding the corpus lane (D13).

## Goal

AuthCard in ui/auth (UX-40), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-08** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQF-08**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- Promote LoginCard, ProviderRow, Glyphs and KeyField; one CodeEntry for SignInPage, StepUp and SignInMethods; step slots per SIGN-IN.md §3.2; t() only; the Worker twin renderAuthCard() in brandHtml.ts reads the same catalog (expired code or link with Send a new code, device pages with the product header; UX-43). PX-12, PX-14, PX-15, PX-21 and the console login (ST-30) build on it. Absorbs UX-40 and UX-43.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-08**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

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

- Worker no-JS pages (B8): `brandedHtmlCsp` adds the image origin through the same `cspImageOrigin()` guard `appCsp` uses (one bare https origin, else unchanged) with a header test; no per-product colour or background image (the art is an `<img>`, panes use neutral tokens); no script (static 'Expires at 14:32'; forms POST to self; QR inline SVG); `frame-ancestors 'none'` stays. Delivered by I-38; this brief follows its result. The Worker twin follows SIGN-IN §3.1: 18 px muted lockup in app contexts, Rubik via `font-src 'self'`, top-aligned at 10vh, 'Back to <Product>' wording. (auth-14)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 20 mockup item(s):** `identity.consent`, `identity.device-code-states`, `identity.device-code`, `identity.device-confirm`, `identity.finish`, `identity.key-step`, `identity.refusals`, `identity.sign-in-routes`, `identity.sign-in`, `portal.signin`, `hosted:signin-card`, `hosted:app-header-passport`, `hosted:device-code-entry`, `hosted:device-code-states`, `hosted:device-confirm`, `hosted:license-choice`, `hosted:key-on-ramp`, `hosted:refusals`, `hosted:magic-link-landing`, `hosted:brand-page-shell`.

## Acceptance criteria

- [ ] One AuthCard used by portal sign-in, step-up and console sign-in
- [ ] The Worker's renderAuthCard pages use the same catalog strings (test)
- [ ] No sign-in string outside the catalog
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-38 done`.

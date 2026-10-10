# UK-04 `@polaris-key/elements` on Lit 3: every §4.1 component as `pk-*`, shared `styles.css`, platform variants, CDN module at `key.plrs.im/elements/<major>/pk.js`

| Field       | Value                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                       |
| Size        | 3–4 engineer-weeks                                                                                                                                                                                                                                                                                 |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-03](UK-03-ui-core.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md)                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-05](UK-05-react-kit.md), [UK-17](UK-17-vue-kit.md), [UK-18](UK-18-svelte-kit.md), [UK-19](UK-19-angular-kit.md), [UK-21](UK-21-tauri-bridge.md), [UK-31](UK-31-web-recipes.md), [UK-39](UK-39-python-web-uis.md), [UK-41](UK-41-must-tier-closeout.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                                                 |
| Gates       | Playwright visual baselines (Chromium, WebKit); `pnpm ui:lint`; rule 10 (the CDN route's OpenAPI entry); THREAT-MODEL row for serving script                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                          |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): `<pk-sign-in presentation="inline|sheet|browser" replace="inline|browser">`, the step elements, the web `<dialog>` for `sheet`, and the motion of SIGN-IN.md §3.18 (View Transitions with the Web Animations fallback, CSP-safe). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs UK-22's Tailwind v4 preset; pk-gate takes product + config (polaris-key.json).

- Absorbs UK-22 (split; this package takes its share): Tailwind v4 preset to UK-04, the CSS-variable 'bring your own design system' recipe to UK-31; the shadcn registry route and the MUI, Mantine and Chakra theme objects are parked.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: runs all ten families of `ui-matrix.json`. `hidden` rows assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only; the web browses, so no QR).
- **In this kit:** Container queries on the kit root, in rem, drive DL1, with the root's measured height for short landscape (under 30rem). DL2 is `<dialog>` in the top layer over the §2.1 scrim, a bottom sheet under 35rem, an inert host and focus returned to the opener. Spacing is `--pk-space-*` only. Focus lives in shadow roots with `delegatesFocus`, and the ring follows a keydown-since-load flag. `colorScheme: "system"` walks up from the host element, across shadow roots, to the first opaque ground. `native` is `Canvas`, `CanvasText`, `AccentColor` and the host's font. Links open through one https-checking opener. The Fluent, GNOME and Mac sheet variants come from `theme.platform`.
- **Minimum check:** Every §7.1 GUI row in Chromium and WebKit, both schemes and both presets, plus `forced-colors` and a 24 px root, with DL1's viewport assertions and axe on every render.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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

## Progress and continuation (2026-10-10)

Built so far on `wp/UK-04-elements` (`packages/elements`), in two slices:

1. **The package and every component.** Lit 3 over ui-core: the shared stylesheet (`src/styles.ts`,
   brand's typed tokens on `:host` and the kit root's `[data-theme]`, the kit rules in
   `@layer polaris-key`, logical properties, rem type; written to `dist/styles.css` at build), the
   theme API (`PolarisKey.theme`, `<pk-provider>`, the element's `theme`; identity through
   ui-core's `watchProductIdentity` and the SDK's `PresentationSource`, no fetch or icon cache of
   its own), copy through brand's generated tables and ui-core's `Copy` (the eight packs load on
   demand), all 23 components as `pk-*` elements on ui-core's `ViewModel` (DL7's delay), the
   `<pk-gate>` drop-in (Welcome, StatusScreen, the grace banner, the app slot), where each key goes
   (`src/layout.ts`), the styled parts (`src/render.ts`) and `pk-action`, `pk-input`, `pk-select`
   events. `test/matrix.test.ts` (jsdom) draws all 356 component rows of `ui-matrix.json` through
   their elements and holds the DOM to the catalog's roles.
2. **Real Chromium.** `test/browser/render.browser.test.ts`: every component state (the first row
   of each) at 390 × 844 and 1440 × 900 in dark and light, axe (WCAG 2.x A/AA) on every render, no
   sideways scroll, title and primary in the first viewport, the DL9 keyboard path, and forced
   colours; 503 renders. `PKEY_KIT_SHOTS=<dir>` writes the PNGs.

Then on `wp/UK-04-elements-2`, two more slices:

3. **Look fixes from the renders.** Device rows name the platform through a typed fallback
   table (`src/platforms.ts`; every `Os` of the vocabulary, plus ids device records carry) until
   the catalog has platform-name keys; DeviceLimit is titled Replace a device with the count as
   its subhead above the lede; Settings rows show the catalog entry's `label` (else the key read
   as words), the value's source under it, On or Off, and the lock on the locked row, under a
   From <developer> heading; the dark split's identity panel carries the blurred icon ambient;
   the links row follows the end pane's start edge (and a pane's links its start edge); forced
   colours and reduced transparency hide the blurred art. `test/look.test.ts`.
4. **The one sign-in form.** `<pk-sign-in>` (`src/signin.ts`) morphs its body through the steps,
   drawing the handoff's code view, the license choice and Replace a device in place;
   `presentation` and `replace` attributes; the step elements `pk-sign-in-methods`,
   `pk-replace-device` and `pk-sign-in-done`; Replace a device per SIGN-IN.md §3.7 (least recent
   preselected, Active now and This browser tags, the confirm follows the pick, Replace and
   continue carries the device id); `presentation="sheet"` as a modal `<dialog>` (host inert,
   Escape backs out, focus returns to the opener, bottom sheet under 35rem); the morph (card
   height and the body entering from the side of travel through the Web Animations API, the
   license rows' stagger, Done's check) with reduced motion an instant swap; with `primitives`
   the form drives ui-core's `SignInModel` from its own controls. `test/signin.test.ts` and the
   browser suite's sheet and motion tests.

Decisions taken here (lead, 2026-10-10): no pixel baselines and no change to ui-qa's
React/elements diff until UK-05 renders on this package's `styles.css`; `@polaris-key/node`'s
pure QR encoder stays a dependency (follow-up: move it to client-core); the release closure is
untouched (a new public package registers on npm with a tag deploy, UK-03's rule).

**Model and catalog notes for UK-02a and UK-03, not changed here:** the catalog has no
platform-name keys (`part.platform.<os>`) and no title-role key for the Replace step's heading
(the form uses `deviceLimit.title`, the same words); `ConfigRowInput` has no `label` (the elements
read one when the adapter passes the catalog entry's); `signin.replace.open` and, on macOS,
`signin.replace.openSystem` are in the Replace step's copy though the web confirms inline (D-80),
so the elements draw them as quiet links; the provider row's `{provider}` and a store-origin
license row's `{store}` have no input to fill them (the elements fill `{thisDevice}`, `{device}`
and `{developer}` from what the kit knows).

**Continue here, in this order:**

1. **Baselines and the cross-renderer diff.** Committing PNGs under
   `packages/elements/test/visual/__screenshots__/` turns on `pnpm ui:report`'s React/elements pixel
   diff, which fails on any name only one side has (`packages/ui-qa/src/pixeldiff.ts`). React's 26
   baselines are its pre-UK-05 kit with different scene names, so they cannot match until UK-05
   renders on this `styles.css`. Lead decision needed: gate the diff on UK-05 (for example, active
   only when `@polaris-key/react` depends on `@polaris-key/elements`), then record the baselines
   with a `toMatchScreenshot`-style compare at the §7.1 rows (both presets, 200 % text, 400 % zoom,
   `prefers-contrast: more`) and in WebKit.
2. **The rest of the sign-in form:** the Fluent, GNOME and Mac sheet variants from
   `theme.platform` (the kit tokens exist in brand's `kit.css`); View Transitions for the morph
   once `view-transition-name` works inside shadow roots in the target browsers (the Web
   Animations path is the fallback the spec allows, and it is what runs now); the logo-only
   provider row (D-21) once the input names the providers.
3. **A live adapter** for `<pk-gate>`'s `config` (client-core gate, the sign-in primitives; the
   form's own primitives path is done) and the `examples/ui/elements/` static and htmx samples
   with fixture adapters and `--live`.
4. **`parity.json` `ui.*` rows** were decided by the lead (2026-10-10): the elements' proofs are recorded in React's `ui.*` rows by UK-05, with no separate manifest. Options considered: the registry
   (`conformance/parity/features.json` `sdks`) has no elements entry, a full SDK manifest would
   have to declare every non-UI feature, and the React manifest's `ui.*` rows are UK-05's (in
   flight). Either register a UI-only kit manifest for the elements, or record the elements'
   proofs (`test/matrix.test.ts`, `test/browser/render.browser.test.ts`, both tagged
   `@pkey-feature ui.*`) in React's rows when UK-05 lands.
5. **Follow-up packages, not this one:** the CDN route `key.plrs.im/elements/<major>/pk.js` (an
   esbuild bundle, immutable, SRI; a Worker route with its OpenAPI entry and `routeCoverage` row,
   rule 10, and a THREAT-MODEL row for serving script); the Tailwind v4 preset (from UK-22). The release
   closure follows UK-03's `ba4184ea0` (`npm.elements` in `.pkey/release`, a `publish-sdks.yml` tier
   beside `cli`, the package counts in `sdk-version.test.ts` and `feed-closure.test.ts`, the releasing
   page); a new public package needs a tag deploy to register on npm. Until then
   `packages/elements/package.json` is `"private": true`.
6. **The rest of the acceptance list:** `pnpm ui:lint` over the element renders, the docs
   framework page and kit tabs (UK-16 scaffold), and the UX reviews (`pkey-ux-reviewer`, BUILT
   mode).

**Model notes for UK-03 (ui-core), not changed here:** some states name a `primary` their `copy`
leaves out (Welcome `busy` and `capability-limited`, LicenseChoice `raced` and `new`); the
elements draw the primary anyway (DL4: a busy control keeps its label, and a capability-limited
Welcome would otherwise have no way forward). The matrix's code rows carry no `userCode`, so the
renders add one (`WDJB-MJHT`).

## Goal

Any web page can gate itself with two lines (`<script type=module>` + `<pk-gate>`), every component exists as a Lit 3 element in the Polaris look, and the elements own the shared stylesheet and DOM contract that React reuses.

## Why

The universal fallback for every web framework (§5.1), and the base for Vue, Svelte, Angular and the Godot web-export overlay. Lit 3 is the owner's choice (2026-10-05). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4 Web row, §1.5, §3.1–§3.4, §4 (all), §4.8, §5.3, §7.1
- Mockups: [web-gate-dark](../../../../design/ui-kits/shots/web-gate-dark.png), [web-gate-light](../../../../design/ui-kits/shots/web-gate-light.png), [web-activate-dark](../../../../design/ui-kits/shots/web-activate-dark.png), [web-activate-light](../../../../design/ui-kits/shots/web-activate-light.png), [web-sign-in-dark](../../../../design/ui-kits/shots/web-sign-in-dark.png), [web-sign-in-light](../../../../design/ui-kits/shots/web-sign-in-light.png), [web-device-limit-dark](../../../../design/ui-kits/shots/web-device-limit-dark.png), [web-device-limit-light](../../../../design/ui-kits/shots/web-device-limit-light.png), [web-update-dark](../../../../design/ui-kits/shots/web-update-dark.png), [web-update-light](../../../../design/ui-kits/shots/web-update-light.png), [web-settings-dark](../../../../design/ui-kits/shots/web-settings-dark.png), [web-settings-light](../../../../design/ui-kits/shots/web-settings-light.png), [web-theming-dark](../../../../design/ui-kits/shots/web-theming-dark.png), [web-theming-light](../../../../design/ui-kits/shots/web-theming-light.png), [web-states-dark](../../../../design/ui-kits/shots/web-states-dark.png), [web-states-light](../../../../design/ui-kits/shots/web-states-light.png), [web-components-dark](../../../../design/ui-kits/shots/web-components-dark.png), [web-components-light](../../../../design/ui-kits/shots/web-components-light.png), [web-layers-dark](../../../../design/ui-kits/shots/web-layers-dark.png), [web-layers-light](../../../../design/ui-kits/shots/web-layers-light.png), [web-motion-dark](../../../../design/ui-kits/shots/web-motion-dark.png), [web-motion-light](../../../../design/ui-kits/shots/web-motion-light.png)

## Scope

**In:**

- Every §4.1 component as `pk-*` with `::part`, named slots and `pk-*` DOM events; styled parts as their own elements.
- The shared `styles.css` and `data-part` contract (owned here; React re-exports it), adopted via `adoptedStyleSheets`; `@font-face` for Rubik and the kit mono with fallback metrics.
- Container-query layouts (flow card, full-bleed under 560 px), native `<dialog>` with scrim and `@starting-style`, View Transitions, `forced-colors`, the `platform` variants (Windows Fluent, GNOME, macOS sheet).
- The CDN ES module, built and served by the Worker at `key.plrs.im/elements/<major>/pk.js` (immutable, SRI published), with its OpenAPI entry; npm package `@polaris-key/elements`.
- Static and htmx samples under `examples/ui/elements/`.

**Out** (and where it belongs instead):

- React components (→ UK-05).
- Framework wrappers (→ UK-17–UK-19).

## Design notes

- No new domain (lead decision): the route lives on `key.plrs.im`.
- Kit CSS uses container units, never `vw`, and logical properties only.
- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Web Paywall: no in-kit checkout until the owner's 'commerce: go'. The offers state shows store- or portal-supplied offers only when a checkout exists for the product; otherwise the not-available state with one action that opens the product's store or portal page (an https link from the server, DL14). [ ] A fixture with no checkout renders not-available, never a dead Continue. (sdk-a-15)

## Steps

1. Headless layer first: the models or controllers, running the UK-02b fixtures.
2. Styled parts, then the drop-in flow, against the mockups.
3. Baselines in both themes, the lint, the sample and the docs pages.
4. Design review against the mockups; record it in the PR.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 25 mockup item(s):** `kitboard:web:gate-1440`, `kitboard:web:gate-390`, `kitboard:web:activate-1440`, `kitboard:web:sign-in-1440`, `kitboard:web:sign-in-390`, `kitboard:web:device-limit-1440`, `kitboard:web:device-limit-390`, `kitboard:web:update-prompt`, `kitboard:web:settings-1440`, `kitboard:web:settings-390`, `kitboard:web:theming-four-themes`, `kitboard:web:states-sheet`, `kitboard:web:components-boot`, `kitboard:web:components-status-screen`, `kitboard:web:components-grace-toasts`, `kitboard:web:components-devices`, `kitboard:web:components-paywall`, `kitboard:web:components-cloudsync`, `kitboard:web:layers-b-styled-parts`, `kitboard:web:layers-c-headless`, `kitboard:web:motion`, `kitboard:web:forced-colors`, `kitboard:web:native-preset`, `kitboard:web:web-components-elements`, `sdk.react-sign-in`.

## Acceptance criteria

- [ ] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model.
- [ ] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured.
- [ ] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14).
- [ ] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes.
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `packages/elements/test/visual/__screenshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (`pnpm ui:lint` on the component tests), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (axe on every render).
- [ ] The sample `examples/ui/elements/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`web.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/elements test
mise exec node@22 -- pnpm --filter @polaris-key/elements test:visual
mise exec node@22 -- pnpm ui:lint
```

## Hand-off

React (UK-05) imports `styles.css` and matches the DOM contract; the cross-renderer diff (UK-15) compares them.

The role agent sets `--set UK-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-04 done`.

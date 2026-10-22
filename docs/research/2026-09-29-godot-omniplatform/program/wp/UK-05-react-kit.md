# UK-05 `@polaris-key/react` rebuilt on ui-core: Polaris look by default, `@layer polaris-key` styling, scoped vars, `<PolarisKeyGate>` one-liner, every missing screen, React 18 and 19

| Field       | Value                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                   |
| Size        | 3–4 engineer-weeks                                                                                                                                                                                             |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-03](UK-03-ui-core.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md), [UK-04](UK-04-web-components.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-06](UK-06-electron-kit.md), [UK-20](UK-20-react-native-kit.md), [UK-41](UK-41-must-tier-closeout.md), [UK-42](UK-42-activation-holders-web.md)                     |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                             |
| Gates       | Playwright visual baselines; `pnpm ui:lint`; the React/elements cross-renderer pixel diff                                                                                                                      |
| Human input | none                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                      |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.
- Replace `PolarisLogin.tsx`'s "Authenticate to unlock this app.", "Sign out on another device, or contact your administrator." and "Sign in to the portal…" with `signin.*` (SIGN-IN.md §10.5).

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): `<SignIn presentation replace>` inside `<PolarisKeyGate>` or alone, the step parts, `useSignIn()`, and the motion of SIGN-IN.md §3.18 (View Transitions with the Web Animations fallback, CSP-safe). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> PolarisKeyProvider config={polarisKey}; theme, branding and colorScheme collapse to theme; expectServices accepted as an alias of expectedServices.

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## Breaks for the 0.9 release notes (2026-10-11)

The cutover to the kit removes these from `@polaris-key/react`, with no alias. The replacements are on `@polaris-key/react/kit`: `PolarisKeyGate` calls the SDK itself (so does `SignIn`, given the SDK's primitives), and the other parts draw an `input` and report each control. These are the rows for the changelog entry whose `replaces` builds the Upgrade to 0.9 table (docs plan §3.5, DOC-12a). A component's `*Props` and `*Slots` types go with it.

- `LicenseGate` (root, `/license`) and `PolarisLogin` (root, `/identity`): use `PolarisKeyGate` inside `<PolarisKeyProvider config={polarisKey}>`.
- `PolarisLogout` (root, `/identity`): use Sign out on `AccountAndLicense`, or `usePolarisAuth().signOut()`.
- `DeviceManager` (root, `/license`): use `Devices`.
- `ConfigPanel` and `ConfigRow` (root, `/config`): use `Settings`, over `useManagedConfig()` or `useConfigSetting()`.
- `UpdatePrompt` (root, `/update`): use `UpdatePrompt` from `/kit`, and `useUpdateDecision()` for your own prompt. The `/update` subpath stays, for the hooks and the packs.
- `openManageUrl` (root): use `withManageReturn` and `withManageKey`, then the app's own navigation (the Replace-a-device example on the React "Your own UI" page).
- `usePolarisTheme`, `defaultTheme`, `lightTheme`, `highContrastTheme`, `polarisKeyTheme`, `mergeTheme`, `themeVars`, `baseTokens`, `neutralDarkTokens`, `neutralLightTokens`, `polarisKeyDarkTokens`, `polarisKeyLightTokens` and the types `PolarisTheme`, `PartialTheme`, `PolarisThemeTokens`, `PolarisThemeCopy`, `PolarisBranding`, `PolarisColorScheme`, `PolarisResolvedScheme`, `PoweredByLayout`: use `<PolarisKeyTheme theme={…}>` and `KitTheme`.
- `PoweredByPolarisKey`: use the theme's `poweredBy` option (`"line"` or `"badge"`) on the kit's screens.
- `MessageScreen`, `Button`, `Panel`, `TextField` and `useFocusRing`: use the kit's parts, or your own components.
- `<PolarisKeyProvider>` props `theme`, `branding`, `colorScheme` and `expectServices`: the transport props (`productSlug`, `baseUrl` and the rest) move into `config={polarisKey}`, which takes `expectedServices`; the theme goes on `<PolarisKeyTheme>`.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: runs all ten families of `ui-matrix.json`. `hidden` rows assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Its framework pages replace SP-45a's interim pages in place.

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
- **In this kit:** Shares the elements' stylesheet and DOM contract, so DL1–DL3 and DL10–DL12 come from UK-04's CSS. React adds what CSS cannot: focus moves through refs (a pending target after Save, removal and retry), `inert` siblings while a modal is mounted, a StrictMode-safe provider and `bare` on embedded panels. The fix round's outcomes carry over unchanged: the scheme resolved against the host's ground, the neutral device-limit callout, docked phone actions and two columns in short landscape.
- **Minimum check:** The React browser suite's sizes (the §7.1 rows plus 568×320, 667×375 and 800×600) in both schemes and both presets, and the pixel diff against UK-04; the UX review compares with the fix round's `react.*` renders.
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

## Progress (2026-10-10): first slices, and where to continue

Branch `wp/UK-05-react-kit`. Done:

- **Shared contract.** `@polaris-key/elements/contract` (no Lit) holds the layouts, `placeKeys`
  (a view's primary is always the filled control, which restored Activate's device-limit fix and
  LicenseChoice's key path), the opener list, the theme and copy resolution, the QR encoder and
  `lightDomCss()`: the elements' sheet with every selector anchored to `.pk-root` through `:where()`
  and all of it, tokens included, in `@layer polaris-key` (the shadow sheet's tokens moved into the
  layer too: unlayered, they beat `native`'s surfaces). `dist/styles.css` is that light-DOM form.
- **React kit** (`@polaris-key/react/kit`, `src/kit/`): every §4.1 component as a React component
  over its ui-core view, drawing the elements' DOM; `<PolarisKeyTheme>` (§3.1); the stylesheet
  adopted once per document (never a `<style>`), `@polaris-key/react/styles.css` and `fonts.css`
  for hosts; `fill` for a screen that owns the window. Elements is a workspace devDependency only:
  the build bundles `src/kit/contract.ts` (it is not published until UK-04 completes).
- **`<PolarisKeyGate>`** (root export) starts itself inside `<PolarisKeyProvider>`: loading
  without sign-in paths, the app outside any kit root, Welcome → Activate → refusal (device limit:
  the neutral callout, Replace a device opens the validated link with `return=` and the key, key
  retried on return) → app; the desktop code hand-off with its countdown; Try again, Reconnect,
  Sign out; Escape backs out of a step; focus follows the drawn screen.
- **Shared stylesheet fixes** from the Chromium renders: short landscape in two columns, actions
  docked or sticky so the primary never leaves reach, narrow rows wrap their actions, the gate
  fills the window.
- **Tests:** `test/kitMatrix.test.tsx` (every component row of the eight families, plus "the
  primary is the filled control", also added to the elements' matrix test), `test/kit.test.tsx`,
  `test/kitGate.test.tsx`, `test/browser/kit.browser.test.tsx` (21 states × the §7.1 sizes ×
  dark/light, five under `native`: 498 renders). Baselines: `test/visual/__screenshots__/kit.*`
  (eight scenes, 1440 and 390, both schemes). `parity.json`: seven `ui.*` rows implemented;
  `packages/elements/test` is a test root. New size case `polaris-key-gate` (67.0 KB budget).

Continue with, in order:

1. **The one sign-in form** (SIGN-IN.md §3.17, §3.18): `<SignIn presentation replace>` driven by
   ui-core's `SignInModel` over the SDK (SignIn → hand-off or code → LicenseChoice → Replace →
   done, morphing in place with View Transitions and the Web Animations fallback), inside the
   gate and alone; `useSignIn()`. UK-04's `packages/elements/src/signin.ts` (on main since
   2026-10-10) is the elements' form: port it, as `src/kit/views.tsx` ports `views.ts`, then flip
   `ui.signin`. `SignIn/choose` drawn alone shows its title with no rows, because the rows are
   LicenseChoice's: the form composes them. Keep React's views in step with every later change
   to the elements' `render.ts` and `views.ts` (the matrix and browser suites catch a key that
   goes missing, not a look that drifts; the cross-renderer diff will once UK-04 records
   baselines).
2. **Re-point the legacy components** onto the kit and retire the inline-style theme
   (`components/theme.ts` neutral default): `LicenseGate`, `PolarisLogin`, `DeviceManager` →
   `Devices` wired to `listDevices`/`renameDevice`/`deauthorizeDevice`, `UpdatePrompt` (the root
   name collides: the kit's is on `/kit` until then), `ConfigPanel` → `Settings`, `PolarisLogout`.
   Keep the UK-47 rules (forced-colours Highlight primary, safeLink, the refusal callout). Then
   the DX consolidation: `PolarisKeyProvider config={polarisKey}`, `theme` the §3.1 shape (no
   `branding`/`colorScheme` aliases), `expectServices` refused with `invalid-options`, and the
   provider's presentation source (HA-13/14) fed to the kit with no integrator code. Re-record
   the legacy baselines that change and look at the most-changed scenes before and after.
3. **Theme and i18n families:** run `ui-matrix.json`'s `theme` and `i18n` families through the kit,
   renders in the launch locales (CJK headings at 600), then flip `ui.theme` and `ui.i18n`.
4. **Baselines for every fixture component × state** in both schemes at the §7.1 sizes. PNGs of
   the screen states are about 250 KB at 1440 (the ambient gradient); agree the storage with the
   lead before committing several hundred. Name them `<Component>.<state>/<size>-<scheme>.png`
   so UK-04's land beside them for the cross-renderer diff.
5. **Samples and docs:** `examples/ui/react-vite/` and `examples/ui/react-next/` (App Router,
   `"use client"`, the stylesheet imported in the layout), React 19 in CI beside 18, the
   framework page and the kit tabs in `build/ui/`, the README cut to install + one line + link.
6. **UX review** (`pkey-ux-reviewer`, BUILT mode) against `web.html` and the fix round's `react.*`
   renders; record it in the PR.

Seen in the renders, for ui-core and the corpus (plan-mode, not changed here): `update.current`
and `grace.deadline` print `{size}` and `{date}` because `UiInput` carries neither; Activate's key
states, `SignIn/code` and `Paywall/not-available` carry no title key, so those screens have no h1;
the light ambient's second gradient reads as a smudge at 1440.

## Goal

A React app gates itself in four lines, every §4.1 component exists as a native React component on ui-core sharing the elements' stylesheet and DOM contract, and the old neutral default is gone.

## Why

Today's React kit is correct but looks like a 2019 admin page and lacks half the catalogue (§0, RE). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §0 React row, §1.4 Web row, §1.5, §3.2 React row, §4, §9 (React files to change)
- `packages/sdk-react/src/`
- Mockups: [web-gate-dark](../../../../design/ui-kits/shots/web-gate-dark.png), [web-gate-light](../../../../design/ui-kits/shots/web-gate-light.png), [web-activate-dark](../../../../design/ui-kits/shots/web-activate-dark.png), [web-activate-light](../../../../design/ui-kits/shots/web-activate-light.png), [web-device-limit-dark](../../../../design/ui-kits/shots/web-device-limit-dark.png), [web-device-limit-light](../../../../design/ui-kits/shots/web-device-limit-light.png), [web-update-dark](../../../../design/ui-kits/shots/web-update-dark.png), [web-update-light](../../../../design/ui-kits/shots/web-update-light.png), [web-settings-dark](../../../../design/ui-kits/shots/web-settings-dark.png), [web-settings-light](../../../../design/ui-kits/shots/web-settings-light.png), [web-states-dark](../../../../design/ui-kits/shots/web-states-dark.png), [web-states-light](../../../../design/ui-kits/shots/web-states-light.png)

## Scope

**In:**

- Components on ui-core models, class names `pk-*` and `data-part`, `@layer polaris-key`, `--pk-*` vars scoped to the provider (never `:root`).
- `<PolarisKeyGate>` (starts itself, no flash of the wrong state, live status updates).
- Missing screens: DeviceLimit, SignInHandoff, UpdateProgress, Paywall, ReleaseNotes, AccountAndLicense, About, CloudSyncStatus, Toast, typed Settings.
- `"use client"` boundaries; React 18 and 19 in CI; Vite and Next.js App Router samples.
- §9's React changes: `theme.ts`, README, `test/theme.test.tsx`.

**Out** (and where it belongs instead):

- Electron main/preload (→ UK-06).
- Host design-system adapters (→ UK-22).

## Design notes

- The stylesheet is the elements' (`@polaris-key/elements/styles.css`), re-exported as `@polaris-key/react/styles.css`.
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

- **Builds or backs 25 mockup item(s):** `kitboard:web:gate-1440`, `kitboard:web:gate-390`, `kitboard:web:activate-1440`, `kitboard:web:sign-in-1440`, `kitboard:web:sign-in-390`, `kitboard:web:device-limit-1440`, `kitboard:web:device-limit-390`, `kitboard:web:update-prompt`, `kitboard:web:settings-1440`, `kitboard:web:settings-390`, `kitboard:web:theming-four-themes`, `kitboard:web:states-sheet`, `kitboard:web:components-boot`, `kitboard:web:components-status-screen`, `kitboard:web:components-grace-toasts`, `kitboard:web:components-devices`, `kitboard:web:components-paywall`, `kitboard:web:components-cloudsync`, `kitboard:web:layers-b-styled-parts`, `kitboard:web:layers-c-headless`, `kitboard:web:motion`, `kitboard:web:forced-colors`, `kitboard:web:native-preset`, `sdk.react-sign-in`, `sdk.react-activate`.

## Acceptance criteria

- [ ] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model.
- [ ] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured.
- [ ] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14).
- [ ] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes.
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `packages/sdk-react/test/visual/__screenshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (plus the cross-renderer diff against UK-04), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (axe; focus trap and `inert` background).
- [ ] The sample `examples/ui/react-vite/ and examples/ui/react-next/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`web.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/react test:visual
mise exec node@22 -- pnpm ui:lint
```

## Hand-off

Electron (UK-06), React Native (UK-20) and the shadcn registry (UK-22) build on these components and hooks.

The role agent sets `--set UK-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-05 done`.

## Progress and continuation (2026-10-16, second pass)

Found on main (the audit's list was stale): the one sign-in form (`ui.signin` implemented,
`src/kit/signin.tsx`), the legacy-component cutover (commit 56b9027b9: no `LicenseGate`,
`PolarisLogin`, inline theme or `expectServices`), `examples/ui/react-vite` and `react-next`, and the
framework page. Done in this pass:

- `ui.theme` and `ui.i18n` flipped: the matrix test runs both families (450 tests green), and a new
  Chromium group renders Welcome, Activate, Devices and Settings in de, fr, es, pt-BR, it, ja, ko
  and zh-Hans at 390 and 1440 in both schemes, asserting `lang` and a 600 heading (DL12).
- `provideKitCopy` on `/kit` (the elements' `provideTable`): registers a pack up front. Needed because
  Vite's browser dev server cannot serve the packs' lazy JSON imports (the pack never loaded in
  Chromium), and useful to a host whose bundler does not split them.
- Browser suite on the whole matrix: 21 scenes x 16 sizes x 2 schemes (every §7.1 row, 200 % and a
  24 px root), native, and the 133 states at 390 and 1440 x 2 schemes: 1241 passed. Renders are under
  `_mockups/built/UK-05/`.

Remaining: the committed baselines are still the 390 and 1440 rows (133 states x 4); the other §7.1
rows are asserted (overflow, first viewport, targets, contrast, fonts) and rendered but not committed
as PNGs, pending the lead's storage decision (about 250 KB each at 1440). The cross-renderer diff
needs UK-04's baselines. `packages/sdk-react/README.md` still carries the update-driver and boot-guard
sections, which have no docs page yet: move them before cutting the README to install + one line +
link. UX review (`pkey-ux-reviewer`, BUILT mode) not yet run.

## Progress and continuation (2026-10-17, `wp/UK-05-ux`, driven by the BUILT UX review)

Review: `_lead/reviews/2026-10-16/ux-UK-05.json` (fail, 6 blockers). Scope: `packages/sdk-react` and
`examples/ui/react-*` only; ui-core got the additive `DeviceInput.id` inputs by cherry-pick from
`wp/UK-04-ux` (`c1d7a99a7`), `packages/elements` is untouched.

**Fixed (all 6 blockers):**

- Gate navigation. Back (chevron and label) on every step past Welcome, bound to the Escape action;
  each step is one history entry, so the platform Back steps back; focus returns to the opener. A
  refusal is dropped when the person leaves the step or edits the key; the device limit offers "Use a
  different key" and the refused key stays in the field. Paste works.
- Activate keeps title, lede, field and Paste while typing, parsed, cut short, refused and busy; a
  refusal shows once under the field with `aria-invalid` and `aria-describedby`. The change is the
  drop-in's (`kit/adapt.ts`), applied only when the gate drives itself, so fixture states still draw
  the corpus's keys.
- Devices, Settings, UpdatePrompt and About run themselves inside `<PolarisKeyProvider>` given no
  `input` (`kit/drive.tsx`): rename with a field, remove with an inline confirm under the row (list
  and title kept), switches, choices and number fields from the catalog (`fetchSchema`), update,
  copy diagnostics. Both samples use them and hold no data code; the Vite fixture now answers
  rename, deauthorize, `config.set` and `fetchSchema` like the Next one.
- A driven line whose argument the input lacks is left out, never drawn as `{version}`; the app
  version comes from the provider's `config.version` (now on the context with `productSlug`).
  `UpdateInput.size` has no source in `checkUpdate()`, so "You have {version} · {size}" is dropped.
- Embedded panes draw h2 (`headingLevel` prop; pane form default 2, screen form 1); `embedded` draws
  UpdatePrompt as a pane; the gate stage is `<main>`.
- Shoulds: no part takes focus from the page on mount (only `fill`, `autoFocus` or a part already
  holding focus); a text field is not focused on appear under a coarse pointer; revoked offers Sign
  in as the primary and drops Sign out; devices rows name the unnamed device in their buttons and
  say "This Mac" with no platform; the pane's product header is dropped where the title names it.

- Host-fed parts report the payloads a host needs: row actions carry `deviceId` and `index`, the
  typed name and a setting's value arrive through `onInput` (`rename`, `config:<key>`), and
  `ChannelPicker` draws `input.channel.options` as a radio group reporting through `onSelect`.
  UK-04's `LAYOUTS.Activate` gaining `common.back` is compatible: the gate adds its own Back only
  when the view's copy lacks the key.

**Remaining:**

- Visual, in the shared stylesheet (`packages/elements`, UK-04's): the gate's two-pane row pinned at
  the top with an empty lower half and a 45 % identity pane; Welcome links wrapping 3 + 1; lavender
  light-scheme surfaces; the pane form's actions aligned to the end; the baseline of the Copy
  button against the code.
- SignIn: the code step's countdown and "Waiting" status; the methods step's "Or continue with"
  divider, full-width Cancel, "Sign in…" link and method order (`signin.tsx`, not touched this slice).
- Copy, from the catalog and ui-core's copy lists (corpus-fixed): Expired's body repeats its title;
  Device limit states the count three times and the confirm callout runs four sentences; the grace
  banner says Offline and reconnect twice; raw setting values in a host-fed Settings (the driven part
  formats them).
- Versus mockup: tier in the Activate header, the parsed-license line, the Help/Privacy/version
  footer, Settings toggles beyond the driven part.
- Fixture-fed (non-driven) parts still draw `{size}`-style gaps where the corpus rows omit the
  argument (the UK-04 renderer drops them; the React renderer drops them only when driven, because
  `kitMatrix` requires each listed key on screen). Decide with UK-02b whether the rows carry the
  value.
- Pixel baselines for the changed driven states and the new Back control are not recorded (the
  committed rows are the fixture states, unchanged); re-record with the lead's storage decision.

Note (2026-10-17, UK-04 `wp/UK-04-next`): the stylesheet's visual items above (centred card with 5:7
panes and a filled identity panel, links that stack whole, neutral light surfaces, pane actions at
the end, the Copy baseline) are fixed in `packages/elements`; this package picks them up on its
next build. The code step's countdown, the methods step's divider and "Sign in..." (the elements'
renderer drops both; React's `signin.tsx` still draws them) and the copy items stay with this
package and the catalog.

## Progress and continuation (2026-10-17, `wp/UK-05-next`, on `wp/UK-04-next`)

UK-04's controls reach React's own parts (`kit/views.tsx`, `kit/parts.tsx`) and the sign-in form
(`kit/signin.tsx`, `kit/adapt.ts`). The stylesheet items came with the build.

- Panes: the device list scrolls in its own box past six rows and opens on the checked row
  (`data-scroll`, `openOnChecked`); the Replace primary names the device
  (`signin.replace.confirmNamed`, also Activate's device-limit primary); the count is stated once
  (the subhead, not the meter caption too); setting labels spell UI, URL, ID; the no-browser hand-off
  shows its address; the Replace step has no "Replace a device" openers over its own button.
- SignIn: the code step has "Code expires in 4:12" (a local one-second tick over the model's
  `secondsLeft`, not a live region; at 0:00 the model's view goes to expired), a polite status
  "Waiting for you to sign in…" and a full-width Cancel (also in the gate's own hand-off step); the
  methods and error steps have no "Or continue with" divider and no "Sign in…" link; a failed
  sign-in keeps the other methods (the shared `formStep`).
- Tests: `test/kitNext.test.tsx`; `kitMatrix.test.tsx` lists the keys left out on purpose; browser
  scenes `SignIn.methods-web`, `SignIn.error-kept`, `SignIn.code-live` (the old `SignIn.code`
  scene used a row with no code, so it drew "Getting a sign-in code…"; its id also collided with a
  baseline fixture's shots).
- Size: React gate +70.8 KB against the unchanged 71.5 KB budget; not ratcheted (no headroom to
  give back). Lazy-loading the offline and offer steps stays the follow-up if the next slice grows it.

Decided, not done: the waiting status reuses the terminal's `cli.signin.waitingCode` ("Waiting for
you to sign in…"; nine locales) rather than a new kit key; a kit key with the same words is the
tidy fix and needs `pnpm gen brand`. Method order: the first method is ui-core's primary (corpus
rows pin it), so the order is not changed here; "Polaris Key" ahead of the product is the lead's
call. Still open: the revoked and expired ledes, the four-sentence Replace callout and the grace
banner's wording (catalog), the versus-mockup items, pixel baselines.

## Consolidation 2026-10-22 (triage)

The remaining copy calls (revoked/expired ledes, Replace callout, grace banner, waiting-line kit key at `adapt.ts:93`) are not criteria of this package: they go to the lead's COPY PASS.

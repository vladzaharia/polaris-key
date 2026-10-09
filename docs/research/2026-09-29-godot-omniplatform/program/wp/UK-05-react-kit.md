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

## Steps

1. Headless layer first: the models or controllers, running the UK-02b fixtures.
2. Styled parts, then the drop-in flow, against the mockups.
3. Baselines in both themes, the lint, the sample and the docs pages.
4. Design review against the mockups; record it in the PR.

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

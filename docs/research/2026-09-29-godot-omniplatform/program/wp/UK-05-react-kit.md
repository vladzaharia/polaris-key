# UK-05 `@polaris-key/react` rebuilt on ui-core: Polaris look by default, `@layer polaris-key` styling, scoped vars, `<PolarisKeyGate>` one-liner, every missing screen, React 18 and 19

| Field       | Value                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                   |
| Size        | 3–4 engineer-weeks                                                                                                                                                                                             |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-03](UK-03-ui-core.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md), [UK-04](UK-04-web-components.md) |
| Unblocks    | [UK-06](UK-06-electron-kit.md), [UK-20](UK-20-react-native-kit.md), [UK-22](UK-22-host-design-systems.md), [UK-41](UK-41-must-tier-closeout.md)                                                                |
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

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill, "{n} of {limit} devices" or "Account-wide · unlimited devices", **Lifetime**); DeviceLimit titled **Replace a device**.
- Replace `PolarisLogin.tsx`'s "Authenticate to unlock this app.", "Sign out on another device, or contact your administrator." and "Sign in to the portal…" with `signin.*` (SIGN-IN.md §10.5).

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

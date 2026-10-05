# UK-04 `@polaris-key/elements` on Lit 3: every §4.1 component as `pk-*`, shared `styles.css`, platform variants, CDN module at `key.plrs.im/elements/<major>/pk.js`

| Field       | Value                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                    |
| Size        | 3–4 engineer-weeks                                                                                                                                                                                                                                                                              |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-03](UK-03-ui-core.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md)                                                                                                                    |
| Unblocks    | [UK-05](UK-05-react-kit.md), [UK-17](UK-17-vue-kit.md), [UK-18](UK-18-svelte-kit.md), [UK-19](UK-19-angular-kit.md), [UK-21](UK-21-tauri-bridge.md), [UK-31](UK-31-web-recipes.md), [UK-37](UK-37-godot-web-overlay.md), [UK-39](UK-39-python-web-uis.md), [UK-41](UK-41-must-tier-closeout.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                                                                                                              |
| Gates       | Playwright visual baselines (Chromium, WebKit); `pnpm ui:lint`; rule 10 (the CDN route's OpenAPI entry); THREAT-MODEL row for serving script                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                       |

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `packages/elements/test/visual/__screenshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (`pnpm ui:lint` on the component tests), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (axe on every render).
- [ ] The sample `examples/ui/elements/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`web.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
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

# UK-11 Godot UI kit modernised in place: brand default (dark), glass `PKeySheet`, wordmark and display face, input glyphs, console focus ring, themed engine icons, Tween motion, new scenes, POT export

| Field       | Value                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                              |
| Size        | 5–7 engineer-weeks                                                                                                                                                                        |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-29](UK-29-godot-dotnet-facade.md), [UK-41](UK-41-must-tier-closeout.md), [UK-43](UK-43-activation-holders-native.md)                          |
| Role        | `pkey-godot-engineer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                        |
| Gates       | `tools/ui_screenshots.gd` promoted to a compared suite; the Godot focus-chain tests; the Godot lint equivalent (every engine control icon themed); `sdks/godot/tools/run_tests.sh`        |
| Human input | none                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                 |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.
- "Is this you?" and the attach checkbox only after **Keep** (D-10); title "Activate" → "Welcome to <Product>" (SIGN-IN.md §10.5).

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): `PKeySignIn` as the in-game inline form (frames 31, 39), `PKeySheet` for `sheet`, the inline Replace confirm, `PKeySignInController`, and the Godot motion of SIGN-IN.md §3.18 (`ui_reduce_motion` swaps instantly). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Godot reads res://polaris-key.json (SP-32b); the dock gains Import polaris-key.json and drops the pkey shell-out as the default path.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: runs all ten families of `ui-matrix.json`. `hidden` rows assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Its framework pages replace SP-45b's interim pages in place.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: a QR only on pad-only, TV and console screens).
- **In this kit:** Game UI. Two columns when the panel is landscape, at least 680 layout px wide and at least 1.5:1, for identity-plus-form screens; 4:3 gets one centred column; phone portrait (under 560 layout px, or `OS.has_feature("mobile")`) goes full-bleed, top-aligned, with the actions docked and stacked, primary on top. Dialogs over a running game sit on the 0.42 (dark) or 0.2 (light) scrim; the gate and boot keep their opaque ground. Densities derive from `PKeyKitTokens`. The last input decides focus: after a pad or keyboard, grab the initial control; after a pointer, nothing until the first D-pad press. Busy controls keep focus, and the ring is 3 px at a 2 px offset plus a fill step. On phones the scale ladder takes a floor from the screen's density (16 dp body, 48 dp controls). The CJK fallback has a 600 face. `ui_branding` defaults to the brand look, the accent comes from `PKeyAccent`, and the native look borrows the ancestor or project theme with a kit ring and a ground where the game's panel is empty. Links pass `PKeyOutletAdapter.is_https`. Title-safe 5 % and the toast anchor keep play visible.
- **Minimum check:** `suite_ui_matrix` at §7.1's Godot rows plus 640×360, 1080×2400, 1170×2532 at 3×, 1536×2048 and 3440×1440, in the brand, native, custom, default and accent looks; the focus pass and the stretch setups to PNG; `de` and `ja`. The UX review compares with the fix round's `godot.*` renders.
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

## Goal

A game gates itself with `await PolarisKey.boot()` and every screen looks like modern game UI: glass panels, the game's wordmark, a console focus ring, input glyphs, themed engine controls, at console and Steam Deck sizes.

## Why

The Godot kit has solid plumbing but dated pixels: about 4/10 for polish (§0, GO). Godot is the programme's primary engine. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §0 Godot row, §1.4 Godot row, §1.5 (rules 5, 6), §3.2 Godot row, §4, §4.3 (games never interrupt play), §4.8, §9 (Godot files)
- `sdks/godot/addons/polaris_key/ui/`, `tools/ui_screenshots.gd`
- Mockups: [godot-gate-dark](../../../../design/ui-kits/shots/godot-gate-dark.png), [godot-gate-light](../../../../design/ui-kits/shots/godot-gate-light.png), [godot-activate-dark](../../../../design/ui-kits/shots/godot-activate-dark.png), [godot-activate-light](../../../../design/ui-kits/shots/godot-activate-light.png), [godot-sign-in-dark](../../../../design/ui-kits/shots/godot-sign-in-dark.png), [godot-sign-in-light](../../../../design/ui-kits/shots/godot-sign-in-light.png), [godot-device-limit-dark](../../../../design/ui-kits/shots/godot-device-limit-dark.png), [godot-device-limit-light](../../../../design/ui-kits/shots/godot-device-limit-light.png), [godot-update-toast-dark](../../../../design/ui-kits/shots/godot-update-toast-dark.png), [godot-update-toast-light](../../../../design/ui-kits/shots/godot-update-toast-light.png), [godot-update-dark](../../../../design/ui-kits/shots/godot-update-dark.png), [godot-update-light](../../../../design/ui-kits/shots/godot-update-light.png), [godot-settings-dark](../../../../design/ui-kits/shots/godot-settings-dark.png), [godot-settings-light](../../../../design/ui-kits/shots/godot-settings-light.png), [godot-gate-deck-dark](../../../../design/ui-kits/shots/godot-gate-deck-dark.png), [godot-gate-deck-light](../../../../design/ui-kits/shots/godot-gate-deck-light.png)

## Scope

**In:**

- Brand default with `colorScheme` dark; glass panel and `PKeySheet` host with scrim, the opaque fallback (`gl_compatibility`, web, `ui_reduce_transparency`).
- `product.wordmark`, `typography.display`, `PKeyInputGlyphs` with the confirm swap, console focus ring with glow, the type floor, toast anchor, UI sound hooks, haptics.
- MSDF fonts and `ui_scale`; every engine control icon themed; 60 px controls; icon set; Tween motion with reduced motion; OS dark-mode follow; safe areas; AccessKit names and live regions.
- New scenes: DeviceLimit, Devices, Paywall, Account tab, CloudSyncStatus, About, Toast, UpdateProgress, ReleaseNotes; copy fixes (no raw codes or slugs); POT export from UK-02a.
- Controllers run the UK-02b fixtures; the presentation seam filled by HA-14.

**Out** (and where it belongs instead):

- The C# facade (→ UK-29); editor dock and web-export overlay (→ UK-36, UK-37).

## Design notes

- `options.gd` `ui_branding := "none"` and the neutral builder become the `native` preset (§3.4, §9).
- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

## Presentation seam ([`plans/HA-11.md`](../plans/HA-11.md), approved 2026-10-06)

- **Do not define a seam.** The kit's `ProductIdentity` resolver takes the Godot `PKeyPresentationSource` (`core/presentation.gd`, HA-14).
- **Bidi-isolate presentation text** ([`plans/HA-12.md`](../plans/HA-12.md) Q5). The SDK keeps bidi controls in `PresentationSource` `name` and `developerName` (only C0 and C1 are dropped), so the kit renders both in an isolated run: wrapped in FSI…PDI (U+2068…U+2069).
- **Before that lands.** If the SDK type has not landed when this package starts, declare a
  structurally identical local type, `current()`, `icon(px, scale)` and change notification, and
  replace it with the SDK's type when it lands.
- **Fake sources.** Tests build fake sources from that type.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Host-owns-pause (B10): see UK-50; set `process_mode` so kit dialogs survive tree pause and verify in the engine. (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)
- Art: theme values `product.backdrop` (Texture2D, integrator-set, no wire change) fill the identity pane at two-pane rows and sit dimmed behind the card at one-column rows; `product.wordmark` replaces the name when set; reduced transparency makes the card opaque. Presentation-level art is a discovery change: record it as a known gap for an HA follow-up through plan mode. (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)
- Update prompt: What's new lines (at most three) and size when the release carries them; verbs follow the outlet (Restart now only for a staged code pack); Later keeps initial focus; download, verify, ready and installed stay distinct. UpdateProgress toast at the host's `toast_anchor` inside 5% title-safe, never over the HUD, never taking gamepad focus; the deferral label is a host string. (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)
- PKeyAccountTab for a game's tabbed menu: host navigation, no own rail when embedded, email masked and revealed on focus on TV and console, typed settings as rows; labels read positively from the catalog schema. (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)
- Boot: wordmark over product art; loading is DL7 (nothing for 250-300 ms, then identity, a muted stage label and the 2 px indeterminate shimmer; a determinate bar only for real bytes). No part-filled bar. (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)
- Activate: live verdict line under the field (prefix immediately, tier and terms only after the server answers), the input-glyph hint bar, and UK-43's Done step; masking per the key-field rule (visible and private). (sdk-c-03, sdk-c-05, sdk-c-15, sdk-c-16, sdk-c-17, sdk-c-19, sdk-c-32)

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/godot/tests/ui/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (every engine control icon set by the brand theme), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (gamepad focus chain, AccessKit live regions).
- [ ] The sample `the addon's demo project` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`godot.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
sdks/godot/tools/run_tests.sh
```

## Hand-off

UK-29, UK-36 and UK-37 extend the kit; HA-14 plugs the Godot presentation into `ui_accent` and the brand node through the same seam.

The role agent sets `--set UK-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-11 done`.

# Polaris Key UI kits: one design system for every SDK

**Status:** proposed, 2026-10-05. Design spec plus build plan; nothing here is implemented yet.

**Owner brief (verbatim):**

- "As part of our SDK parity pass, we should also do a UI SDK parity and modernization pass. All of
  the available UI kits and components should be modernized, made as easy to drop in (piecemeal or
  whole as possible), and made to look and feel like they belong in the Polaris Key ecosystem (by
  default, with themeing/styling available)"
- "We should also ensure we support all major UI systems and frameworks for the platforms/langauegs
  we support."
- "The Polaris Key UI Kit branding should still be product-focused, even while using Polaris Key
  branding."
- "And in general, each SDK UI Kit should implement modern, beautiful drop-in UIs that we can
  customize (or reimplement with primitives ourselves)"
- "It should look like all the UI kits were made in 2026 using modern, clean principles. Scrutinize
  these HEAVILY."

**What this document is.** The single spec for every UI an SDK ships: the React kit
(`packages/sdk-react`), the SwiftUI kit (`sdks/swift/Sources/PolarisKeyUI`), the Compose kit
(`sdks/kotlin/ui`), the Godot kit (`sdks/godot/addons/polaris_key/ui`), and the kits that do not
exist yet (web components, Vue, Svelte, Angular, React Native, Electron, Tauri, UIKit, AppKit,
Compose Desktop, Android Views, Qt, Tkinter, the terminal and more). It covers the default look
(§1), tokens (§2), the theme API (§3), the component catalogue (§4), the framework matrix and
architecture (§5), samples and docs (§6), visual QA (§7), the mockups (§8), what it supersedes (§9),
the build plan (§10) and open questions (§11).

**Relationship to the other specs.** [BRAND.md](BRAND.md) stays canonical for tokens, accents, marks
and type. `EXPERIENCE.md` (on the `brand/experience-spec`
branch when this was written, landing beside this file) and [PORTAL.md](PORTAL.md) stay canonical for the
web portal and console. This document borrows their flows (the one login card, the device-limit
flow, the confirmation levels, the copy rules) so a person moving between an app, the portal and
the console meets one system. Where this document and BRAND §12.1 disagree, **this document wins**
(§9).

**Evidence.** Five audits on 2026-10-05 against `main` @ 248fef64. Every kit was built and rendered;
the screenshots are under `/private/tmp/claude-501/ui-kit-audit/` (`react/` 36 renders, `swiftui/`
48 macOS and iOS 26 renders, `compose/` the 136 Roborazzi baselines plus the verify log, `godot/` 428
renders at five sizes, `gaps/` the Python and Node CLI output). Findings below cite them as **RE**
(React), **SW** (SwiftUI), **KO** (Compose), **GO** (Godot) and **GA** (gap audit).

### Contents

[1. The Polaris Key default look](#1-the-polaris-key-default-look) ·
[2. Tokens in every kit](#2-tokens-in-every-kit) · [3. One theme API](#3-one-theme-api) ·
[4. The component catalogue](#4-the-component-catalogue) ·
[5. Frameworks and architecture](#5-frameworks-and-architecture) ·
[6. Samples and docs](#6-samples-and-docs) · [7. Visual QA](#7-visual-qa) ·
[8. Mockups](#8-mockups) · [9. What this supersedes](#9-what-this-supersedes) ·
[10. Build plan](#10-build-plan) · [11. Questions for the owner](#11-questions-for-the-owner)

---

## 0. Where the kits are today

| Kit          | Screens that exist                                                                                                               | Verdict (2026 scale)                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React        | Gate, login card, logout, devices, config panel, update prompt, Powered-by; 11 headless hooks                                    | Correct and accessible, plain 2019 admin look: inline styles, no hover/pressed/disabled visuals, no motion, an opaque full-window "dialog", violet only, neutral default (RE). Half the catalogue missing.                                         |
| SwiftUI      | One screen, `PolarisLoginView` (activation card, grace banner, message card)                                                     | An iOS 17 kit: no Liquid Glass, forced 10 pt rounded rectangles over iOS 26 capsules, a flash of the sign-in card on every launch, "this Mac" copy on iPhone, unreadable prominent buttons in inactive macOS windows, ~10 % of the catalogue (SW). |
| Compose      | Boot, gate, activation, device-code sign-in, devices, update offer, pack progress, read-only settings                            | Material 3 at its 2023 level (no Expressive), one centred 480 dp column everywhere, no one-line flow, Android only, toolchain pinned to the Godot template (KO).                                                                                   |
| Godot        | Boot, gate, activation, sign-in with QR, offline activation, update prompt, status banner, entitlement badge, settings, dev menu | Solid plumbing (focus chain, controllers, tr()), dated pixels: 1 px outlined boxes, engine-default bitmap toggles and spinners, no icons, no motion, no surfaces on half the screens, raw codes in copy (GO). About 4/10 for polish.               |
| Python, Node | Plain-text CLI verbs only                                                                                                        | No kit. `ui.kit` is marked `na` (headless) in both `parity.json` files, which hides the two largest framework gaps (Qt, Electron) from the parity gate (GA).                                                                                       |

What is worth keeping everywhere: the headless cores (React hooks and `/core`, Compose's stateless
screens and pure state holders, Godot's per-scene controllers, `ui.stages` in every SDK), the
accessibility baselines (React's MessageScreen contract, Compose's `AccessibilityTest`, Godot's
gamepad focus chain), and the generated brand tokens with their drift gate.

---

## 1. The Polaris Key default look

### 1.1 The rule

**Every kit renders the Polaris Key look by default** (owner direction 2026-10-05, superseding the
2026-10-04 "neutral/native by default" decision): the `@polaris-key/brand` surfaces, text, status
and elevation tokens, Rubik, the radii and motion tokens, dark first with full light parity and a
"System · Dark · Light" choice. A `native` preset (§3.4) restyles any kit to follow its host; a
partial theme restyles one token at a time.

### 1.2 The product is the hero

Polaris Key supplies the **design language, structure and polish**. The **product** leads every
screen:

- **`ProductIdentity`** (`name`, `icon`, `developer`, optional `accent`, optional `art`) heads every
  full screen, sheet and card: the product icon at hero size on the gate, at 32 px beside the
  product name on focused steps, at 56 px in update prompts and settings. Titles name the product
  ("Welcome to Tidewater Studio", "Tidewater Studio 2.5", "Your license is on 3 of 3 devices" under
  "Tidewater Studio Pro").
- **Where identity comes from:** the integrator's theme first, then the product's registered
  presentation (G1: name, icon, developer; the same data the portal shows), then the bundle (app
  name and icon from `Info.plist`, the Android manifest, `package.json` `productName`, Godot's
  `application/config/name` and icon). With no icon at all the kit draws a **monogram tile**: the
  product's initial in Rubik Bold on `accent-subtle`. It never falls back to a Polaris Key mark.
- **Product ambient:** the gate and boot screens may lay the product icon (or `art`), blurred 70–90
  px at 25–55 % opacity, behind the hero (the mockups do). It is the product's own content, so it is
  not a gradient in Polaris chrome (BRAND §7.7 still holds for the chrome); `theme.ambient = false`
  turns it off, and it is off under the `native` preset.
- **Accent:** `theme.accent` defaults to `"product"`: the product's accent when its presentation or
  the integrator supplies one, otherwise the core violet. Any accent is run through the contrast
  resolver (§3.3) so `solid`, `fg`, `on`, `subtle` and the focus ring stay AA in both themes.
- **Polaris Key appears only as an optional "Powered by Polaris Key"** line or badge (`poweredBy`,
  off by default, §4.5). No kit screen shows the Pinned K, the Star Cut or the "Polaris Key" name
  otherwise. Two exceptions, both of which are true statements about who handles a step: the sign-in
  footnote "Polaris Key handles sign-in for <Product>. <Developer> never sees your codes or
  passkeys." (EXPERIENCE §8 passthrough footer) and the device-code URL `key.plrs.im/tv`.
- **Service cues:** the six service accents appear only as **small cues** (a 20–28 px tinted glyph
  tile in the service's `subtle` and `fg`): License chartreuse on license sections, Update tangerine
  on update sections, Identity orchid on sign-in method lists, Config yellow on "From <Developer>"
  managed-settings groups. Never as a fill, never as the primary button, never as a status (BRAND
  §5.4). `theme.accent = "service"` is an opt-in that uses the section accent for the primary button
  inside that section, for integrators who want the console's look.

### 1.3 Three layers in every kit

Every component in §4 ships in three layers, so a team can drop in a flow, restyle a component, or
rebuild the UI on the state alone:

| Layer                | What it is                                                 | Web                                                    | SwiftUI                                                  | Compose                                                  | Godot                                           | Python (Qt)                                  |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| **(a) Drop-in flow** | One call that gates the app and runs every screen it needs | `<PolarisKeyGate>` / `<pk-gate>`                       | `.polarisKeyGate(client)` / `PolarisKeyGate(client) { }` | `PolarisKeyGate(client) { }`                             | `PKeyGate` node / `await PolarisKey.boot()`     | `polaris_key.ui.qt.run_gate(client, window)` |
| **(b) Styled parts** | Each screen and each part on its own, themed, with slots   | `<Activate>`, `<DeviceList>`… with `data-part` + slots | `ActivateView`, `DeviceList`… with `PolarisKeyStyle`     | `Activate(state)`, `DeviceList(state)`… with `*Defaults` | `PKeyActivate.tscn`… with theme type variations | `ActivateWidget`… with object names + QSS    |
| **(c) Headless**     | The state machine, actions and copy keys, no UI            | `useActivate()` (React), `ActivateModel` (ui-core)     | `@Observable ActivateModel`                              | `rememberActivateState(client)`                          | `PKeyActivateController`                        | `ActivateViewModel` (`polaris_key.ui.core`)  |

Layer (c) is the same state machine in every language, pinned by conformance fixtures (§5.2), so a
React screen, a SwiftUI screen and a Godot scene fed the same inputs show the same step with the same
copy key.

### 1.4 Platform-adapted, clearly Polaris Key

One identity, rendered in each platform's current idiom. What stays identical everywhere: the
product-first hierarchy, Rubik (except under `native`), the token colours, the copy, the flows and
their order, one primary per region, status as icon plus word.

| Platform                                        | Design language                                     | What the kit does                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web** (React, elements, Vue, Svelte, Angular) | Modern web, 2026                                    | Cards `surface-raised` with a hairline and `elevation-3`, card radius 22 px, 48 px controls with 12 px radius, fluid type (`clamp()`), container queries, native `<dialog>` in the top layer with a blurred scrim, View Transitions between steps, `:hover`/`:active`/`:disabled`/`:focus-visible` states, `forced-colors` support                             |
| **iOS / iPadOS 26**                             | Liquid Glass                                        | Full-bleed screens with the product hero and a bottom action area; capsule `.glassProminent` primary and `.glass` secondary buttons; sheets with detents, floating at the medium detent; circular glass toolbar buttons (xmark, checkmark); inset grouped lists; `GlassEffectContainer` for grouped controls. iOS 17–25: the same layout on `.regularMaterial` |
| **macOS 26**                                    | Liquid Glass, Mac idioms                            | Sheets (not window takeovers), a Settings scene pane, `CommandGroup` items (Check for Updates…, Manage License…), a SwiftUI Sparkle user driver, split hero/form windows, glass sidebars                                                                                                                                                                       |
| **visionOS / tvOS / watchOS**                   | Glass windows, focus engine, glance                 | visionOS: glass windows and ornaments for banners; tvOS: device-code sign-in first, focus-scaled controls; watchOS: status glance only                                                                                                                                                                                                                         |
| **Android**                                     | Material 3 Expressive                               | Expressive type, shape-morphing product icon container (Cookie 9), 56 dp full-round buttons, connected button groups, contained `LoadingIndicator`, wavy progress, segmented (connected) lists, `MotionScheme` springs, Material Symbols Rounded, adaptive layouts (window size classes, list-detail, bottom sheets), dynamic colour only under `native`       |
| **Windows, Linux desktop**                      | Fluent 2 / Mica (Windows), Adwaita-friendly (Linux) | Electron, Tauri, Compose Desktop and Qt render the web or Compose look inside native chrome; Windows uses Mica backdrop and Fluent corner radii (8 px controls) through the `windows` platform variant                                                                                                                                                         |
| **Godot**                                       | Modern game UI                                      | Glass panels over the game (backdrop blur shader), 60 px controls, gamepad glyph hints, a 3 px focus ring with a 4 px offset and a 1.02 scale on focus, every engine control themed with generated SVG icons                                                                                                                                                   |
| **Terminal** (Node, Python)                     | 2026 CLI (gh, uv, wrangler, clack)                  | Truecolor from the tokens with ANSI-16 and `NO_COLOR` fallbacks, clack-style rails, spinners and progress bars, terminal QR codes, masked key entry, `--json` on every verb                                                                                                                                                                                    |

### 1.5 Nothing dated: the hard rules

Each rule is checked by the visual QA lint (§7.3) or a kit test. A screen that breaks one does not
ship.

1. **No boxed forms.** Inputs sit on `surface-sunken` with a hairline, not 1 px outlined boxes on a
   flat page; groups are inset grouped lists or `k-group` panels, never fieldsets.
2. **No heavy borders.** Hairlines only (`border-subtle` at ≤ 80 % mix); depth comes from surface
   steps and the elevation tokens, plus an inner top highlight on raised surfaces.
3. **No default system alerts** for anything the kit owns (no `alert()`, no `NSAlert`, no
   `AlertDialog` with stock buttons, no Godot `AcceptDialog`). Confirmations are EXPERIENCE §7
   levels: inline panels, sheets, or the kit's dialog.
4. **No stock spinners.** Loading is a skeleton shaped like the content, a neutral ring in
   `text-subtle` (web, desktop, Godot, terminal), the M3 Expressive `LoadingIndicator` (Android), or
   `ProgressView` in its iOS 26 style. Never the star (BRAND §7.5).
5. **No cramped spacing.** 4 px grid; card padding ≥ 28 px (web), ≥ 20 pt (iOS), ≥ 24 dp (Android),
   ≥ 40 px (Godot at 1080p); 10–14 px between stacked controls; touch targets ≥ 44 pt / 48 dp, TV and
   gamepad targets ≥ 60 px.
6. **No 2018 Material or Bootstrap tells:** no all-caps buttons, no 4 px-radius cards, no drop
   shadows below flat cards on dark, no underline-only text fields, no default blue links, no
   engine-default bitmap controls (Godot), no `CheckBox` where a switch is meant.
7. **States are visible:** hover, pressed (scale 0.98 or the platform press), disabled (42 %
   opacity plus `aria-disabled`), focus (the ring), busy (label kept, indicator added), selected.
8. **Motion is functional and tokenised** (§4.8): step transitions, sheet presentation, progress,
   the success moment. Nothing loops, nothing decorative, all of it collapses under reduced motion.
9. **Status is icon plus word**, issues only (EXPERIENCE §7); healthy is quiet text.
10. **Buttons:** one primary per region; primary last (right on desktop and web, bottom on phones);
    side by side when two fit, full width stacked when not, never mixed widths (PORTAL §8).
11. **Copy:** sentence case, no raw codes or slugs, no spec references, "Try again" not "Retry",
    the verb and object on confirms (EXPERIENCE §2).
12. **Mono only for keys, codes, versions and hashes** (BRAND §4.6); tabular figures for counts and
    progress.

### 1.6 Marks

- Kit screens show **no Polaris Key mark**. The Pinned K appears only inside the optional Powered-by
  line or badge; the Star Cut does not appear in SDK UI at all. This supersedes BRAND §7.1's two
  "SDK UI" rows (§9).
- The Powered-by line is `<Pinned K at 13–14 px, favicon or service cut> Powered by Polaris Key` in
  `text-subtle` at 12 px, or the kit's compact badge at its 232 × 88 minimum (BRAND §1.5) on About
  screens. Off by default. It sits at the foot of settings, about and credits screens only, never on
  the gate's first screen.

---

## 2. Tokens in every kit

### 2.1 Generated, never hand-copied

`packages/brand/scripts/gen.ts` already writes `tokens.json`, `css/tokens.css`, `css/theme.css`,
TypeScript, `PKeyBrand` (GDScript), `PolarisBrand` (Swift) and `PolarisBrandTokens` (Kotlin). It
grows two layers and four targets:

1. **Kit component tokens** (`packages/brand/src/tokens/kit.ts`, new): the measures this spec fixes,
   per platform variant: `controlHeight` (web 48, compact 36; iOS 52; Android 56; Godot 60),
   `radius.control` (web 12, iOS capsule, Android full, Godot 16, Windows 8), `radius.card` (web 22,
   iOS sheet 40/48 floating, Android 28 sheet, Godot 28), `radius.tile` (`xl` 18), `space.cardPad`,
   `focus.width` (2; Godot and TV 3) and `focus.offset` (2; Godot 4), `scrim` per theme, the
   `highlight` inner edge per theme, and the motion mapping per platform (§4.8).
2. **New targets:**

| Target                  | File (generated)                                                                             | Consumer                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CSS (exists) + kit vars | `packages/brand/css/kit.css` (`--pk-kit-*`)                                                  | React, elements, Vue, Svelte, Angular, Electron, Tauri |
| JS objects              | `packages/brand/src/generated/kit.ts`                                                        | ui-core theme resolver, React Native                   |
| Swift (exists) + kit    | `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift` + `KitTokens.generated.swift`  | SwiftUI, UIKit, AppKit                                 |
| Kotlin (exists) + kit   | `sdks/kotlin/ui/src/commonMain/.../PolarisKitTokens.generated.kt`                            | Compose (all targets), Views interop                   |
| Godot (exists) + themes | `PKeyBrand` + `pkey_brand_{dark,light}.tres` + `ui/theme/icons/*.svg` (engine control icons) | Godot kit                                              |
| **Python (new)**        | `sdks/python/src/polaris_key/ui/_tokens.py`, `qt/polaris_{dark,light}.qss`, `tk/theme.tcl`   | Qt, Tk, rich/Textual                                   |
| **Terminal (new)**      | `packages/sdk-node/src/cli/tokens.generated.ts`, `polaris_key/ui/ansi.py`                    | Node and Python CLIs (truecolor + ANSI-16)             |
| **C# (new)**            | `sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs`                                | Godot .NET facade                                      |

3. **Fonts per platform:** WOFF2 for the web (exists), the kit's TTFs for Swift (exists), Compose
   Resources fonts for KMP (moves from Android `R.font`), Godot `FontFile`s (exist), and TTFs with
   `OFL.txt` in the Python wheel (`polaris_key/ui/fonts/`). Every web kit **loads Rubik itself**
   (an `@font-face` in the elements stylesheet and `@polaris-key/react/styles.css`), so a bare page
   never renders the kit in Times (RE). Rubik has no CJK, Arabic, Hebrew or Devanagari: each kit
   documents and sets a fallback chain to the system face for those scripts.

### 2.2 The drift gate

`pnpm gen:brand -- --check` covers every file above; the Python, Kotlin, Swift and Godot suites each
add one test that the committed generated file matches what the generator would write (the pattern
`BrandThemeTests` and the Godot `brand` suite already use). A kit test fails on a raw colour literal
outside the generated files (Compose's `BrandRulesTest` pattern, ported to every kit as
`polaris-lint: allow-colour` escapes).

---

## 3. One theme API

### 3.1 The shape

Every kit exposes one theme value with the same field names, cased for the language
(`colorScheme`, `color_scheme`). Everything is optional; an empty theme is the Polaris Key look.

| Field         | Type                                                                      | Default                    | Meaning                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`      | `"polaris-key"` · `"native"`                                              | `"polaris-key"`            | The base look (§3.4)                                                                                                                    |
| `colorScheme` | `"system"` · `"dark"` · `"light"`                                         | `"system"`                 | Follows the OS live; dark when the OS has no preference                                                                                 |
| `accent`      | `"product"` · `"core"` · `"service"` · a colour                           | `"product"`                | §1.2; a colour is resolved for contrast (§3.3)                                                                                          |
| `colors`      | partial map of semantic roles (`surfacePage`, `textStrong`, `danger`, …)  | none                       | Per-role overrides, per scheme (`colors.dark`, `colors.light`)                                                                          |
| `radius`      | `"sm"` · `"md"` · `"lg"` · a number (control radius; cards scale from it) | `"md"`                     | `sm` = 6/10, `md` = 12/22, `lg` = 16/28 (control/card, web)                                                                             |
| `typography`  | `{ family, monoFamily, scale }`                                           | Rubik, platform mono, 1.0  | `family: "system"` uses the platform face; `scale` multiplies on top of Dynamic Type / font scale                                       |
| `density`     | `"compact"` · `"comfortable"` · `"spacious"`                              | `"comfortable"`            | Control height and spacing only, never the component (EXPERIENCE §1.9); Godot and TV default to `spacious`                              |
| `motion`      | `"system"` · `"reduced"` · `"none"`                                       | `"system"`                 | `system` follows the OS reduced-motion setting                                                                                          |
| `ambient`     | boolean                                                                   | `true` (`false` in native) | The product ambient (§1.2)                                                                                                              |
| `product`     | `ProductIdentity`                                                         | from presentation/bundle   | §1.2                                                                                                                                    |
| `copy`        | partial map of copy keys, or a `locale`                                   | the OS locale              | §4.7                                                                                                                                    |
| `poweredBy`   | `false` · `"line"` · `"badge"`                                            | `false`                    | §1.6                                                                                                                                    |
| `platform`    | `"auto"` · `"ios"` · `"android"` · `"macos"` · `"windows"` · `"web"`      | `"auto"`                   | Web kits only: renders the platform variant inside a webview (Electron on Windows gets Fluent radii, Tauri on macOS gets the Mac sheet) |

### 3.2 Where it is set, per kit

| Kit                  | Set it                                                                                                                      | Restyle hooks beyond the theme                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React                | `<PolarisKeyProvider theme={…}>`; `polarisKeyTheme({ … })` helper                                                           | Stable class names `pk-*` and `data-part="title"` etc.; CSS cascade layer `@layer polaris-key` so host CSS wins without `!important`; slots (`slots={{ header, footer }}`) and render props; `--pk-*` vars scoped to the provider element, **never `:root`** (RE) |
| Web components       | `<pk-provider theme='…'>` or `PolarisKey.theme({…})`; `--pk-*` custom properties                                            | `::part(title)`, `::part(primary)`…; named `<slot>`s; `pk-*` DOM events                                                                                                                                                                                           |
| Vue, Svelte, Angular | `providePolarisKey({ theme })` / `setPolarisKeyTheme` / `providePolarisKey({ theme })`                                      | Pass-through of the element parts and slots                                                                                                                                                                                                                       |
| SwiftUI              | `.polarisKeyTheme(PolarisKeyTheme(…))` environment modifier                                                                 | `PolarisKeyStyle` protocols per component (`.activateStyle(.myStyle)`) in the manner of `ButtonStyle`; `@ViewBuilder` slots                                                                                                                                       |
| UIKit / AppKit       | `PolarisKeyUI.theme = …` or per presenter                                                                                   | Subclassable hosting controllers                                                                                                                                                                                                                                  |
| Compose              | `PolarisKeyTheme(theme = PolarisKeyTheme(…)) { }`                                                                           | `ActivateDefaults.colors()/shapes()/…` objects like Material's `ButtonDefaults`; composable slot parameters                                                                                                                                                       |
| Godot                | `PKeyOptions.ui_theme_preset`, `ui_accent`, `ui_radius`, `ui_density`… in `polaris_key.tres`; or `PKeyUiTheme.build(theme)` | Theme type variations (`PKeyTitle`, `PKeyPrimary`, …, full list documented); a per-node `Theme` wins                                                                                                                                                              |
| Qt                   | `polaris_key.ui.qt.apply_theme(app, Theme(…))`                                                                              | Object names (`#pkTitle`, `#pkPrimary`) and dynamic properties for QSS; native `QStyle` under `native`                                                                                                                                                            |
| Terminal             | `PolarisKeyTheme` in the CLI adapter options; env `PKEY_THEME=dark\|light`, `NO_COLOR`                                      | Symbols set (unicode / ascii)                                                                                                                                                                                                                                     |

### 3.3 The accent resolver

One algorithm in `@polaris-key/brand` (`resolveAccent(hex, scheme)`, built on `color.ts`), ported to
Swift, Kotlin, GDScript and Python with shared test vectors: from any input colour it derives
`solid` (≥ 3:1 on every surface), `fg` (≥ 4.5:1), `on` (≥ 4.5:1 on `solid`), `subtle`, and the
`focus` colour, adjusting OKLCH lightness only, in both schemes. When the integrator supplies an
accent, the focus ring takes the resolved accent (one learnable focus signal within the product);
with the core accent it stays the kit violet (BRAND §7.4). Status colours never change with the
accent.

### 3.4 The `native` preset

`preset: "native"` keeps the structure, flows, copy and spacing and hands the look to the host:

- **Web:** inherits the host's font (`font: inherit`) with a sane system fallback, uses
  `canvas`/`canvastext`-based neutrals, the host's accent from `theme.accent` or `accent-color`.
- **SwiftUI / UIKit / AppKit:** system fonts, the app's `.tint`, system colours and materials, stock
  button styles (`.borderedProminent`/`.glassProminent`).
- **Compose:** the host `MaterialTheme` (including dynamic colour); status colours mapped to the host
  scheme's error and a computed warning, not tertiary/primary (KO).
- **Godot:** derives from the ancestor or project theme (today's "neutral" builder, kept and
  polished).
- **Qt:** the platform `QStyle` with only spacing and typography hierarchy applied.

### 3.5 Bring your own design system

No new kits for host design systems; instead the brand package publishes: a **Tailwind v4 preset**
(from `css/theme.css`), **MUI, Mantine and Chakra theme objects** generated from the tokens, a
**shadcn/ui registry** (`npx shadcn add https://key.plrs.im/r/activate.json`) whose components are
built on the React headless hooks, and "go native" recipes that render each screen with host
components over layer (c).

---

## 4. The component catalogue

### 4.1 The set and the names

The same set and names in every kit. Web components prefix `pk-`; Godot prefixes `PKey`; Swift and
Compose use the bare name inside their module (`PolarisKeyUI.Activate`, `im.plrs.key.ui.Activate`);
React exports bare names from `@polaris-key/react`. Headless names follow each language
(`useActivate`, `ActivateModel`, `rememberActivateState`, `PKeyActivateController`,
`ActivateViewModel`).

| Component             | What it is                                                                                                                                                                          | States                                                                                                                        | Priority |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| **PolarisKeyGate**    | The drop-in root. Boots, gates, and runs every flow below as needed; renders the app when licensed; adds the grace banner, update prompt and toasts                                 | booting · needs-activation · licensed · grace · blocked (revoked, expired, version too old/new, channel not entitled) · error | must     |
| **Boot**              | First-paint screen while the stage machine runs (`ui.stages`): product hero, a neutral indicator, consent for metered downloads, offline and blocked stops                          | progress · consent · fetching · offline · blocked · error                                                                     | must     |
| **Welcome**           | The gate's first screen: product hero, Sign in, Use a license key, and the extras the product supports (trial, restore purchase, activate offline)                                  | default · busy · capability-limited (only the paths the build supports, GO)                                                   | must     |
| **SignIn**            | Method chooser: platform-native first (Sign in with Apple, Google on Android), email via the hosted card, Steam, Use another device                                                 | default · busy · method error · no method enabled                                                                             | must     |
| **SignInHandoff**     | "Finish in your browser": the RFC 8628 user code, a QR, Open browser again, the countdown; moves on by itself                                                                       | starting · waiting · link copied · confirm · ok · denied · expired · cancelled                                                | must     |
| **Activate**          | License key entry with live verdict: the key field names the product and tier as soon as it parses, catches cut-short keys (EXPERIENCE P2), paste button, Return submits            | empty · typing · parsed · cut short · busy · rejected · device limit (hands to DeviceLimit) · done                            | must     |
| **OfflineActivation** | Request code (text + QR), load or drop a response file, paste box                                                                                                                   | default · loaded · rejected signature · done                                                                                  | must     |
| **DeviceLimit**       | The focused "remove a device to continue" flow (PORTAL §4.25): seat meter, devices as radio rows, least recent preselected, consequences, "Remove <device> and continue"            | default · busy · removed · failed · browser mode (links to the portal)                                                        | must     |
| **Devices**           | Device list: icon by form factor, friendly name, platform and last seen, "This device", rename (inline, not an always-open form, RE), Remove with an L1 inline confirm              | loading · list · renaming · confirming · empty · browser mode                                                                 | must     |
| **UpdatePrompt**      | Available / downloading / ready / mandatory / blocked / store outlet, with notes and the right verb per outlet ("Update on the App Store", "Restart when ready", "Get it on Steam") | available · downloading · ready · mandatory · blocked · store · platform · revoked-required-content · up to date              | must     |
| **UpdateProgress**    | Compact download and install progress for app updates and content packs: toast, pill, or inline row                                                                                 | queued · downloading · installing · paused (metered) · failed · done                                                          | must     |
| **ReleaseNotes**      | The changelog for one or many versions, from `ReleaseClient.changelog()`                                                                                                            | loading · list · empty · error                                                                                                | must     |
| **StatusScreen**      | Blocking states with their fix: revoked ("Use a different key", "Sign out"), expired ("Renew"), version too old ("Update"), too new, channel not entitled                           | one per state, each with a primary fix                                                                                        | must     |
| **GraceBanner**       | Offline grace: deadline and countdown, Reconnect, dismissible per session (the prop doc already promises it, RE)                                                                    | days left · last day · expired → StatusScreen                                                                                 | must     |
| **AccountAndLicense** | The settings pane: product and tier, holder, Manage (portal), Devices, Cloud Sync status, Updates (automatic, channel, check now, version), managed settings, Sign out, Powered-by  | loading · signed in · key-only (no account) · offline                                                                         | must     |
| **Settings**          | Config-catalog-driven settings with typed controls (switch, slider, select, text), categories, search above 12 rows, provenance as text, locked rows "Set by <org>", reset          | loading · list · dirty · saving · locked · error                                                                              | must     |
| **Paywall**           | Entitlement-gated upsell: what a tier adds, purchase or redeem; StoreKit 2 views on Apple, Play Billing on Android, the portal elsewhere                                            | loading · offers · purchasing · purchased · restore · not available here                                                      | must     |
| **EntitlementGate**   | Renders children only when an entitlement holds; otherwise a slot or the Paywall                                                                                                    | entitled · not entitled · loading                                                                                             | must     |
| **CloudSyncStatus**   | A small status: synced time, syncing, conflict, offline; opens details                                                                                                              | synced · syncing · offline · conflict · error                                                                                 | should   |
| **About**             | Product, version, build, licenses (OSS notices), the Powered-by badge, Copy diagnostics                                                                                             | default                                                                                                                       | should   |
| **ChannelPicker**     | Release channel choice, locked when the outlet fixes it                                                                                                                             | default · locked                                                                                                              | should   |
| **Toast**             | Bottom-right (bottom full width on phones), one line plus a consequence, ≤ 2 actions, 6 s with a visible timer, errors persist (EXPERIENCE §7)                                      | info · success · warning · error · with progress                                                                              | must     |

**Styled parts** shared by the screens, each exported on its own: `ProductHeader`, `KeyField`,
`CodeDisplay` (user code + copy), `QrCode` (forced black on white, with a larger view), `SeatMeter`,
`DeviceRow`, `SettingsRow`, `Banner`, `ProgressBar`, `LoadingIndicator`, `StatusPill`, `PoweredBy`,
`MonogramIcon`.

### 4.2 The one-line flows

```tsx
// React (web, Electron renderer, Tauri webview, Next.js client component)
<PolarisKeyGate product="tidewater">
  <App />
</PolarisKeyGate>
```

```html
<!-- Any web page, Angular, Vue, Svelte, htmx -->
<pk-gate product="tidewater"><my-app></my-app></pk-gate>
```

```swift
// SwiftUI, iOS 17+ / macOS 14+, Liquid Glass on 26
WindowGroup { ContentView().polarisKeyGate(client) }
// macOS: adds the Settings pane and the menu commands
Settings { PolarisKeySettings(client) }
```

```kotlin
// Compose (Android, Desktop)
setContent { PolarisKeyGate(client) { App() } }
```

```gdscript
# Godot: one node, or one call before the main scene
await PolarisKey.boot()
```

```python
# Qt (PySide6 or PyQt6)
from polaris_key.ui.qt import run_gate
run_gate(client, main_window)  # shows the gate until licensed, then main_window
```

```ts
// Electron main + preload: two lines replace the hand-written bridge (RE, GA)
registerPolarisKey({ ipcMain, client }); // main
exposePolarisKey(); // preload
```

The gate fixes today's lifecycle traps: it starts itself (Compose `gate.start()`, KO), never flashes
the sign-in card before the real state loads (SW), and re-renders on background changes from a
`statusStream` (SW "no live updates").

### 4.3 Key components in detail

**Welcome and Activate** ([web](ui-kits/shots/web-gate-dark.png),
[iOS](ui-kits/shots/ios-activate-dark.png), [Android](ui-kits/shots/android-activate-light.png),
[Godot](ui-kits/shots/godot-activate-dark.png)).

- Welcome is product-first: icon at hero size (80 web, 120 iOS, 136 Android cookie, 88 Godot logo
  lockup with the game's wordmark), the product name as the title, one line of lede. Two buttons:
  **Sign in** (primary; hidden when Identity is off) and **Use a license key** (secondary; hidden
  when License keys are off). Extras are quiet links: trial, restore purchase, activate offline.
- The key field is **collapsed behind "Use a license key"** (RE: the always-visible field is heavier
  than the portal's collapsed path). It has a visible label, autocorrect and autocapitalisation off, a paste
  button, submit on Return, and parses as you type: `pkey_<product>_<22>` names the product and tier in a success line ("Tidewater Studio Pro ·
  Lifetime · 3 devices"), a cut-short key gets "This key is cut short. After tidewater\_ come 22
  characters, and this has 10." Errors are inline under the field, `aria-invalid`, announced, and
  cleared on edit.
- Device limit is not an error string: Activate hands off to **DeviceLimit** with the device list
  (RE, SW, KO, GO all lacked this).

**SignIn and SignInHandoff** ([web](ui-kits/shots/web-sign-in-dark.png),
[iOS](ui-kits/shots/ios-sign-in-dark.png), [desktop](ui-kits/shots/desktop-sign-in-dark.png),
[Godot TV](ui-kits/shots/godot-sign-in-dark.png),
[terminal](ui-kits/shots/terminal-sign-in-dark.png)).

- Methods follow PORTAL §4.1's provider rules: Apple whenever the product ships on Apple platforms
  (native `ASAuthorizationAppleIDButton`), Google on Android (Credential Manager), Steam where the
  product sells on Steam, email through the hosted card in `ASWebAuthenticationSession` / Custom Tabs
  / the system browser, and **Use another device** (device code).
- The handoff screen shows the user code large in mono with Copy, the QR beside it on desktop, TV
  and Godot (forced black on white), "Check the code there matches this one", a neutral waiting
  indicator with the countdown, **Open browser again**, Cancel, and moves on by itself.
- TV and consoles (tvOS, Android TV, Godot on console or Steam Deck in game mode) open on the
  device-code path, with `key.plrs.im/tv` spelled out.

**DeviceLimit** ([web](ui-kits/shots/web-device-limit-light.png),
[iOS](ui-kits/shots/ios-device-limit-dark.png),
[Android](ui-kits/shots/android-device-limit-dark.png),
[Godot](ui-kits/shots/godot-device-limit-dark.png),
[terminal](ui-kits/shots/terminal-device-limit-dark.png)).

PORTAL §4.25 in every kit: product header; "Your license is on 3 of 3 devices"; a segmented seat
meter (`role="img"`, labelled); "To use it on <this device>, remove one. You can add it back later.";
devices as radio rows with form-factor icons, friendly names (never `dev-2` or `macos`, RE), platform
and last used; least recent preselected and labelled; one consequence line; **Remove <device> and
continue** as the primary. Browser mode (no device API) links to the portal flow instead.

**UpdatePrompt and UpdateProgress** ([web](ui-kits/shots/web-update-dark.png),
[iOS](ui-kits/shots/ios-update-dark.png), [Android](ui-kits/shots/android-update-light.png),
[desktop](ui-kits/shots/desktop-update-dark.png), [Godot](ui-kits/shots/godot-update-dark.png)).

- Product icon, "<Product> <version>", "You have <current>", three release-note lines and "Release
  notes" for the rest, the download progress inline (bar, bytes, time left, tabular figures), and the
  verb the outlet allows: **Restart when ready** (queues the restart, so the primary is never
  disabled during a download), **Update on the App Store**, **Get it on Steam**, **Reload**.
- Presentation per platform: web and desktop a top-layer dialog with a blurred scrim (not an opaque
  window takeover, RE), iOS a floating sheet, Android a modal bottom sheet with wavy progress (Play
  in-app flexible update), macOS a SwiftUI window driven by a custom Sparkle `SPUUserDriver`, Godot a
  glass modal that waits for the end of a race ("After this race").
- Mandatory updates have no dismiss and say why; non-blocking availability is a toast with the
  product icon, not a full-width 2012 alert bar (GO).
- **UpdateProgress** is its own component for background content packs (the Godot toast in the
  mockup, the Android foreground-service notification, a Live Activity on iOS).

**AccountAndLicense and Settings** ([web](ui-kits/shots/web-settings-light.png),
[iOS](ui-kits/shots/ios-settings-dark.png), [Android](ui-kits/shots/android-settings-dark.png),
[macOS](ui-kits/shots/desktop-settings-dark.png), [Godot](ui-kits/shots/godot-settings-dark.png)).

- Inset grouped rows, label left and control or value right, equal row heights (EXPERIENCE §6), the
  product row first, service cues on group headers (License, Updates, From <Developer>).
- Catalog settings render **typed controls from the catalog schema** (switch for booleans, slider
  or stepper for bounded numbers, select for enums, text otherwise) with catalog labels and help,
  never raw dotted keys or literal `true` (RE). Locked rows show a lock glyph and "Set by <org>" as
  text; provenance is text, not equal-weight chips (GO).
- The pane embeds into the host's own settings (a React component, a SwiftUI `Section` set, a
  Compose `LazyListScope` extension, a Godot `PKeyAccountTab` for a game's tabbed menu, a Qt
  `QWidget`), or opens as a whole page.

### 4.4 Accessibility (every kit)

WCAG 2.2 AA in both themes (BRAND §9) plus:

1. One heading per screen; product name is not the only heading text on focused steps.
2. Visible labels on every field; placeholders never carry information (SW used placeholder only).
3. Errors announced (`aria-live`, `AccessibilityNotification.Announcement`, Compose
   `liveRegion`, Godot AccessKit live regions in 4.5+), focus moved to the error or the panel
   heading.
4. Modals trap focus, restore it on close, close on Escape / B / back where dismissible (RE had
   `aria-modal` only). The background is `inert`.
5. Dynamic Type / font scale to the largest accessibility size without clipping (layouts stack, as
   Compose's 200 % test already checks); `forced-colors` on the web.
6. Gamepad, D-pad and keyboard reach everything, with the focus ring always visible (Godot already
   does; Compose TV, tvOS and Qt gain it).
7. Every icon-only control is named; QR codes are described and paired with the text code.
8. Status never by colour alone; seat meters carry a text label.

### 4.5 Powered by

`poweredBy: "line"` adds the 12 px line at the foot of AccountAndLicense and About; `"badge"` adds the
compact badge at its minimum on About. Off by default in every kit and in both presets.

### 4.6 States and copy are data

Each component's states and the copy key for every visible string are listed once in
`packages/brand/kit-copy/` (new, §4.7) and in the conformance fixtures (§5.2). A kit cannot add a
state without the fixture; a fixture without a kit render fails visual QA (§7).

### 4.7 Internationalisation

- **One ICU MessageFormat catalog**, `packages/brand/kit-copy/en.json`, holds every kit string
  (about 220 keys: today's React copy bag, PolarisCopy in Swift and Kotlin, PKeyUiCopy in Godot,
  plus the strings each audit found hard-coded outside them: error descriptions, accessibility hints,
  "Something went wrong", "Working", "(allowed: x – y)", the busy glyph).
- Generated per platform: JSON for web kits, `Localizable.xcstrings` (String Catalog) for Swift,
  Compose Resources `strings.xml` with plurals for Kotlin, gettext `.po`/`.pot` for Godot and Python,
  ANSI-safe tables for the terminal. Plurals and selects use ICU (`{count, plural, one {# device}
other {# devices}}`), never string concatenation (SW, KO).
- **Launch locales:** English plus German, French, Spanish, Brazilian Portuguese, Italian, Japanese,
  Korean, Simplified Chinese and Arabic (owner to confirm, §11). Arabic forces the **RTL** pass:
  mirrored layouts, RTL snapshot variants in every kit (none exist today).
- Dates, durations and byte counts use the platform formatters with the active locale ("3 days
  left", "Synced 2 min ago", "38 of 61 MB").
- Platform words come from the platform: "this iPhone", "this Mac", "this device", never a
  hard-coded "this Mac" (SW).
- `copy` overrides take partial maps per locale and fall back key by key.

### 4.8 Motion

| Change                     | Web / desktop                                    | iOS / macOS                                 | Android                               | Godot                        |
| -------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------------------- | ---------------------------- |
| Step to step inside a flow | View Transition, cross-fade + 8 px slide, `base` | `.contentTransition` / `.transition(.push)` | `AnimatedContent` with `MotionScheme` | Tween fade + slide, 200 ms   |
| Sheet or dialog in         | `slow`, `ease-enter`, scale 0.98 → 1             | system sheet springs                        | system bottom sheet                   | Tween 320 ms                 |
| Press                      | scale 0.98, `fast`                               | system                                      | shape morph (M3E)                     | scale 1.02 focus, 0.98 press |
| Progress                   | width with `base`                                | system                                      | wavy indicator                        | Tween                        |
| Success ("It's yours")     | one check draw, `slow`                           | `.symbolEffect(.bounce)` once               | one shape morph                       | one Tween                    |

`motion: "system"` follows `prefers-reduced-motion`, `accessibilityReduceMotion`,
`Settings.Global.ANIMATOR_DURATION_SCALE`, and a Godot `ui_reduce_motion` option. Reduced motion
replaces movement with opacity at `fast`; `"none"` removes it. The star never animates (BRAND §7.5).

---

## 5. Frameworks and architecture

### 5.1 The matrix

**must** ships in the first release of the parity pass; **should** follows; **could** is recipes,
thin adapters or demand-driven.

| Language / SDK | Framework                                                       | Priority | Architecture                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS / TS        | **ui-core** (framework-neutral view models, theme, copy)        | must     | `@polaris-key/ui-core` on `client-core`: the state machines of §4, the error → copy mapping, the theme resolver; grows from `@polaris-key/react/core`                                                 |
| JS / TS        | **Web Components**                                              | must     | `@polaris-key/elements`, Lit 3 over ui-core; shadow DOM, `::part`, slots, `--pk-*` vars, DOM events; the universal fallback                                                                           |
| JS / TS        | **React** (web, Electron renderer, Tauri, Next.js)              | must     | `@polaris-key/react` rebuilt on ui-core: native React components (not wrappers) styled by `styles.css` in `@layer polaris-key`; `"use client"` boundaries; React 18 and 19 in CI                      |
| JS / TS        | **Electron** (main + preload)                                   | must     | `@polaris-key/electron`: `registerPolarisKey` (main, wraps `@polaris-key/node`) and `exposePolarisKey` (preload, `contextBridge`); native menu items and notifications                                |
| JS / TS        | Vue 3 / Nuxt                                                    | should   | `@polaris-key/vue`: composables over ui-core plus typed wrappers over the elements; a Nuxt module                                                                                                     |
| JS / TS        | Svelte 5 / SvelteKit                                            | should   | `@polaris-key/svelte`: rune stores over ui-core plus typed element wrappers                                                                                                                           |
| JS / TS        | Angular                                                         | should   | `@polaris-key/angular`: a signals service and standalone components wrapping the elements                                                                                                             |
| JS / TS        | React Native / Expo                                             | should   | `@polaris-key/react-native`: the React hooks over ui-core, screens in RN primitives, platform-adaptive (glass on iOS 26, M3E on Android), a native module over the Swift and Kotlin SDKs              |
| JS / TS        | Tauri v2                                                        | should   | `tauri-plugin-polaris-key` (Rust, a `@polaris-key/node` sidecar first) implementing the bridge over `invoke`; the web kits render unchanged                                                           |
| JS / TS        | Host design systems (Tailwind v4, shadcn, MUI, Mantine, Chakra) | should   | §3.5: presets, theme objects and a shadcn registry, no new kits                                                                                                                                       |
| JS / TS        | SolidJS, Preact, Qwik, htmx and plain pages                     | could    | Recipes over the elements (Preact can also use React via compat)                                                                                                                                      |
| Swift          | **SwiftUI iOS / iPadOS 26** (iOS 17 floor)                      | must     | `PolarisKeyUI` rebuilt: `@Observable` models over a pure-Swift presentation core, public composable views, `.polarisKeyGate`, glass on 26                                                             |
| Swift          | **SwiftUI macOS 26** (macOS 14 floor)                           | must     | Same kit plus Settings scene, `CommandGroup`s, sheets, a SwiftUI Sparkle user driver                                                                                                                  |
| Swift          | UIKit (and Mac Catalyst)                                        | should   | `PolarisKeyUIKit`: `PolarisKeyGateViewController`, `presentIfNeeded(from:client:)`, embeddable banner and status views; no second implementation                                                      |
| Swift          | AppKit                                                          | should   | `PolarisKeyAppKit`: `beginGateSheet(for:)`, a Preferences `NSViewController`, the Sparkle bridge                                                                                                      |
| Swift          | StoreKit 2 views                                                | should   | `Paywall` wraps `SubscriptionStoreView` / `StoreView` with the theme and entitlement mapping (`PolarisKeyPlatform` StoreService)                                                                      |
| Swift          | visionOS                                                        | should   | Glass windows, ornaments for banners, hover effects; declare `.visionOS`, CI                                                                                                                          |
| Swift          | tvOS                                                            | should   | Focus-engine layouts, device-code first; fix `systemGroupedBackground` (SW); declare `.tvOS`, CI                                                                                                      |
| Swift          | watchOS                                                         | could    | Status glance and companion sign-in; first fix Core's 64-bit literal overflow (SW)                                                                                                                    |
| Swift          | WidgetKit, Live Activities, App Intents                         | could    | Update progress Live Activity, license widget, "Check for updates" intent                                                                                                                             |
| Kotlin         | **Compose Multiplatform: Android** (M3 Expressive)              | must     | `:ui` becomes a KMP module (`commonMain` composables and states, `androidMain`); Material3 with Expressive on a version line decoupled from the Godot template pins (KO)                              |
| Kotlin         | **Compose Multiplatform: Desktop JVM**                          | must     | `desktopMain`: real windows for dialogs, keyboard focus rings, desktop density, Windows/macOS/Linux                                                                                                   |
| Kotlin         | Android Views (XML, Fragments)                                  | should   | `PolarisKeyActivity` (ActivityResultContract), `PolarisKeyFragment`s, `ComposeView`-based XML views; also serves the Godot Android plugin                                                             |
| Kotlin         | Android TV, Glance, notifications                               | could    | TV focus and device-code first; a Glance license/update widget; foreground-service pack progress                                                                                                      |
| Godot          | **Control nodes (GDScript)**                                    | must     | The existing kit modernised in place on its controllers (§1.4, GO), plus the missing scenes and a `PKeySheet` host with a scrim                                                                       |
| Godot          | Godot .NET (C#)                                                 | should   | A typed C# facade over the same scenes: generated wrappers, typed signals, options records                                                                                                            |
| Godot          | Editor dock restyle; web-export overlay                         | could    | Brand-aligned setup dock that respects the editor theme; elements for sign-in and paywall on HTML5 exports via `JavaScriptBridge`                                                                     |
| Python         | **ui-core**                                                     | must     | `polaris_key.ui.core`: view models over `stages.py` and `get_sync_state()`, with a thread-marshalling hook (GA)                                                                                       |
| Python         | **Qt** (PySide6 primary, PyQt6 via qtpy)                        | must     | `polaris_key.ui.qt` QWidget screens (optional QML), generated QSS, bundled Rubik TTF, Qt Linguist from the catalog, `QAccessible` names, signals marshal `on_change`                                  |
| Python         | **Terminal** (rich, Textual)                                    | must     | The CLI core restyled with rich (palette, rails, spinners, progress, terminal QR, masked key), `--json` on every verb; optional Textual app                                                           |
| Python         | Tkinter (ttk)                                                   | should   | A generated ttk theme; gate, activation, device limit and update prompt; `tk.after` marshalling                                                                                                       |
| Python         | wxPython, Kivy, web UIs (NiceGUI, Gradio, Flet)                 | could    | Thin adapters over ui-core, or the elements embedded                                                                                                                                                  |
| Node           | **Terminal** (CLI prompts)                                      | must     | `@polaris-key/node` CLI and `pkey` restyled (`util.styleText`, `NO_COLOR`, isatty), clack-style prompts with masked key entry, spinners, progress, terminal QR, `--json`, grouped help and completion |
| Node           | Ink                                                             | could    | `@polaris-key/node/ink` components over the same commands and stage core                                                                                                                              |

### 5.2 One state machine, conformance-pinned

- The presentation state machines are specified once as **`conformance/corpus/v2/ui/` fixtures**
  (new): each case gives the inputs (license status, capabilities, decision, device list, error code)
  and the expected component, state and copy keys. ui-core, the Swift presentation core, the Kotlin
  `commonMain` states, the Godot controllers and Python ui-core each run them in their own test
  suite. This needs no wire change: the inputs are existing SDK results.
- **Parity:** `conformance/parity/features.json` gains `ui.gate`, `ui.activate`, `ui.signin`,
  `ui.deviceLimit`, `ui.devices`, `ui.update`, `ui.settings`, `ui.paywall`, `ui.theme` and
  `ui.i18n`, each proven by `{ "kind": "snapshot" }` plus the fixture run. The `headless` NA on
  `ui.kit` is removed for Python and Node: their kits are Qt and the terminal (Python), Electron and
  the terminal (Node), so `sdks/python/parity.json` and `packages/sdk-node/parity.json` must record
  real proofs (GA).
- **Threading:** every core exposes a "deliver on the UI thread" hook (Qt signal, `tk.after`,
  `MainActor`, `Dispatchers.Main`, Godot `call_deferred`), so hosts never meet the Python daemon
  thread problem (GA).

### 5.3 Packaging

- Web: `@polaris-key/ui-core`, `@polaris-key/elements` (also as a single CDN ES module), framework
  packages with subpath exports per component and `sideEffects` limited to the stylesheet.
- Swift: `PolarisKeyUI` (SwiftUI), `PolarisKeyUIKit`, `PolarisKeyAppKit` products in the one package;
  `Package.swift` declares iOS, macOS, visionOS, tvOS (watchOS after the Core fix).
- Kotlin: `im.plrs.key:polaris-key-ui` (KMP: android, desktop), `polaris-key-ui-views`; ZXing and
  Rubik split into `polaris-key-ui-brand` so `native` hosts do not ship them (KO).
- Godot: the addon; the C# facade as an optional folder and NuGet package.
- Python: extras `polaris-key[qt]`, `[tk]`, `[cli]` (rich), `[tui]` (Textual).

---

## 6. Samples and docs

### 6.1 A sample per kit

Each must and should kit ships a runnable sample under `examples/ui/<kit>/` with the Tidewater-style
fixture product, wired to the test fixture adapters so it runs without a live Worker, plus a
`--live` switch:

| Kit                  | Sample                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| React                | Vite app (whole flow) + Next.js App Router app (`"use client"` boundary, settings page)                  |
| Elements             | One static HTML page using the CDN module; an htmx page                                                  |
| Electron             | Electron Forge app using `registerPolarisKey`/`exposePolarisKey` and the React kit                       |
| Tauri                | Tauri v2 app with the plugin and the elements                                                            |
| Vue, Svelte, Angular | Nuxt, SvelteKit and Angular standalone apps                                                              |
| React Native         | Expo app (iOS and Android)                                                                               |
| SwiftUI              | One Xcode project: iOS, iPadOS, macOS, visionOS, tvOS targets; a gallery of every state                  |
| UIKit / AppKit       | Storyboard-free UIKit app; AppKit document app                                                           |
| Compose              | Android app (gate, settings, adaptive layouts) and a Compose Desktop app                                 |
| Android Views        | XML app using `PolarisKeyActivity`                                                                       |
| Godot                | The addon's demo project: a title screen, a settings menu with the Account tab, a pack download; C# twin |
| Qt / Tk              | PySide6 app; Tkinter app                                                                                 |
| Terminal             | `tidewater` demo CLI in Node and Python                                                                  |

### 6.2 Docs

- A new **docs site section** `packages/docs/src/content/docs/build/ui/`: an overview (the three
  layers, the look, product identity), **Theming** (the §3 table with one tab per kit), **Components**
  (one page per §4.1 component: states, screenshots in both themes from the visual QA baselines,
  props/parameters per kit, copy keys, accessibility notes), **Frameworks** (one page per §5.1 row
  with install, the one-line flow, piecemeal use, headless use), **Localisation** and **Recipes**
  (Next.js, Nuxt, shadcn, Tailwind, MUI, "go native" per platform). The existing `build/sdks/*.mdx`
  pages link into it; `kotlin-ui.mdx` becomes the Compose page.
- The component pages embed the baseline PNGs, so the docs cannot drift from what ships. Adding a
  page means its route and the docs drift gates (AGENTS rules 9–10) run.
- Each kit README shrinks to install + one-line flow + a link.
- Interactive previews: Storybook for React and elements (deployed with the docs), SwiftUI `#Preview`
  with public `PolarisKeyPreviewState`s (SW: the previewable surface is internal today), Compose
  `@Preview`s, the Godot demo scene.

---

## 7. Visual QA

### 7.1 Baselines per kit, both themes

Every component × state in the fixtures (§5.2) is rendered in **dark and light**, at the platform's
sizes, and compared with a committed baseline:

| Kit                                   | Tool                                                                 | Variants                                                                                   | Baselines                                                             |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| React, elements, Vue, Svelte, Angular | Playwright component tests (Chromium, WebKit)                        | 1440 and 390 px; dark, light; `polaris-key` and `native`; RTL; `forced-colors` (dark only) | `packages/<kit>/test/visual/__screenshots__/`                         |
| SwiftUI, UIKit, AppKit                | swift-snapshot-testing on iOS 26 and macOS 26 simulators/hosts       | iPhone, iPad, Mac; dark, light; AX3 Dynamic Type; RTL; iOS 18 fallback                     | `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`           |
| Compose                               | Roborazzi (exists, 136 baselines) + Compose Desktop screenshot tests | phone, tablet, desktop; dark, light; 200 % font; RTL; native preset                        | `sdks/kotlin/ui/src/test/snapshots/`                                  |
| Godot                                 | `tools/ui_screenshots.gd` (exists) promoted to a compared suite      | 1280×720, 1920×1080, 720×1280; dark, light; native                                         | `sdks/godot/tests/ui/snapshots/`                                      |
| Qt, Tk                                | pytest-qt `grab()` / Tk `PhotoImage` export, offscreen               | dark, light; native                                                                        | `sdks/python/tests/ui/snapshots/`                                     |
| Terminal                              | Golden ANSI text + an SVG render (both CLIs)                         | truecolor, ANSI-16, `NO_COLOR`                                                             | `packages/sdk-node/test/cli/golden/`, `sdks/python/tests/cli/golden/` |

The fixture inputs are shared, so the same state is captured in every kit; a report page
(`pnpm ui:report`) lays the kits side by side per state for review.

### 7.2 Gates

- A changed baseline fails CI until re-recorded in the same change with the reason in the commit.
- axe (web), `AccessibilityTest` (Compose), XCTest accessibility audits (`performAccessibilityAudit`,
  iOS 17+), Godot focus-chain tests and contrast checks run on the same renders.
- The visual QA job runs per kit in that kit's existing CI lane; nothing joins the JS green gate
  except the JS kits.

### 7.3 The modernity lint

A small rule set run on the web kits' DOM and, where practical, on the other kits' view trees,
encoding §1.5: no element with a border wider than 1 px; no `font-family` other than the theme's; no
text below 12 px; no `text-transform: uppercase` on buttons; touch targets ≥ 44 px on touch variants;
no `alert`/`confirm` calls; every interactive element has hover, active, disabled and focus-visible
styles; no colour literal outside the generated tokens; one primary per region. Each kit adds its
equivalent (SwiftUI: no `.buttonBorderShape(.roundedRectangle)` override on iOS 26; Godot: every
engine control icon set by the brand theme; Compose: no `Icons.Filled` from the legacy set).

### 7.4 Design review

Each must kit's first full baseline set is reviewed against this document's mockups by a designer
(or the lead with the role agents) before release; the review notes go in the PR.

---

## 8. Mockups

HTML mockups of the key components in the Polaris look, rendered from the generated tokens
(`packages/brand/css/tokens.css`, Rubik from `packages/brand/fonts/`):

- Sources: `docs/design/ui-kits/{web,ios,android,desktop,godot,terminal}.html`, with `shared.css`
  (the kit primitives, mapping §3 onto `--kit-*` vars) and `shared.js` (icons, fake QR, product art).
- Render: `NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs`, which writes
  every `[data-shot]` to `docs/design/ui-kits/shots/<board>-<shot>-<theme>.png` in both themes. The
  committed PNGs are downscaled and palette-quantised.
- The fixture products are fictional: **Tidewater Studio** by Harbor Audio (web, iOS, Android,
  desktop, terminal; core violet accent, i.e. the default) and **Drift Kart** by Lanternworks (Godot;
  a product accent, `#ff6a3d`, showing §3.3).

**Web** (React and elements). The theming board shows one component under four themes: the default,
a product accent, compact density with a smaller radius, and the native preset.

| Dark                                                     | Light                                                     |
| -------------------------------------------------------- | --------------------------------------------------------- |
| ![Gate](ui-kits/shots/web-gate-dark.png)                 | ![Gate](ui-kits/shots/web-gate-light.png)                 |
| ![Activate](ui-kits/shots/web-activate-dark.png)         | ![Activate](ui-kits/shots/web-activate-light.png)         |
| ![Sign in](ui-kits/shots/web-sign-in-dark.png)           | ![Sign in](ui-kits/shots/web-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/web-device-limit-dark.png) | ![Device limit](ui-kits/shots/web-device-limit-light.png) |
| ![Update](ui-kits/shots/web-update-dark.png)             | ![Update](ui-kits/shots/web-update-light.png)             |
| ![Settings](ui-kits/shots/web-settings-dark.png)         | ![Settings](ui-kits/shots/web-settings-light.png)         |
| ![Theming](ui-kits/shots/web-theming-dark.png)           | ![Theming](ui-kits/shots/web-theming-light.png)           |

**iOS 26** (SwiftUI, Liquid Glass): gate, activate sheet with keyboard, sign-in method sheet,
device limit, floating update sheet, account settings.

| Gate                                  | Activate                                  | Sign in                                  | Device limit                                  | Update                                  | Settings                                  |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------- | --------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| ![](ui-kits/shots/ios-gate-dark.png)  | ![](ui-kits/shots/ios-activate-dark.png)  | ![](ui-kits/shots/ios-sign-in-dark.png)  | ![](ui-kits/shots/ios-device-limit-dark.png)  | ![](ui-kits/shots/ios-update-dark.png)  | ![](ui-kits/shots/ios-settings-dark.png)  |
| ![](ui-kits/shots/ios-gate-light.png) | ![](ui-kits/shots/ios-activate-light.png) | ![](ui-kits/shots/ios-sign-in-light.png) | ![](ui-kits/shots/ios-device-limit-light.png) | ![](ui-kits/shots/ios-update-light.png) | ![](ui-kits/shots/ios-settings-light.png) |

**Android** (Compose, Material 3 Expressive): Cookie-shaped product icon, 56 dp pill buttons,
contained loading indicator, connected lists, a modal bottom sheet with wavy progress and a
connected button group.

| Gate                                      | Activate                                      | Sign in                                      | Device limit                                      | Update                                      | Settings                                      |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/android-gate-dark.png)  | ![](ui-kits/shots/android-activate-dark.png)  | ![](ui-kits/shots/android-sign-in-dark.png)  | ![](ui-kits/shots/android-device-limit-dark.png)  | ![](ui-kits/shots/android-update-dark.png)  | ![](ui-kits/shots/android-settings-dark.png)  |
| ![](ui-kits/shots/android-gate-light.png) | ![](ui-kits/shots/android-activate-light.png) | ![](ui-kits/shots/android-sign-in-light.png) | ![](ui-kits/shots/android-device-limit-light.png) | ![](ui-kits/shots/android-update-light.png) | ![](ui-kits/shots/android-settings-light.png) |

**Desktop** (macOS 26 chrome; the same layouts serve Electron, Tauri, Compose Desktop and Qt):
split hero window, sheets, the update window that replaces Sparkle's stock UI, a Settings window.

| Dark                                                         | Light                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| ![Gate](ui-kits/shots/desktop-gate-dark.png)                 | ![Gate](ui-kits/shots/desktop-gate-light.png)                 |
| ![Activate](ui-kits/shots/desktop-activate-dark.png)         | ![Activate](ui-kits/shots/desktop-activate-light.png)         |
| ![Sign in](ui-kits/shots/desktop-sign-in-dark.png)           | ![Sign in](ui-kits/shots/desktop-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/desktop-device-limit-dark.png) | ![Device limit](ui-kits/shots/desktop-device-limit-light.png) |
| ![Update](ui-kits/shots/desktop-update-dark.png)             | ![Update](ui-kits/shots/desktop-update-light.png)             |
| ![Settings](ui-kits/shots/desktop-settings-dark.png)         | ![Settings](ui-kits/shots/desktop-settings-light.png)         |

**Godot** (Control nodes, 1280 × 720, gamepad): glass panels over the game, the focused control
ringed and scaled, input hints on a plate, a device-code sign-in built for a TV, a content-pack
toast, and an Account tab inside the game's own menu.

| Dark                                                       | Light                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| ![Gate](ui-kits/shots/godot-gate-dark.png)                 | ![Gate](ui-kits/shots/godot-gate-light.png)                 |
| ![Activate](ui-kits/shots/godot-activate-dark.png)         | ![Activate](ui-kits/shots/godot-activate-light.png)         |
| ![Sign in](ui-kits/shots/godot-sign-in-dark.png)           | ![Sign in](ui-kits/shots/godot-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/godot-device-limit-dark.png) | ![Device limit](ui-kits/shots/godot-device-limit-light.png) |
| ![Update](ui-kits/shots/godot-update-dark.png)             | ![Update](ui-kits/shots/godot-update-light.png)             |
| ![Settings](ui-kits/shots/godot-settings-dark.png)         | ![Settings](ui-kits/shots/godot-settings-light.png)         |

**Terminal** (Node and Python CLIs): device-code sign-in with a terminal QR, the device-limit
picker, status and update progress.

| Dark                                                          | Light                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Sign in](ui-kits/shots/terminal-sign-in-dark.png)           | ![Sign in](ui-kits/shots/terminal-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/terminal-device-limit-dark.png) | ![Device limit](ui-kits/shots/terminal-device-limit-light.png) |
| ![Update](ui-kits/shots/terminal-update-dark.png)             | ![Update](ui-kits/shots/terminal-update-light.png)             |

**Mockup review notes** (what the render pass caught and fixed before commit): an app icon that
stretched to its grid cell on the desktop hero; a shadowed helper that dropped every icon and QR on
the Godot board; an update dialog whose action row overflowed its padding; a settings pane that
clipped its last group; low-contrast gamepad hints over the light road art (now on a plate); and a
disclosure chevron that sat beside its label instead of at the row end.

---

## 9. What this supersedes

When this spec is accepted, the same change that starts UK-01 updates:

- **BRAND.md §12.1** "SDK UI: branding is the integrator's choice" → replaced by a pointer here: the
  Polaris Key look is the default; `native` is the opt-out preset; Powered-by stays optional.
- **BRAND.md owner decisions (2026-10-04)**, the bullets "SDK UI is native by default; Polaris Key
  branding is opt-in" and "React: SDK UI branding is optional": marked superseded (2026-10-05) with
  a link here. The "Every SDK UI view is centred and polished" bullet stays and is extended by §1.5.
- **BRAND.md §7.1**, the rows "SDK UI (gate, activation, sign-in): Pinned K" and "SDK updater UI:
  Star Cut": replaced by §1.6 (no Polaris mark in kit screens; the product's identity instead).
- **BRAND.md §12**, the Godot and SwiftUI bullets: "neutral" and "native by default" wording.
- Kit code and docs that encode the old default, each changed in its kit's build item: React
  `theme.ts`, README, `test/theme.test.tsx`; Swift `PolarisBranding.swift`, `PolarisTheme.swift`,
  README, `BrandThemeTests`; Kotlin `PolarisTheme.kt`, `neutralFallback()`, README, POM description,
  `BrandingTest`/`BrandRulesTest`, snapshot names; Godot `options.gd` (`ui_branding := "none"`),
  `PKeyUiTheme`, README, `tools/ui_screenshots.gd`, the `brand` suite; `parity.json` `ui.kit`
  wording in every SDK.

---

## 10. Build plan

One build item per (SDK, framework) kit, ordered must → should → could. Every item ships: the kit's
components to §4 with all three layers, the theme API (§3), copy from the catalog (§4.7), motion
(§4.8), the sample (§6.1), its docs pages (§6.2), and its visual QA baselines in both themes (§7).
Dependencies are noted in each scope; UK-01 to UK-03 come first because every kit reads them.

**Wire impact.** None of the items changes the wire: kits consume existing SDK results. Two items
touch shared contracts and must go through plan mode (CLAUDE.md): UK-02 (new conformance fixtures
and new `features.json` parity rows, with every SDK's `parity.json` following) and, if the owner
approves §11 Q1, a product-presentation `accent` field (a catalog and portal API change, an
all-languages event).

### must

| Id    | SDK    | Framework                          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UK-01 | brand  | Tokens for every kit               | `kit.ts` component tokens; new targets (CSS `kit.css`, JS, Python `_tokens.py` + QSS + ttk, ANSI for Node and Python, C#); Compose Resources fonts; Rubik TTFs for Python; `resolveAccent` with shared vectors; drift gate over all outputs; BRAND.md §7.1/§12/§12.1 and owner-decision updates (§9)                                                                                                                                                                                       |
| UK-02 | shared | Copy catalog, fixtures, parity     | `packages/brand/kit-copy/` ICU catalog (~220 keys) with generators for JSON, xcstrings, Compose Resources, gettext, terminal; launch locale packs; `conformance/corpus/v2/ui/` state fixtures; `features.json` `ui.*` rows; remove the headless NA for Python and Node (plan mode)                                                                                                                                                                                                         |
| UK-03 | js     | ui-core                            | `@polaris-key/ui-core`: §4 state machines and actions over `client-core`, error → copy keys, theme resolution (preset, accent, scheme, density, motion), product identity resolution, the fixture runner; grows from `@polaris-key/react/core`                                                                                                                                                                                                                                             |
| UK-04 | js     | Web Components (Lit)               | `@polaris-key/elements`: every §4.1 component as `pk-*`, `::part`/slots/events, `@font-face` for Rubik, native `<dialog>` + scrim, View Transitions, platform variants, CDN build; Playwright baselines; static and htmx samples                                                                                                                                                                                                                                                           |
| UK-05 | js     | React                              | Rebuild `@polaris-key/react` on ui-core: Polaris look by default, class/`data-part` styling in `@layer polaris-key` (states, motion), scoped vars (no `:root` writes), `<PolarisKeyGate>` one-liner, every missing screen (device limit, handoff, progress, paywall, release notes, account, about, sync, toast, typed settings), `"use client"`, React 19 in CI, Vite + Next.js samples                                                                                                   |
| UK-06 | js     | Electron                           | `@polaris-key/electron`: `registerPolarisKey` (main, over `@polaris-key/node`), `exposePolarisKey` (preload), invoke routes for bridge v3, menu items, notifications, autoUpdater progress into UpdateProgress; Forge sample                                                                                                                                                                                                                                                               |
| UK-07 | swift  | SwiftUI iOS / iPadOS 26            | Rebuild `PolarisKeyUI`: pure-Swift presentation core running the fixtures, `@Observable` models with a status stream (no flash of wrong state, live updates), public components, `.polarisKeyGate`, glass on 26 with the iOS 17 fallback, capsule controls, sheets, String Catalog, typed errors, `#Preview` states, swift-snapshot-testing baselines; fixes "this Mac" copy                                                                                                               |
| UK-08 | swift  | SwiftUI macOS 26                   | Settings scene pane, `CommandGroup`s (Check for Updates…, Manage License…, About), sheets instead of window takeovers, SwiftUI `SPUUserDriver` for Sparkle, the inactive-window prominent-button fix (no forced foreground), Mac baselines                                                                                                                                                                                                                                                 |
| UK-09 | kotlin | Compose Multiplatform: Android     | `:ui` to KMP (`commonMain` + `androidMain`) on a version line decoupled from the Godot template pins; Material 3 Expressive (MotionScheme, LoadingIndicator, button groups, shapes, wavy progress), Material Symbols Rounded, adaptive layouts, `rememberPolaris*State`, ViewModel/SavedState, a navigation graph and deep links, `PolarisKeyGate` one-liner, missing screens; Roborazzi re-baselined                                                                                      |
| UK-10 | kotlin | Compose Multiplatform: Desktop     | `desktopMain`: dialogs as real windows, keyboard focus rings, desktop density, open-URL and theme `expect/actual`, Windows/macOS/Linux sample, desktop screenshot tests                                                                                                                                                                                                                                                                                                                    |
| UK-11 | godot  | Control nodes (GDScript)           | Modernise in place: brand default, glass panel and `PKeySheet` host with scrim, every engine control icon themed (switch, spin, option, scrollbar, slider, tab), elevation, 60 px controls, icon set, Tween motion with reduced motion, OS dark-mode follow, safe areas, AccessKit names and live regions; new scenes (DeviceLimit, Devices, Paywall, Account tab, CloudSyncStatus, About, Toast, UpdateProgress, ReleaseNotes); copy fixes (no raw codes or slugs); POT export; baselines |
| UK-12 | python | ui-core + Qt (PySide6, PyQt6)      | `polaris_key.ui.core` view models (fixtures, UI-thread hook) and `polaris_key.ui.qt` screens with generated QSS, bundled Rubik, Linguist catalogs from UK-02, `QAccessible`, `run_gate`; `[qt]` extra; PySide6 sample; pytest-qt baselines; Python `parity.json` `ui.*` proofs                                                                                                                                                                                                             |
| UK-13 | python | Terminal (rich, Textual)           | Restyle the CLI core with rich (palette, rails, glyphs, spinners, progress, terminal QR for `begin_sign_in`, device-limit picker), error-code → copy mapping, `--json` on every verb, `NO_COLOR`/ANSI-16, optional Textual app; golden tests                                                                                                                                                                                                                                               |
| UK-14 | node   | Terminal (CLI prompts, `pkey`)     | Restyle the sdk-node CLI and `pkey`: clack-style prompts, masked key entry (fixes the positional `activate <key>` leak), spinners and progress for sync, packs and publish, terminal QR, `--json`, grouped help, completion, `pkey init --help` and `validate <path>` fixes; golden tests                                                                                                                                                                                                  |
| UK-15 | shared | Visual QA harness + modernity lint | `pnpm ui:report` side-by-side report from every kit's baselines; the §7.3 lint for web kits and the per-kit equivalents; CI wiring per lane; designer review checklist                                                                                                                                                                                                                                                                                                                     |
| UK-16 | docs   | Docs section + samples hub         | `build/ui/` section (overview, theming, a page per component with baseline images, a page per framework, localisation, recipes), `examples/ui/` index, kit READMEs slimmed; the docs drift gates for the new routes                                                                                                                                                                                                                                                                        |

### should

| Id    | SDK    | Framework              | Scope                                                                                                                                                                                              |
| ----- | ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-17 | js     | Vue 3 / Nuxt           | `@polaris-key/vue` composables over ui-core, typed element wrappers, Nuxt module (SSR-safe), Nuxt sample, Playwright baselines                                                                     |
| UK-18 | js     | Svelte 5 / SvelteKit   | `@polaris-key/svelte` rune stores, typed element wrappers, SvelteKit sample, baselines                                                                                                             |
| UK-19 | js     | Angular                | `@polaris-key/angular` signals service, standalone wrapper components, Angular sample, baselines                                                                                                   |
| UK-20 | js     | React Native / Expo    | `@polaris-key/react-native`: hooks over ui-core, RN screens with platform-adaptive styling and sheets, native module bridging the Swift and Kotlin SDKs, Expo sample, Maestro or Detox screenshots |
| UK-21 | js     | Tauri v2               | `tauri-plugin-polaris-key` (Rust) implementing the bridge over `invoke`/events with a `@polaris-key/node` sidecar; Tauri sample                                                                    |
| UK-22 | js     | Host design systems    | Tailwind v4 preset, shadcn/ui registry over the React hooks, MUI/Mantine/Chakra theme objects from the tokens, "go native" recipes                                                                 |
| UK-23 | swift  | UIKit (+ Mac Catalyst) | `PolarisKeyUIKit`: gate view controller, `presentIfNeeded`, embeddable banner/status views over the SwiftUI kit; Catalyst tested; sample and snapshots                                             |
| UK-24 | swift  | AppKit                 | `PolarisKeyAppKit`: sheet presenters, Preferences view controller, Sparkle bridge; sample and snapshots                                                                                            |
| UK-25 | swift  | StoreKit 2 paywall     | `Paywall` over `SubscriptionStoreView`/`StoreView` with theme and entitlement mapping via `PolarisKeyPlatform`; restore; snapshots                                                                 |
| UK-26 | swift  | visionOS               | Glass windows, ornaments for banners, hover effects; `.visionOS` declared; CI and snapshots                                                                                                        |
| UK-27 | swift  | tvOS                   | Focus-engine layouts, device-code first; `systemGroupedBackground` fix; `.tvOS` declared; CI and snapshots                                                                                         |
| UK-28 | kotlin | Android Views interop  | `polaris-key-ui-views`: `PolarisKeyActivity` + result contract, Fragments, XML-inflatable ComposeView views with theme attrs; sample                                                               |
| UK-29 | godot  | Godot .NET (C#)        | Generated typed C# facade over the GDScript scenes and controllers, `PKeyBrand.generated.cs`, NuGet/addon folder, C# demo twin                                                                     |
| UK-30 | python | Tkinter (ttk)          | Generated ttk theme; gate, activation, device limit and update prompt over ui-core; `tk.after`; sample and snapshots                                                                               |

### could

| Id    | SDK    | Framework                               | Scope                                                                                   |
| ----- | ------ | --------------------------------------- | --------------------------------------------------------------------------------------- |
| UK-31 | js     | SolidJS, Preact, Qwik, htmx             | Recipes over the elements (Solid signals adapter if demanded)                           |
| UK-32 | node   | Ink                                     | `@polaris-key/node/ink` components over the commands and stage core                     |
| UK-33 | swift  | watchOS                                 | Core 64-bit literal fix, status glance, companion sign-in                               |
| UK-34 | swift  | WidgetKit, Live Activities, App Intents | Update-progress Live Activity, license widget, intents                                  |
| UK-35 | kotlin | Android TV, Glance, notifications       | TV focus and device-code first; Glance widget; foreground-service pack progress         |
| UK-36 | godot  | Editor dock restyle                     | Setup dock aligned to the tokens within the editor theme; scene previews in both themes |
| UK-37 | godot  | Web-export overlay                      | Elements for sign-in and paywall on HTML5 exports via `JavaScriptBridge`                |
| UK-38 | python | wxPython, Kivy                          | Thin adapters over ui-core                                                              |
| UK-39 | python | Web UIs (NiceGUI, Gradio, Flet)         | Embed the elements or a small adapter over ui-core                                      |

---

## 11. Questions for the owner

1. **Product accent at the source.** Should a product's registered presentation gain an optional
   `accent` colour (set in the console, served with the presentation G1 already returns), so kits
   pick it up with no integrator code? It is a catalog and API addition and therefore an
   all-languages, plan-mode change. Without it, `accent: "product"` means "the integrator's accent,
   else violet".
2. **Launch locales.** English plus de, fr, es, pt-BR, it, ja, ko, zh-Hans and ar (§4.7)? Arabic
   brings the RTL pass into the must items.
3. **OS floors.** Keep iOS 17 / macOS 14 with Liquid Glass on 26 (§5.1), or raise the Apple floor to
   iOS 18 / macOS 15 to cut the fallback path?
4. **Lit for the elements.** Lit 3 (about 6 KB, mature SSR story) or dependency-free custom
   elements? The spec assumes Lit.

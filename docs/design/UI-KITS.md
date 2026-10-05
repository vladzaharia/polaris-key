# Polaris Key UI kits: one design system for every SDK

**Status:** proposed, 2026-10-05; revised the same day after critique round 1 (six design reviews,
§8). Design spec plus build plan; nothing here is implemented yet.

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
"System · Dark · Light" choice, all in the **product's** accent (§1.2). Apple platforms take their
system grouped grounds; every platform takes its own idiom (§1.4). A `native` preset (§3.4) restyles any kit to follow its host; a
partial theme restyles one token at a time.

### 1.2 The product is the hero

Polaris Key supplies the **design language, structure and polish**. The **product** leads every
screen:

- **`ProductIdentity`** (`name`, `icon`, `developer`, optional `shortName`, `accent`, `art`,
  `wordmark` and `deviceCodeUrl`) heads every full screen, sheet and card. The icon appears at hero
  size on Welcome (96 web, 120 iOS and Android, 64 macOS, 72 Godot beside the game's wordmark), at
  32 px beside the product name on every focused step, and at 56 px in update prompts and settings.
  Titles name the product in full ("Welcome to Tidewater Studio", "Tidewater Studio 2.5"). Inline
  sentences may use `shortName` only when the integrator sets it. Device names keep the user's
  casing ("signs out on Work laptop").
- **The product header** on focused steps is icon plus name in `text-strong` at weight 500. It is the
  strongest line in the header, not the faintest. Once a key parses, the tier follows in
  `text-muted` ("Tidewater Studio · Pro").
- **Developer attribution** has one rule: "by <Developer>" in `text-subtle` at 13/18, 6 px under
  the product name, on Welcome only.
- **Where identity comes from:** the integrator's theme first, then the product's registered
  presentation (G1: name, icon, developer; the same data the portal shows), then the bundle (app
  name and icon from `Info.plist`, the Android manifest, `package.json` `productName`, Godot's
  `application/config/name` and icon). With no icon at all the kit draws a **monogram tile**: the
  product's initial in Rubik 600 on neutral `surface-sunken`. It never falls back to a Polaris Key
  mark and never uses violet.
- **Product ambient:** the gate and boot screens lay the product's own content behind the hero.
  - Dark: the icon (or `art`) blurred 90–110 px at 35–45 % opacity, scaled up above 1200 px so a
    large window is not a small island in a black void.
  - Light: never the raw icon, which blurs into grey murk. Instead, radial washes from the
    resolved accent's `subtle` and the icon's secondary hue.
  - Platform forms: an icon-palette `MeshGradient` over the top 45 % on Apple, eased out with no hard
    stop; a radial wash centred on the icon on Android; full-bleed `art` in desktop split windows.

  It is the product's content, so it is not a gradient in Polaris chrome (BRAND §7.7 still holds for
  the chrome). `theme.ambient = false` turns it off, and it is off under the `native` preset.

- **Accent:** `theme.accent` defaults to `"product"`, resolved in this order:
  1. the integrator's colour or the product presentation's `accent`;
  2. otherwise the colour **derived from the product icon**: the most saturated dominant hue by
     area, in OKLCH, run through the resolver (§3.3);
  3. with no icon, a neutral **ink** primary (`text-strong` fill, `surface-page` label).

  Polaris violet appears only when the integrator asks for `accent: "core"`. Every accent goes
  through the contrast resolver (§3.3), so `solid`, `fg`, `on`, `subtle` and the focus ring stay AA
  in both themes. The fixture Tidewater Studio resolves to teal; it is never "violet with a teal
  icon pasted in".

- **Polaris Key appears only as an optional "Powered by Polaris Key"** line or badge (`poweredBy`,
  off by default, §4.5). No kit screen shows the Pinned K, the Star Cut or the "Polaris Key" name
  otherwise. Two exceptions, both true statements about who handles a step:
  - the sign-in footnote "Polaris Key handles sign-in. <Developer> never sees your passkeys."
    (EXPERIENCE §8 passthrough footer);
  - the device-code URL. The product's `deviceCodeUrl` (for example `driftkart.gg/tv`) is used when
    set, otherwise `key.plrs.im/tv` on TV and console and `key.plrs.im/activate` in desktop
    hand-offs.
- **Service cues are off on product screens.** Users neither know nor care that License is
  chartreuse. In product-facing kit screens the six service accents do not appear at all. They
  return only for integrators who opt in: `theme.serviceCues: true` adds the small tinted glyph tiles
  (20–28 px, the service's `subtle` and `fg`) to group headers, and `theme.accent = "service"` also
  uses the section accent for that section's primary. Even then they are never a fill, a status or
  a large surface (BRAND §5.4).

### 1.3 Three layers in every kit

Every component in §4 ships in three layers, so a team can drop in a flow, restyle a component, or
rebuild the UI on the state alone:

| Layer                | What it is                                                 | Web                                                    | SwiftUI                                                  | Compose                                                  | Godot                                           | Python (Qt)                                  |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| **(a) Drop-in flow** | One call that gates the app and runs every screen it needs | `<PolarisKeyGate>` / `<pk-gate>`                       | `.polarisKeyGate(client)` / `PolarisKeyGate(client) { }` | `PolarisKeyGate(client) { }`                             | `PKeyGate` node / `await PolarisKey.boot()`     | `polaris_key.ui.qt.run_gate(client, window)` |
| **(b) Styled parts** | Each screen and each part on its own, themed, with slots   | `<Activate>`, `<DeviceList>`… with `data-part` + slots | `ActivateView`, `DeviceList`… with `PolarisKeyStyle`     | `Activate(state)`, `DeviceList(state)`… with `*Defaults` | `PKeyActivate.tscn`… with theme type variations | `Activate.qml`… (QWidget parts + QSS)        |
| **(c) Headless**     | The state machine, actions and copy keys, no UI            | `useActivate()` (React), `ActivateModel` (ui-core)     | `@Observable ActivateModel`                              | `rememberActivateState(client)`                          | `PKeyActivateController`                        | `ActivateViewModel` (`polaris_key.ui.core`)  |

Layer (c) is the same state machine in every language, pinned by conformance fixtures (§5.2), so a
React screen, a SwiftUI screen and a Godot scene fed the same inputs show the same step with the same
copy key.

### 1.4 Platform-adapted, clearly Polaris Key

One identity, rendered in each platform's current idiom. These stay identical everywhere:

- the product-first hierarchy;
- Rubik (except under `native`);
- the token colours and the resolved product accent;
- the copy catalog, the flows and their order;
- one primary per region;
- status as icon plus word.

| Platform                                        | Design language                     | What the kit does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web** (React, elements, Vue, Svelte, Angular) | Modern web, 2026                    | **Flow card:** every gate step in one card (`surface-raised`, inner hairline, `elevation-3`, radius 22, `inline-size: min(440px, 100%)`, padding 32). Below a 560 px container it goes full-bleed with 20 px padding and the actions docked to the bottom (`max(20px, env(safe-area-inset-bottom))`). **Sizing:** controls 44 px on `(pointer: fine)`, 48 on `(pointer: coarse)`, 36 compact; radius 12 (10 at 36). **Type:** fluid in container units (`cqi`) on the kit root, never `vw`. **Layers:** native `<dialog>` in the top layer with a blurred scrim and `@starting-style` entry; View Transitions between steps. **States and modes:** `:hover`, `:active`, `:disabled` and `:focus-visible`; `forced-colors`. **Settings:** the sidebar becomes a push list below 720 px                                                        |
| **iOS / iPadOS 26**                             | Liquid Glass                        | **Layout:** full-bleed screens with the product hero and a bottom action area, on system grouped grounds (black / `#f2f2f7`, cells `#16181d` / white; no tinted product chrome). **Buttons:** `.glassProminent` capsule primaries with a white label and no coloured shadow; secondaries are `.buttonStyle(.glass)`, never a filled capsule with a border. **Sheets:** concentric corners (inner = display corner − inset); a grabber and swipe-to-dismiss at the medium detent with no extra X. **Platform controls:** `SignInWithAppleButton` (system), `PasteButton` in key fields, `ProgressView`. **Update:** non-mandatory availability is a glass banner; only a mandatory update is a sheet. iOS 17–25 uses the same layout on `.regularMaterial`                                                                                    |
| **macOS 26**                                    | Liquid Glass at Mac scale           | **Scale:** 13 pt body, 22 pt titles (26 pt on Welcome). Controls are `.controlSize(.large)` (about 28 pt); `.extraLarge` 36 pt capsules only for the Welcome hero. Grouped `Form` sections at radius 10. **Sheets** attach under the title bar, about 440 pt wide, without dimming the parent. **Copy:** title-case buttons ("Install and Relaunch", "Sign Out…"). **Windows:** a split Welcome window with full-bleed product `art` (inner radius = window radius − inset ≈ 12); a single-column update utility window with minimise and zoom disabled; a Settings scene that hugs its content (about 650 pt) and names the pane in its title. **Also:** `CommandGroup` items (Check for Updates…, Manage License…)                                                                                                                         |
| **visionOS / tvOS / watchOS**                   | Glass windows, focus engine, glance | visionOS: glass windows and ornaments for banners; tvOS: device-code sign-in first, focus-scaled controls; watchOS: status glance only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Android**                                     | Material 3 Expressive               | **Product icon:** drawn through the adaptive-icon mask (or a 28 % squircle) with an 8 % hairline, never re-cut into a Cookie shape. Shape morphs are kept for the monogram, the pressed state and the `LoadingIndicator`, which appears only inline at 24–48 dp and never as a hero. **Controls:** M3 filled fields (radius 16, label inside, a 2 dp focus indicator, never the outlined or notched field); 56 dp full-round buttons at equal widths; connected lists (outer 24, inner 6, 2 dp gaps); modal bottom sheets at radius 28 with a 32 % (light) or 60 % (dark) scrim; wavy progress (amplitude 3, wavelength 32) with a stop indicator. **System:** Material Symbols Rounded (wght 400, FILL 1 when selected); Credential Manager first for sign-in; `MotionScheme` springs; adaptive layouts; dynamic colour only under `native` |
| **Windows**                                     | Fluent 2                            | The `windows` platform variant for Electron, Tauri, Compose Desktop and Qt Quick. **Chrome:** a Mica title bar with caption buttons on the right (`DwmSetWindowAttribute` `DWMWA_SYSTEMBACKDROP_TYPE` natively). **Controls:** 32 px at radius 4; overlays at radius 8. **Focused steps:** a `ContentDialog` on a smoke layer, with the footer buttons at equal width, primary first. **Focus:** the Fluent two-tone ring                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Linux (GNOME)**                               | libadwaita                          | The `linux` platform variant: a header bar with only the close button, window radius 12, 34 px controls at radius 8, a pill suggested-action for the primary, and focused steps in an `AdwDialog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Godot**                                       | Modern game UI                      | **Scheme:** `colorScheme` defaults to `"dark"`; light is opt-in. **Glass:** panels over a 35–45 % scrim, with an opaque `surface-raised` at 0.94 under `gl_compatibility`, on web exports and when `ui_reduce_transparency` is set; blur at half resolution in one cached pass. **Controls:** 60 px, with a 3 px focus ring at a 2 px offset plus an accent glow; scale 1.03 only on tiles and rows, from the centre. **Identity and type:** a `product.wordmark` texture beside the icon, and `typography.display` for the game's heading face. **Input:** `PKeyInputGlyphs` (monochrome filled glyphs that follow the last input device and honour the confirm-button swap). **Also:** a type floor (§1.5 rule 5), title-safe areas, a host-set toast anchor, UI sound hooks and optional haptics                                          |
| **Terminal** (Node, Python)                     | 2026 CLI (gh, uv, clack)            | **Colour:** ANSI-16 for status roles by default, so output follows the user's terminal theme; truecolor only for the product chip, and only with `COLORTERM=truecolor`; light background detected via OSC 11, then `COLORFGBG`. **Layout:** 80 columns, degrading to 60, with keys truncated in the middle; a continuous rail on every line. **Feedback:** a braille spinner in `mute`; a half-block QR, hidden below 70 columns or 20 rows. **Interaction:** OSC 8 links, OSC 52 copy, masked key entry, `--json` on every verb. **Fallbacks:** `NO_COLOR` and ascii symbols                                                                                                                                                                                                                                                                |
| **Qt, Tk** (Python)                             | Platform variants above             | **Qt:** Qt Quick (QML with `MultiEffect` blur and `Behavior` springs) is the drop-in, rendering the macOS, Windows or Linux variant. QWidget is layer (b) only, with its limits stated: QSS has no blur, transitions or transforms. **Tk:** an image-element ttk theme (9-slice PNGs at 1x and 2x generated from the tokens). It has no blur and no motion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Desktop dialog model.** Focused steps (Activate, SignInHandoff, DeviceLimit) are sheets on macOS
and in-window dialogs on Windows (`ContentDialog`) and Linux (`AdwDialog`). The update prompt and
Settings are real windows on desktop. This replaces UK-10's "dialogs as real windows".

### 1.5 Nothing dated: the hard rules

Each rule is checked by the visual QA lint (§7.3), a kit test, or the mockup review (§7.4). A screen
that breaks one does not ship.

1. **No boxed forms.** Fields are filled: `surface-sunken` lifted toward the card, with an inner
   hairline and no border.
   - Focus is a single 2 px outline at offset 0, with the hairline removed: no halo, no spread
     shadow, no glow.
   - Android uses the M3 filled field, never the outlined or notched one.
   - Groups are inset grouped lists, never fieldsets or boxes inside boxes.
2. **No heavy borders.** Hairlines only (`border-subtle` at ≤ 80 % mix); depth comes from surface
   steps and the elevation tokens.
   - No border of 1.5 px or more on a selected row, or on any control at rest.
   - A selection is shown once: an `accent-subtle` tint plus one indicator (a check on web and iOS;
     a radio on Android, macOS, Godot and the terminal). Never border plus tint plus radio.
3. **No default system alerts** for anything the kit owns (no `alert()`, no `NSAlert`, no
   `AlertDialog` with stock buttons, no Godot `AcceptDialog`). Confirmations are EXPERIENCE §7
   levels: inline panels, sheets, or the kit's dialog.
4. **No stock spinners.** Each kind of wait has its own indicator:
   - A wait with a known end (a device code's lifetime) shows a **determinate countdown ring**:
     20 px, 2 px stroke, in the accent, draining linearly, beside the time in tabular figures.
   - Indeterminate waits use a 2 px shimmer along the container's top edge, or a skeleton shaped
     like the content.
   - A ring appears only at 16 px inside a busy button, which keeps its label.
   - Platform forms: the M3 Expressive `LoadingIndicator`, inline at 24–48 dp and never as a hero
     (Android); `ProgressView` (Apple; `.controlSize(.small)` on macOS); a braille spinner in `mute`
     at 80 ms a frame (terminal).
   - Never the star (BRAND §7.5).
5. **No cramped spacing, no mobile sizes on desktop.** Spacing sits on a 4 px grid.
   - Card padding: ≥ 28 px on web, ≥ 20 pt on iOS, ≥ 24 dp on Android, 24 px in desktop sheets,
     ≥ 44 px on Godot panels at 720p.
   - 10–16 px between stacked controls (16 px between paired gamepad buttons).
   - Touch targets: ≥ 44 pt / 48 dp; TV and gamepad targets ≥ 60 px.
   - Desktop controls follow §2.1 (28 pt macOS, 32 px Windows, 34 px GNOME, 44 px web on pointer
     devices), never 48 px everywhere.
   - **Type floor for Godot and TV at 720p:** meta and subtitles ≥ 16 px (24 at 1080p), hints 17,
     body 18–19.
6. **No 2018 Material or Bootstrap tells, and no 2020 Dribbble ones:**
   - no all-caps buttons and no 4 px-radius cards;
   - no drop shadows under flat cards on dark, and no coloured glow under buttons;
   - no underline-only or outlined text fields;
   - no default blue links;
   - no "— or —" dividers between buttons and links;
   - no disc bullets in release notes;
   - no 1 px outlined keycaps;
   - no engine-default bitmap controls (Godot), and no `CheckBox` where a switch is meant.
   - **No all-bold UI:** weights are 400 (body, row titles), 500 (labels, buttons, the product
     header) and 600 (headings). 700 appears only in the game wordmark fallback.
7. **States are visible, and only when they apply.** Every control shows hover, pressed (scale 0.98
   or the platform press), disabled (42 % opacity plus `aria-disabled`), busy (label kept, indicator
   added) and selected.
   - The focus ring appears on keyboard focus only (`:focus-visible`). A mockup's default shot shows
     rest, and focus gets its own state shot.
   - A locked setting shows its value as text with a 14 px lock glyph and "Set by <org>". It is
     never a dimmed switch, which reads as "off and broken".
8. **Motion is functional and tokenised** (§4.8): step transitions, sheet presentation, progress,
   the success moment. Nothing loops, nothing is decorative, and all of it collapses under reduced
   motion.
9. **Status is icon plus word**, issues only (EXPERIENCE §7); healthy is quiet text.
   - A full license is a limit, not an error. The seat meter is neutral (filled segments in
     `text-strong` at 80 %, empty at 10 %) with a "3 of 3 in use" caption.
   - Warning colour appears only when over the limit.
   - A success verdict colours only its icon; the text stays `text-default`.
10. **Buttons:** one primary per region, and never mixed widths (PORTAL §8).
    - In cards up to 440 px and on phones: full width, stacked, primary first (on top).
    - In dialogs of 460 px or more and on desktop: right-aligned at equal height, primary last. The
      secondary is tonal or bezel (not bare text) and at least 96 px wide.
    - A label longer than half the row stacks the pair.
    - One dismissal per surface: no X beside a Cancel or Later. Escape, the scrim, swipe and B also
      dismiss.
11. **Copy:** sentence case everywhere except macOS buttons, menu items and window titles, which use
    title case. Further rules:
    - Every visible string comes from the one catalog (§4.7); platforms may vary only the verb
      ("Install and Relaunch" on macOS).
    - No raw codes, slugs or spec references; "Try again", not "Retry"; confirms carry verb and
      object (EXPERIENCE §2).
    - Separators are "·" with thin spaces.
    - Lines are balanced or rewritten so none ends on a single orphan word (`text-wrap: balance` for
      headings, `pretty` for body).
12. **Mono only for keys, user codes and hashes** (BRAND §4.6), in the kit mono (§2.1).
    - Versions, counts, times and progress use tabular figures in the body face.
    - Keys never truncate at the end: they wrap to two lines or truncate in the middle
      (`pkey_tidewater_7Q2M…3WPLDA`).
13. **The terminal lays out for 80 columns** and degrades to 60. Key hints show keys in `strong` and
    actions in `mute`, everywhere. Footers never leak implementation ("NO_COLOR respected").

### 1.6 Marks

- Kit screens show **no Polaris Key mark**. The Pinned K appears only inside the optional Powered-by
  line or badge; the Star Cut does not appear in SDK UI at all. This supersedes BRAND §7.1's two
  "SDK UI" rows (§9).
- The Powered-by line is `<Pinned K at 13–14 px> Powered by Polaris Key` in `text-subtle` at 12 px,
  or the kit's compact badge at its 232 × 88 minimum (BRAND §1.5) on About screens. It is off by
  default and sits only at the foot of settings, about and credits screens, never on the gate. Default
  mockups show the default: no Powered-by.

---

## 2. Tokens in every kit

### 2.1 Generated, never hand-copied

`packages/brand/scripts/gen.ts` already writes `tokens.json`, `css/tokens.css`, `css/theme.css`,
TypeScript, `PKeyBrand` (GDScript), `PolarisBrand` (Swift) and `PolarisBrandTokens` (Kotlin). It
grows two layers and four targets:

**Kit component tokens** (`packages/brand/src/tokens/kit.ts`, new): the measures this spec fixes,
per platform variant.

| Token                    | Web                              | iOS                      | macOS             | Android                           | Windows    | GNOME       | Godot        |
| ------------------------ | -------------------------------- | ------------------------ | ----------------- | --------------------------------- | ---------- | ----------- | ------------ |
| `controlHeight`          | 44 fine · 48 coarse · 36 compact | 52                       | 28 (36 hero)      | 56                                | 32         | 34          | 60           |
| `radius.control`         | 12 (10 at 36)                    | capsule                  | capsule           | full                              | 4          | 8           | 16           |
| `radius.surface`         | card 22, group 16                | sheet 40, floating 40/48 | form 10, sheet 18 | sheet 28, list 24 outer / 6 inner | overlay 8  | dialog 14   | panel 28     |
| `space.cardPad`          | 32 (20 full-bleed)               | 20                       | 22–24             | 24                                | 24         | 24          | 44           |
| `focus.width` / `offset` | 2 / 2                            | system                   | system            | 2 / 0                             | Fluent     | 2 / −2      | 3 / 2 + glow |
| `scrim` light · dark     | 14 % + blur 12 · 50 % + blur 16  | 18 % · 32 %              | none (sheets)     | 32 % · 60 %                       | smoke 30 % | 12 % · 35 % | 20 % · 42 %  |

It also carries the `highlight` inner edge per theme, the danger `solid` for white labels, the
motion mapping per platform (§4.8), and the **concentric rule**: inner radius = outer radius −
inset, minimum 8.

**Type scale per platform** (`kit.ts` `typeScale`). Weights are 400, 500 and 600 only (§1.5 rule
6); new tokens `--pk-font-weight-medium: 500` and `--pk-font-weight-semibold: 600`.

| Role              | Web                                                              | iOS (pt)      | macOS (pt)          | Android (sp)           | Godot 720p (px)     |
| ----------------- | ---------------------------------------------------------------- | ------------- | ------------------- | ---------------------- | ------------------- |
| Display (Welcome) | `clamp(1.75rem, 1.1rem + 2.6cqi, 2.25rem)` / 1.12 / −0.02em, 600 | 34/40 600     | 26/32 600           | 36/44 600              | 36/44 600           |
| Title             | `clamp(1.625rem, 1rem + 2.4cqi, 2.125rem)` / 1.15, 600           | 28/34 600     | 22/28 600           | 28/36 600              | 32/40 600           |
| Body              | 15/22 400                                                        | 17/22 400     | 13/16 400           | 16/24 400              | 18–19/26 400        |
| Label, button     | 14/20 500 · 15 500                                               | 17 500        | 13 500              | 14/20 · 16 500         | 19 500              |
| Meta              | 13/18 400                                                        | 15/20 · 13/18 | 12/15 400           | 14/20 400              | 16/22 400           |
| Code (user code)  | 40 mono 500, tracking 0.12em                                     | 28 mono 500   | 28 mono 600, 0.06em | 32/40 mono 500, 0.06em | 52 mono 600, 0.06em |

**New targets:**

| Target                  | File (generated)                                                                             | Consumer                                                |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| CSS (exists) + kit vars | `packages/brand/css/kit.css` (`--pk-kit-*`)                                                  | React, elements, Vue, Svelte, Angular, Electron, Tauri  |
| JS objects              | `packages/brand/src/generated/kit.ts`                                                        | ui-core theme resolver, React Native                    |
| Swift (exists) + kit    | `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift` + `KitTokens.generated.swift`  | SwiftUI, UIKit, AppKit                                  |
| Kotlin (exists) + kit   | `sdks/kotlin/ui/src/commonMain/.../PolarisKitTokens.generated.kt`                            | Compose (all targets), Views interop                    |
| Godot (exists) + themes | `PKeyBrand` + `pkey_brand_{dark,light}.tres` + `ui/theme/icons/*.svg` (engine control icons) | Godot kit                                               |
| **Python (new)**        | `sdks/python/src/polaris_key/ui/_tokens.py`, Qt Quick `Theme.qml` + QSS, ttk image elements  | Qt, Tk, rich/Textual                                    |
| **Terminal (new)**      | `packages/sdk-node/src/cli/tokens.generated.ts`, `polaris_key/ui/ansi.py`                    | Node and Python CLIs (ANSI-16 roles + truecolor accent) |
| **C# (new)**            | `sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs`                                | Godot .NET facade                                       |

**Fonts per platform.** Rubik ships as a **variable font** (wght 300–900; about 35 KB as latin
WOFF2), replacing today's 400 and 700 statics, which forced every non-body string to Bold. The
kits also ship one **kit mono**, JetBrains Mono (OFL, 400–600 variable, latin, about 31 KB), as
`--pk-font-mono` for keys, user codes and hashes, so a key looks the same on every OS.

- Formats: WOFF2 for the web, TTFs for Swift, Compose Resources fonts for KMP (moving from
  Android `R.font`), Godot `FontFile`s (MSDF, so focus scaling stays sharp), and TTFs with
  `OFL.txt` in the Python wheel (`polaris_key/ui/fonts/`).
- Every web kit **loads its fonts itself** (an `@font-face` in the elements stylesheet and
  `@polaris-key/react/styles.css`), with `size-adjust` and `ascent-override` fallback faces so a
  host page does not shift when Rubik arrives (RE).
- Panes embedded in a host layout default `typography.family` to `"inherit"`, so a settings pane
  reads in the host's type. Full-screen flows keep Rubik.
- Apple kits scale Rubik with `UIFontMetrics` / `.relativeTo:` so Dynamic Type works (§11 Q6
  asks whether SF should carry body and controls instead).
- Rubik has no CJK, Arabic, Hebrew or Devanagari: each kit sets a fallback chain to the system
  face for those scripts.

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
(`colorScheme`, `color_scheme`). Everything is optional; an empty theme is the Polaris Key look in the
product's accent.

| Field         | Type                                                                             | Default                                         | Meaning                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`      | `"polaris-key"` · `"native"`                                                     | `"polaris-key"`                                 | The base look (§3.4)                                                                                                                                             |
| `colorScheme` | `"system"` · `"dark"` · `"light"`                                                | `"system"`; `"dark"` for Godot and TV           | Follows the OS live; dark when the OS has no preference. Games follow their own art, so the Godot kit defaults to dark                                           |
| `accent`      | `"product"` · `"core"` · `"service"` · a colour                                  | `"product"`                                     | §1.2: the given colour, else derived from the icon, else ink; `"core"` is Polaris violet; every value is resolved for contrast (§3.3)                            |
| `serviceCues` | boolean                                                                          | `false`                                         | Service glyph tiles on settings group headers (§1.2); implied by `accent: "service"`                                                                             |
| `colors`      | partial map of semantic roles (`surfacePage`, `textStrong`, `danger`, …)         | none                                            | Per-role overrides, per scheme (`colors.dark`, `colors.light`)                                                                                                   |
| `radius`      | `"sm"` · `"md"` · `"lg"` · a number (control radius; surfaces scale from it)     | `"md"`                                          | `sm` = 6/10, `md` = 12/22, `lg` = 16/28 (control/card, web)                                                                                                      |
| `typography`  | `{ family, display, monoFamily, scale }`                                         | Rubik; `"inherit"` when embedded; kit mono; 1.0 | `family: "system"` uses the platform face, `"inherit"` the host's; `display` sets a heading face (games); `scale` multiplies on top of Dynamic Type / font scale |
| `density`     | `"compact"` · `"comfortable"` · `"spacious"`                                     | `"comfortable"`                                 | Control height and spacing only, never the component (EXPERIENCE §1.9); Godot and TV default to `spacious`                                                       |
| `motion`      | `"system"` · `"reduced"` · `"none"`                                              | `"system"`                                      | `system` follows the OS reduced-motion setting                                                                                                                   |
| `ambient`     | boolean                                                                          | `true` (`false` in native)                      | The product ambient (§1.2)                                                                                                                                       |
| `product`     | `ProductIdentity`                                                                | from presentation/bundle                        | §1.2, including `shortName`, `wordmark` and `deviceCodeUrl`                                                                                                      |
| `copy`        | partial map of copy keys, or a `locale`                                          | the OS locale                                   | §4.7                                                                                                                                                             |
| `poweredBy`   | `false` · `"line"` · `"badge"`                                                   | `false`                                         | §1.6                                                                                                                                                             |
| `platform`    | `"auto"` · `"ios"` · `"android"` · `"macos"` · `"windows"` · `"linux"` · `"web"` | `"auto"`                                        | Web and Qt Quick kits: render the platform variant inside a webview or QML (Electron on Windows gets Fluent, Tauri on macOS gets the Mac sheet)                  |

### 3.2 Where it is set, per kit

| Kit                  | Set it                                                                                                                      | Restyle hooks beyond the theme                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React                | `<PolarisKeyProvider theme={…}>`; `polarisKeyTheme({ … })` helper                                                           | Stable class names `pk-*` and `data-part="title"` etc.; CSS cascade layer `@layer polaris-key` so host CSS wins without `!important`; slots (`slots={{ header, footer }}`) and render props; `--pk-*` vars scoped to the provider element, **never `:root`** (RE); the same `styles.css` and `data-part` contract as the elements |
| Web components       | `<pk-provider theme='…'>` or `PolarisKey.theme({…})`; `--pk-*` custom properties                                            | `::part(title)`, `::part(primary)`…; named `<slot>`s; `pk-*` DOM events; the shared `styles.css` adopted into each shadow root (`adoptedStyleSheets`)                                                                                                                                                                             |
| Vue, Svelte, Angular | `providePolarisKey({ theme })` / `setPolarisKeyTheme` / `providePolarisKey({ theme })`                                      | Pass-through of the element parts and slots                                                                                                                                                                                                                                                                                       |
| SwiftUI              | `.polarisKeyTheme(PolarisKeyTheme(…))` environment modifier                                                                 | `PolarisKeyStyle` protocols per component (`.activateStyle(.myStyle)`) in the manner of `ButtonStyle`; `@ViewBuilder` slots                                                                                                                                                                                                       |
| UIKit / AppKit       | `PolarisKeyUI.theme = …` or per presenter                                                                                   | Subclassable hosting controllers                                                                                                                                                                                                                                                                                                  |
| Compose              | `PolarisKeyTheme(theme = PolarisKeyTheme(…)) { }`                                                                           | `ActivateDefaults.colors()/shapes()/…` objects like Material's `ButtonDefaults`; composable slot parameters                                                                                                                                                                                                                       |
| Godot                | `PKeyOptions.ui_theme_preset`, `ui_accent`, `ui_radius`, `ui_density`… in `polaris_key.tres`; or `PKeyUiTheme.build(theme)` | Theme type variations (`PKeyTitle`, `PKeyPrimary`, …, full list documented); a per-node `Theme` wins                                                                                                                                                                                                                              |
| Qt                   | `polaris_key.ui.qt.apply_theme(app, Theme(…))`                                                                              | Object names (`#pkTitle`, `#pkPrimary`) and dynamic properties for QSS; native `QStyle` under `native`                                                                                                                                                                                                                            |
| Terminal             | `PolarisKeyTheme` in the CLI adapter options; env `PKEY_THEME=dark\|light`, `NO_COLOR`                                      | Symbols set (unicode / ascii)                                                                                                                                                                                                                                                                                                     |

### 3.3 The accent resolver

One algorithm in `@polaris-key/brand`, ported to Swift, Kotlin, GDScript and Python with shared test
vectors. It is built on `color.ts` and adjusts OKLCH lightness only, in both schemes.

**`deriveAccent(iconPixels)`** picks the input colour when the product supplies none. It clusters the
icon's opaque pixels in OKLCH and takes the most saturated cluster that covers at least 8 % of the
area; it returns nothing for a near-greyscale icon, which falls through to ink. Kits run it once and
cache it per icon hash. It needs no network and no wire change.

**`resolveAccent(hex, scheme)`** derives from any input colour:

- **`solid`**: ≥ 3:1 on every surface.
- **`fg`**: ≥ 4.5:1 on every surface.
- **`subtle`**: the tinted fill for selected rows.
- **`focus`**: the ring colour.
- **`on`**: ≥ 4.5:1 on `solid`. It **prefers white**: when moving `solid`'s lightness by ≤ 0.08 gets
  white text to 4.5:1, the resolver moves `solid` and keeps a white label, so the primary's label is
  the same in both schemes. Only light accents (yellows, oranges, light teals) flip to an ink label,
  again in both schemes, and keep their hue rather than darkening to mud.

The focus ring takes the resolved accent (one learnable focus signal within the product). Status
colours never change with the accent; the danger `solid` behind white labels follows the same
white-first rule.

| Vector (input → scheme)      | `solid`               | `on`  | `fg`      | `subtle`  |
| ---------------------------- | --------------------- | ----- | --------- | --------- |
| Tidewater icon teal → dark   | `#0f8075`             | white | `#4fd8c4` | `#0c2628` |
| Tidewater icon teal → light  | `#0d7268`             | white | `#0b6b62` | `#dff2ef` |
| Core violet → dark           | `#7a3df0`             | white | `#b688fe` | `#18132e` |
| Core violet → light          | `#7a2fff`             | white | `#6a1fef` | `#eae4ff` |
| Drift Kart `#ff6a3d` → dark  | `#ff6a3d`             | ink   | `#ff8a63` | 16 % tint |
| Drift Kart `#ff6a3d` → light | `#ff6a3d`             | ink   | `#c2410c` | 14 % tint |
| Danger → dark / light        | `#c83b2c` / `#be2323` | white | token     | token     |

A pinned test asserts that `on` is the same colour in both schemes for every vector.

### 3.4 The `native` preset

`preset: "native"` keeps the structure, flows, copy and spacing and hands the look to the host:

- **Web:** the host's font (`font: inherit`), `Canvas` / `CanvasText` neutrals, the host's accent
  from `theme.accent`, else the host's `accent-color`, else the CSS `AccentColor` system colour;
  radii from the host; no ambient. It never hard-codes a platform blue.
- **SwiftUI / UIKit / AppKit:** system fonts, the app's `.tint`, system colours and materials, stock
  button styles (`.glassProminent` / `.borderedProminent`).
- **Compose:** the host `MaterialTheme` (including dynamic colour); status colours mapped to the host
  scheme's error and a computed warning, not tertiary/primary (KO).
- **Godot:** derives from the ancestor or project theme (today's "neutral" builder, kept and
  polished).
- **Qt:** the platform `QStyle` (or the Qt Quick native style) with only spacing and typography
  hierarchy applied.

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

### 4.2 The drop-in flows, complete

Each snippet below is complete: imports, client construction and styles included. The line count is
the integration cost.

```tsx
// React: web, Electron renderer, Tauri webview, Next.js client component (4 lines)
import { PolarisKeyGate } from "@polaris-key/react";
import "@polaris-key/react/styles.css";

<PolarisKeyGate
  product="tidewater"
  publishableKey={import.meta.env.VITE_PK_KEY}
>
  <App />
</PolarisKeyGate>;
```

```html
<!-- Any web page, Angular, Vue, Svelte, htmx (2 lines; the module injects its own styles and fonts) -->
<script type="module" src="https://cdn.key.plrs.im/elements/1/pk.js"></script>
<pk-gate product="tidewater" publishable-key="pk_live_…"
  ><my-app></my-app
></pk-gate>
```

```swift
// SwiftUI, iOS 17+ / macOS 14+, Liquid Glass on 26 (3 lines)
import PolarisKeyUI
let client = PolarisKey.client(product: "tidewater")   // reads PolarisKey.plist
WindowGroup { ContentView().polarisKeyGate(client) }
// macOS: also adds the Settings pane and the menu commands
Settings { PolarisKeySettings(client) }
```

```kotlin
// Compose (Android, Desktop) (3 lines)
import im.plrs.key.ui.PolarisKeyGate
val client = PolarisKey.client(context, product = "tidewater")
setContent { PolarisKeyGate(client) { App() } }
```

```gdscript
# Godot: the autoload reads polaris_key.tres; one call before the main scene (1 line)
await PolarisKey.boot()
```

```python
# Qt (PySide6 or PyQt6) (3 lines)
from polaris_key import Client
from polaris_key.ui.qt import run_gate
run_gate(Client(product="tidewater"), main_window)  # shows the gate until licensed
```

```ts
// Electron main + preload: two lines replace the hand-written bridge (RE, GA)
registerPolarisKey({ ipcMain, client }); // main
exposePolarisKey(); // preload
```

The constructor names follow each SDK. Every kit takes a `client` built the same way, and every web
kit takes `product` plus `publishableKey`. The gate fixes today's lifecycle traps:

- it starts itself (Compose `gate.start()`, KO);
- it never flashes the sign-in card before the real state loads (SW);
- it re-renders on background changes from a `statusStream` (SW "no live updates").

### 4.3 Key components in detail

#### Welcome and Activate

Mockups: [web](ui-kits/shots/web-gate-dark.png), [web 390](ui-kits/shots/web-gate-390-light.png),
[iOS](ui-kits/shots/ios-activate-light.png), [Android](ui-kits/shots/android-activate-dark.png),
[macOS](ui-kits/shots/desktop-activate-light.png), [Godot](ui-kits/shots/godot-activate-dark.png).

- **One surface.** On the web, every gate step sits in the same card, so step changes morph one
  surface (View Transition on the card group). Below a 560 px container the card goes full-bleed.
- **Welcome is product-first:**
  - the icon at hero size (§1.2) and "Welcome to <Product>" as the title;
  - "by <Developer>" under it, and one line of lede;
  - two buttons: **Sign in** (primary; hidden when Identity is off) and **Use a license key**
    (secondary; hidden when License keys are off), with no leading glyphs;
  - extras (trial, restore purchase, activate offline) as one quiet row of links 20 px below, with
    no divider;
  - in games, the `wordmark` texture beside the icon, and no Quit on console builds (B does nothing
    on the root screen).
- **The key field** sits behind "Use a license key" (RE: an always-visible field is heavier than
  the portal's collapsed path). It has:
  - a visible label and autocorrect and autocapitalisation off;
  - a paste control inside the field (`PasteButton` on iOS, `content_paste` on Android); consoles
    open the platform virtual keyboard instead;
  - submit on Return (`.submitLabel(.go)` with an ASCII keyboard on iOS).
- **Keys are never end-truncated:** they wrap to two lines in mono (13–15 px), or truncate in the
  middle at narrow widths.
- **Live verdict.** The key parses as you type: `pkey_<product>_<22>` puts a verdict under the field
  ("✓ Tidewater Studio Pro · Lifetime · 3 devices", with only the icon in success colour), and the
  product header gains the tier. A cut-short key gets "This key is cut short. After tidewater\_ come
  22 characters, and this has 10." Errors are inline under the field, `aria-invalid`, announced, and
  cleared on edit.
- **Device limit is not an error string:** Activate hands off to **DeviceLimit** with the device
  list (RE, SW, KO, GO all lacked this).

#### SignIn and SignInHandoff

Mockups: [web](ui-kits/shots/web-sign-in-light.png), [iOS](ui-kits/shots/ios-sign-in-dark.png),
[Android](ui-kits/shots/android-sign-in-dark.png),
[macOS](ui-kits/shots/desktop-sign-in-dark.png), [Godot TV](ui-kits/shots/godot-sign-in-dark.png),
[terminal](ui-kits/shots/terminal-sign-in-dark.png).

- **Methods** follow PORTAL §4.1's provider rules:
  - **Sign in with Apple** whenever the product ships on Apple platforms, as the system
    `SignInWithAppleButton` / `ASAuthorizationAppleIDButton` (App Review requires it);
  - **a passkey** row;
  - **Credential Manager first on Android** (passkey and Google accounts in one system sheet);
  - Steam where the product sells on Steam;
  - email through the hosted card (`ASWebAuthenticationSession` / Custom Tabs / the system
    browser);
  - **Use another device** (device code).

  The iOS method sheet is titled "Sign in to <Product>", with no second product icon and no X at
  the medium detent.

- **The hand-off screen:**
  - the user code centred in mono (40 px, weight 500, tracking 0.12em) on a borderless fill, so it
    reads as output and not as an input, with a ghost Copy icon at the inline end;
  - "Or go to key.plrs.im/activate", with copy;
  - "Check the code there matches this one";
  - the determinate countdown ring with "code expires in 4:12";
  - **Open browser again** (primary) and **Cancel** (secondary).

  The QR sits beside the code when the card is ≥ 560 px (desktop sheets, web), and behind "Scan with
  your phone instead" when narrower. The screen moves on by itself.

- **TV and consoles** (tvOS, Android TV, Godot on console or Steam Deck in game mode) open on the
  device-code path:
  - the product's `deviceCodeUrl`, or `key.plrs.im/tv`;
  - the code as two groups of four, with a gap and no hyphen;
  - a QR tile in 92 % white with an 8 px quiet zone;
  - focusable **Use a license key instead** and **Cancel**, so the screen is never a dead end
    without B.

#### DeviceLimit

Mockups: [web](ui-kits/shots/web-device-limit-dark.png),
[web 390](ui-kits/shots/web-device-limit-390-dark.png),
[iOS](ui-kits/shots/ios-device-limit-dark.png),
[Android](ui-kits/shots/android-device-limit-light.png),
[macOS](ui-kits/shots/desktop-device-limit-light.png),
[Godot](ui-kits/shots/godot-device-limit-dark.png),
[terminal](ui-kits/shots/terminal-device-limit-dark.png).

PORTAL §4.25 in every kit, top to bottom:

1. The product header with tier.
2. "Your license is on 3 of 3 devices".
3. "To use it on <this device>, remove one. You can add it back later."
4. The neutral seat meter with its "3 of 3 in use" caption (`role="img"`, labelled), under the lede.
5. **One inset grouped list.** Radius 16, hairlines inset past the glyph, 64 px rows. Each row has a
   bare 20 px form-factor glyph in `text-muted` and one meta template: "<platform> · last used
   <when>", with "· least recent" on the preselected row. Glyphs by `deviceType`: laptop, desktop
   (Mac mini, towers), tablet, phone, handheld; `laptop_windows`, `laptop_mac`, `desktop_mac`,
   `tablet_android` and `phone_android` in Material Symbols.
6. Selection: `accent-subtle` plus one indicator (§1.5 rule 2).
7. The consequence line, "<Product> signs out on <device>."
8. **Remove <device> and continue** as the primary. On macOS it reads "Remove “<device>” and
   Continue". It stacks full width when the label runs past half the row.

Browser mode (no device API) links to the portal flow instead. The copy never shows `dev-2` or
`macos` (RE).

#### UpdatePrompt and UpdateProgress

Mockups: [web](ui-kits/shots/web-update-dark.png), [iOS banner](ui-kits/shots/ios-update-dark.png),
[iOS required](ui-kits/shots/ios-update-required-light.png),
[Android](ui-kits/shots/android-update-light.png), [macOS](ui-kits/shots/desktop-update-dark.png),
[Windows](ui-kits/shots/windows-update-dark.png),
[Godot toast](ui-kits/shots/godot-update-toast-dark.png),
[Godot results](ui-kits/shots/godot-update-dark.png).

- **Content:**
  - the product icon, "<Product> <version>", and "You have <current> · <size> download";
  - a 13 px "What's new" label over at most three plain lines, then an inline "All changes in
    <version> ↗" link;
  - the download progress inline: bar, "Downloading · 38 of 61 MB", and "About 20 seconds left" in
    tabular figures.
- **Actions:** one dismissal plus the verb the outlet allows, with no X.
  - **Later** pairs with **Restart when ready**, which queues the restart, so the primary is never
    disabled during a download. The ready state's verb is "Restart now".
  - The other outlets' verbs: **Update on the App Store**, **Get it on Steam**, **Reload**.
  - macOS uses the platform verbs **Remind Me Later** and **Install and Relaunch**, with **Skip This
    Version** at the leading edge.
- **Presentation per platform:**
  - web, Windows and Linux: a dialog with a blurred scrim (not an opaque window takeover, RE);
  - macOS: a single-column utility window driven by a custom Sparkle `SPUUserDriver`;
  - Android: a modal bottom sheet with wavy progress (Play in-app flexible update);
  - iOS: a glass banner when the update is available, and a sheet with no dismiss only when it is
    mandatory.
- **Mandatory updates** have no dismiss and say why ("Your library moved to a new format, and 2.4.1
  can't open it.").
- **Games** never interrupt play. During gameplay the kit shows only an UpdateProgress toast at the
  host's `toast_anchor`; the default is bottom centre above the hints, inside the 5 % title-safe
  area and never over the HUD. The modal waits for the results or pause screen, with default focus
  on **Later** and input ignored for 250 ms after it opens.
- **UpdateProgress** is its own component for background content packs: the Godot toast ("38 of 91
  MB · 1 min left"), the Android foreground-service notification, a Live Activity on iOS.

#### AccountAndLicense and Settings

Mockups: [web](ui-kits/shots/web-settings-light.png),
[web 390](ui-kits/shots/web-settings-390-dark.png), [iOS](ui-kits/shots/ios-settings-light.png),
[Android](ui-kits/shots/android-settings-dark.png),
[macOS](ui-kits/shots/desktop-settings-light.png),
[Windows](ui-kits/shots/windows-settings-light.png),
[Godot](ui-kits/shots/godot-settings-dark.png).

- **Rows:** inset grouped, label left and control or value right, at least 52 px (64 px with a
  second line). Titles use weight 400; the product row comes first.
- **Group headers:** 13 px, weight 500, `text-muted`, 8 px above the group, with no tiles (§1.2
  service cues).
- **Web layout:** content capped at 640 px; the sidebar collapses to a push list below 720 px.
- **Rows that change:** "Manage" carries an external-link glyph because it opens the portal. Sign
  out sits in its own group, in danger text.
- **Typed controls from the catalog schema:** a switch for booleans, a slider or stepper for bounded
  numbers, a select for enums, text otherwise. Catalog labels and help appear; raw dotted keys and
  literal `true` never do (RE).
- **Provenance and locks:**
  - "From <Developer>" groups the developer's pushed defaults that the user can still change.
  - A row locked by a policy shows its value as text with a lock and names who set it ("Set by
    Fennick Studio"; on consoles, "Set by your parent or guardian").
  - Provenance is text, not equal-weight chips (GO).
- **Embedding:** the pane embeds into the host's own settings and inherits the host's font: a React
  component, a SwiftUI `Section` set, a Compose `LazyListScope` extension, a Godot `PKeyAccountTab`
  for a game's tabbed menu, a Qt Quick page. It can also open as a whole page.
- **Privacy on shared screens:** on TV and console the email is masked (`m•••@fennick.studio`) and
  revealed on focus.

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
9. Pointer users see focus only on keyboard focus (`:focus-visible`); gamepad, D-pad and TV users
   always see it.
10. Reduced transparency (`prefers-reduced-transparency`, Reduce Transparency, Godot
    `ui_reduce_transparency`) turns every glass surface opaque.

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
- **One key per visible string, in every kit and every mockup.** A key may carry documented
  platform variants, and only for the verb or casing: `update.restartWhenReady` is "Install and
  Relaunch" on macOS, and macOS buttons are title case. The string lint (§7.3) fails any other
  drift between kits.
- Product names come from `ProductIdentity`: the full name in titles, and `shortName` only where the
  integrator set it.

### 4.8 Motion

Durations come from the tokens: `fast` 120 ms, `base` 200 ms, `slow` 320 ms.

| Change                     | Web / desktop webviews                                                                         | iOS / macOS                                                                                                     | Android                               | Godot                                                          | Qt Quick                     | Terminal                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| Step to step inside a flow | View Transition on the card: cross-fade plus an 8 px slide, `base`, `ease-standard`            | `.navigationTransition(.zoom)` where the icon persists; `matchedGeometryEffect` for the icon from gate to sheet | `AnimatedContent` with `MotionScheme` | 220 ms, `TRANS_BACK` / `EASE_OUT`, overshoot ≤ 1.04            | `Behavior` 200 ms `OutCubic` | Redraw in place                |
| Sheet or dialog in         | `slow`, `ease-enter`, scale 0.98 → 1 and opacity, via `@starting-style`; scrim fades at `base` | system sheet springs (`.smooth(duration: 0.35)`); macOS sheets slide from the title bar                         | system bottom sheet                   | 280 ms rise of 24 px plus fade; exit 160 ms                    | 320 ms `OutCubic`            | n/a                            |
| Press                      | scale 0.98, `fast`                                                                             | system                                                                                                          | shape morph (M3E)                     | 0.98 press; focus moves the ring, no scale on buttons in a row | scale 0.98                   | n/a                            |
| Progress                   | width at `base`                                                                                | system                                                                                                          | wavy indicator                        | Tween                                                          | `NumberAnimation`            | Redraw at ≤ 10 Hz              |
| Waiting                    | countdown ring drains linearly; 2 px shimmer                                                   | `ProgressView`                                                                                                  | `LoadingIndicator` inline             | countdown ring                                                 | countdown ring               | braille spinner, 80 ms a frame |
| Success                    | one check draw, `slow`                                                                         | `.symbolEffect(.bounce)` once                                                                                   | one shape morph                       | one Tween                                                      | one check draw               | `✓` printed once               |

The [motion board](ui-kits/shots/web-motion-dark.png) shows the web keyframes. `motion: "system"`
follows `prefers-reduced-motion`, `accessibilityReduceMotion`,
`Settings.Global.ANIMATOR_DURATION_SCALE` and a Godot `ui_reduce_motion` option. Reduced motion
keeps only the opacity change, at `fast`; `"none"` removes it. The terminal never animates when
stdout is not a TTY or `CI` is set. The star never animates (BRAND §7.5).

---

## 5. Frameworks and architecture

### 5.1 The matrix

**must** ships in the first release of the parity pass; **should** follows; **could** is recipes,
thin adapters or demand-driven.

| Language / SDK | Framework                                                       | Priority | Architecture                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS / TS        | **ui-core** (framework-neutral view models, theme, copy)        | must     | `@polaris-key/ui-core` on `client-core`: the state machines of §4, the error → copy mapping, the theme resolver; grows from `@polaris-key/react/core`                                                                                                                                                                                           |
| JS / TS        | **Web Components**                                              | must     | `@polaris-key/elements`, Lit 3 over ui-core; shadow DOM, `::part`, slots, `--pk-*` vars, DOM events; the universal fallback                                                                                                                                                                                                                     |
| JS / TS        | **React** (web, Electron renderer, Tauri, Next.js)              | must     | `@polaris-key/react` rebuilt on ui-core: native React components (not wrappers) styled by `styles.css` in `@layer polaris-key`; `"use client"` boundaries; React 18 and 19 in CI                                                                                                                                                                |
| JS / TS        | **Electron** (main + preload)                                   | must     | `@polaris-key/electron`: `registerPolarisKey` (main, wraps `@polaris-key/node`) and `exposePolarisKey` (preload, `contextBridge`); native menu items and notifications                                                                                                                                                                          |
| JS / TS        | Vue 3 / Nuxt                                                    | should   | `@polaris-key/vue`: composables over ui-core plus typed wrappers over the elements; a Nuxt module                                                                                                                                                                                                                                               |
| JS / TS        | Svelte 5 / SvelteKit                                            | should   | `@polaris-key/svelte`: rune stores over ui-core plus typed element wrappers                                                                                                                                                                                                                                                                     |
| JS / TS        | Angular                                                         | should   | `@polaris-key/angular`: a signals service and standalone components wrapping the elements                                                                                                                                                                                                                                                       |
| JS / TS        | React Native / Expo                                             | should   | `@polaris-key/react-native`: the React hooks over ui-core, screens in RN primitives, platform-adaptive (glass on iOS 26, M3E on Android), a native module over the Swift and Kotlin SDKs                                                                                                                                                        |
| JS / TS        | Tauri v2                                                        | should   | `tauri-plugin-polaris-key` (Rust, a `@polaris-key/node` sidecar first) implementing the bridge over `invoke`; the web kits render unchanged                                                                                                                                                                                                     |
| JS / TS        | Host design systems (Tailwind v4, shadcn, MUI, Mantine, Chakra) | should   | §3.5: presets, theme objects and a shadcn registry, no new kits                                                                                                                                                                                                                                                                                 |
| JS / TS        | SolidJS, Preact, Qwik, htmx and plain pages                     | could    | Recipes over the elements (Preact can also use React via compat)                                                                                                                                                                                                                                                                                |
| Swift          | **SwiftUI iOS / iPadOS 26** (iOS 17 floor)                      | must     | `PolarisKeyUI` rebuilt: `@Observable` models over a pure-Swift presentation core, public composable views, `.polarisKeyGate`, glass on 26                                                                                                                                                                                                       |
| Swift          | **SwiftUI macOS 26** (macOS 14 floor)                           | must     | Same kit plus Settings scene, `CommandGroup`s, sheets, a SwiftUI Sparkle user driver                                                                                                                                                                                                                                                            |
| Swift          | UIKit (and Mac Catalyst)                                        | should   | `PolarisKeyUIKit`: `PolarisKeyGateViewController`, `presentIfNeeded(from:client:)`, embeddable banner and status views; no second implementation                                                                                                                                                                                                |
| Swift          | AppKit                                                          | should   | `PolarisKeyAppKit`: `beginGateSheet(for:)`, a Preferences `NSViewController`, the Sparkle bridge                                                                                                                                                                                                                                                |
| Swift          | StoreKit 2 views                                                | should   | `Paywall` wraps `SubscriptionStoreView` / `StoreView` with the theme and entitlement mapping (`PolarisKeyPlatform` StoreService)                                                                                                                                                                                                                |
| Swift          | visionOS                                                        | should   | Glass windows, ornaments for banners, hover effects; declare `.visionOS`, CI                                                                                                                                                                                                                                                                    |
| Swift          | tvOS                                                            | should   | Focus-engine layouts, device-code first; fix `systemGroupedBackground` (SW); declare `.tvOS`, CI                                                                                                                                                                                                                                                |
| Swift          | watchOS                                                         | could    | Status glance and companion sign-in; first fix Core's 64-bit literal overflow (SW)                                                                                                                                                                                                                                                              |
| Swift          | WidgetKit, Live Activities, App Intents                         | could    | Update progress Live Activity, license widget, "Check for updates" intent                                                                                                                                                                                                                                                                       |
| Kotlin         | **Compose Multiplatform: Android** (M3 Expressive)              | must     | `:ui` becomes a KMP module (`commonMain` composables and states, `androidMain`); Material3 with Expressive on a version line decoupled from the Godot template pins (KO)                                                                                                                                                                        |
| Kotlin         | **Compose Multiplatform: Desktop JVM**                          | must     | `desktopMain`: the §1.4 desktop dialog model (sheets on macOS, `ContentDialog` on Windows, `AdwDialog` on Linux; update and settings as windows), the `windows`/`linux`/`macos` variants, keyboard focus rings, desktop density                                                                                                                 |
| Kotlin         | Android Views (XML, Fragments)                                  | should   | `PolarisKeyActivity` (ActivityResultContract), `PolarisKeyFragment`s, `ComposeView`-based XML views; also serves the Godot Android plugin                                                                                                                                                                                                       |
| Kotlin         | Android TV, Glance, notifications                               | could    | TV focus and device-code first; a Glance license/update widget; foreground-service pack progress                                                                                                                                                                                                                                                |
| Godot          | **Control nodes (GDScript)**                                    | must     | The existing kit modernised in place on its controllers (§1.4, GO), plus the missing scenes and a `PKeySheet` host with a scrim                                                                                                                                                                                                                 |
| Godot          | Godot .NET (C#)                                                 | should   | A typed C# facade over the same scenes: generated wrappers, typed signals, options records                                                                                                                                                                                                                                                      |
| Godot          | Editor dock restyle; web-export overlay                         | could    | Brand-aligned setup dock that respects the editor theme; elements for sign-in and paywall on HTML5 exports via `JavaScriptBridge`                                                                                                                                                                                                               |
| Python         | **ui-core**                                                     | must     | `polaris_key.ui.core`: view models over `stages.py` and `get_sync_state()`, with a thread-marshalling hook (GA)                                                                                                                                                                                                                                 |
| Python         | **Qt** (PySide6 primary, PyQt6 via qtpy)                        | must     | `polaris_key.ui.qt`: **Qt Quick** screens as the drop-in (QML, `MultiEffect` blur, `Behavior` springs, the macOS/Windows/Linux variants, Mica via `DwmSetWindowAttribute`), QWidget parts with generated QSS as layer (b) with its limits stated, bundled fonts, Qt Linguist from the catalog, `QAccessible` names, signals marshal `on_change` |
| Python         | **Terminal** (rich, Textual)                                    | must     | The CLI core restyled with rich (palette, rails, spinners, progress, terminal QR, masked key), `--json` on every verb; optional Textual app                                                                                                                                                                                                     |
| Python         | Tkinter (ttk)                                                   | should   | An image-element ttk theme (9-slice PNGs at 1x and 2x generated from the tokens); gate, activation, device limit and update prompt; no blur or motion; `tk.after` marshalling                                                                                                                                                                   |
| Python         | wxPython, Kivy, web UIs (NiceGUI, Gradio, Flet)                 | could    | Thin adapters over ui-core, or the elements embedded                                                                                                                                                                                                                                                                                            |
| Node           | **Terminal** (CLI prompts)                                      | must     | `@polaris-key/node` CLI and `pkey` restyled (`util.styleText`, `NO_COLOR`, isatty), clack-style prompts with masked key entry, spinners, progress, terminal QR, `--json`, grouped help and completion                                                                                                                                           |
| Node           | Ink                                                             | could    | `@polaris-key/node/ink` components over the same commands and stage core                                                                                                                                                                                                                                                                        |

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
real sizes, and compared with a committed lossless baseline:

| Kit                                   | Tool                                                                           | Variants                                                                                                                              | Baselines                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| React, elements, Vue, Svelte, Angular | Playwright component tests (Chromium, WebKit)                                  | 1440 × 900 and 390 × 844 at 2x; dark, light; `polaris-key` and `native`; RTL; `forced-colors` (dark only); keyboard-focus state shots | `packages/<kit>/test/visual/__screenshots__/`                         |
| SwiftUI, UIKit, AppKit                | swift-snapshot-testing on iOS 26 and macOS 26 simulators/hosts                 | iPhone, iPad, Mac; dark, light; AX3 Dynamic Type; RTL; iOS 18 fallback                                                                | `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`           |
| Compose                               | Roborazzi (exists, 136 baselines) + Compose Desktop screenshot tests           | phone, tablet, desktop (Windows, macOS, Linux chrome); dark, light; 200 % font; RTL; native preset                                    | `sdks/kotlin/ui/src/test/snapshots/`                                  |
| Godot                                 | `tools/ui_screenshots.gd` (exists) promoted to a compared suite                | 1280 × 720, 1280 × 800 (Steam Deck), 1920 × 1080, 3840 × 2160, 720 × 1280; dark, light; native; opaque fallback                       | `sdks/godot/tests/ui/snapshots/`                                      |
| Qt, Tk                                | pytest-qt `grab()` / Tk `PhotoImage` export, offscreen                         | macOS, Windows, Linux variants; dark, light; native                                                                                   | `sdks/python/tests/ui/snapshots/`                                     |
| Terminal                              | Golden ANSI text + an SVG rendered by a real terminal (VHS) at line-height 1.2 | truecolor, ANSI-16, `NO_COLOR`, ascii; 80 and 60 columns                                                                              | `packages/sdk-node/test/cli/golden/`, `sdks/python/tests/cli/golden/` |

The fixture inputs are shared, so the same state is captured in every kit; a report page
(`pnpm ui:report`) lays the kits side by side per state for review. React and the elements share one
`styles.css` (adopted into shadow roots through `adoptedStyleSheets`) and one DOM / `data-part`
contract, and a **cross-renderer pixel diff** fails when the two drift.

### 7.2 Gates

- A changed baseline fails CI until re-recorded in the same change with the reason in the commit.
- axe (web), `AccessibilityTest` (Compose), XCTest accessibility audits (`performAccessibilityAudit`,
  iOS 17+), Godot focus-chain tests and contrast checks run on the same renders.
- The visual QA job runs per kit in that kit's existing CI lane; nothing joins the JS green gate
  except the JS kits.

### 7.3 The modernity lint

A small rule set encoding §1.5, run on the web kits' DOM and, where practical, on the other kits'
view trees.

**Borders, focus and depth:**

- no border wider than 1 px, and none of 1.5 px or more on a selected or resting control;
- no `box-shadow` spread ring on focus, and no focus ring outside `:focus-visible`;
- no coloured `box-shadow` under buttons.

**Type:**

- no `font-family` other than the theme's;
- no `font-weight: 700` outside the allow list;
- no text below 12 px, and no fractional px sizes;
- no `text-transform: uppercase` on buttons;
- no `vw` units in kit CSS (container units only);
- no orphaned last line in headings and ledes (a snapshot check over the baselines).

**Behaviour and code:**

- touch targets ≥ 44 px on touch variants;
- no `alert` / `confirm` calls;
- every interactive element has hover, active, disabled and focus-visible styles;
- no colour literal outside the generated tokens;
- one primary per region; no X beside a Cancel;
- every visible string is a catalog key (the **string lint** also diffs the visible strings of the
  same state across kits and mockup boards, allowing only the documented platform variants).

**Per-kit equivalents:**

- SwiftUI: no `.buttonBorderShape(.roundedRectangle)` override on iOS 26, and no filled secondary
  capsule;
- Godot: every engine control icon is set by the brand theme;
- Compose: no `Icons.Filled` from the legacy set, and no `OutlinedTextField`.

### 7.4 Design review

Each must kit's first full baseline set is reviewed against this document's mockups by a designer
(or the lead with the role agents) before release; the review notes go in the PR. The mockups are
the reference, so they must agree with this text. A disagreement between the two is a bug in one of
them, and it is fixed before review.

---

## 8. Mockups

HTML mockups of the key components in the Polaris look, rendered from the generated tokens
(`packages/brand/css/tokens.css`) with the kit fonts (variable Rubik, JetBrains Mono, and the
Material Symbols subset for Android) from `docs/design/ui-kits/fonts/`.

- **Sources:** `docs/design/ui-kits/{web,ios,android,desktop,windows,linux,godot,terminal}.html`.
  `shared.css` holds the kit primitives and maps §3 onto `--kit-*` vars; `shared.js` holds icons,
  the fake QR, product art, the countdown ring and the platform marks.
- **Render:** `NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs`. It writes
  every `[data-shot]` to `docs/design/ui-kits/shots/<board>-<shot>-<theme>.png` in both themes and
  fails on a console error or a font that did not load.
  - **Committed set:** 1x, lossless, with no resizing and no palette quantisation, so hairlines and
    type stay honest.
  - **Review:** `--scale=2 --out=<scratch>`.
- **Sizes:** every shot is drawn at a real size: web 1440 × 900 and 390 × 844 (with genuine container
  queries, not separate layouts), iPhone 402 × 874 pt, Android 412 × 915 dp, Mac and PC windows at
  their content size, Godot 1280 × 720 and 1280 × 800.
- **Fixtures** are fictional:
  - **Tidewater Studio** by Harbor Audio (web, Apple, Android, desktop, terminal). It sets no accent,
    so its teal is **derived from its icon**: this is the default look.
  - **Drift Kart** by Lanternworks (Godot). Its own accent, `#ff6a3d`, is light, so it shows the
    resolver's ink label.
  - The **user's organisation** is Fennick Studio; the shared device list is Work laptop, Mara's
    iPad and MacBook Pro.

#### Web (React and elements)

The theming board shows one component under four themes: the default (the product's derived
accent), opt-in Polaris violet, compact with a small radius, and the native preset taking the host's
font and `accent-color`. The state sheet covers rest, hover, pressed, keyboard focus, disabled and
busy, plus field errors and row states. The components board covers Boot, StatusScreen,
GraceBanner, Toast, Devices, Paywall and CloudSyncStatus; the layers board shows (b) and (c); the
motion board shows keyframes.

| Dark                                                     | Light                                                     |
| -------------------------------------------------------- | --------------------------------------------------------- |
| ![Gate](ui-kits/shots/web-gate-dark.png)                 | ![Gate](ui-kits/shots/web-gate-light.png)                 |
| ![Activate](ui-kits/shots/web-activate-dark.png)         | ![Activate](ui-kits/shots/web-activate-light.png)         |
| ![Sign in](ui-kits/shots/web-sign-in-dark.png)           | ![Sign in](ui-kits/shots/web-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/web-device-limit-dark.png) | ![Device limit](ui-kits/shots/web-device-limit-light.png) |
| ![Update](ui-kits/shots/web-update-dark.png)             | ![Update](ui-kits/shots/web-update-light.png)             |
| ![Settings](ui-kits/shots/web-settings-dark.png)         | ![Settings](ui-kits/shots/web-settings-light.png)         |
| ![Theming](ui-kits/shots/web-theming-dark.png)           | ![Theming](ui-kits/shots/web-theming-light.png)           |
| ![States](ui-kits/shots/web-states-dark.png)             | ![States](ui-kits/shots/web-states-light.png)             |
| ![Components](ui-kits/shots/web-components-dark.png)     | ![Components](ui-kits/shots/web-components-light.png)     |
| ![Layers](ui-kits/shots/web-layers-dark.png)             | ![Layers](ui-kits/shots/web-layers-light.png)             |
| ![Motion](ui-kits/shots/web-motion-dark.png)             | ![Motion](ui-kits/shots/web-motion-light.png)             |

At 390 × 844:

| Gate                                      | Sign in                                      | Device limit                                      | Settings                                      |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/web-gate-390-dark.png)  | ![](ui-kits/shots/web-sign-in-390-dark.png)  | ![](ui-kits/shots/web-device-limit-390-dark.png)  | ![](ui-kits/shots/web-settings-390-dark.png)  |
| ![](ui-kits/shots/web-gate-390-light.png) | ![](ui-kits/shots/web-sign-in-390-light.png) | ![](ui-kits/shots/web-device-limit-390-light.png) | ![](ui-kits/shots/web-settings-390-light.png) |

#### iOS 26 (SwiftUI, Liquid Glass)

The iOS board has the gate, the activate sheet with the iOS 26 keyboard, the sign-in method sheet over
the real gate, device limit, the non-blocking update banner, a mandatory update sheet, and account
settings.

| Gate                                  | Activate                                  | Sign in                                  | Device limit                                  | Update                                  | Update required                                  | Settings                                  |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------- | --------------------------------------------- | --------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| ![](ui-kits/shots/ios-gate-dark.png)  | ![](ui-kits/shots/ios-activate-dark.png)  | ![](ui-kits/shots/ios-sign-in-dark.png)  | ![](ui-kits/shots/ios-device-limit-dark.png)  | ![](ui-kits/shots/ios-update-dark.png)  | ![](ui-kits/shots/ios-update-required-dark.png)  | ![](ui-kits/shots/ios-settings-dark.png)  |
| ![](ui-kits/shots/ios-gate-light.png) | ![](ui-kits/shots/ios-activate-light.png) | ![](ui-kits/shots/ios-sign-in-light.png) | ![](ui-kits/shots/ios-device-limit-light.png) | ![](ui-kits/shots/ios-update-light.png) | ![](ui-kits/shots/ios-update-required-light.png) | ![](ui-kits/shots/ios-settings-light.png) |

#### Android (Compose, Material 3 Expressive)

The Android board shows the product icon in the adaptive mask, filled fields with the IME up,
Credential Manager first, the inline `LoadingIndicator`, connected lists, and a bottom sheet with
wavy progress and equal-width buttons.

| Gate                                      | Activate                                      | Sign in                                      | Hand-off                                             | Device limit                                      | Update                                      | Settings                                      |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/android-gate-dark.png)  | ![](ui-kits/shots/android-activate-dark.png)  | ![](ui-kits/shots/android-sign-in-dark.png)  | ![](ui-kits/shots/android-sign-in-handoff-dark.png)  | ![](ui-kits/shots/android-device-limit-dark.png)  | ![](ui-kits/shots/android-update-dark.png)  | ![](ui-kits/shots/android-settings-dark.png)  |
| ![](ui-kits/shots/android-gate-light.png) | ![](ui-kits/shots/android-activate-light.png) | ![](ui-kits/shots/android-sign-in-light.png) | ![](ui-kits/shots/android-sign-in-handoff-light.png) | ![](ui-kits/shots/android-device-limit-light.png) | ![](ui-kits/shots/android-update-light.png) | ![](ui-kits/shots/android-settings-light.png) |

#### macOS 26 (SwiftUI; Electron and Tauri on macOS)

The macOS board is drawn at Mac scale: the split Welcome window with product art, sheets attached
under the title bar, the single-column update window, and the Settings scene.

| Dark                                                         | Light                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| ![Gate](ui-kits/shots/desktop-gate-dark.png)                 | ![Gate](ui-kits/shots/desktop-gate-light.png)                 |
| ![Activate](ui-kits/shots/desktop-activate-dark.png)         | ![Activate](ui-kits/shots/desktop-activate-light.png)         |
| ![Sign in](ui-kits/shots/desktop-sign-in-dark.png)           | ![Sign in](ui-kits/shots/desktop-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/desktop-device-limit-dark.png) | ![Device limit](ui-kits/shots/desktop-device-limit-light.png) |
| ![Update](ui-kits/shots/desktop-update-dark.png)             | ![Update](ui-kits/shots/desktop-update-light.png)             |
| ![Settings](ui-kits/shots/desktop-settings-dark.png)         | ![Settings](ui-kits/shots/desktop-settings-light.png)         |

#### Windows 11 and GNOME (Electron, Tauri, Compose Desktop, Qt Quick)

The Windows board has a Mica window, a `ContentDialog` on a smoke layer, keyboard focus in the Fluent
ring, and a NavigationView settings page. The GNOME board has a header bar, a pill suggested-action
and an `AdwDialog`.

| Windows dark                                 | Windows light                                 |
| -------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/windows-gate-dark.png)     | ![](ui-kits/shots/windows-gate-light.png)     |
| ![](ui-kits/shots/windows-activate-dark.png) | ![](ui-kits/shots/windows-activate-light.png) |
| ![](ui-kits/shots/windows-update-dark.png)   | ![](ui-kits/shots/windows-update-light.png)   |
| ![](ui-kits/shots/windows-settings-dark.png) | ![](ui-kits/shots/windows-settings-light.png) |
| ![](ui-kits/shots/linux-gate-dark.png)       | ![](ui-kits/shots/linux-gate-light.png)       |
| ![](ui-kits/shots/linux-activate-dark.png)   | ![](ui-kits/shots/linux-activate-light.png)   |

#### Godot (Control nodes)

The Godot board (1280 × 720, plus 1280 × 800 for Steam Deck) uses dark by default: glass panels on a
scrim, the game's wordmark, a console focus ring with glow, monochrome input glyphs, a device-code
screen for TV, an in-race toast with the modal held for the results screen, and an Account tab in
the game's menu.

| Dark                                                       | Light (opt-in)                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| ![Gate](ui-kits/shots/godot-gate-dark.png)                 | ![Gate](ui-kits/shots/godot-gate-light.png)                 |
| ![Activate](ui-kits/shots/godot-activate-dark.png)         | ![Activate](ui-kits/shots/godot-activate-light.png)         |
| ![Sign in](ui-kits/shots/godot-sign-in-dark.png)           | ![Sign in](ui-kits/shots/godot-sign-in-light.png)           |
| ![Device limit](ui-kits/shots/godot-device-limit-dark.png) | ![Device limit](ui-kits/shots/godot-device-limit-light.png) |
| ![Update toast](ui-kits/shots/godot-update-toast-dark.png) | ![Update toast](ui-kits/shots/godot-update-toast-light.png) |
| ![Update](ui-kits/shots/godot-update-dark.png)             | ![Update](ui-kits/shots/godot-update-light.png)             |
| ![Settings](ui-kits/shots/godot-settings-dark.png)         | ![Settings](ui-kits/shots/godot-settings-light.png)         |
| ![Steam Deck](ui-kits/shots/godot-gate-deck-dark.png)      | ![Steam Deck](ui-kits/shots/godot-gate-deck-light.png)      |

#### Terminal (Node and Python CLIs, Textual)

The terminal board is drawn in a real cell grid at line-height 1.2, 80 columns. It covers
device-code sign-in with a half-block QR, masked key entry, the device-limit picker, status and
update progress, a blocked status with its fix as a command, grouped help, the four colour and
symbol fallbacks, a 60-column render and a Textual app.

| Dark                                                          | Light                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Sign in](ui-kits/shots/terminal-sign-in-dark.png)           | ![Sign in](ui-kits/shots/terminal-sign-in-light.png)           |
| ![Activate](ui-kits/shots/terminal-activate-dark.png)         | ![Activate](ui-kits/shots/terminal-activate-light.png)         |
| ![Device limit](ui-kits/shots/terminal-device-limit-dark.png) | ![Device limit](ui-kits/shots/terminal-device-limit-light.png) |
| ![Update](ui-kits/shots/terminal-update-dark.png)             | ![Update](ui-kits/shots/terminal-update-light.png)             |
| ![Status error](ui-kits/shots/terminal-status-error-dark.png) | ![Status error](ui-kits/shots/terminal-status-error-light.png) |
| ![Help](ui-kits/shots/terminal-help-dark.png)                 | ![Help](ui-kits/shots/terminal-help-light.png)                 |
| ![Fallbacks](ui-kits/shots/terminal-fallbacks-dark.png)       | ![Fallbacks](ui-kits/shots/terminal-fallbacks-light.png)       |
| ![60 columns](ui-kits/shots/terminal-narrow-dark.png)         | ![60 columns](ui-kits/shots/terminal-narrow-light.png)         |
| ![Textual](ui-kits/shots/terminal-textual-dark.png)           | ![Textual](ui-kits/shots/terminal-textual-light.png)           |

#### Critique round 1 (2026-10-05)

Six reviews (web, Apple, Android and desktop, Godot, Python and Node, and a cross-platform pass)
found the first boards structurally sound but dated in finish. These root causes were fixed in the
spec and in every board:

- **Weights:** everything was Bold, because only Rubik 400 and 700 shipped.
- **Accent:** Polaris violet stood in for the product's accent.
- **Fields and spinners:** boxed fields with Bootstrap focus halos, and stock ring spinners.
- **Seat meter:** solid red at 3 of 3.
- **Selection:** triple-encoded selected rows.
- **Button layout:** mixed button widths and doubled dismissals.
- **Copy:** drift between boards.
- **Scale and layout:** mobile-sized desktop controls and Sparkle-era update windows; no responsive
  or Windows and Linux boards; terminal shots that no terminal could draw.

**Still to draw before UK-01 closes** (§7.4 needs a reference for each):

- web: RTL, `forced-colors`, and the native preset at full screen;
- Apple: iPad regular width, visionOS, tvOS, the watchOS glance, the iOS 17–25 fallback, AX3
  Dynamic Type, StoreKit Paywall and the Live Activity;
- Android: tablet list-detail, the 200 % font stack, predictive back and dynamic colour under
  `native`;
- everywhere: the Boot, StatusScreen and error states on every non-web board;
- the Qt Quick and Tk widgets, rendered rather than borrowed from the web variants.

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
- **BRAND.md §4** (type): Rubik ships as a variable font with weights 400/500/600 in UI, and the
  kits' mono becomes JetBrains Mono (§2.1; §11 Q7).
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
approves §11 Q1, a stored product-presentation `accent` field (a catalog and portal API change, an
all-languages event).

### must

| Id    | SDK    | Framework                          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-01 | brand  | Tokens for every kit               | variable Rubik (wght 300–900) and the kit mono (JetBrains Mono) replacing the static 400/700 files, weight tokens 500/600, `typeScale`; `kit.ts` component tokens; `deriveAccent` and the white-first `resolveAccent` with shared vectors; new targets (CSS `kit.css`, JS, Python `_tokens.py` + QSS + ttk, ANSI for Node and Python, C#); Compose Resources fonts; Rubik TTFs for Python; `resolveAccent` with shared vectors; drift gate over all outputs; BRAND.md §7.1/§12/§12.1 and owner-decision updates (§9)                                                                                                                                                                                                            |
| UK-02 | shared | Copy catalog, fixtures, parity     | `packages/brand/kit-copy/` ICU catalog (~220 keys) with generators for JSON, xcstrings, Compose Resources, gettext, terminal; launch locale packs; `conformance/corpus/v2/ui/` state fixtures; the cross-kit string lint; `features.json` `ui.*` rows; remove the headless NA for Python and Node (plan mode)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| UK-03 | js     | ui-core                            | `@polaris-key/ui-core`: §4 state machines and actions over `client-core`, error → copy keys, theme resolution (preset, accent, scheme, density, motion), product identity resolution, the fixture runner; grows from `@polaris-key/react/core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UK-04 | js     | Web Components (Lit)               | `@polaris-key/elements`: every §4.1 component as `pk-*`, `::part`/slots/events, `@font-face` for Rubik and the kit mono with fallback metrics, the shared `styles.css` via `adoptedStyleSheets`, container-query layouts, native `<dialog>` + scrim, View Transitions, platform variants, CDN build; Playwright baselines; static and htmx samples                                                                                                                                                                                                                                                                                                                                                                              |
| UK-05 | js     | React                              | Rebuild `@polaris-key/react` on ui-core: Polaris look by default, class/`data-part` styling in `@layer polaris-key` (states, motion), scoped vars (no `:root` writes), `<PolarisKeyGate>` one-liner, every missing screen (device limit, handoff, progress, paywall, release notes, account, about, sync, toast, typed settings), `"use client"`, React 19 in CI, Vite + Next.js samples                                                                                                                                                                                                                                                                                                                                        |
| UK-06 | js     | Electron                           | `@polaris-key/electron`: `registerPolarisKey` (main, over `@polaris-key/node`), `exposePolarisKey` (preload), invoke routes for bridge v3, menu items, notifications, autoUpdater progress into UpdateProgress; Forge sample                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| UK-07 | swift  | SwiftUI iOS / iPadOS 26            | Rebuild `PolarisKeyUI`: pure-Swift presentation core running the fixtures, `@Observable` models with a status stream (no flash of wrong state, live updates), public components, `.polarisKeyGate`, glass on 26 with the iOS 17 fallback, capsule controls, sheets, String Catalog, typed errors, `#Preview` states, swift-snapshot-testing baselines; fixes "this Mac" copy                                                                                                                                                                                                                                                                                                                                                    |
| UK-08 | swift  | SwiftUI macOS 26                   | Settings scene pane, `CommandGroup`s (Check for Updates…, Manage License…, About), sheets instead of window takeovers, SwiftUI `SPUUserDriver` for Sparkle, the inactive-window prominent-button fix (no forced foreground), Mac baselines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| UK-09 | kotlin | Compose Multiplatform: Android     | `:ui` to KMP (`commonMain` + `androidMain`) on a version line decoupled from the Godot template pins; Material 3 Expressive (MotionScheme, LoadingIndicator, button groups, shapes, wavy progress), Material Symbols Rounded, adaptive layouts, `rememberPolaris*State`, ViewModel/SavedState, a navigation graph and deep links, `PolarisKeyGate` one-liner, missing screens; Roborazzi re-baselined                                                                                                                                                                                                                                                                                                                           |
| UK-10 | kotlin | Compose Multiplatform: Desktop     | `desktopMain`: the §1.4 desktop dialog model and the Windows/Linux/macOS variants, keyboard focus rings, desktop density, open-URL and theme `expect/actual`, Windows/macOS/Linux sample, desktop screenshot tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UK-11 | godot  | Control nodes (GDScript)           | Modernise in place: brand default (dark scheme), glass panel and `PKeySheet` host with scrim and the opaque fallback, `product.wordmark` and `typography.display`, `PKeyInputGlyphs` with the confirm swap, the console focus ring, type floor, toast anchor, UI sound hooks and haptics, MSDF fonts and `ui_scale`, every engine control icon themed (switch, spin, option, scrollbar, slider, tab), elevation, 60 px controls, icon set, Tween motion with reduced motion, OS dark-mode follow, safe areas, AccessKit names and live regions; new scenes (DeviceLimit, Devices, Paywall, Account tab, CloudSyncStatus, About, Toast, UpdateProgress, ReleaseNotes); copy fixes (no raw codes or slugs); POT export; baselines |
| UK-12 | python | ui-core + Qt (PySide6, PyQt6)      | `polaris_key.ui.core` view models (fixtures, UI-thread hook) and `polaris_key.ui.qt` Qt Quick screens (QWidget parts as layer b) with generated QSS, bundled Rubik, Linguist catalogs from UK-02, `QAccessible`, `run_gate`; `[qt]` extra; PySide6 sample; pytest-qt baselines; Python `parity.json` `ui.*` proofs                                                                                                                                                                                                                                                                                                                                                                                                              |
| UK-13 | python | Terminal (rich, Textual)           | Restyle the CLI core with rich (ANSI-16 status roles with a truecolor product chip, 80-column layout degrading to 60, continuous rails, braille spinner, half-block QR, OSC 8 links and OSC 52 copy, terminal QR for `begin_sign_in`, device-limit picker), error-code → copy mapping, `--json` on every verb, `NO_COLOR`/ANSI-16, optional Textual app; golden tests                                                                                                                                                                                                                                                                                                                                                           |
| UK-14 | node   | Terminal (CLI prompts, `pkey`)     | Restyle the sdk-node CLI and `pkey` to the §1.4 terminal row (ANSI-16 roles, 80 columns, half-block QR, OSC 8/52): clack-style prompts, masked key entry (fixes the positional `activate <key>` leak), spinners and progress for sync, packs and publish, terminal QR, `--json`, grouped help, completion, `pkey init --help` and `validate <path>` fixes; golden tests                                                                                                                                                                                                                                                                                                                                                         |
| UK-15 | shared | Visual QA harness + modernity lint | `pnpm ui:report` side-by-side report from every kit's baselines; the React/elements pixel diff; the §7.3 lint (including the string lint and the orphan check) for web kits and the per-kit equivalents; CI wiring per lane; designer review checklist                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| UK-16 | docs   | Docs section + samples hub         | `build/ui/` section (overview, theming, a page per component with baseline images, a page per framework, localisation, recipes), `examples/ui/` index, kit READMEs slimmed; the docs drift gates for the new routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
| UK-30 | python | Tkinter (ttk)          | Image-element ttk theme; gate, activation, device limit and update prompt over ui-core; `tk.after`; sample and snapshots                                                                           |

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

1. **Product accent at the source.** Kits now derive the accent from the product icon at runtime
   (§3.3), which needs no wire change. Should the console also let a developer **set or override**
   the accent on the product's registered presentation (served with G1), and store the derived
   value at registration so the portal matches? That is a catalog and API addition, so it would be an
   all-languages, plan-mode change.
2. **The no-icon fallback.** With neither an accent nor an icon, the spec uses a neutral ink primary
   (the Linear and Vercel look) rather than Polaris violet, so an unconfigured product never reads as
   a Polaris product. Keep ink, or fall back to core violet?
3. **Launch locales.** English plus de, fr, es, pt-BR, it, ja, ko, zh-Hans and ar (§4.7)? Arabic
   brings the RTL pass into the must items.
4. **OS floors.** Keep iOS 17 / macOS 14 with Liquid Glass on 26 (§5.1), or raise the Apple floor to
   iOS 18 / macOS 15 to cut the fallback path?
5. **Lit for the elements.** Lit 3 (about 6 KB, mature SSR story) or dependency-free custom
   elements? The spec assumes Lit.
6. **Rubik on Apple platforms.** Rubik everywhere keeps one identity but gives up SF's optical sizes.
   The spec keeps Rubik and scales it with `UIFontMetrics`. The alternative is SF for body and
   controls under the Polaris look, with Rubik only for display titles. Which do you want?
7. **The kit mono.** Ship JetBrains Mono (OFL, about 31 KB latin) as the kits' mono for keys and
   codes, so they look the same on every OS? Geist Mono is the alternative. Either needs a BRAND §4.6
   update, because today's mono is the platform's.
8. **Device-code vanity URLs.** A product `deviceCodeUrl` (`driftkart.gg/tv`) puts the product, not
   Polaris Key, on the TV sign-in screen. It needs the developer to redirect that URL to the hosted
   device page, plus a portal field. Accept it as a should item?
9. **Games default to dark.** The Godot kit defaults `colorScheme` to `"dark"`, with light opt-in,
   because games follow their art and not the OS. Agreed?
10. **Service cues.** The spec now turns service cues off on product-facing screens (opt-in only),
    reversing the first draft. The console keeps them. Agreed?

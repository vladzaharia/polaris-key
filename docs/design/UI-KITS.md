# Polaris Key UI kits: one design system for every SDK

**Status:** approved, 2026-10-05, after two critique rounds (§8) and the owner decisions below. Design
spec plus build plan; nothing here is implemented yet. The build items of §10 are work packages in
phase UK of the execution program
([`workpackages.json`](../research/2026-09-29-godot-omniplatform/program/workpackages.json), briefs in
[`program/wp/UK-*.md`](../research/2026-09-29-godot-omniplatform/program/wp/)).

## Owner decisions (2026-10-05)

The owner answered §11 on 2026-10-05 and delegated the remaining choices to the lead, who took the
recommended option in each case. **These decisions win over the sections below where they differ**;
the sections have been edited to match.

| Topic                                       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch locales (§11 Q3)                     | English, `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`. **No Arabic yet**, so the RTL pass moves from must to later: layouts stay RTL-safe (logical properties, leading/trailing, mirrored-icon flags in the icon set, checked by a §7.3 lint), but there are no RTL baselines and no RTL QA gate until a right-to-left locale is scheduled.                                                                                                                                                                                                                                                                                                                       |
| Apple floors (§11 Q4)                       | **iOS 18, iPadOS 18, macOS 15, tvOS 18, visionOS 2, watchOS 11** (the 2024 releases). Liquid Glass on the 26 releases; a polished, designed fallback on the 18-era releases (same layout on system materials, reviewed against its own baselines). **No iOS 17 / macOS 14 fallback work.** UK-07 raises the floors in `sdks/swift/Package.swift`.                                                                                                                                                                                                                                                                                                                           |
| Web components (§11 Q5)                     | **Lit 3** (`@polaris-key/elements`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Product accent and icon (Q1)                | Come from the product's **registered presentation**: [HA-04](../research/2026-09-29-godot-omniplatform/program/wp/HA-04-manifest-presentation.md) (manifest `presentation { icon, accent, accentDark }`) and HA-11 to HA-14 (discovery `core.presentation`, the SDK accessors and the kit defaults) deliver it. SP-11 was dropped in their favour. Kits default to it with **zero integrator code**. The UK items consume the SDK's presentation accessor through one `ProductIdentity` seam and **must not invent a separate path** (no kit-side discovery fetch, no second icon cache). Icon-derived accent (§3.3) stays as the fallback when presentation has no accent. |
| Python UI                                   | **Qt plus the terminal. No Tk.** UK-30 (Tkinter) is dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Kotlin JVM desktop                          | **Full parity:** the Compose Desktop kit (UK-10), an OS keyring store and a desktop updater driver (UK-40, which is SP-K12 of `notes/SDK-PARITY-PASS.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kept as specified                           | The product is the hero (§1.2); three layers in every kit (§1.3); the made-in-2026 look and its hard rules (§1.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Optional SDKs                               | X-01 (C#/.NET SDK) and X-02 (native Rust Tauri plugin) **stay optional**. UK-21's Tauri bridge stays a **should** and does not depend on X-02: it is a thin plugin over a `@polaris-key/node` sidecar. UK-29's Godot C# facade wraps the GDScript kit and does not depend on X-01.                                                                                                                                                                                                                                                                                                                                                                                          |
| No-icon fallback (Q2, lead)                 | **Ink** primary, as specified. Never Polaris violet by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Rubik on Apple (Q6, lead)                   | **Rubik everywhere**, scaled with `UIFontMetrics` / `.relativeTo:` for Dynamic Type; SF only under `native`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Kit mono (Q7, lead)                         | **JetBrains Mono** (OFL); BRAND §4.6 is updated in UK-01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Device-code URL (Q8, lead)                  | Kits honour an integrator-set `product.deviceCodeUrl` now (theme value, no wire change). A presentation-level field is deferred as a known gap for a later HA follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Games dark (Q9, lead)                       | **Agreed:** the Godot kit and TV default to dark; light is opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Service cues (Q10, lead)                    | **Agreed:** off on product screens, opt-in only; the console keeps them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Copy source (lead)                          | `conformance/parity/copy.en.json` (SP-00, `core.copy`) stays the one source for error and gate copy. `packages/brand/kit-copy/en.json` holds kit-only strings and references `core.copy` keys by name, never a duplicate. UK-02 plans both generators together.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Hosting (lead)                              | No new domain. The elements CDN module is served by the Worker at `key.plrs.im/elements/<major>/pk.js` (immutable, with published SRI) (the shadcn registry route went with UK-22, dropped); the elements route has the rule-10 gate. (The docs site sits behind the admin session gate, so it cannot host them.)                                                                                                                                                                                                                                                                                                                                                           |
| Translations (lead)                         | The eight non-English packs are produced in UK-02a against a glossary and marked `reviewed: false`; a native-speaker review is a release follow-up, not a merge blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| One sign-in form (owner, 2026-10-05)        | "Let's make 'Finish in your browser' not a popup and instead just replace the login part … Just have a very consolidated system." Every kit has **one sign-in form** whose body morphs in place through Sign in → Finish in your browser (or the code) → Choose a license (→ Replace a device) → Done (SIGN-IN.md O-13, §3.17). No sheet or dialog stacks on it. This replaces §1.4's desktop dialog model for sign-in.                                                                                                                                                                                                                                                     |
| Native and configurable (owner, 2026-10-05) | "I do like the native elements still, so you know, make it reasonable and configurable." One option in every kit, `presentation: "inline" \| "sheet" \| "browser"` (default inline), and `replace: "inline" \| "browser"`. Native controls stay native inside the form, including the system confirmation for a destructive Replace where the platform expects one (SIGN-IN.md O-14, D-79, D-80).                                                                                                                                                                                                                                                                           |
| Two ways to integrate (owner, 2026-10-05)   | "We should have a completely integrated sign in/license activation web system, but also the UI kit and primitives necessary for doing it natively instead." Path A is the hosted card (zero UI code, the `browser` presentation); path B is the kit's form (layers a and b) and the headless model plus SDK primitives (layer c) (SIGN-IN.md O-15, §2.4; §1.3 below).                                                                                                                                                                                                                                                                                                       |
| Motion (owner, 2026-10-05)                  | "Animations are going to be key here. I want this experience to feel modern, especially the web one." Sign-in's motion patterns and tokens are SIGN-IN.md §3.18, mapped per platform in §4.8; S-23 makes them the shared system in `packages/brand` (SIGN-IN.md O-16).                                                                                                                                                                                                                                                                                                                                                                                                      |

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
Compose Desktop, Android Views, Qt, the terminal and more). It covers the default look
(§1), tokens (§2), the theme API (§3), the component catalogue (§4), the framework matrix and
architecture (§5), samples and docs (§6), visual QA (§7), the mockups (§8), what it supersedes (§9),
the build plan (§10) and the answered questions (§11).

**Relationship to the other specs.** [BRAND.md](BRAND.md) stays canonical for tokens, accents, marks
and type. `EXPERIENCE.md` (on the `brand/experience-spec`
branch when this was written, landing beside this file) and [PORTAL.md](PORTAL.md) stay canonical for the
web portal and console. Source precedence: owner decisions and the platform contract, then these design docs, then accepted mockups, then guide studies. A study enters only as a mockup with status `proposal` until the owner accepts it, and no API, entitlement or permission is derived from a mockup (§7.4). This document borrows their flows (the one login card, the device-limit
flow, the confirmation levels, the copy rules) so a person moving between an app, the portal and
the console meets one system. Where this document and BRAND §12.1 disagree, **this document wins**
(§9).

**Evidence.** Five audits on 2026-10-05 against `main` @ 248fef64. Every kit was built and rendered;
the screenshots are under `/private/tmp/claude-501/ui-kit-audit/` (`react/` 36 renders, `swiftui/`
48 macOS and iOS 26 renders, `compose/` the 136 Roborazzi baselines plus the verify log, `godot/` 428
renders at five sizes, `gaps/` the Python and Node CLI output). Findings below cite them as **RE**
(React), **SW** (SwiftUI), **KO** (Compose), **GO** (Godot) and **GA** (gap audit).

### Contents

[Design language (v2)](#design-language-v2-2026-10-08) ·
[1. The Polaris Key default look](#1-the-polaris-key-default-look) ·
[2. Tokens in every kit](#2-tokens-in-every-kit) · [3. One theme API](#3-one-theme-api) ·
[4. The component catalogue](#4-the-component-catalogue) ·
[5. Frameworks and architecture](#5-frameworks-and-architecture) ·
[6. Samples and docs](#6-samples-and-docs) · [7. Visual QA](#7-visual-qa) ·
[8. Mockups](#8-mockups) · [9. What this supersedes](#9-what-this-supersedes) ·
[10. Build plan](#10-build-plan) · [11. Questions for the owner](#11-questions-for-the-owner)

---

## Design language (v2, 2026-10-08)

The six built kits (React, SwiftUI, Compose, Godot, and the Node and Python terminals) went through
multi-reviewer UX rounds on 2026-10-08. What those reviewers demanded and the builders shipped is
now the language of every kit (owner, 2026-10-08: "extend this design language to all the other UI
kits"). These rules add to §1.5 and win over §1–§8 where they differ; the owner decisions above
still win. Where §1.5, §2.1, §4 or §7.1 already fixes a measure, the rule points there instead of
repeating it. How each kit applies the rules, and its minimum checks, are in the
[application matrix](UI-KITS-LANGUAGE-MATRIX.md). UK-55 turns the mechanical rules into lint;
UK-56 redraws the boards of the platforms that have no built kit yet.

Each rule says how it is tested, why it exists, and which reviewed screens set it. Evidence ids name
the built screens of those rounds (for example `compose.sign-in`); the rule is what the review
accepted for them. A measure without a unit is in logical pixels (dp on Android, pt on Apple).

**DL1. Layout follows the container's shape, not the device.** The arrangement is a function of the
kit root's measured size, never of the device class, the OS, the input or the keyboard.

- **Landscape:** two panes for screens with a control group (Welcome and activation, the sign-in
  code view, device limit, revoked). The start pane is the identity panel (the passport): the
  product art when set, otherwise the icon on the accent `subtle` ground (light) or the icon
  ambient (dark), and under `native` a `surface-sunken` panel with the icon only. It holds art or
  icon and nothing that repeats the end pane. The end pane holds the title, lede and act,
  top-aligned with the panel's content, never centred in empty space; the product name appears
  once (DL5). A key field that middle-ellipsizes in the end pane is at least 28rem wide. When the
  layout goes to one column the panel collapses to a one-line header strip. The panes are
  top-aligned to each other, the row is centred and capped at about
  1040, with a 48 gutter. A message screen (a sentence and its actions) never splits: it is one
  block at most 560 wide, with its actions in a trailing row.
- **Short landscape** (under 30rem tall): two columns as well, with no inner scroll. If it still
  overflows, the window scrolls and the start column sticks, so the title stays in view.
- **Tall:** content top-anchored under a fixed inset, the heading block near the upper third
  (spacers 1:2), actions docked at the bottom safe area and riding above the keyboard.
- **Tablet portrait and 4:3:** one centred column of about 480–600, in the tall form; never two
  narrow panes.
- **Large windows:** a sheet-scale surface (the two-pane row, or the 560 card) on the product
  ambient, at the platform's desktop type scale; never a phone column on a bare page, never
  stretched to the window.
- **No floating void:** identity heads the screen and the content is anchored; no screen is one
  sentence afloat in empty space.
- Focusing a field or raising the keyboard never changes the arrangement or rebuilds the field; a
  covered field scrolls into view.

A new kit starts from the Compose rule, the most general one (two panes at compact height under
480, on TV, or from 840 wide at 1.4:1, never under 560 wide), and records its own thresholds in its
tests. _Test:_ at every §7.1 row, the title and the primary are inside the first viewport, no
control is partly scrolled away, and the arrangement matches the shape, asserted directly rather
than through the kit's own layout metrics. _Why:_ portrait cards scrolled the title away in
landscape, phone columns floated on wide pages, and a keyboard dropped as the page re-laid out.
_Evidence:_ `compose.sign-in`, `react.license-gate.login`, `swiftui.gate`, `godot.gate`.

**DL2. Interruptions sit over the app; blocking screens own the window; panes join the host.**

- A dismissible interruption (an optional update, sign-in or offline activation opened from
  settings, any dialog over a running game) is a card over the §2.1 scrim with the host visible
  behind it, and a bottom sheet below a 560 container. The host is inert, Escape, B or Back
  dismisses it, and focus returns to the opener.
- A blocking gate (boot, sign-in before first use, a mandatory update) owns the window on an opaque
  ground with the product ambient.
- Sign-in and activation are inline by default (D-79): their steps morph in the form. A sheet is
  the labelled alternative, `presentation: "sheet"`; boards draw the inline step as the primary
  shot and caption the dialog shots with the option.
- An embedded pane (devices, settings, sign-out) starts at the host's start edge, is at most 40rem
  wide, never centres itself, and offers `bare` to drop its own frame. Its controls have opaque
  fills, so their contrast never depends on the host's ground.

_Test:_ the scrim, `inert` and focus return asserted on every dismissible state; contrast checked
on a light and a dark host. _Why:_ optional prompts were opaque takeovers, and Sign out measured
1.04:1 on a light host. _Evidence:_ `react.update-prompt.dialog`, `godot.update.modal`,
`react.polaris-logout`.

**DL3. One spacing scale, with density steps.** Every margin, padding and gap is a `--pk-space-*`
step (BRAND §4.6; the 2 and 6 steps only inside a control) or a `kit.ts` component token, in any
unit. Density (§3.1) moves control heights and gaps by whole steps; Godot and TV default to
`spacious`. When a screen does not fit, it gives way in this order and stops as soon as it fits:
decoration (hero size, ambient), then secondary lines (a device echo, a drop hint, an optional
subtitle, the code check line), then the QR toward its minimum (DL14), then the actions under both
columns, then the product header to its one-line form, then one density step, and only then a
scroll. The title, the code, the URL, the primary and the key hints never give way, and type never
shrinks below its floor to make room. _Test:_ UK-55 `spacing-off-scale`; the §7.1 renders. _Why:_
the owner's "Spacing. Spacing. Spacing.": one rhythm is what makes ten kits read as one product.
_Evidence:_ `godot.sign_in`, `godot.activation.device_limit`, `swiftui.gate`,
`terminal.node-login-code`.

**DL4. One primary per screen; everything else recedes.**

- Exactly one filled (prominent) control at a time. It follows the state: Sign in on an empty
  Welcome, Activate once a key is typed, the fix once a refusal arrives (DL6). A lone action is
  always the primary.
- Secondaries are tonal or bordered, never bare text when paired; tertiary actions (Activate
  offline, Copy diagnostics) are text links at the foot. No "or" dividers.
- Groups follow §1.5 rule 10. A group that does not fit stacks whole, never 2 + 1.
- A busy control keeps its label and its focus (DL9) and adds the indicator.

_Test:_ `one-primary` on every fixture render. _Why:_ after a refusal the way out was the weakest
button, and Welcome showed two primaries. _Evidence:_ `swiftui.gate`,
`compose.gate-device-limit-manage`, `react.license-gate.device-limit`, `godot.gate`.

**DL5. The product is the identity.** Every gate, sign-in, update, settings and status screen is
headed by the product's icon, or its monogram (the initial at weight 600 on `surface-sunken`, in the
platform's icon shape), and its name in `text-strong`, at one size per context (§1.2). The name
appears once per screen, in the title when the title names the product and otherwise once
under the icon; a split's identity panel holds art or icon only (DL1). At short heights the header
collapses to one line; it is never removed. The Polaris mark appears only in the opt-in Powered-by
line or badge (§1.6). _Test:_ UK-55 `polaris-mark`; the header present at every §7.1 row. _Why:_ the
Pinned K stood in for the product, and phone screens had no identity at all. _Evidence:_
`compose.sign-in`, `react.license-gate.login`, `godot.activation.device_limit`, `swiftui.gate`.

**DL6. A refusal the person can resolve is a neutral callout, and its fix is the primary.** This
covers device limit, revoked, expired, version too old or too new, and channel not entitled.

- The callout sits under the control it concerns, in default text on the sunken surface: no danger
  colour, no `aria-invalid` on a valid key, no error glyph. A full license is a limit, not an
  error (§1.5 rule 9). This replaces the danger-subtle callout of the SwiftUI fix round.
- The fixing action is the screen's only primary and takes focus. A fix that leaves the app carries
  the new-window glyph (never an ellipsis, §1.5 rule 11), and on return the kit retries once.
- Every blocking state has an action that can change its outcome: revoked shows the sign-in
  methods, expired offers another license. A fix the kit cannot reach is named in words, and Try
  again stays.
- In a terminal a refusal is ▲ with its fix, never ✗. A refused gate in a host CLI exits 4 and
  `status` exits 1 (UK-51).

_Test:_ UK-55 `refusal-styling` on the refusal fixtures. _Why:_ the device limit looked like an
error with its fix as the weakest button, and revoked was a dead end. _Evidence:_
`react.license-gate.device-limit`, `compose.gate-device-limit-manage`,
`godot.activation.device_limit`, `react.license-gate.revoked`, `compose.gate-revoked`.

**DL7. Errors sit under the control that caused them, and every state is designed.**

- Each action has its own message slot directly under it: key errors under the key field, sign-in
  errors under Sign in, a row's error in its row. Only an input that is itself wrong takes
  `aria-invalid` and the danger stroke. The message is announced, focus moves to it or to its
  field, and it clears on edit or on a new attempt.
- A failed load is an error state with Try again, never an empty state. An unknown code shows the
  catalog's fallback sentence.
- Loading shows nothing for the first 250–300 ms, then the identity, a muted label and the 2 px
  shimmer (§1.5 rule 4). A determinate bar appears only for counted bytes; Boot never draws a
  part-filled bar for a stage.
- Cancelling is not an error: the flow closes with no "cancelled" screen. Expired, denied and
  failed keep a result with the action that starts again.

_Test:_ a render per fixture state; announcement and focus assertions. _Why:_ errors appeared at the
top of panels or under the extras, and a failed load claimed "No devices". _Evidence:_
`react.device-manager.load-error`, `swiftui.gate-limit`, `godot.gate.error`,
`react.license-gate.loading`.

**DL8. Copy is verbatim from the catalogs, says each fact once, in the reader's terms.** Every
visible string is a key of `packages/brand/kit-copy/` or `core.copy` (§4.7). A kit never writes a
string; a missing one is a catalog change for every kit. Platforms vary only the verb and the casing
(§1.5 rule 11). No lede restates the buttons, no body repeats its title, and no caption under a
meter repeats the count its title gives. Titles name the state ("Code expired", not "Sign in"). No
raw codes, slugs or platform ids (`macos` is macOS), and `{product}` wherever "the game" or "this
app" would go. _Test:_ the string lint (§7.3); UK-55 `catalog-string` over native sources. _Why:_
copy had drifted between kits ("Retry" beside "Try again", raw ranges, "sign in" three times on one
screen). _Evidence:_ `react.license-gate.expired`, `compose.gate-expired`,
`terminal.node-status-none`, `godot.update.modal`.

**DL9. Focus is always somewhere useful, and visible where it must be.**

- **Initial focus on every screen:** the primary, or the first sign-in method on the gate. A
  dialog that interrupts play focuses Later and ignores input for 250 ms (§4.3). On a coarse
  pointer a text field is never focused on appear. After pointer input a game focuses nothing, and
  the first D-pad or arrow press focuses the initial control. On TV and pad-only devices the first
  focus is never a control that opens a browser.
- **Never lost across async work:** a busy control keeps focus (`aria-disabled`, not `disabled`).
  After a result, focus goes to the error's field or to the next screen's initial control; after a
  removal, to the next row or the heading. A closing dialog returns focus to its opener, and
  Escape, B or Back always backs out.
- **A visible ring:** on pointer platforms on keyboard focus only (no ring at rest on a cold
  start); on D-pad, gamepad and TV always, 3 px at a 2 px offset at TV distance, at least 3:1
  against both the control and the ground, in the resolved accent's `focus`, with the focused TV
  control lifted (scale up to 1.05, or the platform's focus effect). Under `native`, a host ring
  thinner or fainter than that gives way to the kit's.

_Test:_ per-kit focus tests (a cold start with no pointer lands inside the screen; after each async
action a control inside has focus); UK-55 `initial-focus`. _Why:_ focus fell to the page after
Activate, Save and Sign out, gamepads got none, and the first-focused TV button crashed a TV with no
browser. _Evidence:_ `compose.focus`, `godot.gate`, `react.license-gate.login`,
`react.device-manager.rename`.

**DL10. Targets and type have platform floors.** Targets, controls and the Godot and TV type floor
are §1.5 rule 5 and §2.1 (`controlHeight`); the web floor is §7.3's 12 px. A compact control still
reaches 2.75rem on a coarse pointer. On phones body text is at least 16 dp and controls at least
48 dp (44 pt), computed from the screen's real density in engines that see only pixels. The 16 px floor is for phones, tablets and the web; desktop kits use the platform body size, which
the OS text-size setting scales (DL11). A user code
is never smaller than the title beside it. _Test:_ matrix assertions on every control and text run.
_Why:_ a Godot game on a phone drew 12 dp body text and 37 dp buttons. _Evidence:_ `godot.sign_in`,
`swiftui.signin`.

**DL11. Text scales with the person's setting, everywhere.** Web kits size type and breakpoints in
rem (fluid type in container units, never `vw` or px); Apple kits scale Rubik with `UIFontMetrics`
or `relativeTo:` to AX5; Compose uses sp with the system's non-linear scale and never overrides
`Density`; Qt uses point sizes and the font scale; Godot applies its 0.75–2 scale ladder and the
content scale; terminals reflow at the terminal's size. At large text a screen gives way in the DL3
order and wraps. It never clips, never cuts a key or a code inside a group (a code breaks at its
hyphen), and never hyphenates a URL. _Test:_ the §7.1 200 % row; UK-55 `px-font`. _Why:_ at AX3 URLs
broke mid-word and the offline request code was cut with an ellipsis. _Evidence:_
`swiftui.signin-long`, `swiftui.offline`, `react.license-gate.login`.

**DL12. Three weights.** 400 for body and row titles, 500 for labels, buttons and the product header,
600 for headings; 700 only in the game wordmark fallback (§1.5 rule 6). The variable Rubik draws
them, and the CJK fallback has its own 600 face, so `ja`, `ko` and `zh-Hans` headings stay
headings. _Test:_ UK-55 `weights`. _Why:_ every Compose title was bold, and Japanese titles rendered
at body weight. _Evidence:_ `compose.sign-in`, `godot.gate`.

**DL13. Two presets: `native` follows the host, `polaris-key` resolves the product accent.**

- **`polaris-key`:** the product accent through the contrast resolver (§3.3) for every role:
  `solid` for fills only, `fg` for accent text and glyphs, `on`, `subtle` and `focus`. Never violet
  by default.
- **`native`:** the host's scheme (`system` resolves against the ground the kit sits on, not only
  the OS), tint, shapes, fonts and control styles (macOS rounded-border fields and link-style
  extras, Fluent, libadwaita, Material dynamic colour). The resolver still runs against the host's
  surfaces, so text keeps 4.5:1 and fills 3:1. Status colours stay the brand's. A host theme with
  an empty or transparent panel still gets a ground.
- **Provider buttons** take the theme's radius, height and density and keep each provider's own
  fill and logo (§3.6). Polaris chrome's ink action never applies inside the kits: a kit primary is
  the product accent's solid, or ink when the product has no accent.
- **Both presets** keep the platform idiom: title case and the default-button order on macOS,
  Return and Escape bound to the primary and Cancel, a lone Android Cancel as a centred text
  button, B on consoles.

_Test:_ every §7.1 row in both presets; contrast on every render; a host-accent scene on a custom
host ground. _Why:_ violet stood in for the product, and native screens were unreadable on light
hosts and light game themes. _Evidence:_ `compose.accent`, `react.system-on-light-host`,
`godot.settings`, `swiftui.signin`.

**DL14. QR codes and links fail closed.**

- **Where:** a QR appears only where the device cannot browse: TV, console and pad-only screens,
  and an offline-activation request. Never on a phone, and never on a desktop surface (SIGN-IN.md
  D-67), which retires the old web QR beside the code. Not on a tablet either: the Godot kit's desktop
  and tablet QR is removed, and Godot shows one only pad-only. A phone leads with Open browser,
  then the code with Copy. Terminals draw no QR for sign-in or the device limit; the offline
  request gets a half-block QR where the whole screen fits.
- **Size:** at least 160 physical px and at most 42 % of the short side, one size per kit, on a
  92 % white tile with an 8 px quiet zone (and a hairline in light), its modules scaled by a whole
  factor, always beside the URL and the code in text.
- **Content:** the QR, Copy and the visible text carry exactly the same code or link.
- **Links:** only https links the server or the integrator supplied (`deviceCodeUrl`,
  `verificationUri`, `manageUrl`, a release URL); the loopback redirect is the one http exception.
  Every link passes the kit's one validating opener before it is shown, encoded or opened. A
  missing or invalid link hides its control and its QR and leaves the rest of the screen working; a
  kit never makes up a URL. When the opener fails, the screen stays and shows
  `signin.handoff.noBrowser` with Copy link.
- **Expiry:** at 0:00 the code view switches to expired locally while any poll finishes.

_Test:_ UK-55 `link-validation`; QR size assertions per row; a no-browser test; a countdown-at-zero
test. _Why:_ a QR was the hero on the phone itself, Copy carried a different code than the one
shown, and Open sign-in page crashed a TV with no browser. _Evidence:_ `compose.sign-in`,
`godot.sign_in`, `swiftui.offline`, `godot.activation.device_limit`.

**DL15. Every screen passes the size matrix.** The rows are §7.1's (GUI and terminal), in both
schemes and both presets. A kit adds its platform's own rows (keyboard up, split screen, overscan,
resize sequences) and never drops one. _Test:_ the kit's matrix suite. _Why:_ the owner's
"responsive, with landscape layouts where the window is landscape". _Evidence:_ the matrix suites
of the six built kits.

**DL16. Motion and transparency follow the person's settings.** Motion is §4.8: under reduced motion
every duration is 0 with no fade, and the shimmer and busy indicators hold still (the countdown
steps once a second). Reduced transparency makes every glass surface and scrim opaque (§4.4).
_Test:_ the reduced-motion and reduced-transparency renders. _Why:_ motion is part of the product
(owner, 2026-10-05), so the setting that turns it off must turn all of it off. _Evidence:_
`react.license-gate.loading`.

**DL17. Content stays inside the safe area.** Content and docked actions stay inside the insets: the
notch and home indicator, game title-safe 5 %, and TV overscan (48 horizontal and 27–32 vertical on
Android TV; the system's elsewhere). A full-bleed surface's ground and bottom padding run past its
content's end by the inset, and docked actions ride above the on-screen keyboard. _Test:_ the inset
rows (notched phones, TV) assert no control inside an inset. _Why:_ full-bleed cards ended above
their own padding, and TV screens had no overscan margin. _Evidence:_ `compose.sign-in`,
`godot.gate`, `react.license-gate.login`.

**DL18. One line to drop in, then customise.** The drop-in is the one call of §4.2, and it runs every
state with no integrator layout code; the theme (§3) and copy overrides customise it; the styled
parts and the headless model (§1.3) rebuild it. Nothing in DL1–DL17 needs integrator code to hold.
_Test:_ the sample integrates in §4.2's line count, and the matrix renders the drop-in itself, not a
test layout. _Why:_ "as easy to drop in (piecemeal or whole) as possible" (owner brief). _Evidence:_
the §6.1 samples.

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
  presentation (discovery `core.presentation`: name, `developerName`, `accent`, `accentDark` and the
  icon verified by its `sha256`; the same data the portal shows), then the bundle (app
  name and icon from `Info.plist`, the Android manifest, `package.json` `productName`, Godot's
  `application/config/name` and icon). With no icon at all the kit draws a **monogram tile**: the
  product's initial in Rubik 600 on neutral `surface-sunken`. It never falls back to a Polaris Key
  mark and never uses violet.
- **One path for presentation.** The presentation is declared in the manifest (HA-04), served in
  discovery (HA-11, HA-12) and read, fetched, verified and cached by each SDK (HA-13, HA-14). Every
  kit reads it through its core's `ProductIdentity` resolver, which takes a presentation source from
  the SDK. Kits never fetch discovery or the icon themselves. Until an SDK ships its accessor, the
  source is empty and the kit falls through to the bundle, so kits do not wait for HA-13 or HA-14.
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
  1. the integrator's colour; otherwise the product presentation's `accent` (its `accentDark` in
     the dark scheme, when set), with zero integrator code;
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
  - the sign-in footnote "Polaris Key signs you in for <App>. <Developer> never sees your codes or
    passkeys." (`signin.footer`, SIGN-IN.md D-15);
  - the device-code URL. The product's `deviceCodeUrl` (for example `driftkart.gg/tv`) is used when
    set, otherwise `key.plrs.im/tv` on TV and console and `key.plrs.im/device` in desktop and
    phone hand-offs (SIGN-IN.md D-16; `/activate` is only the license-key route).
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

**Sign-in and activation in three layers** (owner, 2026-10-05; SIGN-IN.md §2.4, §3.17). The one
sign-in form is the drop-in; its steps are the styled parts; `SignInModel` over the SDK primitives
is the headless layer. **Activation** (the key) is a step of the same form (`Activate`, reached
from **Have a license key?** or **Use a license key instead**) and also ships on its own for a
key-only app. `presentation` and `replace` take the same values everywhere.

| Kit                        | (a) Drop-in form                                                                  | (b) Styled parts (the steps)                                                                                                       | (c) Headless                                                       |
| -------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| React                      | `<SignIn presentation="inline" />`, or inside `<PolarisKeyGate>`                  | `<SignInMethods>`, `<SignInHandoff>`, `<LicenseChoice>`, `<ReplaceDevice>`, `<Activate>`, `<SignInDone>`                           | `useSignIn()` over ui-core's `SignInModel`                         |
| Elements (Lit)             | `<pk-sign-in presentation="sheet">`                                               | `<pk-sign-in-methods>`, `<pk-sign-in-handoff>`, `<pk-license-choice>`, `<pk-replace-device>`, `<pk-activate>`, `<pk-sign-in-done>` | `SignInModel` (ui-core)                                            |
| Vue, Svelte, Angular       | Wrappers over `<pk-sign-in>`                                                      | The elements                                                                                                                       | A composable, rune store or signals service over `SignInModel`     |
| SwiftUI (iOS, macOS)       | `.polarisKeySignIn(client, presentation: .inline)`, or in `.polarisKeyGate`       | `SignInMethodsView`, `SignInHandoffView`, `LicenseChoiceView`, `ReplaceDeviceView`, `ActivateView`                                 | `@Observable SignInModel`                                          |
| UIKit, AppKit              | `PolarisKeySignIn.present(from:presentation:)`, `beginSignInSheet(for:)`          | The SwiftUI parts in hosting controllers                                                                                           | `SignInModel`                                                      |
| Compose (Android, desktop) | `SignIn(state, presentation = SignInPresentation.Inline)`, or in `PolarisKeyGate` | `SignInMethods(state)`, `SignInHandoff(state)`, `LicenseChoice(state)`, `ReplaceDevice(state)`, `Activate(state)`                  | `rememberSignInState(client)`                                      |
| Godot                      | `PKeySignIn` node, `presentation = "inline"`, or `await PolarisKey.boot()`        | `PKeySignInHandoff.tscn`, `PKeyLicenseChoice.tscn`, `PKeyReplaceDevice.tscn`, `PKeyActivate.tscn`                                  | `PKeySignInController`                                             |
| Qt (Python)                | `SignIn.qml { presentation: "sheet" }`, or `run_gate`                             | `SignInHandoff.qml`, `LicenseChoice.qml`, `ReplaceDevice.qml`, `Activate.qml`                                                      | `SignInViewModel` (`polaris_key.ui.core`)                          |
| Electron, Tauri            | The renderer's React or elements form                                             | As React or the elements                                                                                                           | The main process or sidecar holds the grant (`registerPolarisKey`) |
| Terminal (Node, Python)    | The `login` and `activate` verbs (the browser presentation only)                  | —                                                                                                                                  | The SDK primitives                                                 |

The SDK primitives under every layer (c), Node first (I-10a fixes the per-language names):
`signIn.start({channel, licenseChoice})`, `session.wait()`, `session.reopen()`, `session.cancel()`,
`choice.licenses(grant)`, `choice.devices(grant, licenseId)`, `choice.complete(grant, choice)`,
`choice.cancel(grant)`, `exchange({kind, token, licenseChoice})`, `activate(key)`, `signOut()`
(`plans/I-04.md` §G.9). An app that draws its own UI on them gets the same steps, states and copy
keys as the drop-in.

### 1.4 Platform-adapted, clearly Polaris Key

One identity, rendered in each platform's current idiom. These stay identical everywhere:

- the product-first hierarchy;
- Rubik (except under `native`);
- the token colours and the resolved product accent;
- the copy catalog, the flows and their order;
- one primary per region;
- status as icon plus word.

| Platform                                        | Design language                     | What the kit does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Web** (React, elements, Vue, Svelte, Angular) | Modern web, 2026                    | **Flow card:** every gate step in one card (`surface-raised`, inner hairline, `elevation-3`, radius 22, `inline-size: min(440px, 100%)`, padding 32). Below a 560 px container it goes full-bleed with 20 px padding and the actions docked to the bottom (`max(20px, env(safe-area-inset-bottom))`). **Sizing:** controls 44 px on `(pointer: fine)`, 48 on `(pointer: coarse)`, 36 compact; radius 12 (10 at 36). **Type:** fluid in container units (`cqi`) on the kit root, never `vw`. **Layers:** native `<dialog>` in the top layer with a blurred scrim and `@starting-style` entry; View Transitions between steps. **States and modes:** `:hover`, `:active`, `:disabled` and `:focus-visible`; `forced-colors`. **Settings:** the sidebar becomes a push list below 720 px                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **iOS / iPadOS 26**                             | Liquid Glass                        | **Layout:** full-bleed screens with the product hero and a bottom action area, on system grouped grounds (black / `#f2f2f7`, cells `#16181d` / white; no tinted product chrome). **Buttons:** `.glassProminent` capsule primaries with a white label and no coloured shadow; secondaries are `.buttonStyle(.glass)`, never a filled capsule with a border. **Sheets:** concentric corners (inner = display corner − inset); a grabber and swipe-to-dismiss at the medium detent with no extra X. **Platform controls:** `SignInWithAppleButton` (system), `PasteButton` in key fields, `ProgressView`. **Update:** non-mandatory availability is a glass banner floating above the bottom safe area (never over the nav bar or large title); only a mandatory update is a sheet. iOS and iPadOS 18 (the floor; no iOS 17 path) use the same layout on `.regularMaterial` as a designed fallback. **Sheets:** the toolbar carries the dismissal only when the form has no Cancel, and never a confirm that repeats the form's primary (DL4, rule 10). Sign-in and activation are one inline form; the method sheet is the labelled `sheet` alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **macOS 26**                                    | Liquid Glass at Mac scale           | **Scale:** 13 pt body, 22 pt titles (26 pt on Welcome). Controls are `.controlSize(.large)` (about 28 pt); `.extraLarge` 36 pt capsules only for the Welcome hero. Grouped `Form` sections at radius 10. **Sheets** float inset below the title-bar row, rounded on every side (radius about 24, the macOS 26 sheet shape, never a drop-down glued to the window edge), about 440 pt wide, without dimming the parent. **Copy:** title-case buttons ("Install and Relaunch", "Sign Out…"). **Windows:** a split Welcome window with full-bleed product `art` (inner radius = window radius − inset ≈ 12); a single-column update utility window with minimise and zoom disabled; a Settings scene that hugs its content (about 650 pt) and names the pane in its title. **Also:** `CommandGroup` items (Check for Updates…, Manage License…). macOS 15, the floor, uses the same layout on system materials. **Ellipsis and glyph:** an ellipsis only where the app asks for more input next (Sign Out…, Use a Different Key…, Replace…); actions that open the browser carry the new-window glyph and no ellipsis (Renew ↗, Manage License ↗). **Chrome:** the kit never draws a title bar or caption buttons; Increase Contrast puts hairlines and separators at full contrast and keeps accent fills at 3:1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **visionOS / tvOS / watchOS**                   | Glass windows, focus engine, glance | visionOS: glass windows and ornaments for banners; tvOS: device-code sign-in first, focus-scaled controls; watchOS: status glance only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Android**                                     | Material 3 Expressive               | **Product icon:** drawn through the adaptive-icon mask (or a 28 % squircle) with an 8 % hairline, never re-cut into a Cookie shape. Shape morphs are kept for the monogram, the pressed state and the `LoadingIndicator`, which appears only inline at 24–48 dp and never as a hero. **Controls:** M3 filled fields (radius 16, label inside, a 2 dp focus indicator, never the outlined or notched field); 56 dp full-round buttons at equal widths; connected lists (outer 24, inner 6, 2 dp gaps); modal bottom sheets at radius 28 with a 32 % (light) or 60 % (dark) scrim; wavy progress (amplitude 3, wavelength 32) with a stop indicator. **System:** Material Symbols Rounded (wght 400, FILL 1 when selected); native auth behind the logo-only row (D-21), Google through Credential Manager and passkeys through the system sheet; `MotionScheme` springs; adaptive layouts; dynamic colour only under `native`. **Predictive back:** every step with a back target (Activate, the code view, LicenseChoice, ReplaceDevice, offline activation) uses `PredictiveBackHandler`; the gesture previews the previous step behind the scaled, rounded card; cancelling keeps the key draft, caret and focus; committing returns to the opener with the draft in SavedState; the gate root never consumes back; a mandatory update consumes back with no dead end. API 33 needs `android:enableOnBackInvokedCallback`; API 24–32 gets classic back with the same draft rules. **Constrained hosts:** dynamic colour is API 31+ and only under `native` (below 31, the host's static `MaterialTheme`); non-linear font scale from API 34; edge-to-edge enforced from API 35 (DL17); without Google Play services the Google logo opens the hosted card in Custom Tabs and the passkey row hides when no credential provider answers; with no browser or Custom Tabs provider the screen shows `signin.handoff.noBrowser` with Copy link |
| **Windows**                                     | Fluent 2                            | The `windows` platform variant for Electron, Tauri, Compose Desktop and Qt Quick. **Chrome:** the OS or the host draws the title bar and caption buttons, never the kit. Mica (`DWMWA_SYSTEMBACKDROP_TYPE`, Electron `backgroundMaterial`) only on windows the kit creates, on Windows 11 22H2+; Windows 10, Remote Desktop and Transparency effects off get a solid `surface-page`. No accent rule under the title bar (rule 4). Contrast themes switch to system colours. A native WinUI 3 / WPF kit is UK-60 (optional, parked behind X-01). **Controls:** 32 px at radius 4; overlays at radius 8. **Focused steps:** a `ContentDialog` on a smoke layer, with the footer buttons at equal width, primary first. **Focus:** the Fluent two-tone ring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Linux (GNOME)**                               | libadwaita                          | The `linux` platform variant: a header bar with only the close button, window radius 12, 34 px controls at radius 8, a pill suggested-action for the primary, and focused steps in an `AdwDialog` (radius 12, a soft libadwaita shadow with a 7 % edge in light, never a drawn dark outline). **Message screens** follow `AdwStatusPage`: icon, title, body, then pills stacked and centred, the suggested action on top; **dialogs** follow `AdwAlertDialog`: responses side by side at equal width, the suggested action a pill at the end, stacking when narrow; the loading window keeps its close button. Without a compositor or under reduced transparency the surfaces are opaque; GNOME high contrast comes from the Settings portal `contrast` key; Flatpak and Snap open links through the OpenURI portal. **Qt on KDE Plasma** (Qt kit only): the Breeze frame and focus, affirmative before Cancel (`QDialogButtonBox` KDE layout), Breeze radii under `native`; Compose Desktop, Electron and Tauri keep the GNOME form. A native GTK 4 / libadwaita kit is UK-61 (optional, parked beside UK-38)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Godot**                                       | Modern game UI                      | **Scheme:** `colorScheme` defaults to `"dark"`; light is opt-in. **Glass:** panels over a 35–45 % scrim, with an opaque `surface-raised` at 0.94 under `gl_compatibility`, on web exports and when `ui_reduce_transparency` is set; blur at half resolution in one cached pass. **Controls:** 60 px, with a 3 px focus ring at a 2 px offset plus an accent glow; scale 1.03 only on tiles and rows, from the centre. **Identity and type:** a `product.wordmark` texture beside the icon, and `typography.display` for the game's heading face. **Input:** `PKeyInputGlyphs` (monochrome filled glyphs that follow the last input device and honour the confirm-button swap). **Also:** a type floor (§1.5 rule 5), title-safe areas, a host-set toast anchor, UI sound hooks and optional haptics. **The game owns pause and input:** the kit never sets `SceneTree.paused`; its own nodes run while the tree is paused (process mode Always, overridable); it emits `input_captured(true/false)` when a dialog or sheet opens and closes so the host pauses play and routes input; every dismissible state cancels explicitly (B, Back, Escape). **Shape and scale:** two columns when landscape at 680 layout px or more and aspect 1.5 or more (4:3 one centred column, phone full-bleed); the scale ladder runs 0.75–2 with one density step down; content stays inside the title-safe insets. **QR:** pad-only screens and the offline request only, at 160 physical px or more and at most 42 % of the shorter side; desktop and tablet show none. **Welcome order (the Godot exception to §4.3):** on keyboard platforms the key field and Activate lead, on pad-only devices Sign in comes first and is filled. **Code face:** the user code is set in Rubik, because JetBrains Mono draws E, 8 and 0 as boxes in Godot 4.7. Cards have no accent edge by default; `cardAccentEdge: none                                           | start` (3 px, logical start edge, resolved accent) is the opt-in token |
| **Terminal** (Node, Python)                     | 2026 CLI (gh, uv, clack)            | **Colour:** ANSI-16 for status roles by default, so output follows the user's terminal theme; truecolor only for the product chip, and only with `COLORTERM=truecolor`; light background detected via OSC 11, then `COLORFGBG`. **Layout:** 80 columns, degrading to the terminal's width; prose wraps (a keep-together unit such as a name, a date or `3 of 3` moves whole, a separator is dropped at a wrap), a URL or a user code is never cut (it wraps at `/ ? &`, each piece still a link) and only keys are truncated in the middle; command rows stack below 50 columns; below 32 columns the rail goes and the content takes the real width; a live screen taller than the terminal compacts by fit, not by a row count (the key hints join the waiting line, then blank rows, the check line, the code's air and the countdown go, then what is not essential leaves from the top; the URL, the code and the hints never do); a resize (SIGWINCH) lays the whole flow out again, with one header and the URL and code whole in view; an ending is one result block that replaces the live screen (Ctrl+C and Esc included); one blank rail row between blocks, never two; a continuous rail on every line. **Feedback:** a braille spinner in `mute`; a half-block QR for offline requests only, shown only where the whole screen fits with it, and never for sign-in or the device limit (SIGN-IN.md D-67, D-68: browser and loopback, or a device code without a QR when headless). **Interaction:** OSC 8 links, OSC 52 copy, masked key entry, `--json` on every verb. **Fallbacks:** `NO_COLOR` drops every colour but keeps bold, reverse video and links on a terminal; the QR stays black on white cells; ascii symbols. A pipe (not a TTY, `TERM=dumb`, `--json`) writes no escape and no spinner and prints each line once. Layout frames at 80, 60, 40 and 32 columns. Refusals are ▲ with their fix, never ✗          |
| **Qt** (Python)                                 | Platform variants above             | **Qt:** Qt Quick (QML with `MultiEffect` blur and `Behavior` springs) is the drop-in, rendering the macOS, Windows or Linux variant. QWidget is layer (b) only, with its limits stated: QSS has no blur, transitions or transforms. There is no Tk kit (owner, 2026-10-05)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Terminal output for scripts** (both terminal kits, the Python kit of UK-13 and the Node kit of
UK-14; the Python kit's is the reference). The human output is localised catalog copy and may
change between releases, so a script never parses it: it uses `--json`. Under `--json` a kit never
prompts and never writes an escape, and writes ASCII only (every other character, server text
included, as a `\u` escape). Each line on stdout is one JSON object (NDJSON) with `"v": 1` and
`"command"`:

- **Progress lines** carry an `"event"`: `"pending"` (sign-in: `verificationUri`,
  `verificationUriComplete`, `userCode`, `expiresAt`), `"stage"` or `"progress"` (`done`,
  `total`).
- **The last line of every run** is `"event": "result"` with `"ok"`, `"exit"` and the verb's
  fields flattened beside them (for example `status`, `usable`, `state`, `version` for
  `status`; `kind`, `code`, `deviceCount`, `limit`, `manageUrl` for `activate`). That holds when
  something fails too.
- **`"error"`** appears on a failure that has a code: a registry code (`device_limit`,
  `network`), `"usage"` for an argument error, `"internal"` for an unexpected exception and
  `"interrupted"` for Ctrl-C. **`"message"`** appears only with a usage error and an
  import-bundle failure.
- **Exit codes:** 0 success; 1 a refusal, an unusable license, a cancelled or declined step or any
  other failure; 2 a usage error; 130 Ctrl-C. A refused gate in a host CLI exits 4 (UK-51);
  `status` and a network failure stay 1.
- **Never on a `--json` line:** a license key, a device token, a sign-in poll credential, a
  secret's value or a minted token.
- **Off `--json`,** the Node kit's `secret` and `mint` print the value alone on stdout for a script
  to capture byte for byte; the Python kit's never print it. Inside a CI job whose runner obeys
  commands in its log (`GITHUB_ACTIONS`, `TF_BUILD`, `TEAMCITY_VERSION`), with stdout not a
  terminal, the Node kit withholds a value with a line the runner would obey (`::`, `##[`,
  `##vso[`, `##teamcity[`) and exits 1, unless `--allow-workflow-commands` is given. It never
  alters the value to defuse it.

**Terminal capability table.** One table (environment × streams × flags → colour, unicode,
interactive, animate, links) in the UK-51 `cli` rows runs in both kits' tests. Python must match
Node: CI is truthy over `CI`, `GITHUB_ACTIONS` and `BUILDKITE` (`CI=0` is not CI); `FORCE_COLOR`
forces colour on a pipe but never OSC 8 (links only on a TTY stdout); animation follows a TTY
stdout, not stdin; no OSC 11 query under `NO_COLOR`. `activate` with no key reads piped stdin only
when it is a file or FIFO, stops at the first non-empty line and gives up after about 2 s (exit 2,
`cli.activate.noKey`), so a headless server never waits on a hidden prompt. `NO_COLOR` and
`--no-color` drop colour; on a terminal bold, reverse video and OSC 8 links stay.

**Desktop model** (revised 2026-10-05, SIGN-IN.md §3.17). Sign-in and activation are steps of
the **one sign-in form**: inline in the Welcome window's pane by default, or, with `presentation:
"sheet"`, in one sheet on macOS, one `ContentDialog` on Windows or one `AdwDialog` on Linux that
holds every step. The steps morph inside it and never open a second dialog. Only a destructive
Replace confirm may use the system confirmation (SIGN-IN.md D-80). SIGN-IN.md frames 18, 23–31 and
35–41 draw both presentations. `DeviceLimit` on the key path follows the same rule. The update prompt and
Settings are real windows on desktop. This replaces UK-10's "dialogs as real windows".

**Desktop chrome.** Window chrome belongs to the OS or the host: a drop-in never draws a title bar
or caption buttons in a host window (Electron renderer, Qt widget, Compose content). Windows the
kit creates (the gate, update and settings windows) use the OS frame. Opaque fallbacks, each with
a baseline: Windows 10, Remote Desktop and Transparency effects off; Linux without a compositor or
under reduced transparency; the Qt Quick software backend (no `MultiEffect`); a Compose Desktop
window that cannot be transparent. The close button of a kit dialog cancels that step; closing a
blocking gate window asks the host and by default quits; Sign out lives only in Settings → Account
and the app menu (SIGN-IN.md D-71), never beside Cancel or Close. Each desktop kit declares a
minimum window size (the 480×520 Mac sheet is the floor).

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
   - The 2 px accent line at a container's top edge is only the indeterminate shimmer: no static
     accent rule under a title bar, header or card.

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
   - **Godot panels and hints never collide:** the input-hint bar sits in the title-safe margin
     below the panel, never over it, and the panel sizes to its rows so the last row keeps its full
     bottom padding.
   - **Godot key art stays behind the glass, not through it:** bright, hard-edged art (a sun, a
     vehicle) never sits partly under a panel edge. The host's art places its focal point clear of
     the panel or fully behind a centred one, and a modal hides foreground sprites. A clipped
     bright shape under glass reads as a smudge.
6. **No 2018 Material or Bootstrap tells, and no 2020 Dribbble ones:**
   - no all-caps buttons and no 4 px-radius cards;
   - no drop shadows under flat cards on dark, and no coloured glow under buttons;
   - no underline-only or outlined text fields;
   - no default blue links;
   - no "— or —" dividers between buttons and links;
   - no disc bullets in release notes;
   - no 1 px outlined keycaps;
   - no engine-default bitmap controls (Godot), and no `CheckBox` where a switch is meant.
   - **One switch everywhere:** a light knob (white, with a 1 px soft shadow) on the accent track
     when on and on a neutral track when off, in both themes and on every kit; never a dark knob on
     a coloured track.
   - **No all-bold UI:** weights are 400 (body, row titles), 500 (labels, buttons, the product
     header) and 600 (headings). 700 appears only in the game wordmark fallback.

- **Not adopted (the Edition 04 expressive layer):** accent-tinted card hairlines, accent sheet
  rims and a coloured glow under filled primaries, including under `native` and forced colours.
  Reasons: forced colours removes shadows and tints anyway; `native` follows the host (DL13);
  hairlines are `border-subtle` (rule 2); the accent marks the primary and the focus ring, and an
  accent edge on every card competes with the ring. The primary is the accent's solid with no
  shadow. Product-owned art and ambient stay exempt (§1.2). The only accent edge is the opt-in
  `cardAccentEdge` token (Godot, §1.4); no kit draws accent chrome on a terminal.

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
    - An ellipsis only where the app asks for more input next; an action that leaves the app carries
      the new-window glyph, never an ellipsis ("Renew ↗", not "Renew…").
    - Separators are "·" with thin spaces.
    - Lines are balanced or rewritten so none ends on a single orphan word (`text-wrap: balance` for
      headings, `pretty` for body).
12. **Mono only for keys, user codes and hashes** (BRAND §4.6), in the kit mono (§2.1) (Godot sets
    the user code in Rubik, §1.4).
    - Versions, counts, times and progress use tabular figures in the body face.
    - Keys never truncate at the end: they wrap to two lines or truncate in the middle
      (`pkey_tidewater_7Q2M…3WPLDA`).
13. **The terminal lays out for 80 columns** and degrades to 60, 40 and a 32-column floor. Key hints show keys in `strong` and
    actions in `mute`, everywhere. Footers never leak implementation ("NO_COLOR respected").

### 1.6 Marks

- Kit screens show **no Polaris Key mark**. The Pinned K appears only inside the optional Powered-by
  line or badge; the Star Cut does not appear in SDK UI at all. This supersedes BRAND §7.1's two
  "SDK UI" rows (§9).
- The Powered-by line is `<Pinned K favicon cut at 16 px, no bit> Powered by Polaris Key` in live text, `text-subtle` at 12–13 px,
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

| Target                  | File (generated)                                                                            | Consumer                                                |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| CSS (exists) + kit vars | `packages/brand/css/kit.css` (`--pk-kit-*`)                                                 | React, elements, Vue, Svelte, Angular, Electron, Tauri  |
| JS objects              | `packages/brand/src/generated/kit.ts`                                                       | ui-core theme resolver, React Native                    |
| Swift (exists) + kit    | `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift` + `KitTokens.generated.swift` | SwiftUI, UIKit, AppKit                                  |
| Kotlin (exists) + kit   | `sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/brand/PolarisKitTokens.generated.kt` (¹)     | Compose (all targets), Views interop                    |
| Godot (exists) + themes | `PKeyBrand` + `PKeyKitTokens` + `PKeyKitIcons` (engine control icons) (²)                   | Godot kit                                               |
| **Python (new)**        | `sdks/python/src/polaris_key/ui/_tokens.py`, `ui/qt/Theme.qml` + `qmldir` + QSS per scheme  | Qt, rich/Textual                                        |
| **Terminal (new)**      | `packages/sdk-node/src/cli/tokens.generated.ts`, `polaris_key/ui/ansi.py`                   | Node and Python CLIs (ANSI-16 roles + truecolor accent) |
| **C# (new)**            | `sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs`                               | Godot .NET facade                                       |

(¹) The Compose kit is an Android library module today (`src/main`); the file moves to
`commonMain` when UK-09/UK-10 make it Kotlin Multiplatform. (²) `pkey_brand_{dark,light}.tres`
stay Godot-saved resources written by `tools/gen_theme.gd` from `PKeyUiTheme` and drift-checked by
the `brand` suite; the engine control icons are SVG templates in `kit_icons_generated.gd`
(rasterised at run time) rather than imported `.svg` files, because an import's parameters differ
between engine versions. UK-01 implemented this table (2026-10-05); the design source is
`packages/brand/src/tokens/{kit,terminal}.ts` and the renderers are `scripts/gen-kit.ts`.

**Fonts per platform.** Rubik ships as a **variable font** (wght 300–900; about 35 KB as latin
WOFF2), replacing today's 400 and 700 statics, which forced every non-body string to Bold. The
kits also ship one **kit mono**, JetBrains Mono (OFL, 400–600 variable, latin, about 31 KB), as
`--pk-font-mono` for keys, user codes and hashes, so a key looks the same on every OS.

- Formats: WOFF2 for the web (`packages/brand/fonts/`, with the unmodified variable TTFs in
  `fonts/ttf/`), TTFs for Swift, Android resource fonts for Compose (Compose Resources once the kit
  is KMP), Godot `FontFile`s (MSDF, so focus scaling stays sharp), and TTFs with the OFL texts in
  the Python wheel (`polaris_key/ui/fonts/`). The SDKs keep the static 400/700 copies beside the
  variable ones until each kit's typography moves over (UK-07, UK-09, UK-11).
- Every web kit **loads its fonts itself** (an `@font-face` in the elements stylesheet and
  `@polaris-key/react/styles.css`), with `size-adjust` and `ascent-override` fallback faces so a
  host page does not shift when Rubik arrives (RE).
- Panes embedded in a host layout default `typography.family` to `"inherit"`, so a settings pane
  reads in the host's type. Full-screen flows keep Rubik.
- Apple kits scale Rubik with `UIFontMetrics` / `.relativeTo:` so Dynamic Type works (§11 Q6:
  Rubik stays; SF only under `native`).
- Rubik has no CJK, Arabic, Hebrew or Devanagari: each kit sets a fallback chain to the system
  face for those scripts.

### 2.2 The drift gate

`pnpm gen brand --check` covers every file above; the Python, Kotlin, Swift and Godot suites each
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

The focus ring takes the resolved accent (one learnable focus signal within the product). Console,
portal and hosted pages follow B17 instead (state colour is the referenced service's accent); kits
are unchanged and use the product accent. Status
colours never change with the accent; the danger `solid` behind white labels follows the same
white-first rule.

| Vector (input → scheme)              | `solid`               | `on`  | `fg`      | `subtle`  |
| ------------------------------------ | --------------------- | ----- | --------- | --------- |
| Tidewater icon teal `#369186` → dark | `#26847a`             | white | `#72cabe` | `#0a181e` |
| Tidewater icon teal → light          | `#26847a`             | white | `#14796f` | `#e1ecf2` |
| Core violet `#9a5cff` → dark         | `#9051f3`             | white | `#c0a6ff` | `#17122d` |
| Core violet `#7a2fff` → light        | `#7a2fff`             | white | `#7321f6` | `#eae4ff` |
| Drift Kart `#ff6a3d` → dark          | `#ff6a3d`             | ink   | `#ff987a` | `#241517` |
| Drift Kart `#ff6a3d` → light         | `#ec592a`             | ink   | `#b73500` | `#f5e8ea` |
| Danger → dark / light                | `#db3a2b` / `#be2323` | white | token     | token     |

A pinned test asserts that `on` is the same colour in both schemes for every vector.

**As implemented (UK-01, 2026-10-05).** `packages/brand/src/accent.ts` is the reference; the
Swift (`PolarisAccent`), Kotlin (`PolarisAccent`), GDScript (`PKeyAccent`) and Python
(`polaris_key.ui.accent`) ports reproduce every vector in `packages/brand/fixtures/accent-vectors.json`
exactly (generated by `pnpm gen brand` from `src/tokens/accent-vectors.ts`, with the spec rows
above plus edge cases). The table above is the resolver's output; the first draft's values were
hand-tuned mockup colours and were replaced by it. The rules the draft left open are fixed as:

- **deriveAccent:** opaque means alpha ≥ 128; a pixel is grey below OKLCH chroma 0.04; clusters are
  30° hue bins; a cluster must cover ≥ 8 % of the opaque pixels; the highest mean chroma wins (ties:
  the larger cluster, then the lower hue); the answer is the cluster's mean OKLab colour with its
  lightness clamped to 0.45–0.60 (an icon colour is art, the accent is UI).
- **solid:** white label → the smallest darkening that gives white 4.5:1, then (dark schemes only)
  the smallest lift that clears 3:1 on every surface; ink label → the smallest lightening that
  gives ink 4.5:1, then (light schemes only) the smallest darkening that clears 3:1 on every surface.
  This is why Drift Kart's light solid is `#ec592a`, not the raw `#ff6a3d` (2.9:1 on white).
- **fg:** from the input at lightness ≥ 0.78 (dark) or ≤ 0.52 (light), moved until it clears 4.5:1
  on every surface. **subtle:** `solid` at 12 % (dark) or 10 % (light) over the page, flattened,
  like the section accents. **focus:** `fg` in dark, `solid` in light.
- Every search is a 32-step bisection on lightness, compared on the rounded hex, so the ports agree
  bit for bit.

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

No new kits for host design systems. UK-22 (a Tailwind v4 preset, MUI, Mantine and Chakra theme
objects, a shadcn registry) is dropped; the recipes (UK-31) show how to map a host's tokens onto
`--pk-*` and how to go native over layer (c).

### 3.6 Provider buttons

The theme sets the provider buttons' radius, height, density and type. Each provider keeps its own
fill, logo and label colours: Apple black, white or white-outline per scheme, Google light, dark or
neutral, Steam its own. Never the product accent, never a glow. They sit in the logo-only row at
equal widths. Under `native`, `SignInWithAppleButton` and the platform's own controls are used
unchanged. The passkey and email rows are kit secondaries. The theming board shows the provider row
under default, core, compact and native.

### 3.7 What a theme change must re-render

Root surfaces, text, fields, focus, buttons, provider rows, dialogs, skeletons, progress, toasts
and empty states, together. The theme API test covers this list, and custom accents are tested on
light and dark surfaces. No shared component hard-codes a customer's product name or artwork.
EXPERIENCE §3 lists the same parts for the console and portal.

---

## 4. The component catalogue

### 4.1 The set and the names

The same set and names in every kit. Web components prefix `pk-`; Godot prefixes `PKey`; Swift and
Compose use the bare name inside their module (`PolarisKeyUI.Activate`, `im.plrs.key.ui.Activate`);
React exports bare names from `@polaris-key/react`. Headless names follow each language
(`useActivate`, `ActivateModel`, `rememberActivateState`, `PKeyActivateController`,
`ActivateViewModel`).

| Component             | What it is                                                                                                                                                                                                                                                                                                                                       | States                                                                                                                                        | Priority |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **PolarisKeyGate**    | The drop-in root. Boots, gates, and runs every flow below as needed; renders the app when licensed; adds the grace banner, update prompt and toasts                                                                                                                                                                                              | booting · needs-activation · licensed · grace · blocked (revoked, expired, version too old/new, channel not entitled) · error                 | must     |
| **Boot**              | First-paint screen while the stage machine runs (`ui.stages`): product hero, a neutral indicator (the 2 px shimmer in `text-strong` at low alpha, never a part-filled bar; the accent only on the consent action), consent for metered downloads, offline and blocked stops                                                                      | progress · consent · fetching · offline · blocked · declined · rolled-back · error                                                            | must     |
| **Welcome**           | The gate's first screen: product hero, Sign in, Use a license key, and the extras the product supports (trial, restore purchase, activate offline)                                                                                                                                                                                               | default · busy · capability-limited (only the paths the build supports, GO)                                                                   | must     |
| **SignIn**            | **The one sign-in form** (SIGN-IN.md §3.17): its body morphs through Sign in (the logo-only provider row with native Apple and Google behind it, Continue in browser on desktop, Sign in on your phone or computer on TV) → SignInHandoff → LicenseChoice (→ ReplaceDevice) → Done, with `presentation` `inline` (default), `sheet` or `browser` | methods · handoff · code · finishing · choose · replace · key · done · error · expired                                                        | must     |
| **SignInHandoff**     | Step 2 of the form, in place: "Finish in your browser" with Open browser again, Cancel and Use a code instead; the code view (the RFC 8628 user code, the countdown; a QR only on TV and console); moves on by itself                                                                                                                            | starting · waiting · no browser · code · link copied · finishing · denied · expired · cancelled                                               | must     |
| **Activate**          | License key entry with live verdict: the key field names the product and tier as soon as it parses, catches cut-short keys (EXPERIENCE P2), paste button, Return submits                                                                                                                                                                         | empty · typing · parsed · cut short · busy · rejected · device limit (hands to DeviceLimit) · done                                            | must     |
| **OfflineActivation** | Two numbered actions: 1 send the request (the code with Copy, and a QR), 2 load the response (file, drop or paste), then the verdict. A loaded file is not an activation until its signature verifies                                                                                                                                            | default · loaded · rejected signature · done                                                                                                  | must     |
| **DeviceLimit**       | The focused **Replace a device** flow (PORTAL §4.25; SIGN-IN.md §3.7, D-08): seat meter, devices as radio rows, least recent preselected, the "Replace <device>?" confirm, **Replace and continue**                                                                                                                                              | default · busy · removed · failed · browser mode (opens `manageUrl`)                                                                          | must     |
| **LicenseChoice**     | Step 3 of the form (SIGN-IN.md §3.6; I-04 §G): license rows (the tier pill with "{n} of {limit} devices" and a seat meter; origins in plain words, SIGN-IN.md O-17), full licenses without a radio, **Replace a device** as a step in place, the key field                                                                                       | loading · many · one · current · keep · new · create · all full · mixed · replace open · raced · none (keys) · none (no keys) · grant expired | must     |
| **Devices**           | Device list: icon by form factor, friendly name, platform and last seen, "This device", rename (inline, not an always-open form, RE), Remove with an L1 inline confirm                                                                                                                                                                           | loading · list · renaming · confirming · empty · browser mode                                                                                 | must     |
| **UpdatePrompt**      | Available / downloading / ready / mandatory / blocked / store outlet, with notes and the right verb per outlet ("Update on the App Store", "Restart when ready", "Get it on Steam")                                                                                                                                                              | available · downloading · ready · mandatory · blocked · store · platform · revoked-required-content · up to date                              | must     |
| **UpdateProgress**    | Compact download and install progress for app updates and content packs: toast, pill, or inline row. Verification happens inside downloading; installing is apply; the copy never says installed before apply                                                                                                                                    | queued · downloading · installing · paused (metered) · failed · done                                                                          | must     |
| **ReleaseNotes**      | The changelog for one or many versions, from `ReleaseClient.changelog()`                                                                                                                                                                                                                                                                         | loading · list · empty · error                                                                                                                | must     |
| **StatusScreen**      | Blocking states with their fix: revoked ("Use a different key", "Sign out"), expired ("Renew"), version too old ("Update"), too new, channel not entitled                                                                                                                                                                                        | one per state, each with a primary fix                                                                                                        | must     |
| **GraceBanner**       | Offline grace: deadline and countdown, Reconnect, dismissible per session (the prop doc already promises it, RE)                                                                                                                                                                                                                                 | days left · last day · expired → StatusScreen                                                                                                 | must     |
| **AccountAndLicense** | The settings pane: product and tier, holder (a floating license shows "Not in an account · Add your name and email", S-24), Manage (portal), Devices (the seat count only from the roster or the `device_limit` body, else omitted), Cloud Sync status, Updates (automatic, channel, check now, version), managed settings, Sign out, Powered-by | loading · signed in · key-only (no account) · offline                                                                                         | must     |
| **Settings**          | Config-catalog-driven settings with typed controls (switch, slider, select, text), categories, search above 12 rows, provenance as text, locked rows "Set by <org>", reset                                                                                                                                                                       | loading · list · dirty · saving · locked · error                                                                                              | must     |
| **Paywall**           | Entitlement-gated upsell: what a tier adds, purchase or redeem; StoreKit draws the store on Apple (the kit computes no per-month price or saving); Play Billing on Android; the portal elsewhere. Web checkout waits for the owner's `commerce: go`; until then "not available here" hands off to the portal                                     | loading · offers · purchasing · purchased · restore · not available here                                                                      | must     |
| **EntitlementGate**   | Renders children only when an entitlement holds; otherwise a slot or the Paywall                                                                                                                                                                                                                                                                 | entitled · not entitled · loading                                                                                                             | must     |
| **CloudSyncStatus**   | A small status: synced time, syncing, conflict, offline; opens details                                                                                                                                                                                                                                                                           | synced · syncing · offline · conflict · error                                                                                                 | should   |
| **About**             | Product, version, build, licenses (OSS notices), the Powered-by badge, Copy diagnostics                                                                                                                                                                                                                                                          | default                                                                                                                                       | should   |
| **ChannelPicker**     | Release channel choice, locked when the outlet fixes it                                                                                                                                                                                                                                                                                          | default · locked                                                                                                                              | should   |
| **Toast**             | Bottom-right (bottom full width on phones), one line plus a consequence, ≤ 2 actions, 6 s with a visible timer, errors persist (EXPERIENCE §7)                                                                                                                                                                                                   | info · success · warning · error · with progress                                                                                              | must     |

**Must not.** Each component keeps one protected behaviour, which UK-02b turns into a negative
fixture:

| Component         | Must not                                                        |
| ----------------- | --------------------------------------------------------------- |
| PolarisKeyGate    | flash activation during a cached-session check                  |
| Boot              | animate invented progress, or trap metered consent off-screen   |
| SignIn            | restart the flow or erase account context on a step change      |
| SignInHandoff     | use the public user code as the polling handle                  |
| Activate          | require an account for a floating key                           |
| OfflineActivation | treat a loaded file as a verified activation                    |
| DeviceLimit       | delete local files when access is removed                       |
| LicenseChoice     | blur keep, create and add-to-account into one outcome           |
| Devices           | say "This device" when the runtime does not know it             |
| UpdatePrompt      | offer a restart the browser cannot perform on a desktop product |
| UpdateProgress    | say installed when only the download verified                   |
| ReleaseNotes      | execute remote markup                                           |
| StatusScreen      | collapse the five refusals into one error                       |
| GraceBanner       | extend grace visually                                           |
| AccountAndLicense | silently attach a floating license                              |
| Settings          | expose hidden values through a theme                            |
| Paywall           | invent checkout                                                 |
| EntitlementGate   | treat a style override as authorization                         |
| CloudSyncStatus   | imply universal backup                                          |
| About             | copy diagnostics unredacted                                     |
| ChannelPicker     | lock the picker without saying why                              |
| Toast             | be the only record of an error                                  |

**Verification recipe.** For each component state: a fixture render at the phone-portrait and
desktop rows (§7.1) with the variants long product name, a `de` and a `ja` pack, a custom light
accent (`#ff6a3d`, which resolves to the ink label), a response delayed past the DL7 threshold,
cancellation and a recoverable failure; the Must not as a negative case; the semantic outcome
asserted independently of the animation (the reduced-motion render reaches the same state). A
matrix cell is complete only with runtime evidence or a documented N/A reason in the kit's parity
row.

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
import polarisKey from "./polaris-key.json"; // the generated config module

<PolarisKeyGate config={polarisKey}>
  <App />
</PolarisKeyGate>;
```

```html
<!-- Any web page, Angular, Vue, Svelte, htmx (2 lines; the module injects its own styles and fonts) -->
<script type="module" src="https://key.plrs.im/elements/1/pk.js"></script>
<pk-gate product="tidewater" config='{"product":"tidewater",…}'
  ><my-app></my-app
></pk-gate>
```

```swift
// SwiftUI, iOS 18+ / macOS 15+, Liquid Glass on 26 (3 lines)
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

The constructor names follow each SDK. Every kit takes a `client` built the same way, and the React
kit takes the generated config module and the elements take `product` plus a `config` attribute
(SETUP.md D18; there is no publishable key or other credential). The gate fixes today's lifecycle traps:

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
- **The key field is visible and private, not masked.** People compare its prefix and last six
  against the purchase email. No autocorrect or personalised learning (Android
  `noPersonalizedLearning`; no spellcheck or autocorrect on Apple, Qt and the web), excluded from
  autofill saving, middle-truncated at rest, and never written to logs, analytics, crash tags or
  `--json`. Terminals mask entry. The Android keyboard draws no suggestion strip for it.
- **Godot's Welcome order is the exception.** A game's key path is the common one and a pad has no
  keyboard, so on keyboard platforms the key field and Activate lead; on pad-only devices Sign in
  comes first and is the filled primary.
- **Keys stay on one line and are never end-truncated or wrapped.** A key that does not fit gives
  way in the middle, keeping the prefix and the last six characters ("pkey_tidewater_7Q2M…3WPLDA"),
  because those are what people compare against the purchase email; the field scrolls to the caret
  while editing. A key wrapping mid-token inside a field reads as broken.
- **Live verdict.** The key parses as you type: `pkey_<product>_<22>` puts "Key for Tidewater Studio" under the
  field from the prefix alone; the tier and terms ("✓ Tidewater Studio Pro · Lifetime · 3 devices",
  with only the icon in success colour) and the header's tier follow the server's answer, never
  before it (SIGN-IN.md D-20). A cut-short key gets "This key is cut short. After tidewater\_ come
  22 characters, and this has 10." Errors are inline under the field, `aria-invalid`, announced, and
  cleared on edit.
- **Device limit is not an error string:** Activate hands off to **DeviceLimit** with the device
  list (RE, SW, KO, GO all lacked this).

**After a key (S-24, 2026-10-06).** [notes/S-24](../research/2026-09-29-godot-omniplatform/notes/S-24-licence-holders.md) §9 adds the **Done** step after a key activation
(`ActivateDone`; frames [42](sign-in/shots/42-desk-mac-key-done-desktop-dark.png) and
[47](sign-in/shots/47-kit-key-done-phone-light.png)). The license stays **floating** (no account);
Done says "<Product> is ready" and shows a quiet **Keep <Product> in your account** card, marked
Recommended, listing only the reasons the product has (Cloud Sync only when it is on; getting the
license back; moving it to a new device yourself), with **Add your name and email** as its
secondary and **Start using <Product>** as the primary. **Add your name and email**
(`AddToAccount`, frame 43) collects both natively and hands them to the card as sign-in hints
(SIGN-IN.md §6.6); after the code, the kit keeps the device on its license and attaches it (frame
44). The key-ownership states (waiting, in an account, owned with refusals on, sent to another email)
are SIGN-IN.md §3.9's. Every skip reads **Continue without an account**. Three layers as always:
drop-in inside `SignIn` and the gate, styled `ActivateDone` / `AddToAccount`, headless
`useActivateDone` / `ActivateDoneModel`. Packages UK-42 (ui-core, elements, React) and UK-43 (native
kits).

#### SignIn and SignInHandoff

> **Sign-in is specified in [SIGN-IN.md](SIGN-IN.md) (2026-10-05).** Its §5 matrix says which steps
> a kit renders natively and which hand off to the browser, and its §5.2 holds the `signin.*` copy
> keys. It supersedes this section, Welcome and Activate, and DeviceLimit where they differ, and
> adds the **LicenseChoice** component (with **Replace a device**) used after a native sign-in.
>
> **Desktop kits** (macOS 15+ SwiftUI and AppKit, Compose Desktop, Qt Quick, Electron and Tauri,
> Godot desktop, the terminals) follow SIGN-IN.md §3.17 and §4.15 (D-60–D-77, frames 23–34):
>
> - the Welcome window's chooser leads with **Continue in browser**, keeps the logo-only provider
>   row as shortcuts, and has no passkey or "Sign in on your phone or computer" row (D-69);
> - sign-in runs in the **default browser** with a loopback redirect (a registered scheme when the
>   app cannot listen), and the window shows the waiting step in its desktop dialog: "Finish in
>   your browser", **Open browser again**, **Cancel** and **Use a code instead** (D-61, D-62,
>   D-66);
> - **no QR on any desktop surface** (D-67): the code view shows the URL, the code with **Copy**
>   and **Open browser**. The `desktop-sign-in` board's QR is retired;
> - the tab ends on the hosted desktop ReturnStep ("You can close this tab and return to <App>",
>   no timer), and the app comes to the front with the toast "Signed in as <name> · <Tier>
>   license" (D-63–D-65);
> - sign-out is the platform dialog from Settings → Account (D-71), and an ended sign-in is a
>   non-blocking banner while grace holds (D-72).
>
> **One sign-in form (owner, 2026-10-05; SIGN-IN.md O-13–O-16, §3.17, D-78–D-93).** "Finish in
> your browser", the code view, the license choice, Replace a device and Done are steps of one form
> that morphs in place, not sheets or dialogs over it. That supersedes the waiting sheet and the
> in-app LicenseChoice dialog above and in §1.4. The form takes `presentation: "inline" | "sheet" |
"browser"` and `replace: "inline" | "browser"` in every kit; inline and sheet choose the license
> in the app through the pending sign-in grant (`plans/I-04.md` §G), browser leaves it to the card.
> Device-code sign-ins (TV, console, Use a code instead) always choose on the card. The in-app
> device list for Replace comes from the grant (`choice/devices`), so the kits' **Replace a
> device** is inline in sign-in; `DeviceLimit` on the key path keeps the browser mode.

Mockups: [web](ui-kits/shots/web-sign-in-light.png), [iOS](ui-kits/shots/ios-sign-in-dark.png),
[Android](ui-kits/shots/android-sign-in-dark.png),
[macOS](ui-kits/shots/desktop-sign-in-dark.png), [Godot TV](ui-kits/shots/godot-sign-in-dark.png),
[terminal](ui-kits/shots/terminal-sign-in-dark.png).

- **Methods** follow PORTAL §4.1's provider rules and the owner's logo-only row (SIGN-IN.md D-21):
  - the **provider row**: Apple, Google and Steam as the product ships, logo only, equal width, in
    that order. Apple runs native `ASAuthorization` behind a logo-only button drawn to Apple's
    logo-only guidelines (App Review 4.8 is met by equal prominence). Google runs through
    Credential Manager on Android. Steam goes through the hosted card;
  - **Sign in with a passkey** (the platform passkey sheet);
  - **Continue with email** through the hosted card (`ASWebAuthenticationSession` / Custom Tabs /
    the system browser);
  - **Sign in on your phone or computer** (device code).

  The iOS method sheet is titled "Sign in to <Product>", with no second product icon and no X at
  the medium detent.

- **The hand-off screen:**
  - the user code centred in mono (40 px, weight 500, tracking 0.12em) on a borderless fill, so it
    reads as output and not as an input, with a ghost Copy icon at the inline end. **One format
    everywhere:** two groups of four joined by a hyphen, `WDJB-MJHT`, exactly as the activate page
    asks for it. TV and handheld sizes only get larger type and tracking; the terminal shows the
    same string in reverse video. No spaced-out letters, no space in place of the hyphen;
  - "Or go to key.plrs.im/device", with copy;
  - "Check the code there matches this one";
  - the determinate countdown ring with "code expires in 4:12";
  - **Open browser again** (primary) and **Cancel** (secondary).

  A QR appears only where DL14 allows it: TV, console, pad-only screens and an offline-activation
  request. On web, tablet, phone and desktop the code view shows the URL with Copy, the code with
  Copy, the countdown ring, **Open browser again** (primary), **Cancel** and **Use a code
  instead** (SIGN-IN.md D-67). The device-code title is **Sign in with a code** in every kit. The
  screen moves on by itself.

- **TV and consoles** (tvOS, Android TV, Godot on console or Steam Deck in game mode) open on the
  device-code path:
  - the product's `deviceCodeUrl`, or `key.plrs.im/tv`;
  - the code as two groups of four joined by a hyphen, as everywhere (SIGN-IN.md D-17);
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
3. "To use it on <this device>, replace one. You can add it back later."
4. The neutral seat meter with its "3 of 3 in use" caption (`role="img"`, labelled), under the lede.
5. **One inset grouped list.** Radius 16, hairlines inset past the glyph, 64 px rows. Each row has a
   bare 20 px form-factor glyph in `text-muted` and one meta template: "<platform> · last used
   <when>". The preselected row carries a quiet neutral **Least recent** tag after its name
   (`k-tag`: 12 px 500, full radius, `text-strong` at 9 %), so the meta never wraps to an orphan
   word (a terminal list, once I-13 brings one, appends "· least recent" to the meta instead; until
   then the terminal kits draw no list, below). Glyphs by `deviceType`: laptop, desktop
   (Mac mini, towers), tablet, phone, handheld; `laptop_windows`, `laptop_mac`, `desktop_mac`,
   `tablet_android` and `phone_android` in Material Symbols.
6. Selection: `accent-subtle` plus one indicator (§1.5 rule 2).
7. The confirm block under the list follows the selection (SIGN-IN.md §3.7): "Replace <device>?",
   then "<device> signs out of <Product> and <this device> takes its seat. <device> can sign in
   again later if a seat is free."
8. **Replace and continue** as the primary and **Back** (SIGN-IN.md D-08). On macOS the confirm
   reads "Replace “<device>”?". The buttons stack full width when a label runs past half the row.

**Naming and data source (owner decision, 2026-10-05).** The component is titled **Replace a
device** in every kit, matching the sign-in card's inline Replace (`plans/I-04.md`, "Owner
decision (2026-10-05): licence choice at sign-in"). Layer 1 has no device-wire source for the list:

- a device token manages only itself (R3-09);
- a device refused with `device_limit` holds no token for the full licence.

So in layer 1 the kits ship the browser mode: **Replace a device** opens `manageUrl` (PX-W8),
shown as a QR on TV and console, and a sign-in started there reaches the card's inline Replace.
The terminal kits open it in the browser (Enter, then Enter again to retry; SIGN-IN.md §4.15) and
draw neither a list nor a QR.
The in-app radio list above arrives with I-13's `choose` response, which carries the list. There
is no key-authenticated device removal.

Browser mode (no device API) links to the portal flow instead. On the key path it is the only
mode, titled **Replace a device**. The seat meter and count appear only when the roster or the
`device_limit` body supplies them. The copy never shows `dev-2` or
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
  - iOS: a glass banner when the update is available, floating above the bottom safe area (or the
    tab bar, as its accessory) so it never covers the navigation bar or the large title; a sheet
    with no dismiss only when it is mandatory.
- **Mandatory updates** have no dismiss and say why ("Your library moved to a new format, and 2.4.1
  can't open it.").
- **Games** never interrupt play. During gameplay the kit shows only an UpdateProgress toast at the
  host's `toast_anchor`; the default is bottom centre above the hints, inside the 5 % title-safe
  area and never over the HUD. The modal waits for the results or pause screen, with default focus
  on **Later** and input ignored for 250 ms after it opens.
- **UpdateProgress** is its own component for background content packs: the Godot toast ("38 of 91
  MB · 1 min left"), the Android foreground-service notification, a Live Activity on iOS that tracks a content-pack download (an App Store app cannot update itself). Verification happens inside downloading; installing is apply; the copy never says installed before apply.

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
  - "Managed settings" groups the rows a policy locks. A locked row shows its value as text with a
    lock and names its config source ("Set by <developer>"). A host may pass its own lock reason
    through the kit API (host-owned, shown verbatim, never invented by the kit); "Set by your
    parent or guardian" is a host string, not a source Polaris Key knows.
  - A source that is not the product's developer never appears under "From <Developer>".
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
11. Native desktop contrast settings: Windows Contrast themes (Compose Desktop and Qt read the
    high-contrast flag and switch to system colours; Electron gets forced-colors from Chromium),
    macOS Increase Contrast (hairlines and separators at full contrast, accent fills keep 3:1) and
    GNOME high contrast through the Settings portal `contrast` key.

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
- **Launch locales** (owner, 2026-10-05): English plus German, French, Spanish, Brazilian
  Portuguese, Italian, Japanese, Korean and Simplified Chinese (`de`, `fr`, `es`, `pt-BR`, `it`,
  `ja`, `ko`, `zh-Hans`). The CJK locales need the system fallback chain of §2.1 and line breaking
  that never splits a key or a user code.
- **RTL is later.** There is no right-to-left locale at launch, so there are no RTL baselines and no
  RTL QA gate. Layouts stay **RTL-safe** so the pass is cheap when a locale arrives: logical
  properties (`margin-inline-start`, `leading`/`trailing`, `start`/`end`), directional icons flagged
  as mirrorable, and no hard-coded left or right in layout code (the §7.3 lint).
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

Durations come from the tokens: `micro` 80 ms, `fast` 120 ms, `base` 200 ms, `moderate` 260 ms,
`slow` 320 ms, `deliberate` 480 ms (and `shimmer` 1600 ms, the skeleton's period), with the
distances `xs`–`xl` (2, 4, 8, 12, 24 px), the scales and the stagger (30 ms a step, at most 6) of
BRAND.md §4.6. The shared motion system is
[notes/S-23](../research/2026-09-29-godot-omniplatform/notes/S-23-motion-system.md), with the
canonical tokens in `packages/brand` (generated into `KitTokens.Motion` in Swift, `Motion` in
Kotlin and `DURATION_*_MS` / `MOTION_DISTANCE_*` in GDScript). **Sign-in's motion is SIGN-IN.md
§3.18** (owner, 2026-10-05): the named patterns (morph, shared-element, enter, exit, stagger-list,
expand, success, skeleton, press), the S-23 tokens (no `quick` step: exits use `fast`), and its
per-platform mapping table, which wins over the rows below for sign-in. The web column names each
row's S-23 pattern; the platform columns keep their native curves.

| Change                     | Web / desktop webviews                                                                                               | iOS / macOS                                                                                                     | Android                               | Godot                                                          | Qt Quick                     | Terminal                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| Step to step inside a flow | **morph**: View Transition on the card: cross-fade plus an 8 px slide, `base`, `ease-standard`                       | `.navigationTransition(.zoom)` where the icon persists; `matchedGeometryEffect` for the icon from gate to sheet | `AnimatedContent` with `MotionScheme` | 220 ms, `TRANS_BACK` / `EASE_OUT`, overshoot ≤ 1.04            | `Behavior` 200 ms `OutCubic` | Redraw in place                |
| Sheet or dialog in         | **enter** / **exit**: `slow`, `ease-enter`, scale 0.98 → 1 and opacity, via `@starting-style`; scrim fades at `base` | system sheet springs (`.smooth(duration: 0.35)`); macOS sheets slide from the title bar                         | system bottom sheet                   | 280 ms rise of 24 px plus fade; exit 160 ms                    | 320 ms `OutCubic`            | n/a                            |
| Press                      | **press**: scale 0.98, `fast`                                                                                        | system                                                                                                          | shape morph (M3E)                     | 0.98 press; focus moves the ring, no scale on buttons in a row | scale 0.98                   | n/a                            |
| Progress                   | **meter**: width at `base`                                                                                           | system                                                                                                          | wavy indicator                        | Tween                                                          | `NumberAnimation`            | Redraw at ≤ 10 Hz              |
| Waiting                    | **skeleton**: countdown ring drains linearly; 2 px shimmer                                                           | `ProgressView`                                                                                                  | `LoadingIndicator` inline             | countdown ring                                                 | countdown ring               | braille spinner, 80 ms a frame |
| Success                    | **success**: one check draw, `slow`                                                                                  | `.symbolEffect(.bounce)` once                                                                                   | one shape morph                       | one Tween                                                      | one check draw               | `✓` printed once               |

The [motion board](ui-kits/shots/web-motion-dark.png) shows the web keyframes. `motion: "system"`
follows `prefers-reduced-motion`, `accessibilityReduceMotion`,
`Settings.Global.ANIMATOR_DURATION_SCALE` and a Godot `ui_reduce_motion` option. Reduced motion
swaps instantly (S-23 D3): every duration is 0, with no opacity fade; `"none"` is the same. The
terminal never animates when stdout is not a TTY or `CI` is set. The star never animates (BRAND
§7.5).

---

## 5. Frameworks and architecture

### 5.1 The matrix

**must** ships in the first release of the parity pass; **should** follows; **could** is recipes,
thin adapters or demand-driven.

| Language / SDK | Framework                                                | Priority | Architecture                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS / TS        | **ui-core** (framework-neutral view models, theme, copy) | must     | `@polaris-key/ui-core` on `client-core`: the state machines of §4, the error → copy mapping, the theme resolver; grows from `@polaris-key/react/core`                                                                                                                                                                                           |
| JS / TS        | **Web Components**                                       | must     | `@polaris-key/elements`, Lit 3 over ui-core; shadow DOM, `::part`, slots, `--pk-*` vars, DOM events; the universal fallback                                                                                                                                                                                                                     |
| JS / TS        | **React** (web, Electron renderer, Tauri, Next.js)       | must     | `@polaris-key/react` rebuilt on ui-core: native React components (not wrappers) styled by `styles.css` in `@layer polaris-key`; `"use client"` boundaries; React 18 and 19 in CI                                                                                                                                                                |
| JS / TS        | **Electron** (main + preload)                            | must     | `@polaris-key/electron`: `registerPolarisKey` (main, wraps `@polaris-key/node`) and `exposePolarisKey` (preload, `contextBridge`); native menu items and notifications                                                                                                                                                                          |
| JS / TS        | Vue 3 / Nuxt                                             | optional | `@polaris-key/vue`: composables over ui-core plus typed wrappers over the elements; a Nuxt module (pending the owner's veto of "framework kits become recipes"; recipes are UK-31)                                                                                                                                                              |
| JS / TS        | Svelte 5 / SvelteKit                                     | optional | `@polaris-key/svelte`: rune stores over ui-core plus typed element wrappers (pending the owner's veto of "framework kits become recipes"; recipes are UK-31)                                                                                                                                                                                    |
| JS / TS        | Angular                                                  | optional | `@polaris-key/angular`: a signals service and standalone components wrapping the elements (pending the owner's veto of "framework kits become recipes"; recipes are UK-31)                                                                                                                                                                      |
| JS / TS        | React Native / Expo                                      | optional | `@polaris-key/react-native`: the React hooks over ui-core, screens in RN primitives, platform-adaptive (glass on iOS 26, M3E on Android), a native module over the Swift and Kotlin SDKs (pending the owner's veto of "framework kits become recipes"; recipes are UK-31)                                                                       |
| JS / TS        | Tauri v2                                                 | optional | `tauri-plugin-polaris-key` (Rust, a `@polaris-key/node` sidecar first) implementing the bridge over `invoke`; the web kits render unchanged (pending the owner's veto of "framework kits become recipes"; recipes are UK-31)                                                                                                                    |
| JS / TS        | ~~Host design systems~~                                  | dropped  | UK-22 dropped; recipes (UK-31) map host tokens onto `--pk-*`                                                                                                                                                                                                                                                                                    |
| JS / TS        | SolidJS, Preact, Qwik, htmx and plain pages              | could    | Recipes over the elements (Preact can also use React via compat)                                                                                                                                                                                                                                                                                |
| Swift          | **SwiftUI iOS / iPadOS 26** (iOS 18 floor)               | must     | `PolarisKeyUI` rebuilt: `@Observable` models over a pure-Swift presentation core, public composable views, `.polarisKeyGate`, glass on 26, a designed material fallback on 18                                                                                                                                                                   |
| Swift          | **SwiftUI macOS 26** (macOS 15 floor)                    | must     | Same kit plus Settings scene, `CommandGroup`s, sheets, a SwiftUI Sparkle user driver                                                                                                                                                                                                                                                            |
| Swift          | UIKit (and Mac Catalyst)                                 | should   | `PolarisKeyUIKit`: `PolarisKeyGateViewController`, `presentIfNeeded(from:client:)`, embeddable banner and status views; no second implementation                                                                                                                                                                                                |
| Swift          | AppKit                                                   | should   | `PolarisKeyAppKit`: `beginGateSheet(for:)`, a Preferences `NSViewController`, the Sparkle bridge                                                                                                                                                                                                                                                |
| Swift          | StoreKit 2 views                                         | should   | `Paywall` wraps `SubscriptionStoreView` / `StoreView` with the theme and entitlement mapping (`PolarisKeyPlatform` StoreService)                                                                                                                                                                                                                |
| Swift          | visionOS                                                 | should   | Glass windows, ornaments for banners, hover effects; declare `.visionOS`, CI                                                                                                                                                                                                                                                                    |
| Swift          | tvOS                                                     | should   | Focus-engine layouts, device-code first; fix `systemGroupedBackground` (SW); declare `.tvOS`, CI                                                                                                                                                                                                                                                |
| Swift          | watchOS                                                  | could    | Status glance and companion sign-in; first fix Core's 64-bit literal overflow (SW)                                                                                                                                                                                                                                                              |
| Swift          | WidgetKit, Live Activities, App Intents                  | could    | Update progress Live Activity, license widget, "Check for updates" intent                                                                                                                                                                                                                                                                       |
| Kotlin         | **Compose Multiplatform: Android** (M3 Expressive)       | must     | `:ui` becomes a KMP module (`commonMain` composables and states, `androidMain`); Material3 with Expressive on a version line decoupled from the Godot template pins (KO)                                                                                                                                                                        |
| Kotlin         | **Compose Multiplatform: Desktop JVM**                   | must     | `desktopMain`: the §1.4 desktop dialog model (sheets on macOS, `ContentDialog` on Windows, `AdwDialog` on Linux; update and settings as windows), the `windows`/`linux`/`macos` variants, keyboard focus rings, desktop density; UK-40 adds the OS keyring store and the desktop updater driver for full JVM parity                             |
| Kotlin         | Android Views (XML, Fragments)                           | should   | `PolarisKeyActivity` (ActivityResultContract), `PolarisKeyFragment`s, `ComposeView`-based XML views; also serves the Godot Android plugin                                                                                                                                                                                                       |
| Kotlin         | Android TV, Glance, notifications                        | could    | TV focus and device-code first; a Glance license/update widget; foreground-service pack progress                                                                                                                                                                                                                                                |
| Godot          | **Control nodes (GDScript)**                             | must     | The existing kit modernised in place on its controllers (§1.4, GO), plus the missing scenes and a `PKeySheet` host with a scrim                                                                                                                                                                                                                 |
| Godot          | Godot .NET (C#)                                          | should   | A typed C# facade over the same scenes: generated wrappers, typed signals, options records                                                                                                                                                                                                                                                      |
| Godot          | ~~Editor dock restyle; web-export overlay~~              | dropped  | UK-36 and UK-37 dropped                                                                                                                                                                                                                                                                                                                         |
| Python         | **ui-core**                                              | must     | `polaris_key.ui.core`: view models over `stages.py` and `get_sync_state()`, with a thread-marshalling hook (GA)                                                                                                                                                                                                                                 |
| Python         | **Qt** (PySide6 primary, PyQt6 via qtpy)                 | must     | `polaris_key.ui.qt`: **Qt Quick** screens as the drop-in (QML, `MultiEffect` blur, `Behavior` springs, the macOS/Windows/Linux variants, Mica via `DwmSetWindowAttribute`), QWidget parts with generated QSS as layer (b) with its limits stated, bundled fonts, Qt Linguist from the catalog, `QAccessible` names, signals marshal `on_change` |
| Python         | **Terminal** (rich, Textual)                             | must     | The CLI core restyled with rich (palette, rails, spinners, progress, a half-block QR for offline requests only, masked key), `--json` on every verb; optional Textual app                                                                                                                                                                       |
| Python         | ~~Tkinter (ttk)~~                                        | dropped  | Not built (owner, 2026-10-05: Python UI is Qt plus the terminal)                                                                                                                                                                                                                                                                                |
| Python         | wxPython, Kivy, web UIs (NiceGUI, Gradio, Flet)          | could    | Thin adapters over ui-core, or the elements embedded                                                                                                                                                                                                                                                                                            |
| Windows        | Native WinUI 3 / WPF                                     | could    | UK-60, optional and parked behind X-01 (C#/.NET SDK): the `windows` board as native Fluent over the .NET SDK. Until then Windows is reached through Electron, Tauri, Compose Desktop and Qt                                                                                                                                                     |
| Python         | Native GNOME (GTK 4 / libadwaita, PyGObject)             | could    | UK-61, optional and parked beside UK-38: `AdwStatusPage`, `AdwDialog`, `AdwPreferencesPage` over `polaris_key.ui.core`                                                                                                                                                                                                                          |
| Node           | **Terminal** (CLI prompts)                               | must     | `@polaris-key/node` CLI and `pkey` restyled (`util.styleText`, `NO_COLOR`, isatty), clack-style prompts with masked key entry, spinners, progress, a half-block QR for offline requests only, `--json`, grouped help and completion                                                                                                             |
| Node           | Ink                                                      | could    | `@polaris-key/node/ink` components over the same commands and stage core                                                                                                                                                                                                                                                                        |

### 5.2 One state machine, conformance-pinned

- The presentation state machines are specified once in **`conformance/corpus/v2/ui-matrix.json`**
  (generated by `pnpm gen corpus` from `tools/ui-matrix.ts`; `plans/UK-02b.md`): each row gives the
  inputs (license status, capabilities, decision, device list, error code, the sign-in session and
  I-04's license-choice views, the enabled services, presentation present or absent) and the
  expected component, state, copy keys and actions; `theme` and `i18n` rows pin theme resolution and
  the catalog. ui-core, the Swift presentation core, the Kotlin `commonMain` states, the Godot
  controllers and Python ui-core each run every row in their own test suite. This needs no wire
  change: the inputs are existing SDK results, approved views and kit-side values.
- **Parity:** `conformance/parity/features.json` has `ui.gate`, `ui.activate`, `ui.signin`,
  `ui.devicelimit`, `ui.devices`, `ui.update`, `ui.settings`, `ui.paywall`, `ui.theme` and `ui.i18n`,
  each proven by its `ui-matrix.json` family plus `{ "kind": "snapshot" }`, and `planned` in every
  SDK until its kit package runs the rows and renders them. `ui.signin` covers the whole sign-in form
  (SignIn, SignInHandoff and LicenseChoice); there is no separate `ui.kit.signin` row. The only N/A
  is `ui.activate`'s `outlet` on iOS and Android. Node's and Python's kits (the terminal and
  Electron, the terminal and Qt) implement all ten, so no new row allows `headless`; `ui.kit` keeps
  its `headless` N/A until UK-41 retires that row (GA).
- **The kit rule:** a feature package delivers layer (c) only, in one PR: its state in
  `components.json`, its keys in the catalog and its `ui-matrix.json` rows. The kits then render the
  new state.
- **Threading:** every core exposes a "deliver on the UI thread" hook (Qt signal,
  `MainActor`, `Dispatchers.Main`, Godot `call_deferred`), so hosts never meet the Python daemon
  thread problem (GA).

### 5.3 Packaging

- Web: `@polaris-key/ui-core`, `@polaris-key/elements` (also as a single CDN ES module), framework
  packages with subpath exports per component and `sideEffects` limited to the stylesheet.
- Swift: `PolarisKeyUI` (SwiftUI), `PolarisKeyUIKit`, `PolarisKeyAppKit` products in the one package;
  `Package.swift` declares iOS 18, macOS 15, visionOS 2 and tvOS 18 (watchOS 11 after the Core
  fix).
- Kotlin: `im.plrs.key:polaris-key-ui` (KMP: android, desktop), `polaris-key-ui-views`; ZXing and
  Rubik split into `polaris-key-ui-brand` so `native` hosts do not ship them (KO).
- Godot: the addon; the C# facade as an optional folder and NuGet package.
- Python: extras `polaris-key[qt]`, `[cli]` (rich), `[tui]` (Textual).

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
| Qt                   | PySide6 app                                                                                              |
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

Every component × state in the fixtures (§5.2) is rendered in **dark and light**, at every size
below that the kit runs at, and compared with a committed lossless baseline. This section is the
one home for the size matrix (owner, 2026-10-08: every kit screen adapts to its window, with
landscape layouts where the window is landscape).

**GUI kits** (logical pixels; on a desktop platform, the phone and tablet rows are window sizes):

| Row                | Size                                                                     | Kits                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phone portrait     | 390 × 844                                                                | every GUI kit                                                                                                                           |
| Phone landscape    | 844 × 390                                                                | every GUI kit                                                                                                                           |
| Small landscape    | 640 × 360                                                                | every GUI kit                                                                                                                           |
| Tablet             | 820 × 1180 and 1180 × 820                                                | every GUI kit                                                                                                                           |
| Desktop            | 1440 × 900                                                               | every GUI kit                                                                                                                           |
| Wide desktop       | 1920 × 1080                                                              | every GUI kit                                                                                                                           |
| TV                 | 1920 × 1080 at TV scale, focus navigation                                | tvOS, Android TV and Godot                                                                                                              |
| Godot game sizes   | 1280 × 720, 1280 × 800 (Steam Deck), 2560 × 1440, 3840 × 2160 at scale 2 | Godot                                                                                                                                   |
| 200 % text or zoom | Phone portrait, phone landscape and desktop, again                       | every GUI kit: browser zoom 200 % (web), AX3 Dynamic Type (Apple), font scale 2.0 (Compose), font scale 2 (Qt), content scale 2 (Godot) |
| 400 % zoom         | 1280 × 1024 at 400 % (320 × 256 CSS px, WCAG 1.4.10)                     | web kits and hosted pages: no page-level horizontal scroll; a table that scrolls sideways sits in a labelled, focusable region          |

The web boards draw the rows 844 × 390, 640 × 360, 820 × 1180, 1180 × 820 and 1920 × 1080 beside
390 × 844 and 1440 × 900. Forced-colors runs in both schemes (not dark only), and a
`prefers-contrast: more` render is added.

**Four rendering classes.** A fixture state is rendered by the class its kit belongs to:

- **Full visual host:** web, Apple, Compose, Qt, Godot. Pixel baselines in both schemes.
- **Focus-constrained host:** TV, console, pad-only and a screen reader's order. Baselines plus a
  focus pass: first focus on appear, after each async result, and Back or B out.
- **Terminal:** golden ANSI text and the VHS render at the terminal rows below.
- **Headless:** the view models (ui-core, the Swift and Kotlin cores, the Godot controllers). The
  fixture runner asserts the component, state, copy keys, primary action, refusal tone, error slot
  and initial-focus target, with no pixels.

**Fixtures strategy.** The shared fixtures cover each semantic state with these variants: a long
product name, a localised pack (`de`, `ja`), a custom light accent (`#ff6a3d`), a delayed response
past the DL7 threshold, cancellation and a recoverable failure. Variants render only at the
phone-portrait and desktop rows, not across the whole matrix. The reduced-motion render must reach
the same state as the animated one.

**Constrained hosts.** Rules the kits meet and the matrix checks:

- Android: predictive back (a mid-gesture shot at progress 0.5); API floors 24–35, with an API 30
  `native` render; no Google Play services (a no-GMS sign-in render); no browser.
- Windows 10, Remote Desktop and Transparency effects off render opaque, without Mica.
- Linux without a compositor, or under reduced transparency, renders opaque.
- OS contrast modes on desktop: Windows Contrast themes, macOS Increase Contrast, GNOME high
  contrast. A `contrast` render for Compose Desktop, Qt, Electron and SwiftUI macOS.
- Qt button order follows `QDialogButtonBox` per platform; the KDE Plasma form is Qt only.
- Flatpak and Snap open links through the OpenURI portal; Linux screen readers are checked through
  AT-SPI (Compose Desktop has none on Linux, which its page records).

**Terminal kits** (columns × rows):

| Row            | Size                                                             |
| -------------- | ---------------------------------------------------------------- |
| Tiny           | 24 × 24, 28 × 24, 32 × 24 (32 columns is the frame floor)        |
| Narrow         | 40 × 24                                                          |
| Small          | 60 × 24                                                          |
| Standard       | 80 × 24                                                          |
| Wide           | 120 × 40                                                         |
| Very wide      | 200 × 50                                                         |
| Short terminal | 80 × 12, 40 × 12, and 8, 10, 16 and 17 rows at 40 and 80 columns |

**Per kit:**

| Kit                                   | Tool                                                                           | Variants, beyond the sizes above                                                                                                                                                                                                     | Baselines                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| React, elements, Vue, Svelte, Angular | Playwright component tests (Chromium, WebKit)                                  | at 2x; `polaris-key` and `native`; `forced-colors` (dark only); keyboard-focus state shots                                                                                                                                           | `packages/<kit>/test/visual/__screenshots__/`                         |
| SwiftUI, UIKit, AppKit                | swift-snapshot-testing on iOS 26 and macOS 26 simulators/hosts                 | iPhone, iPad and Mac devices for the matching rows; iOS 18 and macOS 15 fallbacks                                                                                                                                                    | `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`           |
| Compose                               | Roborazzi (exists, 136 baselines) + Compose Desktop screenshot tests           | Windows, macOS and Linux chrome on the desktop rows; native preset                                                                                                                                                                   | `sdks/kotlin/ui/src/test/snapshots/`                                  |
| Godot                                 | `tools/ui_screenshots.gd` (exists) promoted to a compared suite                | native; opaque fallback                                                                                                                                                                                                              | `sdks/godot/tests/ui/snapshots/`                                      |
| Qt                                    | pytest-qt `grab()`, offscreen                                                  | macOS, Windows and Linux styles; native                                                                                                                                                                                              | `sdks/python/tests/ui/snapshots/`                                     |
| Terminal                              | Golden ANSI text + an SVG rendered by a real terminal (VHS) at line-height 1.2 | truecolor, ANSI-16, `NO_COLOR`, ascii; long values, de and ja, a height-shrinking resize mid-flow, every ending, one shared text file both kits draw alike (`ui-kits/terminal-parity.json`), faint text on the Solarized QA palettes | `packages/sdk-node/test/cli/golden/`, `sdks/python/tests/cli/golden/` |

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

**Where it runs** (UK-15): `pnpm ui:lint` (`packages/ui-qa`) lints every mockup board in both
themes, any kit stylesheet (`--css=`) or page (`--html=`), and the native kits' sources; a web kit's
component tests call `lintPage()` from the same package. The mockups of native kits use the
`native` profile, which leaves `colour-literal` and `interactive-states` to the kit's own lane. A
board's platform chrome, captions and justified exceptions are listed, each with its reason, in
`packages/ui-qa/src/boards.ts`. Copy that predates the string lint is recorded in
`packages/ui-qa/rules/strings.debt.json` and the native kits' existing hits in `kit-debt.json`;
both ledgers only shrink. The per-kit runtime helpers are `sdks/godot/tests/support/ui_lint.gd`
(every engine icon themed) and `sdks/python/tests/ui_lint_qt.py` (the Qt widget tree).

**Borders, focus and depth:**

- no border wider than 1 px, and none of 1.5 px or more on a selected or resting control;
- no `box-shadow` spread ring on focus, and no focus ring outside `:focus-visible`;
- no coloured `box-shadow` under buttons (`no-button-glow`);
- no accent-tinted border, rim or shadow under `native` or forced colours;
- no static accent rule under a title bar or header (`static-top-accent-rule`).

**Type:**

- no `font-family` other than the theme's;
- no `font-weight: 700` outside the allow list;
- no text below 12 px, and no fractional px sizes;
- no `text-transform: uppercase` on buttons;
- no `vw` units in kit CSS (container units only);
- no orphaned last line in headings, ledes and list-row meta (a snapshot check over the baselines);
- the tier is one text run with the product name ("Tidewater Studio · Pro"): the separator never
  sits in its own flex item, so a layout `gap` can never open before the dot;
- license keys never wrap inside a field (`white-space: nowrap` with the middle ellipsis of §4.3);
- RTL-safe layout: no physical `left`/`right`, `margin-left`/`padding-right` or `text-align: left`
  in kit CSS (logical properties only), and the per-kit equivalents (no `.padding(.left)` in
  SwiftUI, no `Alignment.Left`/`absolutePadding` in Compose). This keeps the later RTL pass cheap;
  it is not an RTL QA gate.

**Shape and material:**

- no square-cornered row, list or band inside a rounded container: a list takes the group radius
  and clips its rows; an inline confirm or highlight sits inset with its own radius
  (group − inset);
- no glass on glass: a control on a blurred sheet is a flat fill, never a second `backdrop-filter`;
- a modal scrim dims the whole window evenly (the title bar included where the platform does),
  never a light wash over part of it;
- no empty placeholder box where an image or logo belongs in a published mockup or example.

**Behaviour and code:**

- touch targets ≥ 44 px on touch variants;
- no `alert` / `confirm` calls;
- every interactive element has hover, active, disabled and focus-visible styles;
- no colour literal outside the generated tokens;
- one primary per region; no X beside a Cancel;
- `accent-as-status`: a service-accent colour on a status, alert or StatusPill element (accent
  identifies context, never success or failure);
- `section-index`: a heading preceded by a bare two-digit index;
- `code-no-wrap`: CodeDisplay and the key field never wrap and break only at the hyphen at 200 %;
- raw escape: a terminal kit writes no escape sequence outside its painter;
- drifted board copy: board strings are diffed against the catalog (the string lint below);
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
them, and it is fixed before review. Source precedence is stated in the opening section. The review follows the checklist in
[ui-kits/REVIEW.md](ui-kits/REVIEW.md); `pnpm ui:report` lays the kit's baselines beside the
mockups for it.

---

## 8. Mockups

HTML mockups of the key components in the Polaris look, rendered from the generated tokens
(`packages/brand/css/tokens.css` and `kit.css`) with the kit fonts as the package ships them
(`packages/brand/fonts/fonts.css`: variable Rubik and JetBrains Mono) and the Material Symbols subset
for Android (`docs/design/ui-kits/fonts/`). Every accent on the boards is the resolver's output
(§3.3).

- **Sources:** `docs/design/ui-kits/{web,ios,apple,android,desktop,windows,linux,qt,godot,terminal}.html`.
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

| Dark                                                           | Light                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| ![Gate](ui-kits/shots/web-gate-dark.png)                       | ![Gate](ui-kits/shots/web-gate-light.png)                       |
| ![Activate](ui-kits/shots/web-activate-dark.png)               | ![Activate](ui-kits/shots/web-activate-light.png)               |
| ![Sign in](ui-kits/shots/web-sign-in-dark.png)                 | ![Sign in](ui-kits/shots/web-sign-in-light.png)                 |
| ![Device limit](ui-kits/shots/web-device-limit-dark.png)       | ![Device limit](ui-kits/shots/web-device-limit-light.png)       |
| ![Update](ui-kits/shots/web-update-dark.png)                   | ![Update](ui-kits/shots/web-update-light.png)                   |
| ![Settings](ui-kits/shots/web-settings-dark.png)               | ![Settings](ui-kits/shots/web-settings-light.png)               |
| ![Theming](ui-kits/shots/web-theming-dark.png)                 | ![Theming](ui-kits/shots/web-theming-light.png)                 |
| ![States](ui-kits/shots/web-states-dark.png)                   | ![States](ui-kits/shots/web-states-light.png)                   |
| ![Components](ui-kits/shots/web-components-dark.png)           | ![Components](ui-kits/shots/web-components-light.png)           |
| ![Layers](ui-kits/shots/web-layers-dark.png)                   | ![Layers](ui-kits/shots/web-layers-light.png)                   |
| ![Motion](ui-kits/shots/web-motion-dark.png)                   | ![Motion](ui-kits/shots/web-motion-light.png)                   |
| ![forced-colors](ui-kits/shots/web-forced-colors-dark.png)     | ![forced-colors](ui-kits/shots/web-forced-colors-light.png)     |
| ![Native, full screen](ui-kits/shots/web-native-full-dark.png) | ![Native, full screen](ui-kits/shots/web-native-full-light.png) |

`forced-colors` is drawn in the Windows contrast themes (Night sky for dark, Desert for light): every
colour is a system colour, borders return, the ambient and tints go, and the product icon stays
because it is an image.

At 390 × 844:

| Gate                                      | Sign in                                      | Device limit                                      | Settings                                      |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/web-gate-390-dark.png)  | ![](ui-kits/shots/web-sign-in-390-dark.png)  | ![](ui-kits/shots/web-device-limit-390-dark.png)  | ![](ui-kits/shots/web-settings-390-dark.png)  |
| ![](ui-kits/shots/web-gate-390-light.png) | ![](ui-kits/shots/web-sign-in-390-light.png) | ![](ui-kits/shots/web-device-limit-390-light.png) | ![](ui-kits/shots/web-settings-390-light.png) |

#### iOS 26 (SwiftUI, Liquid Glass)

The iOS board has the gate, the activate sheet with the iOS 26 keyboard, the inline one-form sign-in with
the logo-only provider row, device limit, the non-blocking update banner, a mandatory update sheet, and account
settings.

| Gate                                  | Activate                                  | Sign in                                  | Device limit                                  | Update                                  | Update required                                  | Settings                                  |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------- | --------------------------------------------- | --------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| ![](ui-kits/shots/ios-gate-dark.png)  | ![](ui-kits/shots/ios-activate-dark.png)  | ![](ui-kits/shots/ios-sign-in-dark.png)  | ![](ui-kits/shots/ios-device-limit-dark.png)  | ![](ui-kits/shots/ios-update-dark.png)  | ![](ui-kits/shots/ios-update-required-dark.png)  | ![](ui-kits/shots/ios-settings-dark.png)  |
| ![](ui-kits/shots/ios-gate-light.png) | ![](ui-kits/shots/ios-activate-light.png) | ![](ui-kits/shots/ios-sign-in-light.png) | ![](ui-kits/shots/ios-device-limit-light.png) | ![](ui-kits/shots/ios-update-light.png) | ![](ui-kits/shots/ios-update-required-light.png) | ![](ui-kits/shots/ios-settings-light.png) |

The iOS 18 fallback (the same layout on system materials), AX3 Dynamic Type, the StoreKit paywall,
the Live Activity (a content-pack download, not an app update), and boot, status and error:

| iOS 18                                 | AX3                                  | Paywall                                  | Live Activity                                  | Boot, status, error                     |
| -------------------------------------- | ------------------------------------ | ---------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| ![](ui-kits/shots/ios-ios18-dark.png)  | ![](ui-kits/shots/ios-ax3-dark.png)  | ![](ui-kits/shots/ios-paywall-dark.png)  | ![](ui-kits/shots/ios-live-activity-dark.png)  | ![](ui-kits/shots/ios-states-dark.png)  |
| ![](ui-kits/shots/ios-ios18-light.png) | ![](ui-kits/shots/ios-ax3-light.png) | ![](ui-kits/shots/ios-paywall-light.png) | ![](ui-kits/shots/ios-live-activity-light.png) | ![](ui-kits/shots/ios-states-light.png) |

#### iPadOS, visionOS, tvOS and watchOS

iPad at regular width with the activate form sheet, the welcome window in a visionOS room (glass is
always the system material; a gaze-hover state), tvOS device-code sign-in under the focus engine,
and the watchOS glance.

| iPad                                    | visionOS                                    | tvOS                                    | watchOS                                  |
| --------------------------------------- | ------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| ![](ui-kits/shots/apple-ipad-dark.png)  | ![](ui-kits/shots/apple-visionos-dark.png)  | ![](ui-kits/shots/apple-tvos-dark.png)  | ![](ui-kits/shots/apple-watch-dark.png)  |
| ![](ui-kits/shots/apple-ipad-light.png) | ![](ui-kits/shots/apple-visionos-light.png) | ![](ui-kits/shots/apple-tvos-light.png) | ![](ui-kits/shots/apple-watch-light.png) |

#### Android (Compose, Material 3 Expressive)

The Android board shows the product icon in the adaptive mask, filled fields with the IME up,
the logo-only provider row, the inline `LoadingIndicator`, connected lists, and a bottom sheet with
wavy progress and equal-width buttons.

| Gate                                      | Activate                                      | Sign in                                      | Hand-off                                             | Device limit                                      | Update                                      | Settings                                      |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| ![](ui-kits/shots/android-gate-dark.png)  | ![](ui-kits/shots/android-activate-dark.png)  | ![](ui-kits/shots/android-sign-in-dark.png)  | ![](ui-kits/shots/android-sign-in-handoff-dark.png)  | ![](ui-kits/shots/android-device-limit-dark.png)  | ![](ui-kits/shots/android-update-dark.png)  | ![](ui-kits/shots/android-settings-dark.png)  |
| ![](ui-kits/shots/android-gate-light.png) | ![](ui-kits/shots/android-activate-light.png) | ![](ui-kits/shots/android-sign-in-light.png) | ![](ui-kits/shots/android-sign-in-handoff-light.png) | ![](ui-kits/shots/android-device-limit-light.png) | ![](ui-kits/shots/android-update-light.png) | ![](ui-kits/shots/android-settings-light.png) |

Tablet list-detail, 200 % font, predictive back, dynamic colour under `native`, and boot, status
and error:

| Tablet                                      | 200 % font                                    | Predictive back                                      | Native, dynamic colour                              | Boot, status, error                         |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| ![](ui-kits/shots/android-tablet-dark.png)  | ![](ui-kits/shots/android-font-200-dark.png)  | ![](ui-kits/shots/android-predictive-back-dark.png)  | ![](ui-kits/shots/android-native-dynamic-dark.png)  | ![](ui-kits/shots/android-states-dark.png)  |
| ![](ui-kits/shots/android-tablet-light.png) | ![](ui-kits/shots/android-font-200-light.png) | ![](ui-kits/shots/android-predictive-back-light.png) | ![](ui-kits/shots/android-native-dynamic-light.png) | ![](ui-kits/shots/android-states-light.png) |

#### macOS 26 (SwiftUI; Electron and Tauri on macOS)

The macOS board is drawn at Mac scale: the split Welcome window with product art, inset rounded
sheets below the title-bar row, the single-column update window, and the Settings scene.

| Dark                                                          | Light                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Gate](ui-kits/shots/desktop-gate-dark.png)                  | ![Gate](ui-kits/shots/desktop-gate-light.png)                  |
| ![Activate](ui-kits/shots/desktop-activate-dark.png)          | ![Activate](ui-kits/shots/desktop-activate-light.png)          |
| ![Sign in](ui-kits/shots/desktop-sign-in-dark.png)            | ![Sign in](ui-kits/shots/desktop-sign-in-light.png)            |
| ![Device limit](ui-kits/shots/desktop-device-limit-dark.png)  | ![Device limit](ui-kits/shots/desktop-device-limit-light.png)  |
| ![Update](ui-kits/shots/desktop-update-dark.png)              | ![Update](ui-kits/shots/desktop-update-light.png)              |
| ![Settings](ui-kits/shots/desktop-settings-dark.png)          | ![Settings](ui-kits/shots/desktop-settings-light.png)          |
| ![macOS 15](ui-kits/shots/desktop-macos15-dark.png)           | ![macOS 15](ui-kits/shots/desktop-macos15-light.png)           |
| ![Boot, status, error](ui-kits/shots/desktop-states-dark.png) | ![Boot, status, error](ui-kits/shots/desktop-states-light.png) |

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
| ![](ui-kits/shots/windows-states-dark.png)   | ![](ui-kits/shots/windows-states-light.png)   |
| ![](ui-kits/shots/linux-states-dark.png)     | ![](ui-kits/shots/linux-states-light.png)     |

#### Qt (Qt Quick and QWidget, Python)

Drawn as Qt draws them, from the generated `Theme.qml` and QSS: the Qt Quick gate on Windows, the
activate dialog on Linux in the KDE Breeze frame with KDE's affirmative-first button order, the QWidget parts by object name, and boot, status
and error.

| Dark                                          | Light                                          |
| --------------------------------------------- | ---------------------------------------------- |
| ![](ui-kits/shots/qt-quick-gate-dark.png)     | ![](ui-kits/shots/qt-quick-gate-light.png)     |
| ![](ui-kits/shots/qt-quick-activate-dark.png) | ![](ui-kits/shots/qt-quick-activate-light.png) |
| ![](ui-kits/shots/qt-widgets-dark.png)        | ![](ui-kits/shots/qt-widgets-light.png)        |
| ![](ui-kits/shots/qt-states-dark.png)         | ![](ui-kits/shots/qt-states-light.png)         |

#### Godot (Control nodes)

The Godot board (1280 × 720, plus 1280 × 800 for Steam Deck; the kit is held to the DL15 matrix) uses dark by default: glass panels on a
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
| ![Boot](ui-kits/shots/godot-boot-dark.png)                 | ![Boot](ui-kits/shots/godot-boot-light.png)                 |
| ![Status](ui-kits/shots/godot-status-dark.png)             | ![Status](ui-kits/shots/godot-status-light.png)             |
| ![Error](ui-kits/shots/godot-error-dark.png)               | ![Error](ui-kits/shots/godot-error-light.png)               |

#### Terminal (Node and Python CLIs, Textual)

The terminal board is drawn in a real cell grid at line-height 1.2, 80 columns. It covers
device-code sign-in without a QR (SIGN-IN.md D-67, D-68), masked key entry that never echoes the
key, the device limit's browser hand-off (SIGN-IN.md §4.15: the terminal opens `manageUrl` to
replace a device), status and update progress, a blocked status with its fix as a command, grouped
help, the four colour and symbol fallbacks plus a fifth, the pipe (no escapes, no spinner, each line printed once), 60-, 40- and 32-column renders and a Textual app. Refusals are ▲ with exit codes per UK-51. The sign-in,
activate, device-limit, help, fallback and 60-column shots follow the Node kit's goldens
(`packages/sdk-node/test/cli/golden/`). Textual buttons share one shape (a one-row block with one cell of padding): the
primary in the accent, the secondary as a tonal block, never bracketed `[ text ]` buttons beside
blocks.

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
| ![States](ui-kits/shots/terminal-states-dark.png)             | ![States](ui-kits/shots/terminal-states-light.png)             |

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

**Drawn in UK-01 (2026-10-05)**, so §7.4 has a reference for each (the boards above):

- web: `forced-colors`, and the native preset at full screen;
- Apple: iPad regular width, visionOS, tvOS, the watchOS glance, the iOS 18 and macOS 15 fallbacks, AX3
  Dynamic Type, StoreKit Paywall and the Live Activity;
- Android: tablet list-detail, the 200 % font stack, predictive back and dynamic colour under
  `native`;
- everywhere: the Boot, StatusScreen and error states on every non-web board;
- the Qt Quick screens and QWidget parts, rendered rather than borrowed from the web variants.

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

**Work packages.** Each item below is a work package in phase **UK** of the execution program, with
its brief at `program/wp/UK-<nn>-*.md`, its estimate, dependencies and role in `workpackages.json`.
The graph orders them: UK-01 (tokens) and the UK-02 plan start at once; UK-02a and UK-02b execute
the approved plan; UK-15 (the QA harness and lint) and UK-16 (the docs scaffold) follow; then UK-03
(ui-core) and the non-JS kits; the JS kits after UK-03; the should and could tiers after the kit
they extend. UK-41 closes the must tier.

**Wire impact.** None of the items changes the wire: kits consume existing SDK results. The product
presentation (accent, `accentDark`, icon) is a wire addition, but it is owned by HA-04 and HA-11 to
HA-14, not by this programme; the kits read it through the SDK. One item touches shared contracts
and goes through plan mode (CLAUDE.md): **UK-02** (the kit copy catalog beside SP-00's
`copy.en.json`, new `conformance` UI fixtures, new `features.json` parity rows with every SDK's
`parity.json` following). It is split into a planning package (UK-02, `pkey-wire-planner`) and two
packages that execute the approved `plans/UK-02.md`: UK-02a (catalog, generators, locale packs) and
UK-02b (fixtures and parity rows).

**Presentation seam.** Kits do not list HA-13 or HA-14 as dependencies. Each core's
`ProductIdentity` resolver takes an optional presentation source from the SDK; a kit built before
its SDK's HA package lands tests the default with a fake source, and the real accessor plugs in with
no kit change. UK-41 verifies the end-to-end default once HA-13 and HA-14 are done.

### must

| Id     | SDK    | Framework                            | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-01  | brand  | Tokens for every kit                 | variable Rubik (wght 300–900) and the kit mono (JetBrains Mono) replacing the static 400/700 files, weight tokens 500/600, `typeScale`; `kit.ts` component tokens; `deriveAccent` and the white-first `resolveAccent` with shared vectors; new targets (CSS `kit.css`, JS, Python `_tokens.py` + QSS, ANSI for Node and Python, C#); Compose Resources fonts; Rubik TTFs for Python; `resolveAccent` with shared vectors; drift gate over all outputs; BRAND.md §7.1/§12/§12.1 and owner-decision updates (§9)                                                                                                                                                                                                                  |
| UK-02  | shared | Copy catalog, fixtures, parity: plan | `plans/UK-02.md` (plan mode, `pkey-wire-planner`): the `packages/brand/kit-copy/` ICU catalog beside SP-00's `copy.en.json` (kit strings reference `core.copy` keys, never duplicate them), its generators, the fixture format and path, the `ui.*` parity rows and every SDK's manifest change                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UK-02a | shared | Copy catalog and locale packs        | Executes `plans/UK-02.md`: `kit-copy/en.json` (~220 keys) with generators for JSON, xcstrings, Compose Resources, gettext and terminal tables; the eight launch locale packs (`reviewed: false`); the generated-file drift gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UK-02b | shared | UI fixtures and parity rows          | Executes `plans/UK-02.md`: the UI state fixtures under `conformance/` (component, state and copy keys per input), the shared fixture runner contract, `features.json` `ui.gate`…`ui.i18n` rows, every SDK's `parity.json` at `planned` with its UK item named (SP-00 has already replaced the `headless` N/A with `ui.cli`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| UK-03  | js     | ui-core                              | `@polaris-key/ui-core`: §4 state machines and actions over `client-core`, error → copy keys, theme resolution (preset, accent, scheme, density, motion), product identity resolution, the fixture runner; grows from `@polaris-key/react/core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UK-04  | js     | Web Components (Lit)                 | `@polaris-key/elements`: every §4.1 component as `pk-*`, `::part`/slots/events, `@font-face` for Rubik and the kit mono with fallback metrics, the shared `styles.css` via `adoptedStyleSheets`, container-query layouts, native `<dialog>` + scrim, View Transitions, platform variants, CDN build served by the Worker at `key.plrs.im/elements/<major>/pk.js` (rule 10); Playwright baselines; static and htmx samples                                                                                                                                                                                                                                                                                                       |
| UK-05  | js     | React                                | Rebuild `@polaris-key/react` on ui-core: Polaris look by default, class/`data-part` styling in `@layer polaris-key` (states, motion), scoped vars (no `:root` writes), `<PolarisKeyGate>` one-liner, every missing screen (device limit, handoff, progress, paywall, release notes, account, about, sync, toast, typed settings), `"use client"`, React 19 in CI, Vite + Next.js samples                                                                                                                                                                                                                                                                                                                                        |
| UK-06  | js     | Electron                             | `@polaris-key/electron`: `registerPolarisKey` (main, over `@polaris-key/node`), `exposePolarisKey` (preload), invoke routes for bridge v3, menu items, notifications, autoUpdater progress into UpdateProgress; Forge sample                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| UK-07  | swift  | SwiftUI iOS / iPadOS 26              | Rebuild `PolarisKeyUI`: pure-Swift presentation core running the fixtures, `@Observable` models with a status stream (no flash of wrong state, live updates), public components, `.polarisKeyGate`, glass on 26 with a designed material fallback on iOS 18 (the floor; `Package.swift` raised to iOS 18 / macOS 15 / tvOS 18 / visionOS 2 / watchOS 11), capsule controls, sheets, String Catalog, typed errors, `#Preview` states, swift-snapshot-testing baselines; fixes "this Mac" copy                                                                                                                                                                                                                                    |
| UK-08  | swift  | SwiftUI macOS 26                     | Settings scene pane, `CommandGroup`s (Check for Updates…, Manage License…, About), sheets instead of window takeovers, SwiftUI `SPUUserDriver` for Sparkle, the inactive-window prominent-button fix (no forced foreground), Mac baselines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| UK-09  | kotlin | Compose Multiplatform: Android       | `:ui` to KMP (`commonMain` + `androidMain`) on a version line decoupled from the Godot template pins; Material 3 Expressive (MotionScheme, LoadingIndicator, button groups, shapes, wavy progress), Material Symbols Rounded, adaptive layouts, `rememberPolaris*State`, ViewModel/SavedState, a navigation graph and deep links, `PolarisKeyGate` one-liner, missing screens; Roborazzi re-baselined                                                                                                                                                                                                                                                                                                                           |
| UK-10  | kotlin | Compose Multiplatform: Desktop       | `desktopMain`: the §1.4 desktop dialog model and the Windows/Linux/macOS variants, keyboard focus rings, desktop density, open-URL and theme `expect/actual`, Windows/macOS/Linux sample, desktop screenshot tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UK-11  | godot  | Control nodes (GDScript)             | Modernise in place: brand default (dark scheme), glass panel and `PKeySheet` host with scrim and the opaque fallback, `product.wordmark` and `typography.display`, `PKeyInputGlyphs` with the confirm swap, the console focus ring, type floor, toast anchor, UI sound hooks and haptics, MSDF fonts and `ui_scale`, every engine control icon themed (switch, spin, option, scrollbar, slider, tab), elevation, 60 px controls, icon set, Tween motion with reduced motion, OS dark-mode follow, safe areas, AccessKit names and live regions; new scenes (DeviceLimit, Devices, Paywall, Account tab, CloudSyncStatus, About, Toast, UpdateProgress, ReleaseNotes); copy fixes (no raw codes or slugs); POT export; baselines |
| UK-12  | python | ui-core + Qt (PySide6, PyQt6)        | `polaris_key.ui.core` view models (fixtures, UI-thread hook) and `polaris_key.ui.qt` Qt Quick screens (QWidget parts as layer b) with generated QSS, bundled Rubik, Linguist catalogs from UK-02a, `QAccessible`, `run_gate`; `[qt]` extra; PySide6 sample; pytest-qt baselines; Python `parity.json` `ui.*` proofs                                                                                                                                                                                                                                                                                                                                                                                                             |
| UK-13  | python | Terminal (rich, Textual)             | Restyle the CLI core with rich (ANSI-16 status roles with a truecolor product chip, 80-column layout degrading to 60, continuous rails, braille spinner, half-block QR for offline requests only (none for sign-in, D-67; the device limit hands off to the browser), OSC 8 links and OSC 52 copy, the device limit's browser hand-off to `manageUrl`), error-code → copy mapping, `--json` on every verb, `NO_COLOR`/ANSI-16, optional Textual app; golden tests                                                                                                                                                                                                                                                               |
| UK-14  | node   | Terminal (CLI prompts, `pkey`)       | Restyle the sdk-node CLI and `pkey` to the §1.4 terminal row (ANSI-16 roles, 80 columns, half-block QR for offline requests only, OSC 8/52): clack-style prompts, masked key entry (fixes the positional `activate <key>` leak), spinners and progress for sync, packs and publish, the device limit's browser hand-off, `--json`, grouped help, completion, `pkey init --help` and `validate <path>` fixes; golden tests                                                                                                                                                                                                                                                                                                       |
| UK-15  | shared | Visual QA harness + modernity lint   | `pnpm ui:report` side-by-side report from every kit's baselines; the React/elements pixel diff; the §7.3 lint (including the string lint and the orphan check) for web kits and the per-kit equivalents; CI wiring per lane; designer review checklist                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| UK-16  | docs   | Docs section + samples hub           | The `build/ui/` scaffold kits write into: overview, theming, localisation, the component-page template that embeds baseline images, the framework-page template, recipes, the `examples/ui/` index; each kit then adds its own pages and slims its README; the docs drift gates for the new routes                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UK-40  | kotlin | JVM desktop parity (SP-K12)          | An OS keyring store (Keychain, Credential Manager, Secret Service) and a desktop updater driver (download the installer for the OS and arch through `release.fetch`, verify, open), default `UpdateSlots`; the Compose Desktop UpdatePrompt drives it (UK-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| UK-41  | shared | Must-tier close-out                  | End-to-end check that every must kit takes the product's presentation accent and icon with zero integrator code once HA-13 and HA-14 are done; `pnpm ui:report` across all must kits reviewed (§7.4); `ui.*` parity rows flipped to proven; docs component pages complete                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### should

| Id        | SDK    | Framework               | Scope                                                                                                                                                                                                                                               |
| --------- | ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-17     | js     | Vue 3 / Nuxt            | `@polaris-key/vue` composables over ui-core, typed element wrappers, Nuxt module (SSR-safe), Nuxt sample, Playwright baselines                                                                                                                      |
| UK-18     | js     | Svelte 5 / SvelteKit    | `@polaris-key/svelte` rune stores, typed element wrappers, SvelteKit sample, baselines                                                                                                                                                              |
| UK-19     | js     | Angular                 | `@polaris-key/angular` signals service, standalone wrapper components, Angular sample, baselines                                                                                                                                                    |
| UK-20     | js     | React Native / Expo     | `@polaris-key/react-native`: hooks over ui-core, RN screens with platform-adaptive styling and sheets, native module bridging the Swift and Kotlin SDKs, Expo sample, Maestro or Detox screenshots                                                  |
| UK-21     | js     | Tauri v2                | `tauri-plugin-polaris-key`: a thin Rust plugin that runs a `@polaris-key/node` sidecar and forwards the bridge over `invoke`/events (the native Rust SDK stays X-02, optional); Tauri sample                                                        |
| ~~UK-22~~ | js     | ~~Host design systems~~ | Tailwind v4 preset, shadcn/ui registry over the React hooks (served at `key.plrs.im/r/<name>.json`, rule 10), MUI/Mantine/Chakra theme objects from the tokens, "go native" recipes **Dropped** (2026-10-09 brand transition); the id is not reused |
| UK-23     | swift  | UIKit (+ Mac Catalyst)  | `PolarisKeyUIKit`: gate view controller, `presentIfNeeded`, embeddable banner/status views over the SwiftUI kit; Catalyst tested; sample and snapshots                                                                                              |
| UK-24     | swift  | AppKit                  | `PolarisKeyAppKit`: sheet presenters, Preferences view controller, Sparkle bridge; sample and snapshots                                                                                                                                             |
| UK-25     | swift  | StoreKit 2 paywall      | `Paywall` over `SubscriptionStoreView`/`StoreView` with theme and entitlement mapping via `PolarisKeyPlatform`; restore; snapshots                                                                                                                  |
| UK-26     | swift  | visionOS                | Glass windows, ornaments for banners, hover effects; `.visionOS` declared; CI and snapshots                                                                                                                                                         |
| UK-27     | swift  | tvOS                    | Focus-engine layouts, device-code first; `systemGroupedBackground` fix; `.tvOS` declared; CI and snapshots                                                                                                                                          |
| UK-28     | kotlin | Android Views interop   | `polaris-key-ui-views`: `PolarisKeyActivity` + result contract, Fragments, XML-inflatable ComposeView views with theme attrs; sample                                                                                                                |
| UK-29     | godot  | Godot .NET (C#)         | Generated typed C# facade over the GDScript scenes and controllers, `PKeyBrand.generated.cs`, NuGet/addon folder, C# demo twin                                                                                                                      |
| ~~UK-30~~ | python | ~~Tkinter (ttk)~~       | **Dropped** (owner, 2026-10-05: Python UI is Qt plus the terminal). Kept in the graph as `dropped` so the id is not reused                                                                                                                          |

### could

| Id        | SDK    | Framework                               | Scope                                                                                                                                                   |
| --------- | ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-31     | js     | SolidJS, Preact, Qwik, htmx             | Recipes over the elements (Solid signals adapter if demanded)                                                                                           |
| UK-32     | node   | Ink                                     | `@polaris-key/node/ink` components over the commands and stage core                                                                                     |
| UK-33     | swift  | watchOS                                 | Core 64-bit literal fix, status glance, companion sign-in                                                                                               |
| UK-34     | swift  | WidgetKit, Live Activities, App Intents | Update-progress Live Activity, license widget, intents                                                                                                  |
| UK-35     | kotlin | Android TV, Glance, notifications       | TV focus and device-code first; Glance widget; foreground-service pack progress                                                                         |
| ~~UK-36~~ | godot  | ~~Editor dock restyle~~                 | Setup dock aligned to the tokens within the editor theme; scene previews in both themes **Dropped** (2026-10-09 brand transition); the id is not reused |
| ~~UK-37~~ | godot  | ~~Web-export overlay~~                  | Elements for sign-in and paywall on HTML5 exports via `JavaScriptBridge` **Dropped** (2026-10-09 brand transition); the id is not reused                |
| UK-38     | python | wxPython, Kivy                          | Thin adapters over ui-core                                                                                                                              |
| UK-39     | python | Web UIs (NiceGUI, Gradio, Flet)         | Embed the elements or a small adapter over ui-core                                                                                                      |

### added after the brand transition (2026-10-09)

Ids are assigned by the lead; the graph holds the briefs.

| Id    | SDK    | Framework                    | Scope                                                                                                                                                                              |
| ----- | ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-59 | shared | Built-kit boards refresh     | Redraw the boards of the built kits (web, ios, apple iPad, android, godot, terminal) from the reviewed builds and this document; render both themes, `pnpm ui:lint`, mockup review |
| UK-60 | c#     | Native Windows (WinUI 3/WPF) | Optional, parked behind X-01 (§5.1)                                                                                                                                                |
| UK-61 | python | Native GNOME (libadwaita)    | Optional, parked beside UK-38 (§5.1)                                                                                                                                               |
| UK-62 | shared | Kit playground bundle        | A static bundle built here that the website and the console drop-in preview embed                                                                                                  |

---

## 11. Questions for the owner

All answered on 2026-10-05, by the owner or by the lead under delegation; the "Owner decisions
(2026-10-05)" table at the top is the record. In short:

1. **Product accent at the source.** Yes, through the registered presentation, but not as a new
   package: HA-04 (manifest `presentation { icon, accent, accentDark }`) and HA-11 to HA-14
   (discovery, SDKs, kit defaults) build it; SP-11 is dropped. The icon-derived accent stays as the
   fallback.
2. **The no-icon fallback.** Ink (lead).
3. **Launch locales.** English, `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; no Arabic, so
   RTL moves to later (RTL-safe layouts, no RTL gate).
4. **OS floors.** iOS 18 / iPadOS 18 / macOS 15 / tvOS 18 / visionOS 2 / watchOS 11; Liquid Glass on
   26 with a polished fallback on 18; no iOS 17 work.
5. **Lit for the elements.** Lit 3.
6. **Rubik on Apple platforms.** Rubik everywhere with `UIFontMetrics` (lead).
7. **The kit mono.** JetBrains Mono (lead).
8. **Device-code vanity URLs.** Kit-level `product.deviceCodeUrl` now; a presentation field is a
   later HA follow-up (lead).
9. **Games default to dark.** Agreed (lead).
10. **Service cues.** Off on product screens, opt-in (lead).

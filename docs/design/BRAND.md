# Polaris Key design system

The spec every Polaris Key surface follows: the admin console and customer portal, the docs site,
the Worker's HTML pages and emails, the bytes host (dl.plrs.im), the React SDK UI, the Godot UI kit
and the SwiftUI gate. **`packages/brand` (`@polaris-key/brand`) is its implementation.** When this
page and the package disagree, the package's tests decide and this page gets fixed in the same
change.

- **Source of truth for artwork:** the Polaris Key Launch Kit v1 (30 September 2026), copied
  verbatim into `packages/brand/kit/` and checksum-tested against the kit's `SHA256SUMS.txt`. SVG
  is the master. Marks are never redrawn, recoloured outside the rules below, or re-traced.
- **Source of truth for UI colour:** `packages/brand/src/tokens/source.ts` (designed in OKLCH,
  emitted as hex by `pnpm gen brand`).
- **The living preview:** `pnpm --filter @polaris-key/brand build`, then open
  `packages/brand/dist/preview/index.html`. It renders every token, mark, lockup, badge and section
  accent in both themes, with a working theme toggle and section-bit demo.

Contents: [1. Kit rules](#1-kit-rules) · [2. Using the package](#2-using-the-package) ·
[3. Theme mechanics](#3-theme-mechanics) · [4. Token reference](#4-token-reference) ·
[5. Section accents](#5-section-accents) · [6. The section bit](#6-the-section-bit) ·
[7. Usage conventions](#7-usage-conventions) · [8. The bytes host, dl.plrs.im](#8-the-bytes-host-dlplrsim) ·
[9. Accessibility](#9-accessibility) · [10. Do and don't](#10-do-and-dont) ·
[11. Migration from the console's `--pk-*` tokens](#11-migration-from-the-consoles---pk--tokens) ·
[12. Native consumers](#12-native-consumers) · [13. Changing the system](#13-changing-the-system) ·
[14. Brand expression and marketing](#14-brand-expression-and-marketing)

---

## 1. Kit rules

Restated from the kit, with the source of each. These are not negotiable in product work; the
only owner-approved extension is [the section bit](#6-the-section-bit).

### 1.1 Two marks

| Mark         | Identifies                                                                                                                                        | Alt text               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Pinned K** | The platform, "Polaris Key". The default mark has no terminal bit (§6); the kit's gold bit marks signed artwork only.                             | `Polaris Key`          |
| **Star Cut** | The service mark **Polaris Key Delivery**: the delivery family as a whole (the bytes host, Distribution, Update). Stationary star, open geometry. | `Polaris Key Delivery` |

Source: `kit/Brand-Guide.pdf` p.1; `kit/README.md` ("General use"). The Star Cut covering the whole
delivery family (not only the `update` slug) is an owner direction of 2026-10-03, and so is its
name (see [Owner decisions](#owner-decisions-2026-10-03)): the kit labels it "Star Cut Update" /
"Polaris Key Update", and on our surfaces it is **Polaris Key Delivery**. The kit's Update files
stay untouched in `kit/` as kit originals (their file names keep `update`, as does the `update`
glyph key in the package); the package generates the Delivery lockups
(`@polaris-key/brand/lockups/delivery/…`, `lockupSvg({ kind: "delivery" })`) from the kit's Star Cut
glyph and the bundled Rubik Bold, by the kit's own construction (`packages/brand/README.md`).

The Star Cut identifies the service. It is **not** a live update-status indicator: never use it
as a spinner, a badge count, or an "update available" icon (kit README).

**A service icon is never a mark.** Service icons (`@polaris-key/brand/icons/services/*`, UK-57)
explain a capability in navigation, diagrams and menus. They are not marks, never a recoloured
mark, and always sit beside the service's name (Brand Guide Ed. 04 pp.4, 23). The set is ten
single-colour outline icons on one grid and stroke per size: License `key-round`, Config
`sliders-horizontal`, Release `package`, Distribution `waypoints`, Update `circle-arrow-up`,
Identity `user-round`, Cloud Sync `cloud`, Commerce `shopping-bag`, Core `box`, and `boxes` for
Content Packs, which is marketing-only and never a `data-service`. Distribution's icon is not the
recoloured Star Cut: the Star Cut stays the Delivery mark (bytes host, lockups, service-off
states). The package exports the SVGs, a sprite, `serviceIconSvg()` and `<ServiceIcon>`; the
console's `ServiceGlyph` renders them instead of its own lucide imports, and `tools/services.json`
`console.icon` follows the set. The tile that frames an icon is [§7.8](#78-service-icon-tile).

### 1.2 Colour (kit primitives)

| Token                    | For dark grounds | For light grounds | Use                                     |
| ------------------------ | ---------------- | ----------------- | --------------------------------------- |
| Violet                   | `#9a5cff`        | `#7a2fff`         | the marks' body; the platform accent    |
| Gold (terminal bit)      | `#ffc24d`        | `#d07a00`         | the K's terminal bit only, ≥ 48 px only |
| Page ground              | `#060912`        | `#f6f8ff`         | page background                         |
| Polaris star             | `#ffffff`        | `#7a2fff`         | the star                                |
| Text (wordmark)          | `#ffffff`        | `#060912`         | wordmark and primary text               |
| Muted (secondary phrase) | `#dbe4ff`        | `#48536b`         | "Powered by", soft text                 |
| Rose                     | `#ff6fa6`        | `#e0348a`         | **reserved** for display treatments     |

Source: `kit/08-developer/tokens.json`, `kit/README.md` ("Colour and background selection"),
Brand-Guide p.2. Asserted equal by `test/kit-fidelity.test.ts`.

- **No gradients, no blue, no indigo** in brand artwork (kit README; Brand-Guide p.2).
- **Gold only on the K's terminal bit, and only when the rendered glyph is ≥ 48 px** (kit README;
  Brand-Guide p.2). Badges carry no gold at any size.
- **Rose is reserved** for optional display treatments. It is never a UI accent and never appears
  in a mark.
- **"dark" means FOR dark backgrounds**, "light" means FOR light backgrounds. mono-white is white
  ink, mono-black is `#060912` ink, currentColor inherits one CSS ink when inlined; an external
  `<img>` does not inherit currentColor (kit README).
- **Mono uses one ink** for every part, star and bit included (kit README; Brand-Guide p.2).

### 1.3 Optical cuts: choose by displayed size, never DPR

| Displayed (CSS) size | Cut                                     | Grid |
| -------------------- | --------------------------------------- | ---- |
| < 24 px              | favicon (separately drawn; use at 16)   | 16   |
| 24–32 px             | service (open construction; no gold)    | 24   |
| > 32 px              | display (the master; gold allowed ≥ 48) | 96   |

A 16 px mark on a 2× screen still uses the favicon drawing, rendered at 32 physical pixels; never
substitute the 32 px geometry (kit README; Brand-Guide p.2). Keep the mark at least 24 px except
for the dedicated 16 px cut. Between 33 and 47 px the kit's own component draws the display master
without gold; `opticalCut()` and `<PolarisMark>` do the same.

### 1.4 Clear space and lockups

- Outside clear space ≥ **¼ of the glyph height** around standalone marks and lockups; the SVG's
  small internal margin is not a substitute (`clearSpace()` computes it).
- Use the **compact lockup** when the full wordmark would make its mark smaller than 48 px
  (Brand-Guide p.2).
- Preserve proportions and internal gaps. Do not stretch, rotate the stationary star, replace it
  with a sparkle emoji, add a shield or padlock, or attach an unapproved service name (kit README).
  "Delivery" is the owner-approved service name for the Star Cut (2026-10-03); use the generated
  Delivery lockups rather than setting the name yourself.

### 1.5 "Powered by Polaris Key"

- The exact phrase **Powered by Polaris Key**. The secondary phrase is Rubik Regular; the wordmark
  is Rubik Bold.
- Minimum sizes (CSS px): **horizontal 376 × 144**, **compact 232 × 88**, **stacked 288 × 336**.
  `badgeSize()` and `<PoweredByBadge>` never render smaller; a smaller request is raised to the
  minimum (with a development warning).
- Treatments: **transparent** and **outline** need a clean ground of matching contrast; **sticker**
  carries its own plate, for busy imagery. Variants dark, light, mono-black, mono-white.
- **Never crop the badge padding**; the canvas is part of the artwork.
- **The Powered-by line** (the Pinned K in its 16 px favicon cut, no bit, plus the exact phrase in
  live `text-subtle` at 12–13 px) is the approved attribution for settings, about and credits
  footers in SDK kits. Everywhere else use the badge at its minimum size. No Polaris mark is drawn
  below the 16 px cut (UK-55 `mark-size`).

Source: kit README ("Powered by badges"), Brand-Guide p.3.

### 1.6 Type

Rubik ships as **one variable face** (wght 300–900; `fonts/ttf/Rubik-Variable.ttf`, Rubik[wght]
2.300, with latin and latin-ext WOFF2 subsets), replacing the kit's two static weights (UI-KITS.md
§2.1, owner decisions 2026-10-05). UI uses three weights on **every** surface (console, portal, hosted
sign-in, kits, docs): **400** for body and row titles, **500** for labels and buttons, **600** for
headings. **700** is the wordmark's (the kit's outlined Rubik Bold) and a game wordmark fallback's
only; hierarchy comes from scale and spacing, not from universal boldness. Customer body text is
16 px; console tables and forms use `sm` 14 (§7.6). Display size and tracking exist only for
marketing and the docs landing (§4.6, §14). `tokens.css` sets `font-synthesis: none` so a browser
never fakes a weight or a slant. All logo text in the kit SVGs is outlined; the web fonts are for UI
text only. The kit's static `Rubik-Regular.ttf` and `Rubik-Bold.ttf` stay in `kit/source/fonts/` as
launch-kit originals (the Delivery wordmark is set from Rubik Bold).

### 1.7 Alt text

`alt="Polaris Key"`, `alt="Polaris Key Delivery"` (the Star Cut on our surfaces; the kit's own
Update files carry `Polaris Key Update`), `alt="Powered by Polaris Key"`. Use **empty alt**
when an adjacent visible label already names it. An icon alone never labels an interactive control
(kit README).

---

## 2. Using the package

| You are building                      | Use                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin console / portal (React)        | `tokens.css` + `theme.css` (Tailwind v4) + `fonts.css`; `@polaris-key/brand/react` components; service icons                                |
| Docs (Astro Starlight)                | `tokens.css` + `theme.css` + `fonts.css` in `customCss`; map Starlight's `--sl-color-*` onto `--pk-*`; `marketing.css` for the landing only |
| Marketing (plrs.im)                   | `tokens.css` + `marketing.css`; service icons; generated Delivery assets (§14)                                                              |
| Worker HTML pages, emails, dl.plrs.im | `tokens.css` (inline the few variables you need in emails); `@polaris-key/brand/svg` strings; kit PNGs for email                            |
| React SDK UI (opt-in branding)        | `@polaris-key/brand/react` + `THEME_TOKENS` (do not require consumers to load tokens.css)                                                   |
| Godot UI kit                          | `sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd` (`PKeyBrand`)                                                            |
| SwiftUI gate                          | `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift` (`PolarisBrand`)                                                              |
| Any other generator                   | `@polaris-key/brand/tokens.json`                                                                                                            |

Asset paths through the exports map: `@polaris-key/brand/web/{key,delivery}/…` (favicons, PWA
icons, manifest templates, head snippets), `/games/{key,update}/{dark,light,mono-*}/…-16.svg`
(Godot editor glyphs) and `/games/powered-by-credit-{dark,light}*`, `/social/{key,delivery}/…` (OG
cards, banners, avatars, and the 1080 × 1350 portrait canvases with an 8 % safe margin),
`/marks/…` (and the generated `/marks/delivery/…`), `/lockups/…` (and the generated
`/lockups/delivery/…`, plus the trimmed horizontal lockup for the 64 px console header),
`/powered-by/…`, `/app-icons/…`, `/icons/services/…`, `/sprite.svg`, and the whole kit under
`/kit/…`. The Delivery-named files are generated from the kit's Star Cut glyph, so no public
surface carries the retired "Polaris Key Update" string; the kit's own Update files stay untouched
in `kit/`. Every generated asset is listed with its SHA-256 in `packages/brand/GENERATED.sha256`,
so marketing's `provenance.json` can pin our revision (UK-57).

Emails: mail clients do not render SVG reliably. Use the kit PNGs (for example
`/marks/key/png/dark/key-48.png`, `/lockups/key/key-horizontal-dark-944.png` shown at 472 × 160,
`/powered-by/sticker/powered-by-compact-dark-464.png` shown at 232 × 88): the 2× file with
explicit CSS `width`/`height` at the 1× size, and colours inlined from `tokens.json` rather than
custom properties. The sticker treatment is the safe badge in email, because the client may
invert or replace the background.

---

## 3. Theme mechanics

**Dark first, following the system, with a persisted override.**

```text
no data-theme, OS dark or no preference  → dark   (:root)
no data-theme, OS light                  → light  (@media (prefers-color-scheme: light) :root:not([data-theme="dark"]))
data-theme="dark" on <html>              → dark   (whatever the OS says)
data-theme="light" on <html>             → light  (whatever the OS says)
```

- The persisted choice is **"system" | "dark" | "light"**. "system" removes the attribute; the
  other two set `data-theme` on `<html>`. Store it in `localStorage` (web) and apply it in an
  inline `<head>` script before first paint so there is no flash. The preview page does exactly
  this.
- `color-scheme` is set with each palette, so form controls and scrollbars follow.
- `data-theme` on any other element re-themes that subtree (the preview's side-by-side panels).
- Tailwind: `theme.css` defines `dark:` and `light:` variants with the same precedence (attribute,
  then system, then dark). Because the tokens already swap, most components need neither variant.
- **Full light parity**: every token has a light value, and the contrast suite tests both themes.
- **Sections**: `data-service="core|license|config|release|distribution|update|identity|sync"` on, or
  inside, the themed element re-points `--pk-accent*` and `--pk-section-bit`. No attribute means
  core.

---

## 4. Token reference

All CSS names are `--pk-*` (the kit's own `--polaris-key-*` primitives are re-exported verbatim
too). TypeScript: `THEME_TOKENS[theme]`, `SERVICE_ACCENTS[theme][id]`; Tailwind names in brackets.
Contrast is the minimum over every surface of the theme (page, raised, overlay, sunken).

### 4.1 Surfaces

Layered from the page ground in flat steps (no gradients, no transparency). Dark: raised and
overlay step lighter, sunken darker. Light: raised and overlay are white (overlay is separated by
`border-subtle` and `elevation-3`), sunken a step darker.

| Token                              | Dark      | Light     | Use                                         |
| ---------------------------------- | --------- | --------- | ------------------------------------------- |
| `surface-page` (`bg-surface-page`) | `#060912` | `#f6f8ff` | the page (the kit ground, exact)            |
| `surface-raised`                   | `#0d111b` | `#ffffff` | cards, the console header, table containers |
| `surface-overlay`                  | `#121722` | `#ffffff` | menus, popovers, dialogs                    |
| `surface-sunken`                   | `#020408` | `#ebeef8` | wells, code blocks, inputs on raised        |

### 4.2 Text

| Token                            | Dark      | Light     | Min contrast (dark / light) | Use                                 |
| -------------------------------- | --------- | --------- | --------------------------- | ----------------------------------- |
| `text-strong` (`text-fg-strong`) | `#ffffff` | `#060912` | 17.9 / 17.2                 | headings, key figures               |
| `text-default` (`text-fg`)       | `#dbe4ff` | `#262d40` | 14.1 / 11.8                 | body                                |
| `text-muted` (`text-fg-muted`)   | `#b5bed3` | `#48536b` | 9.6 / 6.7                   | secondary text, table metadata      |
| `text-subtle` (`text-fg-subtle`) | `#969eb2` | `#5d667b` | 6.7 / 5.0                   | placeholders, timestamps, hints     |
| `text-on-accent`                 | `#060912` | `#ffffff` | 5.1 / 5.7 on violet         | text on a violet (core accent) fill |

The dark default text is the kit's muted `#dbe4ff`; the light muted text is the kit's `#48536b`.

### 4.3 Borders and focus

| Token                             | Dark      | Light     | Rule                                                                             |
| --------------------------------- | --------- | --------- | -------------------------------------------------------------------------------- |
| `border-subtle` (`border-border`) | `#212633` | `#dadee9` | decorative dividers and card edges; no contrast requirement                      |
| `border-strong`                   | `#61697b` | `#7e8699` | anything that bounds a control (inputs, checkboxes): ≥ 3:1 (3.3/3.2)             |
| `focus` (`ring-focus`)            | `#9a5cff` | `#7a2fff` | the core focus ring (violet) ≥ 3:1 (4.6/4.9); elsewhere the service's `fg` (B17) |

### 4.4 Status

Each status has `fg` (text and icons; ≥ 4.5:1 on every surface and on its own callout), `on`
(text on an `fg` fill), `border` (callout outline; ≥ 3:1 on page and callout) and `subtle` (the
callout background, `fg` flattened over the page). CSS: `--pk-success`, `--pk-success-on`,
`--pk-success-border`, `--pk-success-subtle`; likewise `warning`, `danger`, `info`.

| Status  | Dark fg   | Light fg  | Hue and reasoning                                                                                 |
| ------- | --------- | --------- | ------------------------------------------------------------------------------------------------- |
| success | `#56d57b` | `#167337` | green                                                                                             |
| warning | `#c38d18` | `#814d00` | **amber** (2026-10-03), between the Update tangerine and the Config yellow; ΔEOK 0.17 from signed |
| danger  | `#f2513f` | `#be2323` | red, held ΔE ≥ 0.12 from the reserved rose                                                        |
| info    | `#b688fe` | `#7a2fff` | **violet, never blue**                                                                            |

A status is never communicated by colour alone: always an icon and a word.

### 4.5 Signed (gold means signed)

Gold in UI means **a signing key, a signed record or a verified signature, and nothing else**. It
echoes the kit's "gold is the signing bit". Use it for: the release-key and product-key rows, a
"Signed" chip on a release record, a verified-signature result, the signed-document viewer.
Never for warnings, premium tiers, ratings, highlights or "featured".

| Token           | Dark      | Light     | Use                                                                      |
| --------------- | --------- | --------- | ------------------------------------------------------------------------ |
| `signed`        | `#ffc24d` | `#c47300` | the indicator: a glyph, a chip fill. ≥ 3:1 on every surface (11.2 / 3.1) |
| `signed-on`     | `#060912` | `#060912` | text inside a gold chip (12.4 / 5.5)                                     |
| `signed-border` | `#ba882e` | `#bf7101` | chip or callout outline                                                  |
| `signed-subtle` | `#241f19` | `#f1ebe6` | a signed callout's background                                            |
| `signed-mark`   | `#ffc24d` | `#d07a00` | the K's terminal bit: the kit gold, exact. Artwork only                  |

`signed` is an **indicator, never a text colour**: label the signed thing with `text-*` beside the
gold glyph, or with `signed-on` inside a gold chip. In light, the UI indicator is the kit gold
deepened just enough (ΔE < 0.05, same hue) to clear 3:1 on the sunken surface; the mark keeps the
exact kit gold.

### 4.6 Scales

| Group     | Tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space     | `--pk-space-{0,0_5,1,1_5,2,3,4,5,6,8,10,12,16,20,24}` on a 4 px grid (Tailwind `--spacing: 0.25rem`, so `p-4` = `--pk-space-4`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Radius    | `none 0`, `xs 2px`, `sm 4px`, `md 6px` (controls), `lg 10px` (cards), `xl 18px` (the badge frame's `rx`), `full`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Elevation | `--pk-elevation-{0..3}`: page-ground-ink shadows, stronger in light; on dark the surface step does the layering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Motion    | Durations `--pk-duration-{instant 0, micro 80ms, fast 120ms, base 200ms, moderate 260ms, slow 320ms, deliberate 480ms, shimmer 1600ms}`; easings `--pk-ease-{standard, enter, exit, emphasized, spring}` (`spring` is a `linear()` curve with a 4 % overshoot, `standard` where `linear()` is unsupported); distances `--pk-motion-distance-{xs 2px, sm 4px, md 8px, lg 12px, xl 24px}`; scales `--pk-motion-scale-{press 0.98, enter 0.98, pop 0.9}`; `--pk-stagger-step` 30ms, `--pk-stagger-max` 6; delays `--pk-delay-{skeleton 150ms, highlight 1600ms}` (not motion: never collapsed). §7.5 and notes/S-23 §5 |
| Type      | `--pk-font-sans` (variable Rubik), `--pk-font-mono` (JetBrains Mono); `--pk-font-size-*` / `--pk-line-height-*` for `xs 12/16 … 5xl 48`; `--pk-font-weight-{regular 400, medium 500, semibold 600, bold 700}`. `marketing.css` (export `./marketing.css`, UK-58) adds the display scale, display and heading tracking (`--pk-tracking-display`, `--pk-tracking-heading`) and the eyebrow, for marketing pages and the docs landing only: never in tables, forms, the console or the kits. Product keeps tracking at or above -0.02em and only from 40 px up                                                         |
| UI kits   | `--pk-kit-*` in `kit.css` (component measures, the per-platform type scale, highlight, scrim, the danger solid): [UI-KITS.md §2.1](UI-KITS.md#21-generated-never-hand-copied)                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Monospace** is **JetBrains Mono** (SIL OFL 1.1; variable, wght 400–600, about 30 KB as a latin
WOFF2), the kit mono for keys, user codes, hashes and code, so a key reads the same on every OS
(UI-KITS.md §2.1, owner decisions 2026-10-05). The platform stack (`ui-monospace, SFMono-Regular,
"SF Mono", Menlo, Consolas, "Liberation Mono", monospace`) follows it in `--pk-font-mono`.
`fonts.css` also declares **metric-matched fallback faces** ("Rubik Fallback" on Arial, "JetBrains
Mono Fallback" on Menlo or Courier New, with `size-adjust` and ascent and descent overrides), named
second in each stack, so a page does not shift when the web font arrives. **Figures** in tables use
Rubik with `font-variant-numeric: tabular-nums` (Rubik ships `tnum`), not monospace.

### 4.7 Action

The primary action is **neutral ink**, in the console, the portal and hosted sign-in (lead
decision B2, 2026-10-09). Role `action-neutral`, generated by `pnpm gen brand` (UK-58) as
`--pk-action` (fill) and `--pk-action-on` (label), with `-hover`, `-pressed`, `-disabled` (fill)
and `-disabled-on` (label); Tailwind `bg-action text-action-on`; `ACTION*` / `action*` in the Godot,
Swift and Kotlin outputs and `action*` in Python and C#:

| Theme | Fill      | Label     | Contrast |
| ----- | --------- | --------- | -------- |
| Dark  | `#f6f8ff` | `#060912` | > 17:1   |
| Light | `#060912` | `#ffffff` | > 19:1   |

Danger buttons stay danger red. The accent marks context only (§5.4). UI kits keep the host's
accent as their primary (UI-KITS DL13); the `polaris-key` preset's primary is the product accent.
The fill is also at least 3:1 on every surface of its theme, and the label 4.5:1 on the fill (tested).
States are steps of lightness, never colour: hover is the fill at 90 % (dark) or 88 % (light) over
the page, pressed at 78 % or 74 %; the label stays `action-on` (4.5:1 on both). Disabled is the fill
at 16 % or 14 % over the page with the `text-subtle` label, at least 3:1 in both themes; a disabled
primary is never offered where a refusal needs the fix as the one primary (B8). Every state fill
clears 3:1 on every surface.

### 4.8 State tokens per service

Interactive and context colour follows the service the element references (B17, §5.4). For each of
`core`, `license`, `config`, `release`, `distribution`, `update`, `identity` and `sync` (`commerce`
aliases `distribution`: `[data-service="commerce"]` repeats its rule), in both themes,
`pnpm gen brand` writes seven tokens: `--pk-state-<service>-<kind>` for every service, and
`--pk-state-<kind>` re-pointed by the nearest `data-service` (Tailwind `ring-state-ring`,
`bg-state-selected-fill`). Native outputs carry `state<Service><Kind>` (Swift, Kotlin) and
`STATE_<SERVICE>_<KIND>` (Godot).

| Kind          | Token                 | Is                                                                                 | Contrast, tested                                          |
| ------------- | --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Focus ring    | `state-ring`          | the family's `fg`                                                                  | 3:1 on every surface, and on selected-fill and hover-tint |
| Selected fill | `state-selected-fill` | `subtle`: `solid` 12 % (dark) or 10 % (light) over the page                        | `text-strong` and `text-default` 4.5:1                    |
| Hover tint    | `state-hover-tint`    | `solid` 7 % (dark) or 6 % (light) over the page: a lighter step than selected-fill | the same text pair                                        |
| Checked fill  | `state-checked-fill`  | `solid`: checkbox, radio, switch, segmented, chip                                  | 3:1 on every surface                                      |
| Checked glyph | `state-checked-on`    | the family's `on`                                                                  | 4.5:1 on checked-fill                                     |
| Checked edge  | `state-checked-edge`  | `fg`                                                                               | 3:1 on every surface and on both tints                    |
| Context edge  | `state-context-edge`  | `fg`                                                                               | 3:1 on every surface and on both tints                    |

Status colours (success, warning, danger, info, signed) are not in this set and never alias a
service accent (info is Core's violet by design and appears only as status). The pairs are listed
per token in `packages/brand/test/contrast.test.ts` and fail the build under the thresholds. The
light License and Release bases were darkened (B17) so a checked control and a bar clear 3.4:1 on
every surface; `fg` text and rings were already darker.

---

## 5. Section accents

Each console section has an accent: `solid` (indicators, nav markers, fills, icons, the section
bit; ≥ 3:1 on every surface), `fg` (text and links; ≥ 4.5:1 on every surface), `on` (text on a
solid fill; ≥ 4.5:1) and `subtle` (a tinted surface for the selected row or nav item; `fg`, body
and strong text all clear 4.5:1 on it).

### 5.1 The rules the accents satisfy (all tested)

- **No blue or indigo**: OKLCH hue outside [215°, 285°) **and** HSL hue outside [190°, 260°). Two
  models, so neither one's quirks let a blue through; the kit violet sits just outside both
  (OKLCH 290–297°, HSL 262–263°).
- **No rose or pink**: OKLCH hue outside [335°, 25°) and ΔEOK ≥ 0.12 from the kit rose.
- **Gold is for signed artwork only** (owner decision 2026-10-03). The core K carries no gold bit
  any more, so the ΔEOK ≥ 0.12 gold distance applies to the kit's signed artwork, the kit
  lockups, the UI `signed` indicator and the status colours, **not to section accents**: Config's
  yellow sits next to the gold on purpose (ΔE00 6.6 in dark). `colorViolations(hex, theme,
{ gold: false })` is the accent check.
- **Distinct** (ΔEOK, the second metric): pairwise ΔEOK ≥ 0.085 between families in each theme
  (0.12 until 2026-10-03; measured minimum 0.090, light Config/Update). ΔEOK 0.02 is about a
  just-noticeable difference.
- **Distinct in CIEDE2000** (the governing metric, re-derived 2026-10-03): service vs service
  ΔE00 ≥ 17.5 (measured minimum 18.0, light Config/Update; dark 20.4, Config/License); the
  platform violet vs any service ≥ 13 (measured 13.2, light Identity); any service vs the kit rose
  and danger ≥ 17.5 (measured 17.9, light Identity vs rose). Each floor sits just under the approved
  palette's minimum, so a regression fails. A flat 20 would fail on owner-approved pairs.
- **Warning is its own amber** (2026-10-03): ΔE00 ≥ 16 (dark) / ≥ 10 (light) from Config and Update,
  solid and fg (measured 16.6 / 10.5), and ≥ 20 from danger (31.7 / 24.2). Light is lower because
  every warm text colour at 4.5:1 on the light grounds is a dark amber-to-brown; a status always
  carries an icon and a word.
- Full matrices, status row included: `packages/brand/preview/proofs/accents-{dark,light}.png`.
- **WCAG AA** as above, both themes.

`colorViolations(hex, theme)` (exported) runs the hue and gold checks on any candidate colour.

### 5.2 The table

| Section          | Mark     | Family                 | Dark solid = fg (min contrast) | Light solid (min) | Light fg (min)  | Was (console) |
| ---------------- | -------- | ---------------------- | ------------------------------ | ----------------- | --------------- | ------------- |
| **Core**         | Pinned K | violet                 | `#9a5cff` (4.6)                | `#7a2fff` (4.9)   | `#7a2fff` (4.9) | indigo        |
| **License**      | Pinned K | chartreuse             | `#c6e940` (12.9)               | `#6d8600` (3.6)   | `#556e00` (5.0) | amber         |
| **Config**       | Pinned K | yellow                 | `#fac700` (11.3)               | `#8b6902` (4.4)   | `#866500` (4.7) | cyan          |
| **Release**      | Pinned K | cyan                   | `#00dbfd` (10.7)               | `#008ca3` (3.4)   | `#007487` (4.7) | violet        |
| **Distribution** | Star Cut | green                  | `#39d075` (8.9)                | `#05773b` (4.9)   | `#05773b` (4.9) | orange        |
| **Update**       | Star Cut | tangerine              | `#fe8001` (7.1)                | `#b95800` (4.1)   | `#aa5000` (4.7) | green         |
| **Identity**     | Pinned K | orchid                 | `#d77df2` (6.9)                | `#9e34ae` (5.1)   | `#9e34ae` (5.1) | rose          |
| **Cloud Sync**   | Pinned K | teal                   | `#14f8e1` (13.3)               | `#086260` (6.2)   | `#086260` (6.2) | (new, U-04)   |
| **Commerce**     | Pinned K | green (Distribution's) | `#39d075` (8.9)                | `#05773b` (4.9)   | `#05773b` (4.9) | (new, CM-29)  |

**Commerce shares the Distribution green family** (lead decision B1, 2026-10-09; reverses the
2026-10-08 vermilion choice, because the guide, the site and our mockups all draw green and
vermilion reads as an error). There is no ninth family and the accent-distance floor stays 17.5.
The `commerce` service slug and its routes (CM-29) stay: only the colour is shared. Commerce uses
the shopping-bag icon and the Pinned K (it requires License), never the Star Cut. CM-29b is
re-scoped to exactly that. Distribution and Commerce never sit side by side as one identity: the
data-service decides, and the icon tells them apart.

`on` is `#060912` on every dark solid (5.1–14.7:1) and on the light chartreuse and cyan solids
(4.8 and 5.0:1); `#ffffff` on the other light solids (4.7–7.2:1). The full set (subtle values, bit colours) is in
`tokens.json` and the preview.

OKLCH design values (dark solid / light solid): violet = the kit's; chartreuse `0.88 0.19 121` /
`0.60 0.15 123`; yellow `0.85 0.175 90` / `0.54 0.11 86` (fg `0.525`); cyan
`0.82 0.145 214` / `0.60 0.105 214` (fg `0.515`); green `0.76 0.18 152` / `0.50 0.13 152`;
tangerine `0.73 0.185 53` / `0.57 0.15 51` (fg `0.535`); orchid `0.73 0.185 318` /
`0.53 0.20 322`; teal `0.88 0.155 183` / `0.45 0.075 192` (U-04: `tune-accents`' optimum over
the palette's remaining gaps, 19.0 / 19.3 ΔE00 from the nearest accent, the Release cyan). Warning: `0.68 0.135 80` (border `0.52`) / `0.47 0.105 67` (border `0.56`).

Config, Update (light), Release and the warning status were chosen by
`packages/brand/scripts/tune-accents.ts`, a reproducible grid search: among values that pass every
rule above, inside a window around the owner's starting colour (Config `#ffd43b` / `#8a6a00`, hue
held at 90–100° so it stays yellow, and in light never darker than the start; Update light near
`#b04a00`; Release over the whole 150–214° arc in the palette's lightness band), it takes the one
with the largest minimum ΔE00 to every other accent, the violet, rose and danger; warning then
takes the amber between Update and Config farthest from both and from danger. Before (2026-10-03
morning, the original palette) and after:

| ΔE00                    | Before dark | After dark | Before light | After light |
| ----------------------- | ----------- | ---------- | ------------ | ----------- |
| Release vs Config       | 18.8        | 50.1       | 20.6         | 42.4        |
| Config vs License       | 45.9        | 20.4       | 40.7         | 20.7        |
| Config vs Update        | 33.9        | 25.5       | 27.7         | 18.0        |
| Distribution vs Update  | 0.0         | 56.6       | 0.0          | 49.5        |
| Release vs Distribution | 19.3        | 36.7       | 19.9         | 31.9        |
| Warning vs Config       | 48.5        | 16.9       | 43.0         | 11.8        |
| Warning vs Update       | 57.1        | 16.6       | 52.3         | 13.5        |
| Warning vs danger       | 15.8        | 31.7       | 11.1         | 24.2        |
| Lowest service pair     | 0.0         | 20.4       | 0.0          | 18.0        |

### 5.3 Reasoning

The usable hue wheel is small: blue/indigo (215–285°) is out, rose (335–25°) is reserved and
violet (≈ 290–300°) is the platform's. Until 2026-10-03 the gold bit also owned amber-to-yellow
(≈ 60–100°); with no gold bit on the core K that arc opened to section accents (Config yellow) and
the warning status (amber), and the danger status keeps the red end of the warm arc.

- **Core keeps the kit violet, exactly**, in both themes: the platform is the brand. The dark-theme
  surfaces were set so that `#9a5cff` itself clears 4.5:1 on the overlay surface.
- **License: amber → chartreuse.** Amber sits on top of the gold signing bit; a License accent
  that reads as gold would make every License screen look "signed". Chartreuse is the nearest hue
  that clears the gold by ΔE ≥ 0.12.
- **Config: cyan → yellow** (owner decision 2026-10-03), because cyan and the Release teal read
  as one colour. The pair to watch is yellow vs the License chartreuse: the hue is held at 90–100°
  (lime starts near 105°) and the tuner keeps it 20.4 / 20.7 ΔE00 from chartreuse. Dark is a pure
  yellow next to the kit gold, which the gold rule no longer forbids; light is the owner's ochre
  `#8a6a00` (a yellow at 3:1 on a light ground is necessarily ochre).
- **Release: violet → teal → cyan.** Violet is the platform's alone, and a violet section bit would
  vanish into the violet K. With Config yellow, Release is the only blue-green; over the whole
  150–214° arc the measured optimum is the cyan end (214°, the old Config hue), farthest from the
  Distribution green. A greener teal at 200° would score 29.1 / 25.5 ΔE00 instead of 36.7 / 31.9.
- **Distribution green, Update tangerine** (owner decisions 2026-10-03; until then they shared one
  green, the old Update colour). Neither is violet even though the Star Cut mark is: the mark's
  colour is the brand's, not the section's, and a violet section bit is invisible on a violet K.
  Update light is a bright orange near the owner's `#b04a00` (the gold rule that pushed it darker
  is gone).
- **Identity: rose → orchid.** Rose is reserved. Orchid (OKLCH 318–322°, HSL 287–296°) is held
  between the violet and the rose at ΔE ≥ 0.12 from each and outside the rose hue band. It is the
  tightest fit in the palette; see [decisions to confirm](#decisions-to-confirm).
- In light, three solids (License, Release, and to a lesser degree Config) cannot be both vivid
  and 4.5:1, so `solid` (3:1, the identity colour) and `fg` (4.5:1 text) differ there. In dark
  every solid is also its own text colour.
- **Warning: orange → amber** (owner decision 2026-10-03), between the Update tangerine and the
  Config yellow so it is mistaken for neither, and away from danger (floors in §5.1).
- **Status overlaps are accepted, not hidden**: Distribution shares green's neighbourhood with
  success, and a status always carries an icon and a word. Status colours are tested against the
  brand rules and the signed gold; warning is also held away from Config, Update and danger.

### 5.4 Using accents

- Section chrome only: the active nav item (`subtle` background + a 3 px `solid` marker), the
  section header rule, links in the section (`fg`), charts that belong to the section. The primary
  button is never the accent: it is the neutral action ink (§4.7).
- One flat section identifier per page header: a §7.8 tile at 64 px or less, never a solid accent
  plate, never a glow. Platform pages show the kit app icon, never a recoloured K.
- Never as a status. Never as a large background (use `subtle`). Never in the marks, except the
  [section bit](#6-the-section-bit).
- States follow the service the element references (`data-service`; core violet on core and platform
  screens; B17): the focus ring, active and selected nav item, hover, checked controls (checkbox,
  radio, switch, segmented, tab, chip) and borders that mark context. Text and edges use `fg`, fills
  use `solid`, at 3:1 for UI and 4.5:1 for text in both themes, and a non-colour cue (check, dot, bar
  and label) always stays. An element inside Licensing is lime; a Config row in a mixed list is
  config yellow. Status colours are never drawn in a service accent. The filled primary button is the
  exception: it stays the neutral action ink (B2). Kits keep their platform look with the product
  accent.

---

## 6. The section bit

**Owner-approved extension (2026-10-03) of the kit rule "gold lives only on the K's terminal
bit", corrected the same day.** The default "Polaris Key" mark (the Pinned K) has **no terminal
bit at all** on core/platform pages: no gold rectangle and nothing in its place. The bit appears
only in a service section (License, Config, Release, Distribution, Update, Identity), filled with
**that section's accent**: License → chartreuse, Config → yellow, and so on. The star never
changes. (The earlier version of this rule kept the kit gold on core pages; it is superseded.)

Rules:

0. **No bit on core.** Dashboard, products, platform pages, the portal, the boot screen, sign-in
   and every other non-service surface show the Pinned K without its bit. The path is left out of
   the markup entirely (no space, no hit-testing), never painted transparent; the glyph's geometry
   and clear space are otherwise identical. Favicons, the touch icon and the manifest icons are the
   default logo, so they carry no bit either (the kit's `web/key/` files already have none, and
   `test/kit-fidelity.test.ts` asserts it).

1. **Display cut, ≥ 48 px, only.** The ≥ 48 px rule still governs whether the bit shows at all.
   No bit is ever drawn on the service or favicon cut (they have no bit geometry, and the kit is
   not redrawn). `bitVisible()` enforces it; the tests cover 16/24/32/40/47 px.
2. **The console header mark is 48 px.** See the proofs below for why not smaller.
3. **3:1 against the header ground** (page or raised) in both themes; tested for every section.
   Light core is the kit gold at 3.06:1 on the page ground and 3.25:1 on raised, so a light header
   must use one of those two surfaces, never sunken.
4. **The star never changes colour, rotates or animates.** Only the bit's fill moves.
5. **Smooth, reduced-motion-aware transitions.** The bit eases between section colours over
   `--pk-duration-base` with `--pk-ease-standard` (class `polaris-section-bit`, in tokens.css).
   Under `prefers-reduced-motion: reduce` (or `data-motion="reduce"` on `<html>`) the transition
   is removed and every duration token is 0 ms, so the change is instant.
6. **Mono stays mono**: under a one-ink theme the bit is the same ink as everything else.
7. **CSP-safe markup.** No renderer emits an inline `style`; the live bit is coloured by the
   `polaris-live-bit` class in tokens.css, so lockup `innerHTML` is safe under a `style-src`
   without `'unsafe-inline'`.

API:

```tsx
<PolarisMark size={48} title="Polaris Key" />             // the default: no bit
<PolarisMark size={48} bit="none" />                      // the same, said explicitly
<PolarisMark size={48} bit="core" />                      // core has no bit: the same again
<PolarisMark size={48} bit="config" />                    // the Config accent
// Follows the nearest data-service ancestor: the accent in a service section, and not
// displayed at all under data-service="core" or none (--pk-section-bit-display: none):
<PolarisMark size={48} bit="section" title="Polaris Key" />
<PolarisMark size={48} bit="#123456" />                   // any CSS colour (hex, var(), rgb/hsl/oklch)
<PolarisLockup layout="horizontal" height={80} bit="license" />  // glyph 48 px at height 80
```

The console resolves the section from the route and passes `bit="none"` on core and the section
id elsewhere, so the DOM never holds a bit on a platform page. The default `PolarisLockup` has no
bit either (`signed` defaults to false; `kitLockupSvg` still reproduces the kit's signed files).

tokens.css: core (and no `data-service`) sets `--pk-section-bit: none` and
`--pk-section-bit-display: none`; a service section sets its accent and `inline`. There is no
`--pk-service-core-bit`.

`sectionBit(id, theme)` returns the colour, or `null` for core; `SERVICE_ACCENTS[theme].core.bit`
is `null`. Natively, `PKeyBrand.has_section_bit()` is false for core and `section_bit()` answers
transparent there; `PolarisBrand.accent(for:).bit` is `nil` for core.

**Proofs** (`packages/brand/preview/proofs/section-bit-{dark,light}.png`, re-render with
`pnpm --filter @polaris-key/brand proofs`): every section's bit at 32, 40 and 48 px, 1× and 2×, on
both header grounds, with 8× nearest-neighbour magnification; the Core row shows the bare K. At 48 px the bit is about 10 × 4 px
and every hue reads, light theme included. At 40 px (about 8 × 3.5 px) it still reads on dark but
the darker light-theme hues (Config, Distribution/Update) start to merge with the violet K at 1×.
At 32 px the kit's service cut has no bit, and forcing the display master to 32 px both breaks the
optical-cut rule and leaves a 2–3 px sliver. **Recommendation: keep the kit's 48 px minimum and
size the console header mark at 48 px** (a 64 px header holds it with 8 px of clear space,
consistent with the ¼-glyph rule for the outward edges).

---

## 7. Usage conventions

### 7.1 Which mark

| Surface                                                                                                                                         | Mark                                                                  | Favicon / PWA identity            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| Admin console, customer portal, docs site, Worker pages on key.plrs.im, emails                                                                  | Pinned K                                                              | `web/key/`                        |
| Delivery surfaces: dl.plrs.im (and dl-staging, dl-dev), updater prompts, feed pages, the Distribution and Update console sections' empty states | Star Cut                                                              | `web/update/` (on the bytes host) |
| Console header (service sections, including Distribution/Update; core pages show no bit)                                                        | Pinned K with the section bit                                         | `web/key/`                        |
| Service navigation, diagrams, marketing menus                                                                                                   | Service icon in the section accent (`fg`), beside the name (§1.1)     | n/a                               |
| SDK UI kits (every screen)                                                                                                                      | None: the product's identity ([UI-KITS.md §1.6](UI-KITS.md#16-marks)) | n/a                               |

SDK UI kit screens show **no Polaris Key mark**; the Pinned K appears only inside the optional
Powered-by line or badge, and the Star Cut not at all (UI-KITS.md §1.6, superseding this table's
former "SDK UI" and "SDK updater UI" rows, 2026-10-05).

Install only one identity's manifest per origin (kit README). Copy the relevant `web/<identity>/`
directory, adapt `head-snippet.html`, and set the manifest's `id`, `start_url` and `scope`.

### 7.2 "Powered by Polaris Key"

- **Where:** in a product built on Polaris Key: its about/credits screen, its licence or account
  screen, the Godot credits (`games/powered-by-credit-*`), a partner page. In an SDK's drop-in UI
  it is optional and off by default ([UI-KITS.md §1.6](UI-KITS.md#16-marks)). On Polaris Key's own
  surfaces (console, docs, dl.plrs.im) the platform speaks in its own voice and the badge does
  **not** appear.
- **Which:** compact for app UI, horizontal for web footers and credits, stacked for square
  placements; sticker on busy imagery, transparent or outline on a clean matching ground.
- Never below the minimums, never cropped, always the exact phrase, alt `Powered by Polaris Key`.

### 7.3 Gold means signed

See [4.5](#45-signed-gold-means-signed). In the console: key rows (product key, release key) carry
a gold key glyph; a release record's "Signed" chip is `signed` + `signed-on`; a failed
verification is `danger`, never gold. Nothing else in the console is gold.

### 7.4 Focus

Every interactive element shows a visible `:focus-visible` ring: 2 px solid `--pk-focus` with a
2 px offset in the surface colour. Never remove it; never replace it with a colour change alone.
The ring takes the service the element references (`--pk-state-ring`, §4.8; core violet on core and
platform screens), one ring colour per element, never per component; ≥ 3:1 everywhere in both
themes. `--pk-focus` stays the platform violet for contexts with no service.

### 7.5 Motion

The one motion system for the console, the portal, the sign-in card and the UI kits is
[notes/S-23](../research/2026-09-29-godot-omniplatform/notes/S-23-motion-system.md): the tokens
of §4.6 (S-23 §5) and nine named patterns (enter, exit, morph, expand, shared-element,
stagger-list, success, skeleton, press; S-23 §6).

- **Motion is functional and expressive within the tokens**: state changes (open and close,
  expand, the section bit, toasts), navigation (route, tab and step transitions), and the brief
  success moments of [EXPERIENCE §0.7](EXPERIENCE.md#07-moments-of-delight), which burst plain
  sparks in the section accent once per moment at `deliberate`, never the mark.
- **Use only the motion tokens**: durations, easings, distances, scales, the stagger and the
  delays. Every duration and the stagger step collapse to 0 ms under reduced motion, so a
  component animating through them needs no extra code. There is no `quick` step: exits use
  `fast`.
- **Only loading indicators loop**: the spinner and the skeleton shimmer (period `shimmer`). No
  ambient or decorative motion; no parallax.
- **Nothing that blocks input runs longer than `slow` plus `micro`**; success bursts, count-ups and
  highlight fades (`deliberate`) never block input. Animate transform and opacity only, with
  S-23's three named exceptions (the expand pattern's grid rows, colour on small elements, SVG
  stroke draws).
- **Reduced motion swaps instantly** (S-23 D3): under `prefers-reduced-motion: reduce` or the
  in-app preference (`data-motion="reduce"` on `<html>`), tokens.css sets every
  `--pk-duration-*` and `--pk-stagger-step` to 0 ms, and no View Transition, shimmer or burst
  runs. The delays (`--pk-delay-skeleton`, `--pk-delay-highlight`) are not motion and stay: a
  skeleton still waits 150 ms, a new row keeps its tint for 1.6 s. Loading indicators stand still
  too: the spinner is a still ring and the refetch bar a dimmed full-width bar; the busy control
  or the status text says the work goes on (S-23 §6.6, amended 2026-10-08).
- **Pause every loop offscreen and in hidden tabs** (`IntersectionObserver`, `visibilitychange`); a
  paused shimmer resumes from rest.
- **Never delay, fade in or animate an authorization control** (Allow, Approve, Sign in, Continue
  on consent): it is interactive on first paint. The update dialog's 250 ms input guard
  (UI-KITS §4.3) applies only to Later, which is not an authorization control.
- **Workspace entrance**: one bounded settle (`slow`–`deliberate`, 320–480 ms) on first entry only,
  never on navigation within the workspace.
- **An error appears without moving the content above or beside it**: its slot is reserved or it
  expands with the expand pattern. Progress shows real stages and values, never an invented
  percentage; after a failure every indicator stops and the error with Try again replaces it.
  Tokens describe transitions, never a fabricated wait.
- **No celebration** on a refund, revocation, removal, deletion, sign-out or consent
  ([EXPERIENCE §0.7](EXPERIENCE.md#07-moments-of-delight)).
- **Marketing only** (plrs.im, [§14](#14-brand-expression-and-marketing)): scroll reveal (opacity
  plus an 18 px rise, 650 ms), hero arrive (800 ms, staggered 0/100/180 ms), menu and tab panel
  220 ms, pointer tilt of ±5–6° (bounded to 12 px and 2–4° where kept), an 8 s looping dashed
  signal, flying tokens (1450 ms), a 5.2 s autoplay story and 2–6 px hover lift. Product keeps the
  tokens above (nothing over `deliberate`, only loaders loop, press 0.98, no parallax, no tilt,
  no hover lift). The site's reduced-motion rule (jump scenes to their final state) and its
  off-screen pause are kept.
- **The star never animates, rotates, pulses, twinkles or orbits**, anywhere: not in a loader, not
  in an empty state, not on hover, not in a success moment. Loading indicators are neutral (a bar
  or a ring in `text-subtle`), never the mark.

### 7.6 Console density and layout (data-heavy tables)

- Base UI size `sm` (14/20) for tables, forms and nav; `base` (16/24) for prose and dialog bodies.
- Table rows **56 px** (comfortable, the console default) or 40 px (compact); never 76 px. One
  spec: [EXPERIENCE §6](EXPERIENCE.md#6-tables-lists-forms-and-settings-rows) points here. Cell
  padding `space-2` × `space-3`; header row `text-muted`, `font-size-xs`, sentence case (no
  `text-transform`; never transform an identifier, code or user content).
- Numbers right-aligned with `tabular-nums`; IDs, keys, hashes and versions in `font-mono`
  `font-size-xs`, truncated in the middle with the full value in a tooltip and a copy button.
- Row dividers `border-subtle`; hover `surface-raised` on page tables (or `surface-overlay` on
  raised tables); the selected row uses the section `subtle`.
- Layout: a 64 px header (the 48 px mark, `surface-page`, no divider), a 240 px sidebar on
  `surface-page`, content max-width 1760 px (centred; the canvas itself fills the window), page
  gutters `space-6`, card radius `lg`, control
  radius `md`. From 1024 px the main region is a `surface-raised` canvas (radius `xl`,
  `border-subtle`, inset `space-4` from the top bar and window edge) carrying a 3 px section rule
  on its top edge; below 1024 px it is edge to edge with no radius. No gradient, glow or wash on
  the canvas. The shell is specified in ADMIN §2.4.
- Status in tables: a dot or icon plus the word; never colour alone.
- **Wide windows and zoom** (owner, 2026-10-08). Content never stretches edge to edge: the
  console's column caps at 1760 px and the customer site's at 82 rem (1312 px, 1248 px of content),
  both centred; focused flows (free a device, download, activate) are one centred card of at most
  41 rem. A window wider than the cap gains margin, not line length; where the width allows,
  panels sit side by side (Home's split, the product page's three columns) instead of one long
  column. At 200 % zoom (640 or 720 CSS px) the layout is the narrow one, edge to edge; at 400 %
  (320 × 256 CSS px) nothing scrolls sideways except a table inside a labelled, focusable region
  (`role=region`, an accessible name, `tabindex=0`). The console and portal e2e suites check 1920,
  200 % and 400 % in both themes, and forced colours and `prefers-contrast: more`.

### 7.7 Empty states and illustration

- Use the **stationary star** as the motif: the star path from the mark, in `text-subtle` or the
  section `subtle`/`solid`, static and upright. A single star, or the star with plenty of
  negative space. Never a constellation of sparkles, never animated, never rotated.
- Empty-state copy: one `text-strong` line saying what is missing, one `text-muted` line saying
  how to add it, one primary action. An empty state is accepted only when its first-run and
  filtered variants are rendered in the real runtime in both themes ([EXPERIENCE §7.3](EXPERIENCE.md#73-screen-acceptance)),
  with the motif static and the action reachable by keyboard.
- No stock illustration, no gradients, no blue/indigo, no rose (rose is for display treatments in
  marketing, not product UI).
- **Flat surfaces.** Glows, radial washes, vignettes, coloured shadows and accent-tinted card
  hairlines are not Polaris chrome: no glow under emblems or buttons, no wash behind the workspace
  header or the sign-in card (the guide's boards pp.28, 31 are not followed here). Product-owned
  art (cover art, the UI-KITS §1.2 product ambient) may contain gradients. The Polaris Key system
  product's own card shows its flat app icon on `surface-sunken`. The one exception is
  [marketing expression](#14-brand-expression-and-marketing), on plrs.im only.

### 7.8 Service icon tile

A service icon framed as a tile (masthead, feature rows, menus): 64 / 48 / 28 / 20 px with radius
14 / 12 / 8 / 6, `surface-raised` fill, 1 px border in the accent `solid` (dark) or `fg` (light), the
glyph at 50 % of the tile in the accent `fg`, stroke per size (UK-57). Flat: never a solid accent
plate, never a glow. The console masthead uses the 48 px tile only on feature landing pages from
1024 px.

---

## 8. The bytes host, dl.plrs.im

The bytes host (`https://dl.plrs.im`, with `dl-staging` and `dl-dev`) serves release artifacts and
packs. Its root (`GET /`) answers a static landing page built to this contract
(`packages/worker/src/core/bytesLanding.ts`). Where the page departs from the contract below is
recorded under [What the page omits, and why](#what-the-page-omits-and-why).

**Identity**

- The **Star Cut**, as the **Polaris Key Delivery** service mark, never the Pinned K as the
  primary mark. The page title is "Polaris Key Delivery".
- Favicon and PWA: `@polaris-key/brand/web/delivery/` (the icon bytes are unchanged; favicon.svg adapts to the OS
  theme; favicon.ico; `app-icon-dark-180.png` touch icon). No manifest install prompt is needed; include
  the manifest only if the page is meant to be installable.
- Page ground `--pk-surface-page` (`#060912` dark, `#f6f8ff` light), following the system theme;
  no toggle needed on a one-screen page.
- The Delivery lockup (`lockupSvg({ kind: "delivery", layout: "horizontal" })`, height ≥ 80 px so the
  glyph is ≥ 48 px) or the display mark at 96 px above the wordmark; ¼-glyph clear space.
- Rubik from `fonts.css`; text `text-default`/`text-strong`; one accent at most (the delivery
  green `--pk-service-distribution-fg` for links; Update's tangerine is not used here), no gold (nothing on the page is a signature), no
  gradients, no illustration beyond the static star.
- OG card: `social/delivery/social-card-dark-1200.png` (still omitted on the host; see below).

**Content**

- What it is, in one line: "Polaris Key Delivery: the download host for apps built on Polaris
  Key." One short paragraph: files here are signed release artifacts and packs, fetched by apps
  and updaters; there is nothing to browse.
- Links: the Polaris Key console (`https://key.plrs.im/`) and the docs
  (`https://key.plrs.im/docs/`, sign-in required); for staging and dev hosts, say which
  environment it is in `text-muted` under the title.
- **Never**: listings of products, releases, channels, files or buckets; version numbers; any
  token, key, signed URL or internal hostname; analytics or third-party scripts.
- Status code 200 for `/` only; unknown paths keep their current behaviour. A small, static,
  cacheable page with a strict CSP (no inline script needed; inline the few CSS variables or
  serve tokens.css as a static asset).

**What the package provides for it**: `web/delivery/` (favicons, touch and PWA icons, manifest
template, head snippet), `markSvg({ kind: "update", size: 96, title: "Polaris Key Delivery" })` and
`lockupSvg({ kind: "delivery" })` as strings (no React), `tokens.css`, `fonts.css` + the WOFF2
files, and the update social card.

### What the page omits, and why

The shipped page follows this section except where the bytes host's own guarantees win
(`core/bytesHost.ts`, THREAT-MODEL §3: nothing on this host may run as script, and it serves no
route that is not a byte route):

- **Type: the system font stack, not Rubik.** Body text uses `FONT.sans` (Rubik first, then the
  system stack) with no `@font-face`. The page is an inert document (`sandbox`,
  `default-src 'none'`, one hashed stylesheet, images only as `data:`). Serving Rubik would need a
  font route and a font type on the host's allowlist, or a `font-src` plus about 100 KB of
  inline WOFF2 in that policy; either widens the one check that keeps HTML on this host inert.
  The wordmark is outlined in the lockup, so the brand's type is exact where it names the
  service; a visitor with Rubik installed sees it in the body too.
- **No OG card, no `favicon.ico`, no touch icon.** Each would be a non-byte route (or an
  absolute URL to one) on a host that serves only byte routes and this one page. The favicon is
  the kit's adaptive `web/delivery/favicon.svg` drawing, inlined as a `data:` URI, so the host gains
  no icon route; `/favicon.ico` keeps its plain not-found. The page sets no `og:image`.
- **The lede.** The visible lede is "The download host for games and apps built on Polaris Key."
  The lockup above it already says "Polaris Key Delivery", so the line drops the name and names
  games, the platform's first audience. The page `<title>` is "Polaris Key Delivery" (with the
  environment in parentheses on staging and dev).

### The registry host, pkg.plrs.im

The registry host (`https://pkg.plrs.im`, with `pkg-staging` and `pkg-dev`, F-02) serves package
feeds and is Distribution's, as the bytes host is. Its root answers the same page under the same
contract and the same omissions (`packages/worker/src/core/registryLanding.ts`): the Polaris Key
Delivery lockup, the delivery green, the title "Polaris Key Delivery", the console and docs
links, and the environment named on staging and dev. Only its two sentences differ: "The package
registry for libraries and tools published through Polaris Key." and a short paragraph saying that
package managers fetch from here, that the console has each client's setup lines, and that there
is nothing to browse. It never lists owners, packages or versions.

---

## 9. Accessibility

1. WCAG 2.2 AA in both themes: text ≥ 4.5:1, large text ≥ 3:1, UI components and focus ≥ 3:1.
   The token pairings are guaranteed by `test/contrast.test.ts`; product code must keep text
   tokens on surface tokens (or on the documented tinted surfaces) to inherit the guarantee.
2. Never convey state by colour alone: status, section, signed and selection all carry an icon,
   a word, a shape or position as well.
3. Marks: meaningful images get the kit alt text; decorative ones (next to a visible name) are
   `aria-hidden` with no title. `<PolarisMark title="…">` gives `role="img"` and a label; without
   a title it is decorative.
4. Controls are labelled with visible text; an icon-only control needs an accessible name and a
   24 × 24 px minimum target (44 × 44 on touch). Primary actions aim for 44 px tall (44–48 px on
   phones); a compact 36 px console button keeps a 44 px hit area (UI-KITS DL10).
5. Reduced motion (the OS setting or `data-motion="reduce"`) is honoured globally through the
   duration tokens: every change swaps instantly and the section bit stops easing (§7.5).
6. Respect the OS theme by default; the override is a user choice, persisted, and never forced.
   Marketing pages (plrs.im) may be dark-only; product surfaces never are.
7. Do not set body text below 14 px (nothing below 12 px anywhere); never use `text-subtle` for
   content a user must read to complete a task.
8. Never move a focused form field: no layout shift, scroll-jacking or animation while a field
   has focus.
9. Design the full journey: loading, empty, filtered-empty, success, refusal, expired access,
   offline and recovery states where they apply. A passing token does not prove a composited
   graphic, screenshot or hover state is accessible.
10. Console and portal support `forced-colors` and `prefers-contrast: more` in both themes: borders
    and the 3 px nav marker survive, no shadow or tint carries meaning, native colours are never
    undone by accent-tinted hairlines.

---

## 10. Do and don't

**Do**

- Pick the optical cut by the displayed CSS size; let `<PolarisMark size>` do it.
- Use the kit SVGs and the package renderers; inline the SVG when it must follow `currentColor`.
- Leave ¼-glyph clear space around marks and lockups.
- Use the compact lockup when the full one would shrink the mark below 48 px.
- Reserve gold for signing keys, signed records and verified signatures.
- Use the Star Cut for the delivery family and the bytes host; the Pinned K for everything else.
- Keep the focus ring visible, in the accent of the service the element references (core violet on core screens).
- Use the tokens; add a token (in `source.ts`, with tests) rather than a one-off hex.

**Don't**

- Don't redraw, re-trace, stretch, skew, outline or add effects to a mark.
- Don't rotate, animate or recolour the star; don't replace it with a sparkle emoji.
- Don't show the bit below 48 px or on the service/favicon cut; don't add gold anywhere else.
- Don't use gradients, blue or indigo in brand artwork; don't use rose as a UI accent.
- Don't use the Star Cut as an update-status or progress indicator.
- Don't crop the "Powered by" badge or use it below its minimum; don't paraphrase the phrase.
- Don't add a shield, padlock or unapproved service name to a lockup.
- Don't install both identities' manifests on one origin.
- Don't put a "dark" asset on a light background (dark means _for_ dark).
- Don't let a browser synthesise a weight or slant (`font-synthesis: none`). Don't use 700 in UI:
  body 400, labels and buttons 500, headings 600; 700 is the outlined wordmark's (§1.6). Don't set
  the wordmark in live text: use a generated lockup (§1.4).
- Don't fill a primary with an accent, and don't use an accent for success, warning or any status.
- Don't use a service icon as a mark, or a recoloured Star Cut as a service icon.

---

## 11. Migration from the console's `--pk-*` tokens

The console (`packages/admin/src/styles.css`, Tailwind 3) stores HSL channels in `--pk-*` and
swaps palettes with a `.light` class. The new tokens are hex, swap by `data-theme` plus the
system preference, and keep the `--pk-` prefix. The restyle is a later work package; this is the
map it follows.

| Current (admin)                                                | New                                                                | Notes                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `.light` class / `:root,.dark`                                 | `data-theme="light"` / `"dark"` on `<html>`, or none (system)      | persist "system" too                                     |
| `--pk-background`                                              | `--pk-surface-page`                                                | now the kit ground `#060912`                             |
| `--pk-foreground`                                              | `--pk-text-default` (body) / `--pk-text-strong` (headings)         |                                                          |
| `--pk-card`, `--pk-card-foreground`                            | `--pk-surface-raised`, `--pk-text-default`                         |                                                          |
| `--pk-popover`, `--pk-popover-foreground`                      | `--pk-surface-overlay`, `--pk-text-default`                        |                                                          |
| `--pk-sidebar`                                                 | `--pk-surface-page` (dark) with `--pk-border-subtle` edge          | or `surface-raised`                                      |
| `--pk-sidebar-foreground`                                      | `--pk-text-muted`                                                  |                                                          |
| `--pk-sidebar-border`                                          | `--pk-border-subtle`                                               |                                                          |
| `--pk-sidebar-accent`                                          | `--pk-accent-subtle` (active item) / `--pk-surface-raised` (hover) |                                                          |
| `--pk-primary`                                                 | the `action-neutral` fill (§4.7, UK-58)                            | neutral ink, never the accent (B2); indigo is gone       |
| `--pk-primary-foreground`                                      | the `action-neutral` label (§4.7)                                  |                                                          |
| `--pk-accent` (hover fill)                                     | `--pk-surface-raised` / `--pk-surface-overlay`                     | **name reused**: new `--pk-accent` is the section colour |
| `--pk-accent-foreground`                                       | `--pk-text-strong`                                                 |                                                          |
| `--pk-secondary`, `-foreground`                                | `--pk-surface-overlay`, `--pk-text-strong`                         |                                                          |
| `--pk-muted`                                                   | `--pk-surface-sunken`                                              |                                                          |
| `--pk-muted-foreground`                                        | `--pk-text-muted`                                                  |                                                          |
| `--pk-success`, `-foreground`                                  | `--pk-success`, `--pk-success-on`                                  | plus `-border`, `-subtle`                                |
| `--pk-warning`, `-foreground`                                  | `--pk-warning`, `--pk-warning-on`                                  | amber since 2026-10-03 (was orange)                      |
| `--pk-destructive`, `-foreground`                              | `--pk-danger`, `--pk-danger-on`                                    |                                                          |
| (none)                                                         | `--pk-info`, `--pk-signed`, `--pk-signed-*`                        | new                                                      |
| `--pk-border`                                                  | `--pk-border-subtle`                                               |                                                          |
| `--pk-input`                                                   | `--pk-border-strong`                                               | control boundaries need 3:1                              |
| `--pk-ring`                                                    | `--pk-state-ring` (`--pk-focus` outside any service)               | the referenced service's accent (§4.8, B17)              |
| `--pk-shadow`                                                  | `--pk-elevation-{1,2,3}`                                           |                                                          |
| `--pk-radius` (0.625rem)                                       | `--pk-radius-lg` (cards) / `--pk-radius-md` (controls)             |                                                          |
| `[data-service="core"]`                                        | `[data-service="core"]`                                            | unchanged                                                |
| `[data-service="key"]` (License)                               | `[data-service="license"]`                                         | ids are now the service slugs                            |
| `[data-service="config"\|"release"\|"distribution"\|"update"]` | same                                                               |                                                          |
| `[data-service="id"]` (Identity)                               | `[data-service="identity"]`                                        |                                                          |
| `hsl(var(--pk-x) / <alpha>)`                                   | `var(--pk-x)`; for a tint use the `*-subtle` tokens                | hex has no channel form; no ad-hoc alpha                 |
| `font-sans` (system)                                           | `--pk-font-sans` (Rubik) + `fonts.css`                             |                                                          |

`tools/services.json`'s old `console.accent` keys `key` (License) and `id` (Identity) are retired:
since the console migration (ADMIN.md §7.2, chunk 1) every `console.accent` is the service slug,
so `data-service` carries the same ids this package keys its accents by.

---

## 12. Native consumers

- **Godot** (`PKeyBrand`, generated): `PKeyBrand.Dark.SURFACE_PAGE`, `PKeyBrand.Light.TEXT_MUTED`,
  `PKeyBrand.service_accent("config", dark)`, `section_bit()`, `optical_cut(size)`,
  `bit_visible(size)`, the badge minimums and the kit primitives; the kit tokens (`PKeyKitTokens`),
  the engine control icons (`PKeyKitIcons`), the variable fonts as MSDF `FontFile`s and the accent
  resolver (`PKeyAccent`). The kit's look is the Polaris Key default, dark by default; the former
  "neutral" builder becomes the `native` preset (UI-KITS.md §3.4; the kit moves over in UK-11). Use the 16 px editor glyphs from
  `games/` for editor-scale icons; pick cuts by the control's logical size. The addon carries
  copies in `sdks/godot/addons/polaris_key/brand/` (written by `pnpm gen brand`, never imported:
  the bit-less 16 px Pinned K glyphs, which the setup dock's tab shows on 4.6+, and the
  `games/powered-by-credit-*` screens and compact "Powered by" badges for a game's credits).
- **SwiftUI** (`PolarisBrand`, generated, in `PolarisKeyUI`): `PolarisBrand.Dark.surfacePage.color`,
  `PolarisBrand.accent(for: "license", dark: true).fg`, `opticalCut(for:)`, the badge minimums
  (`badgeMinCompact`, …), and the kit tokens (`PolarisKit.IOS`, `PolarisKit.MacOS`,
  `KitTokens.generated.swift`) and the accent resolver (`PolarisAccent`). Points are CSS-pixel
  equivalents for the optical-cut rule; follow `colorScheme` for the theme. The Polaris Key look
  is the kit's default and `native` the opt-out preset (UI-KITS.md §3.4, superseding the
  2026-10-04 "native by default" decision; the kit moves over in UK-07). `PolarisKeyUI` bundles
  the kit's Rubik TTFs and the variable Rubik and JetBrains Mono unchanged with their OFL texts
  (registered per process, on first branded use),
  the bit-less Pinned K PNGs and the "Powered by" badge PNGs; `sdks/swift/tools/sync-brand-assets.sh`
  copies them and `BrandThemeTests` checks them byte for byte against `kit/`. The badge is opt-in
  (`PolarisTheme(poweredBy:)`).
- **Kotlin (Compose)** (`PolarisBrandTokens`, `PolarisKitTokens`, `PolarisAccent`), **Python**
  (`polaris_key.ui`: tokens, the ANSI tables, the Qt theme and stylesheets, the fonts, the accent
  resolver), the **Node CLI** (`packages/sdk-node/src/cli/tokens.generated.ts`) and the **Godot
  .NET facade** (`PKeyBrand.generated.cs`) are generated the same way (UI-KITS.md §2.1).
- All are regenerated by `pnpm gen brand` and drift-checked by `pnpm gen brand --check`.

### 12.1 SDK UI

**Superseded (2026-10-05) by [UI-KITS.md](UI-KITS.md)**, the single spec for every UI an SDK
ships. In short: the **Polaris Key look is the default** of every kit, in the **product's** accent
(the registered presentation, else derived from the icon, else ink; never Polaris violet by
default); **`native`** is the opt-out preset that hands the look to the host; **Powered by** stays
optional and off by default; kit screens show no Polaris Key mark (UI-KITS §1.6). The tokens every
kit reads, the accent resolver and the drift gate are UI-KITS §2 and §3.3.

---

## 13. Changing the system

1. Edit `packages/brand/src/tokens/source.ts` (colours, OKLCH) or `scales.ts`.
2. `pnpm --filter @polaris-key/brand gen`, then `pnpm --filter @polaris-key/brand test`: the
   contrast, hue, gold, rose and distinctness suites must pass unchanged. **Never weaken a
   threshold to make a colour pass**; change the colour.
3. Update this page's tables (the numbers come from the test data) and rebuild the preview.
4. A new service in `tools/services.json` fails `test/services.test.ts` until it has an accent
   that passes every rule.
5. A new kit version: replace `packages/brand/kit/` wholesale (including its `SHA256SUMS.txt`),
   run `gen` (it re-derives and re-verifies every template) and the fidelity suite.

### Decisions to confirm

- **Identity orchid** is the tightest fit (ΔE 0.136 from violet and 0.128 from rose in dark).
  The alternative is to give Identity a cool hue and accept ~0.09 pairwise distinctness among
  five cool accents, or to share the warm arc with the warning status.
- **Light warning vs Config and Update** is the tightest status fit (ΔE00 11.8 / 10.5, floor 10):
  light amber text at 4.5:1 is necessarily brown. The icon and word carry the distinction.
- **Dark Config yellow vs the kit gold** (ΔE00 6.6): allowed since the gold rule left the
  accents; the section bit in Config is yellow next to where gold used to be.
- **Section-bit minimum stays 48 px** (the kit's), so the console header mark is 48 px.
- **The "Powered by" badge does not appear on Polaris Key's own surfaces.**

## Owner decisions (2026-10-03)

- **The Star Cut is the "Polaris Key Delivery" service mark.** It names the whole delivery family:
  the CDN / bytes host (dl.plrs.im), Distribution and Update. It supersedes the kit's "Update"
  label ("Star Cut Update", "Polaris Key Update") on all our surfaces; alt text is
  `Polaris Key Delivery`. The kit's Update files stay as kit originals; the Delivery lockups are
  generated in `@polaris-key/brand` from the kit glyph and Rubik Bold (§1.1). The Update
  _service_ keeps its name (the `update` section, its accent and its console section).

- **No terminal bit on core (2026-10-03, corrects the section-bit decision below).** The default
  Polaris Key mark (the Pinned K) has no terminal bit at all on core/platform pages: no gold
  rectangle and nothing in its place. The bit appears only in service sections, in that section's
  accent. The star never changes. Core no longer defines a gold section bit anywhere (tokens.css,
  tokens.json, TypeScript, GDScript, Swift); favicons and app icons stay bit-less.
- **Console header mark: 48 px with the section bit** (in service sections; none on core). The header is tall enough (about 64 px) for the
  Pinned K's display cut at 48 px, so every section's bit is legible in both themes (proofs:
  `packages/brand/preview/proofs/section-bit-{dark,light}.png`). 32–47 px placements use the
  display cut without a bit; below 24 px, the favicon cut.
- **Accent palette approved as tuned** (§5.2), including Identity orchid.
- **After the accent proofs (2026-10-03):** Config becomes yellow (`#fac700` / `#8b6902`, from the
  owner's `#ffd43b` / `#8a6a00`); Release, the only blue-green left, is re-tuned to the measured
  optimum (`#00dbfd` / `#008ca3`); Update dark stays `#fe8001` and Update light returns to a bright
  orange (`#b95800`, near the owner's `#b04a00`); License stays chartreuse. The gold distance no
  longer applies to section accents (only to the kit's signed artwork, the kit lockups, the signed
  indicator and statuses). The warning status moves to amber (`#c38d18` / `#814d00`) between
  Update and Config. CIEDE2000 floors are re-derived and tested (§5.1); the proofs are
  `packages/brand/preview/proofs/accents-{dark,light}.png`.
- **No "Powered by Polaris Key" badge on Polaris Key's own surfaces** (console, portal, docs,
  dl.plrs.im). The badge belongs to integrators' surfaces: SDK credit screens, the Godot addon's
  credits and integrator websites.

## Owner decisions (2026-10-04)

- **The SDK UI kits are Polaris Key by default and `native` is the opt-out preset** (UI-KITS.md,
  2026-10-05, which replaced the 2026-10-04 native-by-default and neutral-React decisions): the
  kit look is in the product's accent, `native` hands the look to the host, and kit screens show
  no Polaris Key mark (UI-KITS §1.6).
- **The "Powered by Polaris Key" badge is optional and off by default** in the SDK UI, in both
  modes; an integrator turns it on explicitly, and it then follows §1.5 and §7.2.
- **Every SDK UI view is centred and polished** (extended by UI-KITS.md §1.5): content centred
  horizontally and, for full-screen states, vertically; a comfortable maximum width on iPad and
  desktop rather than edge to edge; balanced padding, a clear type hierarchy, Dynamic Type at
  every size, consistent corner radii and native materials where they fit.

## Lead decisions (2026-10-09, Brand Guide Edition 04)

Delegated by the owner; the owner can veto any item. The guide is a designed reference edition:
this page and the package win (guide pp.27, 35), and the guide changes presentation only, never
a wire contract.

- **C1 Commerce** shares the Distribution green family (§5.2). The `commerce` service slug and
  routes (CM-29) stay: the brand brief's "not a protocol service slug" holds for Packs, and for
  Commerce only for its colour and identity. CM-29b is re-scoped to green, the shopping-bag icon
  and the Pinned K. No ninth family; the 17.5 floor stands. Reverses the 2026-10-08 vermilion
  choice.
- **C2 Primary** is neutral ink (§4.7, §5.4) in the console, portal and hosted sign-in. Kits keep
  the host accent.
- **C3 Selected nav** is `subtle` + a 3 px marker (§5.4), not a solid pill.
- **C4 Distribution icon** is `waypoints`, not the Star Cut (§1.1); a recommendation adopted by
  default.
- **C5 Header emblem**: one flat section identifier (§5.4, §7.8); no plate, no glow.
- **C6 Powered-by line**: the 16 px favicon-cut K plus the phrase (§1.5); adopted by default.
- **C7 Glows and gradients** stay out of product chrome (§7.7).
- **C8 Naming** differs by service, console feature and marketing entry point: the table in §14.
- **C9 Section bit** stays (48 px, §6), and the guide's accent band is adopted as the 3 px
  workspace rule; the emblem is skipped.

## 14. Brand expression and marketing

The Brand Guide Edition 04 (`Polaris-Key/website`, `docs/BRAND-GUIDE.md`) is a designed reference
for marketing and for the shell treatments adopted in ADMIN §2.4. It never overrides this page,
the package or the contract.

### 14.1 Four attributes

| Attribute       | Means                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| **Capable**     | Shows real state and real consequences; never decorative status.        |
| **Expressive**  | Colour, art and type carry personality where the surface allows it.     |
| **Considerate** | Plain words, restraint, accessible by default, nothing blocks the task. |
| **Precise**     | Exact tokens, exact marks, dense stable data; no invented values.       |

### 14.2 Intensity per surface

| Surface                         | Intensity | What leads                                                                                                                          |
| ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Marketing (plrs.im)             | Highest   | Large composition, service demos, vivid colour, display type                                                                        |
| Customer portal                 | Medium    | Developer art leads; display type for Library and product titles only; ink primary; ownership, availability and next action visible |
| Authentication (hosted sign-in) | Low       | One product anchor, one task card; account, requesting product and consequence visible                                              |
| Management (console)            | Low       | Title-size headings, precise service glyphs, dense stable data, accepted shell and workflows                                        |
| Native kits, TUI, email         | Native    | Host art and accent (DL13), native behaviour; every themed part uses the resolved theme                                             |

Working rules for every surface: service colour identifies context, never success or failure;
never recolour customer art; Polaris marks come only from `packages/brand`.

### 14.3 Marketing expression (plrs.im only)

Allowed on marketing and never in product: a dark-only site, flat accent-filled bands with `on`
text, two-tone display headlines (white plus an accent phrase in `<em>` that wraps freely),
`marketing.css` display type and tracking, the diagonal accent-stripe motif on platform-level
covers and social cards, pointer response (≤ 12 px, 2–4°), parallax, tilt, loops and autoplay
(§7.5), and the site's code-window and menu compositions. Rose stays a display treatment.
Product chrome never takes any of these (B6): no eyebrows or taglines repeating the path, no
display h1 in the console, no chartreuse fills in the core-violet portal.

What product adopts from the site: the mono uppercase eyebrow where an orientation line needs one
(12 px, 0.08em, accent `fg`, never smaller), the code-window anatomy, language tabs with logos,
destination-chip links, numbered steps only where order is real, the accent top-rule feature
card, the accent glyph chip for feature identity, honest "Sample data" captions, phone nav focus
handling and the forced-colors block. Adapted: display tracking only from 40 px; phase, percent
and meter for real long operations only. The embedded React kit demo on the site is a stale copy;
the playground (UK-62) is built here and the site embeds it, and the site's code examples live
here, type-checked per SDK (DOC-13). Marketing names are page titles and
entry points; body copy uses glossary words, and no marketing name becomes a product alias.

### 14.4 Naming

| Capability     | Slug (`serviceLabel`)        | Console feature (ST-38)         | Marketing entry point |
| -------------- | ---------------------------- | ------------------------------- | --------------------- |
| License        | `license`                    | Licensing                       | License               |
| Config         | `config`                     | Managed config                  | Config                |
| Release        | `release`                    | Ship builds (one package glyph) | Releases              |
| Distribution   | `distribution`               | Ship builds                     | Distribution          |
| Update         | `update`                     | Ship builds                     | Updates               |
| Identity       | `identity`                   | Sign-in                         | Identity              |
| Cloud Sync     | `sync`                       | Cloud Sync                      | Cloud Sync            |
| Commerce       | `commerce` (CM-29)           | Commerce                        | Commerce              |
| Packs (update) | none: a capability of Update | none: under Releases            | Content Packs         |

Eight slugs, nine marketing entry points, six console features. Ship builds is one console
identity (Package glyph, Release cyan); the marketing identities (Delivery, Update tangerine, Packs
orange) never split it in navigation.

**Marketing glossary drift** (for the website owner; page titles and entry points may keep their
marketing names, body copy uses the glossary words of `concepts.md`):

| On plrs.im today                                                                   | Use instead                                                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "Choose an outlet", "Route to the selected outlet", "the product outlet"           | Channel                                                                                  |
| "Channels with a purpose. Keep alpha, beta and stable releases", "Channel: Stable" | Release track, named for what it does ("Stable" is a track)                              |
| "Release channels, artifacts and changelogs"                                       | Release tracks, builds and release notes                                                 |
| "Content packs" in body copy                                                       | Pack; "Content Packs" stays as the marketing entry point and page title                  |
| "Reach storefronts, downloads and registries"                                      | "Reach stores, downloads and package managers" (a storefront is where something is sold) |
| "Cloud sync" in the menu                                                           | Cloud Sync, as everywhere else                                                           |
| Releases, Distribution and Updates described as console areas                      | Ship builds                                                                              |
| Identity described as a console area                                               | Sign-in                                                                                  |

### 14.5 Assets this section specifies (UK-57, UK-58)

Service icon set and tile (§1.1, §7.8); Delivery-named marks, web manifest and social set;
1080 × 1350 portrait cards with an 8 % safe margin; the trimmed horizontal lockup for the 64 px
console header (48 px glyph; replaces live "Polaris Key" text); the `GENERATED.sha256` manifest;
the `action-neutral` role, the display scale and tracking tokens, and the 400/500/600 weight
reconciliation (UK-58).

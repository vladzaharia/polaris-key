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
  emitted as hex by `pnpm gen:brand`).
- **The living preview:** `pnpm --filter @polaris-key/brand build`, then open
  `packages/brand/dist/preview/index.html`. It renders every token, mark, lockup, badge and section
  accent in both themes, with a working theme toggle and section-bit demo.

Contents: [1. Kit rules](#1-kit-rules) · [2. Using the package](#2-using-the-package) ·
[3. Theme mechanics](#3-theme-mechanics) · [4. Token reference](#4-token-reference) ·
[5. Section accents](#5-section-accents) · [6. The section bit](#6-the-section-bit) ·
[7. Usage conventions](#7-usage-conventions) · [8. The bytes host, dl.plrs.im](#8-the-bytes-host-dlplrsim) ·
[9. Accessibility](#9-accessibility) · [10. Do and don't](#10-do-and-dont) ·
[11. Migration from the console's `--pk-*` tokens](#11-migration-from-the-consoles---pk--tokens) ·
[12. Native consumers](#12-native-consumers) · [13. Changing the system](#13-changing-the-system)

---

## 1. Kit rules

Restated from the kit, with the source of each. These are not negotiable in product work; the
only owner-approved extension is [the section bit](#6-the-section-bit).

### 1.1 Two marks

| Mark                | Identifies                                                                                                | Alt text             |
| ------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| **Pinned K**        | The platform, "Polaris Key". Gold is the signing bit.                                                     | `Polaris Key`        |
| **Star Cut Update** | The delivery service as a whole: Distribution, Update and the bytes host. Stationary star, open geometry. | `Polaris Key Update` |

Source: `kit/Brand-Guide.pdf` p.1; `kit/README.md` ("General use"). The Star Cut covering the whole
delivery family (not only the `update` slug) is an owner direction of 2026-10-03.

The Update mark identifies the service. It is **not** a live update-status indicator: never use it
as a spinner, a badge count, or an "update available" icon (kit README).

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

### 1.5 "Powered by Polaris Key"

- The exact phrase **Powered by Polaris Key**. The secondary phrase is Rubik Regular; the wordmark
  is Rubik Bold.
- Minimum sizes (CSS px): **horizontal 376 × 144**, **compact 232 × 88**, **stacked 288 × 336**.
  `badgeSize()` and `<PoweredByBadge>` never render smaller; a smaller request is raised to the
  minimum (with a development warning).
- Treatments: **transparent** and **outline** need a clean ground of matching contrast; **sticker**
  carries its own plate, for busy imagery. Variants dark, light, mono-black, mono-white.
- **Never crop the badge padding**; the canvas is part of the artwork.

Source: kit README ("Powered by badges"), Brand-Guide p.3.

### 1.6 Type

Rubik Bold for the wordmark and headings; Rubik Regular for the secondary phrase and body. The kit
ships only these two weights, so the system has no medium or semibold, and `tokens.css` sets
`font-synthesis: none` so a browser never fakes one. All logo text in the kit SVGs is outlined;
the web fonts are for UI text only.

### 1.7 Alt text

`alt="Polaris Key"`, `alt="Polaris Key Update"`, `alt="Powered by Polaris Key"`. Use **empty alt**
when an adjacent visible label already names it. An icon alone never labels an interactive control
(kit README).

---

## 2. Using the package

| You are building                      | Use                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Admin console / portal (React)        | `tokens.css` + `theme.css` (Tailwind v4) + `fonts.css`; `@polaris-key/brand/react` components                    |
| Docs (Astro Starlight)                | `tokens.css` + `theme.css` + `fonts.css` in `customCss`; map Starlight's `--sl-color-*` onto `--pk-*`            |
| Worker HTML pages, emails, dl.plrs.im | `tokens.css` (inline the few variables you need in emails); `@polaris-key/brand/svg` strings; kit PNGs for email |
| React SDK UI                          | `@polaris-key/brand/react` + `THEME_TOKENS` (do not require consumers to load tokens.css)                        |
| Godot UI kit                          | `sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd` (`PKeyBrand`)                                 |
| SwiftUI gate                          | `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift` (`PolarisBrand`)                                   |
| Any other generator                   | `@polaris-key/brand/tokens.json`                                                                                 |

Asset paths through the exports map: `@polaris-key/brand/web/{key,update}/…` (favicons, PWA icons,
manifest templates, head snippets), `/games/{key,update}/{dark,light,mono-*}/…-16.svg` (Godot
editor glyphs) and `/games/powered-by-credit-{dark,light}*`, `/social/{key,update}/…` (OG cards,
banners, avatars), `/marks/…`, `/lockups/…`, `/powered-by/…`, `/app-icons/…`, `/sprite.svg`,
and the whole kit under `/kit/…`.

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
- **Sections**: `data-service="core|license|config|release|distribution|update|identity"` on, or
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

| Token                             | Dark      | Light     | Rule                                                                 |
| --------------------------------- | --------- | --------- | -------------------------------------------------------------------- |
| `border-subtle` (`border-border`) | `#212633` | `#dadee9` | decorative dividers and card edges; no contrast requirement          |
| `border-strong`                   | `#61697b` | `#7e8699` | anything that bounds a control (inputs, checkboxes): ≥ 3:1 (3.3/3.2) |
| `focus` (`ring-focus`)            | `#9a5cff` | `#7a2fff` | the focus ring, always violet: ≥ 3:1 (4.6/4.9)                       |

### 4.4 Status

Each status has `fg` (text and icons; ≥ 4.5:1 on every surface and on its own callout), `on`
(text on an `fg` fill), `border` (callout outline; ≥ 3:1 on page and callout) and `subtle` (the
callout background, `fg` flattened over the page). CSS: `--pk-success`, `--pk-success-on`,
`--pk-success-border`, `--pk-success-subtle`; likewise `warning`, `danger`, `info`.

| Status  | Dark fg   | Light fg  | Hue and reasoning                                                                              |
| ------- | --------- | --------- | ---------------------------------------------------------------------------------------------- |
| success | `#56d57b` | `#167337` | green                                                                                          |
| warning | `#ff8f57` | `#a24112` | **orange, not amber**: amber is the gold signing bit's territory. ΔE 0.125 / 0.140 from signed |
| danger  | `#f2513f` | `#be2323` | red, held ΔE ≥ 0.12 from the reserved rose                                                     |
| info    | `#b688fe` | `#7a2fff` | **violet, never blue**                                                                         |

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

| Group     | Tokens                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Space     | `--pk-space-{0,0_5,1,1_5,2,3,4,5,6,8,10,12,16,20,24}` on a 4 px grid (Tailwind `--spacing: 0.25rem`, so `p-4` = `--pk-space-4`)             |
| Radius    | `none 0`, `xs 2px`, `sm 4px`, `md 6px` (controls), `lg 10px` (cards), `xl 18px` (the badge frame's `rx`), `full`                            |
| Elevation | `--pk-elevation-{0..3}`: page-ground-ink shadows, stronger in light; on dark the surface step does the layering                             |
| Motion    | `--pk-duration-{instant 0, fast 120ms, base 200ms, slow 320ms}`; `--pk-ease-{standard, enter, exit}`                                        |
| Type      | `--pk-font-sans` (Rubik), `--pk-font-mono` (system); `--pk-font-size-*` / `--pk-line-height-*` for `xs 12/16 … 5xl 48`; weights 400 and 700 |

**Monospace** is the platform stack (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
"Liberation Mono", monospace`): zero bytes to ship, the face each platform's developers already
read code in, and the same answer native consumers get from their system monospace. **Figures** in
tables use Rubik with `font-variant-numeric: tabular-nums` (Rubik ships `tnum`), not monospace.

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
- **Not confusable with gold**: ΔEOK ≥ 0.12 from both the kit gold and the UI `signed` colour.
- **Distinct**: pairwise ΔEOK ≥ 0.12 between families in each theme (achieved minimum: 0.136 dark,
  violet/orchid; 0.121 light, cyan/green). ΔEOK 0.02 is about a just-noticeable difference.
- **WCAG AA** as above, both themes.

`colorViolations(hex, theme)` (exported) runs the hue and gold checks on any candidate colour.

### 5.2 The table

| Section          | Mark     | Family     | Dark solid = fg (min contrast) | Light solid (min) | Light fg (min)  | Was (console) |
| ---------------- | -------- | ---------- | ------------------------------ | ----------------- | --------------- | ------------- |
| **Core**         | Pinned K | violet     | `#9a5cff` (4.6)                | `#7a2fff` (4.9)   | `#7a2fff` (4.9) | indigo        |
| **License**      | Pinned K | chartreuse | `#c6e940` (12.9)               | `#708d00` (3.3)   | `#556e00` (5.0) | amber         |
| **Config**       | Pinned K | cyan       | `#12bcd5` (7.8)                | `#006270` (6.1)   | `#006270` (6.1) | cyan          |
| **Release**      | Pinned K | teal       | `#3eeedb` (12.3)               | `#01948a` (3.2)   | `#00736b` (4.9) | violet        |
| **Distribution** | Star Cut | green      | `#39d075` (8.9)                | `#05773b` (4.9)   | `#05773b` (4.9) | orange        |
| **Update**       | Star Cut | green      | `#39d075` (8.9)                | `#05773b` (4.9)   | `#05773b` (4.9) | green         |
| **Identity**     | Pinned K | orchid     | `#d77df2` (6.9)                | `#9e34ae` (5.1)   | `#9e34ae` (5.1) | rose          |

`on` is `#060912` on every dark solid (5.1–14.3:1) and on the light chartreuse and teal solids;
`#ffffff` on the other light solids (5.7–7.0:1). The full set (subtle values, bit colours) is in
`tokens.json` and the preview.

OKLCH design values (dark solid / light solid): violet = the kit's; chartreuse `0.88 0.19 121` /
`0.60 0.15 123`; cyan `0.73 0.125 212` / `0.455 0.085 212`; teal `0.86 0.14 184` /
`0.60 0.105 186`; green `0.76 0.18 152` / `0.50 0.13 152`; orchid `0.73 0.185 318` /
`0.53 0.20 322`.

### 5.3 Reasoning

The usable hue wheel is small: blue/indigo (215–285°) is out, rose (335–25°) is reserved, the
gold bit owns amber (≈ 60–100°), violet (≈ 290–300°) is the platform's, and the warm arc that is
left (25–60°) holds the warning and danger statuses. What remains is chartreuse-through-cyan
(≈ 115–214°) plus a narrow orchid band between violet and rose.

- **Core keeps the kit violet, exactly**, in both themes: the platform is the brand. The dark-theme
  surfaces were set so that `#9a5cff` itself clears 4.5:1 on the overlay surface.
- **License: amber → chartreuse.** Amber sits on top of the gold signing bit; a License accent
  that reads as gold would make every License screen look "signed". Chartreuse is the nearest hue
  that clears the gold by ΔE ≥ 0.12.
- **Config keeps cyan**, nudged to OKLCH 212° so it stays out of the HSL blue band.
- **Release: violet → teal.** Violet is the platform's alone, and a violet section bit would
  vanish into the violet K.
- **Distribution and Update share one accent: green** (the old Update colour). The Star Cut mark
  identifies the delivery service as a whole (owner direction), so its two sections read as one
  family; the section label tells them apart. The family is **not violet** even though the Star
  Cut mark is violet: the mark's colour is the brand's, not the section's, a violet accent would
  make delivery indistinguishable from core, and a violet section bit is invisible on a violet K.
  This is the one deliberate exception to pairwise distinctness, and the test asserts it.
- **Identity: rose → orchid.** Rose is reserved. Orchid (OKLCH 318–322°, HSL 287–296°) is held
  between the violet and the rose at ΔE ≥ 0.12 from each and outside the rose hue band. It is the
  tightest fit in the palette; see [decisions to confirm](#decisions-to-confirm).
- In light, three solids (License, Release, and to a lesser degree Config) cannot be both vivid
  and 4.5:1, so `solid` (3:1, the identity colour) and `fg` (4.5:1 text) differ there. In dark
  every solid is also its own text colour.
- **Status overlaps are accepted, not hidden**: Distribution/Update share green's neighbourhood
  with success, and a status always carries an icon and a word. Status colours are tested against
  the brand rules and against the signed gold, not against section accents.

### 5.4 Using accents

- Section chrome only: the active nav item (`subtle` background + `solid` marker), the section
  header rule, the primary button in that section (`solid` + `on`), links in the section (`fg`),
  charts that belong to the section.
- Never as a status. Never as a large background (use `subtle`). Never in the marks, except the
  [section bit](#6-the-section-bit).
- The focus ring stays violet in every section: one learnable focus signal.

---

## 6. The section bit

**Owner-approved extension (2026-10-03) of the kit rule "gold lives only on the K's terminal
bit".** In the console header, the Pinned K's terminal bit takes **the current section's accent**:
License → chartreuse, Config → cyan, and so on; on the platform (core) pages it stays the kit
gold. The bit is still the only coloured terminal; it changes hue by section, nothing else
changes.

Rules:

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
   Under `prefers-reduced-motion: reduce` the transition is removed and every duration token is
   0 ms, so the change is instant.
6. **Mono stays mono**: under a one-ink theme the bit is the same ink as everything else.

API:

```tsx
// Follows the nearest data-service ancestor through --pk-section-bit (recommended):
<PolarisMark size={48} bit="section" title="Polaris Key" />
// Or explicitly:
<PolarisMark size={48} bit="config" />        // the Config accent
<PolarisMark size={48} bit="core" />          // the kit gold
<PolarisMark size={48} bit="#123456" />       // any CSS colour (hex, var(), rgb/hsl/oklch)
<PolarisLockup layout="horizontal" height={80} bit="section" />  // glyph 48 px at height 80
```

`sectionBit(id, theme)` returns the colour; `PKeyBrand.section_bit()` and
`PolarisBrand.accent(for:).bit` are the native equivalents.

**Proofs** (`packages/brand/preview/proofs/section-bit-{dark,light}.png`, re-render with
`pnpm --filter @polaris-key/brand proofs`): every section's bit at 32, 40 and 48 px, 1× and 2×, on
both header grounds, with 8× nearest-neighbour magnification. At 48 px the bit is about 10 × 4 px
and every hue reads, light theme included. At 40 px (about 8 × 3.5 px) it still reads on dark but
the darker light-theme hues (Config, Distribution/Update) start to merge with the violet K at 1×.
At 32 px the kit's service cut has no bit, and forcing the display master to 32 px both breaks the
optical-cut rule and leaves a 2–3 px sliver. **Recommendation: keep the kit's 48 px minimum and
size the console header mark at 48 px** (a 64 px header holds it with 8 px of clear space,
consistent with the ¼-glyph rule for the outward edges).

---

## 7. Usage conventions

### 7.1 Which mark

| Surface                                                                                                                                         | Mark                                                       | Favicon / PWA identity            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Admin console, customer portal, docs site, Worker pages on key.plrs.im, emails                                                                  | Pinned K                                                   | `web/key/`                        |
| Delivery surfaces: dl.plrs.im (and dl-staging, dl-dev), updater prompts, feed pages, the Distribution and Update console sections' empty states | Star Cut                                                   | `web/update/` (on the bytes host) |
| Console header (every section, including Distribution/Update)                                                                                   | Pinned K with the section bit                              | `web/key/`                        |
| SDK UI (gate, activation, sign-in)                                                                                                              | Pinned K                                                   | n/a                               |
| SDK updater UI (update available, downloading)                                                                                                  | Star Cut as identity only, never as the progress indicator | n/a                               |

Install only one identity's manifest per origin (kit README). Copy the relevant `web/<identity>/`
directory, adapt `head-snippet.html`, and set the manifest's `id`, `start_url` and `scope`.

### 7.2 "Powered by Polaris Key"

- **Where:** in a product built on Polaris Key: its about/credits screen, its licence or account
  screen, the Godot credits (`games/powered-by-credit-*`), a partner page. On Polaris Key's own
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
The ring is violet in every section and both themes (≥ 3:1 everywhere).

### 7.5 Motion

- Use only the duration and easing tokens. They collapse to 0 ms under reduced motion, so a
  component animating through them needs no extra code.
- Motion is functional: state changes (open/close, expand, the section bit, toasts). No ambient,
  looping or decorative motion; no parallax.
- **The star never animates, rotates, pulses, twinkles or orbits**, anywhere: not in a loader, not
  in an empty state, not on hover. Loading indicators are neutral (a bar or a ring in
  `text-subtle`), never the mark.

### 7.6 Console density and layout (data-heavy tables)

- Base UI size `sm` (14/20) for tables, forms and nav; `base` (16/24) for prose and dialog bodies.
- Table rows 36 px (compact) or 44 px (comfortable, the default); cell padding
  `space-2` × `space-3`; header row `text-muted`, `font-size-xs`, uppercase not required.
- Numbers right-aligned with `tabular-nums`; IDs, keys, hashes and versions in `font-mono`
  `font-size-xs`, truncated in the middle with the full value in a tooltip and a copy button.
- Row dividers `border-subtle`; hover `surface-raised` on page tables (or `surface-overlay` on
  raised tables); the selected row uses the section `subtle`.
- Layout: a 64 px header (`surface-raised`, `border-subtle` bottom, the 48 px mark), a 240 px
  sidebar, content max-width 1440 px, page gutters `space-6`, card radius `lg`, control radius
  `md`.
- Status in tables: a dot or icon plus the word; never colour alone.

### 7.7 Empty states and illustration

- Use the **stationary star** as the motif: the star path from the mark, in `text-subtle` or the
  section `subtle`/`solid`, static and upright. A single star, or the star with plenty of
  negative space. Never a constellation of sparkles, never animated, never rotated.
- Empty-state copy: one `text-strong` line saying what is missing, one `text-muted` line saying
  how to add it, one primary action.
- No stock illustration, no gradients, no blue/indigo, no rose (rose is for display treatments in
  marketing, not product UI).

---

## 8. The bytes host, dl.plrs.im

The bytes host (`https://dl.plrs.im`, with `dl-staging` and `dl-dev`) serves release artifacts and
packs. Its root currently answers 404. A later work package builds a simple landing page; this is
its identity and content contract.

**Identity**

- The **Star Cut Update** mark (the delivery service), never the Pinned K as the primary mark.
- Favicon and PWA: `@polaris-key/brand/web/update/` (favicon.svg adapts to the OS theme;
  favicon.ico; `app-icon-dark-180.png` touch icon). No manifest install prompt is needed; include
  the manifest only if the page is meant to be installable.
- Page ground `--pk-surface-page` (`#060912` dark, `#f6f8ff` light), following the system theme;
  no toggle needed on a one-screen page.
- The Update lockup (`lockupSvg({ kind: "update", layout: "horizontal" })`, height ≥ 80 px so the
  glyph is ≥ 48 px) or the display mark at 96 px above the wordmark; ¼-glyph clear space.
- Rubik from `fonts.css`; text `text-default`/`text-strong`; one accent at most (the delivery
  green `--pk-service-update-fg` for links), no gold (nothing on the page is a signature), no
  gradients, no illustration beyond the static star.
- OG card: `social/update/social-card-dark-1200.png`.

**Content**

- What it is, in one line: "Polaris Key Update: the download host for apps built on Polaris
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

**What the package provides for it**: `web/update/` (favicons, touch and PWA icons, manifest
template, head snippet), `markSvg({ kind: "update", size: 96, title: "Polaris Key Update" })` and
`lockupSvg({ kind: "update" })` as strings (no React), `tokens.css`, `fonts.css` + the WOFF2
files, and the update social card.

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
   24 × 24 px minimum target (44 × 44 on touch).
5. Reduced motion is honoured globally through the duration tokens; the section bit stops easing.
6. Respect the OS theme by default; the override is a user choice, persisted, and never forced.
7. Do not set body text below 14 px; never use `text-subtle` for content a user must read to
   complete a task.

---

## 10. Do and don't

**Do**

- Pick the optical cut by the displayed CSS size; let `<PolarisMark size>` do it.
- Use the kit SVGs and the package renderers; inline the SVG when it must follow `currentColor`.
- Leave ¼-glyph clear space around marks and lockups.
- Use the compact lockup when the full one would shrink the mark below 48 px.
- Reserve gold for signing keys, signed records and verified signatures.
- Use the Star Cut for the delivery family and the bytes host; the Pinned K for everything else.
- Keep the focus ring violet and visible.
- Use the tokens; add a token (in `source.ts`, with tests) rather than a one-off hex.

**Don't**

- Don't redraw, re-trace, stretch, skew, outline or add effects to a mark.
- Don't rotate, animate or recolour the star; don't replace it with a sparkle emoji.
- Don't show the bit below 48 px or on the service/favicon cut; don't add gold anywhere else.
- Don't use gradients, blue or indigo in brand artwork; don't use rose as a UI accent.
- Don't use the Update mark as an update-status or progress indicator.
- Don't crop the "Powered by" badge or use it below its minimum; don't paraphrase the phrase.
- Don't add a shield, padlock or unapproved service name to a lockup.
- Don't install both identities' manifests on one origin.
- Don't put a "dark" asset on a light background (dark means _for_ dark).
- Don't synthesise Rubik weights (no 500/600) or set the wordmark in live text.

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
| `--pk-primary`                                                 | `--pk-accent` (section-aware solid)                                | indigo `#5b7cfa` is gone (blue band)                     |
| `--pk-primary-foreground`                                      | `--pk-accent-on`                                                   |                                                          |
| `--pk-accent` (hover fill)                                     | `--pk-surface-raised` / `--pk-surface-overlay`                     | **name reused**: new `--pk-accent` is the section colour |
| `--pk-accent-foreground`                                       | `--pk-text-strong`                                                 |                                                          |
| `--pk-secondary`, `-foreground`                                | `--pk-surface-overlay`, `--pk-text-strong`                         |                                                          |
| `--pk-muted`                                                   | `--pk-surface-sunken`                                              |                                                          |
| `--pk-muted-foreground`                                        | `--pk-text-muted`                                                  |                                                          |
| `--pk-success`, `-foreground`                                  | `--pk-success`, `--pk-success-on`                                  | plus `-border`, `-subtle`                                |
| `--pk-warning`, `-foreground`                                  | `--pk-warning`, `--pk-warning-on`                                  | now orange; amber/gold means signed                      |
| `--pk-destructive`, `-foreground`                              | `--pk-danger`, `--pk-danger-on`                                    |                                                          |
| (none)                                                         | `--pk-info`, `--pk-signed`, `--pk-signed-*`                        | new                                                      |
| `--pk-border`                                                  | `--pk-border-subtle`                                               |                                                          |
| `--pk-input`                                                   | `--pk-border-strong`                                               | control boundaries need 3:1                              |
| `--pk-ring`                                                    | `--pk-focus`                                                       | always violet; no longer per section                     |
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
  `bit_visible(size)`, the badge minimums and the kit primitives. Use the 16 px editor glyphs from
  `games/` for editor-scale icons; pick cuts by the control's logical size.
- **SwiftUI** (`PolarisBrand`, generated, in `PolarisKeyUI`): `PolarisBrand.Dark.surfacePage.color`,
  `PolarisBrand.accent(for: "license", dark: true).fg`, `opticalCut(for:)`. Points are CSS-pixel
  equivalents for the optical-cut rule; follow `colorScheme` for the theme.
- Both are regenerated by `pnpm gen:brand` and drift-checked by `pnpm gen:brand -- --check`. The
  existing Godot `pkey_theme.tres` and `PolarisTheme.brandAccent` (`#5B7CFA`, indigo) predate the
  system and move onto these constants in their own work packages.

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
- **Distribution and Update share one accent** (green). If the console needs them distinct, the
  fallback is a second green-family step, which falls below the 0.12 distinctness bar.
- **Section-bit minimum stays 48 px** (the kit's), so the console header mark is 48 px.
- **The "Powered by" badge does not appear on Polaris Key's own surfaces.**

## Owner decisions (2026-10-03)

- **Console header mark: 48 px with the section bit.** The header is tall enough (about 64 px) for the
  Pinned K's display cut at 48 px, so every section's bit is legible in both themes (proofs:
  `packages/brand/preview/proofs/section-bit-{dark,light}.png`). 32–47 px placements use the
  display cut without a bit; below 24 px, the favicon cut.
- **Accent palette approved as tuned** (the table above), including Config cyan, Release teal,
  one shared green for Distribution and Update (the Star Cut delivery family) and Identity orchid.
- **No "Powered by Polaris Key" badge on Polaris Key's own surfaces** (console, portal, docs,
  dl.plrs.im). The badge belongs to integrators' surfaces: SDK credit screens, the Godot addon's
  credits and integrator websites.

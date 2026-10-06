# @polaris-key/brand

The Polaris Key design system, as a package: brand tokens for every consumer (CSS, Tailwind v4,
TypeScript, JSON, GDScript, Swift, Kotlin for Compose, Python, C#), the UI-kit tokens and the product accent
resolver, the variable Rubik and JetBrains Mono fonts, the **Pinned K** and **Star Cut** marks
(the Star Cut is the **Polaris Key Delivery** service mark on our surfaces), wordmark lockups and "Powered by Polaris Key" badges (React and framework-free), and the
launch-kit assets (favicons, PWA icons, Godot glyphs, social cards).

**The spec is [`docs/design/BRAND.md`](../../docs/design/BRAND.md).** Read it before building UI.

## Use it

```css
/* Any web surface */
@import "@polaris-key/brand/fonts.css";
@import "@polaris-key/brand/tokens.css";

/* A UI kit (React, elements, Vue, Svelte, Angular, Electron, Tauri): the --pk-kit-* tokens */
@import "@polaris-key/brand/kit.css";

/* Tailwind v4 (admin, docs): after Tailwind and tokens.css */
@import "tailwindcss";
@import "@polaris-key/brand/tokens.css";
@import "@polaris-key/brand/theme.css";
```

```tsx
import { PolarisMark, PolarisLockup, PoweredByBadge } from "@polaris-key/brand/react";

<PolarisMark size={48} title="Polaris Key" />                 // the default logo: no terminal bit
<PolarisMark size={48} bit="license" title="Polaris Key" />   // a service section: the bit in its accent
<PolarisMark size={48} bit="section" title="Polaris Key" />   // follows data-service; none on core
<PolarisLockup layout="compact" theme="light" />
<PoweredByBadge layout="compact" treatment="sticker" />
```

```ts
import { markSvg, poweredBySvg } from "@polaris-key/brand/svg"; // Worker HTML, emails, scripts
import { THEME_TOKENS, sectionBit, opticalCut } from "@polaris-key/brand";
import { KIT_TOKENS, resolveAccent, deriveAccent } from "@polaris-key/brand"; // UI kits (UI-KITS.md)

resolveAccent("#ff6a3d", "dark"); // { solid, on, fg, subtle, focus }, contrast-checked
deriveAccent(imageData.data); // a product icon's accent, or null (the kit uses ink)
```

Assets resolve through the exports map: `@polaris-key/brand/web/key/favicon.svg`,
`/web/update/site.webmanifest`, `/games/key/dark/key-16.svg`, `/social/key/social-card-dark-1200.png`,
`/sprite.svg`, `/tokens.json`, and everything else in the kit under `/kit/…`.

| Export                                                                                                         | What                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `.`                                                                                                            | tokens (typed), kit primitives, mark rules, colour rules     |
| `./react`                                                                                                      | `PolarisMark`, `PolarisLockup`, `PoweredByBadge` (React ≥18) |
| `./svg`                                                                                                        | the same artwork as SVG strings                              |
| `./color`                                                                                                      | OKLab/OKLCH, WCAG contrast, ΔE                               |
| `./tokens.css`, `./theme.css`                                                                                  | CSS custom properties; the Tailwind v4 `@theme`              |
| `./kit.css`                                                                                                    | the UI-kit tokens (`--pk-kit-*`, UI-KITS.md §2.1)            |
| `./accent`                                                                                                     | `resolveAccent`, `deriveAccent` (UI-KITS.md §3.3)            |
| `./fonts.css`, `./fonts/*`                                                                                     | variable Rubik and JetBrains Mono: WOFF2, TTF, OFL           |
| `./tokens.json`                                                                                                | every token, resolved, for generators                        |
| `./kit-copy`                                                                                                   | the UI kit copy tables, nine locales (generated, see below)  |
| `./web/*`, `./games/*`, `./social/*`, `./marks/*`, `./lockups/*`, `./powered-by/*`, `./app-icons/*`, `./kit/*` | launch-kit files, verbatim                                   |
| `./lockups/delivery/*`                                                                                         | the Polaris Key Delivery lockups (generated, see below)      |

## Work on it

```sh
pnpm --filter @polaris-key/brand gen            # regenerate every output after editing src/tokens/
pnpm gen:brand -- --check                       # the drift gate (CI, AGENTS.md)
pnpm --filter @polaris-key/brand test           # React 18 and React 19 projects
pnpm --filter @polaris-key/brand build          # dist/ + the living preview at dist/preview/index.html
pnpm --filter @polaris-key/brand proofs         # re-render preview/proofs/section-bit-*.png
```

### The kit copy catalog (`kit-copy/`)

Every string a Polaris Key UI kit shows lives in one ICU MessageFormat catalog
(plans/UK-02.md; UI-KITS.md §4.7). The sources are hand-written, each with a JSON Schema beside it:

- `kit-copy/en.json`: every kit key as `{value, role, note, variants?}`. The `signin.*` namespace
  is `docs/design/SIGN-IN.md` §5.2. Error and gate copy is **not** here: it is the core copy,
  `conformance/parity/copy.en.json`, and every generated table carries it under `core.*` keys.
- `kit-copy/<locale>.json`: the eight launch packs (`de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`,
  `zh-Hans`), values only, `reviewed: false` until a native speaker has checked them.
- `kit-copy/glossary.json`: the fixed word for license, device, tier and the other product terms
  in each locale.
- `kit-copy/components.json`: each UI-KITS §4.1 component's states and the copy keys each shows
  (the UK-15 string lint and UK-02b's `ui-matrix.json` read it).

Messages use a subset of ICU: plain `{arg}` arguments from a closed set, at most one
`{n, plural, …}` on an integer argument with exactly the locale's CLDR categories, or one
`{formFactor, select, …}` with all eight form factors ("this iPhone", "this Mac", "this device").
Dates, durations and sizes are formatted by the platform and passed in as strings. `gen` refuses
anything outside the subset, a missing or extra key in any locale, an argument set that differs
from English, a kit string equal to a core string, "licence", "grant", "Retry", "machine" or
"plan" in English, a control character, `%`, a changed "Polaris Key", and a component key no
state lists. To check a pack while translating:
`npx tsx scripts/kit-copy.ts --validate --only <locale>`.

`gen` writes one native table per platform, kit keys plus `core.*` keys, in all nine locales:
`src/generated/kit-copy/` (this package's `./kit-copy` export), the Node terminal module
`packages/sdk-node/src/kitCopy.generated.ts`, the SwiftUI kit's `Localizable.xcstrings`, Compose
Resources `strings.xml` under `sdks/kotlin/ui/src/commonMain/composeResources/`, the Godot kit's
`ui/locale/*.po` and `.pot`, and the Python module `polaris_key/ui/kit_copy_generated.py` with a
`.pot`. English buttons, menu items and window titles get a generated macOS title-case variant.
Edit the sources, run `gen`, and commit the outputs; `gen:brand -- --check` fails on drift.

### The Polaris Key Delivery lockups

The kit ships the Star Cut lockups as "Polaris Key Update"; those files stay untouched in
`kit/02-lockups/update/` as kit originals. Our surfaces use **Polaris Key Delivery** (owner
decision, 2026-10-03; BRAND.md §1.1). `gen` writes `lockups/delivery/delivery-{horizontal,stacked,compact}-{dark,light,mono-black,mono-white,currentColor}.svg`
and the `delivery` lockup templates (`lockupSvg({ kind: "delivery" })`, `<PolarisLockup kind="delivery">`):
the kit's Star Cut glyph, byte for byte, and the wordmark outlined from
`kit/source/fonts/Rubik-Bold.ttf` by `scripts/wordmark.ts` (a dependency-free TrueType reader),
laid out by the kit's own rules in `scripts/delivery.ts`. Before writing, the generator re-sets
"Polaris Key" and "Polaris Key Update" the same way and requires the kit's six lockups byte for
byte, so the construction is the kit's. Never edit these files by hand; `gen:brand -- --check`
fails on drift. PNG renders are not generated (raster output is not reproducible across
platforms); render one from the SVG when a surface needs it.

- `kit/` is a verbatim copy of the Polaris Key Launch Kit v1 (`SHA256SUMS.txt` is the kit's own;
  the tests check every file against it). Never edit it; SVG is the source of truth and marks are
  never redrawn. To take a new kit version, replace the directory and run `gen`.
- `src/tokens/source.ts` is the colour design (OKLCH); `gen` emits hex.
- `src/tokens/kit.ts` and `src/tokens/terminal.ts` are the UI-kit design (UI-KITS.md §2.1);
  `scripts/gen-kit.ts` writes them into every kit's language. `src/accent.ts` is the accent
  resolver; `src/tokens/accent-vectors.ts` lists the inputs of the shared vectors
  (`fixtures/accent-vectors.json`, generated) that the Swift, Kotlin, GDScript and Python ports
  must reproduce exactly.
- `fonts/ttf/` holds the unmodified variable Rubik and JetBrains Mono; `fonts/*.woff2` come from
  `scripts/build-fonts.py` (fontTools + brotli, run once; committed).

Rubik and JetBrains Mono are under the SIL Open Font License 1.1: see `THIRD_PARTY_NOTICES`,
`fonts/OFL.txt` and `fonts/OFL-JetBrainsMono.txt`.

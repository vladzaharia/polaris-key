# @polaris-key/brand

The Polaris Key design system, as a package: brand tokens for every consumer (CSS, Tailwind v4,
TypeScript, JSON, GDScript, Swift), the Rubik web fonts, the **Pinned K** and **Star Cut Update**
marks, wordmark lockups and "Powered by Polaris Key" badges (React and framework-free), and the
launch-kit assets (favicons, PWA icons, Godot glyphs, social cards).

**The spec is [`docs/design/BRAND.md`](../../docs/design/BRAND.md).** Read it before building UI.

## Use it

```css
/* Any web surface */
@import "@polaris-key/brand/fonts.css";
@import "@polaris-key/brand/tokens.css";

/* Tailwind v4 (admin, docs): after Tailwind and tokens.css */
@import "tailwindcss";
@import "@polaris-key/brand/tokens.css";
@import "@polaris-key/brand/theme.css";
```

```tsx
import { PolarisMark, PolarisLockup, PoweredByBadge } from "@polaris-key/brand/react";

<PolarisMark size={48} bit="section" title="Polaris Key" />   // console header
<PolarisLockup layout="compact" theme="light" />
<PoweredByBadge layout="compact" treatment="sticker" />
```

```ts
import { markSvg, poweredBySvg } from "@polaris-key/brand/svg"; // Worker HTML, emails, scripts
import { THEME_TOKENS, sectionBit, opticalCut } from "@polaris-key/brand";
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
| `./fonts.css`, `./fonts/*`                                                                                     | Rubik 400/700 WOFF2 (latin, latin-ext) + OFL                 |
| `./tokens.json`                                                                                                | every token, resolved, for generators                        |
| `./web/*`, `./games/*`, `./social/*`, `./marks/*`, `./lockups/*`, `./powered-by/*`, `./app-icons/*`, `./kit/*` | launch-kit files, verbatim                                   |

## Work on it

```sh
pnpm --filter @polaris-key/brand gen            # regenerate every output after editing src/tokens/
pnpm gen:brand -- --check                       # the drift gate (CI, AGENTS.md)
pnpm --filter @polaris-key/brand test           # React 18 and React 19 projects
pnpm --filter @polaris-key/brand build          # dist/ + the living preview at dist/preview/index.html
pnpm --filter @polaris-key/brand proofs         # re-render preview/proofs/section-bit-*.png
```

- `kit/` is a verbatim copy of the Polaris Key Launch Kit v1 (`SHA256SUMS.txt` is the kit's own;
  the tests check every file against it). Never edit it; SVG is the source of truth and marks are
  never redrawn. To take a new kit version, replace the directory and run `gen`.
- `src/tokens/source.ts` is the colour design (OKLCH); `gen` emits hex.
- `fonts/*.woff2` come from `scripts/build-fonts.py` (fontTools + brotli, run once; committed).

Rubik is under the SIL Open Font License 1.1: see `THIRD_PARTY_NOTICES` and `fonts/OFL.txt`.

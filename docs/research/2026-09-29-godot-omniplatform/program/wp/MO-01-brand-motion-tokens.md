# MO-01 Motion tokens in `@polaris-key/brand`: `micro`, `moderate`, `deliberate`, `shimmer` durations, `emphasized` and `spring` easings, distances, scales, stagger and delays through `gen:brand` to CSS, Tailwind, TS, JSON and the kit languages; BRAND §7.5 and UI-KITS §4.8 updated

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 1: foundation)                                                                                                 |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                              |
| Depends on  | none                                                                                                                                                |
| Unblocks    | [MO-02](MO-02-motion-layer.md)                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                  |
| Plan mode   | no                                                                                                                                                  |
| Gates       | `pnpm gen:brand -- --check` (brand-token drift gate); the brand package tests; `pnpm --filter @polaris-key/docs check:links` if a docs page changes |
| Human input | none                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Goal

`packages/brand` owns the whole motion token set of notes/S-23 §5: `gen:brand` emits the new durations, easings, distances, scales, stagger and delays into `css/tokens.css` (`--pk-*`, collapsing to 0 under `prefers-reduced-motion: reduce` **and** `:root[data-motion="reduce"]`), `css/theme.css` (Tailwind `--ease-*`), `tokens.json`, `src/generated/tokens.ts` and the Swift, Kotlin and GDScript constants; BRAND.md §7.5 and UI-KITS.md §4.8 describe the one system.

## Why

Every later MO package, the UI kits and the sign-in card (SIGN-IN.md §3.18, which defers to S-23) animate through these tokens. Today the brand has four durations and three easings (`src/tokens/scales.ts` `MOTION`), not enough for exits, morphs, success moments and staggers, and UI-KITS §4.8's reduced-motion rule ("opacity at `fast`") contradicts the owner's "instant swaps" (notes/S-23 D3).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/brand/src/tokens/scales.ts` (`MOTION`), `src/tokens/kit.ts` (`KIT_MOTION`, `KIT_MOTION_MEASURES`), `scripts/gen.ts` (the reduced-motion block, `duration-*` and `ease-*` emission), `scripts/gen-kit.ts` (Swift, Kotlin, GDScript motion constants).
- [BRAND.md §4 and §7.5](../../../../design/BRAND.md), [UI-KITS.md §4.8](../../../../design/UI-KITS.md).

## Scope

**In:**

- `MOTION` gains: durations `micro` 80 ms, `moderate` 260 ms, `deliberate` 480 ms, `shimmer` 1600 ms; easings `emphasized` `cubic-bezier(0.05, 0.7, 0.1, 1)` and `spring` (the `linear()` curve in `prototype/motion/motion.css`, with a `@supports not (transition-timing-function: linear(0, 1))` fallback to `standard`); `distance` xs 2, sm 4, md 8, lg 12, xl 24 px; `scale` press 0.98, enter 0.98, pop 0.9; `stagger` step 30 ms, max 6; `delay` skeleton 150 ms, highlight 1600 ms.
- `gen.ts`: emit `--pk-duration-*`, `--pk-ease-*`, `--pk-motion-distance-*`, `--pk-motion-scale-*`, `--pk-stagger-step`, `--pk-stagger-max`, `--pk-delay-*`; the reduced-motion block collapses **every** duration and `--pk-stagger-step` (not the delays) and is repeated for `:root[data-motion="reduce"]`; `theme.css` gains `--ease-emphasized` and `--ease-spring`.
- `gen-kit.ts`: the Swift, Kotlin and GDScript motion constants gain `micro`, `moderate`, `deliberate` and the distances; `KIT_MOTION_MEASURES` keeps its values (stepSlide 8 = md, sheetRise 24 = xl); `KIT_MOTION.web` rows are renamed to the S-23 pattern names (enter, exit, morph, press, meter, skeleton, success) with unchanged numbers.
- BRAND.md: the §4 token table rows; §7.5 rewritten to notes/S-23 §9's text (functional and expressive within the tokens; the success moments of EXPERIENCE §0.7; only loading indicators loop; no parallax; the star never moves; reduced motion swaps instantly).
- UI-KITS.md §4.8: "Reduced motion swaps instantly (S-23 D3); `\"none\"` is the same" replaces "keeps only the opacity change, at `fast`"; add the new durations to its first line.

**Out** (and where it belongs instead):

- Keyframes, patterns and the utility layer (→ MO-02).
- Any change in `packages/admin` (→ MO-02).
- Kit-side motion code (→ the UK packages, which read these constants).

## Design notes

- Names are final (SIGN-IN.md §3.18 adopts them): no `quick` token; exits use `fast`.
- `delay-*` tokens are not motion and must **not** collapse under reduced motion: a skeleton still waits 150 ms, a new row's tint still lasts 1.6 s.
- The generated files are committed and drift-checked (AGENTS.md rule 3). `wp/U-04-catalog-and-service` also regenerates `css/tokens.css`, `css/theme.css`, `tokens.json` and `src/generated/tokens.ts`: resolve a conflict by regenerating, never by hand.

## Files it touches

`packages/brand/src/tokens/scales.ts`, `src/tokens/kit.ts`, `scripts/gen.ts`, `scripts/gen-kit.ts`, the generated `css/tokens.css`, `css/theme.css`, `css/kit.css`, `tokens.json`, `src/generated/{tokens,kit}.ts`, `sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift`, the Kotlin `BrandTokens.generated.kt`, `sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd`, brand tests, `docs/design/BRAND.md`, `docs/design/UI-KITS.md`. In flight: `wp/U-04` (generated brand files; regenerate on rebase).

## Steps

1. Extend `MOTION` and the kit motion tables.
2. Teach `gen.ts` and `gen-kit.ts` the new groups and both reduced-motion selectors; regenerate (`pnpm gen:brand`).
3. Add brand tests: every duration collapses under both selectors; delays do not; `spring` has its fallback.
4. Edit BRAND.md and UI-KITS.md.

## Acceptance criteria

- [ ] `pnpm gen:brand -- --check` is clean and the generated CSS contains every token of notes/S-23 §5 with the listed values.
- [ ] Under `prefers-reduced-motion: reduce` and under `:root[data-motion="reduce"]` every `--pk-duration-*` and `--pk-stagger-step` is `0ms`; `--pk-delay-*` are unchanged (a brand test asserts it).
- [ ] The Swift, Kotlin and GDScript generated constants include `micro`, `moderate` and `deliberate` and the kits still build (`swift build`, the Kotlin `:ui` compile, the Godot runner).
- [ ] BRAND.md §7.5 and UI-KITS.md §4.8 read as notes/S-23 §9 proposes.

## Verify

```sh
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm --filter @polaris-key/brand test
mise exec node@22 -- pnpm build && mise exec node@22 -- pnpm typecheck
```

## Hand-off

MO-02 and every kit read these names. SIGN-IN.md §3.18's packages use them as they are. Nothing is deliberately left except the patterns (MO-02). The role agent sets `--set MO-01 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-01 done`.

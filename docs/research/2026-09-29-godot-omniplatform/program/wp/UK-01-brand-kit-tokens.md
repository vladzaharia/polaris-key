# UK-01 Brand tokens for every UI kit: variable Rubik and JetBrains Mono, weight and type-scale tokens, `kit.ts` component tokens, `deriveAccent`/`resolveAccent` with shared vectors, Python/terminal/C# targets, BRAND.md updates

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                                                                             |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                       |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                                                                     |
| Unblocks    | [UK-03](UK-03-ui-core.md), [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md), [UK-22](UK-22-host-design-systems.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gates       | `pnpm gen:brand -- --check` (rule 3, generated banners); the per-SDK generated-file tests; mockup render (`render.cjs`) clean                                                                                                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                |

## Goal

`pnpm gen:brand` emits every token every kit reads, in every language, from `packages/brand`, and the drift gate covers all of it. Rubik ships as a variable font with weights 400/500/600 in use, the kit mono is JetBrains Mono, and the accent resolver gives the same answer in TypeScript, Swift, Kotlin, GDScript and Python for the shared vectors.

## Why

Every kit reads these tokens, so they come first (§10). Today only Rubik 400 and 700 ship, which forced every non-body string to Bold (critique round 1), and the accent resolver does not exist. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §2 (tokens, type scale, new targets, fonts, drift gate), §3.3 (the accent resolver and its vector table), §9 (what this supersedes)
- `packages/brand/scripts/gen.ts`, `packages/brand/src/tokens/`, `packages/brand/src/color.ts`
- `docs/design/BRAND.md` §4, §7.1, §12, §12.1 and its owner decisions (2026-10-04)

## Scope

**In:**

- Variable Rubik (wght 300–900, latin WOFF2 plus TTFs) and JetBrains Mono (400–600 variable) replacing the static 400/700 files; `--pk-font-weight-medium: 500`, `--pk-font-weight-semibold: 600`; per-platform `typeScale`.
- `packages/brand/src/tokens/kit.ts`: the §2.1 component-token table per platform variant, the `highlight` edge, the danger `solid`, the motion mapping (§4.8) and the concentric rule.
- `deriveAccent(iconPixels)` and the white-first `resolveAccent(hex, scheme)` in `@polaris-key/brand`, with the §3.3 vectors as a shared JSON fixture ported to Swift, Kotlin, GDScript and Python tests; the pinned test that `on` is identical in both schemes.
- New generated targets: `css/kit.css` (`--pk-kit-*`), `src/generated/kit.ts`, `KitTokens.generated.swift`, `PolarisKitTokens.generated.kt`, Godot `pkey_brand_{dark,light}.tres` and engine control icons, Python `polaris_key/ui/_tokens.py` + Qt Quick `Theme.qml` + QSS, terminal ANSI tables for Node and Python, `PKeyBrand.generated.cs`.
- Fonts per platform (§2.1): Compose Resources fonts, Godot MSDF `FontFile`s, TTFs with `OFL.txt` in the Python wheel.
- BRAND.md: §12.1 replaced by a pointer to UI-KITS.md; the 2026-10-04 "native by default" bullets marked superseded; §7.1 SDK rows replaced by UI-KITS §1.6; §4 and §4.6 (variable Rubik, JetBrains Mono).
- The mockups still to draw before UK-01 closes (§8, critique round 1 list, as amended: no RTL boards, the iOS 18 and macOS 15 fallbacks instead of iOS 17).

**Out** (and where it belongs instead):

- The copy catalog (→ UK-02a).
- Kit code that consumes the tokens (→ each kit).
- Presentation accent plumbing (→ HA-13, HA-14; the resolver here only takes a colour).

## Design notes

- No ttk image elements: Tk is dropped (owner, 2026-10-05).
- Weights in UI are 400, 500 and 600 only; 700 is allowed only for the game wordmark fallback.
- Every generated file carries the GENERATED banner (rule 3) and is covered by `gen:brand -- --check`; each SDK suite adds one test that its committed file matches the generator.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] `pnpm gen:brand -- --check` covers every new output, and a hand edit to any of them fails it.
- [ ] The §3.3 vector table passes in TypeScript, Swift, Kotlin, GDScript and Python.
- [ ] The mockup render (`render.cjs`) runs with no console error and no missing font, and the new boards exist in both themes.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm --filter @polaris-key/brand test
NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs
```

## Hand-off

Every kit imports the generated tokens and the resolver; none hand-copies a value. UK-15's colour-literal lint relies on the generated files being the only place colours live.

The role agent sets `--set UK-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-01 done`.

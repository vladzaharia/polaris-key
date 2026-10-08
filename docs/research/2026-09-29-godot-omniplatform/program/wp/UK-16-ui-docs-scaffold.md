# UK-16 UI docs scaffold: the `build/ui/` docs section (overview, theming, localisation, component and framework page templates embedding baselines, recipes) and the `examples/ui/` hub

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-15](UK-15-visual-qa-harness.md)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unblocks    | [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-06](UK-06-electron-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-17](UK-17-vue-kit.md), [UK-18](UK-18-svelte-kit.md), [UK-19](UK-19-angular-kit.md), [UK-20](UK-20-react-native-kit.md), [UK-21](UK-21-tauri-bridge.md), [UK-41](UK-41-must-tier-closeout.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Gates       | docs link check (`pnpm --filter @polaris-key/docs check:links`); the docs route drift gates (AGENTS rules 10–11)                                                                                                                                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Goal

A docs section exists that every kit writes into: the overview, theming and localisation pages are written, and the component and framework page templates embed baselines so docs cannot drift from what ships.

## Why

§10 makes every kit ship its own docs pages; they need a shared skeleton first, or each kit invents its own. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §6.1, §6.2
- `packages/docs/src/content/docs/build/sdks/*.mdx`, AGENTS.md "Conventions when writing docs pages"

## Scope

**In:**

- `packages/docs/src/content/docs/build/ui/`: overview (three layers, the look, product identity and the presentation default), Theming (§3 with one tab per kit, filled as kits land), Localisation, Recipes index.
- A component page template that embeds the baseline PNGs in both themes, and one framework page template.
- `examples/ui/README.md` index; `kotlin-ui.mdx` redirected to the Compose page.

**Out** (and where it belongs instead):

- Per-kit framework pages and component tabs (→ each kit).
- Host design-system recipes (→ UK-22).

## Design notes

- The docs site is gated (rule 11); the repo is the agent-readable source.

**Corrections against the code (UK-16, 2026-10-06).**

- The header's "docs route drift gates (AGENTS rules 10–11)" and UI-KITS.md §6.2's "rules 9–10"
  do not apply as written: docs pages are not Worker routes. The Worker serves `/docs/*` from the
  assembled asset root (`packages/worker/src/docs.ts`), so a new page needs no OpenAPI entry and
  no `routeCoverage` row (rule 10), and no manifest validator rule (rule 9). The drift gates a docs
  page does touch are `pnpm --filter @polaris-key/docs gen:check` (the generated reference pages,
  unchanged here), `check:links` (now also checking every `/docs/...` `src`, so a missing baseline
  image fails it), the committed `docsCsp.generated.ts` with the worker's `docsCspParity` test
  (the new pages add Starlight's Tabs scripts), and the `docs-slugs.json` manifest with the
  worker's `docsLinks` test.
- "Theming with one tab per kit" follows §3.2's rows (React, Web components, Vue/Svelte/Angular,
  SwiftUI, UIKit/AppKit, Compose, Godot, Qt, Terminal), each a "not filled yet" placeholder with
  the planned entry point until its kit ships the theme API.
- The scaffold creates every catalog component's page now (23, from
  `packages/brand/kit-copy/components.json`) rather than leaving each kit to create them, so kits
  only add tabs and two kits never race to create one page. Baselines reach the pages by file
  name, through per-kit literal globs in `packages/docs/src/lib/baselines.ts` that a test holds to
  ui-qa's `BASELINE_DIRS`. Every globbed file is published, so each kit's pattern is its docs
  subset (Compose: the branded phone render).
- `kotlin-ui.mdx` is replaced by `build/ui/frameworks/compose.mdx` (the first page on the
  framework template, still rendering `sdks/kotlin/ui/README.md`) and an Astro redirect from
  `/docs/build/sdks/kotlin-ui/`.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [x] The section builds and `check:links` passes.
- [x] A component page renders baseline images from a kit's committed baseline path.
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Each kit adds its framework page and component tabs here and slims its README.

The role agent sets `--set UK-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-16 done`.

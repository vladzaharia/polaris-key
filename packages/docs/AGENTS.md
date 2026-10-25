# AGENTS.md: packages/docs

Local traps for the docs site. The root `AGENTS.md` rules still apply; commands and layout are in [README.md](README.md).

- **Three doors**: Help (`help/`) for people using an app; Developers (`start/`, `build/`, `features/`, `reference/`); Operate (`operate/`, `contribute/`). Long-form adopter and authoring material lives here, not in the repo's `docs/`.
- **Doors and tiers come from the directory** (`src/lib/doors.ts`), never from frontmatter. Moving a page is a row in `site-map.json`, applied with `node scripts/site-map.mjs apply`; the file also lists the hidden stubs that reserve planned paths.
- **`lint-debt.json` only shrinks.** `pnpm --filter @polaris-key/docs lint:docs` fails on a hit the ledger does not hold. Never add to it to get green.
- **`build` writes four outputs**: the Astro site, redirect fragments, `docsCsp.generated.ts` in the Worker, and `dist/docs-slugs.json`. Never hand-edit them; rebuild.
- **`reference/*.mdx` is generated.** Run `pnpm --filter @polaris-key/docs gen`; `gen:check` fails on a stale page.
- **Page conventions**:
  - quote frontmatter values (`title: "…"`);
  - no bare `{` or `}` in MDX prose; braces inside a code span are literal;
  - internal links are absolute and end in a slash: `/docs/features/managed-config/catalog/`;
  - code fences are compiled (`test/snippets/extract.ts`), and `no-compile` is never allowed on a page in `test/snippets/covered.ts`. ` ```ts run ` also executes a block. A code span naming an export must be one the SDK exports, or its line says "planned".
  - `swift`, `kotlin` and `gdscript` fences compile against the real SDK (`test/snippets/nativeLanes.ts`): Swift needs macOS, Kotlin a JDK 17, GDScript `godot` on PATH or `GODOT_BIN`. CI names the lanes it requires in `PKEY_DOCS_LANES`.
- **Renaming a page** also updates `packages/admin/src/console/nav.ts` and `packages/admin/src/lib/docsLinks.ts`.
- **Words**: Help says "app" throughout. The rest of the writing rules: `docs/research/2026-10-08-docs/style-guide.md` (published as Contribute → Writing docs).

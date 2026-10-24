# AGENTS.md: packages/docs

Local traps for the docs site. The root `AGENTS.md` rules still apply; commands and layout are in [README.md](README.md).

- **Doors and tiers come from the directory** (`src/lib/doors.ts`), never from frontmatter. Moving a page is a row in `site-map.json`, applied with `node scripts/site-map.mjs apply`; the file also lists the hidden stubs that reserve planned paths.
- **`lint-debt.json` only shrinks.** `pnpm --filter @polaris-key/docs lint:docs` fails on a hit the ledger does not hold. Never add to it to get green.
- **`build` writes four outputs**: the Astro site, redirect fragments, `docsCsp.generated.ts` in the Worker, and `dist/docs-slugs.json`. Never hand-edit them; rebuild.
- **`reference/*.mdx` is generated.** Run `pnpm --filter @polaris-key/docs gen`; `gen:check` fails on a stale page.
- **Page conventions**:
  - quote frontmatter values;
  - no bare `{` or `}` in MDX prose;
  - internal links are absolute and end in a slash;
  - code fences are compiled, and `no-compile` is never allowed on a page in `test/snippets/covered.ts`.
- **Renaming a page** also updates `packages/admin/src/console/nav.ts` and `packages/admin/src/lib/docsLinks.ts`.
- Terminology follows `src/content/docs/start/concepts.md`.

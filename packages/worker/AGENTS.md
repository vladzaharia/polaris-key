# AGENTS.md: packages/worker

Local traps for the Worker. The root `AGENTS.md` rules still apply; what the package is lives in [README.md](README.md).

- **Node 22 only.** The suite drives D1 through native `better-sqlite3`; a newer Node fails to collect the whole package. Prefix commands with `mise exec node@22 --`.
- **Layers** (`src/platform/` and `src/db/` < `src/core/` < `src/services/<slug>/` < `src/console/` and `src/mount.ts`): each imports only itself and lower layers; type-only imports count. `test/boundaries.test.ts` walks `src/` and the runtime import graph.
- **Services** import `core/`, `platform/`, `db/`, their own directory and declared packages. The only cross-service edge is `update → release`; everything else goes through the descriptor hooks in `src/core/hooks.ts`. The console reads a service only through its `src/services/<slug>/public.ts`.
- **Tables are owned.** A new D1 table needs a row in `src/db/owners.ts` (`TABLE_OWNERS`). `test/tableCrossings.test.ts` fails when a service reads or writes another service's table, or Core or the console writes one, unless a `SEAMS` / `WRITE_SEAMS` row names it with `removedBy` (a package or `permanent`); Core's tables are shared. `audit` has one writer, `src/core/audit.ts` (`test/auditWriter.test.ts`).
- **Migrations** are `migrations/00XX_<name>.sql`; the lead assigns the number at merge time.
- **A new route** needs an OpenAPI entry and, for a service, its descriptor's `surface` (root rule 10).
- **The workerd smoke**: Node allows runtime code generation that workerd forbids, so a green `pnpm test` does not prove the runtime. Run `pnpm --filter @polaris-key/worker typecheck:workerd` and `pnpm --filter @polaris-key/worker test:workerd` when you touch runtime code.
- `pnpm build` does not typecheck the Worker; run `pnpm typecheck`.

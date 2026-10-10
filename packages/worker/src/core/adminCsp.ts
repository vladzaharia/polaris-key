/**
 * The CSP source expressions for the inline scripts in the admin/portal SPA shells
 * (`packages/admin/index.html` and `packages/admin/manage.html`).
 *
 * There is exactly one: the pre-paint theme script (docs/design/BRAND.md §3), which reads the
 * persisted theme from `localStorage` and sets `data-theme` on `<html>` before the first paint,
 * so a light-theme user never sees a dark flash. It must run before the bundle loads, so it is
 * inline; `appSecurityHeaders` allows it by hash and nothing else inline ever runs
 * (`'unsafe-inline'` never appears).
 *
 * Hand-maintained, and checked from both sides so it cannot drift:
 *   - packages/admin/test/theme.test.tsx hashes the script in both HTML sources and requires
 *     the result to be listed here (runs on every `pnpm test`, no build needed);
 *   - packages/worker/test/adminCspParity.test.ts sweeps the BUILT shells in packages/admin/dist
 *     and requires the set of inline-script hashes to equal this list exactly.
 */
export const ADMIN_SCRIPT_HASHES: readonly string[] = [
  "'sha256-YlwcFk/JBj5nmlys+DONIW0sGgDVwI9Wz/FNj3awy0o='",
];

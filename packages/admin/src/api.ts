/**
 * Same-origin typed client for the `/manage/api/*` surface. The worker
 * (`packages/worker/src/console/api.ts` + each service's `admin.ts`) is the source of truth for
 * these shapes.
 *
 * ── THE ADMIN SURFACE IS SERVICE-GROUPED (plan §R1) ─────────────────────────────────────────
 *
 * Every product-scoped resource now lives under the service that owns it, and the pre-suite
 * spellings are GONE server-side (pre-launch; this client was their only consumer):
 *
 *   licenses[/…] → license/licenses[/…]      schema  → config/catalog
 *   tiers[/…]    → license/tiers[/…]         profiles[/…] → config/profiles[/…]
 *   portal       → identity/portal            policy  → the settings `license.fingerprint` and
 *                                              `license.autoIssue` (the generic settings API)
 *
 * Core/platform resources keep their top-level spelling because they belong to no service:
 * `secrets/*`, `keys/rotate`, `activity`, `services[/revert]`, `bundles`.
 *
 * Auth is the HttpOnly session cookie (sent automatically); every state-changing
 * call echoes the per-session CSRF token in the `X-PKey-CSRF` header or the server rejects
 * it. A 401 means the session lapsed → bounce to the login redirect to re-authenticate.
 *
 * Secrets are write-only: a managed *secret* comes back as `{ state, configured, updatedAt }`
 * only — its value NEVER crosses the wire, mirrored here so the UI can't render one.
 *
 * Management state is the v2 MDM model: `default` (server value is a default the client may
 * override) | `enforced` (server value wins, read-only) | `hidden` (enforced + withheld from
 * enumeration). Every managed entry carries `updatedAt` (epoch seconds) for change detection.
 */

// ── catalog / config shapes ──────────────────────────────────────────────────
/**
 * Re-exported from `@polaris-key/catalog`, which is the ONE definition the worker validates against,
 * the SDKs read, and `tools/gen-mirrors.ts` generates from. The console used to re-declare a
 * hand-copied subset here (`ui.widget` as a bare `string`, no `dependsOn`/`appliesTo`), which is
 * how a form silently stops rendering a field the catalog gained. Views keep importing these
 * from `./api.js` — this file is still the console's single import surface, it just no longer
 * owns the shapes.
 */
export type {
  ConfigEntry,
  ConfigKind,
  ManagementState,
  ProductCatalog,
  UiHints,
} from "@polaris-key/catalog";
import type { ServiceSlug } from "./services.generated.js";
import { platformApi } from "./console/api/platform.js";
import { productsApi } from "./console/api/products.js";
import { coreApi } from "./console/api/core.js";
import { configApi } from "./console/api/config.js";
import { distributionApi } from "./console/api/distribution.js";
import { releaseApi } from "./console/api/release.js";
import { updateApi } from "./console/api/update.js";
import { licenseApi } from "./console/api/license.js";
import { feedsApi } from "./console/api/feeds.js";
import { activityApi } from "./console/api/activity.js";
import { settingsApi } from "./console/api/settings.js";
import { syncApi } from "./console/api/sync.js";
import { searchApi } from "./console/api/search.js";
export * from "./console/api/platform.js";
export * from "./console/api/products.js";
export * from "./console/api/core.js";
export * from "./console/api/config.js";
export * from "./console/api/distribution.js";
export * from "./console/api/release.js";
export * from "./console/api/update.js";
export * from "./console/api/license.js";
export * from "./console/api/feeds.js";
export * from "./console/api/activity.js";
export * from "./console/api/settings.js";
export * from "./console/api/sync.js";
export * from "./console/api/search.js";
export {
  ApiError,
  setCsrf,
  setLoginRedirectForTests,
} from "./console/api/transport.js";

/** The opt-in services layered over the always-on Core substrate — generated from the service
 *  table (`tools/services.json`) by `pnpm gen services`. */
export type { ServiceSlug };

export { SERVICE_ERROR_MESSAGES } from "./lib/serviceErrorMessages.js";

// A gated action refused for a stale step-up goes to the step-up sign-in and back.
export { setStepUpRedirectForTests, startStepUp } from "./lib/stepUp.js";

const rawApi = {
  ...platformApi,
  ...productsApi,
  ...coreApi,
  ...configApi,
  ...distributionApi,
  ...releaseApi,
  ...updateApi,
  ...licenseApi,
  ...feedsApi,
  ...activityApi,
  ...settingsApi,
  ...syncApi,
  ...searchApi,
};

/** The admin API surface: every endpoint the console calls. */
export type AdminApi = typeof rawApi;

/**
 * The admin API client. Reads are called directly; WRITES go through `mutate()` in
 * `console/data/mutations.ts`, which runs each write's declared invalidation (ADMIN.md §5.4).
 * `test/mutations.test.ts` fails if a view calls a write on `api` directly.
 */
export const api: AdminApi = rawApi;

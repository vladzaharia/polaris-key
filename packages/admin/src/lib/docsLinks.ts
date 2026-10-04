/**
 * The console's help-link registry — the ONE table naming every docs page the UI points at.
 *
 * The docs site is served by this same worker at `/docs`, behind the same platform-admin
 * session the console runs under, so every link here opens without a second sign-in. Links
 * are site-absolute paths with trailing slashes (the site builds with directory-format
 * URLs).
 *
 * Drift gate: `packages/worker/test/docsLinks.test.ts` asserts every path this module (and
 * `console/nav.ts`'s per-page `docs` declarations) names exists in the built site's slug manifest
 * (`packages/docs/dist/docs-slugs.json`) — a help link cannot silently point at a page that
 * stopped existing. Add a link here → the page must exist; rename a page → this table (or
 * the nav table) fails CI until it follows.
 */

/** Help topics for dialogs, empty states, and inline callouts (view headers live on the nav
 *  table in `console/nav.ts` — `NavPage.docs` — so the sidebar and the help link cannot disagree). */
export const DOCS_LINKS = {
  // Dialogs
  createProduct: "/docs/admin/products/",
  setSecret: "/docs/admin/secrets-and-keys/",
  rotateKey: "/docs/admin/secrets-and-keys/",
  publishCatalog: "/docs/services/config/catalog/",
  createLicense: "/docs/admin/licenses-and-devices/",
  mintKey: "/docs/services/license/model/",
  mintBundle: "/docs/admin/bundles/",
  tierEditor: "/docs/services/license/model/",
  createProfile: "/docs/services/config/profiles/",
  resync: "/docs/build/manifest/",
  servicesRevert: "/docs/admin/services-enablement/",
  fingerprintRevert: "/docs/services/license/policy/",
  updateSettingsRevert: "/docs/services/update/eligibility/",
  releaseChannels: "/docs/services/release/channels/",
  packDeliverables: "/docs/services/release/packs/",
  compatSimulator: "/docs/services/release/compatibility/",
  rolloutControl: "/docs/admin/distribution-matrix/",
  storeConnections: "/docs/admin/store-connections/",
  platformSecrets: "/docs/admin/deploy/",
  // Inline explainer callouts
  manifestNote: "/docs/build/manifest/",
  updateAccessNote: "/docs/services/update/eligibility/",
  identityOidcNote: "/docs/services/identity/oidc/",
  downloadPage: "/docs/users/downloads/",
  // Editors + policy surfaces
  managedPayloads: "/docs/services/config/profiles/",
  managementStates: "/docs/services/config/management-states/",
  deviceFingerprints: "/docs/services/core/fingerprints/",
  offlineBundles: "/docs/build/wire/bundles/",
  registrationPolicy: "/docs/services/core/device-principal/",
  // Landing
  docsHome: "/docs/",
} as const;

export type DocsLinkKey = keyof typeof DOCS_LINKS;

/** The href for a registered help topic. */
export function docsUrl(key: DocsLinkKey): string {
  return DOCS_LINKS[key];
}

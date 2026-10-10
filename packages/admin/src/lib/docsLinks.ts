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
  createProduct: "/docs/operate/console/products/",
  setSecret: "/docs/operate/console/keys-and-secrets/",
  rotateKey: "/docs/operate/console/keys-and-secrets/",
  publishCatalog: "/docs/features/managed-config/catalog/",
  createLicense: "/docs/features/licensing/manage-licenses/",
  mintKey: "/docs/features/licensing/model/",
  mintBundle: "/docs/features/licensing/offline/",
  tierEditor: "/docs/features/licensing/model/",
  createProfile: "/docs/features/managed-config/profiles/",
  resync: "/docs/build/manifest/",
  servicesRevert: "/docs/operate/console/products/",
  fingerprintRevert: "/docs/features/licensing/access/",
  updateSettingsRevert: "/docs/features/ship-builds/updates/eligibility/",
  releaseChannels: "/docs/features/ship-builds/releases/channels/",
  ciPublishing: "/docs/features/ship-builds/ci/",
  packDeliverables: "/docs/features/ship-builds/packs/",
  compatSimulator: "/docs/features/ship-builds/releases/compatibility/",
  rolloutControl: "/docs/features/ship-builds/channels/",
  storeConnections: "/docs/operate/platform/connections/",
  // PS-06: the built-in storefront's page (listing, audience, ways to add, preview, analytics).
  polarisKeyStorefront: "/docs/features/ship-builds/channels/polaris-key/",
  packageFeeds: "/docs/features/ship-builds/packages/",
  packageFeedsHost: "/docs/features/ship-builds/packages/",
  platformSecrets: "/docs/operate/platform/deploy/",
  // Inline explainer callouts
  manifestNote: "/docs/build/manifest/",
  updateAccessNote: "/docs/features/ship-builds/updates/eligibility/",
  identityOidcNote: "/docs/features/sign-in/oidc/",
  // P0-47: where auto-issue is set (the manifest's `autoIssue`), named from Identity → Sign-in,
  // which links its `#auto-issue` section.
  autoIssue: "/docs/features/licensing/access/",
  downloadPage: "/docs/help/download/",
  // Editors + policy surfaces
  managedPayloads: "/docs/features/managed-config/profiles/",
  managementStates: "/docs/features/managed-config/management-states/",
  deviceFingerprints: "/docs/features/licensing/fingerprints/",
  offlineBundles: "/docs/reference/protocol/bundles/",
  registrationPolicy: "/docs/reference/protocol/device-principal/",
  // Landing
  docsHome: "/docs/",
} as const;

export type DocsLinkKey = keyof typeof DOCS_LINKS;

/** The href for a registered help topic. */
export function docsUrl(key: DocsLinkKey): string {
  return DOCS_LINKS[key];
}

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
 * (`packages/docs/dist/docs-slugs.json`), and that a `#fragment` names a heading on that page — a help link cannot silently point at a page that
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
  // The admin API token `pkey bundle` authenticates with: the offline page documents it.
  mintApiToken: "/docs/features/licensing/offline/",
  tierEditor: "/docs/features/licensing/manage-licenses/",
  createProfile: "/docs/features/managed-config/profiles/",
  resync: "/docs/build/manifest/",
  servicesRevert: "/docs/operate/console/products/",
  fingerprintRevert: "/docs/features/licensing/access/",
  updateSettingsRevert: "/docs/features/ship-builds/updates/eligibility/",
  releaseChannels: "/docs/features/ship-builds/releases/channels/",
  ciPublishing: "/docs/features/ship-builds/ci/",
  packDeliverables: "/docs/features/ship-builds/packs/",
  compatSimulator: "/docs/features/ship-builds/releases/compatibility/",
  rollouts: "/docs/features/ship-builds/channels/rollouts/",
  releasesHome: "/docs/features/ship-builds/releases/",
  rolloutControl: "/docs/features/ship-builds/channels/",
  storeConnections: "/docs/operate/platform/connections/",
  // PS-06: the built-in storefront's page (listing, audience, ways to add, preview, analytics).
  polarisKeyStorefront: "/docs/features/ship-builds/channels/polaris-key/",
  // B-226: the storefronts pages (the tile list and the Add to storefronts flow) and the listing.
  channels: "/docs/features/ship-builds/channels/",
  storefronts: "/docs/features/ship-builds/channels/storefronts/",
  storefrontListing: "/docs/features/ship-builds/channels/polaris-key/",
  packageFeeds: "/docs/features/ship-builds/packages/",
  // The Personal tokens page's Learn-more link: the section on the packages page.
  personalTokens: "/docs/features/ship-builds/packages/#personal-tokens",
  // ST-34.11: the CLI reference, where `pkey login` is.
  cliReference: "/docs/reference/cli/",
  packageFeedsHost: "/docs/features/ship-builds/packages/",
  // F-34.7: the Packages page's empty panel names the task, so it opens that section.
  declarePackage:
    "/docs/features/ship-builds/packages/publish/#declare-the-package",
  publishFromCi: "/docs/features/ship-builds/packages/publish/#publish-from-ci",
  platformSecrets: "/docs/operate/platform/deploy/",
  // Inline explainer callouts
  manifestNote: "/docs/build/manifest/",
  updateAccessNote: "/docs/features/ship-builds/updates/eligibility/",
  identityOidcNote: "/docs/features/sign-in/oidc/",
  // P0-47: where auto-issue is set (the manifest's `autoIssue`), named from Identity → Sign-in,
  // which sits under Enroll a device.
  autoIssue: "/docs/features/licensing/access/#enroll-a-device",
  downloadPage: "/docs/help/download/",
  // Editors + policy surfaces
  managedPayloads: "/docs/features/managed-config/profiles/",
  managementStates: "/docs/features/managed-config/management-states/",
  deviceFingerprints: "/docs/features/licensing/fingerprints/",
  offlineBundles: "/docs/reference/protocol/bundles/",
  registrationPolicy: "/docs/reference/protocol/device-principal/",
  // The Integration page (ST-41): one drop-in per host, then these two links. "Customise the
  // screens" opens the kit's page, "Integrate directly with the library" the SDK's own-UI page.
  // A path may end in a #fragment; the docs build's slug manifest checks it names a heading.
  notSeenYet: "/docs/build/troubleshooting/#not-seen-yet",
  // U-05.20: Cloud Sync → Usage (the nav table carries page paths only, never a fragment).
  syncUsage: "/docs/features/cloud-sync/#in-the-console",
  connect: "/docs/features/cloud-connect/",
  // The server card (SP-64): the contract, then the framework-free core.
  serverVerify: "/docs/build/servers/",
  serverCore: "/docs/build/servers/#use-the-core-directly",
  nodeCustomiseCli: "/docs/build/ui/frameworks/terminal-node/#piecemeal",
  nodeOwnUiCli: "/docs/build/sdks/node/your-own-ui/#cli",
  nodeCustomiseElectron: "/docs/build/ui/frameworks/react/",
  nodeOwnUiElectron: "/docs/build/sdks/node/your-own-ui/#electron",
  nodeLibrary: "/docs/build/sdks/node/",
  reactCustomise: "/docs/build/ui/frameworks/react/#piecemeal",
  reactOwnUi: "/docs/build/sdks/react/your-own-ui/",
  pythonCustomise: "/docs/build/ui/frameworks/terminal-python/#piecemeal",
  pythonOwnUi: "/docs/build/sdks/python/your-own-ui/",
  pythonQt: "/docs/build/sdks/python/your-own-ui/#qt",
  swiftCustomise: "/docs/build/ui/frameworks/swiftui/#piecemeal",
  swiftOwnUi: "/docs/build/sdks/swift/your-own-ui/",
  swiftUikitAppkit: "/docs/build/sdks/swift/your-own-ui/#uikit-and-appkit",
  kotlinCustomise: "/docs/build/ui/frameworks/compose/#piecemeal",
  kotlinOwnUi: "/docs/build/sdks/kotlin/your-own-ui/",
  kotlinComposeDesktop: "/docs/build/sdks/kotlin/your-own-ui/#compose-desktop",
  godotCustomise: "/docs/build/ui/frameworks/godot/#scenes",
  godotOwnUi: "/docs/build/sdks/godot/your-own-ui/",
  // Console pages that link their own docs page inline (B-fix: formerly legacy admin-path literals).
  activityPage: "/docs/operate/console/activity/",
  devicesPage: "/docs/features/licensing/manage-licenses/",
  usersPage: "/docs/operate/console/users/",
  appStorePage: "/docs/features/ship-builds/channels/app-store/",
  credentialsPage: "/docs/operate/console/keys-and-secrets/",
  productsPage: "/docs/operate/console/products/",
  deployPage: "/docs/operate/platform/deploy/",
  keyringRunbook: "/docs/operate/platform/runbook/",
  storeConnectionsPage: "/docs/operate/platform/connections/",
  consoleDocsHome: "/docs/operate/",
  storefrontSetup: "/docs/features/commerce/#setting-it-up",
  // Landing
  docsHome: "/docs/",
} as const;

export type DocsLinkKey = keyof typeof DOCS_LINKS;

/** The href for a registered help topic. */
export function docsUrl(key: DocsLinkKey): string {
  return DOCS_LINKS[key];
}

/** The channels with a docs page of their own under Ship builds → Channels (A-22.7). */
const CHANNEL_DOCS = new Set([
  "app-store",
  "flathub",
  "google-play",
  "homebrew",
  "itch",
  "microsoft-store",
  "polaris-key",
  "scoop",
  "snap",
  "steam",
  "winget",
]);

/** A channel page's Docs button: the channel's own page, else the Channels overview. */
export function channelDocs(id: string | undefined): string {
  return id !== undefined && CHANNEL_DOCS.has(id)
    ? `/docs/features/ship-builds/channels/${id}/`
    : DOCS_LINKS.channels;
}

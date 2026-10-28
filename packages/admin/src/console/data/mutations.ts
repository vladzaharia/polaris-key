/**
 * The mutation → invalidation table (docs/design/ADMIN.md §5.4). Fixes CC-1 to CC-4.
 *
 * Every write the admin API client can make is a key here, with the queries it makes stale, and
 * every write is made through `mutate(method, ...args)`, which runs that invalidation once the
 * server confirms. A view therefore cannot forget one: before this table, 44 hand-placed
 * `invalidate` calls missed `me` after a product create (CC-1), most of what a resync rewrites
 * (CC-2), Compatibility and the Matrix after a yank (CC-3), and the compatibility overlay and
 * health after a rollout verb (CC-4).
 *
 * `test/mutations.test.ts` calls every API method against a recording fetch and fails if a method
 * that sends anything but GET has no entry here, if an entry names a method that is not a write,
 * or if any source file calls a write on `api` directly instead of through `mutate`.
 *
 * Supersets are deliberate where the arguments cannot name the exact record (a product-level
 * device deauthorize does not know the device's license, so it refreshes every license): one
 * extra refetch is cheap, a stale security fact is not (§0.2 "the server is the truth").
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createWrites, type Target } from "../../lib/writes.js";
import {
  api,
  HttpError,
  type AdminApi,
  type AlertScope,
  type FeedScope,
} from "../../api.js";
import { SYSTEM_PRODUCT_SLUG } from "../sections/feeds/model/model.js";
import { qk } from "./queries.js";

/** What a product-scope Members write makes stale: the product's roster, the platform's, who can give access. */
const productMemberTargets = (slug: string): Target[] => [
  prefix(qk.productMembers(slug)),
  prefix(qk.members()),
  prefix(qk.platformActivity()),
  prefix(qk.activity(slug)),
  prefix(["access-admins"]),
];

export type { Target };

const prefix = (key: QueryKey): Target => ({ key });
/** The trail a write in `scope` appends to (ST-27 alert destinations). */
const activity = (scope: AlertScope): Target[] => [
  scope.kind === "platform"
    ? { key: qk.platformActivity() }
    : { key: qk.activity(scope.slug) },
];
const exact = (key: QueryKey): Target => ({ key, exact: true });

/** The API methods that write. Kept in step with `api.ts` by `test/mutations.test.ts`. */
export type WriteMethod =
  | "search"
  | "logout"
  | "patchPlatformSetting"
  | "revertPlatformSetting"
  | "mintApiToken"
  | "revokeApiToken"
  | "createAlertDestination"
  | "updateAlertDestination"
  | "deleteAlertDestination"
  | "testAlertDestination"
  | "revokePersonalToken"
  | "myPasskeyOptions"
  | "myPasskeyAdd"
  | "myMethodStrong"
  | "setMyPrefs"
  | "inviteMembers"
  | "inviteProductMembers"
  | "editProductMemberAreas"
  | "revokeProductMember"
  | "grantRole"
  | "editBindingAreas"
  | "revokeBinding"
  | "revokeMyPersonalToken"
  | "createPlatformConnection"
  | "updatePlatformConnection"
  | "deletePlatformConnection"
  | "discoverConnection"
  | "startConnectionTest"
  | "addConnectionDomain"
  | "verifyConnectionDomain"
  | "setConnectionDomainEnforce"
  | "removeConnectionDomain"
  | "createManualProduct"
  | "linkRepo"
  | "checkRepoCreate"
  | "updateProduct"
  | "deleteProduct"
  | "resyncProduct"
  | "revertClaim"
  | "checkRepoLink"
  | "planResync"
  | "linkProductRepo"
  | "updateReleaseChannel"
  | "revertReleaseChannel"
  | "setChannelFloor"
  | "fixCiReadiness"
  | "openSetupPullRequest"
  | "yankRelease"
  | "unyankRelease"
  | "updatePortalSettings"
  | "polarisKeyPreview"
  | "putProductSecret"
  | "putOutletCredential"
  | "deleteOutletCredential"
  | "rotateProductKey"
  | "activateProductKey"
  | "retireProductKey"
  | "revokeProductKey"
  | "putCiPublisher"
  | "putTrustPolicy"
  | "resetTrustPolicy"
  | "issueCiToken"
  | "revokeCiToken"
  | "updateServices"
  | "revertServices"
  | "servicesDryRun"
  | "saveUpdateSettings"
  | "revertUpdateSettings"
  | "saveDeliveryAccess"
  | "revertDeliveryAccess"
  | "rolloutAction"
  | "setRollout"
  | "refreshReadiness"
  | "overrideReadiness"
  | "clearReadinessOverride"
  | "narrowOutletCapabilities"
  | "revertOutletCapabilities"
  | "putDistributionKey"
  | "deleteDistributionKey"
  | "connectorControl"
  | "saveAutoHalt"
  | "decideCandidate"
  | "publishSchema"
  | "approveEdgeMintRecipe"
  | "revokeEdgeMintRecipe"
  | "createLicense"
  | "createLicenseBatch"
  | "patchLicense"
  | "setLicenseEnabled"
  | "deleteLicense"
  | "disableUnusedLicenses"
  | "deleteLicenses"
  | "putLicenseOverrides"
  | "mintKey"
  | "sendLicenseKey"
  | "sendLicenseInvite"
  | "revokeKey"
  | "deauthorizeDevice"
  | "resetDeviceFingerprint"
  | "deauthorizeProductDevice"
  | "deleteProductUserData"
  | "detachProductUserLicense"
  | "relinkProductUserLicense"
  | "makeLicenseFloating"
  | "reassignLicenseHolder"
  | "undoRelink"
  | "putProductUserOverrides"
  | "updateSignInSettings"
  | "resetProductDeviceFingerprint"
  | "mintBundle"
  | "updateFingerprintPolicy"
  | "revertFingerprintPolicy"
  | "updateProductSetting"
  | "revertProductSetting"
  | "createProfile"
  | "patchProfile"
  | "putProfilePayload"
  | "deleteProfile"
  | "createTier"
  | "patchTier"
  | "deleteTier"
  | "assignPlatformStoreApp"
  | "releasePlatformStoreApp"
  | "checkPlatformStoreCredential"
  | "putPlatformStoreCredential"
  | "checkCiSecret"
  | "saveFeedSettings"
  | "saveFeedPolicy"
  | "feedVersionAction"
  | "rebuildFeed"
  | "previewFeedPrune"
  | "saveFeedRetention"
  | "pruneFeeds"
  | "bootstrapPlatformFeeds"
  | "savePackageFeeds"
  | "commerceUseAssigned"
  | "mintRegistryToken"
  | "mintServiceToken"
  | "revokeRegistryToken"
  | "revokeAllRegistryTokens"
  | "acceptListingAsset"
  | "storefrontRequest"
  | "storefrontCheck"
  | "pushListing"
  | "putListing"
  | "putListingOverride"
  | "listingImport"
  | "putListingReleaseNotes"
  | "uploadHostedAsset"
  | "deleteHostedAsset"
  | "saveAssetSetting"
  | "resetAssetSetting";

export interface MutationSpec<A extends unknown[]> {
  /** What the write does, for the table's readers (and the test's failure messages). */
  label: string;
  /** The queries the write makes stale. `[]` is a decision, and `why` must say so. */
  invalidates: (...args: A) => Target[];
  /** Required when `invalidates` returns nothing. */
  why?: string;
}

export type MutationTable = {
  [K in WriteMethod]: MutationSpec<Parameters<AdminApi[K]>>;
};

/** §5.4 "channel policy (promote/pin/…/floor), yank, unyank". */
/**
 * What needs the operator (`GET /attention`, Home): every write that can open or close an item
 * (a secret, a recipe's approval, a resync, a credential) refreshes it.
 */
const attention = (): Target => exact(qk.attention());
/** Every product's Cloud Sync usage read: it carries the platform pause (who, when, why). */
const syncUsageEvery = (): Target => ({
  key: ["product"],
  match: (k) => k[2] === "sync" && k[3] === "usage",
});

const releasePolicy = (slug: string): Target[] => [
  attention(),
  prefix(qk.releases(slug)),
  prefix(qk.channels(slug)),
  prefix(qk.releaseHealth(slug)),
  prefix(qk.deliverables(slug)),
  prefix(qk.compat(slug)),
  prefix(qk.packReleases(slug)),
  prefix(qk.matrix(slug)),
];

/** §5.4 "rollout start / set / verb". */
const rollout = (slug: string): Target[] => [
  prefix(qk.matrix(slug)),
  prefix(qk.rollouts(slug)),
  prefix(qk.health(slug)),
  prefix(qk.compat(slug)),
];

/** §5.4 "readiness refresh / override / clear". */
const readiness = (slug: string): Target[] => [
  prefix(qk.readiness(slug)),
  prefix(qk.matrix(slug)),
  prefix(qk.compat(slug)),
];

/** §5.4 "license create / patch / enable / disable / overrides". */
const license = (slug: string): Target[] => [
  prefix(qk.licenses(slug)),
  prefix(qk.devicesSummary(slug)),
  // LX-30: a batch counts its licences' states (unused, disabled), and a deletion its rows.
  prefix(qk.licenseBatches(slug)),
  attention(),
];

/**
 * §5.4 "device deauthorize / reset". The license list shows per-license device counts, so it is
 * stale too; a product-level action does not know the device's license, so every license record.
 */
const device = (slug: string, licenseId?: string): Target[] =>
  licenseId === undefined
    ? [prefix(qk.devices(slug)), prefix(qk.licenses(slug))]
    : [
        prefix(qk.devices(slug)),
        exact(qk.licenses(slug)),
        prefix(qk.licensesPages(slug)),
        prefix(qk.license(slug, licenseId)),
      ];

/**
 * I-12: a Users write. A detach, relink or undo moves a licence's owner (the license list and
 * record show the holder) and can clear a device's signed-in binding; a data deletion changes the
 * row's data size. Every user row, since a relink touches two subjects.
 */
const users = (slug: string): Target[] => [
  attention(),
  prefix(qk.users(slug)),
  prefix(qk.licenses(slug)),
  prefix(qk.devices(slug)),
  prefix(qk.activity(slug)),
];

/** §5.4 "key mint / revoke": the record, and the list's key counts. */
const licenseKey = (slug: string, id: string): Target[] => [
  exact(qk.licenses(slug)),
  prefix(qk.license(slug, id)),
];

/**
 * F-11: a Feeds write. The scope's whole Feeds area, the platform's (it lists every owner's
 * packages) and the owning product's (the same feed seen from its product scope).
 */
const feeds = (scope: FeedScope, owner?: string): Target[] => {
  const targets = [prefix(qk.pkgFeeds({ kind: "platform" }))];
  if (scope.kind === "product") targets.push(prefix(qk.pkgFeeds(scope)));
  const ownerSlug =
    owner ?? (scope.kind === "platform" ? SYSTEM_PRODUCT_SLUG : undefined);
  if (ownerSlug && !(scope.kind === "product" && scope.slug === ownerSlug))
    targets.push(prefix(qk.pkgFeeds({ kind: "product", slug: ownerSlug })));
  return targets;
};

/**
 * HA-06: a hosted-asset write (an upload, Revert, delete-a-copy). The slots themselves; the
 * registry row and the product detail, which carry `presentation.icon` for the product card and
 * the Products table (worker `console/lib/presentation.ts`); Home's summary; the activity trail;
 * and, because a store slot (A-18) is also written into the listing model, the slot board and
 * the listing.
 */
const hostedAssets = (slug: string): Target[] => [
  prefix(qk.hostedAssets(slug)),
  exact(qk.products()),
  exact(qk.product(slug)),
  attention(),
  prefix(qk.activity(slug)),
  prefix(qk.storefronts(slug)),
  prefix(qk.listing(slug)),
];

export const MUTATIONS: MutationTable = {
  search: {
    label: "palette search",
    invalidates: () => [],
    why: "A read sent as POST so a pasted key stays out of the URL; it writes nothing.",
  },
  logout: {
    label: "sign out",
    invalidates: () => [],
    why: "The page leaves for the sign-in screen; nothing cached is shown again.",
  },
  patchPlatformSetting: {
    label: "platform setting set",
    // The settings list (effective value, source, version) and the platform trail, which the
    // write appends to (Settings → History, Deployment → Platform activity).
    invalidates: () => [
      exact(qk.platformSettings()),
      // The reserved-names report carries the severity the settings row sets (LX-05).
      exact(qk.platformReservedNames()),
      prefix(qk.platformActivity()),
      // Home's Needs attention lists the Cloud Sync pause (U-05.21): it must clear on Resume.
      attention(),
      syncUsageEvery(),
    ],
  },
  mintApiToken: {
    label: "admin API token mint",
    // The roster, and the platform trail (a platform write may leave a row there).
    invalidates: () => [prefix(qk.apiTokens()), prefix(qk.platformActivity())],
  },
  revokeApiToken: {
    label: "admin API token revoke",
    invalidates: () => [prefix(qk.apiTokens()), prefix(qk.platformActivity())],
  },
  createAlertDestination: {
    label: "alert destination add",
    invalidates: (scope) => [
      prefix(qk.alertDestinations(scope)),
      ...activity(scope),
    ],
  },
  updateAlertDestination: {
    label: "alert destination change",
    invalidates: (scope) => [
      prefix(qk.alertDestinations(scope)),
      ...activity(scope),
    ],
  },
  deleteAlertDestination: {
    label: "alert destination remove",
    invalidates: (scope) => [
      prefix(qk.alertDestinations(scope)),
      ...activity(scope),
    ],
  },
  testAlertDestination: {
    label: "alert destination test",
    // The outcome is recorded on the destination, and the test is audited.
    invalidates: (scope) => [
      prefix(qk.alertDestinations(scope)),
      ...activity(scope),
    ],
  },
  createPlatformConnection: {
    label: "connection add",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  updatePlatformConnection: {
    label: "connection change",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  deletePlatformConnection: {
    label: "connection delete",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  // Dry checks: nothing is written, so nothing goes stale.
  discoverConnection: {
    label: "connection discovery",
    invalidates: () => [],
    why: "A dry check: it reads the provider and writes nothing.",
  },
  startConnectionTest: {
    label: "connection test",
    invalidates: () => [],
    why: "It starts a sign-in at the provider; nothing is saved.",
  },
  addConnectionDomain: {
    label: "connection domain claim",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  verifyConnectionDomain: {
    label: "connection domain check",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  setConnectionDomainEnforce: {
    label: "connection domain enforce",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  removeConnectionDomain: {
    label: "connection domain release",
    invalidates: () => [
      prefix(qk.platformConnections()),
      prefix(qk.platformActivity()),
    ],
  },
  // ST-31.11: a role change moves the roster and the platform trail (`rbac.*` rows).
  inviteMembers: {
    label: "member invite",
    invalidates: () => [prefix(qk.members()), prefix(qk.platformActivity())],
  },
  grantRole: {
    label: "role grant",
    invalidates: () => [prefix(qk.members()), prefix(qk.platformActivity())],
  },
  editBindingAreas: {
    label: "role areas edit",
    invalidates: () => [prefix(qk.members()), prefix(qk.platformActivity())],
  },
  revokeBinding: {
    label: "role revoke",
    invalidates: () => [prefix(qk.members()), prefix(qk.platformActivity())],
  },
  // ST-31.14: the product twins also move the platform roster and the access lists NoAccess reads.
  inviteProductMembers: {
    label: "product member invite",
    invalidates: (slug) => productMemberTargets(slug),
  },
  editProductMemberAreas: {
    label: "product role areas edit",
    invalidates: (slug) => productMemberTargets(slug),
  },
  revokeProductMember: {
    label: "product role revoke",
    invalidates: (slug) => productMemberTargets(slug),
  },
  revokePersonalToken: {
    label: "personal token revoke",
    invalidates: () => [
      prefix(qk.personalTokens()),
      prefix(qk.platformActivity()),
    ],
  },
  myPasskeyOptions: {
    label: "passkey challenge",
    invalidates: () => [],
    why: "a challenge changes nothing the page shows",
  },
  myPasskeyAdd: {
    label: "passkey add",
    invalidates: () => [prefix(qk.myMethods())],
  },
  setMyPrefs: {
    label: "console preference",
    invalidates: () => [exact(qk.me())],
  },
  myMethodStrong: {
    label: "passkey set for the console",
    invalidates: () => [prefix(qk.myMethods())],
  },
  revokeMyPersonalToken: {
    label: "own personal token revoke",
    // The roster lists the same token: refetch it too.
    invalidates: () => [
      prefix(qk.myPersonalTokens()),
      prefix(qk.personalTokens()),
    ],
  },
  revertPlatformSetting: {
    label: "platform setting revert",
    invalidates: () => [
      exact(qk.platformSettings()),
      // The reserved-names report carries the severity the settings row sets (LX-05).
      exact(qk.platformReservedNames()),
      prefix(qk.platformActivity()),
      // Home's Needs attention lists the Cloud Sync pause (U-05.21): it must clear on Resume.
      attention(),
      syncUsageEvery(),
    ],
  },
  createManualProduct: {
    label: "product create (manual)",
    invalidates: () => [exact(qk.me()), exact(qk.products()), attention()],
  },
  linkRepo: {
    label: "product create (link a repository)",
    invalidates: () => [exact(qk.me()), exact(qk.products()), attention()],
  },
  checkRepoCreate: {
    label: "product create check (dry run)",
    invalidates: () => [],
    why: "A dry run (POST link-repo?dryRun=1): it reads the repository and writes nothing.",
  },
  updateProduct: {
    label: "product update",
    // `me` too: the switcher reads product names from the session.
    invalidates: (slug) => [
      exact(qk.me()),
      exact(qk.products()),
      exact(qk.product(slug)),
    ],
  },
  deleteProduct: {
    label: "product delete",
    invalidates: () => [exact(qk.me()), exact(qk.products()), attention()],
  },
  resyncProduct: {
    label: "resync from repo",
    // A resync re-applies channels, catalog, services, tiers, profiles, update settings and
    // delivery access (outlets included): everything under the product, and its card's facts.
    invalidates: (slug) => [
      exact(qk.products()),
      prefix(qk.product(slug)),
      attention(),
    ],
  },
  planResync: {
    label: "resync plan (dry run)",
    invalidates: () => [],
    why: "A dry run: it reads the repository and writes nothing.",
  },
  revertClaim: {
    label: "revert a claimed setting to the manifest",
    // The product row carries the claims and the reverted value; the catalog revert publishes a
    // new active version, so everything under the product.
    invalidates: (slug) => [
      exact(qk.me()),
      exact(qk.products()),
      prefix(qk.product(slug)),
      attention(),
    ],
  },
  checkRepoLink: {
    label: "link repository check (dry run)",
    invalidates: () => [],
    why: "A dry run: it reads the repository and writes nothing.",
  },
  linkProductRepo: {
    label: "link repository",
    // Linking applies the manifest the way a resync does (everything under the product), and
    // the registry shows each product's source.
    invalidates: (slug) => [
      exact(qk.me()),
      exact(qk.products()),
      prefix(qk.product(slug)),
      attention(),
    ],
  },
  updateReleaseChannel: {
    label: "channel policy (promote, pin, unpin, minimum, critical)",
    invalidates: (slug) => releasePolicy(slug),
  },
  revertReleaseChannel: {
    label: "channel policy revert to manifest",
    invalidates: (slug) => releasePolicy(slug),
  },
  setChannelFloor: {
    label: "channel rollback floor",
    invalidates: (slug) => releasePolicy(slug),
  },
  fixCiReadiness: {
    label: "CI readiness fix (release environment, tag ruleset)",
    invalidates: (slug) => [prefix(qk.ciReadiness(slug))],
  },
  openSetupPullRequest: {
    label: "setup pull request",
    invalidates: (slug) => [
      prefix(qk.ciReadiness(slug)),
      prefix(qk.setupPullRequest(slug)),
    ],
  },
  yankRelease: {
    label: "yank release",
    invalidates: (slug) => releasePolicy(slug),
  },
  unyankRelease: {
    label: "unyank release",
    invalidates: (slug) => releasePolicy(slug),
  },
  updatePortalSettings: {
    label: "Locker settings",
    // PS-06: the listing state is in this row, so the Polaris Key panel (its paths, readiness
    // and the storefront tile) reads it too.
    invalidates: (slug) => [
      prefix(qk.portal(slug)),
      prefix(qk.polarisKey(slug)),
    ],
  },
  polarisKeyPreview: {
    label: "Polaris Locker preview",
    invalidates: () => [],
    why: "A dry run for a persona: the Worker evaluates it in memory and writes nothing.",
  },
  updateSignInSettings: {
    label: "sign-in settings",
    // `claimByKey` is the same column the Portal page edits.
    invalidates: (slug) => [
      prefix(qk.signInSettings(slug)),
      prefix(qk.portal(slug)),
    ],
  },
  deleteProductUserData: {
    label: "user data delete",
    invalidates: (slug) => users(slug),
  },
  detachProductUserLicense: {
    label: "user license detach",
    invalidates: (slug) => users(slug),
  },
  relinkProductUserLicense: {
    label: "user license relink",
    invalidates: (slug) => users(slug),
  },
  // LX-30: Make floating and Reassign are I-12's tool keyed by the licence; the same rows move.
  makeLicenseFloating: {
    label: "license make floating",
    invalidates: (slug) => users(slug),
  },
  reassignLicenseHolder: {
    label: "license reassign",
    invalidates: (slug) => users(slug),
  },
  undoRelink: {
    label: "user license relink undo",
    invalidates: (slug) => users(slug),
  },
  putProductUserOverrides: {
    label: "user account overrides",
    // The record (the overrides read sits under it), the trail the write appends to, and which
    // accounts set each catalog key (the key drawer's "Overridden by").
    invalidates: (slug, subject) => [
      prefix(qk.user(slug, subject)),
      prefix(qk.activity(slug)),
      prefix(qk.catalog(slug)),
    ],
  },
  putProductSecret: {
    label: "secret set",
    // An edge-mint recipe's status depends on whether its signing secret is set.
    invalidates: (slug) => [
      exact(qk.product(slug)),
      attention(),
      prefix(qk.secrets(slug)),
      prefix(qk.mint(slug)),
    ],
  },
  putOutletCredential: {
    label: "outlet credential put",
    invalidates: (slug) => [
      prefix(qk.credentials(slug)),
      prefix(qk.health(slug)),
    ],
  },
  deleteOutletCredential: {
    label: "outlet credential delete",
    invalidates: (slug) => [
      prefix(qk.credentials(slug)),
      prefix(qk.health(slug)),
    ],
  },
  rotateProductKey: {
    label: "signing key prepare",
    invalidates: (slug) => [
      exact(qk.product(slug)),
      prefix(qk.keys(slug)),
      attention(),
    ],
  },
  activateProductKey: {
    label: "signing key activate",
    // The product row carries the active key (the Integration page's pins, the JWKS link).
    invalidates: (slug) => [
      exact(qk.product(slug)),
      prefix(qk.keys(slug)),
      attention(),
    ],
  },
  retireProductKey: {
    label: "signing key retire",
    invalidates: (slug) => [prefix(qk.keys(slug))],
  },
  revokeProductKey: {
    label: "signing key revoke",
    invalidates: (slug) => [prefix(qk.keys(slug))],
  },
  putTrustPolicy: {
    label: "device trust policy save",
    // The same setting is listed by the settings pages (one store, ST-05b).
    invalidates: (slug) => [
      prefix(qk.trustPolicy(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  resetTrustPolicy: {
    label: "device trust policy reset",
    invalidates: (slug) => [
      prefix(qk.trustPolicy(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  putCiPublisher: {
    label: "trusted publisher claim",
    invalidates: (slug) => [prefix(qk.ciPublisher(slug))],
  },
  issueCiToken: {
    label: "CI token issue",
    invalidates: (slug) => [prefix(qk.ciTokens(slug))],
  },
  revokeCiToken: {
    label: "CI token revoke",
    invalidates: (slug) => [prefix(qk.ciTokens(slug))],
  },
  updateServices: {
    label: "services update",
    // Enablement changes which sections and queries exist at all: refresh the whole product, the
    // registry's service rows, and which facts the card shows.
    invalidates: (slug) => [
      exact(qk.products()),
      prefix(qk.product(slug)),
      attention(),
    ],
  },
  revertServices: {
    label: "services revert to manifest",
    invalidates: (slug) => [
      exact(qk.products()),
      prefix(qk.product(slug)),
      attention(),
    ],
  },
  servicesDryRun: {
    label: "services change dry run",
    invalidates: () => [],
    why: "A dry run (PATCH ?dryRun=1) only counts what the change would do; the Worker writes nothing.",
  },
  saveUpdateSettings: {
    label: "update feed settings save",
    invalidates: (slug) => [
      prefix(qk.feed(slug)),
      exact(qk.product(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  revertUpdateSettings: {
    label: "update feed settings revert",
    invalidates: (slug) => [
      prefix(qk.feed(slug)),
      exact(qk.product(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  saveDeliveryAccess: {
    label: "delivery access save",
    invalidates: (slug) => [
      prefix(qk.access(slug)),
      prefix(qk.deliverables(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  revertDeliveryAccess: {
    label: "delivery access revert",
    invalidates: (slug) => [
      prefix(qk.access(slug)),
      prefix(qk.deliverables(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  rolloutAction: {
    label: "rollout verb (pause, resume, halt, complete)",
    invalidates: (slug) => rollout(slug),
  },
  setRollout: {
    label: "rollout start or set percentage",
    invalidates: (slug) => rollout(slug),
  },
  refreshReadiness: {
    label: "readiness refresh",
    invalidates: (slug) => readiness(slug),
  },
  overrideReadiness: {
    label: "readiness override",
    invalidates: (slug) => readiness(slug),
  },
  clearReadinessOverride: {
    label: "readiness override clear",
    invalidates: (slug) => readiness(slug),
  },
  narrowOutletCapabilities: {
    label: "outlet capabilities narrow",
    invalidates: (slug) => [prefix(qk.outlets(slug))],
  },
  revertOutletCapabilities: {
    label: "outlet capabilities revert to the kind default",
    invalidates: (slug) => [prefix(qk.outlets(slug))],
  },
  putDistributionKey: {
    label: "distribution key add or update",
    invalidates: (slug) => [prefix(qk.distributionKeys(slug))],
  },
  deleteDistributionKey: {
    label: "distribution key remove or dismiss",
    invalidates: (slug) => [prefix(qk.distributionKeys(slug))],
  },
  connectorControl: {
    label: "store connector control",
    // A store control moves a store rollout (mirrored into the matrix and the rollouts) or the
    // connector's own settings (its vitals auto-halt reads into health).
    invalidates: (slug) => [prefix(qk.connectors(slug)), ...rollout(slug)],
  },
  saveAutoHalt: {
    label: "auto-halt settings",
    invalidates: (slug) => [prefix(qk.health(slug))],
  },
  decideCandidate: {
    label: "Sentry candidate confirm or dismiss",
    // Confirming halts the rollout.
    invalidates: (slug, _id, decision) =>
      decision === "confirm"
        ? [
            prefix(qk.health(slug)),
            prefix(qk.rollouts(slug)),
            prefix(qk.matrix(slug)),
          ]
        : [prefix(qk.health(slug))],
  },
  publishSchema: {
    label: "catalog publish",
    // Overrides re-validate against the new version, so every license record is stale too.
    invalidates: (slug) => [
      prefix(qk.catalog(slug)),
      prefix(qk.profiles(slug)),
      prefix(qk.licenses(slug)),
      exact(qk.products()),
    ],
  },
  approveEdgeMintRecipe: {
    label: "edge-mint approve",
    invalidates: (slug) => [
      prefix(qk.mint(slug)),
      exact(qk.product(slug)),
      attention(),
    ],
  },
  revokeEdgeMintRecipe: {
    label: "edge-mint revoke",
    invalidates: (slug) => [
      prefix(qk.mint(slug)),
      exact(qk.product(slug)),
      attention(),
    ],
  },
  createLicense: {
    label: "license create",
    invalidates: (slug) => license(slug),
  },
  // LX-28: the keys come back once; the batch row and every licence it made are new.
  createLicenseBatch: {
    label: "license batch create",
    invalidates: (slug) => license(slug),
  },
  patchLicense: {
    label: "license patch",
    invalidates: (slug) => license(slug),
  },
  setLicenseEnabled: {
    label: "license enable or disable",
    invalidates: (slug) => license(slug),
  },
  // A deletion removes the licence's devices and registry tokens too.
  deleteLicense: {
    label: "license delete",
    invalidates: (slug) => [...license(slug), prefix(qk.devices(slug))],
  },
  // LX-30: disables the batch's never-used licences.
  disableUnusedLicenses: {
    label: "license batch disable unused",
    invalidates: (slug) => license(slug),
  },
  deleteLicenses: {
    label: "license bulk delete",
    invalidates: (slug) => [...license(slug), prefix(qk.devices(slug))],
  },
  putLicenseOverrides: {
    label: "license overrides",
    invalidates: (slug) => license(slug),
  },
  mintKey: {
    label: "license key mint",
    invalidates: (slug, id) => licenseKey(slug, id),
  },
  // LX-27: mints a key and mails it; "Also revoke its other keys" changes the key list too.
  sendLicenseKey: {
    label: "license key send",
    invalidates: (slug, id) => licenseKey(slug, id),
  },
  // LX-27c.2: mails the invitation again; it mints nothing, so only the licence's own reads change.
  sendLicenseInvite: {
    label: "license invitation send",
    invalidates: (slug, id) => licenseKey(slug, id),
  },
  revokeKey: {
    label: "license key revoke",
    invalidates: (slug, id) => licenseKey(slug, id),
  },
  deauthorizeDevice: {
    label: "device deauthorize (license)",
    invalidates: (slug, id) => device(slug, id),
  },
  resetDeviceFingerprint: {
    label: "device fingerprint reset (license)",
    invalidates: (slug, id) => device(slug, id),
  },
  deauthorizeProductDevice: {
    label: "device deauthorize (product)",
    invalidates: (slug) => device(slug),
  },
  resetProductDeviceFingerprint: {
    label: "device fingerprint reset (product)",
    invalidates: (slug) => device(slug),
  },
  mintBundle: {
    label: "offline bundle mint",
    invalidates: () => [],
    why: "A bundle is a signed artifact handed to the operator; minting one changes no stored state the console reads.",
  },
  updateFingerprintPolicy: {
    label: "fingerprint policy update",
    invalidates: (slug) => [
      prefix(qk.fingerprintPolicy(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  revertFingerprintPolicy: {
    label: "fingerprint policy revert",
    invalidates: (slug) => [
      prefix(qk.fingerprintPolicy(slug)),
      prefix(qk.productSettingsAll(slug)),
    ],
  },
  updateProductSetting: {
    label: "product setting update",
    // Every area's settings (one store), and the activity log the audit row lands in.
    invalidates: (slug) => [
      prefix(qk.productSettingsAll(slug)),
      prefix(qk.activity(slug)),
    ],
  },
  revertProductSetting: {
    label: "product setting revert",
    invalidates: (slug) => [
      prefix(qk.productSettingsAll(slug)),
      prefix(qk.activity(slug)),
    ],
  },
  createProfile: {
    label: "profile create",
    invalidates: (slug) => [prefix(qk.profiles(slug))],
  },
  patchProfile: {
    label: "profile details",
    // Tier and license pages show profile names.
    invalidates: (slug) => [
      prefix(qk.profiles(slug)),
      prefix(qk.tiers(slug)),
      prefix(qk.licenses(slug)),
    ],
  },
  putProfilePayload: {
    label: "profile payload",
    // A license's resolved stack includes its profiles' payloads.
    invalidates: (slug) => [
      prefix(qk.profiles(slug)),
      prefix(qk.licenses(slug)),
    ],
  },
  deleteProfile: {
    label: "profile delete",
    invalidates: (slug) => [
      prefix(qk.profiles(slug)),
      prefix(qk.licenses(slug)),
      prefix(qk.tiers(slug)),
    ],
  },
  createTier: {
    label: "tier create",
    invalidates: (slug) => [prefix(qk.tiers(slug)), prefix(qk.licenses(slug))],
  },
  patchTier: {
    label: "tier patch",
    invalidates: (slug) => [prefix(qk.tiers(slug)), prefix(qk.licenses(slug))],
  },
  deleteTier: {
    label: "tier delete",
    invalidates: (slug) => [prefix(qk.tiers(slug)), prefix(qk.licenses(slug))],
  },
  assignPlatformStoreApp: {
    label: "store app assign",
    // The connection list (assignments, pin counts), every store's apps listing (who holds what),
    // and the product's outlet credentials and connector health (pins, credential source).
    invalidates: (_store, _appId, product) => [
      prefix(qk.platformStores()),
      prefix(qk.credentials(product)),
      prefix(qk.health(product)),
    ],
  },
  releasePlatformStoreApp: {
    label: "store app release",
    invalidates: (_store, _appId, heldBy) => [
      prefix(qk.platformStores()),
      prefix(qk.credentials(heldBy)),
      prefix(qk.health(heldBy)),
    ],
  },
  checkPlatformStoreCredential: {
    label: "store credential live check",
    invalidates: () => [],
    why: "A POST that stores nothing (UX-69): the unsaved value is tried against the store and the answer is shown in the form.",
  },
  putPlatformStoreCredential: {
    label: "store credential set",
    // The connection list (presence, source, metadata, health) and every store's apps listing,
    // which the Worker caches by the credential's version.
    invalidates: () => [prefix(qk.platformStores())],
  },
  checkCiSecret: {
    label: "CI secret live check",
    invalidates: () => [],
    why: "A POST that stores nothing (UX-69): the value is tried against the vendor and never kept.",
  },
  saveFeedSettings: {
    label: "feed settings save",
    invalidates: (scope) => feeds(scope),
  },
  saveFeedPolicy: {
    label: "platform feed policy save",
    // The kill switch and the ceiling decide every owner's feed status: every product's Feeds
    // view goes stale (only the visible ones refetch), and the platform trail gains a row.
    invalidates: () => [
      prefix(qk.pkgFeeds({ kind: "platform" })),
      prefix(qk.allProducts()),
      prefix(qk.platformActivity()),
    ],
  },
  feedVersionAction: {
    label: "package version yank / unyank / deprecate",
    // The version's state shows in the Feeds views and, as a yank, in the owner's release views.
    invalidates: (scope, _eco, owner) => [
      ...feeds(scope, owner),
      ...releasePolicy(owner),
    ],
  },
  rebuildFeed: {
    label: "feed rebuild",
    // Nothing the console shows changes but the feed's activity trail.
    invalidates: (scope) => feeds(scope),
  },
  previewFeedPrune: {
    label: "feed cleanup dry run",
    invalidates: () => [],
    why: "A POST that stores nothing (apply: false): the plan is read like a query and shown in the dry-run dialog.",
  },
  saveFeedRetention: {
    label: "feed cleanup setting save",
    // The notice and the plan's wording follow the setting; the activity trail gains a row.
    invalidates: (scope) => feeds(scope),
  },
  pruneFeeds: {
    label: "feed cleanup apply",
    // The versions go: the feeds' counts and package lists, the plan and the notice change.
    invalidates: (scope) => feeds(scope),
  },
  bootstrapPlatformFeeds: {
    label: "platform feeds bootstrap",
    // It creates (or re-asserts) the system product, which the session's product list carries.
    invalidates: () => [
      prefix(qk.pkgFeeds({ kind: "platform" })),
      exact(qk.me()),
      exact(qk.products()),
      prefix(qk.platformActivity()),
    ],
  },
  mintRegistryToken: {
    label: "registry token mint",
    // The scope's token lists (every licence filter) and the feed activity trails.
    invalidates: (scope) => feeds(scope),
  },
  mintServiceToken: {
    label: "service token mint",
    invalidates: (scope) => feeds(scope),
  },
  revokeRegistryToken: {
    label: "registry token revoke",
    invalidates: (scope) => feeds(scope),
  },
  revokeAllRegistryTokens: {
    label: "registry token revoke all",
    invalidates: (scope) => feeds(scope),
  },
  acceptListingAsset: {
    label: "listing asset accept",
    // The slot board, and the plans whose image steps count accepted assets.
    invalidates: (slug) => [prefix(qk.storefronts(slug))],
  },
  storefrontRequest: {
    label: "storefront flow step",
    // A step reaches a store through a reviewed route: A-17b's bundle ids and A-16's assignment
    // (the store connections and the product's credentials), A-17c's setup controls (the
    // connectors), or the flow's own runtimes (the plans). Every one of those may move.
    invalidates: (slug) => [
      prefix(qk.storefronts(slug)),
      prefix(qk.connectors(slug)),
      prefix(qk.credentials(slug)),
      prefix(qk.platformStores()),
      attention(),
    ],
  },
  storefrontCheck: {
    label: "storefront deep-linked step check or assert",
    invalidates: (slug) => [prefix(qk.storefronts(slug))],
  },
  pushListing: {
    label: "storefront listing push",
    invalidates: (slug) => [prefix(qk.storefronts(slug))],
  },
  putListing: {
    label: "listing model save",
    invalidates: (slug) => listingWrite(slug),
  },
  putListingOverride: {
    label: "listing per-store override",
    invalidates: (slug) => listingWrite(slug),
  },
  listingImport: {
    label: "listing import (diff, or apply with the digest)",
    // A diff writes nothing, but one method serves both: an apply moves the model.
    invalidates: (slug) => listingWrite(slug),
  },
  putListingReleaseNotes: {
    label: "listing release notes save",
    invalidates: (slug) => listingWrite(slug),
  },
  uploadHostedAsset: {
    label: "hosted asset upload",
    invalidates: (slug) => hostedAssets(slug),
  },
  deleteHostedAsset: {
    label: "hosted asset revert or delete",
    invalidates: (slug) => hostedAssets(slug),
  },
  saveAssetSetting: {
    label: "hosted asset setting save",
    // The usage read (under the slots' prefix) carries the settings; the trail records the write.
    invalidates: (slug) => [
      prefix(qk.hostedAssets(slug)),
      prefix(qk.activity(slug)),
    ],
  },
  resetAssetSetting: {
    label: "hosted asset setting reset",
    invalidates: (slug) => [
      prefix(qk.hostedAssets(slug)),
      prefix(qk.activity(slug)),
    ],
  },
  commerceUseAssigned: {
    label: "store app",
    // The typed identity is gone: the view, Home's items and the trail change.
    invalidates: (slug) => [
      prefix(qk.commerceView(slug)),
      prefix(qk.activity(slug)),
      attention(),
    ],
  },
  savePackageFeeds: {
    label: "package feeds switch",
    // The product row carries the switch the sidebar gates Package feeds on.
    invalidates: (slug) => [
      exact(qk.product(slug)),
      exact(qk.products()),
      exact(qk.packageFeedsSwitch(slug)),
      ...feeds({ kind: "product", slug }),
    ],
  },
};

/** A-18j: a listing write moves the model, its fit report and every store's plan. */
const listingWrite = (slug: string): Target[] => [
  prefix(qk.listing(slug)),
  prefix(qk.storefronts(slug)),
];

const writes = createWrites<AdminApi, WriteMethod>({
  table: MUTATIONS,
  api,
  onError(error, _clients, method, args) {
    refreshMeOnNoAccess(error);
    // The page showed a state the server no longer has: refetch it.
    if (
      method === "commerceUseAssigned" &&
      error instanceof HttpError &&
      error.reason === "no_assigned_app"
    )
      void writes.invalidateAfter(method, args);
  },
});

export const { invalidationFor, mutate, mutateEach } = writes;

/**
 * The query clients a confirmed write invalidates in: each mounted console tree's own
 * (`ConsoleQueryProvider` binds it on mount and unbinds it on unmount). Nothing here holds a cache.
 */
const boundClients = new Set<QueryClient>();

/** Bind `client` to the write path; returns the unbind. */
export function bindWriteInvalidation(client: QueryClient): () => void {
  boundClients.add(client);
  const unbind = writes.bindWriteInvalidation(client);
  return () => {
    boundClients.delete(client);
    unbind();
  };
}

/**
 * A refusal with `reason: "no_access"` means the member's role no longer includes the area (their
 * role changed under an open tab): refetch who they are, so the shell shows the NoAccess state
 * rather than a page that fails (ST-29, B-212). Anything else is left alone.
 */
export function refreshMeOnNoAccess(error: unknown): void {
  if (
    !(error instanceof HttpError) ||
    error.status !== 403 ||
    error.reason !== "no_access"
  )
    return;
  for (const client of boundClients)
    void client.invalidateQueries({ queryKey: qk.me(), exact: true });
}

/** Invalidate a write's declared queries. Active queries refetch; inactive ones go stale. */
export function invalidateAfter(method: WriteMethod, args: unknown[]): void {
  void writes.invalidateAfter(method, args);
}

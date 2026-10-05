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

import type { QueryKey } from "@tanstack/react-query";
import { api, type AdminApi, type FeedScope } from "../../api.js";
import { SYSTEM_PRODUCT_SLUG } from "../areas/feeds/model.js";
import { qk } from "./queries.js";
import { queryClient } from "./queryClient.js";

/** One invalidation target: a key prefix, or one exact key. */
export interface Target {
  key: QueryKey;
  exact?: boolean;
}

const prefix = (key: QueryKey): Target => ({ key });
const exact = (key: QueryKey): Target => ({ key, exact: true });

/** The API methods that write. Kept in step with `api.ts` by `test/mutations.test.ts`. */
export type WriteMethod =
  | "logout"
  | "patchPlatformSetting"
  | "revertPlatformSetting"
  | "createManualProduct"
  | "linkRepo"
  | "updateProduct"
  | "deleteProduct"
  | "resyncProduct"
  | "updateReleaseChannel"
  | "revertReleaseChannel"
  | "setChannelFloor"
  | "yankRelease"
  | "unyankRelease"
  | "updatePortalSettings"
  | "putProductSecret"
  | "putOutletCredential"
  | "deleteOutletCredential"
  | "rotateProductKey"
  | "activateProductKey"
  | "retireProductKey"
  | "revokeProductKey"
  | "putCiPublisher"
  | "issueCiToken"
  | "revokeCiToken"
  | "updateServices"
  | "revertServices"
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
  | "patchLicense"
  | "setLicenseEnabled"
  | "putLicenseOverrides"
  | "mintKey"
  | "revokeKey"
  | "deauthorizeDevice"
  | "resetDeviceFingerprint"
  | "deauthorizeProductDevice"
  | "resetProductDeviceFingerprint"
  | "mintBundle"
  | "updateFingerprintPolicy"
  | "revertFingerprintPolicy"
  | "createProfile"
  | "patchProfile"
  | "putProfilePayload"
  | "deleteProfile"
  | "createTier"
  | "patchTier"
  | "deleteTier"
  | "assignPlatformStoreApp"
  | "releasePlatformStoreApp"
  | "saveFeedSettings"
  | "saveFeedPolicy"
  | "feedVersionAction"
  | "rebuildFeed"
  | "bootstrapPlatformFeeds"
  | "savePackageFeeds"
  | "mintRegistryToken"
  | "revokeRegistryToken"
  | "revokeAllRegistryTokens"
  | "acceptListingAsset"
  | "storefrontRequest"
  | "storefrontCheck"
  | "pushListing"
  | "putListing"
  | "putListingOverride"
  | "listingImport"
  | "putListingReleaseNotes";

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
const releasePolicy = (slug: string): Target[] => [
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
        prefix(qk.license(slug, licenseId)),
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

export const MUTATIONS: MutationTable = {
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
      prefix(qk.platformActivity()),
    ],
  },
  revertPlatformSetting: {
    label: "platform setting revert",
    invalidates: () => [
      exact(qk.platformSettings()),
      prefix(qk.platformActivity()),
    ],
  },
  createManualProduct: {
    label: "product create (manual)",
    invalidates: () => [exact(qk.me()), exact(qk.products())],
  },
  linkRepo: {
    label: "product create (link a repository)",
    invalidates: () => [exact(qk.me()), exact(qk.products())],
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
    invalidates: () => [exact(qk.me()), exact(qk.products())],
  },
  resyncProduct: {
    label: "resync from repo",
    // A resync re-applies channels, catalog, services, tiers, profiles, update settings and
    // delivery access: everything under the product.
    invalidates: (slug) => [exact(qk.products()), prefix(qk.product(slug))],
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
  yankRelease: {
    label: "yank release",
    invalidates: (slug) => releasePolicy(slug),
  },
  unyankRelease: {
    label: "unyank release",
    invalidates: (slug) => releasePolicy(slug),
  },
  updatePortalSettings: {
    label: "portal settings",
    invalidates: (slug) => [prefix(qk.portal(slug))],
  },
  putProductSecret: {
    label: "secret set",
    // An edge-mint recipe's status depends on whether its signing secret is set.
    invalidates: (slug) => [
      exact(qk.product(slug)),
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
    invalidates: (slug) => [exact(qk.product(slug)), prefix(qk.keys(slug))],
  },
  activateProductKey: {
    label: "signing key activate",
    // The product row carries the active key (Overview's Trust & SDK, the JWKS link).
    invalidates: (slug) => [exact(qk.product(slug)), prefix(qk.keys(slug))],
  },
  retireProductKey: {
    label: "signing key retire",
    invalidates: (slug) => [prefix(qk.keys(slug))],
  },
  revokeProductKey: {
    label: "signing key revoke",
    invalidates: (slug) => [prefix(qk.keys(slug))],
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
    // Enablement changes which sections and queries exist at all: refresh the whole product, and
    // the registry's service dots.
    invalidates: (slug) => [exact(qk.products()), prefix(qk.product(slug))],
  },
  revertServices: {
    label: "services revert to manifest",
    invalidates: (slug) => [exact(qk.products()), prefix(qk.product(slug))],
  },
  saveUpdateSettings: {
    label: "update feed settings save",
    invalidates: (slug) => [prefix(qk.feed(slug)), exact(qk.product(slug))],
  },
  revertUpdateSettings: {
    label: "update feed settings revert",
    invalidates: (slug) => [prefix(qk.feed(slug)), exact(qk.product(slug))],
  },
  saveDeliveryAccess: {
    label: "delivery access save",
    invalidates: (slug) => [
      prefix(qk.access(slug)),
      prefix(qk.deliverables(slug)),
    ],
  },
  revertDeliveryAccess: {
    label: "delivery access revert",
    invalidates: (slug) => [
      prefix(qk.access(slug)),
      prefix(qk.deliverables(slug)),
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
    invalidates: (slug) => [prefix(qk.mint(slug)), exact(qk.product(slug))],
  },
  revokeEdgeMintRecipe: {
    label: "edge-mint revoke",
    invalidates: (slug) => [prefix(qk.mint(slug)), exact(qk.product(slug))],
  },
  createLicense: {
    label: "license create",
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
  putLicenseOverrides: {
    label: "license overrides",
    invalidates: (slug) => license(slug),
  },
  mintKey: {
    label: "license key mint",
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
    invalidates: (slug) => [prefix(qk.fingerprintPolicy(slug))],
  },
  revertFingerprintPolicy: {
    label: "fingerprint policy revert",
    invalidates: (slug) => [prefix(qk.fingerprintPolicy(slug))],
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

/** The targets a write invalidates, or `null` when `method` is not a write (a read). */
export function invalidationFor(
  method: string,
  args: unknown[],
): Target[] | null {
  const spec = (MUTATIONS as Record<string, MutationSpec<unknown[]>>)[method];
  return spec ? spec.invalidates(...args) : null;
}

/** Invalidate a write's declared queries. Active queries refetch; inactive ones go stale. */
export function invalidateAfter(method: WriteMethod, args: unknown[]): void {
  for (const t of invalidationFor(method, args) ?? []) {
    void queryClient.invalidateQueries({ queryKey: t.key, exact: t.exact });
  }
}

/**
 * Make a write and, once the server confirms it, invalidate what it declared (§5.3: confirmed,
 * never optimistic). A failed write invalidates nothing; the caller gets the error as before.
 */
export async function mutate<K extends WriteMethod>(
  method: K,
  ...args: Parameters<AdminApi[K]>
): Promise<Awaited<ReturnType<AdminApi[K]>>> {
  const fn = api[method] as (...a: unknown[]) => ReturnType<AdminApi[K]>;
  const result = await fn(...args);
  invalidateAfter(method, args);
  return result;
}

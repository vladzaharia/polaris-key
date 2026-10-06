/**
 * THE APPLE ADAPTER: the first `StorefrontAdapter` (A-18a; notes/S-15 §6.1, §11). It declares
 * A-17's operations against the rule table A-17a built (`../rules/appStore.ts`, moved unchanged):
 *
 *   - Worker plane, behind the gate: bundle ids, pricing and availability defaults, TestFlight,
 *     versions, release notes, submission, release and phased release, non-consumable IAPs, the
 *     notification URL and P5-02's webhook;
 *   - the listing (A-18m, S-15 owner decision 1): text into the version and app info
 *     localizations, screenshots into a version localization's sets, from the shared listing
 *     model and the blob store (`connectors/asc/listingPush.ts`);
 *   - deep links for what Apple's API cannot do (create the app record, App Information, the age
 *     rating, App Privacy);
 *   - no build upload: binaries are uploaded by the release workflow's vendor CLI step, never by
 *     the Worker (README decision 7 as amended by S-15 decision 2).
 *
 * Every allow rule of the table is named by at least one operation, and every write operation
 * names only rules the table has: `test/storefront/conformance.test.ts` checks both ways.
 */

import type { Support } from "../../adapters/contract.js";
import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import { APP_STORE_COMPILED_GATE, ASC_SPEC_PIN } from "../rules/appStore.js";
import { ASC_WRITE_DENIED } from "../rules/appStoreDenied.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";

const api = (...rules: string[]): Support => ({
  mode: "api",
  plane: "worker",
  rules,
});
const link = (
  id: string,
  verify: Extract<
    Support,
    { mode: "deep-link" }
  >["verify"] = "operator-assertion",
): Support => ({
  mode: "deep-link",
  link: id,
  verify,
});

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: api(),
  listApps: api(),
  identifiers: api("POST /v1/bundleIds", "POST /v1/bundleIdCapabilities"),
  createApp: link("app-store.new-app", {
    read: "/v1/apps",
    every: 10,
    until: 900,
  }),
  readListing: api(),
  writeListingText: api(
    "POST /v1/appStoreVersionLocalizations",
    "PATCH /v1/appStoreVersionLocalizations/{id}",
    "POST /v1/appInfoLocalizations",
    "PATCH /v1/appInfoLocalizations/{id}",
  ),
  // Screenshots only (the icon ships in the build). Removing or reordering old screenshots stays
  // in App Store Connect: the push answers the `app-store.version` deep link for it.
  writeListingAssets: api(
    "POST /v1/appScreenshotSets",
    "POST /v1/appScreenshots",
    "PATCH /v1/appScreenshots/{id}",
  ),
  category: link("app-store.app-information"),
  contentRating: link("app-store.app-information"),
  privacyDeclarations: link("app-store.app-privacy"),
  pricing: api("POST /v2/appAvailabilities", "POST /v1/appPriceSchedules"),
  iap: api(
    "POST /v2/inAppPurchases",
    "POST /v1/inAppPurchaseVersions",
    "POST /v2/inAppPurchaseLocalizations",
    "PATCH /v2/inAppPurchaseLocalizations/{id}",
    "POST /v1/inAppPurchasePriceSchedules",
    "POST /v1/inAppPurchaseAvailabilities",
  ),
  testers: api(
    "POST /v1/betaGroups",
    "PATCH /v1/betaGroups/{id}",
    "POST /v1/betaTesters",
    "POST /v1/betaGroups/{id}/relationships/builds",
    "POST /v1/betaGroups/{id}/relationships/betaTesters",
    "POST /v1/betaBuildLocalizations",
    "PATCH /v1/betaBuildLocalizations/{id}",
    "POST /v1/betaAppReviewSubmissions",
  ),
  uploadBuild: {
    mode: "unsupported",
    reason:
      "builds reach App Store Connect from the release workflow's own vendor CLI step, never from the Worker (README decision 7)",
  },
  notificationsUrl: api(
    "PATCH /v1/apps/{id}",
    "POST /v1/webhooks",
    "POST /v1/webhookPings",
  ),
  submit: api(
    "POST /v1/appStoreVersions",
    "PATCH /v1/appStoreVersions/{id}",
    "PATCH /v1/appStoreVersions/{id}/relationships/build",
    "PATCH /v1/builds/{id}",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/{id}",
  ),
  release: api(
    "PATCH /v1/appStoreVersions/{id}",
    "POST /v1/appStoreVersionPhasedReleases",
    "PATCH /v1/appStoreVersionPhasedReleases/{id}",
    "POST /v1/appStoreVersionReleaseRequests",
  ),
  rollout: api("PATCH /v1/appStoreVersionPhasedReleases/{id}"),
  status: api(),
};

/**
 * Attributes kept per resource type in a ledger row's before and after (A-17a's `audit.ts`
 * projection, moved here unchanged: the projection is keyed by store and resource type).
 */
const PROJECTION: Readonly<Record<string, readonly string[]>> = {
  bundleIds: ["identifier", "name", "platform", "seedId"],
  bundleIdCapabilities: ["capabilityType"],
  apps: [
    "name",
    "bundleId",
    "sku",
    "primaryLocale",
    "subscriptionStatusUrl",
    "subscriptionStatusUrlVersion",
    "subscriptionStatusUrlForSandbox",
    "subscriptionStatusUrlVersionForSandbox",
  ],
  appAvailabilities: ["availableInNewTerritories"],
  appPriceSchedules: [],
  betaGroups: [
    "name",
    "isInternalGroup",
    "hasAccessToAllBuilds",
    "publicLinkEnabled",
    "publicLinkLimitEnabled",
    "publicLinkLimit",
    "publicLink",
    "feedbackEnabled",
  ],
  betaTesters: ["inviteType", "state"],
  builds: [
    "version",
    "processingState",
    "usesNonExemptEncryption",
    "expired",
    "uploadedDate",
  ],
  betaBuildLocalizations: ["locale"],
  betaAppReviewSubmissions: ["betaReviewState", "submittedDate"],
  appStoreVersions: [
    "platform",
    "versionString",
    "appVersionState",
    "appStoreState",
    "releaseType",
    "earliestReleaseDate",
    "reviewType",
  ],
  appStoreVersionLocalizations: ["locale"],
  // A-18m: the listing's localizations and screenshots (no listing text: it is the model's).
  appInfoLocalizations: ["locale"],
  appScreenshotSets: ["screenshotDisplayType"],
  appScreenshots: ["fileName", "fileSize", "sourceFileChecksum"],
  appStoreVersionPhasedReleases: [
    "phasedReleaseState",
    "currentDayNumber",
    "startDate",
    "totalPauseDuration",
  ],
  appStoreVersionReleaseRequests: [],
  reviewSubmissions: ["platform", "state", "submittedDate"],
  reviewSubmissionItems: ["state"],
  inAppPurchases: [
    "name",
    "productId",
    "inAppPurchaseType",
    "state",
    "familySharable",
  ],
  inAppPurchaseVersions: ["state"],
  inAppPurchaseLocalizations: ["locale", "name", "state"],
  // A-17e: the schedule is projected from its reads (base territory, today's base price).
  inAppPurchasePriceSchedules: [
    "baseTerritory",
    "customerPrice",
    "pricePointId",
  ],
  inAppPurchaseAvailabilities: ["availableInNewTerritories"],
  webhooks: ["name", "enabled", "eventTypes", "url"],
  webhookPings: [],
};

const DENIED = Object.values(ASC_WRITE_DENIED).flat();

export const APP_STORE_ADAPTER: StorefrontAdapter = {
  id: "app-store",
  label: "App Store Connect",
  outletKinds: ["app-store", "testflight"],
  credential: "app-store.api-key",
  specPin: ASC_SPEC_PIN,
  gate: APP_STORE_COMPILED_GATE,
  capabilities: {
    ops: OPS,
    // Apple meters per key over a rolling hour and reports it in `X-Rate-Limit` (A-17h: 3,600).
    rate: { kind: "header", limit: 3600 },
    limits: {
      // One open review submission per platform at Apple.
      openReviewSubmissionsPerPlatform: 1,
    },
  },
  never: {
    delete: DENIED.filter((k) => k.startsWith("DELETE ")),
    users: [
      ...ASC_WRITE_DENIED.teamMembership,
      "* /v1/users",
      "* /v1/users/{id}",
      "* /v1/userInvitations",
      "* /v1/userInvitations/{id}",
    ],
    signingKeys: ASC_WRITE_DENIED.signingIdentity,
    // App Store Connect's API has no refund, payout or banking operation; prices are typed.
    payments: [],
    ciTokens: ["delete", "users", "invite", "certificates", "refund"],
  },
  ci: null,
  pr: null,
  // Apple's column of the shared listing model (A-18b; `../listingProfiles.ts`): the limits A-17d
  // and A-18m write to, the same numbers the fit report grades.
  listing: adapterListingProfile(STORE_LISTING_COLUMNS["app-store"]),
  confirmation: { phrase: "app-name", label: "App Store Connect" },
  audit: { action: "asc", projection: PROJECTION },
};

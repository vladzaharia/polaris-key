/**
 * THE MICROSOFT STORE ADAPTER (A-18f; notes/S-15 §4.2, §11). The second `StorefrontAdapter`, on
 * the Worker plane, against the rule table in `../rules/microsoftStore.ts`. Both submission APIs,
 * chosen by package type:
 *
 *   - CLASSIC (MSIX/APPX): submission create (a copy of the last published one), update, the
 *     listing images ZIP to the submission's SAS `fileUploadUrl`, commit, status with
 *     certification reports; package flights; gradual rollout update, halt and finalize; category;
 *     the price tier (`pricing.priceId`, not Pricing Version 2);
 *   - MSI/EXE (Godot's Windows export is an EXE): the `listings`, `properties` and `availability`
 *     metadata modules; the package BY URL (the release's own artifact, no upload) then
 *     `packages/commit`; `listings/assets/create` to SAS URLs then `commit`; `submit`.
 *
 * Deep links for what no API does: reserving the name, the first submission with the IARC
 * questionnaire, MSIX Properties, and a submission someone edited in Partner Center (which the API
 * can then neither change nor commit, only delete, and deleting is denied).
 *
 * Writes go through `MsStoreWriteClient` (`services/distribution/connectors/msstore/write.ts`);
 * P5-04's client stays GET-only for polling. Every allow rule is named by at least one operation
 * and every write operation names only rules the table has (`test/storefront/conformance.test.ts`).
 */

import type { Support } from "../../adapters/contract.js";
import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import {
  MICROSOFT_STORE_COMPILED_GATE,
  MSSTORE_SPEC_PIN,
  MSSTORE_WRITE_DENIED,
} from "../rules/microsoftStore.js";
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
): Support => ({ mode: "deep-link", link: id, verify });

const C = "/v1.0/my/applications/{id}";
const M = "/submission/v1/product/{id}";

const CLASSIC_UPDATE = `PUT ${C}/submissions/{id}`;
const MSI_METADATA = [`PUT ${M}/metadata`, `PATCH ${M}/metadata`];

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: api(),
  listApps: api(),
  identifiers: {
    mode: "unsupported",
    reason:
      "Microsoft has no identifier to register before the app: the reserved name is the app record (createApp)",
  },
  createApp: link("microsoft-store.new-app", {
    read: "/v1.0/my/applications",
    every: 10,
    until: 900,
  }),
  readListing: api(),
  writeListingText: api(CLASSIC_UPDATE, ...MSI_METADATA),
  writeListingAssets: api(
    CLASSIC_UPDATE,
    `POST ${M}/listings/assets/create`,
    `PUT ${M}/listings/assets/commit`,
  ),
  category: api(CLASSIC_UPDATE, ...MSI_METADATA),
  // IARC: answered once in Partner Center with the first submission (S-15 §4.2).
  contentRating: link("microsoft-store.age-ratings"),
  // MSI/EXE `properties` (privacy, website, support URLs). For an MSIX app the classic fields are
  // obsolete and ignored: the flow offers `microsoft-store.properties` instead.
  privacyDeclarations: api(...MSI_METADATA),
  pricing: api(CLASSIC_UPDATE, ...MSI_METADATA),
  iap: {
    mode: "unsupported",
    reason:
      "add-ons wait for a commerce extension: P6-01 has no Microsoft row, so the gate denies creating or submitting one",
  },
  testers: api(
    `POST ${C}/flights`,
    `POST ${C}/flights/{id}/submissions`,
    `PUT ${C}/flights/{id}/submissions/{id}`,
    `POST ${C}/flights/{id}/submissions/{id}/commit`,
    `POST ${C}/flights/{id}/submissions/{id}/updatepackagerolloutpercentage`,
    `POST ${C}/flights/{id}/submissions/{id}/haltpackagerollout`,
    `POST ${C}/flights/{id}/submissions/{id}/finalizepackagerollout`,
  ),
  uploadBuild: {
    mode: "unsupported",
    reason:
      "an MSIX is uploaded by the release workflow's msstore step (CI, decision 2; A-18h); an MSI/EXE is not uploaded at all, the submission points at the release's URL (submit)",
  },
  notificationsUrl: {
    mode: "unsupported",
    reason:
      "Partner Center has no notification callback for submissions; P5-04's connector polls their status",
  },
  submit: api(
    `POST ${C}/submissions`,
    CLASSIC_UPDATE,
    `POST ${C}/submissions/{id}/commit`,
    `PUT ${M}/packages`,
    `PATCH ${M}/packages/{id}`,
    `POST ${M}/packages/commit`,
    `POST ${M}/submit`,
  ),
  release: api(`POST ${C}/submissions/{id}/finalizepackagerollout`),
  rollout: api(
    `POST ${C}/submissions/{id}/updatepackagerolloutpercentage`,
    `POST ${C}/submissions/{id}/haltpackagerollout`,
  ),
  status: api(),
};

/**
 * Attributes kept per resource type on a ledger row (`audit.ts`). The write client maps
 * Microsoft's answers onto `{type, id, attributes}`: a submission's `fileUploadUrl` (a writable
 * SAS URI) and `statusDetails` (certification report URLs carry tokens) are dropped there, and no
 * list below names them either.
 */
const PROJECTION: Readonly<Record<string, readonly string[]>> = {
  applications: ["primaryName", "packageIdentityName", "firstPublishedDate"],
  submissions: [
    "status",
    "friendlyName",
    "applicationCategory",
    "visibility",
    "targetPublishMode",
    "priceId",
  ],
  flights: ["friendlyName", "rankHigherThan"],
  flightSubmissions: ["status", "targetPublishMode"],
  packageRollouts: [
    "isPackageRollout",
    "packageRolloutPercentage",
    "packageRolloutStatus",
  ],
  draftMetadata: ["category", "subcategory", "pricing", "discoverability"],
  draftPackages: ["packageType", "architectures"],
  listingAssets: ["language"],
  draftSubmissions: ["submissionId"],
};

export const MICROSOFT_STORE_ADAPTER: StorefrontAdapter = {
  id: "microsoft-store",
  label: "Microsoft Store",
  outletKinds: ["ms-store"],
  credential: "microsoft-store.partner-center",
  specPin: MSSTORE_SPEC_PIN,
  gate: MICROSOFT_STORE_COMPILED_GATE,
  capabilities: {
    ops: OPS,
    // The classic API documents no limit; the MSI/EXE API only a `Retry-After` "due to rate
    // limiting". The client honours it and otherwise self-throttles (S-15 §4.2). [U] A-18k.
    rate: { kind: "retry-after" },
    limits: {
      // One pendingApplicationSubmission per app; MSI/EXE `submit` fails over an active one.
      pendingSubmissionsPerApp: 1,
      trailersPerListing: 15,
      featuresPerListing: 20,
      keywordsPerListing: 7,
    },
  },
  never: {
    delete: MSSTORE_WRITE_DENIED.delete,
    // No Store API manages Partner Center users (UI only, S-15 §4.2): these paths are not on
    // either API, so the gate refuses them for every method (`invalid_path`).
    users: [
      "* /v1.0/my/users",
      "* /v1.0/my/users/{id}",
      "* /v1.0/my/groups",
      "* /v1.0/my/groups/{id}",
    ],
    signingKeys: [],
    // Payout and tax have no API (a Manager "can't change tax and payout settings"); price tiers
    // are typed. Listed so a future path is refused here first.
    payments: ["* /v1.0/my/payouts", "* /v1.0/my/tax"],
    ciTokens: ["delete", "users"],
  },
  ci: null,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS["ms-store"]),
  confirmation: { phrase: "app-name", label: "Partner Center" },
  audit: { action: "msstore", projection: PROJECTION },
};

/**
 * THE GOOGLE PLAY ADAPTER (A-18e; notes/S-15 §4.1, §11). It declares Play's operations against the
 * rule table `../rules/googlePlay.ts`, classified against the pinned androidpublisher v3 discovery
 * document:
 *
 *   - Worker plane, behind the gate and under the package's EDIT LEASE: app details and listings
 *     per language, listing images from the blob store (decision 2), closed-testing tracks and
 *     their Google Groups, release notes and releases on tracks, one-time products and their prices
 *     (from `dist_store_products`, store `play`), and the commit (typed when production is
 *     touched). The runtime is `services/distribution/connectors/play/storefront.ts`;
 *   - deep links for what Play's API cannot do: create the app and its first upload, the category,
 *     the content rating, target audience and the rest of App content (data safety stays in the
 *     Console, decision 4), the RTDN topic in Monetization setup, Play Integrity, managed
 *     publishing, email tester lists, and removing replaced images (decision 6);
 *   - no build upload: AABs reach Play from the release workflow in CI, never from the Worker
 *     (decision 2, README decision 7).
 *
 * Every allow rule is named by at least one operation, and every write operation names only rules
 * the table has: `test/storefront/conformance.test.ts` checks both ways.
 */

import type { Support } from "../../adapters/contract.js";
import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import {
  GOOGLE_PLAY_COMPILED_GATE,
  PLAY_SPEC_PIN,
} from "../rules/googlePlay.js";
import { PLAY_WRITE_DENIED } from "../rules/googlePlayDenied.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";

const A = "/androidpublisher/v3/applications/{packageName}";
const E = `${A}/edits/{editId}`;

/** The rule ids, by what they do (the `"<METHOD> <template>"` the gate's allow table spells). */
export const PLAY_RULES = {
  insert: `POST ${A}/edits`,
  validate: `POST ${E}:validate`,
  commit: `POST ${E}:commit`,
  details: `PATCH ${E}/details`,
  listingPatch: `PATCH ${E}/listings/{language}`,
  listingUpdate: `PUT ${E}/listings/{language}`,
  imageUpload: `POST ${E}/listings/{language}/{imageType}`,
  trackCreate: `POST ${E}/tracks`,
  trackPatch: `PATCH ${E}/tracks/{track}`,
  testers: `PATCH ${E}/testers/{track}`,
  oneTimeProduct: `PATCH ${A}/onetimeproducts/{productId}`,
  convertPrices: `POST ${A}/pricing:convertRegionPrices`,
} as const;

const R = PLAY_RULES;

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
  // Reporting's `apps:search` (A-16's lister, another origin): a read.
  listApps: api(),
  identifiers: {
    mode: "unsupported",
    reason:
      "Play has no identifier to register before the app: the package name is claimed by the app's first upload in the Play Console",
  },
  createApp: link("google-play.create-app", {
    read: `${E}/details`,
    every: 10,
    until: 900,
  }),
  // A read-only edit under the lease (opened, read, discarded).
  readListing: api(R.insert),
  writeListingText: api(
    R.insert,
    R.details,
    R.listingPatch,
    R.listingUpdate,
    R.validate,
    R.commit,
  ),
  writeListingAssets: api(R.insert, R.imageUpload, R.validate, R.commit),
  category: link("google-play.store-settings"),
  contentRating: link("google-play.content-rating"),
  privacyDeclarations: link("google-play.app-content"),
  pricing: api(R.convertPrices, R.oneTimeProduct),
  iap: api(R.oneTimeProduct),
  testers: api(R.insert, R.trackCreate, R.testers, R.validate, R.commit),
  uploadBuild: {
    mode: "unsupported",
    reason:
      "AABs reach Google Play from the release workflow in CI (edits.bundles.upload), never from the Worker (S-15 decision 2, README decision 7)",
  },
  notificationsUrl: link("google-play.monetization-setup"),
  submit: api(R.insert, R.validate, R.commit),
  release: api(R.insert, R.trackPatch, R.validate, R.commit),
  rollout: api(R.insert, R.trackPatch, R.commit),
  // `tracks.releases.list` (no edit needed): a read.
  status: api(),
};

/**
 * Steps the operator ticks before the flow promises anything (S-15 §4.1): Play states them but no
 * API reads them. Declared data, rendered by the console (A-18j).
 */
export const PLAY_PREFLIGHT = [
  {
    id: "personal-account-testers",
    text: "A new personal developer account must have 12 testers opted in to a closed test for 14 days before it can publish to production.",
    link: "google-play.testers",
  },
  {
    id: "billing-release",
    text: "One-time products need one release that carries the Play Billing Library before Play accepts them.",
    link: "google-play.monetization-setup",
  },
  {
    id: "managed-publishing",
    text: "With managed publishing on, approved changes wait in the Console until the operator publishes them there.",
    link: "google-play.managed-publishing",
  },
] as const;

/**
 * Attributes kept per resource type in a ledger row's before and after. Play's objects are mapped
 * onto `{type, id, attributes}` by the runtime. Tester groups are stored as a COUNT, never the
 * group addresses (S-15 §6.3), and no contact field is kept.
 */
const PROJECTION: Readonly<Record<string, readonly string[]>> = {
  details: ["defaultLanguage"],
  listings: ["language", "title"],
  images: ["imageType", "language", "sha1", "sha256", "aiGeneratedState"],
  tracks: ["track", "type", "formFactor", "releaseCount", "statuses"],
  testers: ["track", "googleGroupCount"],
  edits: ["committed", "changesNotSentForReview"],
  oneTimeProducts: [
    "productId",
    "listingCount",
    "purchaseOptionCount",
    "regionCount",
  ],
};

const DENIED = Object.values(PLAY_WRITE_DENIED).flat();
const DEV = "/androidpublisher/v3/developers/{developersId}";

export const GOOGLE_PLAY_ADAPTER: StorefrontAdapter = {
  id: "google-play",
  label: "Google Play",
  outletKinds: ["play", "play-testing"],
  credential: "google-play.service-account",
  specPin: PLAY_SPEC_PIN,
  gate: GOOGLE_PLAY_COMPILED_GATE,
  capabilities: {
    ops: OPS,
    // 3,000 queries per minute per bucket, no rate header: the Worker counts (S-15 §4.1).
    rate: { kind: "per-minute", limit: 3000 },
    limits: {
      imageMaxBytes: 15 * 1024 * 1024,
      // One open edit per service account; the edit lease serialises the Worker's callers.
      openEditsPerAccount: 1,
      closedTrackTesterGroups: 200,
    },
  },
  never: {
    delete: DENIED.filter((k) => k.startsWith("DELETE ")),
    users: [
      `* ${DEV}/users`,
      `* ${DEV}/users/{usersId}`,
      `* ${DEV}/users/{usersId}/grants`,
      `* ${DEV}/users/{usersId}/grants/{grantsId}`,
    ],
    signingKeys: PLAY_WRITE_DENIED.signingKeys,
    payments: PLAY_WRITE_DENIED.payments,
    ciTokens: ["delete", "users", "grants", "appsigning", "refund"],
  },
  ci: null,
  // Play's column of the shared listing model (A-18b; `../listingProfiles.ts`).
  listing: adapterListingProfile(STORE_LISTING_COLUMNS.play),
  confirmation: { phrase: "app-name", label: "Google Play" },
  audit: { action: "play", projection: PROJECTION },
};

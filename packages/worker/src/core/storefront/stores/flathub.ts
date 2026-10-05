/**
 * THE FLATHUB ADAPTER (A-18i; notes/S-15 §4.4): a PR-plane storefront. The FIRST submission is a
 * person's: `pkey storefront flathub init` writes the MetaInfo XML (name, summary, description,
 * screenshots, releases from the notes, the OARS rating from the content descriptors, the
 * developer id, branding with `tint` and `tintDark`), a desktop entry and a manifest skeleton
 * whose `extra-data` source carries `x-checker-data` pointing at Polaris Key's checker feed
 * (`/<p>/distribution/flathub/<channel>.json`), and a person opens and shepherds the PR to
 * `flathub/flathub` against `new-pr`. After that, "updates never need submission review": Flathub's
 * external-data checker opens update PRs from the feed, or `pkey storefront flathub pr` opens one
 * to `flathub/<appId>` with the new release's sources and MetaInfo. Never close the app or delete
 * its repository.
 *
 * The token is the maintainer's, with write access to `flathub/<appId>` (a GitHub account with
 * 2FA, invited to the app repository), a CI environment secret. There is no Worker plane.
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { FLATHUB_PR } from "../prPlane.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";
import { linkOp, unsupported } from "./ciShared.js";
import { PR_STEP_PROJECTION, prOp } from "./prShared.js";

const pr = prOp(FLATHUB_PR);
const NO_KEY =
  "Flathub's credential is the maintainer's GitHub token, held in CI and never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported(
    "the application id is the outlet's (flathub.appId); Flathub registers it with the first submission",
  ),
  createApp: linkOp("flathub.submission"),
  readListing: unsupported(
    "the MetaInfo is written from the listing model, never read back into it",
  ),
  writeListingText: pr,
  writeListingAssets: pr,
  category: unsupported(
    "Flathub reads categories from the desktop entry, which the first submission's person reviews",
  ),
  contentRating: pr,
  privacyDeclarations: unsupported(
    "Flathub asks for no privacy declaration; sandbox permissions are the manifest's finish-args, reviewed by a person",
  ),
  pricing: unsupported(
    "Flathub's payments are a donation link, set by a person",
  ),
  iap: unsupported("Flathub has no in-app purchases"),
  testers: unsupported(
    "Flathub's beta branch is a separate repository branch, set up by a person",
  ),
  uploadBuild: pr,
  notificationsUrl: unsupported("Flathub sends no notifications to a URL"),
  submit: linkOp("flathub.submission"),
  release: pr,
  rollout: unsupported("Flathub has no staged rollout"),
  status: pr,
};

export const FLATHUB_ADAPTER: StorefrontAdapter = {
  id: "flathub",
  label: "Flathub",
  outletKinds: ["flathub"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...FLATHUB_PR.neverTokens],
  },
  ci: null,
  pr: FLATHUB_PR,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS.flathub),
  confirmation: { phrase: "app-name", label: "Flathub" },
  audit: { action: "flathub", projection: PR_STEP_PROJECTION },
};

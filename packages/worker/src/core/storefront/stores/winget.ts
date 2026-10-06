/**
 * THE WINGET ADAPTER (A-18i; notes/S-15 §4.4): a PR-plane storefront. Each version is a
 * multi-file manifest (schema 1.12.0: version, installer, default and extra locale files) in a pull
 * request to `microsoft/winget-pkgs`, opened from a fork by `pkey storefront winget pr` with the
 * outlet's `packageIdentifier`; the installers are the release's HTTPS direct download URLs, and
 * the locale files come from the listing model's winget projection (A-18b). Every PR is validated
 * automatically and then reviewed by a moderator, so the console shows the PR and its review
 * labels (`Validation-*`, `Needs-Author-Feedback`), never a date. One PR per package version is
 * the natural key.
 *
 * The token is a CI environment secret (decision 7): a fine-grained one if A-18k shows it can open
 * the PR, else a classic `public_repo` token. There is no Worker plane.
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { WINGET_PR } from "../prPlane.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";
import { unsupported } from "./ciShared.js";
import { PR_STEP_PROJECTION, prOp } from "./prShared.js";

const pr = prOp(WINGET_PR);
const NO_KEY =
  "winget has no account: its only credential is a GitHub token, held in CI and never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported(
    "the package identifier is the outlet's; winget registers nothing before the first PR",
  ),
  createApp: unsupported(
    "winget needs no bootstrap: the first version's PR is moderated like every other",
  ),
  readListing: unsupported(
    "winget's manifests are written from the listing model, never read back into it",
  ),
  writeListingText: pr,
  writeListingAssets: unsupported(
    "winget shows no screenshots or art from a manifest",
  ),
  category: unsupported("winget has no categories, only tags"),
  contentRating: unsupported("winget has no content rating"),
  privacyDeclarations: unsupported(
    "winget asks for no privacy declaration beyond the PrivacyUrl the locale file carries",
  ),
  pricing: unsupported("winget sells nothing"),
  iap: unsupported("winget has no in-app purchases"),
  testers: unsupported("winget has no testers or tracks"),
  uploadBuild: pr,
  notificationsUrl: unsupported("winget sends no notifications to a URL"),
  submit: unsupported(
    "the PR is the submission: validation and moderator review start when it opens",
  ),
  release: pr,
  rollout: unsupported("winget has no staged rollout"),
  status: pr,
};

export const WINGET_ADAPTER: StorefrontAdapter = {
  id: "winget",
  label: "winget",
  outletKinds: ["winget"],
  credential: null,
  gate: null,
  // The GitHub token's own X-RateLimit-* headers are read CI-side; the Worker spends nothing.
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...WINGET_PR.neverTokens],
  },
  ci: null,
  pr: WINGET_PR,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS.winget),
  confirmation: { phrase: "app-name", label: "winget" },
  audit: { action: "winget", projection: PR_STEP_PROJECTION },
};

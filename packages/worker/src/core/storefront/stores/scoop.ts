/**
 * THE SCOOP BUCKET ADAPTER (A-18i; notes/S-15 §4.4): a PR-plane storefront over the product's OWN
 * bucket (`.pkey/distribution` `direct.scoopBucket`). The manifest is the one Polaris Key already
 * serves (`/<p>/distribution/scoop/<channel>.json`, P2b-05) with its `checkver` and `autoupdate`
 * pointing back at that feed, so the bucket's own Excavator keeps it current between releases;
 * `pkey storefront scoop pr` commits it as `bucket/<app>.json` in a pull request. An own bucket
 * has no review; the official ScoopInstaller buckets are refused by the bucket pattern.
 *
 * The token is the same kind as the tap's: fine-grained, the bucket only, a CI environment secret
 * (decision 7). There is no Worker plane, and the outlet is `direct`.
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { SCOOP_PR } from "../prPlane.js";
import { linkOp, unsupported } from "./ciShared.js";
import { PR_STEP_PROJECTION, prOp } from "./prShared.js";

const pr = prOp(SCOOP_PR);
const NO_KEY =
  "a bucket is a GitHub repository; its token is held in CI and never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported("a bucket registers nothing"),
  createApp: linkOp("scoop.new-bucket"),
  readListing: unsupported(
    "the manifest is the feed's, never read back into the listing model",
  ),
  writeListingText: pr,
  writeListingAssets: unsupported("a Scoop manifest carries no art"),
  category: unsupported("Scoop has no categories"),
  contentRating: unsupported("Scoop has no content rating"),
  privacyDeclarations: unsupported("Scoop asks for no privacy declaration"),
  pricing: unsupported("Scoop sells nothing"),
  iap: unsupported("Scoop has no in-app purchases"),
  testers: unsupported("a bucket has no testers or tracks"),
  uploadBuild: pr,
  notificationsUrl: unsupported("a bucket sends no notifications to a URL"),
  submit: unsupported("an own bucket has no review"),
  release: pr,
  rollout: unsupported("a bucket has no staged rollout"),
  status: pr,
};

export const SCOOP_ADAPTER: StorefrontAdapter = {
  id: "scoop",
  label: "Scoop bucket",
  outletKinds: ["direct"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...SCOOP_PR.neverTokens],
  },
  ci: null,
  pr: SCOOP_PR,
  listing: { fields: {}, images: {} },
  confirmation: { phrase: "app-name", label: "Scoop bucket" },
  audit: { action: "scoop", projection: PR_STEP_PROJECTION },
};

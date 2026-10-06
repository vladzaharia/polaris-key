/**
 * THE HOMEBREW TAP ADAPTER (A-18i; notes/S-15 §4.4): a PR-plane storefront over the product's OWN
 * tap (`.pkey/distribution` `direct.homebrewTap`, `<owner>/homebrew-<name>`). `pkey storefront
 * homebrew pr` writes `Casks/<homebrewCask>.rb` (version, sha256, url, name, desc, homepage, app,
 * livecheck, auto_updates) from the release's macOS builds and the listing model, as a pull request
 * to the tap. An own tap has no review. NEVER `homebrew/cask`: it has notability rules and needs
 * notarized apps, so a PR there is the owner's, by hand (the tap pattern refuses any Homebrew
 * organisation repository).
 *
 * The token is a fine-grained GitHub token with contents and pull-request write on the tap only,
 * a CI environment secret (decision 7). There is no Worker plane. The cask's outlet is `direct`:
 * a tap is not a wire outlet kind (S-15 §4.4).
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { HOMEBREW_PR } from "../prPlane.js";
import { linkOp, unsupported } from "./ciShared.js";
import { PR_STEP_PROJECTION, prOp } from "./prShared.js";

const pr = prOp(HOMEBREW_PR);
const NO_KEY =
  "a tap is a GitHub repository; its token is held in CI and never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported(
    "the cask token is the outlet's (direct.homebrewCask); nothing is registered",
  ),
  createApp: linkOp("homebrew.new-tap"),
  readListing: unsupported(
    "the cask is written from the listing model, never read back into it",
  ),
  writeListingText: pr,
  writeListingAssets: unsupported("a cask carries no art"),
  category: unsupported("Homebrew has no categories"),
  contentRating: unsupported("Homebrew has no content rating"),
  privacyDeclarations: unsupported("Homebrew asks for no privacy declaration"),
  pricing: unsupported("Homebrew sells nothing"),
  iap: unsupported("Homebrew has no in-app purchases"),
  testers: unsupported("a tap has no testers or tracks"),
  uploadBuild: pr,
  notificationsUrl: unsupported("a tap sends no notifications to a URL"),
  submit: unsupported("an own tap has no review"),
  release: pr,
  rollout: unsupported("a tap has no staged rollout"),
  status: pr,
};

export const HOMEBREW_ADAPTER: StorefrontAdapter = {
  id: "homebrew",
  label: "Homebrew tap",
  outletKinds: ["direct"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...HOMEBREW_PR.neverTokens],
  },
  ci: null,
  pr: HOMEBREW_PR,
  // The cask's name, desc and homepage are short identity fields, not a store listing column.
  listing: { fields: {}, images: {} },
  confirmation: { phrase: "app-name", label: "Homebrew tap" },
  audit: { action: "homebrew", projection: PR_STEP_PROJECTION },
};

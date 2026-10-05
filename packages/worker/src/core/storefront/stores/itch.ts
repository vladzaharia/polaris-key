/**
 * THE ITCH.IO ADAPTER (A-18h; notes/S-15 §4.4): a CI-plane storefront. itch.io takes builds
 * through butler, which needs the account's UNSCOPED API key, so every build step runs in CI and
 * never in the Worker (README decision 7): `butler push <dir> <user/game>:<channel>
 * --userversion <v>`, the target from the outlet identity, the channel name tagging its platform
 * (`windows`, `linux`, `mac`, `android`, optionally suffixed: `windows-beta`). The page (text,
 * art, price, classification) has no API and stays a deep link; collections deletes and page
 * edits are never automated. Uploads have no review, so a pushed channel is live at once.
 *
 * There is no Worker plane: no credential, no gate, no spec pin. The ledger rows are the publish
 * action's report-back (`plane = 'ci'`).
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { ITCH_CI } from "../ciPlane.js";
import { CI_STEP_PROJECTION, ciOp, linkOp, unsupported } from "./ciShared.js";

const NO_KEY =
  "itch.io's only credential is the unscoped butler key, which lives in CI and never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported(
    "itch.io has no identifier to register before the game page",
  ),
  createApp: linkOp("itch.new-game"),
  readListing: unsupported("itch.io has no API that reads a game page"),
  writeListingText: linkOp("itch.edit-game"),
  writeListingAssets: linkOp("itch.edit-game"),
  category: linkOp("itch.edit-game"),
  contentRating: linkOp("itch.edit-game"),
  privacyDeclarations: unsupported("itch.io asks for no privacy declaration"),
  pricing: linkOp("itch.edit-game"),
  iap: unsupported(
    "itch.io sells the game and its rewards on the page, with no product API",
  ),
  testers: unsupported(
    "itch.io has no tester groups; a restricted page with download keys is set on the page",
  ),
  uploadBuild: ciOp(ITCH_CI, "push"),
  notificationsUrl: unsupported(
    "itch.io sends no store notifications to a URL",
  ),
  submit: unsupported(
    "itch.io reviews no uploads: a pushed channel is live at once",
  ),
  release: unsupported(
    "a pushed channel is live at once, so uploadBuild is the release",
  ),
  rollout: unsupported("itch.io has no staged rollout"),
  status: unsupported(
    "the channel's version (/wharf/latest) needs the unscoped butler key, so it is read in CI, never by the Worker",
  ),
};

export const ITCH_ADAPTER: StorefrontAdapter = {
  id: "itch",
  label: "itch.io",
  outletKinds: ["itch"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...ITCH_CI.neverTokens],
  },
  ci: ITCH_CI.list,
  // itch.io's page text has no store-side limit Polaris Key sends to: nothing is pushed.
  listing: { fields: {}, images: {} },
  confirmation: { phrase: "app-name", label: "itch.io" },
  audit: { action: "itch", projection: CI_STEP_PROJECTION },
};

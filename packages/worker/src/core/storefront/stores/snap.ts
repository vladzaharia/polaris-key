/**
 * THE SNAP STORE ADAPTER (A-18h; notes/S-15 §4.4): a CI-plane storefront. Revisions go up with
 * `snapcraft upload <snap> --release=<channels>`, released only to channels the outlet identity
 * declares (`.pkey/distribution` `snap.channels`, declared channel → snap channel), and
 * `snapcraft upload-metadata <snap>` updates the summary, description and icon the snap carries,
 * which `pkey storefront snap metadata` writes from the listing model's Snap projection (A-18b)
 * before the snap is built. Title, screenshots and banner are dashboard-only: a deep link. Never
 * `close`, never collaborator ACLs (`package_manage`).
 *
 * The credential is a scoped, expiring `snapcraft export-login` (`--snaps <name> --channels <…>
 * --acls package_push,package_release --expires <date>`), held as a CI environment secret
 * (`SNAPCRAFT_STORE_CREDENTIALS`), never in the Worker. There is no Worker plane.
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { SNAP_CI } from "../ciPlane.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";
import { CI_STEP_PROJECTION, ciOp, linkOp, unsupported } from "./ciShared.js";

const NO_KEY =
  "the Snap Store credential is a scoped export-login held in CI, never in Polaris Key";

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: unsupported(NO_KEY),
  listApps: unsupported(NO_KEY),
  identifiers: unsupported(
    "the snap name is the only identifier; it is registered with the app",
  ),
  createApp: linkOp("snap.register"),
  readListing: unsupported(
    "the Snap Store's listing is read in its dashboard, not through Polaris Key",
  ),
  writeListingText: ciOp(SNAP_CI, "upload-metadata"),
  writeListingAssets: linkOp("snap.listing"),
  category: linkOp("snap.listing"),
  contentRating: unsupported("the Snap Store has no content rating"),
  privacyDeclarations: unsupported(
    "the Snap Store asks for no privacy declaration",
  ),
  pricing: unsupported("the Snap Store sells nothing"),
  iap: unsupported("the Snap Store has no in-app purchases"),
  testers: unsupported(
    "testers follow a beta or edge channel; there are no tester groups",
  ),
  uploadBuild: ciOp(SNAP_CI, "upload"),
  notificationsUrl: unsupported(
    "the Snap Store sends no notifications to a URL",
  ),
  submit: unsupported(
    "review is automatic, except classic confinement, which is one forum request and a human review",
  ),
  release: ciOp(SNAP_CI, "upload"),
  rollout: unsupported(
    "progressive releases are snapcraft release --progressive, which the allow-list excludes",
  ),
  status: unsupported(
    "snapcraft status needs the store credential, so it runs in CI",
  ),
};

export const SNAP_ADAPTER: StorefrontAdapter = {
  id: "snap",
  label: "Snap Store",
  outletKinds: ["snap"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [...SNAP_CI.neverTokens],
  },
  ci: SNAP_CI.list,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS.snap),
  confirmation: { phrase: "app-name", label: "Snap Store" },
  audit: { action: "snap", projection: CI_STEP_PROJECTION },
};

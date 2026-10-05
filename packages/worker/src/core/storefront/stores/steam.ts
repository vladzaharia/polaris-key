/**
 * THE STEAM ADAPTER (A-18g; notes/S-15 §4.3, §11, owner decision 5). Honest about what Steam
 * allows: reads, setting a build live on a NAMED branch, and, for everything else, deep links plus
 * what Polaris Key can prepare for the operator (A-18j renders Steam's plan as "store page: links
 * only"):
 *
 *   - Worker plane, behind the gate (`../rules/steam.ts`): the partner app list, builds and
 *     branches (`connect`, `listApps`, `status`), and `SetAppBuildLive` on a named branch
 *     (`testers`: a Steam beta branch is how a build reaches testers before release);
 *   - deep links for app creation (the fee), the store page (text, capsules, screenshots, tags,
 *     the content survey, store review) and App Admin's builds page, where the operator sets the
 *     default (public) branch live (decision 5: `release` is a deep link until A-18k verifies the
 *     key, then typed confirmation, never plain). The release is verified by reading
 *     `GetAppBetas`: the public branch shows the build;
 *   - the store page's text is a COPY CARD (Steam's listing column is all `copy` plane,
 *     `../listingProfiles.ts`) and its art the generated asset pack (A-18d's `pack:steam`), both
 *     served by Distribution's Steam storefront routes with the per-app checklist;
 *   - no build upload from the Worker: depots go up from the release workflow's steamcmd step
 *     (P5-08's VDFs; A-18h declares its command allow-list).
 *
 * NEVER (S-15 §4.3): users and permissions, app credits, pricing, branch or depot deletion. The
 * Web API has none of the first four for partners and the gate refuses every delete it does have;
 * pricing and app credits are UI-only and no operation here reaches them.
 */

import type { Support } from "../../adapters/contract.js";
import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import {
  STEAM_COMPILED_GATE,
  STEAM_SET_LIVE,
  STEAM_SPEC_PIN,
} from "../rules/steam.js";
import { STEAM_WRITE_DENIED } from "../rules/steamDenied.js";
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
const unsupported = (reason: string): Support => ({
  mode: "unsupported",
  reason,
});

const POLL = { every: 10, until: 900 } as const;

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: api(),
  listApps: api(),
  identifiers: unsupported(
    "Steam assigns the app id when the app is created; nothing is registered before it",
  ),
  createApp: link("steam.new-app", {
    read: "/ISteamApps/GetPartnerAppListForWebAPIKey/v2/",
    ...POLL,
  }),
  readListing: unsupported(
    "no Steamworks Web API method reads a store page; the console shows the copy card from the listing model instead",
  ),
  writeListingText: link("steam.store-page"),
  writeListingAssets: link("steam.store-page"),
  category: link("steam.store-page"),
  contentRating: link("steam.store-page"),
  privacyDeclarations: unsupported(
    "Steam's store admin has no privacy questionnaire; a privacy policy link belongs in the store page text",
  ),
  pricing: unsupported(
    "pricing is never automated for Steam (S-15 §4.3 never-list): prices are set in Steamworks' own pricing pages only",
  ),
  iap: unsupported(
    "Steam DLC are apps created in Steamworks, and micro-transactions are payments, which the gate never reaches",
  ),
  testers: api(`POST ${STEAM_SET_LIVE}`),
  uploadBuild: unsupported(
    "depots go up from the release workflow's steamcmd step (P5-08's VDFs; A-18h's allow-list), never from the Worker (README decision 7)",
  ),
  notificationsUrl: unsupported(
    "Steam pushes no notifications; the Worker reads GetAppBuilds and GetAppBetas instead",
  ),
  submit: link("steam.store-page"),
  release: link("steam.app-admin", {
    read: "/ISteamApps/GetAppBetas/v1/",
    ...POLL,
  }),
  rollout: unsupported(
    "Steam has no staged rollout: a build is live on a branch or it is not",
  ),
  status: api(),
};

/** Attributes kept per resource type in a ledger row's before and after. */
const PROJECTION: Readonly<Record<string, readonly string[]>> = {
  /** One branch as `GetAppBetas` answers it (the natural key of a branch move). */
  betas: ["name", "buildId", "description", "updatedAt", "locked"],
  builds: ["buildId", "description", "createdAt"],
  apps: ["appId", "name", "appType"],
};

export const STEAM_ADAPTER: StorefrontAdapter = {
  id: "steam",
  label: "Steamworks",
  outletKinds: ["steam"],
  credential: "steam.publisher-key",
  specPin: STEAM_SPEC_PIN,
  gate: STEAM_COMPILED_GATE,
  capabilities: {
    ops: OPS,
    // 100,000 Web API calls per day per key; a 403 rate-limits the Worker's shared egress IP, so
    // the meter stops every call on the first one (S-15 §4.3).
    rate: { kind: "per-day", limit: 100_000, stopOn403: true },
    limits: {
      // A Coming Soon page must be up at least two weeks before release.
      comingSoonDays: 14,
      // Between paying the app fee and release.
      feeToReleaseDays: 30,
    },
  },
  never: {
    delete: [...STEAM_WRITE_DENIED.deletes],
    // Partner users and permissions have no Web API; the never-list's users are players' data
    // and accounts, refused for every method.
    users: [
      "* /ISteamUser/GetPlayerSummaries/v2/",
      "* /ISteamUser/GetFriendList/v1/",
      "* /ISteamUser/GetPublisherAppOwnership/v4/",
      "* /IPlayerService/GetOwnedGames/v1/",
      "* /ISteamMicroTxn/GetUserInfo/v2/",
      "POST /ILobbyMatchmakingService/RemoveUserFromLobby/v1/",
      "POST /ICheatReportingService/RequestPlayerGameBan/v1/",
      "POST /ICheatReportingService/RemovePlayerGameBan/v1/",
    ],
    signingKeys: [
      ...STEAM_WRITE_DENIED.credentials,
      "* /IGameServersService/QueryLoginToken/v1/",
    ],
    payments: [
      ...STEAM_WRITE_DENIED.payments,
      "* /IPartnerFinancialsService/GetDetailedSales/v001/",
      "* /ISteamMicroTxn/GetReport/v5/",
    ],
    ciTokens: ["delete", "remove", "refund", "users", "password"],
  },
  ci: null,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS.steam),
  confirmation: { phrase: "app-name", label: "Steamworks" },
  audit: { action: "steam", projection: PROJECTION },
};


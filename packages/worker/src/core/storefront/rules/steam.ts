/**
 * THE STEAM WRITE GATE (A-18g; notes/S-15 §4.3, §6.2, owner decision 5).
 *
 * Steam has no listing API: none of the Steamworks Web API's 33 interfaces edits a store page.
 * What the Worker may do with the publisher key is small, and this table says exactly that:
 *
 *   - READS, and only three (`reads`): `ISteamApps/GetPartnerAppListForWebAPIKey/v2` (the apps
 *     the key may act on), `GetAppBuilds/v1` and `GetAppBetas/v1` (builds and branches). Any other
 *     read, and every write method sent as a `GET`, is refused before the key is opened;
 *   - ONE WRITE: `ISteamApps/SetAppBuildLive/v2` on a NAMED branch. The form matcher
 *     (`../match/form.ts`) admits `appid`, `buildid`, `betakey` and an optional `description`,
 *     nothing else: no `steamid`, which Steam requires only for the default branch;
 *   - the DEFAULT BRANCH IS DENIED. `betakey=public` (or `default`, any case) is refused
 *     `value_not_allowed` whatever the confirmation. Decision 5: until A-18k shows the
 *     group-scoped key may set the public branch live, that release is a deep link to App Admin
 *     (`steam.app-admin`). A follow-up then flips this check to TYPED confirmation (the phrase is
 *     Steam's app name), declares `release` as `api`, adds a typed conformance sample and admits
 *     `steamid`. It is never `plain`.
 *
 * Personal and financial reads are also listed as `forbidden` (player summaries, friends,
 * ownership, micro-transaction reports, partner financials, game-server login tokens), so the
 * refusal says `personal_data` rather than `not_allowed`; `reads` would refuse them anyway.
 *
 * The vendor contract is the hand-written operation list in `steamDenied.ts`, pinned by its digest
 * (`STEAM_SPEC_PIN`; the fixture `test/fixtures/steam/webapi-writes.json` is the same list). A
 * change to this table is a THREAT-MODEL §9 review trigger.
 */

import type { SpecPin } from "../../adapters/contract.js";
import {
  compileGate,
  type DenyReason,
  type GateContext,
  type GateRuleSet,
} from "../gate.js";
import { StoreWriteDenied } from "../errors.js";
import { matchForm, type FormRule } from "../match/form.js";
import { STEAM_DENY_REASONS, STEAM_WRITE_DENIED } from "./steamDenied.js";

/**
 * The hand-written Steamworks Web API operation list the gate is classified against: its date,
 * and the SHA-256 of the fixture's `operations` array as JSON (the Steam test recomputes it).
 */
export const STEAM_SPEC_PIN = {
  title: "Steamworks Web API reference (hand-written write list)",
  version: "2026-10-04",
  sha256: "01fc507d23ab8b1b88ee42254b77f7e0119d3dc0d2f2f2b90516f293483aca54",
} as const satisfies SpecPin;

/** A request the Steam gate refused. Thrown before the publisher key is opened or a byte sent. */
export class SteamWriteDenied extends StoreWriteDenied {
  constructor(method: string, target: string, reason: DenyReason) {
    super(
      "steam",
      method,
      target,
      reason,
      `Steam write gate refused ${method} ${target}: ${reason}`,
    );
    this.name = "SteamWriteDenied";
  }
}

/** The three reads the adapter makes (and nothing else may be read through the gate). */
export const STEAM_READS = {
  apps: "/ISteamApps/GetPartnerAppListForWebAPIKey/v2/",
  builds: "/ISteamApps/GetAppBuilds/v1/",
  betas: "/ISteamApps/GetAppBetas/v1/",
} as const;

/** The one write. */
export const STEAM_SET_LIVE = "/ISteamApps/SetAppBuildLive/v2/";

/**
 * A named branch as `betakey` carries it. Steamworks branch names are short lower-case tokens;
 * upper case is admitted here so that `Public` is caught by the default-branch check below.
 */
export const STEAM_BRANCH = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The default branch, which a Web API call reaches as `public` (decision 5: a deep link). */
export function isSteamDefaultBranch(branch: string): boolean {
  const b = branch.toLowerCase();
  return b === "public" || b === "default";
}

/** The approved write surface: one rule. */
export const STEAM_WRITE_ALLOW: readonly FormRule[] = [
  {
    method: "POST",
    path: STEAM_SET_LIVE,
    confirm: "plain",
    why: "S-15 §4.3: set a build live on a NAMED branch (beta, staging, playtest); the default branch is decision 5's deep link",
    params: {
      appid: { kind: "integer" },
      buildid: { kind: "integer" },
      betakey: { kind: "string", max: 64 },
      description: { kind: "string", max: 200 },
    },
    required: ["appid", "buildid", "betakey"],
    check: (params: Readonly<Record<string, string>>, _ctx: GateContext) => {
      const branch = params.betakey ?? "";
      if (!STEAM_BRANCH.test(branch)) return "value_not_allowed";
      // Decision 5: refused whatever the confirmation, until A-18k (see the file comment).
      if (isSteamDefaultBranch(branch)) return "value_not_allowed";
      return null;
    },
  },
];

const PERSONAL_OR_FINANCIAL = new Set(
  [
    "/ISteamUser/CheckAppOwnership/v4/",
    "/ISteamUser/GetDeletedSteamIDs/v1/",
    "/ISteamUser/GetFriendList/v1/",
    "/ISteamUser/GetPlayerBans/v1/",
    "/ISteamUser/GetPlayerSummaries/v2/",
    "/ISteamUser/GetPublisherAppOwnership/v4/",
    "/ISteamUser/GetUserGroupList/v1/",
    "/ISteamUser/ResolveVanityURL/v1/",
    "/ISteamUserAuth/AuthenticateUserTicket/v1/",
    "/ISteamApps/GetPlayersBanned/v1/",
    "/IPlayerService/GetRecentlyPlayedGames/v1/",
    "/IPlayerService/GetSingleGamePlaytime/v1/",
    "/IPlayerService/GetOwnedGames/v1/",
    "/IPlayerService/GetSteamLevel/v1/",
    "/IPlayerService/GetBadges/v1/",
    "/IPlayerService/GetCommunityBadgeProgress/v1/",
    "/ISteamMicroTxn/GetReport/v5/",
    "/ISteamMicroTxn/GetUserAgreementInfo/v2/",
    "/ISteamMicroTxn/GetUserInfo/v2/",
    "/ISteamMicroTxn/QueryTxn/v3/",
    "/IPartnerFinancialsService/GetChangedDatesForPartner/v001/",
    "/IPartnerFinancialsService/GetDetailedSales/v001/",
    "/IPartnerFinancialsService/GetAppWishlistReporting/v001/",
    "/IGameServersService/GetAccountList/v1/",
    "/IGameServersService/QueryLoginToken/v1/",
    "/ICheatReportingService/GetCheatingReports/v1/",
    "/IGameInventory/GetUserHistory/v1/",
    "/IGameInventory/SupportGetAssetHistory/v1/",
    "/IGameInventory/GetHistoryCommandDetails/v1/",
    "/IEconService/GetTradeHistory/v1/",
    "/IEconService/GetTradeOffers/v1/",
    "/IEconService/GetTradeOffer/v1/",
    "/IEconService/GetTradeOffersSummary/v1/",
    "/IInventoryService/GetInventory/v1/",
    "/ISteamEconomy/GetExportedAssetsForUser/v1/",
    "/ICloudService/EnumerateUserFiles/v1/",
    "/ISteamUserStats/GetPlayerAchievements/v1/",
    "/ISteamUserStats/GetUserStatsForGame/v2/",
  ].map((s) => s.toLowerCase()),
);

/** Player data, financial reports and login tokens: refused for every method. */
export function isSteamPersonalPath(path: string): boolean {
  return PERSONAL_OR_FINANCIAL.has(path.toLowerCase());
}

const READS = new Set<string>(Object.values(STEAM_READS));

/** `/<Interface>/<Method>/v<N>/`, as every Steamworks Web API path is spelt. */
const STEAM_PATH = /^\/I[A-Za-z]{2,63}\/[A-Za-z]{2,63}\/v[0-9]{1,4}\/$/;

/** The Steam rule set, as the store-agnostic engine takes it. */
export const STEAM_GATE: GateRuleSet<FormRule> = {
  store: "steam",
  specPin: STEAM_SPEC_PIN,
  allow: STEAM_WRITE_ALLOW,
  denied: STEAM_WRITE_DENIED,
  denyReasons: STEAM_DENY_REASONS,
  validPath: (path) => STEAM_PATH.test(path),
  forbidden: isSteamPersonalPath,
  reads: (path) => READS.has(path),
  match: matchForm,
  deny: (method, target, reason) =>
    new SteamWriteDenied(method, target, reason),
};

/** The compiled Steam gate: what `SteamClient` and the Steam adapter consult. */
export const STEAM_COMPILED_GATE = compileGate(STEAM_GATE);

/**
 * Admit or refuse one Steam request. Throws `SteamWriteDenied`; returns the matched rule for a
 * write (null for an admitted read). Pure: no I/O, no key.
 */
export function checkSteamRequest(
  method: string,
  path: string,
  body: unknown,
  ctx: GateContext = {},
): FormRule | null {
  return STEAM_COMPILED_GATE.check(method, path, body, ctx);
}

/**
 * EVERY OTHER STEAMWORKS WEB API WRITE, BY DENY GROUP (A-18g; notes/S-15 §4.3, §6.2).
 *
 * Steam publishes no machine-readable spec, so the Steam gate is classified against a HAND-WRITTEN
 * operation list: every `POST` method of the 33 interfaces of the Steamworks Web API reference
 * (partner.steamgames.com/doc/webapi, read 2026-10-04), plus the two methods the reference lists
 * as `GET` although they change state (`IPublishedFileService/Delete`, `ISteamEconomy/StartTrade`).
 * `ISteamMicroTxnSandbox` is "identical to the regular ISteamMicroTxn interface", so its writes are
 * ISteamMicroTxn's. The fixture `test/fixtures/steam/webapi-writes.json` carries the same list and
 * its digest is the gate's spec pin (`STEAM_SPEC_PIN`); the conformance suite classifies every
 * entry exactly once. A page Valve changes is a docs-drift review, not a CI failure (as Microsoft's
 * hand-written list, A-18f).
 *
 * None of these is reachable: the allow table (`steam.ts`) has one rule, `SetAppBuildLive` on a
 * named branch. A change here is a THREAT-MODEL §9 review trigger.
 *
 * Paths are as the reference spells them, with a trailing slash; `IGameInventory/UpdateItemDefs`
 * is written `v0001/` for uniformity (the reference omits the slash there).
 */

const p = (method: string, iface: string, name: string, version: string) =>
  `${method} /${iface}/${name}/${version}/`;
const post = (iface: string, ...names: string[]) =>
  names.map((n) => {
    const [name, version] = n.split("@") as [string, string];
    return p("POST", iface, name, version);
  });

const MICRO_TXN_WRITES = [
  "AdjustAgreement@v1",
  "CancelAgreement@v1",
  "FinalizeTxn@v2",
  "InitTxn@v3",
  "ProcessAgreement@v1",
  "RefundTxn@v2",
];

export const STEAM_WRITE_DENIED = {
  /** Deleting anything (owner rule: never delete). */
  deletes: [
    ...post(
      "ISteamLeaderboards",
      "DeleteLeaderboard@v1",
      "DeleteLeaderboardScore@v1",
      "ResetLeaderboard@v1",
    ),
    ...post("ICloudService", "Delete@v1"),
    ...post("IGameServersService", "DeleteAccount@v1"),
    ...post(
      "IGameNotificationsService",
      "DeleteSession@v1",
      "DeleteSessionBatch@v1",
    ),
    p("GET", "IPublishedFileService", "Delete", "v1"),
  ],
  /** Acting on players: bans, reports, lobbies, sessions, notifications, market listings. */
  players: [
    ...post(
      "ICheatReportingService",
      "ReportPlayerCheating@v1",
      "RequestPlayerGameBan@v1",
      "RemovePlayerGameBan@v1",
      "RequestVacStatusForUser@v1",
      "StartSecureMultiplayerSession@v1",
      "EndSecureMultiplayerSession@v1",
    ),
    ...post(
      "ILobbyMatchmakingService",
      "CreateLobby@v1",
      "RemoveUserFromLobby@v1",
    ),
    ...post("ISteamCommunity", "ReportAbuse@v1"),
    ...post("ISteamUserAuth", "AuthenticateUser@v1"),
    ...post(
      "IGameNotificationsService",
      "CreateSession@v1",
      "UpdateSession@v1",
      "RequestNotifications@v1",
    ),
    ...post("IBroadcastService", "PostGameDataFrame@v1"),
    ...post("IEconMarketService", "CancelAppListingsForUser@v1"),
  ],
  /** Money: micro-transactions and agreements (live and sandbox), asset transactions, payment rules. */
  payments: [
    ...post("ISteamMicroTxn", ...MICRO_TXN_WRITES),
    ...post("ISteamMicroTxnSandbox", ...MICRO_TXN_WRITES),
    ...post(
      "ISteamEconomy",
      "StartAssetTransaction@v1",
      "FinalizeAssetTransaction@v1",
    ),
    p("GET", "ISteamEconomy", "StartTrade", "v1"),
    ...post("IWorkshopService", "SetItemPaymentRules@v1"),
  ],
  /** Game-server accounts and their login tokens: credentials. */
  credentials: post(
    "IGameServersService",
    "CreateAccount@v1",
    "ResetLoginToken@v1",
    "SetMemo@v1",
  ),
  /** Players' items, stats and leaderboards: game data, not the listing or the build. */
  gameData: [
    ...post(
      "IInventoryService",
      "AddItem@v1",
      "AddPromoItem@v1",
      "ConsumeItem@v1",
      "ExchangeItem@v1",
      "Consolidate@v1",
      "ModifyItems@v1",
    ),
    ...post(
      "IGameInventory",
      "HistoryExecuteCommands@v1",
      "UpdateItemDefs@v0001",
    ),
    ...post(
      "IEconService",
      "FlushInventoryCache@v1",
      "FlushAssetAppearanceCache@v1",
      "FlushContextCache@v1",
    ),
    ...post(
      "ISteamLeaderboards",
      "FindOrCreateLeaderboard@v2",
      "SetLeaderboardScore@v1",
    ),
    ...post("ISteamUserStats", "SetUserStatsForGame@v1"),
  ],
  /** Workshop and cloud content: user-generated files, their moderation and uploads. */
  content: [
    ...post(
      "IPublishedFileService",
      "SetDeveloperMetadata@v1",
      "UpdateAppUGCBan@v1",
      "UpdateBanStatus@v1",
      "UpdateIncompatibleStatus@v1",
      "UpdateTags@v1",
    ),
    ...post("IPublishedFileModerationService", "ProcessApprovalRequest@v1"),
    ...post(
      "ISteamRemoteStorage",
      "SetUGCUsedByGC@v1",
      "SubscribePublishedFile@v1",
      "UnsubscribePublishedFile@v1",
    ),
    ...post("IWorkshopService", "PopulateItemDescriptions@v1"),
    ...post(
      "ICloudService",
      "BeginAppUploadBatch@v1",
      "CompleteAppUploadBatch@v1",
      "BeginHTTPUpload@v1",
      "CommitHTTPUpload@v1",
    ),
  ],
  /** `POST`-shaped queries: reads the adapter does not need. */
  postQueries: [
    ...post(
      "ISteamPublishedItemSearch",
      "RankedByPublicationOrder@v1",
      "RankedByTrend@v1",
      "RankedByVote@v1",
      "ResultSetSummary@v1",
    ),
    ...post(
      "ISteamPublishedItemVoting",
      "ItemVoteSummary@v1",
      "UserVoteSummary@v1",
    ),
    ...post(
      "ISteamRemoteStorage",
      "EnumerateUserSubscribedFiles@v1",
      "GetCollectionDetails@v1",
      "GetPublishedFileDetails@v1",
    ),
  ],
} as const satisfies Record<string, readonly string[]>;

export const STEAM_DENY_REASONS: Readonly<
  Record<keyof typeof STEAM_WRITE_DENIED, string>
> = {
  deletes:
    "owner rule: never delete (leaderboards, cloud files, game-server accounts, sessions, workshop items)",
  players:
    "acting on players (bans, reports, lobbies, notifications, market listings) is no part of store provisioning",
  payments:
    "owner rule: never touch payments (micro-transactions, refunds, agreements, asset transactions, payment rules)",
  credentials:
    "game-server accounts carry login tokens: credentials are never minted or reset by the Worker",
  gameData:
    "players' items, stats and leaderboards are the game's runtime data, not its listing or its builds",
  content:
    "workshop and cloud content belongs to players and moderators, not to provisioning",
  postQueries:
    "queries the adapter does not need; reads are limited to the partner app list, builds and branches",
};

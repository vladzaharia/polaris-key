/**
 * The Steam side of the commerce bridge (P6-01; notes/E3 §B3).
 *
 * A claim carries a Steam **web-API session ticket** (GodotSteam's `getAuthTicketForWebApi`,
 * created with the licence's binding as its `identity`) and the DLC's app id. The Worker then
 * asks Steam, with the operator's `steam-publisher-key` (pinned to the game's app id):
 *
 *   1. `ISteamUserAuth/AuthenticateUserTicket/v1` (`appid` = the game, `identity` = the caller's
 *      binding) — the ticket is genuine, fresh and was made for THIS licence, and names the
 *      player's `steamid`. A ticket captured from another player's session fails here, because
 *      its identity is that player's binding.
 *   2. `ISteamUser/CheckAppOwnership/v4` for (`steamid`, DLC app id) — the player owns the DLC
 *      outright: `permanent` (not Family Sharing, a free weekend or the PC Café programme), not a
 *      `sitelicense`, not `usercanceled`, owned by the account itself (`ownersteamid` equals
 *      `steamid`) and not a timed trial.
 *
 * Both calls go to `partner.steam-api.com` (the publisher host, which a publisher key requires),
 * redirect-free and capped (`http.ts`); the key rides in the query string, so no error ever
 * carries the URL. Steam does not push refunds, so ownership is re-checked on every claim and
 * weekly (`recheck.ts`); a player who no longer owns the DLC loses the flag.
 *
 * **The platform publisher key (A-16).** A product with NO active `steam-publisher-key` of its own
 * falls back to the platform's group key (`steam.publisher-key`: console credential, else
 * `PLATFORM_STEAM_PUBLISHER_KEY`), only for the game a platform admin assigned to it (its platform
 * pin, compared with the commerce settings' `appId`). The key is opened through
 * `openPlatformCredential`, which refuses a product whose pin does not match — this file is one of
 * the two reviewed callers outside Core. `listPlatformSteamApps` lists the apps the group key may
 * query (`ISteamApps/GetPartnerAppListForWebAPIKey/v2`) plus the operator-entered `steam.appIds`.
 */

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import type { SteamSettings } from "../../settings.js";
import type { VerifiedPurchase } from "../../state.js";
import { StoreUnavailable, storeJson } from "../../../../core/stores/http.js";
import { platformFallback } from "../../../../core/stores/platformFallback.js";
import {
  STEAM_PLATFORM_CREDENTIAL,
  isSteamAppId,
  openSteamPublisherKey,
  steamUrl,
} from "../../../../core/stores/steam/publisher.js";

const STEAM_ID = /^[0-9]{17}$/;
/** A web-API ticket is hex; Steam's are a few hundred bytes. */
const TICKET = /^[0-9A-Fa-f]{16,4096}$/;

export function isSteamTicket(v: unknown): v is string {
  return typeof v === "string" && TICKET.test(v);
}

export type SteamRejection = "invalid_ticket" | "not_owned";

export class SteamRejected extends Error {
  constructor(readonly reason: SteamRejection) {
    super(`steam: ${reason}`);
    this.name = "SteamRejected";
  }
}

/** The `steam-publisher-key` credential pinned to `appId` (lowest id), or null. */
export async function steamCredential(
  env: Env,
  db: Db,
  product: string,
  appId: string,
): Promise<string | null> {
  const own = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === "steam-publisher-key",
  );
  if (own.length > 0)
    return own.find((c) => checkOutletCredentialPin(c, appId).ok)?.id ?? null;
  // A-16: no key of the product's own — the platform group key, for the pinned game.
  const f = await platformFallback(
    env,
    db,
    product,
    STEAM_PLATFORM_CREDENTIAL,
    appId,
  );
  return f.ok ? f.handle : null;
}

export interface SteamContext {
  env: Env;
  db: Db;
  product: string;
  now: number;
  settings: SteamSettings;
  credentialId: string;
}

async function publisherKey(ctx: SteamContext, use: string): Promise<string> {
  return openSteamPublisherKey(
    ctx.env,
    ctx.db,
    ctx.product,
    ctx.settings.appId,
    ctx.credentialId,
    use,
    ctx.now,
  );
}

/** `AuthenticateUserTicket`: the ticket's `steamid`. Throws `SteamRejected` /
 *  `StoreUnavailable`. */
export async function authenticateTicket(
  ctx: SteamContext,
  key: string,
  ticket: string,
  identity: string,
): Promise<string> {
  const res = await storeJson(
    steamUrl("/ISteamUserAuth/AuthenticateUserTicket/v1/", {
      key,
      appid: ctx.settings.appId,
      ticket,
      identity,
    }),
    { method: "GET", headers: { accept: "application/json" } },
    "steam AuthenticateUserTicket",
    [400, 401, 403],
  );
  if (res.status === 401 || res.status === 403)
    throw new StoreUnavailable("steam AuthenticateUserTicket", res.status);
  const response = res.body?.response as Record<string, unknown> | undefined;
  const params = response?.params as Record<string, unknown> | undefined;
  if (
    res.status !== 200 ||
    !params ||
    params.result !== "OK" ||
    typeof params.steamid !== "string" ||
    !STEAM_ID.test(params.steamid)
  )
    throw new SteamRejected("invalid_ticket");
  // A ticket made on a borrowed (Family Sharing) copy authenticates the borrower; ownership of
  // the DLC is decided by CheckAppOwnership below.
  return params.steamid;
}

export interface SteamOwnership {
  owns: boolean;
  ownerSteamId: string | null;
}

/** `CheckAppOwnership` for (steamid, app). Throws `StoreUnavailable`. */
export async function checkOwnership(
  _ctx: SteamContext,
  key: string,
  steamId: string,
  appId: string,
): Promise<SteamOwnership> {
  const res = await storeJson(
    steamUrl("/ISteamUser/CheckAppOwnership/v4/", {
      key,
      steamid: steamId,
      appid: appId,
    }),
    { method: "GET", headers: { accept: "application/json" } },
    "steam CheckAppOwnership",
  );
  const o = res.body?.appownership as Record<string, unknown> | undefined;
  if (!o || o.result !== "OK")
    throw new StoreUnavailable("steam CheckAppOwnership", 502);
  const owner = typeof o.ownersteamid === "string" ? o.ownersteamid : null;
  return {
    // Owned outright (Steamworks ISteamUser/CheckAppOwnership v4,
    // partner.steamgames.com/doc/webapi/ISteamUser#CheckAppOwnership): an active licence
    // (`ownsapp`) that is `permanent` ("not true for ownership via Family Sharing, free weekends or
    // PC Café program"), not a PC Café `sitelicense`, not self-cancelled (`usercanceled`), held by
    // this account itself (`ownersteamid`), and not a timed trial (an undocumented field some
    // answers carry; refused when true).
    owns:
      o.ownsapp === true &&
      o.permanent === true &&
      o.sitelicense !== true &&
      o.usercanceled !== true &&
      o.timedtrial !== true &&
      owner === steamId,
    ownerSteamId: owner,
  };
}

/** The record for (steamid, DLC). `state` follows ownership. */
export function steamPurchase(
  steamId: string,
  dlcAppId: string,
  owns: boolean,
  binding: string | null,
): VerifiedPurchase {
  return {
    store: "steam",
    purchaseKey: `${steamId}:${dlcAppId}`,
    storeProductId: dlcAppId,
    environment: "steam",
    state: owns ? "active" : "revoked",
    binding,
    detail: { steamId, dlcAppId },
  };
}

/**
 * A device's claim: authenticate the ticket for the caller's binding, then check DLC ownership.
 * A non-owner throws `SteamRejected("not_owned")` (nothing recorded, nothing granted).
 */
export async function verifySteamClaim(
  ctx: SteamContext,
  ticket: string,
  dlcAppId: string,
  binding: string,
): Promise<VerifiedPurchase> {
  const key = await publisherKey(ctx, "commerce:claim");
  const steamId = await authenticateTicket(ctx, key, ticket, binding);
  const own = await checkOwnership(ctx, key, steamId, dlcAppId);
  // A player who owned the DLC once and no longer does is recorded as revoked (the grant goes);
  // one who never owned it is simply refused.
  if (!own.owns) return steamPurchase(steamId, dlcAppId, false, binding);
  return steamPurchase(steamId, dlcAppId, true, binding);
}

/** The weekly re-check of one recorded (steamid, DLC). Throws `StoreUnavailable`. */
export async function recheckSteamOwnership(
  ctx: SteamContext,
  steamId: string,
  dlcAppId: string,
): Promise<boolean> {
  const key = await publisherKey(ctx, "commerce:recheck");
  return (await checkOwnership(ctx, key, steamId, dlcAppId)).owns;
}

export { STEAM_ID, isSteamAppId };

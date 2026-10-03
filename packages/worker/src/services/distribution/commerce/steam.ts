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
 *   2. `ISteamUser/CheckAppOwnership/v4` for (`steamid`, DLC app id) — the player owns the DLC,
 *      themselves (`ownersteamid` equals `steamid`: a Family Sharing borrower does not get a
 *      licence flag) and not as a timed trial.
 *
 * Both calls go to `partner.steam-api.com` (the publisher host, which a publisher key requires),
 * redirect-free and capped (`http.ts`); the key rides in the query string, so no error ever
 * carries the URL. Steam does not push refunds, so ownership is re-checked on every claim and
 * weekly (`recheck.ts`); a player who no longer owns the DLC loses the flag.
 */

import type { Db, Env } from "../../../core/platform.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
  openOutletCredential,
} from "../../../core/outletCredentials.js";
import type { SteamSettings } from "./settings.js";
import type { VerifiedPurchase } from "./state.js";
import { StoreUnavailable, storeJson } from "./http.js";

export const STEAM_PARTNER_API = "https://partner.steam-api.com";

const STEAM_ID = /^[0-9]{17}$/;
/** A web-API ticket is hex; Steam's are a few hundred bytes. */
const TICKET = /^[0-9A-Fa-f]{16,4096}$/;
const APP_ID = /^[1-9][0-9]{0,9}$/;

export function isSteamTicket(v: unknown): v is string {
  return typeof v === "string" && TICKET.test(v);
}

export function isSteamAppId(v: unknown): v is string {
  return typeof v === "string" && APP_ID.test(v);
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
  db: Db,
  product: string,
  appId: string,
): Promise<string | null> {
  const creds = (await listOutletCredentials(db, product)).filter(
    (c) =>
      c.status === "active" &&
      c.kind === "steam-publisher-key" &&
      checkOutletCredentialPin(c, appId).ok,
  );
  return creds[0]?.id ?? null;
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
  const cred = await openOutletCredential(
    ctx.env,
    ctx.db,
    ctx.product,
    ctx.credentialId,
    use,
    {
      kind: "steam-publisher-key",
      now: ctx.now,
    },
  );
  if (!cred) throw new StoreUnavailable("steam credential", 401);
  return cred.value.key;
}

function steamUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, STEAM_PARTNER_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (url.origin !== STEAM_PARTNER_API)
    throw new Error("refusing a Steam call elsewhere");
  return url.toString();
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
  ctx: SteamContext,
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
    owns:
      o.ownsapp === true &&
      o.timedtrial !== true &&
      // Owned by this account itself, not borrowed through Family Sharing.
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

export { STEAM_ID };

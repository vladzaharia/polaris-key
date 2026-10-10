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

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
  openOutletCredential,
  type TransientOutletCredential,
} from "../../../core/outletCredentials.js";
import {
  openPlatformCredential,
  parsePlatformCredentialHandle,
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../../core/platformCredentials.js";
import type { PlatformEventActor } from "../../../core/platformEvents.js";
import { resolvePlatformStoreSetting } from "../../../core/platformStoreSettings.js";
import type { SteamSettings } from "./settings.js";
import type { VerifiedPurchase } from "./state.js";
import { StoreUnavailable, storeJson } from "./http.js";
import { platformFallback } from "../connectors/platformFallback.js";
import {
  appCount,
  checked,
  hiddenAssignedApps,
  storeUnavailable,
  type CheckFact,
  type CredentialCheck,
} from "../connectors/credentialCheck.js";
import {
  cachedPlatformApps,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
  type PlatformStoreApp,
} from "../connectors/platformApps.js";

/** The platform credential the fallback uses (A-16). */
export const STEAM_PLATFORM_CREDENTIAL = "steam.publisher-key" as const;

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

/**
 * Open the publisher key a Steam call for (`product`, `appId`) uses: the product's own
 * `steam-publisher-key` (`credentialId`), or the platform group key when `credentialId` is its
 * handle, whose open refuses unless the product's platform pin is `appId`. Every open is audited
 * with `use`. A-18g's storefront adapter opens through here too, inside its gated client's key
 * thunk (so a request the gate refuses never opens the key). Throws `StoreUnavailable(401)` when
 * the key cannot be opened.
 */
export async function openSteamPublisherKey(
  env: Env,
  db: Db,
  product: string,
  appId: string,
  credentialId: string,
  use: string,
  now: number,
): Promise<string> {
  if (parsePlatformCredentialHandle(credentialId)) {
    // The open itself refuses unless this product's platform pin is the game's app id.
    const team = await openPlatformCredential(
      env,
      db,
      STEAM_PLATFORM_CREDENTIAL,
      use,
      { product, pin: appId },
      now,
    );
    if (!team) throw new StoreUnavailable("steam credential", 401);
    return team.value.key;
  }
  const cred = await openOutletCredential(env, db, product, credentialId, use, {
    kind: "steam-publisher-key",
    now,
  });
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

export { STEAM_ID };

// ── the platform apps listing (A-16) ────────────────────────────────────────────────────────

export interface PlatformSteamOptions {
  env: Env;
  db: Db;
  actor: PlatformEventActor;
  use: string;
  now: number;
  refresh?: boolean;
}

/** At most this many apps are kept from Steam's answer. */
export const MAX_STEAM_APPS = 1000;

/** The apps the group key may query, from Steam (uncached). Throws `StoreUnavailable`. */
async function fetchSteamApps(
  o: PlatformSteamOptions,
): Promise<PlatformStoreApp[]> {
  const cred = await openPlatformCredential(
    o.env,
    o.db,
    STEAM_PLATFORM_CREDENTIAL,
    o.use,
    { team: o.actor },
    o.now,
  );
  if (!cred) throw new StoreUnavailable("steam credential", 401);
  const res = await storeJson(
    steamUrl("/ISteamApps/GetPartnerAppListForWebAPIKey/v2/", {
      key: cred.value.key,
    }),
    { method: "GET", headers: { accept: "application/json" } },
    "steam GetPartnerAppListForWebAPIKey",
  );
  const applist = res.body?.applist as { apps?: { app?: unknown } } | undefined;
  const list = applist?.apps?.app;
  const out: PlatformStoreApp[] = [];
  for (const a of Array.isArray(list) ? list.slice(0, MAX_STEAM_APPS) : []) {
    const r = a as Record<string, unknown>;
    const appId =
      typeof r.appid === "number" ? String(r.appid) : (r.appid as unknown);
    if (typeof appId !== "string" || !APP_ID.test(appId)) continue;
    out.push({
      appId,
      name: typeof r.app_name === "string" ? r.app_name.slice(0, 200) : null,
      pins: {},
      identifiers: {
        appType: typeof r.app_type === "string" ? r.app_type : null,
      },
      status: {
        source: "steam",
        lastUpdate: typeof r.last_update === "number" ? r.last_update : null,
      },
    });
  }
  return out;
}

/**
 * The apps the platform's Steam group key may query, plus the operator-entered `steam.appIds`
 * (added when Steam does not list them, and the whole list when the key cannot list its apps:
 * a 401/403/404 from Steam). Cached briefly; the operator list is merged on every read.
 */
export async function listPlatformSteamApps(
  o: PlatformSteamOptions,
): Promise<PlatformAppsListing> {
  const ref = await resolvePlatformCredential(
    o.env,
    o.db,
    STEAM_PLATFORM_CREDENTIAL,
  );
  if (!ref) throw new PlatformStoreNotConfigured("steam");
  const listing = await cachedPlatformApps(
    o.env,
    "steam",
    ref.version,
    o.refresh === true,
    async () => {
      let apps: PlatformStoreApp[] = [];
      let listed = true;
      try {
        apps = await fetchSteamApps(o);
        await recordPlatformCredentialResult(
          o.db,
          STEAM_PLATFORM_CREDENTIAL,
          { ok: true },
          o.now,
        );
      } catch (e) {
        const status = e instanceof StoreUnavailable ? e.status : 502;
        const message =
          e instanceof StoreUnavailable
            ? `Steam GetPartnerAppListForWebAPIKey: HTTP ${status}`
            : "Steam app listing failed";
        await recordPlatformCredentialResult(
          o.db,
          STEAM_PLATFORM_CREDENTIAL,
          { ok: false, error: message },
          o.now,
        );
        // A key without the listing permission still serves the operator-entered apps.
        if (status !== 401 && status !== 403 && status !== 404)
          throw new PlatformStoreUnavailable("steam", status, message);
        listed = false;
      }
      return {
        store: "steam",
        source: ref.source,
        fetchedAt: o.now,
        truncated: false,
        apps,
        ...(listed ? {} : { listed: false }),
      };
    },
  );
  const entered = (
    await resolvePlatformStoreSetting(o.env, o.db, "steam.appIds")
  )?.value.split(",");
  const known = new Set(listing.apps.map((a) => a.appId));
  const apps = [...listing.apps];
  for (const id of entered ?? [])
    if (!known.has(id)) {
      known.add(id);
      apps.push({
        appId: id,
        name: null,
        pins: {},
        identifiers: { appType: null },
        status: { source: "operator" },
      });
    }
  return { ...listing, apps };
}

// ── the live check (UX-69, SETUP.md D42) ────────────────────────────────────────────────────

/**
 * Check an unsaved Steamworks publisher key with the one read the listing already makes,
 * `ISteamApps/GetPartnerAppListForWebAPIKey/v2` (read-only, on the publisher host). The key rides
 * in the query string, so no error here ever carries the URL (`http.ts`). Steam answers 403 for a
 * key it does not know or one that is not a publisher key.
 */
export async function checkSteamPublisherKey(o: {
  cred: TransientOutletCredential<"steam-publisher-key">;
  /** The app ids products are assigned on this connection. */
  assigned: readonly string[];
}): Promise<CredentialCheck> {
  let res;
  try {
    res = await storeJson(
      steamUrl("/ISteamApps/GetPartnerAppListForWebAPIKey/v2/", {
        key: o.cred.reveal().key,
      }),
      { method: "GET", headers: { accept: "application/json" } },
      "steam GetPartnerAppListForWebAPIKey",
      [401, 403, 404],
    );
  } catch (e) {
    return storeUnavailable(
      "Steam",
      e instanceof StoreUnavailable ? e.status : 0,
    );
  }
  if (res.status !== 200)
    return checked(
      "invalid",
      "rejected",
      "Steam did not accept this as a publisher Web API key",
      "Use the key from Steamworks → Users & Permissions → Manage Groups → your group → Web API key. A personal key from steamcommunity.com/dev/apikey cannot reach the publisher API.",
      [],
      { status: res.status },
    );
  const applist = res.body?.applist as { apps?: { app?: unknown } } | undefined;
  const list = Array.isArray(applist?.apps?.app) ? applist.apps.app : [];
  const apps = list
    .slice(0, MAX_STEAM_APPS)
    .map((a) => a as Record<string, unknown>)
    .map((r) => ({
      appId: typeof r.appid === "number" ? String(r.appid) : r.appid,
      name: typeof r.app_name === "string" ? r.app_name.slice(0, 80) : null,
      type: r.app_type,
    }))
    .filter(
      (a): a is { appId: string; name: string | null; type: unknown } =>
        typeof a.appId === "string" && APP_ID.test(a.appId),
    );
  const games = apps.filter((a) => a.type === "game");
  const facts: CheckFact[] = [{ label: "Apps", value: String(apps.length) }];
  const names = (games.length > 0 ? games : apps)
    .map((a) => a.name)
    .filter((n): n is string => n !== null)
    .slice(0, 3);
  if (names.length > 0)
    facts.push({ label: "First apps", value: names.join(", ") });
  const seen = new Set(apps.map((a) => a.appId));
  const hidden = o.assigned.filter((id) => !seen.has(id));
  if (hidden.length > 0) return hiddenAssignedApps(hidden, facts, "key");
  if (apps.length === 0)
    return checked(
      "warning",
      "permission",
      "Steam accepted the key, but its group reaches no apps",
      "Add your apps to the group in Steamworks → Users & Permissions → Manage Groups, or enter their app ids under Account below.",
      facts,
    );
  return checked(
    "valid",
    "ok",
    `Publisher key · ${appCount(apps.length)}`,
    null,
    facts,
  );
}

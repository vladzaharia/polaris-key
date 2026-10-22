/**
 * The Steam publisher-key custody and the platform apps listing (A-16, UX-69): the store-client
 * half of the Steam commerce bridge, shared by Commerce (ticket and ownership checks,
 * `services/commerce/steam.ts`) and Distribution's Steam storefront (P0-27a, CM-29). It imports
 * no service, so both reach it without reaching each other.
 *
 * The platform group key (`steam.publisher-key`: console credential, else
 * `PLATFORM_STEAM_PUBLISHER_KEY`) is opened through `openPlatformCredential`, which refuses a
 * product whose platform pin is not the game's app id. `listPlatformSteamApps` lists the apps the
 * group key may query (`ISteamApps/GetPartnerAppListForWebAPIKey/v2`) plus the operator-entered
 * `steam.appIds`.
 */

import { channelLabel } from "@polaris-key/manifest";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  openOutletCredential,
  type TransientOutletCredential,
} from "../../outletCredentials.js";
import {
  openPlatformCredential,
  parsePlatformCredentialHandle,
  recordPlatformCredentialResult,
  resolvePlatformCredential,
} from "../../platformCredentials.js";
import type { PlatformEventActor } from "../../ops/platformEvents.js";
import { resolvePlatformStoreSetting } from "../../platformStoreSettings.js";
import { StoreUnavailable, storeJson } from "../http.js";
import {
  appCount,
  checked,
  hiddenAssignedApps,
  storeUnavailable,
  type CheckFact,
  type CredentialCheck,
} from "../credentialCheck.js";
import {
  cachedPlatformApps,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
  type PlatformAppsListing,
  type PlatformStoreApp,
} from "../platformApps.js";

/** The platform credential the fallback uses (A-16). */
export const STEAM_PLATFORM_CREDENTIAL = "steam.publisher-key" as const;

export const STEAM_PARTNER_API = "https://partner.steam-api.com";

const APP_ID = /^[1-9][0-9]{0,9}$/;

export function isSteamAppId(v: unknown): v is string {
  return typeof v === "string" && APP_ID.test(v);
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

export function steamUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, STEAM_PARTNER_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (url.origin !== STEAM_PARTNER_API)
    throw new Error("refusing a Steam call elsewhere");
  return url.toString();
}

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
      channelLabel("steam"),
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

/**
 * The commerce bridge's operator settings (P6-01): which store app each store's purchases must
 * belong to, and how a store's notifications authenticate. One JSON object in
 * `dist_connector_settings` under connector `commerce` (`connectors/settings.ts` stores it; this
 * module owns the shape). Written only by Distribution's admin API (platform admin, audited); no
 * manifest field reaches it — a repo push must never decide which app's purchases unlock a flag,
 * or whose push messages are believed.
 *
 *   appStore: { bundleId, appAppleId?, acceptSandbox? }
 *   play:     { packageName, pushAudience, pushServiceAccount, acceptTestPurchases? }
 *   steam:    { appId }
 *
 * A store whose block is absent (or invalid on read) is OFF: its claim answers Core's not-found
 * and its hook answers not-found, exactly like a product without Distribution.
 *
 * `acceptSandbox` / `acceptTestPurchases` default to false: a production deployment refuses App
 * Store `Sandbox` transactions and Play licence-tester purchases (`purchaseType` 0), so a sandbox
 * purchase can never unlock a production licence. App Store `Xcode` (StoreKit Testing) is refused
 * always (S-09). Turn them on only for a staging product.
 */

import type { Db } from "../../../core/platform.js";
import {
  readConnectorSettings,
  writeConnectorSettings,
} from "../connectors/settings.js";

export const COMMERCE_SETTINGS = "commerce";

export interface AppStoreSettings {
  bundleId: string;
  /** The app's numeric Apple ID; checked against Production notifications when set. */
  appAppleId: number | null;
  acceptSandbox: boolean;
}

export interface PlaySettings {
  packageName: string;
  /** The push subscription's OIDC audience. `null`: the platform's Google Play connection
   *  setting `pushAudience` applies (A-16); with neither, RTDN is off. */
  pushAudience: string | null;
  /** The push subscription's service-account email (the JWT's `email`). `null`: the platform's
   *  `pushServiceAccount` applies (A-16); with neither, RTDN is off. */
  pushServiceAccount: string | null;
  acceptTestPurchases: boolean;
}

export interface SteamSettings {
  /** The base game's app id (the ticket's `appid`). */
  appId: string;
}

export interface CommerceSettings {
  appStore: AppStoreSettings | null;
  play: PlaySettings | null;
  steam: SteamSettings | null;
}

/** An iOS/macOS bundle id. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
/** An Android package name (the Play connector's rule). */
const PACKAGE_NAME =
  /^(?=.{1,255}$)[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
const STEAM_APP_ID = /^[1-9][0-9]{0,9}$/;

type Field = { ok: true } | { ok: false; field: string; message: string };

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseAppStore(
  v: unknown,
): { value: AppStoreSettings } | { field: string; message: string } {
  const o = obj(v);
  if (!o) return { field: "appStore", message: "appStore must be an object" };
  if (typeof o.bundleId !== "string" || !BUNDLE_ID.test(o.bundleId))
    return {
      field: "appStore.bundleId",
      message: "bundleId must be the app's bundle id",
    };
  let appAppleId: number | null = null;
  if (o.appAppleId !== undefined && o.appAppleId !== null) {
    if (
      typeof o.appAppleId !== "number" ||
      !Number.isSafeInteger(o.appAppleId) ||
      o.appAppleId <= 0
    )
      return {
        field: "appStore.appAppleId",
        message: "appAppleId must be the app's numeric Apple ID",
      };
    appAppleId = o.appAppleId;
  }
  if (o.acceptSandbox !== undefined && typeof o.acceptSandbox !== "boolean")
    return {
      field: "appStore.acceptSandbox",
      message: "acceptSandbox must be a boolean",
    };
  return {
    value: {
      bundleId: o.bundleId,
      appAppleId,
      acceptSandbox: o.acceptSandbox === true,
    },
  };
}

function parsePlay(
  v: unknown,
): { value: PlaySettings } | { field: string; message: string } {
  const o = obj(v);
  if (!o) return { field: "play", message: "play must be an object" };
  if (typeof o.packageName !== "string" || !PACKAGE_NAME.test(o.packageName))
    return {
      field: "play.packageName",
      message: "packageName must be the app's package name",
    };
  // A-16: both push fields may be omitted (or null) to use the platform's Google Play settings.
  const pushAudience = o.pushAudience ?? null;
  const pushServiceAccount = o.pushServiceAccount ?? null;
  if (
    pushAudience !== null &&
    (typeof pushAudience !== "string" ||
      pushAudience.length === 0 ||
      pushAudience.length > 500)
  )
    return {
      field: "play.pushAudience",
      message: "pushAudience must be the push subscription's audience",
    };
  if (
    pushServiceAccount !== null &&
    (typeof pushServiceAccount !== "string" || !EMAIL.test(pushServiceAccount))
  )
    return {
      field: "play.pushServiceAccount",
      message:
        "pushServiceAccount must be the push subscription's service-account email",
    };
  if (
    o.acceptTestPurchases !== undefined &&
    typeof o.acceptTestPurchases !== "boolean"
  )
    return {
      field: "play.acceptTestPurchases",
      message: "acceptTestPurchases must be a boolean",
    };
  return {
    value: {
      packageName: o.packageName,
      pushAudience,
      pushServiceAccount,
      acceptTestPurchases: o.acceptTestPurchases === true,
    },
  };
}

function parseSteam(
  v: unknown,
): { value: SteamSettings } | { field: string; message: string } {
  const o = obj(v);
  if (!o) return { field: "steam", message: "steam must be an object" };
  const appId = typeof o.appId === "number" ? String(o.appId) : o.appId;
  if (typeof appId !== "string" || !STEAM_APP_ID.test(appId))
    return {
      field: "steam.appId",
      message: "appId must be the game's Steam app id",
    };
  return { value: { appId } };
}

/** Validate a full settings object from the admin API. `null` for a store turns it off. */
export function validateCommerceSettings(
  raw: unknown,
): { ok: true; value: CommerceSettings } | (Field & { ok: false }) {
  const o = obj(raw);
  if (!o)
    return { ok: false, field: "body", message: "settings must be an object" };
  for (const k of Object.keys(o))
    if (k !== "appStore" && k !== "play" && k !== "steam")
      return { ok: false, field: k, message: `unknown store ${k}` };
  const out: CommerceSettings = { appStore: null, play: null, steam: null };
  if (o.appStore !== undefined && o.appStore !== null) {
    const r = parseAppStore(o.appStore);
    if (!("value" in r)) return { ok: false, ...r };
    out.appStore = r.value;
  }
  if (o.play !== undefined && o.play !== null) {
    const r = parsePlay(o.play);
    if (!("value" in r)) return { ok: false, ...r };
    out.play = r.value;
  }
  if (o.steam !== undefined && o.steam !== null) {
    const r = parseSteam(o.steam);
    if (!("value" in r)) return { ok: false, ...r };
    out.steam = r.value;
  }
  return { ok: true, value: out };
}

/** The stored settings, normalised: a block that no longer validates reads as off. */
export async function readCommerceSettings(
  db: Db,
  product: string,
): Promise<CommerceSettings> {
  const stored = await readConnectorSettings(db, product, COMMERCE_SETTINGS);
  const v = stored?.value ?? {};
  const pick = <T>(
    r: { value: T } | { field: string; message: string },
  ): T | null => ("value" in r ? r.value : null);
  return {
    appStore: v.appStore ? pick(parseAppStore(v.appStore)) : null,
    play: v.play ? pick(parsePlay(v.play)) : null,
    steam: v.steam ? pick(parseSteam(v.steam)) : null,
  };
}

export function writeCommerceSettings(
  db: Db,
  product: string,
  value: CommerceSettings,
  by: string,
  now: number,
): Promise<void> {
  return writeConnectorSettings(
    db,
    product,
    COMMERCE_SETTINGS,
    value as unknown as Record<string, unknown>,
    by,
    now,
  );
}

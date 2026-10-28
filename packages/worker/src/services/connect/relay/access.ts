/**
 * What the relay routes ask before a ticket is issued and again before a socket is admitted
 * (CC-07.3; plans/CC-01-cloud-connect.md §2.7, §2.9; WIRE-CONTRACT-V5 §15.7): the product's relay
 * switch, the deployment's pause, the product's month ceiling and total, and a person's relay
 * bytes per UTC day. The one reader of `cloudConnect.relay.enabled`,
 * `cloudConnect.ceiling.relayBytes`, `cloudConnect.relayPaused` and
 * `cloudConnect.quota.defaultRelayBytes`.
 *
 * A person's day comes from the `pkey.cloudConnect.relayBytes` entitlement on the device's anchor
 * licence; without it, the platform default; a device with no usable licence gets the unlicensed
 * floor. The value is clamped to the 4 GiB per-person ceiling. The LAN is never metered.
 */

import {
  CLOUD_CONNECT_CEILINGS,
  CLOUD_CONNECT_DEFAULTS,
} from "@polaris-key/catalog";
import { deviceLicence } from "../../../core/accounts/syncAccess.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { DeviceRow } from "../../../core/repo.js";
import { resolveProductSetting } from "../../../core/settings/resolve.js";
import { platformSetting } from "../../../core/settings/platformRead.js";
import { clampDayBytes } from "./engine.js";

/** The entitlement a tier, a licence override or an add-on sets (plans/CC-01 §2.9). */
export const CONNECT_RELAY_BYTES_ENTITLEMENT = "pkey.cloudConnect.relayBytes";

/** A ticket lives this long (V5 §15.7); the engine assumes the same. */
export const RELAY_TICKET_TTL_SECONDS = 60;

/** `Retry-After` of `relay_paused`. */
export const RELAY_PAUSED_RETRY_AFTER_SECONDS = 300;

const DAY_SECONDS = 86_400;

export interface RelayProductState {
  /** `cloudConnect.relay.enabled` for this product. */
  enabled: boolean;
  /** `cloudConnect.relayPaused` on this deployment. */
  paused: boolean;
  /** The product's relay bytes per UTC month, clamped to the 500 GiB ceiling. */
  monthCeiling: number;
  /** The product's month total has reached the ceiling. */
  productOver: boolean;
}

/** The first and last UTC day (`YYYY-MM-DD`, the second exclusive) of the month holding `now`. */
function monthBounds(now: number): { from: string; to: string } {
  const d = new Date(Math.floor(now / DAY_SECONDS) * DAY_SECONDS * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  return { from: day(Date.UTC(y, m, 1)), to: day(Date.UTC(y, m + 1, 1)) };
}

async function productSetting(
  ctx: ServiceContext,
  key: string,
): Promise<unknown> {
  if (!ctx.settings) return undefined;
  const r = await resolveProductSetting(
    { env: ctx.env, db: ctx.db, registry: ctx.settings },
    ctx.product.slug,
    key,
    { now: ctx.now },
  );
  return r?.value;
}

/** The switch, the pause and the month, read fresh. Fails closed on an unreadable pause. */
export async function relayProductState(
  ctx: ServiceContext,
): Promise<RelayProductState> {
  const { env, db, product, now } = ctx;
  const enabledValue = await productSetting(ctx, "cloudConnect.relay.enabled");
  const ceilingValue = await productSetting(
    ctx,
    "cloudConnect.ceiling.relayBytes",
  );
  const monthCeiling = Math.min(
    typeof ceilingValue === "number" &&
      Number.isFinite(ceilingValue) &&
      ceilingValue >= 0
      ? Math.floor(ceilingValue)
      : CLOUD_CONNECT_CEILINGS.perProduct.relayBytesPerMonth,
    CLOUD_CONNECT_CEILINGS.perProduct.relayBytesPerMonth,
  );
  const { from, to } = monthBounds(now);
  const row = await db.first<{ b: number | null }>(
    "SELECT COALESCE(SUM(bytes), 0) AS b FROM connect_relay_daily WHERE product = ? AND day >= ? AND day < ?",
    product.slug,
    from,
    to,
  );
  return {
    enabled: enabledValue !== false,
    paused:
      (await platformSetting(env, db, "cloudConnect.relayPaused")) === "on",
    monthCeiling,
    productOver: (row?.b ?? 0) >= monthCeiling,
  };
}

/** The person's relay bytes per UTC day, as the device's licence and the platform resolve them. */
export async function relayDayBytes(
  ctx: ServiceContext,
  device: DeviceRow,
): Promise<number> {
  const { env, db, product, now } = ctx;
  const licenseOff = !product.services.license.enabled;
  const { licensed, entitlements } = await deviceLicence(
    db,
    product.slug,
    device,
    now,
  );
  if (!licenseOff && !licensed)
    return CLOUD_CONNECT_DEFAULTS.unlicensedRelayBytesPerDay;
  const grant = licenseOff
    ? null
    : entitlements[CONNECT_RELAY_BYTES_ENTITLEMENT];
  const bytes =
    typeof grant === "number" && Number.isSafeInteger(grant) && grant >= 0
      ? grant
      : await platformSetting(env, db, "cloudConnect.quota.defaultRelayBytes");
  return clampDayBytes(bytes);
}

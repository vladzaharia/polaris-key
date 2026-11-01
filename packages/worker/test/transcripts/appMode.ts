// Shared setup for the tests of the device-code app mode (UK-42.22, WIRE-CONTRACT-V5 §12.10.1).

import { expect } from "vitest";
import type { World } from "./recorder.js";
import { DEVICE, T0 } from "./client.js";
import { PRODUCT } from "./world.js";
import { upsertDevice } from "../../src/core/devices/store.js";
import {
  platformIdentityWorld,
  PLAYER,
  playerSignsIn,
  postJson,
  START,
  type Started,
} from "./scenarios/identity.js";

export const POLL = `/${PRODUCT}/identity/auth/device/poll`;
export const CHOICE = `/${PRODUCT}/identity/choice`;
export const VERIFIED = { ...PLAYER, email_verified: true };

/** Start (default: app mode), sign in at the IdP and approve; returns the flow and the page. */
export async function signedIn(
  w: World,
  extra: Record<string, unknown> = { licenseChoice: "app" },
  deviceName?: string,
): Promise<{ started: Started; page: string }> {
  const res = await postJson(w, T0, START, {
    deviceId: DEVICE,
    ...(deviceName ? { deviceName } : {}),
    ...extra,
  });
  expect(res.status).toBe(200);
  const started = (await res.json()) as Started;
  const page = await playerSignsIn(
    w,
    T0 + 3,
    started.verificationUriComplete,
    "approve",
    VERIFIED,
  );
  return { started, page };
}

/** A platform product whose policy grants this person nothing: the poll answers `choose`. */
export async function noGrantWorld(): Promise<World> {
  const w = await platformIdentityWorld();
  await w.db.run(
    "UPDATE oidc_config SET group_role_map_json = ? WHERE product = ?",
    JSON.stringify({}),
    PRODUCT,
  );
  return w;
}

export function pollDevice(
  w: World,
  s: Started,
  now: number,
): Promise<Response> {
  return postJson(w, now, POLL, { deviceCode: s.deviceCode, deviceId: DEVICE });
}

/**
 * Give the signed-in account a FULL licence `lic_full` (a seat limit of one, taken by another
 * device), so a card or same-device grant would offer Replace on it. Call after the sign-in.
 */
export async function seedFullLicense(w: World): Promise<void> {
  const account = await w.db.first<{ account_id: string }>(
    "SELECT account_id FROM account_links WHERE kind = 'oidc' AND subject = ?",
    PLAYER.sub,
  );
  expect(account).toBeTruthy();
  await w.db.run(
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
     expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
     modified_by, modified_at, account_id)
   VALUES (?, 'lic_full', 'active', NULL, 'Full', NULL, NULL, NULL, ?, NULL, NULL, '{}', NULL, NULL, NULL, NULL, ?, ?)`,
    PRODUCT,
    T0,
    T0,
    account!.account_id,
  );
  await w.db.run(
    "UPDATE products SET default_device_limit = 1 WHERE slug = ?",
    PRODUCT,
  );
  await upsertDevice(w.db, {
    product: PRODUCT,
    device_id: "other-device",
    customer_id: null,
    license_id: "lic_full",
    status: "authorized",
    first_seen: T0,
    last_seen: T0,
    ua: null,
    label: "Other PC",
    overrides_json: null,
    reported_json: null,
    token_hash: null,
  });
  await w.db.run(
    "UPDATE devices SET seat_no = 1 WHERE product = ? AND device_id = 'other-device'",
    PRODUCT,
  );
}

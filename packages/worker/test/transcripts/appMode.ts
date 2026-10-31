// Shared setup for the tests of the device-code app mode (UK-42.22, WIRE-CONTRACT-V5 §12.10.1).

import { expect } from "vitest";
import type { World } from "./recorder.js";
import { DEVICE, T0 } from "./client.js";
import { PRODUCT } from "./world.js";
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

/// <reference types="@cloudflare/workers-types" />
// activate-enroll-deactivate: the licence service's mint and release paths (wire contract v3
// §5–§6) — activation with a key, keyless enrolment on a free tier, and deactivation, whose
// remote half is best-effort while the local wipe is mandatory.

import { expect } from "vitest";
import { TranscriptRecorder, type StepRecorder } from "../recorder.js";
import {
  DEVICE,
  document,
  FINGERPRINT,
  FINGERPRINT_EXPECT,
  syncReport,
  T0,
  trust,
  VERSION,
} from "../client.js";
import {
  enforced,
  LICENSED,
  offerEnrollment,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  setup,
  type Scenario,
} from "../world.js";
import { seedLicenseWithKey } from "../../seed.js";
import { retireDeviceBinding } from "../../../src/core/devices.js";
import { hashKey } from "../../../src/crypto.js";

/** The sync an acquisition triggers: forced, so no ETag rides along. */
async function acquisitionSync(
  s: StepRecorder,
  values: {
    config: Record<string, unknown>;
    entitlements: Record<string, unknown>;
  },
): Promise<void> {
  await trust(s, PRODUCT);
  expect((await document(s, PRODUCT, "license")).status).toBe(200);
  expect((await document(s, PRODUCT, "config")).status).toBe(200);
  expect((await syncReport(s, PRODUCT, values)).status).toBe(200);
}

export const activateEnrollDeactivate: Scenario = {
  id: "activate-enroll-deactivate",
  record: () =>
    pinned("activate-enroll-deactivate", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key } = await seedLicense(world);
      await offerEnrollment(world);
      const r = new TranscriptRecorder({
        id: "activate-enroll-deactivate",
        description:
          "The licence mint and release paths. Activation exchanges a licence key (plus a hashed fingerprint) for a device token and syncs; deactivation releases the seat and wipes the client; keyless enrolment on the product's free tier mints a token and syncs; and a deactivation the server refuses (the device was already deauthorized from the console, so the token 401s) still wipes the client, because the remote half is best-effort and the local half is not.",
        features: ["license.activate", "license.enroll", "license.deactivate"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      await r.step(
        {
          action: "activate",
          args: { key },
          note: "Key activation, then the sync it triggers.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
            capture: { token: "$.token" },
          });
          expect(res.status).toBe(200);
          await acquisitionSync(s, {
            config: { "ui.theme": "dark" },
            entitlements: { polarisVpn: true },
          });
        },
        { result: "ok", licenseStatus: "ok", tokenHeld: true },
      );

      await r.step(
        {
          action: "deactivate",
          now: T0 + 60,
          note: "The server releases the seat.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/deauthorize`,
            bearer: "token",
          });
          expect(res.status).toBe(200);
        },
        { licenseStatus: "needs-activation", tokenHeld: false },
      );

      await r.step(
        {
          action: "enroll",
          now: T0 + 120,
          note: "Keyless enrolment on the free tier, then the sync it triggers.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/enroll`,
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
            capture: { token: "$.token" },
          });
          expect(res.status).toBe(200);
          await acquisitionSync(s, { config: {}, entitlements: {} });
        },
        { result: "ok", licenseStatus: "ok", tokenHeld: true },
      );

      // The owner deauthorizes this device from the console: its row is retired and its token
      // record purged, so the device's own deauthorize will be refused.
      await retireDeviceBinding(
        world.env,
        world.db,
        PRODUCT,
        DEVICE,
        await hashKey(r.bindings.token!, world.env.KEY_HASH_PEPPER),
      );
      await r.step(
        {
          action: "deactivate",
          now: T0 + 180,
          note: "The server refuses (401); the client wipes itself anyway.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/deauthorize`,
            bearer: "token",
          });
          expect(res.status).toBe(401);
        },
        { licenseStatus: "needs-activation", tokenHeld: false },
      );
      return r.transcript();
    }),
};

/** The device that already holds the only seat in `license-device-limit`. */
const OCCUPANT = "TRANSCRIPTOCCUPANT00000000000001";

export const licenseDeviceLimit: Scenario = {
  id: "license-device-limit",
  record: () =>
    pinned("license-device-limit", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key, licenseId } = await seedLicenseWithKey(world.db, PRODUCT, {
        entitlements: { deviceLimit: enforced(1) },
      });
      // Another device takes the only seat, outside the recording.
      const occupied = await setup(world, "POST", `/${PRODUCT}/license/activate`, {
        authorization: `Bearer ${key}`,
        "x-pkey-device": OCCUPANT,
      });
      expect(occupied.status).toBe(200);

      const r = new TranscriptRecorder({
        id: "license-device-limit",
        description:
          "The seat refusal's portal link (PX-W8, WIRE-CONTRACT-V4 §5.3). Every seat is taken, so activation is refused with `device_limit`, which carries `manageUrl`: for a floating licence the portal's activate page, then free-device; once the licence is attached to an account, the free-device flow for that licence; and, with the product's portal off, no link at all. `for` is the coarse platform-and-arch label from the request's metadata. The link is never an auth failure: the client holds no token and wipes nothing.",
        features: ["license.activate", "license.manage"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      const refused = (s: StepRecorder) =>
        s.send({
          method: "POST",
          path: `/${PRODUCT}/license/activate`,
          bearer: "key",
          body: FINGERPRINT,
          expectBody: FINGERPRINT_EXPECT,
        });

      await r.step(
        {
          action: "activate",
          args: { key },
          note: "A floating licence: the link opens activate, then free-device.",
        },
        async (s) => {
          const res = await refused(s);
          expect(res.status).toBe(403);
        },
        {
          result: "device-limit",
          manageUrl: `https://key.plrs.im/activate?product=${PRODUCT}&next=free-device&for=Linux%20x86_64`,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );

      await world.db.run(
        "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
        "acct_transcript",
        PRODUCT,
        licenseId,
      );
      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 60,
          note: "The licence is attached to an account: the link opens free-device for it.",
        },
        async (s) => {
          const res = await refused(s);
          expect(res.status).toBe(403);
        },
        {
          result: "device-limit",
          manageUrl: `https://key.plrs.im/#/p/${PRODUCT}/free-device?license=${licenseId}&for=Linux%20x86_64`,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );

      await world.db.run(
        `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
         VALUES (?, 0, ?, ?)`,
        PRODUCT,
        T0,
        T0,
      );
      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 120,
          note: "The product's portal is off: the refusal carries no link.",
        },
        async (s) => {
          const res = await refused(s);
          expect(res.status).toBe(403);
        },
        {
          result: "device-limit",
          manageUrl: null,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );
      return r.transcript();
    }),
};

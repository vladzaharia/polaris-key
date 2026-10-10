/// <reference types="@cloudflare/workers-types" />
// activate-enroll-deactivate: the licence service's mint and release paths (wire contract v3
// §5–§6) — activation with a key, keyless enrolment on a free tier, and deactivation, whose
// remote half is best-effort while the local wipe is mandatory.
//
// activate-refusals (SP-00, plans/SP-00.md D2; SDK-PARITY-PASS §3.1): every refusal the
// activation and enrolment routes answer TODAY, each surfaced by its body code. Recorded beside
// activate-enroll-deactivate so the SDKs that implement license.activate keep replaying that one
// unchanged. Two of the plan's six refusals are not answers these routes give today, and neither
// is faked (plans/SP-00.md §8):
//
//   * `license_expired`: an expired licence's key is answered `401 unauthorized`
//     (`core/authz.ts` `authorizeDevice` refuses every unusable licence alike, deliberately). The
//     step records that answer as it is: when the Worker starts answering `license_expired`, the
//     regenerated transcript shows which SDKs must follow.
//   * `attestation_required`: activation and enrolment are not trust operations
//     (`core/deviceTrust.ts` `TrustOperation` is mint, gatedDelivery and commerceClaim), so no
//     attesting product makes them answer it. The step is dropped.
//
// The 429 carries no `Retry-After` today (`errorResponse` sets none), so nothing about a retry
// delay is asserted.

import { expect } from "vitest";
import { TranscriptRecorder, type StepRecorder } from "../recorder.js";
import {
  DEVICE,
  document,
  FINGERPRINT,
  FINGERPRINT_EXPECT,
  LABELLED_FINGERPRINT,
  LABELLED_FINGERPRINT_EXPECT,
  syncReport,
  TRANSCRIPT_DEVICE_NAME,
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
import { BASE_URL } from "../recorder.js";
import { retireDeviceBinding } from "../../../src/core/devices.js";
import { hashKey } from "../../../src/platform/crypto.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { seedLicenseWithKey } from "../../seed.js";
import type { World } from "../recorder.js";

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
          "The licence mint and release paths. Activation exchanges a licence key (plus a hashed fingerprint and the device label the SDK takes from the platform's device name, PX-W13) for a device token and syncs; deactivation releases the seat and wipes the client; keyless enrolment on the product's free tier mints a token and syncs; and a deactivation the server refuses (the device was already deauthorized from the console, so the token 401s) still wipes the client, because the remote half is best-effort and the local half is not.",
        features: ["license.activate", "license.enroll", "license.deactivate"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          deviceName: TRANSCRIPT_DEVICE_NAME,
        },
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
            body: LABELLED_FINGERPRINT,
            expectBody: LABELLED_FINGERPRINT_EXPECT,
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
      const occupied = await setup(
        world,
        "POST",
        `/${PRODUCT}/license/activate`,
        {
          authorization: `Bearer ${key}`,
          "x-pkey-device": OCCUPANT,
        },
      );
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

/** A device id other than the recorded client's, for setup the client must not inherit. */
const OTHER_DEVICE = "TRANSCRIPTDEVICE0000000000000002";

/** Setup: a fingerprinted POST outside the recording (enrolment, activation). */
async function setupWithBody(
  w: World,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  now: number,
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "x-pkey-version": VERSION,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );
}

/** A refusal: no token before, none after. */
const refused = (result: string, code: string) => ({
  result,
  code,
  tokenHeld: false,
});

export const activateRefusals: Scenario = {
  id: "activate-refusals",
  record: () =>
    pinned("activate-refusals", async (pin) => {
      const world = await productWorld(LICENSED);
      await offerEnrollment(world);
      const r = new TranscriptRecorder({
        id: "activate-refusals",
        description:
          "Every refusal the activation and enrolment routes answer today, each surfaced by its body code and never collapsed into another kind: enrolment for a machine whose free licence an account has claimed (403 enroll_claimed), then whose free licence an operator disabled (403 license_disabled); activation with an expired licence's key (today a 401 unauthorized: the Worker refuses every unusable licence alike); activation on hardware that drifted past the threshold from the seat's binding (409 hardware_mismatch); and activation once the per-client budget is spent (429 rate_limited, no Retry-After). No refusal mints a token. attestation_required is not recorded: activation and enrolment are not trust operations.",
        features: ["license.refusals"],
        requires: ["core.store", "license.activate"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      // This machine's free licence (dedupe is by the fingerprint's anchor, not the device id),
      // enrolled from another install, then claimed by an account (R3-05).
      const seeded = await setupWithBody(
        world,
        `/${PRODUCT}/license/enroll`,
        { "x-pkey-device": OTHER_DEVICE },
        FINGERPRINT,
        T0,
      );
      expect(seeded.status).toBe(200);
      await world.db.run(
        "UPDATE licenses SET sub = ? WHERE product = ? AND origin = 'enroll'",
        "transcript-account",
        PRODUCT,
      );
      await r.step(
        {
          action: "enroll",
          note: "This machine's free licence belongs to an account now: sign in instead.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/enroll`,
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(403);
          expect(((await res.json()) as { error: string }).error).toBe(
            "enroll_claimed",
          );
        },
        refused("enroll-claimed", "enroll_claimed"),
      );

      await world.db.run(
        "UPDATE licenses SET sub = NULL, status = 'disabled' WHERE product = ? AND origin = 'enroll'",
        PRODUCT,
      );
      await r.step(
        {
          action: "enroll",
          now: T0 + 60,
          note: "An operator disabled this machine's free licence.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/enroll`,
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(403);
          expect(((await res.json()) as { error: string }).error).toBe(
            "license_disabled",
          );
        },
        refused("license-disabled", "license_disabled"),
      );

      const expired = await seedLicenseWithKey(world.db, PRODUCT, {
        id: "lic_djdl_expired",
        expiresAt: T0 - 86_400,
      });
      await r.step(
        {
          action: "activate",
          args: { key: expired.key },
          now: T0 + 120,
          note: "An expired licence's key. Today's Worker answers 401 unauthorized, not license_expired.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(401);
          expect(((await res.json()) as { error: string }).error).toBe(
            "unauthorized",
          );
        },
        refused("unauthorized", "unauthorized"),
      );

      // The seat is bound to other hardware: every component the recorder presents differs.
      const { key } = await seedLicense(world);
      const bound = await setupWithBody(
        world,
        `/${PRODUCT}/license/activate`,
        { "x-pkey-device": DEVICE, authorization: `Bearer ${key}` },
        {
          fingerprint: {
            components: {
              machineUuid: "TRANSCRIPTmachineUuidX",
              boardSerial: "TRANSCRIPTboardSerialX",
              cpuModel: "TRANSCRIPTcpuModel000X",
            },
            hwid: "TRANSCRIPThwid00000000000000000X",
          },
        },
        T0 + 120,
      );
      expect(bound.status).toBe(200);
      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 180,
          note: "The hardware drifted past the threshold: re-activation is required (409, not 403).",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(409);
          expect(((await res.json()) as { error: string }).error).toBe(
            "hardware_mismatch",
          );
        },
        refused("hardware-mismatch", "hardware_mismatch"),
      );

      // Spend this client's activation budget (30 a minute per address) outside the recording.
      const late = T0 + 600;
      let spent = false;
      for (let i = 0; i < 40 && !spent; i++) {
        const res = await setup(
          world,
          "POST",
          `/${PRODUCT}/license/activate`,
          { authorization: "Bearer pkey_not_a_key" },
          late,
        );
        spent = res.status === 429;
      }
      expect(spent).toBe(true);
      await r.step(
        {
          action: "activate",
          args: { key },
          now: late,
          note: "Too many activation attempts from this client. Today's 429 carries no Retry-After.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(429);
          expect(res.headers.get("retry-after")).toBeNull();
          expect(((await res.json()) as { error: string }).error).toBe(
            "rate_limited",
          );
        },
        refused("rate-limited", "rate_limited"),
      );
      return r.transcript();
    }),
};

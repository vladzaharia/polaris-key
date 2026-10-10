/// <reference types="@cloudflare/workers-types" />
// Key entry (PX-W9, G21; WIRE-CONTRACT-V4 §12.2, plans/PX-W9.md §4): what an SDK sees when it
// activates by key on a product whose Identity toggle is on.
//
//   keyentry-limit         limit 2, refusals on: the member on every success (an enrolled
//                          re-entry included), the `key_entry_limit` refusal with its portal link
//                          once a new device meets the limit, and success again once the limit is
//                          raised.
//   keyentry-refusals-off  limit 1, refusals off: counted past the limit, never refused; a
//                          licence in an account is counted and admitted too (I-09).
//   keyentry-identity-off  Identity off: no member at all, whatever the table and the limit say.
//   keyentry-owned         I-09 (§12.2 step 3), refusals on: a licence in an account, entered
//                          again on its enrolled device (counted nothing new), then on a new
//                          one: `license_owned` with `signInUrl`, nothing counted.
//
// The limit and the switch are fixture rows (`product_settings`, `platform_settings`), written
// before the first request so the platform-settings cache never holds an older read. The other
// device's entry is a real activation outside the recording, as `license-device-limit` seeds its
// seat; only the Identity-off one is a row from an earlier period, because nothing is counted
// while Identity is off.
//
// No existing transcript changes: none of them activates by key on an Identity product, which is
// the "installs are unaffected" half of the proof.

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
  LICENSED,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  setup,
  type Scenario,
} from "../world.js";
import type { World } from "../recorder.js";
import { holdLicense, seedAccount } from "./account.js";

/** The product's services: License, Config and Identity. */
const IDENTITY_ON = servicesOn("license", "config", "identity");

/** A device other than the recorded client's, whose activation is the other key entry. */
const OTHER_DEVICE = "TRANSCRIPTKEYENTRY00000000000002";

const FEATURES = ["license.activate", "identity.keyentry"];

async function setLimit(w: World, limit: number): Promise<void> {
  await w.db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.keyEntry.limit', ?, 'console', ?, 'transcript')
     ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json`,
    PRODUCT,
    JSON.stringify(limit),
    T0,
  );
}

async function refusalsOn(w: World): Promise<void> {
  await w.db.run(
    `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
     VALUES ('KEYENTRY_REFUSALS', '"on"', 1, ?, 'transcript')`,
    T0,
  );
}

/** Setup: another device enters the same key (one counted entry on an Identity product). */
async function otherDeviceEnters(w: World, key: string): Promise<void> {
  const res = await setup(w, "POST", `/${PRODUCT}/license/activate`, {
    authorization: `Bearer ${key}`,
    "x-pkey-device": OTHER_DEVICE,
  });
  expect(res.status).toBe(200);
}

/** A key activation the Worker accepts, then the sync it triggers. */
export async function activateAndSync(
  s: StepRecorder,
  keyEntries: { used: number; limit: number } | null,
): Promise<void> {
  const res = await s.send({
    method: "POST",
    path: `/${PRODUCT}/license/activate`,
    bearer: "key",
    body: FINGERPRINT,
    expectBody: FINGERPRINT_EXPECT,
    capture: { token: "$.token" },
  });
  expect(res.status).toBe(200);
  const body = (await res.clone().json()) as Record<string, unknown>;
  if (keyEntries) expect(body.keyEntries).toEqual(keyEntries);
  else expect(body).not.toHaveProperty("keyEntries");
  await trust(s, PRODUCT);
  expect((await document(s, PRODUCT, "license")).status).toBe(200);
  expect((await document(s, PRODUCT, "config")).status).toBe(200);
  expect(
    (
      await syncReport(s, PRODUCT, {
        config: { "ui.theme": "dark" },
        entitlements: { polarisVpn: true },
      })
    ).status,
  ).toBe(200);
}

export const keyentryLimit: Scenario = {
  id: "keyentry-limit",
  record: () =>
    pinned("keyentry-limit", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key } = await seedLicense(world);
      await setLimit(world, 2);
      await refusalsOn(world);

      const r = new TranscriptRecorder({
        id: "keyentry-limit",
        description:
          "Key-entry counting on a product with Identity on (PX-W9, WIRE-CONTRACT-V4 §12.2), with a limit of 2 and refusals on. Every successful activation carries keyEntries {used, limit}: the first entry counts, and the same device entering the key again does not. Another device then enters the key and this device deactivates, so the next activation is a new device at the limit: it is refused with key_entry_limit, carrying keyEntries and manageUrl (the portal's activate page, where the key can join an account). The refusal is not an auth failure: the client keeps its state. Once the limit is raised to 3 the key activates again, and that entry is the third.",
        features: FEATURES,
        requires: ["core.store", "license.deactivate"],
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
          note: "The first key entry on a new device: counted, then the sync it triggers.",
        },
        (s) => activateAndSync(s, { used: 1, limit: 2 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 2 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 60,
          note: "The same device enters the key again: it is enrolled, so nothing is counted.",
        },
        (s) => activateAndSync(s, { used: 1, limit: 2 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 2 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await otherDeviceEnters(world, key);
      await r.step(
        {
          action: "deactivate",
          now: T0 + 120,
          note: "Another device has entered the key (the second entry); this device deactivates.",
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
          action: "activate",
          args: { key },
          now: T0 + 180,
          note: "A new device at the limit: key_entry_limit, with the portal link and the count.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(403);
          expect(await res.clone().json()).toMatchObject({
            error: "key_entry_limit",
            keyEntries: { used: 2, limit: 2 },
          });
        },
        {
          result: "key-entry-limit",
          keyEntries: { used: 2, limit: 2 },
          manageUrl: `https://key.plrs.im/activate?product=${PRODUCT}`,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );

      await setLimit(world, 3);
      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 240,
          note: "The limit is raised to 3: the key activates, and that entry is the third.",
        },
        (s) => activateAndSync(s, { used: 3, limit: 3 }),
        {
          result: "ok",
          keyEntries: { used: 3, limit: 3 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const keyentryRefusalsOff: Scenario = {
  id: "keyentry-refusals-off",
  record: () =>
    pinned("keyentry-refusals-off", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(world);
      await setLimit(world, 1);
      await otherDeviceEnters(world, key);

      const r = new TranscriptRecorder({
        id: "keyentry-refusals-off",
        description:
          "Key-entry counting with refusals off (PX-W9, WIRE-CONTRACT-V4 §12.2), the rollout default. The limit is 1 and another device has already entered the key, yet a new device activates: the entry is counted past the limit (keyEntries used 2 of 1, so a client shows none left) and never refused. The device then deactivates and the licence joins an account: its next entry is a new device's and, with refusals off, step 3 (license_owned, I-09) does not apply either, so it is counted (3 of 1) and admitted.",
        features: FEATURES,
        requires: ["core.store", "license.deactivate"],
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
          note: "Past the limit with refusals off: counted, not refused, then the sync.",
        },
        (s) => activateAndSync(s, { used: 2, limit: 1 }),
        {
          result: "ok",
          keyEntries: { used: 2, limit: 1 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      // I-09: the licence joins an account. With refusals off, step 3 does not apply either.
      await r.step(
        {
          action: "deactivate",
          now: T0 + 60,
          note: "This device deactivates, so its next entry is a new device's.",
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
      const holder = await seedAccount(world, "holder@example.com");
      await holdLicense(world, licenseId, holder.id);
      await r.step(
        {
          action: "activate",
          args: { key },
          now: T0 + 120,
          note: "The licence is now in an account: with refusals off it is still counted and admitted (I-09).",
        },
        (s) => activateAndSync(s, { used: 3, limit: 1 }),
        {
          result: "ok",
          keyEntries: { used: 3, limit: 1 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const keyentryIdentityOff: Scenario = {
  id: "keyentry-identity-off",
  record: () =>
    pinned("keyentry-identity-off", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key, licenseId } = await seedLicense(world);
      await setLimit(world, 1);
      // An entry from a period when the product ran Identity: kept, and ignored while it is off.
      await world.db.run(
        `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
         VALUES (?, ?, 'ke_transcript', 'app', ?, ?)`,
        PRODUCT,
        licenseId,
        OTHER_DEVICE,
        T0,
      );

      const r = new TranscriptRecorder({
        id: "keyentry-identity-off",
        description:
          "Key entry on a product whose Identity toggle is off (PX-W9, WIRE-CONTRACT-V4 §12.2 rule 9). The licence holds an entry from an earlier period and the stored limit is 1, but with Identity off nothing is counted or refused and the activation carries no keyEntries member: the client reports none.",
        features: FEATURES,
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
          note: "Identity off: no member, nothing counted, then the sync.",
        },
        (s) => activateAndSync(s, null),
        {
          result: "ok",
          keyEntries: null,
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      const n = await world.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM license_key_entries WHERE product = ? AND license_id = ?",
        PRODUCT,
        licenseId,
      );
      expect(n?.n).toBe(1);
      return r.transcript();
    }),
};

export const keyentryOwned: Scenario = {
  id: "keyentry-owned",
  record: () =>
    pinned("keyentry-owned", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(world);
      await refusalsOn(world);
      // This device entered the key while the licence was in no account (one counted entry);
      // then the licence joined an account.
      await setup(world, "POST", `/${PRODUCT}/license/activate`, {
        authorization: `Bearer ${key}`,
      });
      const holder = await seedAccount(world, "holder@example.com");
      await holdLicense(world, licenseId, holder.id);

      const r = new TranscriptRecorder({
        id: "keyentry-owned",
        description:
          "An owned licence never moves by key (I-09, WIRE-CONTRACT-V4 §12.2 step 3), on a product with Identity on and refusals on. The licence is in an account. The device that is enrolled on it enters the key again: admitted as before, nothing new counted. The device deactivates, so its next entry is a new device's: refused 403 license_owned with signInUrl, the product's login card, which carries no key and nothing about the account. Nothing is counted and the client keeps its state; it offers sign-in behind a user action.",
        features: FEATURES,
        requires: ["core.store", "license.deactivate"],
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
          note: "The enrolled device enters the key again: step 2 admits it, nothing is counted.",
        },
        (s) => activateAndSync(s, { used: 1, limit: 10 }),
        {
          result: "ok",
          keyEntries: { used: 1, limit: 10 },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "deactivate",
          now: T0 + 60,
          note: "This device deactivates: it is no longer enrolled.",
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
          action: "activate",
          args: { key },
          now: T0 + 120,
          note: "A new device and a licence in an account: license_owned with the sign-in link.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/activate`,
            bearer: "key",
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
          });
          expect(res.status).toBe(403);
          expect(await res.clone().json()).toEqual({
            error: "license_owned",
            message: "license is in an account",
            signInUrl: `https://key.plrs.im/signin?product=${PRODUCT}`,
          });
        },
        {
          result: "refused",
          code: "license_owned",
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );
      const n = await world.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM license_key_entries WHERE product = ? AND license_id = ?",
        PRODUCT,
        licenseId,
      );
      expect(n?.n).toBe(1);
      return r.transcript();
    }),
};

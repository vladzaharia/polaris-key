/// <reference types="@cloudflare/workers-types" />
// register-open, register-reregister-401 and telemetry-report: Core's device surfaces (wire
// contract v3 §6) — keyless registration under the `open` policy, the registered-without-licence
// device's re-registration on a 401, and allowlisted telemetry.

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import {
  DEVICE,
  document,
  etagOf,
  explicitReport,
  FINGERPRINT,
  FINGERPRINT_EXPECT,
  syncReport,
  T0,
  trust,
  VERSION,
} from "../client.js";
import {
  activated,
  CONFIG_ONLY,
  LICENSED,
  pinned,
  PRODUCT,
  productWorld,
  registered,
  seedLicense,
  type Scenario,
} from "../world.js";
import { retireDeviceBinding } from "../../../src/core/devices.js";
import { hashKey } from "../../../src/crypto.js";

const NO_VALUES = { config: {}, entitlements: {} };

export const registerOpen: Scenario = {
  id: "register-open",
  record: () =>
    pinned("register-open", async (pin) => {
      const world = await productWorld(CONFIG_ONLY);
      const r = new TranscriptRecorder({
        id: "register-open",
        description:
          "Keyless registration under the open policy (a Config-only product, D-08). register() sends no credential, only the device id and a hashed fingerprint, and stores the token it gets back; it does not sync by itself. The next sync fetches the config document alone, and the gate reports not-applicable because the product runs no licence service.",
        features: ["devices.register"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION, services: ["config"] },
      });
      await r.step(
        { action: "register" },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/devices/register`,
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
            capture: { token: "$.token" },
          });
          expect(res.status).toBe(200);
          expect(((await res.json()) as { deviceId: string }).deviceId).toBe(
            DEVICE,
          );
        },
        { result: "ok", tokenHeld: true },
      );
      await r.step(
        { action: "sync", args: { force: false }, now: T0 + 60 },
        async (s) => {
          await trust(s, PRODUCT);
          expect((await document(s, PRODUCT, "config")).status).toBe(200);
          expect((await syncReport(s, PRODUCT, NO_VALUES)).status).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { config: "applied" },
          licenseStatus: "not-applicable",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const registerReregister401: Scenario = {
  id: "register-reregister-401",
  record: () =>
    pinned("register-reregister-401", async (pin) => {
      const world = await productWorld(CONFIG_ONLY);
      const token = await registered(world);
      const r = new TranscriptRecorder({
        id: "register-reregister-401",
        description:
          "A registered device with no licence (Config-only product, open policy) re-registers on a 401 (wire contract v3 §5). After the owner deauthorizes the device, its token 401s on the config document; the client makes exactly one POST /devices/register (keyless, so no bearer) instead of POST /license/token, stores the new token and retries the document once.",
        features: ["license.reregister", "devices.register"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          token,
          version: VERSION,
          services: ["config"],
        },
      });
      let configEtag = "";
      await r.step(
        {
          action: "sync",
          args: { force: false },
          note: "A healthy first pass.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          const cfg = await document(s, PRODUCT, "config");
          expect(cfg.status).toBe(200);
          configEtag = etagOf(cfg);
          expect((await syncReport(s, PRODUCT, NO_VALUES)).status).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { config: "applied" },
          licenseStatus: "not-applicable",
          tokenHeld: true,
        },
      );

      await retireDeviceBinding(
        world.env,
        world.db,
        PRODUCT,
        DEVICE,
        await hashKey(token, world.env.KEY_HASH_PEPPER),
      );
      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 60,
          note: "The token 401s: one re-registration, then one retry with the new token.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          expect(
            (await document(s, PRODUCT, "config", configEtag)).status,
          ).toBe(401);
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/devices/register`,
            body: FINGERPRINT,
            expectBody: FINGERPRINT_EXPECT,
            capture: { token: "$.token" },
          });
          expect(res.status).toBe(200);
          expect(r.bindings.token).not.toBe(token);
          expect(
            (await document(s, PRODUCT, "config", configEtag)).status,
          ).toBe(304);
          expect((await syncReport(s, PRODUCT, NO_VALUES)).status).toBe(200);
        },
        {
          applied: false,
          unauthorized: false,
          blocked: false,
          documents: { config: "unchanged" },
          licenseStatus: "not-applicable",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const telemetryReport: Scenario = {
  id: "telemetry-report",
  record: () =>
    pinned("telemetry-report", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key } = await seedLicense(world);
      const token = await activated(world, key);
      const values = {
        config: { "ui.theme": "dark" },
        entitlements: { polarisVpn: true },
      };
      const r = new TranscriptRecorder({
        id: "telemetry-report",
        description:
          "Device telemetry carries allowlisted keys only (wire contract v3 §6). After a sync, report() posts the values of the documents the client VERIFIED (R4-05) plus host facts; any top-level key outside the Worker's report allowlist fails the replay, because the Worker would drop it without a word — the recording sends one such key to show exactly that.",
        features: ["devices.report"],
        requires: ["core.store", "core.sync"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, token, version: VERSION },
      });
      await r.step(
        { action: "sync", args: { force: false } },
        async (s) => {
          await trust(s, PRODUCT);
          expect((await document(s, PRODUCT, "license")).status).toBe(200);
          expect((await document(s, PRODUCT, "config")).status).toBe(200);
          expect((await syncReport(s, PRODUCT, values)).status).toBe(200);
        },
        {
          applied: true,
          documents: { license: "applied", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      await r.step(
        { action: "report", now: T0 + 60 },
        async (s) => {
          const res = await explicitReport(s, PRODUCT, values, {
            serialNumber: "C02XK0000000",
          });
          expect(res.status).toBe(200);
          const row = await world.db.first<{ reported_json: string }>(
            "SELECT reported_json FROM devices WHERE product = ? AND device_id = ?",
            PRODUCT,
            DEVICE,
          );
          const stored = JSON.parse(row!.reported_json) as Record<
            string,
            unknown
          >;
          expect(stored.entitlements).toEqual(values.entitlements);
          expect(stored).not.toHaveProperty("serialNumber");
        },
        { result: true },
      );
      return r.transcript();
    }),
};

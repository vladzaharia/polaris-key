/// <reference types="@cloudflare/workers-types" />
// register-open, register-reregister-401 and telemetry-report: Core's device surfaces (wire
// contract v3 §6) — keyless registration under the `open` policy, the registered-without-licence
// device's re-registration on a 401, and allowlisted telemetry.
//
// boot-cold-register (SP-00, `ui.boot`): the one-call boot of a fresh install on a product whose
// registration is open — discovery, registration, then the sync pass (trust, the documents the
// product runs, the report) — ending at the stage machine's terminal outcome
// (conformance/corpus/v2/stage-matrix.json). Open registration is the D-08 shape, a product
// WITHOUT License (`core/services.ts` `resolveRegistration`; the boot registers only there,
// Godot `PKeyBootHost.registration_open`), so the documents are the config document alone and the
// gate reports `not-applicable`, which passes the gate (stage-matrix "ready — not-applicable passes
// the gate"). A licensed product never registers at boot: its device mints through activation.
//
// telemetry-report-updates (SP-00, `telemetry.updates`): the update journal's events (P6-03) on
// the device report, at most 16 per report (`core/updateHealth.ts` `MAX_UPDATE_EVENTS`, Godot
// `PKeyUpdater.pending_events`). Seventeen journalled events take two reports.

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import type { JsonValue } from "../format.js";
import {
  boot,
  DEVICE,
  document,
  etagOf,
  explicitReport,
  LABELLED_FINGERPRINT,
  LABELLED_FINGERPRINT_EXPECT,
  REPORT_ALLOWED_KEYS,
  TRANSCRIPT_DEVICE_NAME,
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
          "Keyless registration under the open policy (a Config-only product, D-08). register() sends no credential, only the device id, a hashed fingerprint and the device label (PX-W13), and stores the token it gets back; it does not sync by itself. The next sync fetches the config document alone, and the gate reports not-applicable because the product runs no licence service.",
        features: ["devices.register"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["config"],
          deviceName: TRANSCRIPT_DEVICE_NAME,
        },
      });
      await r.step(
        { action: "register" },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/devices/register`,
            body: LABELLED_FINGERPRINT,
            expectBody: LABELLED_FINGERPRINT_EXPECT,
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
          deviceName: TRANSCRIPT_DEVICE_NAME,
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
            body: LABELLED_FINGERPRINT,
            expectBody: LABELLED_FINGERPRINT_EXPECT,
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

export const bootColdRegister: Scenario = {
  id: "boot-cold-register",
  record: () =>
    pinned("boot-cold-register", async (pin) => {
      const world = await productWorld(CONFIG_ONLY);
      const r = new TranscriptRecorder({
        id: "boot-cold-register",
        description:
          "The one-call boot of a fresh install (no token, nothing cached) on a product whose registration is open (Config only, D-08). boot() fetches discovery, finds registration open and no token held, registers keylessly with a hashed fingerprint and stores the token, then runs its sync pass: the trust manifest, the config document (the product runs no licence service) and the report. The stage machine ends at its terminal outcome, ready: the gate's not-applicable passes, Update is off so nothing is decided, and no content stamp means nothing is fetched or mounted.",
        features: ["ui.boot"],
        requires: ["core.store", "core.discover", "devices.register"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION, services: ["config"] },
      });
      await r.step({ action: "boot", args: {} }, (s) => boot(s, PRODUCT), {
        bootOutcome: "ready",
        licenseStatus: "not-applicable",
        tokenHeld: true,
      });
      return r.transcript();
    }),
};

/** The update events a P6-03 journal holds, oldest first: `n` well-formed entries. */
function journal(n: number): Array<Record<string, JsonValue>> {
  const events = [
    "update_offered",
    "update_downloaded",
    "update_applied",
    "update_confirmed",
  ];
  return Array.from({ length: n }, (_, i) => ({
    eventId: `transcript-${String(i + 1).padStart(2, "0")}`,
    event: events[i % events.length]!,
    deliverable: "app",
    release: "v1.1.0",
    fromRelease: "v1.0.0",
    outlet: "direct",
    channel: "stable",
    at: T0 - 3600 + i * 60,
  }));
}

/** The per-report cap (`core/updateHealth.ts` `MAX_UPDATE_EVENTS`). */
const MAX_UPDATES_PER_REPORT = 16;

export const telemetryReportUpdates: Scenario = {
  id: "telemetry-report-updates",
  record: () =>
    pinned("telemetry-report-updates", async (pin) => {
      const world = await productWorld(LICENSED);
      const { key } = await seedLicense(world);
      const token = await activated(world, key);
      const updateJournal = journal(MAX_UPDATES_PER_REPORT + 1);
      const r = new TranscriptRecorder({
        id: "telemetry-report-updates",
        description:
          "Update-health events on the device report (P6-03). The client's update journal holds seventeen events; a report carries at most sixteen, oldest first, in the report's updates member, and the client drops the ones a 200 delivered. So the first report() carries the first sixteen and leaves one pending, and the second carries the last and leaves none. The Worker counts each event once by its eventId.",
        features: ["telemetry.updates"],
        requires: ["core.store", "core.sync", "devices.report"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          token,
          version: VERSION,
          updateJournal,
        },
      });
      const report = async (
        s: Parameters<Parameters<typeof r.step>[1]>[0],
        updates: Record<string, unknown>[],
      ) => {
        const res = await s.send({
          method: "POST",
          path: `/${PRODUCT}/devices/report`,
          bearer: "token",
          body: { os: { name: "linux", version: "6.8" }, updates },
          expectBody: {
            json: { updates: updates as never },
            match: "subset",
            allowedKeys: REPORT_ALLOWED_KEYS,
          },
        });
        expect(res.status).toBe(200);
        const row = await world.db.first<{ reported_json: string }>(
          "SELECT reported_json FROM devices WHERE product = ? AND device_id = ?",
          PRODUCT,
          DEVICE,
        );
        const stored = JSON.parse(row!.reported_json) as {
          updates?: unknown;
        };
        expect(stored.updates).toEqual(updates);
      };
      await r.step(
        { action: "report", note: "The first sixteen journalled events." },
        (s) => report(s, updateJournal.slice(0, MAX_UPDATES_PER_REPORT)),
        { result: true, updatesPending: 1 },
      );
      await r.step(
        {
          action: "report",
          now: T0 + 60,
          note: "The seventeenth, the last one pending.",
        },
        (s) => report(s, updateJournal.slice(MAX_UPDATES_PER_REPORT)),
        { result: true, updatesPending: 0 },
      );
      return r.transcript();
    }),
};

/// <reference types="@cloudflare/workers-types" />
// sync-etag-304 and sync-errors: Core's sync pass (wire contract v3 §4.2, §5) — the trust
// refresh, both signed documents with per-document ETags, the report — and the status ladder a
// document fetch can end on.

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import {
  DEVICE,
  document,
  etagOf,
  syncReport,
  T0,
  trust,
  VERSION,
} from "../client.js";
import {
  activated,
  enforced,
  LICENSED,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  type Scenario,
} from "../world.js";

const VALUES = {
  config: { "ui.theme": "dark" },
  entitlements: { polarisVpn: true },
};

export const syncEtag304: Scenario = {
  id: "sync-etag-304",
  record: () =>
    pinned("sync-etag-304", async (pin) => {
      const world = await productWorld(LICENSED);
      const { licenseId, key } = await seedLicense(world);
      const token = await activated(world, key);
      const r = new TranscriptRecorder({
        id: "sync-etag-304",
        description:
          "Conditional sync over the verified cache. The first pass fetches the trust manifest and both documents; the second sends each document's own ETag and gets two 304s, keeping the cached, verified documents; after an operator changes one config value, the third pass re-downloads only the config document.",
        features: ["core.sync", "core.cache"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, token, version: VERSION },
      });

      let licenseEtag = "";
      let configEtag = "";
      await r.step(
        {
          action: "sync",
          args: { force: false },
          note: "Nothing cached: both documents download.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          const lic = await document(s, PRODUCT, "license");
          expect(lic.status).toBe(200);
          licenseEtag = etagOf(lic);
          const cfg = await document(s, PRODUCT, "config");
          expect(cfg.status).toBe(200);
          configEtag = etagOf(cfg);
          expect(configEtag).not.toBe(licenseEtag);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { license: "applied", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 60,
          note: "Both ETags are sent and both documents answer 304.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          expect(
            (await document(s, PRODUCT, "license", licenseEtag)).status,
          ).toBe(304);
          expect(
            (await document(s, PRODUCT, "config", configEtag)).status,
          ).toBe(304);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: false,
          unauthorized: false,
          blocked: false,
          documents: { license: "unchanged", config: "unchanged" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      // An operator changes one config value. Only the config document's content moves.
      await world.db.run(
        "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
        JSON.stringify({
          config: { "ui.theme": enforced("light") },
          secrets: {},
          entitlements: { polarisVpn: enforced(true) },
        }),
        PRODUCT,
        licenseId,
      );
      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 120,
          note: "A config value changed: the licence 304s, the config document downloads.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          expect(
            (await document(s, PRODUCT, "license", licenseEtag)).status,
          ).toBe(304);
          const cfg = await document(s, PRODUCT, "config", configEtag);
          expect(cfg.status).toBe(200);
          expect(etagOf(cfg)).not.toBe(configEtag);
          expect(
            (
              await syncReport(s, PRODUCT, {
                ...VALUES,
                config: { "ui.theme": "light" },
              })
            ).status,
          ).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { license: "unchanged", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const syncErrors: Scenario = {
  id: "sync-errors",
  record: () =>
    pinned("sync-errors", async (pin) => {
      const world = await productWorld(LICENSED);
      const { licenseId, key } = await seedLicense(world);
      const token = await activated(world, key);
      const setLicense = (column: string, value: string | null) =>
        world.db.run(
          `UPDATE licenses SET ${column} = ? WHERE product = ? AND id = ?`,
          value,
          PRODUCT,
          licenseId,
        );
      const r = new TranscriptRecorder({
        id: "sync-errors",
        description:
          "The document status ladder. (1) A 401 on the licence document gets exactly one POST /license/token and one retry with the rotated token; the licence was disabled when the document was fetched and re-enabled before the re-acquire, so each answer is the Worker's real one. (2) A 403 version block with allowedRange gates the client as version-too-old while the config document 304s. (3) A 500 on the config document is an error for that document only; the licence 304 clears the block.",
        features: ["core.sync"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, token, version: VERSION },
      });

      let licenseEtag = "";
      let configEtag = "";
      await r.step(
        {
          action: "sync",
          args: { force: false },
          note: "401 on the licence document, one re-acquire, one retry.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          await setLicense("status", "disabled");
          expect((await document(s, PRODUCT, "license")).status).toBe(401);
          // Re-enabled before the config document, which is fetched in parallel with the token
          // held at the time. This step is the licence document's 401 ladder; on a product that
          // runs License the config document refuses a disabled licence too (a 401 with code
          // `license_unusable`, R1), and that conversation is `sync-config-license-unusable`.
          await setLicense("status", "active");
          const cfg = await document(s, PRODUCT, "config");
          expect(cfg.status).toBe(200);
          configEtag = etagOf(cfg);
          const rotated = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/token`,
            bearer: "token",
            capture: { token: "$.token" },
          });
          expect(rotated.status).toBe(200);
          expect(r.bindings.token).not.toBe(token);
          const retry = await document(s, PRODUCT, "license");
          expect(retry.status).toBe(200);
          licenseEtag = etagOf(retry);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { license: "applied", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      await setLicense("min_version", "2.0.0");
      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 60,
          note: "The licence now requires 2.0.0: 403 version_blocked with allowedRange.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          const lic = await document(s, PRODUCT, "license", licenseEtag);
          expect(lic.status).toBe(403);
          const body = (await lic.json()) as {
            error: { code: string };
            allowedRange?: unknown;
          };
          expect(body.error.code).toBe("version_blocked");
          expect(body.allowedRange).toBeTruthy();
          expect(
            (await document(s, PRODUCT, "config", configEtag)).status,
          ).toBe(304);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: false,
          unauthorized: false,
          blocked: true,
          documents: { license: "blocked", config: "unchanged" },
          licenseStatus: "version-too-old",
          tokenHeld: true,
        },
      );

      // The block is lifted, and the active catalog stops parsing: the config document cannot
      // be validated, so the Worker refuses to sign one (500 catalog_unavailable).
      await setLicense("min_version", null);
      await world.db.run(
        "UPDATE product_schema SET catalog_json = ? WHERE product = ? AND active = 1",
        "{",
        PRODUCT,
      );
      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 120,
          note: "The config document answers 500; the licence 304s and clears the block.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          expect(
            (await document(s, PRODUCT, "license", licenseEtag)).status,
          ).toBe(304);
          const cfg = await document(s, PRODUCT, "config", configEtag);
          expect(cfg.status).toBe(500);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: false,
          unauthorized: false,
          blocked: false,
          documents: { license: "unchanged", config: "error" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const syncConfigLicenseUnusable: Scenario = {
  id: "sync-config-license-unusable",
  record: () =>
    pinned("sync-config-license-unusable", async (pin) => {
      const world = await productWorld(LICENSED);
      const { licenseId, key } = await seedLicense(world);
      const token = await activated(world, key);
      const r = new TranscriptRecorder({
        id: "sync-config-license-unusable",
        description:
          "A licensed product stops serving the config document to a disabled licence (R1). After a healthy first pass, an operator disables the licence. On the next sync the licence document answers 401 unauthorized and the config document answers 401 with code license_unusable, before its ETag is compared. The client makes exactly one POST /license/token re-acquire, which the disabled licence also fails; neither document is retried, nothing is reported, and the gate reports revoked, not a build block.",
        features: ["core.sync"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, token, version: VERSION },
      });

      let licenseEtag = "";
      let configEtag = "";
      await r.step(
        {
          action: "sync",
          args: { force: false },
          note: "A healthy first pass: both documents download.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          const lic = await document(s, PRODUCT, "license");
          expect(lic.status).toBe(200);
          licenseEtag = etagOf(lic);
          const cfg = await document(s, PRODUCT, "config");
          expect(cfg.status).toBe(200);
          configEtag = etagOf(cfg);
          expect((await syncReport(s, PRODUCT, VALUES)).status).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { license: "applied", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );

      // An operator disables the licence. The device row and its token are untouched, so the
      // token still authenticates the DEVICE; only the licence behind it is unusable.
      await world.db.run(
        "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
        PRODUCT,
        licenseId,
      );
      await r.step(
        {
          action: "sync",
          args: { force: false },
          now: T0 + 60,
          note: "Both documents 401, the one re-acquire 401s, and the client ends revoked.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          const lic = await document(s, PRODUCT, "license", licenseEtag);
          expect(lic.status).toBe(401);
          const cfg = await document(s, PRODUCT, "config", configEtag);
          expect(cfg.status).toBe(401);
          expect(await cfg.json()).toEqual({
            error: { code: "license_unusable" },
          });
          const reacquire = await s.send({
            method: "POST",
            path: `/${PRODUCT}/license/token`,
            bearer: "token",
          });
          expect(reacquire.status).toBe(401);
        },
        {
          applied: false,
          unauthorized: true,
          blocked: false,
          documents: { license: "unauthorized", config: "unauthorized" },
          licenseStatus: "revoked",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

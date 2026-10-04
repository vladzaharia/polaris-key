/**
 * P5-02f — the operator's `appleId` pin on an `asc-api-key` closes the confused deputy P5-02
 * shipped with: the app the connector reads and the console controls act on was chosen by the
 * repo's `.pkey/distribution` alone, while the key is the operator's team key.
 *
 * Now the connector runs only when the chosen key is pinned to the app the manifest names:
 *
 *   - mismatch → inert (a visible reason), every control refused, the webhook not-found, the
 *     poll skipped — and not one request to Apple, not one credential open;
 *   - pin absent → the same, with its own reason;
 *   - matching → it works;
 *   - the manifest changing its `appleId` after linking → inert until a platform admin re-pins,
 *     which is audited (`outlet_credential.pin`).
 *
 * Plus the custody side: the pin is written only through the Core admin handler, kept in
 * `meta_json` (never in the sealed value, never settable from a value field), survives a rotation
 * that omits it, and a pin-only PUT touches neither the value nor its version marker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
  outletCredentialVersion,
  pinOutletCredential,
  putOutletCredential,
  validateOutletCredentialPin,
} from "../src/core/outletCredentials.js";
import { open } from "../src/keyvault.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { resolveAscSetup } from "../src/services/distribution/connectors/asc/setup.js";
import { ASC_CONTROLS } from "../src/services/distribution/connectors/asc/controls.js";
import { webhookFixture } from "./ascFake.js";
import {
  admin,
  APPLE_ID,
  ascP8,
  ascWorld,
  audits,
  deliver,
  withFetch,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER_APP = "5555555555";
const NOT_FOUND = { error: { code: "not_found" } };

const KEY = () => ({
  keyId: "ABC123DEFG",
  issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
  p8: ascP8(),
});

const poll = (w: AscWorld) =>
  withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));

/** What a repo writer's resync does: rewrite the Apple outlets' identity from the manifest. */
async function manifestNames(w: AscWorld, appleId: string): Promise<void> {
  await w.db.run(
    "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND kind IN ('app-store', 'testflight')",
    JSON.stringify({ appleId, bundleId: "gg.acme.djdl" }),
    SLUG,
  );
}

async function opens(w: AscWorld) {
  return (await audits(w.db)).filter(
    (a) => a.action === "outlet_credential.use",
  );
}

async function connectorView(w: AscWorld) {
  const res = await admin(w, "GET", "/distribution/connectors/asc");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    inert: {
      reason: string;
      message: string;
      manifestAppleId: string | null;
      apiKeyCredential: string | null;
      pinnedAppleId: string | null;
    } | null;
    setup: { appleId: string } | null;
  };
}

/** Every control, with a body each would accept, refused for `reason` and sending nothing. */
async function expectEveryControlRefused(
  w: AscWorld,
  reason: string,
): Promise<void> {
  const bodies: Record<string, unknown> = {
    "phased-release/pause": { releaseId: "v1.1.0" },
    "phased-release/resume": { releaseId: "v1.1.0" },
    "phased-release/complete": { releaseId: "v1.1.0" },
    release: { releaseId: "v1.1.0" },
    "testflight/public-link": { betaGroupId: "bg-1", enabled: true },
    webhook: {},
  };
  expect(Object.keys(bodies).sort()).toEqual(Object.keys(ASC_CONTROLS).sort());
  for (const [control, body] of Object.entries(bodies)) {
    const res = await admin(
      w,
      "POST",
      `/distribution/connectors/asc/${control}`,
      body,
    );
    expect(res.status, control).toBe(409);
    const json = (await res.json()) as { reason: string; message: string };
    expect(json.reason, control).toBe(reason);
    expect(json.message, control).toMatch(/pin/);
  }
  expect(w.fake.requests).toEqual([]);
  expect(
    (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution.asc."),
    ),
  ).toEqual([]);
}

/** The connector is inert for `reason`: nothing reaches Apple or opens a credential. */
async function expectInert(
  w: AscWorld,
  reason: "pin_missing" | "pin_mismatch",
): Promise<void> {
  w.fake.requests.length = 0;
  const before = (await opens(w)).length;

  const view = await connectorView(w);
  expect(view.configured).toBe(false);
  expect(view.setup).toBeNull();
  expect(view.inert?.reason).toBe(reason);

  await expectEveryControlRefused(w, `credential_${reason}`);

  const hook = await deliver(
    w,
    webhookFixture("APP_STORE_VERSION_APP_VERSION_STATE_UPDATED"),
  );
  expect(hook.status).toBe(404);
  expect(await hook.json()).toEqual(NOT_FOUND);
  expect(
    await w.db.all(
      "SELECT event_id FROM dist_connector_events WHERE product = ?",
      SLUG,
    ),
  ).toEqual([]);

  const report = await poll(w);
  expect(report.failures).toEqual({});
  expect(JSON.stringify(report.results)).toContain(
    `credential-${reason.replace("_", "-")}`,
  );

  expect(w.fake.requests).toEqual([]);
  expect((await opens(w)).length).toBe(before);
}

describe("the pin decides whether the connector runs", () => {
  it("a key pinned to another app than the manifest names: inert, every control refused, nothing mirrored", async () => {
    const w = await ascWorld({ pin: OTHER_APP });
    await expectInert(w, "pin_mismatch");
    const view = await connectorView(w);
    expect(view.inert).toMatchObject({
      manifestAppleId: APPLE_ID,
      apiKeyCredential: "asc",
      pinnedAppleId: OTHER_APP,
    });
    expect(view.inert!.message).toContain(APPLE_ID);
    expect(view.inert!.message).toContain(OTHER_APP);
  });

  it("a key with no pin: inert with its own reason (a pre-pin credential does nothing)", async () => {
    const w = await ascWorld({ pin: null });
    await expectInert(w, "pin_missing");
    const view = await connectorView(w);
    expect(view.inert).toMatchObject({
      manifestAppleId: APPLE_ID,
      apiKeyCredential: "asc",
      pinnedAppleId: null,
    });
  });

  it("a key pinned to the manifest's app: configured, polled, webhooks and controls served", async () => {
    const w = await ascWorld();
    const view = await connectorView(w);
    expect(view.configured).toBe(true);
    expect(view.inert).toBeNull();
    expect(view.setup?.appleId).toBe(APPLE_ID);

    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(w.fake.requests[0]!.path).toBe(
      `/v1/apps/${APPLE_ID}/reviewSubmissions`,
    );

    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    const hook = await deliver(
      w,
      webhookFixture("APP_STORE_VERSION_APP_VERSION_STATE_UPDATED"),
    );
    expect(hook.status).toBe(200);

    // A control gets past the pin (and is then refused on its own terms, by Apple's answer).
    const res = await admin(w, "POST", "/distribution/connectors/asc/release", {
      releaseId: "v1.0.0",
    });
    expect(((await res.json()) as { reason?: string }).reason).not.toMatch(
      /^credential_pin/,
    );
  });

  it("the manifest changing its appleId after linking: inert until a platform admin re-pins (audited)", async () => {
    const w = await ascWorld();
    expect((await resolveAscSetup(w.db, SLUG)).setup?.appleId).toBe(APPLE_ID);

    // A repo writer points the product at another app the team key can see.
    await manifestNames(w, OTHER_APP);
    await expectInert(w, "pin_mismatch");
    expect((await connectorView(w)).inert).toMatchObject({
      manifestAppleId: OTHER_APP,
      pinnedAppleId: APPLE_ID,
    });

    // Only a platform admin's re-pin makes it run again — against the app they named.
    const res = await admin(w, "PUT", "/outlet-credentials/asc", {
      kind: "asc-api-key",
      pin: OTHER_APP,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "asc" });
    const pins = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.pin",
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ actor_sub: "u1", target_id: "asc" });
    expect(pins[0]!.summary).toBe(
      `Pinned outlet credential asc (asc-api-key) to appleId ${OTHER_APP} (was ${APPLE_ID})`,
    );

    const view = await connectorView(w);
    expect(view.configured).toBe(true);
    expect(view.setup?.appleId).toBe(OTHER_APP);
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests[0]?.path).toBe(
      `/v1/apps/${OTHER_APP}/reviewSubmissions`,
    );
  });

  it("the pin is checked on the credential the setup chooses, not on any credential", async () => {
    // A bound key wins over an unbound one; an unbound key pinned to the right app must not
    // stand in for a bound key pinned to another.
    const w = await ascWorld();
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "asc-bound",
      kind: "asc-api-key",
      outletId: "app-store",
      value: KEY(),
      pin: OTHER_APP,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    const { setup, inert } = await resolveAscSetup(w.db, SLUG);
    expect(setup).toBeNull();
    expect(inert).toMatchObject({
      reason: "pin_mismatch",
      apiKeyCredential: "asc-bound",
    });
  });
});

describe("custody of the pin", () => {
  it("lives in meta_json, never in the sealed value, and a value field cannot set it", async () => {
    const w = await ascWorld({ pin: null });
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "asc",
      kind: "asc-api-key",
      outletId: null,
      // A value smuggling `appleId` is not a pin: the kind's projection drops it.
      value: { ...KEY(), appleId: APPLE_ID },
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, pinChange: null });
    const [info] = (await listOutletCredentials(w.db, SLUG)).filter(
      (c) => c.id === "asc",
    );
    expect(info!.meta).toEqual({
      keyId: "ABC123DEFG",
      issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
    });
    expect((await resolveAscSetup(w.db, SLUG)).inert?.reason).toBe(
      "pin_missing",
    );

    await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "asc",
      kind: "asc-api-key",
      outletId: null,
      value: KEY(),
      pin: APPLE_ID,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    const row = await w.db.first<{ enc_value_json: string; meta_json: string }>(
      "SELECT enc_value_json, meta_json FROM outlet_credentials WHERE product = ? AND credential_id = ?",
      SLUG,
      "asc",
    );
    expect(JSON.parse(row!.meta_json)).toMatchObject({ appleId: APPLE_ID });
    const plain = JSON.parse(
      await open(w.env, row!.enc_value_json, {
        product: SLUG,
        kind: "outlet-credential",
        id: "asc",
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(plain).sort()).toEqual(["issuerId", "keyId", "p8"]);
  });

  it("a rotation that omits the pin keeps it; one that gives a new pin reports the change", async () => {
    const w = await ascWorld();
    const rotate = (pin?: string) =>
      putOutletCredential(w.env, w.db, {
        product: SLUG,
        credentialId: "asc",
        kind: "asc-api-key",
        outletId: null,
        value: KEY(),
        ...(pin !== undefined ? { pin } : {}),
        expiresAt: null,
        actor: "admin-1",
        now: NOW,
      });
    expect(await rotate()).toMatchObject({ ok: true, pinChange: null });
    expect((await resolveAscSetup(w.db, SLUG)).setup?.appleId).toBe(APPLE_ID);
    expect(await rotate(APPLE_ID)).toMatchObject({ ok: true, pinChange: null });
    expect(await rotate(OTHER_APP)).toMatchObject({
      ok: true,
      pinChange: { field: "appleId", before: APPLE_ID, after: OTHER_APP },
    });
  });

  it("a pin-only write touches meta_json only: the value, its version marker and health stay", async () => {
    const w = await ascWorld({ pin: null });
    const before = await w.db.first<Record<string, unknown>>(
      "SELECT enc_value_json, rotated_at, last_used_at, status FROM outlet_credentials WHERE product = ? AND credential_id = 'asc'",
      SLUG,
    );
    const version = await outletCredentialVersion(w.db, SLUG, "asc");
    const r = await pinOutletCredential(w.db, {
      product: SLUG,
      credentialId: "asc",
      kind: "asc-api-key",
      pin: ` ${APPLE_ID} `,
    });
    expect(r).toEqual({
      ok: true,
      id: "asc",
      created: false,
      pinChange: { field: "appleId", before: null, after: APPLE_ID },
    });
    expect(
      await w.db.first(
        "SELECT enc_value_json, rotated_at, last_used_at, status FROM outlet_credentials WHERE product = ? AND credential_id = 'asc'",
        SLUG,
      ),
    ).toEqual(before);
    expect(await outletCredentialVersion(w.db, SLUG, "asc")).toBe(version);
    // The same pin again changes nothing and reports no change.
    expect(
      await pinOutletCredential(w.db, {
        product: SLUG,
        credentialId: "asc",
        kind: "asc-api-key",
        pin: APPLE_ID,
      }),
    ).toMatchObject({ ok: true, pinChange: null });
  });

  it("refuses a malformed pin, a kind without one, an unknown id and another kind's row", async () => {
    const w = await ascWorld();
    expect(validateOutletCredentialPin("asc-api-key", "12ab")).toMatchObject({
      ok: false,
    });
    expect(validateOutletCredentialPin("asc-api-key", 1234)).toMatchObject({
      ok: false,
    });
    expect(
      validateOutletCredentialPin("asc-webhook-secret", APPLE_ID),
    ).toMatchObject({ ok: false });
    expect(
      await pinOutletCredential(w.db, {
        product: SLUG,
        credentialId: "nope",
        kind: "asc-api-key",
        pin: APPLE_ID,
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await pinOutletCredential(w.db, {
        product: SLUG,
        credentialId: "asc-webhook",
        kind: "asc-api-key",
        pin: APPLE_ID,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await putOutletCredential(w.env, w.db, {
        product: SLUG,
        credentialId: "asc",
        kind: "asc-api-key",
        outletId: null,
        value: KEY(),
        pin: "not-an-app",
        expiresAt: null,
        actor: "admin-1",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, status: 422, field: "pin" });
    // Nothing above moved the stored pin.
    expect((await resolveAscSetup(w.db, SLUG)).setup?.appleId).toBe(APPLE_ID);
  });

  it("checkOutletCredentialPin: exact match only", () => {
    const info = (meta: Record<string, string>) => ({
      kind: "asc-api-key",
      meta,
    });
    expect(checkOutletCredentialPin(info({ appleId: "1" }), "1")).toEqual({
      ok: true,
      pinned: "1",
    });
    expect(checkOutletCredentialPin(info({ appleId: "1" }), "10")).toEqual({
      ok: false,
      reason: "pin_mismatch",
      pinned: "1",
    });
    expect(checkOutletCredentialPin(info({}), "1")).toEqual({
      ok: false,
      reason: "pin_missing",
      pinned: null,
    });
    // A malformed stored value is no pin.
    expect(checkOutletCredentialPin(info({ appleId: "x" }), "x")).toMatchObject(
      { ok: false, reason: "pin_missing" },
    );
    // A kind without a pin spec never passes: a connector cannot be set up on one by accident.
    expect(
      checkOutletCredentialPin({ kind: "asc-webhook-secret", meta: {} }, "1"),
    ).toMatchObject({ ok: false, reason: "pin_missing" });
  });
});

describe("the admin API", () => {
  it("lists each pinnable kind's field, and the pin with the credential's metadata", async () => {
    const w = await ascWorld();
    const res = await admin(w, "GET", "/outlet-credentials");
    const body = (await res.json()) as {
      pins: Record<string, { field: string; label: string }>;
      credentials: Array<{ id: string; meta: Record<string, string> }>;
    };
    expect(body.pins).toEqual({
      "asc-api-key": {
        field: "appleId",
        label: "App Store Connect app id (Apple ID)",
      },
      // P5-03 adopted the pin for the Play service account (`playPin.test.ts`).
      "google-service-account": {
        field: "packageName",
        label: "Google Play package name",
      },
      // P5-04 adopted it for the Partner Center app (`msstore.test.ts`).
      "ms-partner-center": {
        field: "productId",
        label: "Microsoft Store product id (Store ID)",
      },
      // P6-01 adopted it for the In-App Purchase key and the Steam publisher key
      // (`commerce.test.ts`).
      "app-store-server-key": {
        field: "bundleId",
        label: "App Store bundle id",
      },
      "steam-publisher-key": {
        field: "appId",
        label: "Steam app id",
      },
    });
    expect(body.credentials.find((c) => c.id === "asc")!.meta.appleId).toBe(
      APPLE_ID,
    );
  });

  it("PUT with a value and a pin: one set row and one pin row; the same pin again: no pin row", async () => {
    const w = await ascWorld({ apiKey: false });
    const put = (pin?: string) =>
      admin(w, "PUT", "/outlet-credentials/asc", {
        kind: "asc-api-key",
        value: KEY(),
        ...(pin !== undefined ? { pin } : {}),
      });
    expect((await put(APPLE_ID)).status).toBe(200);
    expect((await put(APPLE_ID)).status).toBe(200);
    expect((await put()).status).toBe(200);
    const rows = (await audits(w.db)).filter((a) =>
      a.action.startsWith("outlet_credential."),
    );
    expect(rows.map((a) => a.action)).toEqual([
      "outlet_credential.set",
      "outlet_credential.pin",
      "outlet_credential.set",
      "outlet_credential.set",
    ]);
    expect(rows[1]!.summary).toBe(
      `Pinned outlet credential asc (asc-api-key) to appleId ${APPLE_ID} (was unpinned)`,
    );
    expect((await connectorView(w)).configured).toBe(true);
  });

  it("refuses a bad pin (422, field pin), a pin on a kind without one, and a pin-only PUT on an unknown id", async () => {
    const w = await ascWorld();
    const bad = await admin(w, "PUT", "/outlet-credentials/asc", {
      kind: "asc-api-key",
      pin: "../../apps",
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual([
      "pin",
    ]);
    const withValue = await admin(w, "PUT", "/outlet-credentials/asc", {
      kind: "asc-api-key",
      value: KEY(),
      pin: "abc",
    });
    expect(withValue.status).toBe(422);
    expect(((await withValue.json()) as { fields: string[] }).fields).toEqual([
      "pin",
    ]);
    expect(
      (
        await admin(w, "PUT", "/outlet-credentials/asc-webhook", {
          kind: "asc-webhook-secret",
          pin: APPLE_ID,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin(w, "PUT", "/outlet-credentials/missing", {
          kind: "asc-api-key",
          pin: APPLE_ID,
        })
      ).status,
    ).toBe(404);
    expect(
      (await audits(w.db)).filter((a) => a.action === "outlet_credential.pin"),
    ).toEqual([]);
    expect((await resolveAscSetup(w.db, SLUG)).setup?.appleId).toBe(APPLE_ID);
  });
});

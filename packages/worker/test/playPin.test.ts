/**
 * P5-03 adopts P5-02f's pin: the operator's `packageName` pin on a `google-service-account` closes
 * the confused deputy the Play connector would otherwise have — the package it reads and the
 * console controls (and the vitals auto-halt) act on was chosen by the repo's `.pkey/distribution`
 * alone, while the service account is the operator's and may be invited to several apps.
 *
 * The connector runs only when the chosen credential is pinned to the package the manifest names:
 *
 *   - mismatch → inert (a visible reason), every control refused 409, the poll skipped, nothing
 *     mirrored — and not one request to Google, not one token minted, not one credential open;
 *   - pin absent → the same, with its own reason;
 *   - matching → it works;
 *   - the manifest changing its `packageName` after linking → inert until a platform admin
 *     re-pins, which is audited (`outlet_credential.pin`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOutletCredentialPin,
  putOutletCredential,
  validateOutletCredentialPin,
} from "../src/core/outletCredentials.js";
import { PLAY_CONTROLS } from "../src/services/distribution/connectors/play/controls.js";
import { resolvePlaySetup } from "../src/services/distribution/connectors/play/setup.js";
import {
  admin,
  audits,
  PLAY_OUTLET_IDENTITY,
  PLAY_PACKAGE,
  playWorld,
  poll,
  rsaKeyPair,
  NOW,
  SLUG,
  CLIENT_EMAIL,
  type PlayWorld,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER_PACKAGE = "gg.rival.game";
const CONTROL = "/distribution/connectors/play";

/** What a repo writer's resync does: rewrite the Play outlets' identity from the manifest. */
async function manifestNames(w: PlayWorld, packageName: string): Promise<void> {
  await w.db.run(
    "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND kind IN ('play', 'play-testing')",
    JSON.stringify({ ...PLAY_OUTLET_IDENTITY, packageName }),
    SLUG,
  );
}

async function opens(w: PlayWorld) {
  return (await audits(w.db)).filter(
    (a) => a.action === "outlet_credential.use",
  );
}

async function connectorView(w: PlayWorld) {
  const res = await admin(w, "GET", CONTROL);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    inert: {
      reason: string;
      message: string;
      manifestPackageName: string | null;
      credential: string | null;
      pinnedPackageName: string | null;
    } | null;
    setup: { packageName: string } | null;
  };
}

/** What the mirror holds: Play-sourced availability, mirrored rollouts, connector objects. */
async function mirrored(w: PlayWorld) {
  const [a, r, o] = await Promise.all([
    w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dist_availability WHERE product = ? AND source = 'play'",
      SLUG,
    ),
    w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dist_rollouts WHERE product = ? AND source = 'play'",
      SLUG,
    ),
    w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dist_connector_objects WHERE product = ? AND connector = 'play'",
      SLUG,
    ),
  ]);
  return { availability: a!.n, rollouts: r!.n, objects: o!.n };
}

/** Every control, with a body each would accept, refused for `reason` and sending nothing. */
async function expectEveryControlRefused(
  w: PlayWorld,
  reason: string,
): Promise<void> {
  const bodies: Record<string, unknown> = {
    "rollout/fraction": {
      track: "production",
      versionCode: "111",
      userFraction: 0.5,
    },
    "rollout/halt": {
      track: "production",
      versionCode: "111",
      confirmRollback: true,
    },
    "rollout/resume": { track: "production", versionCode: "111" },
    "rollout/complete": { track: "production", versionCode: "111" },
    priority: { track: "beta", versionCode: "111", priority: 5 },
    settings: { vitals: { enabled: true } },
  };
  expect(Object.keys(bodies).sort()).toEqual(Object.keys(PLAY_CONTROLS).sort());
  const playAudits = async () =>
    (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution.play."),
    ).length;
  const auditsBefore = await playAudits();
  for (const [control, body] of Object.entries(bodies)) {
    const res = await admin(w, "POST", `${CONTROL}/${control}`, body);
    expect(res.status, control).toBe(409);
    const json = (await res.json()) as {
      reason: string;
      message: string;
      error: { reason: string };
    };
    expect(json.reason, control).toBe(reason);
    expect(json.error.reason, control).toBe(reason);
    expect(json.message, control).toMatch(/pin/);
  }
  expect(w.fake.requests).toEqual([]);
  expect(w.fake.tokenRequests).toEqual([]);
  expect(await playAudits()).toBe(auditsBefore);
}

/** The connector is inert for `reason`: nothing reaches Google or opens a credential. */
async function expectInert(
  w: PlayWorld,
  reason: "pin_missing" | "pin_mismatch",
): Promise<void> {
  w.fake.requests.length = 0;
  w.fake.tokenRequests.length = 0;
  const opened = (await opens(w)).length;
  const auditsBefore = (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.play."),
  ).length;
  const mirrorBefore = await mirrored(w);

  const view = await connectorView(w);
  expect(view.configured).toBe(false);
  expect(view.setup).toBeNull();
  expect(view.inert?.reason).toBe(reason);

  // Controls: refused before any token is minted or any request sent.
  await expectEveryControlRefused(w, `credential_${reason}`);

  const report = await poll(w);
  expect(report.failures).toEqual({});
  expect(JSON.stringify(report.results)).toContain(
    `credential-${reason.replace("_", "-")}`,
  );

  expect(w.fake.requests).toEqual([]);
  expect(w.fake.tokenRequests).toEqual([]);
  expect((await opens(w)).length).toBe(opened);
  expect(await mirrored(w)).toEqual(mirrorBefore);
  expect(
    (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution.play."),
    ).length,
  ).toBe(auditsBefore);
}

describe("the pin decides whether the Play connector runs", () => {
  it("a service account pinned to another package than the manifest names: inert, every control refused, nothing mirrored", async () => {
    const w = await playWorld({ pin: OTHER_PACKAGE });
    await expectInert(w, "pin_mismatch");
    expect(await mirrored(w)).toEqual({
      availability: 0,
      rollouts: 0,
      objects: 0,
    });
    const view = await connectorView(w);
    expect(view.inert).toMatchObject({
      manifestPackageName: PLAY_PACKAGE,
      credential: "play",
      pinnedPackageName: OTHER_PACKAGE,
    });
    expect(view.inert!.message).toContain(PLAY_PACKAGE);
    expect(view.inert!.message).toContain(OTHER_PACKAGE);
    // No value of the credential in the page.
    expect(JSON.stringify(view)).not.toMatch(
      /PRIVATE KEY|client_email|iam\.gserviceaccount/,
    );
  });

  it("a service account with no pin: inert with its own reason (a pre-pin credential does nothing)", async () => {
    const w = await playWorld({ pin: null });
    await expectInert(w, "pin_missing");
    expect((await connectorView(w)).inert).toMatchObject({
      manifestPackageName: PLAY_PACKAGE,
      credential: "play",
      pinnedPackageName: null,
    });
  });

  it("a service account pinned to the manifest's package: configured, polled, controls served", async () => {
    const w = await playWorld();
    const view = await connectorView(w);
    expect(view.configured).toBe(true);
    expect(view.inert).toBeNull();
    expect(view.setup?.packageName).toBe(PLAY_PACKAGE);

    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);
    for (const r of w.fake.requests) expect(r.app, r.path).toBe(PLAY_PACKAGE);
    expect((await mirrored(w)).objects).toBeGreaterThan(0);

    // A control gets past the pin and does its work.
    const res = await admin(w, "POST", `${CONTROL}/rollout/halt`, {
      track: "production",
      versionCode: "111",
    });
    expect(res.status).toBe(200);
    expect((await audits(w.db)).map((a) => a.action)).toContain(
      "distribution.play.halt",
    );
  });

  it("the manifest changing its packageName after linking: inert until a platform admin re-pins (audited)", async () => {
    const w = await playWorld();
    // Linked and running, with the vitals auto-halt on.
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).setup?.packageName).toBe(
      PLAY_PACKAGE,
    );
    expect(
      (
        await admin(w, "POST", `${CONTROL}/settings`, {
          vitals: { enabled: true },
        })
      ).status,
    ).toBe(200);
    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);

    // A repo writer points the product at another app the service account can see.
    await manifestNames(w, OTHER_PACKAGE);
    await expectInert(w, "pin_mismatch");
    expect((await connectorView(w)).inert).toMatchObject({
      manifestPackageName: OTHER_PACKAGE,
      pinnedPackageName: PLAY_PACKAGE,
    });

    // Only a platform admin's re-pin makes it run again — against the package they named.
    const res = await admin(w, "PUT", "/outlet-credentials/play", {
      kind: "google-service-account",
      pin: OTHER_PACKAGE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "play" });
    const pins = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.pin",
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ actor_sub: "u1", target_id: "play" });
    expect(pins[0]!.summary).toBe(
      `Pinned outlet credential play (google-service-account) to packageName ${OTHER_PACKAGE} (was ${PLAY_PACKAGE})`,
    );

    const view = await connectorView(w);
    expect(view.configured).toBe(true);
    expect(view.setup?.packageName).toBe(OTHER_PACKAGE);
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);
    // The re-pinned package — which this fake's account is not invited to, so Google refuses.
    for (const r of w.fake.requests) expect(r.app, r.path).toBe(OTHER_PACKAGE);
  });

  it("the pin is checked on the credential the setup chooses, not on any credential", async () => {
    // A bound credential wins over an unbound one; an unbound one pinned to the right package
    // must not stand in for a bound one pinned to another.
    const w = await playWorld();
    const keys = rsaKeyPair();
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "play-bound",
      kind: "google-service-account",
      outletId: "play",
      value: {
        type: "service_account",
        client_email: CLIENT_EMAIL,
        private_key: keys.privatePem,
      },
      pin: OTHER_PACKAGE,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    const { setup, inert } = await resolvePlaySetup(w.env, w.db, SLUG);
    expect(setup).toBeNull();
    expect(inert).toMatchObject({
      reason: "pin_mismatch",
      credential: "play-bound",
    });
  });
});

describe("the google-service-account pin", () => {
  it("validates an Android package name, and compares exactly", () => {
    for (const ok of ["gg.acme.djdl", "com.Example_1.app", " a.b "])
      expect(
        validateOutletCredentialPin("google-service-account", ok),
        ok,
      ).toMatchObject({ ok: true, value: ok.trim() });
    for (const bad of [
      "djdl",
      "1gg.acme",
      "gg..acme",
      "gg.acme.",
      "gg.acme/../x",
      "gg.acme:commit",
      `a.${"b".repeat(254)}`,
      42,
      "",
    ])
      expect(
        validateOutletCredentialPin("google-service-account", bad),
        String(bad),
      ).toMatchObject({ ok: false });
    const info = (meta: Record<string, string>) => ({
      kind: "google-service-account",
      meta,
    });
    expect(
      checkOutletCredentialPin(
        info({ packageName: PLAY_PACKAGE }),
        PLAY_PACKAGE,
      ),
    ).toEqual({ ok: true, pinned: PLAY_PACKAGE });
    expect(
      checkOutletCredentialPin(
        info({ packageName: PLAY_PACKAGE }),
        `${PLAY_PACKAGE}.beta`,
      ),
    ).toMatchObject({ ok: false, reason: "pin_mismatch" });
    expect(
      checkOutletCredentialPin(
        info({ clientEmail: CLIENT_EMAIL }),
        PLAY_PACKAGE,
      ),
    ).toMatchObject({ ok: false, reason: "pin_missing" });
  });

  it("a value field cannot set it, and the admin PUT refuses a malformed one", async () => {
    const w = await playWorld({ pin: null });
    const keys = rsaKeyPair();
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "play",
      kind: "google-service-account",
      outletId: null,
      // A key file smuggling `packageName` is not a pin: the kind's projection drops it.
      value: {
        type: "service_account",
        client_email: CLIENT_EMAIL,
        private_key: keys.privatePem,
        packageName: PLAY_PACKAGE,
      },
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, pinChange: null });
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).inert?.reason).toBe(
      "pin_missing",
    );
    const res = await admin(w, "PUT", "/outlet-credentials/play", {
      kind: "google-service-account",
      pin: "not a package",
    });
    expect(res.status).toBe(422);
    expect((await resolvePlaySetup(w.env, w.db, SLUG)).inert?.reason).toBe(
      "pin_missing",
    );
  });
});

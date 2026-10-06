/// <reference types="@cloudflare/workers-types" />
// devicecode-happy and devicecode-expired: device-code sign-in (RFC 8628, P1-06) as a client
// drives it — begin, poll at the advertised interval, honour `slow_down`, and on `ready` store
// the device token and run the post-acquisition sync; or watch the flow lapse.
//
// The human half happens between steps, server-side and unrecorded: the player opens the
// verification URI's complete form (the QR payload), confirms the code on the RFC 8628 page, and
// signs in at the IdP, which the scenario mocks (`../idp.ts`). The callback runs for real —
// token exchange, ID-token verification, nonce binding — and stores the verified identity; the
// `ready` poll then runs `activateFromIdentity` (P1-07 defers it to `/device/poll`), so a
// device-code sign-in is recorded yielding the signed-in identity's OWN licence, nothing merged
// (P1-06), and the `identity` the device shows the player.

import { expect } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { TranscriptRecorder, BASE_URL, type World } from "../recorder.js";
import {
  DEVICE,
  discovery,
  document,
  FINGERPRINT,
  FINGERPRINT_EXPECT,
  syncReport,
  T0,
  trust,
  VERSION,
} from "../client.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  type Scenario,
} from "../world.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { attachLicenseAccount } from "../../../src/core/accountSubjects.js";
import type { ServicesMap } from "../../../src/core/services.js";
import { seedTier } from "../../seed.js";
import {
  answerTokenExchange,
  IDP_CLIENT_ID,
  IDP_ISSUER,
  signIdToken,
} from "../idp.js";
import type { JsonValue } from "../format.js";

/** License for the gate, Config for the post-sign-in sync, Identity for the sign-in itself. */
const IDENTITY: ServicesMap = servicesOn("license", "config", "identity");

/** The player who signs in, and the IdP group that entitles them. */
const PLAYER = {
  sub: "transcript-player",
  email: "player@example.com",
  name: "Transcript Player",
  groups: ["players"],
};

/** The product's sign-in configuration: a repo-owned (`custom`) IdP whose `players` group maps
 *  onto the `pro` tier. */
async function identityWorld(): Promise<World> {
  const w = await productWorld(IDENTITY);
  await seedTier(w.db, PRODUCT, "pro");
  await w.db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    PRODUCT,
    "custom",
    IDP_ISSUER,
    IDP_CLIENT_ID,
    null,
    JSON.stringify([`${BASE_URL}/${PRODUCT}/identity/auth/callback`]),
    JSON.stringify({ players: { role: "user", tier: "pro" } }),
  );
  return w;
}

/** A request from the player's BROWSER, outside the recording: no device headers, no bearer. */
async function browser(
  w: World,
  now: number,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE_URL}${path}`, {
      method,
      headers: form
        ? {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
          }
        : {},
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );
}

/**
 * The human half of the flow: open `verificationUriComplete`, confirm the code, sign in at the
 * IdP, land on the callback. Asserts each hop, so a Worker change that breaks the page or the
 * callback fails the scenario rather than silently recording a flow that never completes.
 */
async function playerSignsIn(
  w: World,
  now: number,
  verificationUriComplete: string,
): Promise<void> {
  const complete = new URL(verificationUriComplete);
  const userCode = complete.searchParams.get("user_code")!;
  const page = await browser(
    w,
    now,
    "GET",
    complete.pathname + complete.search,
  );
  expect(page.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  expect(csrf).toBeTruthy();

  const confirmed = await browser(w, now, "POST", complete.pathname, {
    user_code: userCode,
    csrf: csrf!,
  });
  expect(confirmed.status).toBe(303);
  const authorize = new URL(confirmed.headers.get("location")!);
  expect(authorize.origin).toBe(IDP_ISSUER);
  const state = authorize.searchParams.get("state")!;
  const nonce = authorize.searchParams.get("nonce")!;

  const idToken = await signIdToken(PLAYER, nonce, now);
  const callback = await answerTokenExchange(idToken, () =>
    browser(
      w,
      now,
      "GET",
      `/${PRODUCT}/identity/auth/callback?code=idp-code&state=${state}`,
    ),
  );
  expect(callback.status).toBe(200);
}

/** The KV records a device flow lives in expire with the flow (`FLOW_TTL_SECONDS`). The test KV
 *  does not run a clock, so the scenario lapses them itself once the lifetime has passed. */
function lapseFlowRecords(w: World): void {
  for (const key of w.kv.keys()) {
    const ttl = w.kv.ttlOf(key);
    if (ttl !== undefined && ttl <= 600) void w.kv.delete(key);
  }
}

const POLL = `/${PRODUCT}/identity/auth/device/poll`;
const START = `/${PRODUCT}/identity/auth/device/start`;

interface Started {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  /** PX-W13 (§12.7.1): the stored label, echoed. */
  deviceName: string | null;
}

/** What `beginSignIn` hands the host: everything it shows the player, never the device code
 *  (that is the poll credential and stays between the SDK and the server). */
function promptOf(b: Started): JsonValue {
  return {
    userCode: b.userCode,
    verificationUri: b.verificationUri,
    verificationUriComplete: b.verificationUriComplete,
    expiresIn: b.expiresIn,
    interval: b.interval,
    deviceName: b.deviceName,
  };
}

/** `POST …/device/poll`: the device code the start answered, and this device's id. The device
 *  code is server-chosen, so it is held literally: the client must echo it. */
function pollSpec(deviceCode: string) {
  return {
    method: "POST" as const,
    path: POLL,
    body: { deviceCode, deviceId: DEVICE },
    expectBody: {
      json: { deviceCode, deviceId: DEVICE },
      match: "exact" as const,
    },
  };
}

export const devicecodeHappy: Scenario = {
  id: "devicecode-happy",
  record: () =>
    pinned("devicecode-happy", async (pin) => {
      const world = await identityWorld();
      const r = new TranscriptRecorder({
        id: "devicecode-happy",
        description:
          "Device-code sign-in (RFC 8628). beginSignIn() posts this device's id and name and hands the host the user code, both verification URIs (the complete one is the QR payload) and the label the Worker echoed — never the device code. pollSignIn() asks once per call: pending; a poll one second after the last is told to slow_down (429, with the interval); pending again at the interval. Between polls the player confirms the code on the user-code page and signs in at the (mocked) IdP. The next poll is ready, naming the signed-in identity for the device to show: the client stores the device token and runs the same forced sync activation does. The licence is the signed-in identity's own — the device-code callback merges nothing (P1-06), and without the opt-in the poll attaches nothing (P1-07).",
        features: ["identity.devicecode"],
        requires: ["core.store", "core.sync"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["license", "config", "identity"],
        },
      });

      let started!: Started;
      const deviceName = "Living-room PC";
      // The prompt is only known once the server has answered, so the expectation is filled in
      // by the drive: a replaying SDK must surface exactly these values.
      const begun: Record<string, JsonValue> = {};
      await r.step(
        { action: "beginSignIn", args: { deviceName } },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: START,
            body: { deviceId: DEVICE, deviceName },
            expectBody: {
              json: { deviceId: DEVICE, deviceName },
              match: "exact",
            },
          });
          expect(res.status).toBe(200);
          started = (await res.json()) as Started;
          Object.assign(begun, { prompt: promptOf(started), tokenHeld: false });
        },
        begun,
      );

      await r.step(
        { action: "pollSignIn", now: T0 + 2, note: "Pending." },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(await res.json()).toEqual({ status: "pending" });
        },
        { result: "pending", tokenHeld: false },
      );
      await r.step(
        {
          action: "pollSignIn",
          now: T0 + 3,
          note: "One second after the last poll, inside the advertised interval: slow_down.",
        },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(res.status).toBe(429);
          expect(await res.json()).toEqual({
            status: "slow_down",
            interval: 2,
          });
        },
        { result: "slow-down", interval: 2, tokenHeld: false },
      );
      await r.step(
        {
          action: "pollSignIn",
          now: T0 + 5,
          note: "Pending again, at the interval.",
        },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(await res.json()).toEqual({ status: "pending" });
        },
        { result: "pending", tokenHeld: false },
      );

      await playerSignsIn(world, T0 + 6, started.verificationUriComplete);

      await r.step(
        {
          action: "pollSignIn",
          now: T0 + 7,
          note: "Ready: store the token, then the forced post-acquisition sync.",
        },
        async (s) => {
          const res = await s.send({
            ...pollSpec(started.deviceCode),
            capture: { token: "$.token" },
          });
          const body = (await res.json()) as { status: string; token: string };
          expect(body.status).toBe("ready");
          expect(body.token.startsWith("pkeyt_")).toBe(true);
          await trust(s, PRODUCT);
          expect((await document(s, PRODUCT, "license")).status).toBe(200);
          expect((await document(s, PRODUCT, "config")).status).toBe(200);
          expect(
            (
              await syncReport(s, PRODUCT, {
                config: {},
                entitlements: {},
              })
            ).status,
          ).toBe(200);
        },
        { result: "ready", tokenHeld: true, licenseStatus: "ok" },
      );

      // The identity's own licence, minted by the callback — not any licence the device held.
      const licence = await world.db.first<{ sub: string; origin: string }>(
        "SELECT sub, origin FROM licenses WHERE product = ?",
        PRODUCT,
      );
      expect(licence?.sub).toBe(PLAYER.sub);
      return r.transcript();
    }),
};

export const devicecodeExpired: Scenario = {
  id: "devicecode-expired",
  record: () =>
    pinned("devicecode-expired", async (pin) => {
      const world = await identityWorld();
      const r = new TranscriptRecorder({
        id: "devicecode-expired",
        description:
          "A device-code flow nobody completes. beginSignIn() with no device name, on a host with no platform device name, posts the device id alone, and the echoed label is null; one poll is pending. Ten minutes later the flow's records have lapsed and the Worker answers the next poll with timeout, which the client reports as expired, holding no token. waitForSignIn() on the same prompt then makes no request at all: the prompt's expiresIn has passed, and a client stops polling at expiry rather than asking a server that can only say timeout.",
        features: ["identity.devicecode"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["license", "config", "identity"],
        },
      });

      let started!: Started;
      const begun: Record<string, JsonValue> = {};
      await r.step(
        { action: "beginSignIn" },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: START,
            body: { deviceId: DEVICE },
            expectBody: { json: { deviceId: DEVICE }, match: "exact" },
          });
          expect(res.status).toBe(200);
          started = (await res.json()) as Started;
          Object.assign(begun, { prompt: promptOf(started), tokenHeld: false });
        },
        begun,
      );

      await r.step(
        { action: "pollSignIn", now: T0 + 2 },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(await res.json()).toEqual({ status: "pending" });
        },
        { result: "pending", tokenHeld: false },
      );

      lapseFlowRecords(world);

      await r.step(
        {
          action: "pollSignIn",
          now: T0 + 601,
          note: "The flow has lapsed: the Worker says timeout.",
        },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ status: "timeout" });
        },
        { result: "expired", tokenHeld: false },
      );
      await r.step(
        {
          action: "waitForSignIn",
          now: T0 + 601,
          note: "Past expiresIn: no request.",
        },
        async () => {},
        { result: "expired", tokenHeld: false },
      );
      return r.transcript();
    }),
};

// identity-disabled (PX-W17; plans/PX-W17.md §4): a product whose Identity service is off. One
// account per person still owns licences of it; only sign-in THROUGH the product is refused.

/** License and Config on, Identity off: the account-owned licence below still activates. */
const IDENTITY_OFF: ServicesMap = servicesOn("license", "config");

export const identityDisabled: Scenario = {
  id: "identity-disabled",
  record: () =>
    pinned("identity-disabled", async (pin) => {
      const world = await productWorld(IDENTITY_OFF);
      const { key, licenseId } = await seedLicense(world);
      // The licence belongs to a Polaris Key account: licences attach to accounts whatever the
      // product's Identity toggle says.
      const account = await signIn(
        world.db,
        { issuerKey: "email", subject: PLAYER.email, kind: "email" },
        T0,
      );
      if (account.status !== "signed_in") throw new Error(account.status);
      expect(
        await attachLicenseAccount(
          world.db,
          PRODUCT,
          licenseId,
          account.account.id,
          T0,
        ),
      ).toBe(true);

      const r = new TranscriptRecorder({
        id: "identity-disabled",
        description:
          "A product whose Identity service is off (WIRE-CONTRACT-V4 §12.8). The client starts out believing Identity is on (a discovery from before the toggle moved): beginSignIn() posts the device-code start and the Worker answers not_found — device and JSON routes never say 'identity is off' — which the client reports as service-unavailable (service-disabled in React), keeping every piece of state it holds. discover() then installs the real map, Identity off, and the next beginSignIn() fails the same way without sending a request. Licences still attach to accounts: activating a key of an account-owned licence works as on any product, and syncs.",
        features: ["identity.toggle"],
        requires: ["core.discover", "core.store", "license.activate"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["license", "config", "identity"],
        },
      });

      await r.step(
        {
          action: "beginSignIn",
          note: "Mid-session: the client still believes Identity is on. The Worker answers not_found.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: START,
            body: { deviceId: DEVICE },
            expectBody: { json: { deviceId: DEVICE }, match: "exact" },
          });
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: { code: "not_found" } });
        },
        { result: "service-unavailable", tokenHeld: false },
      );

      await r.step(
        {
          action: "discover",
          note: "Discovery is the authority: Identity is off.",
        },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            services: Record<string, { enabled: boolean }>;
          };
          expect(doc.services.identity).toEqual({ enabled: false });
        },
        {
          result: "ok",
          services: {
            license: true,
            config: true,
            release: false,
            distribution: false,
            update: false,
            identity: false,
          },
        },
      );

      await r.step(
        {
          action: "beginSignIn",
          note: "Discovery says Identity is off: fail fast, no request.",
        },
        async () => {},
        { result: "service-unavailable", tokenHeld: false },
      );

      await r.step(
        {
          action: "activate",
          args: { key },
          note: "An account-owned licence activates by key as on any product, then syncs.",
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
          const body = (await res.clone().json()) as Record<string, unknown>;
          expect(body).not.toHaveProperty("keyEntries");
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
        },
        { result: "ok", licenseStatus: "ok", tokenHeld: true },
      );

      // The device was bound by its key: no sign-in binding on an Identity-off product.
      const device = await world.db.first<{ subject: string | null }>(
        "SELECT subject FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      expect(device?.subject ?? null).toBeNull();
      return r.transcript();
    }),
};

/** A label carrying a right-to-left override, a tab and 70 code points (PX-W13, §12.7.1). */
const RAW_LABEL = `Living room TV\u202egnp.exe\t${"x".repeat(70 - 23)}`;

/** The two PX-W13 conversations: one begin each, so only the start is recorded. */
function labelScenario(
  id: string,
  description: string,
  args: Record<string, JsonValue>,
  initialName: string | undefined,
  sent: string,
): Scenario {
  return {
    id,
    record: () =>
      pinned(id, async (pin) => {
        const world = await identityWorld();
        const r = new TranscriptRecorder({
          id,
          description,
          features: ["identity.devicecode", "identity.devicelabel"],
          requires: ["core.store"],
          product: PRODUCT,
          now: T0,
          world,
          pinned: pin,
          initial: {
            deviceId: DEVICE,
            version: VERSION,
            services: ["license", "config", "identity"],
            ...(initialName !== undefined ? { deviceName: initialName } : {}),
          },
        });
        const begun: Record<string, JsonValue> = {};
        await r.step(
          { action: "beginSignIn", args },
          async (s) => {
            const res = await s.send({
              method: "POST",
              path: START,
              body: { deviceId: DEVICE, deviceName: sent },
              expectBody: {
                json: { deviceId: DEVICE, deviceName: sent },
                match: "exact",
              },
            });
            expect(res.status).toBe(200);
            const started = (await res.json()) as Started;
            // The Worker stores exactly what a conforming SDK sends.
            expect(started.deviceName).toBe(sent);
            Object.assign(begun, {
              prompt: promptOf(started),
              tokenHeld: false,
            });
          },
          begun,
        );
        return r.transcript();
      }),
  };
}

export const devicecodeLabel: Scenario = labelScenario(
  "devicecode-label",
  "The device label (WIRE-CONTRACT-V4 §12.7.1). beginSignIn() is passed a raw name carrying a right-to-left override, a tab and 70 code points; the SDK normalises it before sending (the override deleted, the tab a space, cut to 64 code points), so the body holds exactly the normalised label, and the prompt's deviceName is the Worker's echo of it.",
  { deviceName: RAW_LABEL },
  undefined,
  "Living room TVgnp.exe " + "x".repeat(64 - 22),
);

export const devicecodeDefault: Scenario = labelScenario(
  "devicecode-default",
  "The default device label (plans/PX-W13.md §2.1). beginSignIn() with no argument on a host whose platform device name is initial.deviceName: the SDK sends that name as the label, and the prompt's deviceName is the echo.",
  {},
  "Transcript Device",
  "Transcript Device",
);

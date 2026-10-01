/// <reference types="@cloudflare/workers-types" />
// devicecode-happy and devicecode-expired: device-code sign-in (RFC 8628, P1-06) as a client
// drives it — begin, poll at the advertised interval, honour `slow_down`, and on `ready` store
// the device token and run the post-acquisition sync; or watch the flow lapse.
//
// The human half happens between steps, server-side and unrecorded: the player opens the
// verification URI's complete form (the QR payload), confirms the code on the RFC 8628 page, and
// signs in at the IdP, which the scenario mocks (`../idp.ts`). The callback runs for real —
// token exchange, ID-token verification, nonce binding, `activateFromIdentity` — so a device-code
// sign-in is recorded yielding the signed-in identity's OWN licence and nothing merged (P1-06).

import { expect } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { TranscriptRecorder, BASE_URL, type World } from "../recorder.js";
import { DEVICE, document, syncReport, T0, trust, VERSION } from "../client.js";
import { pinned, PRODUCT, productWorld, type Scenario } from "../world.js";
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
const IDENTITY: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: true },
};

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
          "Device-code sign-in (RFC 8628). beginSignIn() posts this device's id and name and hands the host the user code and both verification URIs (the complete one is the QR payload) — never the device code. pollSignIn() asks once per call: pending; a poll one second after the last is told to slow_down (429, with the interval); pending again at the interval. Between polls the player confirms the code on the user-code page and signs in at the (mocked) IdP. The next poll is ready: the client stores the device token and runs the same forced sync activation does. The licence is the signed-in identity's own — the device-code callback merges nothing (P1-06).",
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
          "A device-code flow nobody completes. beginSignIn() with no device name posts the device id alone; one poll is pending. Ten minutes later the flow's records have lapsed and the Worker answers the next poll with timeout, which the client reports as expired, holding no token. waitForSignIn() on the same prompt then makes no request at all: the prompt's expiresIn has passed, and a client stops polling at expiry rather than asking a server that can only say timeout.",
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

/// <reference types="@cloudflare/workers-types" />
// The Cloud Connect relay ticket conversations (CC-07.3; WIRE-CONTRACT-V5 §15.7), recorded
// through the real router:
//
//   connect-relay-ticket   a signed-in, key-registered device asks for a relay ticket: `pkeyrt_`,
//                          the upgrade URL, the subprotocol and a 60 s life; no bearer is `401`;
//                          the launch gate off is `404`
//   connect-relay-quota    the refusals, in their order: the product turned the relay off
//                          (`relay_disabled`), the deployment paused it (`relay_paused`, with
//                          `Retry-After`), the product's month is spent (`relay_quota_exceeded`,
//                          scope `product`)
//
// The identity conversations (CC-06.4; WIRE-CONTRACT-V5 §15.2 to §15.4, §15.9), what
// `client.connect.identity()` and `.listDevices()` do:
//
//   connect-identity           discovery, then the SDK's first identity call: it registers the
//                              device's keys (`PUT /devices/keys`, a `keys` proof) and fetches
//                              the roster, the device's certificate and K_disc; then the list of
//                              the person's devices
//   connect-identity-refusals  the Worker forgot the keys (409 `device_keys_required`: the client
//                              registers once more and asks again); a device with no account
//                              (403 `account_required`); a roster of more than 128 devices
//                              (409 `ring_too_large`); the launch gate off, which discovery
//                              shows (the client sends nothing), and a stale discovery (404)
//   connect-identity-rotate    a third device joins (epoch up, the old K_disc kept 24 h), it
//                              leaves (epoch up, no previous K_disc), then this device rotates its
//                              keys (a re-registration; epoch up, no previous K_disc)
//
// The device keys are fixtures derived from a label (`fixtureDeviceKeys`), so a replaying client
// sends the recorded registration bytes.
//
// The WebSocket upgrade is not recorded: a transcript is HTTP request and response.

import { expect } from "vitest";
import {
  BASE_URL,
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  emptyWorld,
  pinned,
  PRODUCT,
  seedLicense,
  servicesOn,
  type Scenario,
} from "../world.js";
import type { Pinned } from "../determinism.js";
import { seedProduct } from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { seedAccount } from "./account.js";
import { fixtureDeviceKeys } from "../providers.js";
import { discovery } from "../client.js";
import type { JsonValue } from "../format.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { deleteDeviceKeys } from "../../../src/core/devices/keys.js";

const FEATURES = ["connect.relay"];
const REQUIRES = ["core.store"];

/** A relay namespace that is bound; the ticket route never calls it. */
const BOUND_RELAY = {
  idFromName: (n: string) => n,
  get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
} as unknown as DurableObjectNamespace;

async function relayWorld(): Promise<{ world: World; token: string }> {
  const { world, token } = await identityWorld();
  await upsertDeviceKeys(world.db, PRODUCT, DEVICE, await newKeys(), T0);
  (world.env as unknown as Record<string, unknown>).CONNECT_RELAY = BOUND_RELAY;
  return { world, token };
}

function recorder(
  id: string,
  description: string,
  pin: Pinned,
  world: World,
  token: string,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features: FEATURES,
    requires: REQUIRES,
    product: PRODUCT,
    now: T0,
    world,
    pinned: pin,
    initial: { deviceId: DEVICE, token, version: VERSION },
  });
}

/** One ticket request, with `expect` read off the answer. */
async function ticket(
  r: TranscriptRecorder,
  note: string,
  opts: { bearer?: boolean } = {},
): Promise<number> {
  let status = 0;
  const exp: Record<string, string | number> = {};
  await r.step(
    { action: "relayTicket", note },
    async (s: StepRecorder) => {
      const res = await s.send({
        method: "POST",
        path: `/${PRODUCT}/connect/relay/ticket`,
        ...(opts.bearer === false ? {} : { bearer: "token" as const }),
      });
      status = res.status;
      const body = (await res.clone().json()) as Record<string, any>;
      if (res.status >= 400) {
        exp.result = "refused";
        exp.status = res.status;
        exp.code = body.error?.code ?? body.error ?? "not_found";
        if (body.scope !== undefined) exp.scope = body.scope;
        const retry = res.headers.get("retry-after");
        if (retry !== null) exp.retryAfter = Number(retry);
        return;
      }
      expect(body.ticket).toMatch(/^pkeyrt_[A-Za-z0-9_-]{32}$/);
      Object.assign(exp, {
        result: "ok",
        protocol: body.protocol,
        url: body.url,
        expiresIn: body.expiresAt - T0,
      });
    },
    exp,
  );
  return status;
}

export const connectRelayTicket: Scenario = {
  id: "connect-relay-ticket",
  record: () =>
    pinned("connect-relay-ticket", async (pin) => {
      const { world, token } = await relayWorld();
      const r = recorder(
        "connect-relay-ticket",
        "The relay ticket (WIRE-CONTRACT-V5 §15.7). A signed-in device with registered keys trades its bearer for a single-use pkeyrt_ ticket that lives 60 seconds, with the WebSocket URL and the pkey-relay.1 subprotocol. Without the bearer it is 401. With the operator's launch gate (launch.relay) off the route does not exist: 404.",
        pin,
        world,
        token,
      );
      expect(await ticket(r, "A ticket.")).toBe(200);
      expect(await ticket(r, "No bearer.", { bearer: false })).toBe(401);
      (world.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
      expect(await ticket(r, "The launch gate is off.")).toBe(404);
      return r.transcript();
    }),
};

export const connectRelayQuota: Scenario = {
  id: "connect-relay-quota",
  record: () =>
    pinned("connect-relay-quota", async (pin) => {
      const { world, token } = await relayWorld();
      const r = recorder(
        "connect-relay-quota",
        "The relay refusals (WIRE-CONTRACT-V5 §15.7), in their order. The product turned its relay off: 403 relay_disabled. The deployment paused the relay: 503 relay_paused with Retry-After. The product's month of relay bytes is spent: 429 relay_quota_exceeded with scope product. The local network is never metered, so none of these touches a LAN connection.",
        pin,
        world,
        token,
      );
      await world.db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'cloudConnect.relay.enabled', 'false', 'console', ?, 'transcript')`,
        PRODUCT,
        T0,
      );
      expect(await ticket(r, "The product turned the relay off.")).toBe(403);
      await world.db.run(
        "DELETE FROM product_settings WHERE product = ?",
        PRODUCT,
      );

      await world.db.run(
        `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
         VALUES ('cloudConnect.relayPaused', '"on"', 1, ?, 'transcript')`,
        T0,
      );
      invalidatePlatformSettings(world.env, world.db);
      expect(await ticket(r, "The deployment paused the relay.")).toBe(503);
      await world.db.run("DELETE FROM platform_settings");
      invalidatePlatformSettings(world.env, world.db);

      await world.db.run(
        `INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES (?, ?, ?, 1)`,
        PRODUCT,
        new Date(T0 * 1000).toISOString().slice(0, 10),
        500 * 1024 ** 3,
      );
      expect(await ticket(r, "The month is spent.")).toBe(429);
      return r.transcript();
    }),
};

// ── Identity ────────────────────────────────────────────────────────────────────────────────────

const ID_FEATURES = ["connect.identity"];
const KEYS_A = "transcript-connect-key-1";
const KEYS_B = "transcript-connect-key-2";
/** Other devices of the same person, registered outside the recording. */
const PEER = "TRANSCRIPTDEVICE0000000000000002";
const THIRD = "TRANSCRIPTDEVICE0000000000000003";

interface IdentityWorld {
  world: World;
  token: string;
  key: string;
  subject: string;
}

/** The recorded device holds a token and (unless `account` is false) a signed-in account. Its keys
 *  are not registered: the client does that. `peers` are other devices of the person, with keys. */
async function identityWorld(
  opts: { account?: boolean; peers?: string[] } = {},
): Promise<IdentityWorld> {
  const world = emptyWorld();
  await seedProduct(world.db, PRODUCT);
  await setServices(
    world.db,
    PRODUCT,
    serializeServices({
      services: servicesOn("license", "identity", "connect"),
    }),
    "manifest",
    T0,
  );
  const { key } = await seedLicense(world);
  const { subject } = await seedAccount(world, "ada@example.com");
  const token = await activated(world, key);
  if (opts.account !== false)
    expect(
      await setDeviceSubject(world.env, world.db, PRODUCT, DEVICE, subject),
    ).toBe(true);
  for (const id of opts.peers ?? []) await addPeer(world, key, subject, id);
  return { world, token, key, subject };
}

async function addPeer(
  world: World,
  key: string,
  subject: string,
  deviceId: string,
): Promise<void> {
  const res = await dispatchWith(
    new Request(`${BASE_URL}/${PRODUCT}/license/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-pkey-device": deviceId },
    }) as unknown as Request,
    world.env,
    world.db,
    T0,
  );
  expect(res.status).toBe(200);
  expect(
    await setDeviceSubject(world.env, world.db, PRODUCT, deviceId, subject),
  ).toBe(true);
  const k = fixtureDeviceKeys(`${deviceId}-keys`);
  await upsertDeviceKeys(
    world.db,
    PRODUCT,
    deviceId,
    { signKey: k.signKey, agreeKey: k.agreeKey },
    T0,
  );
}

function idRecorder(
  id: string,
  description: string,
  pin: Pinned,
  w: IdentityWorld,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features: ID_FEATURES,
    requires: REQUIRES,
    product: PRODUCT,
    now: T0,
    world: w.world,
    pinned: pin,
    initial: { deviceId: DEVICE, token: w.token, version: VERSION },
  });
}

/** `discover`: the document the client reads the Cloud Connect service from. */
async function discoverStep(r: TranscriptRecorder, note: string) {
  await r.step(
    { action: "discover", note },
    async (s) => {
      expect((await discovery(s, PRODUCT)).status).toBe(200);
    },
    { result: "ok" },
  );
}

/** `PUT /<p>/devices/keys` as the SDK sends it: the fixture keys and their `keys` proof. */
async function registerKeys(s: StepRecorder, label: string): Promise<void> {
  const keys = fixtureDeviceKeys(label);
  const body = {
    signKey: keys.signKey,
    agreeKey: keys.agreeKey,
    issuedAt: s.now,
    sig: keys.proof({
      purpose: "keys",
      product: PRODUCT,
      deviceId: DEVICE,
      value: `${keys.signKey}.${keys.agreeKey}.${s.now}`,
      token: null,
    }),
  };
  const res = await s.send({
    method: "PUT",
    path: `/${PRODUCT}/devices/keys`,
    bearer: "token",
    body,
    expectBody: { json: body, match: "exact" },
  });
  expect(res.status).toBe(200);
}

const getIdentity = (s: StepRecorder): Promise<Response> =>
  s.send({
    method: "GET",
    path: `/${PRODUCT}/connect/identity`,
    bearer: "token",
  });

const claims = (jws: string): Record<string, any> =>
  JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));

/** Record what the client reports of an identity answer; a refusal as `refused` with its code. */
async function identityOutcome(
  res: Response,
  exp: Record<string, JsonValue>,
): Promise<void> {
  const body = (await res.clone().json()) as Record<string, any>;
  if (res.status >= 400) {
    exp.result = "refused";
    exp.code = body.error?.code ?? body.error ?? "not_found";
    return;
  }
  const ring = claims(body.ring);
  const cert = claims(body.certificate);
  Object.assign(exp, {
    result: "ok",
    epoch: ring.epoch,
    devices: ring.devices.map((d: { deviceId: string }) => d.deviceId),
    deviceId: cert.deviceId,
    discKeys: body.discKeys.length,
  });
}

interface IdentityStep {
  note: string;
  keyLabel: string;
  /** Send the registration first (the client holds none for these keys). */
  register?: boolean;
  /** The GET is refused once and the client registers again, then asks again. */
  recover?: boolean;
  refresh?: boolean;
  /** The client clock; a key change must carry a newer proof than the last (seconds after T0). */
  at?: number;
  /** Not sent: the client refuses (discovery names no Cloud Connect). */
  unavailable?: boolean;
}

async function identityStep(
  r: TranscriptRecorder,
  o: IdentityStep,
): Promise<Response | null> {
  let last: Response | null = null;
  const exp: Record<string, JsonValue> = {};
  await r.step(
    {
      action: "connectIdentity",
      note: o.note,
      ...(o.at !== undefined ? { now: T0 + o.at } : {}),
      args: {
        keyLabel: o.keyLabel,
        ...(o.refresh ? { refresh: true } : {}),
      },
    },
    async (s) => {
      if (o.unavailable) {
        exp.result = "unavailable";
        return;
      }
      if (o.register) await registerKeys(s, o.keyLabel);
      last = await getIdentity(s);
      if (o.recover) {
        expect(last.status).toBe(409);
        await registerKeys(s, o.keyLabel);
        last = await getIdentity(s);
      }
      await identityOutcome(last, exp);
    },
    exp,
  );
  return last;
}

export const connectIdentity: Scenario = {
  id: "connect-identity",
  record: () =>
    pinned("connect-identity", async (pin) => {
      const w = await identityWorld({ peers: [PEER] });
      const r = idRecorder(
        "connect-identity",
        "The Cloud Connect identity (WIRE-CONTRACT-V5 §15.2 to §15.4). Discovery names the connect service. The SDK's first identity call makes the device's keys and registers them (PUT devices/keys, the keys proof), then asks GET connect/identity: the signed roster of the person's devices at its epoch, this device's certificate, and K_disc (one key until a device has joined or left). The device list is display data only, with no key, and marks this device self.",
        pin,
        w,
      );
      await discoverStep(r, "Discovery names Cloud Connect.");
      const res = await identityStep(r, {
        note: "The first call: register the keys, fetch the identity.",
        keyLabel: KEYS_A,
        register: true,
      });
      expect(res?.status).toBe(200);
      const exp: Record<string, JsonValue> = {};
      await r.step(
        {
          action: "connectDevices",
          note: "The person's devices.",
          args: { keyLabel: KEYS_A },
        },
        async (s) => {
          const list = await s.send({
            method: "GET",
            path: `/${PRODUCT}/connect/devices`,
            bearer: "token",
          });
          expect(list.status).toBe(200);
          Object.assign(exp, {
            result: "ok",
            devices: ((await list.clone().json()) as { devices: JsonValue })
              .devices,
          });
        },
        exp,
      );
      return r.transcript();
    }),
};

export const connectIdentityRefusals: Scenario = {
  id: "connect-identity-refusals",
  record: () =>
    pinned("connect-identity-refusals", async (pin) => {
      const w = await identityWorld({ peers: [PEER] });
      const r = idRecorder(
        "connect-identity-refusals",
        "The Cloud Connect identity refusals (WIRE-CONTRACT-V5 §15.9). A device the Worker forgot the keys of answers 409 device_keys_required: the client registers them again and asks again, once. A device with no signed-in account is 403 account_required (with the signInUrl). More than 128 devices is 409 ring_too_large, checked before the epoch moves. With the launch gate (launch.connect) off, discovery shows connect off and the client sends nothing; a client holding an earlier discovery gets 404.",
        pin,
        w,
      );
      await discoverStep(r, "Discovery names Cloud Connect.");
      await identityStep(r, {
        note: "The first call.",
        keyLabel: KEYS_A,
        register: true,
      });
      await deleteDeviceKeys(w.world.db, PRODUCT, DEVICE);
      await identityStep(r, {
        note: "The Worker forgot the keys: 409, register again, ask again.",
        keyLabel: KEYS_A,
        at: 100,
        refresh: true,
        recover: true,
      });

      // No account: the device's principal is gone.
      await w.world.db.run(
        "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      const noAccount = await identityStep(r, {
        note: "No signed-in account: 403 account_required.",
        at: 110,
        keyLabel: KEYS_A,
        refresh: true,
      });
      expect(noAccount?.status).toBe(403);
      await w.world.db.run(
        "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
        w.subject,
        PRODUCT,
        DEVICE,
      );

      // More than 128 devices of the person.
      const copy = (await w.world.db.first<Record<string, unknown>>(
        "SELECT * FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      ))!;
      const cols = Object.keys(copy);
      for (let i = 0; i < 128; i++) {
        const id = `TRANSCRIPTDEVICEBULK${String(i).padStart(12, "0")}`;
        const row = {
          ...copy,
          device_id: id,
          token_hash: `bulk-${i}`,
          seat_no: 1000 + i,
        };
        await w.world.db.run(
          `INSERT INTO devices (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          ...cols.map((c) => row[c as keyof typeof row]),
        );
        const k = fixtureDeviceKeys(`${id}-keys`);
        await upsertDeviceKeys(
          w.world.db,
          PRODUCT,
          id,
          { signKey: k.signKey, agreeKey: k.agreeKey },
          T0,
        );
      }
      const big = await identityStep(r, {
        note: "More than 128 devices: 409 ring_too_large.",
        at: 120,
        keyLabel: KEYS_A,
        refresh: true,
      });
      expect(big?.status).toBe(409);
      await w.world.db.run(
        "DELETE FROM device_keys WHERE device_id LIKE 'TRANSCRIPTDEVICEBULK%'",
      );

      // The launch gate off: a client with an earlier discovery gets 404, one that reads the
      // new discovery sends nothing.
      (w.world.env as unknown as Record<string, string>).LAUNCH_CONNECT = "off";
      const gone = await identityStep(r, {
        note: "The gate was turned off since discovery: 404.",
        at: 130,
        keyLabel: KEYS_A,
        refresh: true,
      });
      expect(gone?.status).toBe(404);
      await r.step(
        {
          action: "discover",
          note: "Discovery shows Cloud Connect off.",
        },
        async (s) => {
          const d = await discovery(s, PRODUCT);
          expect(d.status).toBe(200);
          expect(
            ((await d.clone().json()) as { services: Record<string, unknown> })
              .services.connect,
          ).toEqual({ enabled: false });
        },
        { result: "ok" },
      );
      await identityStep(r, {
        note: "The client sends nothing.",
        at: 140,
        keyLabel: KEYS_A,
        refresh: true,
        unavailable: true,
      });
      return r.transcript();
    }),
};

export const connectIdentityRotate: Scenario = {
  id: "connect-identity-rotate",
  record: () =>
    pinned("connect-identity-rotate", async (pin) => {
      const w = await identityWorld({ peers: [PEER] });
      const r = idRecorder(
        "connect-identity-rotate",
        "The roster epoch and K_disc over a person's changes (WIRE-CONTRACT-V5 §15.3, §15.4). A device joins: the epoch rises, a new K_disc is drawn and the old one is delivered beside it for 24 hours (two keys). The device leaves: the epoch rises and the previous key is dropped (one key). This device rotates its keys, which is a re-registration the Worker treats as a leave: the epoch rises and only the new K_disc comes.",
        pin,
        w,
      );
      await discoverStep(r, "Discovery names Cloud Connect.");
      await identityStep(r, {
        note: "The first call.",
        keyLabel: KEYS_A,
        register: true,
      });
      await addPeer(w.world, w.key, w.subject, THIRD);
      await identityStep(r, {
        note: "A device joined: the epoch rises, two K_disc keys.",
        at: 10,
        keyLabel: KEYS_A,
        refresh: true,
      });
      await deleteDeviceKeys(w.world.db, PRODUCT, THIRD);
      await identityStep(r, {
        note: "The device left: the epoch rises, the previous K_disc is gone.",
        at: 20,
        keyLabel: KEYS_A,
        refresh: true,
      });
      await identityStep(r, {
        note: "This device rotated its keys: registered again, the epoch rises.",
        at: 30,
        keyLabel: KEYS_B,
        register: true,
      });
      return r.transcript();
    }),
};

export const CONNECT_SCENARIOS: Scenario[] = [
  connectRelayTicket,
  connectRelayQuota,
  connectIdentity,
  connectIdentityRefusals,
  connectIdentityRotate,
];

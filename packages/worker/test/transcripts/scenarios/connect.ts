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
// The WebSocket upgrade is not recorded: a transcript is HTTP request and response.

import { expect } from "vitest";
import {
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

const FEATURES = ["connect.relay"];
const REQUIRES = ["core.store"];

/** A relay namespace that is bound; the ticket route never calls it. */
const BOUND_RELAY = {
  idFromName: (n: string) => n,
  get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
} as unknown as DurableObjectNamespace;

async function relayWorld(): Promise<{ world: World; token: string }> {
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
  expect(
    await setDeviceSubject(world.env, world.db, PRODUCT, DEVICE, subject),
  ).toBe(true);
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

export const CONNECT_SCENARIOS: Scenario[] = [
  connectRelayTicket,
  connectRelayQuota,
];

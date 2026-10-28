/// <reference types="@cloudflare/workers-types" />
/**
 * CC-07.3: `POST /<p>/connect/relay/ticket` and `GET /<p>/connect/relay` (WIRE-CONTRACT-V5 §15.7):
 * the single-use ticket, the refusals in their order, the quota, and what the relay room is given.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { NOW } from "../../seed.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import {
  decodeAdmission,
  ADMISSION_HEADER,
} from "../../../src/services/connect/do/admission.js";
import { ticketFromProtocols } from "../../../src/services/connect/relay/handlers.js";
import { b64urlDecodeStrict, hexEncode } from "../../../src/platform/bytes.js";
import { releaseSeat } from "./relayRoutesSupport.js";
import { SLUG, BASE, A, B, type World, world } from "./connectFixture.js";

interface Room {
  requests: Request[];
}

/** A relay namespace that records what the Worker hands the room. */
function fakeRoom(): { ns: DurableObjectNamespace; room: Room } {
  const room: Room = { requests: [] };
  const ns = {
    idFromName: (n: string) => n as unknown as DurableObjectId,
    get: () => ({
      fetch: async (req: Request) => {
        room.requests.push(req);
        return new Response("room", { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, room };
}

const post = (w: World, deviceId: string | null, token: string | null) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/connect/relay/ticket`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { "x-pkey-device": deviceId } : {}),
      },
    }) as unknown as Request,
    w.env,
    w.db,
    NOW,
  );

const upgrade = (
  w: World,
  protocols: string | null,
  extra: Record<string, string> = {},
  now = NOW,
) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/connect/relay`, {
      headers: {
        upgrade: "websocket",
        ...(protocols ? { "sec-websocket-protocol": protocols } : {}),
        ...extra,
      },
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );

const ticketOf = async (w: World, d = A): Promise<string> => {
  const res = await post(w, d, w.tokens[d]!);
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
};

const GiB = 1024 ** 3;

describe("the relay routes", () => {
  let w: World;
  let room: Room;
  beforeEach(async () => {
    w = await world();
    const f = fakeRoom();
    room = f.room;
    (w.env as unknown as Record<string, unknown>).CONNECT_RELAY = f.ns;
  });

  const putPlatform = async (key: string, value: string) => {
    await w.db.run(
      `INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES (?, ?, 1, ?, 'test')`,
      key,
      value,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
  };
  const putProduct = (key: string, value: string) =>
    w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, ?, ?, 'console', ?, 'test')`,
      SLUG,
      key,
      value,
      NOW,
    );

  it("issues a pkeyrt_ ticket with the url, protocol and a 60 s expiry, uncached", async () => {
    const res = await post(w, A, w.tokens[A]!);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ticket).toMatch(/^pkeyrt_[A-Za-z0-9_-]{32}$/);
    expect(body.url).toBe(`wss://key.plrs.im/${SLUG}/connect/relay`);
    expect(body.protocol).toBe("pkey-relay.1");
    expect(body.expiresAt).toBe(NOW + 60);
  });

  it("answers the registry's not-found with the launch gate off or the relay unbound", async () => {
    (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
    expect((await post(w, A, w.tokens[A]!)).status).toBe(404);
    expect((await upgrade(w, "pkey-relay.1, pkeyrt_x")).status).toBe(404);
    (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "on";
    delete (w.env as unknown as Record<string, unknown>).CONNECT_RELAY;
    expect((await post(w, A, w.tokens[A]!)).status).toBe(404);
    expect(room.requests).toHaveLength(0);
  });

  it("wants the device's own credential: no bearer, a bad bearer, another device's header", async () => {
    expect((await post(w, A, null)).status).toBe(401);
    expect((await post(w, A, "pkeyt_nope")).status).toBe(401);
    expect((await post(w, B, w.tokens[A]!)).status).toBe(401);
    expect((await post(w, null, w.tokens[A]!)).status).toBe(400);
    const get = await dispatchWith(
      new Request(`${BASE}/${SLUG}/connect/relay/ticket`, {
        headers: { authorization: `Bearer ${w.tokens[A]}`, "x-pkey-device": A },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    expect(get.status).toBe(405);
  });

  it("refuses a device that is not in its own roster", async () => {
    await releaseSeat(w, A);
    const res = await post(w, A, w.tokens[A]!);
    expect([401, 409]).toContain(res.status);
  });

  it("refuses in order: relay switch off, deployment pause, month spent", async () => {
    await putProduct("cloudConnect.relay.enabled", "false");
    const off = await post(w, A, w.tokens[A]!);
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe(
      "relay_disabled",
    );

    await w.db.run("DELETE FROM product_settings");
    await putPlatform("cloudConnect.relayPaused", '"on"');
    const paused = await post(w, A, w.tokens[A]!);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("300");
    expect(
      ((await paused.json()) as { error: { code: string } }).error.code,
    ).toBe("relay_paused");

    await w.db.run("DELETE FROM platform_settings");
    invalidatePlatformSettings(w.env, w.db);
    await w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES (?, '2023-11-01', ?, 1)",
      SLUG,
      500 * GiB,
    );
    const over = await post(w, A, w.tokens[A]!);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({
      error: { code: "relay_quota_exceeded" },
      scope: "product",
    });
  });

  it("lets the product lower its month ceiling, and counts only this month", async () => {
    await w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES (?, '2023-10-31', ?, 1)",
      SLUG,
      10,
    );
    await putProduct("cloudConnect.ceiling.relayBytes", "100");
    expect((await post(w, A, w.tokens[A]!)).status).toBe(200);
    await w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES (?, '2023-11-02', 100, 1)",
      SLUG,
    );
    expect((await post(w, A, w.tokens[A]!)).status).toBe(429);
  });

  it("forwards an upgrade once: the room gets the admission, the bare subprotocol and no credential", async () => {
    const ticket = await ticketOf(w);
    const res = await upgrade(w, `pkey-relay.1, ${ticket}`, {
      authorization: "Bearer secret",
      cookie: "s=1",
      [ADMISSION_HEADER]: "forged",
      "x-pkey-device": B,
    });
    expect(res.status).toBe(200);
    expect(room.requests).toHaveLength(1);
    const fwd = room.requests[0]!;
    expect(fwd.headers.get("sec-websocket-protocol")).toBe("pkey-relay.1");
    expect(fwd.headers.get("authorization")).toBeNull();
    expect(fwd.headers.get("cookie")).toBeNull();
    expect([...fwd.headers.values()].join("\n")).not.toContain(ticket);
    const adm = decodeAdmission(fwd.headers.get(ADMISSION_HEADER))!;
    expect(adm.product).toBe(SLUG);
    expect(adm.subject).toBe(w.subject);
    expect(hexEncode(adm.ticket.device)).toBe(
      hexEncode(b64urlDecodeStrict(A)!),
    );
    expect(adm.ticket.members.map(hexEncode).sort()).toEqual(
      [A, B].map((d) => hexEncode(b64urlDecodeStrict(d)!)).sort(),
    );
    expect(adm.ticket.dayBytes).toBe(256 * 1024 ** 2);
    expect(adm.ticket.paused).toBe(false);
    expect(adm.ticket.productOver).toBe(false);
    expect(adm.ticket.expiresAt).toBe((NOW + 60) * 1000);
    expect(adm.monthCeiling).toBe(500 * GiB);

    // Single use: the same ticket again is refused.
    const again = await upgrade(w, `pkey-relay.1, ${ticket}`);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({
      error: { code: "relay_ticket_invalid" },
    });
    expect(room.requests).toHaveLength(1);
  });

  it("takes the roster fresh at the upgrade, not from the ticket", async () => {
    const ticket = await ticketOf(w);
    await releaseSeat(w, B);
    expect((await upgrade(w, `pkey-relay.1, ${ticket}`)).status).toBe(200);
    const adm = decodeAdmission(
      room.requests[0]!.headers.get(ADMISSION_HEADER),
    )!;
    expect(adm.ticket.members).toHaveLength(1);
  });

  it("refuses a ticket after it expired, for another product, or after the device left its person", async () => {
    const t1 = await ticketOf(w);
    expect((await upgrade(w, `pkey-relay.1, ${t1}`, {}, NOW + 61)).status).toBe(
      401,
    );
    const t2 = await ticketOf(w);
    await w.db.run(
      "UPDATE devices SET subject = 'ps_other' WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    expect((await upgrade(w, `pkey-relay.1, ${t2}`)).status).toBe(401);
    expect(room.requests).toHaveLength(0);
  });

  it("re-asks the refusals at the upgrade", async () => {
    const ticket = await ticketOf(w);
    await putPlatform("cloudConnect.relayPaused", '"on"');
    const res = await upgrade(w, `pkey-relay.1, ${ticket}`);
    expect(res.status).toBe(503);
    expect(room.requests).toHaveLength(0);
  });

  it("refuses a malformed handshake with the ticket error and a non-upgrade with 426", async () => {
    const ticket = await ticketOf(w);
    for (const p of [
      null,
      "pkey-relay.1",
      ticket,
      "pkey-relay.1, pkeyrt_short",
      `pkey-relay.1, ${ticket}, ${ticket}`,
      "x".repeat(600),
    ])
      expect((await upgrade(w, p)).status).toBe(401);
    const plain = await dispatchWith(
      new Request(`${BASE}/${SLUG}/connect/relay`, {
        headers: { "sec-websocket-protocol": `pkey-relay.1, ${ticket}` },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    expect(plain.status).toBe(426);
    // The unspent ticket still works afterwards.
    expect((await upgrade(w, `pkey-relay.1, ${ticket}`)).status).toBe(200);
  });

  it("stores only a hash of the ticket", async () => {
    const ticket = await ticketOf(w);
    const ns = w.env.SINGLE_USE as unknown as { dump?: () => string };
    if (ns.dump) expect(ns.dump()).not.toContain(ticket);
    expect(ticketFromProtocols(`pkey-relay.1, ${ticket}`)).toBe(ticket);
  });

  it("is offered in discovery only while the gate is on", async () => {
    const get = async () =>
      (await (
        await dispatchWith(
          new Request(
            `${BASE}/${SLUG}/.well-known/polaris.json`,
          ) as unknown as Request,
          w.env,
          w.db,
          NOW,
        )
      ).json()) as {
        services: {
          connect: { relay: boolean; endpoints: { ticket: string | null } };
        };
      };
    const on = await get();
    expect(on.services.connect.relay).toBe(true);
    expect(on.services.connect.endpoints.ticket).toBe(
      `${BASE}/${SLUG}/connect/relay/ticket`,
    );
    (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
    const off = await get();
    expect(off.services.connect.relay).toBe(false);
    expect(off.services.connect.endpoints.ticket).toBeNull();
  });
});

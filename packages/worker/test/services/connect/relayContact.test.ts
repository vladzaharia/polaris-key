/// <reference types="@cloudflare/workers-types" />
/**
 * CC-19.3: contact tickets on `POST /<p>/connect/relay/ticket` and their upgrade
 * (WIRE-CONTRACT-V5 §15.7, §15.9, §15.10): the body, the gates and their order, the echo, the
 * 30 an hour and 64 rooms limits (both 429, fail closed), the binding to one room, and the
 * discovery member `interAccount`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { NOW } from "../../seed.js";
import {
  ADMISSION_HEADER,
  decodeAdmission,
} from "../../../src/services/connect/do/admission.js";
import { SLUG, BASE, A, B, type World, world } from "./connectFixture.js";

const RID = "lXg0MgIHVN5qAmGFUen7vA";
const RID2 = "6RpsJG2eU_l_4fHyu0rqyA";
const BODY = (rid = RID) => JSON.stringify({ room: "c", rid });

interface Call {
  name: string;
  path: string;
  req: Request;
}
interface Fake {
  ns: DurableObjectNamespace;
  calls: Call[];
  /** How the account room answers `POST /rooms`. */
  rooms: { status: number } | "throw";
}

/** A relay namespace that records the rooms the Worker names and answers the count call. */
function fake(): Fake {
  const f: Fake = {
    calls: [],
    rooms: { status: 204 },
    ns: undefined as never,
  };
  f.ns = {
    idFromName: (n: string) => n as unknown as DurableObjectId,
    get: (id: unknown) => ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        f.calls.push({ name: String(id), path, req: req.clone() });
        if (path === "/rooms") {
          if (f.rooms === "throw") throw new Error("down");
          return new Response(null, { status: f.rooms.status });
        }
        return new Response("room", { status: 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return f;
}

const post = (
  w: World,
  body: string | null,
  opts: { token?: string | null; device?: string; now?: number } = {},
) => {
  const device = opts.device ?? A;
  const token = opts.token === undefined ? w.tokens[device] : opts.token;
  return dispatchWith(
    new Request(`${BASE}/${SLUG}/connect/relay/ticket`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-pkey-device": device,
      },
      ...(body === null ? {} : { body }),
    }) as unknown as Request,
    w.env,
    w.db,
    opts.now ?? NOW,
  );
};

const upgrade = (w: World, ticket: string, now = NOW) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/connect/relay`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `pkey-relay.1, ${ticket}`,
      },
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );

const codeOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe("contact tickets", () => {
  let w: World;
  let f: Fake;
  const env = () => w.env as unknown as Record<string, unknown>;
  const setting = (value: "true" | "false") =>
    w.db.run(
      `INSERT OR REPLACE INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'cloudConnect.interAccount', ?, 'console', ?, 'test')`,
      SLUG,
      value,
      NOW,
    );

  beforeEach(async () => {
    w = await world();
    f = fake();
    env().CONNECT_RELAY = f.ns;
    await setting("true");
  });

  it("issues a ticket that echoes the room, and counts the room against the person's 64", async () => {
    const res = await post(w, BODY());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.room).toBe("c");
    expect(body.ticket).toMatch(/^pkeyrt_[A-Za-z0-9_-]{32}$/);
    expect(body.url).toBe(`wss://key.plrs.im/${SLUG}/connect/relay`);
    expect(body.protocol).toBe("pkey-relay.1");
    expect(body.expiresAt).toBe(NOW + 60);
    // The count went to the person's account room, naming the product, the person and the rid.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.name).toBe(`${SLUG}:${w.subject}`);
    expect(f.calls[0]!.path).toBe("/rooms");
    expect(await f.calls[0]!.req.json()).toEqual({
      product: SLUG,
      subject: w.subject,
      rid: RID,
    });
  });

  it("answers an account ticket, with no body, with no room member and no count", async () => {
    const res = await post(w, null);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("room");
    expect(f.calls).toHaveLength(0);
    // An empty body is no body.
    const empty = await post(w, "");
    expect(empty.status).toBe(200);
    expect(await empty.json()).not.toHaveProperty("room");
  });

  it("is connect_links_disabled while the setting, the gate or the service is off, before the body or the caller is read", async () => {
    const off: [string, () => Promise<void> | void][] = [
      ["the setting", () => setting("false")],
      ["the gate", () => void (env().LAUNCH_CONNECT_LINKS = "off")],
      ["the gate unset", () => void delete env().LAUNCH_CONNECT_LINKS],
    ];
    for (const [label, turnOff] of off) {
      const x = await world();
      (x.env as unknown as Record<string, unknown>).CONNECT_RELAY = f.ns;
      w = x;
      await setting("true");
      await turnOff();
      // Garbage body and no credential: the gate answers first.
      for (const body of [BODY(), "not json", "x".repeat(600)]) {
        const res = await post(w, body, { token: null });
        expect(res.status, label).toBe(403);
        expect(await codeOf(res), label).toBe("connect_links_disabled");
      }
      // The account ticket is untouched.
      expect((await post(w, null)).status, label).toBe(200);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("is off by default: the setting is off until a product turns it on", async () => {
    await w.db.run("DELETE FROM product_settings");
    const res = await post(w, BODY());
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("connect_links_disabled");
  });

  it("answers the registry's not-found while the relay is off, whatever the body", async () => {
    env().LAUNCH_RELAY = "off";
    expect((await post(w, BODY())).status).toBe(404);
    env().LAUNCH_RELAY = "on";
    delete env().CONNECT_RELAY;
    expect((await post(w, BODY())).status).toBe(404);
  });

  it("wants the device's own credential for a contact ticket", async () => {
    expect((await post(w, BODY(), { token: null })).status).toBe(401);
    expect((await post(w, BODY(), { token: "pkeyt_nope" })).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a body that is not exactly room c and a canonical rid with bad_request", async () => {
    const bad = [
      "{}",
      "not json",
      '{"room":"a","rid":"' + RID + '"}',
      '{"room":"c"}',
      '{"rid":"' + RID + '"}',
      '{"room":"c","rid":"lXg0MgIHVN5qAmGFUen7v"}',
      '{"room":"c","rid":"lXg0MgIHVN5qAmGFUen7vB"}',
      '{"room":"c","rid":"' + RID + '","x":1}',
      '{"room":"c","rid":"' + RID + '","room":"c"}',
      '{"room":"c","rid":7}',
      '{"room":"c","rid":"' + RID + '"}' + " ".repeat(224),
      "x".repeat(4000),
    ];
    for (const body of bad) {
      const res = await post(w, body);
      expect(res.status, body.slice(0, 40)).toBe(400);
      expect(await codeOf(res)).toBe("bad_request");
    }
    // 256 bytes exactly is read, not refused for its size.
    const edge = '{"room":"c","rid":"' + RID + '"}';
    expect((await post(w, edge + " ".repeat(256 - edge.length))).status).toBe(
      200,
    );
    expect(f.calls).toHaveLength(1);
  });

  it("fails closed with rate_limited when the 64 rooms are held or the count cannot be read, and issues no ticket", async () => {
    f.rooms = { status: 429 };
    const full = await post(w, BODY());
    expect(full.status).toBe(429);
    expect(await codeOf(full)).toBe("rate_limited");
    f.rooms = "throw";
    const down = await post(w, BODY(), { now: NOW + 5 });
    expect(down.status).toBe(429);
    expect(await codeOf(down)).toBe("rate_limited");
    f.rooms = { status: 500 };
    expect((await post(w, BODY(), { now: NOW + 10 })).status).toBe(429);
    // Nothing was issued: an account ticket is unaffected.
    expect((await post(w, null, { now: NOW + 15 })).status).toBe(200);
  });

  it("limits contact tickets to 30 an hour per device, and another device has its own", async () => {
    // Spread over three minutes so the 12 a minute limit does not answer first.
    for (let i = 0; i < 30; i++)
      expect((await post(w, BODY(), { now: NOW + i * 6 })).status, `${i}`).toBe(
        200,
      );
    const over = await post(w, BODY(), { now: NOW + 181 });
    expect(over.status).toBe(429);
    expect(await codeOf(over)).toBe("rate_limited");
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await post(w, BODY(), { device: B, now: NOW + 181 })).status).toBe(
      200,
    );
    // Account tickets do not count against the 30.
    expect((await post(w, null, { now: NOW + 182 })).status).toBe(200);
    // The window turns over after the hour.
    expect((await post(w, BODY(), { now: NOW + 3_700 })).status).toBe(200);
  });

  it("binds the ticket to its room: the upgrade names the contact room and hands over only the one device", async () => {
    const t = ((await (await post(w, BODY(RID2))).json()) as { ticket: string })
      .ticket;
    f.calls.length = 0;
    const res = await upgrade(w, t);
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.name).toBe(`${SLUG}:c:${RID2}`);
    expect(call.req.headers.get("sec-websocket-protocol")).toBe("pkey-relay.1");
    const adm = decodeAdmission(call.req.headers.get(ADMISSION_HEADER))!;
    expect(adm.contact).toEqual({ rid: RID2 });
    expect(adm.subject).toBe(w.subject);
    expect(adm.ticket.members).toHaveLength(1);
    // Single use.
    expect((await upgrade(w, t)).status).toBe(401);
    expect(f.calls).toHaveLength(1);
  });

  it("sends an account ticket to the account room, with no contact in the admission", async () => {
    const t = ((await (await post(w, null)).json()) as { ticket: string })
      .ticket;
    expect((await upgrade(w, t)).status).toBe(200);
    expect(f.calls.at(-1)!.name).toBe(`${SLUG}:${w.subject}`);
    expect(
      decodeAdmission(f.calls.at(-1)!.req.headers.get(ADMISSION_HEADER))!
        .contact,
    ).toBeUndefined();
  });

  it("asks the gates again at the upgrade: a contact ticket turns into connect_links_disabled", async () => {
    const t = ((await (await post(w, BODY())).json()) as { ticket: string })
      .ticket;
    f.calls.length = 0;
    env().LAUNCH_CONNECT_LINKS = "off";
    const res = await upgrade(w, t);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("connect_links_disabled");
    expect(f.calls).toHaveLength(0);

    env().LAUNCH_CONNECT_LINKS = "on";
    const t2 = ((await (await post(w, BODY())).json()) as { ticket: string })
      .ticket;
    await setting("false");
    f.calls.length = 0;
    expect((await upgrade(w, t2)).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  it("does not let the setting or the gate touch an account ticket's upgrade", async () => {
    const t = ((await (await post(w, null)).json()) as { ticket: string })
      .ticket;
    env().LAUNCH_CONNECT_LINKS = "off";
    await setting("false");
    expect((await upgrade(w, t)).status).toBe(200);
  });
});

describe("discovery's interAccount", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    (w.env as unknown as Record<string, unknown>).CONNECT_RELAY = fake().ns;
  });
  const get = async (): Promise<{ enabled: boolean; interAccount?: boolean }> =>
    (
      (await (
        await dispatchWith(
          new Request(
            `${BASE}/${SLUG}/.well-known/polaris.json`,
          ) as unknown as Request,
          w.env,
          w.db,
          NOW,
        )
      ).json()) as { services: { connect: { interAccount?: boolean } } }
    ).services.connect as never;
  const setting = (v: "true" | "false") =>
    w.db.run(
      `INSERT OR REPLACE INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'cloudConnect.interAccount', ?, 'console', ?, 'test')`,
      SLUG,
      v,
      NOW,
    );

  it("is false by default, and true only with the setting, the gate and the service all on", async () => {
    expect((await get()).interAccount).toBe(false);
    await setting("true");
    expect((await get()).interAccount).toBe(true);
    (w.env as unknown as Record<string, string>).LAUNCH_CONNECT_LINKS = "off";
    expect((await get()).interAccount).toBe(false);
    (w.env as unknown as Record<string, string>).LAUNCH_CONNECT_LINKS = "on";
    await setting("false");
    expect((await get()).interAccount).toBe(false);
  });

  it("is not reported while the service itself is off", async () => {
    await setting("true");
    (w.env as unknown as Record<string, string>).LAUNCH_CONNECT = "off";
    expect((await get()).enabled).toBe(false);
    expect((await get()).interAccount).toBeUndefined();
  });
});

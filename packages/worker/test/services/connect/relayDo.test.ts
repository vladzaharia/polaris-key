/// <reference types="@cloudflare/workers-types" />
// CC-07.2: the relay room shell around the pure engine, over a fake state (storage, alarm,
// hibernation-API sockets) and a fake WebSocket pair.

import { decodeRelay, encodeRelay } from "@polaris-key/client-core/peer";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv } from "../../seed.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import {
  ADMISSION_HEADER,
  encodeAdmission,
  type Admission,
} from "../../../src/services/connect/do/admission.js";
import {
  forwardToRelay,
  purgeRelay,
} from "../../../src/services/connect/do/client.js";
import {
  ConnectRelayDO,
  type ConnectRelayDoOptions,
} from "../../../src/services/connect/do/relayDo.js";

const DAY = 86_400_000;
const T0 = Math.floor(1_800_000_000_000 / DAY) * DAY + 3_600_000;
const GiB = 1024 ** 3;
const dev = (n: number): Uint8Array => new Uint8Array(24).fill(n);
const A = dev(1);
const B = dev(2);

class FakeSocket {
  sent: Uint8Array[] = [];
  closed: number | null = null;
  attachment: unknown = null;
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(code: number): void {
    this.closed = code;
  }
  serializeAttachment(v: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(v));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/** Storage and sockets that outlive the object instance, as they do across hibernation. */
class FakeState {
  store = new Map<string, unknown>();
  alarmAt: number | null = null;
  sockets: FakeSocket[] = [];
  storage = {
    get: async (k: string) => structuredClone(this.store.get(k)),
    put: async (k: string, v: unknown) =>
      void this.store.set(k, structuredClone(v)),
    delete: async (k: string) => void this.store.delete(k),
    getAlarm: async () => this.alarmAt,
    setAlarm: async (t: number) => void (this.alarmAt = t),
    deleteAlarm: async () => void (this.alarmAt = null),
    deleteAll: async () => void this.store.clear(),
  };
  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }
  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.closed === null);
  }
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> {
    return f();
  }
}

function world(env: Env = makeEnv(new KvMock())) {
  const db = makeTestDb();
  const state = new FakeState();
  let now = T0;
  let n = 0;
  const pairs: { client: FakeSocket; server: FakeSocket }[] = [];
  const make = (extra: Partial<ConnectRelayDoOptions> = {}) =>
    new ConnectRelayDO(state as unknown as DurableObjectState, env, {
      db: () => db,
      now: () => now,
      newId: () => `s${++n}`,
      pair: () => {
        const p = { client: new FakeSocket(), server: new FakeSocket() };
        pairs.push(p);
        return p as never;
      },
      upgraded: (_c, headers) =>
        new Response("upgraded", { status: 200, headers }),
      ...extra,
    });
  return {
    db,
    state,
    env,
    make,
    pairs,
    tick: (ms: number) => (now += ms),
    now: () => now,
  };
}

const adm = (
  device: Uint8Array,
  over: Partial<Admission["ticket"]> = {},
  top: Partial<Admission> = {},
): Admission => ({
  product: "djdl",
  subject: "ps_abc",
  monthCeiling: 500 * GiB,
  ticket: {
    device,
    members: [A, B],
    dayBytes: 256 * 1024 * 1024,
    paused: false,
    productOver: false,
    expiresAt: T0 + 60_000,
    ...over,
  },
  ...top,
});

function upgrade(a: Admission | null, protocols = "pkey-relay.1, pkeyrt_x") {
  const h: Record<string, string> = {
    upgrade: "websocket",
    "sec-websocket-protocol": protocols,
  };
  if (a) h[ADMISSION_HEADER] = encodeAdmission(a);
  return new Request("https://connect-relay.do/", { headers: h });
}

const frames = (s: FakeSocket) =>
  s.sent.map((d) => decodeRelay("toClient", d)?.op);
const send = (to: Uint8Array, len = 10): ArrayBuffer =>
  encodeRelay({
    op: "send",
    to,
    session: 1,
    noise: new Uint8Array(len),
  }).slice().buffer;

/** A room with devices A and B online (sockets pairs 0 and 1). */
async function joined(w: ReturnType<typeof world>): Promise<ConnectRelayDO> {
  const room = w.make();
  await room.fetch(upgrade(adm(A)));
  await room.fetch(upgrade(adm(B)));
  return room;
}

describe("ConnectRelayDO", () => {
  it("is unreachable while launch.relay is off, and on an unreadable gate", async () => {
    const env = makeEnv(new KvMock());
    (env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
    const w = world(env);
    const res = await w.make().fetch(upgrade(adm(A)));
    expect(res.status).toBe(404);
    expect(w.pairs).toHaveLength(0);

    const env2 = makeEnv(new KvMock());
    delete (env2 as unknown as Record<string, string>).LAUNCH_RELAY;
    const w2 = world(env2);
    expect((await w2.make().fetch(upgrade(adm(A)))).status).toBe(404);

    const w3 = world();
    const broken = w3.make({
      db: () => {
        throw new Error("down");
      },
    });
    expect((await broken.fetch(upgrade(adm(A)))).status).toBe(404);
  });

  it("refuses a request that is not a well-formed upgrade", async () => {
    const w = world();
    const room = w.make();
    expect((await room.fetch(new Request("https://x/"))).status).toBe(426);
    expect((await room.fetch(upgrade(adm(A), "other.1"))).status).toBe(400);
    expect((await room.fetch(upgrade(null))).status).toBe(400);
    const bad = upgrade(adm(A));
    bad.headers.set(ADMISSION_HEADER, "{not json");
    expect((await room.fetch(bad)).status).toBe(400);
  });

  it("accepts an upgrade, echoes pkey-relay.1 and announces the members", async () => {
    const w = world();
    const res = await w.make().fetch(upgrade(adm(A)));
    expect(res.status).toBe(200);
    expect(res.headers.get("sec-websocket-protocol")).toBe("pkey-relay.1");
    expect(frames(w.pairs[0]!.server)).toEqual(["members"]);
    expect(w.state.alarmAt).toBe(w.now() + 60_000);
  });

  it("pins the first (product, subject) and refuses another pair", async () => {
    const w = world();
    const room = w.make();
    expect((await room.fetch(upgrade(adm(A)))).status).toBe(200);
    expect(
      (await room.fetch(upgrade(adm(A, {}, { subject: "ps_other" })))).status,
    ).toBe(403);
    expect(
      (await room.fetch(upgrade(adm(A, {}, { product: "other" })))).status,
    ).toBe(403);
  });

  it("stamps from at the room and delivers between two devices", async () => {
    const w = world();
    const room = await joined(w);
    const [a, b] = [w.pairs[0]!.server, w.pairs[1]!.server];
    await room.webSocketMessage(a as never, send(B));
    const recv = decodeRelay("toClient", b.sent.at(-1)!);
    expect(recv).toMatchObject({ op: "recv", from: A });
  });

  it("restores after hibernation: sockets, roster and the day's usage", async () => {
    const w = world();
    const first = w.make();
    await first.fetch(upgrade(adm(A, { dayBytes: 100 })));
    await first.fetch(upgrade(adm(B, { dayBytes: 100 })));
    const [a, b] = [w.pairs[0]!.server, w.pairs[1]!.server];
    await first.webSocketMessage(a as never, send(B, 40)); // 40 + 1 + 24 + 4 ... under 100
    const used = (w.state.store.get("room") as { dayUsed: number }).dayUsed;
    expect(used).toBeGreaterThan(40);

    // The instance is evicted; a new one wakes over the same storage and sockets.
    const second = w.make();
    await second.webSocketMessage(a as never, send(B, 40));
    // The first send's bytes count: this one would pass 100 and is dropped with LIMIT 2.
    expect(frames(a).at(-1)).toBe("limit");
    expect(
      (decodeRelay("toClient", a.sent.at(-1)!) as { reason: number }).reason,
    ).toBe(2);
    // Still delivering for a message that fits, to the restored socket.
    const before = b.sent.length;
    await second.webSocketMessage(a as never, send(B, 1));
    expect(b.sent.length).toBe(before + 1);
    expect(w.state.store.get("room")).toMatchObject({ product: "djdl" });
  });

  it("does not reset the day's ceiling by a new connection on the same day", async () => {
    const w = world();
    const room = w.make();
    await room.fetch(upgrade(adm(A, { dayBytes: 100 })));
    await room.fetch(upgrade(adm(B, { dayBytes: 100 })));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 60));
    await room.fetch(upgrade(adm(A, { dayBytes: 100 })));
    await room.webSocketMessage(w.pairs[2]!.server as never, send(B, 60));
    const lim = decodeRelay("toClient", w.pairs[2]!.server.sent.at(-1)!);
    expect(lim).toMatchObject({ op: "limit", reason: 2 });
  });

  it("flushes the meter from the alarm and is idempotent", async () => {
    const w = world();
    const room = await joined(w);
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 10));
    w.tick(60_000);
    w.state.alarmAt = null;
    await room.alarm();
    const rows = await w.db.all<{
      product: string;
      day: string;
      bytes: number;
      sessions: number;
    }>("SELECT * FROM connect_relay_daily");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product: "djdl", sessions: 2 });
    expect(rows[0]!.bytes).toBe(10 + 24 + 4 + 1);
    expect(w.state.store.has("pending")).toBe(false);
    // Another alarm adds nothing.
    await room.alarm();
    expect(
      (await w.db.first<{ bytes: number }>(
        "SELECT bytes FROM connect_relay_daily",
      ))!.bytes,
    ).toBe(39);
    // Sockets are open, so the alarm repeats.
    expect(w.state.alarmAt).not.toBeNull();
  });

  it("keeps the meter owed when D1 fails, then flushes it", async () => {
    const w = world();
    let down = true;
    const real = w.db;
    const realBatch = real.batch.bind(real);
    const flaky: Db = Object.assign(Object.create(real) as Db, {
      batch: (st: Parameters<Db["batch"]>[0]) =>
        down ? Promise.reject(new Error("d1 down")) : realBatch(st),
    });
    const room = w.make({ db: () => flaky });
    await room.fetch(upgrade(adm(A)));
    await room.fetch(upgrade(adm(B)));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 10));
    w.state.alarmAt = null;
    await expect(room.alarm()).rejects.toThrow();
    expect(w.state.store.has("pending")).toBe(true);
    down = false;
    await room.alarm();
    expect(w.state.store.has("pending")).toBe(false);
    expect(
      (await real.first<{ bytes: number }>(
        "SELECT bytes FROM connect_relay_daily",
      ))!.bytes,
    ).toBe(39);
  });

  it("enforces the product month ceiling from the meter on the alarm", async () => {
    const w = world();
    const room = w.make();
    await room.fetch(upgrade(adm(A, {}, { monthCeiling: 1000 })));
    await room.fetch(upgrade(adm(B, {}, { monthCeiling: 1000 })));
    const [a, b] = [w.pairs[0]!.server, w.pairs[1]!.server];
    // Other rooms of the product already spent the month.
    const day = new Date(w.now()).toISOString().slice(0, 10);
    await w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES ('djdl', ?, 2000, 3)",
      day,
    );
    w.state.alarmAt = null;
    await room.alarm();
    const before = b.sent.length;
    await room.webSocketMessage(a as never, send(B, 5));
    expect(b.sent.length).toBe(before);
    expect(decodeRelay("toClient", a.sent.at(-1)!)).toMatchObject({
      op: "limit",
      reason: 3,
    });
  });

  it("clamps a product ceiling above 500 GiB and a person quota above 4 GiB", async () => {
    const w = world();
    const room = w.make();
    await room.fetch(
      upgrade(adm(A, { dayBytes: 99 * GiB }, { monthCeiling: 9000 * GiB })),
    );
    const r = w.state.store.get("room") as {
      monthCeiling: number;
      dayBytesQuota: number;
    };
    expect(r.monthCeiling).toBe(500 * GiB);
    expect(r.dayBytesQuota).toBe(4 * GiB);
  });

  it("closes open sockets at the next alarm when the gate turns off", async () => {
    const w = world();
    const room = w.make();
    await room.fetch(upgrade(adm(A)));
    (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
    w.state.alarmAt = null;
    await room.alarm();
    expect(w.pairs[0]!.server.closed).toBe(4008);
  });

  it("drops a closed socket and tells the others", async () => {
    const w = world();
    const room = await joined(w);
    await room.webSocketClose(w.pairs[0]!.server as never, 1000);
    expect(frames(w.pairs[1]!.server).at(-1)).toBe("gone");
  });

  it("closes a refused admission (a device outside the roster) 4003", async () => {
    const w = world();
    const res = await w.make().fetch(upgrade(adm(dev(9))));
    expect(res.status).toBe(200);
    expect(w.pairs[0]!.server.closed).toBe(4003);
    expect(w.state.store.has("room")).toBe(false);
  });

  it("forwards through the one namer: name from the pair, admission replaced", async () => {
    const seen: { name?: string; req?: Request } = {};
    const ns = {
      idFromName: (n: string) => {
        seen.name = n;
        return n;
      },
      get: () => ({
        fetch: async (r: Request) => {
          seen.req = r;
          return new Response("ok");
        },
      }),
    } as unknown as DurableObjectNamespace;
    const forged = upgrade(adm(dev(9)));
    const res = await forwardToRelay({ CONNECT_RELAY: ns }, adm(A), forged);
    expect(res?.status).toBe(200);
    expect(seen.name).toBe("djdl:ps_abc");
    expect(seen.req?.headers.get(ADMISSION_HEADER)).toBe(
      encodeAdmission(adm(A)),
    );
    expect(await forwardToRelay({}, adm(A), forged)).toBeNull();
    await expect(
      forwardToRelay(
        { CONNECT_RELAY: ns },
        adm(A, {}, { subject: "a:b" }),
        forged,
      ),
    ).rejects.toThrow();
  });

  it("erases the room on a purge: sockets closed, storage and alarm gone, even with the gate off", async () => {
    const w = world();
    const room = await joined(w);
    (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: (r: Request) => room.fetch(r) }),
    } as unknown as DurableObjectNamespace;
    await expect(
      purgeRelay({ CONNECT_RELAY: ns }, "djdl", "ps_other"),
    ).rejects.toThrow();
    await purgeRelay({ CONNECT_RELAY: ns }, "djdl", "ps_abc");
    expect(w.pairs.map((p) => p.server.closed)).toEqual([4003, 4003]);
    expect(w.state.store.size).toBe(0);
    expect(w.state.alarmAt).toBeNull();
    await purgeRelay({}, "djdl", "ps_abc");
  });
});

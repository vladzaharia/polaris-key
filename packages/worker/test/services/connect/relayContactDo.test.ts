/// <reference types="@cloudflare/workers-types" />
/**
 * CC-19.4: the contact room (`<p>:c:<rid>`) and the lease its senders draw from their account
 * rooms (WIRE-CONTRACT-V5 §15.7, §15.10), over the real `ConnectRelayDO` on a fake state: two
 * people (so two account rooms) meet in one contact room through the one namer.
 */

import {
  decodeRelay,
  encodeRelay,
  contactAlias,
} from "@polaris-key/client-core/peer";
import { describe, expect, it } from "vitest";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import {
  contactObjectName,
  relayObjectName,
  type Admission,
} from "../../../src/services/connect/do/admission.js";
import {
  forwardToRelay,
  leaseBytes,
  purgeRelay,
} from "../../../src/services/connect/do/client.js";
import { ConnectRelayDO } from "../../../src/services/connect/do/relayDo.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, seedProduct } from "../../seed.js";
import {
  DAY,
  FakeSocket,
  FakeState,
  GiB,
  dev,
  world,
} from "./relayDoHarness.js";

const MiB = 1024 * 1024;
const RID = "lXg0MgIHVN5qAmGFUen7vA";
const RID2 = "6RpsJG2eU_l_4fHyu0rqyA";
/** Person one is the harness's seeded person (devices 1 and 2); person two has no roster rows. */
const S1 = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const S2 = "ps_BBBBBBBBBBBBBBBBBBBBBA";
const D1 = dev(1);
const D2 = dev(2);
const D3 = dev(3);
const D9 = dev(9);
/** A person's roster: their devices, with keys (the rule `accountDeviceKeys` reads). */
async function seedPerson(
  w: ReturnType<typeof world>,
  subject: string,
  account: string,
  devices: Uint8Array[],
): Promise<void> {
  await w.db.run(
    "INSERT OR IGNORE INTO accounts (id, created_at, modified_at) VALUES (?, 1, 1)",
    account,
  );
  await w.db.run(
    "INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at) VALUES (?, 'djdl', ?, 1)",
    account,
    subject,
  );
  for (const d of devices) {
    const id = Buffer.from(d).toString("base64url");
    await w.db.run(
      `INSERT OR REPLACE INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES ('djdl', ?, '', 'authorized', 1, 1, ?)`,
      id,
      subject,
    );
    await w.db.run(
      `INSERT OR REPLACE INTO device_keys (product, device_id, sign_key, agree_key, key_seq, created_at)
       VALUES ('djdl', ?, ?, ?, 1, 1)`,
      id,
      `sign${id}`,
      `agree${id}`,
    );
  }
}
const b64 = (d: Uint8Array): string => Buffer.from(d).toString("base64url");

interface Obj {
  state: FakeState;
  obj: ConnectRelayDO;
  pairs: { client: FakeSocket; server: FakeSocket }[];
}

async function cluster() {
  const env = makeEnv(new KvMock());
  const w = world(env);
  const objects = new Map<string, Obj>();
  const calls: { name: string; path: string }[] = [];
  let n = 0;
  const build = (name: string, state: FakeState): Obj => {
    const pairs: Obj["pairs"] = [];
    const obj = new ConnectRelayDO(
      state as unknown as DurableObjectState,
      env,
      {
        db: () => w.db,
        now: w.now,
        newId: () => `${name}#${++n}`,
        pair: () => {
          const p = { client: new FakeSocket(), server: new FakeSocket() };
          pairs.push(p);
          return p as never;
        },
        upgraded: (_c, headers) =>
          new Response("upgraded", { status: 200, headers }),
      },
    );
    return { state, obj, pairs };
  };
  const get = (name: string): Obj => {
    let o = objects.get(name);
    if (!o) {
      o = build(name, new FakeState());
      objects.set(name, o);
    }
    return o;
  };
  /** The same object rebuilt over the same state, as after an eviction. */
  const rebuild = (name: string): Obj => {
    const old = get(name);
    const fresh = build(name, old.state);
    fresh.pairs.push(...old.pairs);
    objects.set(name, fresh);
    return fresh;
  };
  let failLease = false;
  (env as unknown as Record<string, unknown>).CONNECT_RELAY = {
    idFromName: (x: string) => x,
    get: (name: string) => ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        calls.push({ name, path });
        if (path === "/lease" && failLease)
          return new Response(null, { status: 500 });
        return get(name).obj.fetch(req);
      },
    }),
  };
  // Both people have devices (a person with no device leases nothing and loses their sockets).
  await seedProduct(w.db, "djdl");
  await seedPerson(w, S1, "acc1", [D1, D2, D3]);
  await seedPerson(w, S2, "acc2", [D9]);
  return {
    env,
    w,
    get,
    rebuild,
    calls,
    failLeases: () => void (failLease = true),
    leaseCalls: () => calls.filter((c) => c.path === "/lease").length,
  };
}
type Cluster = Awaited<ReturnType<typeof cluster>>;

const admission = (
  c: Cluster,
  subject: string,
  device: Uint8Array,
  over: Partial<Admission["ticket"]> = {},
  rid = RID,
): Admission => ({
  product: "djdl",
  subject,
  monthCeiling: 500 * GiB,
  seatsHeld: false,
  contact: { rid },
  ticket: {
    device,
    members: [device],
    dayBytes: 256 * MiB,
    paused: false,
    productOver: false,
    expiresAt: c.w.now() + 60_000,
    ...over,
  },
});

async function join(
  c: Cluster,
  subject: string,
  device: Uint8Array,
  over: Partial<Admission["ticket"]> = {},
  rid = RID,
) {
  const res = await forwardToRelay(
    c.env,
    admission(c, subject, device, over, rid),
    new Request("https://connect-relay.test/", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "pkey-relay.1, pkeyrt_x",
      },
    }),
  );
  const room = c.get(contactObjectName("djdl", rid));
  return { res: res!, room, server: room.pairs.at(-1)?.server as FakeSocket };
}

const send = (to: Uint8Array, len = 100): ArrayBuffer =>
  encodeRelay({
    op: "send",
    to,
    session: 1,
    noise: new Uint8Array(len),
  }).slice().buffer;
const ops = (s: FakeSocket) =>
  s.sent.map((d) => decodeRelay("toClient", d)).filter((m) => m !== null);
const limits = (s: FakeSocket) =>
  ops(s).flatMap((m) => (m.op === "limit" ? [m.reason] : []));
const aliasOf = async (d: Uint8Array, rid = RID) => contactAlias(rid, b64(d));

/** A person's account room storage (the lease lands here). */
const accountRoom = (c: Cluster, subject: string) =>
  c.get(relayObjectName("djdl", subject));

describe("contact rooms (CC-19.4)", () => {
  it("joins two people through the one namer and relays between aliases, never device ids", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(c.leaseCalls()).toBe(0); // joining draws no lease

    const aliasA = await aliasOf(D1);
    const aliasB = await aliasOf(D9);
    // The members are aliases: A first hears only itself, then both once B arrives.
    const hex = (x: Uint8Array): string => Buffer.from(x).toString("hex");
    const lists = ops(a.server).flatMap((m) =>
      m.op === "members" ? [m.devices.map(hex).sort()] : [],
    );
    expect(lists).toEqual([[hex(aliasA)], [hex(aliasA), hex(aliasB)].sort()]);
    expect(JSON.stringify(lists)).not.toContain(hex(D1));
    expect(JSON.stringify(lists)).not.toContain(hex(D9));

    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    const recv = ops(b.server).find((m) => m.op === "recv");
    expect(recv?.op === "recv" && Buffer.from(recv.from)).toEqual(
      Buffer.from(aliasA),
    );
    expect(recv?.op === "recv" && Buffer.from(recv.from)).not.toEqual(
      Buffer.from(D1),
    );
  });

  it("charges the sender's account room, once per 1 MiB step, and nothing to the receiver", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(1);
    expect(c.calls.find((x) => x.path === "/lease")!.name).toBe(
      relayObjectName("djdl", S1),
    );
    const room = (await accountRoom(c, S1).state.storage.get("room")) as {
      dayUsed: number;
      members: string[];
    };
    expect(room.dayUsed).toBe(MiB);
    expect(room.members).toEqual([]);
    const pending = (await accountRoom(c, S1).state.storage.get(
      "pending",
    )) as Record<string, { bytes: number }>;
    expect(Object.values(pending).reduce((n, p) => n + p.bytes, 0)).toBe(MiB);
    // The receiver paid nothing and its account room does not exist.
    expect(b.room).toBe(a.room);
    expect(accountRoom(c, S2).state.store.size).toBe(0);
    // The sender's alias holds the rest of the lease.
    const croom = (await a.room.state.storage.get("croom")) as {
      aliases: Record<string, { lease: number }>;
    };
    expect(
      Object.values(croom.aliases)
        .map((x) => x.lease)
        .sort((x, y) => x - y),
    ).toEqual([0, MiB - 2 * 129]);
  });

  it("flushes a lease to the product's meter like any relay byte", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    await a.room.obj.webSocketMessage(
      a.server as never,
      send(await aliasOf(D9)),
    );
    await accountRoom(c, S1).obj.alarm();
    const row = await c.w.db.first<{ bytes: number }>(
      "SELECT bytes FROM connect_relay_daily WHERE product = 'djdl'",
    );
    expect(row?.bytes).toBe(MiB);
  });

  it("contact room at rest: the device id is in the socket attachment only, never in storage; only aliases, leases and last-seen are written", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    await a.room.obj.webSocketMessage(
      a.server as never,
      send(await aliasOf(D9)),
    );
    const dump = JSON.stringify([...a.room.state.store.entries()]);
    for (const secret of [
      S1,
      S2,
      b64(D1),
      b64(D9),
      Buffer.from(D1).toString("hex"),
      Buffer.from(D9).toString("hex"),
      RID,
    ])
      expect(dump).not.toContain(secret);
    const croom = (await a.room.state.storage.get("croom")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(croom).sort()).toEqual([
      "aliases",
      "day",
      "monthCeiling",
      "product",
    ]);
    for (const v of Object.values(croom.aliases as Record<string, object>))
      expect(Object.keys(v).sort()).toEqual(["lease", "seen"]);
    expect([...a.room.state.store.keys()].sort()).toEqual(["croom"]);
    // The device id lives in the live socket's attachment (the alarm's roster check), in memory.
    expect((a.server.attachment as { dev?: string }).dev).toBe(
      Buffer.from(D1).toString("hex"),
    );
    // Not after a close, an alarm and a reconnect either.
    await a.room.obj.webSocketClose(a.server as never, 1000);
    await a.room.obj.alarm();
    expect(JSON.stringify([...a.room.state.store.entries()])).not.toContain(
      Buffer.from(D1).toString("hex"),
    );
  });

  it("pins the first two aliases and closes a third device 4003", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    const third = await join(c, S1, D2);
    expect(third.res.status).toBe(200);
    expect(third.server.closed).toBe(4003);
    expect(
      Object.keys(
        ((await a.room.state.storage.get("croom")) as { aliases: object })
          .aliases,
      ),
    ).toHaveLength(2);
    // A pinned device still gets in, even after the third was refused.
    expect((await join(c, S1, D1)).server.closed).toBeNull();
  });

  it("lets a pinned device hold two sockets and replaces the oldest of a third (4009)", async () => {
    const c = await cluster();
    const a1 = await join(c, S1, D1);
    const a2 = await join(c, S1, D1);
    const a3 = await join(c, S1, D1);
    expect(a1.server.closed).toBe(4009);
    expect(a2.server.closed).toBeNull();
    expect(a3.server.closed).toBeNull();
  });

  it("keeps an unspent lease across a reconnect: the sender is not charged again", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    const aliasA = await aliasOf(D1);
    const aliasB = await aliasOf(D9);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(1);
    // A flaky link: the socket drops and a new one connects. The lease stays with the alias.
    await a.room.obj.webSocketClose(a.server as never, 1006);
    const a2 = await join(c, S1, D1);
    await a2.room.obj.webSocketMessage(a2.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(1);
    expect(ops(b.server).filter((m) => m.op === "recv")).toHaveLength(2);
    // B answering draws on B's own account room.
    await b.room.obj.webSocketMessage(b.server as never, send(aliasA));
    expect(c.leaseCalls()).toBe(2);
    expect(c.calls.at(-1)!.name).toBe(relayObjectName("djdl", S2));
  });

  it("clears the leases at the UTC day rollover and draws a fresh one", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(1);
    c.w.tick(DAY);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(2);
  });

  it("answers LIMIT 2 and closes 4008 when the person's day cannot grant a lease", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1, { dayBytes: MiB });
    const b = await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    // 10 messages of 100 000 bytes fit the one lease; the 18th needs a lease the day cannot give.
    for (let i = 0; i < 17; i++)
      await a.room.obj.webSocketMessage(
        a.server as never,
        send(aliasB, 60_000),
      );
    expect(ops(b.server).filter((m) => m.op === "recv")).toHaveLength(17);
    expect(a.server.closed).toBeNull();
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB, 60_000));
    expect(limits(a.server)).toEqual([2]);
    expect(a.server.closed).toBe(4008);
    expect(ops(b.server).filter((m) => m.op === "recv")).toHaveLength(17);
  });

  it("opening many contact rooms still draws on the one account room's day", async () => {
    const c = await cluster();
    // Two rooms (two links of person one), a day of exactly one lease.
    const r1 = await join(c, S1, D1, { dayBytes: MiB }, RID);
    await join(c, S2, D9, {}, RID);
    const r2 = await join(c, S1, D1, { dayBytes: MiB }, RID2);
    await join(c, S2, D9, {}, RID2);
    await r1.room.obj.webSocketMessage(
      r1.server as never,
      send(await aliasOf(D9, RID), 60_000),
    );
    expect(r1.server.closed).toBeNull();
    // The second room finds the day spent in the first.
    await r2.room.obj.webSocketMessage(
      r2.server as never,
      send(await aliasOf(D9, RID2), 60_000),
    );
    expect(limits(r2.server)).toEqual([2]);
    expect(r2.server.closed).toBe(4008);
    const room = (await accountRoom(c, S1).state.storage.get("room")) as {
      dayUsed: number;
    };
    expect(room.dayUsed).toBe(MiB);
  });

  it("answers LIMIT 3 when the product's month is spent, and LIMIT 4 when the relay is paused", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    await c.w.db.run(
      "INSERT INTO connect_relay_daily (product, day, bytes, sessions) VALUES ('djdl', ?, ?, 1)",
      new Date(c.w.now()).toISOString().slice(0, 10),
      500 * GiB,
    );
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(limits(a.server)).toEqual([3]);
    expect(a.server.closed).toBe(4008);

    await c.w.db.run("DELETE FROM connect_relay_daily");
    await c.w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudConnect.relayPaused', '"on"', 1, 1, 'test')`,
    );
    invalidatePlatformSettings(c.env, c.w.db);
    const a2 = await join(c, S1, D1);
    await a2.room.obj.webSocketMessage(a2.server as never, send(aliasB));
    expect(limits(a2.server)).toEqual([4]);
    expect(a2.server.closed).toBe(4008);
  });

  it("fails closed when the account room cannot be asked: LIMIT 4 and 4008", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    c.failLeases();
    await a.room.obj.webSocketMessage(
      a.server as never,
      send(await aliasOf(D9)),
    );
    expect(limits(a.server)).toEqual([4]);
    expect(a.server.closed).toBe(4008);
  });

  it("is unreachable while either gate is off, and the alarm closes open sockets 4003 when one goes off", async () => {
    for (const gate of ["LAUNCH_RELAY", "LAUNCH_CONNECT_LINKS"]) {
      const c = await cluster();
      (c.env as unknown as Record<string, string>)[gate] = "off";
      const off = await join(c, S1, D1);
      expect(off.res.status, gate).toBe(404);
      expect(off.room.pairs, gate).toHaveLength(0);
    }
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    (c.env as unknown as Record<string, string>).LAUNCH_CONNECT_LINKS = "off";
    await a.room.obj.alarm();
    expect(a.server.closed).toBe(4003);
    expect(b.server.closed).toBe(4003);
  });

  it("pauses at the alarm: LIMIT 4 to everyone and 4008", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    await c.w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudConnect.relayPaused', '"on"', 1, 1, 'test')`,
    );
    invalidatePlatformSettings(c.env, c.w.db);
    await a.room.obj.alarm();
    expect(limits(a.server)).toEqual([4]);
    expect(limits(b.server)).toEqual([4]);
    expect(a.server.closed).toBe(4008);
    expect(b.server.closed).toBe(4008);
  });

  it("erases itself after 30 days with no socket: the pin, the aliases, their last-seen times and leases", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    await a.room.obj.webSocketMessage(
      a.server as never,
      send(await aliasOf(D9)),
    );
    await a.room.obj.webSocketClose(a.server as never, 1000);
    expect(a.room.state.alarmAt).toBeLessThanOrEqual(c.w.now() + 60_000); // one socket is still open
    await b.room.obj.webSocketClose(b.server as never, 1000);
    expect(a.room.state.alarmAt).toBe(c.w.now() + 30 * DAY);
    c.w.tick(29 * DAY);
    await a.room.obj.alarm();
    expect(a.room.state.store.has("croom")).toBe(true);
    expect(a.room.state.alarmAt).toBeGreaterThan(c.w.now());
    c.w.tick(2 * DAY);
    await a.room.obj.alarm();
    expect(a.room.state.store.size).toBe(0);
    expect(a.room.state.alarmAt).toBeNull();
    // The shell is empty: a new pair can pin again.
    expect((await join(c, S1, D2)).server.closed).toBeNull();
  });

  it("wakes from hibernation with its pin, leases and sockets", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    const woken = c.rebuild(contactObjectName("djdl", RID));
    await woken.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(c.leaseCalls()).toBe(1);
    expect(ops(b.server).filter((m) => m.op === "recv")).toHaveLength(2);
    // The pin survived: a third device is still refused.
    expect((await join(c, S1, D3)).server.closed).toBe(4003);
  });

  it("keeps account and contact admissions apart", async () => {
    const c = await cluster();
    const contact = await join(c, S1, D1);
    // An admission that is not one is refused before anything is touched.
    const wrong = await contact.room.obj.fetch(
      new Request("https://connect-relay.do/", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "pkey-relay.1",
          "x-pkey-relay-admission": JSON.stringify({}),
        },
      }),
    );
    expect(wrong.status).toBe(400);
    const accountObj = c.get(relayObjectName("djdl", S1));
    const first = await accountObj.obj.fetch(
      new Request("https://connect-relay.do/rooms", {
        method: "POST",
        body: JSON.stringify({ product: "djdl", subject: S1, rid: RID }),
      }),
    );
    expect(first.status).toBe(204);
    // The contact object takes no counting, no lease and no purge.
    for (const path of ["/rooms", "/lease"]) {
      const res = await contact.room.obj.fetch(
        new Request(`https://connect-relay.do${path}`, {
          method: "POST",
          body: "{}",
        }),
      );
      expect(res.status).toBe(404);
    }
    const purge = await contact.room.obj.fetch(
      new Request("https://connect-relay.do/", { method: "POST", body: "{}" }),
    );
    expect(purge.status).toBe(403);
    expect(contact.room.state.store.has("croom")).toBe(true);
  });
});

describe("the lease an account room grants (CC-19.4)", () => {
  const ask = (
    obj: ConnectRelayDO,
    over: Record<string, unknown> = {},
  ): Promise<Response> =>
    obj.fetch(
      new Request("https://connect-relay.do/lease", {
        method: "POST",
        body: JSON.stringify({
          product: "djdl",
          subject: S1,
          n: MiB,
          dayBytes: 3 * MiB,
          monthCeiling: 500 * GiB,
          seatsHeld: false,
          ...over,
        }),
      }),
    );

  it("grants the step, then what is left of the day, then nothing, and records it as metered bytes", async () => {
    const c = await cluster();
    const room = accountRoom(c, S1);
    const answers = [];
    for (let i = 0; i < 4; i++)
      answers.push(await (await ask(room.obj)).json());
    expect(answers).toEqual([
      { granted: MiB, reason: 0 },
      { granted: MiB, reason: 0 },
      { granted: MiB, reason: 0 },
      { granted: 0, reason: 2 },
    ]);
    const stored = (await room.state.storage.get("room")) as {
      dayUsed: number;
      dayBytesQuota: number;
    };
    expect(stored.dayUsed).toBe(3 * MiB);
    expect(stored.dayBytesQuota).toBe(3 * MiB);
    // A partial grant names the person's day.
    const c2 = await cluster();
    const r2 = accountRoom(c2, S1);
    expect(await (await ask(r2.obj, { dayBytes: MiB / 2 })).json()).toEqual({
      granted: MiB / 2,
      reason: 2,
    });
    expect(await (await ask(r2.obj, { dayBytes: MiB / 2 })).json()).toEqual({
      granted: 0,
      reason: 2,
    });
  });

  it("shares the day with the person's own relayed bytes", async () => {
    const c = await cluster();
    const room = accountRoom(c, S1);
    expect(await (await ask(room.obj, { dayBytes: MiB })).json()).toEqual({
      granted: MiB,
      reason: 0,
    });
    const lease = await leaseBytes(c.env, {
      product: "djdl",
      subject: S1,
      bytes: 1,
      dayBytes: MiB,
      monthCeiling: 500 * GiB,
      seatsHeld: false,
    });
    expect(lease).toEqual({ granted: 0, reason: 2 });
  });

  it("refuses a bad body, another pair, a gate that is off and a tombstoned room", async () => {
    const c = await cluster();
    const room = accountRoom(c, S1);
    for (const bad of [
      { n: 0 },
      { n: MiB + 1 },
      { n: 1.5 },
      { n: "1" },
      { dayBytes: -1 },
      { monthCeiling: Number.NaN },
      { subject: 7 },
    ])
      expect((await ask(room.obj, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(
      (
        await room.obj.fetch(
          new Request("https://connect-relay.do/lease", {
            method: "POST",
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await room.obj.fetch(
          new Request("https://connect-relay.do/lease", { method: "GET" }),
        )
      ).status,
    ).toBe(405);
    expect((await ask(room.obj)).status).toBe(200);
    expect((await ask(room.obj, { subject: "ps_other" })).status).toBe(403);
    for (const gate of ["LAUNCH_RELAY", "LAUNCH_CONNECT_LINKS"]) {
      const g = await cluster();
      (g.env as unknown as Record<string, string>)[gate] = "off";
      expect((await ask(accountRoom(g, S1).obj)).status, gate).toBe(404);
    }
    // A purge leaves a ten-minute tombstone: no lease then.
    await room.obj.fetch(
      new Request("https://connect-relay.do/", {
        method: "POST",
        body: JSON.stringify({ product: "djdl", subject: S1 }),
      }),
    );
    expect((await ask(room.obj)).status).toBe(403);
  });

  it("is refused for the month when the product's ceiling is reached", async () => {
    const c = await cluster();
    expect(
      await (await ask(accountRoom(c, S1).obj, { monthCeiling: 0 })).json(),
    ).toEqual({ granted: 0, reason: 3 });
  });
});

describe("contact room roster reach (V5 §15.7)", () => {
  const removeDevice = async (c: Cluster, d: Uint8Array): Promise<void> => {
    await c.w.db.run(
      "DELETE FROM device_keys WHERE device_id = ?",
      Buffer.from(d).toString("base64url"),
    );
    await c.w.db.run(
      "DELETE FROM devices WHERE device_id = ?",
      Buffer.from(d).toString("base64url"),
    );
  };

  it("contact room roster reach: a socket whose device left its person's devices closes 4003 within one alarm and the peer hears GONE", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    const aliasA = await aliasOf(D1);
    await removeDevice(c, D1);
    c.w.tick(60_000);
    await a.room.obj.alarm();
    expect(a.server.closed).toBe(4003);
    expect(b.server.closed).toBeNull();
    const gone = ops(b.server).flatMap((m) => (m.op === "gone" ? [m] : []));
    expect(gone).toHaveLength(1);
    // The device that stays keeps its socket.
    c.w.tick(60_000);
    await a.room.obj.alarm();
    expect(b.server.closed).toBeNull();
    void aliasA;
  });

  it("contact room roster reach: a person with no device left loses every contact socket within one alarm, and no lease re-creates the account room after the purge", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    const b = await join(c, S2, D9);
    const aliasB = await aliasOf(D9);
    const a3 = await join(c, S1, D1, {}, RID2);
    await join(c, S2, D9, {}, RID2);
    await c.w.db.run(
      "DELETE FROM device_keys WHERE device_id IN (SELECT device_id FROM devices WHERE subject = ?)",
      S1,
    );
    await c.w.db.run("DELETE FROM devices WHERE subject = ?", S1);
    await purgeRelay(c.env, "djdl", S1);
    // Before the alarm: a send cannot lease, even after the tombstone, and creates no room.
    c.w.tick(11 * 60_000);
    await a.room.obj.webSocketMessage(a.server as never, send(aliasB));
    expect(ops(b.server).filter((m) => m.op === "recv")).toHaveLength(0);
    expect(accountRoom(c, S1).state.store.has("room")).toBe(false);
    expect(accountRoom(c, S1).state.store.has("pending")).toBe(false);
    expect(a.server.closed).toBe(4008); // the lease was refused
    // Within one alarm every contact socket of the person is closed 4003.
    await a3.room.obj.alarm();
    expect(a3.server.closed).toBe(4003);
    expect(b.server.closed).toBeNull();
  });

  it("contact room roster reach: an unreadable roster keeps the socket open twice and closes it at the third", async () => {
    const c = await cluster();
    const a = await join(c, S1, D1);
    await join(c, S2, D9);
    const room = c.get(contactObjectName("djdl", RID));
    const real = c.w.db;
    let broken = false;
    // Gates and pause read through the settings copy; the roster is the only direct D1 read.
    const flaky = room.state;
    void flaky;
    const failing = c.w.db.all.bind(c.w.db);
    (c.w.db as unknown as { all: unknown }).all = (...args: unknown[]) =>
      broken
        ? Promise.reject(new Error("down"))
        : (failing as (...a: unknown[]) => unknown)(...args);
    broken = true;
    await a.room.obj.alarm();
    await a.room.obj.alarm();
    expect(a.server.closed).toBeNull();
    broken = false;
    // A good read in between resets the count.
    await a.room.obj.alarm();
    broken = true;
    await a.room.obj.alarm();
    await a.room.obj.alarm();
    expect(a.server.closed).toBeNull();
    await a.room.obj.alarm();
    expect(a.server.closed).toBe(4003);
    void real;
  });
});

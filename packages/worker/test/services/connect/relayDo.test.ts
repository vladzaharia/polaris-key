/// <reference types="@cloudflare/workers-types" />
// CC-07.2: the relay room shell around the pure engine, over a fake state (storage, alarm,
// hibernation-API sockets) and a fake WebSocket pair (the harness: ./relayDoHarness.ts).

import { decodeRelay } from "@polaris-key/client-core/peer";
import { describe, expect, it } from "vitest";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv } from "../../seed.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import {
  ADMISSION_HEADER,
  encodeAdmission,
} from "../../../src/services/connect/do/admission.js";
import {
  forwardToRelay,
  pokeRelayRoom,
  purgeRelay,
} from "../../../src/services/connect/do/client.js";
import { installRelayPoke } from "../../../src/services/connect/index.js";
import {
  pokeRelay,
  setRelayPokePort,
} from "../../../src/services/connect/relayPoke.js";
import { ConnectRelayDO } from "../../../src/services/connect/do/relayDo.js";

import {
  A,
  B,
  DAY,
  GiB,
  adm,
  alarmOf,
  dev,
  frames,
  idOf,
  joined,
  seedRoster,
  send,
  upgrade,
  world,
  FakeSocket,
} from "./relayDoHarness.js";

const pokeReq = (body: unknown) =>
  new Request("https://connect-relay.do/", {
    method: "PUT",
    body: JSON.stringify(body),
  });

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
    await alarmOf(w, room);
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
    await alarmOf(w, room);
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
    await expect(alarmOf(w, room)).rejects.toThrow();
    expect(w.state.store.has("pending")).toBe(true);
    down = false;
    await alarmOf(w, room);
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
    await alarmOf(w, room);
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
    await alarmOf(w, room);
    expect(w.pairs[0]!.server.closed).toBe(4008);
  });

  it("closes open sockets with LIMIT 4 when the pause turns on during a session, and recovers when it ends", async () => {
    const w = world();
    const room = await joined(w);
    await seedRoster(w);
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudConnect.relayPaused', '"on"', 1, 1, 'test')`,
    );
    invalidatePlatformSettings(w.env, w.db);
    w.state.alarmAt = null;
    await room.alarm();
    expect(frames(w.pairs[0]!.server)).toContain("limit");
    expect(w.pairs[0]!.server.closed).toBe(4008);
    expect(w.pairs[1]!.server.closed).toBe(4008);
    // The pause ends: the room admits again, and a new session is not told paused.
    await w.db.run("DELETE FROM platform_settings");
    invalidatePlatformSettings(w.env, w.db);
    await room.alarm();
    const before = w.pairs.length;
    await room.fetch(upgrade(adm(A)));
    expect(w.pairs[before]!.server.closed).toBeNull();
  });

  it("closes the socket of a device that left the roster at the next alarm, and announces it gone", async () => {
    const w = world();
    const room = await joined(w);
    await seedRoster(w);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = 'djdl' AND device_id = ?",
      idOf(B),
    );
    w.state.alarmAt = null;
    await room.alarm();
    expect(w.pairs[1]!.server.closed).toBe(4003);
    expect(w.pairs[0]!.server.closed).toBeNull();
    expect(frames(w.pairs[0]!.server)).toContain("gone");
    // And B can no longer be written to.
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B));
    expect(w.pairs[0]!.server.closed).toBe(4003);
  });

  it("deletes the room when the person has no device left", async () => {
    const w = world();
    const room = await joined(w);
    await seedRoster(w, []);
    w.state.alarmAt = null;
    await room.alarm();
    expect(w.pairs[0]!.server.closed).toBe(4003);
    expect(w.state.store.has("room")).toBe(false);
    expect(w.state.alarmAt).toBeNull();
  });

  it("keeps the room open on an unreadable read and enforces the close at the third in a row", async () => {
    const w = world();
    const room = await joined(w);
    let broken = true;
    const flaky = w.make({
      db: () => {
        if (broken) throw new Error("down");
        return w.db;
      },
    });
    void room;
    w.state.alarmAt = null;
    await flaky.alarm().catch(() => undefined);
    await flaky.alarm().catch(() => undefined);
    expect(w.pairs[0]!.server.closed).toBeNull();
    await flaky.alarm().catch(() => undefined);
    expect(w.pairs[0]!.server.closed).toBe(4008);
    broken = false;
  });

  it("refuses an admission for ten minutes after a purge", async () => {
    const w = world();
    const room = await joined(w);
    await room.fetch(
      new Request("https://connect-relay.do/", {
        method: "POST",
        body: JSON.stringify({
          product: "djdl",
          subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
        }),
      }),
    );
    expect((await room.fetch(upgrade(adm(A)))).status).toBe(403);
    w.tick(600_001);
    expect((await room.fetch(upgrade(adm(A)))).status).toBe(200);
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
    expect(seen.name).toBe("djdl:ps_AAAAAAAAAAAAAAAAAAAAAA");
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
    await purgeRelay(
      { CONNECT_RELAY: ns },
      "djdl",
      "ps_AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(w.pairs.map((p) => p.server.closed)).toEqual([4003, 4003]);
    // Only the tombstone is left: no roster, no usage.
    expect([...w.state.store.keys()]).toEqual(["erasedAt"]);
    expect(w.state.alarmAt).toBeNull();
    await purgeRelay({}, "djdl", "ps_AAAAAAAAAAAAAAAAAAAAAA");
  });

  describe("the ring poke (CC-07.4)", () => {
    const nsOf = (room: ConnectRelayDO, calls: Request[] = []) =>
      ({
        idFromName: (n: string) => n,
        get: () => ({
          fetch: (r: Request) => {
            calls.push(r.clone());
            return room.fetch(r);
          },
        }),
      }) as unknown as DurableObjectNamespace;
    const poke = {
      product: "djdl",
      subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
      epoch: 7,
    };
    const ringEpochs = (s: FakeSocket) =>
      s.sent
        .map((d) => decodeRelay("toClient", d))
        .filter((f) => f?.op === "ring")
        .map((f) => (f as unknown as { epoch: number }).epoch);

    it("closes a removed member at once (4003), announces it gone and sends RING to the rest", async () => {
      const w = world();
      const room = await joined(w);
      await seedRoster(w);
      await w.db.run(
        "UPDATE devices SET status = 'deauthorized' WHERE product = 'djdl' AND device_id = ?",
        idOf(B),
      );
      await pokeRelayRoom(
        { ...w.env, CONNECT_RELAY: nsOf(room) } as Env,
        poke,
        w.db,
      );
      expect(w.pairs[1]!.server.closed).toBe(4003);
      expect(w.pairs[0]!.server.closed).toBeNull();
      expect(frames(w.pairs[0]!.server)).toContain("gone");
      expect(ringEpochs(w.pairs[0]!.server)).toEqual([7]);
      expect(ringEpochs(w.pairs[1]!.server)).toEqual([]);
      // The shrunken roster is what the room keeps.
      await room.webSocketMessage(w.pairs[0]!.server as never, send(B));
      expect(w.pairs[0]!.server.closed).toBe(4003);
    });

    it("sends RING with the new epoch to every socket on a rotation, closing none", async () => {
      const w = world();
      const room = await joined(w);
      await seedRoster(w);
      await pokeRelayRoom(
        { ...w.env, CONNECT_RELAY: nsOf(room) } as Env,
        poke,
        w.db,
      );
      expect(ringEpochs(w.pairs[0]!.server)).toEqual([7]);
      expect(ringEpochs(w.pairs[1]!.server)).toEqual([7]);
      expect(w.pairs.map((p) => p.server.closed)).toEqual([null, null]);
    });

    it("pokes nothing with launch.relay off or unbound; a failing room never throws", async () => {
      const w = world();
      const room = await joined(w);
      await seedRoster(w);
      const calls: Request[] = [];
      const env = { ...w.env, CONNECT_RELAY: nsOf(room, calls) } as Env;
      (env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
      await pokeRelayRoom(env, poke, w.db);
      await pokeRelayRoom({ ...w.env } as Env, poke, w.db);
      expect(calls).toHaveLength(0);
      const failing = {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async () => {
            throw new Error("boom");
          },
        }),
      } as unknown as DurableObjectNamespace;
      (env as unknown as Record<string, string>).LAUNCH_RELAY = "on";
      await expect(
        pokeRelayRoom({ ...env, CONNECT_RELAY: failing } as Env, poke, w.db),
      ).resolves.toBeUndefined();
    });

    it("installRelayPoke points a ring bump at the room, and a failing room never fails the bump", async () => {
      const w = world();
      const room = await joined(w);
      await seedRoster(w);
      const env = { ...w.env, CONNECT_RELAY: nsOf(room) } as Env;
      try {
        installRelayPoke(env);
        // The port reads the gate through the env's own DB; the room answers 204 either way.
        await pokeRelay(poke);
        const failing = {
          ...env,
          CONNECT_RELAY: {
            idFromName: () => {
              throw new Error("x");
            },
          },
        } as unknown as Env;
        installRelayPoke(failing);
        await expect(pokeRelay(poke)).resolves.toBeUndefined();
      } finally {
        setRelayPokePort(null);
      }
    });

    it("does not create a room, refuses another pair and a bad epoch, and answers 404 with the gate off", async () => {
      const w = world();
      const fresh = w.make();
      expect((await fresh.fetch(pokeReq(poke))).status).toBe(204);
      expect(w.state.store.size).toBe(0);
      const room = await joined(w);
      expect(
        (await room.fetch(pokeReq({ ...poke, subject: "ps_other" }))).status,
      ).toBe(403);
      expect((await room.fetch(pokeReq({ ...poke, epoch: -1 }))).status).toBe(
        400,
      );
      (w.env as unknown as Record<string, string>).LAUNCH_RELAY = "off";
      expect((await room.fetch(pokeReq(poke))).status).toBe(404);
      expect(ringEpochs(w.pairs[0]!.server)).toEqual([]);
    });
  });
});

describe("ConnectRelayDO: counting contact rooms (CC-19.3, V5 §15.7)", () => {
  const rid = (n: number): string =>
    Buffer.from(new Uint8Array(16).fill(n)).toString("base64url");
  const count = (
    room: ConnectRelayDO,
    r: string,
    over: Record<string, unknown> = {},
  ) =>
    room.fetch(
      new Request("https://connect-relay.do/rooms", {
        method: "POST",
        body: JSON.stringify({
          product: "djdl",
          subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
          rid: r,
          ...over,
        }),
      }),
    );

  it("takes a slot per new room up to 64, refuses the 65th, and refreshes one it holds", async () => {
    const w = world();
    const room = w.make();
    for (let i = 0; i < 64; i++)
      expect((await count(room, rid(i))).status, `${i}`).toBe(204);
    expect((await count(room, rid(64))).status).toBe(429);
    // A ticket for a room already counted is not a new room.
    expect((await count(room, rid(7))).status).toBe(204);
    expect((await count(room, rid(64))).status).toBe(429);
  });

  it("frees a slot when its room's idle period ends", async () => {
    const w = world();
    const room = w.make();
    for (let i = 0; i < 64; i++) await count(room, rid(i));
    w.tick(29 * DAY);
    // Refreshing one keeps it; the others are still held.
    expect((await count(room, rid(0))).status).toBe(204);
    expect((await count(room, rid(100))).status).toBe(429);
    w.tick(2 * DAY);
    // The 63 not refreshed are past their 30 days; rid 0 was refreshed and is held.
    expect((await count(room, rid(100))).status).toBe(204);
    const held = (await w.state.storage.get("contactRooms")) as Record<
      string,
      number
    >;
    expect(Object.keys(held)).toHaveLength(2);
  });

  it("keeps a keyed hash of the rid, never the rid, and no subject, per person", async () => {
    const w = world();
    const room = w.make();
    await count(room, rid(1));
    const raw = JSON.stringify([...w.state.store.entries()]);
    expect(raw).not.toContain(rid(1));
    expect(raw).not.toContain("ps_AAAAAAAAAAAAAAAAAAAAAA");
    // Another person's room, same rid: a different stored key.
    const w2 = world();
    const room2 = w2.make();
    await count(room2, rid(1), { subject: "ps_BBBBBBBBBBBBBBBBBBBBBB" });
    expect(
      Object.keys((await w2.state.storage.get("contactRooms")) as {}),
    ).not.toEqual(
      Object.keys((await w.state.storage.get("contactRooms")) as {}),
    );
  });

  it("creates no room and pins nothing, and refuses another pair once pinned", async () => {
    const w = world();
    const room = w.make();
    await count(room, rid(1));
    expect(w.state.store.has("room")).toBe(false);
    expect(w.state.alarmAt).toBeNull();
    // After the first socket pins (product, subject), another pair is refused.
    await room.fetch(upgrade(adm(A)));
    expect((await count(room, rid(2), { subject: "ps_other" })).status).toBe(
      403,
    );
  });

  it("is unreachable while launch.relay or launch.connectLinks is off, and refuses a bad body", async () => {
    for (const gate of ["LAUNCH_RELAY", "LAUNCH_CONNECT_LINKS"]) {
      const env = makeEnv(new KvMock());
      (env as unknown as Record<string, string>)[gate] = "off";
      const w = world(env);
      expect((await count(w.make(), rid(1))).status, gate).toBe(404);
      expect(w.state.store.has("contactRooms")).toBe(false);
    }
    const w = world();
    const room = w.make();
    expect((await count(room, "short")).status).toBe(400);
    expect((await count(room, rid(1), { product: 1 })).status).toBe(400);
    expect(
      (
        await room.fetch(
          new Request("https://connect-relay.do/rooms", {
            method: "POST",
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await room.fetch(
          new Request("https://connect-relay.do/rooms", { method: "GET" }),
        )
      ).status,
    ).toBe(405);
  });

  it("goes with the room on a purge", async () => {
    const w = world();
    const room = w.make();
    await count(room, rid(1));
    await room.fetch(upgrade(adm(A)));
    await room.fetch(
      new Request("https://connect-relay.do/", {
        method: "POST",
        body: JSON.stringify({
          product: "djdl",
          subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
        }),
      }),
    );
    expect(w.state.store.has("contactRooms")).toBe(false);
  });
});

describe("metering bounds: a room counts its bytes before it erases", () => {
  const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
  const meter = async (w: ReturnType<typeof world>): Promise<number> =>
    (await w.db.first<{ b: number | null }>(
      "SELECT COALESCE(SUM(bytes), 0) AS b FROM connect_relay_daily",
    ))!.b ?? 0;
  const owing = async (w: ReturnType<typeof world>): Promise<number> => {
    const p = (await w.state.storage.get("pending")) as
      | Record<string, { bytes: number }>
      | undefined;
    return Object.values(p ?? {}).reduce((n, d) => n + d.bytes, 0);
  };
  const failingBatch = (w: ReturnType<typeof world>): Db =>
    Object.assign(Object.create(w.db) as Db, {
      batch: () => Promise.reject(new Error("d1 down")),
    });

  it("a room erased because its person has no device left counts its pending bytes first (the alarm)", async () => {
    const w = world();
    const room = await joined(w);
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    const owed = await owing(w);
    expect(owed).toBeGreaterThan(1000);
    await seedRoster(w, []);
    w.state.alarmAt = null;
    await room.alarm();
    expect(w.state.store.has("room")).toBe(false);
    expect(await meter(w)).toBe(owed);
  });

  it("a room erased because its person has no device left counts its pending bytes first (the poke)", async () => {
    const w = world();
    const room = await joined(w);
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    const owed = await owing(w);
    await seedRoster(w, []);
    const res = await room.fetch(
      new Request("https://connect-relay.do/", {
        method: "PUT",
        body: JSON.stringify({ product: "djdl", subject: SUBJECT, epoch: 3 }),
      }),
    );
    expect(res.status).toBe(204);
    expect(w.state.store.has("room")).toBe(false);
    expect(await meter(w)).toBe(owed);
  });

  it("a count that fails before the erase keeps the room, its bytes and the alarm for the retry", async () => {
    const w = world();
    const room = w.make({ db: () => failingBatch(w) });
    await room.fetch(upgrade(adm(A)));
    await room.fetch(upgrade(adm(B)));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    await seedRoster(w, []);
    // The poke swallows the failure.
    const res = await room.fetch(
      new Request("https://connect-relay.do/", {
        method: "PUT",
        body: JSON.stringify({ product: "djdl", subject: SUBJECT, epoch: 3 }),
      }),
    );
    expect(res.status).toBe(204);
    expect(await owing(w)).toBeGreaterThan(1000);
    expect(w.state.store.has("room")).toBe(true);
    // The alarm re-arms (see the backoff test) with the bytes still owed.
    w.state.alarmAt = null;
    await room.alarm();
    expect(await owing(w)).toBeGreaterThan(1000);
    expect(w.state.store.has("room")).toBe(true);
    // The next alarm (the database back) counts them and erases.
    const owed = await owing(w);
    await w.make().alarm();
    expect(w.state.store.has("room")).toBe(false);
    expect(await meter(w)).toBe(owed);
  });

  it("a purge counts pending bytes first, and still erases when the count fails", async () => {
    const w = world();
    const room = await joined(w);
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    const owed = await owing(w);
    const ns = (r: ConnectRelayDO) =>
      ({
        idFromName: (n: string) => n,
        get: () => ({ fetch: (q: Request) => r.fetch(q) }),
      }) as unknown as DurableObjectNamespace;
    await purgeRelay({ CONNECT_RELAY: ns(room) }, "djdl", SUBJECT);
    expect([...w.state.store.keys()]).toEqual(["erasedAt"]);
    expect(await meter(w)).toBe(owed);

    // And when the count fails the room is erased anyway.
    const w2 = world();
    const room2 = w2.make({ db: () => failingBatch(w2) });
    await room2.fetch(upgrade(adm(A)));
    await room2.fetch(upgrade(adm(B)));
    await room2.webSocketMessage(w2.pairs[0]!.server as never, send(B, 1000));
    await purgeRelay({ CONNECT_RELAY: ns(room2) }, "djdl", SUBJECT);
    expect([...w2.state.store.keys()]).toEqual(["erasedAt"]);
    expect(w2.pairs.map((p) => p.server.closed)).toEqual([4003, 4003]);
  });
});

describe("erase critical section and alarm re-arm", () => {
  const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
  /** Fail the first count while a concurrent caller (behind the input gate) tries to enter. */
  const hooked = (
    w: ReturnType<typeof world>,
    during: () => void,
    fail = false,
  ): Db =>
    Object.assign(Object.create(w.db) as Db, {
      batch: async (...a: Parameters<Db["batch"]>) => {
        during();
        await new Promise((r) => setTimeout(r, 5));
        if (fail) throw new Error("d1 down");
        return w.db.batch(...a);
      },
    });
  const behindGate = async (
    w: ReturnType<typeof world>,
    room: ConnectRelayDO,
    req: Request,
  ): Promise<Response> => {
    while (w.state.gate) await w.state.gate;
    return room.fetch(req);
  };

  it("an upgrade arriving during a purge's count waits for the erase and is refused", async () => {
    const w = world();
    let entering: Promise<Response> | undefined;
    let room!: ConnectRelayDO;
    room = w.make({
      db: () =>
        hooked(w, () => {
          entering ??= behindGate(w, room, upgrade(adm(A)));
        }),
    });
    await room.fetch(upgrade(adm(A)));
    await room.fetch(upgrade(adm(B)));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: (q: Request) => room.fetch(q) }),
    } as unknown as DurableObjectNamespace;
    await purgeRelay({ CONNECT_RELAY: ns }, "djdl", SUBJECT);
    const res = await entering!;
    expect(res.status).not.toBe(200);
    expect(w.state.getWebSockets()).toEqual([]);
  });

  it("an upgrade arriving during the poke's erase count never survives in an empty room", async () => {
    const w = world();
    let entering: Promise<Response> | undefined;
    let room!: ConnectRelayDO;
    room = w.make({
      db: () =>
        hooked(w, () => {
          entering ??= behindGate(w, room, upgrade(adm(A)));
        }),
    });
    await room.fetch(upgrade(adm(A)));
    await room.fetch(upgrade(adm(B)));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    await seedRoster(w, []);
    await room.fetch(
      new Request("https://connect-relay.do/", {
        method: "PUT",
        body: JSON.stringify({ product: "djdl", subject: SUBJECT, epoch: 3 }),
      }),
    );
    await entering!;
    // Whatever was admitted after the erase has a room behind it; nothing is left unmetered.
    if (w.state.getWebSockets().length > 0)
      expect(w.state.store.has("room")).toBe(true);
  });

  it("a count that fails on every alarm re-arms with a bounded backoff, then erases once it lands", async () => {
    const w = world();
    const room = w.make({ db: () => failingBatch(w) });
    await room.fetch(upgrade(adm(A)));
    await room.fetch(upgrade(adm(B)));
    await room.webSocketMessage(w.pairs[0]!.server as never, send(B, 1000));
    await seedRoster(w, []);
    const owed = await owing(w);
    const gaps: number[] = [];
    for (let i = 0; i < 12; i++) {
      w.state.alarmAt = null;
      await room.alarm();
      expect(w.state.alarmAt).not.toBeNull();
      gaps.push(w.state.alarmAt! - w.now());
      expect(w.state.store.has("room")).toBe(true);
      expect(await owing(w)).toBe(owed);
    }
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(600_000);
    // The database is back.
    await w.make().alarm();
    expect(w.state.store.has("room")).toBe(false);
    expect(await meter(w)).toBe(owed);
  });

  const meter = async (w: ReturnType<typeof world>): Promise<number> =>
    (await w.db.first<{ b: number | null }>(
      "SELECT COALESCE(SUM(bytes), 0) AS b FROM connect_relay_daily",
    ))!.b ?? 0;
  const owing = async (w: ReturnType<typeof world>): Promise<number> => {
    const p = (await w.state.storage.get("pending")) as
      | Record<string, { bytes: number }>
      | undefined;
    return Object.values(p ?? {}).reduce((n, d) => n + d.bytes, 0);
  };
  const failingBatch = (w: ReturnType<typeof world>): Db =>
    Object.assign(Object.create(w.db) as Db, {
      batch: () => Promise.reject(new Error("d1 down")),
    });
});
